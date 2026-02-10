// ===========================================================================
// database.js - SQLite database initialization and access layer (A-Talk v3.1)
// ===========================================================================
// v3.1 Changes:
//   - anomaly_log: API異常ログ (HTTP エラー、ネットワークエラー等)
//   - ai_daily_summary: 日次AI要約 (~700文字) の保存・参照
//   - reactions: deterministic ordering (ORDER BY depth ASC, id ASC)
//   - DB info/stats queries for admin viewing
//   - DM bulk viewing: full thread content retrieval
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
// Table: posts
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS posts (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id          INTEGER NOT NULL,
    content          TEXT    NOT NULL,
    has_media        INTEGER NOT NULL DEFAULT 1,
    popularity_score INTEGER NOT NULL CHECK(popularity_score >= 0 AND popularity_score <= 100),
    likes            INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// Add has_media column if not exists (migration for existing DB)
try {
  db.exec(`ALTER TABLE posts ADD COLUMN has_media INTEGER NOT NULL DEFAULT 1`);
} catch (e) {
  // Column already exists - ignore
}

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
// Table: direct_messages
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS direct_messages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    from_user_id  INTEGER NOT NULL,
    to_user_id    INTEGER NOT NULL,
    content       TEXT    NOT NULL,
    created_at    TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (from_user_id) REFERENCES users(id),
    FOREIGN KEY (to_user_id)   REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Table: reactions (Reaction Chains feature)
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
// Table: ai_memory - AIが過去の履歴を参照できるコンテキストDB
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
// Table: ai_daily_summary - 日次AI要約 (~700文字)
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
// Table: api_usage (日次集計)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    date           TEXT    PRIMARY KEY,
    request_count  INTEGER NOT NULL DEFAULT 0
  );
`);

// ---------------------------------------------------------------------------
// Table: api_usage_log - モデル別の詳細ログ
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Table: anomaly_log - API異常ログ
// ---------------------------------------------------------------------------
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

// ---------------------------------------------------------------------------
// Table: pause_state - API自動制御の一時停止状態
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS pause_state (
    feature    TEXT PRIMARY KEY,
    paused     INTEGER NOT NULL DEFAULT 0,
    paused_at  TEXT,
    reason     TEXT
  );
`);

// Initialize default pause states
const defaultFeatures = ['post_generation', 'comment_generation', 'dm_generation', 'reaction_chain'];
const stmtInitPause = db.prepare(
  `INSERT OR IGNORE INTO pause_state (feature, paused) VALUES (?, 0)`
);
for (const f of defaultFeatures) {
  stmtInitPause.run(f);
}

// ---------------------------------------------------------------------------
// Table: followers - フォロワー予測結果のキャッシュ
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS followers (
    user_id         INTEGER PRIMARY KEY,
    follower_count  INTEGER NOT NULL DEFAULT 0,
    computed_at     TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
`);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_reactions_post_id ON reactions(post_id);
  CREATE INDEX IF NOT EXISTS idx_ai_memory_user_id ON ai_memory(user_id);
  CREATE INDEX IF NOT EXISTS idx_ai_memory_type ON ai_memory(type);
  CREATE INDEX IF NOT EXISTS idx_api_usage_log_created ON api_usage_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_dm_users ON direct_messages(from_user_id, to_user_id);
  CREATE INDEX IF NOT EXISTS idx_anomaly_log_created ON anomaly_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON ai_daily_summary(date DESC);
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

// Posts
const stmtInsertPost = db.prepare(
  `INSERT INTO posts (user_id, content, has_media, popularity_score, likes) VALUES (?, ?, ?, ?, ?)`
);
const stmtGetTimeline = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.content, p.has_media, p.popularity_score, p.likes, p.created_at
   FROM posts p
   JOIN users u ON p.user_id = u.id
   ORDER BY p.created_at DESC
   LIMIT ? OFFSET ?`
);
const stmtGetPostById = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.content, p.has_media, p.popularity_score, p.likes, p.created_at
   FROM posts p
   JOIN users u ON p.user_id = u.id
   WHERE p.id = ?`
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

// Direct Messages
const stmtInsertDM = db.prepare(
  `INSERT INTO direct_messages (from_user_id, to_user_id, content) VALUES (?, ?, ?)`
);
const stmtGetDMThread = db.prepare(
  `SELECT dm.id, dm.from_user_id, uf.username AS from_username,
          dm.to_user_id, ut.username AS to_username,
          dm.content, dm.created_at
   FROM direct_messages dm
   JOIN users uf ON dm.from_user_id = uf.id
   JOIN users ut ON dm.to_user_id  = ut.id
   WHERE (dm.from_user_id = ? AND dm.to_user_id = ?)
      OR (dm.from_user_id = ? AND dm.to_user_id = ?)
   ORDER BY dm.created_at ASC
   LIMIT ? OFFSET ?`
);

// DM一括閲覧用: 全DMスレッド一覧
const stmtGetAllDMThreads = db.prepare(
  `SELECT
     CASE WHEN dm.from_user_id < dm.to_user_id THEN dm.from_user_id ELSE dm.to_user_id END AS user_a,
     CASE WHEN dm.from_user_id < dm.to_user_id THEN dm.to_user_id ELSE dm.from_user_id END AS user_b,
     COUNT(*) AS message_count,
     MAX(dm.created_at) AS last_message_at
   FROM direct_messages dm
   GROUP BY user_a, user_b
   ORDER BY last_message_at DESC`
);

// DM一括閲覧: 全DMメッセージ取得 (一画面統合表示用)
const stmtGetAllDMs = db.prepare(
  `SELECT dm.id, dm.from_user_id, uf.username AS from_username,
          dm.to_user_id, ut.username AS to_username,
          dm.content, dm.created_at
   FROM direct_messages dm
   JOIN users uf ON dm.from_user_id = uf.id
   JOIN users ut ON dm.to_user_id  = ut.id
   ORDER BY dm.created_at DESC
   LIMIT ?`
);

// Reactions (Reaction Chains) - DETERMINISTIC ORDER: depth ASC, id ASC
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
// Get recent content for summarization (last 500 items across tables)
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

// API Usage (daily)
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

// API Usage Log (per-request detail)
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

// Anomaly Log
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

// Pause State
const stmtGetPauseState = db.prepare(
  `SELECT feature, paused, paused_at, reason FROM pause_state WHERE feature = ?`
);
const stmtGetAllPauseStates = db.prepare(
  `SELECT feature, paused, paused_at, reason FROM pause_state ORDER BY feature`
);
const stmtSetPauseState = db.prepare(
  `UPDATE pause_state SET paused = ?, paused_at = ?, reason = ? WHERE feature = ?`
);

// Followers
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

// Stats queries
const stmtGetUserPostStats = db.prepare(
  `SELECT user_id, COUNT(*) AS post_count, SUM(likes) AS total_likes,
          AVG(popularity_score) AS avg_score
   FROM posts GROUP BY user_id`
);
const stmtGetUserCommentCount = db.prepare(
  `SELECT user_id, COUNT(*) AS comment_count FROM comments GROUP BY user_id`
);

// Trending: most active topics (by recent posts content patterns)
const stmtGetRecentPosts = db.prepare(
  `SELECT p.id, p.content, p.has_media, p.popularity_score, p.likes, p.created_at, u.username
   FROM posts p JOIN users u ON p.user_id = u.id
   ORDER BY p.created_at DESC LIMIT ?`
);

// DB Info/Stats (for admin viewing)
const stmtGetTableCounts = db.prepare(
  `SELECT 'users' AS name, COUNT(*) AS count FROM users
   UNION ALL SELECT 'posts', COUNT(*) FROM posts
   UNION ALL SELECT 'comments', COUNT(*) FROM comments
   UNION ALL SELECT 'direct_messages', COUNT(*) FROM direct_messages
   UNION ALL SELECT 'reactions', COUNT(*) FROM reactions
   UNION ALL SELECT 'ai_memory', COUNT(*) FROM ai_memory
   UNION ALL SELECT 'ai_daily_summary', COUNT(*) FROM ai_daily_summary
   UNION ALL SELECT 'api_usage_log', COUNT(*) FROM api_usage_log
   UNION ALL SELECT 'anomaly_log', COUNT(*) FROM anomaly_log
   UNION ALL SELECT 'followers', COUNT(*) FROM followers
   UNION ALL SELECT 'pause_state', COUNT(*) FROM pause_state`
);

// ---------------------------------------------------------------------------
// Exported functions
// ---------------------------------------------------------------------------

export function insertUser(username, personality, tone) {
  const info = stmtInsertUser.run(username, personality, tone);
  return { id: info.lastInsertRowid };
}
export function getAllUsers() {
  return stmtGetAllUsers.all();
}
export function getUserById(id) {
  return stmtGetUserById.get(id);
}
export function getUserCount() {
  return stmtGetUserCount.get().count;
}

export function insertPost(userId, content, hasMedia, popularityScore, likes) {
  const info = stmtInsertPost.run(userId, content, hasMedia ? 1 : 0, popularityScore, likes);
  return { id: info.lastInsertRowid };
}
export function getTimeline(limit = 20, offset = 0) {
  return stmtGetTimeline.all(limit, offset);
}
export function getPostById(id) {
  return stmtGetPostById.get(id);
}
export function getPostCount() {
  return stmtGetPostCount.get().count;
}
export function getRecentPostUserIds(n) {
  return stmtGetRecentPostUserIds.all(n).map(row => row.user_id);
}

export function insertComment(postId, userId, content) {
  const info = stmtInsertComment.run(postId, userId, content);
  return { id: info.lastInsertRowid };
}
export function getCommentsByPostId(postId) {
  return stmtGetCommentsByPostId.all(postId);
}
export function getCommentCountByPostId(postId) {
  return stmtGetCommentCountByPostId.get(postId).count;
}

export function insertDM(fromUserId, toUserId, content) {
  const info = stmtInsertDM.run(fromUserId, toUserId, content);
  return { id: info.lastInsertRowid };
}
export function getDMThread(userA, userB, limit = 50, offset = 0) {
  return stmtGetDMThread.all(userA, userB, userB, userA, limit, offset);
}
export function getAllDMThreads() {
  return stmtGetAllDMThreads.all();
}
export function getAllDMs(limit = 200) {
  return stmtGetAllDMs.all(limit);
}

// --- Reaction Chains (DETERMINISTIC ORDER: depth ASC, id ASC) ---
export function insertReaction(postId, userId, content, depth, parentId) {
  const info = stmtInsertReaction.run(postId, userId, content, depth, parentId || null);
  return { id: info.lastInsertRowid };
}
export function getReactionsByPostId(postId) {
  return stmtGetReactionsByPostId.all(postId);
}
export function getReactionCountByPostId(postId) {
  return stmtGetReactionCountByPostId.get(postId).count;
}

// --- AI Memory ---
export function insertMemory(userId, type, content, context = null) {
  const info = stmtInsertMemory.run(userId, type, content, context);
  return { id: info.lastInsertRowid };
}
export function getUserMemory(userId, limit = 10) {
  return stmtGetUserMemory.all(userId, limit);
}
export function getUserMemoryByType(userId, type, limit = 5) {
  return stmtGetUserMemoryByType.all(userId, type, limit);
}

// --- AI Daily Summary ---
export function insertDailySummary(date, summary, itemCount, modelUsed) {
  const info = stmtInsertDailySummary.run(date, summary, itemCount, modelUsed);
  return { id: info.lastInsertRowid };
}
export function getDailySummary(date) {
  return stmtGetDailySummary.get(date);
}
export function getRecentDailySummaries(limit = 7) {
  return stmtGetRecentDailySummaries.all(limit);
}
export function getRecentContentForSummary(sinceDate) {
  return stmtGetRecentContentForSummary.all(sinceDate, sinceDate, sinceDate);
}

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
export function getUsageHistory(days = 7) {
  return stmtGetUsageHistory.all(days);
}

// --- API Usage Log ---
export function insertUsageLog(model, feature, tokensIn = 0, tokensOut = 0, success = true, errorMsg = null) {
  stmtInsertUsageLog.run(model, feature, tokensIn, tokensOut, success ? 1 : 0, errorMsg);
}
export function getUsageLogToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetUsageLogToday.all(today + 'T00:00:00');
}
export function getRecentUsageLogs(limit = 20) {
  return stmtGetRecentUsageLogs.all(limit);
}

// --- Anomaly Log ---
export function insertAnomalyLog(type, model, feature, message, httpStatus = null) {
  stmtInsertAnomalyLog.run(type, model, feature, message, httpStatus);
}
export function getRecentAnomalies(limit = 30) {
  return stmtGetRecentAnomalies.all(limit);
}
export function getAnomalyCountToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetAnomalyCountToday.all(today + 'T00:00:00');
}

// --- Pause State ---
export function getPauseState(feature) {
  return stmtGetPauseState.get(feature);
}
export function getAllPauseStates() {
  return stmtGetAllPauseStates.all();
}
export function setPauseState(feature, paused, reason = null) {
  stmtSetPauseState.run(
    paused ? 1 : 0,
    paused ? new Date().toISOString() : null,
    reason,
    feature
  );
}
export function isFeaturePaused(feature) {
  const state = stmtGetPauseState.get(feature);
  return state ? state.paused === 1 : false;
}

// --- Followers ---
export function upsertFollower(userId, followerCount) {
  stmtUpsertFollower.run(userId, followerCount, followerCount);
}
export function getAllFollowers() {
  return stmtGetFollowers.all();
}
export function getFollowerByUserId(userId) {
  return stmtGetFollowerByUserId.get(userId);
}

// --- Stats ---
export function getUserPostStats() {
  return stmtGetUserPostStats.all();
}
export function getUserCommentCounts() {
  return stmtGetUserCommentCount.all();
}
export function getRecentPosts(limit = 50) {
  return stmtGetRecentPosts.all(limit);
}

// --- DB Info (Admin) ---
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

// --- Transaction helpers ---
export function insertUsersTransaction(users) {
  const transaction = db.transaction((userList) => {
    for (const u of userList) {
      stmtInsertUser.run(u.username, u.personality, u.tone);
    }
  });
  transaction(users);
}

export function closeDatabase() {
  db.close();
}

export default db;
