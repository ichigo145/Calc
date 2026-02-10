// ===========================================================================
// comment-generator.js - コメント・DM・リアクションチェーンの生成 (A-Talk v3)
// ===========================================================================
//
// v3 変更点:
//   - マルチモデル対応: feature名でモデルを自動選択
//   - AI Memory: 生成したコメント/DM/リアクションをai_memoryに記録
//   - feature-based pause check
// ===========================================================================

import {
  getAllUsers,
  getPostById,
  getCommentsByPostId,
  getCommentCountByPostId,
  insertComment,
  insertDM,
  getDMThread,
  insertReaction,
  getReactionsByPostId,
  getReactionCountByPostId,
  insertMemory,
  getUserMemoryByType,
  isFeaturePaused,
} from './database.js';
import { generateContent, checkApiQuota } from './gemini-client.js';

// ---------------------------------------------------------------------------
// コメント生成
// ---------------------------------------------------------------------------
const COMMENT_SCORE_THRESHOLD = 60;
const MAX_COMMENTS_PER_POST = 3;

const COMMENT_SYSTEM_INSTRUCTION = `あなたは架空のSNS「A-Talk」のユーザーです。
他のユーザーの投稿に対するコメントを生成してください。

## ルール
- コメントは短く自然に (10-60文字程度)
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない
- 投稿内容に自然に反応する
- 相槌、感想、ツッコミ、共感など多様な反応
- 過度に丁寧すぎない
- 各コメントは改行で区切る
- コメントのみを出力し、番号や記号を付けない

## 出力形式
1行に1コメント、改行区切りで出力してください。
コメント以外は何も書かないでください。`;

function buildCommentPrompt(postContent, commenters) {
  const commenterDescs = commenters
    .map((c, i) => `コメント${i + 1}: 性格「${c.personality}」、口調「${c.tone}」`)
    .join('\n');

  return `以下の投稿に対して、${commenters.length}人のユーザーがコメントします。
各ユーザーの性格・口調を反映したコメントを1行ずつ、合計${commenters.length}件出力してください。

投稿内容:
${postContent}

コメントするユーザー:
${commenterDescs}

${commenters.length}行のコメントのみを出力してください。`;
}

export async function generateCommentsForPost(postId) {
  const post = getPostById(postId);
  if (!post) {
    return { success: false, error: 'Post not found' };
  }

  if (post.popularity_score < COMMENT_SCORE_THRESHOLD) {
    return { success: false, error: 'Post popularity score is below threshold' };
  }

  const existingCount = getCommentCountByPostId(postId);
  if (existingCount >= MAX_COMMENTS_PER_POST) {
    const existing = getCommentsByPostId(postId);
    return { success: true, comments: existing };
  }

  // Check feature pause
  if (isFeaturePaused('comment_generation')) {
    const existing = getCommentsByPostId(postId);
    return { success: true, comments: existing, note: 'Comment generation is paused' };
  }

  const quota = checkApiQuota('comment_generation');
  if (!quota.allowed) {
    const existing = getCommentsByPostId(postId);
    return { success: true, comments: existing };
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
    const existing = getCommentsByPostId(postId);
    return { success: true, comments: existing };
  }

  let rawText;
  try {
    rawText = await generateContent(
      COMMENT_SYSTEM_INSTRUCTION,
      buildCommentPrompt(post.content, commenters),
      { temperature: 1.0, maxOutputTokens: 512, feature: 'comment_generation' }
    );
  } catch (error) {
    console.error(`[comment-generator] API error: ${error.message}`);
    const existing = getCommentsByPostId(postId);
    return { success: true, comments: existing };
  }

  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 200);

  for (let i = 0; i < Math.min(lines.length, commenters.length); i++) {
    try {
      insertComment(postId, commenters[i].id, lines[i]);
      // Save to AI memory
      insertMemory(commenters[i].id, 'comment', lines[i], `post_id=${postId}`);
    } catch (dbError) {
      console.error(`[comment-generator] DB insert error: ${dbError.message}`);
    }
  }

  const allComments = getCommentsByPostId(postId);
  return { success: true, comments: allComments };
}

// ---------------------------------------------------------------------------
// DM生成
// ---------------------------------------------------------------------------

const DM_SYSTEM_INSTRUCTION = `あなたは架空のSNS「A-Talk」のユーザーです。
ダイレクトメッセージ (DM) を生成してください。

## ルール
- 短く自然なメッセージ (10-80文字程度)
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない
- 日常会話のやりとり
- 各メッセージは改行で区切る

## 出力形式
1行に1メッセージ、改行区切りで出力してください。
メッセージ以外は何も書かないでください。`;

export async function generateDMThread(userAId, userBId) {
  const existing = getDMThread(userAId, userBId, 50, 0);
  if (existing.length >= 4) {
    return { success: true, messages: existing };
  }

  // Check feature pause
  if (isFeaturePaused('dm_generation')) {
    return { success: true, messages: existing, note: 'DM generation is paused' };
  }

  const quota = checkApiQuota('dm_generation');
  if (!quota.allowed) {
    return { success: true, messages: existing };
  }

  const allUsers = getAllUsers();
  const userA = allUsers.find(u => u.id === userAId);
  const userB = allUsers.find(u => u.id === userBId);

  if (!userA || !userB) {
    return { success: false, error: 'User(s) not found' };
  }

  const numMessages = Math.floor(Math.random() * 3) + 2;

  // Get recent DM memory for context
  const memA = getUserMemoryByType(userAId, 'dm', 2);
  const memB = getUserMemoryByType(userBId, 'dm', 2);

  let contextHint = '';
  if (memA.length > 0 || memB.length > 0) {
    contextHint = '\n以前のやりとりを踏まえた自然な続きの会話にしてください。\n';
  }

  const dmPrompt = `以下の2人のユーザー間のDMのやりとりを${numMessages}件生成してください。
交互にメッセージを送り合う形にしてください。

ユーザーA: 性格「${userA.personality}」、口調「${userA.tone}」
ユーザーB: 性格「${userB.personality}」、口調「${userB.tone}」
${contextHint}
${numMessages}行のメッセージのみを出力してください。
奇数行はユーザーA、偶数行はユーザーBのメッセージです。`;

  let rawText;
  try {
    rawText = await generateContent(DM_SYSTEM_INSTRUCTION, dmPrompt, {
      temperature: 1.0,
      maxOutputTokens: 512,
      feature: 'dm_generation',
    });
  } catch (error) {
    console.error(`[dm-generator] API error: ${error.message}`);
    return { success: true, messages: existing };
  }

  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 200);

  for (let i = 0; i < lines.length; i++) {
    const fromUser = i % 2 === 0 ? userAId : userBId;
    const toUser = i % 2 === 0 ? userBId : userAId;
    try {
      insertDM(fromUser, toUser, lines[i]);
      // Save to AI memory
      insertMemory(fromUser, 'dm', lines[i], `to_user=${toUser}`);
    } catch (dbError) {
      console.error(`[dm-generator] DB insert error: ${dbError.message}`);
    }
  }

  const allMessages = getDMThread(userAId, userBId, 50, 0);
  return { success: true, messages: allMessages };
}

// ===========================================================================
// リアクションチェーン (Reaction Chains)
// ===========================================================================

const REACTION_SCORE_THRESHOLD = 70;
const MAX_CHAIN_DEPTH = 3;

const REACTION_SYSTEM_INSTRUCTION = `あなたは架空のSNS「A-Talk」のユーザーです。
投稿とそのコメント欄を見て、AIユーザー同士が自然に会話を続けるリアクションチェーンを生成してください。

## ルール
- 各発言は15-80文字程度
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない
- 直前の発言に自然に反応する (同意、反論、追加情報、脱線、ツッコミなど)
- 会話が自然に流れること
- 全く同じ意見の繰り返しにならないこと
- 各発言は改行で区切る

## 出力形式
1行に1発言、改行区切りで出力してください。
発言以外は何も書かないでください。`;

function buildReactionChainPrompt(postContent, existingComments, reactors) {
  let context = `元の投稿:\n${postContent}\n`;

  if (existingComments.length > 0) {
    context += '\n既存のコメント:\n';
    for (const c of existingComments) {
      context += `- ${c.content}\n`;
    }
  }

  const reactorDescs = reactors
    .map((r, i) => `発言${i + 1}: 性格「${r.personality}」、口調「${r.tone}」`)
    .join('\n');

  return `以下の投稿とコメントを踏まえて、${reactors.length}人のユーザーが連鎖的に会話します。
1人目は投稿やコメントに反応し、2人目は1人目の発言に反応し、3人目は2人目の発言に反応します。
会話が自然につながるようにしてください。

${context}

リアクションするユーザー (この順番で発言):
${reactorDescs}

${reactors.length}行の発言のみを出力してください。`;
}

export async function generateReactionChain(postId) {
  const post = getPostById(postId);
  if (!post) {
    return { success: false, error: 'Post not found' };
  }

  if (post.popularity_score < REACTION_SCORE_THRESHOLD) {
    return { success: false, error: 'Post popularity score is below reaction threshold' };
  }

  const existingReactions = getReactionsByPostId(postId);
  if (existingReactions.length > 0) {
    return { success: true, reactions: existingReactions, chainGenerated: false };
  }

  // Check feature pause
  if (isFeaturePaused('reaction_chain')) {
    return { success: true, reactions: [], chainGenerated: false, note: 'Reaction chain is paused' };
  }

  const quota = checkApiQuota('reaction_chain');
  if (!quota.allowed) {
    return { success: true, reactions: [], chainGenerated: false };
  }

  const existingComments = getCommentsByPostId(postId);
  const allUsers = getAllUsers();
  const excludeIds = new Set([post.user_id]);
  for (const c of existingComments) {
    excludeIds.add(c.user_id);
  }

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
      buildReactionChainPrompt(post.content, existingComments, reactors),
      { temperature: 1.0, maxOutputTokens: 512, feature: 'reaction_chain' }
    );
  } catch (error) {
    console.error(`[reaction-chain] API error: ${error.message}`);
    return { success: true, reactions: [], chainGenerated: false };
  }

  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 200);

  let lastReactionId = null;
  for (let i = 0; i < Math.min(lines.length, reactors.length); i++) {
    try {
      const result = insertReaction(postId, reactors[i].id, lines[i], i, lastReactionId);
      lastReactionId = result.id;
      // Save to AI memory
      insertMemory(reactors[i].id, 'reaction', lines[i], `post_id=${postId},depth=${i}`);
      console.log(
        `[reaction-chain] Post #${postId} depth=${i}: ${reactors[i].username} -> "${lines[i].substring(0, 30)}..."`
      );
    } catch (dbError) {
      console.error(`[reaction-chain] DB insert error: ${dbError.message}`);
    }
  }

  const allReactions = getReactionsByPostId(postId);
  return { success: true, reactions: allReactions, chainGenerated: true };
}
