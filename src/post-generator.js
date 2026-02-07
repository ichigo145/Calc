// ===========================================================================
// post-generator.js - 投稿生成処理 (120秒間隔の定期実行) - A-Talk
// ===========================================================================
//
// 処理フロー:
//   1. APIクォータ確認 (950/日 を超えていないか)
//   2. AIユーザー15人からランダムに1人選択 (直近3投稿と被らないようにする)
//   3. そのユーザーの性格・口調をプロンプトに埋め込み、Gemini APIで投稿を生成
//   4. 人気スコア (0-100) をコード側で生成
//   5. 人気スコアからいいね数を算出
//   6. DBに保存
//
// 1回の生成で投稿は1件、APIリクエストも1回。
// 120秒間隔 = 1日最大720投稿 = 720 API リクエスト
// ===========================================================================

import {
  getAllUsers,
  getRecentPostUserIds,
  insertPost,
} from './database.js';
import { generateContent, checkApiQuota } from './gemini-client.js';
import { popularityScoreToLikes } from './likes-calculator.js';

// ---------------------------------------------------------------------------
// 投稿生成プロンプト (全文)
// ---------------------------------------------------------------------------

const SYSTEM_INSTRUCTION = `あなたは架空のSNS「A-Talk」に投稿するユーザーです。
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

/**
 * ユーザープロンプトを生成する。
 * @param {{ username: string, personality: string, tone: string }} user
 * @returns {string}
 */
function buildUserPrompt(user) {
  return `あなたは以下の人物として投稿を1件書いてください。

性格: ${user.personality}
口調: ${user.tone}

この人物らしい投稿を、上記のルールに従って1件だけ生成してください。
出力は投稿本文のみ。`;
}

// ---------------------------------------------------------------------------
// ユーザー選択ロジック
// ---------------------------------------------------------------------------

function selectUser() {
  const allUsers = getAllUsers();
  if (allUsers.length === 0) {
    return null;
  }

  const recentUserIds = getRecentPostUserIds(3);
  const recentSet = new Set(recentUserIds);
  let candidates = allUsers.filter(u => !recentSet.has(u.id));

  if (candidates.length === 0) {
    candidates = allUsers;
  }

  const index = Math.floor(Math.random() * candidates.length);
  return candidates[index];
}

// ---------------------------------------------------------------------------
// 投稿バリデーション
// ---------------------------------------------------------------------------

function validatePost(text) {
  if (!text || text.trim().length === 0) {
    return { valid: false, error: 'Empty text' };
  }

  if (text.length > 140) {
    return { valid: false, error: `Too long: ${text.length} chars (max 140)` };
  }

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

  return { valid: true, error: null };
}

// ---------------------------------------------------------------------------
// 人気スコア生成
// ---------------------------------------------------------------------------

function generatePopularityScore() {
  const u1 = Math.random();
  const u2 = Math.random();
  const z = Math.sqrt(-2.0 * Math.log(u1)) * Math.cos(2.0 * Math.PI * u2);

  const mean = 50;
  const stddev = 18;
  const raw = mean + z * stddev;

  const clamped = Math.max(0, Math.min(100, raw));
  return Math.round(clamped);
}

// ---------------------------------------------------------------------------
// メイン: 投稿1件を生成してDBに保存
// ---------------------------------------------------------------------------

export async function generateOnePost() {
  const quota = checkApiQuota();
  if (!quota.allowed) {
    console.warn(`[post-generator] Skipped: ${quota.reason}`);
    return { success: false, error: quota.reason };
  }

  const user = selectUser();
  if (!user) {
    console.error('[post-generator] No users found in DB. Run `npm run seed-users` first.');
    return { success: false, error: 'No users in DB' };
  }

  console.log(`[post-generator] Selected user: ${user.username} (id=${user.id})`);

  let postText;
  try {
    const userPrompt = buildUserPrompt(user);
    postText = await generateContent(SYSTEM_INSTRUCTION, userPrompt, {
      temperature: 1.0,
      maxOutputTokens: 256,
    });
  } catch (error) {
    console.error(`[post-generator] Gemini API error: ${error.message}`);
    return { success: false, error: error.message };
  }

  const validation = validatePost(postText);
  if (!validation.valid) {
    console.warn(`[post-generator] Invalid post from ${user.username}: ${validation.error}`);
    console.warn(`[post-generator] Raw text: ${postText}`);
    return { success: false, error: `Validation failed: ${validation.error}` };
  }

  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    const result = insertPost(user.id, postText, popularityScore, likes);
    console.log(
      `[post-generator] Post #${result.id} by ${user.username}: ` +
      `score=${popularityScore}, likes=${likes}, len=${postText.length}`
    );
    return {
      success: true,
      post: {
        id: result.id,
        userId: user.id,
        username: user.username,
        content: postText,
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
// 定期実行の開始 / 停止
// ---------------------------------------------------------------------------

const INTERVAL_MS = 120_000;
let intervalId = null;

export function startPostGenerationLoop() {
  if (intervalId !== null) {
    console.warn('[post-generator] Loop already running.');
    return;
  }

  console.log(`[post-generator] Starting generation loop (interval: ${INTERVAL_MS / 1000}s)`);

  generateOnePost().catch(err => {
    console.error('[post-generator] Initial generation error:', err.message);
  });

  intervalId = setInterval(() => {
    generateOnePost().catch(err => {
      console.error('[post-generator] Scheduled generation error:', err.message);
    });
  }, INTERVAL_MS);
}

export function stopPostGenerationLoop() {
  if (intervalId !== null) {
    clearInterval(intervalId);
    intervalId = null;
    console.log('[post-generator] Generation loop stopped.');
  }
}
