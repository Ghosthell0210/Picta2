// Suppress Node 25/26 ExperimentalWarning for globalThis.localStorage accessed by gramJS
try {
  Object.defineProperty(globalThis, 'localStorage', {
    value: undefined,
    writable: true,
    configurable: true,
  });
} catch {
  // Ignore if non-configurable
}

import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';

const rootDir = process.cwd();
const legacyRootBundle = path.join(rootDir, 'server.js');

// Plugged Host safety: ensure index.js is the ONLY .js file in root
if (fs.existsSync(legacyRootBundle)) {
  try {
    fs.rmSync(legacyRootBundle, { force: true });
  } catch {
    // Ignore cleanup error
  }
}

process.env.NODE_ENV = process.env.NODE_ENV || 'production';

const serverTsEntry = path.join(rootDir, 'server.ts');
await import(pathToFileURL(serverTsEntry).href);
