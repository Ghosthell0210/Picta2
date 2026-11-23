import React, { useEffect, useState } from 'react';
import { Plus, RotateCcw, Save, Trash2, UserCheck, UserX, X } from 'lucide-react';
import type { AuthorizedUser, DashboardBootstrapResponse, UserRole } from '../shared/types';
import { apiRequest } from '../lib/api';

interface UsersQuotasViewProps {
  data: DashboardBootstrapResponse;
  token: string;
  onRefresh: () => Promise<void>;
  onToast: (message: string, kind?: 'info' | 'error') => void;
}

const ROLE_LABELS: Record<UserRole, string> = {
  admin: 'Administrador',
  operator: 'Operador',
  user: 'Usuario',
};

export function UsersQuotasView({ data, token, onRefresh, onToast }: UsersQuotasViewProps) {
  const [defaultDailyQuotaGb, setDefaultDailyQuotaGb] = useState(data.quotaSettings.defaultDailyQuotaGb);
  const [defaultDailyMaxFiles, setDefaultDailyMaxFiles] = useState(data.quotaSettings.defaultDailyMaxFiles);
  const [maxSingleFileGb, setMaxSingleFileGb] = useState(data.quotaSettings.maxSingleFileGb);
  const [enforceQuotas, setEnforceQuotas] = useState(data.quotaSettings.enforceQuotas);
  const [savingQuotas, setSavingQuotas] = useState(false);

  const [showAddModal, setShowAddModal] = useState(false);
  const [telegramUserId, setTelegramUserId] = useState('');
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<UserRole>('user');
  const [dailyQuotaGb, setDailyQuotaGb] = useState(String(data.quotaSettings.defaultDailyQuotaGb));
  const [pictaUsername, setPictaUsername] = useState('');
  const [adding, setAdding] = useState(false);
  const [busyUid, setBusyUid] = useState<string | null>(null);

  useEffect(() => {
    setDefaultDailyQuotaGb(data.quotaSettings.defaultDailyQuotaGb);
    setDefaultDailyMaxFiles(data.quotaSettings.defaultDailyMaxFiles);
    setMaxSingleFileGb(data.quotaSettings.maxSingleFileGb);
    setEnforceQuotas(data.quotaSettings.enforceQuotas);
  }, [data.quotaSettings]);

  async function handleSaveGlobalQuotas(e: React.FormEvent) {
    e.preventDefault();
    setSavingQuotas(true);
    try {
      await apiRequest('/api/quotas', {
        method: 'PATCH',
        token,
        body: { defaultDailyQuotaGb, defaultDailyMaxFiles, maxSingleFileGb, enforceQuotas },
      });
      await onRefresh();
      onToast('Políticas de cuotas globales actualizadas.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error guardando cuotas.', 'error');
    } finally {
      setSavingQuotas(false);
    }
  }

  async function handleAddUser(e: React.FormEvent) {
    e.preventDefault();
    setAdding(true);
    try {
      await apiRequest('/api/users', {
        method: 'POST',
        token,
        body: {
          telegramUserId,
          username,
          displayName,
          role,
          dailyQuotaGb: Number(dailyQuotaGb),
          pictaUsername: pictaUsername.trim() || undefined,
        },
      });
      setShowAddModal(false);
      setTelegramUserId('');
      setUsername('');
      setDisplayName('');
      setPictaUsername('');
      await onRefresh();
      onToast('Usuario autorizado agregado y persistido.');
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'No se pudo agregar usuario.', 'error');
    } finally {
      setAdding(false);
    }
  }

  async function handlePatchUser(user: AuthorizedUser, patch: Record<string, unknown>, successMsg: string) {
    setBusyUid(user.telegramUserId);
    try {
      await apiRequest(`/api/users/${user.telegramUserId}`, {
        method: 'PATCH',
        token,
        body: patch,
      });
      await onRefresh();
      onToast(successMsg);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error actualizando usuario.', 'error');
    } finally {
      setBusyUid(null);
    }
  }

  async function handleDeleteUser(user: AuthorizedUser) {
    setBusyUid(user.telegramUserId);
    try {
      await apiRequest(`/api/users/${user.telegramUserId}`, {
        method: 'DELETE',
        token,
      });
      await onRefresh();
      onToast(`Acceso revocado para ${user.displayName}.`);
    } catch (err) {
      onToast(err instanceof Error ? err.message : 'Error revocando usuario.', 'error');
    } finally {
      setBusyUid(null);
    }
  }

  return (
    <div className="space-y-6">
      {/* Global quota settings */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg p-5">
        <div className="pb-4 border-b border-[#223047]">
          <h2 className="text-base font-semibold text-white">Políticas de Cuotas y Límites Diarios</h2>
          <p className="text-xs text-[#94A3B8] mt-0.5">
            Protege el disco de 10 GB y el ancho de banda mensual en Altare limitando el peso máximo por archivo y el
            consumo diario por cuenta de Telegram.
          </p>
        </div>

        <form onSubmit={handleSaveGlobalQuotas} className="pt-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs items-end">
          <div>
            <label className="block text-[#CBD5E1] mb-1">Cuota diaria base (GB)</label>
            <input
              type="number"
              step="0.5"
              min={0.5}
              max={100}
              value={defaultDailyQuotaGb}
              onChange={(e) => setDefaultDailyQuotaGb(Number(e.target.value))}
              className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
            />
          </div>
          <div>
            <label className="block text-[#CBD5E1] mb-1">Máx. archivos por día</label>
            <input
              type="number"
              min={1}
              max={500}
              value={defaultDailyMaxFiles}
              onChange={(e) => setDefaultDailyMaxFiles(Number(e.target.value))}
              className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
            />
          </div>
          <div>
            <label className="block text-[#CBD5E1] mb-1">Tope por archivo individual (GB)</label>
            <input
              type="number"
              step="0.1"
              min={0.2}
              max={4}
              value={maxSingleFileGb}
              onChange={(e) => setMaxSingleFileGb(Number(e.target.value))}
              className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <label className="flex items-center gap-2 text-[#CBD5E1] cursor-pointer whitespace-nowrap">
              <input
                type="checkbox"
                checked={enforceQuotas}
                onChange={(e) => setEnforceQuotas(e.target.checked)}
                className="rounded border-[#223047] bg-[#0B111A]"
              />
              Aplicar límites
            </label>
            <button
              type="submit"
              disabled={savingQuotas}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium disabled:opacity-50 whitespace-nowrap"
            >
              <Save className="w-3.5 h-3.5" />
              Guardar
            </button>
          </div>
        </form>
      </section>

      {/* Authorized Users Directory */}
      <section className="bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-[#223047] flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold text-white">Usuarios Autorizados en Telegram</h3>
            <p className="text-xs text-[#94A3B8] mt-0.5">
              Lista blanca persistida en <code className="text-[#CBD5E1]">authorized_users.json</code> y sincronizada en
              Telegram Cloud Vault.
            </p>
          </div>
          <button
            type="button"
            onClick={() => setShowAddModal(true)}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white transition-colors whitespace-nowrap shrink-0"
          >
            <Plus className="w-3.5 h-3.5" />
            Autorizar usuario
          </button>
        </div>

        {data.users.length === 0 ? (
          <div className="px-6 py-12 text-center">
            <p className="text-sm font-medium text-white">Aún no hay usuarios de Telegram registrados</p>
            <p className="text-xs text-[#94A3B8] mt-1 max-w-md mx-auto">
              Agrega tu Telegram User ID aquí o defínelo en la variable <code className="text-[#CBD5E1]">ADMIN_TELEGRAM_IDS</code> para
              que el bot responda a tus comandos.
            </p>
            <button
              type="button"
              onClick={() => setShowAddModal(true)}
              className="mt-4 inline-flex items-center gap-1.5 px-4 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white"
            >
              <Plus className="w-3.5 h-3.5" />
              Autorizar primer usuario
            </button>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#223047] text-[11px] font-medium text-[#94A3B8] bg-[#0E1520]">
                  <th className="py-2.5 px-5">Usuario / Telegram ID</th>
                  <th className="py-2.5 px-4">Rol</th>
                  <th className="py-2.5 px-4">Estado</th>
                  <th className="py-2.5 px-4 text-right">Consumo diario</th>
                  <th className="py-2.5 px-4">Sesión Picta</th>
                  <th className="py-2.5 px-5 text-right">Acciones</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#223047]/70">
                {data.users.map((u) => {
                  const busy = busyUid === u.telegramUserId;
                  return (
                    <tr key={u.telegramUserId} className="hover:bg-[#162032]/60">
                      <td className="py-3 px-5">
                        <div className="font-medium text-white">{u.displayName}</div>
                        <div className="text-[11px] text-[#64748B] font-mono">
                          @{u.username} · ID {u.telegramUserId}
                        </div>
                      </td>
                      <td className="py-3 px-4">
                        <select
                          disabled={busy}
                          value={u.role}
                          onChange={(e) =>
                            handlePatchUser(u, { role: e.target.value }, `Rol de ${u.displayName} actualizado.`)
                          }
                          className="bg-[#0B111A] border border-[#223047] rounded px-2 py-1 text-xs text-white focus:outline-none focus:border-[#3B82F6]"
                        >
                          {(['admin', 'operator', 'user'] as UserRole[]).map((r) => (
                            <option key={r} value={r}>
                              {ROLE_LABELS[r]}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="py-3 px-4 whitespace-nowrap">
                        <span className={u.active ? 'text-[#4ADE80]' : 'text-[#F87171]'}>
                          {u.active ? 'Activo' : 'Suspendido'}
                        </span>
                      </td>
                      <td className="py-3 px-4 text-right font-mono tabular-nums whitespace-nowrap">
                        <div className="text-white">
                          {u.usedTodayGb.toFixed(2)} / {u.dailyQuotaGb} GB
                        </div>
                        <div className="text-[11px] text-[#64748B]">
                          {u.filesToday} / {u.dailyMaxFiles} archivos
                        </div>
                      </td>
                      <td className="py-3 px-4 text-[#94A3B8] whitespace-nowrap">
                        {u.pictaLinked ? `Vinculado (${u.pictaUsername || 'Picta'})` : 'Sin vincular'}
                      </td>
                      <td className="py-3 px-5 text-right whitespace-nowrap">
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handlePatchUser(
                                u,
                                { active: !u.active },
                                u.active ? `Usuario ${u.displayName} suspendido.` : `Usuario ${u.displayName} reactivado.`
                              )
                            }
                            title={u.active ? 'Suspender acceso' : 'Reactivar acceso'}
                            className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#CBD5E1] disabled:opacity-40"
                          >
                            {u.active ? <UserX className="w-3.5 h-3.5" /> : <UserCheck className="w-3.5 h-3.5" />}
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() =>
                              handlePatchUser(u, { resetUsage: true }, `Cuota diaria reiniciada para ${u.displayName}.`)
                            }
                            title="Reiniciar consumo de hoy"
                            className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#1E2B42] text-[#60A5FA] disabled:opacity-40"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleDeleteUser(u)}
                            title="Revocar y eliminar usuario"
                            className="p-1.5 rounded border border-[#223047] bg-[#0B111A] hover:bg-[#DC2626]/20 text-[#94A3B8] hover:text-[#F87171] disabled:opacity-40"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* Add User Modal */}
      {showAddModal && (
        <div className="fixed inset-0 z-50 bg-black/70 flex items-center justify-center p-4">
          <div className="w-full max-w-md bg-[#111926] border border-[#223047] rounded-lg overflow-hidden">
            <div className="px-5 py-4 border-b border-[#223047] flex items-center justify-between">
              <h3 className="text-sm font-semibold text-white">Autorizar usuario de Telegram</h3>
              <button type="button" onClick={() => setShowAddModal(false)} className="text-[#94A3B8] hover:text-white">
                <X className="w-4 h-4" />
              </button>
            </div>
            <form onSubmit={handleAddUser} className="p-5 space-y-4 text-xs">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Telegram User ID</label>
                  <input
                    type="text"
                    required
                    pattern="\d{4,20}"
                    value={telegramUserId}
                    onChange={(e) => setTelegramUserId(e.target.value)}
                    placeholder="Ej. 5123456789"
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Alias @telegram</label>
                  <input
                    type="text"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    placeholder="operador_picta"
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[#CBD5E1] mb-1">Nombre visible</label>
                <input
                  type="text"
                  required
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                  placeholder="Ej. Cristian Admin"
                  className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Rol</label>
                  <select
                    value={role}
                    onChange={(e) => setRole(e.target.value as UserRole)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                  >
                    <option value="admin">Administrador</option>
                    <option value="operator">Operador</option>
                    <option value="user">Usuario</option>
                  </select>
                </div>
                <div>
                  <label className="block text-[#CBD5E1] mb-1">Cuota diaria (GB)</label>
                  <input
                    type="number"
                    step="0.5"
                    min={0.5}
                    max={100}
                    value={dailyQuotaGb}
                    onChange={(e) => setDailyQuotaGb(e.target.value)}
                    className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white font-mono tabular-nums focus:outline-none focus:border-[#3B82F6]"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[#CBD5E1] mb-1">Usuario Picta vinculado (opcional)</label>
                <input
                  type="text"
                  value={pictaUsername}
                  onChange={(e) => setPictaUsername(e.target.value)}
                  placeholder="Nombre de canal o usuario en Picta"
                  className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2 text-white focus:outline-none focus:border-[#3B82F6]"
                />
              </div>

              <div className="pt-2 flex items-center justify-end gap-2">
                <button
                  type="button"
                  onClick={() => setShowAddModal(false)}
                  className="px-4 py-2 rounded-md border border-[#223047] text-[#CBD5E1] hover:bg-[#162032]"
                >
                  Cancelar
                </button>
                <button
                  type="submit"
                  disabled={adding}
                  className="px-4 py-2 rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white font-medium disabled:opacity-50"
                >
                  {adding ? 'Guardando...' : 'Autorizar usuario'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
