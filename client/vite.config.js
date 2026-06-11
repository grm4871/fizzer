// client/vite.config.js
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Regex to detect bots and CLI tools for graceful degradation
const BOT_CLI_REGEX = /curl|wget|lynx|links|httpie|googlebot|bingbot|baiduspider|duckduckbot|twitterbot|facebookexternalhit|discordbot|slackbot|telegrambot|whatsapp/i;

// Plugin to proxy bot/CLI requests before Vite's SPA fallback kicks in
function botProxyPlugin() {
  return {
    name: 'bot-proxy',
    configureServer(server) {
      // Add middleware BEFORE Vite's internal middleware
      server.middlewares.use(async (req, res, next) => {
        const userAgent = req.headers['user-agent'] || '';
        const isBotOrCLI = BOT_CLI_REGEX.test(userAgent);
        const isNetdocPath = /^\/netdoc\/\d+/.test(req.url);

        if (isBotOrCLI && isNetdocPath) {
          // Proxy to backend
          const http = await import('http');
          const proxyReq = http.request({
            hostname: 'localhost',
            port: 3000,
            path: req.url,
            method: req.method,
            headers: {
              ...req.headers,
              host: 'localhost:3000'
            }
          }, (proxyRes) => {
            res.writeHead(proxyRes.statusCode, proxyRes.headers);
            proxyRes.pipe(res);
          });

          proxyReq.on('error', (err) => {
            console.error('[bot-proxy] Error:', err.message);
            res.statusCode = 502;
            res.end('Backend unavailable');
          });

          req.pipe(proxyReq);
          return;
        }
        next();
      });
    }
  };
}

const fs = await import('fs');
const path = await import('path');

// Generate a build version based on timestamp
const buildVersion = new Date().getTime().toString();

// Plugin to generate version.json at build time
function versionGenerationPlugin() {
  return {
    name: 'version-generation',
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
      console.log(`[version-generation] Wrote version.json with version: ${buildVersion}`);
    }
  };
}

// Plugin to serve app.html as index.html during dev
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

export default defineConfig({
  define: {
    '__APP_VERSION__': JSON.stringify(buildVersion)
  },
  build: {
    rollupOptions: {
      input: {
        main: path.resolve(__dirname, 'app.html')
      }
    }
  },
  plugins: [botProxyPlugin(), versionGenerationPlugin(), htmlFallbackPlugin(), react()],
  server: {
    port: parseInt(process.env.VITE_PORT) || 5173,
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
    // Allow nip.io and netar.is subdomains for staging access
    allowedHosts: ['.nip.io', '.netar.is', 'localhost']
  },
});