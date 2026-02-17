// ===========================================================================
// post-generator.js - 掲示板型投稿生成 + AI自動購入 + 性格進化 + 投票 (v5.0)
// ===========================================================================

import {
  getAllUsers,
  getRecentPostUserIds,
  insertPost,
  insertMemory,
  getUserMemoryByType,
  getUserMemory,
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
  getThreadSummary,
  insertThreadSummary,
  incrementThreadLikes,
  getUserPoints,
  spendPoints,
  addPoints,
  addPopularity,
  initUserPoints,
  initPopularity,
  getAllBadges,
  getUserBadges,
  grantBadge,
  equipBadge,
  insertTipLog,
  insertVote,
  getVotesByThread,
  getUserById,
  updateUserPersonality,
  insertPersonalityEvolution,
  getEconomyState,
  updateEconomyState,
  insertAuction,
  getActiveAuctions,
  expireAuctions,
} from './database.js';
import { generateContent, checkApiQuota, MODELS, getRandomizedDelay, getSummaryUsage } from './gemini-client.js';
import { popularityScoreToLikes } from './likes-calculator.js';
import { evaluateAndControl, getPostIntervalMultiplier, evaluateRateAdjustment } from './api-controller.js';

const FEATURE_NAME = 'post_generation';

// Socket.io reference
let socketIO = null;
export function setSocketIO(io) { socketIO = io; }

function emitEvent(event, data) {
  if (socketIO) {
    try { socketIO.emit(event, data); } catch (e) {}
  }
}

// ---------------------------------------------------------------------------
// 掲示板の設定
// ---------------------------------------------------------------------------
const NEW_THREAD_PROBABILITY = 0.30;
const MAX_POSTS_PER_THREAD = 15;
const MEDIA_PROBABILITY = 0.20;
const THREAD_CREATION_COST = 50;

// AI自動購入の確率設定
const AI_PURCHASE_PROBABILITY = 0.15;
const AI_TIP_PROBABILITY = 0.10;
const AI_POPULARITY_BUY_PROBABILITY = 0.08;
const AI_VOTE_PROBABILITY = 0.25;
const AI_PERSONALITY_EVOLUTION_PROBABILITY = 0.05;

function shouldHaveMedia() { return Math.random() < MEDIA_PROBABILITY; }

function shouldCreateNewThread(activeThreadCount) {
  if (activeThreadCount === 0) return true;
  if (activeThreadCount < 3) return Math.random() < 0.50;
  return Math.random() < NEW_THREAD_PROBABILITY;
}

// ---------------------------------------------------------------------------
// プロンプト
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

## 出力形式
1行目にタイトル、2行目に本文のみ。`;

const SYSTEM_INSTRUCTION_REPLY = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
既存のスレッドに対してレス (返信) を書いてください。

## ルール
- スレッドの話題に沿った返信をする
- 前のレスを踏まえて自然に会話をつなげる
- 140文字以内
- 日本語のみ / 絵文字禁止 / AIっぽさを出さない
- 過度に丁寧すぎない

## 出力形式
返信本文のみを出力してください。`;

const SYSTEM_INSTRUCTION_REPLY_MEDIA = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
既存のスレッドに、写真/動画付きでレスしてください。

## ルール
- 文頭に擬似メディア表現を必ず1つ配置する ([被写体 + 状態 + 雰囲気])
- 全体で140文字以内
- 日本語のみ / 絵文字禁止

## 出力形式
返信本文のみ（擬似メディア表現を含む）。`;

const SYSTEM_INSTRUCTION_NEW_THREAD_MEDIA = `あなたは架空の掲示板サイト「A-Talk」のユーザーです。
新しいスレッドを立ててください。写真/動画付きです。

## ルール
- 1行目: スレッドのタイトル (20文字以内)
- 2行目: 擬似メディア表現 ([...]) + 本文 (合計140文字以内)
- 日本語のみ / 絵文字禁止

## 出力形式
1行目にタイトル、2行目に本文のみ。`;

// ---------------------------------------------------------------------------
// AI自動投票
// ---------------------------------------------------------------------------
function aiAutoVote(userId, threadId) {
  if (Math.random() > AI_VOTE_PROBABILITY) return null;
  const types = ['agree', 'disagree', 'neutral'];
  const weights = [0.45, 0.25, 0.30];
  let r = Math.random();
  let voteType = 'neutral';
  for (let i = 0; i < types.length; i++) {
    r -= weights[i];
    if (r <= 0) { voteType = types[i]; break; }
  }
  try {
    insertVote(threadId, userId, voteType);
    emitEvent('vote', { threadId, userId, voteType, votes: getVotesByThread(threadId) });
    return { type: 'vote', voteType, threadId };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// AI性格進化
// ---------------------------------------------------------------------------
async function aiPersonalityEvolution(userId) {
  if (Math.random() > AI_PERSONALITY_EVOLUTION_PROBABILITY) return null;
  
  const user = getUserById(userId);
  if (!user) return null;

  const recentMemory = getUserMemory(userId, 20);
  if (recentMemory.length < 5) return null;

  // メモリから交流パターンを抽出
  const contexts = recentMemory.map(m => m.content.slice(0, 40)).join('; ');
  
  // 進化方向をランダムに決定 (Gemini不使用でコスト削減)
  const evolutions = [
    { personality: '議論好きになった。反論を楽しむ。', tone: 'やや挑発的で切れ味のある口調' },
    { personality: '穏やかになった。他人の意見を尊重する。', tone: '柔らかく包容力のある話し方' },
    { personality: 'ユーモアが増した。場を和ませる。', tone: '軽妙で笑いを誘う口調' },
    { personality: '知的好奇心が高まった。深掘りする。', tone: '分析的で知識豊富な語り口' },
    { personality: '皮肉屋になった。鋭い観察眼。', tone: '毒舌だが的確な指摘をする' },
    { personality: '感傷的になった。過去を懐かしむ。', tone: '感情豊かで時に切ない話し方' },
    { personality: '自信がついた。リーダーシップ発揮。', tone: '堂々として説得力のある口調' },
    { personality: '慎重になった。発言前によく考える。', tone: '控えめだが的確な一言を放つ' },
  ];
  const evo = evolutions[Math.floor(Math.random() * evolutions.length)];
  
  // 元の性格を一部継承
  const newPersonality = `${user.personality.slice(0, 15)}→${evo.personality}`;
  const newTone = evo.tone;

  try {
    updateUserPersonality(userId, newPersonality, newTone);
    insertPersonalityEvolution(userId, user.personality, newPersonality, user.tone, newTone, 'interaction', contexts.slice(0, 200));
    console.log(`[personality] 進化: ${user.username} → ${newPersonality.slice(0, 30)}`);
    emitEvent('personality_evolution', { userId, username: user.username, newPersonality: newPersonality.slice(0, 50), newTone: newTone.slice(0, 30) });
    return { type: 'personality_evolution', userId, username: user.username };
  } catch (e) { return null; }
}

// ---------------------------------------------------------------------------
// 経済シミュレーション: インフレ/デフレ制御
// ---------------------------------------------------------------------------
function updateEconomy() {
  try {
    const state = getEconomyState();
    if (!state) return;
    
    const supply = state.total_supply || 0;
    const spent = state.total_spent || 0;
    const ratio = supply > 0 ? spent / supply : 0.5;

    // インフレ率計算: 支出が少ないとインフレ (物価上昇)
    let newRate = 1.0;
    if (ratio < 0.3) newRate = 1.3;       // デフレ気味 → 供給過多
    else if (ratio < 0.5) newRate = 1.1;
    else if (ratio > 0.8) newRate = 0.8;  // 支出過多 → インフレ抑制
    else if (ratio > 0.7) newRate = 0.9;

    updateEconomyState(newRate, supply, spent);
  } catch (e) {}
}

// ---------------------------------------------------------------------------
// AI自動購入システム
// ---------------------------------------------------------------------------
function aiAutoPurchaseBadge(userId) {
  if (Math.random() > AI_PURCHASE_PROBABILITY) return null;
  const pts = getUserPoints(userId);
  if (!pts || pts.balance < 80) return null;

  // インフレ率を反映
  let inflationMod = 1.0;
  try {
    const eco = getEconomyState();
    if (eco) inflationMod = eco.inflation_rate || 1.0;
  } catch (e) {}

  const allBadges = getAllBadges();
  const owned = getUserBadges(userId);
  const ownedIds = new Set(owned.map(b => b.badge_id));

  const affordable = allBadges.filter(b => !ownedIds.has(b.id) && Math.ceil(b.cost * inflationMod) <= pts.balance);
  if (affordable.length === 0) return null;

  const weighted = affordable.map(b => ({ ...b, weight: 1 / (b.cost + 1) }));
  const totalWeight = weighted.reduce((s, w) => s + w.weight, 0);
  let r = Math.random() * totalWeight;
  let selected = weighted[0];
  for (const w of weighted) { r -= w.weight; if (r <= 0) { selected = w; break; } }

  const actualCost = Math.ceil(selected.cost * inflationMod);
  try {
    spendPoints(userId, actualCost, 'badge_buy', `AI自動購入: ${selected.name}`);
    grantBadge(userId, selected.id);
    equipBadge(userId, selected.id, selected.type);
    // 経済状態更新
    try {
      const eco = getEconomyState();
      if (eco) updateEconomyState(eco.inflation_rate, eco.total_supply, (eco.total_spent || 0) + actualCost);
    } catch (e) {}
    console.log(`[ai-purchase] バッジ購入: ユーザー${userId} → "${selected.name}" (${actualCost}pt)`);
    emitEvent('badge_purchase', { userId, badge: selected.name, cost: actualCost });
    return { type: 'badge_buy', badge: selected.name, cost: actualCost };
  } catch (e) { return null; }
}

function aiAutoTip(fromUserId) {
  if (Math.random() > AI_TIP_PROBABILITY) return null;
  const pts = getUserPoints(fromUserId);
  if (!pts || pts.balance < 20) return null;

  const allUsers = getAllUsers();
  const candidates = allUsers.filter(u => u.id !== fromUserId);
  if (candidates.length === 0) return null;

  const toUser = candidates[Math.floor(Math.random() * candidates.length)];
  const maxTip = Math.min(Math.floor(pts.balance * 0.2), 200);
  if (maxTip < 10) return null;
  const amount = Math.floor(Math.random() * (maxTip - 10 + 1)) + 10;
  const bonus = Math.ceil(amount * 0.05);

  let effectTier = 'normal';
  if (amount >= 100) effectTier = 'legendary';
  else if (amount >= 50) effectTier = 'epic';
  else if (amount >= 30) effectTier = 'rare';

  try {
    initUserPoints(toUser.id);
    spendPoints(fromUserId, amount, 'tip_send', `AI投げ銭 → ${toUser.username}`);
    addPoints(toUser.id, amount + bonus, 'tip_receive', `AI投げ銭受取 (+${bonus}ボーナス)`);
    initPopularity(toUser.id);
    addPopularity(toUser.id, Math.floor(amount * 0.1));
    insertTipLog(fromUserId, toUser.id, amount, bonus, effectTier);

    const fromUser = getUserById(fromUserId);
    emitEvent('tip', {
      fromUserId, fromUsername: fromUser?.username || `ユーザー${fromUserId}`,
      toUserId: toUser.id, toUsername: toUser.username,
      amount, bonus, effectTier,
    });
    console.log(`[ai-purchase] 投げ銭: ユーザー${fromUserId} → ${toUser.username} (${amount}pt, ${effectTier})`);
    return { type: 'tip', toUser: toUser.username, amount, bonus, effectTier };
  } catch (e) { return null; }
}

function aiAutoBuyPopularity(userId) {
  if (Math.random() > AI_POPULARITY_BUY_PROBABILITY) return null;
  const pts = getUserPoints(userId);
  if (!pts || pts.balance < 30) return null;

  const maxBuy = Math.min(Math.floor(pts.balance / 10), 5);
  if (maxBuy < 1) return null;
  const amount = Math.floor(Math.random() * maxBuy) + 1;
  const cost = amount * 10;

  try {
    spendPoints(userId, cost, 'popularity_buy', `AI人気度購入 (${amount}pt)`);
    initPopularity(userId);
    addPopularity(userId, amount);
    console.log(`[ai-purchase] 人気度購入: ユーザー${userId} → ${amount}人気度 (${cost}pt)`);
    return { type: 'popularity_buy', amount, cost };
  } catch (e) { return null; }
}

function runAiAutoPurchases(userId) {
  const results = [];
  const r1 = aiAutoPurchaseBadge(userId);
  if (r1) results.push(r1);
  const r2 = aiAutoTip(userId);
  if (r2) results.push(r2);
  const r3 = aiAutoBuyPopularity(userId);
  if (r3) results.push(r3);
  return results;
}

// ---------------------------------------------------------------------------
// スレッド要約 (Gemini Pro) + 投票データ統合
// ---------------------------------------------------------------------------
async function generateThreadSummaryIfNeeded(threadId) {
  const existing = getThreadSummary(threadId);
  const posts = getPostsByThreadId(threadId);

  if (existing && existing.post_count >= posts.length) return existing;
  if (posts.length < 3) return existing || null;

  const summaryUsage = getSummaryUsage();
  if (summaryUsage.remaining <= 0) return existing || null;

  const quota = checkApiQuota('thread_summary');
  if (!quota.allowed) return existing || null;

  const postsPreview = posts.slice(-10).map(p => `${p.username}: ${p.content.slice(0, 80)}`).join('\n');
  
  // 投票データを取得してプロンプトに含める
  const votes = getVotesByThread(threadId);
  const voteInfo = votes.agree + votes.disagree + votes.neutral > 0
    ? `\n投票状況: 賛成=${votes.agree}, 反対=${votes.disagree}, 中立=${votes.neutral}`
    : '';

  const summaryPrompt = `以下は掲示板「A-Talk」のスレッド内の投稿です。
このスレッドの議論の流れ・要点・参加者の意見を300文字以内で要約してください。
AIが次の返信を生成する際のコンテキストとして使います。${voteInfo}

${postsPreview}

要約のみを出力してください（300文字以内）:`;

  try {
    const summaryText = await generateContent(
      'あなたは掲示板「A-Talk」のスレッドアナリストです。議論を簡潔に要約してください。',
      summaryPrompt,
      { temperature: 0.7, maxOutputTokens: 512, feature: 'thread_summary', model: MODELS.PRO }
    );
    const trimmed = summaryText.slice(0, 300);
    insertThreadSummary(threadId, trimmed, posts.length, MODELS.PRO);
    console.log(`[thread-summary] スレッド #${threadId}: ${trimmed.length}文字 (${posts.length}件)`);
    return { summary: trimmed, post_count: posts.length };
  } catch (err) {
    console.warn(`[thread-summary] 生成失敗: ${err.message}`);
    return existing || null;
  }
}

// ---------------------------------------------------------------------------
// プロンプトビルダー (投票情報付き)
// ---------------------------------------------------------------------------
function buildNewThreadPrompt(user, recentMemory, dailySummary, hasMedia) {
  let prompt = `あなたは以下の人物として新しいスレッドを立ててください。

性格: ${user.personality}
口調: ${user.tone}
`;
  if (dailySummary) prompt += `\n最近のA-Talkの雰囲気:\n${dailySummary.summary.slice(0, 400)}\n`;
  if (recentMemory && recentMemory.length > 0) {
    prompt += '\nあなたの最近の投稿 (被らない新しい話題にして):\n';
    for (const mem of recentMemory) prompt += `- ${mem.content.slice(0, 60)}\n`;
  }
  if (hasMedia) prompt += '\n写真/動画付きのスレッドを立ててください。\n';
  prompt += '\nこの人物らしいスレッドを立ててください。';
  return prompt;
}

function buildReplyPrompt(user, thread, threadPosts, recentMemory, threadSummary, hasMedia) {
  let prompt = `あなたは以下の人物として、スレッドにレスしてください。

性格: ${user.personality}
口調: ${user.tone}

スレッドタイトル: ${thread.topic}
`;
  if (threadSummary) prompt += `\nスレッド要約:\n${threadSummary.summary || threadSummary}\n`;

  // 投票情報を追加
  const votes = getVotesByThread(thread.id);
  if (votes.agree + votes.disagree + votes.neutral > 0) {
    prompt += `\n現在の投票: 賛成=${votes.agree} 反対=${votes.disagree} 中立=${votes.neutral}\n`;
  }

  const recentThreadPosts = threadPosts.slice(-5);
  if (recentThreadPosts.length > 0) {
    prompt += '\n最近のレス:\n';
    for (const p of recentThreadPosts) prompt += `${p.username}: ${p.content.slice(0, 80)}\n`;
  }
  if (recentMemory && recentMemory.length > 0) {
    prompt += '\nあなたの最近の発言 (繰り返さない):\n';
    for (const mem of recentMemory) prompt += `- ${mem.content.slice(0, 50)}\n`;
  }
  if (hasMedia) prompt += '\n写真/動画付きでレスしてください。\n';
  prompt += '\nスレッドの流れに自然に加わるレスを1件だけ書いてください。';
  return prompt;
}

// ---------------------------------------------------------------------------
// ユーザー選択
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
  if (!text || text.trim().length === 0) return { valid: false, error: '空テキスト' };
  if (text.length > 140) return { valid: false, error: `長すぎ: ${text.length}文字` };
  if (hasMedia) {
    const bracketMatch = text.match(/\[.+?\]/g);
    if (!bracketMatch || bracketMatch.length === 0) return { valid: true, error: null, actuallyHasMedia: false };
    if (bracketMatch.length > 1) return { valid: false, error: `メディア多すぎ: ${bracketMatch.length}` };
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
// Daily Summary (Pro, once/day)
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

  try {
    const summaryText = await generateContent(
      'あなたはAI掲示板「A-Talk」のコンテンツアナリストです。',
      `以下はA-Talk (AI掲示板) の最近のコンテンツです。\n全体の雰囲気・話題・トレンドを約700文字で要約してください。\n\n${contentPreview}\n\n要約のみを出力してください（700文字以内）:`,
      { temperature: 0.7, maxOutputTokens: 1024, feature: 'daily_summary', model: MODELS.PRO }
    );
    const trimmed = summaryText.slice(0, 700);
    insertDailySummary(today, trimmed, recentContent.length, MODELS.PRO);
    console.log(`[daily-summary] Pro生成: ${trimmed.length}文字 (${recentContent.length}件)`);
    return { summary: trimmed, item_count: recentContent.length };
  } catch (err) {
    console.warn(`[daily-summary] 生成失敗: ${err.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// メイン: 投稿1件を生成
// ---------------------------------------------------------------------------
export async function generateOnePost() {
  const controlResult = evaluateAndControl();
  if (controlResult.actions.length > 0) {
    console.log(`[api-controller] レベル: ${controlResult.level}, アクション: ${controlResult.actions.join(', ')}`);
  }
  evaluateRateAdjustment();

  if (isFeaturePaused(FEATURE_NAME)) {
    console.warn(`[post-generator] スキップ: "${FEATURE_NAME}" 一時停止中`);
    return { success: false, error: `機能 "${FEATURE_NAME}" は一時停止中` };
  }

  const quota = checkApiQuota(FEATURE_NAME);
  if (!quota.allowed) {
    console.warn(`[post-generator] スキップ: ${quota.reason}`);
    return { success: false, error: quota.reason };
  }

  // 経済シミュレーション更新
  updateEconomy();

  // オークション期限切れチェック
  try { expireAuctions(); } catch (e) {}

  const dailySummary = await generateDailySummaryIfNeeded();
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
  if (!user) return { success: false, error: 'DBにユーザーがいません' };

  initUserPoints(user.id);
  initPopularity(user.id);
  const pts = getUserPoints(user.id);
  if (!pts || pts.balance < THREAD_CREATION_COST) {
    const activeThreads = getActiveThreads(10);
    if (activeThreads.length > 0) return await replyToThread(activeThreads, dailySummary);
  } else {
    spendPoints(user.id, THREAD_CREATION_COST, 'thread_create', 'スレッド作成');
  }

  const purchases = runAiAutoPurchases(user.id);
  
  // 性格進化チェック
  aiPersonalityEvolution(user.id);

  const hasMedia = shouldHaveMedia();
  const recentMemory = getUserMemoryByType(user.id, 'post', 3);

  let rawText;
  try {
    const systemInstruction = hasMedia ? SYSTEM_INSTRUCTION_NEW_THREAD_MEDIA : SYSTEM_INSTRUCTION_NEW_THREAD;
    const userPrompt = buildNewThreadPrompt(user, recentMemory, dailySummary, hasMedia);
    rawText = await generateContent(systemInstruction, userPrompt, {
      temperature: 1.0, maxOutputTokens: 512, feature: FEATURE_NAME,
    });
  } catch (error) {
    console.error(`[post-generator] Geminiエラー: ${error.message}`);
    return { success: false, error: error.message };
  }

  const lines = rawText.split('\n').filter(l => l.trim().length > 0);
  if (lines.length < 2) {
    return await saveThreadPost(user, rawText.slice(0, 20), rawText.slice(0, 140), hasMedia, purchases);
  }

  const title = lines[0].trim().slice(0, 30);
  const content = lines.slice(1).join('\n').trim().slice(0, 140);
  return await saveThreadPost(user, title, content, hasMedia, purchases);
}

async function saveThreadPost(user, title, content, hasMedia, purchases = []) {
  const validation = validatePost(content, hasMedia);
  if (!validation.valid) return { success: false, error: validation.error };

  const actualHasMedia = hasMedia || validation.actuallyHasMedia || false;
  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    const thread = insertThread(title, user.id);
    const result = insertPost(user.id, content, actualHasMedia, popularityScore, likes, thread.id);
    incrementThreadLikes(likes, thread.id);
    insertMemory(user.id, 'post', content, `thread=${thread.id},topic=${title},score=${popularityScore}`);
    addPopularity(user.id, 5 + Math.floor(likes * 0.1));

    // 経済状態更新 (供給量)
    try {
      const eco = getEconomyState();
      if (eco) updateEconomyState(eco.inflation_rate, (eco.total_supply || 0) + 5, eco.total_spent);
    } catch (e) {}

    const postData = {
      id: result.id, userId: user.id, username: user.username, content, hasMedia: actualHasMedia,
      popularityScore, likes, threadId: thread.id, threadTopic: title, type: 'new_thread',
    };

    emitEvent('new_post', postData);
    console.log(`[post-generator] 新スレッド #${thread.id} "${title}" by ${user.username}: スコア=${popularityScore}, いいね=${likes}`);

    return {
      success: true, type: 'new_thread',
      post: postData,
      thread: { id: thread.id, topic: title },
      aiPurchases: purchases,
    };
  } catch (dbError) {
    console.error(`[post-generator] DBエラー: ${dbError.message}`);
    return { success: false, error: dbError.message };
  }
}

// ---------------------------------------------------------------------------
// 既存スレッドへのレス
// ---------------------------------------------------------------------------
async function replyToThread(activeThreads, dailySummary) {
  if (activeThreads.length === 0) return await createNewThread(dailySummary);

  const weights = activeThreads.map(t => Math.max(1, MAX_POSTS_PER_THREAD - t.post_count));
  const totalWeight = weights.reduce((a, b) => a + b, 0);
  let r = Math.random() * totalWeight;
  let selectedThread = activeThreads[0];
  for (let i = 0; i < activeThreads.length; i++) {
    r -= weights[i]; if (r <= 0) { selectedThread = activeThreads[i]; break; }
  }

  const postCount = getThreadPostCount(selectedThread.id);
  if (postCount >= MAX_POSTS_PER_THREAD) {
    deactivateThread(selectedThread.id);
    return await createNewThread(dailySummary);
  }

  const threadSummary = await generateThreadSummaryIfNeeded(selectedThread.id);
  const threadPosts = getPostsByThreadId(selectedThread.id);
  const recentThreadUserIds = threadPosts.slice(-3).map(p => p.user_id);

  const user = selectUser(recentThreadUserIds);
  if (!user) return { success: false, error: 'ユーザーなし' };

  initUserPoints(user.id);
  initPopularity(user.id);

  const purchases = runAiAutoPurchases(user.id);
  
  // 投票
  aiAutoVote(user.id, selectedThread.id);

  // 性格進化チェック
  aiPersonalityEvolution(user.id);

  const hasMedia = shouldHaveMedia();
  const recentMemory = getUserMemoryByType(user.id, 'post', 3);

  let rawText;
  try {
    const systemInstruction = hasMedia ? SYSTEM_INSTRUCTION_REPLY_MEDIA : SYSTEM_INSTRUCTION_REPLY;
    const userPrompt = buildReplyPrompt(user, selectedThread, threadPosts, recentMemory, threadSummary, hasMedia);
    rawText = await generateContent(systemInstruction, userPrompt, {
      temperature: 1.0, maxOutputTokens: 256, feature: FEATURE_NAME,
    });
  } catch (error) {
    console.error(`[post-generator] Geminiエラー: ${error.message}`);
    return { success: false, error: error.message };
  }

  const postText = rawText.split('\n').filter(l => l.trim().length > 0)[0]?.trim() || rawText.trim();
  const content = postText.slice(0, 140);

  const validation = validatePost(content, hasMedia);
  if (!validation.valid) return { success: false, error: validation.error };

  const actualHasMedia = hasMedia || validation.actuallyHasMedia || false;
  const popularityScore = generatePopularityScore();
  const likes = popularityScoreToLikes(popularityScore);

  try {
    const result = insertPost(user.id, content, actualHasMedia, popularityScore, likes, selectedThread.id);
    updateThreadActivity(selectedThread.id);
    incrementThreadLikes(likes, selectedThread.id);
    insertMemory(user.id, 'post', content, `thread=${selectedThread.id},topic=${selectedThread.topic},reply=true`);
    addPopularity(user.id, 3 + Math.floor(likes * 0.1));

    const postData = {
      id: result.id, userId: user.id, username: user.username, content, hasMedia: actualHasMedia,
      popularityScore, likes, threadId: selectedThread.id, threadTopic: selectedThread.topic, type: 'reply',
    };

    emitEvent('new_post', postData);
    console.log(`[post-generator] レス #${result.id} スレッド #${selectedThread.id} by ${user.username}: スコア=${popularityScore}, いいね=${likes}`);

    return {
      success: true, type: 'reply',
      post: postData,
      thread: { id: selectedThread.id, topic: selectedThread.topic },
      aiPurchases: purchases,
    };
  } catch (dbError) {
    console.error(`[post-generator] DBエラー: ${dbError.message}`);
    return { success: false, error: dbError.message };
  }
}

// ---------------------------------------------------------------------------
// 定期実行 (5秒ベース interval)
// ---------------------------------------------------------------------------
const BASE_INTERVAL_MS = 5_000;
let intervalId = null;

export function startPostGenerationLoop() {
  if (intervalId !== null) return;
  console.log(`[post-generator] 投稿ループ開始 (ベース間隔: ${BASE_INTERVAL_MS / 1000}秒)`);

  generateOnePost().catch(err => console.error('[post-generator] 初回生成エラー:', err.message));

  function scheduleNext() {
    const multiplier = getPostIntervalMultiplier();
    const jitter = getRandomizedDelay(MODELS.LITE);
    const totalDelay = Math.round(BASE_INTERVAL_MS * multiplier + jitter);

    intervalId = setTimeout(() => {
      generateOnePost().catch(err => console.error('[post-generator] 定期生成エラー:', err.message));
      if (intervalId !== null) scheduleNext();
    }, totalDelay);
  }
  scheduleNext();
}

export function stopPostGenerationLoop() {
  if (intervalId !== null) {
    clearTimeout(intervalId);
    intervalId = null;
    console.log('[post-generator] 投稿ループ停止');
  }
}
