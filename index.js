import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const rootDir = process.cwd();
const serverBundle = path.join(rootDir, 'dist', 'server.js');
const serverTsEntry = path.join(rootDir, 'server.ts');
const legacyRootBundle = path.join(rootDir, 'server.js');

// Plugged Host safety: ensure index.js is the ONLY .js file in root
if (fs.existsSync(legacyRootBundle)) {
  try {
    fs.rmSync(legacyRootBundle, { force: true });
  } catch {
    // Ignore cleanup error
  }
}

function getLatestSourceMtimeMs(dirPath) {
  let latest = 0;
  if (!fs.existsSync(dirPath)) return latest;
  const stat = fs.statSync(dirPath);
  if (stat.isFile()) return stat.mtimeMs;
  for (const entry of fs.readdirSync(dirPath, { withFileTypes: true })) {
    const full = path.join(dirPath, entry.name);
    try {
      if (entry.isDirectory()) {
        latest = Math.max(latest, getLatestSourceMtimeMs(full));
      } else if (entry.isFile() && /\.(ts|json)$/.test(entry.name)) {
        latest = Math.max(latest, fs.statSync(full).mtimeMs);
      }
    } catch {
      // Skip transient entries
    }
  }
  return latest;
}

function isBundleStale() {
  if (!fs.existsSync(serverBundle)) return true;
  try {
    const bundleMtime = fs.statSync(serverBundle).mtimeMs;
    const latestSrc = Math.max(
      getLatestSourceMtimeMs(serverTsEntry),
      getLatestSourceMtimeMs(path.join(rootDir, 'package.json')),
      getLatestSourceMtimeMs(path.join(rootDir, 'src'))
    );
    return latestSrc > bundleMtime + 500;
  } catch {
    return true;
  }
}

const envFile = path.join(rootDir, '.env');
const legacyServerFile = ['server.txt', 'server.txr']
  .map((name) => path.join(rootDir, name))
  .find((candidate) => fs.existsSync(candidate));
const importScript = path.join(rootDir, 'scripts', 'import-env-from-legacy.mjs');

if (legacyServerFile && fs.existsSync(importScript) && !fs.existsSync(envFile)) {
  console.log(`[PictaBot] Detectado ${path.basename(legacyServerFile)} sin .env -> generando .env automaticamente...`);
  const imp = spawnSync(process.execPath, [importScript, legacyServerFile], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (imp.status === 0 && fs.existsSync(envFile)) {
    try {
      fs.rmSync(legacyServerFile, { force: true });
      console.log(`[PictaBot] .env generado correctamente y ${path.basename(legacyServerFile)} eliminado.`);
    } catch {
      // Ignore removal error
    }
  }
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';
let useNativeTsFallback = false;

if (isBundleStale()) {
  console.log('[PictaBot] Codigo actualizado detectado -> compilando dist/server.js...');
  const build = spawnSync(npmBin, ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });

  if (build.status !== 0 || !fs.existsSync(serverBundle)) {
    const nodeMajor = Number(process.versions.node.split('.')[0] || 0);
    if (nodeMajor >= 23 && fs.existsSync(serverTsEntry)) {
      console.warn(
        `[PictaBot] esbuild no disponible en este contenedor; ejecutando server.ts directamente con Node ${process.version}.`
      );
      useNativeTsFallback = true;
    } else {
      console.error('[PictaBot] Error compilando dist/server.js.');
      process.exit(build.status || 1);
    }
  }
}

process.env.NODE_ENV = 'production';

if (useNativeTsFallback) {
  await import(pathToFileURL(serverTsEntry).href);
} else {
  await import(pathToFileURL(serverBundle).href);
}
