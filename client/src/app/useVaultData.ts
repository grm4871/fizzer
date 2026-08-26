import { useCallback, useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from 'react';
import type { CommunityUpdates, User, Vault } from '../api';
import { api, ApiError } from '../api';
import { ensureDesktopRunnerHost, startDesktopRunnerHost, stopDesktopRunnerHost } from '../desktopRunnerHost';
import type { DesktopRunnerHealth } from '../chat/types';
import type { PersistedWorkspace } from '../chat/session';
import type { NoteEntry } from './useAppState';

export interface VaultDataOptions {
  user: User | null; vaults: Vault[]; showAgentMemory: boolean; activeVaultIdRef: MutableRefObject<string | null>; vaultWorkspacesRef: MutableRefObject<Record<string, PersistedWorkspace>>; vaultNoteContentsRef: MutableRefObject<Record<string, Record<string, NoteEntry>>>; communityRefreshTimerRef: MutableRefObject<number | null>;
  setVaults: Dispatch<SetStateAction<Vault[]>>; setUser: Dispatch<SetStateAction<User | null>>; setIsOwner: Dispatch<SetStateAction<boolean>>; setAuthReady: Dispatch<SetStateAction<boolean>>; setRunnerHealth: Dispatch<SetStateAction<DesktopRunnerHealth | null>>; setCommunityUpdates: Dispatch<SetStateAction<CommunityUpdates>>; setCommunityUpdatesLoading: Dispatch<SetStateAction<boolean>>; setCommunityUpdatesError: Dispatch<SetStateAction<string>>; setNotice: Dispatch<SetStateAction<string | null>>; setShowAgentMemory: Dispatch<SetStateAction<boolean>>;
  switchVaultWorkspace: (id: string | null) => void;
}

const EMPTY_COMMUNITY_UPDATES: CommunityUpdates = { groups: [], counts: { total: 0, directMessages: 0, byVault: {}, byTarget: {} }, truncated: false };
export function useVaultData({ user, vaults, showAgentMemory, activeVaultIdRef, vaultWorkspacesRef, vaultNoteContentsRef, communityRefreshTimerRef, setVaults, setUser, setIsOwner, setAuthReady, setRunnerHealth, setCommunityUpdates, setCommunityUpdatesLoading, setCommunityUpdatesError, setNotice, setShowAgentMemory, switchVaultWorkspace }: VaultDataOptions) {
  const loadVaults = useCallback(async () => {
    try {
      const data = await api<{ vaults: Vault[] }>('/api/vaults');
      let nextVaults = data.vaults;
      if (nextVaults.length === 0) {
        const created = await api<{ vault: Vault }>('/api/vaults', {
          method: 'POST',
          body: JSON.stringify({ name: 'My Vault' }),
        });
        nextVaults = [created.vault];
      }
      setVaults(nextVaults);
      const restoredVaultId = activeVaultIdRef.current;
      const restoredVaultValid = restoredVaultId && nextVaults.some((vault) => vault.id === restoredVaultId);
      if (!restoredVaultValid) {
        switchVaultWorkspace(nextVaults[0].id);
      }

      // Drop workspaces the signed-in account can no longer access. This also
      // prevents an invalid persisted vault from surviving an account change.
      const accessibleIds = new Set(nextVaults.map((vault) => vault.id));
      vaultWorkspacesRef.current = Object.fromEntries(
        Object.entries(vaultWorkspacesRef.current).filter(([vaultId]) => accessibleIds.has(vaultId)),
      );
      vaultNoteContentsRef.current = Object.fromEntries(
        Object.entries(vaultNoteContentsRef.current).filter(([vaultId]) => accessibleIds.has(vaultId)),
      );
    } catch (error) {
      console.error('Error loading vaults:', error);
    }
  }, [switchVaultWorkspace]);

  const loadCommunityUpdates = useCallback(async (quiet = false) => {
    if (!quiet) setCommunityUpdatesLoading(true);
    try {
      const data = await api<CommunityUpdates>(`/api/community/updates?limit=80${showAgentMemory ? '&includeAgentMemory=1' : ''}`);
      setCommunityUpdates(data);
      setCommunityUpdatesError('');
    } catch (error) {
      if (!quiet) setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not load updates');
    } finally {
      if (!quiet) setCommunityUpdatesLoading(false);
    }
  }, [showAgentMemory]);

  const updateShowAgentMemory = useCallback((show: boolean) => {
    setShowAgentMemory(show);
    localStorage.setItem('cascade_show_agent_memory', show ? '1' : '0');
  }, []);

  const scheduleCommunityRefresh = useCallback((delay = 350) => {
    if (communityRefreshTimerRef.current != null) return;
    communityRefreshTimerRef.current = window.setTimeout(() => {
      communityRefreshTimerRef.current = null;
      void loadCommunityUpdates(true);
    }, delay);
  }, [loadCommunityUpdates]);

  const markCommunityTargetRead = useCallback(async (targetId: string) => {
    if (!targetId) return;
    try {
      await api('/api/community/updates/read', {
        method: 'POST',
        body: JSON.stringify({ targetId }),
      });
      await loadCommunityUpdates(true);
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 404)) {
        console.error('Could not mark update read:', error);
      }
    }
  }, [loadCommunityUpdates]);

  const markAllCommunityUpdatesRead = useCallback(async () => {
    try {
      await api('/api/community/updates/read-all', { method: 'POST' });
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      await loadCommunityUpdates(true);
    } catch (error) {
      setCommunityUpdatesError(error instanceof Error ? error.message : 'Could not mark updates read');
    }
  }, [loadCommunityUpdates]);

  useEffect(() => {
    if (!user) {
      setCommunityUpdates(EMPTY_COMMUNITY_UPDATES);
      return;
    }
    void loadCommunityUpdates();
    const timer = window.setInterval(() => void loadCommunityUpdates(true), 60_000);
    const onVisibility = () => {
      if (document.visibilityState === 'visible') scheduleCommunityRefresh(150);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisibility);
      if (communityRefreshTimerRef.current != null) {
        window.clearTimeout(communityRefreshTimerRef.current);
        communityRefreshTimerRef.current = null;
      }
    };
  }, [loadCommunityUpdates, scheduleCommunityRefresh, user]);

  const handleCreateVault = useCallback(async (name: string): Promise<boolean> => {
    if (!name.trim()) return false;
    try {
      const data = await api<{ vault: Vault }>('/api/vaults', {
        method: 'POST',
        body: JSON.stringify({ name: name.trim() }),
      });
      setVaults((current) => [...current, data.vault]);
      switchVaultWorkspace(data.vault.id);
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not create vault');
      return false;
    }
  }, [switchVaultWorkspace]);

  const handleRenameVault = useCallback(async (id: string, name: string): Promise<boolean> => {
    const next = name.trim();
    if (!next) return false;
    try {
      const data = await api<{ vault: Vault }>(`/api/vaults/${id}`, {
        method: 'PATCH',
        body: JSON.stringify({ name: next }),
      });
      setVaults((current) => current.map((vault) => (
        vault.id === id ? { ...vault, name: data.vault.name } : vault
      )));
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not rename vault');
      return false;
    }
  }, []);

  const handleDeleteVault = useCallback(async (id: string): Promise<boolean> => {
    try {
      await api(`/api/vaults/${id}`, { method: 'DELETE' });
      const remaining = vaults.filter((vault) => vault.id !== id);
      setVaults(remaining);
      if (activeVaultIdRef.current === id) {
        switchVaultWorkspace(remaining[0]?.id ?? null);
      }
      await loadVaults();
      return true;
    } catch (error) {
      setNotice(error instanceof Error ? error.message : 'Could not delete vault');
      return false;
    }
  }, [loadVaults, switchVaultWorkspace, vaults]);

  useEffect(() => {
    let cancelled = false;
    let succeeded = false;
    let unauthorized = false;
    let attempt = 0;
    let timer: number | null = null;
    const tryAuth = () => {
      api<{ authenticated: boolean; user?: User; owner?: boolean }>('/api/session')
        .then((data) => {
          if (cancelled) return;
          if (!data.authenticated || !data.user) {
            unauthorized = true;
            stopDesktopRunnerHost();
            setAuthReady(true);
            return;
          }
          succeeded = true;
          setUser(data.user);
          setIsOwner(Boolean(data.owner));
          setAuthReady(true);
          void loadVaults();
        })
        .catch((error) => {
          if (cancelled) return;
          // A real 401 means no session. Transient network/deploy failures keep
          // retrying so an HttpOnly cookie is not mistaken for a logout.
          if (error instanceof ApiError && error.status === 401) {
            unauthorized = true;
            stopDesktopRunnerHost();
            setAuthReady(true);
            return;
          }
          attempt += 1;
          if (attempt > 6) return;
          timer = window.setTimeout(tryAuth, Math.min(1000 * 2 ** (attempt - 1), 15000));
        });
    };
    // If connectivity returns after the retries gave up, try again — a valid
    // token shouldn't strand the user on the login screen.
    const onReconnect = () => {
      if (cancelled || succeeded || unauthorized) return;
      attempt = 0;
      if (timer != null) window.clearTimeout(timer);
      tryAuth();
    };
    tryAuth();
    window.addEventListener('online', onReconnect);
    return () => {
      cancelled = true;
      if (timer != null) window.clearTimeout(timer);
      window.removeEventListener('online', onReconnect);
    };
  }, [loadVaults]);

  useEffect(() => {
    if (user) {
      // Renderer reloads are not logout. Main-process agents survive the page,
      // and the replacement renderer reconnects/reclaims them.
      startDesktopRunnerHost();
    }
  }, [user?.id]);

  // Poll desktop runner health for the chat agent sidebar.
  // Only commit setState when the payload actually changes — identical JSON
  // every 5s was re-rendering the whole chat tree and made idle hover laggy.
  useEffect(() => {
    if (!user) {
      setRunnerHealth(null);
      return;
    }
    let cancelled = false;
    let timer: number | null = null;
    const sameHealth = (a: DesktopRunnerHealth | null, b: DesktopRunnerHealth): boolean => {
      if (!a) return false;
      if (a.online !== b.online) return false;
      if (a.activeRuns !== b.activeRuns) return false;
      if (a.lastError !== b.lastError) return false;
      if (a.lastErrorAt !== b.lastErrorAt) return false;
      // lastSeenAt ticks on every runner socket event — ignore for UI identity
      // or the 12s health poll re-renders the whole chat tree while streaming.
      if (a.planUsage === b.planUsage) return true;
      try {
        return JSON.stringify(a.planUsage) === JSON.stringify(b.planUsage);
      } catch {
        return false;
      }
    };
    const mergePlanUsage = (
      prev: DesktopRunnerHealth['planUsage'],
      next: DesktopRunnerHealth['planUsage'],
    ): DesktopRunnerHealth['planUsage'] => {
      // Keep last good per-provider snapshot so meters don't vanish on a miss.
      const merged: NonNullable<DesktopRunnerHealth['planUsage']> = { ...(prev || {}) };
      if (!next) return Object.keys(merged).length ? merged : null;
      for (const [key, value] of Object.entries(next)) {
        if (value?.status === 'ok') merged[key] = value;
        else if (!merged[key]) merged[key] = value;
      }
      return merged;
    };
    const apply = (data: DesktopRunnerHealth) => {
      setRunnerHealth((prev) => {
        const withUsage: DesktopRunnerHealth = {
          ...data,
          planUsage: mergePlanUsage(prev?.planUsage ?? null, data.planUsage),
        };
        return sameHealth(prev, withUsage) ? prev : withUsage;
      });
    };
    const tick = async () => {
      // Skip network work while the tab is hidden; resume on visibilitychange.
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
      // Credential setup can race a self-host server boot/restart before the
      // runner socket exists. The setup helper is idempotent, so let this
      // existing health cadence recover that cold-start failure too.
      ensureDesktopRunnerHost();
      try {
        const data = await api<DesktopRunnerHealth>('/api/me/desktop-runner');
        if (!cancelled) apply(data);
      } catch {
        // A failed status request is transport-unknown, not proof that the
        // runner is offline. Keep the last confirmed snapshot (or null during
        // cold start) so a server/network blip cannot manufacture status UI.
      }
    };
    void tick();
    // 12s is plenty for a status pill; was 5s and forced full tree work.
    timer = window.setInterval(tick, 12_000);
    const onVis = () => {
      if (document.visibilityState === 'visible') void tick();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => {
      cancelled = true;
      if (timer != null) window.clearInterval(timer);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [user]);
  return {
    loadVaults, loadCommunityUpdates, updateShowAgentMemory, scheduleCommunityRefresh,
    markCommunityTargetRead, markAllCommunityUpdatesRead, handleCreateVault,
    handleRenameVault, handleDeleteVault,
  };
}
