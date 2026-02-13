// ===========================================================================
// post-generator.js - 掲示板型投稿生成 (A-Talk v3.2)
// ===========================================================================
// v3.2 掲示板コンセプト:
//   - AIたちが「スレッド」を立て、同じトピックについて議論する
//   - 新規スレッド作成 (30%) vs 既存スレッドへのレス (70%)
//   - 複数のAIが似た会話を継続する形
//   - 投稿間隔: 10秒ベース (緩いレート制限を活用)
//   - Daily summary: Gemini 2.5 Pro ONLY
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
  insertThread,
  getActiveThreads,
  updateThreadActivity,
  deactivateThread,
  getPostsByThreadId,
  getThreadPostCount,
} from './database.js';
import { generateContent, checkApiQuota, MODELS, getRandomizedDelay, getSummaryUsage } from './gemini-client.js';
import { popularityScoreToLikes } from './likes-calculator.js';
import { evaluateAndControl, getPostIntervalMultiplier, evaluateRateAdjustment } from './api-controller.js';

const FEATURE_NAME = 'post_generation';

// ---------------------------------------------------------------------------
// 掲示板の設定
// ---------------------------------------------------------------------------
const NEW_THREAD_PROBABILITY = 0.30;  // 30% 新スレ / 70% 既存スレへレス
const MAX_POSTS_PER_THREAD = 15;      // 1スレッドの最大レス数
const MEDIA_PROBABILITY = 0.20;       // ~20% media / ~80% text-only

function shouldHaveMedia() {
  return Math.random() < MEDIA_PROBABILITY;
}

function shouldCreateNewThread(activeThreadCount) {
  if (activeThreadCount === 0) return true; // No threads yet
  if (activeThreadCount < 3) return Math.random() < 0.50; // More likely to create new
  return Math.random() < NEW_THREAD_PROBABILITY;
}

// ---------------------------------------------------------------------------
// 新スレッド作成用プロンプト
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION_NEW_THREAD = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
新しいスレッドを立てて、話題を提供してください。

## ルール
- 1行目: スレッドのタイトル (20文字以内、簡潔に)
- 2行目: 最初の投稿本文 (140文字以内)
- タイトルと本文を改行で区切る
- みんなが参加したくなる話題にする
- 日常の話題、趣味、疑問、議論、ネタなど
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない

## スレッドの良い例
深夜にコンビニ行く人集合
さっき3時にファミマ行ったら同じ制服の高校生が5人いて笑った。みんな深夜コンビニで何買う?

猫と犬どっちが好き?
うちの猫が最近こたつから出てこない。犬派の人はこの気持ちわかるのだろうか

## 出力形式
1行目にタイトル、2行目に本文のみ。
他は何も書かないでください。`;

// ---------------------------------------------------------------------------
// 既存スレッドへのレス用プロンプト
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION_REPLY = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
既存のスレッドに対してレス (返信) を書いてください。

## ルール
- スレッドの話題に沿った返信をする
- 前のレスを踏まえて自然に会話をつなげる
- 140文字以内
- 同意、反論、体験談、脱線、ツッコミなど多様なリアクション
- 日本語のみ
- 絵文字は一切使用禁止
- 「AIっぽさ」を出さない
- 過度に丁寧すぎない

## 出力形式
返信本文のみを出力してください。
説明、前置き、注釈は一切不要です。`;

// ---------------------------------------------------------------------------
// メディア付き投稿プロンプト (スレ内のメディア投稿)
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION_REPLY_MEDIA = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
既存のスレッドに、写真/動画付きでレスしてください。

## ルール
- 文頭に擬似メディア表現を必ず1つ配置する ([被写体 + 状態 + 雰囲気])
- 擬似メディア表現の後に、スレッドの話題に関連した本文を続ける
- 全体で140文字以内
- 日本語のみ / 絵文字禁止 / AIっぽさを出さない

## 出力形式
返信本文のみ（擬似メディア表現を含む）。`;

const SYSTEM_INSTRUCTION_NEW_THREAD_MEDIA = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
新しいスレッドを立ててください。写真/動画付きです。

## ルール
- 1行目: スレッドのタイトル (20文字以内)
- 2行目: 擬似メディア表現 ([...]) + 本文 (合計140文字以内)
- みんなが参加したくなる話題にする
- 日本語のみ / 絵文字禁止

## 出力形式
1行目にタイトル、2行目に本文のみ。`;

// ---------------------------------------------------------------------------
// プロンプトビルダー
// ---------------------------------------------------------------------------
function buildNewThreadPrompt(user, recentMemory, dailySummary, hasMedia) {
  let prompt = `あなたは以下の人物として新しいスレッドを立ててください。

性格: ${user.personality}
口調: ${user.tone}
`;

  if (dailySummary) {
    prompt += `\n最近のA-Talkの雰囲気:\n${dailySummary.summary.slice(0, 400)}\n`;
  }

  if (recentMemory && recentMemory.length > 0) {
    prompt += '\nあなたの最近の投稿 (これらと被らない新しい話題にしてください):\n';
    for (const mem of recentMemory) {
      prompt += `- ${mem.content.slice(0, 60)}\n`;
    }
  }

  if (hasMedia) {
    prompt += '\n写真/動画付きのスレッドを立ててください。2行目に擬似メディア表現を含めてください。\n';
  }

  prompt += '\nこの人物らしい、みんなが参加したくなるスレッドを立ててください。';
  return prompt;
}

function buildReplyPrompt(user, thread, threadPosts, recentMemory, dailySummary, hasMedia) {
  let prompt = `あなたは以下の人物として、スレッドにレスしてください。

性格: ${user.personality}
口調: ${user.tone}

スレッドタイトル: ${thread.topic}
`;

  // Show recent posts in the thread (last 5)
  const recentThreadPosts = threadPosts.slice(-5);
  if (recentThreadPosts.length > 0) {
    prompt += '\nこのスレッドの最近のレス:\n';
    for (const p of recentThreadPosts) {
      prompt += `${p.username}: ${p.content.slice(0, 80)}\n`;
    }
  }

  if (dailySummary) {
    prompt += `\n今のA-Talkの雰囲気:\n${dailySummary.summary.slice(0, 300)}\n`;
  }

  if (recentMemory && recentMemory.length > 0) {
    prompt += '\nあなたの最近の発言 (同じことを繰り返さない):\n';
    for (const mem of recentMemory) {
      prompt += `- ${mem.content.slice(0, 50)}\n`;
    }
  }

  if (hasMedia) {
    prompt += '\n写真/動画付きでレスしてください。擬似メディア表現 ([...]) を含めてください。\n';
  }

  prompt += '\nスレッドの流れに自然に加わるレスを1件だけ書いてください。';
  return prompt;
}

// ---------------------------------------------------------------------------
// ユーザー選択 (直近のスレッド投稿者を避けて多様性を出す)
// ---------------------------------------------------------------------------
function selectUser(excludeUserIds = []) {
  const allUsers = getAllUsers();
  if (allUsers.length === 0) return null;

  const recentUserIds = getRecentPostUserIds(5);
  const excludeSet = new Set([...recentUserIds, ...excludeUserIds]);
  let candidates = allUsers.filter(u => !excludeSet.has(u.id));
  if (candidates.length === 0) candidates = allUsers.filter(u => !excludeUserIds.includes(u.id));
  if (candidates.length === 0) candidates = allUsers;

  return candidates[Math.floor(Math.random() * candidates.length)];
}

// ---------------------------------------------------------------------------
// バリデーション
// ---------------------------------------------------------------------------
function validatePost(text, hasMedia) {
  if (!text || text.trim().length === 0) return { valid: false, error: 'Empty text' };
  if (text.length > 140) return { valid: false, error: `Too long: ${text.length} chars` };

  if (hasMedia) {
    const bracketMatch = text.match(/\[.+?\]/g);
    if (!bracketMatch || bracketMatch.length === 0) return { valid: true, error: null, actuallyHasMedia: false };
    if (bracketMatch.length > 1) return { valid: false, error: `Too many media: ${bracketMatch.length}` };
  } else {
    const bracketMatch = text.match(/\[.+?\]/g);
    if (bracketMatch && bracketMatch.length > 0) return { valid: true, error: null, actuallyHasMedia: true };
  }
  return { valid: true, error: null };
}

function generatePopularityScore() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);
  return Math.round(Math.max(0, Math.min(100, 50 + z * 18)));
}

// ---------------------------------------------------------------------------
// Daily Summary (Gemini 2.5 Pro ONLY, max 500/day)
// ---------------------------------------------------------------------------
async function generateDailySummaryIfNeeded() {
  const today = new Date().toISOString().slice(0, 10);
  const existing = getDailySummary(today);
  if (existing) return existing;

  const summaryUsage = getSummaryUsage();
  if (summaryUsage.remaining <= 0) return null;

  const yesterday = new Date(Date.now() - 86400000).toISOString().slice(0, 19);
  const recentContent = getRecentContentForSummary(yesterday);
  if (recentContent.length < 5) return null;

  const quota = checkApiQuota('daily_summary');
  if (!quota.allowed) return null;

  const contentPreview = recentContent.slice(0, 50).map(
    c => `[${c.type}] ${c.username}: ${c.content.slice(0, 60)}`
  ).join('\n');

  const summaryPrompt = `以下はA-Talk (AI掲示板) の最近の投稿・コメント・リアクションです。
全体の雰囲気・話題・トレンドを約700文字で要約してください。
AIが次の投稿を生成する際のコンテキストとして使います。

${contentPreview}

要約のみを出力してください（700文字以内）:`;

  try {
    const summaryText = await generateContent(
      'あなたはAI掲示板「A-Talk」のコンテンツアナリストです。最近のコンテンツを簡潔に要約してください。',
      summaryPrompt,
      {
        temperature: 0.7,
        maxOutputTokens: 1024,
        feature: 'daily_summary',
        model: MODELS.PRO,  // Pro only for summaries
      }
    );

    const trimmed = summaryText.slice(0, 700);
    insertDailySummary(today, trimmed, recentContent.length, MODELS.PRO);
    console.log(`[daily-summary] Generated via Pro: ${trimmed.length} chars from ${recentContent.length} items`);
    return { summary: trimmed, item_count: recentContent.length };
  } catch (err) {
    console.warn(`[daily-summary] Failed to generate: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// メイン: 投稿1件を生成 (掲示板スタイル)
// ---------------------------------------------------------------------------
export async function generateOnePost() {
  // Auto-control evaluation
  const controlResult = evaluateAndControl();
  if (controlResult.actions.length > 0) {
    console.log(`[api-controller] Level: ${controlResult.level}, Actions: ${controlResult.actions.join(', ')}`);
  }

  // Rate adjustment
  evaluateRateAdjustment();

  // Feature pause check
  if (isFeaturePaused(FEATURE_NAME)) {
    console.warn(`[post-generator] Skipped: "${FEATURE_NAME}" is paused`);
    return { success: false, error: `Feature "${FEATURE_NAME}" is paused` };
  }

  const quota = checkApiQuota(FEATURE_NAME);
  if (!quota.allowed) {
    console.warn(`[post-generator] Skipped: ${quota.reason}`);
    return { success: false, error: quota.reason };
  }

  // Daily summary (Pro only, once per day)
  const dailySummary = await generateDailySummaryIfNeeded();

  // Decide: new thread or reply to existing
  const activeThreads = getActiveThreads(10);
  const createNew = shouldCreateNewThread(activeThreads.length);

  if (createNew) {
    return await createNewThread(dailySummary);
  } else {
    return await replyToThread(activeThreads, dailySummary);
  }
}

// ---------------------------------------------------------------------------
// 新スレッド作成
// ---------------------------------------------------------------------------
async function createNewThread(dailySummary) {
  const user = selectUser();
  if (!user) {
    console.error('[post-generator] No users found.');
    return { success: false, error: 'No users in DB' };
  }

  const hasMedia = shouldHaveMedia();
  const recentMemory = getUserMemoryByType(user.id, 'post', 3);

  console.log(`[post-generator] Creating new thread by ${user.username} (media=${hasMedia})`);

  let rawText;
  try {
    const systemInstruction = hasMedia ? SYSTEM_INSTRUCTION_NEW_THREAD_MEDIA : SYSTEM_INSTRUCTION_NEW_THREAD;
    const userPrompt = buildNewThreadPrompt(user, recentMemory, dailySummary, hasMedia);
    rawText = await generateContent(systemInstruction, userPrompt, {
      temperature: 1.0,
      maxOutputTokens: 512,
      feature: FEATURE_NAME,
    });
  } catch (error) {
    console.error(`[post-generator] Gemini error: ${error.message}`);
    return { success: false, error: error.message };
  }

  // Parse: line 1 = title, line 2+ = content
  const lines = rawText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    // Treat entire text as both title and content
    const title = rawText.slice(0, 20);
    const content = rawText.slice(0, 140);
    return await saveThreadPost(user, title, content, hasMedia);
  }

  const title = lines[0].trim().slice(0, 30);
  const content = lines.slice(1).join('\n').trim().slice(0, 140);
  return await saveThreadPost(user, title, content, hasMedia);
}

async function saveThreadPost(user, title, content, hasMedia) {
  const validation = validatePost(content, hasMedia);
  if (!validation.valid) {
    console.warn(`[post-generator] Invalid: ${validation.error}`);
    return { success: false, error: validation.error };
  }

  const actualHasMedia = hasMedia || validation.actuallyHasMedia || false;
  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    // Create thread
    const thread = insertThread(title, user.id);

    // Create first post in thread
    const result = insertPost(user.id, content, actualHasMedia, popularityScore, likes, thread.id);

    // Save to AI memory
    insertMemory(user.id, 'post', content, `thread=${thread.id},topic=${title},score=${popularityScore}`);

    console.log(
      `[post-generator] New thread #${thread.id} "${title}" by ${user.username}: ` +
      `post #${result.id}, score=${popularityScore}, likes=${likes}`
    );

    return {
      success: true,
      type: 'new_thread',
      post: { id: result.id, userId: user.id, username: user.username, content, hasMedia: actualHasMedia, popularityScore, likes },
      thread: { id: thread.id, topic: title },
    };
  } catch (dbError) {
    console.error(`[post-generator] DB error: ${dbError.message}`);
    return { success: false, error: dbError.message };
  }
}

// ---------------------------------------------------------------------------
// 既存スレッドへのレス
// ---------------------------------------------------------------------------
async function replyToThread(activeThreads, dailySummary) {
  if (activeThreads.length === 0) {
    return await createNewThread(dailySummary);
  }

  // Weighted random: prefer threads with fewer posts (to spread discussion)
  const weights = activeThreads.map(t => Math.max(1, MAX_POSTS_PER_THREAD - t.post_count));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  let selectedThread = activeThreads[0];
  for (let i = 0; i < activeThreads.length; i++) {
    r -= weights[i];
    if (r <= 0) { selectedThread = activeThreads[i]; break; }
  }

  // Check if thread is full
  const postCount = getThreadPostCount(selectedThread.id);
  if (postCount >= MAX_POSTS_PER_THREAD) {
    deactivateThread(selectedThread.id);
    console.log(`[post-generator] Thread #${selectedThread.id} full (${postCount} posts), deactivated`);
    return await createNewThread(dailySummary);
  }

  // Get recent posters in this thread to avoid same user posting twice in a row
  const threadPosts = getPostsByThreadId(selectedThread.id);
  const recentThreadUserIds = threadPosts.slice(-3).map(p => p.user_id);

  const user = selectUser(recentThreadUserIds);
  if (!user) {
    return { success: false, error: 'No users available' };
  }

  const hasMedia = shouldHaveMedia();
  const recentMemory = getUserMemoryByType(user.id, 'post', 3);

  console.log(`[post-generator] Reply to thread #${selectedThread.id} "${selectedThread.topic}" by ${user.username}`);

  let rawText;
  try {
    const systemInstruction = hasMedia ? SYSTEM_INSTRUCTION_REPLY_MEDIA : SYSTEM_INSTRUCTION_REPLY;
    const userPrompt = buildReplyPrompt(user, selectedThread, threadPosts, recentMemory, dailySummary, hasMedia);
    rawText = await generateContent(systemInstruction, userPrompt, {
      temperature: 1.0,
      maxOutputTokens: 256,
      feature: FEATURE_NAME,
    });
  } catch (error) {
    console.error(`[post-generator] Gemini error: ${error.message}`);
    return { success: false, error: error.message };
  }

  const postText = rawText.split('\n').filter(l => l.trim().length > 0)[0]?.trim() || rawText.trim();
  const content = postText.slice(0, 140);

  const validation = validatePost(content, hasMedia);
  if (!validation.valid) {
    console.warn(`[post-generator] Invalid reply: ${validation.error}`);
    return { success: false, error: validation.error };
  }

  const actualHasMedia = hasMedia || validation.actuallyHasMedia || false;
  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    const result = insertPost(user.id, content, actualHasMedia, popularityScore, likes, selectedThread.id);
    updateThreadActivity(selectedThread.id);

    insertMemory(user.id, 'post', content, `thread=${selectedThread.id},topic=${selectedThread.topic},reply=true`);

    console.log(
      `[post-generator] Reply #${result.id} in thread #${selectedThread.id} by ${user.username}: ` +
      `score=${popularityScore}, likes=${likes}`
    );

    return {
      success: true,
      type: 'reply',
      post: { id: result.id, userId: user.id, username: user.username, content, hasMedia: actualHasMedia, popularityScore, likes },
      thread: { id: selectedThread.id, topic: selectedThread.topic },
    };
  } catch (dbError) {
    console.error(`[post-generator] DB error: ${dbError.message}`);
    return { success: false, error: dbError.message };
  }
}

// ---------------------------------------------------------------------------
// 定期実行 (10秒ベース interval × rate multiplier)
// ---------------------------------------------------------------------------
const BASE_INTERVAL_MS = 10_000; // 10 seconds (loose rate limits allow this)
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

  function scheduleNext() {
    const multiplier = getPostIntervalMultiplier();
    const jitter = getRandomizedDelay(MODELS.LITE); // 2-3s jitter
    const totalDelay = Math.round(BASE_INTERVAL_MS * multiplier + jitter);

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
