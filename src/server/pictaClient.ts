import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import type {
  OwnedPictaChannel,
  PictaAlertEvent,
  PictaCatalogItem,
  PictaChannelProfile,
  PictaCommentItem,
  PictaDenunciasSummary,
  PictaPlaylistItem,
  PictaSerieItem,
} from '../shared/types.ts';
import {
  detectViewerRequestComment,
  extractVideoFrameBufferWithFfmpeg,
  fetchSafeImageBuffer,
} from './mediaIntelligence.ts';
import { netlog } from './netlog.ts';
import { stateStore } from './stateStore.ts';

const VIEW_MILESTONES = [100, 500, 1000, 5000, 10000, 25000, 50000, 100000];
const MAX_PICTA_S3_BYTES = 5 * 1024 * 1024 * 1024;
const S3_STREAM_HIGH_WATER_MARK = 256 * 1024;
const MAX_USER_TOKEN_CACHE = 40;

const FALLBACK_JPEG_B64 =
  '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wgALCAABAAEBAREA/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxA=';

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
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return fallback;
    if (PRIVATE_HOST_REGEX.test(parsed.hostname)) return fallback;
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
  if (/^\d{8}$/.test(cleaned)) return `+53${cleaned}`;
  return cleaned;
}

export interface PictaOAuthToken {
  accessToken: string;
  refreshToken?: string;
  tokenType: string;
  expiresAtMs: number;
}

export interface PictaAuthContext {
  telegramUserId: string;
  isMaster: boolean;
  accessToken: string;
  channelId: string;
  channelName: string;
  pictaUsername: string;
  pictaUserId?: number;
}

export interface PictaMinioTicket {
  endpoint: string;
  fields: Record<string, string>;
  key: string;
}

export interface PictaUploadResult {
  minioKey: string;
  publicationId?: string;
  webUrl?: string;
  nomadTriggered: boolean;
}

async function fetchWithTimeout(url: string, init: RequestInit, timeoutMs = 12_000): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function buildPublicationWebUrl(id: string, slug?: string): string {
  const base = getValidatedPictaBaseUrl().replace(/\/+$/, '');
  if (slug) return `${base}/medias/${slug}`;
  return `${base}/medias/${id}`;
}

export class PictaService {
  public lastAlertScanAt?: string;
  public lastNomadCheckAt?: string;

  private masterToken: PictaOAuthToken | null = null;
  private userTokenCache = new Map<string, PictaOAuthToken>();

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
    if (keyBuf.length !== 16 && keyBuf.length !== 24 && keyBuf.length !== 32) return null;
    const algo = keyBuf.length === 16 ? 'aes-128-ecb' : keyBuf.length === 24 ? 'aes-192-ecb' : 'aes-256-ecb';
    try {
      const decipher = crypto.createDecipheriv(algo, keyBuf, null);
      const decrypted = Buffer.concat([
        decipher.update(Buffer.from(base64Ciphertext.trim(), 'base64')),
        decipher.final(),
      ]).toString('utf8');
      return JSON.parse(decrypted) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async requestOAuthToken(rawUsername: string, password: string): Promise<PictaOAuthToken> {
    const clientId = this.getConfiguredClientId();
    if (!rawUsername || !password) {
      throw new Error('Credenciales de Picta no configuradas.');
    }
    if (!clientId) {
      throw new Error('Falta PICTA_CLIENT_ID en las variables de entorno.');
    }

    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('username', formatCubanPhoneUsername(rawUsername));
    form.append('password', password);
    form.append('grant_type', 'password');
    form.append('client_id', clientId);

    const started = Date.now();
    const res = await fetchWithTimeout(
      `${apiUrl}/o/token/`,
      {
        method: 'POST',
        headers: this.getAdminHeaders(),
        body: form,
      },
      15_000
    );

    if (!res.ok) {
      const errText = (await res.text()).slice(0, 220);
      netlog.error('picta', `Error OAuth Picta HTTP ${res.status}`, { latencyMs: Date.now() - started });
      throw new Error(`Autenticación Picta rechazada (HTTP ${res.status}): ${errText}`);
    }

    const data = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      expires_in?: number;
    };
    if (!data.access_token) {
      throw new Error('Respuesta OAuth de Picta no incluyó access_token.');
    }

    const expiresInSec = Math.max(300, Number(data.expires_in || 3600));
    netlog.info('picta', `Token OAuth Picta renovado para ${formatCubanPhoneUsername(rawUsername)}.`, {
      latencyMs: Date.now() - started,
    });

    return {
      accessToken: data.access_token,
      refreshToken: data.refresh_token,
      tokenType: data.token_type || 'Bearer',
      expiresAtMs: Date.now() + expiresInSec * 1000,
    };
  }

  public async authenticateMaster(): Promise<string> {
    if (this.masterToken && Date.now() < this.masterToken.expiresAtMs - 60_000) {
      return this.masterToken.accessToken;
    }
    this.masterToken = await this.requestOAuthToken(this.getConfiguredUsername(), this.getConfiguredPassword());
    return this.masterToken.accessToken;
  }

  public invalidateUserToken(telegramUserId: string): void {
    this.userTokenCache.delete(telegramUserId);
  }

  public async fetchMeProfileWithToken(accessToken: string): Promise<{
    id?: number;
    username?: string;
    firstName?: string;
    lastName?: string;
  } | null> {
    try {
      const apiUrl = getValidatedPictaApiUrl();
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/usuario/me2/`,
        { method: 'GET', headers: this.getAdminHeaders(accessToken) },
        10_000
      );
      if (!res.ok) return null;
      const rawText = await res.text();
      let parsed: Record<string, unknown> | null = null;
      try {
        const jsonVal = JSON.parse(rawText);
        if (typeof jsonVal === 'string') parsed = this.decryptPictaProfilePayload(jsonVal);
        else if (jsonVal && typeof jsonVal === 'object') parsed = jsonVal as Record<string, unknown>;
      } catch {
        parsed = this.decryptPictaProfilePayload(rawText.replace(/^"|"$/g, ''));
      }
      if (!parsed) return null;
      return {
        id: typeof parsed.id === 'number' ? parsed.id : undefined,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        firstName: typeof parsed.first_name === 'string' ? parsed.first_name : undefined,
        lastName: typeof parsed.last_name === 'string' ? parsed.last_name : undefined,
      };
    } catch {
      return null;
    }
  }

  public async fetchOwnedChannelsWithToken(accessToken: string, pictaUserId?: number): Promise<OwnedPictaChannel[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const urls = [
      `${apiUrl}/v2/canal/?mis_canales=true&page_size=50`,
      ...(pictaUserId ? [`${apiUrl}/v2/canal/?usuario_id=${pictaUserId}&page_size=50`] : []),
      `${apiUrl}/v2/canal/propios/?page_size=50`,
    ];

    for (const url of urls) {
      try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: this.getAdminHeaders(accessToken) }, 10_000);
        if (!res.ok) continue;
        const json = (await res.json()) as { results?: Array<Record<string, unknown>> } | Array<Record<string, unknown>>;
        const list = Array.isArray(json) ? json : Array.isArray(json.results) ? json.results : [];
        if (list.length > 0) {
          return list
            .filter((c) => c.id !== undefined)
            .map((c) => ({
              id: Number(c.id),
              nombre: String(c.nombre || `Canal #${c.id}`),
              alias: typeof c.alias === 'string' ? c.alias : undefined,
              slug_url: typeof c.slug_url === 'string' ? c.slug_url : undefined,
            }));
        }
      } catch {
        // Try next endpoint variant
      }
    }
    return [];
  }

  /**
   * Verifies user credentials for /login, fetches their owned channels, and returns structured account info.
   */
  public async authenticateAndInspectAccount(
    username: string,
    password: string
  ): Promise<{
    token: PictaOAuthToken;
    pictaUserId?: number;
    displayName: string;
    ownedChannels: OwnedPictaChannel[];
  }> {
    const token = await this.requestOAuthToken(username, password);
    const me = await this.fetchMeProfileWithToken(token.accessToken);
    const ownedChannels = await this.fetchOwnedChannelsWithToken(token.accessToken, me?.id);
    const displayName = [me?.firstName, me?.lastName].filter(Boolean).join(' ').trim() || me?.username || username;
    return { token, pictaUserId: me?.id, displayName, ownedChannels };
  }

  /**
   * Resolves isolated Picta authentication context for a Telegram user.
   * Guest users NEVER inherit master credentials or the master channel.
   */
  public async resolveContextForUser(telegramUserId: string): Promise<PictaAuthContext> {
    const session = stateStore.userSessions.find((s) => s.telegramUserId === telegramUserId);
    const isMaster = stateStore.isMasterAdmin(telegramUserId);

    // If user explicitly linked a personal Picta session, use it (with strict isolation for non-masters)
    if (session && session.encryptedPassword) {
      const plainPass = stateStore.decryptUserSecret(session.encryptedPassword);
      if (!plainPass) {
        throw new Error('Tu sesión guardada en Picta no pudo descifrarse. Inicia sesión de nuevo con /login.');
      }

      let cached = this.userTokenCache.get(telegramUserId);
      if (!cached || Date.now() >= cached.expiresAtMs - 60_000) {
        cached = await this.requestOAuthToken(session.pictaUsername, plainPass);
        if (this.userTokenCache.size >= MAX_USER_TOKEN_CACHE) {
          const oldest = this.userTokenCache.keys().next().value;
          if (oldest) this.userTokenCache.delete(oldest);
        }
        this.userTokenCache.set(telegramUserId, cached);
      }

      // Enforce channel ownership isolation for guest accounts
      let targetChannelId = session.channelId;
      let targetChannelName = session.channelName;
      if (!isMaster && session.availableChannels.length > 0) {
        const ownsTarget = session.availableChannels.some((c) => String(c.id) === String(targetChannelId));
        if (!ownsTarget) {
          targetChannelId = String(session.availableChannels[0].id);
          targetChannelName = session.availableChannels[0].nombre;
        }
      }

      if (!targetChannelId) {
        throw new Error('Tu cuenta de Picta no tiene un canal seleccionado. Usa /mis_canales o /login.');
      }

      return {
        telegramUserId,
        isMaster,
        accessToken: cached.accessToken,
        channelId: targetChannelId,
        channelName: targetChannelName || `Canal #${targetChannelId}`,
        pictaUsername: session.pictaUsername,
        pictaUserId: session.pictaUserId,
      };
    }

    if (!isMaster) {
      throw new Error('Debes vincular tu propia cuenta de Picta primero usando /login.');
    }

    const accessToken = await this.authenticateMaster();
    return {
      telegramUserId,
      isMaster: true,
      accessToken,
      channelId: this.getDefaultChannelId(),
      channelName: this.getDefaultChannelName(),
      pictaUsername: this.getConfiguredUsername(),
    };
  }

  public async getMinioUploadTicket(accessToken: string): Promise<PictaMinioTicket> {
    const apiUrl = getValidatedPictaApiUrl();
    const res = await fetchWithTimeout(
      `${apiUrl}/v2/publicacion/devolver_url_minio/`,
      { method: 'GET', headers: this.getAdminHeaders(accessToken) },
      15_000
    );
    if (!res.ok) throw new Error(`devolver_url_minio falló con HTTP ${res.status}`);

    const payload = (await res.json()) as { url_minio?: [string, Record<string, string>] };
    if (!Array.isArray(payload.url_minio) || payload.url_minio.length < 2) {
      throw new Error('Respuesta inválida de devolver_url_minio.');
    }
    const [rawEndpoint, fields] = payload.url_minio;
    const endpointParsed = new URL(rawEndpoint);
    if (
      (endpointParsed.protocol !== 'https:' && endpointParsed.protocol !== 'http:') ||
      PRIVATE_HOST_REGEX.test(endpointParsed.hostname)
    ) {
      throw new Error('Endpoint S3 MinIO bloqueado por validación de seguridad.');
    }
    const key = String(fields.key || '');
    if (!key) throw new Error('Ticket MinIO sin campo key.');
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
    if (stat.size <= 0) throw new Error('El archivo local a subir está vacío.');
    if (stat.size > MAX_PICTA_S3_BYTES) {
      throw new Error('El archivo supera el límite máximo de 5 GB de S3 MinIO en Picta.');
    }

    const boundary = `----PictaBot${crypto.randomBytes(12).toString('hex')}`;
    const safeName = params.fileName.replace(/["\r\n]/g, '_');
    const contentType = params.contentType || params.ticket.fields['Content-Type'] || 'video/mp4';

    const fieldChunks: Buffer[] = [];
    for (const [k, v] of Object.entries(params.ticket.fields)) {
      fieldChunks.push(
        Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`, 'utf8')
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
              reject(new Error(`Subida S3 MinIO rechazó archivo (HTTP ${status}): ${errBody}`));
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

      readStream.on('end', () => req.end(fileFooter));
      readStream.pipe(req, { end: false });
    });
  }

  public async triggerNomadConversion(minioKey: string, accessToken?: string): Promise<boolean> {
    const token = accessToken || (await this.authenticateMaster());
    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('action', 'convert');
    form.append('minio_id', minioKey);
    form.append('descargable', 'true');

    const res = await fetchWithTimeout(
      `${apiUrl}/v2/publicacion/proxy_nomad/`,
      { method: 'POST', headers: this.getAdminHeaders(token), body: form },
      12_000
    );
    if (res.ok) {
      netlog.info('picta', `Nomad proxy_nomad disparado para minio_id=${minioKey.slice(0, 28)}.`);
      return true;
    }
    netlog.warn('picta', `proxy_nomad devolvió HTTP ${res.status} para ${minioKey.slice(0, 28)}.`);
    return false;
  }

  public async uploadVideoToPictaPipeline(params: {
    ctx?: PictaAuthContext;
    filePath: string;
    fileName: string;
    title: string;
    description?: string;
    tipologia?: number;
    clasificacion?: string;
    channelId?: string;
    keywords?: string;
    publicado?: boolean;
    descargable?: boolean;
    serieId?: number;
    temporada?: string;
    numero?: string;
    coverUrl?: string;
    posterUrl?: string;
    customCoverPath?: string;
    onUploadProgress?: (uploadedBytes: number, totalBytes: number, speedMbps: number) => void;
  }): Promise<PictaUploadResult> {
    const token = params.ctx?.accessToken || (await this.authenticateMaster());
    const apiUrl = getValidatedPictaApiUrl();
    const ticket = await this.getMinioUploadTicket(token);

    netlog.info('picta', `Iniciando streaming S3 MinIO para "${params.title}" (256 KB).`);
    const uploadRes = await this.uploadFileToMinioStream({
      filePath: params.filePath,
      fileName: params.fileName,
      ticket,
      onProgress: params.onUploadProgress,
    });

    netlog.info('picta', `S3 MinIO completado para "${params.title}"`, {
      throughputMbps: uploadRes.speedMbps,
    });

    // Resolve cover image priority: custom photo -> safe remote URL -> ffmpeg frame -> minimal fallback JPEG
    let coverBuf: Buffer | null = null;
    if (params.customCoverPath && fs.existsSync(params.customCoverPath)) {
      try {
        coverBuf = fs.readFileSync(params.customCoverPath);
      } catch {
        coverBuf = null;
      }
    }
    if (!coverBuf && params.coverUrl) {
      coverBuf = await fetchSafeImageBuffer(params.coverUrl);
    }
    if (!coverBuf && params.posterUrl) {
      coverBuf = await fetchSafeImageBuffer(params.posterUrl);
    }
    if (!coverBuf) {
      const frameTmp = path.join(stateStore.scratchDir, `frame_${Date.now()}_${process.pid}.jpg`);
      coverBuf = await extractVideoFrameBufferWithFfmpeg(params.filePath, frameTmp);
    }
    if (!coverBuf) {
      coverBuf = Buffer.from(FALLBACK_JPEG_B64, 'base64');
    }

    let posterBuf: Buffer | null = null;
    if (params.posterUrl) {
      posterBuf = await fetchSafeImageBuffer(params.posterUrl);
    }
    if (!posterBuf) posterBuf = coverBuf;

    const channelId = (params.channelId || params.ctx?.channelId || this.getDefaultChannelId()).trim();
    const tipologia = String(params.tipologia || 8);
    const description = (params.description || `${params.title} — publicado vía PictaBot`).trim();
    const clasificacion = (params.clasificacion || process.env.PICTA_CLASIFICACION || '+16').trim();
    const publicado = params.publicado !== false;
    const descargable = params.descargable !== false;

    // 1. Non-fatal pre-validation
    try {
      const validateForm = new FormData();
      validateForm.append('tipo', 'publicacion');
      validateForm.append('tipologia', tipologia);
      validateForm.append('nombre', params.title);
      validateForm.append('descripcion', description);
      validateForm.append('canal', channelId);
      validateForm.append('url_manifiesto', ticket.key);
      await fetchWithTimeout(
        `${apiUrl}/v1/publicacion/validar_campos/`,
        { method: 'POST', headers: this.getAdminHeaders(token), body: validateForm },
        8_000
      );
    } catch {
      // Non-fatal
    }

    // 2. Create publication
    const pubForm = new FormData();
    pubForm.append('tipo', 'publicacion');
    pubForm.append('tipologia', tipologia);
    pubForm.append('nombre', params.title);
    pubForm.append('descripcion', description);
    pubForm.append('canal', channelId);
    pubForm.append('url_manifiesto', ticket.key);
    pubForm.append('publicado', String(publicado));
    pubForm.append('descargable', String(descargable));
    pubForm.append('mostrar_comentarios', 'true');
    pubForm.append('mostrar_chat', 'false');
    pubForm.append('internacional', 'false');
    pubForm.append('es_exclusivo', 'false');
    pubForm.append('clasificacion', clasificacion);
    pubForm.append('palabraClave', (params.keywords || process.env.PICTA_PALABRA_CLAVE_ID || '5476').trim());
    pubForm.append('url_imagen', new Blob([new Uint8Array(coverBuf)], { type: 'image/jpeg' }), `portada_${Date.now()}.jpg`);

    if (tipologia === '1') {
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
        new Blob([new Uint8Array(posterBuf)], { type: 'image/jpeg' }),
        `poster_${Date.now()}.jpg`
      );
    }

    if (tipologia === '5' && params.serieId) {
      pubForm.append('serie', String(params.serieId));
      pubForm.append('temporada', String(params.temporada || '1'));
      pubForm.append('numero', String(params.numero || '1'));
      pubForm.append(
        'imagen_secundaria',
        new Blob([new Uint8Array(posterBuf)], { type: 'image/jpeg' }),
        `poster_${Date.now()}.jpg`
      );
    }

    const createRes = await fetchWithTimeout(
      `${apiUrl}/v1/publicacion/`,
      { method: 'POST', headers: this.getAdminHeaders(token), body: pubForm },
      25_000
    );

    let publicationId: string | undefined;
    let slug: string | undefined;
    if (createRes.ok) {
      const created = (await createRes.json()) as { id?: string | number; slug?: string };
      if (created?.id !== undefined) publicationId = String(created.id);
      if (typeof created?.slug === 'string') slug = created.slug;
      netlog.info('picta', `Publicación creada en Picta (ID ${publicationId || 'N/A'}) para "${params.title}".`);
    } else {
      const errTxt = (await createRes.text()).slice(0, 260);
      throw new Error(`Error creando publicación en Picta (HTTP ${createRes.status}): ${errTxt}`);
    }

    // 3. Trigger Nomad encoder
    let nomadTriggered = false;
    try {
      nomadTriggered = await this.triggerNomadConversion(ticket.key, token);
    } catch (err) {
      netlog.warn(
        'picta',
        `proxy_nomad diferido al bucle 20s: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    return {
      minioKey: ticket.key,
      publicationId,
      webUrl: publicationId ? buildPublicationWebUrl(publicationId, slug) : undefined,
      nomadTriggered,
    };
  }

  public async fetchChannelDetails(ctx?: PictaAuthContext, channelId?: string): Promise<PictaChannelProfile | null> {
    const targetChannel = (channelId || ctx?.channelId || this.getDefaultChannelId()).trim();
    const apiUrl = getValidatedPictaApiUrl();
    const token = ctx?.accessToken || (await this.tryMasterToken());
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/canal/${encodeURIComponent(targetChannel)}/`,
        { method: 'GET', headers: this.getAdminHeaders(token) },
        10_000
      );
      if (!res.ok) return null;
      const d = (await res.json()) as Record<string, unknown>;
      return {
        id: Number(d.id ?? targetChannel),
        nombre: String(d.nombre ?? this.getDefaultChannelName()),
        alias: String(d.alias ?? ''),
        descripcion: String(d.descripcion ?? ''),
        clasificacion: String(d.clasificacion ?? '+16'),
        slug_url: typeof d.slug_url === 'string' ? d.slug_url : undefined,
        visible: d.visible !== false,
        publicado: d.publicado !== false,
        cantidad_suscriptores: Number(d.cantidad_suscriptores ?? 0),
        cantidad_publicaciones: Number(d.cantidad_publicaciones ?? 0),
        url_avatar: typeof d.url_avatar === 'string' ? d.url_avatar : undefined,
        url_imagen: typeof d.url_imagen === 'string' ? d.url_imagen : undefined,
      };
    } catch {
      return null;
    }
  }

  private mapPublicationRow(r: Record<string, unknown>): PictaCatalogItem {
    const id = String(r.id ?? '');
    const slug = typeof r.slug === 'string' ? r.slug : undefined;
    const tipObj = r.tipologia && typeof r.tipologia === 'object' ? (r.tipologia as Record<string, unknown>) : null;
    const tipId = tipObj ? Number(tipObj.id || 0) : Number(r.tipologia || 0);
    const tipName =
      (tipObj && typeof tipObj.nombre === 'string' && tipObj.nombre) ||
      PICTA_TIPOLOGIAS[tipId] ||
      'Audiovisual';

    return {
      id,
      nombre: String(r.nombre ?? 'Sin título'),
      descripcion: String(r.descripcion ?? ''),
      slug,
      webUrl: buildPublicationWebUrl(id, slug),
      tipologiaId: tipId || undefined,
      tipologiaNombre: tipName,
      clasificacion: String(r.clasificacion ?? '+16'),
      cantidad_vistas: Number(r.cantidad_vistas ?? r.cantidad_reproducciones ?? 0),
      cantidad_comentarios: Number(r.cantidad_comentarios ?? 0),
      cantidad_me_gusta: Number(r.cantidad_me_gusta ?? r.cantidad_likes ?? 0),
      cantidad_descargas: Number(r.cantidad_descargas ?? 0),
      publicado: Boolean(r.publicado),
      descargable: r.descargable !== false,
      estado_codificacion: typeof r.estado_codificacion === 'string' ? r.estado_codificacion : undefined,
      url_imagen: typeof r.url_imagen === 'string' ? r.url_imagen : undefined,
      imagen_secundaria: typeof r.imagen_secundaria === 'string' ? r.imagen_secundaria : undefined,
      url_descarga: typeof r.url_descarga === 'string' ? r.url_descarga : undefined,
      url_manifiesto: typeof r.url_manifiesto === 'string' ? r.url_manifiesto : undefined,
      fecha_creacion: typeof r.fecha_creacion === 'string' ? r.fecha_creacion : undefined,
    };
  }

  public async fetchChannelPublications(params: {
    ctx?: PictaAuthContext;
    channelId?: string;
    page?: number;
    pageSize?: number;
    search?: string;
  }): Promise<{ items: PictaCatalogItem[]; total: number; hasNext: boolean }> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (params.channelId || params.ctx?.channelId || this.getDefaultChannelId()).trim();
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(50, Math.max(1, params.pageSize || 10));
    const token = params.ctx?.accessToken || (await this.tryMasterToken());

    const url = new URL(`${apiUrl}/v2/publicacion/`);
    url.searchParams.set('canal_id', targetChannel);
    url.searchParams.set('page', String(page));
    url.searchParams.set('page_size', String(pageSize));
    if (params.search?.trim()) url.searchParams.set('search', params.search.trim());

    try {
      const res = await fetchWithTimeout(
        url.toString(),
        { method: 'GET', headers: this.getAdminHeaders(token) },
        10_000
      );
      if (!res.ok) return { items: [], total: 0, hasNext: false };
      const data = (await res.json()) as {
        count?: number;
        next?: string | null;
        results?: Array<Record<string, unknown>>;
      };
      const rows = Array.isArray(data.results) ? data.results : [];
      return {
        items: rows.map((r) => this.mapPublicationRow(r)),
        total: Number(data.count ?? rows.length),
        hasNext: Boolean(data.next),
      };
    } catch {
      return { items: [], total: 0, hasNext: false };
    }
  }

  public async fetchPublicationById(videoId: string, ctx?: PictaAuthContext): Promise<PictaCatalogItem | null> {
    const apiUrl = getValidatedPictaApiUrl();
    const token = ctx?.accessToken || (await this.tryMasterToken());
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/publicacion/${encodeURIComponent(videoId)}/`,
        { method: 'GET', headers: this.getAdminHeaders(token) },
        8_000
      );
      if (!res.ok) return null;
      return this.mapPublicationRow((await res.json()) as Record<string, unknown>);
    } catch {
      return null;
    }
  }

  public async patchPublication(
    ctx: PictaAuthContext,
    videoId: string,
    fields: {
      nombre?: string;
      descripcion?: string;
      publicado?: boolean;
      descargable?: boolean;
      clasificacion?: string;
      tipologia?: number;
      coverBuffer?: Buffer;
      posterBuffer?: Buffer;
    }
  ): Promise<PictaCatalogItem | null> {
    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    if (fields.nombre !== undefined) form.append('nombre', fields.nombre);
    if (fields.descripcion !== undefined) form.append('descripcion', fields.descripcion);
    if (fields.publicado !== undefined) form.append('publicado', String(fields.publicado));
    if (fields.descargable !== undefined) form.append('descargable', String(fields.descargable));
    if (fields.clasificacion !== undefined) form.append('clasificacion', fields.clasificacion);
    if (fields.tipologia !== undefined) form.append('tipologia', String(fields.tipologia));
    if (fields.coverBuffer) {
      form.append('url_imagen', new Blob([new Uint8Array(fields.coverBuffer)], { type: 'image/jpeg' }), `cover_${Date.now()}.jpg`);
    }
    if (fields.posterBuffer) {
      form.append(
        'imagen_secundaria',
        new Blob([new Uint8Array(fields.posterBuffer)], { type: 'image/jpeg' }),
        `poster_${Date.now()}.jpg`
      );
    }

    for (const ver of ['v1', 'v2']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/publicacion/${encodeURIComponent(videoId)}/`,
        { method: 'PATCH', headers: this.getAdminHeaders(ctx.accessToken), body: form },
        15_000
      );
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        return this.mapPublicationRow(json);
      }
    }
    throw new Error(`Picta rechazó la edición de la publicación #${videoId}.`);
  }

  public async deletePublication(ctx: PictaAuthContext, videoId: string): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const ver of ['v1', 'v2']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/publicacion/${encodeURIComponent(videoId)}/`,
        { method: 'DELETE', headers: this.getAdminHeaders(ctx.accessToken) },
        12_000
      );
      if (res.ok || res.status === 204) {
        netlog.warn('picta', `Publicación #${videoId} eliminada por ${ctx.pictaUsername}.`);
        return true;
      }
    }
    return false;
  }

  public async fetchChannelSeries(ctx: PictaAuthContext, channelId?: string): Promise<PictaSerieItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (channelId || ctx.channelId).trim();
    const pinnedSet = new Set(stateStore.pinnedSeriesIds);
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/serie/?canal_id=${encodeURIComponent(targetChannel)}&page_size=50`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const rows = Array.isArray(data.results) ? data.results : [];
      return rows
        .map((r) => {
          const id = Number(r.id || 0);
          return {
            id,
            nombre: String(r.nombre || `Serie #${id}`),
            descripcion: String(r.descripcion || ''),
            canalId: Number(r.canal || targetChannel),
            cantidad_capitulos: Number(r.cantidad_capitulos ?? r.cantidad_publicaciones ?? 0),
            url_imagen: typeof r.url_imagen === 'string' ? r.url_imagen : undefined,
            imagen_secundaria: typeof r.imagen_secundaria === 'string' ? r.imagen_secundaria : undefined,
            publicado: r.publicado !== false,
            pinned: pinnedSet.has(id),
          };
        })
        .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
    } catch {
      return [];
    }
  }

  public async createSerie(
    ctx: PictaAuthContext,
    params: { nombre: string; descripcion?: string; coverBuffer?: Buffer }
  ): Promise<PictaSerieItem> {
    const apiUrl = getValidatedPictaApiUrl();
    const coverBuf = params.coverBuffer || Buffer.from(FALLBACK_JPEG_B64, 'base64');
    const form = new FormData();
    form.append('nombre', params.nombre.trim());
    form.append('descripcion', (params.descripcion || params.nombre).trim());
    form.append('canal', ctx.channelId);
    form.append('publicado', 'true');
    form.append('url_imagen', new Blob([new Uint8Array(coverBuf)], { type: 'image/jpeg' }), `serie_${Date.now()}.jpg`);

    const res = await fetchWithTimeout(
      `${apiUrl}/v1/serie/`,
      { method: 'POST', headers: this.getAdminHeaders(ctx.accessToken), body: form },
      15_000
    );
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      throw new Error(`No se pudo crear la serie (HTTP ${res.status}): ${txt}`);
    }
    const r = (await res.json()) as Record<string, unknown>;
    return {
      id: Number(r.id || 0),
      nombre: String(r.nombre || params.nombre),
      descripcion: String(r.descripcion || ''),
      canalId: Number(ctx.channelId),
      cantidad_capitulos: 0,
      publicado: true,
      pinned: false,
    };
  }

  public async fetchChannelPlaylists(ctx: PictaAuthContext, channelId?: string): Promise<PictaPlaylistItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (channelId || ctx.channelId).trim();
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/lista_reproduccion/?canal_id=${encodeURIComponent(targetChannel)}&page_size=50`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const rows = Array.isArray(data.results) ? data.results : [];
      return rows.map((r) => ({
        id: Number(r.id || 0),
        nombre: String(r.nombre || 'Lista sin nombre'),
        publicado: r.publicado !== false,
        descarga: Boolean(r.descarga),
        fecha_creacion: typeof r.fecha_creacion === 'string' ? r.fecha_creacion : undefined,
        canalId: Number(targetChannel),
        canalNombre: ctx.channelName,
        publicacionesIds: Array.isArray(r.publicaciones) ? r.publicaciones.map((x) => Number(x)) : [],
      }));
    } catch {
      return [];
    }
  }

  public async createPlaylist(ctx: PictaAuthContext, nombre: string): Promise<PictaPlaylistItem> {
    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('nombre', nombre.trim());
    form.append('canal', ctx.channelId);
    form.append('publicado', 'true');
    form.append('descarga', 'true');

    const res = await fetchWithTimeout(
      `${apiUrl}/v1/lista_reproduccion/`,
      { method: 'POST', headers: this.getAdminHeaders(ctx.accessToken), body: form },
      12_000
    );
    if (!res.ok) {
      const txt = (await res.text()).slice(0, 200);
      throw new Error(`No se pudo crear la lista (HTTP ${res.status}): ${txt}`);
    }
    const r = (await res.json()) as Record<string, unknown>;
    return {
      id: Number(r.id || 0),
      nombre: String(r.nombre || nombre),
      publicado: true,
      descarga: true,
      canalId: Number(ctx.channelId),
      canalNombre: ctx.channelName,
      publicacionesIds: [],
    };
  }

  public async fetchChannelComments(ctx: PictaAuthContext, limit = 25): Promise<PictaCommentItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const ignoredSet = new Set(stateStore.ignoredCommentIds);
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/comentario/?canal_id=${encodeURIComponent(ctx.channelId)}&page_size=${Math.min(50, limit)}&ordering=-fecha`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        12_000
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const rows = Array.isArray(data.results) ? data.results : [];
      let newRequestsAdded = false;

      const mapped: PictaCommentItem[] = rows.map((r) => {
        const id = Number(r.id || 0);
        const texto = String(r.texto || r.comentario || '').trim();
        const userObj = r.usuario && typeof r.usuario === 'object' ? (r.usuario as Record<string, unknown>) : null;
        const pubObj = r.publicacion && typeof r.publicacion === 'object' ? (r.publicacion as Record<string, unknown>) : null;
        const usuario =
          (userObj && String(userObj.username || userObj.first_name || 'Usuario')) ||
          String(r.usuario_nombre || 'Usuario');
        const publicacionId = pubObj ? Number(pubObj.id || 0) : Number(r.publicacion || 0);
        const publicacionNombre = (pubObj && String(pubObj.nombre || 'Video')) || String(r.publicacion_nombre || 'Video');
        const replyCount = Number(r.cantidad_respuestas ?? (Array.isArray(r.respuestas) ? r.respuestas.length : 0));
        const reqCheck = detectViewerRequestComment(texto);

        if (reqCheck.isRequest && id > 0 && !stateStore.channelRequests.some((cr) => cr.commentId === id)) {
          stateStore.channelRequests.unshift({
            id: crypto.randomUUID(),
            commentId: id,
            requesterName: usuario,
            requestedTitle: reqCheck.extractedTitle,
            rawText: texto.slice(0, 260),
            sourceVideoTitle: publicacionNombre,
            status: 'pending',
            createdAt: String(r.fecha || new Date().toISOString()),
          });
          newRequestsAdded = true;
        }

        return {
          id,
          texto,
          usuario,
          usuarioId: userObj ? Number(userObj.id || 0) : undefined,
          fecha: String(r.fecha || ''),
          publicacionId,
          publicacionNombre,
          categoriaNombre: 'Comentario',
          parentId: r.parent ? Number(r.parent) : undefined,
          replyCount,
          answered: replyCount > 0,
          isLikelyRequest: reqCheck.isRequest,
          ignored: ignoredSet.has(id),
        };
      });

      if (newRequestsAdded) stateStore.saveChannelRequests();
      return mapped;
    } catch {
      return [];
    }
  }

  public async replyToComment(
    ctx: PictaAuthContext,
    params: { publicacionId: number; parentCommentId: number; texto: string }
  ): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    const payload = {
      publicacion: params.publicacionId,
      parent: params.parentCommentId,
      texto: params.texto.trim(),
    };

    for (const ver of ['v2', 'v1']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/comentario/`,
        {
          method: 'POST',
          headers: {
            ...this.getAdminHeaders(ctx.accessToken),
            'Content-Type': 'application/json',
          },
          body: JSON.stringify(payload),
        },
        12_000
      );
      if (res.ok) return true;
    }
    return false;
  }

  public async fetchDenunciasSummary(ctx: PictaAuthContext): Promise<PictaDenunciasSummary> {
    const apiUrl = getValidatedPictaApiUrl();
    const empty: PictaDenunciasSummary = {
      cantidad_pendientes: 0,
      cantidad_en_proceso: 0,
      cantidad_no_proceden: 0,
      cantidad_procesadas: 0,
      total: 0,
    };
    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/denuncia/resumen/?canal_id=${encodeURIComponent(ctx.channelId)}`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (!res.ok) return empty;
      const d = (await res.json()) as Record<string, unknown>;
      const pendientes = Number(d.cantidad_pendientes ?? 0);
      const proceso = Number(d.cantidad_en_proceso ?? 0);
      const noProceden = Number(d.cantidad_no_proceden ?? 0);
      const procesadas = Number(d.cantidad_procesadas ?? 0);
      return {
        cantidad_pendientes: pendientes,
        cantidad_en_proceso: proceso,
        cantidad_no_proceden: noProceden,
        cantidad_procesadas: procesadas,
        total: pendientes + proceso + noProceden + procesadas,
      };
    } catch {
      return empty;
    }
  }

  public async fetchChannelStats(ctx?: PictaAuthContext): Promise<Record<string, unknown> | null> {
    try {
      const token = ctx?.accessToken || (await this.authenticateMaster());
      const apiUrl = getValidatedPictaApiUrl();
      const todayHavana = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Havana',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());

      const res = await fetchWithTimeout(
        `${apiUrl}/v2/resumen/datos/?date__gte=${todayHavana}&date__lte=${todayHavana}`,
        { method: 'GET', headers: this.getAdminHeaders(token) },
        10_000
      );
      if (!res.ok) return null;
      return (await res.json()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private async tryMasterToken(): Promise<string | undefined> {
    if (this.getConfiguredUsername() && this.getConfiguredPassword() && this.getConfiguredClientId()) {
      try {
        return await this.authenticateMaster();
      } catch {
        return undefined;
      }
    }
    return undefined;
  }

  public async scanAllPictaAlertsAndMilestones(
    notifyFn?: (telegramUserId: string, text: string) => Promise<boolean>
  ): Promise<{ scannedCount: number; newAlerts: PictaAlertEvent[] }> {
    const started = Date.now();
    const apiUrl = getValidatedPictaApiUrl();
    const newAlerts: PictaAlertEvent[] = [];
    const token = await this.tryMasterToken();

    if (stateStore.watchedVideos.length === 0 && this.getDefaultChannelId()) {
      try {
        const pubs = await this.fetchChannelPublications({ channelId: this.getDefaultChannelId(), pageSize: 15 });
        const defaultOwner = stateStore.getPrimaryAdminChatId();
        for (const pub of pubs.items) {
          if (!pub.id) continue;
          stateStore.watchedVideos.push({
            videoId: pub.id,
            title: pub.nombre,
            channelName: this.getDefaultChannelName(),
            ownerUserId: defaultOwner,
            lastCommentCount: pub.cantidad_comentarios,
            lastViewsCount: pub.cantidad_vistas,
            lastMilestoneNotified: [...VIEW_MILESTONES].reverse().find((m) => pub.cantidad_vistas >= m) || 0,
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
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/publicacion/${encodeURIComponent(video.videoId)}/`,
          { method: 'GET', headers: this.getAdminHeaders(token) },
          6_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          cantidad_vistas?: number;
          cantidad_reproducciones?: number;
          cantidad_comentarios?: number;
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
            summary: `${diff} nuevo(s) comentario(s) (total: ${comments}).`,
            metricValue: comments,
            notifiedTelegram: false,
            targetUserId: video.ownerUserId,
            detectedAt: new Date().toISOString(),
          };
          if (notifyFn && video.ownerUserId) {
            alert.notifiedTelegram = await notifyFn(
              video.ownerUserId,
              `💬 Nuevo comentario en <b>${video.title}</b> (${video.channelName}): ${comments} totales.\nUsa /comentarios para responder o generar respuesta con IA.`
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
            summary: `Logro: ${reachedMilestone.toLocaleString('es-ES')} vistas.`,
            metricValue: reachedMilestone,
            notifiedTelegram: false,
            targetUserId: video.ownerUserId,
            detectedAt: new Date().toISOString(),
          };
          if (notifyFn && video.ownerUserId) {
            alert.notifiedTelegram = await notifyFn(
              video.ownerUserId,
              `🏆 Logro en Picta: <b>${video.title}</b> superó <b>${reachedMilestone.toLocaleString('es-ES')}</b> vistas.`
            );
          }
          newAlerts.push(alert);
          video.lastMilestoneNotified = reachedMilestone;
        }

        video.lastViewsCount = views;
        video.nomadStatus = data.publicado ? 'ready' : 'encoding';
        video.updatedAt = new Date().toISOString();
      } catch {
        // Transient network hiccup
      }
    }

    if (newAlerts.length > 0) {
      stateStore.alerts.unshift(...newAlerts);
      stateStore.saveAlerts();
    }

    stateStore.saveWatchedVideos();
    this.lastAlertScanAt = new Date().toISOString();

    netlog.info(
      'picta',
      `Ciclo alertas Picta: ${stateStore.watchedVideos.length} videos vigilados, ${newAlerts.length} alertas.`,
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
    const token = encodingJobs.length > 0 ? await this.tryMasterToken() : undefined;

    for (const job of encodingJobs) {
      job.nomadRetries += 1;
      job.updatedAt = new Date().toISOString();

      let jobToken = token;
      if (job.userId && !stateStore.isMasterAdmin(job.userId)) {
        try {
          const userCtx = await this.resolveContextForUser(job.userId);
          jobToken = userCtx.accessToken;
        } catch {
          // Keep fallback
        }
      }

      if (job.nomadRetries >= job.maxNomadRetries) {
        job.status = 'failed';
        job.errorMessage = `Codificador Nomad no confirmó procesamiento tras ${job.maxNomadRetries} reintentos.`;
        advanced += 1;
        netlog.warn('picta', `Job ${job.id.slice(0, 8)} superó límite Nomad.`);
        continue;
      }

      if (job.minioKey && jobToken && job.nomadRetries <= 3) {
        try {
          await this.triggerNomadConversion(job.minioKey, jobToken);
        } catch {
          // Re-check publication below
        }
      }

      if (job.pictaVideoId) {
        try {
          const apiUrl = getValidatedPictaApiUrl();
          const res = await fetchWithTimeout(
            `${apiUrl}/v2/publicacion/${encodeURIComponent(job.pictaVideoId)}/`,
            { headers: this.getAdminHeaders(jobToken) },
            6_000
          );
          if (res.ok) {
            const payload = (await res.json()) as { publicado?: boolean; estado_codificacion?: string };
            if (payload.publicado || payload.estado_codificacion === 'ready') {
              job.status = 'completed';
              job.progressPct = 100;
              advanced += 1;
              netlog.info('picta', `Nomad completó codificación de "${job.title}".`);
              if (notifyFn && job.telegramChatId) {
                await notifyFn(
                  job.telegramChatId,
                  `✅ Codificación Nomad lista: <b>${job.title}</b>${job.pictaWebUrl ? `\n🔗 ${job.pictaWebUrl}` : ''}`
                );
              }
            }
          }
        } catch {
          // Next 20s tick
        }
      }
    }

    if (encodingJobs.length > 0) stateStore.saveJobs();
    return { checked: encodingJobs.length, advanced };
  }
}

export const pictaService = new PictaService();
