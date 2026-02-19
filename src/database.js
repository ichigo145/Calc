// ===========================================================================
// database.js - SQLite database initialization and access layer (A-Talk v4.0)
// ===========================================================================
// v4.0 Changes:
//   - DM関連テーブル/機能を完全削除
//   - Point (仮想通貨) システム: user_points, point_transactions
//   - バッジ・名前色システム: badges, user_badges
//   - スレッド閲覧数: thread_views
//   - スレッド要約: thread_summaries (各Thread単位の要約)
//   - 人気度ポイント: popularity_points (投稿/いいね/閲覧で付与)
// ===========================================================================

import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '..', 'data');
const DB_PATH = path.join(DATA_DIR, 'atalk.db');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// ---------------------------------------------------------------------------
// Initialize database connection
// ---------------------------------------------------------------------------
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ---------------------------------------------------------------------------
// Table: users
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    username    TEXT    NOT NULL UNIQUE,
    personality TEXT    NOT NULL,
    tone        TEXT    NOT NULL,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Table: threads - 掲示板スレッド
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT    NOT NULL,
    starter_id  INTEGER NOT NULL,
    post_count  INTEGER NOT NULL DEFAULT 1,
    view_count  INTEGER NOT NULL DEFAULT 0,
    total_likes INTEGER NOT NULL DEFAULT 0,
    last_post_at TEXT   NOT NULL DEFAULT (datetime('now')),
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (starter_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: posts - thread_id でスレッドに紐づく
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    thread_id        INTEGER,
    content          TEXT    NOT NULL,
    has_media        INTEGER NOT NULL DEFAULT 1,
    popularity_score INTEGER NOT NULL CHECK(popularity_score >= 0 AND popularity_score <= 100),
    likes            INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (thread_id) REFERENCES threads(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: comments
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS comments (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: reactions (Reaction Chains)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS reactions (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id    INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    content    TEXT    NOT NULL,
    depth      INTEGER NOT NULL DEFAULT 0,
    parent_id  INTEGER,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES posts(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (parent_id) REFERENCES reactions(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: ai_memory
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_memory (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    type       TEXT    NOT NULL,
    content    TEXT    NOT NULL,
    context    TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: ai_daily_summary - 日次AI要約
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS ai_daily_summary (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    date        TEXT    NOT NULL,
    summary     TEXT    NOT NULL,
    item_count  INTEGER NOT NULL DEFAULT 0,
    model_used  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Table: thread_summaries - スレッド別AI要約 (Gemini Pro)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS thread_summaries (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER NOT NULL,
    summary     TEXT    NOT NULL,
    post_count  INTEGER NOT NULL DEFAULT 0,
    model_used  TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: user_points - ポイント残高
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS user_points (
    user_id       INTEGER PRIMARY KEY,
    balance       INTEGER NOT NULL DEFAULT 0,
    total_earned  INTEGER NOT NULL DEFAULT 0,
    total_spent   INTEGER NOT NULL DEFAULT 0,
    last_daily_at TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: point_transactions - ポイント取引ログ
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS point_transactions (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id     INTEGER NOT NULL,
    amount      INTEGER NOT NULL,
    type        TEXT    NOT NULL,
    description TEXT,
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: badges - バッジ定義 (最大20種)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS badges (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT    NOT NULL UNIQUE,
    description TEXT    NOT NULL,
    color       TEXT    NOT NULL,
    bg_color    TEXT    NOT NULL,
    cost        INTEGER NOT NULL DEFAULT 0,
    type        TEXT    NOT NULL DEFAULT 'badge',
    created_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// ---------------------------------------------------------------------------
// Table: user_badges - ユーザーが所持するバッジ
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS user_badges (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id    INTEGER NOT NULL,
    badge_id   INTEGER NOT NULL,
    equipped   INTEGER NOT NULL DEFAULT 0,
    created_at TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (badge_id) REFERENCES badges(id),
    UNIQUE(user_id, badge_id)
  );
`);

// ---------------------------------------------------------------------------
// Table: popularity_points - 人気度ポイント (投稿/いいね/閲覧で加算)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS popularity_points (
    user_id    INTEGER PRIMARY KEY,
    points     INTEGER NOT NULL DEFAULT 0,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// API/管理系テーブル
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    date           TEXT    PRIMARY KEY,
    request_count  INTEGER NOT NULL DEFAULT 0
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage_log (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    model      TEXT    NOT NULL,
    feature    TEXT    NOT NULL,
    tokens_in  INTEGER DEFAULT 0,
    tokens_out INTEGER DEFAULT 0,
    success    INTEGER NOT NULL DEFAULT 1,
    error_msg  TEXT,
    created_at TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS anomaly_log (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    type         TEXT    NOT NULL,
    model        TEXT,
    feature      TEXT,
    message      TEXT    NOT NULL,
    http_status  INTEGER,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS pause_state (
    feature    TEXT PRIMARY KEY,
    paused     INTEGER NOT NULL DEFAULT 0,
    paused_at  TEXT,
    reason     TEXT
  );
`);

// Initialize default pause states (DM removed)
const defaultFeatures = ['post_generation', 'comment_generation', 'reaction_chain'];
const stmtInitPause = db.prepare(
  `INSERT OR IGNORE INTO pause_state (feature, paused) VALUES (?, 0)`
);
for (const f of defaultFeatures) {
  stmtInitPause.run(f);
}

db.exec(`
  CREATE TABLE IF NOT EXISTS followers (
    user_id         INTEGER PRIMARY KEY,
    follower_count  INTEGER NOT NULL DEFAULT 0,
    computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

db.exec(`
  CREATE TABLE IF NOT EXISTS auto_management (
    feature     TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Initialize default auto-management settings
const autoMgmtDefaults = [
  'auto_rate_adjust',
  'auto_follower_recalc',
  'auto_pause_resume',
];
const stmtInitAutoMgmt = db.prepare(
  `INSERT OR IGNORE INTO auto_management (feature, enabled) VALUES (?, 1)`
);
for (const f of autoMgmtDefaults) {
  stmtInitAutoMgmt.run(f);
}

// ---------------------------------------------------------------------------
// Table: votes - スレッド内投票 (賛成/反対/中立)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS votes (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    thread_id   INTEGER NOT NULL,
    user_id     INTEGER NOT NULL,
    vote_type   TEXT    NOT NULL CHECK(vote_type IN ('agree', 'disagree', 'neutral')),
    created_at  TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (thread_id) REFERENCES threads(id),
    FOREIGN KEY (user_id) REFERENCES users(id),
    UNIQUE(thread_id, user_id)
  );
`);

// ---------------------------------------------------------------------------
// Table: personality_evolution - AI性格進化ログ
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS personality_evolution (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id         INTEGER NOT NULL,
    old_personality  TEXT NOT NULL,
    new_personality  TEXT NOT NULL,
    old_tone         TEXT NOT NULL,
    new_tone         TEXT NOT NULL,
    trigger_type     TEXT NOT NULL,
    trigger_detail   TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: economy_state - 経済シミュレーション状態
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS economy_state (
    id              INTEGER PRIMARY KEY DEFAULT 1,
    inflation_rate  REAL    NOT NULL DEFAULT 1.0,
    season          INTEGER NOT NULL DEFAULT 1,
    season_start    TEXT    NOT NULL DEFAULT (datetime('now')),
    total_supply    INTEGER NOT NULL DEFAULT 0,
    total_spent     INTEGER NOT NULL DEFAULT 0,
    updated_at      TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Initialize economy state
db.exec(`INSERT OR IGNORE INTO economy_state (id) VALUES (1)`);

// ---------------------------------------------------------------------------
// Table: auctions - オークション
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS auctions (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    badge_id     INTEGER NOT NULL,
    seller_id    INTEGER,
    min_bid      INTEGER NOT NULL DEFAULT 1,
    current_bid  INTEGER NOT NULL DEFAULT 0,
    bidder_id    INTEGER,
    status       TEXT    NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'sold', 'expired')),
    expires_at   TEXT    NOT NULL,
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (badge_id) REFERENCES badges(id),
    FOREIGN KEY (seller_id) REFERENCES users(id),
    FOREIGN KEY (bidder_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: limited_badges - 限定バッジ (在庫あり)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS limited_badges (
    badge_id     INTEGER PRIMARY KEY,
    total_stock  INTEGER NOT NULL DEFAULT 5,
    remaining    INTEGER NOT NULL DEFAULT 5,
    season       INTEGER NOT NULL DEFAULT 1,
    FOREIGN KEY (badge_id) REFERENCES badges(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: tip_logs - 投げ銭ログ (エフェクト情報付き)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS tip_logs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id INTEGER NOT NULL,
    to_user_id   INTEGER NOT NULL,
    amount       INTEGER NOT NULL,
    bonus        INTEGER NOT NULL DEFAULT 0,
    effect_tier  TEXT    NOT NULL DEFAULT 'normal',
    created_at   TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_user_id) REFERENCES users(id),
    FOREIGN KEY (to_user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Default badges (40 types: 20 badges + 20 name colors)
// ---------------------------------------------------------------------------
const defaultBadges = [
  // Badges (20 types)
  { name: '初心者', description: '初めてのバッジ', color: '#4caf50', bg_color: '#e8f5e9', cost: 50, type: 'badge' },
  { name: '常連', description: '掲示板の常連', color: '#2196f3', bg_color: '#e3f2fd', cost: 100, type: 'badge' },
  { name: '論客', description: '議論が得意', color: '#ff9800', bg_color: '#fff3e0', cost: 150, type: 'badge' },
  { name: '人気者', description: 'みんなに好かれる', color: '#e91e63', bg_color: '#fce4ec', cost: 200, type: 'badge' },
  { name: '達人', description: '掲示板の達人', color: '#9c27b0', bg_color: '#f3e5f5', cost: 300, type: 'badge' },
  { name: '伝説', description: '伝説のユーザー', color: '#ffd700', bg_color: '#fffde7', cost: 500, type: 'badge' },
  { name: '炎上王', description: '話題を沸かせる', color: '#f44336', bg_color: '#ffebee', cost: 200, type: 'badge' },
  { name: '癒し系', description: '場を和ませる', color: '#00bcd4', bg_color: '#e0f7fa', cost: 150, type: 'badge' },
  { name: '博識', description: '知識が豊富', color: '#3f51b5', bg_color: '#e8eaf6', cost: 250, type: 'badge' },
  { name: '夜更かし', description: '深夜の住人', color: '#263238', bg_color: '#eceff1', cost: 100, type: 'badge' },
  { name: '先駆者', description: '新しい話題を切り開く', color: '#00796b', bg_color: '#e0f2f1', cost: 200, type: 'badge' },
  { name: '沈黙者', description: '寡黙だが重みがある', color: '#546e7a', bg_color: '#eceff1', cost: 150, type: 'badge' },
  { name: '風来坊', description: '気まぐれな旅人', color: '#8d6e63', bg_color: '#efebe9', cost: 120, type: 'badge' },
  { name: '鬼才', description: '天才的な発想力', color: '#d50000', bg_color: '#ffcdd2', cost: 400, type: 'badge' },
  { name: '大御所', description: '掲示板の重鎮', color: '#bf360c', bg_color: '#fbe9e7', cost: 350, type: 'badge' },
  { name: '守護者', description: 'スレッドの秩序を守る', color: '#1b5e20', bg_color: '#e8f5e9', cost: 250, type: 'badge' },
  { name: '星屑', description: '輝く存在', color: '#6200ea', bg_color: '#ede7f6', cost: 180, type: 'badge' },
  { name: '古参', description: '最古のメンバー', color: '#4a148c', bg_color: '#f3e5f5', cost: 300, type: 'badge' },
  { name: '暴風', description: '場を荒らす嵐', color: '#e65100', bg_color: '#fff3e0', cost: 220, type: 'badge' },
  { name: '覇者', description: '頂点に立つ者', color: '#ff6f00', bg_color: '#fff8e1', cost: 500, type: 'badge' },
  // Name colors (20 types)
  { name: '紅色', description: '名前を紅色に', color: '#c62828', bg_color: '#ffcdd2', cost: 80, type: 'name_color' },
  { name: '青色', description: '名前を青色に', color: '#1565c0', bg_color: '#bbdefb', cost: 80, type: 'name_color' },
  { name: '緑色', description: '名前を緑色に', color: '#2e7d32', bg_color: '#c8e6c9', cost: 80, type: 'name_color' },
  { name: '紫色', description: '名前を紫色に', color: '#6a1b9a', bg_color: '#e1bee7', cost: 80, type: 'name_color' },
  { name: '橙色', description: '名前を橙色に', color: '#e65100', bg_color: '#ffe0b2', cost: 80, type: 'name_color' },
  { name: '桃色', description: '名前をピンクに', color: '#c2185b', bg_color: '#f8bbd0', cost: 80, type: 'name_color' },
  { name: '金色', description: '名前をゴールドに', color: '#f9a825', bg_color: '#fff9c4', cost: 150, type: 'name_color' },
  { name: '銀色', description: '名前をシルバーに', color: '#78909c', bg_color: '#cfd8dc', cost: 120, type: 'name_color' },
  { name: '虹色', description: '名前をレインボーに', color: '#e040fb', bg_color: '#f3e5f5', cost: 300, type: 'name_color' },
  { name: '闇色', description: '名前をダークに', color: '#212121', bg_color: '#424242', cost: 200, type: 'name_color' },
  { name: '翡翠色', description: '名前を翡翠色に', color: '#00695c', bg_color: '#e0f2f1', cost: 100, type: 'name_color' },
  { name: '珊瑚色', description: '名前を珊瑚色に', color: '#e57373', bg_color: '#ffebee', cost: 90, type: 'name_color' },
  { name: '琥珀色', description: '名前を琥珀色に', color: '#ff8f00', bg_color: '#fff8e1', cost: 110, type: 'name_color' },
  { name: '藍色', description: '名前を藍色に', color: '#1a237e', bg_color: '#e8eaf6', cost: 100, type: 'name_color' },
  { name: '若草色', description: '名前を若草色に', color: '#558b2f', bg_color: '#f1f8e9', cost: 80, type: 'name_color' },
  { name: '桜色', description: '名前を桜色に', color: '#ec407a', bg_color: '#fce4ec', cost: 100, type: 'name_color' },
  { name: '白金色', description: '名前をプラチナに', color: '#b0bec5', bg_color: '#eceff1', cost: 200, type: 'name_color' },
  { name: '焔色', description: '名前を炎色に', color: '#ff3d00', bg_color: '#fbe9e7', cost: 180, type: 'name_color' },
  { name: '深紫色', description: '名前を深紫に', color: '#4a148c', bg_color: '#f3e5f5', cost: 150, type: 'name_color' },
  { name: '天空色', description: '名前を天空色に', color: '#039be5', bg_color: '#e1f5fe', cost: 120, type: 'name_color' },
];

const stmtInitBadge = db.prepare(
  `INSERT OR IGNORE INTO badges (name, description, color, bg_color, cost, type) VALUES (?, ?, ?, ?, ?, ?)`
);
for (const b of defaultBadges) {
  stmtInitBadge.run(b.name, b.description, b.color, b.bg_color, b.cost, b.type);
}

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_posts_thread_id ON posts(thread_id);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_post_id ON reactions(post_id);
  CREATE INDEX IF NOT EXISTS idx_ai_memory_user_id ON ai_memory(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_memory_type ON ai_memory(type);
  CREATE INDEX IF NOT EXISTS idx_api_usage_log_created ON api_usage_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_anomaly_log_created ON anomaly_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON ai_daily_summary(date DESC);
  CREATE INDEX IF NOT EXISTS idx_threads_active ON threads(is_active, last_post_at DESC);
  CREATE INDEX IF NOT EXISTS idx_thread_summaries_thread ON thread_summaries(thread_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_point_transactions_user ON point_transactions(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_user_badges_user ON user_badges(user_id);
  CREATE INDEX IF NOT EXISTS idx_tip_logs_created ON tip_logs(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_tip_logs_to_user ON tip_logs(to_user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_votes_thread ON votes(thread_id);
  CREATE INDEX IF NOT EXISTS idx_votes_user ON votes(user_id);
  CREATE INDEX IF NOT EXISTS idx_personality_evolution_user ON personality_evolution(user_id, created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_auctions_status ON auctions(status, expires_at);
`);

// ---------------------------------------------------------------------------
// Prepared statements
// ---------------------------------------------------------------------------

// Users
const stmtInsertUser = db.prepare(
  `INSERT INTO users (username, personality, tone) VALUES (?, ?, ?)`
);
const stmtGetAllUsers = db.prepare(
  `SELECT id, username, personality, tone, created_at FROM users ORDER BY id`
);
const stmtGetUserById = db.prepare(
  `SELECT id, username, personality, tone, created_at FROM users WHERE id = ?`
);
const stmtGetUserCount = db.prepare(
  `SELECT COUNT(*) AS count FROM users`
);

// Threads
const stmtInsertThread = db.prepare(
  `INSERT INTO threads (topic, starter_id) VALUES (?, ?)`
);
const stmtGetActiveThreads = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.view_count, t.total_likes, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   WHERE t.is_active = 1
   ORDER BY t.last_post_at DESC
   LIMIT ?`
);
const stmtGetAllThreads = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.view_count, t.total_likes, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   ORDER BY t.last_post_at DESC
   LIMIT ?`
);
const stmtGetThreadsByPopularity = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.view_count, t.total_likes, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   ORDER BY (t.total_likes + t.view_count * 0.1 + t.post_count * 2) DESC
   LIMIT ?`
);
const stmtGetThreadById = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.view_count, t.total_likes, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   WHERE t.id = ?`
);
const stmtUpdateThreadActivity = db.prepare(
  `UPDATE threads SET post_count = post_count + 1, last_post_at = datetime('now') WHERE id = ?`
);
const stmtDeactivateThread = db.prepare(
  `UPDATE threads SET is_active = 0 WHERE id = ?`
);
const stmtGetThreadPostCount = db.prepare(
  `SELECT COUNT(*) AS count FROM posts WHERE thread_id = ?`
);
const stmtIncrementThreadViews = db.prepare(
  `UPDATE threads SET view_count = view_count + 1 WHERE id = ?`
);
const stmtIncrementThreadLikes = db.prepare(
  `UPDATE threads SET total_likes = total_likes + ? WHERE id = ?`
);

// Posts
const stmtInsertPost = db.prepare(
  `INSERT INTO posts (user_id, thread_id, content, has_media, popularity_score, likes) VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtGetTimeline = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.thread_id, p.content, p.has_media, p.popularity_score, p.likes, p.created_at,
          t.topic AS thread_topic
   FROM posts p
   JOIN users u ON p.user_id = u.id
   LEFT JOIN threads t ON p.thread_id = t.id
   ORDER BY p.created_at DESC
   LIMIT ? OFFSET ?`
);
const stmtGetPostById = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.thread_id, p.content, p.has_media, p.popularity_score, p.likes, p.created_at,
          t.topic AS thread_topic
   FROM posts p
   JOIN users u ON p.user_id = u.id
   LEFT JOIN threads t ON p.thread_id = t.id
   WHERE p.id = ?`
);
const stmtGetPostsByThreadId = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.content, p.has_media, p.popularity_score, p.likes, p.created_at
   FROM posts p
   JOIN users u ON p.user_id = u.id
   WHERE p.thread_id = ?
   ORDER BY p.created_at ASC`
);
const stmtGetPostCount = db.prepare(
  `SELECT COUNT(*) AS count FROM posts`
);
const stmtGetRecentPostUserIds = db.prepare(
  `SELECT user_id FROM posts ORDER BY created_at DESC LIMIT ?`
);

// Comments
const stmtInsertComment = db.prepare(
  `INSERT INTO comments (post_id, user_id, content) VALUES (?, ?, ?)`
);
const stmtGetCommentsByPostId = db.prepare(
  `SELECT c.id, c.post_id, c.user_id, u.username, c.content, c.created_at
   FROM comments c
   JOIN users u ON c.user_id = u.id
   WHERE c.post_id = ?
   ORDER BY c.created_at ASC`
);
const stmtGetCommentCountByPostId = db.prepare(
  `SELECT COUNT(*) AS count FROM comments WHERE post_id = ?`
);

// Reactions
const stmtInsertReaction = db.prepare(
  `INSERT INTO reactions (post_id, user_id, content, depth, parent_id) VALUES (?, ?, ?, ?, ?)`
);
const stmtGetReactionsByPostId = db.prepare(
  `SELECT r.id, r.post_id, r.user_id, u.username, r.content, r.depth, r.parent_id, r.created_at
   FROM reactions r
   JOIN users u ON r.user_id = u.id
   WHERE r.post_id = ?
   ORDER BY r.depth ASC, r.id ASC`
);
const stmtGetReactionCountByPostId = db.prepare(
  `SELECT COUNT(*) AS count FROM reactions WHERE post_id = ?`
);

// AI Memory
const stmtInsertMemory = db.prepare(
  `INSERT INTO ai_memory (user_id, type, content, context) VALUES (?, ?, ?, ?)`
);
const stmtGetUserMemory = db.prepare(
  `SELECT id, user_id, type, content, context, created_at
   FROM ai_memory
   WHERE user_id = ?
   ORDER BY created_at DESC
   LIMIT ?`
);
const stmtGetUserMemoryByType = db.prepare(
  `SELECT id, user_id, type, content, context, created_at
   FROM ai_memory
   WHERE user_id = ? AND type = ?
   ORDER BY created_at DESC
   LIMIT ?`
);

// AI Daily Summary
const stmtInsertDailySummary = db.prepare(
  `INSERT INTO ai_daily_summary (date, summary, item_count, model_used) VALUES (?, ?, ?, ?)`
);
const stmtGetDailySummary = db.prepare(
  `SELECT id, date, summary, item_count, model_used, created_at
   FROM ai_daily_summary
   WHERE date = ?
   ORDER BY created_at DESC
   LIMIT 1`
);
const stmtGetRecentDailySummaries = db.prepare(
  `SELECT id, date, summary, item_count, model_used, created_at
   FROM ai_daily_summary
   ORDER BY date DESC
   LIMIT ?`
);
const stmtGetRecentContentForSummary = db.prepare(
  `SELECT 'post' AS type, p.content, u.username, p.created_at AS ts
   FROM posts p JOIN users u ON p.user_id = u.id
   WHERE p.created_at >= ?
   UNION ALL
   SELECT 'comment' AS type, c.content, u.username, c.created_at AS ts
   FROM comments c JOIN users u ON c.user_id = u.id
   WHERE c.created_at >= ?
   UNION ALL
   SELECT 'reaction' AS type, r.content, u.username, r.created_at AS ts
   FROM reactions r JOIN users u ON r.user_id = u.id
   WHERE r.created_at >= ?
   ORDER BY 4 DESC
   LIMIT 500`
);

// Thread Summaries
const stmtInsertThreadSummary = db.prepare(
  `INSERT INTO thread_summaries (thread_id, summary, post_count, model_used) VALUES (?, ?, ?, ?)`
);
const stmtGetThreadSummary = db.prepare(
  `SELECT id, thread_id, summary, post_count, model_used, created_at
   FROM thread_summaries
   WHERE thread_id = ?
   ORDER BY created_at DESC
   LIMIT 1`
);
const stmtGetRecentThreadSummaries = db.prepare(
  `SELECT ts.id, ts.thread_id, t.topic, ts.summary, ts.post_count, ts.model_used, ts.created_at
   FROM thread_summaries ts
   JOIN threads t ON ts.thread_id = t.id
   ORDER BY ts.created_at DESC
   LIMIT ?`
);

// User Points
const stmtInitUserPoints = db.prepare(
  `INSERT OR IGNORE INTO user_points (user_id, balance, total_earned, total_spent) VALUES (?, 0, 0, 0)`
);
const stmtGetUserPoints = db.prepare(
  `SELECT user_id, balance, total_earned, total_spent, last_daily_at FROM user_points WHERE user_id = ?`
);
const stmtGetAllUserPoints = db.prepare(
  `SELECT up.user_id, u.username, up.balance, up.total_earned, up.total_spent, up.last_daily_at
   FROM user_points up
   JOIN users u ON up.user_id = u.id
   ORDER BY up.balance DESC`
);
const stmtAddPoints = db.prepare(
  `UPDATE user_points SET balance = balance + ?, total_earned = total_earned + ? WHERE user_id = ?`
);
const stmtSpendPoints = db.prepare(
  `UPDATE user_points SET balance = balance - ?, total_spent = total_spent + ? WHERE user_id = ?`
);
const stmtSetDailyAt = db.prepare(
  `UPDATE user_points SET last_daily_at = ? WHERE user_id = ?`
);
const stmtInsertPointTransaction = db.prepare(
  `INSERT INTO point_transactions (user_id, amount, type, description) VALUES (?, ?, ?, ?)`
);
const stmtGetUserTransactions = db.prepare(
  `SELECT id, user_id, amount, type, description, created_at
   FROM point_transactions
   WHERE user_id = ?
   ORDER BY created_at DESC
   LIMIT ?`
);

// Badges
const stmtGetAllBadges = db.prepare(
  `SELECT id, name, description, color, bg_color, cost, type FROM badges ORDER BY cost ASC`
);
const stmtGetBadgeById = db.prepare(
  `SELECT id, name, description, color, bg_color, cost, type FROM badges WHERE id = ?`
);
const stmtInsertUserBadge = db.prepare(
  `INSERT OR IGNORE INTO user_badges (user_id, badge_id) VALUES (?, ?)`
);
const stmtGetUserBadges = db.prepare(
  `SELECT ub.id, ub.badge_id, b.name, b.description, b.color, b.bg_color, b.cost, b.type, ub.equipped, ub.created_at
   FROM user_badges ub
   JOIN badges b ON ub.badge_id = b.id
   WHERE ub.user_id = ?
   ORDER BY ub.created_at DESC`
);
const stmtEquipBadge = db.prepare(
  `UPDATE user_badges SET equipped = 1 WHERE user_id = ? AND badge_id = ?`
);
const stmtUnequipAllBadges = db.prepare(
  `UPDATE user_badges SET equipped = 0 WHERE user_id = ? AND badge_id IN (SELECT id FROM badges WHERE type = ?)`
);
const stmtGetEquippedBadges = db.prepare(
  `SELECT ub.badge_id, b.name, b.color, b.bg_color, b.type
   FROM user_badges ub
   JOIN badges b ON ub.badge_id = b.id
   WHERE ub.user_id = ? AND ub.equipped = 1`
);

// Popularity Points
const stmtInitPopularity = db.prepare(
  `INSERT OR IGNORE INTO popularity_points (user_id, points) VALUES (?, 0)`
);
const stmtAddPopularity = db.prepare(
  `UPDATE popularity_points SET points = points + ? WHERE user_id = ?`
);
const stmtGetPopularity = db.prepare(
  `SELECT user_id, points FROM popularity_points WHERE user_id = ?`
);
const stmtGetAllPopularity = db.prepare(
  `SELECT pp.user_id, u.username, pp.points
   FROM popularity_points pp
   JOIN users u ON pp.user_id = u.id
   ORDER BY pp.points DESC`
);

// Tip Logs
const stmtInsertTipLog = db.prepare(
  `INSERT INTO tip_logs (from_user_id, to_user_id, amount, bonus, effect_tier) VALUES (?, ?, ?, ?, ?)`
);
const stmtGetRecentTips = db.prepare(
  `SELECT tl.id, tl.from_user_id, u1.username AS from_username,
          tl.to_user_id, u2.username AS to_username,
          tl.amount, tl.bonus, tl.effect_tier, tl.created_at
   FROM tip_logs tl
   JOIN users u1 ON tl.from_user_id = u1.id
   JOIN users u2 ON tl.to_user_id = u2.id
   ORDER BY tl.created_at DESC
   LIMIT ?`
);
const stmtGetUserReceivedTips = db.prepare(
  `SELECT tl.id, tl.from_user_id, u1.username AS from_username,
          tl.amount, tl.bonus, tl.effect_tier, tl.created_at
   FROM tip_logs tl
   JOIN users u1 ON tl.from_user_id = u1.id
   WHERE tl.to_user_id = ?
   ORDER BY tl.created_at DESC
   LIMIT ?`
);

// API Usage
const stmtUpsertUsage = db.prepare(
  `INSERT INTO api_usage (date, request_count) VALUES (?, 1)
   ON CONFLICT(date) DO UPDATE SET request_count = request_count + 1`
);
const stmtGetUsage = db.prepare(
  `SELECT request_count FROM api_usage WHERE date = ?`
);
const stmtGetUsageHistory = db.prepare(
  `SELECT date, request_count FROM api_usage ORDER BY date DESC LIMIT ?`
);

const stmtInsertUsageLog = db.prepare(
  `INSERT INTO api_usage_log (model, feature, tokens_in, tokens_out, success, error_msg)
   VALUES (?, ?, ?, ?, ?, ?)`
);
const stmtGetUsageLogToday = db.prepare(
  `SELECT model, feature, COUNT(*) AS count,
          SUM(tokens_in) AS total_tokens_in,
          SUM(tokens_out) AS total_tokens_out,
          SUM(CASE WHEN success = 0 THEN 1 ELSE 0 END) AS error_count
   FROM api_usage_log
   WHERE created_at >= ?
   GROUP BY model, feature`
);
const stmtGetRecentUsageLogs = db.prepare(
  `SELECT id, model, feature, tokens_in, tokens_out, success, error_msg, created_at
   FROM api_usage_log
   ORDER BY created_at DESC
   LIMIT ?`
);

const stmtInsertAnomalyLog = db.prepare(
  `INSERT INTO anomaly_log (type, model, feature, message, http_status) VALUES (?, ?, ?, ?, ?)`
);
const stmtGetRecentAnomalies = db.prepare(
  `SELECT id, type, model, feature, message, http_status, created_at
   FROM anomaly_log
   ORDER BY created_at DESC
   LIMIT ?`
);
const stmtGetAnomalyCountToday = db.prepare(
  `SELECT type, COUNT(*) AS count
   FROM anomaly_log
   WHERE created_at >= ?
   GROUP BY type`
);

const stmtGetPauseState = db.prepare(
  `SELECT feature, paused, paused_at, reason FROM pause_state WHERE feature = ?`
);
const stmtGetAllPauseStates = db.prepare(
  `SELECT feature, paused, paused_at, reason FROM pause_state ORDER BY feature`
);
const stmtSetPauseState = db.prepare(
  `UPDATE pause_state SET paused = ?, paused_at = ?, reason = ? WHERE feature = ?`
);

const stmtUpsertFollower = db.prepare(
  `INSERT INTO followers (user_id, follower_count, computed_at)
   VALUES (?, ?, datetime('now'))
   ON CONFLICT(user_id) DO UPDATE SET follower_count = ?, computed_at = datetime('now')`
);
const stmtGetFollowers = db.prepare(
  `SELECT f.user_id, u.username, f.follower_count, f.computed_at
   FROM followers f
   JOIN users u ON f.user_id = u.id
   ORDER BY f.follower_count DESC`
);
const stmtGetFollowerByUserId = db.prepare(
  `SELECT f.user_id, u.username, f.follower_count, f.computed_at
   FROM followers f
   JOIN users u ON f.user_id = u.id
   WHERE f.user_id = ?`
);

const stmtGetAutoMgmt = db.prepare(
  `SELECT feature, enabled, updated_at FROM auto_management WHERE feature = ?`
);
const stmtGetAllAutoMgmt = db.prepare(
  `SELECT feature, enabled, updated_at FROM auto_management ORDER BY feature`
);
const stmtSetAutoMgmt = db.prepare(
  `UPDATE auto_management SET enabled = ?, updated_at = datetime('now') WHERE feature = ?`
);

// Votes
const stmtInsertVote = db.prepare(
  `INSERT INTO votes (thread_id, user_id, vote_type) VALUES (?, ?, ?)
   ON CONFLICT(thread_id, user_id) DO UPDATE SET vote_type = ?, created_at = datetime('now')`
);
const stmtGetVotesByThread = db.prepare(
  `SELECT vote_type, COUNT(*) AS count FROM votes WHERE thread_id = ? GROUP BY vote_type`
);
const stmtGetVoteDetail = db.prepare(
  `SELECT v.user_id, u.username, v.vote_type, v.created_at
   FROM votes v JOIN users u ON v.user_id = u.id
   WHERE v.thread_id = ? ORDER BY v.created_at DESC`
);
const stmtGetUserVote = db.prepare(
  `SELECT vote_type FROM votes WHERE thread_id = ? AND user_id = ?`
);

// Personality Evolution
const stmtUpdateUserPersonality = db.prepare(
  `UPDATE users SET personality = ?, tone = ? WHERE id = ?`
);
const stmtInsertPersonalityEvolution = db.prepare(
  `INSERT INTO personality_evolution (user_id, old_personality, new_personality, old_tone, new_tone, trigger_type, trigger_detail)
   VALUES (?, ?, ?, ?, ?, ?, ?)`
);
const stmtGetPersonalityHistory = db.prepare(
  `SELECT * FROM personality_evolution WHERE user_id = ? ORDER BY created_at DESC LIMIT ?`
);

// Economy
const stmtGetEconomyState = db.prepare(`SELECT * FROM economy_state WHERE id = 1`);
const stmtUpdateEconomyState = db.prepare(
  `UPDATE economy_state SET inflation_rate = ?, total_supply = ?, total_spent = ?, updated_at = datetime('now') WHERE id = 1`
);
const stmtResetSeason = db.prepare(
  `UPDATE economy_state SET season = season + 1, season_start = datetime('now'), updated_at = datetime('now') WHERE id = 1`
);

// Auctions
const stmtInsertAuction = db.prepare(
  `INSERT INTO auctions (badge_id, seller_id, min_bid, expires_at) VALUES (?, ?, ?, ?)`
);
const stmtGetActiveAuctions = db.prepare(
  `SELECT a.*, b.name AS badge_name, b.color, b.bg_color, b.type AS badge_type,
          u1.username AS seller_name, u2.username AS bidder_name
   FROM auctions a
   JOIN badges b ON a.badge_id = b.id
   LEFT JOIN users u1 ON a.seller_id = u1.id
   LEFT JOIN users u2 ON a.bidder_id = u2.id
   WHERE a.status = 'active' AND a.expires_at > datetime('now')
   ORDER BY a.expires_at ASC`
);
const stmtGetAuctionById = db.prepare(
  `SELECT a.*, b.name AS badge_name, b.cost FROM auctions a JOIN badges b ON a.badge_id = b.id WHERE a.id = ?`
);
const stmtUpdateAuctionBid = db.prepare(
  `UPDATE auctions SET current_bid = ?, bidder_id = ? WHERE id = ?`
);
const stmtCloseAuction = db.prepare(
  `UPDATE auctions SET status = ? WHERE id = ?`
);
const stmtExpireAuctions = db.prepare(
  `UPDATE auctions SET status = 'expired' WHERE status = 'active' AND expires_at <= datetime('now')`
);

// Limited badges
const stmtGetLimitedBadges = db.prepare(
  `SELECT lb.*, b.name, b.description, b.color, b.bg_color, b.cost, b.type
   FROM limited_badges lb JOIN badges b ON lb.badge_id = b.id
   WHERE lb.remaining > 0 ORDER BY b.cost DESC`
);
const stmtDecrementLimitedBadge = db.prepare(
  `UPDATE limited_badges SET remaining = remaining - 1 WHERE badge_id = ? AND remaining > 0`
);

// Stats
const stmtGetUserPostStats = db.prepare(
  `SELECT user_id, COUNT(*) AS post_count, SUM(likes) AS total_likes,
          AVG(popularity_score) AS avg_score
   FROM posts GROUP BY user_id`
);
const stmtGetUserCommentCount = db.prepare(
  `SELECT user_id, COUNT(*) AS comment_count FROM comments GROUP BY user_id`
);
const stmtGetRecentPosts = db.prepare(
  `SELECT p.id, p.content, p.has_media, p.popularity_score, p.likes, p.created_at, u.username, p.thread_id
   FROM posts p JOIN users u ON p.user_id = u.id
   ORDER BY p.created_at DESC LIMIT ?`
);

// DB Info
const stmtGetTableCounts = db.prepare(
  `SELECT 'users' AS name, COUNT(*) AS count FROM users
   UNION ALL SELECT 'threads', COUNT(*) FROM threads
   UNION ALL SELECT 'posts', COUNT(*) FROM posts
   UNION ALL SELECT 'comments', COUNT(*) FROM comments
   UNION ALL SELECT 'reactions', COUNT(*) FROM reactions
   UNION ALL SELECT 'ai_memory', COUNT(*) FROM ai_memory
   UNION ALL SELECT 'ai_daily_summary', COUNT(*) FROM ai_daily_summary
   UNION ALL SELECT 'thread_summaries', COUNT(*) FROM thread_summaries
   UNION ALL SELECT 'user_points', COUNT(*) FROM user_points
   UNION ALL SELECT 'point_transactions', COUNT(*) FROM point_transactions
   UNION ALL SELECT 'badges', COUNT(*) FROM badges
   UNION ALL SELECT 'user_badges', COUNT(*) FROM user_badges
   UNION ALL SELECT 'popularity_points', COUNT(*) FROM popularity_points
   UNION ALL SELECT 'api_usage_log', COUNT(*) FROM api_usage_log
   UNION ALL SELECT 'anomaly_log', COUNT(*) FROM anomaly_log
   UNION ALL SELECT 'followers', COUNT(*) FROM followers
   UNION ALL SELECT 'pause_state', COUNT(*) FROM pause_state
   UNION ALL SELECT 'auto_management', COUNT(*) FROM auto_management
   UNION ALL SELECT 'tip_logs', COUNT(*) FROM tip_logs
   UNION ALL SELECT 'votes', COUNT(*) FROM votes
   UNION ALL SELECT 'personality_evolution', COUNT(*) FROM personality_evolution
   UNION ALL SELECT 'auctions', COUNT(*) FROM auctions`
);

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

// --- Users ---
export function insertUser(username, personality, tone) {
  const info = stmtInsertUser.run(username, personality, tone);
  return { id: info.lastInsertRowid };
}
export function getAllUsers() { return stmtGetAllUsers.all(); }
export function getUserById(id) { return stmtGetUserById.get(id); }
export function getUserCount() { return stmtGetUserCount.get().count; }

// --- Threads ---
export function insertThread(topic, starterId) {
  const info = stmtInsertThread.run(topic, starterId);
  return { id: info.lastInsertRowid };
}
export function getActiveThreads(limit = 10) { return stmtGetActiveThreads.all(limit); }
export function getAllThreadsList(limit = 50) { return stmtGetAllThreads.all(limit); }
export function getThreadsByPopularity(limit = 50) { return stmtGetThreadsByPopularity.all(limit); }
export function getThreadById(id) { return stmtGetThreadById.get(id); }
export function updateThreadActivity(threadId) { stmtUpdateThreadActivity.run(threadId); }
export function deactivateThread(threadId) { stmtDeactivateThread.run(threadId); }
export function getThreadPostCount(threadId) { return stmtGetThreadPostCount.get(threadId).count; }
export function incrementThreadViews(threadId) { stmtIncrementThreadViews.run(threadId); }
export function incrementThreadLikes(likes, threadId) { stmtIncrementThreadLikes.run(likes, threadId); }

// --- Posts ---
export function insertPost(userId, content, hasMedia, popularityScore, likes, threadId = null) {
  const info = stmtInsertPost.run(userId, threadId, content, hasMedia ? 1 : 0, popularityScore, likes);
  return { id: info.lastInsertRowid };
}
export function getTimeline(limit = 20, offset = 0) { return stmtGetTimeline.all(limit, offset); }
export function getPostById(id) { return stmtGetPostById.get(id); }
export function getPostsByThreadId(threadId) { return stmtGetPostsByThreadId.all(threadId); }
export function getPostCount() { return stmtGetPostCount.get().count; }
export function getRecentPostUserIds(n) { return stmtGetRecentPostUserIds.all(n).map(row => row.user_id); }

// --- Comments ---
export function insertComment(postId, userId, content) {
  const info = stmtInsertComment.run(postId, userId, content);
  return { id: info.lastInsertRowid };
}
export function getCommentsByPostId(postId) { return stmtGetCommentsByPostId.all(postId); }
export function getCommentCountByPostId(postId) { return stmtGetCommentCountByPostId.get(postId).count; }

// --- Reaction Chains ---
export function insertReaction(postId, userId, content, depth, parentId) {
  const info = stmtInsertReaction.run(postId, userId, content, depth, parentId || null);
  return { id: info.lastInsertRowid };
}
export function getReactionsByPostId(postId) { return stmtGetReactionsByPostId.all(postId); }
export function getReactionCountByPostId(postId) { return stmtGetReactionCountByPostId.get(postId).count; }

// --- AI Memory ---
export function insertMemory(userId, type, content, context = null) {
  const info = stmtInsertMemory.run(userId, type, content, context);
  return { id: info.lastInsertRowid };
}
export function getUserMemory(userId, limit = 10) { return stmtGetUserMemory.all(userId, limit); }
export function getUserMemoryByType(userId, type, limit = 5) { return stmtGetUserMemoryByType.all(userId, type, limit); }

// --- AI Daily Summary ---
export function insertDailySummary(date, summary, itemCount, modelUsed) {
  const info = stmtInsertDailySummary.run(date, summary, itemCount, modelUsed);
  return { id: info.lastInsertRowid };
}
export function getDailySummary(date) { return stmtGetDailySummary.get(date); }
export function getRecentDailySummaries(limit = 7) { return stmtGetRecentDailySummaries.all(limit); }
export function getRecentContentForSummary(sinceDate) {
  return stmtGetRecentContentForSummary.all(sinceDate, sinceDate, sinceDate);
}

// --- Thread Summaries ---
export function insertThreadSummary(threadId, summary, postCount, modelUsed) {
  const info = stmtInsertThreadSummary.run(threadId, summary, postCount, modelUsed);
  return { id: info.lastInsertRowid };
}
export function getThreadSummary(threadId) { return stmtGetThreadSummary.get(threadId); }
export function getRecentThreadSummaries(limit = 10) { return stmtGetRecentThreadSummaries.all(limit); }

// --- User Points ---
export function initUserPoints(userId) { stmtInitUserPoints.run(userId); }
export function getUserPoints(userId) { return stmtGetUserPoints.get(userId); }
export function getAllUserPoints() { return stmtGetAllUserPoints.all(); }
export function addPoints(userId, amount, type, description) {
  stmtAddPoints.run(amount, amount, userId);
  stmtInsertPointTransaction.run(userId, amount, type, description);
}
export function spendPoints(userId, amount, type, description) {
  const pts = stmtGetUserPoints.get(userId);
  if (!pts || pts.balance < amount) return false;
  stmtSpendPoints.run(amount, amount, userId);
  stmtInsertPointTransaction.run(userId, -amount, type, description);
  return true;
}
export function setDailyPointsTime(userId, dateStr) { stmtSetDailyAt.run(dateStr, userId); }
export function getUserTransactions(userId, limit = 20) { return stmtGetUserTransactions.all(userId, limit); }

// --- Badges ---
export function getAllBadges() { return stmtGetAllBadges.all(); }
export function getBadgeById(id) { return stmtGetBadgeById.get(id); }
export function grantBadge(userId, badgeId) { stmtInsertUserBadge.run(userId, badgeId); }
export function getUserBadges(userId) { return stmtGetUserBadges.all(userId); }
export function equipBadge(userId, badgeId, type) {
  stmtUnequipAllBadges.run(userId, type);
  stmtEquipBadge.run(userId, badgeId);
}
export function getEquippedBadges(userId) { return stmtGetEquippedBadges.all(userId); }

// --- Popularity Points ---
export function initPopularity(userId) { stmtInitPopularity.run(userId); }
export function addPopularity(userId, points) { stmtAddPopularity.run(points, userId); }
export function getPopularity(userId) { return stmtGetPopularity.get(userId); }
export function getAllPopularity() { return stmtGetAllPopularity.all(); }

// --- Tip Logs ---
export function insertTipLog(fromUserId, toUserId, amount, bonus, effectTier) {
  const info = stmtInsertTipLog.run(fromUserId, toUserId, amount, bonus, effectTier);
  return { id: info.lastInsertRowid };
}
export function getRecentTips(limit = 20) { return stmtGetRecentTips.all(limit); }
export function getUserReceivedTips(userId, limit = 10) { return stmtGetUserReceivedTips.all(userId, limit); }

// --- API Usage ---
export function incrementApiUsage() {
  const today = new Date().toISOString().slice(0, 10);
  stmtUpsertUsage.run(today);
}
export function getTodayApiUsage() {
  const today = new Date().toISOString().slice(0, 10);
  const row = stmtGetUsage.get(today);
  return row ? row.request_count : 0;
}
export function getUsageHistory(days = 7) { return stmtGetUsageHistory.all(days); }

export function insertUsageLog(model, feature, tokensIn = 0, tokensOut = 0, success = true, errorMsg = null) {
  stmtInsertUsageLog.run(model, feature, tokensIn, tokensOut, success ? 1 : 0, errorMsg);
}
export function getUsageLogToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetUsageLogToday.all(today + 'T00:00:00');
}
export function getRecentUsageLogs(limit = 20) { return stmtGetRecentUsageLogs.all(limit); }

export function insertAnomalyLog(type, model, feature, message, httpStatus = null) {
  stmtInsertAnomalyLog.run(type, model, feature, message, httpStatus);
}
export function getRecentAnomalies(limit = 30) { return stmtGetRecentAnomalies.all(limit); }
export function getAnomalyCountToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetAnomalyCountToday.all(today + 'T00:00:00');
}

export function getPauseState(feature) { return stmtGetPauseState.get(feature); }
export function getAllPauseStates() { return stmtGetAllPauseStates.all(); }
export function setPauseState(feature, paused, reason = null) {
  stmtSetPauseState.run(paused ? 1 : 0, paused ? new Date().toISOString() : null, reason, feature);
}
export function isFeaturePaused(feature) {
  const state = stmtGetPauseState.get(feature);
  return state ? state.paused === 1 : false;
}

export function upsertFollower(userId, followerCount) { stmtUpsertFollower.run(userId, followerCount, followerCount); }
export function getAllFollowers() { return stmtGetFollowers.all(); }
export function getFollowerByUserId(userId) { return stmtGetFollowerByUserId.get(userId); }

export function getAutoManagement(feature) { return stmtGetAutoMgmt.get(feature); }
export function getAllAutoManagement() { return stmtGetAllAutoMgmt.all(); }
export function setAutoManagement(feature, enabled) { stmtSetAutoMgmt.run(enabled ? 1 : 0, feature); }
export function isAutoManagementEnabled(feature) {
  const row = stmtGetAutoMgmt.get(feature);
  return row ? row.enabled === 1 : true;
}

export function getUserPostStats() { return stmtGetUserPostStats.all(); }
export function getUserCommentCounts() { return stmtGetUserCommentCount.all(); }
export function getRecentPosts(limit = 50) { return stmtGetRecentPosts.all(limit); }

export function getDbInfo() {
  const tables = stmtGetTableCounts.all();
  const fileSize = fs.existsSync(DB_PATH) ? fs.statSync(DB_PATH).size : 0;
  return {
    path: DB_PATH,
    fileSize,
    fileSizeHuman: fileSize < 1024 ? `${fileSize}B` :
                   fileSize < 1024*1024 ? `${(fileSize/1024).toFixed(1)}KB` :
                   `${(fileSize/1024/1024).toFixed(2)}MB`,
    tables: tables.reduce((acc, t) => { acc[t.name] = t.count; return acc; }, {}),
    journalMode: db.pragma('journal_mode', { simple: true }),
    foreignKeys: db.pragma('foreign_keys', { simple: true }),
  };
}

export function insertUsersTransaction(users) {
  const transaction = db.transaction((userList) => {
    for (const u of userList) {
      stmtInsertUser.run(u.username, u.personality, u.tone);
    }
  });
  transaction(users);
}

// Initialize points for all existing users
export function initAllUserPoints() {
  const users = getAllUsers();
  for (const u of users) {
    initUserPoints(u.id);
    initPopularity(u.id);
  }
}

// Daily point grant (100 points per user at midnight)
export function grantDailyPoints() {
  const today = new Date().toISOString().slice(0, 10);
  const users = getAllUsers();
  let granted = 0;
  for (const u of users) {
    initUserPoints(u.id);
    const pts = getUserPoints(u.id);
    if (!pts.last_daily_at || pts.last_daily_at !== today) {
      addPoints(u.id, 100, 'daily_login', `デイリーボーナス (${today})`);
      setDailyPointsTime(u.id, today);
      granted++;
    }
  }
  return granted;
}

// --- Votes ---
export function insertVote(threadId, userId, voteType) {
  stmtInsertVote.run(threadId, userId, voteType, voteType);
}
export function getVotesByThread(threadId) {
  const rows = stmtGetVotesByThread.all(threadId);
  const result = { agree: 0, disagree: 0, neutral: 0 };
  for (const r of rows) result[r.vote_type] = r.count;
  return result;
}
export function getVoteDetail(threadId) { return stmtGetVoteDetail.all(threadId); }
export function getUserVote(threadId, userId) {
  const row = stmtGetUserVote.get(threadId, userId);
  return row ? row.vote_type : null;
}

// --- Personality Evolution ---
export function updateUserPersonality(userId, personality, tone) {
  stmtUpdateUserPersonality.run(personality, tone, userId);
}
export function insertPersonalityEvolution(userId, oldP, newP, oldT, newT, triggerType, triggerDetail) {
  stmtInsertPersonalityEvolution.run(userId, oldP, newP, oldT, newT, triggerType, triggerDetail);
}
export function getPersonalityHistory(userId, limit = 10) { return stmtGetPersonalityHistory.all(userId, limit); }

// --- Economy ---
export function getEconomyState() { return stmtGetEconomyState.get(); }
export function updateEconomyState(inflationRate, totalSupply, totalSpent) {
  stmtUpdateEconomyState.run(inflationRate, totalSupply, totalSpent);
}
export function resetSeason() { stmtResetSeason.run(); }

// --- Auctions ---
export function insertAuction(badgeId, sellerId, minBid, expiresAt) {
  const info = stmtInsertAuction.run(badgeId, sellerId, minBid, expiresAt);
  return { id: info.lastInsertRowid };
}
export function getActiveAuctions() { return stmtGetActiveAuctions.all(); }
export function getAuctionById(id) { return stmtGetAuctionById.get(id); }
export function updateAuctionBid(id, bid, bidderId) { stmtUpdateAuctionBid.run(bid, bidderId, id); }
export function closeAuction(id, status) { stmtCloseAuction.run(status, id); }
export function expireAuctions() { return stmtExpireAuctions.run(); }
export function getLimitedBadges() { return stmtGetLimitedBadges.all(); }
export function decrementLimitedBadge(badgeId) { return stmtDecrementLimitedBadge.run(badgeId); }

export function closeDatabase() { db.close(); }

export default db;
