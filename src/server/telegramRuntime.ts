import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AuthorizedUser,
  PictaCatalogItem,
  PictaCommentItem,
  RuntimeTelemetry,
  TmdbEnrichedCandidate,
  TransferJob,
  UserRole,
} from '../shared/types.ts';
import {
  getVaultConfigStatus,
  restoreCloudStateFromLocalVault,
  restoreCloudStateFromTelegramCommands,
  saveCloudStateToTelegramNow,
} from './cloudVault.ts';
import {
  analyzeVideoTitleAndSynopsis,
  askGeminiAssistant,
  buildSerieTitleOptions,
  enrichMetadataWithGemini,
  fetchSafeImageBuffer,
  generateAiCommentReply,
  getLastGeminiError,
  isGeminiConfigured,
  searchTmdbRichCandidates,
} from './mediaIntelligence.ts';
import { mtprotoPool } from './mtprotoFastDownload.ts';
import {
  concatBinaryParts,
  extractArchiveSafe,
  inspectSystemBinaries,
  remuxSingleVideoFaststart,
} from './multiPartDiskAssembler.ts';
import { netlog } from './netlog.ts';
import { PICTA_TIPOLOGIAS, pictaService, type PictaAuthContext } from './pictaClient.ts';
import {
  cleanupOrphanedScratchFiles,
  ensureScratchSpaceForFile,
  getDiskStatusReport,
  resolveConfinedScratchPath,
} from './scratchDiskManager.ts';
import { stateStore } from './stateStore.ts';
import {
  downloadDirectUrlToScratch,
  escHtml,
  getTelegramBotToken,
  tgAnswerCallback,
  tgDeleteMessage,
  tgDownloadBotFileToScratch,
  tgDownloadSmallFileToScratch,
  tgEditMessage,
  tgRegisterDefaultCommands,
  tgSendMessage,
  tgSendPhoto,
  type InlineKeyboardButton,
  type InlineKeyboardMarkup,
} from './telegramApi.ts';

interface TelegramMessage {
  message_id: number;
  chat: { id: number; type: string };
  from?: { id: number; username?: string; first_name?: string };
  text?: string;
  caption?: string;
  video?: { file_id: string; file_name?: string; file_size?: number };
  document?: { file_id: string; file_name?: string; file_size?: number };
  photo?: Array<{ file_id: string; width: number; height: number; file_size?: number }>;
}

interface TelegramCallbackQuery {
  id: string;
  from: { id: number; username?: string; first_name?: string };
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
}

interface ActiveUnirSession {
  id: string;
  chatId: number;
  userId: string;
  title: string;
  partRelativePaths: string[];
  totalBytes: number;
  createdAt: number;
}

interface CatalogViewFilter {
  search?: string;
  visibility: 'all' | 'published' | 'hidden';
  ordering: '-fecha_creacion' | '-cantidad_vistas' | '-cantidad_me_gusta' | '-cantidad_comentarios';
}

interface UploadWizardDraft {
  id: string;
  userId: string;
  chatId: number;
  messageId?: number;
  source: 'telegram_mtproto' | 'unir_assembler' | 'direct_url';
  sourceMessageId?: number;
  telegramFileId?: string;
  sourceUrl?: string;
  unirPartPaths?: string[];
  fileName: string;
  sizeBytes: number;
  title: string;
  description: string;
  tipologia: number;
  clasificacion: string;
  keywords: string;
  year?: string;
  publicado: boolean;
  descargable: boolean;
  mostrarComentarios: boolean;
  autoPromo: boolean;
  serieId?: number;
  serieName?: string;
  temporada: string;
  numero: string;
  episodeSubtitle?: string;
  playlistId?: number;
  playlistName?: string;
  coverUrl?: string;
  posterUrl?: string;
  customCoverPath?: string;
  tmdbCandidates: TmdbEnrichedCandidate[];
  createdAt: number;
}

type PendingInputState =
  | { kind: 'login_user'; chatId: number; expiresAt: number }
  | { kind: 'login_pass'; chatId: number; username: string; expiresAt: number }
  | { kind: 'wiz_title'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_desc'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_cover'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_tmdb_q'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_tags'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_year'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'wiz_epnum'; draftId: string; chatId: number; expiresAt: number }
  | { kind: 'cat_search'; chatId: number; expiresAt: number }
  | { kind: 'cat_title'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'cat_desc'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'cat_cover'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'ser_new'; chatId: number; attachDraftId?: string; expiresAt: number }
  | { kind: 'ser_name'; serieId: number; chatId: number; expiresAt: number }
  | { kind: 'ser_desc'; serieId: number; chatId: number; expiresAt: number }
  | { kind: 'ser_cover'; serieId: number; chatId: number; expiresAt: number }
  | { kind: 'lis_new'; chatId: number; expiresAt: number }
  | { kind: 'lis_name'; playlistId: number; chatId: number; expiresAt: number }
  | { kind: 'ch_name'; chatId: number; expiresAt: number }
  | { kind: 'ch_desc'; chatId: number; expiresAt: number }
  | { kind: 'ch_avatar'; chatId: number; expiresAt: number }
  | { kind: 'ch_banner'; chatId: number; expiresAt: number }
  | { kind: 'com_reply'; commentId: number; pubId: number; chatId: number; expiresAt: number }
  | { kind: 'promo_add'; chatId: number; expiresAt: number }
  | { kind: 'promo_cast'; chatId: number; expiresAt: number }
  | { kind: 'req_add'; chatId: number; expiresAt: number }
  | { kind: 'tmdb_search'; chatId: number; expiresAt: number }
  | { kind: 'ai_ask'; chatId: number; expiresAt: number }
  | { kind: 'url_upload'; chatId: number; expiresAt: number }
  | { kind: 'unir_start'; chatId: number; expiresAt: number }
  | { kind: 'add_user'; chatId: number; expiresAt: number };

const CLASIFICACIONES = ['TP', '+12', '+16', '18+'];
const BOT_API_MAX_DOWNLOAD_BYTES = Math.floor(19.5 * 1024 * 1024);

const fmtMb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const fmtGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;
const fmtNum = (n: number) => Number(n || 0).toLocaleString('es-ES');

function extractStatMetrics(raw: Record<string, unknown> | null): Array<{ label: string; value: string }> {
  if (!raw || typeof raw !== 'object') return [];
  const labelMap: Record<string, string> = {
    vistas: '👁 Vistas',
    reproducciones: '👁 Reproducciones',
    cantidad_vistas: '👁 Vistas',
    cantidad_reproducciones: '👁 Reproducciones',
    total_vistas: '👁 Total vistas',
    me_gusta: '❤️ Me gusta',
    likes: '❤️ Me gusta',
    cantidad_me_gusta: '❤️ Me gusta',
    comentarios: '💬 Comentarios',
    cantidad_comentarios: '💬 Comentarios',
    descargas: '⬇️ Descargas',
    cantidad_descargas: '⬇️ Descargas',
    suscriptores: '👥 Suscriptores',
    nuevos_suscriptores: '👥 Nuevos suscriptores',
    publicaciones: '🎬 Publicaciones',
    nuevas_publicaciones: '🎬 Nuevas publicaciones',
  };

  const out: Array<{ label: string; value: string }> = [];
  const visit = (obj: Record<string, unknown>, depth = 0) => {
    if (depth > 2) return;
    for (const [k, v] of Object.entries(obj)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        const lower = k.toLowerCase();
        const pretty = labelMap[lower] || k.replace(/_/g, ' ');
        if (!out.some((x) => x.label === pretty)) {
          out.push({ label: pretty, value: fmtNum(v) });
        }
      } else if (v && typeof v === 'object' && !Array.isArray(v)) {
        visit(v as Record<string, unknown>, depth + 1);
      }
    }
  };
  visit(raw);
  return out.slice(0, 12);
}

export class TelegramBotRuntime {
  private readonly startedAt = new Date().toISOString();
  private readonly isCloudRunDetected = Boolean(process.env.K_SERVICE);

  private pollingActive = false;
  private pollingAborted = false;
  private webhookActive = false;
  private webhookUrl?: string;
  private botUsername?: string;
  private lastOffset = 0;
  private updatesProcessed = 0;
  private lastPollAt?: string;
  private lastError?: string;

  private alertsTimer: NodeJS.Timeout | null = null;
  private nomadTimer: NodeJS.Timeout | null = null;
  private queueTimer: NodeJS.Timeout | null = null;
  private housekeepTimer: NodeJS.Timeout | null = null;
  private queueWorkerBusy = false;

  // Bounded ephemeral maps (auto-swept by housekeepTimer)
  private activeUnirSessions = new Map<string, ActiveUnirSession>();
  private wizardDrafts = new Map<string, UploadWizardDraft>();
  private pendingInputs = new Map<string, PendingInputState>();
  private commentSessionCache = new Map<string, { items: PictaCommentItem[]; expiresAt: number }>();
  private aiReplyDrafts = new Map<string, { text: string; expiresAt: number }>();
  private catalogFilters = new Map<string, CatalogViewFilter>();
  private catalogTmdbCache = new Map<string, { items: TmdbEnrichedCandidate[]; expiresAt: number }>();

  public getBotToken(): string {
    return getTelegramBotToken();
  }

  public async sendMessage(chatId: string | number, htmlText: string, markup?: InlineKeyboardMarkup): Promise<boolean> {
    return Boolean(await tgSendMessage(chatId, htmlText, markup));
  }

  public verifyWebhookSecretHeader(headerValue: string | undefined): boolean {
    const expected = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
    if (!expected || !headerValue) return false;
    const bufA = Buffer.from(headerValue);
    const bufB = Buffer.from(expected);
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
  }

  public async start(): Promise<void> {
    this.startBackgroundLoops();
    netlog.info('system', 'Modo bot headless 24/7 iniciado (sin panel web).');

    await this.applyTransportMode();
    if (this.getBotToken()) {
      void tgRegisterDefaultCommands();
    }

    void mtprotoPool
      .connectIfConfigured()
      .then((ok) => {
        console.log(`[PictaBot] MTProto FastSocket: ${ok ? 'CONECTADO' : 'EN ESPERA'}`);
      })
      .catch((err) => {
        console.warn(`[PictaBot] MTProto aviso: ${err instanceof Error ? err.message : String(err)}`);
      });
  }

  public async applyTransportMode(): Promise<void> {
    const token = this.getBotToken();
    this.stopPollingLoop();
    this.webhookActive = false;
    this.webhookUrl = undefined;

    if (!token) {
      netlog.info('telegram', 'Bot en espera: define TELEGRAM_BOT_TOKEN en el entorno.');
      console.log('[PictaBot] Telegram en espera (falta TELEGRAM_BOT_TOKEN).');
      return;
    }

    try {
      const meRes = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      const meJson = (await meRes.json()) as { ok?: boolean; result?: { username?: string } };
      if (meJson.ok && meJson.result?.username) {
        this.botUsername = meJson.result.username;
      }
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      netlog.warn('telegram', `No se pudo verificar getMe: ${this.lastError}`);
    }

    if (stateStore.config.telegramMode === 'webhook' && stateStore.config.appUrl.startsWith('https://')) {
      const targetUrl = `${stateStore.config.appUrl.replace(/\/+$/, '')}/telegram/webhook`;
      const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: targetUrl,
            ...(secret ? { secret_token: secret } : {}),
            allowed_updates: ['message', 'callback_query'],
            drop_pending_updates: false,
          }),
        });
        const body = (await res.json()) as { ok?: boolean; description?: string };
        if (body.ok) {
          this.webhookActive = true;
          this.webhookUrl = targetUrl;
          this.lastError = undefined;
          netlog.info('telegram', `Webhook HTTPS registrado en ${targetUrl}`);
          console.log(`[PictaBot] Telegram Webhook activo (@${this.botUsername || 'bot'}) -> ${targetUrl}`);
          return;
        }
        this.lastError = body.description || 'Error registrando Webhook';
        netlog.error('telegram', `Fallo Webhook: ${this.lastError}. Usando Long Polling.`);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        netlog.error('telegram', `Error de red Webhook: ${this.lastError}`);
      }
    }

    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
    } catch {
      // Proceed to polling
    }

    this.startPollingLoop();
    console.log(`[PictaBot] Telegram Long Polling 24/7 activo (@${this.botUsername || 'bot'}).`);
  }

  private stopPollingLoop(): void {
    this.pollingAborted = true;
    this.pollingActive = false;
  }

  private startPollingLoop(): void {
    const token = this.getBotToken();
    if (!token) return;

    this.pollingAborted = false;
    this.pollingActive = true;
    netlog.info('telegram', 'Long Polling 24/7 iniciado (message + callback_query).');

    const pollTick = async () => {
      if (this.pollingAborted) return;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 32_000);
      try {
        const allowed = encodeURIComponent(JSON.stringify(['message', 'callback_query']));
        const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${this.lastOffset}&allowed_updates=${allowed}`;
        const res = await fetch(url, { signal: controller.signal });
        this.lastPollAt = new Date().toISOString();

        const data = (await res.json()) as { ok?: boolean; result?: TelegramUpdate[]; description?: string };
        if (data.ok && Array.isArray(data.result)) {
          this.lastError = undefined;
          for (const update of data.result) {
            this.lastOffset = Math.max(this.lastOffset, update.update_id + 1);
            await this.handleIncomingUpdate(update);
          }
        } else if (!data.ok) {
          this.lastError = data.description || `HTTP ${res.status}`;
          netlog.warn('telegram', `getUpdates error: ${this.lastError}`);
          await new Promise((r) => setTimeout(r, 4000));
        }
      } catch (err) {
        if (!this.pollingAborted) {
          this.lastError = err instanceof Error ? err.message : String(err);
          await new Promise((r) => setTimeout(r, 4000));
        }
      } finally {
        clearTimeout(timeout);
      }

      if (!this.pollingAborted) setImmediate(pollTick);
    };

    void pollTick();
  }

  private isAdmin(user: AuthorizedUser): boolean {
    return user.role === 'admin' || stateStore.isMasterAdmin(user.telegramUserId);
  }

  private getCatalogFilter(userId: string): CatalogViewFilter {
    return (
      this.catalogFilters.get(userId) || {
        visibility: 'all',
        ordering: '-fecha_creacion',
      }
    );
  }

  // ===========================================================================
  // UI RENDERERS (CLEAN IN-PLACE NAVIGATION)
  // ===========================================================================

  private async renderMainMenu(chatId: number, user: AuthorizedUser, editMessageId?: number): Promise<void> {
    const isMaster = stateStore.isMasterAdmin(user.telegramUserId);
    const session = stateStore.userSessions.find((s) => s.telegramUserId === user.telegramUserId);
    const activeChannelLabel = session
      ? `${session.channelName} (#${session.channelId})`
      : isMaster
      ? `${pictaService.getDefaultChannelName()} (#${pictaService.getDefaultChannelId()})`
      : 'Sin vincular (usa /login)';

    const modeLabel = user.uploadMode === 'fast' ? '⚡ Rápido' : '🧭 Asistente';
    const activeJobs = stateStore.jobs.filter((j) =>
      ['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(j.status)
    ).length;
    const pendingReqs = stateStore.channelRequests.filter((r) => r.status === 'pending').length;
    const mt = mtprotoPool.getStatus();

    const text = [
      `<b>🎬 PictaBot 24/7 — Centro de Control</b>`,
      ``,
      `📺 <b>Canal activo:</b> ${escHtml(activeChannelLabel)}`,
      `⚙️ <b>Modo subida:</b> ${modeLabel} · <b>MTProto:</b> ${mt.connected ? '🟢 Online' : '🟡 Bot API'}`,
      `📦 <b>Cola:</b> ${activeJobs} activo(s) · <b>Peticiones:</b> ${pendingReqs} · <b>Alertas:</b> ${user.alertsEnabled ? '🔔' : '🔕'}`,
      `📊 <b>Cuota hoy:</b> ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB (${user.filesToday}/${user.dailyMaxFiles})`,
      `✨ <b>IA Gemini:</b> ${isGeminiConfigured() ? '🟢 Activa' : '⚪ Sin GEMINI_API_KEY'}`,
      ``,
      `<i>Envía cualquier video o archivo directamente aquí para subirlo, o elige una herramienta:</i>`,
    ].join('\n');

    const rows: InlineKeyboardButton[][] = [
      [
        { text: '🎬 Catálogo', callback_data: 'm:cat:1' },
        { text: '🏆 Top Videos', callback_data: 'm:top:v' },
        { text: '📺 Mi Canal', callback_data: 'm:chan' },
      ],
      [
        { text: '📺 Series', callback_data: 'm:ser' },
        { text: '📋 Listas', callback_data: 'm:lis' },
        { text: '🔍 TMDB', callback_data: 'm:tmdb' },
      ],
      [
        { text: '💬 Comentarios IA', callback_data: 'm:com:u:0' },
        { text: `🙋 Peticiones (${pendingReqs})`, callback_data: 'm:req:0' },
        { text: '🚨 Denuncias', callback_data: 'm:den' },
      ],
      [
        { text: '📢 Promos', callback_data: 'm:prm' },
        { text: `📥 Cola (${activeJobs})`, callback_data: 'm:col' },
        { text: '📊 Stats', callback_data: 'm:sta:1' },
      ],
      [
        { text: '🔔 Alertas', callback_data: 'm:ale' },
        { text: '✨ Asistente IA', callback_data: 'm:ai' },
        { text: '🧩 Unir / URL', callback_data: 'm:tools' },
      ],
      [
        { text: `Modo: ${modeLabel}`, callback_data: 'm:mode' },
        { text: '🔑 Cuenta Picta', callback_data: 'm:acc' },
      ],
      [
        ...(this.isAdmin(user) ? [{ text: '🛡️ Admin y Bóveda', callback_data: 'm:adm' }] : []),
        { text: '❓ Guía / Ayuda', callback_data: 'm:help' },
      ],
    ];

    await this.showOrEdit(chatId, editMessageId, text, { inline_keyboard: rows });
  }

  private async renderHelpView(chatId: number, editMessageId?: number): Promise<void> {
    const text = [
      `<b>❓ Guía Completa de PictaBot 24/7</b>`,
      ``,
      `<b>📤 Subidas y Ensamblaje</b>`,
      `• Envía cualquier video/documento directo al chat`,
      `• /modo — Alternar Asistente completo / Rápido automático`,
      `• /url <code>&lt;enlace&gt;</code> — Subir video desde enlace directo HTTP/S`,
      `• /unir <code>[título]</code> + /unir_fin — Unir partes (.001/.002), ZIP o TAR`,
      `• /cola — Ver progreso, errores, pausar o reintentar fallidos`,
      ``,
      `<b>🎬 Gestión del Canal y Catálogo</b>`,
      `• /catalogo <code>[buscar]</code> — Explorar, filtrar, ordenar y editar videos`,
      `• /top — Ranking de videos más vistos, likes, comentarios y descargas`,
      `• /canal — Ver y editar perfil, avatar y banner de tu canal`,
      `• /series — Crear, editar, fijar, rellenar con TMDB y ver capítulos`,
      `• /listas — Crear listas, añadir/quitar videos y editar visibilidad`,
      ``,
      `<b>💬 Comunidad, IA y Promoción</b>`,
      `• /comentarios — Leer y responder con sugerencias Gemini IA`,
      `• /peticiones — Peticiones de audiencia detectadas automáticamente`,
      `• /denuncias — Resumen y listado de denuncias del canal`,
      `• /promos — Canales promocionales, auto-post y difusión personalizada`,
      `• /ia <code>&lt;consulta&gt;</code> — Pedir sinopsis, títulos, promos o hashtags a Gemini`,
      `• /buscar <code>&lt;título&gt;</code> — Consultar ficha en TMDB`,
      ``,
      `<b>📊 Métricas, Cuenta y Sistema</b>`,
      `• /stats — Métricas del canal (Hoy / 7 días / 30 días)`,
      `• /alertas — Centro de alertas e hitos de vistas`,
      `• /login · /mis_canales · /logout — Multiusuario aislado`,
      `• /cuota · /disco · /admin · /backup · /restaurar_nube`,
    ].join('\n');

    await this.showOrEdit(chatId, editMessageId, text, {
      inline_keyboard: [[{ text: '🏠 Volver al Menú Principal', callback_data: 'm:home' }]],
    });
  }

  private async renderToolsHub(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    const unir = this.activeUnirSessions.get(userId);
    const lines = [
      `<b>🧩 Herramientas de Subida Avanzada</b>`,
      ``,
      `• <b>Ensamblador /unir:</b> Une archivos divididos (.001/.002) o extrae videos de .ZIP/.TAR en disco sin saturar RAM.`,
      `• <b>Subida por Enlace (/url):</b> Descarga directo desde un enlace HTTP/HTTPS al servidor y lo sube a Picta.`,
    ];
    const rows: InlineKeyboardButton[][] = [];
    if (unir) {
      lines.push(
        ``,
        `🟢 <b>Sesión /unir activa:</b> ${escHtml(unir.title)}`,
        `📦 Partes recibidas: <b>${unir.partRelativePaths.length}</b> (${fmtMb(unir.totalBytes)})`
      );
      rows.push([
        { text: '✅ Finalizar y Subir (/unir_fin)', callback_data: 'un:fin' },
        { text: '❌ Cancelar /unir', callback_data: 'un:can' },
      ]);
    } else {
      rows.push([{ text: '🧩 Iniciar nueva sesión /unir', callback_data: 'un:new' }]);
    }
    rows.push([{ text: '🔗 Subir video desde URL (/url)', callback_data: 'tl:url' }]);
    rows.push([{ text: '🏠 Menú Principal', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderWizardCard(draft: UploadWizardDraft, editMessageId?: number): Promise<void> {
    const tipName = PICTA_TIPOLOGIAS[draft.tipologia] || `ID ${draft.tipologia}`;
    const coverInfo = draft.customCoverPath
      ? '📸 Foto personalizada'
      : draft.coverUrl
      ? '🎬 Carátula TMDB HD'
      : '🎞️ Fotograma automático (ffmpeg)';
    const serieLine =
      draft.serieName || draft.tipologia === 5
        ? `📺 <b>Serie:</b> ${draft.serieName ? escHtml(draft.serieName) : 'Sin vincular'} (T${draft.temporada} Cap. ${draft.numero})`
        : '';
    const playlistLine = draft.playlistName ? `📋 <b>Lista:</b> ${escHtml(draft.playlistName)}` : '';
    const tagsLine = draft.keywords ? `🏷️ <b>Etiquetas:</b> ${escHtml(draft.keywords.slice(0, 90))}` : '';
    const yearLine = draft.year ? ` · <b>Año:</b> ${escHtml(draft.year)}` : '';

    const text = [
      `<b>🧭 Asistente Completo de Subida a Picta</b>`,
      ``,
      `🎞️ <b>Título:</b> ${escHtml(draft.title)}`,
      `📝 <b>Sinopsis:</b> ${escHtml(draft.description ? draft.description.slice(0, 240) : 'Sin sinopsis (usa TMDB o IA)')}`,
      `📂 <b>Tipología:</b> ${escHtml(tipName)} · <b>Clasif.:</b> ${escHtml(draft.clasificacion)}${yearLine}`,
      ...(serieLine ? [serieLine] : []),
      ...(playlistLine ? [playlistLine] : []),
      ...(tagsLine ? [tagsLine] : []),
      `🖼️ <b>Portada:</b> ${coverInfo}`,
      `📦 <b>Origen:</b> ${escHtml(draft.fileName)} (${draft.sizeBytes > 0 ? fmtMb(draft.sizeBytes) : 'Tamaño remoto'})`,
      `⚙️ ${draft.publicado ? '👁 Público' : '🔒 Oculto'} · ${draft.descargable ? '⬇️ Descarga' : '🚫 Sin desc.'} · ${draft.mostrarComentarios ? '💬 Com. SÍ' : '🔇 Com. NO'} · ${draft.autoPromo ? '📢 Promo SÍ' : '📢 Promo NO'}`,
    ].join('\n');

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Confirmar y Subir', callback_data: `w:go:${draft.id}` },
          { text: '❌ Cancelar', callback_data: `w:can:${draft.id}` },
        ],
        [
          { text: '🎬 TMDB Auto', callback_data: `w:tmdb:${draft.id}` },
          { text: '🔎 TMDB Manual', callback_data: `w:tmdbq:${draft.id}` },
          { text: '✨ Pulir IA', callback_data: `w:ai:${draft.id}` },
        ],
        [
          { text: `📂 ${tipName.slice(0, 16)}`, callback_data: `w:tip:${draft.id}` },
          { text: `🔞 ${draft.clasificacion}`, callback_data: `w:cla:${draft.id}` },
          { text: `📅 ${draft.year || 'Año'}`, callback_data: `w:yr:${draft.id}` },
        ],
        [
          { text: '📺 Serie / Cap.', callback_data: `w:ser:${draft.id}` },
          { text: '🔢 T/Cap.', callback_data: `w:epn:${draft.id}` },
          { text: '📋 Lista', callback_data: `w:lis:${draft.id}` },
        ],
        [
          { text: '✏️ Título', callback_data: `w:tit:${draft.id}` },
          { text: '📝 Sinopsis', callback_data: `w:des:${draft.id}` },
          { text: '🖼️ Portada', callback_data: `w:cov:${draft.id}` },
        ],
        [
          { text: '🏷️ Etiquetas', callback_data: `w:tag:${draft.id}` },
          { text: draft.mostrarComentarios ? '💬 Com: SÍ' : '🔇 Com: NO', callback_data: `w:com:${draft.id}` },
        ],
        [
          { text: draft.publicado ? '👁 Público: SÍ' : '🔒 Público: NO', callback_data: `w:pub:${draft.id}` },
          { text: draft.descargable ? '⬇️ Desc: SÍ' : '⬇️ Desc: NO', callback_data: `w:dl:${draft.id}` },
          { text: draft.autoPromo ? '📢 Promo: SÍ' : '📢 Promo: NO', callback_data: `w:prm:${draft.id}` },
        ],
      ],
    };

    const targetMsgId = editMessageId || draft.messageId;
    if (targetMsgId) {
      const ok = await tgEditMessage(draft.chatId, targetMsgId, text, markup);
      if (ok) {
        draft.messageId = targetMsgId;
        return;
      }
    }
    const sentId = await tgSendMessage(draft.chatId, text, markup);
    if (sentId) draft.messageId = sentId;
  }

  private async renderCatalogPage(
    chatId: number,
    userId: string,
    page: number,
    overrideSearch?: string | null,
    editMessageId?: number
  ): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(msg)}`, {
        inline_keyboard: [[{ text: '🔑 Iniciar sesión Picta', callback_data: 'm:acc' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
      });
      return;
    }

    const filter = this.getCatalogFilter(userId);
    if (overrideSearch !== undefined) {
      filter.search = overrideSearch || undefined;
      this.catalogFilters.set(userId, filter);
    }

    const res = await pictaService.fetchChannelPublications({
      ctx,
      page,
      pageSize: 6,
      search: filter.search,
      ordering: filter.ordering,
      visibility: filter.visibility,
    });

    const sortLabels: Record<CatalogViewFilter['ordering'], string> = {
      '-fecha_creacion': '🕒 Recientes',
      '-cantidad_vistas': '👁 Vistas',
      '-cantidad_me_gusta': '❤️ Likes',
      '-cantidad_comentarios': '💬 Coment.',
    };
    const visLabels: Record<CatalogViewFilter['visibility'], string> = {
      all: 'Todos',
      published: '🟢 Públicos',
      hidden: '🔒 Ocultos',
    };

    const lines = [
      `<b>🎬 Catálogo — ${escHtml(ctx.channelName)}</b>`,
      `Filtro: <b>${visLabels[filter.visibility]}</b> · Orden: <b>${sortLabels[filter.ordering]}</b> · Pág. ${page} (${fmtNum(res.total)} total)`,
      ...(filter.search ? [`🔍 Búsqueda: <i>${escHtml(filter.search)}</i>`] : []),
      ``,
    ];

    const rows: InlineKeyboardButton[][] = [
      [
        { text: `Filtro: ${visLabels[filter.visibility]}`, callback_data: 'cf:vis' },
        { text: `Orden: ${sortLabels[filter.ordering]}`, callback_data: 'cf:ord' },
      ],
    ];

    if (res.items.length === 0) {
      lines.push('No se encontraron publicaciones con estos criterios.');
    } else {
      res.items.forEach((item, idx) => {
        const vis = item.publicado ? '🟢' : '🔒';
        lines.push(
          `${idx + 1}. ${vis} <b>${escHtml(item.nombre.slice(0, 52))}</b>\n   👁 ${fmtNum(item.cantidad_vistas)} · ❤️ ${fmtNum(item.cantidad_me_gusta)} · 💬 ${item.cantidad_comentarios} · ${escHtml(item.tipologiaNombre)}`
        );
        rows.push([{ text: `${idx + 1}. ${vis} ${item.nombre.slice(0, 36)}`, callback_data: `cv:${item.id}` }]);
      });
    }

    const navRow: InlineKeyboardButton[] = [];
    if (page > 1) navRow.push({ text: '⬅️ Ant.', callback_data: `m:cat:${page - 1}` });
    navRow.push({ text: '🔍 Buscar', callback_data: 'm:catsearch' });
    if (filter.search) navRow.push({ text: '✖️ Limpiar', callback_data: 'cf:clr' });
    if (res.hasNext) navRow.push({ text: 'Sig. ➡️', callback_data: `m:cat:${page + 1}` });
    rows.push(navRow);
    rows.push([{ text: '🏠 Menú Principal', callback_data: 'm:home' }]);

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderCatalogDetail(chatId: number, userId: string, videoId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const item = await pictaService.fetchPublicationById(videoId, ctx);
    if (!item) {
      await this.showOrEdit(chatId, editMessageId, `❌ Publicación #${escHtml(videoId)} no encontrada.`, {
        inline_keyboard: [[{ text: '⬅️ Volver al Catálogo', callback_data: 'm:cat:1' }]],
      });
      return;
    }

    const text = [
      `<b>🎬 ${escHtml(item.nombre)}</b>`,
      `🆔 ID: <code>${escHtml(item.id)}</code> · 📂 ${escHtml(item.tipologiaNombre)} · 🔞 ${escHtml(item.clasificacion)}`,
      `👁 ${fmtNum(item.cantidad_vistas)} vistas · ❤️ ${fmtNum(item.cantidad_me_gusta)} likes · 💬 ${item.cantidad_comentarios} com. · ⬇️ ${fmtNum(item.cantidad_descargas)} desc.`,
      `⚙️ ${item.publicado ? '🟢 Publicado' : '🔒 Oculto'} · ${item.descargable ? '⬇️ Descargable' : '🚫 Solo stream'}${item.estado_codificacion ? ` · Nomad: ${escHtml(item.estado_codificacion)}` : ''}`,
      ``,
      `📝 ${escHtml(item.descripcion ? item.descripcion.slice(0, 440) : 'Sin sinopsis')}`,
      ``,
      `🔗 ${escHtml(item.webUrl)}`,
    ].join('\n');

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✏️ Título', callback_data: `ce:t:${item.id}` },
          { text: '📝 Sinopsis', callback_data: `ce:d:${item.id}` },
          { text: '🖼️ Portada', callback_data: `ce:cov:${item.id}` },
        ],
        [
          { text: '✨ Pulir con IA', callback_data: `ce:ai:${item.id}` },
          { text: '🎬 TMDB Top-3', callback_data: `ce:tmdb:${item.id}` },
        ],
        [
          { text: '📂 Tipología', callback_data: `ce:tip:${item.id}` },
          { text: `🔞 ${item.clasificacion}`, callback_data: `ce:cla:${item.id}` },
        ],
        [
          { text: '📺 Mover a Serie', callback_data: `ce:ser:${item.id}` },
          { text: '📋 Añadir a Lista', callback_data: `ce:lis:${item.id}` },
        ],
        [
          { text: item.publicado ? '🔒 Ocultar' : '👁️ Publicar', callback_data: `ce:pub:${item.id}` },
          { text: item.descargable ? '🚫 Sin descarga' : '⬇️ Descargable', callback_data: `ce:dl:${item.id}` },
        ],
        [
          { text: `💬 Comentarios (${item.cantidad_comentarios})`, callback_data: `cvc:${item.id}` },
          { text: '🖼️ Ficha + Foto', callback_data: `ce:card:${item.id}` },
        ],
        [
          { text: '📢 Difundir Promo', callback_data: `ce:prm:${item.id}` },
          { text: '🗑️ Eliminar', callback_data: `ce:del:${item.id}` },
        ],
        [
          { text: '⬅️ Catálogo', callback_data: 'm:cat:1' },
          { text: '🏠 Menú', callback_data: 'm:home' },
        ],
      ],
    };

    await this.showOrEdit(chatId, editMessageId, text, markup);
  }

  private async renderTopVideosView(
    chatId: number,
    userId: string,
    metric: 'v' | 'l' | 'c' | 'd',
    editMessageId?: number
  ): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const orderMap: Record<'v' | 'l' | 'c' | 'd', { ordering: string; title: string }> = {
      v: { ordering: '-cantidad_vistas', title: '👁 Más Vistos' },
      l: { ordering: '-cantidad_me_gusta', title: '❤️ Más Likes' },
      c: { ordering: '-cantidad_comentarios', title: '💬 Más Comentados' },
      d: { ordering: '-cantidad_descargas', title: '⬇️ Más Descargados' },
    };

    const res = await pictaService.fetchChannelPublications({
      ctx,
      page: 1,
      pageSize: 8,
      ordering: orderMap[metric].ordering,
    });

    const sorted = [...res.items].sort((a, b) => {
      if (metric === 'l') return b.cantidad_me_gusta - a.cantidad_me_gusta;
      if (metric === 'c') return b.cantidad_comentarios - a.cantidad_comentarios;
      if (metric === 'd') return b.cantidad_descargas - a.cantidad_descargas;
      return b.cantidad_vistas - a.cantidad_vistas;
    });

    const lines = [
      `<b>🏆 Top Videos — ${escHtml(ctx.channelName)}</b>`,
      `Ranking por: <b>${orderMap[metric].title}</b>`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [
      [
        { text: metric === 'v' ? '• 👁 Vistas •' : '👁 Vistas', callback_data: 'm:top:v' },
        { text: metric === 'l' ? '• ❤️ Likes •' : '❤️ Likes', callback_data: 'm:top:l' },
        { text: metric === 'c' ? '• 💬 Com. •' : '💬 Com.', callback_data: 'm:top:c' },
        { text: metric === 'd' ? '• ⬇️ Desc. •' : '⬇️ Desc.', callback_data: 'm:top:d' },
      ],
    ];

    if (sorted.length === 0) {
      lines.push('No hay publicaciones disponibles todavía.');
    } else {
      sorted.slice(0, 8).forEach((item, idx) => {
        const medal = idx === 0 ? '🥇' : idx === 1 ? '🥈' : idx === 2 ? '🥉' : `${idx + 1}.`;
        lines.push(
          `${medal} <b>${escHtml(item.nombre.slice(0, 48))}</b>\n   👁 ${fmtNum(item.cantidad_vistas)} · ❤️ ${fmtNum(item.cantidad_me_gusta)} · 💬 ${item.cantidad_comentarios} · ⬇️ ${fmtNum(item.cantidad_descargas)}`
        );
        rows.push([{ text: `${medal} Abrir: ${item.nombre.slice(0, 34)}`, callback_data: `cv:${item.id}` }]);
      });
    }

    rows.push([{ text: '📊 Estadísticas', callback_data: 'm:sta:1' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderChannelProfileView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const profile = await pictaService.fetchChannelDetails(ctx);
    if (!profile) {
      await this.showOrEdit(chatId, editMessageId, `❌ No se pudo cargar el perfil del canal #${escHtml(ctx.channelId)}.`, {
        inline_keyboard: [[{ text: '🏠 Menú', callback_data: 'm:home' }]],
      });
      return;
    }

    const text = [
      `<b>📺 Mi Canal de Picta</b>`,
      ``,
      `🏷️ <b>Nombre:</b> ${escHtml(profile.nombre)}`,
      `🆔 <b>ID:</b> <code>${profile.id}</code>${profile.alias ? ` · <b>Alias:</b> @${escHtml(profile.alias)}` : ''}`,
      `👥 <b>Suscriptores:</b> ${fmtNum(profile.cantidad_suscriptores)} · 🎬 <b>Videos:</b> ${fmtNum(profile.cantidad_publicaciones)}`,
      `🔞 <b>Clasificación:</b> ${escHtml(profile.clasificacion)} · ${profile.publicado ? '🟢 Público' : '🔒 Oculto'}`,
      ``,
      `📝 <b>Descripción:</b>\n${escHtml(profile.descripcion ? profile.descripcion.slice(0, 420) : 'Sin descripción')}`,
    ].join('\n');

    await this.showOrEdit(chatId, editMessageId, text, {
      inline_keyboard: [
        [
          { text: '✏️ Editar Nombre', callback_data: 'chp:name' },
          { text: '📝 Editar Descripción', callback_data: 'chp:desc' },
        ],
        [
          { text: '🖼️ Cambiar Avatar', callback_data: 'chp:ava' },
          { text: '🎨 Cambiar Banner', callback_data: 'chp:ban' },
        ],
        [
          { text: '🏆 Top Videos', callback_data: 'm:top:v' },
          { text: '📊 Estadísticas', callback_data: 'm:sta:1' },
        ],
        [{ text: '🔑 Cambiar de Canal', callback_data: 'm:acc' }, { text: '🏠 Menú', callback_data: 'm:home' }],
      ],
    });
  }

  private async renderSeriesView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const series = await pictaService.fetchChannelSeries(ctx);
    const lines = [
      `<b>📺 Series — ${escHtml(ctx.channelName)}</b>`,
      `Total: <b>${series.length}</b> serie(s). Toca una serie para ver capítulos, editar, portada o TMDB.`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [];

    if (series.length === 0) {
      lines.push('No hay series creadas en este canal todavía.');
    } else {
      series.slice(0, 12).forEach((s) => {
        const pinIcon = s.pinned ? '📌 ' : '';
        lines.push(`${pinIcon}<b>${escHtml(s.nombre)}</b> · ${s.cantidad_capitulos} cap.`);
        rows.push([{ text: `${pinIcon}${s.nombre.slice(0, 32)} (${s.cantidad_capitulos} cap)`, callback_data: `sd:${s.id}` }]);
      });
    }

    rows.push([{ text: '➕ Crear Nueva Serie', callback_data: 'ser:new' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderSerieDetailView(chatId: number, userId: string, serieId: number, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const [series, episodes] = await Promise.all([
      pictaService.fetchChannelSeries(ctx),
      pictaService.fetchSeriesEpisodes(ctx, serieId),
    ]);
    const s = series.find((x) => x.id === serieId);
    if (!s) {
      await this.showOrEdit(chatId, editMessageId, `❌ Serie #${serieId} no encontrada.`, {
        inline_keyboard: [[{ text: '⬅️ Volver a Series', callback_data: 'm:ser' }]],
      });
      return;
    }

    const lines = [
      `<b>📺 ${escHtml(s.nombre)}</b> ${s.pinned ? '📌' : ''}`,
      `🆔 ID: <code>${s.id}</code> · Capítulos: <b>${Math.max(s.cantidad_capitulos, episodes.length)}</b> · ${s.publicado ? '🟢 Pública' : '🔒 Oculta'}`,
      ``,
      `📝 ${escHtml(s.descripcion ? s.descripcion.slice(0, 320) : 'Sin sinopsis')}`,
    ];

    const rows: InlineKeyboardButton[][] = [
      [
        { text: s.pinned ? '📌 Desfijar' : '📍 Fijar Favorita', callback_data: `ser:pin:${s.id}` },
        { text: '🎬 TMDB (Sinopsis+Foto)', callback_data: `ser:tmdb:${s.id}` },
      ],
      [
        { text: '✏️ Nombre', callback_data: `ser:nam:${s.id}` },
        { text: '📝 Sinopsis', callback_data: `ser:des:${s.id}` },
        { text: '🖼️ Portada', callback_data: `ser:cov:${s.id}` },
      ],
      [
        { text: s.publicado ? '🔒 Ocultar' : '👁 Publicar', callback_data: `ser:pub:${s.id}` },
        { text: '🗑️ Eliminar Serie', callback_data: `ser:del:${s.id}` },
      ],
    ];

    if (episodes.length > 0) {
      lines.push(``, `<b>Capítulos recientes (${episodes.length}):</b>`);
      episodes.slice(0, 5).forEach((ep, i) => {
        lines.push(`${i + 1}. ${escHtml(ep.nombre.slice(0, 48))} (👁 ${fmtNum(ep.cantidad_vistas)})`);
        rows.push([{ text: `🎬 ${ep.nombre.slice(0, 38)}`, callback_data: `cv:${ep.id}` }]);
      });
    }

    rows.push([{ text: '⬅️ Series', callback_data: 'm:ser' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderPlaylistsView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const lists = await pictaService.fetchChannelPlaylists(ctx);
    const lines = [
      `<b>📋 Listas de Reproducción — ${escHtml(ctx.channelName)}</b>`,
      `Total: <b>${lists.length}</b> lista(s). Toca una lista para añadir/quitar videos o editarla.`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [];

    if (lists.length === 0) {
      lines.push('No hay listas de reproducción todavía.');
    } else {
      lists.slice(0, 12).forEach((l, i) => {
        const icon = l.publicado ? '🟢' : '🔒';
        lines.push(`${i + 1}. ${icon} <b>${escHtml(l.nombre)}</b> (${l.publicacionesIds.length} videos)`);
        rows.push([{ text: `${icon} ${l.nombre.slice(0, 32)} (${l.publicacionesIds.length})`, callback_data: `ld:${l.id}` }]);
      });
    }

    rows.push([{ text: '➕ Nueva Lista', callback_data: 'lis:new' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderPlaylistDetailView(chatId: number, userId: string, playlistId: number, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const lists = await pictaService.fetchChannelPlaylists(ctx);
    const pl = lists.find((x) => x.id === playlistId);
    if (!pl) {
      await this.showOrEdit(chatId, editMessageId, `❌ Lista #${playlistId} no encontrada.`, {
        inline_keyboard: [[{ text: '⬅️ Volver a Listas', callback_data: 'm:lis' }]],
      });
      return;
    }

    const lines = [
      `<b>📋 ${escHtml(pl.nombre)}</b>`,
      `🆔 ID: <code>${pl.id}</code> · Videos: <b>${pl.publicacionesIds.length}</b>`,
      `⚙️ ${pl.publicado ? '🟢 Pública' : '🔒 Oculta'} · ${pl.descarga ? '⬇️ Descargable' : '🚫 Sin descarga'}`,
    ];

    const rows: InlineKeyboardButton[][] = [
      [
        { text: '➕ Añadir Video', callback_data: `lis:add:${pl.id}` },
        ...(pl.publicacionesIds.length > 0 ? [{ text: '➖ Quitar Video', callback_data: `lis:rem:${pl.id}` }] : []),
      ],
      [
        { text: '✏️ Renombrar', callback_data: `lis:nam:${pl.id}` },
        { text: pl.publicado ? '🔒 Ocultar' : '👁 Publicar', callback_data: `lis:pub:${pl.id}` },
      ],
      [
        { text: pl.descarga ? '🚫 Sin descarga' : '⬇️ Descargable', callback_data: `lis:dl:${pl.id}` },
        { text: '🗑️ Eliminar Lista', callback_data: `lis:del:${pl.id}` },
      ],
      [{ text: '⬅️ Listas', callback_data: 'm:lis' }, { text: '🏠 Menú', callback_data: 'm:home' }],
    ];

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderCommentsView(
    chatId: number,
    userId: string,
    filter: 'u' | 'a' | 'r',
    index: number,
    forceRefresh = false,
    editMessageId?: number,
    scopedVideoId?: number
  ): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const cacheKey = scopedVideoId ? `${userId}:vid:${scopedVideoId}` : `${userId}:${ctx.channelId}`;
    const cached = this.commentSessionCache.get(cacheKey);
    let comments: PictaCommentItem[];
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      comments = cached.items;
    } else {
      comments = scopedVideoId
        ? await pictaService.fetchPublicationComments(ctx, scopedVideoId, `Video #${scopedVideoId}`, 25)
        : await pictaService.fetchChannelComments(ctx, 35);
      this.commentSessionCache.set(cacheKey, { items: comments, expiresAt: Date.now() + 3 * 60_000 });
    }

    const ignoredSet = new Set(stateStore.ignoredCommentIds);
    const filtered = comments.filter((c) => {
      if (ignoredSet.has(c.id)) return false;
      if (filter === 'r') return c.isLikelyRequest;
      return filter === 'u' ? !c.answered : true;
    });

    const toggleRow: InlineKeyboardButton[] = scopedVideoId
      ? [
          { text: '⬅️ Volver al Video', callback_data: `cv:${scopedVideoId}` },
          { text: '🔄 Recargar', callback_data: `cvc:${scopedVideoId}` },
        ]
      : [
          { text: filter === 'u' ? '• Pend. •' : 'Pendientes', callback_data: 'm:com:u:0' },
          { text: filter === 'r' ? '• 🙋 Pet. •' : '🙋 Petic.', callback_data: 'm:com:r:0' },
          { text: filter === 'a' ? '• Todos •' : 'Todos', callback_data: 'm:com:a:0' },
          { text: '🔄', callback_data: `m:comr:${filter}` },
        ];

    if (filtered.length === 0) {
      await this.showOrEdit(
        chatId,
        editMessageId,
        `<b>💬 Comentarios — ${escHtml(ctx.channelName)}</b>\n\nNo hay comentarios en esta vista.`,
        { inline_keyboard: [toggleRow, [{ text: '🏠 Menú Principal', callback_data: 'm:home' }]] }
      );
      return;
    }

    const safeIdx = Math.max(0, Math.min(index, filtered.length - 1));
    const c = filtered[safeIdx];
    const reqTag = c.isLikelyRequest ? ' · 🙋 Petición' : '';

    const text = [
      `<b>💬 Comentario ${safeIdx + 1}/${filtered.length}</b>`,
      `🎞️ <b>Video:</b> ${escHtml(c.publicacionNombre)}`,
      `👤 <b>Usuario:</b> ${escHtml(c.usuario)}${reqTag}`,
      `📅 ${escHtml(c.fecha ? c.fecha.slice(0, 16).replace('T', ' ') : 'Reciente')} · ${c.answered ? `✅ ${c.replyCount} resp.` : '⏳ Sin responder'}`,
      ``,
      `“${escHtml(c.texto.slice(0, 800))}”`,
    ].join('\n');

    const navRow: InlineKeyboardButton[] = [];
    if (!scopedVideoId) {
      if (safeIdx > 0) navRow.push({ text: '⬅️ Ant.', callback_data: `m:com:${filter}:${safeIdx - 1}` });
      if (safeIdx < filtered.length - 1) navRow.push({ text: 'Sig. ➡️', callback_data: `m:com:${filter}:${safeIdx + 1}` });
    }

    const rows: InlineKeyboardButton[][] = [
      toggleRow,
      [
        { text: '✨ Respuesta IA', callback_data: `cm:ai:${c.id}:${c.publicacionId}` },
        { text: '✍️ Responder manual', callback_data: `cm:man:${c.id}:${c.publicacionId}` },
      ],
      [
        ...(c.publicacionId ? [{ text: '🎬 Abrir Video', callback_data: `cv:${c.publicacionId}` }] : []),
        { text: '🙈 Ignorar', callback_data: `cm:ign:${c.id}` },
        { text: '🗑️ Borrar', callback_data: `cm:del:${c.id}` },
      ],
      ...(navRow.length > 0 ? [navRow] : []),
      [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
    ];

    await this.showOrEdit(chatId, editMessageId, text, { inline_keyboard: rows });
  }

  private async renderRequestsView(chatId: number, page: number, editMessageId?: number): Promise<void> {
    const pending = stateStore.channelRequests.filter((r) => r.status === 'pending');
    const resolvedCount = stateStore.channelRequests.length - pending.length;
    const lines = [
      `<b>🙋 Peticiones de Audiencia</b> (${pending.length} pendiente(s) · ${resolvedCount} resueltas)`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [];

    if (pending.length === 0) {
      lines.push('No hay peticiones pendientes. Se capturan automáticamente al revisar /comentarios o puedes agregar una manual.');
    } else {
      const start = page * 4;
      const slice = pending.slice(start, start + 4);
      slice.forEach((req, idx) => {
        const globalIdx = start + idx;
        lines.push(
          `${globalIdx + 1}. <b>${escHtml(req.requestedTitle)}</b>\n   👤 ${escHtml(req.requesterName)} en <i>${escHtml(req.sourceVideoTitle.slice(0, 35))}</i>\n   “${escHtml(req.rawText.slice(0, 120))}”`
        );
        rows.push([
          { text: `✅ #${globalIdx + 1}`, callback_data: `rq:ok:${req.id.slice(0, 12)}` },
          { text: `🎬 TMDB #${globalIdx + 1}`, callback_data: `rq:tm:${req.id.slice(0, 12)}` },
          { text: `🗑️ #${globalIdx + 1}`, callback_data: `rq:ign:${req.id.slice(0, 12)}` },
        ]);
      });

      const nav: InlineKeyboardButton[] = [];
      if (page > 0) nav.push({ text: '⬅️ Anterior', callback_data: `m:req:${page - 1}` });
      if (start + 4 < pending.length) nav.push({ text: 'Siguiente ➡️', callback_data: `m:req:${page + 1}` });
      if (nav.length > 0) rows.push(nav);
    }

    rows.push([
      { text: '➕ Agregar Manual', callback_data: 'rq:add' },
      ...(resolvedCount > 0 ? [{ text: '🧹 Limpiar resueltas', callback_data: 'rq:clr' }] : []),
    ]);
    rows.push([{ text: '💬 Revisar Comentarios', callback_data: 'm:com:u:0' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderDenunciasView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const [den, list] = await Promise.all([
      pictaService.fetchDenunciasSummary(ctx),
      pictaService.fetchDenunciasList(ctx, 8),
    ]);

    const lines = [
      `<b>🚨 Denuncias — ${escHtml(ctx.channelName)}</b>`,
      ``,
      `• Pendientes: <b>${den.cantidad_pendientes}</b> · En proceso: <b>${den.cantidad_en_proceso}</b>`,
      `• Procesadas: <b>${den.cantidad_procesadas}</b> · No proceden: <b>${den.cantidad_no_proceden}</b>`,
      `• Total histórico: <b>${den.total}</b>`,
    ];

    if (list.length > 0) {
      lines.push(``, `<b>Últimas denuncias registradas:</b>`);
      list.slice(0, 6).forEach((d, idx) => {
        lines.push(
          `${idx + 1}. <b>${escHtml(d.publicacionNombre.slice(0, 40))}</b> [${escHtml(d.estado)}]\n   Motivo: <i>${escHtml(d.motivo)}</i>`
        );
      });
    } else if (den.total === 0) {
      lines.push(``, `✅ Tu canal no tiene denuncias registradas.`);
    }

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), {
      inline_keyboard: [[{ text: '🔄 Actualizar', callback_data: 'm:den' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
    });
  }

  private async renderPromosView(chatId: number, editMessageId?: number): Promise<void> {
    const promos = stateStore.promoChannels;
    const lines = [
      `<b>📢 Canales Promocionales (${promos.length})</b>`,
      `Difunde estrenos con portada y enlace automáticamente o envía un anuncio personalizado.`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [];

    if (promos.length === 0) {
      lines.push('No hay canales promocionales configurados todavía.');
    } else {
      promos.forEach((p, idx) => {
        lines.push(`${idx + 1}. <b>${escHtml(p.name)}</b> (<code>${escHtml(p.telegramChatId)}</code>) · Auto-post: ${p.autoPostEnabled ? '🟢 SÍ' : '⚪ NO'}`);
        rows.push([
          { text: `${p.autoPostEnabled ? '🟢 Auto' : '⚪ Manual'}: ${p.name.slice(0, 20)}`, callback_data: `pr:tog:${idx}` },
          { text: '🗑️ Quitar', callback_data: `pr:del:${idx}` },
        ]);
      });
      rows.push([{ text: '📣 Enviar Promo Personalizada a Todos', callback_data: 'pr:cast' }]);
    }

    rows.push([{ text: '➕ Agregar Canal Promo', callback_data: 'pr:add' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderStatsView(
    chatId: number,
    userId: string,
    days: 1 | 7 | 30,
    editMessageId?: number
  ): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const [profile, stats, recentPubs] = await Promise.all([
      pictaService.fetchChannelDetails(ctx),
      pictaService.fetchChannelStats(ctx, days),
      pictaService.fetchChannelPublications({ ctx, page: 1, pageSize: 20 }),
    ]);

    const periodLabel = days === 1 ? 'Hoy (La Habana)' : `Últimos ${days} días`;
    const parsedStats = extractStatMetrics(stats);

    const sampleViews = recentPubs.items.reduce((acc, p) => acc + p.cantidad_vistas, 0);
    const sampleLikes = recentPubs.items.reduce((acc, p) => acc + p.cantidad_me_gusta, 0);
    const sampleComments = recentPubs.items.reduce((acc, p) => acc + p.cantidad_comentarios, 0);
    const sampleDownloads = recentPubs.items.reduce((acc, p) => acc + p.cantidad_descargas, 0);

    const lines = [
      `<b>📊 Estadísticas — ${escHtml(profile?.nombre || ctx.channelName)}</b>`,
      `Período seleccionado: <b>${periodLabel}</b>`,
      ``,
      ...(profile
        ? [
            `👥 <b>Suscriptores totales:</b> ${fmtNum(profile.cantidad_suscriptores)}`,
            `🎬 <b>Publicaciones totales:</b> ${fmtNum(profile.cantidad_publicaciones)}`,
          ]
        : []),
      ``,
      `<b>📈 Resumen de Picta (${periodLabel}):</b>`,
      ...(parsedStats.length > 0
        ? parsedStats.map((m) => `• ${escHtml(m.label)}: <b>${escHtml(m.value)}</b>`)
        : ['• Sin desglose diario reportado por la API para este rango.']),
      ``,
      `<b>🎞️ Rendimiento últimos ${recentPubs.items.length} videos:</b>`,
      `• 👁 Vistas: <b>${fmtNum(sampleViews)}</b> · ❤️ Likes: <b>${fmtNum(sampleLikes)}</b>`,
      `• 💬 Comentarios: <b>${fmtNum(sampleComments)}</b> · ⬇️ Descargas: <b>${fmtNum(sampleDownloads)}</b>`,
    ];

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), {
      inline_keyboard: [
        [
          { text: days === 1 ? '• Hoy •' : '📅 Hoy', callback_data: 'm:sta:1' },
          { text: days === 7 ? '• 7 días •' : '📆 7 días', callback_data: 'm:sta:7' },
          { text: days === 30 ? '• 30 días •' : '🗓️ 30 días', callback_data: 'm:sta:30' },
        ],
        [
          { text: '🏆 Top Videos', callback_data: 'm:top:v' },
          { text: '🔔 Centro de Alertas', callback_data: 'm:ale' },
        ],
        [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
      ],
    });
  }

  private async renderAlertsView(chatId: number, user: AuthorizedUser, editMessageId?: number): Promise<void> {
    const recent = stateStore.alerts.slice(0, 8);
    const lines = [
      `<b>🔔 Centro de Alertas e Hitos</b>`,
      `Tus notificaciones: <b>${user.alertsEnabled ? '🔔 Activas' : '🔕 Silenciadas'}</b>`,
      `Videos vigilados: <b>${stateStore.watchedVideos.length}</b> · Intervalo: <b>${Math.round(stateStore.config.alertsIntervalMs / 60_000)} min</b>`,
      ``,
      `<b>Últimas alertas detectadas (${stateStore.alerts.length}):</b>`,
      ...(recent.length > 0
        ? recent.map(
            (a) =>
              `• ${a.type === 'milestone' ? '🏆' : '💬'} <b>${escHtml(a.videoTitle.slice(0, 32))}</b> — ${escHtml(a.summary)}`
          )
        : ['• Sin alertas registradas todavía.']),
    ];

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), {
      inline_keyboard: [
        [
          { text: user.alertsEnabled ? '🔕 Silenciar mis alertas' : '🔔 Activar mis alertas', callback_data: 'al:tog' },
          { text: '🔎 Escanear ahora', callback_data: 'al:scan' },
        ],
        [
          { text: '🔁 Barrido Nomad', callback_data: 'al:nomad' },
          ...(stateStore.alerts.length > 0 ? [{ text: '🧹 Limpiar historial', callback_data: 'al:clr' }] : []),
        ],
        [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
      ],
    });
  }

  private async renderQueueView(chatId: number, user: AuthorizedUser, editMessageId?: number): Promise<void> {
    const disk = await getDiskStatusReport();
    const recent = stateStore.jobs.slice(0, 8);
    const failedCount = stateStore.jobs.filter((j) => j.status === 'failed').length;
    const pendingCount = stateStore.jobs.filter((j) => j.status === 'queued').length;

    const lines = [
      `<b>📥 Cola de Subidas y Disco</b>`,
      `Estado: <b>${stateStore.config.queuePaused ? '⏸️ Pausada' : '▶️ Activa'}</b> · Disco: <b>${disk.usagePct}%</b> (${fmtGb(disk.budgetRemainingBytes)} libres)`,
      ``,
    ];

    if (recent.length === 0) {
      lines.push('La cola está vacía.');
    } else {
      for (const j of recent) {
        const icon =
          j.status === 'completed'
            ? '✅'
            : j.status === 'failed'
            ? '❌'
            : j.status === 'cancelled'
            ? '🚫'
            : j.status === 'encoding_nomad'
            ? '⚙️'
            : '⏳';
        const spd = j.speedMbps ? ` · ${j.speedMbps} MB/s` : '';
        lines.push(`${icon} <b>${escHtml(j.title.slice(0, 38))}</b> [${j.status}] ${j.progressPct}%${spd}`);
        if (j.status === 'failed' && j.errorMessage) {
          lines.push(`   <i>↳ ${escHtml(j.errorMessage.slice(0, 110))}</i>`);
        }
      }
    }

    const rows: InlineKeyboardButton[][] = [
      [
        { text: '🔄 Actualizar', callback_data: 'm:col' },
        { text: `🔁 Reintentar fallidos (${failedCount})`, callback_data: 'cl:retry' },
      ],
    ];
    if (pendingCount > 0) {
      rows.push([{ text: `❌ Cancelar pendientes (${pendingCount})`, callback_data: 'cl:canq' }]);
    }
    if (this.isAdmin(user)) {
      rows.push([
        { text: stateStore.config.queuePaused ? '▶️ Reanudar Cola' : '⏸️ Pausar Cola', callback_data: 'cl:pause' },
        { text: '🧹 Limpiar historial', callback_data: 'cl:clr' },
      ]);
      rows.push([{ text: '🧹 Purgar Scratch', callback_data: 'cl:purge' }]);
    }
    rows.push([{ text: '🏠 Menú Principal', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderAccountView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    const isMaster = stateStore.isMasterAdmin(userId);
    const session = stateStore.userSessions.find((s) => s.telegramUserId === userId);
    const lines = [`<b>🔑 Cuenta de Picta (Multiusuario Aislado)</b>`, ``];
    const rows: InlineKeyboardButton[][] = [];

    if (session) {
      lines.push(`👤 <b>Usuario vinculado:</b> ${escHtml(session.pictaUsername)}`);
      lines.push(`📺 <b>Canal activo:</b> ${escHtml(session.channelName)} (#${escHtml(session.channelId)})`);
      lines.push(`🔐 Credenciales protegidas con cifrado AES-256-GCM.`);
      if (session.availableChannels.length > 1) {
        lines.push(``, `Selecciona tu canal activo:`);
        for (const ch of session.availableChannels.slice(0, 6)) {
          const activeMark = String(ch.id) === String(session.channelId) ? '✅ ' : '';
          rows.push([{ text: `${activeMark}${ch.nombre} (#${ch.id})`, callback_data: `ch:${ch.id}` }]);
        }
      }
      rows.push([{ text: '🔄 Re-vincular (/login)', callback_data: 'ac:login' }, { text: '🚪 Cerrar sesión', callback_data: 'ac:logout' }]);
    } else if (isMaster) {
      lines.push(`👑 Operando con la <b>Cuenta Maestra</b> del servidor.`);
      lines.push(`📺 Canal maestro: ${escHtml(pictaService.getDefaultChannelName())} (#${escHtml(pictaService.getDefaultChannelId())})`);
      lines.push(`También puedes vincular una cuenta adicional con /login.`);
      rows.push([{ text: '🔑 Vincular otra cuenta (/login)', callback_data: 'ac:login' }]);
    } else {
      lines.push(`No tienes ninguna cuenta de Picta vinculada todavía.`);
      lines.push(`Tu cuenta operará totalmente aislada sobre tus propios canales sin acceso al canal maestro.`);
      rows.push([{ text: '🔑 Iniciar sesión en Picta', callback_data: 'ac:login' }]);
    }

    rows.push([{ text: '📺 Ver Mi Canal', callback_data: 'm:chan' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderAdminView(chatId: number, editMessageId?: number): Promise<void> {
    const disk = await getDiskStatusReport();
    const mt = mtprotoPool.getStatus();
    const vault = getVaultConfigStatus();
    const bins = await inspectSystemBinaries();

    const text = [
      `<b>🛡️ Administración, Sistema y Bóveda</b>`,
      ``,
      `🤖 <b>Transporte:</b> ${stateStore.config.telegramMode} · Updates: ${this.updatesProcessed}`,
      `⚡ <b>MTProto FastSocket:</b> ${mt.connected ? '🟢 Conectado' : '🟡 En espera'} (${mt.safeParallelWorkers}w / ${mt.activeSockets} TCP)`,
      `✨ <b>IA Gemini:</b> ${isGeminiConfigured() ? '🟢 Activa' : '⚪ Sin clave'} · <b>RAM:</b> ${Math.round(process.memoryUsage().rss / 1024 ** 2)} MB`,
      `💾 <b>Disco:</b> ${disk.usagePct}% (${fmtGb(disk.budgetRemainingBytes)} libres · presión ${disk.pressureLevel})`,
      `🧰 <b>Binarios:</b> ffmpeg=${bins.ffmpeg.available ? 'OK' : 'NO'} · unzip=${bins.unzip.available ? 'OK' : 'NO'} · tar=${bins.tar.available ? 'OK' : 'NO'}`,
      `👥 <b>Usuarios:</b> ${stateStore.users.length} (${stateStore.userSessions.length} sesiones Picta aisladas)`,
      `🔐 <b>Bóveda:</b> ${vault.snapshotsCount} respaldo(s) · Último: ${vault.lastSyncAt ? vault.lastSyncAt.slice(0, 16).replace('T', ' ') : 'Ninguno'}`,
    ].join('\n');

    await this.showOrEdit(chatId, editMessageId, text, {
      inline_keyboard: [
        [
          { text: '👥 Usuarios y Cuotas', callback_data: 'us:list' },
          { text: '⚙️ Ajustes Globales', callback_data: 'cfg:view' },
        ],
        [
          { text: '☁️ Backup Bóveda', callback_data: 'vt:bak' },
          { text: '♻️ Restaurar Nube', callback_data: 'vt:res' },
        ],
        [
          { text: '⚡ Reconectar MTProto', callback_data: 'ad:mt' },
          { text: '📡 Ver /netlog', callback_data: 'ad:netlog' },
        ],
        [
          { text: '🧹 Purgar Scratch', callback_data: 'cl:purge' },
          { text: '🔁 Barrido Nomad', callback_data: 'al:nomad' },
        ],
        [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
      ],
    });
  }

  private async renderUsersAdminView(chatId: number, editMessageId?: number): Promise<void> {
    const lines = [
      `<b>👥 Gestión de Usuarios y Cuotas (${stateStore.users.length})</b>`,
      `Toca un usuario para editar rol, cuota, bloquear o reiniciar consumo.`,
      ``,
    ];
    const rows: InlineKeyboardButton[][] = [];

    for (const u of stateStore.users.slice(0, 12)) {
      const icon = u.active ? (u.role === 'admin' ? '👑' : u.role === 'operator' ? '🛠️' : '👤') : '🚫';
      lines.push(
        `${icon} <b>${escHtml(u.displayName)}</b> (<code>${u.telegramUserId}</code>) · ${u.role} · ${u.usedTodayGb.toFixed(1)}/${u.dailyQuotaGb} GB`
      );
      rows.push([{ text: `${icon} ${u.displayName.slice(0, 24)} (${u.dailyQuotaGb} GB)`, callback_data: `us:v:${u.telegramUserId}` }]);
    }

    rows.push([
      { text: '➕ Agregar Usuario', callback_data: 'us:add' },
      { text: '⬅️ Admin', callback_data: 'm:adm' },
    ]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderUserDetailAdmin(chatId: number, targetUserId: string, editMessageId?: number): Promise<void> {
    const u = stateStore.users.find((x) => x.telegramUserId === targetUserId);
    if (!u) {
      await this.renderUsersAdminView(chatId, editMessageId);
      return;
    }
    const isMasterTarget = stateStore.isMasterAdmin(u.telegramUserId);
    const text = [
      `<b>👤 Usuario: ${escHtml(u.displayName)}</b> ${isMasterTarget ? '👑 (Maestro)' : ''}`,
      `🆔 Telegram ID: <code>${u.telegramUserId}</code>`,
      `🔐 Estado: <b>${u.active ? '🟢 Activo' : '🚫 Bloqueado'}</b> · Rol: <b>${u.role}</b>`,
      `⚙️ Modo subida: <b>${u.uploadMode === 'fast' ? '⚡ Rápido' : '🧭 Asistente'}</b>`,
      `📊 Cuota hoy: <b>${u.usedTodayGb.toFixed(2)} / ${u.dailyQuotaGb} GB</b> (${u.filesToday}/${u.dailyMaxFiles} archivos)`,
      `📺 Picta vinculado: <b>${u.pictaLinked ? escHtml(u.pictaUsername || 'SÍ') : 'NO'}</b>`,
    ].join('\n');

    const rows: InlineKeyboardButton[][] = [
      [
        { text: `👑 Rol: ${u.role}`, callback_data: `us:rol:${u.telegramUserId}` },
        { text: `📊 Cuota: ${u.dailyQuotaGb} GB`, callback_data: `us:qta:${u.telegramUserId}` },
      ],
      [
        { text: '🔄 Reiniciar consumo hoy', callback_data: `us:rst:${u.telegramUserId}` },
        { text: `⚙️ Modo: ${u.uploadMode}`, callback_data: `us:mod:${u.telegramUserId}` },
      ],
    ];
    if (!isMasterTarget) {
      rows.push([
        { text: u.active ? '🚫 Bloquear acceso' : '✅ Reactivar acceso', callback_data: `us:act:${u.telegramUserId}` },
        { text: '🗑️ Eliminar', callback_data: `us:del:${u.telegramUserId}` },
      ]);
    }
    rows.push([{ text: '⬅️ Lista Usuarios', callback_data: 'us:list' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, text, { inline_keyboard: rows });
  }

  private async renderGlobalConfigView(chatId: number, editMessageId?: number): Promise<void> {
    const c = stateStore.config;
    const q = stateStore.quotaSettings;
    const text = [
      `<b>⚙️ Ajustes Globales del Servidor</b>`,
      ``,
      `• Control de cuotas: <b>${q.enforceQuotas ? '🟢 Activo' : '⚪ Desactivado'}</b>`,
      `• Límite por archivo: <b>${q.maxSingleFileGb} GB</b> · Cuota diaria base: <b>${q.defaultDailyQuotaGb} GB</b>`,
      `• Workers MTProto: <b>${c.mtprotoWorkers}</b> · Disco budget: <b>${c.diskBudgetGb} GB</b>`,
      `• Intervalo de alertas: <b>${Math.round(c.alertsIntervalMs / 60_000)} min</b>`,
      `• Auto-Backup Bóveda: <b>${c.autoVaultSyncEnabled ? '🟢 SÍ' : '⚪ NO'}</b>`,
      `• Cola de subidas: <b>${c.queuePaused ? '⏸️ Pausada' : '▶️ Activa'}</b>`,
    ].join('\n');

    await this.showOrEdit(chatId, editMessageId, text, {
      inline_keyboard: [
        [
          { text: q.enforceQuotas ? '🟢 Cuotas: SÍ' : '⚪ Cuotas: NO', callback_data: 'cfg:qen' },
          { text: `📦 Máx archivo: ${q.maxSingleFileGb} GB`, callback_data: 'cfg:mxf' },
        ],
        [
          { text: `⚡ Workers MTProto: ${c.mtprotoWorkers}`, callback_data: 'cfg:wrk' },
          { text: `🔔 Alertas: ${Math.round(c.alertsIntervalMs / 60_000)}m`, callback_data: 'cfg:alt' },
        ],
        [
          { text: c.autoVaultSyncEnabled ? '🔐 Auto-Bóveda: SÍ' : '🔐 Auto-Bóveda: NO', callback_data: 'cfg:vlt' },
          { text: c.queuePaused ? '▶️ Reanudar Cola' : '⏸️ Pausar Cola', callback_data: 'cfg:pau' },
        ],
        [{ text: '⬅️ Admin', callback_data: 'm:adm' }, { text: '🏠 Menú', callback_data: 'm:home' }],
      ],
    });
  }

  private async showOrEdit(
    chatId: number,
    editMessageId: number | undefined,
    htmlText: string,
    markup?: InlineKeyboardMarkup
  ): Promise<void> {
    if (editMessageId) {
      const ok = await tgEditMessage(chatId, editMessageId, htmlText, markup);
      if (ok) return;
    }
    await tgSendMessage(chatId, htmlText, markup);
  }

  // ===========================================================================
  // PROMO BROADCAST HELPER
  // ===========================================================================

  public async broadcastPublicationToPromos(
    item: { title: string; description?: string; webUrl?: string; coverUrl?: string; channelName?: string },
    onlyAutoEnabled: boolean
  ): Promise<{ sent: number; total: number }> {
    const targets = onlyAutoEnabled
      ? stateStore.promoChannels.filter((p) => p.autoPostEnabled)
      : stateStore.promoChannels;
    if (targets.length === 0) return { sent: 0, total: 0 };

    const caption = [
      `<b>🎬 Nuevo estreno${item.channelName ? ` en ${escHtml(item.channelName)}` : ''}</b>`,
      ``,
      `<b>${escHtml(item.title)}</b>`,
      item.description ? `\n${escHtml(item.description.slice(0, 380))}` : '',
      item.webUrl ? `\n\n🔗 <a href="${escHtml(item.webUrl)}">Ver ahora en Picta</a>` : '',
    ]
      .filter(Boolean)
      .join('');

    const markup: InlineKeyboardMarkup | undefined = item.webUrl
      ? { inline_keyboard: [[{ text: '▶️ Ver en Picta', url: item.webUrl }]] }
      : undefined;

    let sent = 0;
    for (const target of targets) {
      const ok = item.coverUrl
        ? await tgSendPhoto(target.telegramChatId, item.coverUrl, caption, markup)
        : Boolean(await tgSendMessage(target.telegramChatId, caption, markup));
      if (ok) sent += 1;
    }
    return { sent, total: targets.length };
  }

  // ===========================================================================
  // QUEUE WORKER (MTPROTO + BOT API FALLBACK + DIRECT URL + /UNIR)
  // ===========================================================================

  private async enqueueFromWizardDraft(draft: UploadWizardDraft, user: AuthorizedUser): Promise<TransferJob> {
    let ctx: PictaAuthContext | undefined;
    try {
      ctx = await pictaService.resolveContextForUser(user.telegramUserId);
    } catch {
      // Surfaces cleanly in worker
    }

    const now = new Date().toISOString();
    const job: TransferJob = {
      id: crypto.randomUUID(),
      userId: user.telegramUserId,
      userName: user.displayName,
      title: draft.title,
      description: draft.description,
      fileName: draft.fileName,
      source: draft.source,
      sourceUrl: draft.sourceUrl,
      sizeBytes: draft.sizeBytes,
      downloadedBytes: draft.source === 'unir_assembler' ? draft.sizeBytes : 0,
      uploadedBytes: 0,
      progressPct: 0,
      speedMbps: 0,
      status: 'queued',
      nomadRetries: 0,
      maxNomadRetries: 6,
      pictaChannel: ctx?.channelName || pictaService.getDefaultChannelName(),
      pictaChannelId: ctx?.channelId || pictaService.getDefaultChannelId(),
      tipologia: draft.tipologia,
      clasificacion: draft.clasificacion,
      keywords: draft.keywords || undefined,
      year: draft.year,
      publicado: draft.publicado,
      descargable: draft.descargable,
      mostrarComentarios: draft.mostrarComentarios,
      autoPromo: draft.autoPromo,
      serieId: draft.serieId,
      temporada: draft.temporada,
      numero: draft.numero,
      playlistId: draft.playlistId,
      coverUrl: draft.coverUrl,
      posterUrl: draft.posterUrl,
      customCoverPath: draft.customCoverPath,
      telegramChatId: String(draft.chatId),
      telegramMessageId: draft.sourceMessageId,
      telegramFileId: draft.telegramFileId,
      statusMessageId: draft.messageId,
      scratchPath:
        draft.source === 'telegram_mtproto' || draft.source === 'direct_url'
          ? `job_${draft.id}_${draft.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`
          : undefined,
      partCount: draft.unirPartPaths?.length,
      createdAt: now,
      updatedAt: now,
    };

    const sizeGb = draft.sizeBytes / 1024 ** 3;
    user.filesToday += 1;
    user.usedTodayGb = Number((user.usedTodayGb + sizeGb).toFixed(3));
    stateStore.jobs.unshift(job);
    stateStore.saveJobs();
    stateStore.saveUsers();

    if (draft.source === 'unir_assembler' && draft.unirPartPaths) {
      void this.runUnirJobPipeline(job, draft.unirPartPaths);
    } else {
      void this.processNextQueuedJob();
    }
    return job;
  }

  private async updateJobStatusMessage(job: TransferJob, htmlText: string, markup?: InlineKeyboardMarkup): Promise<void> {
    if (!job.telegramChatId) return;
    if (job.statusMessageId) {
      const ok = await tgEditMessage(job.telegramChatId, job.statusMessageId, htmlText, markup);
      if (ok) return;
    }
    const sent = await tgSendMessage(job.telegramChatId, htmlText, markup);
    if (sent) {
      job.statusMessageId = sent;
      stateStore.saveJobs();
    }
  }

  private async processNextQueuedJob(): Promise<void> {
    if (this.queueWorkerBusy || stateStore.config.queuePaused) return;
    const job = [...stateStore.jobs]
      .reverse()
      .find(
        (j) =>
          j.status === 'queued' &&
          ((j.source === 'telegram_mtproto' && j.telegramChatId && (j.telegramMessageId || j.telegramFileId)) ||
            (j.source === 'direct_url' && j.sourceUrl))
      );
    if (!job) return;

    this.queueWorkerBusy = true;
    let lastTgEditAt = 0;
    let downloadedPath = '';

    try {
      const ctx = await pictaService.resolveContextForUser(job.userId);
      job.pictaChannel = ctx.channelName;
      job.pictaChannelId = ctx.channelId;
      job.status = 'downloading';
      job.progressPct = 5;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      const relPath = job.scratchPath || `job_${job.id.slice(0, 8)}_${job.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      job.scratchPath = relPath;

      const onDlProgress = (downloadedBytes: number, totalBytes: number, speedMbps?: number) => {
        job.downloadedBytes = downloadedBytes;
        if (speedMbps) job.speedMbps = speedMbps;
        job.progressPct = Math.min(48, Math.max(5, Math.round((downloadedBytes / Math.max(1, totalBytes)) * 48)));
        job.updatedAt = new Date().toISOString();
        const now = Date.now();
        if (now - lastTgEditAt >= 3500) {
          lastTgEditAt = now;
          void this.updateJobStatusMessage(
            job,
            `⬇️ <b>Descargando</b> (${job.progressPct}% · ${job.speedMbps} MB/s)\n🎞️ ${escHtml(job.title)}\n📦 ${fmtMb(downloadedBytes)} / ${fmtMb(totalBytes)}`
          );
        }
      };

      if (job.source === 'direct_url' && job.sourceUrl) {
        await this.updateJobStatusMessage(
          job,
          `🌐 <b>Descargando desde enlace directo...</b>\n🎞️ ${escHtml(job.title)}\n📺 Canal: ${escHtml(ctx.channelName)}`
        );
        const maxBytes = Math.round(stateStore.quotaSettings.maxSingleFileGb * 1024 ** 3);
        const dl = await downloadDirectUrlToScratch({
          url: job.sourceUrl,
          targetRelativePath: relPath,
          maxBytes,
          onProgress: onDlProgress,
        });
        downloadedPath = dl.filePath;
        job.downloadedBytes = dl.bytesWritten;
        job.sizeBytes = dl.bytesWritten;
        if (dl.detectedFileName && job.fileName === 'video_url.mp4') job.fileName = dl.detectedFileName;
      } else {
        await this.updateJobStatusMessage(
          job,
          `⬇️ <b>Descargando video de Telegram...</b>\n🎞️ ${escHtml(job.title)}\n📦 ${fmtMb(job.sizeBytes)} · Canal: ${escHtml(ctx.channelName)}`
        );

        let dl: { filePath: string; bytesWritten: number; throughputMbps: number } | null = null;
        // Prefer MTProto for >19.5MB or when connected; automatically fall back to Bot API for <=19.5MB!
        if (mtprotoPool.isConfigured() && job.telegramMessageId && job.telegramChatId) {
          try {
            dl = await mtprotoPool.downloadTelegramMessageMedia({
              chatId: job.telegramChatId,
              messageId: job.telegramMessageId,
              expectedBytes: job.sizeBytes,
              targetRelativePath: relPath,
              onProgress: onDlProgress,
            });
          } catch (mtErr) {
            if (job.telegramFileId && job.sizeBytes > 0 && job.sizeBytes <= BOT_API_MAX_DOWNLOAD_BYTES) {
              netlog.warn('telegram', `MTProto falló en archivo <=19.5MB; usando Bot API fallback: ${mtErr instanceof Error ? mtErr.message : String(mtErr)}`);
            } else {
              throw mtErr;
            }
          }
        }
        if (!dl && job.telegramFileId && job.sizeBytes <= BOT_API_MAX_DOWNLOAD_BYTES) {
          dl = await tgDownloadBotFileToScratch(job.telegramFileId, relPath, BOT_API_MAX_DOWNLOAD_BYTES, onDlProgress);
        }
        if (!dl) {
          throw new Error(
            job.sizeBytes > BOT_API_MAX_DOWNLOAD_BYTES
              ? 'Archivo > 20 MB requiere MTProto FastSocket activo (verifica TELEGRAM_API_ID y TELEGRAM_API_HASH).'
              : 'No se pudo descargar el archivo desde Telegram.'
          );
        }
        downloadedPath = dl.filePath;
        job.downloadedBytes = dl.bytesWritten;
      }

      job.status = 'uploading';
      job.progressPct = 50;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      await this.updateJobStatusMessage(
        job,
        `⬆️ <b>Subiendo a Picta S3 MinIO...</b>\n🎞️ ${escHtml(job.title)}\n📺 Canal: ${escHtml(ctx.channelName)}`
      );

      const uploadRes = await pictaService.uploadVideoToPictaPipeline({
        ctx,
        filePath: downloadedPath,
        fileName: job.fileName,
        title: job.title,
        description: job.description,
        tipologia: job.tipologia || 8,
        clasificacion: job.clasificacion,
        keywords: job.keywords,
        year: job.year,
        publicado: job.publicado,
        descargable: job.descargable,
        mostrarComentarios: job.mostrarComentarios,
        serieId: job.serieId,
        temporada: job.temporada,
        numero: job.numero,
        playlistId: job.playlistId,
        coverUrl: job.coverUrl,
        posterUrl: job.posterUrl,
        customCoverPath: job.customCoverPath,
        onUploadProgress: (uploadedBytes, totalBytes, speedMbps) => {
          job.uploadedBytes = uploadedBytes;
          job.speedMbps = speedMbps;
          job.progressPct = Math.min(92, 50 + Math.round((uploadedBytes / Math.max(1, totalBytes)) * 42));
          job.updatedAt = new Date().toISOString();
          const now = Date.now();
          if (now - lastTgEditAt >= 3500) {
            lastTgEditAt = now;
            void this.updateJobStatusMessage(
              job,
              `⬆️ <b>Subiendo a Picta S3</b> (${job.progressPct}% · ${speedMbps} MB/s)\n🎞️ ${escHtml(job.title)}\n📦 ${fmtMb(uploadedBytes)} / ${fmtMb(totalBytes)}`
            );
          }
        },
      });

      job.minioKey = uploadRes.minioKey;
      job.pictaVideoId = uploadRes.publicationId;
      job.pictaWebUrl = uploadRes.webUrl;
      job.status = 'encoding_nomad';
      job.progressPct = 95;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      this.safeRm(downloadedPath);
      if (job.customCoverPath) this.safeRm(job.customCoverPath);

      let promoNote = '';
      if (job.autoPromo && stateStore.promoChannels.some((p) => p.autoPostEnabled)) {
        const pr = await this.broadcastPublicationToPromos(
          {
            title: job.title,
            description: job.description,
            webUrl: uploadRes.webUrl,
            coverUrl: job.coverUrl || job.posterUrl,
            channelName: ctx.channelName,
          },
          true
        );
        if (pr.total > 0) promoNote = `\n📢 Difundido en ${pr.sent}/${pr.total} canal(es) promo.`;
      }

      const doneRows: InlineKeyboardButton[][] = [];
      if (uploadRes.webUrl) doneRows.push([{ text: '🔗 Abrir en Picta', url: uploadRes.webUrl }]);
      if (uploadRes.publicationId) {
        doneRows.push([
          { text: '✏️ Editar ficha', callback_data: `cv:${uploadRes.publicationId}` },
          { text: '📢 Difundir Promo', callback_data: `ce:prm:${uploadRes.publicationId}` },
        ]);
      }

      await this.updateJobStatusMessage(
        job,
        [
          `✅ <b>Subida completada a Picta</b>`,
          `🎞️ <b>${escHtml(job.title)}</b>`,
          `📺 Canal: ${escHtml(ctx.channelName)} · ID: <code>${escHtml(uploadRes.publicationId || 'N/A')}</code>`,
          `⚙️ Nomad: ${uploadRes.nomadTriggered ? 'Iniciado' : 'En cola de reintento 20s'}${promoNote}`,
        ].join('\n'),
        doneRows.length > 0 ? { inline_keyboard: doneRows } : undefined
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.errorMessage = msg;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();
      if (downloadedPath) this.safeRm(downloadedPath);
      if (job.customCoverPath) this.safeRm(job.customCoverPath);
      netlog.error('picta', `Fallo transferencia "${job.title}": ${msg}`);
      await this.updateJobStatusMessage(job, `❌ <b>Error procesando "${escHtml(job.title)}"</b>\n${escHtml(msg)}`, {
        inline_keyboard: [[{ text: '🔁 Reintentar fallidos', callback_data: 'cl:retry' }, { text: '📥 Ver Cola', callback_data: 'm:col' }]],
      });
    } finally {
      this.queueWorkerBusy = false;
    }
  }

  private async runUnirJobPipeline(job: TransferJob, partRelativePaths: string[]): Promise<void> {
    const tempDirsToClean: string[] = [];
    let assembledPath = '';
    let finalVideoPath = '';

    try {
      const ctx = await pictaService.resolveContextForUser(job.userId);
      job.pictaChannel = ctx.channelName;
      job.pictaChannelId = ctx.channelId;
      job.status = 'assembling';
      job.progressPct = 30;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      await this.updateJobStatusMessage(
        job,
        `🧩 <b>Ensamblando /unir en disco persistente...</b>\n🎞️ ${escHtml(job.title)} (${partRelativePaths.length} parte(s))`
      );

      const singlePart = partRelativePaths.length === 1 ? partRelativePaths[0] : '';
      if (singlePart && /\.zip$/i.test(singlePart)) {
        const extractRel = `unir_${job.id.slice(0, 8)}_zip`;
        tempDirsToClean.push(extractRel);
        const extracted = await extractArchiveSafe(singlePart, extractRel, 'zip');
        const firstVideo = extracted.extractedFiles.find((f) => /\.(mp4|mkv|mov|avi|webm)$/i.test(f));
        if (!firstVideo) throw new Error('El archivo ZIP no contiene ningún video soportado.');
        assembledPath = firstVideo;
      } else if (singlePart && /\.(tar|tar\.gz|tgz)$/i.test(singlePart)) {
        const extractRel = `unir_${job.id.slice(0, 8)}_tar`;
        tempDirsToClean.push(extractRel);
        const extracted = await extractArchiveSafe(singlePart, extractRel, 'tar');
        const firstVideo = extracted.extractedFiles.find((f) => /\.(mp4|mkv|mov|avi|webm)$/i.test(f));
        if (!firstVideo) throw new Error('El archivo TAR no contiene ningún video soportado.');
        assembledPath = firstVideo;
      } else {
        const mergedRel = `unir_${job.id.slice(0, 8)}_merged.mp4`;
        const merged = await concatBinaryParts(partRelativePaths, mergedRel);
        assembledPath = resolveConfinedScratchPath(merged.outputRelativePath);
      }

      const bins = await inspectSystemBinaries();
      finalVideoPath = assembledPath;
      if (bins.ffmpeg.available) {
        const remuxRel = `unir_${job.id.slice(0, 8)}_final.mp4`;
        const relIn = path.relative(stateStore.scratchDir, assembledPath);
        if (!relIn.startsWith('..')) {
          finalVideoPath = await remuxSingleVideoFaststart(relIn, remuxRel);
        }
      }

      job.status = 'uploading';
      job.progressPct = 55;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      let lastEdit = 0;
      const uploadRes = await pictaService.uploadVideoToPictaPipeline({
        ctx,
        filePath: finalVideoPath,
        fileName: `${job.title.replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`,
        title: job.title,
        description: job.description,
        tipologia: job.tipologia || 8,
        clasificacion: job.clasificacion,
        keywords: job.keywords,
        year: job.year,
        publicado: job.publicado,
        descargable: job.descargable,
        mostrarComentarios: job.mostrarComentarios,
        serieId: job.serieId,
        temporada: job.temporada,
        numero: job.numero,
        playlistId: job.playlistId,
        coverUrl: job.coverUrl,
        posterUrl: job.posterUrl,
        customCoverPath: job.customCoverPath,
        onUploadProgress: (uploadedBytes, totalBytes, speedMbps) => {
          job.uploadedBytes = uploadedBytes;
          job.speedMbps = speedMbps;
          job.progressPct = Math.min(92, 55 + Math.round((uploadedBytes / Math.max(1, totalBytes)) * 37));
          const now = Date.now();
          if (now - lastEdit >= 3500) {
            lastEdit = now;
            void this.updateJobStatusMessage(
              job,
              `⬆️ <b>Subiendo /unir a Picta S3</b> (${job.progressPct}% · ${speedMbps} MB/s)\n🎞️ ${escHtml(job.title)}`
            );
          }
        },
      });

      job.minioKey = uploadRes.minioKey;
      job.pictaVideoId = uploadRes.publicationId;
      job.pictaWebUrl = uploadRes.webUrl;
      job.status = 'encoding_nomad';
      job.progressPct = 95;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      const doneRows: InlineKeyboardButton[][] = [];
      if (uploadRes.webUrl) doneRows.push([{ text: '🔗 Abrir en Picta', url: uploadRes.webUrl }]);
      if (uploadRes.publicationId) doneRows.push([{ text: '✏️ Editar ficha', callback_data: `cv:${uploadRes.publicationId}` }]);

      await this.updateJobStatusMessage(
        job,
        `✅ <b>Ensamblaje /unir publicado en Picta</b>\n🎞️ <b>${escHtml(job.title)}</b>\n🆔 ID: <code>${escHtml(uploadRes.publicationId || 'N/A')}</code>`,
        doneRows.length > 0 ? { inline_keyboard: doneRows } : undefined
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.errorMessage = msg;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();
      netlog.error('assembler', `Error en /unir "${job.title}": ${msg}`);
      await this.updateJobStatusMessage(job, `❌ <b>Error en /unir "${escHtml(job.title)}"</b>\n${escHtml(msg)}`);
    } finally {
      for (const rel of partRelativePaths) {
        try {
          this.safeRm(resolveConfinedScratchPath(rel));
        } catch {
          // Ignore
        }
      }
      for (const rel of tempDirsToClean) {
        try {
          fs.rmSync(resolveConfinedScratchPath(rel), { recursive: true, force: true });
        } catch {
          // Ignore
        }
      }
      if (assembledPath && assembledPath !== finalVideoPath) this.safeRm(assembledPath);
      if (finalVideoPath) this.safeRm(finalVideoPath);
      if (job.customCoverPath) this.safeRm(job.customCoverPath);
    }
  }

  private safeRm(fullPath: string): void {
    try {
      if (fullPath && fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
    } catch {
      // Ignore
    }
  }

  // ===========================================================================
  // DUAL-MODE UPLOAD ENTRY (WIZARD vs FAST)
  // ===========================================================================

  private async startUploadFlow(params: {
    user: AuthorizedUser;
    chatId: number;
    source: 'telegram_mtproto' | 'unir_assembler' | 'direct_url';
    fileName: string;
    sizeBytes: number;
    caption?: string;
    sourceMessageId?: number;
    telegramFileId?: string;
    sourceUrl?: string;
    unirPartPaths?: string[];
  }): Promise<void> {
    const analyzed = analyzeVideoTitleAndSynopsis(params.fileName, params.caption);
    const yearMatch = `${params.fileName} ${params.caption || ''}`.match(/\b(19\d\d|20\d\d)\b/);
    const draftId = crypto.randomBytes(4).toString('hex');
    const draft: UploadWizardDraft = {
      id: draftId,
      userId: params.user.telegramUserId,
      chatId: params.chatId,
      source: params.source,
      sourceMessageId: params.sourceMessageId,
      telegramFileId: params.telegramFileId,
      sourceUrl: params.sourceUrl,
      unirPartPaths: params.unirPartPaths,
      fileName: params.fileName,
      sizeBytes: params.sizeBytes,
      title: analyzed.initialTitle,
      description: analyzed.initialSynopsis,
      tipologia: analyzed.suggestedTipologia,
      clasificacion: (process.env.PICTA_CLASIFICACION || '+16').trim(),
      keywords: '',
      year: yearMatch?.[1],
      publicado: true,
      descargable: true,
      mostrarComentarios: true,
      autoPromo: stateStore.promoChannels.some((p) => p.autoPostEnabled),
      temporada: analyzed.seriesInfo.temporada,
      numero: analyzed.seriesInfo.numero,
      episodeSubtitle: analyzed.seriesInfo.episodeSubtitle,
      tmdbCandidates: [],
      createdAt: Date.now(),
    };

    if (params.user.uploadMode === 'fast') {
      const statusMsgId = await tgSendMessage(
        params.chatId,
        `⚡ <b>Modo Rápido:</b> analizando metadatos para <i>${escHtml(draft.title)}</i>...`
      );
      if (statusMsgId) draft.messageId = statusMsgId;

      if (!analyzed.filenameIsRandom) {
        const tmdb = await searchTmdbRichCandidates(draft.title);
        if (tmdb.length > 0 && tmdb[0].score >= 70) {
          const best = tmdb[0];
          if (!analyzed.seriesInfo.hasExplicitNumbers) {
            draft.title = best.year ? `${best.title} (${best.year})` : best.title;
          }
          if (!draft.description && best.overview) draft.description = best.overview;
          if (best.year) draft.year = best.year;
          draft.coverUrl = best.backdropUrl || best.posterUrl;
          draft.posterUrl = best.posterUrl;
          draft.tipologia = best.mediaType === 'tv' ? 5 : 1;
        }
        if (!draft.description && isGeminiConfigured()) {
          const aiRes = await enrichMetadataWithGemini({
            title: draft.title,
            mediaType: draft.tipologia === 5 ? 'tv' : draft.tipologia === 1 ? 'movie' : 'video',
            existingOverview: draft.description,
            year: draft.year,
          });
          if (aiRes) {
            if (!analyzed.seriesInfo.hasExplicitNumbers && aiRes.title) draft.title = aiRes.title;
            draft.description = aiRes.synopsis;
            draft.clasificacion = aiRes.clasificacion;
            draft.keywords = aiRes.keywords;
            if (!tmdb.length) draft.tipologia = aiRes.suggestedTipologia;
          }
        }
      }

      await this.enqueueFromWizardDraft(draft, params.user);
      return;
    }

    this.wizardDrafts.set(draftId, draft);
    await this.renderWizardCard(draft);
  }

  private async showTmdbPickerForDraft(draft: UploadWizardDraft, query: string, editMsgId?: number): Promise<void> {
    const candidates = await searchTmdbRichCandidates(query);
    draft.tmdbCandidates = candidates.slice(0, 3);
    if (draft.tmdbCandidates.length === 0) {
      await tgSendMessage(draft.chatId, `Sin resultados en TMDB para "<b>${escHtml(query)}</b>" (o falta TMDB_API_KEY).`, {
        inline_keyboard: [[{ text: '🔎 Probar otra búsqueda', callback_data: `w:tmdbq:${draft.id}` }, { text: '⬅️ Volver', callback_data: `w:back:${draft.id}` }]],
      });
      return;
    }
    const lines = [
      `<b>🎬 Top-3 resultados TMDB para "${escHtml(query)}"</b>`,
      ``,
      ...draft.tmdbCandidates.map(
        (c, i) =>
          `${i + 1}. <b>${escHtml(c.title)}</b> (${c.year || 'S/F'}) · ${c.mediaType === 'tv' ? 'Serie' : 'Película'} ★${c.voteAverage ?? '-'}\n   <i>${escHtml(c.overview.slice(0, 140))}</i>`
      ),
    ];
    const rows: InlineKeyboardButton[][] = draft.tmdbCandidates.map((c, i) => [
      { text: `✅ ${i + 1}. ${c.title.slice(0, 32)} (${c.year || 'S/F'})`, callback_data: `w:tm:${draft.id}:${i}` },
    ]);
    rows.push([
      { text: '🔎 Otra búsqueda', callback_data: `w:tmdbq:${draft.id}` },
      { text: '⬅️ Volver', callback_data: `w:back:${draft.id}` },
    ]);
    await this.showOrEdit(draft.chatId, editMsgId || draft.messageId, lines.join('\n'), { inline_keyboard: rows });
  }

  // ===========================================================================
  // PENDING TEXT / PHOTO INPUT HANDLER
  // ===========================================================================

  private async handlePendingInput(
    pending: PendingInputState,
    msg: TelegramMessage,
    user: AuthorizedUser
  ): Promise<boolean> {
    const userId = user.telegramUserId;
    const chatId = msg.chat.id;
    const text = (msg.text || msg.caption || '').trim();

    if (text === '/cancelar' || text === '/cancel') {
      this.pendingInputs.delete(userId);
      await tgSendMessage(chatId, '✅ Operación cancelada.');
      return true;
    }

    if (pending.kind === 'login_user') {
      if (!text) {
        await tgSendMessage(chatId, 'Envía tu usuario o teléfono de Picta (8 dígitos o +53...), o /cancelar.');
        return true;
      }
      this.pendingInputs.set(userId, {
        kind: 'login_pass',
        chatId,
        username: text,
        expiresAt: Date.now() + 5 * 60_000,
      });
      await tgSendMessage(
        chatId,
        `🔐 Ahora envía tu <b>contraseña de Picta</b>.\n<i>(Borraré tu mensaje al instante por seguridad)</i>`
      );
      return true;
    }

    if (pending.kind === 'login_pass') {
      void tgDeleteMessage(chatId, msg.message_id);
      this.pendingInputs.delete(userId);

      if (!text) {
        await tgSendMessage(chatId, 'Contraseña vacía. Inicia de nuevo con /login.');
        return true;
      }
      const waitMsg = await tgSendMessage(chatId, '🔄 Verificando credenciales en Picta...');
      try {
        const res = await pictaService.authenticateAndInspectAccount(pending.username, text);
        const encryptedPassword = stateStore.encryptUserSecret(text);
        const primaryChannel = res.ownedChannels[0];
        const now = new Date().toISOString();

        const existingIdx = stateStore.userSessions.findIndex((s) => s.telegramUserId === userId);
        const sessionObj = {
          telegramUserId: userId,
          pictaUsername: pending.username,
          encryptedPassword,
          defaultChannel: primaryChannel?.nombre || 'Mi Canal',
          channelId: primaryChannel ? String(primaryChannel.id) : '',
          channelName: primaryChannel?.nombre || 'Sin canal',
          pictaUserId: res.pictaUserId,
          availableChannels: res.ownedChannels,
          connectedAt: now,
          lastVerifiedAt: now,
          notifyComments: true,
          notifyMilestones: true,
        };
        if (existingIdx >= 0) stateStore.userSessions[existingIdx] = sessionObj;
        else stateStore.userSessions.push(sessionObj);

        user.pictaLinked = true;
        user.pictaUsername = pending.username;
        pictaService.invalidateUserToken(userId);
        stateStore.saveUserSessions();
        stateStore.saveUsers();

        await this.renderAccountView(chatId, userId, waitMsg || undefined);
      } catch (err) {
        await this.showOrEdit(
          chatId,
          waitMsg || undefined,
          `❌ Error iniciando sesión en Picta: ${escHtml(err instanceof Error ? err.message : String(err))}`
        );
      }
      return true;
    }

    if (pending.kind === 'wiz_title') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft && text) {
        draft.title = text.slice(0, 140);
        await this.renderWizardCard(draft);
      }
      return true;
    }

    if (pending.kind === 'wiz_desc') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft && text) {
        draft.description = text.slice(0, 1500);
        await this.renderWizardCard(draft);
      }
      return true;
    }

    if (pending.kind === 'wiz_tags') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft) {
        draft.keywords = text === '-' ? '' : text.slice(0, 180);
        await this.renderWizardCard(draft);
      }
      return true;
    }

    if (pending.kind === 'wiz_year') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft) {
        const y = text.match(/\b(19\d\d|20\d\d)\b/)?.[1];
        if (y) draft.year = y;
        await this.renderWizardCard(draft);
      }
      return true;
    }

    if (pending.kind === 'wiz_epnum') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft && text) {
        const nums = text.match(/\d+/g);
        if (nums && nums.length >= 2) {
          draft.temporada = String(Number(nums[0]));
          draft.numero = String(Number(nums[1]));
        } else if (nums && nums.length === 1) {
          draft.numero = String(Number(nums[0]));
        }
        if (draft.serieName) {
          draft.title = buildSerieTitleOptions(draft.serieName, draft.temporada, draft.numero, draft.episodeSubtitle)[0];
        }
        await this.renderWizardCard(draft);
      }
      return true;
    }

    if (pending.kind === 'wiz_tmdb_q') {
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft && text) {
        await this.showTmdbPickerForDraft(draft, text);
      }
      return true;
    }

    if (pending.kind === 'wiz_cover') {
      const largestPhoto = msg.photo?.[msg.photo.length - 1];
      if (!largestPhoto) {
        await tgSendMessage(chatId, 'Envía una imagen como foto para usar de portada, o escribe /cancelar.');
        return true;
      }
      this.pendingInputs.delete(userId);
      const draft = this.wizardDrafts.get(pending.draftId);
      if (draft) {
        const saved = await tgDownloadSmallFileToScratch(largestPhoto.file_id, `cover_${draft.id}.jpg`);
        if (saved) {
          draft.customCoverPath = saved;
          await this.renderWizardCard(draft);
        } else {
          await tgSendMessage(chatId, '❌ No se pudo descargar la foto de portada.');
        }
      }
      return true;
    }

    if (pending.kind === 'cat_search') {
      this.pendingInputs.delete(userId);
      await this.renderCatalogPage(chatId, userId, 1, text);
      return true;
    }

    if (pending.kind === 'cat_title' || pending.kind === 'cat_desc') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        await pictaService.patchPublication(
          ctx,
          pending.videoId,
          pending.kind === 'cat_title' ? { nombre: text.slice(0, 140) } : { descripcion: text.slice(0, 1500) }
        );
        await tgSendMessage(chatId, '✅ Publicación actualizada en Picta.');
        await this.renderCatalogDetail(chatId, userId, pending.videoId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ Error editando: ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'cat_cover') {
      const largestPhoto = msg.photo?.[msg.photo.length - 1];
      if (!largestPhoto) {
        await tgSendMessage(chatId, 'Envía una foto para actualizar la portada, o escribe /cancelar.');
        return true;
      }
      this.pendingInputs.delete(userId);
      const rel = `catcov_${pending.videoId}_${Date.now()}.jpg`;
      const saved = await tgDownloadSmallFileToScratch(largestPhoto.file_id, rel);
      if (!saved) {
        await tgSendMessage(chatId, '❌ No se pudo descargar la imagen.');
        return true;
      }
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const buf = fs.readFileSync(saved);
        await pictaService.patchPublication(ctx, pending.videoId, { coverBuffer: buf });
        await tgSendMessage(chatId, '✅ Portada actualizada en Picta.');
        await this.renderCatalogDetail(chatId, userId, pending.videoId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ Error cambiando portada: ${escHtml(err instanceof Error ? err.message : String(err))}`);
      } finally {
        this.safeRm(saved);
      }
      return true;
    }

    if (pending.kind === 'ser_new') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        // Auto-enrich new series with TMDB synopsis & HD cover when available!
        let desc = text.slice(0, 100);
        let coverBuf: Buffer | undefined;
        const tmdb = await searchTmdbRichCandidates(text);
        const bestTv = tmdb.find((c) => c.mediaType === 'tv') || tmdb[0];
        if (bestTv && bestTv.score >= 65) {
          if (bestTv.overview) desc = bestTv.overview.slice(0, 1000);
          const imgUrl = bestTv.backdropUrl || bestTv.posterUrl;
          if (imgUrl) coverBuf = (await fetchSafeImageBuffer(imgUrl)) || undefined;
        }
        const created = await pictaService.createSerie(ctx, { nombre: text.slice(0, 100), descripcion: desc, coverBuffer: coverBuf });
        if (pending.attachDraftId) {
          const draft = this.wizardDrafts.get(pending.attachDraftId);
          if (draft) {
            draft.tipologia = 5;
            draft.serieId = created.id;
            draft.serieName = created.nombre;
            await this.renderWizardCard(draft);
            return true;
          }
        }
        await tgSendMessage(
          chatId,
          `✅ Serie creada: <b>${escHtml(created.nombre)}</b> (#${created.id})${coverBuf ? ' con carátula TMDB HD' : ''}.`
        );
        await this.renderSerieDetailView(chatId, userId, created.id);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'ser_name' || pending.kind === 'ser_desc') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        await pictaService.patchSerie(
          ctx,
          pending.serieId,
          pending.kind === 'ser_name' ? { nombre: text.slice(0, 100) } : { descripcion: text.slice(0, 1200) }
        );
        await tgSendMessage(chatId, '✅ Serie actualizada en Picta.');
        await this.renderSerieDetailView(chatId, userId, pending.serieId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'ser_cover') {
      const largestPhoto = msg.photo?.[msg.photo.length - 1];
      if (!largestPhoto) {
        await tgSendMessage(chatId, 'Envía una foto para la portada de la serie, o escribe /cancelar.');
        return true;
      }
      this.pendingInputs.delete(userId);
      const saved = await tgDownloadSmallFileToScratch(largestPhoto.file_id, `sercov_${pending.serieId}_${Date.now()}.jpg`);
      if (!saved) {
        await tgSendMessage(chatId, '❌ No se pudo descargar la foto.');
        return true;
      }
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        await pictaService.patchSerie(ctx, pending.serieId, { coverBuffer: fs.readFileSync(saved) });
        await tgSendMessage(chatId, '✅ Portada de la serie actualizada.');
        await this.renderSerieDetailView(chatId, userId, pending.serieId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      } finally {
        this.safeRm(saved);
      }
      return true;
    }

    if (pending.kind === 'lis_new') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const created = await pictaService.createPlaylist(ctx, text.slice(0, 100));
        await tgSendMessage(chatId, `✅ Lista creada: <b>${escHtml(created.nombre)}</b>`);
        await this.renderPlaylistDetailView(chatId, userId, created.id);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'lis_name') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        await pictaService.patchPlaylist(ctx, pending.playlistId, { nombre: text.slice(0, 100) });
        await tgSendMessage(chatId, '✅ Nombre de lista actualizado.');
        await this.renderPlaylistDetailView(chatId, userId, pending.playlistId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'ch_name' || pending.kind === 'ch_desc') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        await pictaService.patchChannel(
          ctx,
          pending.kind === 'ch_name' ? { nombre: text.slice(0, 100) } : { descripcion: text.slice(0, 1200) }
        );
        await tgSendMessage(chatId, '✅ Perfil del canal actualizado en Picta.');
        await this.renderChannelProfileView(chatId, userId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'ch_avatar' || pending.kind === 'ch_banner') {
      const largestPhoto = msg.photo?.[msg.photo.length - 1];
      if (!largestPhoto) {
        await tgSendMessage(chatId, 'Envía una imagen como foto, o escribe /cancelar.');
        return true;
      }
      this.pendingInputs.delete(userId);
      const saved = await tgDownloadSmallFileToScratch(largestPhoto.file_id, `chimg_${Date.now()}.jpg`);
      if (!saved) {
        await tgSendMessage(chatId, '❌ No se pudo descargar la foto.');
        return true;
      }
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const buf = fs.readFileSync(saved);
        await pictaService.patchChannel(ctx, pending.kind === 'ch_avatar' ? { avatarBuffer: buf } : { bannerBuffer: buf });
        await tgSendMessage(chatId, pending.kind === 'ch_avatar' ? '✅ Avatar actualizado.' : '✅ Banner actualizado.');
        await this.renderChannelProfileView(chatId, userId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      } finally {
        this.safeRm(saved);
      }
      return true;
    }

    if (pending.kind === 'com_reply') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const ok = await pictaService.replyToComment(ctx, {
          publicacionId: pending.pubId,
          parentCommentId: pending.commentId,
          texto: text.slice(0, 800),
        });
        await tgSendMessage(chatId, ok ? '✅ Respuesta publicada en Picta.' : '❌ Picta rechazó la respuesta.');
        await this.renderCommentsView(chatId, userId, 'u', 0, true);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return true;
    }

    if (pending.kind === 'promo_add') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      const parts = text.split(/\s+/);
      const targetChat = parts[0];
      const name = parts.slice(1).join(' ').trim() || targetChat;
      stateStore.promoChannels.push({
        id: crypto.randomUUID(),
        name: name.slice(0, 60),
        telegramChatId: targetChat,
        autoPostEnabled: true,
        createdAt: new Date().toISOString(),
      });
      stateStore.savePromoChannels();
      await this.renderPromosView(chatId);
      return true;
    }

    if (pending.kind === 'promo_cast') {
      this.pendingInputs.delete(userId);
      const targets = stateStore.promoChannels;
      if (targets.length === 0) {
        await tgSendMessage(chatId, '⚠️ No hay canales promocionales configurados.');
        return true;
      }
      const largestPhoto = msg.photo?.[msg.photo.length - 1];
      let photoBuf: Buffer | null = null;
      let tempPath: string | null = null;
      if (largestPhoto) {
        tempPath = await tgDownloadSmallFileToScratch(largestPhoto.file_id, `pcast_${Date.now()}.jpg`);
        if (tempPath) photoBuf = fs.readFileSync(tempPath);
      }
      let sent = 0;
      for (const t of targets) {
        const ok = photoBuf
          ? await tgSendPhoto(t.telegramChatId, photoBuf, escHtml(text || '📢 Nuevo anuncio'))
          : Boolean(await tgSendMessage(t.telegramChatId, escHtml(text)));
        if (ok) sent += 1;
      }
      if (tempPath) this.safeRm(tempPath);
      await tgSendMessage(chatId, `📣 Anuncio enviado a <b>${sent}/${targets.length}</b> canal(es) promocional(es).`);
      return true;
    }

    if (pending.kind === 'req_add') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      stateStore.channelRequests.unshift({
        id: crypto.randomUUID(),
        requesterName: user.displayName,
        requestedTitle: text.slice(0, 90),
        rawText: text.slice(0, 260),
        sourceVideoTitle: 'Agregada manualmente',
        status: 'pending',
        createdAt: new Date().toISOString(),
      });
      stateStore.saveChannelRequests();
      await this.renderRequestsView(chatId, 0);
      return true;
    }

    if (pending.kind === 'tmdb_search') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      await this.handleTmdbLookupMessage(chatId, text);
      return true;
    }

    if (pending.kind === 'ai_ask') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      await this.handleDirectAiQuery(chatId, userId, text);
      return true;
    }

    if (pending.kind === 'url_upload') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      await this.handleDirectUrlRequest(chatId, user, text);
      return true;
    }

    if (pending.kind === 'unir_start') {
      this.pendingInputs.delete(userId);
      const title = text || `Ensamblaje ${new Date().toISOString().slice(11, 19)}`;
      this.openUnirSession(chatId, userId, title);
      await tgSendMessage(
        chatId,
        `🧩 <b>Sesión /unir abierta:</b> ${escHtml(title)}\nEnvía ahora las partes (.001/.002, .zip o .tar). Cuando termines toca el botón o escribe /unir_fin.`,
        { inline_keyboard: [[{ text: '❌ Cancelar /unir', callback_data: 'un:can' }]] }
      );
      return true;
    }

    if (pending.kind === 'add_user') {
      this.pendingInputs.delete(userId);
      if (!text) return true;
      await this.handleAddUserArgs(chatId, text.split(/\s+/));
      return true;
    }

    return false;
  }

  private openUnirSession(chatId: number, userId: string, title: string): void {
    this.activeUnirSessions.set(userId, {
      id: crypto.randomBytes(4).toString('hex'),
      chatId,
      userId,
      title,
      partRelativePaths: [],
      totalBytes: 0,
      createdAt: Date.now(),
    });
  }

  private async handleTmdbLookupMessage(chatId: number, query: string): Promise<void> {
    const results = await searchTmdbRichCandidates(query);
    if (results.length === 0) {
      await tgSendMessage(chatId, `Sin resultados en TMDB para "<b>${escHtml(query)}</b>" (o falta TMDB_API_KEY).`);
      return;
    }
    const lines = results.slice(0, 5).map(
      (r, i) =>
        `${i + 1}. <b>${escHtml(r.title)}</b> (${r.year || 'S/F'}) · ${r.mediaType === 'tv' ? 'Serie' : 'Película'} ★${r.voteAverage ?? '-'}\n   <i>${escHtml(r.overview.slice(0, 160))}</i>`
    );
    await tgSendMessage(chatId, `<b>🎬 Resultados TMDB para "${escHtml(query)}"</b>\n\n${lines.join('\n\n')}`, {
      inline_keyboard: [[{ text: '🔍 Otra búsqueda TMDB', callback_data: 'm:tmdb' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
    });
  }

  private async handleDirectAiQuery(chatId: number, userId: string, prompt: string): Promise<void> {
    const waitId = await tgSendMessage(chatId, '✨ Consultando Gemini IA...');
    let channelName: string | undefined;
    try {
      const ctx = await pictaService.resolveContextForUser(userId);
      channelName = ctx.channelName;
    } catch {
      channelName = pictaService.getDefaultChannelName();
    }
    const answer = await askGeminiAssistant(prompt, channelName);
    if (!answer) {
      const reason = getLastGeminiError() || 'verifica GEMINI_API_KEY en .env o variables del servidor.';
      await this.showOrEdit(chatId, waitId || undefined, `⚠️ <b>Gemini IA no disponible:</b> ${escHtml(reason)}`);
      return;
    }
    await this.showOrEdit(chatId, waitId || undefined, `<b>✨ Respuesta Gemini IA</b>\n\n${escHtml(answer)}`, {
      inline_keyboard: [[{ text: '✨ Nueva consulta IA', callback_data: 'm:ai' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
    });
  }

  private async handleDirectUrlRequest(chatId: number, user: AuthorizedUser, rawInput: string): Promise<void> {
    const tokens = rawInput.trim().split(/\s+/);
    const urlStr = tokens[0] || '';
    const customTitle = tokens.slice(1).join(' ').trim();
    try {
      const parsed = new URL(urlStr);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') throw new Error('Protocolo no soportado');
      const fileName = decodeURIComponent(parsed.pathname.split('/').pop() || 'video_url.mp4') || 'video_url.mp4';
      await this.startUploadFlow({
        user,
        chatId,
        source: 'direct_url',
        sourceUrl: urlStr,
        fileName: fileName.includes('.') ? fileName : `${fileName}.mp4`,
        sizeBytes: 0,
        caption: customTitle || undefined,
      });
    } catch {
      await tgSendMessage(chatId, '❌ Enlace inválido. Uso: <code>/url https://servidor.com/video.mp4 [Título opcional]</code>');
    }
  }

  private async handleAddUserArgs(chatId: number, args: string[]): Promise<void> {
    const targetId = args[0] || '';
    const displayName = args[1] || '';
    const roleArg = (args[2] || 'user').toLowerCase();
    const quotaGb = Math.max(1, Math.min(200, Number(args[3] || stateStore.quotaSettings.defaultDailyQuotaGb)));
    if (!/^\d{4,20}$/.test(targetId) || !displayName) {
      await tgSendMessage(chatId, 'Uso: <code>&lt;telegramId&gt; &lt;nombre&gt; [user|operator|admin] [gb]</code>');
      return;
    }
    const role: UserRole = roleArg === 'admin' || roleArg === 'operator' ? roleArg : 'user';
    const existing = stateStore.users.find((u) => u.telegramUserId === targetId);
    const now = new Date().toISOString();
    if (existing) {
      existing.active = true;
      existing.displayName = displayName;
      existing.role = role;
      existing.dailyQuotaGb = quotaGb;
    } else {
      stateStore.users.push({
        telegramUserId: targetId,
        username: `user_${targetId.slice(-4)}`,
        displayName,
        role,
        active: true,
        uploadMode: 'wizard',
        dailyQuotaGb: quotaGb,
        dailyMaxFiles: stateStore.quotaSettings.defaultDailyMaxFiles,
        usedTodayGb: 0,
        filesToday: 0,
        pictaLinked: false,
        alertsEnabled: true,
        createdAt: now,
        lastActiveAt: now,
      });
    }
    stateStore.saveUsers();
    await tgSendMessage(chatId, `✅ Usuario autorizado: <b>${escHtml(displayName)}</b> (<code>${targetId}</code> · ${role} · ${quotaGb} GB/día).`);
    await this.renderUsersAdminView(chatId);
  }

  // ===========================================================================
  // CALLBACK QUERY ROUTER
  // ===========================================================================

  private async handleCallbackQuery(cq: TelegramCallbackQuery): Promise<void> {
    const userId = String(cq.from.id);
    const chatId = cq.message?.chat.id || cq.from.id;
    const msgId = cq.message?.message_id;
    const data = (cq.data || '').trim();

    const user = stateStore.users.find((u) => u.telegramUserId === userId && u.active);
    if (!user) {
      await tgAnswerCallback(cq.id, 'Acceso no autorizado.', true);
      return;
    }
    user.lastActiveAt = new Date().toISOString();

    const parts = data.split(':');
    const prefix = parts[0];

    try {
      // Main navigation
      if (data === 'm:home') {
        await tgAnswerCallback(cq.id);
        await this.renderMainMenu(chatId, user, msgId);
        return;
      }
      if (data === 'm:help') {
        await tgAnswerCallback(cq.id);
        await this.renderHelpView(chatId, msgId);
        return;
      }
      if (data === 'm:tools') {
        await tgAnswerCallback(cq.id);
        await this.renderToolsHub(chatId, userId, msgId);
        return;
      }
      if (data === 'm:chan') {
        await tgAnswerCallback(cq.id);
        await this.renderChannelProfileView(chatId, userId, msgId);
        return;
      }
      if (prefix === 'm' && parts[1] === 'top') {
        await tgAnswerCallback(cq.id);
        const metric = (['v', 'l', 'c', 'd'].includes(parts[2]) ? parts[2] : 'v') as 'v' | 'l' | 'c' | 'd';
        await this.renderTopVideosView(chatId, userId, metric, msgId);
        return;
      }
      if (data === 'm:tmdb') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'tmdb_search', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🔍 Escribe el título de la película o serie a buscar en TMDB (o /cancelar):');
        return;
      }
      if (data === 'm:ai') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'ai_ask', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(
          chatId,
          '✨ Escribe tu consulta para <b>Gemini IA</b> (sinopsis, títulos llamativos, texto de promo, hashtags, etc. — o /cancelar):'
        );
        return;
      }
      if (data === 'm:ale') {
        await tgAnswerCallback(cq.id);
        await this.renderAlertsView(chatId, user, msgId);
        return;
      }
      if (data === 'm:mode') {
        user.uploadMode = user.uploadMode === 'fast' ? 'wizard' : 'fast';
        stateStore.saveUsers();
        await tgAnswerCallback(cq.id, user.uploadMode === 'fast' ? '⚡ Modo Rápido activado' : '🧭 Modo Asistente activado');
        await this.renderMainMenu(chatId, user, msgId);
        return;
      }

      // Tools (/unir & /url)
      if (data === 'un:new') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'unir_start', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🧩 Escribe el título para la nueva sesión /unir (o /cancelar):');
        return;
      }
      if (data === 'un:can') {
        const session = this.activeUnirSessions.get(userId);
        if (session) {
          for (const rel of session.partRelativePaths) {
            try {
              this.safeRm(resolveConfinedScratchPath(rel));
            } catch {
              // Ignore
            }
          }
          this.activeUnirSessions.delete(userId);
        }
        await tgAnswerCallback(cq.id, 'Sesión /unir cancelada');
        await this.renderToolsHub(chatId, userId, msgId);
        return;
      }
      if (data === 'un:fin') {
        const session = this.activeUnirSessions.get(userId);
        if (!session || session.partRelativePaths.length === 0) {
          await tgAnswerCallback(cq.id, 'Aún no has enviado partes.', true);
          return;
        }
        this.activeUnirSessions.delete(userId);
        await tgAnswerCallback(cq.id, '🧩 Preparando ensamblaje...');
        await this.startUploadFlow({
          user,
          chatId,
          source: 'unir_assembler',
          fileName: `${session.title}.mp4`,
          sizeBytes: session.totalBytes,
          caption: session.title,
          unirPartPaths: session.partRelativePaths,
        });
        return;
      }
      if (data === 'tl:url') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'url_upload', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🔗 Envía el enlace directo HTTP/HTTPS del video seguido opcionalmente del título (o /cancelar):');
        return;
      }

      // Catalog browsing, filtering & detail
      if (prefix === 'm' && parts[1] === 'cat') {
        await tgAnswerCallback(cq.id);
        await this.renderCatalogPage(chatId, userId, Number(parts[2] || 1), undefined, msgId);
        return;
      }
      if (data === 'cf:vis') {
        const filter = this.getCatalogFilter(userId);
        const cycle: Array<CatalogViewFilter['visibility']> = ['all', 'published', 'hidden'];
        filter.visibility = cycle[(cycle.indexOf(filter.visibility) + 1) % cycle.length];
        this.catalogFilters.set(userId, filter);
        await tgAnswerCallback(cq.id, `Filtro: ${filter.visibility}`);
        await this.renderCatalogPage(chatId, userId, 1, undefined, msgId);
        return;
      }
      if (data === 'cf:ord') {
        const filter = this.getCatalogFilter(userId);
        const cycle: Array<CatalogViewFilter['ordering']> = [
          '-fecha_creacion',
          '-cantidad_vistas',
          '-cantidad_me_gusta',
          '-cantidad_comentarios',
        ];
        filter.ordering = cycle[(cycle.indexOf(filter.ordering) + 1) % cycle.length];
        this.catalogFilters.set(userId, filter);
        await tgAnswerCallback(cq.id, 'Orden actualizado');
        await this.renderCatalogPage(chatId, userId, 1, undefined, msgId);
        return;
      }
      if (data === 'cf:clr') {
        await tgAnswerCallback(cq.id, 'Búsqueda limpiada');
        await this.renderCatalogPage(chatId, userId, 1, null, msgId);
        return;
      }
      if (data === 'm:catsearch') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'cat_search', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🔍 Escribe el título que deseas buscar en tu catálogo (o /cancelar):');
        return;
      }
      if (prefix === 'cv') {
        await tgAnswerCallback(cq.id);
        await this.renderCatalogDetail(chatId, userId, parts[1], msgId);
        return;
      }
      if (prefix === 'cvc') {
        await tgAnswerCallback(cq.id, 'Cargando comentarios del video...');
        await this.renderCommentsView(chatId, userId, 'a', 0, true, msgId, Number(parts[1]));
        return;
      }

      // Catalog editing actions
      if (prefix === 'ce') {
        const action = parts[1];
        const vid = parts[2];
        if (action === 't') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'cat_title', videoId: vid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '✏️ Envía el nuevo título para la publicación (o /cancelar):');
          return;
        }
        if (action === 'd') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'cat_desc', videoId: vid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📝 Envía la nueva sinopsis (o /cancelar):');
          return;
        }
        if (action === 'cov') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'cat_cover', videoId: vid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🖼️ Envía ahora la foto para la nueva portada (o /cancelar):');
          return;
        }
        if (action === 'tip') {
          await tgAnswerCallback(cq.id);
          const entries = Object.entries(PICTA_TIPOLOGIAS);
          const rows: InlineKeyboardButton[][] = [];
          for (let i = 0; i < entries.length; i += 2) {
            rows.push(entries.slice(i, i + 2).map(([k, v]) => ({ text: v, callback_data: `ce:st:${vid}:${k}` })));
          }
          rows.push([{ text: '⬅️ Volver', callback_data: `cv:${vid}` }]);
          await this.showOrEdit(chatId, msgId, '<b>📂 Elige la nueva Tipología:</b>', { inline_keyboard: rows });
          return;
        }
        if (action === 'st') {
          await tgAnswerCallback(cq.id, 'Actualizando tipología...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.patchPublication(ctx, vid, { tipologia: Number(parts[3] || 8) });
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'cla') {
          await tgAnswerCallback(cq.id);
          await this.showOrEdit(chatId, msgId, '<b>🔞 Selecciona la clasificación de edad:</b>', {
            inline_keyboard: [
              CLASIFICACIONES.map((cl) => ({ text: cl, callback_data: `ce:sc:${vid}:${cl}` })),
              [{ text: '⬅️ Volver', callback_data: `cv:${vid}` }],
            ],
          });
          return;
        }
        if (action === 'sc') {
          await tgAnswerCallback(cq.id, 'Actualizando clasificación...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.patchPublication(ctx, vid, { clasificacion: parts[3] || '+16' });
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'ser') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const series = await pictaService.fetchChannelSeries(ctx);
          const rows: InlineKeyboardButton[][] = series.slice(0, 10).map((s) => [
            { text: `${s.pinned ? '📌 ' : ''}${s.nombre.slice(0, 34)} (${s.cantidad_capitulos} cap)`, callback_data: `ce:ss:${vid}:${s.id}` },
          ]);
          rows.push([{ text: '⬅️ Volver', callback_data: `cv:${vid}` }]);
          await this.showOrEdit(chatId, msgId, '<b>📺 Elige la Serie a la que deseas mover este video:</b>', { inline_keyboard: rows });
          return;
        }
        if (action === 'ss') {
          await tgAnswerCallback(cq.id, 'Vinculando a la serie...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.patchPublication(ctx, vid, { tipologia: 5, serie: Number(parts[3]), temporada: '1', numero: '1' });
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'lis') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const lists = await pictaService.fetchChannelPlaylists(ctx);
          const rows: InlineKeyboardButton[][] = lists.slice(0, 10).map((l) => [
            { text: `📋 ${l.nombre.slice(0, 34)} (${l.publicacionesIds.length})`, callback_data: `ce:sl:${vid}:${l.id}` },
          ]);
          rows.push([{ text: '⬅️ Volver', callback_data: `cv:${vid}` }]);
          await this.showOrEdit(chatId, msgId, '<b>📋 Elige la Lista de Reproducción:</b>', { inline_keyboard: rows });
          return;
        }
        if (action === 'sl') {
          await tgAnswerCallback(cq.id, 'Añadiendo a la lista...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.addVideoToPlaylist(ctx, Number(parts[3]), Number(vid));
          await tgSendMessage(chatId, '✅ Video añadido a la lista de reproducción.');
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'card') {
          await tgAnswerCallback(cq.id, 'Generando ficha...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          const cap = [
            `<b>🎬 ${escHtml(item.nombre)}</b>`,
            `📺 ${escHtml(ctx.channelName)} · ${escHtml(item.tipologiaNombre)} · ${escHtml(item.clasificacion)}`,
            `👁 ${fmtNum(item.cantidad_vistas)} · ❤️ ${fmtNum(item.cantidad_me_gusta)} · 💬 ${item.cantidad_comentarios}`,
            item.descripcion ? `\n${escHtml(item.descripcion.slice(0, 420))}` : '',
            `\n🔗 ${escHtml(item.webUrl)}`,
          ]
            .filter(Boolean)
            .join('\n');
          const btn: InlineKeyboardMarkup = { inline_keyboard: [[{ text: '▶️ Ver en Picta', url: item.webUrl }]] };
          if (item.url_imagen) await tgSendPhoto(chatId, item.url_imagen, cap, btn);
          else await tgSendMessage(chatId, cap, btn);
          return;
        }
        if (action === 'ai') {
          await tgAnswerCallback(cq.id, '✨ Pulido con Gemini IA...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          const aiRes = await enrichMetadataWithGemini({ title: item.nombre, existingOverview: item.descripcion });
          if (!aiRes) {
            const reason = getLastGeminiError() || 'verifica GEMINI_API_KEY en .env o variables del servidor.';
            await tgSendMessage(chatId, `⚠️ <b>Gemini IA no disponible:</b> ${escHtml(reason)}`);
            return;
          }
          await pictaService.patchPublication(ctx, vid, {
            nombre: aiRes.title,
            descripcion: aiRes.synopsis,
            clasificacion: aiRes.clasificacion,
          });
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'tmdb') {
          await tgAnswerCallback(cq.id, '🎬 Buscando en TMDB...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          const matches = (await searchTmdbRichCandidates(item.nombre)).slice(0, 3);
          if (matches.length === 0) {
            await tgSendMessage(chatId, `Sin resultados en TMDB para "${escHtml(item.nombre)}".`);
            return;
          }
          this.catalogTmdbCache.set(`${userId}:${vid}`, { items: matches, expiresAt: Date.now() + 10 * 60_000 });
          const lines = [
            `<b>🎬 TMDB Top-3 para "${escHtml(item.nombre)}"</b>`,
            `<i>Al elegir se actualizará título, sinopsis y portada HD en Picta:</i>`,
            ``,
            ...matches.map(
              (c, i) =>
                `${i + 1}. <b>${escHtml(c.title)}</b> (${c.year || 'S/F'}) ★${c.voteAverage ?? '-'}\n   <i>${escHtml(c.overview.slice(0, 120))}</i>`
            ),
          ];
          const rows: InlineKeyboardButton[][] = matches.map((c, i) => [
            { text: `✅ ${i + 1}. ${c.title.slice(0, 32)} (${c.year || 'S/F'})`, callback_data: `ce:tm:${vid}:${i}` },
          ]);
          rows.push([{ text: '⬅️ Volver', callback_data: `cv:${vid}` }]);
          await this.showOrEdit(chatId, msgId, lines.join('\n'), { inline_keyboard: rows });
          return;
        }
        if (action === 'tm') {
          await tgAnswerCallback(cq.id, 'Aplicando ficha y carátula TMDB...');
          const cached = this.catalogTmdbCache.get(`${userId}:${vid}`);
          const picked = cached?.items[Number(parts[3] || 0)];
          if (!picked) {
            await this.renderCatalogDetail(chatId, userId, vid, msgId);
            return;
          }
          const ctx = await pictaService.resolveContextForUser(userId);
          const imgUrl = picked.backdropUrl || picked.posterUrl;
          const coverBuf = imgUrl ? (await fetchSafeImageBuffer(imgUrl)) || undefined : undefined;
          const posterBuf = picked.posterUrl ? (await fetchSafeImageBuffer(picked.posterUrl)) || undefined : undefined;
          await pictaService.patchPublication(ctx, vid, {
            nombre: picked.year ? `${picked.title} (${picked.year})` : picked.title,
            ...(picked.overview ? { descripcion: picked.overview } : {}),
            ...(coverBuf ? { coverBuffer: coverBuf } : {}),
            ...(posterBuf ? { posterBuffer: posterBuf } : {}),
          });
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'pub' || action === 'dl') {
          await tgAnswerCallback(cq.id, 'Actualizando...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          await pictaService.patchPublication(
            ctx,
            vid,
            action === 'pub' ? { publicado: !item.publicado } : { descargable: !item.descargable }
          );
          await this.renderCatalogDetail(chatId, userId, vid, msgId);
          return;
        }
        if (action === 'prm') {
          await tgAnswerCallback(cq.id, '📢 Difundiendo...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          const res = await this.broadcastPublicationToPromos(
            {
              title: item.nombre,
              description: item.descripcion,
              webUrl: item.webUrl,
              coverUrl: item.url_imagen || item.imagen_secundaria,
              channelName: ctx.channelName,
            },
            false
          );
          await tgSendMessage(
            chatId,
            res.total === 0
              ? '⚠️ No hay canales promocionales registrados. Usa /promos para agregar uno.'
              : `📢 Publicación difundida en ${res.sent}/${res.total} canal(es) promo.`
          );
          return;
        }
        if (action === 'del') {
          await tgAnswerCallback(cq.id);
          await this.showOrEdit(
            chatId,
            msgId,
            `⚠️ <b>Confirmar eliminación</b>\n¿Seguro que deseas eliminar la publicación #<code>${escHtml(vid)}</code> de Picta? Esta acción es irreversible.`,
            {
              inline_keyboard: [
                [
                  { text: '🗑️ Sí, eliminar', callback_data: `ce:delok:${vid}` },
                  { text: '⬅️ Cancelar', callback_data: `cv:${vid}` },
                ],
              ],
            }
          );
          return;
        }
        if (action === 'delok') {
          await tgAnswerCallback(cq.id, 'Eliminando...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const ok = await pictaService.deletePublication(ctx, vid);
          await this.showOrEdit(chatId, msgId, ok ? '✅ Publicación eliminada de Picta.' : '❌ No se pudo eliminar.', {
            inline_keyboard: [[{ text: '⬅️ Volver al Catálogo', callback_data: 'm:cat:1' }]],
          });
          return;
        }
      }

      // Channel Profile Editing
      if (prefix === 'chp') {
        await tgAnswerCallback(cq.id);
        const sub = parts[1];
        if (sub === 'name') {
          this.pendingInputs.set(userId, { kind: 'ch_name', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '✏️ Escribe el nuevo nombre para tu canal de Picta (o /cancelar):');
        } else if (sub === 'desc') {
          this.pendingInputs.set(userId, { kind: 'ch_desc', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📝 Escribe la nueva descripción de tu canal (o /cancelar):');
        } else if (sub === 'ava') {
          this.pendingInputs.set(userId, { kind: 'ch_avatar', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🖼️ Envía la foto para el nuevo avatar del canal (o /cancelar):');
        } else if (sub === 'ban') {
          this.pendingInputs.set(userId, { kind: 'ch_banner', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🎨 Envía la foto para el nuevo banner del canal (o /cancelar):');
        }
        return;
      }

      // Series CRUD
      if (data === 'm:ser') {
        await tgAnswerCallback(cq.id);
        await this.renderSeriesView(chatId, userId, msgId);
        return;
      }
      if (prefix === 'sd') {
        await tgAnswerCallback(cq.id);
        await this.renderSerieDetailView(chatId, userId, Number(parts[1]), msgId);
        return;
      }
      if (prefix === 'ser') {
        const sub = parts[1];
        const sid = Number(parts[2] || 0);
        if (sub === 'new') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'ser_new', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📺 Escribe el nombre de la nueva serie (buscaré carátula y sinopsis TMDB automáticamente, o /cancelar):');
          return;
        }
        if (sub === 'pin') {
          const idx = stateStore.pinnedSeriesIds.indexOf(sid);
          if (idx >= 0) stateStore.pinnedSeriesIds.splice(idx, 1);
          else stateStore.pinnedSeriesIds.push(sid);
          stateStore.savePinnedSeries();
          await tgAnswerCallback(cq.id, idx >= 0 ? 'Serie desfijada' : '📌 Serie fijada como favorita');
          await this.renderSerieDetailView(chatId, userId, sid, msgId);
          return;
        }
        if (sub === 'nam') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'ser_name', serieId: sid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '✏️ Escribe el nuevo nombre de la serie (o /cancelar):');
          return;
        }
        if (sub === 'des') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'ser_desc', serieId: sid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📝 Escribe la nueva sinopsis de la serie (o /cancelar):');
          return;
        }
        if (sub === 'cov') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'ser_cover', serieId: sid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🖼️ Envía la nueva foto de portada para esta serie (o /cancelar):');
          return;
        }
        if (sub === 'pub') {
          await tgAnswerCallback(cq.id, 'Actualizando...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const list = await pictaService.fetchChannelSeries(ctx);
          const cur = list.find((s) => s.id === sid);
          if (cur) await pictaService.patchSerie(ctx, sid, { publicado: !cur.publicado });
          await this.renderSerieDetailView(chatId, userId, sid, msgId);
          return;
        }
        if (sub === 'tmdb') {
          await tgAnswerCallback(cq.id, '🎬 Buscando carátula y sinopsis TMDB...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const list = await pictaService.fetchChannelSeries(ctx);
          const cur = list.find((s) => s.id === sid);
          if (!cur) return;
          const tmdb = await searchTmdbRichCandidates(cur.nombre);
          const best = tmdb.find((x) => x.mediaType === 'tv') || tmdb[0];
          if (!best) {
            await tgSendMessage(chatId, `Sin resultados en TMDB para "${escHtml(cur.nombre)}".`);
            return;
          }
          const imgUrl = best.backdropUrl || best.posterUrl;
          const coverBuf = imgUrl ? (await fetchSafeImageBuffer(imgUrl)) || undefined : undefined;
          await pictaService.patchSerie(ctx, sid, {
            ...(best.overview ? { descripcion: best.overview.slice(0, 1000) } : {}),
            ...(coverBuf ? { coverBuffer: coverBuf } : {}),
          });
          await this.renderSerieDetailView(chatId, userId, sid, msgId);
          return;
        }
        if (sub === 'del') {
          await tgAnswerCallback(cq.id);
          await this.showOrEdit(chatId, msgId, `⚠️ ¿Eliminar definitivamente la serie #<code>${sid}</code>?`, {
            inline_keyboard: [
              [
                { text: '🗑️ Sí, eliminar', callback_data: `ser:delok:${sid}` },
                { text: '⬅️ Cancelar', callback_data: `sd:${sid}` },
              ],
            ],
          });
          return;
        }
        if (sub === 'delok') {
          await tgAnswerCallback(cq.id, 'Eliminando serie...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const ok = await pictaService.deleteSerie(ctx, sid);
          await this.showOrEdit(chatId, msgId, ok ? '✅ Serie eliminada.' : '❌ No se pudo eliminar la serie.', {
            inline_keyboard: [[{ text: '⬅️ Volver a Series', callback_data: 'm:ser' }]],
          });
          return;
        }
      }

      // Playlists CRUD
      if (data === 'm:lis') {
        await tgAnswerCallback(cq.id);
        await this.renderPlaylistsView(chatId, userId, msgId);
        return;
      }
      if (prefix === 'ld') {
        await tgAnswerCallback(cq.id);
        await this.renderPlaylistDetailView(chatId, userId, Number(parts[1]), msgId);
        return;
      }
      if (prefix === 'lis') {
        const sub = parts[1];
        const pid = Number(parts[2] || 0);
        if (sub === 'new') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'lis_new', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📋 Escribe el nombre de la nueva lista de reproducción (o /cancelar):');
          return;
        }
        if (sub === 'nam') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'lis_name', playlistId: pid, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '✏️ Escribe el nuevo nombre para esta lista (o /cancelar):');
          return;
        }
        if (sub === 'pub' || sub === 'dl') {
          await tgAnswerCallback(cq.id, 'Actualizando lista...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const lists = await pictaService.fetchChannelPlaylists(ctx);
          const cur = lists.find((x) => x.id === pid);
          if (cur) {
            await pictaService.patchPlaylist(ctx, pid, sub === 'pub' ? { publicado: !cur.publicado } : { descarga: !cur.descarga });
          }
          await this.renderPlaylistDetailView(chatId, userId, pid, msgId);
          return;
        }
        if (sub === 'add') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const pubs = await pictaService.fetchChannelPublications({ ctx, page: 1, pageSize: 8 });
          const rows: InlineKeyboardButton[][] = pubs.items.map((p) => [
            { text: `➕ ${p.nombre.slice(0, 38)}`, callback_data: `lis:addv:${pid}:${p.id}` },
          ]);
          rows.push([{ text: '⬅️ Volver', callback_data: `ld:${pid}` }]);
          await this.showOrEdit(chatId, msgId, '<b>➕ Toca un video reciente para añadirlo a la lista:</b>', { inline_keyboard: rows });
          return;
        }
        if (sub === 'addv') {
          await tgAnswerCallback(cq.id, 'Añadiendo video...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.addVideoToPlaylist(ctx, pid, Number(parts[3]));
          await this.renderPlaylistDetailView(chatId, userId, pid, msgId);
          return;
        }
        if (sub === 'rem') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const lists = await pictaService.fetchChannelPlaylists(ctx);
          const cur = lists.find((x) => x.id === pid);
          const ids = cur?.publicacionesIds.slice(0, 10) || [];
          const rows: InlineKeyboardButton[][] = ids.map((vid) => [
            { text: `➖ Quitar video #${vid}`, callback_data: `lis:remv:${pid}:${vid}` },
          ]);
          rows.push([{ text: '⬅️ Volver', callback_data: `ld:${pid}` }]);
          await this.showOrEdit(chatId, msgId, '<b>➖ Elige el video que deseas quitar de la lista:</b>', { inline_keyboard: rows });
          return;
        }
        if (sub === 'remv') {
          await tgAnswerCallback(cq.id, 'Quitando video...');
          const ctx = await pictaService.resolveContextForUser(userId);
          await pictaService.removeVideoFromPlaylist(ctx, pid, Number(parts[3]));
          await this.renderPlaylistDetailView(chatId, userId, pid, msgId);
          return;
        }
        if (sub === 'del') {
          await tgAnswerCallback(cq.id);
          await this.showOrEdit(chatId, msgId, `⚠️ ¿Eliminar definitivamente la lista #<code>${pid}</code>?`, {
            inline_keyboard: [
              [
                { text: '🗑️ Sí, eliminar', callback_data: `lis:delok:${pid}` },
                { text: '⬅️ Cancelar', callback_data: `ld:${pid}` },
              ],
            ],
          });
          return;
        }
        if (sub === 'delok') {
          await tgAnswerCallback(cq.id, 'Eliminando lista...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const ok = await pictaService.deletePlaylist(ctx, pid);
          await this.showOrEdit(chatId, msgId, ok ? '✅ Lista eliminada.' : '❌ No se pudo eliminar.', {
            inline_keyboard: [[{ text: '⬅️ Volver a Listas', callback_data: 'm:lis' }]],
          });
          return;
        }
      }

      // Comments & AI Replies
      if (prefix === 'm' && parts[1] === 'com') {
        await tgAnswerCallback(cq.id);
        const f = (parts[2] === 'a' ? 'a' : parts[2] === 'r' ? 'r' : 'u') as 'u' | 'a' | 'r';
        await this.renderCommentsView(chatId, userId, f, Number(parts[3] || 0), false, msgId);
        return;
      }
      if (prefix === 'm' && parts[1] === 'comr') {
        await tgAnswerCallback(cq.id, '🔄 Actualizando comentarios...');
        const f = (parts[2] === 'a' ? 'a' : parts[2] === 'r' ? 'r' : 'u') as 'u' | 'a' | 'r';
        await this.renderCommentsView(chatId, userId, f, 0, true, msgId);
        return;
      }
      if (prefix === 'cm') {
        const action = parts[1];
        const cid = Number(parts[2]);
        const pid = Number(parts[3] || 0);
        if (action === 'ign') {
          if (!stateStore.ignoredCommentIds.includes(cid)) {
            stateStore.ignoredCommentIds.push(cid);
            stateStore.saveIgnoredComments();
          }
          await tgAnswerCallback(cq.id, '🙈 Comentario ignorado');
          await this.renderCommentsView(chatId, userId, 'u', 0, false, msgId);
          return;
        }
        if (action === 'del') {
          await tgAnswerCallback(cq.id, 'Eliminando comentario...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const ok = await pictaService.deleteComment(ctx, cid);
          await tgSendMessage(chatId, ok ? '✅ Comentario eliminado en Picta.' : '❌ Picta no permitió borrar este comentario.');
          await this.renderCommentsView(chatId, userId, 'u', 0, true, msgId);
          return;
        }
        if (action === 'man') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, {
            kind: 'com_reply',
            commentId: cid,
            pubId: pid,
            chatId,
            expiresAt: Date.now() + 5 * 60_000,
          });
          await tgSendMessage(chatId, '✍️ Escribe tu respuesta al comentario (o /cancelar):');
          return;
        }
        if (action === 'ai') {
          await tgAnswerCallback(cq.id, '✨ Generando respuesta IA...');
          const ctx = await pictaService.resolveContextForUser(userId);
          let target: PictaCommentItem | undefined;
          for (const [k, v] of this.commentSessionCache.entries()) {
            if (k.startsWith(`${userId}:`)) {
              const found = v.items.find((x) => x.id === cid);
              if (found) {
                target = found;
                break;
              }
            }
          }
          if (!target) {
            await tgSendMessage(chatId, 'Recarga /comentarios primero.');
            return;
          }
          const suggestion = await generateAiCommentReply({
            commentText: target.texto,
            authorName: target.usuario,
            videoTitle: target.publicacionNombre,
            channelName: ctx.channelName,
            isRequest: target.isLikelyRequest,
          });
          if (!suggestion) {
            const reason = getLastGeminiError() || 'verifica GEMINI_API_KEY en .env o variables del servidor.';
            await tgSendMessage(chatId, `⚠️ <b>Gemini IA no disponible:</b> ${escHtml(reason)}`);
            return;
          }
          const draftKey = `${userId}:${cid}`;
          this.aiReplyDrafts.set(draftKey, { text: suggestion, expiresAt: Date.now() + 20 * 60_000 });

          await this.showOrEdit(
            chatId,
            msgId,
            [
              `<b>✨ Sugerencia de Respuesta IA</b>`,
              `👤 A <b>${escHtml(target.usuario)}</b> en <i>${escHtml(target.publicacionNombre)}</i>:`,
              `“${escHtml(target.texto.slice(0, 220))}”`,
              ``,
              `<b>Propuesta:</b>`,
              `<i>${escHtml(suggestion)}</i>`,
            ].join('\n'),
            {
              inline_keyboard: [
                [
                  { text: '📤 Enviar esta respuesta', callback_data: `cm:aisend:${cid}:${pid}` },
                  { text: '🔄 Regenerar', callback_data: `cm:ai:${cid}:${pid}` },
                ],
                [
                  { text: '✍️ Escribir manual', callback_data: `cm:man:${cid}:${pid}` },
                  { text: '⬅️ Volver', callback_data: 'm:com:u:0' },
                ],
              ],
            }
          );
          return;
        }
        if (action === 'aisend') {
          const draftKey = `${userId}:${cid}`;
          const draft = this.aiReplyDrafts.get(draftKey);
          if (!draft) {
            await tgAnswerCallback(cq.id, 'Borrador expirado, genera uno nuevo.', true);
            return;
          }
          await tgAnswerCallback(cq.id, '📤 Publicando respuesta...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const ok = await pictaService.replyToComment(ctx, {
            publicacionId: pid,
            parentCommentId: cid,
            texto: draft.text,
          });
          this.aiReplyDrafts.delete(draftKey);
          await tgSendMessage(chatId, ok ? '✅ Respuesta IA publicada en Picta.' : '❌ Picta rechazó la respuesta.');
          await this.renderCommentsView(chatId, userId, 'u', 0, true, msgId);
          return;
        }
      }

      // Viewer Requests & Denuncias
      if (prefix === 'm' && parts[1] === 'req') {
        await tgAnswerCallback(cq.id);
        await this.renderRequestsView(chatId, Number(parts[2] || 0), msgId);
        return;
      }
      if (prefix === 'rq') {
        const sub = parts[1];
        if (sub === 'add') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'req_add', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🙋 Escribe el título de la película/serie solicitada (o /cancelar):');
          return;
        }
        if (sub === 'clr') {
          stateStore.channelRequests = stateStore.channelRequests.filter((r) => r.status === 'pending');
          stateStore.saveChannelRequests();
          await tgAnswerCallback(cq.id, '🧹 Resueltas limpiadas');
          await this.renderRequestsView(chatId, 0, msgId);
          return;
        }
        const shortId = parts[2];
        const rec = stateStore.channelRequests.find((r) => r.id.startsWith(shortId));
        if (sub === 'tm' && rec) {
          await tgAnswerCallback(cq.id, '🎬 Buscando en TMDB...');
          await this.handleTmdbLookupMessage(chatId, rec.requestedTitle);
          return;
        }
        if (rec) {
          rec.status = sub === 'ok' ? 'fulfilled' : 'ignored';
          stateStore.saveChannelRequests();
        }
        await tgAnswerCallback(cq.id, sub === 'ok' ? '✅ Marcada cumplida' : '🗑️ Descartada');
        await this.renderRequestsView(chatId, 0, msgId);
        return;
      }
      if (data === 'm:den') {
        await tgAnswerCallback(cq.id);
        await this.renderDenunciasView(chatId, userId, msgId);
        return;
      }

      // Promos
      if (data === 'm:prm') {
        await tgAnswerCallback(cq.id);
        await this.renderPromosView(chatId, msgId);
        return;
      }
      if (data === 'pr:add') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'promo_add', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(
          chatId,
          '📢 Envía el <code>@canal</code> o ID (<code>-100...</code>) seguido opcionalmente de un nombre.\nEjemplo: <code>@mi_canal_estrenos Canal Principal</code>\n<i>(El bot debe ser administrador en ese canal)</i>'
        );
        return;
      }
      if (data === 'pr:cast') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'promo_cast', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '📣 Envía ahora el mensaje (texto o foto con texto) que quieres difundir a todos tus canales promo (o /cancelar):');
        return;
      }
      if (prefix === 'pr' && (parts[1] === 'tog' || parts[1] === 'del')) {
        const idx = Number(parts[2]);
        if (stateStore.promoChannels[idx]) {
          if (parts[1] === 'tog') {
            stateStore.promoChannels[idx].autoPostEnabled = !stateStore.promoChannels[idx].autoPostEnabled;
          } else {
            stateStore.promoChannels.splice(idx, 1);
          }
          stateStore.savePromoChannels();
        }
        await tgAnswerCallback(cq.id, 'Actualizado');
        await this.renderPromosView(chatId, msgId);
        return;
      }

      // Queue & Disk
      if (data === 'm:col') {
        await tgAnswerCallback(cq.id);
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:retry') {
        const failed = stateStore.jobs.filter((j) => j.status === 'failed');
        for (const j of failed) {
          j.status = j.minioKey ? 'encoding_nomad' : 'queued';
          j.nomadRetries = 0;
          j.errorMessage = undefined;
          j.updatedAt = new Date().toISOString();
        }
        stateStore.saveJobs();
        await tgAnswerCallback(cq.id, `🔁 ${failed.length} trabajo(s) reencolado(s)`);
        void this.processNextQueuedJob();
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:canq') {
        let cancelled = 0;
        for (const j of stateStore.jobs) {
          if (j.status === 'queued') {
            j.status = 'cancelled';
            j.updatedAt = new Date().toISOString();
            cancelled += 1;
          }
        }
        stateStore.saveJobs();
        await tgAnswerCallback(cq.id, `❌ ${cancelled} pendiente(s) cancelado(s)`);
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:clr' && this.isAdmin(user)) {
        stateStore.jobs = stateStore.jobs.filter((j) =>
          ['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(j.status)
        );
        stateStore.saveJobs();
        await tgAnswerCallback(cq.id, '🧹 Historial limpiado');
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:pause' && this.isAdmin(user)) {
        stateStore.config.queuePaused = !stateStore.config.queuePaused;
        stateStore.saveConfig();
        await tgAnswerCallback(cq.id, stateStore.config.queuePaused ? '⏸️ Cola pausada' : '▶️ Cola reanudada');
        if (!stateStore.config.queuePaused) void this.processNextQueuedJob();
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:purge' && this.isAdmin(user)) {
        const res = await cleanupOrphanedScratchFiles();
        await tgAnswerCallback(cq.id, `🧹 ${res.deletedCount} borrados (${fmtMb(res.freedBytes)})`, true);
        await this.renderQueueView(chatId, user, msgId);
        return;
      }

      // Stats & Alerts
      if (prefix === 'm' && parts[1] === 'sta') {
        await tgAnswerCallback(cq.id);
        const days = (parts[2] === '7' ? 7 : parts[2] === '30' ? 30 : 1) as 1 | 7 | 30;
        await this.renderStatsView(chatId, userId, days, msgId);
        return;
      }
      if (data === 'al:tog') {
        user.alertsEnabled = !user.alertsEnabled;
        stateStore.saveUsers();
        await tgAnswerCallback(cq.id, user.alertsEnabled ? '🔔 Alertas activadas' : '🔕 Alertas silenciadas');
        await this.renderAlertsView(chatId, user, msgId);
        return;
      }
      if (data === 'al:clr') {
        stateStore.alerts = [];
        stateStore.saveAlerts();
        await tgAnswerCallback(cq.id, '🧹 Historial de alertas limpiado');
        await this.renderAlertsView(chatId, user, msgId);
        return;
      }
      if (data === 'al:scan') {
        await tgAnswerCallback(cq.id, '🔎 Escaneando Picta...');
        const r = await pictaService.scanAllPictaAlertsAndMilestones((uid, txt) => this.sendMessage(uid, txt));
        await tgSendMessage(chatId, `✅ Escaneo completo: ${r.scannedCount} videos vigilados, ${r.newAlerts.length} nueva(s) alerta(s).`);
        return;
      }
      if (data === 'al:nomad') {
        await tgAnswerCallback(cq.id, '🔁 Revisando Nomad...');
        const r = await pictaService.runNomadEncoderRetrySweep((uid, txt) => this.sendMessage(uid, txt));
        await tgSendMessage(chatId, `🔁 Barrido Nomad: ${r.checked} revisados, ${r.advanced} actualizados.`);
        return;
      }

      // Account / Multi-user
      if (data === 'm:acc') {
        await tgAnswerCallback(cq.id);
        await this.renderAccountView(chatId, userId, msgId);
        return;
      }
      if (data === 'ac:login') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'login_user', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '👤 Envía tu usuario o teléfono de Picta (8 dígitos o +53...), o /cancelar:');
        return;
      }
      if (data === 'ac:logout') {
        const idx = stateStore.userSessions.findIndex((s) => s.telegramUserId === userId);
        if (idx >= 0) {
          stateStore.userSessions.splice(idx, 1);
          stateStore.saveUserSessions();
        }
        pictaService.invalidateUserToken(userId);
        user.pictaLinked = false;
        stateStore.saveUsers();
        await tgAnswerCallback(cq.id, '🚪 Sesión Picta cerrada');
        await this.renderAccountView(chatId, userId, msgId);
        return;
      }
      if (prefix === 'ch') {
        const targetId = parts[1];
        const session = stateStore.userSessions.find((s) => s.telegramUserId === userId);
        const found = session?.availableChannels.find((c) => String(c.id) === targetId);
        if (session && found) {
          session.channelId = String(found.id);
          session.channelName = found.nombre;
          stateStore.saveUserSessions();
          await tgAnswerCallback(cq.id, `📺 Canal activo: ${found.nombre}`);
          await this.renderAccountView(chatId, userId, msgId);
        } else {
          await tgAnswerCallback(cq.id, 'Canal no autorizado para esta cuenta.', true);
        }
        return;
      }

      // Admin, Users, Config & Vault
      if (data === 'm:adm' && this.isAdmin(user)) {
        await tgAnswerCallback(cq.id);
        await this.renderAdminView(chatId, msgId);
        return;
      }
      if (data === 'ad:mt' && this.isAdmin(user)) {
        await tgAnswerCallback(cq.id, '⚡ Reconectando MTProto...');
        await mtprotoPool.disconnect();
        const ok = await mtprotoPool.connectIfConfigured();
        await tgSendMessage(chatId, ok ? '✅ MTProto FastSocket reconectado.' : '⚠️ MTProto en espera (verifica TELEGRAM_API_ID/API_HASH).');
        await this.renderAdminView(chatId, msgId);
        return;
      }
      if (data === 'vt:bak' && this.isAdmin(user)) {
        await tgAnswerCallback(cq.id, '☁️ Respaldando Bóveda...');
        const snap = await saveCloudStateToTelegramNow(true);
        await tgSendMessage(chatId, `🔐 <b>Bóveda:</b> ${escHtml(snap.message)}`);
        return;
      }
      if (data === 'vt:res' && this.isAdmin(user)) {
        await tgAnswerCallback(cq.id, '♻️ Restaurando...');
        const res = await restoreCloudStateFromTelegramCommands();
        if (res.ok) {
          await tgSendMessage(
            chatId,
            `✅ Bóveda Telegram restaurada (${res.restoredUsers} usuarios · MTProto=${res.restoredMtproto ? 'SÍ' : 'NO'}).`
          );
        } else {
          const localRes = await restoreCloudStateFromLocalVault();
          await tgSendMessage(
            chatId,
            localRes.ok
              ? `✅ Restaurado desde bóveda local (${localRes.restoredUsers} usuarios).`
              : `❌ ${escHtml(res.error || localRes.error || 'Sin respaldo disponible')}`
          );
        }
        return;
      }
      if (data === 'ad:netlog' && (user.role !== 'user' || stateStore.isMasterAdmin(userId))) {
        await tgAnswerCallback(cq.id);
        await tgSendMessage(chatId, `<code>${escHtml(netlog.formatForTelegram(16))}</code>`);
        return;
      }
      if (prefix === 'us' && this.isAdmin(user)) {
        const sub = parts[1];
        const targetUid = parts[2];
        if (sub === 'list') {
          await tgAnswerCallback(cq.id);
          await this.renderUsersAdminView(chatId, msgId);
          return;
        }
        if (sub === 'add') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'add_user', chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(
            chatId,
            '👤 Envía los datos del usuario en este formato:\n<code>&lt;telegramId&gt; &lt;nombre&gt; [user|operator|admin] [gb]</code>\nEjemplo: <code>123456789 Carlos user 15</code>'
          );
          return;
        }
        if (sub === 'v' && targetUid) {
          await tgAnswerCallback(cq.id);
          await this.renderUserDetailAdmin(chatId, targetUid, msgId);
          return;
        }
        const target = stateStore.users.find((x) => x.telegramUserId === targetUid);
        if (target) {
          if (sub === 'act' && !stateStore.isMasterAdmin(targetUid)) target.active = !target.active;
          if (sub === 'rol' && !stateStore.isMasterAdmin(targetUid)) {
            const roles: UserRole[] = ['user', 'operator', 'admin'];
            target.role = roles[(roles.indexOf(target.role) + 1) % roles.length];
          }
          if (sub === 'qta') {
            const steps = [5, 10, 20, 50, 100];
            const next = steps.find((s) => s > target.dailyQuotaGb) || steps[0];
            target.dailyQuotaGb = next;
          }
          if (sub === 'rst') {
            target.usedTodayGb = 0;
            target.filesToday = 0;
          }
          if (sub === 'mod') {
            target.uploadMode = target.uploadMode === 'fast' ? 'wizard' : 'fast';
          }
          if (sub === 'del' && !stateStore.isMasterAdmin(targetUid)) {
            stateStore.users = stateStore.users.filter((x) => x.telegramUserId !== targetUid);
            stateStore.saveUsers();
            await tgAnswerCallback(cq.id, 'Usuario eliminado');
            await this.renderUsersAdminView(chatId, msgId);
            return;
          }
          stateStore.saveUsers();
          await tgAnswerCallback(cq.id, 'Actualizado');
          await this.renderUserDetailAdmin(chatId, targetUid, msgId);
        }
        return;
      }

      if (prefix === 'cfg' && this.isAdmin(user)) {
        const sub = parts[1];
        if (sub === 'qen') {
          stateStore.quotaSettings.enforceQuotas = !stateStore.quotaSettings.enforceQuotas;
          stateStore.saveQuotaSettings();
        } else if (sub === 'mxf') {
          const steps = [1, 2, 4, 5];
          stateStore.quotaSettings.maxSingleFileGb = steps.find((s) => s > stateStore.quotaSettings.maxSingleFileGb) || steps[0];
          stateStore.saveQuotaSettings();
        } else if (sub === 'wrk') {
          const steps = [4, 6, 8];
          stateStore.config.mtprotoWorkers = steps.find((s) => s > stateStore.config.mtprotoWorkers) || steps[0];
          stateStore.saveConfig();
        } else if (sub === 'alt') {
          const steps = [2 * 60_000, 5 * 60_000, 10 * 60_000];
          stateStore.config.alertsIntervalMs = steps.find((s) => s > stateStore.config.alertsIntervalMs) || steps[0];
          stateStore.saveConfig();
          this.startBackgroundLoops();
        } else if (sub === 'vlt') {
          stateStore.config.autoVaultSyncEnabled = !stateStore.config.autoVaultSyncEnabled;
          stateStore.saveConfig();
        } else if (sub === 'pau') {
          stateStore.config.queuePaused = !stateStore.config.queuePaused;
          stateStore.saveConfig();
          if (!stateStore.config.queuePaused) void this.processNextQueuedJob();
        }
        await tgAnswerCallback(cq.id, sub === 'view' ? undefined : 'Ajuste guardado');
        await this.renderGlobalConfigView(chatId, msgId);
        return;
      }

      // =======================================================================
      // UPLOAD WIZARD CALLBACKS (w:*)
      // =======================================================================
      if (prefix === 'w') {
        const action = parts[1];
        const draftId = parts[2];
        const draft = this.wizardDrafts.get(draftId);
        if (!draft || draft.userId !== userId) {
          await tgAnswerCallback(cq.id, 'Este asistente ya expiró o fue completado.', true);
          return;
        }

        if (action === 'can') {
          this.wizardDrafts.delete(draftId);
          if (draft.customCoverPath) this.safeRm(draft.customCoverPath);
          if (draft.unirPartPaths) {
            for (const rel of draft.unirPartPaths) {
              try {
                this.safeRm(resolveConfinedScratchPath(rel));
              } catch {
                // Ignore
              }
            }
          }
          await tgAnswerCallback(cq.id, 'Subida cancelada');
          await this.showOrEdit(chatId, msgId, '❌ Borrador de subida cancelado.');
          return;
        }
        if (action === 'go') {
          this.wizardDrafts.delete(draftId);
          await tgAnswerCallback(cq.id, '🚀 Enviado a la cola');
          await this.enqueueFromWizardDraft(draft, user);
          return;
        }
        if (action === 'back') {
          await tgAnswerCallback(cq.id);
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'pub') {
          draft.publicado = !draft.publicado;
          await tgAnswerCallback(cq.id, draft.publicado ? 'Público: SÍ' : 'Público: NO');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'dl') {
          draft.descargable = !draft.descargable;
          await tgAnswerCallback(cq.id, draft.descargable ? 'Descargable: SÍ' : 'Descargable: NO');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'com') {
          draft.mostrarComentarios = !draft.mostrarComentarios;
          await tgAnswerCallback(cq.id, draft.mostrarComentarios ? 'Comentarios: SÍ' : 'Comentarios: NO');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'prm') {
          draft.autoPromo = !draft.autoPromo;
          await tgAnswerCallback(cq.id, draft.autoPromo ? 'Auto-Promo: SÍ' : 'Auto-Promo: NO');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'cla') {
          const next = CLASIFICACIONES[(CLASIFICACIONES.indexOf(draft.clasificacion) + 1) % CLASIFICACIONES.length];
          draft.clasificacion = next;
          await tgAnswerCallback(cq.id, `Clasificación: ${next}`);
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'tit') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_title', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '✏️ Escribe el título deseado para este video (o /cancelar):');
          return;
        }
        if (action === 'des') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_desc', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📝 Escribe la sinopsis para este video (o /cancelar):');
          return;
        }
        if (action === 'tag') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_tags', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🏷️ Escribe etiquetas separadas por coma (o <code>-</code> para borrar / /cancelar):');
          return;
        }
        if (action === 'yr') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_year', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '📅 Escribe el año de estreno (ej: 2025, o /cancelar):');
          return;
        }
        if (action === 'epn') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_epnum', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🔢 Envía <code>Temporada Capítulo</code> (ej: <code>2 5</code> para T2 Cap. 5, o solo el número de capítulo):');
          return;
        }
        if (action === 'tmdbq') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_tmdb_q', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🔎 Escribe el nombre exacto de la película o serie para buscar en TMDB (o /cancelar):');
          return;
        }
        if (action === 'cov') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, { kind: 'wiz_cover', draftId, chatId, expiresAt: Date.now() + 5 * 60_000 });
          await tgSendMessage(chatId, '🖼️ Envía ahora una foto como portada personalizada (o /cancelar):', {
            inline_keyboard: [[{ text: '🎞️ Usar fotograma automático (ffmpeg)', callback_data: `w:covauto:${draftId}` }]],
          });
          return;
        }
        if (action === 'covauto') {
          this.pendingInputs.delete(userId);
          if (draft.customCoverPath) this.safeRm(draft.customCoverPath);
          draft.customCoverPath = undefined;
          draft.coverUrl = undefined;
          await tgAnswerCallback(cq.id, 'Usará fotograma automático');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'tip') {
          await tgAnswerCallback(cq.id);
          const entries = Object.entries(PICTA_TIPOLOGIAS);
          const rows: InlineKeyboardButton[][] = [];
          for (let i = 0; i < entries.length; i += 2) {
            rows.push(
              entries.slice(i, i + 2).map(([k, v]) => ({
                text: Number(k) === draft.tipologia ? `✅ ${v}` : v,
                callback_data: `w:st:${draftId}:${k}`,
              }))
            );
          }
          rows.push([{ text: '⬅️ Volver', callback_data: `w:back:${draftId}` }]);
          await this.showOrEdit(chatId, msgId, '<b>📂 Selecciona la Tipología de Picta:</b>', { inline_keyboard: rows });
          return;
        }
        if (action === 'st') {
          draft.tipologia = Number(parts[3] || 8);
          await tgAnswerCallback(cq.id, `Tipología: ${PICTA_TIPOLOGIAS[draft.tipologia] || draft.tipologia}`);
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'tmdb') {
          await tgAnswerCallback(cq.id, '🎬 Buscando en TMDB...');
          await this.showTmdbPickerForDraft(draft, draft.title, msgId);
          return;
        }
        if (action === 'tm') {
          const idx = Number(parts[3] || 0);
          const picked = draft.tmdbCandidates[idx];
          if (picked) {
            draft.title = picked.year ? `${picked.title} (${picked.year})` : picked.title;
            if (picked.overview) draft.description = picked.overview;
            if (picked.year) draft.year = picked.year;
            draft.coverUrl = picked.backdropUrl || picked.posterUrl;
            draft.posterUrl = picked.posterUrl;
            draft.tipologia = picked.mediaType === 'tv' ? 5 : 1;
            await tgAnswerCallback(cq.id, `✅ Aplicado: ${picked.title}`);
          }
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'ai') {
          await tgAnswerCallback(cq.id, '✨ Consultando Gemini IA...');
          const aiRes = await enrichMetadataWithGemini({
            title: draft.title,
            mediaType: draft.tipologia === 5 ? 'tv' : draft.tipologia === 1 ? 'movie' : 'video',
            existingOverview: draft.description,
            year: draft.year,
          });
          if (!aiRes) {
            const reason = getLastGeminiError() || 'verifica GEMINI_API_KEY en .env o variables del servidor.';
            await tgSendMessage(chatId, `⚠️ <b>Gemini IA no disponible:</b> ${escHtml(reason)}`);
            return;
          }
          draft.title = aiRes.title;
          draft.description = aiRes.synopsis;
          draft.clasificacion = aiRes.clasificacion;
          draft.keywords = aiRes.keywords;
          draft.tipologia = aiRes.suggestedTipologia;
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'lis') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const lists = await pictaService.fetchChannelPlaylists(ctx);
          const rows: InlineKeyboardButton[][] = lists.slice(0, 8).map((l) => [
            { text: `${draft.playlistId === l.id ? '✅ ' : ''}📋 ${l.nombre.slice(0, 34)}`, callback_data: `w:sl:${draftId}:${l.id}` },
          ]);
          rows.push([
            { text: '🚫 Ninguna', callback_data: `w:sl:${draftId}:0` },
            { text: '⬅️ Volver', callback_data: `w:back:${draftId}` },
          ]);
          await this.showOrEdit(chatId, msgId, '<b>📋 Añadir automáticamente a una Lista al subir:</b>', { inline_keyboard: rows });
          return;
        }
        if (action === 'sl') {
          const plId = Number(parts[3] || 0);
          if (plId <= 0) {
            draft.playlistId = undefined;
            draft.playlistName = undefined;
          } else {
            const ctx = await pictaService.resolveContextForUser(userId);
            const lists = await pictaService.fetchChannelPlaylists(ctx);
            const chosen = lists.find((l) => l.id === plId);
            if (chosen) {
              draft.playlistId = chosen.id;
              draft.playlistName = chosen.nombre;
            }
          }
          await tgAnswerCallback(cq.id, draft.playlistName ? `Lista: ${draft.playlistName}` : 'Sin lista');
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'ser') {
          await tgAnswerCallback(cq.id);
          const ctx = await pictaService.resolveContextForUser(userId);
          const series = await pictaService.fetchChannelSeries(ctx);
          const rows: InlineKeyboardButton[][] = series.slice(0, 8).map((s) => [
            {
              text: `${s.pinned ? '📌 ' : ''}${s.nombre.slice(0, 34)} (${s.cantidad_capitulos} cap)`,
              callback_data: `w:ss:${draftId}:${s.id}`,
            },
          ]);
          rows.push([
            { text: '➕ Crear Nueva Serie', callback_data: `w:snew:${draftId}` },
            { text: '⬅️ Volver', callback_data: `w:back:${draftId}` },
          ]);
          await this.showOrEdit(chatId, msgId, '<b>📺 Elige la Serie para vincular este capítulo:</b>', {
            inline_keyboard: rows,
          });
          return;
        }
        if (action === 'snew') {
          await tgAnswerCallback(cq.id);
          this.pendingInputs.set(userId, {
            kind: 'ser_new',
            chatId,
            attachDraftId: draftId,
            expiresAt: Date.now() + 5 * 60_000,
          });
          await tgSendMessage(chatId, '📺 Escribe el nombre de la nueva serie (o /cancelar):');
          return;
        }
        if (action === 'ss') {
          const sid = Number(parts[3] || 0);
          const ctx = await pictaService.resolveContextForUser(userId);
          const series = await pictaService.fetchChannelSeries(ctx);
          const chosen = series.find((s) => s.id === sid);
          if (chosen) {
            draft.tipologia = 5;
            draft.serieId = chosen.id;
            draft.serieName = chosen.nombre;
            if (!draft.numero || draft.numero === '1') {
              draft.numero = String(Math.max(1, chosen.cantidad_capitulos + 1));
            }
            const opts = buildSerieTitleOptions(chosen.nombre, draft.temporada, draft.numero, draft.episodeSubtitle);
            await tgAnswerCallback(cq.id, `Serie: ${chosen.nombre}`);
            await this.showOrEdit(
              chatId,
              msgId,
              `<b>📺 Serie vinculada: ${escHtml(chosen.nombre)}</b> (T${draft.temporada} Cap. ${draft.numero})\nElige el formato de título:`,
              {
                inline_keyboard: [
                  ...opts.map((opt, idx) => [{ text: opt.slice(0, 46), callback_data: `w:ep:${draftId}:${idx}` }]),
                  [
                    { text: '🔢 Cambiar T/Cap.', callback_data: `w:epn:${draftId}` },
                    { text: '⬅️ Mantener actual', callback_data: `w:back:${draftId}` },
                  ],
                ],
              }
            );
            return;
          }
          await this.renderWizardCard(draft, msgId);
          return;
        }
        if (action === 'ep') {
          const idx = Number(parts[3] || 0);
          const opts = buildSerieTitleOptions(
            draft.serieName || 'Serie',
            draft.temporada,
            draft.numero,
            draft.episodeSubtitle
          );
          if (opts[idx]) draft.title = opts[idx];
          await tgAnswerCallback(cq.id, 'Formato aplicado');
          await this.renderWizardCard(draft, msgId);
          return;
        }
      }

      await tgAnswerCallback(cq.id);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      await tgAnswerCallback(cq.id, msg.slice(0, 180), true);
    }
  }

  // ===========================================================================
  // MESSAGE & SLASH COMMAND ROUTER
  // ===========================================================================

  public async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    this.updatesProcessed += 1;

    if (update.callback_query) {
      await this.handleCallbackQuery(update.callback_query);
      return;
    }

    const msg = update.message;
    if (!msg || !msg.from) return;

    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const user = stateStore.users.find((u) => u.telegramUserId === userId && u.active);
    const text = (msg.text || msg.caption || '').trim();

    if (!user) {
      await tgSendMessage(
        chatId,
        `🔒 Acceso restringido. Tu ID de Telegram (<code>${escHtml(userId)}</code>) no está autorizado en PictaBot.`
      );
      return;
    }

    stateStore.resetDailyQuotasIfNeeded();
    user.lastActiveAt = new Date().toISOString();

    const pending = this.pendingInputs.get(userId);
    if (pending && pending.expiresAt > Date.now() && !text.startsWith('/start') && !text.startsWith('/menu')) {
      const handled = await this.handlePendingInput(pending, msg, user);
      if (handled) return;
    } else if (pending) {
      this.pendingInputs.delete(userId);
    }

    if (text.startsWith('/start') || text.startsWith('/menu')) {
      await this.renderMainMenu(chatId, user);
      return;
    }
    if (text.startsWith('/help') || text.startsWith('/ayuda')) {
      await this.renderHelpView(chatId);
      return;
    }
    if (text.startsWith('/modo')) {
      user.uploadMode = user.uploadMode === 'fast' ? 'wizard' : 'fast';
      stateStore.saveUsers();
      await tgSendMessage(
        chatId,
        user.uploadMode === 'fast'
          ? '⚡ <b>Modo Rápido Automático</b> activado: al enviar videos detecto TMDB/IA y subo directo.'
          : '🧭 <b>Modo Asistente Completo</b> activado: al enviar videos podrás ajustar tipología, clasificación, TMDB, IA, series, listas y portada.'
      );
      return;
    }
    if (text.startsWith('/catalogo')) {
      const search = text.replace(/^\/catalogo\s*/i, '').trim() || null;
      await this.renderCatalogPage(chatId, userId, 1, search);
      return;
    }
    if (text.startsWith('/top')) {
      await this.renderTopVideosView(chatId, userId, 'v');
      return;
    }
    if (text.startsWith('/canal')) {
      await this.renderChannelProfileView(chatId, userId);
      return;
    }
    if (text.startsWith('/series')) {
      await this.renderSeriesView(chatId, userId);
      return;
    }
    if (text.startsWith('/listas')) {
      await this.renderPlaylistsView(chatId, userId);
      return;
    }
    if (text.startsWith('/comentarios')) {
      await this.renderCommentsView(chatId, userId, 'u', 0, true);
      return;
    }
    if (text.startsWith('/peticiones')) {
      await this.renderRequestsView(chatId, 0);
      return;
    }
    if (text.startsWith('/denuncias')) {
      await this.renderDenunciasView(chatId, userId);
      return;
    }
    if (text.startsWith('/promos')) {
      await this.renderPromosView(chatId);
      return;
    }
    if (text.startsWith('/url')) {
      const arg = text.replace(/^\/url\s*/i, '').trim();
      if (!arg) {
        this.pendingInputs.set(userId, { kind: 'url_upload', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🔗 Envía el enlace directo HTTP/HTTPS del video (y título opcional):');
        return;
      }
      await this.handleDirectUrlRequest(chatId, user, arg);
      return;
    }
    if (text.startsWith('/ia')) {
      const prompt = text.replace(/^\/ia\s*/i, '').trim();
      if (!prompt) {
        this.pendingInputs.set(userId, { kind: 'ai_ask', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '✨ Escribe tu consulta para Gemini IA (sinopsis, título, texto de promo, hashtags...):');
        return;
      }
      await this.handleDirectAiQuery(chatId, userId, prompt);
      return;
    }
    if (text.startsWith('/login')) {
      this.pendingInputs.set(userId, { kind: 'login_user', chatId, expiresAt: Date.now() + 5 * 60_000 });
      await tgSendMessage(chatId, '👤 Envía tu usuario o teléfono de Picta (8 dígitos o +53...), o /cancelar:');
      return;
    }
    if (text.startsWith('/logout')) {
      const idx = stateStore.userSessions.findIndex((s) => s.telegramUserId === userId);
      if (idx >= 0) {
        stateStore.userSessions.splice(idx, 1);
        stateStore.saveUserSessions();
      }
      pictaService.invalidateUserToken(userId);
      user.pictaLinked = false;
      stateStore.saveUsers();
      await tgSendMessage(chatId, '🚪 Sesión personal de Picta eliminada.');
      return;
    }
    if (text.startsWith('/mis_canales')) {
      await this.renderAccountView(chatId, userId);
      return;
    }
    if (text.startsWith('/admin') || text.startsWith('/estado') || text.startsWith('/status')) {
      if (!this.isAdmin(user) && text.startsWith('/admin')) {
        await tgSendMessage(chatId, '🔒 Panel reservado para administradores.');
        return;
      }
      await this.renderAdminView(chatId);
      return;
    }
    if (text.startsWith('/config')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, '🔒 Ajustes globales reservados para administradores.');
        return;
      }
      await this.renderGlobalConfigView(chatId);
      return;
    }
    if (text.startsWith('/cuota')) {
      await tgSendMessage(
        chatId,
        [
          `<b>📊 Cuota de ${escHtml(user.displayName)}</b> (${user.role})`,
          `• Consumo hoy: ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB`,
          `• Archivos hoy: ${user.filesToday} / ${user.dailyMaxFiles}`,
          `• Máximo por archivo: ${stateStore.quotaSettings.maxSingleFileGb} GB`,
          `• Modo de subida: ${user.uploadMode === 'fast' ? '⚡ Rápido' : '🧭 Asistente'}`,
        ].join('\n')
      );
      return;
    }
    if (text.startsWith('/disco')) {
      const disk = await getDiskStatusReport();
      await tgSendMessage(
        chatId,
        [
          `<b>💾 Disco Persistente</b>`,
          `• Estado: ${fmtMb(disk.stateUsedBytes)} (<code>${escHtml(disk.stateDir)}</code>)`,
          `• Scratch: ${fmtMb(disk.scratchUsedBytes)} (<code>${escHtml(disk.scratchDir)}</code>)`,
          `• Libre: ${fmtGb(disk.budgetRemainingBytes)} / ${stateStore.config.diskBudgetGb} GB (${disk.usagePct}%)`,
          `• Presión: <b>${disk.pressureLevel.toUpperCase()}</b>`,
        ].join('\n')
      );
      return;
    }
    if (text.startsWith('/purgar')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, 'Solo administradores pueden purgar el disco temporal.');
        return;
      }
      const res = await cleanupOrphanedScratchFiles();
      await tgSendMessage(chatId, `🧹 Purga completada: ${res.deletedCount} elemento(s) borrados (${fmtMb(res.freedBytes)} liberados).`);
      return;
    }
    if (text.startsWith('/stats')) {
      await this.renderStatsView(chatId, userId, 1);
      return;
    }
    if (text.startsWith('/alertas')) {
      await this.renderAlertsView(chatId, user);
      return;
    }
    if (text.startsWith('/nomad')) {
      const r = await pictaService.runNomadEncoderRetrySweep((uid, m) => this.sendMessage(uid, m));
      await tgSendMessage(chatId, `🔁 Barrido Nomad: ${r.checked} revisados, ${r.advanced} actualizados.`);
      return;
    }
    if (text.startsWith('/buscar')) {
      const query = text.replace(/^\/buscar\s*/i, '').trim();
      if (!query) {
        this.pendingInputs.set(userId, { kind: 'tmdb_search', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '🔍 Escribe el título de la película o serie a buscar en TMDB:');
        return;
      }
      await this.handleTmdbLookupMessage(chatId, query);
      return;
    }
    if (text.startsWith('/cola')) {
      await this.renderQueueView(chatId, user);
      return;
    }
    if (text.startsWith('/reintentar')) {
      const failed = stateStore.jobs.filter((j) => j.status === 'failed');
      for (const j of failed) {
        j.status = j.minioKey ? 'encoding_nomad' : 'queued';
        j.nomadRetries = 0;
        j.errorMessage = undefined;
        j.updatedAt = new Date().toISOString();
      }
      stateStore.saveJobs();
      await tgSendMessage(chatId, `🔁 Se reencolaron ${failed.length} trabajo(s) fallido(s).`);
      void this.processNextQueuedJob();
      return;
    }
    if (text.startsWith('/usuarios')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, 'Solo administradores pueden gestionar usuarios.');
        return;
      }
      await this.renderUsersAdminView(chatId);
      return;
    }
    if (text.startsWith('/adduser')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, 'Solo administradores pueden autorizar usuarios.');
        return;
      }
      const args = text.replace(/^\/adduser\s*/i, '').trim().split(/\s+/).filter(Boolean);
      await this.handleAddUserArgs(chatId, args);
      return;
    }
    if (text.startsWith('/netlog')) {
      if (user.role === 'user' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Comando reservado para operadores y administradores.');
        return;
      }
      await tgSendMessage(chatId, `<code>${escHtml(netlog.formatForTelegram(16))}</code>`);
      return;
    }
    if (text.startsWith('/backup') || text.startsWith('/vault')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, 'Solo administradores pueden disparar el respaldo.');
        return;
      }
      const snap = await saveCloudStateToTelegramNow(true);
      await tgSendMessage(chatId, `🔐 Bóveda procesada: ${escHtml(snap.message)}`);
      return;
    }
    if (text.startsWith('/restaurar_nube')) {
      if (!this.isAdmin(user)) {
        await tgSendMessage(chatId, 'Solo administradores pueden restaurar la bóveda.');
        return;
      }
      const res = await restoreCloudStateFromTelegramCommands();
      await tgSendMessage(
        chatId,
        res.ok
          ? `✅ Bóveda Telegram restaurada (${res.restoredUsers} usuarios · MTProto=${res.restoredMtproto ? 'SÍ' : 'NO'}).`
          : `❌ No se pudo restaurar: ${escHtml(res.error || 'Sin datos')}`
      );
      return;
    }
    if (text.startsWith('/unir_cancelar')) {
      const session = this.activeUnirSessions.get(userId);
      if (session) {
        for (const rel of session.partRelativePaths) {
          try {
            this.safeRm(resolveConfinedScratchPath(rel));
          } catch {
            // Ignore
          }
        }
        this.activeUnirSessions.delete(userId);
        await tgSendMessage(chatId, '✅ Sesión /unir cancelada y archivos temporales liberados.');
      } else {
        await tgSendMessage(chatId, 'No tienes ninguna sesión /unir activa.');
      }
      return;
    }
    if (text.startsWith('/unir_fin')) {
      const session = this.activeUnirSessions.get(userId);
      if (!session || session.partRelativePaths.length === 0) {
        await tgSendMessage(chatId, 'No tienes ninguna sesión /unir con partes recibidas.');
        return;
      }
      this.activeUnirSessions.delete(userId);
      await this.startUploadFlow({
        user,
        chatId,
        source: 'unir_assembler',
        fileName: `${session.title}.mp4`,
        sizeBytes: session.totalBytes,
        caption: session.title,
        unirPartPaths: session.partRelativePaths,
      });
      return;
    }
    if (text.startsWith('/unir')) {
      const title = text.replace(/^\/unir\s*/i, '').trim() || `Ensamblaje ${new Date().toISOString().slice(11, 19)}`;
      this.openUnirSession(chatId, userId, title);
      await tgSendMessage(
        chatId,
        `🧩 <b>Sesión /unir abierta:</b> ${escHtml(title)}\nEnvía ahora las partes (.001/.002, .zip o .tar) y cuando termines ejecuta /unir_fin.`,
        { inline_keyboard: [[{ text: '❌ Cancelar /unir', callback_data: 'un:can' }]] }
      );
      return;
    }

    // Incoming video or document upload
    const media = msg.video || msg.document;
    if (media) {
      const sizeBytes = media.file_size || 0;
      const sizeGb = sizeBytes / 1024 ** 3;

      if (stateStore.quotaSettings.enforceQuotas) {
        if (sizeGb > stateStore.quotaSettings.maxSingleFileGb) {
          await tgSendMessage(chatId, `❌ Archivo rechazado: supera el límite por archivo (${stateStore.quotaSettings.maxSingleFileGb} GB).`);
          return;
        }
        if (user.usedTodayGb + sizeGb > user.dailyQuotaGb || user.filesToday + 1 > user.dailyMaxFiles) {
          await tgSendMessage(chatId, '❌ Cuota diaria alcanzada. Consulta /cuota o contacta al administrador.');
          return;
        }
      }

      const space = await ensureScratchSpaceForFile(sizeBytes);
      if (!space.ok) {
        await tgSendMessage(chatId, `❌ Espacio temporal insuficiente: ${escHtml(space.reason || '')}`);
        return;
      }

      const unirSession = this.activeUnirSessions.get(userId);
      if (unirSession) {
        const partIdx = unirSession.partRelativePaths.length + 1;
        const safePartName = (media.file_name || `part_${partIdx}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const partRel = `unir_${unirSession.id}_p${String(partIdx).padStart(2, '0')}_${safePartName}`;
        const statusId = await tgSendMessage(chatId, `⬇️ Descargando parte #${partIdx} (<i>${escHtml(safePartName)}</i>)...`);
        try {
          let dl: { filePath: string; bytesWritten: number; throughputMbps: number } | null = null;
          if (mtprotoPool.isConfigured()) {
            try {
              dl = await mtprotoPool.downloadTelegramMessageMedia({
                chatId,
                messageId: msg.message_id,
                expectedBytes: sizeBytes,
                targetRelativePath: partRel,
              });
            } catch (mtErr) {
              if (sizeBytes <= BOT_API_MAX_DOWNLOAD_BYTES) {
                dl = await tgDownloadBotFileToScratch(media.file_id, partRel, BOT_API_MAX_DOWNLOAD_BYTES);
              } else {
                throw mtErr;
              }
            }
          } else if (sizeBytes <= BOT_API_MAX_DOWNLOAD_BYTES) {
            dl = await tgDownloadBotFileToScratch(media.file_id, partRel, BOT_API_MAX_DOWNLOAD_BYTES);
          }
          if (!dl) throw new Error('No se pudo descargar la parte (verifica MTProto para partes > 20 MB).');

          unirSession.partRelativePaths.push(partRel);
          unirSession.totalBytes += dl.bytesWritten;
          await this.showOrEdit(
            chatId,
            statusId || undefined,
            `✅ Parte #${partIdx} lista (${fmtMb(dl.bytesWritten)} · ${dl.throughputMbps} MB/s).\nTotal acumulado: <b>${fmtMb(unirSession.totalBytes)}</b> (${unirSession.partRelativePaths.length} parte(s)).`,
            {
              inline_keyboard: [
                [
                  { text: '✅ Finalizar y Subir (/unir_fin)', callback_data: 'un:fin' },
                  { text: '❌ Cancelar', callback_data: 'un:can' },
                ],
              ],
            }
          );
        } catch (err) {
          await this.showOrEdit(
            chatId,
            statusId || undefined,
            `❌ Error descargando parte #${partIdx}: ${escHtml(err instanceof Error ? err.message : String(err))}`
          );
        }
        return;
      }

      const fileName = media.file_name || `telegram_${msg.message_id}.mp4`;
      await this.startUploadFlow({
        user,
        chatId,
        source: 'telegram_mtproto',
        fileName,
        sizeBytes,
        caption: text,
        sourceMessageId: msg.message_id,
        telegramFileId: media.file_id,
      });
    }
  }

  // ===========================================================================
  // BACKGROUND LOOPS & MEMORY HOUSEKEEPING
  // ===========================================================================

  private runMemoryHousekeeping(): void {
    const now = Date.now();
    for (const [id, draft] of this.wizardDrafts) {
      if (now - draft.createdAt > 2 * 3600_000) {
        if (draft.customCoverPath) this.safeRm(draft.customCoverPath);
        this.wizardDrafts.delete(id);
      }
    }
    for (const [uid, inp] of this.pendingInputs) {
      if (inp.expiresAt <= now) this.pendingInputs.delete(uid);
    }
    for (const [k, v] of this.commentSessionCache) {
      if (v.expiresAt <= now) this.commentSessionCache.delete(k);
    }
    for (const [k, v] of this.aiReplyDrafts) {
      if (v.expiresAt <= now) this.aiReplyDrafts.delete(k);
    }
    for (const [k, v] of this.catalogTmdbCache) {
      if (v.expiresAt <= now) this.catalogTmdbCache.delete(k);
    }
    for (const [uid, sess] of this.activeUnirSessions) {
      if (now - sess.createdAt > 6 * 3600_000) {
        for (const rel of sess.partRelativePaths) {
          try {
            this.safeRm(resolveConfinedScratchPath(rel));
          } catch {
            // Ignore
          }
        }
        this.activeUnirSessions.delete(uid);
      }
    }
    stateStore.resetDailyQuotasIfNeeded();
  }

  private startBackgroundLoops(): void {
    this.stopBackgroundLoops();

    this.alertsTimer = setInterval(() => {
      void pictaService.scanAllPictaAlertsAndMilestones(async (uid, msg) => {
        const u = stateStore.users.find((x) => x.telegramUserId === uid);
        if (u && !u.alertsEnabled) return false;
        return this.sendMessage(uid, msg);
      });
    }, stateStore.config.alertsIntervalMs);
    this.alertsTimer.unref();

    this.nomadTimer = setInterval(() => {
      void pictaService.runNomadEncoderRetrySweep((uid, msg) => this.sendMessage(uid, msg));
    }, stateStore.config.nomadRetryIntervalMs);
    this.nomadTimer.unref();

    this.queueTimer = setInterval(() => {
      void this.processNextQueuedJob();
    }, 3500);
    this.queueTimer.unref();

    this.housekeepTimer = setInterval(() => {
      this.runMemoryHousekeeping();
    }, 15 * 60_000);
    this.housekeepTimer.unref();
  }

  private stopBackgroundLoops(): void {
    if (this.alertsTimer) {
      clearInterval(this.alertsTimer);
      this.alertsTimer = null;
    }
    if (this.nomadTimer) {
      clearInterval(this.nomadTimer);
      this.nomadTimer = null;
    }
    if (this.queueTimer) {
      clearInterval(this.queueTimer);
      this.queueTimer = null;
    }
    if (this.housekeepTimer) {
      clearInterval(this.housekeepTimer);
      this.housekeepTimer = null;
    }
  }

  public async shutdown(): Promise<void> {
    this.stopPollingLoop();
    this.stopBackgroundLoops();
    stateStore.persistAll();
    await mtprotoPool.disconnect();
  }

  public async getTelemetry(): Promise<RuntimeTelemetry> {
    const binaries = await inspectSystemBinaries();
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
      isCloudRunDetected: this.isCloudRunDetected,
      telegram: {
        mode: stateStore.config.telegramMode,
        botConfigured: Boolean(this.getBotToken()),
        botUsername: this.botUsername,
        pollingActive: this.pollingActive,
        webhookActive: this.webhookActive,
        webhookUrl: this.webhookUrl,
        updatesProcessed: this.updatesProcessed,
        lastPollAt: this.lastPollAt,
        lastError: this.lastError,
      },
      mtproto: mtprotoPool.getStatus(),
      picta: pictaService.getStatus(),
      vault: getVaultConfigStatus(),
      binaries,
    };
  }
}

export const telegramRuntime = new TelegramBotRuntime();
