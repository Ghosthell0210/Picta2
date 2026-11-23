import React, { useCallback, useEffect, useState } from 'react';
import {
  Activity,
  Bell,
  CloudUpload,
  HardDrive,
  Layers,
  LogOut,
  Menu,
  RefreshCw,
  Shield,
  Users,
  X,
} from 'lucide-react';
import type { AuthStatusResponse, DashboardBootstrapResponse } from './shared/types';
import { apiRequest, fetchAuthStatus, fetchBootstrap, UnauthorizedError } from './lib/api';
import { AuthGate } from './components/AuthGate';
import { OverviewQueueView } from './components/OverviewQueueView';
import { DiskAssemblerView } from './components/DiskAssemblerView';
import { NetlogMtprotoView } from './components/NetlogMtprotoView';
import { UsersQuotasView } from './components/UsersQuotasView';
import { PictaAlertsView } from './components/PictaAlertsView';
import { VaultAltareView } from './components/VaultAltareView';

type NavTab = 'overview' | 'disk' | 'netlog' | 'users' | 'alerts' | 'vault';

const NAV_ITEMS: Array<{ id: NavTab; label: string; breadcrumb: string; icon: React.ComponentType<{ className?: string }> }> = [
  { id: 'overview', label: 'Operaciones y Cola', breadcrumb: 'Operaciones / Cola de Subidas', icon: Layers },
  { id: 'disk', label: 'Disco 10 GB y /unir', breadcrumb: 'Almacenamiento / Ensamblador /unir', icon: HardDrive },
  { id: 'netlog', label: 'MTProto y /netlog', breadcrumb: 'Red / Pool MTProto y /netlog', icon: Activity },
  { id: 'users', label: 'Usuarios y Cuotas', breadcrumb: 'Acceso / Usuarios y Cuotas', icon: Users },
  { id: 'alerts', label: 'Alertas Picta', breadcrumb: 'Monitoreo / Alertas y Nomad', icon: Bell },
  { id: 'vault', label: 'Bóveda y Altare', breadcrumb: 'Resiliencia / Cloud Vault y Altare', icon: Shield },
];

export default function App() {
  const [authStatus, setAuthStatus] = useState<AuthStatusResponse | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [data, setData] = useState<DashboardBootstrapResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [syncingVault, setSyncingVault] = useState(false);
  const [activeTab, setActiveTab] = useState<NavTab>('overview');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [toast, setToast] = useState<{ message: string; kind: 'info' | 'error' } | null>(null);

  const showToast = useCallback((message: string, kind: 'info' | 'error' = 'info') => {
    setToast({ message, kind });
  }, []);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 4200);
    return () => clearTimeout(t);
  }, [toast]);

  const loadAuth = useCallback(async (currentToken?: string | null) => {
    try {
      const status = await fetchAuthStatus(currentToken);
      setAuthStatus(status);
      if (!status.authenticated && currentToken) {
        setToken(null);
      }
    } catch {
      setAuthStatus({ requiresClaim: false, envPasscodeConfigured: false, authenticated: false });
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAuth(null);
  }, [loadAuth]);

  const refreshData = useCallback(
    async (silent = false) => {
      if (!token) return;
      if (!silent) setRefreshing(true);
      try {
        const next = await fetchBootstrap(token);
        setData(next);
      } catch (err) {
        if (err instanceof UnauthorizedError) {
          setToken(null);
          setData(null);
          void loadAuth(null);
          showToast('Tu sesión expiró. Vuelve a iniciar sesión.', 'error');
        } else if (!silent) {
          showToast(err instanceof Error ? err.message : 'Error cargando estado del servidor.', 'error');
        }
      } finally {
        if (!silent) setRefreshing(false);
      }
    },
    [token, loadAuth, showToast]
  );

  useEffect(() => {
    if (!token) return;
    void refreshData(false);
    const interval = setInterval(() => {
      void refreshData(true);
    }, 8000);
    return () => clearInterval(interval);
  }, [token, refreshData]);

  async function handleQuickVaultSync() {
    if (!token) return;
    setSyncingVault(true);
    try {
      const resp = await apiRequest<{ ok: boolean; snapshot: { message: string } }>('/api/vault/backup', {
        method: 'POST',
        token,
        body: { includeMtproto: true },
      });
      await refreshData(true);
      showToast(resp.snapshot.message);
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Error respaldando bóveda.', 'error');
    } finally {
      setSyncingVault(false);
    }
  }

  function handleLogout() {
    setToken(null);
    setData(null);
    void loadAuth(null);
  }

  if (loading || !authStatus) {
    return (
      <div className="min-h-screen bg-[#0B111A] text-[#94A3B8] flex items-center justify-center text-sm">
        Inicializando consola PictaBot Altare...
      </div>
    );
  }

  if (!token) {
    return (
      <AuthGate
        status={authStatus}
        onAuthenticated={(issuedToken) => {
          setToken(issuedToken);
          setAuthStatus((prev) => (prev ? { ...prev, authenticated: true, requiresClaim: false } : prev));
        }}
      />
    );
  }

  const currentNav = NAV_ITEMS.find((n) => n.id === activeTab) || NAV_ITEMS[0];

  return (
    <div className="min-h-screen bg-[#0B111A] text-[#E6EDF7] flex">
      {/* Desktop Sidebar */}
      <aside className="hidden lg:flex lg:flex-col w-64 shrink-0 bg-[#111926] border-r border-[#223047]">
        <div className="h-14 px-5 flex items-center border-b border-[#223047]">
          <span className="text-base font-bold tracking-tight text-white whitespace-nowrap">PictaBot Altare</span>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium transition-colors text-left whitespace-nowrap ${
                  active
                    ? 'bg-[#162032] text-white border border-[#223047]'
                    : 'text-[#94A3B8] hover:text-white hover:bg-[#162032]/50 border border-transparent'
                }`}
              >
                <Icon className={`w-4 h-4 shrink-0 ${active ? 'text-[#3B82F6]' : 'text-[#64748B]'}`} />
                <span className="truncate">{item.label}</span>
              </button>
            );
          })}
        </nav>

        <div className="p-4 border-t border-[#223047] space-y-3 text-xs">
          <div className="flex items-center justify-between text-[#94A3B8]">
            <span>Entorno</span>
            <span className="font-mono text-[#E6EDF7]">{data?.telemetry.nodeEnv || '—'}</span>
          </div>
          <div className="flex items-center justify-between text-[#94A3B8]">
            <span>Keep-Alive CR</span>
            <span className="font-mono text-[#4ADE80]">Desactivado</span>
          </div>
          <button
            type="button"
            onClick={handleLogout}
            className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-[#223047] bg-[#0B111A] hover:bg-[#162032] text-[#CBD5E1] transition-colors"
          >
            <LogOut className="w-3.5 h-3.5" />
            Cerrar sesión
          </button>
        </div>
      </aside>

      {/* Mobile Navigation Drawer */}
      {mobileMenuOpen && (
        <div className="fixed inset-0 z-50 lg:hidden flex">
          <div className="w-64 bg-[#111926] border-r border-[#223047] flex flex-col">
            <div className="h-14 px-5 flex items-center justify-between border-b border-[#223047]">
              <span className="text-base font-bold text-white">PictaBot Altare</span>
              <button type="button" onClick={() => setMobileMenuOpen(false)} className="text-[#94A3B8] p-1">
                <X className="w-5 h-5" />
              </button>
            </div>
            <nav className="flex-1 p-3 space-y-1">
              {NAV_ITEMS.map((item) => {
                const Icon = item.icon;
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => {
                      setActiveTab(item.id);
                      setMobileMenuOpen(false);
                    }}
                    className={`w-full flex items-center gap-3 px-3 py-2.5 rounded-md text-sm font-medium ${
                      active ? 'bg-[#162032] text-white' : 'text-[#94A3B8]'
                    }`}
                  >
                    <Icon className="w-4 h-4 shrink-0" />
                    <span>{item.label}</span>
                  </button>
                );
              })}
            </nav>
            <div className="p-4 border-t border-[#223047]">
              <button
                type="button"
                onClick={handleLogout}
                className="w-full inline-flex items-center justify-center gap-2 px-3 py-2 rounded-md border border-[#223047] bg-[#0B111A] text-xs text-[#CBD5E1]"
              >
                <LogOut className="w-3.5 h-3.5" />
                Cerrar sesión
              </button>
            </div>
          </div>
          <div className="flex-1 bg-black/60" onClick={() => setMobileMenuOpen(false)} />
        </div>
      )}

      {/* Main Content Workspace */}
      <div className="flex-1 flex flex-col min-w-0">
        {/* Top Bar Contract: Breadcrumb Left — Primary Action Right */}
        <header className="h-14 px-4 sm:px-6 border-b border-[#223047] bg-[#111926] flex items-center justify-between gap-4 shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-1.5 rounded-md border border-[#223047] text-[#CBD5E1]"
              aria-label="Abrir navegación"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="text-sm font-medium text-[#CBD5E1] truncate">{currentNav.breadcrumb}</div>
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => void refreshData(false)}
              disabled={refreshing}
              title="Actualizar estado"
              className="p-2 rounded-md border border-[#223047] bg-[#0B111A] hover:bg-[#162032] text-[#CBD5E1] disabled:opacity-50 transition-colors"
            >
              <RefreshCw className={`w-4 h-4 ${refreshing ? 'animate-spin' : ''}`} />
            </button>
            <button
              type="button"
              onClick={handleQuickVaultSync}
              disabled={syncingVault}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md bg-[#3B82F6] hover:bg-[#2563EB] text-white disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
            >
              <CloudUpload className="w-3.5 h-3.5" />
              {syncingVault ? 'Sincronizando...' : 'Respaldar Bóveda'}
            </button>
          </div>
        </header>

        {/* Viewport Container */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {!data ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((idx) => (
                <div
                  key={idx}
                  className="h-28 bg-[#111926] border border-[#223047] rounded-lg animate-pulse"
                />
              ))}
            </div>
          ) : (
            <>
              {activeTab === 'overview' && (
                <OverviewQueueView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
              {activeTab === 'disk' && (
                <DiskAssemblerView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
              {activeTab === 'netlog' && (
                <NetlogMtprotoView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
              {activeTab === 'users' && (
                <UsersQuotasView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
              {activeTab === 'alerts' && (
                <PictaAlertsView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
              {activeTab === 'vault' && (
                <VaultAltareView
                  data={data}
                  token={token}
                  onRefresh={() => refreshData(true)}
                  onToast={showToast}
                />
              )}
            </>
          )}
        </main>
      </div>

      {/* Non-intrusive Toast */}
      {toast && (
        <div
          role="status"
          className={`fixed bottom-5 right-5 z-50 max-w-md px-4 py-3 rounded-md border text-xs font-medium shadow-lg ${
            toast.kind === 'error'
              ? 'bg-[#1F1215] border-[#DC2626]/60 text-[#FCA5A5]'
              : 'bg-[#111926] border-[#3B82F6]/60 text-[#E6EDF7]'
          }`}
        >
          {toast.message}
        </div>
      )}
    </div>
  );
}
