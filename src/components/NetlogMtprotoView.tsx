import React, { useEffect, useMemo, useState } from 'react';
import { Download, Save, Search, Trash2 } from 'lucide-react';
import type { DashboardBootstrapResponse, NetlogCategory, TelegramTransportMode } from '../shared/types';
import { apiRequest, formatTimeShort } from '../lib/api';

interface NetlogMtprotoViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

const CATEGORY_LABELS: Record<NetlogCategory | 'all', string> = {
  all: 'Todos',
  mtproto: 'MTProto',
  picta: 'Picta',
  disk: 'Disco',
  assembler: '/unir',
  vault: 'Bóveda',
  telegram: 'Telegram',
  system: 'Sistema',
};

export function NetlogMtprotoView({ data, token, onRefresh, onToast }: NetlogMtprotoViewProps) {
  const [telegramMode, setTelegramMode] = useState<TelegramTransportMode>(data.config.telegramMode);
  const [appUrl, setAppUrl] = useState(data.config.appUrl);
  const [mtprotoWorkers, setMtprotoWorkers] = useState(data.config.mtprotoWorkers);
  const [mtprotoTcpPoolSize, setMtprotoTcpPoolSize] = useState(data.config.mtprotoTcpPoolSize);
  const [maxPrefetchLookahead, setMaxPrefetchLookahead] = useState(data.config.maxPrefetchLookahead);
  const [diskBudgetGb, setDiskBudgetGb] = useState(data.config.diskBudgetGb);
  const [saving, setSaving] = useState(false);

  const [category, setCategory] = useState<NetlogCategory | 'all'>('all');
  const [query, setQuery] = useState('');
  const [clearing, setClearing] = useState(false);

  useEffect(() => {
    setTelegramMode(data.config.telegramMode);
    setAppUrl(data.config.appUrl);
    setMtprotoWorkers(data.config.mtprotoWorkers);
    setMtprotoTcpPoolSize(data.config.mtprotoTcpPoolSize);
    setMaxPrefetchLookahead(data.config.maxPrefetchLookahead);
    setDiskBudgetGb(data.config.diskBudgetGb);
  }, [data.config]);

  const filteredLogs = useMemo(() => {
    return data.netlog.filter((entry) => {
      if (category !== 'all' && entry.category !== category) return false;
      if (query.trim()) {
        const q = query.toLowerCase();
        return entry.message.toLowerCase().includes(q) || entry.category.toLowerCase().includes(q);
      }
      return true;
    });
  }, [data.netlog, category, query]);

  async function handleSaveConfig(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    try {
      await apiRequest('/api/config', {
        method: 'PATCH',
        token,
        body: {
          telegramMode,
          appUrl,
          mtprotoWorkers,
          mtprotoTcpPoolSize,
          maxPrefetchLookahead,
          diskBudgetGb,
        },
      });
      await onRefresh();
      onToast('Parámetros MTProto y transporte Telegram guardados en disco persistente.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error guardando configuración.', 'error');
    } finally {
      setSaving(false);
    }
  }

  async function handleClearNetlog() {
    setClearing(true);
    try {
      await apiRequest('/api/netlog', { method: 'DELETE', token });
      await onRefresh();
      onToast('Registro /netlog limpiado.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo limpiar /netlog.', 'error');
    } finally {
      setClearing(false);
    }
  }

  function handleExportJson() {
    const blob = new Blob([JSON.stringify(filteredLogs, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `pictabot_netlog_${new Date().toISOString().slice(0, 19).replace(/:/g, '-')}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="space-y-6">
      {/* MTProto & Transport Tuning */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg p-5">
        <div className="pb-4 border-b border-[#223047]">
          <h2 className="text-base font-semibold text-white">Afinación MTProto y Transporte Telegram</h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Ajusta en caliente el paralelismo de descifrado AES para CPU compartida en Altare y conmuta entre Long
            Polling 24/7 o Webhook HTTPS.
          </p>
        </div>

        <form onSubmit={handleSaveConfig} className="pt-4 space-y-5 text-xs">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
            <div>
              <label className="block text-[#CBD5E1] mb-1.5">Modo de conexión Telegram</label>
              <div className="flex items-center gap-1 p-1 bg-[#0B111A] border border-[#223047] rounded-md">
                <button
                  type="button"
                  onClick={() => setTelegramMode('polling')}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                    telegramMode === 'polling' ? 'bg-[#3B82F6] text-white' : 'text-[#94A3B8] hover:text-white'
                  }`}
                >
                  Long Polling 24/7
                </button>
                <button
                  type="button"
                  onClick={() => setTelegramMode('webhook')}
                  className={`flex-1 py-1.5 px-3 rounded text-xs font-medium transition-colors whitespace-nowrap ${
                    telegramMode === 'webhook' ? 'bg-[#3B82F6] text-white' : 'text-[#94A3B8] hover:text-white'
                  }`}
                >
                  Webhook HTTPS
                </button>
              </div>
            </div>

            <div className="lg:col-span-2">
              <label className="block text-[#CBD5E1] mb-1.5">APP_URL pública (requerida solo para Webhook)</label>
              <input
                type="url"
                value={appUrl}
                onChange={(e) => setAppUrl(e.target.value)}
                placeholder="https://tu-bot.altr.cc"
                className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5 pt-2 border-t border-[#223047]/70">
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[#CBD5E1]">Workers MTProto</label>
                <span className="font-mono tabular-nums text-white font-medium">{mtprotoWorkers}</span>
              </div>
              <input
                type="range"
                min={2}
                max={12}
                value={mtprotoWorkers}
                onChange={(e) => setMtprotoWorkers(Number(e.target.value))}
                className="w-full accent-[#3B82F6]"
              />
              <p className={`text-[11px] mt-1 ${mtprotoWorkers > 8 ? 'text-[#FBBF24]' : 'text-[#64748B]'}`}>
                {mtprotoWorkers > 8
                  ? 'Más de 8 workers puede saturar descifrado AES en CPU compartida.'
                  : 'Recomendado en Altare: 6 a 8 workers.'}
              </p>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[#CBD5E1]">Pool de sockets TCP</label>
                <span className="font-mono tabular-nums text-white font-medium">{mtprotoTcpPoolSize}</span>
              </div>
              <input
                type="range"
                min={1}
                max={8}
                value={mtprotoTcpPoolSize}
                onChange={(e) => setMtprotoTcpPoolSize(Number(e.target.value))}
                className="w-full accent-[#3B82F6]"
              />
              <p className="text-[11px] text-[#64748B] mt-1">Cliente principal + auxiliares estables.</p>
            </div>

            <div>
              <label className="block text-[#CBD5E1] mb-1.5">MAX_PREFETCH_LOOKAHEAD</label>
              <select
                value={maxPrefetchLookahead}
                onChange={(e) => setMaxPrefetchLookahead(Number(e.target.value))}
                className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:border-[#3B82F6]"
              >
                <option value={1}>1 (Seguro para 10 GB)</option>
                <option value={2}>2 (Solo VPS &gt; 20 GB)</option>
              </select>
            </div>

            <div>
              <label className="block text-[#CBD5E1] mb-1.5">Presupuesto disco (GB)</label>
              <input
                type="number"
                min={2}
                max={100}
                value={diskBudgetGb}
                onChange={(e) => setDiskBudgetGb(Number(e.target.value))}
                className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          </div>

          <div className="flex items-center justify-end">
            <button
              type="submit"
              disabled={saving}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium disabled:opacity-50 transition-colors"
            >
              <Save className="w-3.5 h-3.5" />
              {saving ? 'Aplicando...' : 'Aplicar y guardar configuración'}
            </button>
          </div>
        </form>
      </section>

      {/* /netlog Stream */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#223047] flex flex-col lg:flex-row lg:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Diagnóstico de Red y Eventos (/netlog)</h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Registro en tiempo real compartido con el comando <code className="text-[#CBD5E1]">/netlog</code> en
              Telegram.
            </p>
          </div>

          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleExportJson}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] whitespace-nowrap"
            >
              <Download className="w-3.5 h-3.5" />
              Exportar JSON
            </button>
            <button
              type="button"
              onClick={handleClearNetlog}
              disabled={clearing}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#DC2626]/20 text-[#CBD5E1] hover:text-[#F87171] whitespace-nowrap"
            >
              <Trash2 className="w-3.5 h-3.5" />
              Limpiar
            </button>
          </div>
        </div>

        <div className="px-5 py-3 border-b border-[#223047] flex flex-col md:flex-row md:items-center justify-between gap-3 bg-[#0E1520]">
          <div className="flex items-center gap-1 p-1 bg-[#0B111A] border border-[#223047] rounded-md overflow-x-auto">
            {(Object.keys(CATEGORY_LABELS) as Array<NetlogCategory | 'all'>).map((cat) => (
              <button
                key={cat}
                type="button"
                onClick={() => setCategory(cat)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors whitespace-nowrap shrink-0 ${
                  category === cat ? 'bg-[#1E2B42] text-white' : 'text-[#94A3B8] hover:text-white'
                }`}
              >
                {CATEGORY_LABELS[cat]}
              </button>
            ))}
          </div>

          <div className="relative w-full md:w-64">
            <Search className="w-3.5 h-3.5 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Filtrar mensajes..."
              className="w-full bg-[#0B111A] border border-[#223047] rounded-md pl-8 pr-3 py-1.5 text-xs text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
            />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[460px] overflow-y-auto">
          {filteredLogs.length === 0 ? (
            <div className="py-10 text-center text-xs text-[#94A3B8]">
              No hay eventos registrados para este filtro.
            </div>
          ) : (
            <table className="w-full text-left border-collapse text-xs">
              <thead className="sticky top-0 bg-[#0E1520] border-b border-[#223047] text-[11px] font-medium text-[#94A3B8]">
                <tr>
                  <th className="py-2 px-5">Hora</th>
                  <th className="py-2 px-3">Nivel</th>
                  <th className="py-2 px-3">Módulo</th>
                  <th className="py-2 px-4">Detalle</th>
                  <th className="py-2 px-5 text-right">Latencia / Velocidad</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/60 font-mono">
                {filteredLogs.map((entry) => {
                  const lvlClass =
                    entry.level === 'error'
                      ? 'text-[#F87171]'
                      : entry.level === 'warn'
                        ? 'text-[#FBBF24]'
                        : 'text-[#4ADE80]';
                  return (
                    <tr key={entry.id} className="hover:bg-[#162032]/50">
                      <td className="py-2 px-5 text-[#64748B] tabular-nums whitespace-nowrap">
                        {formatTimeShort(entry.timestamp)}
                      </td>
                      <td className={`py-2 px-3 font-medium whitespace-nowrap ${lvlClass}`}>
                        {entry.level.toUpperCase()}
                      </td>
                      <td className="py-2 px-3 text-[#94A3B8] whitespace-nowrap">{entry.category}</td>
                      <td className="py-2 px-4 text-[#E6EDF7] font-sans">{entry.message}</td>
                      <td className="py-2 px-5 text-right text-[#94A3B8] tabular-nums whitespace-nowrap">
                        {entry.throughputMbps !== undefined
                          ? `${entry.throughputMbps.toFixed(1)} MB/s`
                          : entry.latencyMs !== undefined
                            ? `${entry.latencyMs} ms`
                            : '—'}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </section>
    </div>
  );
}
