import { spawn } from 'child_process';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import type { SystemBinariesStatus } from '../shared/types.ts';
import { netlog } from './netlog.ts';
import { ensureScratchSpaceForFile, resolveConfinedScratchPath } from './scratchDiskManager.ts';

function runCommandSafe(
  command: string,
  args: string[],
  timeoutMs = 15000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = spawn(command, args, { shell: false });

    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill('SIGKILL');
        resolve({ code: -1, stdout, stderr: `${stderr}\nTiempo limite excedido (${timeoutMs}ms).` });
      }
    }, timeoutMs);

    child.stdout.on('data', (chunk: Buffer) => {
      stdout += chunk.toString('utf8').slice(0, 8192);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString('utf8').slice(0, 8192);
    });

    child.on('error', (err) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: 127, stdout, stderr: err.message });
      }
    });

    child.on('close', (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ code: code ?? 1, stdout, stderr });
      }
    });
  });
}

let cachedBinaries: SystemBinariesStatus | null = null;

export async function inspectSystemBinaries(forceRefresh = false): Promise<SystemBinariesStatus> {
  if (cachedBinaries && !forceRefresh) {
    return cachedBinaries;
  }

  const [ffmpegRes, unzipRes, tarRes] = await Promise.all([
    runCommandSafe('ffmpeg', ['-version'], 5000),
    runCommandSafe('unzip', ['-v'], 5000),
    runCommandSafe('tar', ['--version'], 5000),
  ]);

  const firstLine = (raw: string) =>
    raw
      .split(/\r?\n/)
      .map((l) => l.trim())
      .find(Boolean) || 'No disponible';

  cachedBinaries = {
    node: { available: true, version: process.version },
    ffmpeg: {
      available: ffmpegRes.code === 0,
      version: ffmpegRes.code === 0 ? firstLine(ffmpegRes.stdout) : 'No instalado (incluido en Dockerfile)',
    },
    unzip: {
      available: unzipRes.code === 0,
      version: unzipRes.code === 0 ? firstLine(unzipRes.stdout) : 'No instalado (incluido en Dockerfile)',
    },
    tar: {
      available: tarRes.code === 0,
      version: tarRes.code === 0 ? firstLine(tarRes.stdout) : 'No instalado (incluido en Dockerfile)',
    },
  };

  return cachedBinaries;
}

export async function concatBinaryParts(
  partRelativePaths: string[],
  outputRelativePath: string
): Promise<{ outputRelativePath: string; totalBytes: number; sha256: string }> {
  if (partRelativePaths.length === 0) {
    throw new Error('Se requiere al menos una parte para ensamblar.');
  }

  const resolvedParts = partRelativePaths.map((p) => resolveConfinedScratchPath(p));
  let expectedBytes = 0;
  for (const partPath of resolvedParts) {
    if (!fs.existsSync(partPath)) {
      throw new Error(`Parte no encontrada: ${path.basename(partPath)}`);
    }
    expectedBytes += fs.statSync(partPath).size;
  }

  const spaceCheck = await ensureScratchSpaceForFile(expectedBytes);
  if (!spaceCheck.ok) {
    throw new Error(spaceCheck.reason || 'Sin espacio temporal para ensamblaje.');
  }

  const outputFullPath = resolveConfinedScratchPath(outputRelativePath);
  fs.mkdirSync(path.dirname(outputFullPath), { recursive: true });

  const hash = crypto.createHash('sha256');
  const writeStream = fs.createWriteStream(outputFullPath);
  let totalBytes = 0;

  try {
    for (const partPath of resolvedParts) {
      await new Promise<void>((resolve, reject) => {
        const readStream = fs.createReadStream(partPath);
        readStream.on('data', (chunk: string | Buffer) => {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          hash.update(buf);
          totalBytes += buf.length;
        });
        readStream.on('error', reject);
        readStream.on('end', resolve);
        readStream.pipe(writeStream, { end: false });
      });
    }

    await new Promise<void>((resolve, reject) => {
      writeStream.on('error', reject);
      writeStream.on('finish', resolve);
      writeStream.end();
    });
  } catch (err) {
    writeStream.destroy();
    if (fs.existsSync(outputFullPath)) {
      fs.rmSync(outputFullPath, { force: true });
    }
    throw err;
  }

  const sha256 = hash.digest('hex');
  netlog.info('assembler', `Ensamblaje binario completado: ${outputRelativePath} (${totalBytes} bytes)`, {
    parts: partRelativePaths.length,
    sha256: sha256.slice(0, 12),
  });

  return { outputRelativePath, totalBytes, sha256 };
}

function assertSafeArchiveMembers(memberLines: string[]): void {
  for (const raw of memberLines) {
    const member = raw.trim();
    if (!member) continue;
    if (member.startsWith('/') || member.startsWith('\\') || member.includes('..')) {
      throw new Error(`Entrada insegura detectada dentro del archivo comprimido: ${member}`);
    }
  }
}

export async function extractArchiveSafe(
  archiveRelativePath: string,
  targetDirRelativePath: string,
  format: 'zip' | 'tar'
): Promise<{ extractedDir: string; fileCount: number; extractedFiles: string[] }> {
  const archiveFull = resolveConfinedScratchPath(archiveRelativePath);
  const outFull = resolveConfinedScratchPath(targetDirRelativePath);

  if (!fs.existsSync(archiveFull)) {
    throw new Error('Archivo comprimido no encontrado en scratch.');
  }

  const archiveSize = fs.statSync(archiveFull).size;
  const spaceCheck = await ensureScratchSpaceForFile(archiveSize * 2);
  if (!spaceCheck.ok) {
    throw new Error(spaceCheck.reason || 'Sin espacio suficiente para extraer archivo.');
  }

  fs.mkdirSync(outFull, { recursive: true });

  if (format === 'zip') {
    const listRes = await runCommandSafe('unzip', ['-Z1', archiveFull], 15000);
    if (listRes.code !== 0) {
      throw new Error(`Error inspeccionando ZIP: ${listRes.stderr || 'unzip no disponible'}`);
    }
    assertSafeArchiveMembers(listRes.stdout.split(/\r?\n/));
    const extRes = await runCommandSafe('unzip', ['-o', archiveFull, '-d', outFull], 120000);
    if (extRes.code !== 0) {
      throw new Error(`Error extrayendo ZIP: ${extRes.stderr}`);
    }
  } else {
    const listRes = await runCommandSafe('tar', ['-tf', archiveFull], 15000);
    if (listRes.code !== 0) {
      throw new Error(`Error inspeccionando TAR: ${listRes.stderr || 'tar no disponible'}`);
    }
    assertSafeArchiveMembers(listRes.stdout.split(/\r?\n/));
    const extRes = await runCommandSafe('tar', ['-xf', archiveFull, '-C', outFull], 120000);
    if (extRes.code !== 0) {
      throw new Error(`Error extrayendo TAR: ${extRes.stderr}`);
    }
  }

  const collected: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        collected.push(full);
      }
    }
  };
  walk(outFull);

  netlog.info('assembler', `Extraccion ${format.toUpperCase()} segura completada en ${targetDirRelativePath}`, {
    fileCount: collected.length,
  });
  return { extractedDir: targetDirRelativePath, fileCount: collected.length, extractedFiles: collected };
}

export async function remuxSingleVideoFaststart(
  inputRelativePath: string,
  outputRelativePath: string
): Promise<string> {
  const binaries = await inspectSystemBinaries();
  if (!binaries.ffmpeg.available) {
    return resolveConfinedScratchPath(inputRelativePath);
  }
  const inFull = resolveConfinedScratchPath(inputRelativePath);
  const outFull = resolveConfinedScratchPath(outputRelativePath);
  fs.mkdirSync(path.dirname(outFull), { recursive: true });

  const res = await runCommandSafe(
    'ffmpeg',
    ['-y', '-i', inFull, '-c', 'copy', '-movflags', '+faststart', outFull],
    180000
  );
  if (res.code !== 0 || !fs.existsSync(outFull)) {
    netlog.warn('assembler', `Remux faststart omitido (se usa archivo ensamblado): ${res.stderr.slice(-200)}`);
    return inFull;
  }
  return outFull;
}

export async function runFfmpegConcatRemux(
  partRelativePaths: string[],
  outputRelativePath: string
): Promise<{ outputRelativePath: string; durationMs: number }> {
  const started = Date.now();
  const binaries = await inspectSystemBinaries();
  if (!binaries.ffmpeg.available) {
    throw new Error('ffmpeg no esta disponible en este entorno (se instala automaticamente en el Dockerfile de Altare).');
  }

  const listRelative = `${outputRelativePath}.concat.txt`;
  const listFull = resolveConfinedScratchPath(listRelative);
  const outFull = resolveConfinedScratchPath(outputRelativePath);
  fs.mkdirSync(path.dirname(outFull), { recursive: true });

  const lines = partRelativePaths.map((rel) => {
    const resolved = resolveConfinedScratchPath(rel);
    const escaped = resolved.replace(/'/g, "'\\''");
    return `file '${escaped}'`;
  });
  fs.writeFileSync(listFull, lines.join('\n'), 'utf8');

  try {
    const res = await runCommandSafe(
      'ffmpeg',
      ['-y', '-f', 'concat', '-safe', '1', '-i', listFull, '-c', 'copy', outFull],
      180000
    );
    if (res.code !== 0) {
      throw new Error(`ffmpeg fallo con codigo ${res.code}: ${res.stderr.slice(-300)}`);
    }
  } finally {
    if (fs.existsSync(listFull)) {
      fs.rmSync(listFull, { force: true });
    }
  }

  const durationMs = Date.now() - started;
  netlog.info('assembler', `Remux ffmpeg /unir completado: ${outputRelativePath}`, {
    latencyMs: durationMs,
    parts: partRelativePaths.length,
  });
  return { outputRelativePath, durationMs };
}

export async function runDiagnosticAssemblyTest(partsCount = 3, partSizeKb = 128, keepOutput = false): Promise<{
  jobFolder: string;
  partsCount: number;
  totalBytes: number;
  sha256: string;
  durationMs: number;
  cleanedUp: boolean;
}> {
  const started = Date.now();
  const safeParts = Math.min(8, Math.max(2, Math.floor(partsCount)));
  const safeSizeKb = Math.min(2048, Math.max(16, Math.floor(partSizeKb)));

  const jobFolder = `unir_diag_${Date.now()}`;
  const jobFolderFull = resolveConfinedScratchPath(jobFolder);
  fs.mkdirSync(jobFolderFull, { recursive: true });

  const partPaths: string[] = [];
  for (let i = 1; i <= safeParts; i += 1) {
    const rel = path.join(jobFolder, `parte_${String(i).padStart(2, '0')}.bin`);
    const full = resolveConfinedScratchPath(rel);
    fs.writeFileSync(full, crypto.randomBytes(safeSizeKb * 1024));
    partPaths.push(rel);
  }

  const outputRel = path.join(jobFolder, 'ensamblado_final.bin');
  const result = await concatBinaryParts(partPaths, outputRel);

  // Remove intermediate parts immediately (Altare 10GB discipline)
  for (const rel of partPaths) {
    const full = resolveConfinedScratchPath(rel);
    if (fs.existsSync(full)) fs.rmSync(full, { force: true });
  }

  let cleanedUp = false;
  if (!keepOutput) {
    fs.rmSync(jobFolderFull, { recursive: true, force: true });
    cleanedUp = true;
  }

  return {
    jobFolder,
    partsCount: safeParts,
    totalBytes: result.totalBytes,
    sha256: result.sha256,
    durationMs: Date.now() - started,
    cleanedUp,
  };
}
