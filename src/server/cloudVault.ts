import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import type { VaultSnapshotRecord } from '../shared/types.ts';
import { netlog } from './netlog.ts';
import { stateStore } from './stateStore.ts';

interface EncryptedVaultEnvelope {
  version: 1;
  createdAt: string;
  includesMtprotoSession: boolean;
  checksumSha256: string;
  saltHex: string;
  ivHex: string;
  tagHex: string;
  ciphertextBase64: string;
}

const MAX_CMD_DESC_LEN = 240;
const MAX_COMMANDS_PER_SCOPE = 95;

function getMasterAdminChatId(): string {
  return (
    (process.env.MASTER_ADMIN_CHAT_ID || '').trim() ||
    (process.env.ADMIN_TELEGRAM_IDS || '').split(',')[0]?.trim() ||
    ''
  );
}

function getVaultSecretMaterial(): { secret: string; fromEnv: boolean } {
  const envKey = (process.env.VAULT_ENCRYPTION_KEY || '').trim();
  if (envKey.length >= 12) {
    return { secret: envKey, fromEnv: true };
  }
  const tokenFallback = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  if (tokenFallback.length >= 12) {
    return { secret: `pictabot-vault:${tokenFallback}`, fromEnv: true };
  }
  return { secret: `local-altare-preview:${stateStore.stateDir}`, fromEnv: false };
}

function encryptBundlePayload(plaintext: string, includesMtprotoSession: boolean): EncryptedVaultEnvelope {
  const { secret } = getVaultSecretMaterial();
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = crypto.randomBytes(12);

  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const checksumSha256 = crypto.createHash('sha256').update(plaintext, 'utf8').digest('hex');

  return {
    version: 1,
    createdAt: new Date().toISOString(),
    includesMtprotoSession,
    checksumSha256,
    saltHex: salt.toString('hex'),
    ivHex: iv.toString('hex'),
    tagHex: tag.toString('hex'),
    ciphertextBase64: encrypted.toString('base64'),
  };
}

function decryptBundlePayload(envelope: EncryptedVaultEnvelope): string {
  const { secret } = getVaultSecretMaterial();
  const key = crypto.scryptSync(secret, Buffer.from(envelope.saltHex, 'hex'), 32);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.ivHex, 'hex'));
  decipher.setAuthTag(Buffer.from(envelope.tagHex, 'hex'));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertextBase64, 'base64')),
    decipher.final(),
  ]).toString('utf8');

  const computedHash = crypto.createHash('sha256').update(decrypted, 'utf8').digest('hex');
  if (computedHash !== envelope.checksumSha256) {
    throw new Error('Fallo de integridad SHA-256 al descifrar la boveda.');
  }
  return decrypted;
}

function deriveCommandsVaultKey(useLegacyPictaAes: boolean): Buffer {
  const masterId = getMasterAdminChatId() || '0';
  if (useLegacyPictaAes) {
    const pictaAes = (process.env.PICTA_AES_KEY || process.env.AES_KEY || '').trim();
    return crypto.createHash('sha256').update(pictaAes + masterId).digest();
  }
  const { secret } = getVaultSecretMaterial();
  return crypto.createHash('sha256').update(`pictabot-cmd-vault:${secret}:${masterId}`).digest();
}

function packForCommandsVault(
  plaintext: string,
  prefix: 'v_' | 'm_'
): Array<{ command: string; description: string }> {
  const deflated = zlib.deflateRawSync(Buffer.from(plaintext, 'utf8'));
  const key = deriveCommandsVaultKey(false);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(deflated), cipher.final()]);
  const tag = cipher.getAuthTag();
  const packed = Buffer.concat([iv, tag, enc]).toString('base64');

  const chunks: Array<{ command: string; description: string }> = [];
  for (let i = 0; i < packed.length && chunks.length < MAX_COMMANDS_PER_SCOPE; i += MAX_CMD_DESC_LEN) {
    chunks.push({
      command: `${prefix}${chunks.length}`,
      description: packed.slice(i, i + MAX_CMD_DESC_LEN),
    });
  }
  return chunks;
}

function unpackFromCommandsVault(commands: Array<{ command?: string; description?: string }>): string | null {
  if (!Array.isArray(commands) || commands.length === 0) return null;
  const ordered = [...commands]
    .filter((c) => typeof c.command === 'string' && typeof c.description === 'string')
    .sort((a, b) => {
      const numA = Number(String(a.command).replace(/^[a-z]+_?/i, ''));
      const numB = Number(String(b.command).replace(/^[a-z]+_?/i, ''));
      if (Number.isFinite(numA) && Number.isFinite(numB)) return numA - numB;
      return String(a.command).localeCompare(String(b.command));
    });
  const combined = ordered.map((c) => c.description || '').join('');
  if (!combined) return null;

  const tryDecryptWithKey = (key: Buffer, encoding: 'base64' | 'base64url'): string | null => {
    try {
      const raw = Buffer.from(combined, encoding);
      if (raw.length <= 28) return null;
      const iv = raw.subarray(0, 12);
      const tag = raw.subarray(12, 28);
      const data = raw.subarray(28);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
      decipher.setAuthTag(tag);
      const dec = Buffer.concat([decipher.update(data), decipher.final()]);
      try {
        return zlib.inflateRawSync(dec).toString('utf8');
      } catch {
        try {
          return zlib.inflateSync(dec).toString('utf8');
        } catch {
          return dec.toString('utf8');
        }
      }
    } catch {
      return null;
    }
  };

  // 1. Current Altare key
  const currentB64 = tryDecryptWithKey(deriveCommandsVaultKey(false), 'base64');
  if (currentB64) return currentB64;
  const currentUrl = tryDecryptWithKey(deriveCommandsVaultKey(false), 'base64url');
  if (currentUrl) return currentUrl;

  // 2. Legacy Cloud Run PictaBot key fallback (sha256(PICTA_AES_KEY + MASTER_ADMIN_CHAT_ID))
  if ((process.env.PICTA_AES_KEY || process.env.AES_KEY || '').trim()) {
    const legacyB64 = tryDecryptWithKey(deriveCommandsVaultKey(true), 'base64');
    if (legacyB64) return legacyB64;
    const legacyUrl = tryDecryptWithKey(deriveCommandsVaultKey(true), 'base64url');
    if (legacyUrl) return legacyUrl;
  }

  return null;
}

function getLocalVaultArchivePath(): string {
  const resolved = path.resolve(stateStore.stateDir, 'vault_latest.enc.json');
  if (!resolved.startsWith(stateStore.stateDir + path.sep)) {
    throw new Error('Ruta de archivo de boveda invalida.');
  }
  return resolved;
}

export function getVaultConfigStatus() {
  const chatConfigured = Boolean((process.env.TELEGRAM_VAULT_CHAT_ID || '').trim() || getMasterAdminChatId());
  const encryptionKeyConfigured = Boolean((process.env.VAULT_ENCRYPTION_KEY || '').trim());
  const lastSyncAt = stateStore.vaultSnapshots[0]?.createdAt;
  return {
    chatConfigured,
    encryptionKeyConfigured,
    lastSyncAt,
    snapshotsCount: stateStore.vaultSnapshots.length,
  };
}

async function syncSetMyCommandsScope(
  botToken: string,
  chatId: string,
  languageCode: 'eo' | 'ia',
  plaintext: string
): Promise<boolean> {
  const prefix = languageCode === 'ia' ? 'm_' : 'v_';
  const commands = packForCommandsVault(plaintext, prefix);
  if (commands.length === 0) return false;
  const res = await fetch(`https://api.telegram.org/bot${botToken}/setMyCommands`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      commands,
      scope: { type: 'chat', chat_id: Number(chatId) },
      language_code: languageCode,
    }),
  });
  const body = (await res.json()) as { ok?: boolean };
  return Boolean(res.ok && body.ok);
}

export async function saveCloudStateToTelegramNow(includeMtproto = true): Promise<VaultSnapshotRecord> {
  const started = Date.now();
  const bundle = stateStore.exportBundle();
  const payloadObj = includeMtproto ? bundle : { ...bundle, mtprotoSessionString: '' };
  const plaintext = JSON.stringify(payloadObj);

  const envelope = encryptBundlePayload(plaintext, includeMtproto && Boolean(bundle.mtprotoSessionString));
  const envelopeJson = JSON.stringify(envelope, null, 2);

  // 1. Persist local encrypted archive atomically
  const localPath = getLocalVaultArchivePath();
  const tmpPath = `${localPath}.${process.pid}.tmp`;
  fs.writeFileSync(tmpPath, envelopeJson, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(tmpPath, localPath);

  const botToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  const vaultChatId = (process.env.TELEGRAM_VAULT_CHAT_ID || '').trim();
  const masterChatId = getMasterAdminChatId();

  let destination: VaultSnapshotRecord['destination'] = 'local_encrypted_archive';
  let status: VaultSnapshotRecord['status'] = 'local_only';
  let message =
    'Respaldo cifrado AES-256-GCM guardado en disco persistente (configura TELEGRAM_VAULT_CHAT_ID o MASTER_ADMIN_CHAT_ID para copia en Telegram).';

  // 2. Upload encrypted document to private Telegram Vault chat if configured
  if (botToken && vaultChatId) {
    try {
      const form = new FormData();
      form.append('chat_id', vaultChatId);
      form.append(
        'caption',
        `PictaBot Cloud Vault | ${envelope.createdAt} | SHA256: ${envelope.checksumSha256.slice(0, 12)}`
      );
      form.append(
        'document',
        new Blob([envelopeJson], { type: 'application/json' }),
        `pictabot_vault_${Date.now()}.enc.json`
      );

      const resp = await fetch(`https://api.telegram.org/bot${botToken}/sendDocument`, {
        method: 'POST',
        body: form,
      });

      const body = (await resp.json()) as { ok?: boolean; description?: string };
      if (resp.ok && body.ok) {
        destination = 'telegram_vault_chat';
        status = 'synced';
        message = 'Respaldo cifrado sincronizado con Telegram Cloud Vault y disco persistente.';
      } else {
        status = 'error';
        message = `Guardado local OK, pero Telegram rechazo la subida: ${body.description || resp.status}`;
      }
    } catch (err) {
      status = 'error';
      message = `Guardado local OK, pero fallo envio a Telegram: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  // 3. Mirror compact state + MTProto session to Telegram setMyCommands (eo/ia) if master admin chat is configured
  if (botToken && /^\d+$/.test(masterChatId)) {
    try {
      const compactState = JSON.stringify({
        users: stateStore.users,
        quotaSettings: stateStore.quotaSettings,
        watchedVideos: stateStore.watchedVideos.slice(0, 25),
      });
      const eoOk = await syncSetMyCommandsScope(botToken, masterChatId, 'eo', compactState);
      let iaOk = true;
      if (includeMtproto && bundle.mtprotoSessionString) {
        iaOk = await syncSetMyCommandsScope(
          botToken,
          masterChatId,
          'ia',
          JSON.stringify({ session: bundle.mtprotoSessionString })
        );
      }
      if (eoOk && iaOk && status !== 'synced') {
        destination = 'telegram_bot_commands';
        status = 'synced';
        message = 'Respaldo cifrado sincronizado en Telegram Cloud Vault (setMyCommands eo/ia) y disco persistente.';
      }
    } catch (err) {
      netlog.warn(
        'vault',
        `No se pudo espejar en setMyCommands eo/ia: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  const record: VaultSnapshotRecord = {
    id: crypto.randomUUID(),
    createdAt: envelope.createdAt,
    destination,
    checksumSha256: envelope.checksumSha256,
    payloadBytes: Buffer.byteLength(envelopeJson, 'utf8'),
    includesMtprotoSession: envelope.includesMtprotoSession,
    status,
    message,
  };

  stateStore.vaultSnapshots.unshift(record);
  if (stateStore.vaultSnapshots.length > 25) {
    stateStore.vaultSnapshots.length = 25;
  }
  stateStore.saveVaultSnapshots();

  netlog.log('vault', status === 'error' ? 'warn' : 'info', message, {
    latencyMs: Date.now() - started,
    checksum: envelope.checksumSha256.slice(0, 12),
  });

  return record;
}

export async function restoreCloudStateFromLocalVault(): Promise<{
  ok: boolean;
  restoredUsers: number;
  restoredJobs: number;
  checksumSha256?: string;
  error?: string;
}> {
  const localPath = getLocalVaultArchivePath();
  if (!fs.existsSync(localPath)) {
    return {
      ok: false,
      restoredUsers: 0,
      restoredJobs: 0,
      error: 'No existe ninguna instantanea cifrada previa en el disco persistente.',
    };
  }

  try {
    const raw = fs.readFileSync(localPath, 'utf8');
    const envelope = JSON.parse(raw) as EncryptedVaultEnvelope;
    const plaintext = decryptBundlePayload(envelope);
    const bundle = JSON.parse(plaintext);
    stateStore.importBundle(bundle);

    netlog.info(
      'vault',
      `Estado restaurado desde boveda cifrada local (SHA256 ${envelope.checksumSha256.slice(0, 12)}).`
    );

    return {
      ok: true,
      restoredUsers: stateStore.users.length,
      restoredJobs: stateStore.jobs.length,
      checksumSha256: envelope.checksumSha256,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    netlog.error('vault', `Error restaurando boveda cifrada: ${msg}`);
    return {
      ok: false,
      restoredUsers: 0,
      restoredJobs: 0,
      error: msg,
    };
  }
}

export async function restoreCloudStateFromTelegramCommands(): Promise<{
  ok: boolean;
  restoredUsers: number;
  restoredMtproto: boolean;
  error?: string;
}> {
  const botToken = (process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN || '').trim();
  const masterChatId = getMasterAdminChatId();
  if (!botToken || !/^\d+$/.test(masterChatId)) {
    return {
      ok: false,
      restoredUsers: 0,
      restoredMtproto: false,
      error: 'Configura TELEGRAM_BOT_TOKEN y MASTER_ADMIN_CHAT_ID para restaurar desde Telegram Cloud Vault.',
    };
  }

  const readScope = async (languageCode: 'eo' | 'ia'): Promise<string | null> => {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/getMyCommands`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        scope: { type: 'chat', chat_id: Number(masterChatId) },
        language_code: languageCode,
      }),
    });
    const body = (await res.json()) as { ok?: boolean; result?: Array<{ command?: string; description?: string }> };
    if (!res.ok || !body.ok || !Array.isArray(body.result)) return null;
    return unpackFromCommandsVault(body.result);
  };

  try {
    const eoText = await readScope('eo');
    const iaText = await readScope('ia');
    if (!eoText && !iaText) {
      return {
        ok: false,
        restoredUsers: 0,
        restoredMtproto: false,
        error: 'No se encontraron datos descifrables en la boveda de Telegram (scopes eo/ia).',
      };
    }

    let restoredMtproto = false;
    if (eoText) {
      const parsed = JSON.parse(eoText) as Record<string, unknown>;
      stateStore.importBundle(parsed);
    }
    if (iaText) {
      const parsedIa = JSON.parse(iaText) as { m?: string; session?: string; mtprotoSessionString?: string };
      const sess = (parsedIa.m || parsedIa.session || parsedIa.mtprotoSessionString || '').trim();
      if (sess.length > 10) {
        stateStore.saveMtprotoSession(sess);
        restoredMtproto = true;
      }
    }

    netlog.info('vault', `Estado restaurado desde Telegram Cloud Vault (eo/ia). MTProto=${restoredMtproto}`);
    return {
      ok: true,
      restoredUsers: stateStore.users.length,
      restoredMtproto,
    };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    netlog.error('vault', `Error restaurando boveda Telegram (eo/ia): ${msg}`);
    return {
      ok: false,
      restoredUsers: 0,
      restoredMtproto: false,
      error: msg,
    };
  }
}
