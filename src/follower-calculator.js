// ===========================================================================
// follower-calculator.js - フォロワー予測アルゴリズム (A-Talk v3)
// ===========================================================================
//
// AIを使わず、過去の投稿履歴といいね数からフォロワー数を予測する。
// コード側のみで処理。
//
// ## アルゴリズム
//
// followerCount = baseFollowers + activityBonus + popularityBonus + engagementBonus
//
// 1. baseFollowers:
//    - 全ユーザー共通の基本フォロワー数 = 10
//
// 2. activityBonus (投稿頻度ボーナス):
//    - floor(投稿数 * 2.5)
//    - 投稿が多いほどフォロワーが増える
//
// 3. popularityBonus (人気ボーナス):
//    - floor(総いいね数 * 0.3)
//    - いいねの多さに比例してフォロワーが増える
//
// 4. engagementBonus (エンゲージメントボーナス):
//    - floor(コメント数 * 1.5)
//    - コメントが多い = 他ユーザーとの交流が活発
//
// 5. qualityBonus (品質ボーナス):
//    - floor(平均人気スコア * 0.5)
//    - 投稿の質が高いほどフォロワーが増える
//
// ## ランダム補正
//    - 最終値に 0.85〜1.15 のランダム補正を掛ける
//    - 現実のSNSでは同じ活動量でもフォロワー数にばらつきがある
//
// ===========================================================================

import {
  getAllUsers,
  getUserPostStats,
  getUserCommentCounts,
  upsertFollower,
  getAllFollowers,
} from './database.js';

const BASE_FOLLOWERS = 10;
const ACTIVITY_MULTIPLIER = 2.5;
const POPULARITY_MULTIPLIER = 0.3;
const ENGAGEMENT_MULTIPLIER = 1.5;
const QUALITY_MULTIPLIER = 0.5;
const RANDOM_RANGE = 0.15; // ±15%

/**
 * Calculate predicted follower count for a single user.
 *
 * @param {{ post_count: number, total_likes: number, avg_score: number }} postStats
 * @param {number} commentCount
 * @returns {number}
 */
function calculateFollowers(postStats, commentCount) {
  const postCount = postStats?.post_count || 0;
  const totalLikes = postStats?.total_likes || 0;
  const avgScore = postStats?.avg_score || 0;

  const activityBonus = Math.floor(postCount * ACTIVITY_MULTIPLIER);
  const popularityBonus = Math.floor(totalLikes * POPULARITY_MULTIPLIER);
  const engagementBonus = Math.floor(commentCount * ENGAGEMENT_MULTIPLIER);
  const qualityBonus = Math.floor(avgScore * QUALITY_MULTIPLIER);

  const raw = BASE_FOLLOWERS + activityBonus + popularityBonus + engagementBonus + qualityBonus;

  // Random correction (0.85 - 1.15)
  const randomFactor = 1.0 + (Math.random() * 2 - 1) * RANDOM_RANGE;
  return Math.max(0, Math.floor(raw * randomFactor));
}

/**
 * Compute and store follower predictions for all users.
 * Called on demand or periodically.
 */
export function computeAllFollowers() {
  const users = getAllUsers();
  const postStats = getUserPostStats();
  const commentCounts = getUserCommentCounts();

  // Build lookup maps
  const postStatsMap = new Map();
  for (const s of postStats) {
    postStatsMap.set(s.user_id, s);
  }

  const commentCountMap = new Map();
  for (const c of commentCounts) {
    commentCountMap.set(c.user_id, c.comment_count);
  }

  const results = [];
  for (const user of users) {
    const stats = postStatsMap.get(user.id);
    const cc = commentCountMap.get(user.id) || 0;
    const followerCount = calculateFollowers(stats, cc);

    upsertFollower(user.id, followerCount);
    results.push({
      userId: user.id,
      username: user.username,
      followerCount,
      postCount: stats?.post_count || 0,
      totalLikes: stats?.total_likes || 0,
      avgScore: Math.round((stats?.avg_score || 0) * 10) / 10,
      commentCount: cc,
    });
  }

  return results.sort((a, b) => b.followerCount - a.followerCount);
}

/**
 * Get cached follower data (fast, no recomputation).
 * Returns empty array if not yet computed.
 */
export function getCachedFollowers() {
  return getAllFollowers();
}
