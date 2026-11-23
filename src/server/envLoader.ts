import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';

let lastReloadAttemptMs = 0;

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function getCandidateEnvPaths(): string[] {
  const cwd = process.cwd();
  const candidates = [
    path.resolve(cwd, '.env'),
    path.resolve(cwd, '.env.local'),
  ];
  return Array.from(new Set(candidates));
}

function parseEnvFile(filePath: string): Record<string, string> {
  try {
    if (!fs.existsSync(filePath)) return {};
    const raw = fs
      .readFileSync(filePath, 'utf8')
      .replace(/^\uFEFF/, '')
      .replace(/^(\s*)export\s+([A-Za-z_][A-Za-z0-9_]*\s*=)/gm, '$1$2');
    return dotenv.parse(raw);
  } catch {
    return {};
  }
}

/**
 * Loads variables from `.env` and `.env.local` into `process.env`.
 * Unlike default `dotenv/config`, this fills variables that exist in `process.env`
 * as empty/whitespace strings (common in Docker/Pelican/Plugged Host templates),
 * strips UTF-8 BOM, supports `export KEY=VALUE`, and trims accidental quotes.
 */
export function loadProjectEnv(options?: { force?: boolean }): number {
  const now = Date.now();
  if (!options?.force && now - lastReloadAttemptMs < 3000) {
    return 0;
  }
  lastReloadAttemptMs = now;

  let loadedCount = 0;
  for (const envPath of getCandidateEnvPaths()) {
    const parsed = parseEnvFile(envPath);
    for (const [rawKey, rawVal] of Object.entries(parsed)) {
      const key = rawKey.replace(/^\uFEFF/, '').trim();
      if (!key) continue;
      const cleanVal = stripOuterQuotes(String(rawVal ?? ''));
      if (!cleanVal) continue;
      const existing = String(process.env[key] ?? '').trim();
      if (!existing) {
        process.env[key] = cleanVal;
        loadedCount += 1;
      }
    }
  }
  return loadedCount;
}

// Run immediately on module import (before stateStore or runtime modules evaluate)
loadProjectEnv({ force: true });
