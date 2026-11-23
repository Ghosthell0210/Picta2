import fs from 'fs';
import path from 'path';
import type {
  AuthorizedUser,
  PictaAlertEvent,
  QuotaSettings,
  RuntimeConfig,
  TelegramTransportMode,
  TransferJob,
  UserPictaSession,
  VaultSnapshotRecord,
  WatchedPictaVideo,
} from '../shared/types.ts';
import { netlog } from './netlog.ts';

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
  public mtprotoSessionString = '';

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
    // Keep env mode/url synced if explicitly provided
    if (process.env.TELEGRAM_MODE) {
      this.config.telegramMode = envMode;
    }
    if (process.env.APP_URL && !this.config.appUrl) {
      this.config.appUrl = process.env.APP_URL.trim();
    }

    this.jobs = this.readJson<TransferJob[]>('jobs.json', []);
    this.users = this.readJson<AuthorizedUser[]>('authorized_users.json', []);
    this.quotaSettings = this.readJson<QuotaSettings>('quota_settings.json', defaultQuota);
    this.userSessions = this.readJson<UserPictaSession[]>('user_sessions.json', []);
    this.alerts = this.readJson<PictaAlertEvent[]>('alerts.json', []);
    this.watchedVideos = this.readJson<WatchedPictaVideo[]>('watched_videos.json', []);
    this.vaultSnapshots = this.readJson<VaultSnapshotRecord[]>('vault_snapshots.json', []);

    const mtSessionFile = this.readJson<{ session: string; updatedAt?: string }>('mtproto_session.json', {
      session: '',
    });
    this.mtprotoSessionString = (process.env.TELEGRAM_MTPROTO_SESSION || '').trim() || mtSessionFile.session || '';

    this.seedAdminIdsFromEnv();
    this.persistAll();

    netlog.info('system', `Estado persistente inicializado en ${this.stateDir}`, {
      scratchDir: this.scratchDir,
      diskBudgetGb: this.config.diskBudgetGb,
    });
  }

  private seedAdminIdsFromEnv(): void {
    const combinedRaw = [process.env.MASTER_ADMIN_CHAT_ID || '', process.env.ADMIN_TELEGRAM_IDS || ''].join(',');
    const rawIds = Array.from(
      new Set(
        combinedRaw
          .split(',')
          .map((s) => s.trim())
          .filter((s) => /^\d+$/.test(s))
      )
    );

    const pictaUser = (process.env.PICTA_USERNAME || process.env.PICTA_DEFAULT_USERNAME || '').trim();
    const now = new Date().toISOString();
    for (const id of rawIds) {
      const existing = this.users.find((u) => u.telegramUserId === id);
      if (!existing) {
        this.users.push({
          telegramUserId: id,
          username: `admin_${id.slice(-4)}`,
          displayName: `Administrador (${id})`,
          role: 'admin',
          active: true,
          dailyQuotaGb: 25,
          dailyMaxFiles: 100,
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
      if (!fs.existsSync(target)) {
        return fallback;
      }
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
    fs.writeFileSync(tmpTarget, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmpTarget, target);
  }

  public saveConfig(): void {
    this.atomicWriteJson('runtime_config.json', this.config);
  }

  public saveJobs(): void {
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
    this.atomicWriteJson('alerts.json', this.alerts);
  }

  public saveWatchedVideos(): void {
    this.atomicWriteJson('watched_videos.json', this.watchedVideos);
  }

  public saveVaultSnapshots(): void {
    this.atomicWriteJson('vault_snapshots.json', this.vaultSnapshots);
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
      mtprotoSessionString: this.mtprotoSessionString,
    };
  }

  public importBundle(bundle: Partial<PersistedStateBundle & { mtprotoSessionString?: string }>): void {
    if (bundle.config) this.config = { ...this.config, ...bundle.config };
    if (Array.isArray(bundle.jobs)) this.jobs = bundle.jobs;
    if (Array.isArray(bundle.users)) this.users = bundle.users;
    if (bundle.quotaSettings) this.quotaSettings = { ...this.quotaSettings, ...bundle.quotaSettings };
    if (Array.isArray(bundle.userSessions)) this.userSessions = bundle.userSessions;
    if (Array.isArray(bundle.alerts)) this.alerts = bundle.alerts;
    if (Array.isArray(bundle.watchedVideos)) this.watchedVideos = bundle.watchedVideos;
    if (typeof bundle.mtprotoSessionString === 'string' && bundle.mtprotoSessionString.trim()) {
      this.saveMtprotoSession(bundle.mtprotoSessionString);
    }
    this.persistAll();
  }

  public verifyDirectoryWritable(): { stateWritable: boolean; scratchWritable: boolean } {
    const checkDir = (dir: string) => {
      try {
        const probe = path.join(dir, `.write_probe_${Date.now()}`);
        fs.writeFileSync(probe, 'ok', 'utf8');
        fs.unlinkSync(probe);
        return true;
      } catch {
        return false;
      }
    };
    return {
      stateWritable: checkDir(this.stateDir),
      scratchWritable: checkDir(this.scratchDir),
    };
  }
}

export const stateStore = new StateStore();
