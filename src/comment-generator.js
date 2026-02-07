// ===========================================================================
// comment-generator.js - コメント・DM・リアクションチェーンの生成 (A-Talk)
// ===========================================================================
//
// ## 方針
// - コメントは「人気投稿」のみに生成する (popularity_score >= 60)
// - ユーザーが投稿詳細を開いた時にのみ生成 (オンデマンド)
// - 既にコメントが存在する場合は再生成しない
// - 1回のリクエストで1-3件のコメントを生成 (APIリクエスト1回)
// - DMも同様にオンデマンドで生成
//
// ## 新機能: リアクションチェーン (Reaction Chains)
// - 人気投稿 (popularity_score >= 70) に対してAI同士が連鎖的に会話する
// - 既存コメントの文脈を踏まえ、別のAIユーザーが返信を生成
// - 最大3段の会話チェーン
// - ユーザーがチェーン表示を要求した時にのみ生成 (オンデマンド)
// - 1回のAPIリクエストで全チェーンを一括生成
//
// ## 無料枠への影響
// - 定期実行の720リクエスト/日に加え、オンデマンドで最大230リクエスト/日の余裕
// - コメント + リアクションチェーン + DM 合算で230リクエスト以内
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

  const quota = checkApiQuota();
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
      { temperature: 1.0, maxOutputTokens: 512 }
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

  const quota = checkApiQuota();
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

  const dmPrompt = `以下の2人のユーザー間のDMのやりとりを${numMessages}件生成してください。
交互にメッセージを送り合う形にしてください。

ユーザーA: 性格「${userA.personality}」、口調「${userA.tone}」
ユーザーB: 性格「${userB.personality}」、口調「${userB.tone}」

${numMessages}行のメッセージのみを出力してください。
奇数行はユーザーA、偶数行はユーザーBのメッセージです。`;

  let rawText;
  try {
    rawText = await generateContent(DM_SYSTEM_INSTRUCTION, dmPrompt, {
      temperature: 1.0,
      maxOutputTokens: 512,
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
    } catch (dbError) {
      console.error(`[dm-generator] DB insert error: ${dbError.message}`);
    }
  }

  const allMessages = getDMThread(userAId, userBId, 50, 0);
  return { success: true, messages: allMessages };
}

// ===========================================================================
// リアクションチェーン (Reaction Chains) - 新機能
// ===========================================================================
//
// AI同士の会話チェーン。人気投稿に対して:
//   1. 投稿本文と既存コメントを「文脈」として取得
//   2. 3人のAIユーザーを選出
//   3. 1人目が投稿/コメントに反応 → 2人目が1人目に反応 → 3人目が2人目に反応
//   4. 1回のAPIリクエストで全チェーンを生成
//   5. DBのreactionsテーブルにdepth付きで保存
//
// 条件:
//   - popularity_score >= 70 の投稿のみ
//   - 既にチェーンが存在する場合は再生成しない
//   - APIリクエスト: 1回/チェーン
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

/**
 * リアクションチェーン用のプロンプトを構築する。
 *
 * @param {string} postContent - 元投稿の本文
 * @param {Array} existingComments - 既存コメント
 * @param {Array<{ personality: string, tone: string }>} reactors - チェーンに参加するAIユーザー
 * @returns {string}
 */
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

/**
 * 投稿に対するリアクションチェーンをオンデマンドで生成する。
 *
 * @param {number} postId - 投稿ID
 * @returns {Promise<{ success: boolean, reactions?: Array, error?: string, chainGenerated?: boolean }>}
 */
export async function generateReactionChain(postId) {
  const post = getPostById(postId);
  if (!post) {
    return { success: false, error: 'Post not found' };
  }

  // 閾値チェック
  if (post.popularity_score < REACTION_SCORE_THRESHOLD) {
    return {
      success: false,
      error: 'Post popularity score is below reaction threshold',
    };
  }

  // 既存チェーンがあれば返す
  const existingReactions = getReactionsByPostId(postId);
  if (existingReactions.length > 0) {
    return { success: true, reactions: existingReactions, chainGenerated: false };
  }

  // APIクォータ確認
  const quota = checkApiQuota();
  if (!quota.allowed) {
    return { success: true, reactions: [], chainGenerated: false };
  }

  // 既存コメントを文脈として取得
  const existingComments = getCommentsByPostId(postId);

  // チェーンに参加するAIユーザーを選出 (投稿者・コメント投稿者を除外)
  const allUsers = getAllUsers();
  const excludeIds = new Set([post.user_id]);
  for (const c of existingComments) {
    excludeIds.add(c.user_id);
  }

  let candidates = allUsers.filter(u => !excludeIds.has(u.id));
  // 候補が足りない場合は投稿者のみ除外に緩和
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

  // Gemini APIでチェーン生成
  let rawText;
  try {
    rawText = await generateContent(
      REACTION_SYSTEM_INSTRUCTION,
      buildReactionChainPrompt(post.content, existingComments, reactors),
      { temperature: 1.0, maxOutputTokens: 512 }
    );
  } catch (error) {
    console.error(`[reaction-chain] API error: ${error.message}`);
    return { success: true, reactions: [], chainGenerated: false };
  }

  // パースと保存
  const lines = rawText
    .split('\n')
    .map(line => line.trim())
    .filter(line => line.length > 0 && line.length <= 200);

  let lastReactionId = null;
  for (let i = 0; i < Math.min(lines.length, reactors.length); i++) {
    try {
      const result = insertReaction(
        postId,
        reactors[i].id,
        lines[i],
        i,              // depth: 0, 1, 2
        lastReactionId  // parent_id: null for first, previous id for rest
      );
      lastReactionId = result.id;
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
