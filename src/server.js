// ===========================================================================
// server.js - A-Talk メインサーバー v3.2 (掲示板型AI SNS)
// ===========================================================================

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startPostGenerationLoop, stopPostGenerationLoop } from './post-generator.js';
import { getUserCount, closeDatabase } from './database.js';
import { computeAllFollowers } from './follower-calculator.js';
import { startAutoManagement, stopAutoManagement, setFollowerComputer } from './api-controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;

// ---------------------------------------------------------------------------
// Security middleware
// ---------------------------------------------------------------------------
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'"],
      connectSrc: ["'self'"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

// Rate limiting
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 120, // Increased for faster posting
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests. Please try again later.' },
});
app.use('/api', apiLimiter);

// ---------------------------------------------------------------------------
// Static files
// ---------------------------------------------------------------------------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------------------------------------------------------------------------
// API routes
// ---------------------------------------------------------------------------
app.use(routes);

// ---------------------------------------------------------------------------
// SPA fallback
// ---------------------------------------------------------------------------
app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  } else {
    res.status(404).json({ error: 'Not found' });
  }
});

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const server = app.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`  A-Talk Server v3.2 (Bulletin Board Style)`);
  console.log(`  http://localhost:${PORT}`);
  console.log('  Models: flash-lite, flash, flash3-preview, pro (summary)');
  console.log('==================================================');

  const userCount = getUserCount();
  if (userCount === 0) {
    console.warn('[A-Talk] No users in DB. Run `npm run seed-users` first.');
  } else {
    console.log(`[A-Talk] Found ${userCount} users in DB.`);

    // Set follower computer for auto-management
    setFollowerComputer(computeAllFollowers);

    // Compute initial followers
    try {
      const followers = computeAllFollowers();
      console.log(`[A-Talk] Initial follower predictions: ${followers.length} users.`);
    } catch (err) {
      console.warn('[A-Talk] Follower computation skipped:', err.message);
    }

    // Start auto-management (follower recalc, anomaly monitoring)
    startAutoManagement();

    // Start post generation loop (10s base interval)
    startPostGenerationLoop();
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\n[A-Talk] Received ${signal}. Shutting down gracefully...`);
  stopPostGenerationLoop();
  stopAutoManagement();
  server.close(() => {
    closeDatabase();
    console.log('[A-Talk] Server closed. Goodbye.');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[A-Talk] Forced shutdown after timeout.');
    process.exit(1);
  }, 10_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
