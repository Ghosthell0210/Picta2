import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import https from 'https';
import path from 'path';
import type {
  ChannelAuditItem,
  ChannelAuditReport,
  OwnedPictaChannel,
  PictaAlertEvent,
  PictaCatalogItem,
  PictaChannelProfile,
  PictaCommentItem,
  PictaDenunciaItem,
  PictaDenunciasSummary,
  PictaGlobalSearchHit,
  PictaPlaylistItem,
  PictaPoolAccount,
  PictaSerieItem,
  PictaSerieSeason,
} from '../shared/types.ts';
import {
  detectViewerRequestComment,
  extractVideoFrameBufferWithFfmpeg,
  fetchSafeImageBuffer,
} from './mediaIntelligence.ts';
import { netlog } from './netlog.ts';
import { getCubaDateStr, stateStore } from './stateStore.ts';

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
  6: 'Deporte',
  8: 'Audiovisual',
  11: 'Videoclip',
  14: 'Gameplay',
  15: 'Shorts',
  17: 'Reportaje',
  18: 'Receta',
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
  return validateExternalUrl(process.env.PICTA_BASE_URL || 'https://www.picta.cu', 'https://www.picta.cu');
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
  usedPoolAccount?: string;
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
  if (slug) return `${base}/medias/${slug.replace(/^\/+/, '')}`;
  return `${base}/medias/${id}`;
}

function normalizeTitleForAudit(raw: string): string {
  return String(raw || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

const EPISODE_PATTERN_REGEX =
  /\b(?:s\d{1,2}\s*e\d{1,3}|t\d{1,2}\s*(?:e|cap|ep)\.?\s*\d{1,3}|\d{1,2}x\d{1,3}|cap(?:itulo|\.)?\s*\d{1,3}|episodio\s*\d{1,3})\b/i;

export class PictaService {
  public lastAlertScanAt?: string;
  public lastNomadCheckAt?: string;

  private masterToken: PictaOAuthToken | null = null;
  private userTokenCache = new Map<string, PictaOAuthToken>();
  private poolTokenCache = new Map<string, PictaOAuthToken>();

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

  public async requestOAuthToken(rawUsername: string, password: string): Promise<PictaOAuthToken> {
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
    groups: string[];
    hasChannelAdminRole: boolean;
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

      const rawGroups = Array.isArray(parsed.groups)
        ? parsed.groups
        : Array.isArray(parsed.grupos)
          ? parsed.grupos
          : [];
      const groups = rawGroups
        .map((g) => (typeof g === 'string' ? g : typeof g === 'object' && g ? String((g as { name?: unknown; nombre?: unknown }).name || (g as { nombre?: unknown }).nombre || '') : ''))
        .filter(Boolean);
      const isSuper = Boolean(parsed.is_superuser || parsed.is_staff);
      const hasChannelAdminRole =
        isSuper ||
        groups.some((g) => /jefe|canal|admin|editor|productor/i.test(g)) ||
        groups.length > 0;

      return {
        id: typeof parsed.id === 'number' ? parsed.id : undefined,
        username: typeof parsed.username === 'string' ? parsed.username : undefined,
        firstName: typeof parsed.first_name === 'string' ? parsed.first_name : undefined,
        lastName: typeof parsed.last_name === 'string' ? parsed.last_name : undefined,
        groups,
        hasChannelAdminRole,
      };
    } catch {
      return null;
    }
  }

  public async checkLivePublishPermission(accessToken: string): Promise<{ allowed: boolean; statusText: string }> {
    try {
      const apiUrl = getValidatedPictaApiUrl();
      const res = await fetchWithTimeout(
        `${apiUrl}/v1/publicacion/validar_campos/`,
        { method: 'POST', headers: this.getAdminHeaders(accessToken), body: new FormData() },
        8_000
      );
      if (res.status === 403) {
        return { allowed: false, statusText: '🔴 Bloqueado (HTTP 403 en Picta · falta rol Jefe de canal)' };
      }
      return { allowed: true, statusText: '🟢 Activo (Permiso de publicación habilitado)' };
    } catch {
      return { allowed: true, statusText: '⚠️ No se pudo comprobar en vivo con Picta' };
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

  public async findPictaChannelByQuery(ctx: PictaAuthContext, rawQuery: string): Promise<OwnedPictaChannel[]> {
    const apiUrl = getValidatedPictaApiUrl();
    let q = rawQuery.trim();
    const urlMatch = q.match(/picta\.cu\/canal\/([^/?#\s]+)/i);
    if (urlMatch?.[1]) q = decodeURIComponent(urlMatch[1]);
    q = q.replace(/^#/, '').trim();
    if (!q) return [];

    if (/^\d+$/.test(q)) {
      const det = await this.fetchChannelDetails(ctx, q);
      if (det) {
        return [{ id: det.id, nombre: det.nombre, alias: det.alias, slug_url: det.slug_url }];
      }
    }

    try {
      const res = await fetchWithTimeout(
        `${apiUrl}/v2/canal/?search=${encodeURIComponent(q)}&page_size=10`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (!res.ok) return [];
      const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
      const list = Array.isArray(data.results) ? data.results : [];
      return list
        .filter((c) => c.id !== undefined)
        .map((c) => ({
          id: Number(c.id),
          nombre: String(c.nombre || `Canal #${c.id}`),
          alias: typeof c.alias === 'string' ? c.alias : undefined,
          slug_url: typeof c.slug_url === 'string' ? c.slug_url : undefined,
        }));
    } catch {
      return [];
    }
  }

  public async authenticateAndInspectAccount(
    username: string,
    password: string
  ): Promise<{
    token: PictaOAuthToken;
    pictaUserId?: number;
    displayName: string;
    groups: string[];
    hasChannelAdminRole: boolean;
    ownedChannels: OwnedPictaChannel[];
  }> {
    const token = await this.requestOAuthToken(username, password);
    const me = await this.fetchMeProfileWithToken(token.accessToken);
    const livePerm = await this.checkLivePublishPermission(token.accessToken);
    const ownedChannels = await this.fetchOwnedChannelsWithToken(token.accessToken, me?.id);
    const displayName = [me?.firstName, me?.lastName].filter(Boolean).join(' ').trim() || me?.username || username;
    return {
      token,
      pictaUserId: me?.id,
      displayName,
      groups: me?.groups || [],
      hasChannelAdminRole: livePerm.allowed && (me?.hasChannelAdminRole ?? true),
      ownedChannels,
    };
  }

  public async resolveContextForUser(telegramUserId: string): Promise<PictaAuthContext> {
    const session = stateStore.userSessions.find((s) => s.telegramUserId === telegramUserId);
    const isMaster = stateStore.isMasterAdmin(telegramUserId);

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
        throw new Error('Tu cuenta de Picta no tiene un canal seleccionado. Usa /canal o /login.');
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

  public async resolvePoolAccountToken(acc: PictaPoolAccount): Promise<string | null> {
    const cached = this.poolTokenCache.get(acc.id);
    if (cached && Date.now() < cached.expiresAtMs - 60_000) {
      return cached.accessToken;
    }
    const plain = stateStore.decryptUserSecret(acc.encryptedPassword);
    if (!plain) return null;
    try {
      const tok = await this.requestOAuthToken(acc.username, plain);
      this.poolTokenCache.set(acc.id, tok);
      return tok.accessToken;
    } catch {
      return null;
    }
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

  public async uploadSubtitleBufferToMinioS3(
    accessToken: string,
    subBuf: Buffer,
    fileName = 'subtitulos.srt'
  ): Promise<string | null> {
    try {
      const ticket = await this.getMinioUploadTicket(accessToken);
      const s3Form = new FormData();
      for (const [k, v] of Object.entries(ticket.fields)) {
        s3Form.append(k, v);
      }
      const cleanName = fileName.replace(/[^a-zA-Z0-9._-]/g, '_') || 'subtitulos.srt';
      s3Form.append('file', new Blob([new Uint8Array(subBuf)], { type: 'text/plain' }), cleanName);
      const s3Res = await fetchWithTimeout(ticket.endpoint, { method: 'POST', body: s3Form }, 20_000);
      if (!s3Res.ok && s3Res.status !== 204) return null;
      const cleanEndpoint = ticket.endpoint.replace(/\/+$/, '');
      return `${cleanEndpoint}/${ticket.key}`;
    } catch {
      return null;
    }
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

  /**
   * Uploads video to S3 (or reuses existingMinioKey on /reintentar), rotates through Pool accounts if daily quota is hit,
   * auto-resolves duplicate title 400 errors with (Año) or (v2), uploads optional .srt subtitles, and triggers Nomad.
   */
  public async uploadVideoToPictaPipeline(params: {
    ctx?: PictaAuthContext;
    filePath?: string;
    existingMinioKey?: string;
    fileName: string;
    title: string;
    description?: string;
    tipologia?: number;
    clasificacion?: string;
    channelId?: string;
    keywords?: string;
    year?: string;
    publicado?: boolean;
    descargable?: boolean;
    mostrarComentarios?: boolean;
    serieId?: number;
    temporada?: string;
    temporadaId?: number;
    numero?: string;
    playlistId?: number;
    coverUrl?: string;
    posterUrl?: string;
    customCoverPath?: string;
    customPosterPath?: string;
    subtitlePath?: string;
    subtitleFileName?: string;
    onMinioUploaded?: (minioKey: string) => void;
    onUploadProgress?: (uploadedBytes: number, totalBytes: number, speedMbps: number) => void;
  }): Promise<PictaUploadResult> {
    stateStore.resetDailyQuotasIfNeeded();
    const primaryToken = params.ctx?.accessToken || (await this.authenticateMaster());
    const ownerUserId = params.ctx?.telegramUserId || stateStore.getPrimaryAdminChatId();
    const isMaster = params.ctx?.isMaster ?? true;
    const tipNum = Number(params.tipologia || 8);

    // Check daily series reservation split if configured on master
    if (isMaster) {
      const maxS = Number(stateStore.quotaSettings.maxSeriesPerDay || 0);
      const sToday = Number(stateStore.quotaSettings.seriesUploadedToday || 0);
      const oToday = Number(stateStore.quotaSettings.otherUploadedToday || 0);
      if (maxS > 0 && tipNum === 5 && sToday >= maxS) {
        throw new Error(
          `QUOTA_SERIE_RESERVED_REACHED: Se alcanzó el cupo diario asignado a capítulos de Series (${sToday}/${maxS}). Ajusta la división en /cuota o espera al reinicio diario.`
        );
      }
      if (maxS > 0 && tipNum !== 5 && oToday >= Math.max(0, 10 - maxS)) {
        throw new Error(
          `QUOTA_OTHER_RESERVED_REACHED: Se alcanzó el cupo diario reservado para Películas/Otros (${oToday}/${10 - maxS}). Ajusta la división en /cuota.`
        );
      }
    }

    const userPool = (stateStore.quotaSettings.poolAccounts || []).filter(
      (a) => a.ownerUserId === ownerUserId || (isMaster && !a.ownerUserId)
    );

    let finalMinioKey = (params.existingMinioKey || '').trim();
    if (!finalMinioKey) {
      if (!params.filePath || !fs.existsSync(params.filePath)) {
        throw new Error('Archivo local de video no encontrado para subir a S3 MinIO.');
      }
      // We can use an S3 accelerator pool account if available, or primary token
      let s3Token = primaryToken;
      const accelAcc = userPool.find((a) => (a.uploadedToday || 0) < 10);
      if (accelAcc) {
        const pTok = await this.resolvePoolAccountToken(accelAcc);
        if (pTok) s3Token = pTok;
      }

      const ticket = await this.getMinioUploadTicket(s3Token);
      netlog.info('picta', `Iniciando streaming S3 MinIO para "${params.title}" (256 KB).`);
      const uploadRes = await this.uploadFileToMinioStream({
        filePath: params.filePath,
        fileName: params.fileName,
        ticket,
        onProgress: params.onUploadProgress,
      });
      finalMinioKey = ticket.key;
      if (params.onMinioUploaded) params.onMinioUploaded(finalMinioKey);
      netlog.info('picta', `S3 MinIO completado para "${params.title}" (minioKey=${finalMinioKey})`, {
        throughputMbps: uploadRes.speedMbps,
      });
    } else {
      netlog.info('picta', `Reutilizando manifiesto S3 MinIO existente (${finalMinioKey}) para "${params.title}".`);
    }

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
    if (!coverBuf && params.filePath && fs.existsSync(params.filePath)) {
      const frameTmp = path.join(stateStore.scratchDir, `frame_${Date.now()}_${process.pid}.jpg`);
      coverBuf = await extractVideoFrameBufferWithFfmpeg(params.filePath, frameTmp);
    }
    if (!coverBuf) {
      coverBuf = Buffer.from(FALLBACK_JPEG_B64, 'base64');
    }

    let posterBuf: Buffer | null = null;
    if (params.customPosterPath && fs.existsSync(params.customPosterPath)) {
      try {
        posterBuf = fs.readFileSync(params.customPosterPath);
      } catch {
        posterBuf = null;
      }
    }
    if (!posterBuf && params.posterUrl) {
      posterBuf = await fetchSafeImageBuffer(params.posterUrl);
    }
    if (!posterBuf) posterBuf = coverBuf;

    let subtitleUrl: string | null = null;
    if (params.subtitlePath && fs.existsSync(params.subtitlePath)) {
      try {
        const subBuf = fs.readFileSync(params.subtitlePath);
        subtitleUrl = await this.uploadSubtitleBufferToMinioS3(
          primaryToken,
          subBuf,
          params.subtitleFileName || 'subtitulos.srt'
        );
      } catch {
        subtitleUrl = null;
      }
    }

    const channelId = (params.channelId || params.ctx?.channelId || this.getDefaultChannelId()).trim();
    const tipologia = String(tipNum);
    const rawKeywords = (params.keywords || '').trim();
    const palabraClavePk = /^\d+$/.test(rawKeywords)
      ? rawKeywords
      : (process.env.PICTA_PALABRA_CLAVE_ID || '5476').trim();
    const baseDesc = (params.description || `${params.title} — disponible en Picta`).trim();
    const tagLine =
      rawKeywords && !/^\d+$/.test(rawKeywords)
        ? `\n\nEtiquetas: ${rawKeywords
            .split(/[,;]+/)
            .map((t) => t.trim())
            .filter(Boolean)
            .slice(0, 8)
            .join(', ')}`
        : '';
    const description = `${baseDesc}${tagLine}`.slice(0, 2000);
    const clasificacion = (params.clasificacion || process.env.PICTA_CLASIFICACION || '+16').trim();
    const publicado = params.publicado !== false;
    const descargable = params.descargable !== false;
    const mostrarComentarios = params.mostrarComentarios !== false;
    const movieYear = /^\d{4}$/.test(String(params.year || '')) ? String(params.year) : String(new Date().getFullYear());

    // Build candidate tokens: primary account first, then publishable Pool accounts
    const candidateAuths: Array<{ token: string; poolAcc?: PictaPoolAccount }> = [{ token: primaryToken }];
    for (const acc of userPool) {
      if (acc.canPublishDirectly !== false && (acc.uploadedToday || 0) < 10) {
        const pTok = await this.resolvePoolAccountToken(acc);
        if (pTok) candidateAuths.push({ token: pTok, poolAcc: acc });
      }
    }

    const apiUrl = getValidatedPictaApiUrl();
    const buildPubForm = (titleToUse: string) => {
      const pubForm = new FormData();
      pubForm.append('tipo', 'publicacion');
      pubForm.append('tipologia', tipologia);
      pubForm.append('nombre', titleToUse);
      pubForm.append('descripcion', description);
      pubForm.append('canal', channelId);
      pubForm.append('url_manifiesto', finalMinioKey);
      pubForm.append('publicado', String(publicado));
      pubForm.append('descargable', String(descargable));
      pubForm.append('mostrar_comentarios', String(mostrarComentarios));
      pubForm.append('mostrar_chat', 'false');
      pubForm.append('internacional', 'false');
      pubForm.append('es_exclusivo', 'false');
      pubForm.append('clasificacion', clasificacion);
      pubForm.append('palabraClave', palabraClavePk);
      pubForm.append('url_imagen', new Blob([new Uint8Array(coverBuf!)], { type: 'image/jpeg' }), `portada_${Date.now()}.jpg`);
      if (subtitleUrl) {
        pubForm.append('url_subtitulo', subtitleUrl);
      }

      if (tipologia === '1') {
        pubForm.append('ano', movieYear);
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
          new Blob([new Uint8Array(posterBuf!)], { type: 'image/jpeg' }),
          `poster_${Date.now()}.jpg`
        );
      }

      if (tipologia === '5' && params.serieId) {
        pubForm.append('serie', String(params.serieId));
        pubForm.append('temporada', String(params.temporadaId || params.temporada || '1'));
        pubForm.append('numero', String(params.numero || '1'));
        pubForm.append(
          'imagen_secundaria',
          new Blob([new Uint8Array(posterBuf!)], { type: 'image/jpeg' }),
          `poster_${Date.now()}.jpg`
        );
      }
      return pubForm;
    };

    let publicationId: string | undefined;
    let slug: string | undefined;
    let winningToken = primaryToken;
    let winningPoolAcc: PictaPoolAccount | undefined;
    let lastErrorText = '';

    for (const authCand of candidateAuths) {
      const createRes = await fetchWithTimeout(
        `${apiUrl}/v1/publicacion/`,
        { method: 'POST', headers: this.getAdminHeaders(authCand.token), body: buildPubForm(params.title) },
        25_000
      );

      if (createRes.ok) {
        const created = (await createRes.json()) as { id?: string | number; slug?: string; slug_url?: string };
        if (created?.id !== undefined) publicationId = String(created.id);
        if (typeof created?.slug === 'string') slug = created.slug;
        else if (typeof created?.slug_url === 'string') slug = created.slug_url;
        winningToken = authCand.token;
        winningPoolAcc = authCand.poolAcc;
        break;
      }

      const errTxt = await createRes.text();
      lastErrorText = `HTTP ${createRes.status}: ${errTxt.slice(0, 240)}`;

      // Auto-resolve duplicate title in Picta without re-uploading S3
      if (createRes.status === 400 && /Ya existe Contenido con este nombre/i.test(errTxt)) {
        const curName = params.title.trim();
        const resolvedName = curName.includes('(') ? `${curName} (v2)` : `${curName} (${movieYear})`;
        netlog.warn('picta', `Título repetido en Picta ("${curName}"). Auto-resolviendo a "${resolvedName}"...`);
        const retryRes = await fetchWithTimeout(
          `${apiUrl}/v1/publicacion/`,
          { method: 'POST', headers: this.getAdminHeaders(authCand.token), body: buildPubForm(resolvedName) },
          25_000
        );
        if (retryRes.ok) {
          const created = (await retryRes.json()) as { id?: string | number; slug?: string; slug_url?: string };
          if (created?.id !== undefined) publicationId = String(created.id);
          if (typeof created?.slug === 'string') slug = created.slug;
          else if (typeof created?.slug_url === 'string') slug = created.slug_url;
          winningToken = authCand.token;
          winningPoolAcc = authCand.poolAcc;
          break;
        }
      }

      // If daily limit 10/day or 403 on this account, rotate to next Pool account
      if (createRes.status === 403 || /10 publicaciones|l[ií]mite diario|cupo/i.test(errTxt)) {
        if (authCand.poolAcc) {
          authCand.poolAcc.uploadedToday = 10;
          authCand.poolAcc.exhaustedDate = getCubaDateStr();
          stateStore.saveQuotaSettings();
        }
        continue;
      }

      break;
    }

    if (!publicationId) {
      throw new Error(
        `Error creando publicación en Picta (${lastErrorText}). El archivo S3 (${finalMinioKey}) ya quedó subido al 100%; usa /reintentar para publicar en 1 segundo sin resubir.`
      );
    }

    // Update Cuba daily quota counters
    if (winningPoolAcc) {
      winningPoolAcc.uploadedToday = (winningPoolAcc.uploadedToday || 0) + 1;
    }
    if (isMaster) {
      if (tipNum === 5) {
        stateStore.quotaSettings.seriesUploadedToday = (stateStore.quotaSettings.seriesUploadedToday || 0) + 1;
      } else {
        stateStore.quotaSettings.otherUploadedToday = (stateStore.quotaSettings.otherUploadedToday || 0) + 1;
      }
    }
    stateStore.saveQuotaSettings();

    if (params.playlistId && params.ctx) {
      try {
        await this.addVideoToPlaylist(params.ctx, params.playlistId, Number(publicationId));
      } catch {
        // Non-fatal
      }
    }
    if (ownerUserId && !stateStore.watchedVideos.some((w) => w.videoId === publicationId)) {
      stateStore.watchedVideos.unshift({
        videoId: publicationId,
        title: params.title,
        channelName: params.ctx?.channelName || this.getDefaultChannelName(),
        ownerUserId,
        lastCommentCount: 0,
        lastViewsCount: 0,
        lastLikesCount: 0,
        lastDownloadsCount: 0,
        lastMilestoneNotified: 0,
        nomadStatus: 'encoding',
        updatedAt: new Date().toISOString(),
      });
      if (stateStore.watchedVideos.length > 60) stateStore.watchedVideos.length = 60;
      stateStore.saveWatchedVideos();
    }

    let nomadTriggered = false;
    try {
      nomadTriggered = await this.triggerNomadConversion(finalMinioKey, winningToken);
    } catch (err) {
      netlog.warn('picta', `proxy_nomad diferido al bucle 20s: ${err instanceof Error ? err.message : String(err)}`);
    }

    return {
      minioKey: finalMinioKey,
      publicationId,
      webUrl: buildPublicationWebUrl(publicationId, slug),
      nomadTriggered,
      usedPoolAccount: winningPoolAcc?.displayName || winningPoolAcc?.username,
    };
  }

  public async fetchChannelDetails(ctx?: PictaAuthContext, channelId?: string): Promise<PictaChannelProfile | null> {
    const targetChannel = (channelId || ctx?.channelId || this.getDefaultChannelId()).trim();
    const apiUrl = getValidatedPictaApiUrl();
    const token = ctx?.accessToken || (await this.tryMasterToken());
    for (const ver of ['v2', 'v3', 'v1']) {
      const ep = ver === 'v3' ? `${apiUrl}/v3/channel/${encodeURIComponent(targetChannel)}/` : `${apiUrl}/${ver}/canal/${encodeURIComponent(targetChannel)}/`;
      try {
        const res = await fetchWithTimeout(ep, { method: 'GET', headers: this.getAdminHeaders(token) }, 10_000);
        if (!res.ok) continue;
        const d = (await res.json()) as Record<string, unknown>;
        const propRaw = d.propietario;
        const propietarioId =
          typeof propRaw === 'object' && propRaw
            ? Number((propRaw as { id?: unknown; user_id?: unknown }).id ?? (propRaw as { user_id?: unknown }).user_id ?? 0)
            : Number(propRaw || 0);
        const assocRaw = Array.isArray(d.usuarios_asociados) ? d.usuarios_asociados : [];
        const usuariosAsociados = assocRaw
          .map((u) => {
            if (typeof u === 'object' && u) {
              const uObj = u as Record<string, unknown>;
              const uid = Number(uObj.id ?? uObj.user_id ?? 0);
              const label =
                [uObj.first_name, uObj.last_name].filter(Boolean).join(' ').trim() ||
                String(uObj.username || uObj.nombre || `Usuario #${uid}`);
              return { id: uid, label, isOwner: uid > 0 && uid === propietarioId };
            }
            const uid = Number(u || 0);
            return { id: uid, label: `Usuario #${uid}`, isOwner: uid > 0 && uid === propietarioId };
          })
          .filter((x) => x.id > 0);
        if (propietarioId > 0 && !usuariosAsociados.some((u) => u.id === propietarioId)) {
          usuariosAsociados.unshift({ id: propietarioId, label: `Propietario #${propietarioId}`, isOwner: true });
        }

        return {
          id: Number(d.id ?? targetChannel),
          nombre: String(d.nombre ?? this.getDefaultChannelName()),
          alias: String(d.alias ?? ''),
          descripcion: String(d.descripcion ?? ''),
          clasificacion: String(d.clasificacion ?? '18+'),
          slug_url: typeof d.slug_url === 'string' ? d.slug_url : undefined,
          visible: d.visible !== false,
          publicado: d.publicado !== false,
          donacion: Boolean(d.donacion),
          cantidad_suscriptores: Number(d.cantidad_suscriptores ?? 0),
          cantidad_publicaciones: Number(d.cantidad_publicaciones ?? 0),
          url_avatar: typeof d.url_avatar === 'string' ? d.url_avatar : undefined,
          url_imagen: typeof d.url_imagen === 'string' ? d.url_imagen : undefined,
          propietarioId: propietarioId || undefined,
          usuariosAsociados,
        };
      } catch {
        // Fallback version
      }
    }
    return null;
  }

  public async patchChannel(
    ctx: PictaAuthContext,
    fields: {
      nombre?: string;
      alias?: string;
      descripcion?: string;
      clasificacion?: string;
      publicado?: boolean;
      donacion?: boolean;
      avatarBuffer?: Buffer;
      bannerBuffer?: Buffer;
    }
  ): Promise<PictaChannelProfile | null> {
    const apiUrl = getValidatedPictaApiUrl();
    let lastErr = '';
    for (const ver of ['v2', 'v1']) {
      const form = new FormData();
      if (fields.nombre !== undefined) form.append('nombre', fields.nombre);
      if (fields.alias !== undefined) form.append('alias', fields.alias);
      if (fields.descripcion !== undefined) form.append('descripcion', fields.descripcion);
      if (fields.clasificacion !== undefined) form.append('clasificacion', fields.clasificacion);
      if (fields.publicado !== undefined) form.append('publicado', String(fields.publicado));
      if (fields.donacion !== undefined) form.append('donacion', String(fields.donacion));
      if (fields.avatarBuffer) {
        form.append(
          'url_avatar',
          new Blob([new Uint8Array(fields.avatarBuffer)], { type: 'image/jpeg' }),
          `avatar_${Date.now()}.jpg`
        );
      }
      if (fields.bannerBuffer) {
        form.append(
          'url_imagen',
          new Blob([new Uint8Array(fields.bannerBuffer)], { type: 'image/jpeg' }),
          `banner_${Date.now()}.jpg`
        );
      }
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/canal/${encodeURIComponent(ctx.channelId)}/`,
        { method: 'PATCH', headers: this.getAdminHeaders(ctx.accessToken), body: form },
        15_000
      );
      if (res.ok) {
        return this.fetchChannelDetails(ctx, ctx.channelId);
      }
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`;
    }
    throw new Error(`Picta rechazó la edición del canal (${lastErr}).`);
  }

  public async fetchChannelCollaborators(ctx: PictaAuthContext): Promise<{
    channelId: string;
    channelName: string;
    ownerId?: number;
    collaborators: Array<{ id: number; label: string; isOwner: boolean }>;
  }> {
    const det = await this.fetchChannelDetails(ctx, ctx.channelId);
    return {
      channelId: ctx.channelId,
      channelName: det?.nombre || ctx.channelName,
      ownerId: det?.propietarioId,
      collaborators: det?.usuariosAsociados || [],
    };
  }

  public async updateChannelCollaborator(
    ctx: PictaAuthContext,
    rawTargetInput: string,
    action: 'add' | 'remove'
  ): Promise<{ collaborators: Array<{ id: number; label: string; isOwner: boolean }>; targetUserId: number; resolvedLabel?: string }> {
    const apiUrl = getValidatedPictaApiUrl();
    const current = await this.fetchChannelCollaborators(ctx);
    let clean = rawTargetInput.trim().replace(/^[@#]/, '');
    const urlMatch = clean.match(/picta\.cu\/canal\/([^/?#\s]+)/i);
    if (urlMatch?.[1]) clean = decodeURIComponent(urlMatch[1]);

    let targetUserId = /^\d+$/.test(clean) ? Number(clean) : 0;
    let resolvedLabel: string | undefined;

    if (!targetUserId) {
      // Search user or channel owner
      const chCandidates = await this.findPictaChannelByQuery(ctx, clean);
      if (chCandidates.length > 0) {
        const chDet = await this.fetchChannelDetails(ctx, String(chCandidates[0].id));
        if (chDet?.propietarioId) {
          targetUserId = chDet.propietarioId;
          resolvedLabel = `${chDet.nombre} (Propietario #${targetUserId})`;
        }
      }
    }

    if (!targetUserId) {
      throw new Error(`No se pudo resolver un ID de usuario de Picta para "${rawTargetInput}". Ingresa su ID numérico o enlace de su canal.`);
    }

    const computeIds = (uid: number) => {
      const set = new Set(current.collaborators.map((c) => c.id));
      if (current.ownerId) set.add(current.ownerId);
      if (action === 'add') set.add(uid);
      else if (uid !== current.ownerId) set.delete(uid);
      return Array.from(set).filter((n) => n > 0);
    };

    const sendPatch = async (ids: number[]) => {
      for (const ver of ['v2', 'v1']) {
        const res = await fetchWithTimeout(
          `${apiUrl}/${ver}/canal/${encodeURIComponent(ctx.channelId)}/`,
          {
            method: 'PATCH',
            headers: { ...this.getAdminHeaders(ctx.accessToken), 'Content-Type': 'application/json' },
            body: JSON.stringify({ usuarios_asociados: ids }),
          },
          12_000
        );
        if (res.ok) return res;
      }
      return null;
    };

    let patchRes = await sendPatch(computeIds(targetUserId));
    if (!patchRes && /^\d+$/.test(clean)) {
      // Maybe the user typed a channel ID instead of a user ID; resolve the channel's owner ID
      const chDet = await this.fetchChannelDetails(ctx, clean);
      if (chDet?.propietarioId && chDet.propietarioId !== targetUserId) {
        targetUserId = chDet.propietarioId;
        resolvedLabel = `${chDet.nombre} (Propietario #${targetUserId})`;
        patchRes = await sendPatch(computeIds(targetUserId));
      }
    }

    if (!patchRes) {
      throw new Error(`Picta rechazó actualizar colaboradores para el usuario #${targetUserId}.`);
    }

    const refreshed = await this.fetchChannelCollaborators(ctx);
    return {
      collaborators: refreshed.collaborators,
      targetUserId,
      resolvedLabel,
    };
  }

  public async searchOrCreatePersona(
    ctx: PictaAuthContext,
    nombre: string
  ): Promise<{ id: number; nombre: string; created: boolean }> {
    const apiUrl = getValidatedPictaApiUrl();
    const clean = nombre.trim();
    if (!clean) throw new Error('Ingresa el nombre del actor o director.');

    try {
      const searchRes = await fetchWithTimeout(
        `${apiUrl}/v2/persona/?search=${encodeURIComponent(clean)}`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (searchRes.ok) {
        const sData = (await searchRes.json()) as { results?: Array<Record<string, unknown>> };
        const exact = (sData.results || []).find(
          (p) => String(p.nombre || '').toLowerCase().trim() === clean.toLowerCase()
        );
        if (exact?.id) {
          return { id: Number(exact.id), nombre: String(exact.nombre), created: false };
        }
      }
    } catch {
      // Proceed to create
    }

    const createRes = await fetchWithTimeout(
      `${apiUrl}/v1/persona/`,
      {
        method: 'POST',
        headers: { ...this.getAdminHeaders(ctx.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ nombre: clean }),
      },
      12_000
    );
    if (!createRes.ok) {
      throw new Error(`Picta rechazó registrar la persona (HTTP ${createRes.status}): ${(await createRes.text()).slice(0, 160)}`);
    }
    const cObj = (await createRes.json()) as { id?: number; nombre?: string };
    return { id: Number(cObj.id || 0), nombre: String(cObj.nombre || clean), created: true };
  }

  public async searchOrCreateKeyword(
    ctx: PictaAuthContext,
    palabra: string
  ): Promise<{ id: number; palabra: string; created: boolean }> {
    const apiUrl = getValidatedPictaApiUrl();
    const clean = palabra.trim().replace(/^#/, '');
    if (!clean) throw new Error('Ingresa una palabra clave o etiqueta.');

    try {
      const searchRes = await fetchWithTimeout(
        `${apiUrl}/v2/palabra_clave/?search=${encodeURIComponent(clean)}`,
        { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (searchRes.ok) {
        const sData = (await searchRes.json()) as { results?: Array<Record<string, unknown>> };
        const exact = (sData.results || []).find(
          (p) => String(p.palabra || '').toLowerCase().trim() === clean.toLowerCase()
        );
        if (exact?.id) {
          return { id: Number(exact.id), palabra: String(exact.palabra), created: false };
        }
      }
    } catch {
      // Proceed to create
    }

    const createRes = await fetchWithTimeout(
      `${apiUrl}/v1/palabra_clave/`,
      {
        method: 'POST',
        headers: { ...this.getAdminHeaders(ctx.accessToken), 'Content-Type': 'application/json' },
        body: JSON.stringify({ palabra: clean }),
      },
      12_000
    );
    if (!createRes.ok) {
      throw new Error(`Picta rechazó registrar la etiqueta (HTTP ${createRes.status}): ${(await createRes.text()).slice(0, 160)}`);
    }
    const cObj = (await createRes.json()) as { id?: number; palabra?: string };
    return { id: Number(cObj.id || 0), palabra: String(cObj.palabra || clean), created: true };
  }

  private mapPublicationRow(r: Record<string, unknown>): PictaCatalogItem {
    const id = String(r.id ?? '');
    const slug = typeof r.slug_url === 'string' ? r.slug_url : typeof r.slug === 'string' ? r.slug : undefined;
    const catObj = r.categoria && typeof r.categoria === 'object' ? (r.categoria as Record<string, unknown>) : null;
    const tipObj =
      (catObj && typeof catObj.tipologia === 'object' ? (catObj.tipologia as Record<string, unknown>) : null) ||
      (r.tipologia && typeof r.tipologia === 'object' ? (r.tipologia as Record<string, unknown>) : null);
    const tipId = tipObj ? Number(tipObj.id || 0) : Number(r.tipologia || 0);
    const tipName =
      (tipObj && typeof tipObj.nombre === 'string' && tipObj.nombre) ||
      PICTA_TIPOLOGIAS[tipId] ||
      'Audiovisual';

    const rawTags = Array.isArray(r.palabras_clave) ? r.palabras_clave : [];
    const palabras_clave = rawTags
      .map((t) => (typeof t === 'string' ? t : typeof t === 'object' && t ? String((t as { palabra?: unknown }).palabra || '') : ''))
      .filter(Boolean);

    const rawManifest = typeof r.url_manifiesto === 'string' ? r.url_manifiesto : undefined;
    const url_manifiesto =
      rawManifest && !rawManifest.startsWith('http')
        ? `https://manifest.picta.cu/${rawManifest.replace(/^\/+/, '')}`
        : rawManifest;

    return {
      id,
      nombre: String(r.nombre ?? 'Sin título'),
      descripcion: String(r.descripcion ?? ''),
      slug,
      webUrl: buildPublicationWebUrl(id, slug),
      tipologiaId: tipId || undefined,
      tipologiaNombre: tipName,
      clasificacion: String(r.clasificacion ?? '18+'),
      cantidad_vistas: Number(r.cantidad_visitas ?? r.cantidad_vistas ?? r.cantidad_reproducciones ?? 0),
      cantidad_reproducciones: Number(r.cantidad_reproducciones ?? r.cantidad_visitas ?? 0),
      cantidad_comentarios: Number(r.cantidad_comentarios ?? 0),
      cantidad_me_gusta: Number(r.cantidad_me_gusta ?? r.cantidad_likes ?? 0),
      cantidad_descargas: Number(r.cantidad_descargas ?? 0),
      publicado: r.publicado !== false,
      convertido: Boolean(r.convertido ?? r.publicado),
      descargable: r.descarga !== false && r.descargable !== false,
      estado_codificacion: typeof r.estado === 'string' ? r.estado : typeof r.estado_codificacion === 'string' ? r.estado_codificacion : undefined,
      motivo_rechazo: typeof r.motivo_rechazo === 'string' ? r.motivo_rechazo : typeof r.razon_rechazo === 'string' ? r.razon_rechazo : undefined,
      url_imagen: typeof r.url_imagen === 'string' ? r.url_imagen : undefined,
      imagen_secundaria: typeof r.imagen_secundaria === 'string' ? r.imagen_secundaria : undefined,
      url_subtitulo: typeof r.url_subtitulo === 'string' ? r.url_subtitulo : undefined,
      url_descarga: typeof r.url_descarga === 'string' ? r.url_descarga : typeof r.url_archivo === 'string' ? r.url_archivo : undefined,
      url_manifiesto,
      tamanio: Number(r.tamanio ?? r.size ?? 0) || undefined,
      duracion: Number(r.duracion ?? 0) || undefined,
      serieId: Number(r.pelicula_serie ?? r.serie ?? r.serie_id ?? 0) || undefined,
      temporada: Number(r.temporada ?? 0) || undefined,
      numero: Number(r.numero ?? 0) || undefined,
      palabras_clave,
      fecha_creacion: typeof r.fecha_creacion === 'string' ? r.fecha_creacion : undefined,
      fecha_publicado: typeof r.fecha_publicado === 'string' ? r.fecha_publicado : undefined,
    };
  }

  public async fetchPublicationDirectLinks(
    ctx: PictaAuthContext,
    videoId: string
  ): Promise<{
    id: string;
    nombre: string;
    webUrl: string;
    url_descarga?: string;
    url_manifiesto?: string;
    tamanio: number;
    duracion: number;
  }> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const ver of ['v2', 'v1']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/${ver}/publicacion/${encodeURIComponent(videoId)}/`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as Record<string, unknown>;
        const pub = Array.isArray((data as { results?: unknown[] }).results)
          ? (((data as { results: unknown[] }).results[0] as Record<string, unknown>) || data)
          : data;
        const mapped = this.mapPublicationRow(pub);
        const dlUrl =
          mapped.url_descarga ||
          (typeof pub.url_video === 'string' && !pub.url_video.endsWith('.m3u8') ? pub.url_video : undefined);
        let maniUrl =
          mapped.url_manifiesto ||
          (typeof pub.url_video === 'string' && pub.url_video.endsWith('.m3u8') ? pub.url_video : undefined);
        if (maniUrl && !maniUrl.startsWith('http')) {
          maniUrl = `https://manifest.picta.cu/${maniUrl.replace(/^\/+/, '')}`;
        }
        return {
          id: mapped.id || videoId,
          nombre: mapped.nombre,
          webUrl: mapped.webUrl,
          url_descarga: dlUrl,
          url_manifiesto: maniUrl,
          tamanio: mapped.tamanio || 0,
          duracion: mapped.duracion || 0,
        };
      } catch {
        // Fallback version
      }
    }
    throw new Error(`No se pudo obtener el manifiesto directo del video #${videoId}.`);
  }

  public async searchGlobalPictaCatalog(
    rawQuery: string,
    ctx?: PictaAuthContext
  ): Promise<PictaGlobalSearchHit[]> {
    const cleanQ = rawQuery.trim();
    if (cleanQ.length < 2) return [];
    const apiUrl = getValidatedPictaApiUrl();
    const token = ctx?.accessToken || (await this.tryMasterToken());
    const headers = this.getAdminHeaders(token);
    const enc = encodeURIComponent(cleanQ);

    const [pubV2, serV2] = await Promise.all([
      fetchWithTimeout(`${apiUrl}/v2/publicacion/?search=${enc}&page_size=25`, { headers }, 8_000)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
      fetchWithTimeout(`${apiUrl}/v2/serie/?search=${enc}&page_size=15`, { headers }, 8_000)
        .then((r) => (r.ok ? r.json() : null))
        .catch(() => null),
    ]);

    const hits: PictaGlobalSearchHit[] = [];
    const normQuery = normalizeTitleForAudit(cleanQ);
    const queryWords = normQuery.split(' ').filter((w) => w.length >= 2);

    const scoreTitle = (title: string): { score: number; level: 'exact' | 'high' | 'partial' } => {
      const normT = normalizeTitleForAudit(title);
      if (!normT) return { score: 0, level: 'partial' };
      if (normT === normQuery) return { score: 1, level: 'exact' };
      if (normT.includes(normQuery) || normQuery.includes(normT)) return { score: 0.86, level: 'high' };
      const matched = queryWords.filter((w) => normT.includes(w)).length;
      const ratio = queryWords.length > 0 ? matched / queryWords.length : 0;
      return { score: ratio * 0.8, level: ratio >= 0.75 ? 'high' : 'partial' };
    };

    const pubRows = Array.isArray((pubV2 as { results?: unknown[] })?.results)
      ? ((pubV2 as { results: Array<Record<string, unknown>> }).results)
      : [];
    for (const r of pubRows) {
      const mapped = this.mapPublicationRow(r);
      const sc = scoreTitle(mapped.nombre);
      if (sc.score < 0.25) continue;
      const canalObj = r.canal && typeof r.canal === 'object' ? (r.canal as Record<string, unknown>) : null;
      const channelName = String(canalObj?.nombre || r.canal_nombre || 'Canal de Picta');
      const channelId = String(canalObj?.id || r.canal_id || '');
      hits.push({
        id: Number(mapped.id || 0),
        kind: 'publicacion',
        title: mapped.nombre,
        categoryName: mapped.tipologiaNombre,
        tipologiaId: mapped.tipologiaId || 8,
        channelId,
        channelName,
        sizeBytes: mapped.tamanio || 0,
        resolutions: [],
        maxResolutionLabel: '',
        durationSeconds: mapped.duracion || 0,
        views: mapped.cantidad_vistas,
        createdAt: mapped.fecha_publicado || mapped.fecha_creacion || '',
        webUrl: mapped.webUrl,
        manifestUrl: mapped.url_manifiesto,
        downloadUrl: mapped.url_descarga,
        matchScore: sc.score,
        matchLevel: sc.level,
      });
    }

    const serRows = Array.isArray((serV2 as { results?: unknown[] })?.results)
      ? ((serV2 as { results: Array<Record<string, unknown>> }).results)
      : [];
    for (const r of serRows) {
      const id = Number(r.pelser_id || r.id || 0);
      const title = String(r.nombre || '');
      const sc = scoreTitle(title);
      if (!id || sc.score < 0.25) continue;
      const canalObj = r.canal && typeof r.canal === 'object' ? (r.canal as Record<string, unknown>) : null;
      hits.push({
        id,
        kind: 'serie',
        title,
        categoryName: 'Serie',
        tipologiaId: 5,
        channelId: String(canalObj?.id || r.canal || ''),
        channelName: String(canalObj?.nombre || r.canal_nombre || 'Canal de Picta'),
        sizeBytes: 0,
        resolutions: [],
        maxResolutionLabel: 'Catálogo Serie',
        durationSeconds: 0,
        views: Number(r.cantidad_visitas || r.cantidad_reproducciones || 0),
        createdAt: String(r.fecha_creacion || ''),
        webUrl: `${getValidatedPictaBaseUrl().replace(/\/+$/, '')}/series/${id}`,
        matchScore: sc.score,
        matchLevel: sc.level,
      });
    }

    hits.sort((a, b) => (Math.abs(b.matchScore - a.matchScore) > 0.05 ? b.matchScore - a.matchScore : b.views - a.views));
    return hits.slice(0, 20);
  }

  public async auditChannelCatalog(ctx: PictaAuthContext): Promise<ChannelAuditReport> {
    const pages: PictaCatalogItem[] = [];
    for (let p = 1; p <= 4; p++) {
      const res = await this.fetchChannelPublications({ ctx, page: p, pageSize: 50 });
      pages.push(...res.items);
      if (!res.hasNext || res.items.length === 0) break;
    }

    const byTitleMap = new Map<string, PictaCatalogItem[]>();
    const bySizeDurMap = new Map<string, PictaCatalogItem[]>();
    const incompleteItems: ChannelAuditItem[] = [];
    const unpublishedItems: ChannelAuditItem[] = [];
    const orphanEpisodeItems: ChannelAuditItem[] = [];

    const toAuditItem = (pub: PictaCatalogItem, reason: string): ChannelAuditItem => ({
      id: pub.id,
      nombre: pub.nombre,
      reason,
      publicado: pub.publicado,
      views: pub.cantidad_vistas,
      createdAt: pub.fecha_publicado || pub.fecha_creacion,
    });

    for (const pub of pages) {
      const normTitle = normalizeTitleForAudit(pub.nombre);
      if (normTitle.length >= 3) {
        const arr = byTitleMap.get(normTitle) || [];
        arr.push(pub);
        byTitleMap.set(normTitle, arr);
      }
      if (pub.tamanio && pub.tamanio > 1024 && pub.duracion && pub.duracion > 5) {
        const sig = `${pub.tamanio}:${Math.round(pub.duracion)}`;
        const arr = bySizeDurMap.get(sig) || [];
        arr.push(pub);
        bySizeDurMap.set(sig, arr);
      }

      if (!pub.publicado) {
        unpublishedItems.push(
          toAuditItem(
            pub,
            pub.motivo_rechazo
              ? `Rechazado: ${pub.motivo_rechazo}`
              : !pub.fecha_publicado
                ? 'Esperando aprobación / moderación de Picta'
                : 'Oculto en el canal'
          )
        );
      }

      const missingCover = !pub.url_imagen;
      const missingDesc = !pub.descripcion || pub.descripcion.trim().length < 12;
      if (missingCover || missingDesc) {
        const parts: string[] = [];
        if (missingCover) parts.push('Sin portada');
        if (missingDesc) parts.push('Sin sinopsis');
        incompleteItems.push(toAuditItem(pub, parts.join(' · ')));
      }

      const looksLikeEp = EPISODE_PATTERN_REGEX.test(pub.nombre);
      if (looksLikeEp && pub.tipologiaId !== 5 && !pub.serieId) {
        orphanEpisodeItems.push(toAuditItem(pub, 'Parece capítulo de serie pero está en otra categoría sin vincular'));
      } else if (pub.tipologiaId === 5 && !pub.serieId && !pub.temporada) {
        orphanEpisodeItems.push(toAuditItem(pub, 'Categoría Serie sin serie/temporada vinculada'));
      }
    }

    const duplicateGroups: Array<{ groupKey: string; reason: string; items: ChannelAuditItem[] }> = [];
    const seenSigs = new Set<string>();
    const registerDup = (groupKey: string, reason: string, list: PictaCatalogItem[]) => {
      if (list.length < 2) return;
      const sorted = [...list].sort((a, b) => Number(a.id) - Number(b.id));
      const sig = sorted.map((x) => x.id).join(',');
      if (seenSigs.has(sig)) return;
      seenSigs.add(sig);
      duplicateGroups.push({
        groupKey,
        reason,
        items: sorted.map((p) => toAuditItem(p, reason)),
      });
    };

    for (const [normT, list] of byTitleMap.entries()) {
      if (list.length >= 2) registerDup(`title:${normT}`, `Título repetido (${list.length} copias)`, list);
    }
    for (const [sig, list] of bySizeDurMap.entries()) {
      if (list.length >= 2) registerDup(`file:${sig}`, `Mismo peso y duración (${list.length} archivos)`, list);
    }

    return {
      totalScanned: pages.length,
      duplicateGroups,
      incompleteItems,
      unpublishedItems,
      orphanEpisodeItems,
      generatedAt: new Date().toISOString(),
    };
  }

  public async fetchChannelPublications(params: {
    ctx?: PictaAuthContext;
    channelId?: string;
    page?: number;
    pageSize?: number;
    search?: string;
    ordering?: string;
    visibility?: 'all' | 'published' | 'hidden';
  }): Promise<{ items: PictaCatalogItem[]; total: number; hasNext: boolean }> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (params.channelId || params.ctx?.channelId || this.getDefaultChannelId()).trim();
    const page = Math.max(1, params.page || 1);
    const pageSize = Math.min(50, Math.max(1, params.pageSize || 10));
    const token = params.ctx?.accessToken || (await this.tryMasterToken());

    for (const channelParam of ['canal_id', 'canal']) {
      const url = new URL(`${apiUrl}/v2/publicacion/`);
      url.searchParams.set(channelParam, targetChannel);
      url.searchParams.set('page', String(page));
      url.searchParams.set('page_size', String(pageSize));
      if (params.search?.trim()) url.searchParams.set('search', params.search.trim());
      if (params.ordering?.trim()) url.searchParams.set('ordering', params.ordering.trim());
      if (params.visibility === 'published') url.searchParams.set('publicado', 'true');
      if (params.visibility === 'hidden') url.searchParams.set('publicado', 'false');

      try {
        const res = await fetchWithTimeout(
          url.toString(),
          { method: 'GET', headers: this.getAdminHeaders(token) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as {
          count?: number;
          next?: string | null;
          results?: Array<Record<string, unknown>>;
        };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || channelParam === 'canal') {
          return {
            items: rows.map((r) => this.mapPublicationRow(r)),
            total: Number(data.count ?? rows.length),
            hasNext: Boolean(data.next),
          };
        }
      } catch {
        // Try fallback parameter name
      }
    }
    return { items: [], total: 0, hasNext: false };
  }

  public async fetchPublicationById(videoId: string, ctx?: PictaAuthContext): Promise<PictaCatalogItem | null> {
    const apiUrl = getValidatedPictaApiUrl();
    const token = ctx?.accessToken || (await this.tryMasterToken());
    for (const ver of ['v2', 'v1']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/${ver}/publicacion/${encodeURIComponent(videoId)}/`,
          { method: 'GET', headers: this.getAdminHeaders(token) },
          8_000
        );
        if (!res.ok) continue;
        return this.mapPublicationRow((await res.json()) as Record<string, unknown>);
      } catch {
        // Next version
      }
    }
    return null;
  }

  public async patchPublication(
    ctx: PictaAuthContext,
    videoId: string,
    fields: {
      nombre?: string;
      descripcion?: string;
      publicado?: boolean;
      descargable?: boolean;
      mostrar_comentarios?: boolean;
      clasificacion?: string;
      tipologia?: number;
      serie?: number;
      temporada?: string;
      numero?: string;
      palabraClave?: string;
      coverBuffer?: Buffer;
      posterBuffer?: Buffer;
      subtitleBuffer?: Buffer;
      subtitleFileName?: string;
    }
  ): Promise<PictaCatalogItem | null> {
    const apiUrl = getValidatedPictaApiUrl();
    let subtitleUrl: string | null = null;
    if (fields.subtitleBuffer) {
      subtitleUrl = await this.uploadSubtitleBufferToMinioS3(
        ctx.accessToken,
        fields.subtitleBuffer,
        fields.subtitleFileName || `subtitulos_${videoId}.srt`
      );
      if (!subtitleUrl) {
        throw new Error('No se pudo subir el archivo de subtítulos (.srt) a MinIO S3.');
      }
    }

    let lastErr = '';
    for (const ver of ['v1', 'v2']) {
      const form = new FormData();
      if (fields.nombre !== undefined) form.append('nombre', fields.nombre);
      if (fields.descripcion !== undefined) form.append('descripcion', fields.descripcion);
      if (fields.publicado !== undefined) form.append('publicado', String(fields.publicado));
      if (fields.descargable !== undefined) {
        form.append('descargable', String(fields.descargable));
        form.append('descarga', String(fields.descargable));
      }
      if (fields.mostrar_comentarios !== undefined) form.append('mostrar_comentarios', String(fields.mostrar_comentarios));
      if (fields.clasificacion !== undefined) form.append('clasificacion', fields.clasificacion);
      if (fields.tipologia !== undefined) form.append('tipologia', String(fields.tipologia));
      if (fields.serie !== undefined) form.append('serie', String(fields.serie));
      if (fields.temporada !== undefined) form.append('temporada', String(fields.temporada));
      if (fields.numero !== undefined) form.append('numero', String(fields.numero));
      if (fields.palabraClave !== undefined) form.append('palabraClave', String(fields.palabraClave));
      if (subtitleUrl) form.append('url_subtitulo', subtitleUrl);
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

      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/publicacion/${encodeURIComponent(videoId)}/`,
        { method: 'PATCH', headers: this.getAdminHeaders(ctx.accessToken), body: form },
        15_000
      );
      if (res.ok) {
        const json = (await res.json()) as Record<string, unknown>;
        return this.mapPublicationRow(json);
      }
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 180)}`;
    }
    throw new Error(`Picta rechazó la edición de #${videoId} (${lastErr}).`);
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
    const activePinned = stateStore.getPinnedSerieForUser(ctx.telegramUserId);
    if (activePinned) pinnedSet.add(activePinned.serieId);

    for (const paramName of ['canal_id', 'canal']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/serie/?${paramName}=${encodeURIComponent(targetChannel)}&page_size=50`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || paramName === 'canal') {
          return rows
            .map((r) => {
              const id = Number(r.pelser_id || r.id || 0);
              const rawSeasons = Array.isArray(r.temporadas) ? r.temporadas : [];
              const seasons: PictaSerieSeason[] = rawSeasons
                .map((s) => {
                  const sObj = (typeof s === 'object' && s ? s : {}) as Record<string, unknown>;
                  return {
                    id: Number(sObj.id || 0),
                    numero: Number(sObj.numero || 1),
                    nombre: String(sObj.nombre || `Temporada ${sObj.numero || 1}`),
                  };
                })
                .filter((s) => s.numero > 0);
              return {
                id,
                nombre: String(r.nombre || `Serie #${id}`),
                descripcion: String(r.sinopsis || r.descripcion || ''),
                canalId: Number(r.canal || targetChannel),
                cantidad_capitulos: Number(r.cantidad_capitulos ?? r.cantidad_publicaciones ?? 0),
                url_imagen: typeof r.url_imagen === 'string' ? r.url_imagen : undefined,
                imagen_secundaria: typeof r.imagen_secundaria === 'string' ? r.imagen_secundaria : undefined,
                publicado: r.publicado !== false,
                pinned: pinnedSet.has(id),
                seasons,
              };
            })
            .sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)));
        }
      } catch {
        // Fallback param
      }
    }
    return [];
  }

  public async createSerieSeason(
    ctx: PictaAuthContext,
    serieId: number,
    seasonNum: number
  ): Promise<PictaSerieSeason> {
    const apiUrl = getValidatedPictaApiUrl();
    const form = new FormData();
    form.append('nombre', `Temporada ${seasonNum}`);
    form.append('numero', String(seasonNum));
    form.append('serie', String(serieId));
    form.append('canal', ctx.channelId);
    form.append('cantidad_capitulos', '10');

    const res = await fetchWithTimeout(
      `${apiUrl}/v1/temporada/`,
      { method: 'POST', headers: this.getAdminHeaders(ctx.accessToken), body: form },
      12_000
    );
    if (!res.ok) {
      throw new Error(`Fallo al crear Temporada ${seasonNum} (HTTP ${res.status}): ${(await res.text()).slice(0, 160)}`);
    }
    const data = (await res.json()) as { id?: number; numero?: number; nombre?: string };
    return {
      id: Number(data.id || 0),
      numero: Number(data.numero || seasonNum),
      nombre: String(data.nombre || `Temporada ${seasonNum}`),
    };
  }

  public async fetchSeriesEpisodes(ctx: PictaAuthContext, serieId: number): Promise<PictaCatalogItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const paramName of ['serie_id', 'serie', 'pelicula_serie']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/publicacion/?${paramName}=${encodeURIComponent(String(serieId))}&page_size=50`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || paramName === 'pelicula_serie') {
          return rows.map((r) => this.mapPublicationRow(r));
        }
      } catch {
        // Fallback
      }
    }
    return [];
  }

  public async createSerie(
    ctx: PictaAuthContext,
    params: { nombre: string; descripcion?: string; coverBuffer?: Buffer; posterBuffer?: Buffer }
  ): Promise<PictaSerieItem> {
    const apiUrl = getValidatedPictaApiUrl();
    const coverBuf = params.coverBuffer || Buffer.from(FALLBACK_JPEG_B64, 'base64');
    const posterBuf = params.posterBuffer || coverBuf;
    const syn = (params.descripcion || params.nombre).trim();
    const form = new FormData();
    form.append('nombre', params.nombre.trim());
    form.append('descripcion', syn);
    form.append('sinopsis', syn);
    form.append('canal', ctx.channelId);
    form.append('clasificacion', '18+');
    form.append('ano', String(new Date().getFullYear()));
    form.append('pais', 'Estados Unidos');
    form.append('genero', '5');
    form.append('director', '1022');
    form.append('reparto', '646');
    form.append('productora', '679');
    form.append('cantidad_temporadas', '1');
    form.append('cantidad_capitulos', '10');
    form.append('publicado', 'true');
    form.append('url_imagen', new Blob([new Uint8Array(coverBuf)], { type: 'image/jpeg' }), `serie_${Date.now()}.jpg`);
    form.append('imagen_secundaria', new Blob([new Uint8Array(posterBuf)], { type: 'image/jpeg' }), `poster_serie_${Date.now()}.jpg`);

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
    const newId = Number(r.pelser_id || r.id || 0);
    // Also ensure Season 1 exists
    let seasons: PictaSerieSeason[] = [];
    if (newId > 0) {
      try {
        const s1 = await this.createSerieSeason(ctx, newId, 1);
        seasons = [s1];
      } catch {
        // Non-fatal
      }
    }
    return {
      id: newId,
      nombre: String(r.nombre || params.nombre),
      descripcion: String(r.sinopsis || r.descripcion || ''),
      canalId: Number(ctx.channelId),
      cantidad_capitulos: 0,
      publicado: true,
      pinned: false,
      seasons,
    };
  }

  public async patchSerie(
    ctx: PictaAuthContext,
    serieId: number,
    fields: { nombre?: string; descripcion?: string; publicado?: boolean; coverBuffer?: Buffer; posterBuffer?: Buffer }
  ): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    let lastErr = '';
    for (const ver of ['v1', 'v2']) {
      const form = new FormData();
      if (fields.nombre !== undefined) form.append('nombre', fields.nombre.trim());
      if (fields.descripcion !== undefined) {
        form.append('descripcion', fields.descripcion.trim());
        form.append('sinopsis', fields.descripcion.trim());
      }
      if (fields.publicado !== undefined) form.append('publicado', String(fields.publicado));
      if (fields.coverBuffer) {
        form.append('url_imagen', new Blob([new Uint8Array(fields.coverBuffer)], { type: 'image/jpeg' }), `serie_${Date.now()}.jpg`);
      }
      if (fields.posterBuffer) {
        form.append('imagen_secundaria', new Blob([new Uint8Array(fields.posterBuffer)], { type: 'image/jpeg' }), `poster_serie_${Date.now()}.jpg`);
      }
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/serie/${encodeURIComponent(String(serieId))}/`,
        { method: 'PATCH', headers: this.getAdminHeaders(ctx.accessToken), body: form },
        15_000
      );
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
    }
    throw new Error(`No se pudo actualizar la serie #${serieId} (${lastErr}).`);
  }

  public async deleteSerie(ctx: PictaAuthContext, serieId: number): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const ver of ['v1', 'v2']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/serie/${encodeURIComponent(String(serieId))}/`,
        { method: 'DELETE', headers: this.getAdminHeaders(ctx.accessToken) },
        12_000
      );
      if (res.ok || res.status === 204) return true;
    }
    return false;
  }

  public async fetchChannelPlaylists(ctx: PictaAuthContext, channelId?: string): Promise<PictaPlaylistItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const targetChannel = (channelId || ctx.channelId).trim();
    for (const paramName of ['canal_id', 'canal']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/lista_reproduccion/?${paramName}=${encodeURIComponent(targetChannel)}&page_size=50`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || paramName === 'canal') {
          return rows.map((r) => ({
            id: Number(r.id || 0),
            nombre: String(r.nombre || 'Lista sin nombre'),
            publicado: r.publicado !== false,
            descarga: Boolean(r.descarga),
            fecha_creacion: typeof r.fecha_creacion === 'string' ? r.fecha_creacion : undefined,
            canalId: Number(targetChannel),
            canalNombre: ctx.channelName,
            publicacionesIds: Array.isArray(r.publicaciones)
              ? r.publicaciones
                  .map((x) => (typeof x === 'object' && x !== null ? Number((x as { id?: unknown }).id || 0) : Number(x)))
                  .filter((n) => n > 0)
              : [],
          }));
        }
      } catch {
        // Fallback param
      }
    }
    return [];
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

  public async patchPlaylist(
    ctx: PictaAuthContext,
    playlistId: number,
    fields: { nombre?: string; publicado?: boolean; descarga?: boolean; publicaciones?: number[] }
  ): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    let lastErr = '';
    for (const ver of ['v1', 'v2']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/lista_reproduccion/${encodeURIComponent(String(playlistId))}/`,
        {
          method: 'PATCH',
          headers: { ...this.getAdminHeaders(ctx.accessToken), 'Content-Type': 'application/json' },
          body: JSON.stringify(fields),
        },
        12_000
      );
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}: ${(await res.text()).slice(0, 160)}`;
    }
    throw new Error(`No se pudo editar la lista #${playlistId} (${lastErr}).`);
  }

  public async addVideoToPlaylist(ctx: PictaAuthContext, playlistId: number, videoId: number): Promise<boolean> {
    const lists = await this.fetchChannelPlaylists(ctx);
    const target = lists.find((l) => l.id === playlistId);
    const current = target ? [...target.publicacionesIds] : [];
    if (!current.includes(videoId)) current.push(videoId);
    return this.patchPlaylist(ctx, playlistId, { publicaciones: current });
  }

  public async removeVideoFromPlaylist(ctx: PictaAuthContext, playlistId: number, videoId: number): Promise<boolean> {
    const lists = await this.fetchChannelPlaylists(ctx);
    const target = lists.find((l) => l.id === playlistId);
    if (!target) return false;
    const next = target.publicacionesIds.filter((id) => id !== videoId);
    return this.patchPlaylist(ctx, playlistId, { publicaciones: next });
  }

  public async deletePlaylist(ctx: PictaAuthContext, playlistId: number): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const ver of ['v1', 'v2']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/lista_reproduccion/${encodeURIComponent(String(playlistId))}/`,
        { method: 'DELETE', headers: this.getAdminHeaders(ctx.accessToken) },
        12_000
      );
      if (res.ok || res.status === 204) return true;
    }
    return false;
  }

  private mapCommentRows(
    rows: Array<Record<string, unknown>>,
    fallbackPub?: { id: number; nombre: string; tipologiaId?: number; categoriaNombre?: string }
  ): PictaCommentItem[] {
    const ignoredSet = new Set(stateStore.ignoredCommentIds);
    let newRequestsAdded = false;

    const mapped: PictaCommentItem[] = rows.map((r) => {
      const id = Number(r.id || 0);
      const texto = String(r.texto || r.comentario || r.contenido || '').trim();
      const userObj = r.usuario && typeof r.usuario === 'object' ? (r.usuario as Record<string, unknown>) : null;
      const pubObj = r.publicacion && typeof r.publicacion === 'object' ? (r.publicacion as Record<string, unknown>) : null;
      const catObj = pubObj?.categoria && typeof pubObj.categoria === 'object' ? (pubObj.categoria as Record<string, unknown>) : null;
      const tipObj =
        (catObj?.tipologia && typeof catObj.tipologia === 'object' ? (catObj.tipologia as Record<string, unknown>) : null) ||
        (pubObj?.tipologia && typeof pubObj.tipologia === 'object' ? (pubObj.tipologia as Record<string, unknown>) : null);
      const tipologiaId = (tipObj ? Number(tipObj.id || 0) : 0) || fallbackPub?.tipologiaId;
      const categoriaNombre =
        (tipObj && typeof tipObj.nombre === 'string' && tipObj.nombre) ||
        (tipologiaId ? PICTA_TIPOLOGIAS[tipologiaId] : '') ||
        fallbackPub?.categoriaNombre ||
        'Audiovisual';

      const usuario =
        (userObj && String(userObj.username || userObj.first_name || 'Usuario')) ||
        String(r.usuario_nombre || r.nombre_usuario || 'Usuario');
      const publicacionId = (pubObj ? Number(pubObj.id || 0) : Number(r.publicacion || 0)) || fallbackPub?.id || 0;
      const publicacionNombre =
        (pubObj && String(pubObj.nombre || '')) ||
        String(r.publicacion_nombre || '') ||
        fallbackPub?.nombre ||
        'Video';
      const replyCount = Number(
        r.cantidad_respuestas ??
          (Array.isArray(r.respuestas) ? r.respuestas.length : Array.isArray(r.respuesta_set) ? r.respuesta_set.length : 0)
      );
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
          createdAt: String(r.fecha || r.fecha_creacion || new Date().toISOString()),
        });
        newRequestsAdded = true;
      }

      return {
        id,
        texto,
        usuario,
        usuarioId: userObj ? Number(userObj.id || 0) : undefined,
        fecha: String(r.fecha || r.fecha_creacion || ''),
        publicacionId,
        publicacionNombre,
        tipologiaId,
        categoriaNombre,
        parentId: r.parent ? Number(r.parent) : undefined,
        replyCount,
        answered: replyCount > 0,
        isLikelyRequest: reqCheck.isRequest,
        ignored: ignoredSet.has(id),
      };
    });

    if (newRequestsAdded) stateStore.saveChannelRequests();
    return mapped.filter((c) => c.id > 0 && c.texto.length > 0);
  }

  public async fetchPublicationComments(
    ctx: PictaAuthContext,
    publicacionId: number,
    publicacionNombre = 'Video',
    limit = 20,
    tipologiaId?: number,
    categoriaNombre?: string
  ): Promise<PictaCommentItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const paramName of ['publicacion_id', 'publicacion']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/comentario/?${paramName}=${encodeURIComponent(String(publicacionId))}&page_size=${Math.min(50, limit)}&ordering=-fecha`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || paramName === 'publicacion') {
          return this.mapCommentRows(rows, {
            id: publicacionId,
            nombre: publicacionNombre,
            tipologiaId,
            categoriaNombre,
          });
        }
      } catch {
        // Fallback
      }
    }
    return [];
  }

  public async fetchChannelComments(ctx: PictaAuthContext, limit = 30): Promise<PictaCommentItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    const directQueries = [
      `${apiUrl}/v2/comentario/?canal_id=${encodeURIComponent(ctx.channelId)}&page_size=${Math.min(50, limit)}&ordering=-fecha`,
      `${apiUrl}/v2/comentario/?publicacion__canal=${encodeURIComponent(ctx.channelId)}&page_size=${Math.min(50, limit)}&ordering=-fecha`,
    ];

    for (const url of directQueries) {
      try {
        const res = await fetchWithTimeout(url, { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) }, 10_000);
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0) {
          return this.mapCommentRows(rows);
        }
      } catch {
        // Fallback to next query
      }
    }

    try {
      const pubs = await this.fetchChannelPublications({ ctx, page: 1, pageSize: 25 });
      const withComments = pubs.items.filter((p) => p.cantidad_comentarios > 0).slice(0, 10);
      if (withComments.length === 0) return [];
      const batches = await Promise.all(
        withComments.map((p) =>
          this.fetchPublicationComments(ctx, Number(p.id), p.nombre, 8, p.tipologiaId, p.tipologiaNombre)
        )
      );
      return batches
        .flat()
        .sort((a, b) => String(b.fecha || '').localeCompare(String(a.fecha || '')))
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  public async replyToComment(
    ctx: PictaAuthContext,
    params: { publicacionId: number; parentCommentId: number; texto: string }
  ): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    const cleanText = params.texto.trim();
    const payload = {
      publicacion: params.publicacionId,
      parent: params.parentCommentId,
      comentario: params.parentCommentId,
      texto: cleanText,
    };

    for (const ver of ['v1', 'v2']) {
      const form = new FormData();
      form.append('publicacion', String(params.publicacionId));
      form.append('parent', String(params.parentCommentId));
      form.append('comentario', String(params.parentCommentId));
      form.append('texto', cleanText);
      const formRes = await fetchWithTimeout(
        `${apiUrl}/${ver}/comentario/`,
        { method: 'POST', headers: this.getAdminHeaders(ctx.accessToken), body: form },
        12_000
      );
      if (formRes.ok) return true;

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

  public async deleteComment(ctx: PictaAuthContext, commentId: number): Promise<boolean> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const ver of ['v2', 'v1']) {
      const res = await fetchWithTimeout(
        `${apiUrl}/${ver}/comentario/${encodeURIComponent(String(commentId))}/`,
        { method: 'DELETE', headers: this.getAdminHeaders(ctx.accessToken) },
        10_000
      );
      if (res.ok || res.status === 204) return true;
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
    for (const ep of [
      `${apiUrl}/v2/denuncia/resumen/?canal_id=${encodeURIComponent(ctx.channelId)}`,
      `${apiUrl}/v1/denuncia/devolver_cantidades/`,
    ]) {
      try {
        const res = await fetchWithTimeout(ep, { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) }, 10_000);
        if (!res.ok) continue;
        const d = (await res.json()) as Record<string, unknown>;
        const pendientes = Number(d.cantidad_pendientes ?? d.pendientes ?? 0);
        const proceso = Number(d.cantidad_en_proceso ?? d.en_proceso ?? 0);
        const noProceden = Number(d.cantidad_no_proceden ?? d.no_proceden ?? 0);
        const procesadas = Number(d.cantidad_procesadas ?? d.procesadas ?? 0);
        return {
          cantidad_pendientes: pendientes,
          cantidad_en_proceso: proceso,
          cantidad_no_proceden: noProceden,
          cantidad_procesadas: procesadas,
          total: pendientes + proceso + noProceden + procesadas,
        };
      } catch {
        // Fallback
      }
    }
    return empty;
  }

  public async fetchDenunciasList(ctx: PictaAuthContext, limit = 10): Promise<PictaDenunciaItem[]> {
    const apiUrl = getValidatedPictaApiUrl();
    for (const paramName of ['canal_id', 'canal']) {
      try {
        const res = await fetchWithTimeout(
          `${apiUrl}/v2/denuncia/?${paramName}=${encodeURIComponent(ctx.channelId)}&page_size=${limit}`,
          { method: 'GET', headers: this.getAdminHeaders(ctx.accessToken) },
          10_000
        );
        if (!res.ok) continue;
        const data = (await res.json()) as { results?: Array<Record<string, unknown>> };
        const rows = Array.isArray(data.results) ? data.results : [];
        if (rows.length > 0 || paramName === 'canal') {
          return rows.map((r) => {
            const pubObj = r.publicacion && typeof r.publicacion === 'object' ? (r.publicacion as Record<string, unknown>) : null;
            return {
              id: Number(r.id || 0),
              estado: String(r.estado || 'pendiente'),
              motivo: String(r.motivo || r.descripcion || r.tipo || 'Sin detalle').slice(0, 140),
              publicacionId: pubObj ? Number(pubObj.id || 0) : Number(r.publicacion || 0) || undefined,
              publicacionNombre: (pubObj && String(pubObj.nombre || '')) || String(r.publicacion_nombre || 'Publicación'),
              fecha: typeof r.fecha === 'string' ? r.fecha : typeof r.fecha_creacion === 'string' ? r.fecha_creacion : undefined,
            };
          });
        }
      } catch {
        // Fallback
      }
    }
    return [];
  }

  public async fetchChannelStats(ctx?: PictaAuthContext, days = 1): Promise<Record<string, unknown> | null> {
    try {
      const token = ctx?.accessToken || (await this.authenticateMaster());
      const apiUrl = getValidatedPictaApiUrl();
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'America/Havana',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
      const endDate = new Date();
      const startDate = new Date(endDate.getTime() - Math.max(0, days - 1) * 86_400_000);
      const fromStr = fmt.format(startDate);
      const toStr = fmt.format(endDate);

      const url = new URL(`${apiUrl}/v2/resumen/datos/`);
      url.searchParams.set('date__gte', fromStr);
      url.searchParams.set('date__lte', toStr);
      if (ctx?.channelId) url.searchParams.set('canal_id', ctx.channelId);

      const res = await fetchWithTimeout(url.toString(), { method: 'GET', headers: this.getAdminHeaders(token) }, 10_000);
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
        const prefs = stateStore.getAlertPrefsForUser(defaultOwner);
        for (const pub of pubs.items) {
          if (!pub.id) continue;
          stateStore.watchedVideos.push({
            videoId: pub.id,
            title: pub.nombre,
            channelName: this.getDefaultChannelName(),
            ownerUserId: defaultOwner,
            lastCommentCount: pub.cantidad_comentarios,
            lastViewsCount: pub.cantidad_reproducciones || pub.cantidad_vistas,
            lastLikesCount: pub.cantidad_me_gusta,
            lastDownloadsCount: pub.cantidad_descargas,
            lastMilestoneNotified:
              [...prefs.thresholds].reverse().find((m) => (pub.cantidad_reproducciones || pub.cantidad_vistas) >= m) || 0,
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
        const prefs = stateStore.getAlertPrefsForUser(video.ownerUserId);
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
          cantidad_me_gusta?: number;
          cantidad_descargas?: number;
          publicado?: boolean;
        };

        const plays = Number(data.cantidad_reproducciones ?? data.cantidad_vistas ?? video.lastViewsCount);
        const comments = Number(data.cantidad_comentarios ?? video.lastCommentCount);
        const likes = Number(data.cantidad_me_gusta ?? video.lastLikesCount ?? 0);
        const downloads = Number(data.cantidad_descargas ?? video.lastDownloadsCount ?? 0);

        if (prefs.commentsEnabled && prefs.enabledMetrics.comments && comments > video.lastCommentCount) {
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
              `💬 <b>NUEVO COMENTARIO EN PICTA</b>\n<blockquote>🎬 <b>${video.title}</b> (${video.channelName})\n💬 Total comentarios: <b>${comments}</b> (+${diff})</blockquote>\nUsa /comentarios para responder o sugerir respuesta con IA.`
            );
          }
          newAlerts.push(alert);
        }
        video.lastCommentCount = comments;

        if (prefs.milestonesEnabled) {
          const metricVal = prefs.enabledMetrics.plays
            ? plays
            : prefs.enabledMetrics.likes
              ? likes
              : prefs.enabledMetrics.downloads
                ? downloads
                : 0;
          const metricLabel = prefs.enabledMetrics.plays
            ? 'reproducciones'
            : prefs.enabledMetrics.likes
              ? 'likes'
              : 'descargas';

          const reachedMilestone = [...prefs.thresholds]
            .sort((a, b) => a - b)
            .reverse()
            .find((m) => metricVal >= m && m > video.lastMilestoneNotified);

          if (reachedMilestone) {
            const alert: PictaAlertEvent = {
              id: crypto.randomUUID(),
              type: 'milestone',
              videoId: video.videoId,
              videoTitle: video.title,
              channelName: video.channelName,
              summary: `Logro: ${reachedMilestone.toLocaleString('es-ES')} ${metricLabel}.`,
              metricValue: reachedMilestone,
              notifiedTelegram: false,
              targetUserId: video.ownerUserId,
              detectedAt: new Date().toISOString(),
            };
            if (notifyFn && video.ownerUserId) {
              alert.notifiedTelegram = await notifyFn(
                video.ownerUserId,
                `🏆 <b>¡NUEVO LOGRO ALCANZADO EN PICTA!</b>\n<blockquote>🎬 <b>${video.title}</b>\n🚀 Superó la meta de <b>${reachedMilestone.toLocaleString('es-ES')} ${metricLabel}</b></blockquote>`
              );
            }
            newAlerts.push(alert);
            video.lastMilestoneNotified = reachedMilestone;
          }
        }

        video.lastViewsCount = plays;
        video.lastLikesCount = likes;
        video.lastDownloadsCount = downloads;
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
            const payload = (await res.json()) as { publicado?: boolean; convertido?: boolean; estado_codificacion?: string };
            if (payload.publicado || payload.convertido || payload.estado_codificacion === 'ready') {
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
