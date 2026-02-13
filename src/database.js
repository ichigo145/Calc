// ===========================================================================
// database.js - SQLite database initialization and access layer (A-Talk v3.2)
// ===========================================================================
// v3.2 Changes:
//   - threads table: bulletin-board style topic threads
//   - auto_management table: ON/OFF toggles for auto-management features
//   - conversation continuity: posts belong to topic threads
//   - Posts can be either thread-starters or thread-replies
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
// Table: threads - 掲示板スレッド (トピック単位の会話)
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS threads (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    topic       TEXT    NOT NULL,
    starter_id  INTEGER NOT NULL,
    post_count  INTEGER NOT NULL DEFAULT 1,
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

// Migration: add thread_id and has_media columns if not exists
try { db.exec(`ALTER TABLE posts ADD COLUMN thread_id INTEGER REFERENCES threads(id)`); } catch (e) { /* exists */ }
try { db.exec(`ALTER TABLE posts ADD COLUMN has_media INTEGER NOT NULL DEFAULT 1`); } catch (e) { /* exists */ }

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
// Table: reactions (Reaction Chains) - DETERMINISTIC ORDER: depth ASC, id ASC
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
// Table: ai_daily_summary - 日次AI要約 (~700文字, Pro only)
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
// Table: followers
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
// Table: auto_management - 自動管理機能のON/OFF設定
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS auto_management (
    feature     TEXT PRIMARY KEY,
    enabled     INTEGER NOT NULL DEFAULT 1,
    updated_at  TEXT    NOT NULL DEFAULT (datetime('now'))
  );
`);

// Initialize default auto-management settings
const autoMgmtDefaults = [
  'auto_rate_adjust',       // API使用頻度の自動調整
  'auto_follower_recalc',   // フォロワー再計算 (1分間隔)
  'auto_pause_resume',      // APIログ監視による自動停止/復帰
];
const stmtInitAutoMgmt = db.prepare(
  `INSERT OR IGNORE INTO auto_management (feature, enabled) VALUES (?, 1)`
);
for (const f of autoMgmtDefaults) {
  stmtInitAutoMgmt.run(f);
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
  CREATE INDEX IF NOT EXISTS idx_dm_users ON direct_messages(from_user_id, to_user_id);
  CREATE INDEX IF NOT EXISTS idx_anomaly_log_created ON anomaly_log(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON ai_daily_summary(date DESC);
  CREATE INDEX IF NOT EXISTS idx_threads_active ON threads(is_active, last_post_at DESC);
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
          t.post_count, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   WHERE t.is_active = 1
   ORDER BY t.last_post_at DESC
   LIMIT ?`
);
const stmtGetAllThreads = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.last_post_at, t.is_active, t.created_at
   FROM threads t
   JOIN users u ON t.starter_id = u.id
   ORDER BY t.last_post_at DESC
   LIMIT ?`
);
const stmtGetThreadById = db.prepare(
  `SELECT t.id, t.topic, t.starter_id, u.username AS starter_username,
          t.post_count, t.last_post_at, t.is_active, t.created_at
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

// DM一括閲覧
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

// Reactions (DETERMINISTIC: depth ASC, id ASC)
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

// API Usage Log
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

// Auto Management
const stmtGetAutoMgmt = db.prepare(
  `SELECT feature, enabled, updated_at FROM auto_management WHERE feature = ?`
);
const stmtGetAllAutoMgmt = db.prepare(
  `SELECT feature, enabled, updated_at FROM auto_management ORDER BY feature`
);
const stmtSetAutoMgmt = db.prepare(
  `UPDATE auto_management SET enabled = ?, updated_at = datetime('now') WHERE feature = ?`
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

// Trending: recent posts content
const stmtGetRecentPosts = db.prepare(
  `SELECT p.id, p.content, p.has_media, p.popularity_score, p.likes, p.created_at, u.username, p.thread_id
   FROM posts p JOIN users u ON p.user_id = u.id
   ORDER BY p.created_at DESC LIMIT ?`
);

// DB Info/Stats
const stmtGetTableCounts = db.prepare(
  `SELECT 'users' AS name, COUNT(*) AS count FROM users
   UNION ALL SELECT 'threads', COUNT(*) FROM threads
   UNION ALL SELECT 'posts', COUNT(*) FROM posts
   UNION ALL SELECT 'comments', COUNT(*) FROM comments
   UNION ALL SELECT 'direct_messages', COUNT(*) FROM direct_messages
   UNION ALL SELECT 'reactions', COUNT(*) FROM reactions
   UNION ALL SELECT 'ai_memory', COUNT(*) FROM ai_memory
   UNION ALL SELECT 'ai_daily_summary', COUNT(*) FROM ai_daily_summary
   UNION ALL SELECT 'api_usage_log', COUNT(*) FROM api_usage_log
   UNION ALL SELECT 'anomaly_log', COUNT(*) FROM anomaly_log
   UNION ALL SELECT 'followers', COUNT(*) FROM followers
   UNION ALL SELECT 'pause_state', COUNT(*) FROM pause_state
   UNION ALL SELECT 'auto_management', COUNT(*) FROM auto_management`
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
export function getThreadById(id) { return stmtGetThreadById.get(id); }
export function updateThreadActivity(threadId) { stmtUpdateThreadActivity.run(threadId); }
export function deactivateThread(threadId) { stmtDeactivateThread.run(threadId); }
export function getThreadPostCount(threadId) { return stmtGetThreadPostCount.get(threadId).count; }

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

// --- Direct Messages ---
export function insertDM(fromUserId, toUserId, content) {
  const info = stmtInsertDM.run(fromUserId, toUserId, content);
  return { id: info.lastInsertRowid };
}
export function getDMThread(userA, userB, limit = 50, offset = 0) {
  return stmtGetDMThread.all(userA, userB, userB, userA, limit, offset);
}
export function getAllDMThreads() { return stmtGetAllDMThreads.all(); }
export function getAllDMs(limit = 200) { return stmtGetAllDMs.all(limit); }

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

// --- API Usage Log ---
export function insertUsageLog(model, feature, tokensIn = 0, tokensOut = 0, success = true, errorMsg = null) {
  stmtInsertUsageLog.run(model, feature, tokensIn, tokensOut, success ? 1 : 0, errorMsg);
}
export function getUsageLogToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetUsageLogToday.all(today + 'T00:00:00');
}
export function getRecentUsageLogs(limit = 20) { return stmtGetRecentUsageLogs.all(limit); }

// --- Anomaly Log ---
export function insertAnomalyLog(type, model, feature, message, httpStatus = null) {
  stmtInsertAnomalyLog.run(type, model, feature, message, httpStatus);
}
export function getRecentAnomalies(limit = 30) { return stmtGetRecentAnomalies.all(limit); }
export function getAnomalyCountToday() {
  const today = new Date().toISOString().slice(0, 10);
  return stmtGetAnomalyCountToday.all(today + 'T00:00:00');
}

// --- Pause State ---
export function getPauseState(feature) { return stmtGetPauseState.get(feature); }
export function getAllPauseStates() { return stmtGetAllPauseStates.all(); }
export function setPauseState(feature, paused, reason = null) {
  stmtSetPauseState.run(paused ? 1 : 0, paused ? new Date().toISOString() : null, reason, feature);
}
export function isFeaturePaused(feature) {
  const state = stmtGetPauseState.get(feature);
  return state ? state.paused === 1 : false;
}

// --- Followers ---
export function upsertFollower(userId, followerCount) { stmtUpsertFollower.run(userId, followerCount, followerCount); }
export function getAllFollowers() { return stmtGetFollowers.all(); }
export function getFollowerByUserId(userId) { return stmtGetFollowerByUserId.get(userId); }

// --- Auto Management ---
export function getAutoManagement(feature) { return stmtGetAutoMgmt.get(feature); }
export function getAllAutoManagement() { return stmtGetAllAutoMgmt.all(); }
export function setAutoManagement(feature, enabled) { stmtSetAutoMgmt.run(enabled ? 1 : 0, feature); }
export function isAutoManagementEnabled(feature) {
  const row = stmtGetAutoMgmt.get(feature);
  return row ? row.enabled === 1 : true;
}

// --- Stats ---
export function getUserPostStats() { return stmtGetUserPostStats.all(); }
export function getUserCommentCounts() { return stmtGetUserCommentCount.all(); }
export function getRecentPosts(limit = 50) { return stmtGetRecentPosts.all(limit); }

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

export function closeDatabase() { db.close(); }

export default db;
