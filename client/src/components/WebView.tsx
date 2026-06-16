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

import { useEffect, useRef, useState, useCallback } from 'react';
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

// ═══════════════════════════════════════════════════════════════
// COMPONENT
// ═══════════════════════════════════════════════════════════════

export function WebView({ url, onNavigate, onTitleChange }: WebViewProps) {
  const webviewRef = useRef<HTMLElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);

  const [currentUrl, setCurrentUrl] = useState(url);
  const [isLoading, setIsLoading] = useState(true);
  const [canGoBack, setCanGoBack] = useState(false);
  const [canGoForward, setCanGoForward] = useState(false);
  const [hasError, setHasError] = useState(false);
  const [errorMessage, setErrorMessage] = useState('');

  const useWebview = isElectron();

  const currentUrlRef = useRef(currentUrl);
  currentUrlRef.current = currentUrl;

  // Load the URL by imperatively setting the `src` attribute. React's handling
  // of `src` on the <webview> custom element is unreliable (it can render blank
  // because the attribute never reaches the element), and loadURL() throws
  // before the webview's `dom-ready` event. Setting the attribute works in all
  // cases and re-navigates whenever the URL changes.
  useEffect(() => {
    if (!useWebview || !webviewRef.current) return;
    const wv = webviewRef.current as HTMLElement;
    if (wv.getAttribute('src') !== url) wv.setAttribute('src', url);
  }, [useWebview, url]);

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

  // ─── Webview Event Listeners ────────────────────────────
  useEffect(() => {
    if (!useWebview || !webviewRef.current) return;
    const wv = webviewRef.current as any;

    const handleStartLoading = () => {
      setIsLoading(true);
      setHasError(false);
    };

    const handleStopLoading = () => {
      setIsLoading(false);
    };

    const handleNavigate = (event: any) => {
      const newUrl = event.url || (typeof wv.getURL === 'function' ? wv.getURL() : currentUrlRef.current);
      setCurrentUrl(newUrl);
      setCanGoBack(typeof wv.canGoBack === 'function' ? wv.canGoBack() : false);
      setCanGoForward(typeof wv.canGoForward === 'function' ? wv.canGoForward() : false);
      onNavigate?.(newUrl);
    };

    const handleTitleUpdate = (event: any) => {
      if (event.title) {
        onTitleChange?.(event.title);
      }
    };

    const handleFailLoad = (event: any) => {
      if (event.errorCode === -3) return; // ERR_ABORTED
      if (event.isMainFrame === false) return; // ignore subframe/subresource failures
      setHasError(true);
      setIsLoading(false);
      setErrorMessage(`${event.errorDescription || 'Failed to load page'} (Error: ${event.errorCode})`);
      console.error('[WebView Load Failure]', event);
    };

    const handleConsoleMessage = (event: any) => {
      console.log(`[WebView Console] Line ${event.line} (${event.sourceId}): ${event.message}`);
    };

    // Diagnostics — visible in the main window's DevTools (Debug → Toggle DevTools).
    const getUrl = () => (typeof wv.getURL === 'function' ? wv.getURL() : '');
    const handleDomReady = () => console.log('[WebView] dom-ready', getUrl());
    const handleFinishLoad = () => console.log('[WebView] did-finish-load', getUrl());

    wv.addEventListener('did-start-loading', handleStartLoading);
    wv.addEventListener('did-stop-loading', handleStopLoading);
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

        <div className="webview-url-bar" title={currentUrl}>
          <Globe size={12} className="webview-url-icon" />
          <span className="webview-url-text">{extractDomain(currentUrl)}</span>
        </div>

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
            src={url}
            className="webview-frame"
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
