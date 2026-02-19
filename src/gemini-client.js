// ===========================================================================
// gemini-client.js - Multi-model Gemini API client (A-Talk v4.0)
// ===========================================================================
// v4.0 Changes:
//   - DM機能削除、thread_summaryをProの主要用途に
//   - Gemini 2.5 Pro 400 Bad Request エラー修正: thinkingConfig除去
//   - スレッド要約を活動のたびにPro経由で生成
// ===========================================================================

import { GoogleGenAI } from '@google/genai';
import {
  getTodayApiUsage,
  incrementApiUsage,
  insertUsageLog,
  insertAnomalyLog,
  isFeaturePaused,
} from './database.js';

// ---------------------------------------------------------------------------
// Model definitions
// ---------------------------------------------------------------------------
export const MODELS = {
  LITE: 'gemini-2.5-flash-lite',
  FLASH: 'gemini-2.5-flash',
  FLASH3: 'gemini-3-flash-preview',
  PRO: 'gemini-2.5-pro',
};

// Default model assignment per feature (DM removed)
export const MODEL_ASSIGNMENT = {
  post_generation: MODELS.LITE,
  comment_generation: MODELS.FLASH,
  reaction_chain: MODELS.FLASH,
  seed_users: MODELS.LITE,
  api_validation: MODELS.LITE,
  daily_summary: MODELS.PRO,
  thread_summary: MODELS.PRO,  // v4.0: 各スレッドの要約もPro
};

// ---------------------------------------------------------------------------
// Rate limits per model
// ---------------------------------------------------------------------------
export const MODEL_RATE_LIMITS = {
  [MODELS.LITE]: {
    rpm: 4000, rpd: Infinity, tpm_input: 4_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: '最安・RPD無制限',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.FLASH]: {
    rpm: 1000, rpd: 10_000, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'バランス型・RPD 10K',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.FLASH3]: {
    rpm: 1000, rpd: 10_000, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'プレビュー・最新・RPD 10K',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.PRO]: {
    rpm: 150, rpd: 1000, tpm_input: 2_000_000, tpm_output: 65_536,
    tier: 'Paid', note: '要約専用 - RPM 150, RPD 1K',
    scheduling: { minIntervalMs: 1000, maxIntervalMs: 2000 },
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 10000;
const DAILY_SOFT_LIMIT = 9500;
const RESERVE_MIN = 200;
const RPM_LIMIT = 1000;
const SUMMARY_DAILY_LIMIT = 500;

// ---------------------------------------------------------------------------
// Singleton client instance
// ---------------------------------------------------------------------------
let aiClient = null;

function getClient() {
  if (aiClient) return aiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error('GEMINI_API_KEY が設定されていません。.env ファイルを確認してください。');
  }
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

// ---------------------------------------------------------------------------
// Per-minute rate limiter
// ---------------------------------------------------------------------------
const requestTimestamps = new Map();

function canMakeRequestRPM(modelName) {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  const limits = MODEL_RATE_LIMITS[modelName];
  const rpmLimit = limits?.rpm || RPM_LIMIT;

  if (!requestTimestamps.has(modelName)) {
    requestTimestamps.set(modelName, []);
  }
  const ts = requestTimestamps.get(modelName);
  while (ts.length > 0 && ts[0] < oneMinuteAgo) { ts.shift(); }
  return ts.length < rpmLimit;
}

function recordRequest(modelName) {
  if (!requestTimestamps.has(modelName)) {
    requestTimestamps.set(modelName, []);
  }
  requestTimestamps.get(modelName).push(Date.now());
}

function getRpmWindowCount() {
  let total = 0;
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  for (const [, ts] of requestTimestamps) {
    total += ts.filter(t => t >= oneMinuteAgo).length;
  }
  return total;
}

// ---------------------------------------------------------------------------
// Summary daily counter (Pro only)
// ---------------------------------------------------------------------------
let summaryCountToday = 0;
let summaryCountDate = '';

function checkSummaryLimit() {
  const today = new Date().toISOString().slice(0, 10);
  if (summaryCountDate !== today) {
    summaryCountDate = today;
    summaryCountToday = 0;
  }
  return summaryCountToday < SUMMARY_DAILY_LIMIT;
}

function incrementSummaryCount() {
  const today = new Date().toISOString().slice(0, 10);
  if (summaryCountDate !== today) {
    summaryCountDate = today;
    summaryCountToday = 0;
  }
  summaryCountToday++;
}

export function getSummaryUsage() {
  const today = new Date().toISOString().slice(0, 10);
  if (summaryCountDate !== today) return { used: 0, limit: SUMMARY_DAILY_LIMIT, remaining: SUMMARY_DAILY_LIMIT };
  return { used: summaryCountToday, limit: SUMMARY_DAILY_LIMIT, remaining: SUMMARY_DAILY_LIMIT - summaryCountToday };
}

// ---------------------------------------------------------------------------
// checkApiQuota
// ---------------------------------------------------------------------------
export function checkApiQuota(feature = null) {
  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;
  const modelName = feature ? (MODEL_ASSIGNMENT[feature] || MODELS.LITE) : MODELS.LITE;

  if (feature === 'daily_summary' || feature === 'thread_summary') {
    if (!checkSummaryLimit()) {
      return {
        allowed: false,
        reason: `要約上限到達: ${summaryCountToday}/${SUMMARY_DAILY_LIMIT}`,
        todayUsage, remaining,
      };
    }
  }

  if (remaining <= RESERVE_MIN) {
    return {
      allowed: false,
      reason: `予約枠: 残り ${remaining} リクエスト (最低 ${RESERVE_MIN} 必要)`,
      todayUsage, remaining,
    };
  }

  if (todayUsage >= DAILY_SOFT_LIMIT) {
    return {
      allowed: false,
      reason: `日次ソフトリミット到達: ${todayUsage}/${DAILY_SOFT_LIMIT}`,
      todayUsage, remaining,
    };
  }

  if (!canMakeRequestRPM(modelName)) {
    return {
      allowed: false,
      reason: `RPM上限到達: ${modelName}`,
      todayUsage, remaining,
    };
  }

  if (feature && isFeaturePaused(feature)) {
    return {
      allowed: false,
      reason: `機能 "${feature}" は現在一時停止中`,
      todayUsage, remaining,
    };
  }

  return { allowed: true, reason: null, todayUsage, remaining };
}

// ---------------------------------------------------------------------------
// generateContent - FIX: Pro model does NOT use thinkingConfig
// ---------------------------------------------------------------------------
export async function generateContent(systemInstruction, userPrompt, options = {}) {
  const feature = options.feature || 'unknown';
  const modelName = options.model || MODEL_ASSIGNMENT[feature] || MODELS.LITE;

  const quota = checkApiQuota(feature);
  if (!quota.allowed) {
    insertUsageLog(modelName, feature, 0, 0, false, quota.reason);
    throw new Error(`APIクォータ超過: ${quota.reason}`);
  }

  const ai = getClient();

  // CRITICAL FIX: Gemini 2.5 Pro does NOT support thinkingConfig: { thinkingBudget: 0 }
  // This causes HTTP 400 Bad Request. Only add thinkingConfig for non-Pro models.
  const config = {
    systemInstruction,
    temperature: options.temperature ?? 1.0,
    maxOutputTokens: options.maxOutputTokens ?? 256,
  };

  // Only disable thinking for non-Pro models
  if (modelName !== MODELS.PRO) {
    config.thinkingConfig = { thinkingBudget: 0 };
  }

  try {
    recordRequest(modelName);

    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config,
    });

    const text = response.text;

    if (!text || text.trim().length === 0) {
      insertUsageLog(modelName, feature, 0, 0, false, '空のレスポンス');
      insertAnomalyLog('empty_response', modelName, feature, 'Geminiから空のレスポンス', null);
      throw new Error('Geminiから空のレスポンスが返されました');
    }

    incrementApiUsage();

    if (feature === 'daily_summary' || feature === 'thread_summary') {
      incrementSummaryCount();
    }

    insertUsageLog(modelName, feature, 0, 0, true, null);
    return text.trim();
  } catch (error) {
    const errMsg = error.message || 'Unknown error';
    const statusMatch = errMsg.match(/(\d{3})/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (errMsg.includes('429')) {
      console.error(`[Gemini] レート制限 (429) ${modelName}`);
      insertUsageLog(modelName, feature, 0, 0, false, '429 rate limit');
      insertAnomalyLog('rate_limit_429', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API レート制限 (429)');
    }

    if (errMsg.includes('503')) {
      console.error(`[Gemini] モデル過負荷 (503) ${modelName}`);
      insertUsageLog(modelName, feature, 0, 0, false, '503 overloaded');
      insertAnomalyLog('model_overloaded_503', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API モデル過負荷 (503)');
    }

    if (errMsg.includes('400') || errMsg.includes('INVALID_ARGUMENT')) {
      console.error(`[Gemini] 不正リクエスト (400) ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, '400 bad request');
      insertAnomalyLog('bad_request_400', modelName, feature, errMsg.slice(0, 500), 400);
      throw new Error(`Gemini API 不正リクエスト: ${errMsg.slice(0, 100)}`);
    }

    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('API_KEY')) {
      console.error(`[Gemini] 認証エラー ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'auth error');
      insertAnomalyLog('auth_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error(`Gemini API 認証エラー: ${errMsg.slice(0, 100)}`);
    }

    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') || errMsg.includes('fetch failed')) {
      console.error(`[Gemini] ネットワークエラー ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'network error');
      insertAnomalyLog('network_error', modelName, feature, errMsg.slice(0, 500), null);
      throw new Error(`Gemini API ネットワークエラー: ${errMsg.slice(0, 100)}`);
    }

    if (!errMsg.includes('APIクォータ超過')) {
      insertUsageLog(modelName, feature, 0, 0, false, errMsg.slice(0, 200));
      insertAnomalyLog('unknown_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// validateApiKey
// ---------------------------------------------------------------------------
export async function validateApiKey() {
  const results = {};
  const ai = getClient();

  for (const [label, modelName] of Object.entries(MODELS)) {
    try {
      const config = { maxOutputTokens: 8 };
      if (modelName !== MODELS.PRO) {
        config.thinkingConfig = { thinkingBudget: 0 };
      }
      const response = await ai.models.generateContent({
        model: modelName,
        contents: 'Say "OK" in one word.',
        config,
      });
      results[label] = {
        model: modelName,
        status: 'ok',
        response: response.text?.trim() || '(empty)',
      };
    } catch (error) {
      results[label] = {
        model: modelName,
        status: 'error',
        error: error.message?.slice(0, 200),
      };
      insertAnomalyLog('validation_error', modelName, 'api_validation', error.message?.slice(0, 500), null);
    }
  }

  return results;
}

// ---------------------------------------------------------------------------
// getQuotaStatus
// ---------------------------------------------------------------------------
export function getQuotaStatus() {
  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;

  return {
    dailyUsage: todayUsage,
    dailyLimit: DAILY_SOFT_LIMIT,
    dailyHardLimit: DAILY_HARD_LIMIT,
    remaining,
    reserveMin: RESERVE_MIN,
    rpmWindowCount: getRpmWindowCount(),
    rpmLimit: RPM_LIMIT,
    models: MODELS,
    modelAssignment: MODEL_ASSIGNMENT,
    autoStopActive: remaining <= RESERVE_MIN,
    summaryUsage: getSummaryUsage(),
  };
}

// ---------------------------------------------------------------------------
// getModelsInfo
// ---------------------------------------------------------------------------
export function getModelsInfo() {
  return {
    models: [
      {
        id: MODELS.LITE,
        label: 'Gemini 2.5 Flash-Lite',
        status: 'Stable',
        tier: '最安',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.10/1M入力, $0.40/1M出力',
        rateLimits: MODEL_RATE_LIMITS[MODELS.LITE],
        usedFor: ['投稿生成', 'ユーザーシード'],
      },
      {
        id: MODELS.FLASH,
        label: 'Gemini 2.5 Flash',
        status: 'Stable',
        tier: 'バランス',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.30/1M入力, $2.50/1M出力',
        rateLimits: MODEL_RATE_LIMITS[MODELS.FLASH],
        usedFor: ['コメント生成', 'リアクション'],
      },
      {
        id: MODELS.FLASH3,
        label: 'Gemini 3 Flash Preview',
        status: 'Preview',
        tier: '最新',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.50/1M入力, $3.00/1M出力',
        rateLimits: MODEL_RATE_LIMITS[MODELS.FLASH3],
        usedFor: ['オンデマンド'],
      },
      {
        id: MODELS.PRO,
        label: 'Gemini 2.5 Pro',
        status: 'Stable',
        tier: 'プレミアム',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$1.25/1M入力, $10.00/1M出力',
        rateLimits: MODEL_RATE_LIMITS[MODELS.PRO],
        usedFor: ['日次要約', 'スレッド要約'],
      },
    ],
    rateLimitsReference: MODEL_RATE_LIMITS,
    source: 'https://ai.google.dev/gemini-api/docs/models',
    lastVerified: '2026-02-11',
  };
}

export function getSchedulingConfig(modelName) {
  const limits = MODEL_RATE_LIMITS[modelName];
  if (limits?.scheduling) return limits.scheduling;
  return { minIntervalMs: 2000, maxIntervalMs: 3000 };
}

export function getRandomizedDelay(modelName) {
  const config = getSchedulingConfig(modelName);
  return config.minIntervalMs + Math.random() * (config.maxIntervalMs - config.minIntervalMs);
}
