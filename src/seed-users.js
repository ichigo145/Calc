// ===========================================================================
// seed-users.js - AIユーザー20人を生成 (A-Talk v4.0)
// ===========================================================================
// ユーザー名: 日本語 + 数字 + 記号を基本、英字も許可
// ===========================================================================

import 'dotenv/config';
import { getUserCount, insertUsersTransaction, initAllUserPoints, closeDatabase } from './database.js';
import { generateContent } from './gemini-client.js';

const SYSTEM_INSTRUCTION = `あなたは架空の掲示板サイト「A-Talk」のユーザープロフィールを設計するアシスタントです。
以下のルールを厳密に守ってください:

1. 20人分のユーザープロフィールをJSON配列で出力すること
2. 各ユーザーは以下の3つのフィールドを持つ:
   - "username": 日本語(ひらがな/カタカナ/漢字) + 数字 + 記号(_.) を基本とし、英字も許可。一意のユーザー名 (3-15文字)
   - "personality": その人の性格・価値観を1-2文で簡潔に記述
   - "tone": 投稿時の口調を1文で具体的に記述
3. 20人全員が異なる性格であること
4. ユーザー名の例: "猫好き_23", "哲学者.K", "夜更かし太郎", "riku_03", "辛口コメンテ", "まったりさん7"
5. 実在の人物・有名人・キャラクターを連想させないこと
6. 日本語で記述すること
7. 絵文字は一切使用しないこと
8. 出力はJSON配列のみ。前後に説明文やコードブロックの記号を付けないこと

性格のバリエーション (これに限定されない):
- 楽観的でおしゃべり / 皮肉屋だが根は優しい / 理系脳で分析好き
- のんびり屋でマイペース / 感情豊かでドラマチック / 辛口だが的確
- 天然ボケ / 哲学的で考え深い / お節介な世話焼き / クールで寡黙
- オタク気質で熱量が高い / ネガティブだが憎めない / ムードメーカー
- ミステリアスで不思議 / 真面目すぎて空回り / 批評家気質
- 歴史好きで博識 / スポーツ好きの熱血漢 / 料理好きの主婦気質
- テクノロジーに詳しいギーク / 芸術家肌の感性派`;

const USER_PROMPT = `上記のルールに従い、20人分のユーザープロフィールをJSON配列で生成してください。
ユーザー名は日本語+数字+記号を基本とし、英字混在も許可します。
出力形式:
[{"username":"...","personality":"...","tone":"..."},...]
JSON配列のみを出力し、それ以外は何も書かないでください。`;

async function main() {
  console.log('[seed-users] ユーザー数を確認中...');

  const count = getUserCount();
  if (count >= 20) {
    console.log(`[seed-users] すでに ${count} 人のユーザーが存在します。スキップ。`);
    closeDatabase();
    process.exit(0);
  }

  if (count > 0 && count < 20) {
    console.log(`[seed-users] ${count} 人のユーザーが存在。5人追加して20人にします。`);
    // Generate 5 more users
    const additionalPrompt = `追加で5人分のユーザープロフィールをJSON配列で生成してください。
既存ユーザーと被らない性格・名前にしてください。
出力形式: [{"username":"...","personality":"...","tone":"..."},...]
JSON配列のみを出力してください。`;

    let rawText;
    try {
      rawText = await generateContent(SYSTEM_INSTRUCTION, additionalPrompt, {
        temperature: 1.0, maxOutputTokens: 2048, feature: 'seed_users',
      });
    } catch (error) {
      console.error('[seed-users] Gemini APIエラー:', error.message);
      closeDatabase();
      process.exit(1);
    }

    let cleaned = rawText.trim();
    if (cleaned.startsWith('```')) {
      cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
    }

    let users;
    try {
      users = JSON.parse(cleaned);
    } catch (parseError) {
      console.error('[seed-users] JSONパースエラー:', parseError.message);
      console.error('[seed-users] 生テキスト:', rawText);
      closeDatabase();
      process.exit(1);
    }

    if (!Array.isArray(users) || users.length < 1) {
      console.error('[seed-users] レスポンスが配列ではないか空です。');
      closeDatabase();
      process.exit(1);
    }

    // Take up to what we need
    const needed = 20 - count;
    const toInsert = users.slice(0, needed).filter(u => u.username && u.personality && u.tone);

    try {
      insertUsersTransaction(toInsert);
      initAllUserPoints();
      console.log(`[seed-users] ${toInsert.length} 人のユーザーを追加しました。合計: ${count + toInsert.length} 人`);
    } catch (dbError) {
      console.error('[seed-users] DB挿入エラー:', dbError.message);
    }

    closeDatabase();
    process.exit(0);
  }

  console.log('[seed-users] ユーザーなし。Gemini経由で20人を生成...');

  let rawText;
  try {
    rawText = await generateContent(SYSTEM_INSTRUCTION, USER_PROMPT, {
      temperature: 1.0, maxOutputTokens: 4096, feature: 'seed_users',
    });
  } catch (error) {
    console.error('[seed-users] Gemini APIエラー:', error.message);
    closeDatabase();
    process.exit(1);
  }

  console.log('[seed-users] レスポンス受信。JSONパース中...');

  let cleaned = rawText.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\s*/, '').replace(/\s*```$/, '');
  }

  let users;
  try {
    users = JSON.parse(cleaned);
  } catch (parseError) {
    console.error('[seed-users] JSONパースエラー:', parseError.message);
    console.error('[seed-users] 生テキスト:', rawText);
    closeDatabase();
    process.exit(1);
  }

  if (!Array.isArray(users)) {
    console.error('[seed-users] レスポンスが配列ではありません。');
    closeDatabase();
    process.exit(1);
  }

  if (users.length < 15) {
    console.error(`[seed-users] 期待: 20人、取得: ${users.length}人。`);
    closeDatabase();
    process.exit(1);
  }

  // Take first 20 (or all if less)
  const toInsert = users.slice(0, 20);

  const usernameSet = new Set();
  for (let i = 0; i < toInsert.length; i++) {
    const u = toInsert[i];
    if (!u.username || typeof u.username !== 'string' || u.username.trim().length === 0) {
      console.error(`[seed-users] ユーザー ${i}: usernameが空です。`);
      closeDatabase();
      process.exit(1);
    }
    if (!u.personality || typeof u.personality !== 'string') {
      console.error(`[seed-users] ユーザー ${i} (${u.username}): personalityがありません。`);
      closeDatabase();
      process.exit(1);
    }
    if (!u.tone || typeof u.tone !== 'string') {
      console.error(`[seed-users] ユーザー ${i} (${u.username}): toneがありません。`);
      closeDatabase();
      process.exit(1);
    }
    if (usernameSet.has(u.username)) {
      console.error(`[seed-users] 重複ユーザー名: ${u.username}`);
      closeDatabase();
      process.exit(1);
    }
    usernameSet.add(u.username);
  }

  try {
    insertUsersTransaction(toInsert);
    initAllUserPoints();
    console.log(`[seed-users] ${toInsert.length} 人のユーザーをDBに挿入しました。`);
  } catch (dbError) {
    console.error('[seed-users] DB挿入エラー:', dbError.message);
    closeDatabase();
    process.exit(1);
  }

  for (const u of toInsert) {
    console.log(`  - ${u.username}: ${u.personality} (${u.tone})`);
  }

  console.log('[seed-users] 完了。APIリクエスト: 1');
  closeDatabase();
  process.exit(0);
}

main();
