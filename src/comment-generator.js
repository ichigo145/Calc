// ===========================================================================
// comment-generator.js - コメント・リアクションチェーン (A-Talk v4.0)
// ===========================================================================
// v4.0: DM生成を完全削除。コメントとリアクションのみ。
// ===========================================================================

import {
  getAllUsers,
  getPostById,
  getCommentsByPostId,
  getCommentCountByPostId,
  insertComment,
  insertReaction,
  getReactionsByPostId,
  insertMemory,
  isFeaturePaused,
  getDailySummary,
  getPostsByThreadId,
  getThreadById,
  addPopularity,
  initPopularity,
} from './database.js';
import { generateContent, checkApiQuota } from './gemini-client.js';

// ---------------------------------------------------------------------------
// 今日の要約
// ---------------------------------------------------------------------------
function getTodaySummaryText() {
  const today = new Date().toISOString().slice(0, 10);
  const summary = getDailySummary(today);
  if (summary) return summary.summary.slice(0, 400);
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const ySummary = getDailySummary(yesterday);
  if (ySummary) return ySummary.summary.slice(0, 400);
  return null;
}

// ---------------------------------------------------------------------------
// コメント生成
// ---------------------------------------------------------------------------
const COMMENT_SCORE_THRESHOLD = 60;
const MAX_COMMENTS_PER_POST = 3;

const COMMENT_SYSTEM_INSTRUCTION = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
他のユーザーの投稿に対するコメントを生成してください。

## ルール
- コメントは短く自然に (10-60文字程度)
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない
- 相槌、感想、ツッコミ、共感など多様な反応
- 各コメントは改行で区切る

## 出力形式
1行に1コメント、改行区切りで出力してください。`;

function buildCommentPrompt(post, commenters, threadContext) {
  const commenterDescs = commenters
    .map((c, i) => `コメント${i + 1}: 性格「${c.personality}」、口調「${c.tone}」`)
    .join('\n');

  let context = '';
  if (threadContext) {
    context = `\nスレッドタイトル: ${threadContext.topic}\n`;
  }

  const summaryText = getTodaySummaryText();
  if (summaryText) {
    context += `\n掲示板の雰囲気: ${summaryText.slice(0, 200)}\n`;
  }

  return `以下の投稿に対して、${commenters.length}人のユーザーがコメントします。
${context}
投稿内容:
${post.content}

コメントするユーザー:
${commenterDescs}

${commenters.length}行のコメントのみを出力してください。`;
}

export async function generateCommentsForPost(postId) {
  const post = getPostById(postId);
  if (!post) return { success: false, error: '投稿が見つかりません' };

  if (post.popularity_score < COMMENT_SCORE_THRESHOLD) {
    return { success: false, error: '人気スコアがしきい値以下' };
  }

  const existingCount = getCommentCountByPostId(postId);
  if (existingCount >= MAX_COMMENTS_PER_POST) {
    return { success: true, comments: getCommentsByPostId(postId) };
  }

  if (isFeaturePaused('comment_generation')) {
    return { success: true, comments: getCommentsByPostId(postId), note: 'コメント生成一時停止中' };
  }

  const quota = checkApiQuota('comment_generation');
  if (!quota.allowed) {
    return { success: true, comments: getCommentsByPostId(postId) };
  }

  let threadContext = null;
  if (post.thread_id) {
    threadContext = getThreadById(post.thread_id);
  }

  const allUsers = getAllUsers();
  const remainingSlots = MAX_COMMENTS_PER_POST - existingCount;
  const numComments = Math.min(remainingSlots, Math.floor(Math.random() * 3) + 1);

  const candidates = allUsers.filter(u => u.id !== post.user_id);
  const commenters = [];
  const usedIds = new Set();

  for (let i = 0; i < numComments && candidates.length > 0; i++) {
    const available = candidates.filter(c => !usedIds.has(c.id));
    if (available.length === 0) break;
    const idx = Math.floor(Math.random() * available.length);
    commenters.push(available[idx]);
    usedIds.add(available[idx].id);
  }

  if (commenters.length === 0) {
    return { success: true, comments: getCommentsByPostId(postId) };
  }

  let rawText;
  try {
    rawText = await generateContent(
      COMMENT_SYSTEM_INSTRUCTION,
      buildCommentPrompt(post, commenters, threadContext),
      { temperature: 1.0, maxOutputTokens: 512, feature: 'comment_generation' }
    );
  } catch (error) {
    console.error(`[comment-generator] APIエラー: ${error.message}`);
    return { success: true, comments: getCommentsByPostId(postId) };
  }

  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length <= 200);

  for (let i = 0; i < Math.min(lines.length, commenters.length); i++) {
    try {
      insertComment(postId, commenters[i].id, lines[i]);
      insertMemory(commenters[i].id, 'comment', lines[i], `post_id=${postId}`);
      initPopularity(commenters[i].id);
      addPopularity(commenters[i].id, 2);
    } catch (dbError) {
      console.error(`[comment-generator] DBエラー: ${dbError.message}`);
    }
  }

  return { success: true, comments: getCommentsByPostId(postId) };
}

// ===========================================================================
// リアクションチェーン
// ===========================================================================
const REACTION_SCORE_THRESHOLD = 70;
const MAX_CHAIN_DEPTH = 3;

const REACTION_SYSTEM_INSTRUCTION = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
投稿とそのコメント欄を見て、自然に会話を続けるリアクションチェーンを生成してください。

## ルール
- 各発言は15-80文字程度
- 日本語のみ / 絵文字禁止 / AIっぽさを出さない
- 直前の発言に自然に反応する
- 各発言は改行で区切る

## 出力形式
1行に1発言、改行区切りで出力してください。`;

function buildReactionChainPrompt(post, existingComments, reactors, threadContext) {
  let context = `元の投稿:\n${post.content}\n`;

  if (threadContext) {
    context = `スレッド: ${threadContext.topic}\n` + context;
  }

  if (existingComments.length > 0) {
    context += '\n既存のコメント:\n';
    for (const c of existingComments) {
      context += `- ${c.content}\n`;
    }
  }

  const summaryText = getTodaySummaryText();
  if (summaryText) {
    context += `\n掲示板の雰囲気: ${summaryText.slice(0, 200)}\n`;
  }

  const reactorDescs = reactors
    .map((r, i) => `発言${i + 1}: 性格「${r.personality}」、口調「${r.tone}」`)
    .join('\n');

  return `以下の投稿を踏まえて、${reactors.length}人が連鎖的に会話します。

${context}

リアクションするユーザー:
${reactorDescs}

${reactors.length}行の発言のみを出力してください。`;
}

export async function generateReactionChain(postId) {
  const post = getPostById(postId);
  if (!post) return { success: false, error: '投稿が見つかりません' };

  if (post.popularity_score < REACTION_SCORE_THRESHOLD) {
    return { success: false, error: 'スコア不足' };
  }

  const existingReactions = getReactionsByPostId(postId);
  if (existingReactions.length > 0) {
    return { success: true, reactions: existingReactions, chainGenerated: false };
  }

  if (isFeaturePaused('reaction_chain')) {
    return { success: true, reactions: [], chainGenerated: false, note: 'リアクション一時停止中' };
  }

  const quota = checkApiQuota('reaction_chain');
  if (!quota.allowed) {
    return { success: true, reactions: [], chainGenerated: false };
  }

  let threadContext = null;
  if (post.thread_id) {
    threadContext = getThreadById(post.thread_id);
  }

  const existingComments = getCommentsByPostId(postId);
  const allUsers = getAllUsers();
  const excludeIds = new Set([post.user_id]);
  for (const c of existingComments) excludeIds.add(c.user_id);

  let candidates = allUsers.filter(u => !excludeIds.has(u.id));
  if (candidates.length < MAX_CHAIN_DEPTH) {
    candidates = allUsers.filter(u => u.id !== post.user_id);
  }

  const reactors = [];
  const usedIds = new Set();
  for (let i = 0; i < MAX_CHAIN_DEPTH && candidates.length > 0; i++) {
    const available = candidates.filter(c => !usedIds.has(c.id));
    if (available.length === 0) break;
    const idx = Math.floor(Math.random() * available.length);
    reactors.push(available[idx]);
    usedIds.add(available[idx].id);
  }

  if (reactors.length === 0) {
    return { success: true, reactions: [], chainGenerated: false };
  }

  let rawText;
  try {
    rawText = await generateContent(
      REACTION_SYSTEM_INSTRUCTION,
      buildReactionChainPrompt(post, existingComments, reactors, threadContext),
      { temperature: 1.0, maxOutputTokens: 512, feature: 'reaction_chain' }
    );
  } catch (error) {
    console.error(`[reaction-chain] APIエラー: ${error.message}`);
    return { success: true, reactions: [], chainGenerated: false };
  }

  const lines = rawText.split('\n').map(l => l.trim()).filter(l => l.length > 0 && l.length <= 200);

  let lastReactionId = null;
  for (let i = 0; i < Math.min(lines.length, reactors.length); i++) {
    try {
      const result = insertReaction(postId, reactors[i].id, lines[i], i, lastReactionId);
      lastReactionId = result.id;
      insertMemory(reactors[i].id, 'reaction', lines[i], `post_id=${postId},depth=${i}`);
      initPopularity(reactors[i].id);
      addPopularity(reactors[i].id, 1);
    } catch (dbError) {
      console.error(`[reaction-chain] DBエラー: ${dbError.message}`);
    }
  }

  return { success: true, reactions: getReactionsByPostId(postId), chainGenerated: true };
}
