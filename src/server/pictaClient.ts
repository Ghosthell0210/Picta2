import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import type { PictaAlertEvent } from '../shared/types.ts';
import { netlog } from './netlog.ts';
import { stateStore } from './stateStore.ts';

const VIEW_MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];
const MAX_PICTA_S3_BYTES = 5 * 1024 * 1024 * 1024; // 5 GB Picta S3 hard cap
const S3_STREAM_HIGH_WATER_MARK = 256 * 1024; // 256 KB lean RAM buffer for Altare

export const PICTA_TIPOLOGIAS: Record<number, string> = {
  1: 'Película',
  2: 'Documental',
  3: 'Video Musical',
  5: 'Serie',
  6: 'Curso / Deporte',
  8: 'Audiovisual',
  11: 'Videoclip',
  14: 'Deporte / Gameplay',
  15: 'Shorts',
  17: 'Cultural / Reportaje',
  18: 'Informativo / Receta',
  19: 'Humorístico',
};

const PRIVATE_HOST_REGEX =
  /^(localhost|127\.\d+\.\d+\.\d+|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|169\.254\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|\[::1\])$/i;

function validateExternalUrl(raw: string, fallback: string): string {
  try {
    const parsed = new URL(raw.trim());
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return fallback;
    }
    if (PRIVATE_HOST_REGEX.test(parsed.hostname)) {
      return fallback;
    }
    return parsed.origin;
  } catch {
    return fallback;
  }
}

export function getValidatedPictaBaseUrl(): string {
  return validateExternalUrl(process.env.PICTA_BASE_URL || 'https://videos.picta.cu', 'https://videos.picta.cu');
}

export function getValidatedPictaApiUrl(): string {
  return validateExternalUrl(
    process.env.PICTA_API_BASE_URL || process.env.PICTA_API_URL || 'https://api.picta.cu',
    'https://api.picta.cu'
  );
}

export function formatCubanPhoneUsername(raw: string): string {
  const cleaned = raw.trim();
  if (/^\d{8}$/.test(cleaned)) {
    return `+53${cleaned}`;
  }
  return cleaned;
}

export interface PictaOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtMs: number;
}

export interface PictaMinioTicket {
  endpoint: string;
  fields: Record<string, string>;
  key: string;
}

export interface PictaPublicationRecord {
  id: string;
  nombre: string;
  slug?: string;
  cantidad_vistas: number;
  cantidad_comentarios: number;
  cantidad_me_gusta: number;
  cantidad_descargas: number;
  publicado: boolean;
  estado_codificacion?: string;
  url_descarga?: string;
  url_manifiesto?: string;
}

export interface PictaUploadResult {
  minioKey: string;
  publicationId?: string;
  nomadTriggered: boolean;
}

export interface TmdbSearchResult {
  id: number;
  title: string;
  mediaType: 'movie' | 'tv';
  year?: string;
  overview: string;
  posterUrl?: string;
  voteAverage?: number;
}

export class PictaService {
  public lastAlertScanAt?: string;
  public lastNomadCheckAt?: string;

  private cachedToken: PictaOAuthToken | null = null;
  private cachedUserProfile: {
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    isChannelChief?: boolean;
  } | null = null;

  public getConfiguredUsername(): string {
    return (process.env.PICTA_USERNAME || process.env.PICTA_DEFAULT_USERNAME || process.env.PICTA_USER || '').trim();
  }

  public getConfiguredPassword(): string {
    return (process.env.PICTA_PASSWORD || process.env.PICTA_DEFAULT_PASSWORD || process.env.PICTA_PASS || '').trim();
  }

  public getConfiguredClientId(): string {
    return (process.env.PICTA_CLIENT_ID || process.env.CLIENT_ID || '').trim();
  }

  public getDefaultChannelId(): string {
    return (process.env.PICTA_CHANNEL_ID || '36319').trim();
  }

  public getDefaultChannelName(): string {
    return (process.env.PICTA_CHANNEL_NAME || 'Multiverso Visual').trim();
  }

  public getStatus() {
    return {
      baseUrl: getValidatedPictaBaseUrl(),
      defaultAccountConfigured: Boolean(this.getConfiguredUsername() && this.getConfiguredPassword()),
      lastAlertScanAt: this.lastAlertScanAt,
      lastNomadCheckAt: this.lastNomadCheckAt,
      watchedVideosCount: stateStore.watchedVideos.length,
      alertsPendingCount: stateStore.alerts.filter((a) => !a.notifiedTelegram).length,
    };
  }

  private getAdminHeaders(accessToken?: string): Record<string, string> {
    return {
      Accept: 'application/json',
      Origin: 'https://admin.picta.cu',
      Referer: 'https://admin.picta.cu/',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    };
  }

  public decryptPictaProfilePayload(base64Ciphertext: string): Record<string, unknown> | null {
    const rawKey = (process.env.PICTA_AES_KEY || process.env.AES_KEY || '').trim();
    if (!rawKey) return null;

    const keyBuf = Buffer.from(rawKey, 'utf8');
    if (keyBuf.length !== 16 && keyBuf.length !== 24 && keyBuf.length !== 32) {
      netlog.warn('picta', `PICTA_AES_KEY tiene longitud inesperada (${keyBuf.length} bytes; esperado 16).`);
      return null;
    }
    const algo = keyBuf.length === 16 ? 'aes-128-ecb' : keyBuf.length === 24 ? 'aes-192-ecb' : 'aes-256-ecb';
    try {
      const decipher = crypto.createDecipheriv(algo, keyBuf, null);
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(base64Ciphertext.trim(), 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(decrypted) as Record<string, unknown>;
    } catch (err) {
      netlog.warn('picta', `No se pudo descifrar /v2/usuario/me2/: ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  public async authenticate(overrideUsername?: string, overridePassword?: string): Promise<string> {
    if (!overrideUsername && this.cachedToken && Date.now() < this.cachedToken.expiresAtMs - 60_000) {
      return this.cachedToken.accessToken;
    }

    const rawUsername = (overrideUsername || this.getConfiguredUsername()).trim();
    const password = (overridePassword || this.getConfiguredPassword()).trim();
    const clientId = this.getConfiguredClientId();

    if (!rawUsername || !password) {
      throw new Error('Credenciales de Picta no configuradas (PICTA_USERNAME / PICTA_PASSWORD).');
    }
    if (!clientId) {
      throw new Error('Falta PICTA_CLIENT_ID en las variables de entorno de Altare.');
    }

    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('username', formatCubanPhoneUsername(rawUsername));
    form.append('password', password);
    form.append('grant_type', 'password');
    form.append('client_id', clientId);

    const started = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15_000);
    const res = await fetch(`${apiUrl}/o/token/`, {
      method: 'POST',
      headers: this.getAdminHeaders(),
      body: form,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 240);
      netlog.error('picta', `Error OAuth Picta HTTP ${res.status}`, { latencyMs: Date.now() - started });
      throw new Error(`Fallo autenticacion Picta (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };

    if (!data.access_token) {
      throw new Error('Respuesta OAuth de Picta no incluyo access_token.');
    }

    const expiresInSec = Math.max(300, Number(data.expires_in || 3600));
    const tokenObj: PictaOAuthToken = {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || 'Bearer',
      expiresAtMs: Date.now() + expiresInSec * 1000,
    };

    if (!overrideUsername) {
      this.cachedToken = tokenObj;
    }

    netlog.info('picta', `Token OAuth Picta renovado para ${formatCubanPhoneUsername(rawUsername)}.`, {
      latencyMs: Date.now() - started,
    });

    return tokenObj.accessToken;
  }

  public async fetchCurrentUserProfile(): Promise<{
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
    isChannelChief?: boolean;
  } | null> {
    if (this.cachedUserProfile) return this.cachedUserProfile;
    try {
      const token = await this.authenticate();
      const apiUrl = getValidatedPictaApiUrl();
      const res = await fetch(`${apiUrl}/v2/usuario/me2/`, {
        method: 'GET',
        headers: this.getAdminHeaders(token),
      });
      if (!res.ok) return null;
      const rawText = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        const jsonVal = JSON.parse(rawText);
        if (typeof jsonVal === 'string') {
          parsed = this.decryptPictaProfilePayload(jsonVal);
        } else if (jsonVal && typeof jsonVal === 'object') {
          parsed = jsonVal as Record<string, unknown>;
        }
      } catch {
        parsed = this.decryptPictaProfilePayload(rawText.replace(/^"|"$/g, ''));
      }
      if (!parsed) return null;

      const groups = Array.isArray(parsed.groups) ? parsed.groups : [];
      const isChannelChief = groups.some((g) => {
        if (typeof g === 'string') return g.toLowerCase().includes('jefe');
        if (g && typeof g === 'object' && 'name' in g) {
          return String((g as { name?: unknown }).name || '')
            .toLowerCase()
            .includes('jefe');
        }
        return false;
      });

      this.cachedUserProfile = {
        id: typeof parsed.id === 'number' ? parsed.id : undefined,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        firstName: typeof parsed.first_name === 'string' ? parsed.first_name : undefined,
        lastName: typeof parsed.last_name === 'string' ? parsed.last_name : undefined,
        isChannelChief,
      };
      return this.cachedUserProfile;
    } catch {
      return null;
    }
  }

  public async checkPictaConnectivity(): Promise<{
    reachable: boolean;
    statusCode?: number;
    latencyMs: number;
    authenticated?: boolean;
  }> {
    const apiUrl = getValidatedPictaApiUrl();
    const started = Date.now();
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(`${apiUrl}/v2/publicacion/?page_size=1`, {
        method: 'GET',
        signal: controller.signal,
        headers: this.getAdminHeaders(),
      });
      clearTimeout(timeout);
      const latencyMs = Date.now() - started;

      let authenticated = false;
      if (this.getConfiguredUsername() && this.getConfiguredPassword() && this.getConfiguredClientId()) {
        try {
          await this.authenticate();
          authenticated = true;
        } catch {
          authenticated = false;
        }
      }

      netlog.info('picta', `Verificacion conectividad Picta API: HTTP ${res.status}`, {
        latencyMs,
        authenticated,
      });
      return { reachable: res.status < 500, statusCode: res.status, latencyMs, authenticated };
    } catch (err) {
      const latencyMs = Date.now() - started;
      netlog.warn('picta', `No se pudo alcanzar ${apiUrl}: ${err instanceof Error ? err.message : String(err)}`, {
        latencyMs,
      });
      return { reachable: false, latencyMs, authenticated: false };
    }
  }

  public async getMinioUploadTicket(accessToken: string): Promise<PictaMinioTicket> {
    const apiUrl = getValidatedPictaApiUrl();
    const res = await fetch(`${apiUrl}/v2/publicacion/devolver_url_minio/`, {
      method: 'GET',
      headers: this.getAdminHeaders(accessToken),
    });
    if (!res.ok) {
      throw new Error(`devolver_url_minio fallo con HTTP ${res.status}`);
    }
    const payload = (await res.json()) as {
      url_minio?: [string, Record<string, string>];
    };
    if (!Array.isArray(payload.url_minio) || payload.url_minio.length < 2) {
      throw new Error('Respuesta invalida de devolver_url_minio.');
    }
    const [rawEndpoint, fields] = payload.url_minio;
    const endpointParsed = new URL(rawEndpoint);
    if (
      (endpointParsed.protocol !== 'https:' && endpointParsed.protocol !== 'http:') ||
      PRIVATE_HOST_REGEX.test(endpointParsed.hostname)
    ) {
      throw new Error('Endpoint S3 MinIO bloqueado por validacion de seguridad.');
    }
    const key = String(fields.key || '');
    if (!key) {
      throw new Error('Ticket MinIO sin campo key.');
    }
    return { endpoint: rawEndpoint, fields, key };
  }

  public async uploadFileToMinioStream(params: {
    filePath: string;
    fileName: string;
    contentType?: string;
    ticket: PictaMinioTicket;
    onProgress?: (uploadedBytes: number, totalBytes: number, speedMbps: number) => void;
  }): Promise<{ bytesSent: number; speedMbps: number }> {
    const stat = fs.statSync(params.filePath);
    if (stat.size <= 0) {
      throw new Error('El archivo local a subir esta vacio.');
    }
    if (stat.size > MAX_PICTA_S3_BYTES) {
      throw new Error('El archivo supera el limite maximo de 5 GB de S3 MinIO en Picta.');
    }

    const boundary = `----PictaBotAltare${crypto.randomBytes(12).toString('hex')}`;
    const safeName = params.fileName.replace(/["\r\n]/g, '_');
    const contentType = params.contentType || params.ticket.fields['Content-Type'] || 'video/mp4';

    const fieldChunks: Buffer[] = [];
    for (const [k, v] of Object.entries(params.ticket.fields)) {
      fieldChunks.push(
        Buffer.from(
          `--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`,
          'utf8'
        )
      );
    }
    const fileHeader = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${safeName}"\r\nContent-Type: ${contentType}\r\n\r\n`,
      'utf8'
    );
    const fileFooter = Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8');

    const preamble = Buffer.concat([...fieldChunks, fileHeader]);
    const totalContentLength = preamble.length + stat.size + fileFooter.length;
    const targetUrl = new URL(params.ticket.endpoint);
    const transport = targetUrl.protocol === 'https:' ? https : http;

    const started = Date.now();
    return new Promise((resolve, reject) => {
      const req = transport.request(
        {
          protocol: targetUrl.protocol,
          hostname: targetUrl.hostname,
          port: targetUrl.port || (targetUrl.protocol === 'https:' ? 443 : 80),
          path: targetUrl.pathname + targetUrl.search,
          method: 'POST',
          headers: {
            'Content-Type': `multipart/form-data; boundary=${boundary}`,
            'Content-Length': String(totalContentLength),
            Origin: 'https://admin.picta.cu',
            Referer: 'https://admin.picta.cu/',
          },
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const status = res.statusCode || 0;
            if (status >= 200 && status < 300) {
              const elapsedSec = Math.max(0.1, (Date.now() - started) / 1000);
              const speedMbps = Number(((stat.size / (1024 * 1024)) / elapsedSec).toFixed(2));
              resolve({ bytesSent: stat.size, speedMbps });
            } else {
              const errBody = Buffer.concat(chunks).toString('utf8').slice(0, 300);
              reject(new Error(`Subida S3 MinIO rechazo archivo (HTTP ${status}): ${errBody}`));
            }
          });
        }
      );

      req.on('error', (err) => reject(err));
      req.write(preamble);

      let uploadedBytes = 0;
      let lastReportAt = 0;
      const readStream = fs.createReadStream(params.filePath, { highWaterMark: S3_STREAM_HIGH_WATER_MARK });

      readStream.on('data', (chunk: string | Buffer) => {
        const len = Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
        uploadedBytes += len;
        const now = Date.now();
        if (params.onProgress && (now - lastReportAt >= 600 || uploadedBytes >= stat.size)) {
          lastReportAt = now;
          const elapsedSec = Math.max(0.1, (now - started) / 1000);
          const speedMbps = Number(((uploadedBytes / (1024 * 1024)) / elapsedSec).toFixed(2));
          params.onProgress(uploadedBytes, stat.size, speedMbps);
        }
      });

      readStream.on('error', (err) => {
        req.destroy(err);
        reject(err);
      });

      readStream.on('end', () => {
        req.end(fileFooter);
      });

      readStream.pipe(req, { end: false });
    });
  }

  public async triggerNomadConversion(minioKey: string, accessToken?: string): Promise<boolean> {
    const token = accessToken || (await this.authenticate());
    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('action', 'convert');
    form.append('minio_id', minioKey);
    form.append('descargable', 'true');

    const res = await fetch(`${apiUrl}/v2/publicacion/proxy_nomad/`, {
      method: 'POST',
      headers: this.getAdminHeaders(token),
      body: form,
    });
    if (res.ok) {
      netlog.info('picta', `Nomad proxy_nomad disparado para minio_id=${minioKey.slice(0, 28)}.`);
      return true;
    }
    netlog.warn('picta', `proxy_nomad devolvio HTTP ${res.status} para ${minioKey.slice(0, 28)}.`);
    return false;
  }

  public async uploadVideoToPictaPipeline(params: {
    filePath: string;
    fileName: string;
    title: string;
    description?: string;
    tipologia?: number;
    channelId?: string;
    keywords?: string;
    onUploadProgress?: (uploadedBytes: number, totalBytes: number, speedMbps: number) => void;
  }): Promise<PictaUploadResult> {
    const token = await this.authenticate();
    const apiUrl = getValidatedPictaApiUrl();
    const ticket = await this.getMinioUploadTicket(token);

    netlog.info('picta', `Iniciando streaming S3 MinIO para "${params.title}" (buffer 256 KB).`);
    const uploadRes = await this.uploadFileToMinioStream({
      filePath: params.filePath,
      fileName: params.fileName,
      ticket,
      onProgress: params.onUploadProgress,
    });

    netlog.info('picta', `S3 MinIO completado para "${params.title}"`, {
      throughputMbps: uploadRes.speedMbps,
    });

    const channelId = (params.channelId || this.getDefaultChannelId()).trim();
    const tipologia = String(params.tipologia || 8);
    const description = (params.description || `${params.title} — subido via PictaBot Altare`).trim();

    // 1. Validate fields
    const validateForm = new FormData();
    validateForm.append('tipo', 'publicacion');
    validateForm.append('tipologia', tipologia);
    validateForm.append('nombre', params.title);
    validateForm.append('descripcion', description);
    validateForm.append('canal', channelId);
    validateForm.append('url_manifiesto', ticket.key);

    try {
      await fetch(`${apiUrl}/v1/publicacion/validar_campos/`, {
        method: 'POST',
        headers: this.getAdminHeaders(token),
        body: validateForm,
      });
    } catch {
      // Non-fatal pre-validation check
    }

    // 2. Create publication with Picta's required fields
    const fallbackJpeg = Buffer.from(
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=',
      'base64'
    );
    const pubForm = new FormData();
    pubForm.append('tipo', 'publicacion');
    pubForm.append('tipologia', tipologia);
    pubForm.append('nombre', params.title);
    pubForm.append('descripcion', description);
    pubForm.append('canal', channelId);
    pubForm.append('url_manifiesto', ticket.key);
    pubForm.append('publicado', 'true');
    pubForm.append('descargable', 'true');
    pubForm.append('mostrar_comentarios', 'true');
    pubForm.append('mostrar_chat', 'false');
    pubForm.append('internacional', 'false');
    pubForm.append('es_exclusivo', 'false');
    pubForm.append('clasificacion', (process.env.PICTA_CLASIFICACION || '18+').trim());
    pubForm.append('palabraClave', (params.keywords || process.env.PICTA_PALABRA_CLAVE_ID || '5476').trim());
    pubForm.append(
      'url_imagen',
      new Blob([new Uint8Array(fallbackJpeg)], { type: 'image/jpeg' }),
      `portada_${Date.now()}.jpg`
    );

    if (tipologia === '1') {
      // Pelicula requires relational numeric IDs + imagen_secundaria in Picta Django REST
      pubForm.append('ano', String(new Date().getFullYear()));
      pubForm.append('pais', 'Internacional');
      pubForm.append('genero', '5');
      pubForm.append('productora', '679');
      pubForm.append('director', '1022');
      pubForm.append('guion', '1022');
      pubForm.append('reparto', '646');
      pubForm.append('fotografia', '1022');
      pubForm.append('musica', '1022');
      pubForm.append('premio', '469');
      pubForm.append(
        'imagen_secundaria',
        new Blob([new Uint8Array(fallbackJpeg)], { type: 'image/jpeg' }),
        `poster_${Date.now()}.jpg`
      );
    }

    const createRes = await fetch(`${apiUrl}/v1/publicacion/`, {
      method: 'POST',
      headers: this.getAdminHeaders(token),
      body: pubForm,
    });

    let publicationId: string | undefined;
    if (createRes.ok) {
      const created = (await createRes.json()) as { id?: string | number };
      if (created?.id !== undefined) {
        publicationId = String(created.id);
      }
      netlog.info('picta', `Publicacion creada en Picta (ID ${publicationId || 'N/A'}) para "${params.title}".`);
    } else {
      const errTxt = (await createRes.text()).slice(0, 260);
      throw new Error(`Error creando publicacion en Picta (HTTP ${createRes.status}): ${errTxt}`);
    }

    // 3. Trigger Nomad encoder
    let nomadTriggered = false;
    try {
      nomadTriggered = await this.triggerNomadConversion(ticket.key, token);
    } catch (err) {
      netlog.warn('picta', `No se pudo disparar proxy_nomad de inmediato; reintentara el bucle 20s: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      minioKey: ticket.key,
      publicationId,
      nomadTriggered,
    };
  }

  public async fetchChannelPublications(channelId?: string, pageSize = 30): Promise<PictaPublicationRecord[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (channelId || this.getDefaultChannelId()).trim();
    let token: string | undefined;
    if (this.getConfiguredUsername() && this.getConfiguredPassword() && this.getConfiguredClientId()) {
      try {
        token = await this.authenticate();
      } catch {
        // Fallback to public endpoint
      }
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 8000);
    const res = await fetch(
      `${apiUrl}/v2/publicacion/?canal_id=${encodeURIComponent(targetChannel)}&page_size=${Math.min(100, pageSize)}`,
      {
        method: 'GET',
        signal: controller.signal,
        headers: this.getAdminHeaders(token),
      }
    );
    clearTimeout(timeout);
    if (!res.ok) return [];

    const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
    const rows = Array.isArray(data.results) ? data.results : [];
    return rows.map((r) => ({
      id: String(r.id ?? ''),
      nombre: String(r.nombre ?? 'Sin titulo'),
      slug: typeof r.slug === 'string' ? r.slug : undefined,
      cantidad_vistas: Number(r.cantidad_vistas ?? r.cantidad_reproducciones ?? 0),
      cantidad_comentarios: Number(r.cantidad_comentarios ?? 0),
      cantidad_me_gusta: Number(r.cantidad_me_gusta ?? r.cantidad_likes ?? 0),
      cantidad_descargas: Number(r.cantidad_descargas ?? 0),
      publicado: Boolean(r.publicado),
      estado_codificacion: typeof r.estado_codificacion === 'string' ? r.estado_codificacion : undefined,
      url_descarga: typeof r.url_descarga === 'string' ? r.url_descarga : undefined,
      url_manifiesto: typeof r.url_manifiesto === 'string' ? r.url_manifiesto : undefined,
    }));
  }

  public async fetchChannelStats(): Promise<Record<string, unknown> | null> {
    try {
      const token = await this.authenticate();
      const apiUrl = getValidatedPictaApiUrl();
      const todayHavana = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Havana',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const res = await fetch(
        `${apiUrl}/v2/resumen/datos/?date__gte=${todayHavana}&date__lte=${todayHavana}`,
        {
          method: 'GET',
          headers: this.getAdminHeaders(token),
        }
      );
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  public async searchMetadataTmdb(query: string): Promise<TmdbSearchResult[]> {
    const apiKey = (process.env.TMDB_API_KEY || '').trim();
    if (!apiKey || !query.trim()) return [];
    try {
      const url = new URL('https://api.themoviedb.org/3/search/multi');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('language', 'es-ES');
      url.searchParams.set('query', query.trim());

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 7000);
      const res = await fetch(url.toString(), { signal: controller.signal });
      clearTimeout(timeout);
      if (!res.ok) return [];

      const json = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const items = Array.isArray(json.results) ? json.results : [];
      return items
        .filter((item) => item.media_type === 'movie' || item.media_type === 'tv')
        .slice(0, 5)
        .map((item) => {
          const mediaType = item.media_type === 'tv' ? 'tv' : 'movie';
          const dateStr = String(item.release_date || item.first_air_date || '');
          const posterPath = typeof item.poster_path === 'string' ? item.poster_path : '';
          return {
            id: Number(item.id || 0),
            title: String(item.title || item.name || 'Sin titulo'),
            mediaType,
            year: dateStr ? dateStr.slice(0, 4) : undefined,
            overview: String(item.overview || '').slice(0, 320),
            posterUrl: posterPath ? `https://image.tmdb.org/t/p/w500${posterPath}` : undefined,
            voteAverage: typeof item.vote_average === 'number' ? Number(item.vote_average.toFixed(1)) : undefined,
          };
        });
    } catch {
      return [];
    }
  }

  public async scanAllPictaAlertsAndMilestones(
    notifyFn?: (telegramUserId: string, text: string) => Promise<boolean>
  ): Promise<{ scannedCount: number; newAlerts: PictaAlertEvent[] }> {
    const started = Date.now();
    const apiUrl = getValidatedPictaApiUrl();
    const newAlerts: PictaAlertEvent[] = [];

    let token: string | undefined;
    if (this.getConfiguredUsername() && this.getConfiguredPassword() && this.getConfiguredClientId()) {
      try {
        token = await this.authenticate();
      } catch {
        // Continue with public read if available
      }
    }

    // Auto-import top channel publications if watched list is empty and channel ID is configured
    if (stateStore.watchedVideos.length === 0 && this.getDefaultChannelId()) {
      try {
        const pubs = await this.fetchChannelPublications(this.getDefaultChannelId(), 15);
        const defaultOwner =
          (process.env.MASTER_ADMIN_CHAT_ID || '').trim() || stateStore.users[0]?.telegramUserId || '';
        for (const pub of pubs) {
          if (!pub.id) continue;
          stateStore.watchedVideos.push({
            videoId: pub.id,
            title: pub.nombre,
            channelName: this.getDefaultChannelName(),
            ownerUserId: defaultOwner,
            lastCommentCount: pub.cantidad_comentarios,
            lastViewsCount: pub.cantidad_vistas,
            lastMilestoneNotified:
              [...VIEW_MILESTONES].reverse().find((m) => pub.cantidad_vistas >= m) || 0,
            nomadStatus: pub.publicado ? 'ready' : 'encoding',
            updatedAt: new Date().toISOString(),
          });
        }
      } catch {
        // Offline or unreachable
      }
    }

    for (const video of stateStore.watchedVideos) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 6000);
        const res = await fetch(`${apiUrl}/v2/publicacion/${encodeURIComponent(video.videoId)}/`, {
          method: 'GET',
          signal: controller.signal,
          headers: this.getAdminHeaders(token),
        });
        clearTimeout(timeout);

        if (!res.ok) continue;
        const data = (await res.json()) as {
          cantidad_vistas?: number;
          cantidad_reproducciones?: number;
          cantidad_comentarios?: number;
          estado_codificacion?: string;
          publicado?: boolean;
        };

        const views = Number(data.cantidad_vistas ?? data.cantidad_reproducciones ?? video.lastViewsCount);
        const comments = Number(data.cantidad_comentarios ?? video.lastCommentCount);

        if (comments > video.lastCommentCount) {
          const diff = comments - video.lastCommentCount;
          const alert: PictaAlertEvent = {
            id: crypto.randomUUID(),
            type: 'comment',
            videoId: video.videoId,
            videoTitle: video.title,
            channelName: video.channelName,
            summary: `${diff} nuevo(s) comentario(s) detectados (total: ${comments}).`,
            metricValue: comments,
            notifiedTelegram: false,
            targetUserId: video.ownerUserId,
            detectedAt: new Date().toISOString(),
          };
          if (notifyFn && video.ownerUserId) {
            alert.notifiedTelegram = await notifyFn(
              video.ownerUserId,
              `Nuevo comentario en "${video.title}" (${video.channelName}): ${comments} comentarios totales.`
            );
          }
          newAlerts.push(alert);
          video.lastCommentCount = comments;
        }

        const reachedMilestone = [...VIEW_MILESTONES]
          .reverse()
          .find((m) => views >= m && m > video.lastMilestoneNotified);
        if (reachedMilestone) {
          const alert: PictaAlertEvent = {
            id: crypto.randomUUID(),
            type: 'milestone',
            videoId: video.videoId,
            videoTitle: video.title,
            channelName: video.channelName,
            summary: `Logro alcanzado: ${reachedMilestone.toLocaleString('es-ES')} visualizaciones.`,
            metricValue: reachedMilestone,
            notifiedTelegram: false,
            targetUserId: video.ownerUserId,
            detectedAt: new Date().toISOString(),
          };
          if (notifyFn && video.ownerUserId) {
            alert.notifiedTelegram = await notifyFn(
              video.ownerUserId,
              `Logro en Picta: "${video.title}" supero ${reachedMilestone.toLocaleString('es-ES')} vistas.`
            );
          }
          newAlerts.push(alert);
          video.lastMilestoneNotified = reachedMilestone;
        }

        video.lastViewsCount = views;
        video.nomadStatus = data.publicado ? 'ready' : 'encoding';
        video.updatedAt = new Date().toISOString();
      } catch {
        // Network unreachable or transient Picta hiccup; skip quietly
      }
    }

    if (newAlerts.length > 0) {
      stateStore.alerts.unshift(...newAlerts);
      if (stateStore.alerts.length > 100) {
        stateStore.alerts.length = 100;
      }
      stateStore.saveAlerts();
    }

    stateStore.saveWatchedVideos();
    this.lastAlertScanAt = new Date().toISOString();

    netlog.info(
      'picta',
      `Ciclo de alertas Picta completado (${stateStore.watchedVideos.length} videos vigilados, ${newAlerts.length} nuevas alertas).`,
      { latencyMs: Date.now() - started }
    );

    return { scannedCount: stateStore.watchedVideos.length, newAlerts };
  }

  public async runNomadEncoderRetrySweep(
    notifyFn?: (telegramUserId: string, text: string) => Promise<boolean>
  ): Promise<{ checked: number; advanced: number }> {
    this.lastNomadCheckAt = new Date().toISOString();
    const encodingJobs = stateStore.jobs.filter((j) => j.status === 'encoding_nomad');
    let advanced = 0;

    let token: string | undefined;
    if (
      encodingJobs.length > 0 &&
      this.getConfiguredUsername() &&
      this.getConfiguredPassword() &&
      this.getConfiguredClientId()
    ) {
      try {
        token = await this.authenticate();
      } catch {
        // Proceed best-effort
      }
    }

    for (const job of encodingJobs) {
      job.nomadRetries += 1;
      job.updatedAt = new Date().toISOString();

      if (job.nomadRetries >= job.maxNomadRetries) {
        job.status = 'failed';
        job.errorMessage = `Codificador Nomad no confirmo procesamiento tras ${job.maxNomadRetries} reintentos.`;
        advanced += 1;
        netlog.warn('picta', `Job ${job.id.slice(0, 8)} supero limite de reintentos Nomad.`);
        continue;
      }

      if (job.minioKey && token && job.nomadRetries <= 3) {
        try {
          await this.triggerNomadConversion(job.minioKey, token);
        } catch {
          // Will re-check publication status below
        }
      }

      if (job.pictaVideoId) {
        try {
          const apiUrl = getValidatedPictaApiUrl();
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 5000);
          const res = await fetch(`${apiUrl}/v2/publicacion/${encodeURIComponent(job.pictaVideoId)}/`, {
            signal: controller.signal,
            headers: this.getAdminHeaders(token),
          });
          clearTimeout(timeout);
          if (res.ok) {
            const payload = (await res.json()) as {
              publicado?: boolean;
              estado_codificacion?: string;
              url_manifiesto?: string;
            };
            if (payload.publicado || payload.estado_codificacion === 'ready') {
              job.status = 'completed';
              job.progressPct = 100;
              advanced += 1;
              netlog.info('picta', `Nomad completo codificacion de "${job.title}".`);
              if (notifyFn && job.userId) {
                await notifyFn(job.userId, `Tu video "${job.title}" termino la codificacion en Picta.`);
              }
            }
          }
        } catch {
          // Will retry on next 20s Nomad tick
        }
      }
    }

    if (encodingJobs.length > 0) {
      stateStore.saveJobs();
    }

    return { checked: encodingJobs.length, advanced };
  }
}

export const pictaService = new PictaService();
