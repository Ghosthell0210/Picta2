import React, { useState } from 'react';
import { HardDrive, Lock, Play, Trash2 } from 'lucide-react';
import type { DashboardBootstrapResponse } from '../shared/types';
import { apiRequest, formatBytes, formatDateTimeShort } from '../lib/api';

interface DiskAssemblerViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

interface AssemblyTestOutput {
  jobFolder: string;
  partsCount: number;
  totalBytes: number;
  sha256: string;
  durationMs: number;
  cleanedUp: boolean;
}

export function DiskAssemblerView({ data, token, onRefresh, onToast }: DiskAssemblerViewProps) {
  const [purging, setPurging] = useState(false);
  const [purgingItem, setPurgingItem] = useState<string | null>(null);

  const [partsCount, setPartsCount] = useState(3);
  const [partSizeKb, setPartSizeKb] = useState(256);
  const [keepOutput, setKeepOutput] = useState(true);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<AssemblyTestOutput | null>(null);

  const { disk, telemetry, config } = data;

  async function handlePurgeAll() {
    setPurging(true);
    try {
      const resp = await apiRequest<{
        ok: boolean;
        result: { deletedCount: number; freedBytes: number; skippedProtected: number };
      }>('/api/disk/purge', {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast(
        `Purga ejecutada: ${resp.result.deletedCount} eliminado(s), ${formatBytes(resp.result.freedBytes)} liberados (${resp.result.skippedProtected} protegido(s)).`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error purgando archivos.', 'error');
    } finally {
      setPurging(false);
    }
  }

  async function handlePurgeOne(relativePath: string) {
    setPurgingItem(relativePath);
    try {
      const resp = await apiRequest<{
        ok: boolean;
        result: { deletedCount: number; freedBytes: number };
      }>('/api/disk/purge', {
        method: 'POST',
        token,
        body: { relativePath },
      });
      await onRefresh();
      if (resp.result.deletedCount > 0) {
        onToast(`Eliminado ${relativePath} (${formatBytes(resp.result.freedBytes)} liberados).`);
      } else {
        onToast('El archivo está protegido por un trabajo activo.', 'error');
      }
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo eliminar el archivo.', 'error');
    } finally {
      setPurgingItem(null);
    }
  }

  async function handleRunAssemblerTest(e: React.FormEvent) {
    e.preventDefault();
    setTesting(true);
    try {
      const resp = await apiRequest<{ ok: boolean; result: AssemblyTestOutput }>('/api/assembler/test', {
        method: 'POST',
        token,
        body: { partsCount, partSizeKb, keepOutput },
      });
      setTestResult(resp.result);
      await onRefresh();
      onToast(`Prueba /unir verificada (${resp.result.partsCount} partes · ${resp.result.durationMs} ms).`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error ejecutando prueba /unir.', 'error');
    } finally {
      setTesting(false);
    }
  }

  const binariesList = [
    { name: 'Node.js Runtime', info: telemetry.binaries.node },
    { name: 'ffmpeg (remux / concat)', info: telemetry.binaries.ffmpeg },
    { name: 'unzip (extracción ZIP)', info: telemetry.binaries.unzip },
    { name: 'tar (extracción TAR/GZ)', info: telemetry.binaries.tar },
  ];

  return (
    <div className="space-y-6">
      {/* 10 GB Budget Overview */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg p-5">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 pb-4 border-b border-[#223047]">
          <div>
            <h2 className="text-base font-semibold text-white">Presupuesto de Disco Persistente (Altare)</h2>
            <p className="text-xs text-[#94A3B8] mt-0.5 font-mono">
              Estado: {disk.stateDir} · Scratch: {disk.scratchDir}
            </p>
          </div>
          <button
            type="button"
            onClick={handlePurgeAll}
            disabled={purging || disk.reclaimableBytes === 0}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#DC2626]/20 hover:border-[#DC2626]/40 text-[#E6EDF7] disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            {purging ? 'Purgando...' : `Purgar huérfanos (${formatBytes(disk.reclaimableBytes)})`}
          </button>
        </div>

        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 py-4">
          <div>
            <div className="text-xs text-[#94A3B8]">Presupuesto asignado</div>
            <div className="text-lg font-semibold text-white font-mono tabular-nums mt-1">
              {config.diskBudgetGb} GB
            </div>
            <div className="text-[11px] text-[#64748B] font-mono tabular-nums">
              Volumen real: {formatBytes(disk.volumeFreeBytes)} libres
            </div>
          </div>
          <div>
            <div className="text-xs text-[#94A3B8]">Estado JSON persistente</div>
            <div className="text-lg font-semibold text-white font-mono tabular-nums mt-1">
              {formatBytes(disk.stateUsedBytes)}
            </div>
            <div className="text-[11px] text-[#64748B]">Sobrevive a reinicios</div>
          </div>
          <div>
            <div className="text-xs text-[#94A3B8]">Scratch protegido (candado)</div>
            <div className="text-lg font-semibold text-[#60A5FA] font-mono tabular-nums mt-1">
              {formatBytes(disk.protectedBytes)}
            </div>
            <div className="text-[11px] text-[#64748B]">Bloqueado por cola activa</div>
          </div>
          <div>
            <div className="text-xs text-[#94A3B8]">Scratch purgable</div>
            <div className="text-lg font-semibold text-[#FBBF24] font-mono tabular-nums mt-1">
              {formatBytes(disk.reclaimableBytes)}
            </div>
            <div className="text-[11px] text-[#64748B]">
              Reserva mínima: {config.minFreeScratchMb} MB
            </div>
          </div>
        </div>

        <div className="h-2 w-full bg-[#0B111A] rounded-full overflow-hidden">
          <div
            className={`h-full ${
              disk.pressureLevel === 'critical'
                ? 'bg-[#DC2626]'
                : disk.pressureLevel === 'warning'
                  ? 'bg-[#D97706]'
                  : 'bg-[#3B82F6]'
            }`}
            style={{ width: `${Math.min(100, Math.max(1, disk.usagePct))}%` }}
          />
        </div>
      </section>

      {/* Two-column split: Binaries health + /unir live tester */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-stretch">
        <section className="bg-[#111926] border border-[#223047] rounded-lg p-5 flex flex-col justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white mb-1">Binarios del sistema para /unir</h3>
            <p className="text-xs text-[#94A3B8] mb-4">
              Todos se ejecutan sin shell (<code className="text-[#CBD5E1]">spawn</code> con arreglo de argumentos) y
              se preinstalan automáticamente en el <code className="text-[#CBD5E1]">Dockerfile</code> de Altare.
            </p>
            <div className="divide-y divide-[#223047]">
              {binariesList.map((bin) => (
                <div key={bin.name} className="py-3 flex items-center justify-between gap-4">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-white">{bin.name}</div>
                    <div className="text-[11px] text-[#64748B] font-mono truncate mt-0.5">{bin.info.version}</div>
                  </div>
                  <span
                    className={`text-xs font-medium whitespace-nowrap shrink-0 ${
                      bin.info.available ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
                    }`}
                  >
                    {bin.info.available ? 'Disponible' : 'Solo en Docker'}
                  </span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <section className="bg-[#111926] border border-[#223047] rounded-lg p-5">
          <h3 className="text-sm font-semibold text-white mb-1">Verificador en vivo del ensamblador /unir</h3>
          <p className="text-xs text-[#94A3B8] mb-4">
            Crea partes binarias reales dentro de <code className="text-[#CBD5E1]">PICTA_SCRATCH_DIR</code>, valida
            espacio libre, concatena en streaming y calcula SHA-256 eliminando partes intermedias al instante.
          </p>

          <form onSubmit={handleRunAssemblerTest} className="space-y-4 text-xs">
            <div className="grid grid-cols-2 gap-3">
              <div>
                <label className="block text-[#CBD5E1] mb-1">Partes (2 a 8)</label>
                <input
                  type="number"
                  min={2}
                  max={8}
                  value={partsCount}
                  onChange={(e) => setPartsCount(Number(e.target.value))}
                  className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
                />
              </div>
              <div>
                <label className="block text-[#CBD5E1] mb-1">Tamaño por parte (KB)</label>
                <input
                  type="number"
                  min={16}
                  max={2048}
                  value={partSizeKb}
                  onChange={(e) => setPartSizeKb(Number(e.target.value))}
                  className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
                />
              </div>
            </div>

            <label className="flex items-center gap-2 text-[#CBD5E1] cursor-pointer">
              <input
                type="checkbox"
                checked={keepOutput}
                onChange={(e) => setKeepOutput(e.target.checked)}
                className="rounded border-[#223047] bg-[#0B111A]"
              />
              Conservar salida en scratch para inspeccionarla y purgarla manualmente
            </label>

            <button
              type="submit"
              disabled={testing}
              className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium disabled:opacity-50 transition-colors"
            >
              <Play className="w-3.5 h-3.5" />
              {testing ? 'Ensamblando...' : 'Ejecutar prueba real /unir'}
            </button>
          </form>

          {testResult && (
            <div className="mt-4 pt-4 border-t border-[#223047] text-xs space-y-1 font-mono">
              <div className="text-[#4ADE80]">
                Ensamblaje OK · {formatBytes(testResult.totalBytes)} en {testResult.durationMs} ms
              </div>
              <div className="text-[#94A3B8] truncate">Carpeta: {testResult.jobFolder}</div>
              <div className="text-[#64748B] truncate">SHA-256: {testResult.sha256}</div>
            </div>
          )}
        </section>
      </div>

      {/* Scratch Files Inspector */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between">
          <div>
            <h3 className="text-sm font-semibold text-white">Archivos activos en directorio Scratch</h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Los elementos con candado pertenecen a un trabajo en cola y no son eliminados por la purga preventiva.
            </p>
          </div>
          <span className="text-xs font-mono tabular-nums text-[#94A3B8]">{disk.files.length} elemento(s)</span>
        </div>

        {disk.files.length === 0 ? (
          <div className="px-6 py-10 text-center text-xs text-[#94A3B8]">
            <HardDrive className="w-6 h-6 mx-auto text-[#64748B] mb-2" />
            El directorio scratch está completamente limpio ({formatBytes(disk.budgetRemainingBytes)} disponibles).
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#223047] text-[11px] font-medium text-[#94A3B8] bg-[#0E1520]">
                  <th className="py-2.5 px-5">Ruta relativa</th>
                  <th className="py-2.5 px-4">Tipo</th>
                  <th className="py-2.5 px-4">Protección</th>
                  <th className="py-2.5 px-4 text-right">Tamaño</th>
                  <th className="py-2.5 px-4 text-right">Modificado</th>
                  <th className="py-2.5 px-5 text-right">Acción</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/70">
                {disk.files.map((item) => (
                  <tr key={item.relativePath} className="hover:bg-[#162032]/60">
                    <td className="py-2.5 px-5 font-mono text-white">{item.relativePath}</td>
                    <td className="py-2.5 px-4 text-[#94A3B8]">{item.isDirectory ? 'Directorio' : 'Archivo'}</td>
                    <td className="py-2.5 px-4">
                      {item.protectedByJobId ? (
                        <span className="inline-flex items-center gap-1 text-[#60A5FA] font-mono">
                          <Lock className="w-3 h-3" />
                          Job {item.protectedByJobId.slice(0, 8)}
                        </span>
                      ) : (
                        <span className="text-[#FBBF24]">Huérfano / Purgable</span>
                      )}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#E6EDF7]">
                      {formatBytes(item.sizeBytes)}
                    </td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#64748B]">
                      {formatDateTimeShort(item.modifiedAt)}
                    </td>
                    <td className="py-2.5 px-5 text-right">
                      <button
                        type="button"
                        disabled={Boolean(item.protectedByJobId) || purgingItem === item.relativePath}
                        onClick={() => handlePurgeOne(item.relativePath)}
                        className="px-2.5 py-1 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#DC2626]/20 text-[#CBD5E1] hover:text-[#F87171] disabled:opacity-35 transition-colors"
                      >
                        Purgar
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}
