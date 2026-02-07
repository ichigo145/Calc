// ===========================================================================
// seed-users.js - 初回のみ実行: AIユーザー15人を生成してDBに保存 (A-Talk)
// ===========================================================================
// 実行方法: npm run seed-users
//
// このスクリプトは以下を行う:
//   1. DBに既にユーザーが存在するか確認
//   2. 存在する場合は何もしない (冪等性)
//   3. 存在しない場合、Gemini APIで15人分のプロフィールを生成
//   4. 生成結果をパースしてDBに保存
//
// APIリクエスト数: 1回 (15人分を1リクエストで生成)
// ===========================================================================

import 'dotenv/config';
import { getUserCount, insertUsersTransaction, closeDatabase } from './database.js';
import { generateContent } from './gemini-client.js';

// ---------------------------------------------------------------------------
// AIユーザー生成プロンプト (全文)
// ---------------------------------------------------------------------------
const SYSTEM_INSTRUCTION = `あなたは架空のSNS「A-Talk」のユーザープロフィールを設計するアシスタントです。
以下のルールを厳密に守ってください:

1. 15人分のユーザープロフィールをJSON配列で出力すること
2. 各ユーザーは以下の3つのフィールドを持つ:
   - "username": 英数字またはひらがなで構成される一意のユーザー名 (3-12文字)
   - "personality": その人の性格・価値観を1-2文で簡潔に記述
   - "tone": 投稿時の口調を1文で具体的に記述
3. 15人全員が異なる性格であること
4. 実在の人物・有名人・キャラクターを連想させないこと
5. 日本語で記述すること
6. 絵文字は一切使用しないこと
7. 出力はJSON配列のみ。前後に説明文やコードブロックの記号を付けないこと

性格のバリエーション例 (これに限定されない):
- 楽観的でおしゃべり
- 皮肉屋だが根は優しい
- 理系脳で分析好き
- のんびり屋でマイペース
- 感情豊かでドラマチック
- 辛口だが的確
- 天然ボケ
- 哲学的で考え深い
- お節介な世話焼き
- クールで寡黙
- オタク気質で熱量が高い
- ネガティブだが憎めない
- ムードメーカー
- ミステリアスで不思議
- 真面目すぎて空回り`;

const USER_PROMPT = `上記のルールに従い、15人分のユーザープロフィールをJSON配列で生成してください。
出力形式:
[{"username":"...","personality":"...","tone":"..."},...]
JSON配列のみを出力し、それ以外は何も書かないでください。`;

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log('[A-Talk seed-users] Checking existing users...');

  const count = getUserCount();
  if (count >= 15) {
    console.log(`[A-Talk seed-users] Already ${count} users in DB. Skipping generation.`);
    closeDatabase();
    process.exit(0);
  }

  if (count > 0 && count < 15) {
    console.error(
      `[A-Talk seed-users] Found ${count} users (expected 0 or >=15). ` +
      'DB may be in inconsistent state. Please delete data/atalk.db and retry.'
    );
    closeDatabase();
    process.exit(1);
  }

  console.log('[A-Talk seed-users] No users found. Generating 15 AI users via Gemini...');

  let rawText;
  try {
    rawText = await generateContent(SYSTEM_INSTRUCTION, USER_PROMPT, {
      temperature: 1.0,
      maxOutputTokens: 2048,
    });
  } catch (error) {
    console.error('[A-Talk seed-users] Gemini API call failed:', error.message);
    closeDatabase();
    process.exit(1);
  }

  console.log('[A-Talk seed-users] Raw response received. Parsing JSON...');

  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let users;
  try {
    users = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('[A-Talk seed-users] Failed to parse JSON response.');
    console.error('[A-Talk seed-users] Raw text was:', rawText);
    console.error('[A-Talk seed-users] Parse error:', parseError.message);
    closeDatabase();
    process.exit(1);
  }

  if (!Array.isArray(users)) {
    console.error('[A-Talk seed-users] Response is not an array.');
    closeDatabase();
    process.exit(1);
  }

  if (users.length !== 15) {
    console.error(`[A-Talk seed-users] Expected 15 users but got ${users.length}.`);
    closeDatabase();
    process.exit(1);
  }

  const usernameSet = new Set();
  for (let i = 0; i < users.length; i++) {
    const u = users[i];
    if (!u.username || typeof u.username !== 'string' || u.username.trim().length === 0) {
      console.error(`[A-Talk seed-users] User ${i}: missing or empty username.`);
      closeDatabase();
      process.exit(1);
    }
    if (!u.personality || typeof u.personality !== 'string') {
      console.error(`[A-Talk seed-users] User ${i} (${u.username}): missing personality.`);
      closeDatabase();
      process.exit(1);
    }
    if (!u.tone || typeof u.tone !== 'string') {
      console.error(`[A-Talk seed-users] User ${i} (${u.username}): missing tone.`);
      closeDatabase();
      process.exit(1);
    }
    if (usernameSet.has(u.username)) {
      console.error(`[A-Talk seed-users] Duplicate username: ${u.username}`);
      closeDatabase();
      process.exit(1);
    }
    usernameSet.add(u.username);
  }

  try {
    insertUsersTransaction(users);
    console.log('[A-Talk seed-users] Successfully inserted 15 users into DB.');
  } catch (dbError) {
    console.error('[A-Talk seed-users] Database insert failed:', dbError.message);
    closeDatabase();
    process.exit(1);
  }

  for (const u of users) {
    console.log(`  - ${u.username}: ${u.personality} (${u.tone})`);
  }

  console.log('[A-Talk seed-users] Done. API requests used: 1');
  closeDatabase();
  process.exit(0);
}

main();
