// ===========================================================================
// routes.js - REST API endpoints (A-Talk)
// ===========================================================================
//
// 全エンドポイント一覧:
//   GET  /api/timeline              タイムライン取得 (ページネーション)
//   GET  /api/posts/:id             投稿詳細 (コメント含む)
//   GET  /api/posts/:id/comments    コメント取得 (オンデマンド生成)
//   GET  /api/posts/:id/reactions   リアクションチェーン取得 (オンデマンド生成)
//   GET  /api/users                 全ユーザー一覧
//   GET  /api/users/:id             ユーザー詳細
//   GET  /api/dm/:userA/:userB      DM取得 (オンデマンド生成)
//   GET  /api/status                システムステータス
//
// フロントエンドは必ずこれらのAPI経由でデータにアクセスする。
// フロントエンドからGemini APIを直接呼ぶことは禁止。
// ===========================================================================

import { Router } from 'express';
import {
  getTimeline,
  getPostById,
  getPostCount,
  getAllUsers,
  getUserById,
  getCommentsByPostId,
  getReactionsByPostId,
} from './database.js';
import { getQuotaStatus } from './gemini-client.js';
import { generateCommentsForPost, generateDMThread, generateReactionChain } from './comment-generator.js';

const router = Router();

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
      pagination: {
        limit,
        offset,
        total,
        hasMore: offset + posts.length < total,
      },
    });
  } catch (error) {
    console.error('[routes] /api/timeline error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/posts/:id
// ---------------------------------------------------------------------------
router.get('/api/posts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

    const post = getPostById(id);
    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const comments = getCommentsByPostId(id);
    const reactions = getReactionsByPostId(id);

    res.json({ post, comments, reactions });
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
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

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
// GET /api/posts/:id/reactions (新機能: リアクションチェーン)
// ---------------------------------------------------------------------------
router.get('/api/posts/:id/reactions', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid post ID' });
    }

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
    const publicUsers = users.map(u => ({
      id: u.id,
      username: u.username,
      created_at: u.created_at,
    }));
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
    if (isNaN(id) || id < 1) {
      return res.status(400).json({ error: 'Invalid user ID' });
    }

    const user = getUserById(id);
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }

    res.json({
      user: {
        id: user.id,
        username: user.username,
        created_at: user.created_at,
      },
    });
  } catch (error) {
    console.error('[routes] /api/users/:id error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/dm/:userA/:userB
// ---------------------------------------------------------------------------
router.get('/api/dm/:userA/:userB', async (req, res) => {
  try {
    const userAId = parseInt(req.params.userA, 10);
    const userBId = parseInt(req.params.userB, 10);

    if (isNaN(userAId) || isNaN(userBId) || userAId < 1 || userBId < 1) {
      return res.status(400).json({ error: 'Invalid user IDs' });
    }

    if (userAId === userBId) {
      return res.status(400).json({ error: 'Cannot DM yourself' });
    }

    const result = await generateDMThread(userAId, userBId);

    res.json({
      messages: result.messages || [],
      generated: result.success,
    });
  } catch (error) {
    console.error('[routes] /api/dm error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ---------------------------------------------------------------------------
// GET /api/status
// ---------------------------------------------------------------------------
router.get('/api/status', (req, res) => {
  try {
    const quota = getQuotaStatus();
    const postCount = getPostCount();
    const users = getAllUsers();

    res.json({
      quota,
      postCount,
      userCount: users.length,
      serverTime: new Date().toISOString(),
    });
  } catch (error) {
    console.error('[routes] /api/status error:', error.message);
    res.status(500).json({ error: 'Internal server error' });
  }
});

export default router;
