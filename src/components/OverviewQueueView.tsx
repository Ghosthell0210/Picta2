import React, { useMemo, useState } from 'react';
import { Pause, Play, Plus, RefreshCw, RotateCcw, Search, Trash2, X } from 'lucide-react';
import type { DashboardBootstrapResponse, TransferJob, TransferJobSource, TransferJobStatus } from '../shared/types';
import { apiRequest, formatBytes, formatDateTimeShort, formatUptime } from '../lib/api';

interface OverviewQueueViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

const STATUS_LABELS: Record<TransferJobStatus, string> = {
  queued: 'En cola',
  downloading: 'Descargando MTProto',
  assembling: 'Ensamblando /unir',
  uploading: 'Subiendo a Picta',
  encoding_nomad: 'Codificando Nomad',
  completed: 'Completado',
  failed: 'Fallido',
  cancelled: 'Cancelado',
};

const SOURCE_LABELS: Record<TransferJobSource, string> = {
  telegram_mtproto: 'Telegram MTProto',
  unir_assembler: 'Ensamblador /unir',
  manual_queue: 'Cola manual',
};

function getStatusColorClass(status: TransferJobStatus): string {
  switch (status) {
    case 'completed':
      return 'text-[#4ADE80]';
    case 'failed':
    case 'cancelled':
      return 'text-[#F87171]';
    case 'encoding_nomad':
    case 'assembling':
      return 'text-[#FBBF24]';
    default:
      return 'text-[#60A5FA]';
  }
}

export function OverviewQueueView({ data, token, onRefresh, onToast }: OverviewQueueViewProps) {
  const [filter, setFilter] = useState<'all' | 'active' | 'nomad' | 'completed' | 'failed'>('all');
  const [query, setQuery] = useState('');
  const [busyId, setBusyId] = useState<string | null>(null);
  const [togglingPause, setTogglingPause] = useState(false);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newFileName, setNewFileName] = useState('capitulo_01_1080p.mp4');
  const [newSource, setNewSource] = useState<TransferJobSource>('telegram_mtproto');
  const [newSizeMb, setNewSizeMb] = useState('450');
  const [newChannel, setNewChannel] = useState('Canal Principal');
  const [newPartCount, setNewPartCount] = useState('3');
  const [creating, setCreating] = useState(false);

  const activeJobsCount = useMemo(
    () =>
      data.jobs.filter((j) =>
        ['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(j.status)
      ).length,
    [data.jobs]
  );

  const filteredJobs = useMemo(() => {
    return data.jobs.filter((job) => {
      if (filter === 'active') {
        if (!['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad'].includes(job.status)) return false;
      } else if (filter === 'nomad') {
        if (job.status !== 'encoding_nomad') return false;
      } else if (filter === 'completed') {
        if (job.status !== 'completed') return false;
      } else if (filter === 'failed') {
        if (job.status !== 'failed' && job.status !== 'cancelled') return false;
      }

      if (query.trim()) {
        const q = query.toLowerCase();
        return (
          job.title.toLowerCase().includes(q) ||
          job.fileName.toLowerCase().includes(q) ||
          job.userName.toLowerCase().includes(q) ||
          job.id.toLowerCase().includes(q)
        );
      }
      return true;
    });
  }, [data.jobs, filter, query]);

  async function toggleQueuePause() {
    setTogglingPause(true);
    try {
      await apiRequest('/api/config', {
        method: 'PATCH',
        token,
        body: { queuePaused: !data.config.queuePaused },
      });
      await onRefresh();
      onToast(data.config.queuePaused ? 'Cola de transferencias reanudada.' : 'Cola pausada.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error cambiando estado de cola.', 'error');
    } finally {
      setTogglingPause(false);
    }
  }

  async function handleCreateJob(e: React.FormEvent) {
    e.preventDefault();
    setCreating(true);
    try {
      await apiRequest('/api/jobs', {
        method: 'POST',
        token,
        body: {
          title: newTitle,
          fileName: newFileName,
          source: newSource,
          sizeMb: Number(newSizeMb),
          pictaChannel: newChannel,
          partCount: newSource === 'unir_assembler' ? Number(newPartCount) : undefined,
        },
      });
      setShowCreateModal(false);
      setNewTitle('');
      await onRefresh();
      onToast('Trabajo encolado y archivo temporal protegido en disco persistente.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo encolar el trabajo.', 'error');
    } finally {
      setCreating(false);
    }
  }

  async function handleRetry(job: TransferJob, mode: 'full' | 'nomad') {
    setBusyId(job.id);
    try {
      await apiRequest(`/api/jobs/${job.id}/retry`, {
        method: 'POST',
        token,
        body: { mode },
      });
      await onRefresh();
      onToast(mode === 'nomad' ? 'Reintento Nomad activado.' : 'Trabajo reencolado.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error reintentando trabajo.', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleCancel(job: TransferJob) {
    setBusyId(job.id);
    try {
      await apiRequest(`/api/jobs/${job.id}/cancel`, {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast('Trabajo cancelado y espacio scratch liberado.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error cancelando trabajo.', 'error');
    } finally {
      setBusyId(null);
    }
  }

  async function handleDelete(job: TransferJob) {
    setBusyId(job.id);
    try {
      await apiRequest(`/api/jobs/${job.id}`, {
        method: 'DELETE',
        token,
      });
      await onRefresh();
      onToast('Registro eliminado del historial.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error eliminando registro.', 'error');
    } finally {
      setBusyId(null);
    }
  }

  const { telemetry, disk, config } = data;
  const telegramStateText = telemetry.telegram.pollingActive
    ? 'Polling 24/7 activo'
    : telemetry.telegram.webhookActive
      ? 'Webhook HTTPS activo'
      : telemetry.telegram.botConfigured
        ? 'Conectando...'
        : 'Sin TELEGRAM_BOT_TOKEN';

  const telegramStateColor =
    telemetry.telegram.pollingActive || telemetry.telegram.webhookActive
      ? 'text-[#4ADE80]'
      : telemetry.telegram.botConfigured
        ? 'text-[#FBBF24]'
        : 'text-[#94A3B8]';

  const diskColor =
    disk.pressureLevel === 'critical'
      ? 'text-[#F87171]'
      : disk.pressureLevel === 'warning'
        ? 'text-[#FBBF24]'
        : 'text-[#4ADE80]';

  return (
    <div className="space-y-6">
      {/* 4-column tabular KPI strip */}
      <section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
        <div className="bg-[#111926] border border-[#223047] rounded-lg p-5">
          <div className="text-xs text-[#94A3B8] mb-2">Transporte Telegram</div>
          <div className={`text-base font-semibold ${telegramStateColor}`}>{telegramStateText}</div>
          <div className="mt-2 text-xs text-[#64748B] font-mono tabular-nums">
            {telemetry.telegram.botUsername ? `@${telemetry.telegram.botUsername}` : config.telegramMode} ·{' '}
            {telemetry.telegram.updatesProcessed} updates
          </div>
        </div>

        <div className="bg-[#111926] border border-[#223047] rounded-lg p-5">
          <div className="text-xs text-[#94A3B8] mb-2">Pool MTProto (Altare CPU)</div>
          <div className="text-base font-semibold text-white font-mono tabular-nums">
            {config.mtprotoWorkers} workers / {config.mtprotoTcpPoolSize} TCP
          </div>
          <div className="mt-2 text-xs text-[#64748B]">
            {telemetry.mtproto.connected
              ? 'Sockets conectados'
              : telemetry.mtproto.configured
                ? 'En espera de enlace'
                : 'Faltan API ID / Hash'}{' '}
            · Lookahead {config.maxPrefetchLookahead}
          </div>
        </div>

        <div className="bg-[#111926] border border-[#223047] rounded-lg p-5">
          <div className="text-xs text-[#94A3B8] mb-2">Presupuesto Disco Persistente</div>
          <div className="flex items-baseline justify-between gap-2">
            <span className={`text-base font-semibold font-mono tabular-nums ${diskColor}`}>{disk.usagePct}% usado</span>
            <span className="text-xs text-[#94A3B8] font-mono tabular-nums">
              {formatBytes(disk.budgetRemainingBytes)} libres
            </span>
          </div>
          <div className="mt-2.5 h-1.5 w-full bg-[#0B111A] rounded-full overflow-hidden">
            <div
              className={`h-full transition-all ${
                disk.pressureLevel === 'critical'
                  ? 'bg-[#DC2626]'
                  : disk.pressureLevel === 'warning'
                    ? 'bg-[#D97706]'
                    : 'bg-[#3B82F6]'
              }`}
              style={{ width: `${Math.min(100, Math.max(2, disk.usagePct))}%` }}
            />
          </div>
          <div className="mt-2 text-xs text-[#64748B] font-mono tabular-nums">
            Tope {config.diskBudgetGb} GB · Protegido {formatBytes(disk.protectedBytes)}
          </div>
        </div>

        <div className="bg-[#111926] border border-[#223047] rounded-lg p-5">
          <div className="text-xs text-[#94A3B8] mb-2">Runtime Always-On</div>
          <div className="text-base font-semibold text-white font-mono tabular-nums">
            {formatUptime(telemetry.uptimeSeconds)}
          </div>
          <div className="mt-2 text-xs text-[#64748B]">
            Cola: {config.queuePaused ? 'Pausada' : `${activeJobsCount} activos`} · Keep-alive Cloud Run:{' '}
            {telemetry.cloudRunKeepAliveActive ? 'Activo' : 'Desactivado'}
          </div>
        </div>
      </section>

      {/* Queue section */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#223047] flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">Cola de Transferencias y Codificación Nomad</h2>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Seguimiento en disco persistente con candado de protección temporal y reintento Nomad cada{' '}
              <span className="font-mono tabular-nums">{Math.round(config.nomadRetryIntervalMs / 1000)}s</span>.
            </p>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={toggleQueuePause}
              disabled={togglingPause}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] transition-colors whitespace-nowrap shrink-0"
            >
              {config.queuePaused ? <Play className="w-3.5 h-3.5" /> : <Pause className="w-3.5 h-3.5" />}
              {config.queuePaused ? 'Reanudar cola' : 'Pausar cola'}
            </button>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white transition-colors whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Encolar transferencia
            </button>
          </div>
        </div>

        {/* Filter & Search Bar */}
        <div className="px-5 py-3 border-b border-[#223047] flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0E1520]">
          <div className="flex items-center gap-1 p-1 bg-[#0B111A] border border-[#223047] rounded-md overflow-x-auto">
            {(
              [
                ['all', `Todos (${data.jobs.length})`],
                ['active', `Activos (${activeJobsCount})`],
                ['nomad', 'Nomad'],
                ['completed', 'Completados'],
                ['failed', 'Fallidos'],
              ] as const
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                onClick={() => setFilter(key)}
                className={`px-3 py-1.5 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  filter === key
                    ? 'bg-[#1E2B42] text-white'
                    : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-72">
            <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Buscar por título, archivo o usuario..."
              className="w-full bg-[#0B111A] border border-[#223047] rounded-md pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
            />
          </div>
        </div>

        {/* Table or Empty state */}
        {filteredJobs.length === 0 ? (
          <div className="px-6 py-14 text-center">
            <p className="text-sm font-medium text-white">No hay trabajos que coincidan con este filtro</p>
            <p className="text-xs text-[#94A3B8] mt-1 max-w-md mx-auto">
              Cuando un usuario autorizado envíe un video o comando /unir al bot en Telegram, aparecerá aquí con su
              progreso y candado de disco. También puedes registrar un trabajo manual para verificar la cola.
            </p>
            <button
              type="button"
              onClick={() => setShowCreateModal(true)}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white transition-colors"
            >
              <Plus className="w-3.5 h-3.5" />
              Registrar primer trabajo
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#223047] text-[11px] font-medium text-[#94A3B8] bg-[#0E1520]">
                  <th className="py-2.5 px-5">Trabajo / Archivo</th>
                  <th className="py-2.5 px-4">Origen · Usuario</th>
                  <th className="py-2.5 px-4 text-right">Tamaño</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-4 text-right">Nomad</th>
                  <th className="py-2.5 px-4 text-right">Actualizado</th>
                  <th className="py-2.5 px-5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/70 text-xs">
                {filteredJobs.map((job) => {
                  const isBusy = busyId === job.id;
                  const isTerminal = job.status === 'completed' || job.status === 'cancelled';
                  return (
                    <tr key={job.id} className="hover:bg-[#162032]/60 transition-colors">
                      <td className="py-3 px-5 max-w-xs">
                        <div className="font-medium text-white truncate">{job.title}</div>
                        <div className="text-[#64748B] font-mono text-[11px] truncate mt-0.5">
                          {job.fileName}
                          {job.partCount ? ` · ${job.partCount} partes` : ''}
                        </div>
                        {job.errorMessage && (
                          <div className="text-[#F87171] text-[11px] mt-1 truncate">{job.errorMessage}</div>
                        )}
                      </td>
                      <td className="py-3 px-4 text-[#CBD5E1] whitespace-nowrap">
                        <div>{SOURCE_LABELS[job.source]}</div>
                        <div className="text-[#64748B] text-[11px] mt-0.5">
                          {job.userName} · {job.pictaChannel || 'Sin canal'}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#E6EDF7] whitespace-nowrap">
                        {formatBytes(job.sizeBytes)}
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <div className={`font-medium ${getStatusColorClass(job.status)}`}>
                          {STATUS_LABELS[job.status]}
                        </div>
                        <div className="text-[11px] text-[#64748B] font-mono tabular-nums mt-0.5">
                          {job.progressPct}%{job.speedMbps > 0 ? ` · ${job.speedMbps.toFixed(1)} MB/s` : ''}
                        </div>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#94A3B8] whitespace-nowrap">
                        {job.nomadRetries}/{job.maxNomadRetries}
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums text-[#64748B] whitespace-nowrap">
                        {formatDateTimeShort(job.updatedAt)}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={isBusy}
                            onClick={() => handleRetry(job, 'nomad')}
                            title="Reintentar codificación Nomad"
                            className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#CBD5E1] disabled:opacity-40"
                          >
                            <RefreshCw className="w-3.5 h-3.5" />
                          </button>
                          {(job.status === 'failed' || job.status === 'cancelled') && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleRetry(job, 'full')}
                              title="Reencolar trabajo"
                              className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#60A5FA] disabled:opacity-40"
                            >
                              <RotateCcw className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {!isTerminal && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleCancel(job)}
                              title="Cancelar y liberar disco"
                              className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#DC2626]/20 text-[#F87171] disabled:opacity-40"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {isTerminal && (
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => handleDelete(job)}
                              title="Eliminar registro"
                              className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#DC2626]/20 text-[#94A3B8] hover:text-[#F87171] disabled:opacity-40"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Enqueue Job Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-lg bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Encolar transferencia en PictaBot</h3>
              <button
                type="button"
                onClick={() => setShowCreateModal(false)}
                className="text-[#94A3B8] hover:text-white p-1"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleCreateJob} className="p-5 space-y-4 text-xs">
              <div>
                <label className="block text-[#CBD5E1] mb-1">Título de publicación en Picta</label>
                <input
                  type="text"
                  required
                  value={newTitle}
                  onChange={(e) => setNewTitle(e.target.value)}
                  placeholder="Ej. Documental Tecnología 2026 (1080p)"
                  className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Nombre de archivo</label>
                  <input
                    type="text"
                    required
                    value={newFileName}
                    onChange={(e) => setNewFileName(e.target.value)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Canal destino</label>
                  <input
                    type="text"
                    value={newChannel}
                    onChange={(e) => setNewChannel(e.target.value)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Origen</label>
                  <select
                    value={newSource}
                    onChange={(e) => setNewSource(e.target.value as TransferJobSource)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                  >
                    <option value="telegram_mtproto">Descarga Telegram MTProto</option>
                    <option value="unir_assembler">Ensamblador multiparte /unir</option>
                    <option value="manual_queue">Cola manual</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Tamaño estimado (MB)</label>
                  <input
                    type="number"
                    min={1}
                    max={4096}
                    required
                    value={newSizeMb}
                    onChange={(e) => setNewSizeMb(e.target.value)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              </div>

              {newSource === 'unir_assembler' && (
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Cantidad de partes a ensamblar</label>
                  <input
                    type="number"
                    min={2}
                    max={20}
                    value={newPartCount}
                    onChange={(e) => setNewPartCount(e.target.value)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              )}

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowCreateModal(false)}
                  className="px-4 py-2 rounded-md border border-[#223047] text-[#CBD5E1] hover:bg-[#162032]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={creating}
                  className="px-4 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium disabled:opacity-50"
                >
                  {creating ? 'Validando espacio...' : 'Encolar trabajo'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
