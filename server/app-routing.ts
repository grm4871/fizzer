import express, { Request, Response } from 'express';
import http from 'http';
import cors from 'cors';
import { Server as SocketIOServer } from 'socket.io';
import { setIO } from './socket.js';

import { initYjsHandler } from './yjs-handler.js';
import authRouter from './routes/auth.js';
import profileRouter from './routes/profile.js';
import sidebarRouter from './routes/sidebar.js';
import netdocsRouter from './routes/netdoc.js';
import subscriptionsRouter from './routes/subscriptions.js';
import uploadRouter from './routes/upload.js';
import fallbackRouter from './routes/fallback.js';
import recommendationsRouter from './routes/recommendations.js';
import oembedRouter from './routes/oembed.js';
import spacesRouter from './routes/spaces.js';

/**
 * Main Express application and HTTP server configuration.
 * Exports `app`, `io` and `server` for use by the CLI/dev tooling and tests.
 */
const app = express();

// Trust the reverse proxy (Nginx) to provide the correct client IP
app.set('trust proxy', 1);


// CORS configuration for API routes
const allowedOrigins = [
  'http://localhost:5173',
  'http://localhost:5174',
  'http://localhost:3000',
  'http://localhost:3001',
  'https://api.netar.is',
  'https://netar.is'
];

// Allow nip.io domains for staging environments
const isAllowedOrigin = (origin: string | undefined): boolean => {
  if (!origin) return true; // Allow requests with no origin (mobile apps, curl)
  if (allowedOrigins.includes(origin)) return true;
  // Allow any *.nip.io or *.netar.is subdomain for staging (subdomain optional)
  if (/^https?:\/\/([^/]+\.)?(nip\.io|netar\.is)(:\d+)?$/.test(origin)) return true;
  return false;
};

app.use(cors({
  origin: (origin, callback) => {
    if (isAllowedOrigin(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

/**
 * Middleware to handle BigInt serialization in JSON responses
 * This wraps the json() method of the Response object to serialize BigInt values
 */
app.use((req: Request, res: Response, next) => {
  if (req.path.includes('/netdoc/')) {
    console.log(`[REQUEST] ${req.method} ${req.path} (originalUrl: ${req.originalUrl})`);
  }
  next();
});

const server = http.createServer(app);

/**
 * Socket.IO instance attached to the HTTP server. This provides
 * real-time pub/sub abilities used by the client for live updates.
 */
const io = new SocketIOServer(server, {
  cors: { 
    origin: ['http://localhost:5173', 'http://localhost:3000', 'https://api.netar.is', 'https://netar.is'],
    credentials: true
  }
});

// Make io available to other modules
setIO(io);

// Initialize Yjs collaboration handler
initYjsHandler(io);

/**
 * Socket connection handling
 */
io.on('connection', (socket) => {
  const userId = socket.handshake.auth.userId;
  
  if (userId) {
    // Join user to their personal room for targeted messages
    socket.join(`user:${userId}`);
    console.log(`[Socket] User ${userId} connected with socket ${socket.id}`);
  }
  
  socket.on('subscribe', async (netdocId: string) => {
    try {
      socket.join(`netdoc:${netdocId}`);
    } catch (err) {
      console.error('Error subscribing to netdoc:', err);
    }
  });

  /**
   * Unsubscribe from a netdoc
   */
  socket.on('unsubscribe', (netdocId: string) => {
    try {
      socket.leave(`netdoc:${netdocId}`);
    } catch (err) {
      console.error('Error unsubscribing from netdoc:', err);
    }
  });
  
  socket.on('disconnect', () => {
    // Disconnection handled silently
  });
});


// Health check endpoint for offline detection
app.get('/api/health', (_req: Request, res: Response) => {
  res.status(200).json({ status: 'ok' });
});

app.use('/api/auth', authRouter);
app.use('/api/profile', profileRouter);
app.use('/api/sidebar', sidebarRouter);
app.use('/api/netdoc', netdocsRouter);
app.use('/api/subscriptions', subscriptionsRouter);
app.use('/api/upload', uploadRouter);
app.use('/api/recommendations', recommendationsRouter);
app.use('/api/oembed', oembedRouter);
app.use('/api/spaces', spacesRouter);

// Fallback route for SSR/graceful degradation (scrapers, curl, bots)
// This serves netdoc content to non-browser clients
app.use('/', fallbackRouter);

// Debug endpoint to verify CORS config
app.get('/api/debug/cors', (req: Request, res: Response) => {
  res.json({
    message: 'CORS is working',
    allowedMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    origin: req.headers.origin,
    timestamp: new Date().toISOString()
  });
});

export { app, io, server };
