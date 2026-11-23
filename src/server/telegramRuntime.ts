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
  buildSerieTitleOptions,
  enrichMetadataWithGemini,
  generateAiCommentReply,
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
  escHtml,
  getTelegramBotToken,
  tgAnswerCallback,
  tgDeleteMessage,
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

interface UploadWizardDraft {
  id: string;
  userId: string;
  chatId: number;
  messageId?: number;
  source: 'telegram_mtproto' | 'unir_assembler';
  sourceMessageId?: number;
  unirPartPaths?: string[];
  fileName: string;
  sizeBytes: number;
  title: string;
  description: string;
  tipologia: number;
  clasificacion: string;
  keywords: string;
  publicado: boolean;
  descargable: boolean;
  autoPromo: boolean;
  serieId?: number;
  serieName?: string;
  temporada: string;
  numero: string;
  episodeSubtitle?: string;
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
  | { kind: 'cat_search'; chatId: number; expiresAt: number }
  | { kind: 'cat_title'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'cat_desc'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'cat_cover'; videoId: string; chatId: number; expiresAt: number }
  | { kind: 'ser_new'; chatId: number; attachDraftId?: string; expiresAt: number }
  | { kind: 'lis_new'; chatId: number; expiresAt: number }
  | { kind: 'com_reply'; commentId: number; pubId: number; chatId: number; expiresAt: number }
  | { kind: 'promo_add'; chatId: number; expiresAt: number };

const fmtMb = (bytes: number) => `${(bytes / 1024 ** 2).toFixed(1)} MB`;
const fmtGb = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GB`;

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

    // Start Telegram Bot API polling/webhook immediately so commands respond even while MTProto connects
    await this.applyTransportMode();
    if (this.getBotToken()) {
      void tgRegisterDefaultCommands();
    }

    // Connect MTProto FastSocket in parallel without blocking bot command handling
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

  // ===========================================================================
  // UI RENDERERS (IN-PLACE MESSAGE EDITING)
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

    const text = [
      `<b>🎬 PictaBot 24/7 — Centro de Control</b>`,
      ``,
      `📺 <b>Canal activo:</b> ${escHtml(activeChannelLabel)}`,
      `⚙️ <b>Modo de subida:</b> ${modeLabel}`,
      `📦 <b>Cola activa:</b> ${activeJobs} trabajo(s) · <b>Peticiones:</b> ${pendingReqs}`,
      `📊 <b>Cuota hoy:</b> ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB (${user.filesToday}/${user.dailyMaxFiles} archivos)`,
      `✨ <b>IA Gemini:</b> ${isGeminiConfigured() ? 'Activa' : 'Sin GEMINI_API_KEY'}`,
      ``,
      `<i>Envía un video/archivo directamente para subir, o usa /unir para unir partes/ZIP/TAR.</i>`,
    ].join('\n');

    const rows: InlineKeyboardButton[][] = [
      [
        { text: '🎬 Catálogo', callback_data: 'm:cat:1' },
        { text: '📺 Series', callback_data: 'm:ser' },
        { text: '📋 Listas', callback_data: 'm:lis' },
      ],
      [
        { text: '💬 Comentarios IA', callback_data: 'm:com:u:0' },
        { text: `🙋 Peticiones (${pendingReqs})`, callback_data: 'm:req:0' },
      ],
      [
        { text: '📢 Promos', callback_data: 'm:prm' },
        { text: `Modo: ${modeLabel}`, callback_data: 'm:mode' },
      ],
      [
        { text: `📥 Cola (${activeJobs})`, callback_data: 'm:col' },
        { text: '📊 Stats y Alertas', callback_data: 'm:sta' },
        { text: '🚨 Denuncias', callback_data: 'm:den' },
      ],
      [
        { text: '🔑 Cuenta Picta', callback_data: 'm:acc' },
        ...(isMaster || user.role === 'admin' ? [{ text: '🛡️ Admin y Bóveda', callback_data: 'm:adm' }] : []),
      ],
    ];

    const markup: InlineKeyboardMarkup = { inline_keyboard: rows };
    if (editMessageId) {
      const ok = await tgEditMessage(chatId, editMessageId, text, markup);
      if (ok) return;
    }
    await tgSendMessage(chatId, text, markup);
  }

  private async renderWizardCard(draft: UploadWizardDraft, editMessageId?: number): Promise<void> {
    const tipName = PICTA_TIPOLOGIAS[draft.tipologia] || `ID ${draft.tipologia}`;
    const coverInfo = draft.customCoverPath
      ? 'Foto personalizada'
      : draft.coverUrl
      ? 'Carátula TMDB'
      : 'Fotograma automático (ffmpeg)';
    const serieLine =
      draft.tipologia === 5
        ? `📺 <b>Serie:</b> ${draft.serieName ? escHtml(draft.serieName) : 'Sin vincular'} (T${draft.temporada} Cap. ${draft.numero})`
        : '';

    const text = [
      `<b>🧭 Asistente de Subida a Picta</b>`,
      ``,
      `🎞️ <b>Título:</b> ${escHtml(draft.title)}`,
      `📝 <b>Sinopsis:</b> ${escHtml(draft.description ? draft.description.slice(0, 240) : 'Sin sinopsis (puedes usar TMDB o IA)')}`,
      `📂 <b>Tipología:</b> ${escHtml(tipName)} · <b>Clasif.:</b> ${escHtml(draft.clasificacion)}`,
      ...(serieLine ? [serieLine] : []),
      `🖼️ <b>Portada:</b> ${coverInfo}`,
      `📦 <b>Archivo:</b> ${escHtml(draft.fileName)} (${fmtMb(draft.sizeBytes)})`,
      `⚙️ <b>Opciones:</b> ${draft.publicado ? 'Público' : 'Oculto'} · ${draft.descargable ? 'Descargable' : 'Solo stream'} · ${draft.autoPromo ? 'Auto-Promo SÍ' : 'Auto-Promo NO'}`,
    ].join('\n');

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '✅ Confirmar y Subir', callback_data: `w:go:${draft.id}` },
          { text: '❌ Cancelar', callback_data: `w:can:${draft.id}` },
        ],
        [
          { text: '🎬 TMDB Top-3', callback_data: `w:tmdb:${draft.id}` },
          { text: '✨ Mejorar con IA', callback_data: `w:ai:${draft.id}` },
        ],
        [
          { text: `📂 ${tipName}`, callback_data: `w:tip:${draft.id}` },
          { text: '📺 Vincular Serie', callback_data: `w:ser:${draft.id}` },
        ],
        [
          { text: '✏️ Título', callback_data: `w:tit:${draft.id}` },
          { text: '📝 Sinopsis', callback_data: `w:des:${draft.id}` },
          { text: '🖼️ Portada', callback_data: `w:cov:${draft.id}` },
        ],
        [
          { text: draft.publicado ? '👁️ Público: SÍ' : '👁️ Público: NO', callback_data: `w:pub:${draft.id}` },
          { text: draft.descargable ? '⬇️ Descarga: SÍ' : '⬇️ Descarga: NO', callback_data: `w:dl:${draft.id}` },
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
    search?: string,
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

    const res = await pictaService.fetchChannelPublications({ ctx, page, pageSize: 5, search });
    const lines = [
      `<b>🎬 Catálogo — ${escHtml(ctx.channelName)}</b>`,
      search ? `🔍 Filtro: <i>${escHtml(search)}</i> · Página ${page} (${res.total} total)` : `Página ${page} · ${res.total} publicación(es)`,
      ``,
    ];

    const rows: InlineKeyboardButton[][] = [];
    if (res.items.length === 0) {
      lines.push('No se encontraron publicaciones en esta página.');
    } else {
      res.items.forEach((item, idx) => {
        const vis = item.publicado ? '🟢' : '🔒';
        lines.push(
          `${idx + 1}. ${vis} <b>${escHtml(item.nombre.slice(0, 52))}</b>\n   👁 ${item.cantidad_vistas} · ❤️ ${item.cantidad_me_gusta} · 💬 ${item.cantidad_comentarios} · ${escHtml(item.tipologiaNombre)}`
        );
        rows.push([{ text: `${idx + 1}. ${item.nombre.slice(0, 38)}`, callback_data: `cv:${item.id}` }]);
      });
    }

    const navRow: InlineKeyboardButton[] = [];
    if (page > 1) navRow.push({ text: '⬅️ Anterior', callback_data: `m:cat:${page - 1}` });
    navRow.push({ text: '🔍 Buscar', callback_data: 'm:catsearch' });
    if (res.hasNext) navRow.push({ text: 'Siguiente ➡️', callback_data: `m:cat:${page + 1}` });
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
      `🆔 ID: <code>${escHtml(item.id)}</code> · ${escHtml(item.tipologiaNombre)} · ${escHtml(item.clasificacion)}`,
      `👁 ${item.cantidad_vistas} vistas · ❤️ ${item.cantidad_me_gusta} likes · 💬 ${item.cantidad_comentarios} com. · ⬇️ ${item.cantidad_descargas} desc.`,
      `⚙️ ${item.publicado ? 'Publicado' : 'Oculto'} · ${item.descargable ? 'Descargable' : 'Sin descarga'}`,
      ``,
      `📝 ${escHtml(item.descripcion ? item.descripcion.slice(0, 420) : 'Sin sinopsis')}`,
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
          { text: '🎬 Datos TMDB', callback_data: `ce:tmdb:${item.id}` },
        ],
        [
          { text: item.publicado ? '🔒 Ocultar' : '👁️ Publicar', callback_data: `ce:pub:${item.id}` },
          { text: item.descargable ? '🚫 Quitar descarga' : '⬇️ Permitir descarga', callback_data: `ce:dl:${item.id}` },
        ],
        [
          { text: '📢 Difundir en Promos', callback_data: `ce:prm:${item.id}` },
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

  private async renderSeriesView(chatId: number, userId: string, editMessageId?: number): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const series = await pictaService.fetchChannelSeries(ctx);
    const lines = [`<b>📺 Series — ${escHtml(ctx.channelName)}</b>`, `Total: ${series.length} serie(s). Toca para fijar/desfijar como favorita.`, ``];
    const rows: InlineKeyboardButton[][] = [];

    if (series.length === 0) {
      lines.push('No hay series creadas en este canal todavía.');
    } else {
      series.slice(0, 10).forEach((s) => {
        const pinIcon = s.pinned ? '📌 ' : '';
        lines.push(`${pinIcon}<b>${escHtml(s.nombre)}</b> · ${s.cantidad_capitulos} cap.`);
        rows.push([{ text: `${s.pinned ? '📌 Desfijar' : '📍 Fijar'}: ${s.nombre.slice(0, 32)}`, callback_data: `ser:pin:${s.id}` }]);
      });
    }

    rows.push([{ text: '➕ Crear Nueva Serie', callback_data: 'ser:new' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
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
    const lines = [`<b>📋 Listas de Reproducción — ${escHtml(ctx.channelName)}</b>`, ``];
    if (lists.length === 0) {
      lines.push('No hay listas de reproducción todavía.');
    } else {
      lists.slice(0, 12).forEach((l, i) => {
        lines.push(`${i + 1}. <b>${escHtml(l.nombre)}</b> (${l.publicacionesIds.length} videos)`);
      });
    }

    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), {
      inline_keyboard: [[{ text: '➕ Nueva Lista', callback_data: 'lis:new' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
    });
  }

  private async renderCommentsView(
    chatId: number,
    userId: string,
    filter: 'u' | 'a',
    index: number,
    forceRefresh = false,
    editMessageId?: number
  ): Promise<void> {
    let ctx: PictaAuthContext;
    try {
      ctx = await pictaService.resolveContextForUser(userId);
    } catch (err) {
      await this.showOrEdit(chatId, editMessageId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      return;
    }

    const cacheKey = `${userId}:${ctx.channelId}`;
    const cached = this.commentSessionCache.get(cacheKey);
    let comments: PictaCommentItem[];
    if (!forceRefresh && cached && cached.expiresAt > Date.now()) {
      comments = cached.items;
    } else {
      comments = await pictaService.fetchChannelComments(ctx, 30);
      this.commentSessionCache.set(cacheKey, { items: comments, expiresAt: Date.now() + 3 * 60_000 });
    }

    const ignoredSet = new Set(stateStore.ignoredCommentIds);
    const filtered = comments.filter((c) => {
      if (ignoredSet.has(c.id)) return false;
      return filter === 'u' ? !c.answered : true;
    });

    const toggleRow: InlineKeyboardButton[] = [
      { text: filter === 'u' ? '• Sin responder •' : 'Sin responder', callback_data: 'm:com:u:0' },
      { text: filter === 'a' ? '• Todos •' : 'Todos', callback_data: 'm:com:a:0' },
      { text: '🔄 Recargar', callback_data: `m:comr:${filter}` },
    ];

    if (filtered.length === 0) {
      await this.showOrEdit(
        chatId,
        editMessageId,
        `<b>💬 Comentarios — ${escHtml(ctx.channelName)}</b>\n\nNo hay comentarios ${filter === 'u' ? 'pendientes sin responder' : 'recientes'}.`,
        { inline_keyboard: [toggleRow, [{ text: '🏠 Menú Principal', callback_data: 'm:home' }]] }
      );
      return;
    }

    const safeIdx = Math.max(0, Math.min(index, filtered.length - 1));
    const c = filtered[safeIdx];
    const reqTag = c.isLikelyRequest ? ' · 🙋 Petición detectada' : '';

    const text = [
      `<b>💬 Comentario ${safeIdx + 1}/${filtered.length}</b> (${filter === 'u' ? 'Sin responder' : 'Todos'})`,
      `🎞️ <b>Video:</b> ${escHtml(c.publicacionNombre)}`,
      `👤 <b>Usuario:</b> ${escHtml(c.usuario)}${reqTag}`,
      `📅 ${escHtml(c.fecha ? c.fecha.slice(0, 16).replace('T', ' ') : 'Reciente')} · ${c.answered ? `✅ ${c.replyCount} resp.` : '⏳ Pendiente'}`,
      ``,
      `“${escHtml(c.texto.slice(0, 800))}”`,
    ].join('\n');

    const navRow: InlineKeyboardButton[] = [];
    if (safeIdx > 0) navRow.push({ text: '⬅️ Ant.', callback_data: `m:com:${filter}:${safeIdx - 1}` });
    if (safeIdx < filtered.length - 1) navRow.push({ text: 'Sig. ➡️', callback_data: `m:com:${filter}:${safeIdx + 1}` });

    const rows: InlineKeyboardButton[][] = [
      toggleRow,
      [
        { text: '✨ Sugerir respuesta IA', callback_data: `cm:ai:${c.id}:${c.publicacionId}` },
        { text: '✍️ Responder manual', callback_data: `cm:man:${c.id}:${c.publicacionId}` },
      ],
      [
        { text: '🙈 Ignorar', callback_data: `cm:ign:${c.id}` },
        ...navRow,
      ],
      [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
    ];

    await this.showOrEdit(chatId, editMessageId, text, { inline_keyboard: rows });
  }

  private async renderRequestsView(chatId: number, page: number, editMessageId?: number): Promise<void> {
    const pending = stateStore.channelRequests.filter((r) => r.status === 'pending');
    const lines = [`<b>🙋 Peticiones de Audiencia</b> (${pending.length} pendiente(s))`, ``];
    const rows: InlineKeyboardButton[][] = [];

    if (pending.length === 0) {
      lines.push('No hay peticiones pendientes. Se detectan automáticamente al revisar /comentarios.');
    } else {
      const start = page * 4;
      const slice = pending.slice(start, start + 4);
      slice.forEach((req, idx) => {
        const globalIdx = start + idx;
        lines.push(
          `${globalIdx + 1}. <b>${escHtml(req.requestedTitle)}</b>\n   👤 ${escHtml(req.requesterName)} en <i>${escHtml(req.sourceVideoTitle.slice(0, 35))}</i>\n   “${escHtml(req.rawText.slice(0, 120))}”`
        );
        rows.push([
          { text: `✅ Cumplida #${globalIdx + 1}`, callback_data: `rq:ok:${req.id.slice(0, 12)}` },
          { text: `🗑️ Descartar #${globalIdx + 1}`, callback_data: `rq:ign:${req.id.slice(0, 12)}` },
        ]);
      });

      const nav: InlineKeyboardButton[] = [];
      if (page > 0) nav.push({ text: '⬅️ Anterior', callback_data: `m:req:${page - 1}` });
      if (start + 4 < pending.length) nav.push({ text: 'Siguiente ➡️', callback_data: `m:req:${page + 1}` });
      if (nav.length > 0) rows.push(nav);
    }

    rows.push([{ text: '💬 Revisar Comentarios', callback_data: 'm:com:u:0' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderPromosView(chatId: number, editMessageId?: number): Promise<void> {
    const promos = stateStore.promoChannels;
    const lines = [`<b>📢 Canales Promocionales (${promos.length})</b>`, `Difunde estrenos con portada y enlace automáticamente o desde /catalogo.`, ``];
    const rows: InlineKeyboardButton[][] = [];

    if (promos.length === 0) {
      lines.push('No hay canales promocionales configurados todavía.');
    } else {
      promos.forEach((p, idx) => {
        lines.push(`${idx + 1}. <b>${escHtml(p.name)}</b> (<code>${escHtml(p.telegramChatId)}</code>) · Auto-post: ${p.autoPostEnabled ? 'SÍ' : 'NO'}`);
        rows.push([
          { text: `${p.autoPostEnabled ? '🟢 Auto' : '⚪ Manual'}: ${p.name.slice(0, 20)}`, callback_data: `pr:tog:${idx}` },
          { text: '🗑️ Quitar', callback_data: `pr:del:${idx}` },
        ]);
      });
    }

    rows.push([{ text: '➕ Agregar Canal Promo', callback_data: 'pr:add' }, { text: '🏠 Menú', callback_data: 'm:home' }]);
    await this.showOrEdit(chatId, editMessageId, lines.join('\n'), { inline_keyboard: rows });
  }

  private async renderQueueView(chatId: number, user: AuthorizedUser, editMessageId?: number): Promise<void> {
    const disk = await getDiskStatusReport();
    const recent = stateStore.jobs.slice(0, 8);
    const lines = [
      `<b>📥 Cola de Subidas y Disco</b>`,
      `Estado cola: <b>${stateStore.config.queuePaused ? '⏸️ Pausada' : '▶️ Activa'}</b> · Disco: <b>${disk.usagePct}%</b> (${fmtGb(disk.budgetRemainingBytes)} libres)`,
      ``,
    ];

    if (recent.length === 0) {
      lines.push('La cola está vacía.');
    } else {
      for (const j of recent) {
        const spd = j.speedMbps ? ` · ${j.speedMbps} MB/s` : '';
        lines.push(`• <b>${escHtml(j.title.slice(0, 40))}</b> [${j.status}] ${j.progressPct}%${spd}`);
      }
    }

    const rows: InlineKeyboardButton[][] = [
      [
        { text: '🔄 Actualizar', callback_data: 'm:col' },
        { text: '🔁 Reintentar fallidos', callback_data: 'cl:retry' },
      ],
    ];
    if (user.role === 'admin' || stateStore.isMasterAdmin(user.telegramUserId)) {
      rows.push([
        { text: stateStore.config.queuePaused ? '▶️ Reanudar Cola' : '⏸️ Pausar Cola', callback_data: 'cl:pause' },
        { text: '🧹 Purgar Scratch', callback_data: 'cl:purge' },
      ]);
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

    rows.push([{ text: '🏠 Menú Principal', callback_data: 'm:home' }]);
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
      `⚡ <b>MTProto FastSocket:</b> ${mt.connected ? 'Conectado' : 'En espera'} (${mt.safeParallelWorkers}w / ${mt.activeSockets} TCP)`,
      `💾 <b>Disco:</b> ${disk.usagePct}% (${fmtGb(disk.budgetRemainingBytes)} libres · presión ${disk.pressureLevel})`,
      `🧰 <b>Binarios:</b> ffmpeg=${bins.ffmpeg.available ? 'OK' : 'NO'} · unzip=${bins.unzip.available ? 'OK' : 'NO'} · tar=${bins.tar.available ? 'OK' : 'NO'}`,
      `👥 <b>Usuarios:</b> ${stateStore.users.length} (${stateStore.userSessions.length} sesiones Picta aisladas)`,
      `🔐 <b>Bóveda:</b> ${vault.snapshotsCount} respaldo(s) · Último: ${vault.lastSyncAt ? vault.lastSyncAt.slice(0, 16).replace('T', ' ') : 'Ninguno'}`,
    ].join('\n');

    const markup: InlineKeyboardMarkup = {
      inline_keyboard: [
        [
          { text: '☁️ Backup Bóveda', callback_data: 'vt:bak' },
          { text: '♻️ Restaurar Nube', callback_data: 'vt:res' },
        ],
        [
          { text: '👥 Usuarios y Cuotas', callback_data: 'us:list' },
          { text: '📡 Ver /netlog', callback_data: 'ad:netlog' },
        ],
        [
          { text: '🧹 Purgar Scratch', callback_data: 'cl:purge' },
          { text: '🔁 Barrido Nomad', callback_data: 'al:nomad' },
        ],
        [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
      ],
    };

    await this.showOrEdit(chatId, editMessageId, text, markup);
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
  // QUEUE WORKER (DIRECT MTPROTO + /UNIR ASSEMBLER)
  // ===========================================================================

  private async enqueueFromWizardDraft(draft: UploadWizardDraft, user: AuthorizedUser): Promise<TransferJob> {
    let ctx: PictaAuthContext | undefined;
    try {
      ctx = await pictaService.resolveContextForUser(user.telegramUserId);
    } catch {
      // Will surface cleanly in worker if credentials missing
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
      publicado: draft.publicado,
      descargable: draft.descargable,
      autoPromo: draft.autoPromo,
      serieId: draft.serieId,
      temporada: draft.temporada,
      numero: draft.numero,
      coverUrl: draft.coverUrl,
      posterUrl: draft.posterUrl,
      customCoverPath: draft.customCoverPath,
      telegramChatId: String(draft.chatId),
      telegramMessageId: draft.sourceMessageId,
      statusMessageId: draft.messageId,
      scratchPath:
        draft.source === 'telegram_mtproto'
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
      .find((j) => j.status === 'queued' && j.source === 'telegram_mtproto' && j.telegramChatId && j.telegramMessageId);
    if (!job) return;

    this.queueWorkerBusy = true;
    let lastTgEditAt = 0;

    try {
      const ctx = await pictaService.resolveContextForUser(job.userId);
      job.pictaChannel = ctx.channelName;
      job.pictaChannelId = ctx.channelId;
      job.status = 'downloading';
      job.progressPct = 5;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      await this.updateJobStatusMessage(
        job,
        `⬇️ <b>Descargando (MTProto FastSocket)...</b>\n🎞️ ${escHtml(job.title)}\n📦 ${fmtMb(job.sizeBytes)} · Canal: ${escHtml(ctx.channelName)}`
      );

      const relPath = job.scratchPath || `job_${job.id.slice(0, 8)}_${job.fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`;
      job.scratchPath = relPath;

      const dl = await mtprotoPool.downloadTelegramMessageMedia({
        chatId: job.telegramChatId!,
        messageId: job.telegramMessageId!,
        expectedBytes: job.sizeBytes,
        targetRelativePath: relPath,
        onProgress: (downloadedBytes, totalBytes, speedMbps) => {
          job.downloadedBytes = downloadedBytes;
          job.speedMbps = speedMbps || job.speedMbps;
          job.progressPct = Math.min(48, Math.max(5, Math.round((downloadedBytes / Math.max(1, totalBytes)) * 48)));
          job.updatedAt = new Date().toISOString();
          const now = Date.now();
          if (now - lastTgEditAt >= 3500) {
            lastTgEditAt = now;
            void this.updateJobStatusMessage(
              job,
              `⬇️ <b>Descargando MTProto</b> (${job.progressPct}% · ${job.speedMbps} MB/s)\n🎞️ ${escHtml(job.title)}\n📦 ${fmtMb(downloadedBytes)} / ${fmtMb(totalBytes)}`
            );
          }
        },
      });

      job.status = 'uploading';
      job.downloadedBytes = dl.bytesWritten;
      job.progressPct = 50;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      await this.updateJobStatusMessage(
        job,
        `⬆️ <b>Subiendo a Picta S3 MinIO...</b>\n🎞️ ${escHtml(job.title)}\n📺 Canal: ${escHtml(ctx.channelName)}`
      );

      const uploadRes = await pictaService.uploadVideoToPictaPipeline({
        ctx,
        filePath: dl.filePath,
        fileName: job.fileName,
        title: job.title,
        description: job.description,
        tipologia: job.tipologia || 8,
        clasificacion: job.clasificacion,
        keywords: job.keywords,
        publicado: job.publicado,
        descargable: job.descargable,
        serieId: job.serieId,
        temporada: job.temporada,
        numero: job.numero,
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

      // Reclaim scratch & temporary custom cover immediately
      this.safeRm(dl.filePath);
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
          { text: '📢 Difundir en Promos', callback_data: `ce:prm:${uploadRes.publicationId}` },
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
      if (job.customCoverPath) this.safeRm(job.customCoverPath);
      netlog.error('picta', `Fallo transferencia "${job.title}": ${msg}`);
      await this.updateJobStatusMessage(job, `❌ <b>Error procesando "${escHtml(job.title)}"</b>\n${escHtml(msg)}`);
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
        publicado: job.publicado,
        descargable: job.descargable,
        serieId: job.serieId,
        temporada: job.temporada,
        numero: job.numero,
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

      await this.updateJobStatusMessage(
        job,
        `✅ <b>Ensamblaje /unir publicado en Picta</b>\n🎞️ <b>${escHtml(job.title)}</b>\n🆔 ID: <code>${escHtml(uploadRes.publicationId || 'N/A')}</code>`,
        uploadRes.webUrl ? { inline_keyboard: [[{ text: '🔗 Abrir en Picta', url: uploadRes.webUrl }]] } : undefined
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
    source: 'telegram_mtproto' | 'unir_assembler';
    fileName: string;
    sizeBytes: number;
    caption?: string;
    sourceMessageId?: number;
    unirPartPaths?: string[];
  }): Promise<void> {
    const analyzed = analyzeVideoTitleAndSynopsis(params.fileName, params.caption);
    const draftId = crypto.randomBytes(4).toString('hex');
    const draft: UploadWizardDraft = {
      id: draftId,
      userId: params.user.telegramUserId,
      chatId: params.chatId,
      source: params.source,
      sourceMessageId: params.sourceMessageId,
      unirPartPaths: params.unirPartPaths,
      fileName: params.fileName,
      sizeBytes: params.sizeBytes,
      title: analyzed.initialTitle,
      description: analyzed.initialSynopsis,
      tipologia: analyzed.suggestedTipologia,
      clasificacion: (process.env.PICTA_CLASIFICACION || '+16').trim(),
      keywords: '',
      publicado: true,
      descargable: true,
      autoPromo: stateStore.promoChannels.some((p) => p.autoPostEnabled),
      temporada: analyzed.seriesInfo.temporada,
      numero: analyzed.seriesInfo.numero,
      episodeSubtitle: analyzed.seriesInfo.episodeSubtitle,
      tmdbCandidates: [],
      createdAt: Date.now(),
    };

    // FAST MODE: auto-enrich with high-confidence TMDB + Gemini AI and enqueue immediately
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
          draft.coverUrl = best.backdropUrl || best.posterUrl;
          draft.posterUrl = best.posterUrl;
          draft.tipologia = best.mediaType === 'tv' ? 5 : 1;
        }
        if (!draft.description && isGeminiConfigured()) {
          const aiRes = await enrichMetadataWithGemini({
            title: draft.title,
            mediaType: draft.tipologia === 5 ? 'tv' : draft.tipologia === 1 ? 'movie' : 'video',
            existingOverview: draft.description,
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

    // WIZARD MODE: interactive inline card
    this.wizardDrafts.set(draftId, draft);
    await this.renderWizardCard(draft);
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
    const text = (msg.text || '').trim();

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
      // Immediately delete password message from Telegram chat!
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
        const created = await pictaService.createSerie(ctx, { nombre: text.slice(0, 100) });
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
        await tgSendMessage(chatId, `✅ Serie creada: <b>${escHtml(created.nombre)}</b> (#${created.id})`);
        await this.renderSeriesView(chatId, userId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
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
        await this.renderPlaylistsView(chatId, userId);
      } catch (err) {
        await tgSendMessage(chatId, `❌ ${escHtml(err instanceof Error ? err.message : String(err))}`);
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

    return false;
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

      if (data === 'm:mode') {
        user.uploadMode = user.uploadMode === 'fast' ? 'wizard' : 'fast';
        stateStore.saveUsers();
        await tgAnswerCallback(
          cq.id,
          user.uploadMode === 'fast' ? '⚡ Modo Rápido activado' : '🧭 Modo Asistente activado'
        );
        await this.renderMainMenu(chatId, user, msgId);
        return;
      }

      if (prefix === 'm' && parts[1] === 'cat') {
        await tgAnswerCallback(cq.id);
        await this.renderCatalogPage(chatId, userId, Number(parts[2] || 1), undefined, msgId);
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
        if (action === 'ai') {
          await tgAnswerCallback(cq.id, '✨ Pulido con Gemini IA...');
          const ctx = await pictaService.resolveContextForUser(userId);
          const item = await pictaService.fetchPublicationById(vid, ctx);
          if (!item) return;
          const aiRes = await enrichMetadataWithGemini({ title: item.nombre, existingOverview: item.descripcion });
          if (!aiRes) {
            await tgSendMessage(chatId, '⚠️ Gemini IA no disponible (verifica GEMINI_API_KEY en el servidor).');
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
          const matches = await searchTmdbRichCandidates(item.nombre);
          if (matches.length === 0) {
            await tgSendMessage(chatId, `Sin resultados en TMDB para "${escHtml(item.nombre)}".`);
            return;
          }
          const best = matches[0];
          await pictaService.patchPublication(ctx, vid, {
            nombre: best.year ? `${best.title} (${best.year})` : best.title,
            ...(best.overview ? { descripcion: best.overview } : {}),
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

      // Series & Playlists
      if (data === 'm:ser') {
        await tgAnswerCallback(cq.id);
        await this.renderSeriesView(chatId, userId, msgId);
        return;
      }
      if (prefix === 'ser' && parts[1] === 'pin') {
        const sid = Number(parts[2]);
        const idx = stateStore.pinnedSeriesIds.indexOf(sid);
        if (idx >= 0) stateStore.pinnedSeriesIds.splice(idx, 1);
        else stateStore.pinnedSeriesIds.push(sid);
        stateStore.savePinnedSeries();
        await tgAnswerCallback(cq.id, idx >= 0 ? 'Serie desfijada' : '📌 Serie fijada como favorita');
        await this.renderSeriesView(chatId, userId, msgId);
        return;
      }
      if (data === 'ser:new') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'ser_new', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '📺 Escribe el nombre de la nueva serie a crear en Picta (o /cancelar):');
        return;
      }
      if (data === 'm:lis') {
        await tgAnswerCallback(cq.id);
        await this.renderPlaylistsView(chatId, userId, msgId);
        return;
      }
      if (data === 'lis:new') {
        await tgAnswerCallback(cq.id);
        this.pendingInputs.set(userId, { kind: 'lis_new', chatId, expiresAt: Date.now() + 5 * 60_000 });
        await tgSendMessage(chatId, '📋 Escribe el nombre de la nueva lista de reproducción (o /cancelar):');
        return;
      }

      // Comments & AI Replies
      if (prefix === 'm' && parts[1] === 'com') {
        await tgAnswerCallback(cq.id);
        await this.renderCommentsView(chatId, userId, parts[2] === 'a' ? 'a' : 'u', Number(parts[3] || 0), false, msgId);
        return;
      }
      if (prefix === 'm' && parts[1] === 'comr') {
        await tgAnswerCallback(cq.id, '🔄 Actualizando comentarios...');
        await this.renderCommentsView(chatId, userId, parts[2] === 'a' ? 'a' : 'u', 0, true, msgId);
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
          const cached = this.commentSessionCache.get(`${userId}:${ctx.channelId}`);
          const target = cached?.items.find((x) => x.id === cid);
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
            await tgSendMessage(chatId, '⚠️ Gemini IA no disponible (verifica GEMINI_API_KEY).');
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
        const status = parts[1] === 'ok' ? 'fulfilled' : 'ignored';
        const shortId = parts[2];
        const rec = stateStore.channelRequests.find((r) => r.id.startsWith(shortId));
        if (rec) {
          rec.status = status;
          stateStore.saveChannelRequests();
        }
        await tgAnswerCallback(cq.id, status === 'fulfilled' ? '✅ Petición marcada cumplida' : '🗑️ Descartada');
        await this.renderRequestsView(chatId, 0, msgId);
        return;
      }
      if (data === 'm:den') {
        await tgAnswerCallback(cq.id);
        const ctx = await pictaService.resolveContextForUser(userId);
        const den = await pictaService.fetchDenunciasSummary(ctx);
        await this.showOrEdit(
          chatId,
          msgId,
          [
            `<b>🚨 Denuncias — ${escHtml(ctx.channelName)}</b>`,
            ``,
            `• Pendientes: <b>${den.cantidad_pendientes}</b>`,
            `• En proceso: <b>${den.cantidad_en_proceso}</b>`,
            `• Procesadas: <b>${den.cantidad_procesadas}</b>`,
            `• No proceden: <b>${den.cantidad_no_proceden}</b>`,
            `• Total histórico: <b>${den.total}</b>`,
          ].join('\n'),
          { inline_keyboard: [[{ text: '🏠 Menú Principal', callback_data: 'm:home' }]] }
        );
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
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:pause' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
        stateStore.config.queuePaused = !stateStore.config.queuePaused;
        stateStore.saveConfig();
        await tgAnswerCallback(cq.id, stateStore.config.queuePaused ? '⏸️ Cola pausada' : '▶️ Cola reanudada');
        await this.renderQueueView(chatId, user, msgId);
        return;
      }
      if (data === 'cl:purge' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
        const res = await cleanupOrphanedScratchFiles();
        await tgAnswerCallback(cq.id, `🧹 ${res.deletedCount} borrados (${fmtMb(res.freedBytes)})`, true);
        await this.renderQueueView(chatId, user, msgId);
        return;
      }

      // Stats & Alerts
      if (data === 'm:sta') {
        await tgAnswerCallback(cq.id);
        const ctx = await pictaService.resolveContextForUser(userId);
        const [profile, stats] = await Promise.all([
          pictaService.fetchChannelDetails(ctx),
          pictaService.fetchChannelStats(ctx),
        ]);
        const recentAlerts = stateStore.alerts.slice(0, 4);
        const lines = [
          `<b>📊 Estadísticas y Alertas — ${escHtml(profile?.nombre || ctx.channelName)}</b>`,
          profile
            ? `👥 Suscriptores: <b>${profile.cantidad_suscriptores}</b> · 🎬 Videos: <b>${profile.cantidad_publicaciones}</b>`
            : '',
          stats ? `\n<b>Resumen de hoy (La Habana):</b>\n<code>${escHtml(JSON.stringify(stats).slice(0, 600))}</code>` : '\n<i>Sin métricas diarias disponibles.</i>',
          ``,
          `<b>Últimas alertas (${stateStore.watchedVideos.length} videos vigilados):</b>`,
          ...(recentAlerts.length
            ? recentAlerts.map((a) => `• ${escHtml(a.videoTitle.slice(0, 32))}: ${escHtml(a.summary)}`)
            : ['• Sin alertas recientes.']),
        ].filter(Boolean);

        await this.showOrEdit(chatId, msgId, lines.join('\n'), {
          inline_keyboard: [
            [
              { text: '🔎 Escanear Alertas', callback_data: 'al:scan' },
              { text: '🔁 Barrido Nomad', callback_data: 'al:nomad' },
            ],
            [{ text: '🏠 Menú Principal', callback_data: 'm:home' }],
          ],
        });
        return;
      }
      if (data === 'al:scan') {
        await tgAnswerCallback(cq.id, '🔎 Escaneando Picta...');
        const r = await pictaService.scanAllPictaAlertsAndMilestones((uid, txt) => this.sendMessage(uid, txt));
        await tgSendMessage(chatId, `✅ Escaneo completo: ${r.scannedCount} videos vigilados, ${r.newAlerts.length} nuevas alertas.`);
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

      // Admin & Vault
      if (data === 'm:adm' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
        await tgAnswerCallback(cq.id);
        await this.renderAdminView(chatId, msgId);
        return;
      }
      if (data === 'vt:bak' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
        await tgAnswerCallback(cq.id, '☁️ Respaldando Bóveda...');
        const snap = await saveCloudStateToTelegramNow(true);
        await tgSendMessage(chatId, `🔐 <b>Bóveda:</b> ${escHtml(snap.message)}`);
        return;
      }
      if (data === 'vt:res' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
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
        await tgSendMessage(chatId, `<code>${escHtml(netlog.formatForTelegram(14))}</code>`);
        return;
      }
      if (data === 'us:list' && (user.role === 'admin' || stateStore.isMasterAdmin(userId))) {
        await tgAnswerCallback(cq.id);
        const lines = [
          `<b>👥 Usuarios Autorizados (${stateStore.users.length})</b>`,
          ...stateStore.users.map(
            (u) =>
              `• <code>${u.telegramUserId}</code> <b>${escHtml(u.displayName)}</b> [${u.role}] · ${u.uploadMode} · ${u.usedTodayGb.toFixed(1)}/${u.dailyQuotaGb} GB`
          ),
          ``,
          `<i>Agregar usuario:</i> <code>/adduser &lt;telegramId&gt; &lt;nombre&gt; [user|admin] [gb]</code>`,
        ];
        await this.showOrEdit(chatId, msgId, lines.join('\n'), {
          inline_keyboard: [[{ text: '⬅️ Admin', callback_data: 'm:adm' }, { text: '🏠 Menú', callback_data: 'm:home' }]],
        });
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
        if (action === 'prm') {
          draft.autoPromo = !draft.autoPromo;
          await tgAnswerCallback(cq.id, draft.autoPromo ? 'Auto-Promo: SÍ' : 'Auto-Promo: NO');
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
            const pair = entries.slice(i, i + 2).map(([k, v]) => ({
              text: Number(k) === draft.tipologia ? `✅ ${v}` : v,
              callback_data: `w:st:${draftId}:${k}`,
            }));
            rows.push(pair);
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
          const candidates = await searchTmdbRichCandidates(draft.title);
          draft.tmdbCandidates = candidates.slice(0, 3);
          if (draft.tmdbCandidates.length === 0) {
            await tgSendMessage(chatId, `Sin resultados en TMDB para "${escHtml(draft.title)}" (o falta TMDB_API_KEY).`);
            return;
          }
          const lines = [
            `<b>🎬 Top-3 resultados TMDB para "${escHtml(draft.title)}"</b>`,
            ``,
            ...draft.tmdbCandidates.map(
              (c, i) =>
                `${i + 1}. <b>${escHtml(c.title)}</b> (${c.year || 'S/F'}) · ${c.mediaType === 'tv' ? 'Serie' : 'Película'} ★${c.voteAverage ?? '-'}\n   <i>${escHtml(c.overview.slice(0, 140))}</i>`
            ),
          ];
          const rows: InlineKeyboardButton[][] = draft.tmdbCandidates.map((c, i) => [
            { text: `✅ ${i + 1}. ${c.title.slice(0, 32)} (${c.year || 'S/F'})`, callback_data: `w:tm:${draftId}:${i}` },
          ]);
          rows.push([{ text: '⬅️ Volver al asistente', callback_data: `w:back:${draftId}` }]);
          await this.showOrEdit(chatId, msgId, lines.join('\n'), { inline_keyboard: rows });
          return;
        }

        if (action === 'tm') {
          const idx = Number(parts[3] || 0);
          const picked = draft.tmdbCandidates[idx];
          if (picked) {
            draft.title = picked.year ? `${picked.title} (${picked.year})` : picked.title;
            if (picked.overview) draft.description = picked.overview;
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
          });
          if (!aiRes) {
            await tgSendMessage(chatId, '⚠️ Gemini IA no disponible (verifica GEMINI_API_KEY en el servidor).');
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
              `<b>📺 Serie vinculada: ${escHtml(chosen.nombre)}</b>\nElige el formato de título para el episodio:`,
              {
                inline_keyboard: [
                  ...opts.map((opt, idx) => [{ text: opt.slice(0, 46), callback_data: `w:ep:${draftId}:${idx}` }]),
                  [{ text: '⬅️ Mantener título actual', callback_data: `w:back:${draftId}` }],
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

    // Pending conversational input takes priority (except /start or /menu)
    const pending = this.pendingInputs.get(userId);
    if (pending && pending.expiresAt > Date.now() && !text.startsWith('/start') && !text.startsWith('/menu')) {
      const handled = await this.handlePendingInput(pending, msg, user);
      if (handled) return;
    } else if (pending) {
      this.pendingInputs.delete(userId);
    }

    if (text.startsWith('/start') || text.startsWith('/menu') || text.startsWith('/help')) {
      await this.renderMainMenu(chatId, user);
      return;
    }

    if (text.startsWith('/modo')) {
      user.uploadMode = user.uploadMode === 'fast' ? 'wizard' : 'fast';
      stateStore.saveUsers();
      await tgSendMessage(
        chatId,
        user.uploadMode === 'fast'
          ? '⚡ <b>Modo Rápido Automático</b> activado: al enviar videos detecto TMDB/IA y subo directo.'
          : '🧭 <b>Modo Asistente Completo</b> activado: al enviar videos podrás ajustar tipología, TMDB, IA, series y portada.'
      );
      return;
    }

    if (text.startsWith('/catalogo')) {
      const search = text.replace(/^\/catalogo\s*/i, '').trim() || undefined;
      await this.renderCatalogPage(chatId, userId, 1, search);
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
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const den = await pictaService.fetchDenunciasSummary(ctx);
        await tgSendMessage(
          chatId,
          `<b>🚨 Denuncias — ${escHtml(ctx.channelName)}</b>\nPendientes: ${den.cantidad_pendientes} · En proceso: ${den.cantidad_en_proceso} · Procesadas: ${den.cantidad_procesadas} · Total: ${den.total}`
        );
      } catch (err) {
        await tgSendMessage(chatId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return;
    }

    if (text.startsWith('/promos')) {
      await this.renderPromosView(chatId);
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

    if (text.startsWith('/estado') || text.startsWith('/status')) {
      await this.renderAdminView(chatId);
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
      if (user.role !== 'admin' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Solo administradores pueden purgar el disco temporal.');
        return;
      }
      const res = await cleanupOrphanedScratchFiles();
      await tgSendMessage(chatId, `🧹 Purga completada: ${res.deletedCount} elemento(s) borrados (${fmtMb(res.freedBytes)} liberados).`);
      return;
    }

    if (text.startsWith('/stats')) {
      try {
        const ctx = await pictaService.resolveContextForUser(userId);
        const stats = await pictaService.fetchChannelStats(ctx);
        await tgSendMessage(
          chatId,
          stats
            ? `<b>📊 Resumen Picta hoy (${escHtml(ctx.channelName)})</b>\n<code>${escHtml(JSON.stringify(stats, null, 2).slice(0, 1800))}</code>`
            : 'No se pudieron obtener estadísticas de hoy.'
        );
      } catch (err) {
        await tgSendMessage(chatId, `⚠️ ${escHtml(err instanceof Error ? err.message : String(err))}`);
      }
      return;
    }

    if (text.startsWith('/alertas')) {
      const r = await pictaService.scanAllPictaAlertsAndMilestones((uid, m) => this.sendMessage(uid, m));
      await tgSendMessage(chatId, `🔔 Escaneo completado: ${r.scannedCount} videos vigilados, ${r.newAlerts.length} nueva(s) alerta(s).`);
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
        await tgSendMessage(chatId, 'Uso: <code>/buscar nombre de película o serie</code>');
        return;
      }
      const results = await searchTmdbRichCandidates(query);
      if (results.length === 0) {
        await tgSendMessage(chatId, `Sin resultados en TMDB para "${escHtml(query)}" (o falta TMDB_API_KEY).`);
        return;
      }
      const lines = results.slice(0, 5).map(
        (r, i) =>
          `${i + 1}. <b>${escHtml(r.title)}</b> (${r.year || 'S/F'}) · ${r.mediaType === 'tv' ? 'Serie' : 'Película'} ★${r.voteAverage ?? '-'}\n   <i>${escHtml(r.overview.slice(0, 140))}</i>`
      );
      await tgSendMessage(chatId, `<b>🎬 Resultados TMDB</b>\n\n${lines.join('\n\n')}`);
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
      if (user.role !== 'admin' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Solo administradores pueden ver la lista de usuarios.');
        return;
      }
      const lines = stateStore.users.map(
        (u) => `• <code>${u.telegramUserId}</code> <b>${escHtml(u.displayName)}</b> [${u.role}] · ${u.usedTodayGb.toFixed(1)}/${u.dailyQuotaGb} GB`
      );
      await tgSendMessage(
        chatId,
        `<b>👥 Usuarios (${stateStore.users.length})</b>\n${lines.join('\n')}\n\nAgregar: <code>/adduser &lt;id&gt; &lt;nombre&gt; [user|admin] [gb]</code>`
      );
      return;
    }

    if (text.startsWith('/adduser')) {
      if (user.role !== 'admin' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Solo administradores pueden autorizar usuarios.');
        return;
      }
      const args = text.replace(/^\/adduser\s*/i, '').trim().split(/\s+/);
      const targetId = args[0] || '';
      const displayName = args[1] || '';
      const roleArg = (args[2] || 'user').toLowerCase();
      const quotaGb = Math.max(1, Math.min(100, Number(args[3] || stateStore.quotaSettings.defaultDailyQuotaGb)));
      if (!/^\d{4,20}$/.test(targetId) || !displayName) {
        await tgSendMessage(chatId, 'Uso: <code>/adduser &lt;telegramId&gt; &lt;nombre&gt; [user|operator|admin] [gb]</code>');
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
      return;
    }

    if (text.startsWith('/netlog')) {
      if (user.role === 'user' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Comando reservado para operadores y administradores.');
        return;
      }
      await tgSendMessage(chatId, `<code>${escHtml(netlog.formatForTelegram(14))}</code>`);
      return;
    }

    if (text.startsWith('/backup') || text.startsWith('/vault')) {
      if (user.role !== 'admin' && !stateStore.isMasterAdmin(userId)) {
        await tgSendMessage(chatId, 'Solo administradores pueden disparar el respaldo.');
        return;
      }
      const snap = await saveCloudStateToTelegramNow(true);
      await tgSendMessage(chatId, `🔐 Bóveda procesada: ${escHtml(snap.message)}`);
      return;
    }

    if (text.startsWith('/restaurar_nube')) {
      if (user.role !== 'admin' && !stateStore.isMasterAdmin(userId)) {
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
      this.activeUnirSessions.set(userId, {
        id: crypto.randomBytes(4).toString('hex'),
        chatId,
        userId,
        title,
        partRelativePaths: [],
        totalBytes: 0,
        createdAt: Date.now(),
      });
      await tgSendMessage(
        chatId,
        `🧩 <b>Sesión /unir abierta:</b> ${escHtml(title)}\nEnvía ahora las partes (.001/.002, .zip o .tar) y cuando termines ejecuta /unir_fin (o /unir_cancelar).`
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

      // Attach part if /unir session is active
      const unirSession = this.activeUnirSessions.get(userId);
      if (unirSession) {
        const partIdx = unirSession.partRelativePaths.length + 1;
        const safePartName = (media.file_name || `part_${partIdx}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const partRel = `unir_${unirSession.id}_p${String(partIdx).padStart(2, '0')}_${safePartName}`;
        const statusId = await tgSendMessage(chatId, `⬇️ Descargando parte #${partIdx} (<i>${escHtml(safePartName)}</i>)...`);
        try {
          const dl = await mtprotoPool.downloadTelegramMessageMedia({
            chatId,
            messageId: msg.message_id,
            expectedBytes: sizeBytes,
            targetRelativePath: partRel,
          });
          unirSession.partRelativePaths.push(partRel);
          unirSession.totalBytes += dl.bytesWritten;
          await this.showOrEdit(
            chatId,
            statusId || undefined,
            `✅ Parte #${partIdx} lista (${fmtMb(dl.bytesWritten)} · ${dl.throughputMbps} MB/s).\nTotal acumulado: ${fmtMb(unirSession.totalBytes)}. Envía más partes o escribe /unir_fin.`
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
      void pictaService.scanAllPictaAlertsAndMilestones((uid, msg) => this.sendMessage(uid, msg));
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
