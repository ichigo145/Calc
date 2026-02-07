// ===========================================================================
// database.js - SQLite database initialization and access layer (A-Talk)
// ===========================================================================
// - SQLite via better-sqlite3 (synchronous, no external server)
// - All tables created on first run
// - DB file stored at ./data/atalk.db
// - This module is the ONLY module that touches the database
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

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
// Enforce foreign keys
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
    popularity_score INTEGER NOT NULL CHECK(popularity_score >= 0 AND popularity_score <= 100),
    likes            INTEGER NOT NULL DEFAULT 0,
    created_at       TEXT    NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id) REFERENCES users(id)
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
// AI同士の会話チェーン。人気投稿のコメント欄で
// AIユーザーが連鎖的に反応する「リアクションチェーン」を保存。
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
// Table: api_usage
// ---------------------------------------------------------------------------
db.exec(`
  CREATE TABLE IF NOT EXISTS api_usage (
    date           TEXT    PRIMARY KEY,
    request_count  INTEGER NOT NULL DEFAULT 0
  );
`);

// ---------------------------------------------------------------------------
// Indexes
// ---------------------------------------------------------------------------
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_posts_created_at ON posts(created_at DESC);
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_comments_post_id ON comments(post_id);
`);
db.exec(`
  CREATE INDEX IF NOT EXISTS idx_reactions_post_id ON reactions(post_id);
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
  `INSERT INTO posts (user_id, content, popularity_score, likes) VALUES (?, ?, ?, ?)`
);
const stmtGetTimeline = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.content, p.popularity_score, p.likes, p.created_at
   FROM posts p
   JOIN users u ON p.user_id = u.id
   ORDER BY p.created_at DESC
   LIMIT ? OFFSET ?`
);
const stmtGetPostById = db.prepare(
  `SELECT p.id, p.user_id, u.username, p.content, p.popularity_score, p.likes, p.created_at
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

// Reactions (Reaction Chains)
const stmtInsertReaction = db.prepare(
  `INSERT INTO reactions (post_id, user_id, content, depth, parent_id) VALUES (?, ?, ?, ?, ?)`
);
const stmtGetReactionsByPostId = db.prepare(
  `SELECT r.id, r.post_id, r.user_id, u.username, r.content, r.depth, r.parent_id, r.created_at
   FROM reactions r
   JOIN users u ON r.user_id = u.id
   WHERE r.post_id = ?
   ORDER BY r.created_at ASC`
);
const stmtGetReactionCountByPostId = db.prepare(
  `SELECT COUNT(*) AS count FROM reactions WHERE post_id = ?`
);

// API Usage
const stmtUpsertUsage = db.prepare(
  `INSERT INTO api_usage (date, request_count) VALUES (?, 1)
   ON CONFLICT(date) DO UPDATE SET request_count = request_count + 1`
);
const stmtGetUsage = db.prepare(
  `SELECT request_count FROM api_usage WHERE date = ?`
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

export function insertPost(userId, content, popularityScore, likes) {
  const info = stmtInsertPost.run(userId, content, popularityScore, likes);
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

// --- Reaction Chains ---

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
