export type TelegramTransportMode = 'polling' | 'webhook';

export type UploadMode = 'wizard' | 'fast';

export type TransferJobStatus =
  | 'queued'
  | 'downloading'
  | 'assembling'
  | 'uploading'
  | 'creating_picta_publication'
  | 'encoding_nomad'
  | 'awaiting_duplicate_confirmation'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type TransferJobSource = 'telegram_mtproto' | 'unir_assembler' | 'direct_url';

export interface TransferJob {
  id: string;
  userId: string;
  userName: string;
  title: string;
  description?: string;
  fileName: string;
  source: TransferJobSource;
  sourceUrl?: string;
  sizeBytes: number;
  downloadedBytes: number;
  uploadedBytes: number;
  progressPct: number;
  speedMbps: number;
  status: TransferJobStatus;
  nomadRetries: number;
  maxNomadRetries: number;
  pictaVideoId?: string;
  pictaWebUrl?: string;
  pictaChannel?: string;
  pictaChannelId?: string;
  minioKey?: string;
  tipologia?: number;
  clasificacion?: string;
  keywords?: string;
  year?: string;
  publicado?: boolean;
  descargable?: boolean;
  mostrarComentarios?: boolean;
  autoPromo?: boolean;
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
  duplicateCheckApprovedTitle?: string;
  telegramChatId?: string;
  telegramMessageId?: number;
  telegramFileId?: string;
  statusMessageId?: number;
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
  uploadMode: UploadMode;
  dailyQuotaGb: number;
  dailyMaxFiles: number;
  usedTodayGb: number;
  filesToday: number;
  lastQuotaResetDay?: string;
  pictaLinked: boolean;
  pictaUsername?: string;
  alertsEnabled: boolean;
  createdAt: string;
  lastActiveAt: string;
}

export interface PictaPoolAccount {
  id: string;
  ownerUserId: string;
  username: string;
  displayName: string;
  encryptedPassword: string;
  canPublishDirectly: boolean;
  uploadedToday: number;
  exhaustedDate?: string;
  addedAt: string;
}

export interface QuotaSettings {
  defaultDailyQuotaGb: number;
  defaultDailyMaxFiles: number;
  maxSingleFileGb: number;
  enforceQuotas: boolean;
  resetHourUtc: number;
  currentDateCuba?: string;
  maxSeriesPerDay?: number;
  seriesUploadedToday?: number;
  otherUploadedToday?: number;
  poolAccounts?: PictaPoolAccount[];
}

export interface PinnedBatchSerie {
  userId: string;
  serieId: number;
  serieName: string;
  seasonNum: number;
  seasonId?: number;
  nextEpisodeNumber?: number;
}

export interface UserAlertPreferences {
  userId: string;
  commentsEnabled: boolean;
  milestonesEnabled: boolean;
  enabledMetrics: {
    plays: boolean;
    likes: boolean;
    downloads: boolean;
    comments: boolean;
  };
  thresholds: number[];
}

export interface UserRequestsGroupConfig {
  userId: string;
  targetChannelId?: string;
  targetChannelLabel?: string;
  requestsGroupChatId?: string;
  requestsGroupLabel?: string;
  requestsMonitorMode: 'off' | 'prefix' | 'all';
}

export interface OwnedPictaChannel {
  id: number;
  nombre: string;
  alias?: string;
  slug_url?: string;
}

export interface UserPictaSession {
  telegramUserId: string;
  pictaUsername: string;
  encryptedPassword: string;
  defaultChannel: string;
  channelId: string;
  channelName: string;
  pictaUserId?: number;
  userFullName?: string;
  pictaGroups?: string[];
  hasChannelAdminRole?: boolean;
  availableChannels: OwnedPictaChannel[];
  connectedAt: string;
  lastVerifiedAt: string;
  notifyComments: boolean;
  notifyMilestones: boolean;
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
  lastLikesCount?: number;
  lastDownloadsCount?: number;
  lastMilestoneNotified: number;
  nomadStatus: 'ready' | 'encoding' | 'failed';
  updatedAt: string;
}

export interface PictaChannelProfile {
  id: number;
  nombre: string;
  alias: string;
  descripcion: string;
  clasificacion: string;
  slug_url?: string;
  visible: boolean;
  publicado: boolean;
  donacion?: boolean;
  cantidad_suscriptores: number;
  cantidad_publicaciones: number;
  url_avatar?: string;
  url_imagen?: string;
  propietarioId?: number;
  usuariosAsociados?: Array<{ id: number; label: string; isOwner: boolean }>;
}

export interface PictaCatalogItem {
  id: string;
  nombre: string;
  descripcion: string;
  slug?: string;
  webUrl: string;
  tipologiaId?: number;
  tipologiaNombre: string;
  clasificacion: string;
  cantidad_vistas: number;
  cantidad_reproducciones?: number;
  cantidad_comentarios: number;
  cantidad_me_gusta: number;
  cantidad_descargas: number;
  publicado: boolean;
  convertido?: boolean;
  descargable: boolean;
  estado_codificacion?: string;
  motivo_rechazo?: string;
  url_imagen?: string;
  imagen_secundaria?: string;
  url_subtitulo?: string;
  url_descarga?: string;
  url_manifiesto?: string;
  tamanio?: number;
  duracion?: number;
  serieId?: number;
  temporada?: number;
  numero?: number;
  palabras_clave?: string[];
  fecha_creacion?: string;
  fecha_publicado?: string;
}

export interface PictaSerieSeason {
  id: number;
  numero: number;
  nombre: string;
}

export interface PictaSerieItem {
  id: number;
  nombre: string;
  descripcion: string;
  canalId: number;
  cantidad_capitulos: number;
  url_imagen?: string;
  imagen_secundaria?: string;
  publicado: boolean;
  pinned?: boolean;
  seasons?: PictaSerieSeason[];
}

export interface PictaPlaylistItem {
  id: number;
  nombre: string;
  publicado: boolean;
  descarga: boolean;
  fecha_creacion?: string;
  canalId: number;
  canalNombre: string;
  publicacionesIds: number[];
}

export interface PictaCommentItem {
  id: number;
  texto: string;
  usuario: string;
  usuarioId?: number;
  fecha: string;
  publicacionId: number;
  publicacionNombre: string;
  tipologiaId?: number;
  categoriaNombre: string;
  parentId?: number;
  replyCount: number;
  answered: boolean;
  isLikelyRequest: boolean;
  ignored?: boolean;
}

export interface PictaDenunciasSummary {
  cantidad_pendientes: number;
  cantidad_en_proceso: number;
  cantidad_no_proceden: number;
  cantidad_procesadas: number;
  total: number;
}

export interface PictaDenunciaItem {
  id: number;
  estado: string;
  motivo: string;
  publicacionId?: number;
  publicacionNombre: string;
  fecha?: string;
}

export interface PictaGlobalSearchHit {
  id: number;
  kind: 'publicacion' | 'serie';
  title: string;
  categoryName: string;
  tipologiaId: number;
  channelId: string;
  channelName: string;
  sizeBytes: number;
  resolutions: string[];
  maxResolutionLabel: string;
  durationSeconds: number;
  views: number;
  createdAt: string;
  webUrl: string;
  manifestUrl?: string;
  downloadUrl?: string;
  matchScore: number;
  matchLevel: 'exact' | 'high' | 'partial';
}

export interface ChannelAuditItem {
  id: string;
  nombre: string;
  reason: string;
  publicado: boolean;
  views: number;
  createdAt?: string;
}

export interface ChannelAuditReport {
  totalScanned: number;
  duplicateGroups: Array<{ groupKey: string; reason: string; items: ChannelAuditItem[] }>;
  incompleteItems: ChannelAuditItem[];
  unpublishedItems: ChannelAuditItem[];
  orphanEpisodeItems: ChannelAuditItem[];
  generatedAt: string;
}

export interface ChannelRequestRecord {
  id: string;
  ownerUserId?: string;
  commentId?: number;
  requesterName: string;
  requesterUsername?: string;
  requestedTitle: string;
  rawText: string;
  sourceVideoTitle: string;
  status: 'pending' | 'fulfilled' | 'ignored';
  createdAt: string;
}

export interface PromoChannelRecord {
  id: string;
  name: string;
  telegramChatId: string;
  inviteUrl?: string;
  autoPostEnabled: boolean;
  createdAt: string;
}

export interface TmdbEnrichedCandidate {
  id: number;
  title: string;
  originalTitle?: string;
  mediaType: 'movie' | 'tv';
  year?: string;
  overview: string;
  posterUrl?: string;
  backdropUrl?: string;
  voteAverage?: number;
  popularity?: number;
  score: number;
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

export interface RuntimeTelemetry {
  startedAt: string;
  uptimeSeconds: number;
  nodeEnv: string;
  isCloudRunDetected: boolean;
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
