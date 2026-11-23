import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { RuntimeTelemetry, TransferJob } from '../shared/types.ts';
import {
  getVaultConfigStatus,
  restoreCloudStateFromTelegramCommands,
  saveCloudStateToTelegramNow,
} from './cloudVault.ts';
import { mtprotoPool } from './mtprotoFastDownload.ts';
import {
  concatBinaryParts,
  extractArchiveSafe,
  inspectSystemBinaries,
  remuxSingleVideoFaststart,
} from './multiPartDiskAssembler.ts';
import { netlog } from './netlog.ts';
import { PICTA_TIPOLOGIAS, pictaService } from './pictaClient.ts';
import {
  ensureScratchSpaceForFile,
  getDiskStatusReport,
  resolveConfinedScratchPath,
} from './scratchDiskManager.ts';
import { stateStore } from './stateStore.ts';

interface TelegramUpdate {
  update_id: number;
  message?: {
    message_id: number;
    chat: { id: number; type: string };
    from?: { id: number; username?: string; first_name?: string };
    text?: string;
    caption?: string;
    video?: { file_id: string; file_name?: string; file_size?: number };
    document?: { file_id: string; file_name?: string; file_size?: number };
  };
}

interface ActiveUnirSession {
  jobId: string;
  chatId: number;
  userId: string;
  title: string;
  partRelativePaths: string[];
  createdAt: number;
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
  private queueWorkerBusy = false;

  private activeUnirSessions = new Map<string, ActiveUnirSession>();

  public getBotToken(): string {
    return (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  }

  public async sendMessage(chatId: string | number, text: string): Promise<boolean> {
    const token = this.getBotToken();
    if (!token) return false;
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, text: text.slice(0, 4000) }),
      });
      const body = (await res.json()) as { ok?: boolean };
      return Boolean(res.ok && body.ok);
    } catch {
      return false;
    }
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

    if (this.isCloudRunDetected) {
      netlog.warn('system', 'Entorno Cloud Run detectado (K_SERVICE activo). En Altare este aviso desaparece.');
    } else {
      netlog.info(
        'system',
        'Modo contenedor Always-On activo (Altare): bucle keep-alive de Cloud Run desactivado por diseño.'
      );
    }

    await mtprotoPool.connectIfConfigured();
    await this.applyTransportMode();
  }

  public async applyTransportMode(): Promise<void> {
    const token = this.getBotToken();
    this.stopPollingLoop();
    this.webhookActive = false;
    this.webhookUrl = undefined;

    if (!token) {
      netlog.info('telegram', 'Bot en espera: define TELEGRAM_BOT_TOKEN en el panel de secretos de Altare.');
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
      const targetUrl = `${stateStore.config.appUrl.replace(/\/+$/, '')}/api/telegram/webhook`;
      const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || '').trim();
      try {
        const res = await fetch(`https://api.telegram.org/bot${token}/setWebhook`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            url: targetUrl,
            ...(secret ? { secret_token: secret } : {}),
            drop_pending_updates: false,
          }),
        });
        const body = (await res.json()) as { ok?: boolean; description?: string };
        if (body.ok) {
          this.webhookActive = true;
          this.webhookUrl = targetUrl;
          this.lastError = undefined;
          netlog.info('telegram', `Webhook HTTPS registrado en ${targetUrl}`);
          return;
        }
        this.lastError = body.description || 'Error registrando Webhook';
        netlog.error('telegram', `Fallo registro Webhook: ${this.lastError}. Recayendo a Long Polling.`);
      } catch (err) {
        this.lastError = err instanceof Error ? err.message : String(err);
        netlog.error('telegram', `Error de red configurando Webhook: ${this.lastError}`);
      }
    }

    // Default Altare mode: 24/7 Long Polling
    try {
      await fetch(`https://api.telegram.org/bot${token}/deleteWebhook`, { method: 'POST' });
    } catch {
      // Proceed to polling
    }

    this.startPollingLoop();
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
    netlog.info('telegram', 'Long Polling 24/7 iniciado para entorno Always-On.');

    const pollTick = async () => {
      if (this.pollingAborted) return;
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 32_000);
        const url = `https://api.telegram.org/bot${token}/getUpdates?timeout=25&offset=${this.lastOffset}`;
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timeout);
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
          netlog.warn('telegram', `Respuesta getUpdates no exitosa: ${this.lastError}`);
          await new Promise((r) => setTimeout(r, 4000));
        }
      } catch (err) {
        if (!this.pollingAborted) {
          this.lastError = err instanceof Error ? err.message : String(err);
          await new Promise((r) => setTimeout(r, 4000));
        }
      }

      if (!this.pollingAborted) {
        setImmediate(pollTick);
      }
    };

    void pollTick();
  }

  private async processNextQueuedJob(): Promise<void> {
    if (this.queueWorkerBusy || stateStore.config.queuePaused) return;
    const job = [...stateStore.jobs]
      .reverse()
      .find((j) => j.status === 'queued' && j.source === 'telegram_mtproto' && j.telegramChatId && j.telegramMessageId);
    if (!job) return;

    this.queueWorkerBusy = true;
    try {
      // 1. Download from Telegram via FastSocket MTProto
      job.status = 'downloading';
      job.progressPct = 5;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

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
        },
      });

      // 2. Upload to Picta S3 MinIO (256 KB stream) + Create Publication + Nomad trigger
      job.status = 'uploading';
      job.downloadedBytes = dl.bytesWritten;
      job.progressPct = 50;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      const uploadRes = await pictaService.uploadVideoToPictaPipeline({
        filePath: dl.filePath,
        fileName: job.fileName,
        title: job.title,
        tipologia: job.tipologia || 8,
        onUploadProgress: (uploadedBytes, totalBytes, speedMbps) => {
          job.uploadedBytes = uploadedBytes;
          job.speedMbps = speedMbps;
          job.progressPct = Math.min(92, 50 + Math.round((uploadedBytes / Math.max(1, totalBytes)) * 42));
          job.updatedAt = new Date().toISOString();
        },
      });

      job.minioKey = uploadRes.minioKey;
      job.pictaVideoId = uploadRes.publicationId;
      job.status = 'encoding_nomad';
      job.progressPct = 94;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      // 3. Reclaim scratch space immediately after S3 upload completes
      try {
        if (fs.existsSync(dl.filePath)) {
          fs.rmSync(dl.filePath, { force: true });
        }
      } catch {
        // Non-fatal
      }

      if (job.telegramChatId) {
        await this.sendMessage(
          job.telegramChatId,
          `Subida completada a Picta: "${job.title}".\nPublicacion ID: ${uploadRes.publicationId || 'en proceso'}\nCodificador Nomad: ${uploadRes.nomadTriggered ? 'iniciado' : 'pendiente de reintento automatico (20s)'}.`
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.errorMessage = msg;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();
      netlog.error('picta', `Fallo transferencia "${job.title}": ${msg}`);
      if (job.telegramChatId) {
        await this.sendMessage(job.telegramChatId, `Error procesando "${job.title}": ${msg}`);
      }
    } finally {
      this.queueWorkerBusy = false;
    }
  }

  private async finalizeUnirSession(session: ActiveUnirSession): Promise<void> {
    const job = stateStore.jobs.find((j) => j.id === session.jobId);
    if (!job) return;

    try {
      job.status = 'assembling';
      job.progressPct = 35;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      let assembledPath: string;
      const tempDirsToClean: string[] = [];
      const singlePart = session.partRelativePaths.length === 1 ? session.partRelativePaths[0] : '';

      if (singlePart && /\.zip$/i.test(singlePart)) {
        const extractRel = `unir_${job.id.slice(0, 8)}_zip`;
        tempDirsToClean.push(extractRel);
        const extracted = await extractArchiveSafe(singlePart, extractRel, 'zip');
        const firstVideo = extracted.extractedFiles.find((f: string) => /\.(mp4|mkv|mov|avi|webm)$/i.test(f));
        if (!firstVideo) throw new Error('El archivo ZIP no contiene ningun video soportado.');
        assembledPath = firstVideo;
      } else if (singlePart && /\.(tar|tar\.gz|tgz)$/i.test(singlePart)) {
        const extractRel = `unir_${job.id.slice(0, 8)}_tar`;
        tempDirsToClean.push(extractRel);
        const extracted = await extractArchiveSafe(singlePart, extractRel, 'tar');
        const firstVideo = extracted.extractedFiles.find((f: string) => /\.(mp4|mkv|mov|avi|webm)$/i.test(f));
        if (!firstVideo) throw new Error('El archivo TAR no contiene ningun video soportado.');
        assembledPath = firstVideo;
      } else {
        const mergedRel = `unir_${job.id.slice(0, 8)}_merged.mp4`;
        const merged = await concatBinaryParts(session.partRelativePaths, mergedRel);
        assembledPath = resolveConfinedScratchPath(merged.outputRelativePath);
      }

      // Remux with ffmpeg if available for clean MP4 moov atom
      const bins = await inspectSystemBinaries();
      let finalVideoPath = assembledPath;
      if (bins.ffmpeg.available) {
        const remuxRel = `unir_${job.id.slice(0, 8)}_final.mp4`;
        const relIn = path.relative(stateStore.scratchDir, assembledPath);
        if (!relIn.startsWith('..')) {
          finalVideoPath = await remuxSingleVideoFaststart(relIn, remuxRel);
        }
      }

      job.status = 'uploading';
      job.progressPct = 60;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      const uploadRes = await pictaService.uploadVideoToPictaPipeline({
        filePath: finalVideoPath,
        fileName: `${job.title.replace(/[^a-zA-Z0-9._-]/g, '_')}.mp4`,
        title: job.title,
        tipologia: job.tipologia || 8,
        onUploadProgress: (uploadedBytes, totalBytes, speedMbps) => {
          job.uploadedBytes = uploadedBytes;
          job.speedMbps = speedMbps;
          job.progressPct = Math.min(92, 60 + Math.round((uploadedBytes / Math.max(1, totalBytes)) * 32));
        },
      });

      job.minioKey = uploadRes.minioKey;
      job.pictaVideoId = uploadRes.publicationId;
      job.status = 'encoding_nomad';
      job.progressPct = 95;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();

      // Clean up parts and assembled files to keep 10 GB disk healthy
      for (const rel of session.partRelativePaths) {
        try {
          fs.rmSync(resolveConfinedScratchPath(rel), { force: true });
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
      try {
        if (assembledPath !== finalVideoPath && fs.existsSync(assembledPath)) {
          fs.rmSync(assembledPath, { force: true });
        }
        if (fs.existsSync(finalVideoPath)) {
          fs.rmSync(finalVideoPath, { force: true });
        }
      } catch {
        // Ignore
      }

      await this.sendMessage(
        session.chatId,
        `Ensamblaje /unir completado y subido a Picta: "${job.title}" (ID ${uploadRes.publicationId || 'en proceso'}).`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      job.status = 'failed';
      job.errorMessage = msg;
      job.updatedAt = new Date().toISOString();
      stateStore.saveJobs();
      netlog.error('assembler', `Error en /unir "${job.title}": ${msg}`);
      await this.sendMessage(session.chatId, `Error en ensamblaje /unir "${job.title}": ${msg}`);
    }
  }

  public async handleIncomingUpdate(update: TelegramUpdate): Promise<void> {
    this.updatesProcessed += 1;
    const msg = update.message;
    if (!msg || !msg.from) return;

    const userId = String(msg.from.id);
    const chatId = msg.chat.id;
    const user = stateStore.users.find((u) => u.telegramUserId === userId && u.active);
    const text = (msg.text || msg.caption || '').trim();

    if (!user) {
      await this.sendMessage(
        chatId,
        `Acceso restringido. Tu ID de Telegram (${userId}) no esta autorizado en PictaBot Altare.`
      );
      return;
    }

    user.lastActiveAt = new Date().toISOString();
    stateStore.saveUsers();

    if (text.startsWith('/start') || text.startsWith('/help') || text.startsWith('/menu')) {
      const tips = Object.entries(PICTA_TIPOLOGIAS)
        .slice(0, 6)
        .map(([k, v]) => `${k}:${v}`)
        .join(', ');
      await this.sendMessage(
        chatId,
        [
          `PictaBot Altare Edition activo (${stateStore.config.telegramMode} 24/7).`,
          `Canal por defecto: ${pictaService.getDefaultChannelName()} (#${pictaService.getDefaultChannelId()})`,
          `Cuota hoy: ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB (${user.filesToday}/${user.dailyMaxFiles} archivos).`,
          'Comandos: /estado, /cola, /cuota, /stats, /buscar <titulo>, /disco, /unir <titulo>, /unir_fin, /netlog, /backup, /restaurar_nube, /reintentar',
          `Tipologias Picta: ${tips}...`,
        ].join('\n')
      );
      return;
    }

    if (text.startsWith('/estado') || text.startsWith('/status')) {
      const disk = await getDiskStatusReport();
      const freeGb = (disk.budgetRemainingBytes / 1024 ** 3).toFixed(2);
      const activeCount = stateStore.jobs.filter((j) =>
        ['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(j.status)
      ).length;
      await this.sendMessage(
        chatId,
        [
          `Estado PictaBot (Altare Always-On)`,
          `Disco presupuesto: ${disk.usagePct}% usado (${freeGb} GB libres de ${stateStore.config.diskBudgetGb} GB)`,
          `MTProto FastSocket: ${mtprotoPool.getStatus().connected ? 'Conectado' : 'En espera'} | Workers: ${stateStore.config.mtprotoWorkers} | Pool TCP: ${stateStore.config.mtprotoTcpPoolSize}`,
          `Cola activa: ${activeCount} trabajo(s) | Estado: ${stateStore.config.queuePaused ? 'Pausada' : 'Activa'}`,
        ].join('\n')
      );
      return;
    }

    if (text.startsWith('/cuota')) {
      await this.sendMessage(
        chatId,
        [
          `Cuota de ${user.displayName} (${user.role}):`,
          `- Consumo hoy: ${user.usedTodayGb.toFixed(2)} / ${user.dailyQuotaGb} GB`,
          `- Archivos hoy: ${user.filesToday} / ${user.dailyMaxFiles}`,
          `- Maximo por archivo: ${stateStore.quotaSettings.maxSingleFileGb} GB`,
        ].join('\n')
      );
      return;
    }

    if (text.startsWith('/disco')) {
      const disk = await getDiskStatusReport();
      await this.sendMessage(
        chatId,
        [
          `Disco Persistente Altare:`,
          `- Estado: ${(disk.stateUsedBytes / 1024 ** 2).toFixed(1)} MB (${disk.stateDir})`,
          `- Scratch: ${(disk.scratchUsedBytes / 1024 ** 2).toFixed(1)} MB (${disk.scratchDir})`,
          `- Presupuesto libre: ${(disk.budgetRemainingBytes / 1024 ** 3).toFixed(2)} GB / ${stateStore.config.diskBudgetGb} GB`,
          `- Presion: ${disk.pressureLevel.toUpperCase()}`,
        ].join('\n')
      );
      return;
    }

    if (text.startsWith('/stats')) {
      const stats = await pictaService.fetchChannelStats();
      if (!stats) {
        await this.sendMessage(
          chatId,
          'No se pudieron obtener estadisticas de Picta. Verifica PICTA_USERNAME, PICTA_PASSWORD y PICTA_CLIENT_ID.'
        );
        return;
      }
      await this.sendMessage(chatId, `Resumen Picta hoy:\n${JSON.stringify(stats, null, 2).slice(0, 1500)}`);
      return;
    }

    if (text.startsWith('/buscar')) {
      const query = text.replace(/^\/buscar\s*/i, '').trim();
      if (!query) {
        await this.sendMessage(chatId, 'Uso: /buscar <nombre de pelicula o serie>');
        return;
      }
      const results = await pictaService.searchMetadataTmdb(query);
      if (results.length === 0) {
        await this.sendMessage(chatId, `Sin resultados en TMDB para "${query}" (o falta TMDB_API_KEY).`);
        return;
      }
      const lines = results.map(
        (r, i) => `${i + 1}. ${r.title} (${r.year || 'S/F'}) [${r.mediaType === 'tv' ? 'Serie' : 'Pelicula'}] ★${r.voteAverage ?? '-'}`
      );
      await this.sendMessage(chatId, `Resultados TMDB:\n${lines.join('\n')}`);
      return;
    }

    if (text.startsWith('/cola')) {
      const active = stateStore.jobs.slice(0, 8);
      if (active.length === 0) {
        await this.sendMessage(chatId, 'La cola de transferencias esta vacia.');
        return;
      }
      const lines = active.map(
        (j) => `- ${j.title} [${j.status}] ${j.progressPct}% (${(j.sizeBytes / 1024 ** 2).toFixed(1)} MB)`
      );
      await this.sendMessage(chatId, `Trabajos recientes:\n${lines.join('\n')}`);
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
      await this.sendMessage(chatId, `Se reencolaron ${failed.length} trabajo(s) fallido(s).`);
      return;
    }

    if (text.startsWith('/netlog')) {
      if (user.role === 'user') {
        await this.sendMessage(chatId, 'Comando reservado para operadores y administradores.');
        return;
      }
      await this.sendMessage(chatId, netlog.formatForTelegram(12));
      return;
    }

    if (text.startsWith('/backup') || text.startsWith('/vault')) {
      if (user.role !== 'admin') {
        await this.sendMessage(chatId, 'Solo administradores pueden disparar el respaldo de boveda.');
        return;
      }
      const snap = await saveCloudStateToTelegramNow(true);
      await this.sendMessage(chatId, `Boveda procesada: ${snap.message}`);
      return;
    }

    if (text.startsWith('/restaurar_nube')) {
      if (user.role !== 'admin') {
        await this.sendMessage(chatId, 'Solo administradores pueden restaurar desde Telegram Cloud Vault.');
        return;
      }
      const res = await restoreCloudStateFromTelegramCommands();
      if (!res.ok) {
        await this.sendMessage(chatId, `No se pudo restaurar: ${res.error}`);
      } else {
        await this.sendMessage(
          chatId,
          `Boveda Telegram restaurada (${res.restoredUsers} usuarios · MTProto=${res.restoredMtproto ? 'SI' : 'NO'}).`
        );
      }
      return;
    }

    if (text.startsWith('/unir_fin')) {
      const session = this.activeUnirSessions.get(userId);
      if (!session || session.partRelativePaths.length === 0) {
        await this.sendMessage(chatId, 'No tienes ninguna sesion /unir con partes recibidas.');
        return;
      }
      this.activeUnirSessions.delete(userId);
      await this.sendMessage(
        chatId,
        `Iniciando ensamblaje en disco persistente para "${session.title}" (${session.partRelativePaths.length} parte(s))...`
      );
      void this.finalizeUnirSession(session);
      return;
    }

    if (text.startsWith('/unir')) {
      const title =
        text.replace(/^\/unir\s*/i, '').trim() || `Ensamblaje /unir ${new Date().toISOString().slice(11, 19)}`;
      const job: TransferJob = {
        id: crypto.randomUUID(),
        userId: user.telegramUserId,
        userName: user.displayName,
        title,
        fileName: 'paquete_multiparte.mp4',
        source: 'unir_assembler',
        sizeBytes: 0,
        downloadedBytes: 0,
        uploadedBytes: 0,
        progressPct: 0,
        speedMbps: 0,
        status: 'queued',
        nomadRetries: 0,
        maxNomadRetries: 6,
        pictaChannel: pictaService.getDefaultChannelName(),
        partCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      stateStore.jobs.unshift(job);
      stateStore.saveJobs();
      this.activeUnirSessions.set(userId, {
        jobId: job.id,
        chatId,
        userId,
        title,
        partRelativePaths: [],
        createdAt: Date.now(),
      });
      await this.sendMessage(
        chatId,
        `Sesion /unir creada (${job.id.slice(0, 8)}): "${title}".\nEnvia las partes (.zip, .tar o segmentos .001/.002) y luego ejecuta /unir_fin.`
      );
      return;
    }

    const media = msg.video || msg.document;
    if (media) {
      const sizeBytes = media.file_size || 0;
      const sizeGb = sizeBytes / 1024 ** 3;

      if (stateStore.quotaSettings.enforceQuotas) {
        if (sizeGb > stateStore.quotaSettings.maxSingleFileGb) {
          await this.sendMessage(
            chatId,
            `Archivo rechazado: supera el limite por archivo (${stateStore.quotaSettings.maxSingleFileGb} GB).`
          );
          return;
        }
        if (user.usedTodayGb + sizeGb > user.dailyQuotaGb || user.filesToday + 1 > user.dailyMaxFiles) {
          await this.sendMessage(chatId, 'Cuota diaria alcanzada. Contacta al administrador.');
          return;
        }
      }

      const space = await ensureScratchSpaceForFile(sizeBytes);
      if (!space.ok) {
        await this.sendMessage(chatId, `Espacio temporal insuficiente: ${space.reason}`);
        return;
      }

      // If user has an active /unir session, download part directly to scratch and attach
      const unirSession = this.activeUnirSessions.get(userId);
      if (unirSession) {
        const partIdx = unirSession.partRelativePaths.length + 1;
        const safePartName = (media.file_name || `part_${partIdx}.bin`).replace(/[^a-zA-Z0-9._-]/g, '_');
        const partRel = `unir_${unirSession.jobId.slice(0, 8)}_p${String(partIdx).padStart(2, '0')}_${safePartName}`;
        await this.sendMessage(chatId, `Descargando parte #${partIdx} (${safePartName}) al disco persistente...`);
        try {
          const dl = await mtprotoPool.downloadTelegramMessageMedia({
            chatId,
            messageId: msg.message_id,
            expectedBytes: sizeBytes,
            targetRelativePath: partRel,
          });
          unirSession.partRelativePaths.push(partRel);
          const unirJob = stateStore.jobs.find((j) => j.id === unirSession.jobId);
          if (unirJob) {
            unirJob.partCount = unirSession.partRelativePaths.length;
            unirJob.sizeBytes += dl.bytesWritten;
            unirJob.updatedAt = new Date().toISOString();
            stateStore.saveJobs();
          }
          await this.sendMessage(
            chatId,
            `Parte #${partIdx} lista (${(dl.bytesWritten / 1024 ** 2).toFixed(1)} MB · ${dl.throughputMbps} MB/s). Envia mas partes o escribe /unir_fin.`
          );
        } catch (err) {
          await this.sendMessage(
            chatId,
            `Error descargando parte #${partIdx}: ${err instanceof Error ? err.message : String(err)}`
          );
        }
        return;
      }

      const fileName = media.file_name || `telegram_${msg.message_id}.mp4`;
      const now = new Date().toISOString();
      const job: TransferJob = {
        id: crypto.randomUUID(),
        userId: user.telegramUserId,
        userName: user.displayName,
        title: text || fileName.replace(/\.[^.]+$/, ''),
        fileName,
        source: 'telegram_mtproto',
        sizeBytes,
        downloadedBytes: 0,
        uploadedBytes: 0,
        progressPct: 0,
        speedMbps: 0,
        status: 'queued',
        nomadRetries: 0,
        maxNomadRetries: 6,
        pictaChannel: pictaService.getDefaultChannelName(),
        telegramChatId: String(chatId),
        telegramMessageId: msg.message_id,
        scratchPath: `job_${msg.message_id}_${fileName.replace(/[^a-zA-Z0-9._-]/g, '_')}`,
        createdAt: now,
        updatedAt: now,
      };
      stateStore.jobs.unshift(job);
      user.filesToday += 1;
      user.usedTodayGb = Number((user.usedTodayGb + sizeGb).toFixed(3));
      stateStore.saveJobs();
      stateStore.saveUsers();

      netlog.info('telegram', `Trabajo encolado desde Telegram: ${fileName} (${(sizeBytes / 1024 ** 2).toFixed(1)} MB)`);
      await this.sendMessage(chatId, `Encolado "${job.title}" (${job.id.slice(0, 8)}). Iniciando descarga MTProto...`);
      void this.processNextQueuedJob();
    }
  }

  private startBackgroundLoops(): void {
    this.stopBackgroundLoops();

    this.alertsTimer = setInterval(() => {
      void pictaService.scanAllPictaAlertsAndMilestones((uid, msg) => this.sendMessage(uid, msg));
    }, stateStore.config.alertsIntervalMs);

    this.nomadTimer = setInterval(() => {
      void pictaService.runNomadEncoderRetrySweep((uid, msg) => this.sendMessage(uid, msg));
    }, stateStore.config.nomadRetryIntervalMs);

    this.queueTimer = setInterval(() => {
      void this.processNextQueuedJob();
    }, 3500);
  }

  public restartBackgroundLoops(): void {
    this.startBackgroundLoops();
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
  }

  public async shutdown(): Promise<void> {
    this.stopPollingLoop();
    this.stopBackgroundLoops();
    await mtprotoPool.disconnect();
  }

  public async getTelemetry(): Promise<RuntimeTelemetry> {
    const binaries = await inspectSystemBinaries();
    return {
      startedAt: this.startedAt,
      uptimeSeconds: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
      isCloudRunDetected: this.isCloudRunDetected,
      cloudRunKeepAliveActive: false,
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
