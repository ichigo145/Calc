// ===========================================================================
// server.js - A-Talk メインサーバー
// ===========================================================================
//
// アーキテクチャ:
//   Express.js (HTTP server)
//   +-- public/                   静的ファイル配信 (HTML/CSS/JS)
//   +-- src/routes.js             REST API エンドポイント
//   +-- src/database.js           SQLite データベース (atalk.db)
//   +-- src/gemini-client.js      Gemini API クライアント (gemini-2.5-flash-lite)
//   +-- src/post-generator.js     投稿の定期生成 (120秒間隔)
//   +-- src/comment-generator.js  コメント・DM・リアクションチェーンの生成
//   +-- src/likes-calculator.js   人気スコア → いいね数変換
//
// データフロー:
//   ブラウザ → Express (API) → SQLite ← Gemini API (バックエンドのみ)
//
// ===========================================================================

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import routes from './routes.js';
import { startPostGenerationLoop, stopPostGenerationLoop } from './post-generator.js';
import { getUserCount } from './database.js';
import { closeDatabase } from './database.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

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

// Rate limiting for API endpoints
const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 60,
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
  console.log(`  A-Talk Server started on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log('  Model: gemini-2.5-flash-lite (Stable)');
  console.log('==================================================');

  const userCount = getUserCount();
  if (userCount === 0) {
    console.warn('[A-Talk] No users in DB. Run `npm run seed-users` to generate AI users.');
    console.warn('[A-Talk] Post generation loop will NOT start until users exist.');
  } else {
    console.log(`[A-Talk] Found ${userCount} users in DB.`);
    startPostGenerationLoop();
  }
});

// ---------------------------------------------------------------------------
// Graceful shutdown
// ---------------------------------------------------------------------------
function shutdown(signal) {
  console.log(`\n[A-Talk] Received ${signal}. Shutting down gracefully...`);
  stopPostGenerationLoop();
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
