import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const rootDir = process.cwd();
const serverBundle = path.join(rootDir, 'dist', 'server.js');
const legacyRootBundle = path.join(rootDir, 'server.js');

// Plugged Host safety: ensure index.js is the ONLY .js file in root
if (fs.existsSync(legacyRootBundle)) {
  try {
    fs.rmSync(legacyRootBundle, { force: true });
  } catch {
    // Ignore cleanup error
  }
}

const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!fs.existsSync(serverBundle)) {
  const esbuildBin = path.join(
    rootDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'esbuild.cmd' : 'esbuild'
  );

  if (!fs.existsSync(esbuildBin)) {
    console.log('[PictaBot] Instalando dependencias de compilacion (npm install --include=dev)...');
    const inst = spawnSync(npmBin, ['install', '--include=dev'], {
      cwd: rootDir,
      stdio: 'inherit',
      shell: false,
    });
    if (inst.status !== 0) {
      console.error('[PictaBot] Error instalando dependencias.');
      process.exit(inst.status || 1);
    }
  }

  console.log('[PictaBot] Compilando bot headless optimizado (npm run build)...');
  const build = spawnSync(npmBin, ['run', 'build'], {
    cwd: rootDir,
    stdio: 'inherit',
    shell: false,
  });
  if (build.status !== 0) {
    console.error('[PictaBot] Error compilando el proyecto.');
    process.exit(build.status || 1);
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
      console.log(`[PictaBot] .env generado correctamente y ${path.basename(legacyServerFile)} eliminado del contenedor.`);
    } catch {
      // Ignore removal error
    }
  }
}

process.env.NODE_ENV = 'production';

await import(pathToFileURL(serverBundle).href);
