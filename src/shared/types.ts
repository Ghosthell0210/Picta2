export type TelegramTransportMode = 'polling' | 'webhook';

export type TransferJobStatus =
  | 'queued'
  | 'downloading'
  | 'assembling'
  | 'uploading'
  | 'encoding_nomad'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TransferJobSource = 'telegram_mtproto' | 'unir_assembler' | 'manual_queue';

export interface TransferJob {
  id: string;
  userId: string;
  userName: string;
  title: string;
  fileName: string;
  source: TransferJobSource;
  sizeBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  progressPct: number;
  speedMbps: number;
  status: TransferJobStatus;
  nomadRetries: number;
  maxNomadRetries: number;
  pictaVideoId?: string;
  pictaChannel?: string;
  minioKey?: string;
  tipologia?: number;
  telegramChatId?: string;
  telegramMessageId?: number;
  scratchPath?: string;
  partCount?: number;
  errorMessage?: string;
  createdAt: string;
  updatedAt: string;
}

export type UserRole = 'admin' | 'operator' | 'user';

export interface AuthorizedUser {
  telegramUserId: string;
  username: string;
  displayName: string;
  role: UserRole;
  active: boolean;
  dailyQuotaGb: number;
  dailyMaxFiles: number;
  usedTodayGb: number;
  filesToday: number;
  pictaLinked: boolean;
  pictaUsername?: string;
  alertsEnabled: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface QuotaSettings {
  defaultDailyQuotaGb: number;
  defaultDailyMaxFiles: number;
  maxSingleFileGb: number;
  enforceQuotas: boolean;
  resetHourUtc: number;
}

export interface UserPictaSession {
  telegramUserId: string;
  pictaUsername: string;
  defaultChannel: string;
  connectedAt: string;
  lastVerifiedAt: string;
  notifyComments: boolean;
  notifyMilestones: boolean;
  hasEncryptedToken: boolean;
}

export type PictaAlertType = 'comment' | 'milestone' | 'nomad_ready' | 'nomad_error';

export interface PictaAlertEvent {
  id: string;
  type: PictaAlertType;
  videoId: string;
  videoTitle: string;
  channelName: string;
  summary: string;
  metricValue?: number;
  notifiedTelegram: boolean;
  targetUserId?: string;
  detectedAt: string;
}

export interface WatchedPictaVideo {
  videoId: string;
  title: string;
  channelName: string;
  ownerUserId: string;
  lastCommentCount: number;
  lastViewsCount: number;
  lastMilestoneNotified: number;
  nomadStatus: 'ready' | 'encoding' | 'failed';
  updatedAt: string;
}

export type NetlogCategory = 'mtproto' | 'picta' | 'disk' | 'vault' | 'telegram' | 'assembler' | 'system';
export type NetlogLevel = 'info' | 'warn' | 'error';

export interface NetlogEntry {
  id: string;
  timestamp: string;
  category: NetlogCategory;
  level: NetlogLevel;
  message: string;
  latencyMs?: number;
  throughputMbps?: number;
  meta?: Record<string, string | number | boolean>;
}

export interface RuntimeConfig {
  telegramMode: TelegramTransportMode;
  appUrl: string;
  mtprotoWorkers: number;
  mtprotoTcpPoolSize: number;
  maxPrefetchLookahead: number;
  diskBudgetGb: number;
  minFreeScratchMb: number;
  alertsIntervalMs: number;
  nomadRetryIntervalMs: number;
  queuePaused: boolean;
  autoVaultSyncEnabled: boolean;
}

export interface ScratchFileEntry {
  name: string;
  relativePath: string;
  sizeBytes: number;
  modifiedAt: string;
  isDirectory: boolean;
  protectedByJobId?: string;
}

export interface DiskStatusReport {
  stateDir: string;
  scratchDir: string;
  budgetBytes: number;
  stateUsedBytes: number;
  scratchUsedBytes: number;
  protectedBytes: number;
  reclaimableBytes: number;
  budgetRemainingBytes: number;
  volumeTotalBytes: number;
  volumeFreeBytes: number;
  usagePct: number;
  pressureLevel: 'nominal' | 'warning' | 'critical';
  files: ScratchFileEntry[];
}

export interface SystemBinariesStatus {
  node: { available: boolean; version: string };
  ffmpeg: { available: boolean; version: string };
  unzip: { available: boolean; version: string };
  tar: { available: boolean; version: string };
}

export interface VaultSnapshotRecord {
  id: string;
  createdAt: string;
  destination: 'telegram_vault_chat' | 'telegram_bot_commands' | 'local_encrypted_archive';
  checksumSha256: string;
  payloadBytes: number;
  includesMtprotoSession: boolean;
  status: 'synced' | 'local_only' | 'error';
  message: string;
}

export interface EnvCheckItem {
  key: string;
  configured: boolean;
  requiredForProduction: boolean;
  category: 'telegram' | 'mtproto' | 'picta' | 'storage' | 'vault' | 'security';
  description: string;
}

export interface RuntimeTelemetry {
  startedAt: string;
  uptimeSeconds: number;
  nodeEnv: string;
  isCloudRunDetected: boolean;
  cloudRunKeepAliveActive: boolean;
  telegram: {
    mode: TelegramTransportMode;
    botConfigured: boolean;
    botUsername?: string;
    pollingActive: boolean;
    webhookActive: boolean;
    webhookUrl?: string;
    updatesProcessed: number;
    lastPollAt?: string;
    lastError?: string;
  };
  mtproto: {
    configured: boolean;
    connected: boolean;
    activeSockets: number;
    targetPoolSize: number;
    safeParallelWorkers: number;
    maxPrefetchLookahead: number;
    aesPressureWarning: boolean;
    sessionPresent: boolean;
    lastEventAt?: string;
  };
  picta: {
    baseUrl: string;
    defaultAccountConfigured: boolean;
    lastAlertScanAt?: string;
    lastNomadCheckAt?: string;
    watchedVideosCount: number;
    alertsPendingCount: number;
  };
  vault: {
    chatConfigured: boolean;
    encryptionKeyConfigured: boolean;
    lastSyncAt?: string;
    snapshotsCount: number;
  };
  binaries: SystemBinariesStatus;
}

export interface AuthStatusResponse {
  requiresClaim: boolean;
  envPasscodeConfigured: boolean;
  authenticated: boolean;
}

export interface DashboardBootstrapResponse {
  telemetry: RuntimeTelemetry;
  config: RuntimeConfig;
  disk: DiskStatusReport;
  jobs: TransferJob[];
  users: AuthorizedUser[];
  quotaSettings: QuotaSettings;
  alerts: PictaAlertEvent[];
  watchedVideos: WatchedPictaVideo[];
  netlog: NetlogEntry[];
  vaultSnapshots: VaultSnapshotRecord[];
  envChecks: EnvCheckItem[];
}
