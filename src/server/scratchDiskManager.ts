import fs from 'fs';
import path from 'path';
import type { DiskStatusReport, ScratchFileEntry, TransferJob } from '../shared/types.ts';
import { netlog } from './netlog.ts';
import { stateStore } from './stateStore.ts';

const ACTIVE_JOB_STATUSES = new Set(['queued', 'downloading', 'assembling', 'uploading', 'encoding_nomad']);

export function resolveConfinedScratchPath(relativeSegment: string): string {
  const baseDir = stateStore.scratchDir;
  const cleaned = relativeSegment.replace(/^[/\\]+/, '');
  if (!cleaned || cleaned.includes('\0')) {
    throw new Error('Ruta temporal invalida.');
  }
  const resolved = path.resolve(baseDir, cleaned);
  if (!resolved.startsWith(baseDir + path.sep)) {
    throw new Error('Intento de acceso fuera del directorio scratch bloqueado.');
  }
  return resolved;
}

function getDirectorySizeBytes(dirPath: string): number {
  if (!fs.existsSync(dirPath)) return 0;
  let total = 0;
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        total += getDirectorySizeBytes(full);
      } else if (entry.isFile()) {
        total += fs.statSync(full).size;
      }
    } catch {
      // Ignore files deleted concurrently
    }
  }
  return total;
}

function buildProtectedMap(jobs: TransferJob[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const job of jobs) {
    if (ACTIVE_JOB_STATUSES.has(job.status) && job.scratchPath) {
      const normalized = job.scratchPath.replace(/^[/\\]+/, '').split(path.sep)[0];
      if (normalized) {
        map.set(normalized, job.id);
      }
    }
  }
  return map;
}

export async function getDiskStatusReport(): Promise<DiskStatusReport> {
  const stateDir = stateStore.stateDir;
  const scratchDir = stateStore.scratchDir;
  const budgetBytes = Math.round(stateStore.config.diskBudgetGb * 1024 * 1024 * 1024);

  fs.mkdirSync(stateDir, { recursive: true });
  fs.mkdirSync(scratchDir, { recursive: true });

  const stateUsedBytes = getDirectorySizeBytes(stateDir);
  const protectedMap = buildProtectedMap(stateStore.jobs);

  const files: ScratchFileEntry[] = [];
  let scratchUsedBytes = 0;
  let protectedBytes = 0;

  const rawEntries = fs.readdirSync(scratchDir, { withFileTypes: true });
  for (const entry of rawEntries) {
    if (entry.name.startsWith('.write_probe_')) continue;
    const full = path.join(scratchDir, entry.name);
    try {
      const st = fs.statSync(full);
      const sizeBytes = entry.isDirectory() ? getDirectorySizeBytes(full) : st.size;
      const protectedByJobId = protectedMap.get(entry.name);

      scratchUsedBytes += sizeBytes;
      if (protectedByJobId) {
        protectedBytes += sizeBytes;
      }

      files.push({
        name: entry.name,
        relativePath: entry.name,
        sizeBytes,
        modifiedAt: st.mtime.toISOString(),
        isDirectory: entry.isDirectory(),
        protectedByJobId,
      });
    } catch {
      // Skip vanished entries
    }
  }

  files.sort((a, b) => b.modifiedAt.localeCompare(a.modifiedAt));

  let volumeTotalBytes = budgetBytes;
  let volumeFreeBytes = Math.max(0, budgetBytes - stateUsedBytes - scratchUsedBytes);
  try {
    const stat = await fs.promises.statfs(scratchDir);
    volumeTotalBytes = Number(stat.blocks) * Number(stat.bsize);
    volumeFreeBytes = Number(stat.bavail) * Number(stat.bsize);
  } catch {
    // Fallback to budget calculation
  }

  const totalUsed = stateUsedBytes + scratchUsedBytes;
  const budgetRemainingBytes = Math.max(0, budgetBytes - totalUsed);
  const reclaimableBytes = Math.max(0, scratchUsedBytes - protectedBytes);
  const usagePct = budgetBytes > 0 ? Math.min(100, Number(((totalUsed / budgetBytes) * 100).toFixed(2))) : 0;

  let pressureLevel: 'nominal' | 'warning' | 'critical' = 'nominal';
  if (usagePct >= 85 || budgetRemainingBytes < stateStore.config.minFreeScratchMb * 1024 * 1024) {
    pressureLevel = 'critical';
  } else if (usagePct >= 65) {
    pressureLevel = 'warning';
  }

  return {
    stateDir,
    scratchDir,
    budgetBytes,
    stateUsedBytes,
    scratchUsedBytes,
    protectedBytes,
    reclaimableBytes,
    budgetRemainingBytes,
    volumeTotalBytes,
    volumeFreeBytes,
    usagePct,
    pressureLevel,
    files,
  };
}

export async function cleanupOrphanedScratchFiles(specificRelativePath?: string): Promise<{
  deletedCount: number;
  freedBytes: number;
  skippedProtected: number;
}> {
  const report = await getDiskStatusReport();
  let deletedCount = 0;
  let freedBytes = 0;
  let skippedProtected = 0;

  const targets = specificRelativePath
    ? report.files.filter((f) => f.relativePath === specificRelativePath)
    : report.files;

  for (const item of targets) {
    if (item.protectedByJobId) {
      skippedProtected += 1;
      continue;
    }
    try {
      const confined = resolveConfinedScratchPath(item.relativePath);
      fs.rmSync(confined, { recursive: true, force: true });
      deletedCount += 1;
      freedBytes += item.sizeBytes;
    } catch (err) {
      netlog.warn('disk', `No se pudo purgar ${item.relativePath}`, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (deletedCount > 0) {
    netlog.info(
      'disk',
      `Purga de scratch completada: ${deletedCount} elemento(s), ${(freedBytes / (1024 * 1024)).toFixed(2)} MB liberados.`
    );
  }

  return { deletedCount, freedBytes, skippedProtected };
}

export async function ensureScratchSpaceForFile(requiredBytes: number): Promise<{
  ok: boolean;
  freedBytes: number;
  availableBytes: number;
  reason?: string;
}> {
  const minReserve = stateStore.config.minFreeScratchMb * 1024 * 1024;
  let report = await getDiskStatusReport();

  if (report.budgetRemainingBytes - requiredBytes >= minReserve) {
    return {
      ok: true,
      freedBytes: 0,
      availableBytes: report.budgetRemainingBytes,
    };
  }

  netlog.warn(
    'disk',
    `Espacio justo en presupuesto de ${stateStore.config.diskBudgetGb} GB. Ejecutando purga preventiva de archivos huerfanos.`
  );
  const cleanup = await cleanupOrphanedScratchFiles();
  report = await getDiskStatusReport();

  if (report.budgetRemainingBytes - requiredBytes >= minReserve) {
    return {
      ok: true,
      freedBytes: cleanup.freedBytes,
      availableBytes: report.budgetRemainingBytes,
    };
  }

  const reqGb = (requiredBytes / 1024 ** 3).toFixed(2);
  const availGb = (report.budgetRemainingBytes / 1024 ** 3).toFixed(2);
  const reason = `Presupuesto insuficiente: se requieren ${reqGb} GB (+ reserva de ${stateStore.config.minFreeScratchMb} MB) y solo quedan ${availGb} GB libres.`;
  netlog.error('disk', reason);
  return {
    ok: false,
    freedBytes: cleanup.freedBytes,
    availableBytes: report.budgetRemainingBytes,
    reason,
  };
}
