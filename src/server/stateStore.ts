import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type {
  AuthorizedUser,
  ChannelRequestRecord,
  PictaAlertEvent,
  PromoChannelRecord,
  QuotaSettings,
  RuntimeConfig,
  TelegramTransportMode,
  TransferJob,
  UserPictaSession,
  VaultSnapshotRecord,
  WatchedPictaVideo,
} from '../shared/types.ts';
import { netlog } from './netlog.ts';

const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad']);
const MAX_JOBS_HISTORY = 120;
const MAX_ALERTS_HISTORY = 100;
const MAX_REQUESTS_HISTORY = 200;
const MAX_IGNORED_COMMENTS = 500;
const MAX_VAULT_SNAPSHOTS = 25;

function clampNumber(val: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(val)) return fallback;
  return Math.min(max, Math.max(min, val));
}

function resolveWritableDir(configuredEnv: string | undefined, fallbackSubdir: string): string {
  const fallback = path.resolve(process.cwd(), 'data', fallbackSubdir);
  const configured = (configuredEnv || '').trim();
  if (!configured) {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
  const preferred = path.resolve(configured);
  try {
    fs.mkdirSync(preferred, { recursive: true });
    const probe = path.join(preferred, `.boot_probe_${process.pid}`);
    fs.writeFileSync(probe, 'ok', 'utf8');
    fs.unlinkSync(probe);
    return preferred;
  } catch {
    fs.mkdirSync(fallback, { recursive: true });
    return fallback;
  }
}

export function resolveStateDir(): string {
  return resolveWritableDir(process.env.PICTA_STATE_DIR, 'bot_state');
}

export function resolveScratchDir(): string {
  return resolveWritableDir(process.env.PICTA_SCRATCH_DIR, 'scratch');
}

export interface PersistedStateBundle {
  config: RuntimeConfig;
  jobs: TransferJob[];
  users: AuthorizedUser[];
  quotaSettings: QuotaSettings;
  userSessions: UserPictaSession[];
  alerts: PictaAlertEvent[];
  watchedVideos: WatchedPictaVideo[];
  vaultSnapshots: VaultSnapshotRecord[];
  pinnedSeriesIds: number[];
  channelRequests: ChannelRequestRecord[];
  ignoredCommentIds: number[];
  promoChannels: PromoChannelRecord[];
}

export class StateStore {
  public readonly stateDir: string;
  public readonly scratchDir: string;

  public config: RuntimeConfig;
  public jobs: TransferJob[] = [];
  public users: AuthorizedUser[] = [];
  public quotaSettings: QuotaSettings;
  public userSessions: UserPictaSession[] = [];
  public alerts: PictaAlertEvent[] = [];
  public watchedVideos: WatchedPictaVideo[] = [];
  public vaultSnapshots: VaultSnapshotRecord[] = [];
  public pinnedSeriesIds: number[] = [];
  public channelRequests: ChannelRequestRecord[] = [];
  public ignoredCommentIds: number[] = [];
  public promoChannels: PromoChannelRecord[] = [];
  public mtprotoSessionString = '';

  private secretKeyCache: Buffer | null = null;
  private masterAdminIdsCache: Set<string>;

  constructor() {
    this.stateDir = resolveStateDir();
    this.scratchDir = resolveScratchDir();

    fs.mkdirSync(this.stateDir, { recursive: true });
    fs.mkdirSync(this.scratchDir, { recursive: true });

    const envModeRaw = (process.env.TELEGRAM_MODE || 'polling').trim().toLowerCase();
    const envMode: TelegramTransportMode = envModeRaw === 'webhook' ? 'webhook' : 'polling';

    const defaultConfig: RuntimeConfig = {
      telegramMode: envMode,
      appUrl: (process.env.APP_URL || '').trim(),
      mtprotoWorkers: clampNumber(Number(process.env.MTPROTO_SAFE_PARALLEL_WORKERS || 6), 2, 12, 6),
      mtprotoTcpPoolSize: clampNumber(Number(process.env.MTPROTO_TCP_POOL_SIZE || 6), 1, 8, 6),
      maxPrefetchLookahead: clampNumber(Number(process.env.MAX_PREFETCH_LOOKAHEAD || 1), 1, 2, 1),
      diskBudgetGb: clampNumber(Number(process.env.PICTA_DISK_BUDGET_GB || 10), 2, 100, 10),
      minFreeScratchMb: 768,
      alertsIntervalMs: clampNumber(Number(process.env.PICTA_ALERTS_INTERVAL_MS || 65000), 15000, 600000, 65000),
      nomadRetryIntervalMs: clampNumber(Number(process.env.NOMAD_RETRY_INTERVAL_MS || 20000), 5000, 120000, 20000),
      queuePaused: false,
      autoVaultSyncEnabled: true,
    };

    const defaultQuota: QuotaSettings = {
      defaultDailyQuotaGb: 6,
      defaultDailyMaxFiles: 15,
      maxSingleFileGb: 3.5,
      enforceQuotas: true,
      resetHourUtc: 0,
    };

    this.config = this.readJson<RuntimeConfig>('runtime_config.json', defaultConfig);
    if (process.env.TELEGRAM_MODE) this.config.telegramMode = envMode;
    if (process.env.APP_URL && !this.config.appUrl) this.config.appUrl = process.env.APP_URL.trim();

    this.jobs = this.readJson<TransferJob[]>('jobs.json', []);
    this.users = this.readJson<AuthorizedUser[]>('authorized_users.json', []).map((u) => ({
      ...u,
      uploadMode: u.uploadMode === 'fast' ? 'fast' : 'wizard',
    }));
    this.quotaSettings = this.readJson<QuotaSettings>('quota_settings.json', defaultQuota);
    this.userSessions = this.readJson<UserPictaSession[]>('user_sessions.json', []);
    this.alerts = this.readJson<PictaAlertEvent[]>('alerts.json', []);
    this.watchedVideos = this.readJson<WatchedPictaVideo[]>('watched_videos.json', []);
    this.vaultSnapshots = this.readJson<VaultSnapshotRecord[]>('vault_snapshots.json', []);
    this.pinnedSeriesIds = this.readJson<number[]>('pinned_series.json', []);
    this.channelRequests = this.readJson<ChannelRequestRecord[]>('channel_requests.json', []);
    this.ignoredCommentIds = this.readJson<number[]>('ignored_comments.json', []);
    this.promoChannels = this.readJson<PromoChannelRecord[]>('promo_channels.json', []);

    const mtSessionFile = this.readJson<{ session: string; updatedAt?: string }>('mtproto_session.json', {
      session: '',
    });
    this.mtprotoSessionString = (process.env.TELEGRAM_MTPROTO_SESSION || '').trim() || mtSessionFile.session || '';

    this.masterAdminIdsCache = this.parseMasterAdminIds();
    this.seedAdminIdsFromEnv();
    this.resetDailyQuotasIfNeeded();
    this.persistAll();

    netlog.info('system', `Estado persistente inicializado en ${this.stateDir}`, {
      scratchDir: this.scratchDir,
      diskBudgetGb: this.config.diskBudgetGb,
    });
  }

  private parseMasterAdminIds(): Set<string> {
    const combinedRaw = [process.env.MASTER_ADMIN_CHAT_ID || '', process.env.ADMIN_TELEGRAM_IDS || ''].join(',');
    return new Set(
      combinedRaw
        .split(',')
        .map((s) => s.trim())
        .filter((s) => /^\d+$/.test(s))
    );
  }

  public isMasterAdmin(telegramUserId: string): boolean {
    const clean = String(telegramUserId || '').trim();
    if (!clean) return false;
    if (this.masterAdminIdsCache.size > 0) {
      return this.masterAdminIdsCache.has(clean);
    }
    const user = this.users.find((u) => u.telegramUserId === clean && u.active);
    return user?.role === 'admin';
  }

  public getPrimaryAdminChatId(): string {
    const firstMaster = Array.from(this.masterAdminIdsCache)[0];
    if (firstMaster) return firstMaster;
    return this.users.find((u) => u.role === 'admin' && u.active)?.telegramUserId || '';
  }

  private getSessionSecretKey(): Buffer {
    if (this.secretKeyCache) return this.secretKeyCache;
    const rawMaterial =
      (process.env.VAULT_ENCRYPTION_KEY || '').trim() ||
      (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim() ||
      `pictabot-local:${this.stateDir}`;
    this.secretKeyCache = crypto.createHash('sha256').update(`pictabot-user-secret:${rawMaterial}`).digest();
    return this.secretKeyCache;
  }

  public encryptUserSecret(plaintext: string): string {
    const key = this.getSessionSecretKey();
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const enc = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `v1:${iv.toString('base64')}:${tag.toString('base64')}:${enc.toString('base64')}`;
  }

  public decryptUserSecret(ciphertext: string): string | null {
    try {
      const parts = String(ciphertext || '').split(':');
      if (parts.length !== 4 || parts[0] !== 'v1') return null;
      const key = this.getSessionSecretKey();
      const iv = Buffer.from(parts[1], 'base64');
      const tag = Buffer.from(parts[2], 'base64');
      const data = Buffer.from(parts[3], 'base64');
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
    } catch {
      return null;
    }
  }

  private seedAdminIdsFromEnv(): void {
    const pictaUser = (process.env.PICTA_USERNAME || process.env.PICTA_DEFAULT_USERNAME || process.env.PICTA_USER || '').trim();
    const now = new Date().toISOString();
    for (const id of this.masterAdminIdsCache) {
      const existing = this.users.find((u) => u.telegramUserId === id);
      if (!existing) {
        this.users.push({
          telegramUserId: id,
          username: `admin_${id.slice(-4)}`,
          displayName: `Administrador (${id})`,
          role: 'admin',
          active: true,
          uploadMode: 'wizard',
          dailyQuotaGb: 50,
          dailyMaxFiles: 200,
          usedTodayGb: 0,
          filesToday: 0,
          pictaLinked: Boolean(pictaUser),
          pictaUsername: pictaUser || undefined,
          alertsEnabled: true,
          createdAt: now,
          lastActiveAt: now,
        });
      }
    }
  }

  public resetDailyQuotasIfNeeded(): boolean {
    const now = new Date();
    const adjusted = new Date(now.getTime() - this.quotaSettings.resetHourUtc * 3600_000);
    const todayKey = adjusted.toISOString().slice(0, 10);
    let changed = false;
    for (const user of this.users) {
      if (user.lastQuotaResetDay !== todayKey) {
        user.usedTodayGb = 0;
        user.filesToday = 0;
        user.lastQuotaResetDay = todayKey;
        changed = true;
      }
    }
    if (changed) {
      this.saveUsers();
    }
    return changed;
  }

  private filePath(fileName: string): string {
    const resolved = path.resolve(this.stateDir, fileName);
    if (!resolved.startsWith(this.stateDir + path.sep)) {
      throw new Error('Ruta de archivo de estado no permitida.');
    }
    return resolved;
  }

  private readJson<T>(fileName: string, fallback: T): T {
    const target = this.filePath(fileName);
    try {
      if (!fs.existsSync(target)) return fallback;
      const raw = fs.readFileSync(target, 'utf8');
      if (!raw.trim()) return fallback;
      return JSON.parse(raw) as T;
    } catch (err) {
      netlog.warn('disk', `No se pudo leer ${fileName}; se aplicara estado por defecto.`, {
        error: err instanceof Error ? err.message : String(err),
      });
      return fallback;
    }
  }

  private atomicWriteJson(fileName: string, data: unknown): void {
    const target = this.filePath(fileName);
    const tmpTarget = `${target}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmpTarget, JSON.stringify(data), 'utf8');
    fs.renameSync(tmpTarget, target);
  }

  public saveConfig(): void {
    this.atomicWriteJson('runtime_config.json', this.config);
  }

  public saveJobs(): void {
    if (this.jobs.length > MAX_JOBS_HISTORY) {
      const active = this.jobs.filter((j) => ACTIVE_STATUSES.has(j.status));
      const finished = this.jobs.filter((j) => !ACTIVE_STATUSES.has(j.status)).slice(0, Math.max(20, MAX_JOBS_HISTORY - active.length));
      this.jobs = [...active, ...finished].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    }
    this.atomicWriteJson('jobs.json', this.jobs);
  }

  public saveUsers(): void {
    this.atomicWriteJson('authorized_users.json', this.users);
  }

  public saveQuotaSettings(): void {
    this.atomicWriteJson('quota_settings.json', this.quotaSettings);
  }

  public saveUserSessions(): void {
    this.atomicWriteJson('user_sessions.json', this.userSessions);
  }

  public saveAlerts(): void {
    if (this.alerts.length > MAX_ALERTS_HISTORY) this.alerts.length = MAX_ALERTS_HISTORY;
    this.atomicWriteJson('alerts.json', this.alerts);
  }

  public saveWatchedVideos(): void {
    this.atomicWriteJson('watched_videos.json', this.watchedVideos);
  }

  public saveVaultSnapshots(): void {
    if (this.vaultSnapshots.length > MAX_VAULT_SNAPSHOTS) this.vaultSnapshots.length = MAX_VAULT_SNAPSHOTS;
    this.atomicWriteJson('vault_snapshots.json', this.vaultSnapshots);
  }

  public savePinnedSeries(): void {
    this.atomicWriteJson('pinned_series.json', this.pinnedSeriesIds);
  }

  public saveChannelRequests(): void {
    if (this.channelRequests.length > MAX_REQUESTS_HISTORY) this.channelRequests.length = MAX_REQUESTS_HISTORY;
    this.atomicWriteJson('channel_requests.json', this.channelRequests);
  }

  public saveIgnoredComments(): void {
    if (this.ignoredCommentIds.length > MAX_IGNORED_COMMENTS) {
      this.ignoredCommentIds = this.ignoredCommentIds.slice(-MAX_IGNORED_COMMENTS);
    }
    this.atomicWriteJson('ignored_comments.json', this.ignoredCommentIds);
  }

  public savePromoChannels(): void {
    this.atomicWriteJson('promo_channels.json', this.promoChannels);
  }

  public saveMtprotoSession(session: string): void {
    this.mtprotoSessionString = session.trim();
    this.atomicWriteJson('mtproto_session.json', {
      session: this.mtprotoSessionString,
      updatedAt: new Date().toISOString(),
    });
  }

  public persistAll(): void {
    this.saveConfig();
    this.saveJobs();
    this.saveUsers();
    this.saveQuotaSettings();
    this.saveUserSessions();
    this.saveAlerts();
    this.saveWatchedVideos();
    this.saveVaultSnapshots();
    this.savePinnedSeries();
    this.saveChannelRequests();
    this.saveIgnoredComments();
    this.savePromoChannels();
  }

  public exportBundle(): PersistedStateBundle & { mtprotoSessionString: string } {
    return {
      config: this.config,
      jobs: this.jobs,
      users: this.users,
      quotaSettings: this.quotaSettings,
      userSessions: this.userSessions,
      alerts: this.alerts,
      watchedVideos: this.watchedVideos,
      vaultSnapshots: this.vaultSnapshots,
      pinnedSeriesIds: this.pinnedSeriesIds,
      channelRequests: this.channelRequests,
      ignoredCommentIds: this.ignoredCommentIds,
      promoChannels: this.promoChannels,
      mtprotoSessionString: this.mtprotoSessionString,
    };
  }

  public importBundle(bundle: Partial<PersistedStateBundle & { mtprotoSessionString?: string }>): void {
    if (bundle.config) this.config = { ...this.config, ...bundle.config };
    if (Array.isArray(bundle.jobs)) this.jobs = bundle.jobs;
    if (Array.isArray(bundle.users)) {
      this.users = bundle.users.map((u) => ({
        ...u,
        uploadMode: u.uploadMode === 'fast' ? 'fast' : 'wizard',
      }));
    }
    if (bundle.quotaSettings) this.quotaSettings = { ...this.quotaSettings, ...bundle.quotaSettings };
    if (Array.isArray(bundle.userSessions)) this.userSessions = bundle.userSessions;
    if (Array.isArray(bundle.alerts)) this.alerts = bundle.alerts;
    if (Array.isArray(bundle.watchedVideos)) this.watchedVideos = bundle.watchedVideos;
    if (Array.isArray(bundle.pinnedSeriesIds)) this.pinnedSeriesIds = bundle.pinnedSeriesIds;
    if (Array.isArray(bundle.channelRequests)) this.channelRequests = bundle.channelRequests;
    if (Array.isArray(bundle.ignoredCommentIds)) this.ignoredCommentIds = bundle.ignoredCommentIds;
    if (Array.isArray(bundle.promoChannels)) this.promoChannels = bundle.promoChannels;
    if (typeof bundle.mtprotoSessionString === 'string' && bundle.mtprotoSessionString.trim()) {
      this.saveMtprotoSession(bundle.mtprotoSessionString);
    }
    this.seedAdminIdsFromEnv();
    this.persistAll();
  }
}

export const stateStore = new StateStore();
