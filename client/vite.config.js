// client/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const fs = await import('fs');
const path = await import('path');

// Generate a build version based on timestamp
const buildVersion = new Date().getTime().toString();

// Plugin to generate version.json at build time
function versionGenerationPlugin() {
  return {
    name: 'version-generation',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.method === 'GET' && req.url?.startsWith('/version.json')) {
          res.setHeader('Content-Type', 'application/json');
          res.setHeader('Cache-Control', 'no-cache');
          res.end(JSON.stringify({ version: buildVersion }));
          return;
        }
        next();
      });
    },
    writeBundle() {
      const versionFile = { version: buildVersion };
      const distPath = path.resolve(__dirname, 'dist');
      // Ensure dist exists (writeBundle usually runs after dist creation)
      if (!fs.existsSync(distPath)) {
          fs.mkdirSync(distPath, { recursive: true });
      }
      fs.writeFileSync(
        path.join(distPath, 'version.json'),
        JSON.stringify(versionFile)
      );
      // Capacitor requires index.html as the web entry point.
      const appHtmlPath = path.join(distPath, 'app.html');
      const indexHtmlPath = path.join(distPath, 'index.html');
      if (fs.existsSync(appHtmlPath)) {
        fs.copyFileSync(appHtmlPath, indexHtmlPath);
      }
      console.log(`[version-generation] Wrote version.json with version: ${buildVersion}`);
    }
  };
}

// Plugin to serve app.html as index.html during dev
function htmlFallbackPlugin() {
  return {
    name: 'html-fallback',
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        // Rewrite to app.html if it's a navigation request and not an API call or static asset
        if (
          req.method === 'GET' &&
          req.headers.accept?.includes('text/html') &&
          !req.url.startsWith('/api') &&
          !req.url.startsWith('/socket.io') &&
          (!req.url.includes('.') || req.url === '/index.html') 
        ) {
          req.url = '/app.html';
        }
        next();
      });
    }
  };
}

const isCapacitorBuild = process.env.CAPACITOR === 'true';
const requestedBase = process.env.CASCADE_CLIENT_BASE || '/';
if (!requestedBase.startsWith('/') || !requestedBase.endsWith('/') || requestedBase.includes('://')) {
  throw new Error('CASCADE_CLIENT_BASE must be an absolute path ending in /');
}
const disableAutoRefresh =
  process.env.CASCADE_DISABLE_AUTO_REFRESH === 'true' ||
  process.env.VITE_DISABLE_AUTO_REFRESH === 'true';

function autoRefreshFlagPlugin() {
  return {
    name: 'auto-refresh-flag',
    transformIndexHtml(html) {
      const transformed = html.replace(
        'window.__CASCADE_DISABLE_AUTO_REFRESH__ = false;',
        `window.__CASCADE_DISABLE_AUTO_REFRESH__ = ${disableAutoRefresh ? 'true' : 'false'};`
      );
      if (requestedBase === '/') return transformed;
      return transformed.replace(
        '<body>',
        '<body><div class="beta-frontend-banner" role="status">Beta frontend · live data</div>'
      );
    }
  };
}

export default defineConfig({
  base: isCapacitorBuild ? './' : requestedBase,
  define: {
    '__APP_VERSION__': JSON.stringify(buildVersion)
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'app.html')
      },
      output: {
        // Split the large third-party libs out of the entry chunk. CodeMirror
        // and xterm already sit behind React.lazy boundaries (note editor / raw
        // terminal); naming them here keeps them in their own cacheable files
        // rather than being merged into whichever route pulls them in first.
        // NOTE: deliberately no rule for @codemirror/@lezer. `language-data`
        // dynamic-imports each language mode on demand; grouping them under a
        // manual chunk collapses those imports into one ~1.6 MB eager file and
        // makes opening a note *worse*. Leave rollup's own splitting alone.
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (id.includes('@xterm')) return 'terminal';
          if (id.includes('react-markdown') || id.includes('remark') || id.includes('unist')) return 'markdown';
          if (id.includes('react-router')) return 'react-vendor';
        }
      }
    }
  },
  plugins: [autoRefreshFlagPlugin(), versionGenerationPlugin(), htmlFallbackPlugin(), react()],
  server: {
    port: parseInt(process.env.VITE_PORT) || 5173,
    // Fail loudly on a port clash. Without this Vite silently falls back to the
    // next free port while Electron still loads the configured one, so the
    // desktop window quietly renders whatever else is squatting on it.
    strictPort: true,
    hmr: disableAutoRefresh ? false : undefined,
    proxy: {
      '/api': {
        target: `http://localhost:${process.env.API_PORT || 3000}`,
        changeOrigin: true,
        secure: false,
      },
      '/socket.io': {
        target: `http://localhost:${process.env.API_PORT || 3000}`,
        changeOrigin: true,
        secure: false,
        ws: true,  // Enable WebSocket proxying
      },
    },
    // Allow nip.io and cscd.online subdomains for staging access
    allowedHosts: ['.nip.io', '.cscd.online', 'localhost']
  },
});
