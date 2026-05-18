import 'dotenv/config';
/**
 * Annotation Tracker Pro — Main Server
 * 
 * Production-grade Express server with:
 * - RESTful API
 * - Socket.IO real-time updates
 * - Session-based auth (PostgreSQL-backed)
 * - Security headers (Helmet)
 * - Rate limiting
 * - Compression
 */

import express from 'express';
import { createServer } from 'http';
import { Server as SocketServer } from 'socket.io';
import session from 'express-session';
import helmet from 'helmet';
import compression from 'compression';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

import { initDb } from './db/database.js';
import { PgStore } from './db/pgStore.js';
import { hashPassword } from './middleware/auth.js';
import { 
  createUser, 
  getUserByEmail, 
  cleanOldData,
  cleanExpiredShareLinks
} from './db/database.js';
import apiRoutes from './routes/api.js';
import sheetsRoutes from './routes/sheets.js';
import { initSheetsSync } from './services/sheetsSync.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 3000;

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

// ─── Express Setup ─────────────────────────────────────────────────────────────

const app = express();

// Trust Render's reverse proxy (required for secure cookies, correct req.protocol, etc.)
if (process.env.NODE_ENV === 'production') {
  app.set('trust proxy', 1);
}

const server = createServer(app);

// Socket.IO
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(origin => origin.trim()).filter(Boolean)
  : ['http://localhost:3000'];

// Auto-include Render's external URL in allowed origins if available
if (process.env.RENDER_EXTERNAL_URL && !allowedOrigins.includes(process.env.RENDER_EXTERNAL_URL)) {
  allowedOrigins.push(process.env.RENDER_EXTERNAL_URL);
}

const io = new SocketServer(server, {
  cors: { 
    origin: allowedOrigins,
    methods: ['GET', 'POST'],
    credentials: true
  },
  pingTimeout: 60000,
  pingInterval: 25000
});

// Make io accessible in routes
app.io = io;

// ─── Middleware ─────────────────────────────────────────────────────────────────

// Build CSP connectSrc: include self + all allowed origins + websocket variants
const cspConnectSrc = ["'self'", ...allowedOrigins];
// Add wss:// variants for WebSocket connections
for (const origin of allowedOrigins) {
  try {
    const url = new URL(origin);
    if (url.protocol === 'https:') {
      cspConnectSrc.push(`wss://${url.host}`);
    } else {
      cspConnectSrc.push(`ws://${url.host}`);
    }
  } catch { /* skip invalid origins */ }
}

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com", "data:"],
      connectSrc: cspConnectSrc,
      imgSrc: ["'self'", "data:"]
    }
  }
}));


app.use(compression());
app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (mobile apps, curl, same-origin)
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      // In production on Render, the origin will match RENDER_EXTERNAL_URL
      // For safety, allow same-host requests
      callback(null, true);
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE'],
  allowedHeaders: ['Content-Type']
}));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Session
if (!process.env.SESSION_SECRET) {
  console.warn('[SECURITY] WARNING: SESSION_SECRET not set. Using insecure default. Set environment variable SESSION_SECRET.');
}
const isProduction = process.env.NODE_ENV === 'production';
const sessionMiddleware = session({
  secret: process.env.SESSION_SECRET || 'CHANGE_ME_IN_PRODUCTION',
  store: new PgStore(),
  resave: false,
  saveUninitialized: false,
  proxy: isProduction, // Trust Render's reverse proxy for secure cookies
  cookie: {
    maxAge: 24 * 60 * 60 * 1000, // 24 hours
    httpOnly: true,
    secure: isProduction,         // HTTPS only in production
    sameSite: 'lax'               // 'lax' allows cookie on same-site navigations (login redirects)
  }
});

app.use(sessionMiddleware);

// Share session with Socket.IO
io.engine.use(sessionMiddleware);

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 120,
  message: { error: 'Too many requests, please try again later' }
});
app.use('/api/', apiLimiter);

// ─── Static Files ──────────────────────────────────────────────────────────────

app.use(express.static(path.join(__dirname, 'public')));

// ─── Routes ────────────────────────────────────────────────────────────────────

app.use(apiRoutes);
app.use(sheetsRoutes);

// Short URL redirect: supports /s/:name/:slug (new personalized format) and /s/:slug (legacy)
app.get('/s/:nameOrSlug/:slug?', async (req, res) => {
  try {
    const { resolveShortLink } = await import('./services/urlShortener.js');
    // If slug param exists, use it (new format: /s/naumit/a7k3m9)
    // Otherwise nameOrSlug IS the slug (legacy format: /s/a7k3m9)
    const slug = req.params.slug || req.params.nameOrSlug;
    
    if (!slug || slug.length > 20 || !/^[a-zA-Z0-9]+$/.test(slug)) {
      return res.status(400).send('Invalid short link');
    }
    
    const resolved = await resolveShortLink(slug);
    if (!resolved) {
      return res.status(404).send('Short link not found or expired');
    }
    
    // Redirect to the full shared link
    res.redirect(`/shared/${resolved.token}`);
  } catch (err) {
    console.error('[Server] Short link resolution error:', err);
    res.status(500).send('Failed to resolve short link');
  }
});

// SPA-style fallback for page routes
const pages = ['app', 'dashboard', 'history', 'admin'];
for (const page of pages) {
  app.get(`/${page}`, (req, res) => {
    res.sendFile(path.join(__dirname, 'public', `${page}.html`));
  });
}

// Public shared dashboard route (no auth required)
app.get('/shared/:token', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'shared.html'));
});

// ─── Socket.IO ─────────────────────────────────────────────────────────────────

// Simple WebSocket rate limiter
const wsRateLimiters = new Map();
function wsRateLimit(socket, limit = 30, windowMs = 60000) {
  if (!wsRateLimiters.has(socket.id)) {
    wsRateLimiters.set(socket.id, { count: 0, resetTime: Date.now() + windowMs });
  }
  
  const limiter = wsRateLimiters.get(socket.id);
  if (Date.now() > limiter.resetTime) {
    limiter.count = 0;
    limiter.resetTime = Date.now() + windowMs;
  }
  
  limiter.count++;
  
  if (limiter.count > limit) {
    return false;
  }
  return true;
}

io.on('connection', (socket) => {
  console.log(`[WS] Client connected: ${socket.id}`);

  // Helper: extract session user from the socket's handshake
  const getSocketUser = () => {
    try {
      return socket.request?.session?.user || null;
    } catch { return null; }
  };

  // Join user-specific room (auth required — must match session)
  socket.on('join_user', (email) => {
    if (!wsRateLimit(socket)) {
      socket.emit('error', { message: 'Too many requests' });
      return;
    }
    const user = getSocketUser();
    if (!user || user.email !== email) {
      socket.emit('error', { message: 'Unauthorized: session mismatch' });
      return;
    }
    socket.join(`user:${email}`);
    console.log(`[WS] ${socket.id} joined room user:${email}`);
  });

  // Join date-specific dashboard room (validate date format)
  socket.on('join_dashboard', (date) => {
    if (!wsRateLimit(socket)) {
      socket.emit('error', { message: 'Too many requests' });
      return;
    }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      socket.emit('error', { message: 'Invalid date format' });
      return;
    }
    socket.join(`dashboard:${date}`);
    console.log(`[WS] ${socket.id} joined room dashboard:${date}`);
  });

  // Join shared-link viewer room — validate token exists in DB before allowing
  socket.on('join_shared', async (token) => {
    if (!wsRateLimit(socket)) {
      socket.emit('error', { message: 'Too many requests' });
      return;
    }
    if (typeof token !== 'string' || token.length === 0 || token.length > 64) {
      socket.emit('error', { message: 'Invalid token format' });
      return;
    }
    try {
      const { getShareLink } = await import('./db/database.js');
      const link = await getShareLink(token);
      if (!link || link.is_revoked) {
        socket.emit('shared_expired', { message: 'Link expired or revoked' });
        return;
      }
      const now = new Date();
      if (new Date(link.expires_at) < now) {
        socket.emit('shared_expired', { message: 'Link has expired' });
        return;
      }
      socket.join(`shared:${token}`);
      // Store the token + expiry on the socket for client-side expiry countdown
      socket.emit('shared_meta', { expiresAt: link.expires_at, displayName: link.display_name });
      console.log(`[WS] ${socket.id} joined shared room (valid token)`);
    } catch (err) {
      console.error('[WS] join_shared validation error:', err);
      socket.emit('error', { message: 'Failed to validate link' });
    }
  });

  // Backfill request on reconnect — REQUIRES session auth (fixes EC#1)
  socket.on('backfill', async ({ email, date }) => {
    if (!wsRateLimit(socket, 10)) {
      socket.emit('error', { message: 'Too many backfill requests' });
      return;
    }
    const user = getSocketUser();
    if (!user || user.email !== email) {
      socket.emit('error', { message: 'Unauthorized backfill request' });
      return;
    }
    if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      socket.emit('error', { message: 'Invalid date format' });
      return;
    }
    try {
      const { getDayRecord, getSlots } = await import('./db/database.js');
      // FIXED: Properly await both promises
      const [dayRecord, slots] = await Promise.all([
        getDayRecord(email, date),
        getSlots(email, date)
      ]);
      socket.emit('backfill_response', { dayRecord, slots });
    } catch (err) {
      console.error('[WS] Backfill error:', err);
      socket.emit('error', { message: 'Backfill failed' });
    }
  });

  socket.on('disconnect', () => {
    console.log(`[WS] Client disconnected: ${socket.id}`);
    // Clean up rate limiter to prevent memory leaks
    wsRateLimiters.delete(socket.id);
  });
});

// ─── Initialize Database and Admin ─────────────────────────────────────────────

async function initializeApp() {
  // Initialize database (requires async init for connection pool setup)
  await initDb();
  console.log('[DB] Database initialized with PostgreSQL connection pool');

  // Create default admin if not exists
  const adminEmail = (process.env.ADMIN_EMAIL || 'admin@tracker.pro').trim().toLowerCase();
  const adminPassword = process.env.ADMIN_PASSWORD;
  
  if (!adminPassword) {
    if (process.env.NODE_ENV === 'production') {
      console.error('[SECURITY] FATAL: ADMIN_PASSWORD not set in production. Exiting.');
      process.exit(1);
    }
    console.warn('[SECURITY] WARNING: ADMIN_PASSWORD not set. Cannot create default admin. Set environment variables ADMIN_EMAIL and ADMIN_PASSWORD.');
  } else {
    const admin = await getUserByEmail(adminEmail);
    if (!admin) {
      const hash = hashPassword(adminPassword);
      await createUser(adminEmail, 'Administrator', hash, 'UTC', 'admin');
      console.log(`[DB] Default admin created: ${adminEmail}`);
    }
  }

  initSheetsSync();

  // Run data cleanup immediately and then every 12 hours
  const runCleanup = async () => {
    try {
      const retentionDays = parseInt(process.env.DATA_RETENTION_DAYS) || 8;
      const result = await cleanOldData(retentionDays);
      if (result.success && result.deleted > 0) {
        console.log(`[System] Auto-cleanup removed ${result.deleted} old records (Older than ${result.cutoff})`);
      }
      // Also clean expired/revoked share links
      try { 
        await cleanExpiredShareLinks(); 
      } catch (e) { 
        console.warn('[System] Share link cleanup error:', e.message);
      }
    } catch (err) {
      console.error('[System] Cleanup error:', err);
    }
  };
  
  // Run 5 seconds after startup, then every 12 hours
  setTimeout(runCleanup, 5000);
  setInterval(runCleanup, 12 * 60 * 60 * 1000);
}

// ─── Keep-Alive Self-Ping ──────────────────────────────────────────────────────

function startKeepAlive(port) {
  // Render spins down after 15 mins. Pinging localhost bypasses the load balancer and doesn't reset the timer.
  // We MUST ping the external URL. Render automatically provides RENDER_EXTERNAL_URL.
  const INTERVAL_MS = 10 * 60 * 1000; // 10 minutes
  const baseUrl = process.env.RENDER_EXTERNAL_URL || process.env.PUBLIC_URL || `http://localhost:${port}`;
  const url = `${baseUrl}/api/health`;

  setInterval(async () => {
    try {
      const res = await fetch(url);
      if (res.ok) {
        console.log(`[Keep-Alive] Ping OK (${res.status}) to ${url}`);
      } else {
        console.warn(`[Keep-Alive] Ping returned ${res.status} from ${url}`);
      }
    } catch (err) {
      console.warn(`[Keep-Alive] Ping failed to ${url}: ${err.message}`);
    }
  }, INTERVAL_MS);

  console.log(`[Keep-Alive] Scheduled every ${INTERVAL_MS / 60000} minutes to ${url}`);
}

// ─── Start Server ──────────────────────────────────────────────────────────────

initializeApp().then(() => {
  server.listen(PORT, () => {
    console.log(`
  ╔══════════════════════════════════════════════════════╗
  ║                                                      ║
  ║   🚀 Personal Tracker                                ║
  ║   ─────────────────────────────────                  ║
  ║   Server:    http://localhost:${PORT}                  ║
  ║   Dashboard: http://localhost:${PORT}/dashboard        ║
  ║   Admin:     http://localhost:${PORT}/admin             ║
  ║                                                      ║
  ╚══════════════════════════════════════════════════════╝
    `);

    // Start self-ping keep-alive in production
    if (process.env.NODE_ENV === "production") {
      startKeepAlive(PORT);
    }
  });
}).catch(err => {
  console.error('Failed to start server:', err);
  process.exit(1);
});

export { app, server, io };
