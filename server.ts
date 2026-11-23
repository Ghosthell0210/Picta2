import 'dotenv/config';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import express from 'express';
import type {
  AuthorizedUser,
  DashboardBootstrapResponse,
  EnvCheckItem,
  TransferJob,
  TransferJobSource,
  UserRole,
  WatchedPictaVideo,
} from './src/shared/types.ts';
import {
  claimInitialAdminPassword,
  getAuthStatus,
  issueSessionToken,
  requireAdminAuth,
  verifyAdminPassword,
} from './src/server/auth.ts';
import {
  restoreCloudStateFromLocalVault,
  restoreCloudStateFromTelegramCommands,
  saveCloudStateToTelegramNow,
} from './src/server/cloudVault.ts';
import { inspectSystemBinaries, runDiagnosticAssemblyTest } from './src/server/multiPartDiskAssembler.ts';
import { netlog } from './src/server/netlog.ts';
import { pictaService } from './src/server/pictaClient.ts';
import {
  cleanupOrphanedScratchFiles,
  ensureScratchSpaceForFile,
  getDiskStatusReport,
  resolveConfinedScratchPath,
} from './src/server/scratchDiskManager.ts';
import { stateStore } from './src/server/stateStore.ts';
import { telegramRuntime } from './src/server/telegramRuntime.ts';

function buildEnvChecks(): EnvCheckItem[] {
  const has = (key: string) => Boolean((process.env[key] || '').trim());
  const hasAny = (...keys: string[]) => keys.some((k) => has(k));
  return [
    {
      key: 'TELEGRAM_BOT_TOKEN',
      configured: has('TELEGRAM_BOT_TOKEN'),
      requiredForProduction: true,
      category: 'telegram',
      description: 'Token del bot obtenido con @BotFather (nunca en el codigo fuente).',
    },
    {
      key: 'TELEGRAM_MODE',
      configured: has('TELEGRAM_MODE'),
      requiredForProduction: false,
      category: 'telegram',
      description: 'Modo de transporte: "polling" (recomendado en Altare 24/7) o "webhook".',
    },
    {
      key: 'TELEGRAM_WEBHOOK_SECRET',
      configured: has('TELEGRAM_WEBHOOK_SECRET'),
      requiredForProduction: stateStore.config.telegramMode === 'webhook',
      category: 'telegram',
      description: 'Secreto para validar el encabezado X-Telegram-Bot-Api-Secret-Token en modo webhook.',
    },
    {
      key: 'MASTER_ADMIN_CHAT_ID',
      configured: hasAny('MASTER_ADMIN_CHAT_ID', 'ADMIN_TELEGRAM_IDS'),
      requiredForProduction: true,
      category: 'security',
      description: 'Telegram ID del administrador maestro (acepta MASTER_ADMIN_CHAT_ID o ADMIN_TELEGRAM_IDS).',
    },
    {
      key: 'TELEGRAM_API_ID',
      configured: has('TELEGRAM_API_ID'),
      requiredForProduction: true,
      category: 'mtproto',
      description: 'API ID de my.telegram.org para descargas MTProto de archivos mayores a 20 MB.',
    },
    {
      key: 'TELEGRAM_API_HASH',
      configured: has('TELEGRAM_API_HASH'),
      requiredForProduction: true,
      category: 'mtproto',
      description: 'API Hash de my.telegram.org para el pool TCP FastSocket de GramJS.',
    },
    {
      key: 'TELEGRAM_VAULT_CHAT_ID',
      configured: has('TELEGRAM_VAULT_CHAT_ID'),
      requiredForProduction: false,
      category: 'vault',
      description: 'ID de chat/canal privado para copias cifradas (.enc.json) adicionales a setMyCommands eo/ia.',
    },
    {
      key: 'VAULT_ENCRYPTION_KEY',
      configured: has('VAULT_ENCRYPTION_KEY'),
      requiredForProduction: true,
      category: 'vault',
      description: 'Clave maestra AES-256-GCM para cifrar sesiones MTProto y usuarios en la boveda.',
    },
    {
      key: 'PICTA_USERNAME',
      configured: hasAny('PICTA_USERNAME', 'PICTA_DEFAULT_USERNAME'),
      requiredForProduction: true,
      category: 'picta',
      description: 'Usuario o telefono de Picta (acepta PICTA_USERNAME o PICTA_DEFAULT_USERNAME).',
    },
    {
      key: 'PICTA_PASSWORD',
      configured: hasAny('PICTA_PASSWORD', 'PICTA_DEFAULT_PASSWORD'),
      requiredForProduction: true,
      category: 'picta',
      description: 'Contrasena de api.picta.cu cargada exclusivamente desde secretos de Altare.',
    },
    {
      key: 'PICTA_CLIENT_ID',
      configured: has('PICTA_CLIENT_ID'),
      requiredForProduction: true,
      category: 'picta',
      description: 'Client ID OAuth2 de api.picta.cu/o/token/ requerido para autenticacion.',
    },
    {
      key: 'PICTA_AES_KEY',
      configured: has('PICTA_AES_KEY'),
      requiredForProduction: true,
      category: 'picta',
      description: 'Clave AES-128-ECB para descifrar /v2/usuario/me2/ y restaurar boveda heredada eo/ia.',
    },
    {
      key: 'PICTA_CHANNEL_ID',
      configured: has('PICTA_CHANNEL_ID'),
      requiredForProduction: false,
      category: 'picta',
      description: 'ID numerico del canal de Picta por defecto (por defecto 36319).',
    },
    {
      key: 'TMDB_API_KEY',
      configured: has('TMDB_API_KEY'),
      requiredForProduction: false,
      category: 'picta',
      description: 'API Key opcional de TMDB para el comando /buscar y ficha tecnica de peliculas/series.',
    },
    {
      key: 'PICTA_STATE_DIR',
      configured: has('PICTA_STATE_DIR'),
      requiredForProduction: false,
      category: 'storage',
      description: 'Directorio persistente fuera de /tmp para JSON de estado (por defecto ./data/bot_state).',
    },
    {
      key: 'PICTA_SCRATCH_DIR',
      configured: has('PICTA_SCRATCH_DIR'),
      requiredForProduction: false,
      category: 'storage',
      description: 'Directorio temporal persistente para descargas y ensamblaje /unir.',
    },
    {
      key: 'ADMIN_DASHBOARD_PASSCODE',
      configured: has('ADMIN_DASHBOARD_PASSCODE'),
      requiredForProduction: true,
      category: 'security',
      description: 'Clave de acceso al panel web de operaciones (sobrescribe reclamo inicial).',
    },
  ];
}

function sanitizeString(input: unknown, maxLen = 180): string {
  if (typeof input !== 'string') return '';
  return input.trim().slice(0, maxLen);
}

function clamp(val: unknown, min: number, max: number, fallback: number): number {
  const num = Number(val);
  if (!Number.isFinite(num)) return fallback;
  return Math.min(max, Math.max(min, num));
}

async function createServer() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '2mb' }));

  // Public health endpoint
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      service: 'pictabot-altare',
      uptimeSeconds: Math.floor(process.uptime()),
      nodeEnv: process.env.NODE_ENV || 'development',
    });
  });

  // Public auth endpoints
  app.get('/api/auth/status', (req, res) => {
    res.json(getAuthStatus(req));
  });

  app.post('/api/auth/claim', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const result = claimInitialAdminPassword(password);
    if (!result.ok) {
      res.status(400).json({ error: result.error });
      return;
    }
    const session = issueSessionToken();
    netlog.info('system', 'Contraseña inicial del panel de operaciones configurada mediante reclamo unico.');
    res.json({ ok: true, ...session });
  });

  app.post('/api/auth/login', (req, res) => {
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    if (!verifyAdminPassword(password)) {
      res.status(401).json({ error: 'Contraseña administrativa incorrecta.' });
      return;
    }
    const session = issueSessionToken();
    res.json({ ok: true, ...session });
  });

  // Telegram Webhook endpoint (verified via official secret header)
  app.post('/api/telegram/webhook', async (req, res) => {
    if (stateStore.config.telegramMode !== 'webhook') {
      res.status(409).json({ error: 'El bot opera actualmente en modo Long Polling.' });
      return;
    }
    const secretHeader = req.header('x-telegram-bot-api-secret-token');
    if (!telegramRuntime.verifyWebhookSecretHeader(secretHeader)) {
      res.status(403).json({ error: 'Encabezado secreto de Telegram invalido o no configurado.' });
      return;
    }
    res.status(200).json({ ok: true });
    try {
      await telegramRuntime.handleIncomingUpdate(req.body);
    } catch (err) {
      netlog.error('telegram', `Error procesando update webhook: ${err instanceof Error ? err.message : String(err)}`);
    }
  });

  // Protected admin API router
  const api = express.Router();
  api.use(requireAdminAuth);

  api.get('/bootstrap', async (_req, res) => {
    const [telemetry, disk] = await Promise.all([telegramRuntime.getTelemetry(), getDiskStatusReport()]);
    const payload: DashboardBootstrapResponse = {
      telemetry,
      config: stateStore.config,
      disk,
      jobs: stateStore.jobs,
      users: stateStore.users,
      quotaSettings: stateStore.quotaSettings,
      alerts: stateStore.alerts,
      watchedVideos: stateStore.watchedVideos,
      netlog: netlog.getEntries(undefined, 150),
      vaultSnapshots: stateStore.vaultSnapshots,
      envChecks: buildEnvChecks(),
    };
    res.json(payload);
  });

  api.patch('/config', async (req, res) => {
    const body = req.body || {};
    const prevMode = stateStore.config.telegramMode;
    const prevUrl = stateStore.config.appUrl;

    if (body.telegramMode === 'polling' || body.telegramMode === 'webhook') {
      stateStore.config.telegramMode = body.telegramMode;
    }
    if (typeof body.appUrl === 'string') {
      const cleaned = body.appUrl.trim();
      if (cleaned === '' || /^https:\/\//i.test(cleaned)) {
        stateStore.config.appUrl = cleaned;
      } else {
        res.status(400).json({ error: 'APP_URL debe comenzar con https:// o quedar vacio.' });
        return;
      }
    }
    if (body.mtprotoWorkers !== undefined) {
      stateStore.config.mtprotoWorkers = Math.round(clamp(body.mtprotoWorkers, 2, 12, stateStore.config.mtprotoWorkers));
    }
    if (body.mtprotoTcpPoolSize !== undefined) {
      stateStore.config.mtprotoTcpPoolSize = Math.round(
        clamp(body.mtprotoTcpPoolSize, 1, 8, stateStore.config.mtprotoTcpPoolSize)
      );
    }
    if (body.maxPrefetchLookahead !== undefined) {
      stateStore.config.maxPrefetchLookahead = Math.round(
        clamp(body.maxPrefetchLookahead, 1, 2, stateStore.config.maxPrefetchLookahead)
      );
    }
    if (body.diskBudgetGb !== undefined) {
      stateStore.config.diskBudgetGb = clamp(body.diskBudgetGb, 2, 100, stateStore.config.diskBudgetGb);
    }
    if (body.minFreeScratchMb !== undefined) {
      stateStore.config.minFreeScratchMb = Math.round(
        clamp(body.minFreeScratchMb, 256, 4096, stateStore.config.minFreeScratchMb)
      );
    }
    if (body.alertsIntervalMs !== undefined) {
      stateStore.config.alertsIntervalMs = Math.round(
        clamp(body.alertsIntervalMs, 15000, 600000, stateStore.config.alertsIntervalMs)
      );
    }
    if (body.nomadRetryIntervalMs !== undefined) {
      stateStore.config.nomadRetryIntervalMs = Math.round(
        clamp(body.nomadRetryIntervalMs, 5000, 120000, stateStore.config.nomadRetryIntervalMs)
      );
    }
    if (typeof body.queuePaused === 'boolean') {
      stateStore.config.queuePaused = body.queuePaused;
    }
    if (typeof body.autoVaultSyncEnabled === 'boolean') {
      stateStore.config.autoVaultSyncEnabled = body.autoVaultSyncEnabled;
    }

    stateStore.saveConfig();
    telegramRuntime.restartBackgroundLoops();

    if (prevMode !== stateStore.config.telegramMode || prevUrl !== stateStore.config.appUrl) {
      await telegramRuntime.applyTransportMode();
    }

    netlog.info(
      'system',
      `Configuracion actualizada: modo=${stateStore.config.telegramMode}, workers=${stateStore.config.mtprotoWorkers}, pool=${stateStore.config.mtprotoTcpPoolSize}, cola=${stateStore.config.queuePaused ? 'pausada' : 'activa'}.`
    );

    res.json({ ok: true, config: stateStore.config });
  });

  // Transfer jobs queue routes
  api.post('/jobs', async (req, res) => {
    const title = sanitizeString(req.body?.title, 120);
    const fileName = sanitizeString(req.body?.fileName, 120) || 'video_subida.mp4';
    const userId = sanitizeString(req.body?.userId, 40) || 'console-admin';
    const userName = sanitizeString(req.body?.userName, 80) || 'Operador Consola';
    const pictaChannel = sanitizeString(req.body?.pictaChannel, 80) || 'Canal Principal';
    const sourceRaw = req.body?.source;
    const source: TransferJobSource =
      sourceRaw === 'telegram_mtproto' || sourceRaw === 'unir_assembler' || sourceRaw === 'manual_queue'
        ? sourceRaw
        : 'manual_queue';
    const sizeMb = clamp(req.body?.sizeMb, 1, 4096, 250);
    const sizeBytes = Math.round(sizeMb * 1024 * 1024);
    const partCount = source === 'unir_assembler' ? Math.round(clamp(req.body?.partCount, 2, 20, 3)) : undefined;

    if (!title) {
      res.status(400).json({ error: 'El titulo del trabajo es obligatorio.' });
      return;
    }

    const space = await ensureScratchSpaceForFile(sizeBytes);
    if (!space.ok) {
      res.status(409).json({ error: space.reason || 'Sin espacio disponible en presupuesto de disco.' });
      return;
    }

    const safeFile = fileName.replace(/[^a-zA-Z0-9._-]/g, '_');
    const id = crypto.randomUUID();
    const scratchPath = `job_${id.slice(0, 8)}_${safeFile}`;

    // Create a lightweight manifest file inside scratchDir so disk lock protection is real & verifiable
    const confined = resolveConfinedScratchPath(scratchPath);
    fs.writeFileSync(
      confined,
      JSON.stringify({ jobId: id, title, fileName, expectedBytes: sizeBytes, createdAt: new Date().toISOString() }),
      'utf8'
    );

    const now = new Date().toISOString();
    const job: TransferJob = {
      id,
      userId,
      userName,
      title,
      fileName: safeFile,
      source,
      sizeBytes,
      downloadedBytes: 0,
      uploadedBytes: 0,
      progressPct: 0,
      speedMbps: 0,
      status: 'queued',
      nomadRetries: 0,
      maxNomadRetries: 6,
      pictaChannel,
      scratchPath,
      partCount,
      createdAt: now,
      updatedAt: now,
    };

    stateStore.jobs.unshift(job);
    stateStore.saveJobs();
    netlog.info('telegram', `Trabajo encolado: "${job.title}" (${sizeMb} MB · ${source})`);
    res.status(201).json({ ok: true, job });
  });

  api.post('/jobs/:id/retry', (req, res) => {
    const job = stateStore.jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Trabajo no encontrado.' });
      return;
    }
    const mode = req.body?.mode === 'nomad' ? 'nomad' : 'full';
    job.errorMessage = undefined;
    job.updatedAt = new Date().toISOString();
    if (mode === 'nomad') {
      job.status = 'encoding_nomad';
      job.nomadRetries = 0;
      job.progressPct = 92;
      netlog.info('picta', `Reintento manual de codificador Nomad solicitado para "${job.title}".`);
    } else {
      job.status = 'queued';
      job.progressPct = 0;
      job.downloadedBytes = 0;
      job.uploadedBytes = 0;
      netlog.info('telegram', `Trabajo "${job.title}" devuelto a la cola.`);
    }
    stateStore.saveJobs();
    res.json({ ok: true, job });
  });

  api.post('/jobs/:id/cancel', (req, res) => {
    const job = stateStore.jobs.find((j) => j.id === req.params.id);
    if (!job) {
      res.status(404).json({ error: 'Trabajo no encontrado.' });
      return;
    }
    job.status = 'cancelled';
    job.updatedAt = new Date().toISOString();
    if (job.scratchPath) {
      try {
        const confined = resolveConfinedScratchPath(job.scratchPath);
        if (fs.existsSync(confined)) {
          fs.rmSync(confined, { recursive: true, force: true });
        }
      } catch {
        // Ignore if already removed
      }
    }
    stateStore.saveJobs();
    netlog.warn('disk', `Trabajo "${job.title}" cancelado y archivo temporal liberado.`);
    res.json({ ok: true, job });
  });

  api.delete('/jobs/:id', (req, res) => {
    const idx = stateStore.jobs.findIndex((j) => j.id === req.params.id);
    if (idx === -1) {
      res.status(404).json({ error: 'Trabajo no encontrado.' });
      return;
    }
    const [removed] = stateStore.jobs.splice(idx, 1);
    if (removed.scratchPath) {
      try {
        const confined = resolveConfinedScratchPath(removed.scratchPath);
        if (fs.existsSync(confined)) fs.rmSync(confined, { recursive: true, force: true });
      } catch {
        // Ignore
      }
    }
    stateStore.saveJobs();
    res.json({ ok: true });
  });

  // Scratch disk & /unir routes
  api.post('/disk/purge', async (req, res) => {
    const specific = typeof req.body?.relativePath === 'string' ? req.body.relativePath.trim() : undefined;
    try {
      const result = await cleanupOrphanedScratchFiles(specific || undefined);
      const disk = await getDiskStatusReport();
      res.json({ ok: true, result, disk });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Error purgando scratch.' });
    }
  });

  api.post('/assembler/test', async (req, res) => {
    const partsCount = Math.round(clamp(req.body?.partsCount, 2, 8, 3));
    const partSizeKb = Math.round(clamp(req.body?.partSizeKb, 16, 2048, 256));
    const keepOutput = Boolean(req.body?.keepOutput);
    try {
      const result = await runDiagnosticAssemblyTest(partsCount, partSizeKb, keepOutput);
      const disk = await getDiskStatusReport();
      res.json({ ok: true, result, disk });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Error en prueba de ensamblador.' });
    }
  });

  // Authorized users & quotas
  api.post('/users', (req, res) => {
    const telegramUserId = sanitizeString(req.body?.telegramUserId, 32);
    const username = sanitizeString(req.body?.username, 64).replace(/^@/, '');
    const displayName = sanitizeString(req.body?.displayName, 80);
    const roleRaw = req.body?.role;
    const role: UserRole = roleRaw === 'admin' || roleRaw === 'operator' || roleRaw === 'user' ? roleRaw : 'user';
    const dailyQuotaGb = clamp(req.body?.dailyQuotaGb, 0.5, 100, stateStore.quotaSettings.defaultDailyQuotaGb);
    const dailyMaxFiles = Math.round(
      clamp(req.body?.dailyMaxFiles, 1, 500, stateStore.quotaSettings.defaultDailyMaxFiles)
    );
    const pictaUsername = sanitizeString(req.body?.pictaUsername, 64) || undefined;

    if (!/^\d{4,20}$/.test(telegramUserId)) {
      res.status(400).json({ error: 'El Telegram User ID debe ser numerico (4 a 20 digitos).' });
      return;
    }
    if (!displayName) {
      res.status(400).json({ error: 'El nombre visible es obligatorio.' });
      return;
    }
    if (stateStore.users.some((u) => u.telegramUserId === telegramUserId)) {
      res.status(409).json({ error: 'Ese Telegram User ID ya esta registrado.' });
      return;
    }

    const now = new Date().toISOString();
    const user: AuthorizedUser = {
      telegramUserId,
      username: username || `user_${telegramUserId.slice(-4)}`,
      displayName,
      role,
      active: true,
      dailyQuotaGb,
      dailyMaxFiles,
      usedTodayGb: 0,
      filesToday: 0,
      pictaLinked: Boolean(pictaUsername),
      pictaUsername,
      alertsEnabled: true,
      createdAt: now,
      lastActiveAt: now,
    };

    stateStore.users.unshift(user);
    stateStore.saveUsers();
    netlog.info('system', `Usuario autorizado agregado: ${user.displayName} (${user.telegramUserId} · ${user.role})`);
    res.status(201).json({ ok: true, user });
  });

  api.patch('/users/:telegramUserId', (req, res) => {
    const user = stateStore.users.find((u) => u.telegramUserId === req.params.telegramUserId);
    if (!user) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }
    const body = req.body || {};
    if (body.role === 'admin' || body.role === 'operator' || body.role === 'user') user.role = body.role;
    if (typeof body.active === 'boolean') user.active = body.active;
    if (typeof body.alertsEnabled === 'boolean') user.alertsEnabled = body.alertsEnabled;
    if (body.dailyQuotaGb !== undefined) user.dailyQuotaGb = clamp(body.dailyQuotaGb, 0.5, 100, user.dailyQuotaGb);
    if (body.dailyMaxFiles !== undefined) {
      user.dailyMaxFiles = Math.round(clamp(body.dailyMaxFiles, 1, 500, user.dailyMaxFiles));
    }
    if (body.resetUsage === true) {
      user.usedTodayGb = 0;
      user.filesToday = 0;
    }
    stateStore.saveUsers();
    res.json({ ok: true, user });
  });

  api.delete('/users/:telegramUserId', (req, res) => {
    const idx = stateStore.users.findIndex((u) => u.telegramUserId === req.params.telegramUserId);
    if (idx === -1) {
      res.status(404).json({ error: 'Usuario no encontrado.' });
      return;
    }
    const [removed] = stateStore.users.splice(idx, 1);
    stateStore.saveUsers();
    netlog.warn('system', `Acceso revocado para usuario ${removed.displayName} (${removed.telegramUserId}).`);
    res.json({ ok: true });
  });

  api.patch('/quotas', (req, res) => {
    const body = req.body || {};
    if (body.defaultDailyQuotaGb !== undefined) {
      stateStore.quotaSettings.defaultDailyQuotaGb = clamp(
        body.defaultDailyQuotaGb,
        0.5,
        100,
        stateStore.quotaSettings.defaultDailyQuotaGb
      );
    }
    if (body.defaultDailyMaxFiles !== undefined) {
      stateStore.quotaSettings.defaultDailyMaxFiles = Math.round(
        clamp(body.defaultDailyMaxFiles, 1, 500, stateStore.quotaSettings.defaultDailyMaxFiles)
      );
    }
    if (body.maxSingleFileGb !== undefined) {
      stateStore.quotaSettings.maxSingleFileGb = clamp(
        body.maxSingleFileGb,
        0.2,
        4,
        stateStore.quotaSettings.maxSingleFileGb
      );
    }
    if (typeof body.enforceQuotas === 'boolean') {
      stateStore.quotaSettings.enforceQuotas = body.enforceQuotas;
    }
    stateStore.saveQuotaSettings();
    res.json({ ok: true, quotaSettings: stateStore.quotaSettings });
  });

  // Picta alerts & watched videos
  api.post('/watched-videos', (req, res) => {
    const videoId = sanitizeString(req.body?.videoId, 64);
    const title = sanitizeString(req.body?.title, 120);
    const channelName = sanitizeString(req.body?.channelName, 80) || 'Canal Picta';
    const ownerUserId = sanitizeString(req.body?.ownerUserId, 32) || stateStore.users[0]?.telegramUserId || '';

    if (!videoId || !title) {
      res.status(400).json({ error: 'ID de publicacion Picta y titulo son obligatorios.' });
      return;
    }
    if (stateStore.watchedVideos.some((v) => v.videoId === videoId)) {
      res.status(409).json({ error: 'Ese video ya esta siendo vigilado.' });
      return;
    }

    const watched: WatchedPictaVideo = {
      videoId,
      title,
      channelName,
      ownerUserId,
      lastCommentCount: 0,
      lastViewsCount: 0,
      lastMilestoneNotified: 0,
      nomadStatus: 'ready',
      updatedAt: new Date().toISOString(),
    };
    stateStore.watchedVideos.unshift(watched);
    stateStore.saveWatchedVideos();
    netlog.info('picta', `Video agregado a vigilancia de comentarios/logros: "${title}" (${videoId}).`);
    res.status(201).json({ ok: true, watched });
  });

  api.delete('/watched-videos/:videoId', (req, res) => {
    const idx = stateStore.watchedVideos.findIndex((v) => v.videoId === req.params.videoId);
    if (idx === -1) {
      res.status(404).json({ error: 'Video no encontrado.' });
      return;
    }
    stateStore.watchedVideos.splice(idx, 1);
    stateStore.saveWatchedVideos();
    res.json({ ok: true });
  });

  api.post('/picta/scan', async (_req, res) => {
    const result = await pictaService.scanAllPictaAlertsAndMilestones((uid, txt) =>
      telegramRuntime.sendMessage(uid, txt)
    );
    res.json({ ok: true, ...result });
  });

  api.post('/picta/check', async (_req, res) => {
    const result = await pictaService.checkPictaConnectivity();
    res.json({ ok: true, ...result });
  });

  api.post('/picta/nomad-sweep', async (_req, res) => {
    const result = await pictaService.runNomadEncoderRetrySweep((uid, txt) => telegramRuntime.sendMessage(uid, txt));
    res.json({ ok: true, ...result });
  });

  api.patch('/alerts/:id/ack', (req, res) => {
    const alert = stateStore.alerts.find((a) => a.id === req.params.id);
    if (!alert) {
      res.status(404).json({ error: 'Alerta no encontrada.' });
      return;
    }
    alert.notifiedTelegram = true;
    stateStore.saveAlerts();
    res.json({ ok: true, alert });
  });

  // Cloud Vault routes
  api.post('/vault/backup', async (req, res) => {
    const includeMtproto = req.body?.includeMtproto !== false;
    const snapshot = await saveCloudStateToTelegramNow(includeMtproto);
    res.json({ ok: true, snapshot, snapshots: stateStore.vaultSnapshots });
  });

  api.post('/vault/restore', async (_req, res) => {
    const result = await restoreCloudStateFromLocalVault();
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  api.post('/vault/restore-telegram', async (_req, res) => {
    const result = await restoreCloudStateFromTelegramCommands();
    if (!result.ok) {
      res.status(404).json({ error: result.error });
      return;
    }
    res.json(result);
  });

  // Netlog clear
  api.delete('/netlog', (_req, res) => {
    netlog.clear();
    res.json({ ok: true });
  });

  // Altare readiness check
  api.get('/altare/readiness', async (_req, res) => {
    const [binaries, disk] = await Promise.all([inspectSystemBinaries(true), getDiskStatusReport()]);
    const writable = stateStore.verifyDirectoryWritable();
    res.json({
      ok: true,
      writable,
      binaries,
      disk,
      envChecks: buildEnvChecks(),
      isCloudRunDetected: Boolean(process.env.K_SERVICE),
    });
  });

  app.use('/api', api);

  // Mount Vite middleware in development or static dist in production / compiled bundle
  const distDir = path.resolve(process.cwd(), 'dist');
  const runningCompiledBundle = Boolean(process.argv[1]?.endsWith('server.js'));
  const isProd = process.env.NODE_ENV === 'production' || (runningCompiledBundle && fs.existsSync(path.join(distDir, 'index.html')));

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    app.use(express.static(distDir));
    app.get('*', (req, res, next) => {
      if (req.path.startsWith('/api/')) {
        res.status(404).json({ error: 'Ruta API no encontrada.' });
        return;
      }
      const indexFile = path.join(distDir, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        next();
      }
    });
  }

  const port = Number(process.env.PORT || process.env.SERVER_PORT || 3000);
  const server = app.listen(port, '0.0.0.0', () => {
    console.log(`[PictaBot Altare] Servidor activo en http://0.0.0.0:${port} (${isProd ? 'production' : 'development'})`);
    void telegramRuntime.start();
  });

  const gracefulExit = async () => {
    await telegramRuntime.shutdown();
    server.close(() => process.exit(0));
  };
  process.on('SIGINT', () => void gracefulExit());
  process.on('SIGTERM', () => void gracefulExit());
}

void createServer();
