// ===========================================================================
// routes.js - REST API endpoints (A-Talk v3.2)
// ===========================================================================
// v3.2 新エンドポイント:
//   GET  /api/threads               スレッド一覧
//   GET  /api/threads/:id           スレッド詳細 (投稿一覧)
//   GET  /api/auto-management       自動管理設定の取得
//   POST /api/auto-management       自動管理設定の変更
// ===========================================================================

import { Router } from 'express';
import express from 'express';
import {
  getTimeline, getPostById, getPostCount,
  getAllUsers, getUserById, getUserCount,
  getCommentsByPostId, getReactionsByPostId,
  getAllDMThreads, getAllDMs,
  getUserMemory, getRecentPosts,
  getFollowerByUserId, getUserPostStats, getUserCommentCounts,
  getDbInfo, getRecentAnomalies, getAnomalyCountToday,
  getRecentDailySummaries, getRecentUsageLogs, getUsageHistory, getUsageLogToday,
  getDMThread,
  getAllThreadsList, getThreadById, getPostsByThreadId, getActiveThreads,
  getAllAutoManagement,
} from './database.js';
import { getQuotaStatus, getModelsInfo, validateApiKey, MODEL_RATE_LIMITS, getSummaryUsage } from './gemini-client.js';
import { generateCommentsForPost, generateDMThread, generateReactionChain } from './comment-generator.js';
import { getDashboardData, manualPause, manualResume, pauseAll, resumeAll, toggleAutoManagement } from './api-controller.js';
import { computeAllFollowers, getCachedFollowers } from './follower-calculator.js';

const router = Router();
router.use(express.json());

// ---------------------------------------------------------------------------
// GET /api/timeline
// ---------------------------------------------------------------------------
router.get('/api/timeline', (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    let offset = parseInt(req.query.offset, 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 50) limit = 50;
    if (isNaN(offset) || offset < 0) offset = 0;

    const posts = getTimeline(limit, offset);
    const total = getPostCount();

    res.json({
      posts,
      pagination: { limit, offset, total, hasMore: offset + posts.length < total },
    });
  } catch (error) {
    console.error('[routes] /api/timeline error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/threads - スレッド一覧
// ---------------------------------------------------------------------------
router.get('/api/threads', (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    const activeOnly = req.query.active !== 'false';

    const threads = activeOnly ? getActiveThreads(limit) : getAllThreadsList(limit);
    res.json({ threads });
  } catch (error) {
    console.error('[routes] /api/threads error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/threads/:id - スレッド詳細 (全投稿)
// ---------------------------------------------------------------------------
router.get('/api/threads/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid thread ID' });

    const thread = getThreadById(id);
    if (!thread) return res.status(404).json({ error: 'Thread not found' });

    const posts = getPostsByThreadId(id);
    res.json({ thread, posts });
  } catch (error) {
    console.error('[routes] /api/threads/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id
// ---------------------------------------------------------------------------
router.get('/api/posts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid post ID' });

    const post = getPostById(id);
    if (!post) return res.status(404).json({ error: 'Post not found' });

    const comments = getCommentsByPostId(id);
    const reactions = getReactionsByPostId(id);

    // Include thread info if available
    let thread = null;
    if (post.thread_id) {
      thread = getThreadById(post.thread_id);
    }

    res.json({ post, comments, reactions, thread });
  } catch (error) {
    console.error('[routes] /api/posts/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id/comments
// ---------------------------------------------------------------------------
router.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid post ID' });

    const result = await generateCommentsForPost(id);
    if (!result.success && result.error === 'Post not found') {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json({
      comments: result.comments || [],
      generated: result.success,
      error: result.error || null,
    });
  } catch (error) {
    console.error('[routes] /api/posts/:id/comments error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id/reactions
// ---------------------------------------------------------------------------
router.get('/api/posts/:id/reactions', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid post ID' });

    const result = await generateReactionChain(id);
    if (!result.success && result.error === 'Post not found') {
      return res.status(404).json({ error: 'Post not found' });
    }

    res.json({
      reactions: result.reactions || [],
      chainGenerated: result.chainGenerated || false,
      error: result.error || null,
    });
  } catch (error) {
    console.error('[routes] /api/posts/:id/reactions error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users
// ---------------------------------------------------------------------------
router.get('/api/users', (req, res) => {
  try {
    const users = getAllUsers();
    const postStatsArr = getUserPostStats();
    const commentCountsArr = getUserCommentCounts();

    const postStatsMap = new Map();
    for (const s of postStatsArr) postStatsMap.set(s.user_id, s);
    const commentCountMap = new Map();
    for (const c of commentCountsArr) commentCountMap.set(c.user_id, c.comment_count);

    const publicUsers = users.map(u => {
      const stats = postStatsMap.get(u.id);
      const follower = getFollowerByUserId(u.id);
      return {
        id: u.id, username: u.username, created_at: u.created_at,
        post_count: stats?.post_count || 0,
        total_likes: stats?.total_likes || 0,
        avg_score: Math.round((stats?.avg_score || 0) * 10) / 10,
        comment_count: commentCountMap.get(u.id) || 0,
        follower_count: follower?.follower_count || 0,
      };
    });
    res.json({ users: publicUsers });
  } catch (error) {
    console.error('[routes] /api/users error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/users/:id
// ---------------------------------------------------------------------------
router.get('/api/users/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: 'Invalid user ID' });

    const user = getUserById(id);
    if (!user) return res.status(404).json({ error: 'User not found' });

    const postStatsArr = getUserPostStats();
    const stats = postStatsArr.find(s => s.user_id === id);
    const commentCountsArr = getUserCommentCounts();
    const cc = commentCountsArr.find(c => c.user_id === id);
    const follower = getFollowerByUserId(id);

    res.json({
      user: {
        id: user.id, username: user.username, personality: user.personality,
        tone: user.tone, created_at: user.created_at,
        post_count: stats?.post_count || 0, total_likes: stats?.total_likes || 0,
        avg_score: Math.round((stats?.avg_score || 0) * 10) / 10,
        comment_count: cc?.comment_count || 0,
        follower_count: follower?.follower_count || 0,
      },
    });
  } catch (error) {
    console.error('[routes] /api/users/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/followers
// ---------------------------------------------------------------------------
router.get('/api/followers', (req, res) => {
  try { res.json({ followers: getCachedFollowers() }); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/followers/compute', (req, res) => {
  try { res.json({ success: true, followers: computeAllFollowers() }); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// DM endpoints
// ---------------------------------------------------------------------------
router.get('/api/dm/:userA/:userB', async (req, res) => {
  try {
    const userAId = parseInt(req.params.userA, 10);
    const userBId = parseInt(req.params.userB, 10);
    if (isNaN(userAId) || isNaN(userBId) || userAId < 1 || userBId < 1) {
      return res.status(400).json({ error: 'Invalid user IDs' });
    }
    if (userAId === userBId) return res.status(400).json({ error: 'Cannot DM yourself' });

    const result = await generateDMThread(userAId, userBId);
    res.json({ messages: result.messages || [], generated: result.success });
  } catch (error) {
    console.error('[routes] /api/dm error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/dm/threads', (req, res) => {
  try {
    const threads = getAllDMThreads();
    const allUsers = getAllUsers();
    const userMap = new Map();
    for (const u of allUsers) userMap.set(u.id, u.username);

    res.json({
      threads: threads.map(t => ({
        userA: t.user_a, userB: t.user_b,
        usernameA: userMap.get(t.user_a) || '???',
        usernameB: userMap.get(t.user_b) || '???',
        messageCount: t.message_count, lastMessageAt: t.last_message_at,
      })),
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/dm/all', (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 200;
    if (limit > 500) limit = 500;

    const messages = getAllDMs(limit);
    const allUsers = getAllUsers();
    const userMap = new Map();
    for (const u of allUsers) userMap.set(u.id, u.username);

    const threadMap = new Map();
    for (const msg of messages) {
      const keyA = Math.min(msg.from_user_id, msg.to_user_id);
      const keyB = Math.max(msg.from_user_id, msg.to_user_id);
      const key = `${keyA}-${keyB}`;
      if (!threadMap.has(key)) {
        threadMap.set(key, {
          userA: keyA, userB: keyB,
          usernameA: userMap.get(keyA) || '???',
          usernameB: userMap.get(keyB) || '???',
          messages: [],
        });
      }
      threadMap.get(key).messages.push(msg);
    }
    for (const thread of threadMap.values()) {
      thread.messages.sort((a, b) => a.created_at.localeCompare(b.created_at));
    }

    res.json({
      threads: Array.from(threadMap.values()),
      totalMessages: messages.length,
      threadCount: threadMap.size,
    });
  } catch (error) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// Status / Dashboard / Models
// ---------------------------------------------------------------------------
router.get('/api/status', (req, res) => {
  try {
    const quota = getQuotaStatus();
    res.json({ quota, postCount: getPostCount(), userCount: getUserCount(), serverTime: new Date().toISOString() });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/dashboard', (req, res) => {
  try {
    const data = getDashboardData();
    res.json({ ...data, postCount: getPostCount(), userCount: getUserCount(), serverTime: new Date().toISOString() });
  } catch (error) {
    console.error('[routes] /api/dashboard error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

router.get('/api/models', (req, res) => {
  try { res.json(getModelsInfo()); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/validate-key', async (req, res) => {
  try { res.json({ results: await validateApiKey() }); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// Manual controls (pause/resume)
// ---------------------------------------------------------------------------
router.post('/api/control/pause', (req, res) => {
  try {
    const { feature, reason } = req.body || {};
    if (!feature) return res.status(400).json({ error: 'Feature name required' });
    res.json(manualPause(feature, reason || 'Manual pause via API'));
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/control/resume', (req, res) => {
  try {
    const { feature } = req.body || {};
    if (!feature) return res.status(400).json({ error: 'Feature name required' });
    res.json(manualResume(feature));
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/control/pause-all', (req, res) => {
  try { res.json(pauseAll(req.body?.reason || 'Manual pause all')); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/control/resume-all', (req, res) => {
  try { res.json(resumeAll()); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// Auto-management controls
// ---------------------------------------------------------------------------
router.get('/api/auto-management', (req, res) => {
  try {
    const settings = getAllAutoManagement();
    res.json({
      settings: settings.map(s => ({
        feature: s.feature, enabled: s.enabled === 1, updatedAt: s.updated_at,
      })),
    });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.post('/api/auto-management', (req, res) => {
  try {
    const { feature, enabled } = req.body || {};
    if (!feature) return res.status(400).json({ error: 'Feature name required' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled must be boolean' });
    res.json(toggleAutoManagement(feature, enabled));
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// AI Memory
// ---------------------------------------------------------------------------
router.get('/api/ai/memory/:userId', (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId) || userId < 1) return res.status(400).json({ error: 'Invalid user ID' });
    const limit = parseInt(req.query.limit, 10) || 20;
    const memory = getUserMemory(userId, Math.min(limit, 100));
    const user = getUserById(userId);
    res.json({ user: user ? { id: user.id, username: user.username } : null, memory });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// Trending (exclude photo keywords)
// ---------------------------------------------------------------------------
router.get('/api/trending', (req, res) => {
  try {
    const recentPosts = getRecentPosts(30);
    const topicCounts = new Map();
    const photoExcludePatterns = /写真|動画|画像|撮った|撮影|スクリーンショット|スクショ/;

    for (const post of recentPosts) {
      const mediaMatches = post.content.match(/\[(.+?)\]/g);
      if (mediaMatches) {
        for (const match of mediaMatches) {
          const inner = match.slice(1, -1);
          const keywords = inner.split(/[のがをにでと、]/);
          for (const kw of keywords) {
            const trimmed = kw.trim();
            if (trimmed.length >= 2 && !photoExcludePatterns.test(trimmed)) {
              topicCounts.set(trimmed, (topicCounts.get(trimmed) || 0) + 1);
            }
          }
        }
      }
      const textOnly = post.content.replace(/\[.+?\]/g, '').trim();
      if (textOnly.length >= 4) {
        const phrases = textOnly.split(/[。、\s！？!?.]+/).filter(p => p.length >= 2 && p.length <= 10);
        for (const phrase of phrases) {
          if (!photoExcludePatterns.test(phrase)) {
            topicCounts.set(phrase, (topicCounts.get(phrase) || 0) + 0.5);
          }
        }
      }
    }

    const topics = [...topicCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 10)
      .map(([topic, count]) => ({ topic, count: Math.round(count * 10) / 10 }));

    res.json({ topics, basedOn: recentPosts.length, generatedAt: new Date().toISOString() });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

// ---------------------------------------------------------------------------
// Admin info endpoints
// ---------------------------------------------------------------------------
router.get('/api/db-info', (req, res) => {
  try { res.json(getDbInfo()); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/anomalies', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 30;
    res.json({ anomalies: getRecentAnomalies(Math.min(limit, 100)), todayCounts: getAnomalyCountToday() });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/daily-summaries', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 7;
    res.json({ summaries: getRecentDailySummaries(Math.min(limit, 30)), summaryUsage: getSummaryUsage() });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/usage-details', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const recentLogs = getRecentUsageLogs(Math.min(limit, 200));
    res.json({
      recentLogs: recentLogs.map(l => ({ ...l, success: l.success === 1 })),
      history: getUsageHistory(14),
      todayByModel: getUsageLogToday(),
    });
  } catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

router.get('/api/rate-limits', (req, res) => {
  try { res.json({ rateLimits: MODEL_RATE_LIMITS }); }
  catch (error) { res.status(500).json({ error: 'Internal server error' }); }
});

export default router;
