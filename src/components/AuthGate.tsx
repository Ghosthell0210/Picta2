import React, { useState } from 'react';
import { KeyRound, Lock, ShieldCheck } from 'lucide-react';
import type { AuthStatusResponse } from '../shared/types';
import { apiRequest } from '../lib/api';

interface AuthGateProps {
  status: AuthStatusResponse;
  onAuthenticated: (token: string) => void;
}

export function AuthGate({ status, onAuthenticated }: AuthGateProps) {
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isClaimMode = status.requiresClaim;

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);

    if (isClaimMode) {
      if (password.trim().length < 8) {
        setError('La contraseña administrativa debe tener al menos 8 caracteres.');
        return;
      }
      if (password !== confirmPassword) {
        setError('Las contraseñas no coinciden.');
        return;
      }
    }

    setSubmitting(true);
    try {
      const endpoint = isClaimMode ? '/api/auth/claim' : '/api/auth/login';
      const resp = await apiRequest<{ ok: boolean; token: string }>(endpoint, {
        method: 'POST',
        body: { password },
      });
      onAuthenticated(resp.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'No se pudo autenticar.');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="min-h-screen bg-[#0B111A] text-[#E6EDF7] flex items-center justify-center px-4 py-12">
      <div className="w-full max-w-md bg-[#111926] border border-[#223047] rounded-lg p-8">
        <div className="flex items-center gap-3 mb-6">
          <div className="w-10 h-10 rounded-md bg-[#162032] border border-[#223047] flex items-center justify-center text-[#3B82F6]">
            {isClaimMode ? <ShieldCheck className="w-5 h-5" /> : <Lock className="w-5 h-5" />}
          </div>
          <div>
            <h1 className="text-lg font-semibold tracking-tight text-white">PictaBot Altare</h1>
            <p className="text-xs text-[#94A3B8]">
              {isClaimMode ? 'Configuración inicial de acceso' : 'Consola de operaciones administrativas'}
            </p>
          </div>
        </div>

        <p className="text-sm text-[#94A3B8] leading-relaxed mb-6">
          {isClaimMode
            ? 'No se detectó ADMIN_DASHBOARD_PASSCODE en el entorno. Define una contraseña única para proteger esta consola (se guarda cifrada en el disco persistente con scrypt).'
            : status.envPasscodeConfigured
              ? 'Introduce la clave configurada en ADMIN_DASHBOARD_PASSCODE para administrar la cola, MTProto y la bóveda.'
              : 'Introduce la contraseña administrativa registrada en el servidor para iniciar sesión.'}
        </p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="admin-pass" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
              {isClaimMode ? 'Nueva contraseña de administrador' : 'Contraseña administrativa'}
            </label>
            <div className="relative">
              <KeyRound className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
              <input
                id="admin-pass"
                type="password"
                autoComplete={isClaimMode ? 'new-password' : 'current-password'}
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isClaimMode ? 'Mínimo 8 caracteres' : 'Ingresa tu contraseña'}
                className="w-full bg-[#0B111A] border border-[#223047] rounded-md pl-9 pr-3 py-2.5 text-sm text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          </div>

          {isClaimMode && (
            <div>
              <label htmlFor="admin-pass-confirm" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                Confirmar contraseña
              </label>
              <input
                id="admin-pass-confirm"
                type="password"
                autoComplete="new-password"
                required
                value={confirmPassword}
                onChange={(e) => setConfirmPassword(e.target.value)}
                placeholder="Repite la contraseña"
                className="w-full bg-[#0B111A] border border-[#223047] rounded-md px-3 py-2.5 text-sm text-white placeholder:text-[#64748B] focus:outline-none focus:border-[#3B82F6]"
              />
            </div>
          )}

          {error && (
            <div className="text-xs text-[#FCA5A5] bg-[#DC2626]/10 border border-[#DC2626]/40 rounded-md px-3 py-2">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-2.5 px-4 bg-[#3B82F6] hover:bg-[#2563EB] disabled:opacity-50 text-white text-sm font-medium rounded-md transition-colors whitespace-nowrap"
          >
            {submitting
              ? 'Verificando...'
              : isClaimMode
                ? 'Establecer contraseña y entrar'
                : 'Iniciar sesión'}
          </button>
        </form>

        <div className="mt-6 pt-5 border-t border-[#223047] text-xs text-[#64748B] space-y-1">
          <p>El token de sesión se mantiene solo en memoria del navegador.</p>
          <p>En Altare, define ADMIN_DASHBOARD_PASSCODE en los secretos del contenedor.</p>
        </div>
      </div>
    </div>
  );
}
