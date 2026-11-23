import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const rootDir = process.cwd();
const serverBundle = path.join(rootDir, 'server.js');
const distIndex = path.join(rootDir, 'dist', 'index.html');
const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm';

if (!fs.existsSync(serverBundle) || !fs.existsSync(distIndex)) {
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

  console.log('[PictaBot] Compilando panel web y servidor (npm run build)...');
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

process.env.NODE_ENV = 'production';

await import(pathToFileURL(serverBundle).href);
