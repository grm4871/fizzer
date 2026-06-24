/**
 * Standalone Version Check Script
 * 
 * This file is served by nginx with Cache-Control: no-cache headers,
 * ensuring it's always fetched fresh even when the rest of the app is cached.
 * 
 * It runs BEFORE the main app loads and forces a cache-busting reload
 * if the version.json doesn't match the client version.
 */

(function() {
  if (
    window.__CASCADE_DISABLE_AUTO_REFRESH__ === true ||
    localStorage.getItem('cascade_disable_auto_refresh') === 'true' ||
    new URLSearchParams(window.location.search).get('noAutoRefresh') === '1'
  ) {
    console.log('[VersionCheck] Auto-refresh disabled.');
    return;
  }

  // Get the last known version from localStorage
  var lastVersion = localStorage.getItem('app_version');
  
  // Check version immediately
  fetch('/version.json?t=' + Date.now())
    .then(function(res) {
      if (!res.ok) return;
      return res.json();
    })
    .then(function(data) {
      if (!data || !data.version) return;
      
      var serverVersion = data.version;
      var clientVersion = window.__APP_VERSION__ || lastVersion;
      
      console.log('[VersionCheck] Client:', clientVersion, 'Server:', serverVersion);
      
      // If no client version, this might be first load - save server version
      if (!clientVersion) {
        localStorage.setItem('app_version', serverVersion);
        return;
      }
      
      if (serverVersion !== clientVersion) {
        console.log('[VersionCheck] Version mismatch! Forcing reload...');
        
        // Update to new version in localStorage
        localStorage.setItem('app_version', serverVersion);
        
        // Force cache-busting reload
        var currentUrl = window.location.href.split('?')[0];
        window.location.href = currentUrl + '?v=' + Date.now();
      }
    })
    .catch(function(err) {
      console.error('[VersionCheck] Failed to check version:', err);
    });
})();
