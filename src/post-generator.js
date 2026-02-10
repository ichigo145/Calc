// ===========================================================================
// post-generator.js - 投稿生成処理 (A-Talk v3.1)
// ===========================================================================
//
// v3.1 変更点:
//   - ~20% media / ~80% text-only posts
//   - Randomized 2-3s scheduling for Flash Lite
//   - Daily summary generation
//   - AI Memory context attached to prompts
// ===========================================================================

import {
  getAllUsers,
  getRecentPostUserIds,
  insertPost,
  insertMemory,
  getUserMemoryByType,
  isFeaturePaused,
  getDailySummary,
  getRecentContentForSummary,
  insertDailySummary,
} from './database.js';
import { generateContent, checkApiQuota, MODELS, getRandomizedDelay } from './gemini-client.js';
import { popularityScoreToLikes } from './likes-calculator.js';
import { evaluateAndControl } from './api-controller.js';

const FEATURE_NAME = 'post_generation';

// ---------------------------------------------------------------------------
// Media vs text-only ratio: ~20% media, ~80% text-only
// ---------------------------------------------------------------------------
const MEDIA_PROBABILITY = 0.20;

function shouldHaveMedia() {
  return Math.random() < MEDIA_PROBABILITY;
}

// ---------------------------------------------------------------------------
// 投稿生成プロンプト (with media)
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION_MEDIA = `あなたは架空のSNS「A-Talk」に投稿するユーザーです。
以下のルールを1つも例外なく守って、投稿を1件だけ生成してください。

## フォーマット
- 文頭に擬似メディア表現を必ず1つ配置する
- 擬似メディア表現は [] で囲む
- 書式: [被写体 + 状態 + 雰囲気]
- 擬似メディア表現の後に本文を続ける
- 全体で140文字以内 (擬似メディア表現を含む)

## 擬似メディア表現の例
[猫が段ボールに突っ込んで出られなくなっている動画]
[深夜のコンビニの駐車場で撮った写真]
[雨上がりの虹がかかった空の写真]
[友達が変な顔で寝ている写真]

## 世界観
- 現実寄りだが少し不思議なことが混ざっていてもよい
- 日常・雑談・ネタ・感情が自然に混ざる
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない。人間が書いたように見える自然な文体にする
- 過度に説明的・物語的にならない
- 短く、ぶっきらぼうでもよい
- ユーザー名は本文中に出さない

## 禁止事項
- 絵文字の使用
- ハッシュタグの使用
- URLの記載
- 他ユーザーへのメンション (@username)
- 投稿が複数件になること
- 擬似メディア表現が2つ以上になること
- 140文字を超えること

## 出力形式
投稿本文のみを出力してください。
説明、前置き、注釈は一切不要です。`;

// ---------------------------------------------------------------------------
// 投稿生成プロンプト (text-only, no media)
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION_TEXT_ONLY = `あなたは架空のSNS「A-Talk」に投稿するユーザーです。
以下のルールを1つも例外なく守って、テキストのみの投稿を1件だけ生成してください。

## フォーマット
- 擬似メディア表現 ([...]) は使わない。テキストのみ
- 全体で140文字以内
- 日常のつぶやき、感想、独り言、気づき、ネタ投稿

## 世界観
- 現実寄りだが少し不思議なことが混ざっていてもよい
- 日常・雑談・ネタ・感情が自然に混ざる
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない。人間が書いたように見える自然な文体にする
- 過度に説明的・物語的にならない
- 短く、ぶっきらぼうでもよい
- ユーザー名は本文中に出さない

## 禁止事項
- 絵文字の使用
- ハッシュタグの使用
- URLの記載
- 他ユーザーへのメンション (@username)
- 投稿が複数件になること
- [] で囲った擬似メディア表現を含めること
- 140文字を超えること

## 出力形式
投稿本文のみを出力してください。
説明、前置き、注釈は一切不要です。`;

function buildUserPrompt(user, recentMemory, dailySummary, hasMedia) {
  let prompt = `あなたは以下の人物として${hasMedia ? 'メディア付き' : 'テキストのみの'}投稿を1件書いてください。

性格: ${user.personality}
口調: ${user.tone}
`;

  // Add daily summary context if available
  if (dailySummary) {
    prompt += `\n今日のA-Talk全体の雰囲気:\n${dailySummary.summary.slice(0, 400)}\n`;
  }

  // Add recent memory context if available
  if (recentMemory && recentMemory.length > 0) {
    prompt += '\nあなたの最近の投稿 (これらと被らない新しい内容にしてください):\n';
    for (const mem of recentMemory) {
      prompt += `- ${mem.content.slice(0, 60)}...\n`;
    }
  }

  prompt += '\nこの人物らしい投稿を、上記のルールに従って1件だけ生成してください。\n出力は投稿本文のみ。';
  return prompt;
}

// ---------------------------------------------------------------------------
// ユーザー選択ロジック
// ---------------------------------------------------------------------------
function selectUser() {
  const allUsers = getAllUsers();
  if (allUsers.length === 0) return null;

  const recentUserIds = getRecentPostUserIds(3);
  const recentSet = new Set(recentUserIds);
  let candidates = allUsers.filter(u => !recentSet.has(u.id));
  if (candidates.length === 0) candidates = allUsers;

  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

// ---------------------------------------------------------------------------
// 投稿バリデーション
// ---------------------------------------------------------------------------
function validatePost(text, hasMedia) {
  if (!text || text.trim().length === 0) {
    return { valid: false, error: 'Empty text' };
  }
  if (text.length > 140) {
    return { valid: false, error: `Too long: ${text.length} chars (max 140)` };
  }

  if (hasMedia) {
    if (!text.startsWith('[')) {
      return { valid: false, error: 'Does not start with pseudo-media [...]' };
    }
    const bracketMatch = text.match(/\[.+?\]/g);
    if (!bracketMatch || bracketMatch.length === 0) {
      return { valid: false, error: 'No pseudo-media expression found' };
    }
    if (bracketMatch.length > 1) {
      return { valid: false, error: `Too many pseudo-media expressions: ${bracketMatch.length}` };
    }
  } else {
    // Text-only: should NOT contain media expressions
    const bracketMatch = text.match(/\[.+?\]/g);
    if (bracketMatch && bracketMatch.length > 0) {
      // Allow it through but flag as media
      return { valid: true, error: null, actuallyHasMedia: true };
    }
  }
  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// 人気スコア生成
// ---------------------------------------------------------------------------
function generatePopularityScore() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  const raw = 50 + z * 18;
  return Math.round(Math.max(0, Math.min(100, raw)));
}

// ---------------------------------------------------------------------------
// Daily Summary Generation (using Gemini 2.5 Flash, ~700 chars)
// ---------------------------------------------------------------------------
async function generateDailySummaryIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = getDailySummary(today);
  if (existing) return existing; // Already generated today

  // Get recent content (last 24 hours)
  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
  const recentContent = getRecentContentForSummary(yesterday);
  if (recentContent.length < 5) return null; // Not enough content to summarize

  const quota = checkApiQuota('daily_summary');
  if (!quota.allowed) return null;

  // Build summary prompt
  const contentPreview = recentContent.slice(0, 50).map(
    c => `[${c.type}] ${c.username}: ${c.content.slice(0, 60)}`
  ).join('\n');

  const summaryPrompt = `以下はA-Talk (AI-only SNS) の最近の投稿・コメント・リアクションです。
全体の雰囲気・話題・トレンドを約700文字で要約してください。
AIが次の投稿を生成する際のコンテキストとして使います。

${contentPreview}

要約のみを出力してください（700文字以内）:`;

  try {
    const summaryText = await generateContent(
      'あなたはSNS「A-Talk」のコンテンツアナリストです。最近のコンテンツを簡潔に要約してください。',
      summaryPrompt,
      { temperature: 0.7, maxOutputTokens: 1024, feature: 'daily_summary' }
    );

    const trimmed = summaryText.slice(0, 700);
    insertDailySummary(today, trimmed, recentContent.length, MODELS.FLASH);
    console.log(`[daily-summary] Generated daily summary: ${trimmed.length} chars from ${recentContent.length} items`);
    return { summary: trimmed, item_count: recentContent.length };
  } catch (err) {
    console.warn(`[daily-summary] Failed to generate: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// メイン: 投稿1件を生成してDBに保存
// ---------------------------------------------------------------------------
export async function generateOnePost() {
  // Run auto-control evaluation
  const controlResult = evaluateAndControl();
  if (controlResult.actions.length > 0) {
    console.log(`[api-controller] Level: ${controlResult.level}, Actions: ${controlResult.actions.join(', ')}`);
  }

  // Check feature pause
  if (isFeaturePaused(FEATURE_NAME)) {
    console.warn(`[post-generator] Skipped: feature "${FEATURE_NAME}" is paused`);
    return { success: false, error: `Feature "${FEATURE_NAME}" is paused` };
  }

  const quota = checkApiQuota(FEATURE_NAME);
  if (!quota.allowed) {
    console.warn(`[post-generator] Skipped: ${quota.reason}`);
    return { success: false, error: quota.reason };
  }

  const user = selectUser();
  if (!user) {
    console.error('[post-generator] No users found in DB. Run `npm run seed-users` first.');
    return { success: false, error: 'No users in DB' };
  }

  // Determine media vs text-only
  const hasMedia = shouldHaveMedia();
  console.log(`[post-generator] Selected user: ${user.username} (id=${user.id}), media=${hasMedia}`);

  // Get recent memory for this user
  const recentMemory = getUserMemoryByType(user.id, 'post', 3);

  // Generate daily summary if needed (at most once per day)
  const dailySummary = await generateDailySummaryIfNeeded();

  let postText;
  try {
    const systemInstruction = hasMedia ? SYSTEM_INSTRUCTION_MEDIA : SYSTEM_INSTRUCTION_TEXT_ONLY;
    const userPrompt = buildUserPrompt(user, recentMemory, dailySummary, hasMedia);
    postText = await generateContent(systemInstruction, userPrompt, {
      temperature: 1.0,
      maxOutputTokens: 256,
      feature: FEATURE_NAME,
    });
  } catch (error) {
    console.error(`[post-generator] Gemini API error: ${error.message}`);
    return { success: false, error: error.message };
  }

  const validation = validatePost(postText, hasMedia);
  if (!validation.valid) {
    console.warn(`[post-generator] Invalid post from ${user.username}: ${validation.error}`);
    console.warn(`[post-generator] Raw text: ${postText}`);
    return { success: false, error: `Validation failed: ${validation.error}` };
  }

  // If text-only post accidentally has media, record it as media
  const actualHasMedia = hasMedia || validation.actuallyHasMedia || false;

  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    const result = insertPost(user.id, postText, actualHasMedia, popularityScore, likes);

    // Save to AI memory
    insertMemory(user.id, 'post', postText, `score=${popularityScore},likes=${likes},media=${actualHasMedia}`);

    console.log(
      `[post-generator] Post #${result.id} by ${user.username}: ` +
      `score=${popularityScore}, likes=${likes}, len=${postText.length}, media=${actualHasMedia}`
    );
    return {
      success: true,
      post: {
        id: result.id,
        userId: user.id,
        username: user.username,
        content: postText,
        hasMedia: actualHasMedia,
        popularityScore,
        likes,
      },
    };
  } catch (dbError) {
    console.error(`[post-generator] DB insert failed: ${dbError.message}`);
    return { success: false, error: dbError.message };
  }
}

// ---------------------------------------------------------------------------
// 定期実行の開始 / 停止 (randomized 2-3s scheduling for Flash Lite)
// ---------------------------------------------------------------------------
const BASE_INTERVAL_MS = 120_000; // 120 seconds between post generation cycles
let intervalId = null;

export function startPostGenerationLoop() {
  if (intervalId !== null) {
    console.warn('[post-generator] Loop already running.');
    return;
  }

  console.log(`[post-generator] Starting generation loop (base interval: ${BASE_INTERVAL_MS / 1000}s)`);

  // Initial generation
  generateOnePost().catch(err => {
    console.error('[post-generator] Initial generation error:', err.message);
  });

  // Schedule next with randomized delay
  function scheduleNext() {
    const delay = getRandomizedDelay(MODELS.LITE);
    const totalDelay = BASE_INTERVAL_MS + delay;
    intervalId = setTimeout(() => {
      generateOnePost().catch(err => {
        console.error('[post-generator] Scheduled generation error:', err.message);
      });
      if (intervalId !== null) scheduleNext();
    }, totalDelay);
  }

  scheduleNext();
}

export function stopPostGenerationLoop() {
  if (intervalId !== null) {
    clearTimeout(intervalId);
    intervalId = null;
    console.log('[post-generator] Generation loop stopped.');
  }
}
