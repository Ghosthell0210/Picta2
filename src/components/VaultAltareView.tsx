import React, { useMemo, useState } from 'react';
import { Check, CloudDownload, CloudUpload, Copy, KeyRound, RotateCcw, Shield } from 'lucide-react';
import type { DashboardBootstrapResponse } from '../shared/types';
import { apiRequest, formatBytes, formatDateTimeShort } from '../lib/api';

interface VaultAltareViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

function generateSecureHex(bytesLen: number): string {
  const bytes = new Uint8Array(bytesLen);
  window.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function buildAltareEnvSnippet(keys?: { vaultKey: string; webhookSecret: string; adminPasscode: string }): string {
  return `NODE_ENV=production
PORT=3000
TELEGRAM_MODE=polling
TELEGRAM_BOT_TOKEN=<tu_token_botfather>
TELEGRAM_WEBHOOK_SECRET=${keys?.webhookSecret || '<secreto_webhook_opcional>'}
MASTER_ADMIN_CHAT_ID=<tu_telegram_user_id>
TELEGRAM_API_ID=<tu_api_id>
TELEGRAM_API_HASH=<tu_api_hash>
TELEGRAM_VAULT_CHAT_ID=<id_canal_privado_boveda_opcional>
VAULT_ENCRYPTION_KEY=${keys?.vaultKey || '<clave_maestra_32_caracteres>'}
PICTA_USERNAME=<usuario_o_telefono_picta>
PICTA_PASSWORD=<password_picta>
PICTA_CLIENT_ID=<client_id_oauth_picta>
PICTA_AES_KEY=<clave_aes_128_picta>
PICTA_CHANNEL_ID=36319
PICTA_CHANNEL_NAME=Multiverso Visual
TMDB_API_KEY=<tu_tmdb_api_key_opcional>
ADMIN_DASHBOARD_PASSCODE=${keys?.adminPasscode || '<clave_panel_operaciones>'}
PICTA_STATE_DIR=/app/data/bot_state
PICTA_SCRATCH_DIR=/app/data/scratch
PICTA_DISK_BUDGET_GB=10
MTPROTO_SAFE_PARALLEL_WORKERS=6
MTPROTO_TCP_POOL_SIZE=6
MAX_PREFETCH_LOOKAHEAD=1`;
}

export function VaultAltareView({ data, token, onRefresh, onToast }: VaultAltareViewProps) {
  const [includeMtproto, setIncludeMtproto] = useState(true);
  const [backingUp, setBackingUp] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [restoringTelegram, setRestoringTelegram] = useState(false);
  const [copiedEnv, setCopiedEnv] = useState(false);
  const [generatedKeys, setGeneratedKeys] = useState<{
    vaultKey: string;
    webhookSecret: string;
    adminPasscode: string;
  } | null>(null);

  const envSnippet = useMemo(() => buildAltareEnvSnippet(generatedKeys || undefined), [generatedKeys]);

  async function handleBackupNow() {
    setBackingUp(true);
    try {
      const resp = await apiRequest<{ ok: boolean; snapshot: { message: string } }>('/api/vault/backup', {
        method: 'POST',
        token,
        body: { includeMtproto },
      });
      await onRefresh();
      onToast(resp.snapshot.message);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error creando respaldo en bóveda.', 'error');
    } finally {
      setBackingUp(false);
    }
  }

  async function handleRestoreVault() {
    setRestoring(true);
    try {
      const resp = await apiRequest<{
        ok: boolean;
        restoredUsers: number;
        restoredJobs: number;
        checksumSha256?: string;
      }>('/api/vault/restore', {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast(
        `Estado restaurado (${resp.restoredUsers} usuarios · ${resp.restoredJobs} trabajos · SHA256 ${resp.checksumSha256?.slice(0, 10)}).`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo restaurar la bóveda.', 'error');
    } finally {
      setRestoring(false);
    }
  }

  async function handleRestoreTelegramVault() {
    setRestoringTelegram(true);
    try {
      const resp = await apiRequest<{
        ok: boolean;
        restoredUsers: number;
        restoredMtproto: boolean;
      }>('/api/vault/restore-telegram', {
        method: 'POST',
        token,
      });
      await onRefresh();
      onToast(
        `Bóveda de Telegram (eo/ia) restaurada: ${resp.restoredUsers} usuarios · Sesión MTProto ${resp.restoredMtproto ? 'recuperada' : 'no presente'}.`
      );
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo restaurar desde Telegram (eo/ia).', 'error');
    } finally {
      setRestoringTelegram(false);
    }
  }

  function handleGenerateKeys() {
    setGeneratedKeys({
      vaultKey: generateSecureHex(24),
      webhookSecret: generateSecureHex(16),
      adminPasscode: generateSecureHex(12),
    });
    onToast('Claves seguras generadas localmente en tu navegador. Cópialas y guárdalas en Altare.');
  }

  async function handleCopyEnvTemplate() {
    try {
      await navigator.clipboard.writeText(envSnippet);
      setCopiedEnv(true);
      setTimeout(() => setCopiedEnv(false), 2000);
      onToast('Plantilla de variables para Altare copiada al portapapeles.');
    } catch {
      onToast('No se pudo copiar al portapapeles.', 'error');
    }
  }

  const configuredCount = data.envChecks.filter((e) => e.configured).length;
  const requiredMissing = data.envChecks.filter((e) => e.requiredForProduction && !e.configured).length;

  return (
    <div className="space-y-6">
      {/* Telegram Cloud Vault Section */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#223047] flex flex-col lg:flex-row lg:items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-white">Respaldo Cifrado en Telegram Cloud Vault</h2>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Cifrado AES-256-GCM con verificación SHA-256. Protege usuarios, cuotas, cola y sesión MTProto si un nodo
              gratuito de Altare se reinicia o se pierde.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <label className="inline-flex items-center gap-2 text-xs text-[#CBD5E1] mr-2 cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={includeMtproto}
                onChange={(e) => setIncludeMtproto(e.target.checked)}
                className="rounded border-[#223047] bg-[#0B111A]"
              />
              Incluir sesión MTProto
            </label>
            <button
              type="button"
              onClick={handleRestoreTelegramVault}
              disabled={restoringTelegram}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] disabled:opacity-40 whitespace-nowrap"
            >
              <CloudDownload className="w-3.5 h-3.5" />
              {restoringTelegram ? 'Leyendo Telegram...' : 'Restaurar de Telegram (eo/ia)'}
            </button>
            <button
              type="button"
              onClick={handleRestoreVault}
              disabled={restoring || data.vaultSnapshots.length === 0}
              className="inline-flex items-center gap-1.5 px-3 py-2 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-[#E6EDF7] disabled:opacity-40 whitespace-nowrap"
            >
              <RotateCcw className="w-3.5 h-3.5" />
              {restoring ? 'Restaurando...' : 'Restaurar copia local'}
            </button>
            <button
              type="button"
              onClick={handleBackupNow}
              disabled={backingUp}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white disabled:opacity-50 whitespace-nowrap"
            >
              <CloudUpload className="w-3.5 h-3.5" />
              {backingUp ? 'Cifrando...' : 'Respaldar ahora'}
            </button>
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 divide-y sm:divide-y-0 sm:divide-x divide-[#223047] text-xs bg-[#0E1520]">
          <div className="px-5 py-3">
            <span className="text-[#94A3B8]">Chat Bóveda Telegram: </span>
            <span className={data.telemetry.vault.chatConfigured ? 'text-[#4ADE80] font-medium' : 'text-[#FBBF24] font-medium'}>
              {data.telemetry.vault.chatConfigured ? 'Configurado' : 'Pendiente (solo copia local)'}
            </span>
          </div>
          <div className="px-5 py-3">
            <span className="text-[#94A3B8]">Clave VAULT_ENCRYPTION_KEY: </span>
            <span
              className={data.telemetry.vault.encryptionKeyConfigured ? 'text-[#4ADE80] font-medium' : 'text-[#FBBF24] font-medium'}
            >
              {data.telemetry.vault.encryptionKeyConfigured ? 'Definida en secretos' : 'Pendiente para producción'}
            </span>
          </div>
          <div className="px-5 py-3 font-mono tabular-nums">
            <span className="text-[#94A3B8] font-sans">Último respaldo: </span>
            <span className="text-white">{formatDateTimeShort(data.telemetry.vault.lastSyncAt)}</span>
          </div>
        </div>

        {data.vaultSnapshots.length === 0 ? (
          <div className="p-8 text-center text-xs text-[#94A3B8]">
            <Shield className="w-6 h-6 mx-auto text-[#64748B] mb-2" />
            Todavía no hay instantáneas cifradas. Pulsa &quot;Respaldar ahora&quot; para generar tu primera copia
            verificada.
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#223047] text-[11px] font-medium text-[#94A3B8] bg-[#0E1520]">
                  <th className="py-2.5 px-5">Fecha</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-4">Destino</th>
                  <th className="py-2.5 px-4">SHA-256</th>
                  <th className="py-2.5 px-4 text-right">Tamaño</th>
                  <th className="py-2.5 px-5">Detalle</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/70">
                {data.vaultSnapshots.map((snap) => (
                  <tr key={snap.id} className="hover:bg-[#162032]/50">
                    <td className="py-2.5 px-5 font-mono tabular-nums text-[#CBD5E1] whitespace-nowrap">
                      {formatDateTimeShort(snap.createdAt)}
                    </td>
                    <td className="py-2.5 px-4 whitespace-nowrap font-medium">
                      <span
                        className={
                          snap.status === 'synced'
                            ? 'text-[#4ADE80]'
                            : snap.status === 'local_only'
                              ? 'text-[#60A5FA]'
                              : 'text-[#F87171]'
                        }
                      >
                        {snap.status === 'synced'
                          ? 'Sincronizado'
                          : snap.status === 'local_only'
                            ? 'Cifrado local'
                            : 'Error remoto'}
                      </span>
                    </td>
                    <td className="py-2.5 px-4 text-[#94A3B8] font-mono whitespace-nowrap">{snap.destination}</td>
                    <td className="py-2.5 px-4 font-mono text-[#CBD5E1]">{snap.checksumSha256.slice(0, 14)}</td>
                    <td className="py-2.5 px-4 text-right font-mono tabular-nums text-[#E6EDF7] whitespace-nowrap">
                      {formatBytes(snap.payloadBytes)}
                    </td>
                    <td className="py-2.5 px-5 text-[#94A3B8] max-w-md truncate">{snap.message}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Altare Readiness & Env Variables Matrix */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6 items-start">
        <section className="xl:col-span-2 bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between gap-4">
            <div>
              <h3 className="text-sm font-semibold text-white">Lista de Verificación para Altare (Secretos)</h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">
                Cero credenciales escritas en el repositorio. Se muestra solo presencia/ausencia sin exponer valores.
              </p>
            </div>
            <div className="text-xs font-mono tabular-nums whitespace-nowrap">
              <span className="text-white">{configuredCount}/{data.envChecks.length}</span>{' '}
              <span className={requiredMissing > 0 ? 'text-[#FBBF24]' : 'text-[#4ADE80]'}>
                ({requiredMissing} faltantes)
              </span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#223047] text-[11px] font-medium text-[#94A3B8] bg-[#0E1520]">
                  <th className="py-2.5 px-5">Variable</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-5">Propósito</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/70">
                {data.envChecks.map((item) => (
                  <tr key={item.key} className="hover:bg-[#162032]/40">
                    <td className="py-2.5 px-5 font-mono text-white whitespace-nowrap">{item.key}</td>
                    <td className="py-2.5 px-4 whitespace-nowrap font-medium">
                      {item.configured ? (
                        <span className="text-[#4ADE80]">Configurada</span>
                      ) : item.requiredForProduction ? (
                        <span className="text-[#FBBF24]">Requerida en Altare</span>
                      ) : (
                        <span className="text-[#94A3B8]">Valor por defecto</span>
                      )}
                    </td>
                    <td className="py-2.5 px-5 text-[#94A3B8]">{item.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between gap-2">
            <div>
              <h3 className="text-sm font-semibold text-white">Plantilla .env para Altare</h3>
              <p className="text-xs text-[#94A3B8] mt-0.5">Lista para pegar en Variables de Entorno.</p>
            </div>
            <div className="flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={handleGenerateKeys}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs font-medium rounded-md border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#CBD5E1] whitespace-nowrap shrink-0"
              >
                <KeyRound className="w-3.5 h-3.5" />
                Generar claves
              </button>
              <button
                type="button"
                onClick={handleCopyEnvTemplate}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#223047] bg-[#162032] hover:bg-[#1E2B42] text-white whitespace-nowrap shrink-0"
              >
                {copiedEnv ? <Check className="w-3.5 h-3.5 text-[#4ADE80]" /> : <Copy className="w-3.5 h-3.5" />}
                {copiedEnv ? 'Copiado' : 'Copiar'}
              </button>
            </div>
          </div>
          <pre className="p-4 text-[11px] leading-relaxed font-mono text-[#CBD5E1] bg-[#0B111A] overflow-x-auto">
            {envSnippet}
          </pre>
          <div className="px-5 py-3 border-t border-[#223047] text-xs text-[#94A3B8] space-y-1">
            <p className="text-white font-medium">Pasos de despliegue en Altare:</p>
            <p>1. Conecta tu repositorio Git con el Dockerfile incluido.</p>
            <p>2. Monta el volumen persistente en <code className="text-[#CBD5E1]">/app/data</code>.</p>
            <p>3. Carga los secretos en el panel y arranca con <code className="text-[#CBD5E1]">node server.js</code>.</p>
          </div>
        </section>
      </div>
    </div>
  );
}
