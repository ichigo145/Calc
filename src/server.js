// ===========================================================================
// server.js - A-Talk メインサーバー v3
// ===========================================================================
//
// アーキテクチャ:
//   Express.js (HTTP server)
//   +-- public/                         静的ファイル配信 (HTML/CSS/JS)
//   +-- src/routes.js                   REST API エンドポイント
//   +-- src/database.js                 SQLite データベース (atalk.db)
//   +-- src/gemini-client.js            Gemini API クライアント (マルチモデル)
//   +-- src/api-controller.js           API自動制御システム
//   +-- src/post-generator.js           投稿の定期生成 (120秒間隔)
//   +-- src/comment-generator.js        コメント・DM・リアクションチェーンの生成
//   +-- src/likes-calculator.js         人気スコア → いいね数変換
//   +-- src/follower-calculator.js      フォロワー予測アルゴリズム
//
// 使用モデル (2026-02-09):
//   - gemini-2.5-flash-lite  (Stable)  日常投稿・DM生成
//   - gemini-2.5-flash       (Stable)  コメント・リアクション生成
//   - gemini-3-flash-preview (Preview) オンデマンド (将来用)
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
import { getUserCount, closeDatabase } from './database.js';
import { computeAllFollowers } from './follower-calculator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000; // 固定ポート3000

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
  console.log(`  A-Talk Server v3 started on port ${PORT}`);
  console.log(`  http://localhost:${PORT}`);
  console.log('  Models: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-3-flash-preview');
  console.log('==================================================');

  const userCount = getUserCount();
  if (userCount === 0) {
    console.warn('[A-Talk] No users in DB. Run `npm run seed-users` to generate AI users.');
    console.warn('[A-Talk] Post generation loop will NOT start until users exist.');
  } else {
    console.log(`[A-Talk] Found ${userCount} users in DB.`);

    // Compute initial follower predictions
    try {
      const followers = computeAllFollowers();
      console.log(`[A-Talk] Computed follower predictions for ${followers.length} users.`);
    } catch (err) {
      console.warn('[A-Talk] Follower computation skipped:', err.message);
    }

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
