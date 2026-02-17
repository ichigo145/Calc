// ===========================================================================
// server.js - A-Talk メインサーバー v5.0 (Socket.io + 経済 + 投票 + 性格進化)
// ===========================================================================
// v5.0: Socket.io, 投票, 性格進化, 経済シミュレーション, 安定化
// ===========================================================================

import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { Server as SocketIOServer } from 'socket.io';
import routes from './routes.js';
import { startPostGenerationLoop, stopPostGenerationLoop, setSocketIO } from './post-generator.js';
import { getUserCount, closeDatabase, initAllUserPoints, grantDailyPoints } from './database.js';
import { computeAllFollowers } from './follower-calculator.js';
import { startAutoManagement, stopAutoManagement, setFollowerComputer } from './api-controller.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const app = express();

// ─────────────────────────────────────────────────────────────────────────────
// PORT: 3000 固定 (環境変数を無視、変更禁止)
// ─────────────────────────────────────────────────────────────────────────────
const PORT = 3000;

// ─────────────────────────────────────────────────────────────────────────────
// 未処理例外・Promiseリジェクションで即死しないようにする
// ─────────────────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => {
  console.error('[A-Talk] 未処理例外 (致命的でない):', err.message);
  console.error(err.stack);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[A-Talk] 未処理Promiseリジェクション:', reason);
});

// ─────────────────────────────────────────────────────────────────────────────
// Security middleware - Socket.io対応CSP
// ─────────────────────────────────────────────────────────────────────────────
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'"],
      styleSrc: ["'self'", "'unsafe-inline'"],
      imgSrc: ["'self'", "data:"],
      connectSrc: ["'self'", "ws:", "wss:"],
      fontSrc: ["'self'"],
      objectSrc: ["'none'"],
      frameAncestors: ["'none'"],
      mediaSrc: ["'self'", "data:", "blob:"],
    },
  },
  crossOriginEmbedderPolicy: false,
}));

const apiLimiter = rateLimit({
  windowMs: 60_000,
  max: 200,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'リクエスト過多です。しばらくお待ちください。' },
});
app.use('/api', apiLimiter);

// ─────────────────────────────────────────────────────────────────────────────
// Static files & Routes
// ─────────────────────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use(routes);

app.get('*', (req, res) => {
  if (!req.path.startsWith('/api')) {
    res.sendFile(path.join(__dirname, '..', 'public', 'index.html'));
  } else {
    res.status(404).json({ error: '見つかりません' });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// Global error handler
// ─────────────────────────────────────────────────────────────────────────────
app.use((err, req, res, _next) => {
  console.error('[A-Talk] Expressエラー:', err.message);
  res.status(500).json({ error: 'サーバー内部エラー' });
});

// ─────────────────────────────────────────────────────────────────────────────
// HTTP + Socket.io
// ─────────────────────────────────────────────────────────────────────────────
const httpServer = createServer(app);
const io = new SocketIOServer(httpServer, {
  cors: { origin: '*' },
  pingInterval: 25000,
  pingTimeout: 60000,
  transports: ['websocket', 'polling'],
});

// Socket.io connection handling
io.on('connection', (socket) => {
  console.log(`[Socket.io] 接続: ${socket.id}`);
  socket.on('disconnect', () => {
    console.log(`[Socket.io] 切断: ${socket.id}`);
  });
});

// Export io for use in other modules
export { io };

// Make io accessible from routes
app.set('io', io);

// ─────────────────────────────────────────────────────────────────────────────
// Start server (PORT 3000 固定)
// ─────────────────────────────────────────────────────────────────────────────
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log('==================================================');
  console.log(`  A-Talk Server v5.0 (AI掲示板 - Socket.io版)`);
  console.log(`  http://localhost:${PORT}`);
  console.log(`  ポート: ${PORT} (固定・変更不可)`);
  console.log('  モデル: flash-lite, flash, flash3-preview, pro (要約)');
  console.log('  投稿間隔: 5秒ベース');
  console.log('  ポイントシステム: 有効 (デイリー100pt)');
  console.log('  バッジ/名前色: 40種類');
  console.log('  AI自動購入: 有効');
  console.log('  Socket.io: 有効');
  console.log('  投票機能: 有効');
  console.log('  性格進化: 有効');
  console.log('  経済シミュレーション: 有効');
  console.log('==================================================');

  const userCount = getUserCount();
  if (userCount === 0) {
    console.warn('[A-Talk] ユーザーなし。`npm run seed-users` を実行してください。');
  } else {
    console.log(`[A-Talk] ユーザー数: ${userCount}人`);

    try {
      initAllUserPoints();
      grantDailyPoints();
      console.log('[A-Talk] ポイントシステム初期化完了');
    } catch (err) {
      console.warn('[A-Talk] ポイント初期化エラー:', err.message);
    }

    setFollowerComputer(computeAllFollowers);
    try {
      const followers = computeAllFollowers();
      console.log(`[A-Talk] フォロワー予測: ${followers.length}人`);
    } catch (err) {
      console.warn('[A-Talk] フォロワー計算スキップ:', err.message);
    }

    // Socket.ioをpost-generatorに設定
    setSocketIO(io);

    startAutoManagement();
    startPostGenerationLoop();
  }
});

httpServer.keepAliveTimeout = 65_000;
httpServer.headersTimeout = 66_000;

// ─────────────────────────────────────────────────────────────────────────────
// Graceful shutdown
// ─────────────────────────────────────────────────────────────────────────────
function shutdown(signal) {
  console.log(`\n[A-Talk] ${signal} 受信。シャットダウン中...`);
  stopPostGenerationLoop();
  stopAutoManagement();
  io.close();
  httpServer.close(() => {
    try { closeDatabase(); } catch (e) {}
    console.log('[A-Talk] サーバー停止。');
    process.exit(0);
  });

  setTimeout(() => {
    console.error('[A-Talk] タイムアウトによる強制停止');
    process.exit(1);
  }, 10_000);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
