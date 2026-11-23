import React, { useState } from 'react';
import { Bell, Check, Plus, Radio, RefreshCw, Trash2, Wifi } from 'lucide-react';
import type { DashboardBootstrapResponse, PictaAlertType } from '../shared/types';
import { apiRequest, formatDateTimeShort } from '../lib/api';

interface PictaAlertsViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

const ALERT_TYPE_LABELS: Record<PictaAlertType, string> = {
  comment: 'Nuevo comentario',
  milestone: 'Logro de vistas',
  nomad_ready: 'Nomad completado',
  nomad_error: 'Error Nomad',
};

export function PictaAlertsView({ data, token, onRefresh, onToast }: PictaAlertsViewProps) {
  const [videoId, setVideoId] = useState('');
  const [title, setTitle] = useState('');
  const [channelName, setChannelName] = useState('Canal Principal');
  const [adding, setAdding] = useState(false);

  const [scanning, setScanning] = useState(false);
  const [checkingHealth, setCheckingHealth] = useState(false);
  const [sweepingNomad, setSweepingNomad] = useState(false);

  async function handleAddWatched(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await apiRequest('/api/watched-videos', {
        method: 'POST',
        token,
        body: { videoId, title, channelName },
      });
      setVideoId('');
      setTitle('');
      await onRefresh();
      onToast('Publicación agregada al ciclo automático de vigilancia (65s).');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error agregando publicación.', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function handleRemoveWatched(id: string) {
    try {
      await apiRequest(`/api/watched-videos/${encodeURIComponent(id)}`, {
        method: 'DELETE',
        token,
      });
      await onRefresh();
      onToast('Video retirado de la lista de vigilancia.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo retirar el video.', 'error');
    }
  }

  async function handleManualScan() {
    setScanning(true);
    try {
      const resp = await apiRequest<{ ok: boolean; scannedCount: number; newAlerts: unknown[] }>('/api/picta/scan', {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast(`Escaneo completado: ${resp.scannedCount} video(s) revisado(s), ${resp.newAlerts.length} nueva(s) alerta(s).`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error ejecutando escaneo Picta.', 'error');
    } finally {
      setScanning(false);
    }
  }

  async function handleCheckPicta() {
    setCheckingHealth(true);
    try {
      const resp = await apiRequest<{ ok: boolean; reachable: boolean; statusCode?: number; latencyMs: number }>(
        '/api/picta/check',
        { method: 'POST', token }
      );
      await onRefresh();
      if (resp.reachable) {
        onToast(`Picta alcanzable (HTTP ${resp.statusCode} · ${resp.latencyMs} ms).`);
      } else {
        onToast(`No se pudo conectar con ${data.telemetry.picta.baseUrl} (${resp.latencyMs} ms).`, 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error comprobando conectividad.', 'error');
    } finally {
      setCheckingHealth(false);
    }
  }

  async function handleNomadSweep() {
    setSweepingNomad(true);
    try {
      const resp = await apiRequest<{ ok: boolean; checked: number; advanced: number }>('/api/picta/nomad-sweep', {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast(`Barrido Nomad ejecutado: ${resp.checked} revisado(s), ${resp.advanced} actualizado(s).`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error ejecutando barrido Nomad.', 'error');
    } finally {
      setSweepingNomad(false);
    }
  }

  async function handleAckAlert(id: string) {
    try {
      await apiRequest(`/api/alerts/${id}/ack`, { method: 'PATCH', token });
      await onRefresh();
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error actualizando alerta.', 'error');
    }
  }

  return (
    <div className="space-y-6">
      {/* Scanner controls */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg p-5">
        <div className="flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">Escáner de Alertas Picta y Reintento Nomad</h2>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Endpoint: <span className="font-mono text-[#CBD5E1]">{data.telemetry.picta.baseUrl}</span> · Ciclo
              comentarios/logros cada{' '}
              <span className="font-mono tabular-nums">{Math.round(data.config.alertsIntervalMs / 1000)}s</span> ·
              Reintento Nomad cada{' '}
              <span className="font-mono tabular-nums">{Math.round(data.config.nomadRetryIntervalMs / 1000)}s</span>
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              onClick={handleCheckPicta}
              disabled={checkingHealth}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] whitespace-nowrap"
            >
              <Wifi className="w-3.5 h-3.5" />
              {checkingHealth ? 'Probando...' : 'Probar Picta'}
            </button>
            <button
              type="button"
              onClick={handleNomadSweep}
              disabled={sweepingNomad}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] whitespace-nowrap"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              {sweepingNomad ? 'Verificando...' : 'Barrido Nomad'}
            </button>
            <button
              type="button"
              onClick={handleManualScan}
              disabled={scanning}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white whitespace-nowrap"
            >
              <Radio className="w-3.5 h-3.5" />
              {scanning ? 'Escaneando...' : 'Escanear ahora'}
            </button>
          </div>
        </div>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        {/* Watched Videos */}
        <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#223047]">
            <h3 className="text-sm font-semibold text-white">Publicaciones vigiladas ({data.watchedVideos.length})</h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Detecta nuevos comentarios e hitos (100, 500, 1K, 5K, 10K+ vistas) de forma continua 24/7 sin
              interrupciones.
            </p>
          </div>

          <form onSubmit={handleAddWatched} className="p-4 border-b border-[#223047] bg-[#0E1520] space-y-3 text-xs">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              <input
                type="text"
                required
                value={videoId}
                onChange={(e) => setVideoId(e.target.value)}
                placeholder="ID / slug de publicación Picta"
                className="bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
              <input
                type="text"
                value={channelName}
                onChange={(e) => setChannelName(e.target.value)}
                placeholder="Nombre del canal"
                className="bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
            <div className="flex gap-2.5">
              <input
                type="text"
                required
                value={title}
                onChange={(e) => setTitle(e.target.value)}
                placeholder="Título del video en Picta"
                className="flex-1 bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
              <button
                type="submit"
                disabled={adding}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium whitespace-nowrap"
              >
                <Plus className="w-3.5 h-3.5" />
                Vigilar
              </button>
            </div>
          </form>

          {data.watchedVideos.length === 0 ? (
            <div className="p-8 text-center text-xs text-[#94A3B8]">
              Agrega el ID de una publicación de <code className="text-[#CBD5E1]">videos.picta.cu</code> para comenzar
              a recibir alertas de comentarios y logros.
            </div>
          ) : (
            <div className="divide-y divide-[#223047]/70">
              {data.watchedVideos.map((v) => (
                <div key={v.videoId} className="px-5 py-3 flex items-center justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="font-medium text-white truncate">{v.title}</div>
                    <div className="text-[#64748B] font-mono text-[11px] mt-0.5">
                      ID {v.videoId} · {v.channelName} · {v.lastViewsCount} vistas · {v.lastCommentCount} comentarios
                    </div>
                  </div>
                  <button
                    type="button"
                    onClick={() => handleRemoveWatched(v.videoId)}
                    title="Dejar de vigilar"
                    className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#DC2626]/20 text-[#94A3B8] hover:text-[#F87171] shrink-0"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>

        {/* Detected Alerts Feed */}
        <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between">
            <div>
              <h3 className="text-sm font-semibold text-white">Historial de Alertas y Logros</h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Último escaneo: <span className="font-mono">{formatDateTimeShort(data.telemetry.picta.lastAlertScanAt)}</span>
              </p>
            </div>
            <span className="text-xs font-mono tabular-nums text-[#94A3B8]">{data.alerts.length} evento(s)</span>
          </div>

          {data.alerts.length === 0 ? (
            <div className="p-10 text-center text-xs text-[#94A3B8]">
              <Bell className="w-6 h-6 mx-auto text-[#64748B] mb-2" />
              Sin alertas registradas todavía. Cuando se detecten nuevos comentarios o logros aparecerán aquí.
            </div>
          ) : (
            <div className="divide-y divide-[#223047]/70 max-h-[420px] overflow-y-auto">
              {data.alerts.map((alert) => (
                <div key={alert.id} className="px-5 py-3 flex items-start justify-between gap-3 text-xs">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 text-[11px]">
                      <span className="font-medium text-[#60A5FA]">{ALERT_TYPE_LABELS[alert.type]}</span>
                      <span className="text-[#64748B]">·</span>
                      <span className="text-[#94A3B8] font-mono tabular-nums">
                        {formatDateTimeShort(alert.detectedAt)}
                      </span>
                    </div>
                    <div className="font-medium text-white mt-0.5 truncate">{alert.videoTitle}</div>
                    <div className="text-[#94A3B8] mt-0.5">{alert.summary}</div>
                  </div>
                  {alert.notifiedTelegram ? (
                    <span className="text-[11px] text-[#4ADE80] whitespace-nowrap shrink-0">Notificada</span>
                  ) : (
                    <button
                      type="button"
                      onClick={() => handleAckAlert(alert.id)}
                      className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#CBD5E1] whitespace-nowrap shrink-0"
                    >
                      <Check className="w-3 h-3" />
                      Marcar leída
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
