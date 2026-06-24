/**
 * @file WebView.tsx — Embedded web browser component
 *
 * Renders a website inside the app using Electron's native WebContentsView when running
 * in Electron, or an <iframe> fallback when running in a regular browser (dev mode).
 *
 * Features:
 * - Navigation toolbar (back, forward, reload, URL bar, open-externally)
 * - Loading progress indicator
 * - Error state with retry button
 * - Title change tracking (reported to parent for tab title updates)
 *
 * WebContentsView is preferred over <webview> or <iframe> because it is a native
 * Chromium child window managed directly by the main process, providing complete compatibility
 * with complex sites like Discord and high performance.
 *
 * @component
 */

import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, AlertTriangle, Shield, ShieldOff } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface WebViewProps {
  /** Unique ID for the tab session */
  tabId: string;
  /** The URL to load in the web view */
  url: string;
  /**
   * Whether this tab is currently visible/focused.
   */
  active?: boolean;
  /** Called when the page navigates to a new URL */
  onNavigate?: (url: string) => void;
  /** Called when the page title changes (used to update tab title) */
  onTitleChange?: (title: string) => void;
  /** Whether the tab is a chat note and should hide UI elements */
  isChatNote?: boolean;
}

type ElectronApi = {
  openExternal?: (url: string) => Promise<{ success: boolean; error?: string }>;
  getAdBlockState?: (url: string) => Promise<AdBlockStateResult>;
  setAdBlockSiteEnabled?: (input: { url: string; enabled: boolean }) => Promise<AdBlockStateResult>;
  createView?: (tabId: string, isChatNote?: boolean) => Promise<{ success: boolean; adopted?: boolean; error?: string }>;
  setChatNote?: (tabId: string, isChatNote: boolean) => Promise<{ success: boolean; error?: string }>;
  setViewBounds?: (tabId: string, bounds: { x: number; y: number; width: number; height: number }) => Promise<{ success: boolean; error?: string }>;
  setViewVisible?: (tabId: string, visible: boolean) => Promise<{ success: boolean; error?: string }>;
  destroyView?: (tabId: string) => Promise<{ success: boolean; error?: string }>;
  loadURL?: (tabId: string, url: string) => Promise<{ success: boolean; error?: string }>;
  goBack?: (tabId: string) => Promise<{ success: boolean; error?: string }>;
  goForward?: (tabId: string) => Promise<{ success: boolean; error?: string }>;
  reload?: (tabId: string) => Promise<{ success: boolean; error?: string }>;
  onBrowserEvent?: (callback: (payload: any) => void) => () => void;
};

type AdBlockStateResult = {
  success: boolean;
  site?: string;
  enabled?: boolean;
  blockerReady?: boolean;
  error?: string;
};

type AdBlockState = {
  site: string;
  enabled: boolean;
  blockerReady: boolean;
  unavailable?: boolean;
};

function getElectronApi(): ElectronApi | undefined {
  return (window as unknown as { electronAPI?: ElectronApi }).electronAPI;
}

/**
 * Checks if the app is running inside Electron.
 */
function isElectron(): boolean {
  return !!getElectronApi();
}

/**
 * Extracts the domain from a URL for display in the URL bar.
 */
function extractDomain(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

function normalizeUrlInput(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return '';
  if (/^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;
  if (/^[^\s]+\.[^\s]+/.test(trimmed)) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

function normalizeSite(value: string): string {
  try {
    const parsedUrl = /^[a-z][a-z\d+.-]*:/i.test(value)
      ? new URL(value)
      : new URL(`https://${value}`);
    return parsedUrl.hostname.toLowerCase().replace(/^www\./, '');
  } catch {
    return '';
  }
}

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export function WebView({ tabId, url, active = true, onNavigate, onTitleChange, isChatNote }: WebViewProps) {
  const placeholderRef = useRef<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [currentUrl, setCurrentUrl] = useState(url);
  const [urlDraft, setUrlDraft] = useState(url);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');
  const [adBlockState, setAdBlockState] = useState<AdBlockState | null>(null);

  const useWebview = isElectron();

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
  const activeRef = useRef(active);
  activeRef.current = active;
  const lastInternalNavigationUrlRef = useRef<string | null>(null);
  const didAutoEditBlankRef = useRef(false);

  useEffect(() => {
    if (!isEditingUrl) setUrlDraft(currentUrl);
  }, [currentUrl, isEditingUrl]);

  useEffect(() => {
    if (didAutoEditBlankRef.current || currentUrl !== 'about:blank') return;
    didAutoEditBlankRef.current = true;
    setIsEditingUrl(true);
  }, [currentUrl]);

  useEffect(() => {
    const electronApi = getElectronApi();
    const site = normalizeSite(currentUrl);

    if (!useWebview || currentUrl === 'about:blank' || !site) {
      setAdBlockState(null);
      return;
    }

    if (!electronApi?.getAdBlockState) {
      setAdBlockState({ site, enabled: false, blockerReady: false, unavailable: true });
      return;
    }

    let cancelled = false;
    void electronApi.getAdBlockState(currentUrl)
      .then((result) => {
        if (cancelled) return;
        if (result.success && result.site && typeof result.enabled === 'boolean') {
          setAdBlockState({
            site: result.site,
            enabled: result.enabled,
            blockerReady: Boolean(result.blockerReady),
          });
        } else {
          setAdBlockState({ site, enabled: false, blockerReady: false, unavailable: true });
        }
      })
      .catch((error) => {
        if (cancelled) return;
        console.error('[WebView] Failed to read adblock state:', error);
        setAdBlockState({ site, enabled: false, blockerReady: false, unavailable: true });
      });

    return () => {
      cancelled = true;
    };
  }, [useWebview, currentUrl]);

  // 1. Lifecycle and Visibility
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();
    if (!electronApi?.createView || !electronApi?.destroyView || !electronApi?.setViewVisible) return;

    void electronApi.createView(tabId, isChatNote).then((res) => {
      if (res && res.adopted) {
        return;
      }
      if (url && url !== 'about:blank') {
        void electronApi.loadURL?.(tabId, url);
      }
    });

    return () => {
      void electronApi.destroyView?.(tabId);
    };
  }, [useWebview, tabId]);

  // Propagate isChatNote changes to Electron
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();
    if (electronApi?.setChatNote) {
      void electronApi.setChatNote(tabId, !!isChatNote);
    }
  }, [useWebview, tabId, isChatNote]);

  // Sync active visibility state
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();
    void electronApi?.setViewVisible?.(tabId, active);
  }, [useWebview, tabId, active]);

  // 2. Bounds Synchronization
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();
    if (!electronApi?.setViewBounds) return;

    let lastBounds = { x: 0, y: 0, width: 0, height: 0 };

    const updateBounds = () => {
      const el = placeholderRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      const nextBounds = {
        x: rect.left,
        y: rect.top,
        width: rect.width,
        height: rect.height
      };

      if (
        nextBounds.x !== lastBounds.x ||
        nextBounds.y !== lastBounds.y ||
        nextBounds.width !== lastBounds.width ||
        nextBounds.height !== lastBounds.height
      ) {
        lastBounds = nextBounds;
        void electronApi.setViewBounds?.(tabId, nextBounds);
      }
    };

    updateBounds();

    window.addEventListener('resize', updateBounds);
    const observer = new ResizeObserver(() => updateBounds());
    const el = placeholderRef.current;
    if (el) observer.observe(el);

    let pollTimer: any;
    if (active) {
      pollTimer = setInterval(updateBounds, 100);
    }

    return () => {
      window.removeEventListener('resize', updateBounds);
      observer.disconnect();
      if (pollTimer) clearInterval(pollTimer);
    };
  }, [useWebview, tabId, active]);

  // 3. Prop URL Changes (excluding internal navigations)
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();

    if (lastInternalNavigationUrlRef.current === url) {
      lastInternalNavigationUrlRef.current = null;
      return;
    }

    if (currentUrl !== url) {
      setCurrentUrl(url);
      void electronApi?.loadURL?.(tabId, url);
    }
  }, [useWebview, tabId, url]);

  // 4. Browser Event Listener
  useEffect(() => {
    if (!useWebview) return;
    const electronApi = getElectronApi();
    if (!electronApi?.onBrowserEvent) return;

    const unsubscribe = electronApi.onBrowserEvent((payload) => {
      if (payload.tabId !== tabId) return;

      switch (payload.type) {
        case 'navigate':
          lastInternalNavigationUrlRef.current = payload.url;
          setCurrentUrl(payload.url);
          onNavigate?.(payload.url);
          setHasError(false);
          break;
        case 'title':
          onTitleChange?.(payload.title);
          break;
        case 'loading':
          setIsLoading(payload.isLoading);
          if (payload.isLoading) setHasError(false);
          break;
        case 'backforward':
          setCanGoBack(payload.canGoBack);
          setCanGoForward(payload.canGoForward);
          break;
        case 'fail':
          setHasError(true);
          setErrorMessage(payload.errorDescription);
          setIsLoading(false);
          break;
      }
    });

    return () => {
      unsubscribe();
    };
  }, [useWebview, tabId, onNavigate, onTitleChange]);

  // ─── Navigation Controls ────────────────────────────────
  const goBack = useCallback(() => {
    if (useWebview) {
      void getElectronApi()?.goBack?.(tabId);
    }
  }, [useWebview, tabId]);

  const goForward = useCallback(() => {
    if (useWebview) {
      void getElectronApi()?.goForward?.(tabId);
    }
  }, [useWebview, tabId]);

  const reload = useCallback(() => {
    setHasError(false);
    setIsLoading(true);
    if (useWebview) {
      void getElectronApi()?.reload?.(tabId);
    } else if (iframeRef.current) {
      iframeRef.current.src = currentUrl;
    }
  }, [useWebview, currentUrl, tabId]);

  const reloadIgnoringCache = useCallback(() => {
    setHasError(false);
    setIsLoading(true);
    reload();
  }, [reload]);

  const openExternal = useCallback(() => {
    const electronApi = getElectronApi();

    if (electronApi?.openExternal) {
      void electronApi.openExternal(currentUrl).then((result) => {
        if (!result.success) console.error('[WebView] Failed to open external URL:', result.error);
      });
      return;
    }

    window.open(currentUrl, '_blank', 'noopener,noreferrer');
  }, [currentUrl]);

  const toggleAdBlockForSite = useCallback(() => {
    const electronApi = getElectronApi();
    if (!electronApi?.setAdBlockSiteEnabled || !adBlockState || adBlockState.unavailable) return;

    const nextEnabled = !adBlockState.enabled;
    void electronApi.setAdBlockSiteEnabled({ url: currentUrl, enabled: nextEnabled })
      .then((result) => {
        if (!result.success || !result.site || typeof result.enabled !== 'boolean') {
          console.error('[WebView] Failed to update adblock state:', result.error);
          return;
        }

        setAdBlockState({
          site: result.site,
          enabled: result.enabled,
          blockerReady: Boolean(result.blockerReady),
        });
        reloadIgnoringCache();
      })
      .catch((error) => {
        console.error('[WebView] Failed to update adblock state:', error);
      });
  }, [adBlockState, currentUrl, reloadIgnoringCache]);

  const beginUrlEdit = useCallback(() => {
    setUrlDraft(currentUrl);
    setIsEditingUrl(true);
  }, [currentUrl]);

  const cancelUrlEdit = useCallback(() => {
    setUrlDraft(currentUrl);
    setIsEditingUrl(false);
  }, [currentUrl]);

  const submitUrlEdit = useCallback((event?: FormEvent<HTMLFormElement>) => {
    event?.preventDefault();
    const nextUrl = normalizeUrlInput(urlDraft);
    if (!nextUrl) {
      cancelUrlEdit();
      return;
    }

    setIsEditingUrl(false);
    setCurrentUrl(nextUrl);
    onNavigate?.(nextUrl);
    if (useWebview) {
      void getElectronApi()?.loadURL?.(tabId, nextUrl);
    }
  }, [urlDraft, cancelUrlEdit, onNavigate, useWebview, tabId]);

  // ─── Iframe fallback: handle load/error ─────────────────
  const handleIframeLoad = useCallback(() => {
    setIsLoading(false);
    setHasError(false);
  }, []);

  const handleIframeError = useCallback(() => {
    setIsLoading(false);
    setHasError(true);
    setErrorMessage('This site may not allow embedding in iframes. Try opening externally.');
  }, []);

  return (
    <div className="webview-container" id="webview-container">
      {/* Navigation Toolbar */}
      <div className="webview-toolbar" id="webview-toolbar">
        <button
          className="btn-icon webview-nav-btn"
          onClick={goBack}
          disabled={!canGoBack}
          title="Go back"
        >
          <ArrowLeft size={14} />
        </button>
        <button
          className="btn-icon webview-nav-btn"
          onClick={goForward}
          disabled={!canGoForward}
          title="Go forward"
        >
          <ArrowRight size={14} />
        </button>
        <button
          className="btn-icon webview-nav-btn"
          onClick={reload}
          title="Reload"
        >
          <RotateCw size={14} className={isLoading ? 'webview-spinning' : ''} />
        </button>

        <form className="webview-url-bar" title={currentUrl} onSubmit={submitUrlEdit}>
          <Globe size={12} className="webview-url-icon" />
          <input
            className="webview-url-input"
            value={isEditingUrl ? urlDraft : currentUrl}
            onChange={(event) => setUrlDraft(event.target.value)}
            onFocus={(event) => {
              beginUrlEdit();
              setTimeout(() => event.currentTarget.select(), 0);
            }}
            onBlur={() => setIsEditingUrl(false)}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault();
                cancelUrlEdit();
                event.currentTarget.blur();
              }
            }}
            autoFocus={currentUrl === 'about:blank'}
          />
        </form>

        {useWebview && adBlockState && (
          <button
            className={`btn-icon webview-nav-btn webview-adblock-btn${adBlockState.enabled ? ' is-active' : ''}`}
            onClick={toggleAdBlockForSite}
            disabled={adBlockState.unavailable}
            title={adBlockState.unavailable
              ? 'Ad blocking controls require restarting Cascade'
              : `${adBlockState.enabled ? 'Disable' : 'Enable'} ad blocking for ${adBlockState.site}`}
            aria-pressed={adBlockState.enabled}
          >
            {adBlockState.enabled ? <Shield size={14} /> : <ShieldOff size={14} />}
          </button>
        )}

        <button
          className="btn-icon webview-nav-btn"
          onClick={openExternal}
          title="Open in browser"
        >
          <ExternalLink size={14} />
        </button>
      </div>

      {/* Loading Bar */}
      {isLoading && <div className="webview-loading-bar" />}

      {/* Error State */}
      {hasError && (
        <div className="webview-error">
          <AlertTriangle size={32} />
          <span className="webview-error-title">Failed to load page</span>
          <span className="webview-error-message">{errorMessage}</span>
          <div className="webview-error-actions">
            <button className="btn btn-primary" onClick={reload}>
              Retry
            </button>
            <button className="btn" onClick={openExternal}>
              <ExternalLink size={14} /> Open externally
            </button>
          </div>
        </div>
      )}

      {/* Web Content */}
      {!hasError && (
        useWebview ? (
          /* WebContentsView placeholder wrapper */
          <div
            ref={placeholderRef}
            className="webview-frame"
            style={{ width: '100%', height: '100%', display: 'flex' }}
          />
        ) : (
          /* Iframe fallback for browser-based development */
          <iframe
            ref={iframeRef}
            src={url}
            className="webview-frame"
            title={`Web view: ${extractDomain(url)}`}
            sandbox="allow-scripts allow-same-origin allow-forms allow-popups"
            onLoad={handleIframeLoad}
            onError={handleIframeError}
          />
        )
      )}
    </div>
  );
}
