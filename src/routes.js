// ===========================================================================
// routes.js - REST API endpoints (A-Talk v5.0)
// ===========================================================================

import { Router } from 'express';
import express from 'express';
import {
  getTimeline, getPostById, getPostCount,
  getAllUsers, getUserById, getUserCount,
  getCommentsByPostId, getReactionsByPostId,
  getUserMemory, getRecentPosts,
  getFollowerByUserId, getUserPostStats, getUserCommentCounts,
  getDbInfo, getRecentAnomalies, getAnomalyCountToday,
  getRecentDailySummaries, getRecentUsageLogs, getUsageHistory, getUsageLogToday,
  getAllThreadsList, getThreadById, getPostsByThreadId, getActiveThreads,
  getThreadsByPopularity, incrementThreadViews,
  getAllAutoManagement,
  getUserPoints, getAllUserPoints, getAllBadges, getUserBadges,
  getBadgeById, spendPoints, grantBadge, equipBadge, addPoints,
  getEquippedBadges, getPopularity, getAllPopularity,
  getRecentThreadSummaries, getThreadSummary,
  initUserPoints, initPopularity, addPopularity,
  insertTipLog, getRecentTips, getUserReceivedTips,
  insertVote, getVotesByThread, getVoteDetail, getUserVote,
  getPersonalityHistory,
  getEconomyState,
  insertAuction, getActiveAuctions, getAuctionById, updateAuctionBid, closeAuction, expireAuctions,
  getLimitedBadges,
} from './database.js';
import { getQuotaStatus, getModelsInfo, validateApiKey, MODEL_RATE_LIMITS, getSummaryUsage } from './gemini-client.js';
import { generateCommentsForPost, generateReactionChain } from './comment-generator.js';
import { getDashboardData, manualPause, manualResume, pauseAll, resumeAll, toggleAutoManagement } from './api-controller.js';
import { computeAllFollowers, getCachedFollowers } from './follower-calculator.js';

const router = Router();
router.use(express.json());

// ---------------------------------------------------------------------------
// タイムライン
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
    res.json({ posts, pagination: { limit, offset, total, hasMore: offset + posts.length < total } });
  } catch (error) {
    console.error('[routes] /api/timeline エラー:', error.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// スレッド
// ---------------------------------------------------------------------------
router.get('/api/threads', (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 20;
    if (limit > 100) limit = 100;
    const sort = req.query.sort || 'recent';
    const activeOnly = req.query.active !== 'false';
    let threads;
    if (sort === 'popular') threads = getThreadsByPopularity(limit);
    else if (activeOnly) threads = getActiveThreads(limit);
    else threads = getAllThreadsList(limit);

    // 投票データを付加
    const threadsWithVotes = threads.map(t => ({
      ...t,
      votes: getVotesByThread(t.id),
    }));
    res.json({ threads: threadsWithVotes, sort });
  } catch (error) {
    console.error('[routes] /api/threads エラー:', error.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/threads/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効なスレッドID' });
    const thread = getThreadById(id);
    if (!thread) return res.status(404).json({ error: 'スレッドが見つかりません' });
    incrementThreadViews(id);
    const posts = getPostsByThreadId(id);
    const summary = getThreadSummary(id);
    const votes = getVotesByThread(id);
    const voteDetail = getVoteDetail(id);
    res.json({ thread, posts, summary, votes, voteDetail });
  } catch (error) {
    console.error('[routes] /api/threads/:id エラー:', error.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// 投票
// ---------------------------------------------------------------------------
router.post('/api/threads/:id/vote', (req, res) => {
  try {
    const threadId = parseInt(req.params.id, 10);
    const { userId, voteType } = req.body || {};
    if (!userId || !voteType) return res.status(400).json({ error: 'userId と voteType が必要' });
    if (!['agree', 'disagree', 'neutral'].includes(voteType)) return res.status(400).json({ error: '無効な投票タイプ' });
    
    insertVote(threadId, userId, voteType);
    const votes = getVotesByThread(threadId);
    
    // Socket.io emit
    const io = req.app.get('io');
    if (io) io.emit('vote', { threadId, userId, voteType, votes });
    
    res.json({ success: true, votes });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/threads/:id/votes', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効なスレッドID' });
    res.json({ votes: getVotesByThread(id), detail: getVoteDetail(id) });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// 投稿
// ---------------------------------------------------------------------------
router.get('/api/posts/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効な投稿ID' });
    const post = getPostById(id);
    if (!post) return res.status(404).json({ error: '投稿が見つかりません' });
    const comments = getCommentsByPostId(id);
    const reactions = getReactionsByPostId(id);
    let thread = null;
    if (post.thread_id) thread = getThreadById(post.thread_id);
    res.json({ post, comments, reactions, thread });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/posts/:id/comments', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効な投稿ID' });
    const result = await generateCommentsForPost(id);
    if (!result.success && result.error === '投稿が見つかりません') return res.status(404).json({ error: '投稿が見つかりません' });
    res.json({ comments: result.comments || [], generated: result.success, error: result.error || null });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/posts/:id/reactions', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効な投稿ID' });
    const result = await generateReactionChain(id);
    res.json({ reactions: result.reactions || [], chainGenerated: result.chainGenerated || false, error: result.error || null });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// ユーザー
// ---------------------------------------------------------------------------
router.get('/api/users', (req, res) => {
  try {
    const sort = req.query.sort || 'follower';
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
      const pts = getUserPoints(u.id);
      const pop = getPopularity(u.id);
      const equipped = getEquippedBadges(u.id);
      return {
        id: u.id, username: u.username, created_at: u.created_at,
        post_count: stats?.post_count || 0, total_likes: stats?.total_likes || 0,
        avg_score: Math.round((stats?.avg_score || 0) * 10) / 10,
        comment_count: commentCountMap.get(u.id) || 0,
        follower_count: follower?.follower_count || 0,
        points: pts?.balance || 0, popularity: pop?.points || 0,
        badges: equipped || [],
      };
    });

    if (sort === 'point') publicUsers.sort((a, b) => b.points - a.points);
    else if (sort === 'popularity') publicUsers.sort((a, b) => b.popularity - a.popularity);
    else publicUsers.sort((a, b) => b.follower_count - a.follower_count);

    res.json({ users: publicUsers, sort });
  } catch (error) {
    console.error('[routes] /api/users エラー:', error.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/users/:id', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効なユーザーID' });
    const user = getUserById(id);
    if (!user) return res.status(404).json({ error: 'ユーザーが見つかりません' });
    const postStatsArr = getUserPostStats();
    const stats = postStatsArr.find(s => s.user_id === id);
    const commentCountsArr = getUserCommentCounts();
    const cc = commentCountsArr.find(c => c.user_id === id);
    const follower = getFollowerByUserId(id);
    const pts = getUserPoints(id);
    const pop = getPopularity(id);
    const badges = getUserBadges(id);
    const equipped = getEquippedBadges(id);
    const personalityHistory = getPersonalityHistory(id, 5);
    res.json({
      user: {
        id: user.id, username: user.username, personality: user.personality,
        tone: user.tone, created_at: user.created_at,
        post_count: stats?.post_count || 0, total_likes: stats?.total_likes || 0,
        avg_score: Math.round((stats?.avg_score || 0) * 10) / 10,
        comment_count: cc?.comment_count || 0,
        follower_count: follower?.follower_count || 0,
        points: pts?.balance || 0, total_earned: pts?.total_earned || 0, total_spent: pts?.total_spent || 0,
        popularity: pop?.points || 0,
        badges, equipped, personalityHistory,
      },
    });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// フォロワー
// ---------------------------------------------------------------------------
router.get('/api/followers', (req, res) => {
  try { res.json({ followers: getCachedFollowers() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/followers/compute', (req, res) => {
  try { res.json({ success: true, followers: computeAllFollowers() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ---------------------------------------------------------------------------
// ポイント・バッジ
// ---------------------------------------------------------------------------
router.get('/api/points', (req, res) => {
  try { res.json({ points: getAllUserPoints() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/badges', (req, res) => {
  try { res.json({ badges: getAllBadges() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/users/:id/badges', (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    if (isNaN(id) || id < 1) return res.status(400).json({ error: '無効なユーザーID' });
    res.json({ badges: getUserBadges(id), equipped: getEquippedBadges(id) });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// バッジ購入 (インフレ率適用)
router.post('/api/badges/buy', (req, res) => {
  try {
    const { userId, badgeId } = req.body || {};
    if (!userId || !badgeId) return res.status(400).json({ error: 'userId と badgeId が必要' });
    const badge = getBadgeById(badgeId);
    if (!badge) return res.status(404).json({ error: 'バッジが見つかりません' });

    let inflationRate = 1.0;
    try { const eco = getEconomyState(); if (eco) inflationRate = eco.inflation_rate || 1.0; } catch (e) {}
    const actualCost = Math.ceil(badge.cost * inflationRate);

    initUserPoints(userId);
    const pts = getUserPoints(userId);
    if (!pts || pts.balance < actualCost) {
      return res.status(400).json({ error: 'ポイント不足', required: actualCost, balance: pts?.balance || 0 });
    }
    const existing = getUserBadges(userId);
    if (existing.find(b => b.badge_id === badgeId)) return res.status(400).json({ error: 'すでに所持しています' });

    spendPoints(userId, actualCost, 'badge_buy', `バッジ購入: ${badge.name}`);
    grantBadge(userId, badgeId);

    const io = req.app.get('io');
    if (io) io.emit('badge_purchase', { userId, badge: badge.name, cost: actualCost });

    res.json({ success: true, badge, actualCost, newBalance: getUserPoints(userId).balance });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.post('/api/badges/equip', (req, res) => {
  try {
    const { userId, badgeId } = req.body || {};
    if (!userId || !badgeId) return res.status(400).json({ error: 'userId と badgeId が必要' });
    const badge = getBadgeById(badgeId);
    if (!badge) return res.status(404).json({ error: 'バッジが見つかりません' });
    equipBadge(userId, badgeId, badge.type);
    res.json({ success: true, equipped: getEquippedBadges(userId) });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// 投げ銭
router.post('/api/tip', (req, res) => {
  try {
    const { fromUserId, toUserId, amount } = req.body || {};
    if (!fromUserId || !toUserId || !amount || amount < 1) return res.status(400).json({ error: 'fromUserId, toUserId, amount (1以上) が必要' });
    if (fromUserId === toUserId) return res.status(400).json({ error: '自分に投げ銭できません' });

    initUserPoints(fromUserId);
    initUserPoints(toUserId);
    const fromPts = getUserPoints(fromUserId);
    if (!fromPts || fromPts.balance < amount) return res.status(400).json({ error: 'ポイント不足' });

    const bonus = Math.ceil(amount * 0.05);
    let effectTier = 'normal';
    if (amount >= 100) effectTier = 'legendary';
    else if (amount >= 50) effectTier = 'epic';
    else if (amount >= 30) effectTier = 'rare';

    spendPoints(fromUserId, amount, 'tip_send', `投げ銭 (→ユーザー${toUserId})`);
    addPoints(toUserId, amount + bonus, 'tip_receive', `投げ銭受取 (+${bonus}ボーナス)`);
    initPopularity(toUserId);
    addPopularity(toUserId, Math.floor(amount * 0.1));
    insertTipLog(fromUserId, toUserId, amount, bonus, effectTier);

    const io = req.app.get('io');
    if (io) {
      const fromUser = getUserById(fromUserId);
      const toUser = getUserById(toUserId);
      io.emit('tip', {
        fromUserId, fromUsername: fromUser?.username, toUserId, toUsername: toUser?.username,
        amount, bonus, effectTier,
      });
    }

    res.json({
      success: true, sent: amount, bonus, received: amount + bonus, effectTier,
      fromBalance: getUserPoints(fromUserId).balance, toBalance: getUserPoints(toUserId).balance,
    });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/tips/recent', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 20;
    res.json({ tips: getRecentTips(Math.min(limit, 50)) });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// 人気度
router.post('/api/popularity/buy', (req, res) => {
  try {
    const { userId, amount } = req.body || {};
    if (!userId || !amount || amount < 1) return res.status(400).json({ error: 'userId と amount が必要' });
    initUserPoints(userId);
    initPopularity(userId);
    const pts = getUserPoints(userId);
    const cost = amount * 10;
    if (!pts || pts.balance < cost) return res.status(400).json({ error: 'ポイント不足', required: cost, balance: pts?.balance || 0 });
    spendPoints(userId, cost, 'popularity_buy', `人気度購入 (${amount}pt)`);
    addPopularity(userId, amount);
    res.json({ success: true, pointsSpent: cost, popularityGained: amount });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/popularity', (req, res) => {
  try { res.json({ ranking: getAllPopularity() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ---------------------------------------------------------------------------
// 経済シミュレーション
// ---------------------------------------------------------------------------
router.get('/api/economy', (req, res) => {
  try {
    const state = getEconomyState();
    const auctions = getActiveAuctions();
    const limitedBadges = getLimitedBadges();
    res.json({ economy: state, auctions, limitedBadges });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// オークション
router.get('/api/auctions', (req, res) => {
  try {
    expireAuctions();
    res.json({ auctions: getActiveAuctions() });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.post('/api/auctions/bid', (req, res) => {
  try {
    const { auctionId, userId, bid } = req.body || {};
    if (!auctionId || !userId || !bid) return res.status(400).json({ error: 'パラメータ不足' });
    
    const auction = getAuctionById(auctionId);
    if (!auction) return res.status(404).json({ error: 'オークションが見つかりません' });
    if (bid <= auction.current_bid) return res.status(400).json({ error: '入札額が現在の最高額以下' });
    if (bid < auction.min_bid) return res.status(400).json({ error: '最低入札額未満' });

    initUserPoints(userId);
    const pts = getUserPoints(userId);
    if (!pts || pts.balance < bid) return res.status(400).json({ error: 'ポイント不足' });

    // 前の入札者に返金
    if (auction.bidder_id && auction.current_bid > 0) {
      addPoints(auction.bidder_id, auction.current_bid, 'auction_refund', 'オークション入札返金');
    }

    spendPoints(userId, bid, 'auction_bid', `オークション入札 #${auctionId}`);
    updateAuctionBid(auctionId, bid, userId);

    const io = req.app.get('io');
    if (io) io.emit('auction_bid', { auctionId, userId, bid, badgeName: auction.badge_name });

    res.json({ success: true, bid });
  } catch (error) {
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

// ---------------------------------------------------------------------------
// ステータス・ダッシュボード
// ---------------------------------------------------------------------------
router.get('/api/status', (req, res) => {
  try {
    const quota = getQuotaStatus();
    res.json({ quota, postCount: getPostCount(), userCount: getUserCount(), serverTime: new Date().toISOString() });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/dashboard', (req, res) => {
  try {
    const data = getDashboardData();
    const economy = getEconomyState();
    res.json({ ...data, economy, postCount: getPostCount(), userCount: getUserCount(), serverTime: new Date().toISOString() });
  } catch (error) {
    console.error('[routes] /api/dashboard エラー:', error.message);
    res.status(500).json({ error: 'サーバーエラー' });
  }
});

router.get('/api/models', (req, res) => {
  try { res.json(getModelsInfo()); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/validate-key', async (req, res) => {
  try { res.json({ results: await validateApiKey() }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ---------------------------------------------------------------------------
// 手動制御・自動管理
// ---------------------------------------------------------------------------
router.post('/api/control/pause', (req, res) => {
  try {
    const { feature, reason } = req.body || {};
    if (!feature) return res.status(400).json({ error: '機能名が必要' });
    res.json(manualPause(feature, reason || '手動停止'));
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.post('/api/control/resume', (req, res) => {
  try {
    const { feature } = req.body || {};
    if (!feature) return res.status(400).json({ error: '機能名が必要' });
    res.json(manualResume(feature));
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.post('/api/control/pause-all', (req, res) => {
  try { res.json(pauseAll(req.body?.reason || '全機能手動停止')); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.post('/api/control/resume-all', (req, res) => {
  try { res.json(resumeAll()); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/auto-management', (req, res) => {
  try {
    const settings = getAllAutoManagement();
    res.json({ settings: settings.map(s => ({ feature: s.feature, enabled: s.enabled === 1, updatedAt: s.updated_at })) });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.post('/api/auto-management', (req, res) => {
  try {
    const { feature, enabled } = req.body || {};
    if (!feature) return res.status(400).json({ error: '機能名が必要' });
    if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled は boolean で指定' });
    res.json(toggleAutoManagement(feature, enabled));
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/ai/memory/:userId', (req, res) => {
  try {
    const userId = parseInt(req.params.userId, 10);
    if (isNaN(userId) || userId < 1) return res.status(400).json({ error: '無効なユーザーID' });
    const limit = parseInt(req.query.limit, 10) || 20;
    const memory = getUserMemory(userId, Math.min(limit, 100));
    const user = getUserById(userId);
    res.json({ user: user ? { id: user.id, username: user.username } : null, memory });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

router.get('/api/trending', (req, res) => {
  try {
    const recentPosts = getRecentPosts(30);
    const topicCounts = new Map();
    const photoExclude = /写真|動画|画像|撮った|撮影|スクリーンショット|スクショ/;
    for (const post of recentPosts) {
      const mediaMatches = post.content.match(/\[(.+?)\]/g);
      if (mediaMatches) {
        for (const match of mediaMatches) {
          const inner = match.slice(1, -1);
          const keywords = inner.split(/[のがをにでと、]/);
          for (const kw of keywords) {
            const trimmed = kw.trim();
            if (trimmed.length >= 2 && !photoExclude.test(trimmed)) topicCounts.set(trimmed, (topicCounts.get(trimmed) || 0) + 1);
          }
        }
      }
      const textOnly = post.content.replace(/\[.+?\]/g, '').trim();
      if (textOnly.length >= 4) {
        const phrases = textOnly.split(/[。、\s！？!?.]+/).filter(p => p.length >= 2 && p.length <= 10);
        for (const phrase of phrases) { if (!photoExclude.test(phrase)) topicCounts.set(phrase, (topicCounts.get(phrase) || 0) + 0.5); }
      }
    }
    const topics = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10)
      .map(([topic, count]) => ({ topic, count: Math.round(count * 10) / 10 }));
    res.json({ topics, basedOn: recentPosts.length, generatedAt: new Date().toISOString() });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

// ---------------------------------------------------------------------------
// 管理系
// ---------------------------------------------------------------------------
router.get('/api/db-info', (req, res) => {
  try { res.json(getDbInfo()); } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.get('/api/anomalies', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 30;
    res.json({ anomalies: getRecentAnomalies(Math.min(limit, 100)), todayCounts: getAnomalyCountToday() });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.get('/api/daily-summaries', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 7;
    res.json({ summaries: getRecentDailySummaries(Math.min(limit, 30)), summaryUsage: getSummaryUsage() });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.get('/api/thread-summaries', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 10;
    res.json({ summaries: getRecentThreadSummaries(Math.min(limit, 50)) });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.get('/api/usage-details', (req, res) => {
  try {
    const limit = parseInt(req.query.limit, 10) || 50;
    const recentLogs = getRecentUsageLogs(Math.min(limit, 200));
    res.json({
      recentLogs: recentLogs.map(l => ({ ...l, success: l.success === 1 })),
      history: getUsageHistory(14), todayByModel: getUsageLogToday(),
    });
  } catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});
router.get('/api/rate-limits', (req, res) => {
  try { res.json({ rateLimits: MODEL_RATE_LIMITS }); }
  catch (error) { res.status(500).json({ error: 'サーバーエラー' }); }
});

export default router;
