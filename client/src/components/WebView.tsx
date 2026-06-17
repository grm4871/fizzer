/**
 * @file WebView.tsx — Embedded web browser component
 *
 * Renders a website inside the app using Electron's <webview> tag when running
 * in Electron, or an <iframe> fallback when running in a regular browser (dev mode).
 *
 * Features:
 * - Navigation toolbar (back, forward, reload, URL bar, open-externally)
 * - Loading progress indicator
 * - Error state with retry button
 * - Title change tracking (reported to parent for tab title updates)
 *
 * Electron's <webview> is preferred over <iframe> because it works with any URL
 * (no X-Frame-Options / CSP restrictions), runs in a separate process (security),
 * and provides navigation APIs (canGoBack, goBack, etc.).
 *
 * @component
 */

import { useEffect, useRef, useState, useCallback, type FormEvent } from 'react';
import { ArrowLeft, ArrowRight, RotateCw, ExternalLink, Globe, AlertTriangle } from 'lucide-react';

// ═══════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════

interface WebViewProps {
  /** The URL to load in the web view */
  url: string;
  /** Called when the page navigates to a new URL */
  onNavigate?: (url: string) => void;
  /** Called when the page title changes (used to update tab title) */
  onTitleChange?: (title: string) => void;
}

/**
 * Checks if the app is running inside Electron (webview tag available).
 * We detect this by checking for the electronAPI exposed via preload.
 */
function isElectron(): boolean {
  return !!(window as unknown as { electronAPI?: unknown }).electronAPI;
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

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export function WebView({ url, onNavigate, onTitleChange }: WebViewProps) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [currentUrl, setCurrentUrl] = useState(url);
  const [urlDraft, setUrlDraft] = useState(url);
  const [isEditingUrl, setIsEditingUrl] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const useWebview = isElectron();

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;
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

  const safeGetWebviewUrl = useCallback((wv: HTMLElement & { getURL?: () => string }) => {
    try {
      return typeof wv.getURL === 'function' ? wv.getURL() : '';
    } catch {
      return '';
    }
  }, []);

  const logWebview = useCallback((eventName: string, detail: Record<string, unknown> = {}) => {
    console.log('[WebView]', eventName, {
      propUrl: url,
      currentUrl: currentUrlRef.current,
      ...detail,
    });
  }, [url]);

  // Load the URL by imperatively setting the `src` attribute. Keeping `src` in
  // JSX lets React mutate the custom element after internal webview navigations,
  // which reloads login flows such as x.com's username/password steps.
  useEffect(() => {
    if (!useWebview || !webviewRef.current) return;
    const wv = webviewRef.current as HTMLElement & { getURL?: () => string };
    const loadedUrl = safeGetWebviewUrl(wv);
    const attrUrl = wv.getAttribute('src') || '';

    // The `src` attribute does not track same-tab navigations. Comparing
    // against it after `did-navigate` causes SPA/login redirects to be loaded
    // again from scratch, which breaks flows such as x.com's username submit.
    if (lastInternalNavigationUrlRef.current === url) {
      logWebview('skip-prop-load-internal-navigation', { loadedUrl, attrUrl });
      lastInternalNavigationUrlRef.current = null;
      return;
    }

    if (loadedUrl === url || attrUrl === url) {
      logWebview('skip-prop-load-same-url', { loadedUrl, attrUrl });
      return;
    }

    logWebview('set-src-from-prop', { loadedUrl, attrUrl, nextUrl: url });
    setCurrentUrl(url);
    wv.setAttribute('src', url);
  }, [useWebview, url, safeGetWebviewUrl, logWebview]);

  // ─── Navigation Controls ────────────────────────────────
  const goBack = useCallback(() => {
    const wv = webviewRef.current as any;
    if (useWebview && wv && typeof wv.goBack === 'function') {
      wv.goBack();
    }
  }, [useWebview]);

  const goForward = useCallback(() => {
    const wv = webviewRef.current as any;
    if (useWebview && wv && typeof wv.goForward === 'function') {
      wv.goForward();
    }
  }, [useWebview]);

  const reload = useCallback(() => {
    setHasError(false);
    setIsLoading(true);
    const wv = webviewRef.current as any;
    if (useWebview && wv && typeof wv.reload === 'function') {
      wv.reload();
    } else if (iframeRef.current) {
      iframeRef.current.src = currentUrl;
    }
  }, [useWebview, currentUrl]);

  const openExternal = useCallback(() => {
    window.open(currentUrl, '_blank');
  }, [currentUrl]);

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
  }, [urlDraft, cancelUrlEdit, onNavigate]);

  // ─── Webview Event Listeners ────────────────────────────
  useEffect(() => {
    if (!useWebview || !webviewRef.current) return;
    const wv = webviewRef.current as any;

    const handleStartLoading = () => {
      logWebview('did-start-loading', { loadedUrl: safeGetWebviewUrl(wv) });
      setIsLoading(true);
      setHasError(false);
    };

    const handleStopLoading = () => {
      logWebview('did-stop-loading', { loadedUrl: safeGetWebviewUrl(wv) });
      setIsLoading(false);
    };

    const handleNavigate = (event: any) => {
      const newUrl = event.url || safeGetWebviewUrl(wv) || currentUrlRef.current;
      lastInternalNavigationUrlRef.current = newUrl;
      logWebview(event.type || 'navigate', {
        eventUrl: event.url,
        loadedUrl: safeGetWebviewUrl(wv),
        isMainFrame: event.isMainFrame,
      });
      setCurrentUrl(newUrl);
      setCanGoBack(typeof wv.canGoBack === 'function' ? wv.canGoBack() : false);
      setCanGoForward(typeof wv.canGoForward === 'function' ? wv.canGoForward() : false);
      onNavigate?.(newUrl);
    };

    const handleNavigationDetail = (event: any) => {
      logWebview(event.type || 'navigation-detail', {
        eventUrl: event.url,
        loadedUrl: safeGetWebviewUrl(wv),
        isMainFrame: event.isMainFrame,
        isInPlace: event.isInPlace,
        isSameDocument: event.isSameDocument,
        httpResponseCode: event.httpResponseCode,
      });
    };

    const handleTitleUpdate = (event: any) => {
      logWebview('page-title-updated', { title: event.title, loadedUrl: safeGetWebviewUrl(wv) });
      if (event.title) {
        onTitleChange?.(event.title);
      }
    };

    const handleFailLoad = (event: any) => {
      if (event.errorCode === -3) return; // ERR_ABORTED
      if (event.isMainFrame === false) return; // ignore subframe/subresource failures
      logWebview('did-fail-load', {
        eventUrl: event.validatedURL || event.url,
        loadedUrl: safeGetWebviewUrl(wv),
        errorCode: event.errorCode,
        errorDescription: event.errorDescription,
        isMainFrame: event.isMainFrame,
      });
      setHasError(true);
      setIsLoading(false);
      setErrorMessage(`${event.errorDescription || 'Failed to load page'} (Error: ${event.errorCode})`);
      console.error('[WebView Load Failure]', event);
    };

    const handleConsoleMessage = (event: any) => {
      console.log('[WebView Console]', {
        level: event.level,
        line: event.line,
        sourceId: event.sourceId,
        message: event.message,
        loadedUrl: safeGetWebviewUrl(wv),
      });
    };

    // Diagnostics — visible in the main window's DevTools (Debug → Toggle DevTools).
    const handleDomReady = () => logWebview('dom-ready', { loadedUrl: safeGetWebviewUrl(wv) });
    const handleFinishLoad = () => logWebview('did-finish-load', { loadedUrl: safeGetWebviewUrl(wv) });

    wv.addEventListener('did-start-loading', handleStartLoading);
    wv.addEventListener('did-stop-loading', handleStopLoading);
    wv.addEventListener('did-start-navigation', handleNavigationDetail);
    wv.addEventListener('did-redirect-navigation', handleNavigationDetail);
    wv.addEventListener('did-navigate', handleNavigate);
    wv.addEventListener('did-navigate-in-page', handleNavigate);
    wv.addEventListener('page-title-updated', handleTitleUpdate);
    wv.addEventListener('did-fail-load', handleFailLoad);
    wv.addEventListener('console-message', handleConsoleMessage);
    wv.addEventListener('dom-ready', handleDomReady);
    wv.addEventListener('did-finish-load', handleFinishLoad);

    return () => {
      wv.removeEventListener('did-start-loading', handleStartLoading);
      wv.removeEventListener('did-stop-loading', handleStopLoading);
      wv.removeEventListener('did-start-navigation', handleNavigationDetail);
      wv.removeEventListener('did-redirect-navigation', handleNavigationDetail);
      wv.removeEventListener('did-navigate', handleNavigate);
      wv.removeEventListener('did-navigate-in-page', handleNavigate);
      wv.removeEventListener('page-title-updated', handleTitleUpdate);
      wv.removeEventListener('did-fail-load', handleFailLoad);
      wv.removeEventListener('console-message', handleConsoleMessage);
      wv.removeEventListener('dom-ready', handleDomReady);
      wv.removeEventListener('did-finish-load', handleFinishLoad);
    };
  }, [useWebview, onNavigate, onTitleChange]);

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

  // ─── Render ─────────────────────────────────────────────

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
          /* Electron webview — src present at attach (most reliable first load),
             with the effect above as a safety net for URL changes. */
          <webview
            ref={webviewRef as any}
            className="webview-frame"
            allowpopups="true"
            {...{
              partition: 'persist:webview',
            } as any}
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
