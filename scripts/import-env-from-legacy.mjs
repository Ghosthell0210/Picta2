#!/usr/bin/env node
/**
 * Herramienta local de migracion para extraer automaticamente tus variables
 * desde tu archivo antiguo `server.txt` o `server.ts` y generar `.env` listo
 * para Altare (sin escribir secretos dentro del codigo fuente).
 *
 * Uso:
 *   node scripts/import-env-from-legacy.mjs ruta/a/tu/server.txt
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const inputArg = process.argv[2] || 'server.txt';

const sourcePath = path.resolve(process.cwd(), inputArg);
if (!fs.existsSync(sourcePath)) {
  console.error(`Uso: node scripts/import-env-from-legacy.mjs <ruta_a_server.txt>`);
  console.error(`No se encontro el archivo: ${sourcePath}`);
  process.exit(1);
}

const raw = fs.readFileSync(sourcePath, 'utf8');

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractValue(names, fallbackRegexes = []) {
  for (const name of names) {
    const escaped = escapeRegExp(name);
    const patterns = [
      // const NAME = process.env.X || 'value'  OR  propName: process.env.X || 'value'
      new RegExp(`\\b${escaped}\\b\\s*[:=][^\\n;,]*\\|\\|\\s*['"\`]([^'"\`\\n]+)['"\`]`),
      // process.env.NAME || 'value'
      new RegExp(`process\\.env\\.${escaped}\\s*\\|\\|\\s*['"\`]([^'"\`\\n]+)['"\`]`),
      // const NAME = 'value'  OR  NAME: 'value'
      new RegExp(`\\b${escaped}\\b\\s*[:=]\\s*['"\`]([^'"\`\\n]+)['"\`]`),
      // const NAME = Number(process.env.X || 12345) OR propName: process.env.X || 12345
      new RegExp(`\\b${escaped}\\b\\s*[:=][^\\n;,]*\\|\\|\\s*(\\d{4,20})\\b`),
      new RegExp(`\\b${escaped}\\b\\s*[:=]\\s*(\\d{4,20})\\b`),
      // KEY=value style
      new RegExp(`^\\s*${escaped}\\s*=\\s*([^\\s#\\n]+)`, 'm'),
    ];
    for (const re of patterns) {
      const match = raw.match(re);
      if (match && match[1] && !match[1].startsWith('<') && !match[1].includes('process.env')) {
        return match[1].trim();
      }
    }
  }
  for (const re of fallbackRegexes) {
    const match = raw.match(re);
    if (match && match[1]) return match[1].trim();
  }
  return '';
}

const detected = {
  TELEGRAM_BOT_TOKEN: extractValue(
    ['TELEGRAM_BOT_TOKEN', 'telegramBotToken', 'BOT_TOKEN', 'TELEGRAM_TOKEN', 'TOKEN'],
    [/['"`](\d{7,12}:[A-Za-z0-9_-]{30,50})['"`]/]
  ),
  MASTER_ADMIN_CHAT_ID: extractValue([
    'MASTER_ADMIN_CHAT_ID',
    'MASTER_CHAT_ID',
    'ADMIN_CHAT_ID',
    'ADMIN_ID',
    'OWNER_ID',
    'ADMIN_TELEGRAM_IDS',
  ]),
  TELEGRAM_API_ID: extractValue(['TELEGRAM_API_ID', 'telegramApiId', 'MTPROTO_API_ID', 'API_ID', 'TG_API_ID']),
  TELEGRAM_API_HASH: extractValue(['TELEGRAM_API_HASH', 'telegramApiHash', 'MTPROTO_API_HASH', 'API_HASH', 'TG_API_HASH']),
  TELEGRAM_MTPROTO_SESSION: extractValue([
    'TELEGRAM_MTPROTO_SESSION',
    'MTPROTO_SESSION',
    'STRING_SESSION',
    'SESSION_STRING',
    'TG_SESSION',
  ]),
  TELEGRAM_VAULT_CHAT_ID: extractValue(['TELEGRAM_VAULT_CHAT_ID', 'VAULT_CHAT_ID', 'CLOUD_VAULT_CHAT_ID']),
  PICTA_USERNAME: extractValue([
    'PICTA_USERNAME',
    'pictaUsername',
    'PICTA_DEFAULT_USERNAME',
    'DEFAULT_PICTA_USERNAME',
    'PICTA_USER',
    'DEFAULT_PICTA_USER',
  ]),
  PICTA_PASSWORD: extractValue([
    'PICTA_PASSWORD',
    'pictaPassword',
    'PICTA_DEFAULT_PASSWORD',
    'DEFAULT_PICTA_PASSWORD',
    'PICTA_PASS',
    'DEFAULT_PICTA_PASS',
  ]),
  PICTA_CLIENT_ID: extractValue(['PICTA_OFFICIAL_CLIENT_ID', 'PICTA_CLIENT_ID', 'pictaClientId', 'CLIENT_ID', 'OAUTH_CLIENT_ID']),
  PICTA_AES_KEY: extractValue(['PICTA_AES_KEY', 'AES_KEY', 'PICTA_CRYPTO_KEY']),
  PICTA_CHANNEL_ID: extractValue(['PICTA_CHANNEL_ID', 'DEFAULT_CHANNEL_ID', 'CHANNEL_ID']) || '36319',
  PICTA_CHANNEL_NAME: extractValue(['PICTA_CHANNEL_NAME', 'DEFAULT_CHANNEL_NAME', 'CHANNEL_NAME']) || 'Multiverso Visual',
  TMDB_API_KEY: extractValue(['PICTA_TMDB_API_KEY', 'TMDB_API_KEY', 'TMDB_KEY']),
  GEMINI_API_KEY: extractValue(['GEMINI_API_KEY', 'GOOGLE_API_KEY']),
  VAULT_ENCRYPTION_KEY: extractValue(['VAULT_ENCRYPTION_KEY']) || crypto.randomBytes(24).toString('hex'),
};

const envLines = [
  '# Generado localmente desde tu archivo heredado (NO subir a Git)',
  'NODE_ENV=production',
  'PORT=3000',
  'TELEGRAM_MODE=polling',
  `TELEGRAM_BOT_TOKEN=${detected.TELEGRAM_BOT_TOKEN}`,
  `MASTER_ADMIN_CHAT_ID=${detected.MASTER_ADMIN_CHAT_ID}`,
  `TELEGRAM_API_ID=${detected.TELEGRAM_API_ID}`,
  `TELEGRAM_API_HASH=${detected.TELEGRAM_API_HASH}`,
  `TELEGRAM_MTPROTO_SESSION=${detected.TELEGRAM_MTPROTO_SESSION}`,
  `TELEGRAM_VAULT_CHAT_ID=${detected.TELEGRAM_VAULT_CHAT_ID}`,
  `VAULT_ENCRYPTION_KEY=${detected.VAULT_ENCRYPTION_KEY}`,
  `PICTA_USERNAME=${detected.PICTA_USERNAME}`,
  `PICTA_PASSWORD=${detected.PICTA_PASSWORD}`,
  `PICTA_CLIENT_ID=${detected.PICTA_CLIENT_ID}`,
  `PICTA_AES_KEY=${detected.PICTA_AES_KEY}`,
  `PICTA_CHANNEL_ID=${detected.PICTA_CHANNEL_ID}`,
  `PICTA_CHANNEL_NAME=${detected.PICTA_CHANNEL_NAME}`,
  `TMDB_API_KEY=${detected.TMDB_API_KEY}`,
  `GEMINI_API_KEY=${detected.GEMINI_API_KEY}`,
  'PICTA_STATE_DIR=./data/bot_state',
  'PICTA_SCRATCH_DIR=./data/scratch',
  'PICTA_DISK_BUDGET_GB=10',
  'MTPROTO_SAFE_PARALLEL_WORKERS=6',
  'MTPROTO_TCP_POOL_SIZE=6',
  'MAX_PREFETCH_LOOKAHEAD=1',
  '',
];

const targetEnvPath = path.resolve(process.cwd(), '.env');
fs.writeFileSync(targetEnvPath, envLines.join('\n'), { encoding: 'utf8', mode: 0o600 });

console.log(`Archivo .env generado en: ${targetEnvPath}`);
console.log('Resumen de campos detectados:');
for (const [k, v] of Object.entries(detected)) {
  console.log(`  - ${k}: ${v ? 'OK' : 'VACIO (completar manualmente si aplica)'}`);
}
