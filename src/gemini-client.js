// ===========================================================================
// gemini-client.js - Multi-model Gemini API client (A-Talk v3.2)
// ===========================================================================
// SDK: @google/genai (Google Gen AI unified SDK)
//
// 利用モデル (2026-02-11 公式調査結果):
//   1. gemini-2.5-flash-lite  (Stable) - 投稿/DM生成: 最安、高速、RPM 4K, RPD 無制限
//   2. gemini-2.5-flash       (Stable) - コメント/リアクション: RPM 1K, RPD 10K
//   3. gemini-3-flash-preview (Preview) - 最新: RPM 1K, RPD 10K
//   4. gemini-2.5-pro         (Stable) - 日次要約専用: RPM 150, TPM 2M, RPD 1K
//
// レート制限 (2026-02-11 更新):
//   - Flash Lite: RPM 4,000 / TPM 4M / RPD 無制限 (最も緩い)
//   - Flash:      RPM 1,000 / TPM 1M / RPD 10,000
//   - Flash 3:    RPM 1,000 / TPM 1M / RPD 10,000
//   - Pro:        RPM 150   / TPM 2M / RPD 1,000 (要約専用)
//
// CRITICAL FIX (v3.1):
//   - incrementApiUsage() は API成功レスポンス受信後のみ実行する
//   - ネットワークエラー/サーバーエラー/無効APIキーの場合はカウントしない
//
// 投稿間隔: 全モデル 2-3秒 (2000-3000ms) に統一
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

// Default model assignment per feature
// Posts/DMs/seed: LITE, Comments/Reactions: FLASH, Summary: PRO only
export const MODEL_ASSIGNMENT = {
  post_generation: MODELS.LITE,
  comment_generation: MODELS.FLASH,
  dm_generation: MODELS.LITE,
  reaction_chain: MODELS.FLASH,
  seed_users: MODELS.LITE,
  api_validation: MODELS.LITE,
  daily_summary: MODELS.PRO,  // v3.2: Pro only for summaries
};

// ---------------------------------------------------------------------------
// Rate limits per model (from gemini_rate_limits.csv / official docs 2026-02-11)
// ---------------------------------------------------------------------------
export const MODEL_RATE_LIMITS = {
  [MODELS.LITE]: {
    rpm: 4000, rpd: Infinity, tpm_input: 4_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Cheapest, loosest limits - RPD unlimited',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.FLASH]: {
    rpm: 1000, rpd: 10_000, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Balanced price-performance, RPD 10K',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.FLASH3]: {
    rpm: 1000, rpd: 10_000, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Preview, latest, RPD 10K',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 },
  },
  [MODELS.PRO]: {
    rpm: 150, rpd: 1000, tpm_input: 2_000_000, tpm_output: 65_536,
    tier: 'Paid', note: 'Daily summary ONLY - RPM 150, TPM 2M, RPD 1K',
    scheduling: { minIntervalMs: 1000, maxIntervalMs: 2000 },
  },
};

// ---------------------------------------------------------------------------
// Constants - Updated for loose rate limits
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 10000;   // RPD for Flash/Flash3 (most restrictive actively used)
const DAILY_SOFT_LIMIT = 9500;    // 500 request buffer
const RESERVE_MIN = 200;          // Reserve for manual operations
const RPM_LIMIT = 1000;           // Flash/Flash3 RPM (LITE is 4K so no issue)
const SUMMARY_DAILY_LIMIT = 500;  // Pro: max 500 summaries/day (RPD 1K, but save half)

// ---------------------------------------------------------------------------
// Singleton client instance
// ---------------------------------------------------------------------------
let aiClient = null;

function getClient() {
  if (aiClient) return aiClient;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey || apiKey === 'YOUR_GEMINI_API_KEY_HERE') {
    throw new Error(
      'GEMINI_API_KEY is not set or still contains placeholder value. ' +
      'Set a valid API key in .env file.'
    );
  }
  aiClient = new GoogleGenAI({ apiKey });
  return aiClient;
}

// ---------------------------------------------------------------------------
// Per-minute rate limiter (sliding window, per-model)
// ---------------------------------------------------------------------------
const requestTimestamps = new Map(); // model -> timestamp[]

function canMakeRequestRPM(modelName) {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  const limits = MODEL_RATE_LIMITS[modelName];
  const rpmLimit = limits?.rpm || RPM_LIMIT;

  if (!requestTimestamps.has(modelName)) {
    requestTimestamps.set(modelName, []);
  }
  const ts = requestTimestamps.get(modelName);

  // Prune old entries
  while (ts.length > 0 && ts[0] < oneMinuteAgo) {
    ts.shift();
  }
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
// Summary daily counter (Pro only, max 500/day)
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
// Exported: check if API call is allowed
// ---------------------------------------------------------------------------

/**
 * Check if we can make an API call (RPM, RPD, pause state, and reserve).
 * @param {string} [feature] - Feature name for pause check
 * @returns {{ allowed: boolean, reason: string | null, todayUsage: number, remaining: number }}
 */
export function checkApiQuota(feature = null) {
  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;
  const modelName = feature ? (MODEL_ASSIGNMENT[feature] || MODELS.LITE) : MODELS.LITE;

  // Pro summary limit check
  if (feature === 'daily_summary') {
    if (!checkSummaryLimit()) {
      return {
        allowed: false,
        reason: `Daily summary limit reached: ${summaryCountToday}/${SUMMARY_DAILY_LIMIT}`,
        todayUsage,
        remaining,
      };
    }
  }

  // Check minimum reserve
  if (remaining <= RESERVE_MIN) {
    return {
      allowed: false,
      reason: `Reserve limit: only ${remaining} requests remaining (minimum ${RESERVE_MIN} must be preserved)`,
      todayUsage,
      remaining,
    };
  }

  // Check daily soft limit
  if (todayUsage >= DAILY_SOFT_LIMIT) {
    return {
      allowed: false,
      reason: `Daily soft limit reached: ${todayUsage}/${DAILY_SOFT_LIMIT}`,
      todayUsage,
      remaining,
    };
  }

  // Check RPM per model
  if (!canMakeRequestRPM(modelName)) {
    return {
      allowed: false,
      reason: `RPM limit reached for ${modelName}`,
      todayUsage,
      remaining,
    };
  }

  // Check feature-specific pause
  if (feature && isFeaturePaused(feature)) {
    return {
      allowed: false,
      reason: `Feature "${feature}" is currently paused`,
      todayUsage,
      remaining,
    };
  }

  return { allowed: true, reason: null, todayUsage, remaining };
}

// ---------------------------------------------------------------------------
// Exported: generate content (multi-model support)
// ---------------------------------------------------------------------------

/**
 * Call Gemini API to generate text content.
 * CRITICAL: incrementApiUsage() is called ONLY after a successful response.
 *
 * @param {string} systemInstruction - System instruction for the model
 * @param {string} userPrompt - User prompt
 * @param {object} [options] - Optional generation config overrides
 * @returns {Promise<string>} Generated text
 * @throws {Error} If quota exceeded or API call fails
 */
export async function generateContent(systemInstruction, userPrompt, options = {}) {
  const feature = options.feature || 'unknown';
  const modelName = options.model || MODEL_ASSIGNMENT[feature] || MODELS.LITE;

  // --- Quota check ---
  const quota = checkApiQuota(feature);
  if (!quota.allowed) {
    insertUsageLog(modelName, feature, 0, 0, false, quota.reason);
    throw new Error(`API quota exceeded: ${quota.reason}`);
  }

  const ai = getClient();

  const config = {
    systemInstruction,
    temperature: options.temperature ?? 1.0,
    maxOutputTokens: options.maxOutputTokens ?? 256,
    thinkingConfig: { thinkingBudget: 0 },
  };

  try {
    recordRequest(modelName); // Record RPM timestamp before request

    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config,
    });

    const text = response.text;

    if (!text || text.trim().length === 0) {
      insertUsageLog(modelName, feature, 0, 0, false, 'Empty response');
      insertAnomalyLog('empty_response', modelName, feature, 'Gemini returned empty response', null);
      throw new Error('Gemini returned empty response');
    }

    // SUCCESS: Only now do we increment the daily usage counter
    incrementApiUsage();

    // Track summary count for Pro
    if (feature === 'daily_summary') {
      incrementSummaryCount();
    }

    // Log success
    insertUsageLog(modelName, feature, 0, 0, true, null);

    return text.trim();
  } catch (error) {
    const errMsg = error.message || 'Unknown error';
    const statusMatch = errMsg.match(/(\d{3})/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    if (errMsg.includes('429')) {
      console.error(`[Gemini] Rate limit hit (429) on ${modelName}. Skipping.`);
      insertUsageLog(modelName, feature, 0, 0, false, '429 rate limit');
      insertAnomalyLog('rate_limit_429', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API rate limit exceeded (429)');
    }

    if (errMsg.includes('503')) {
      console.error(`[Gemini] Model overloaded (503) on ${modelName}. Skipping.`);
      insertUsageLog(modelName, feature, 0, 0, false, '503 model overloaded');
      insertAnomalyLog('model_overloaded_503', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API model overloaded (503)');
    }

    if (errMsg.includes('400') || errMsg.includes('INVALID_ARGUMENT')) {
      console.error(`[Gemini] Bad request (400) on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, '400 bad request');
      insertAnomalyLog('bad_request_400', modelName, feature, errMsg.slice(0, 500), 400);
      throw new Error(`Gemini API bad request: ${errMsg.slice(0, 100)}`);
    }

    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('API_KEY')) {
      console.error(`[Gemini] Auth error on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'auth error');
      insertAnomalyLog('auth_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error(`Gemini API auth error: ${errMsg.slice(0, 100)}`);
    }

    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') || errMsg.includes('fetch failed')) {
      console.error(`[Gemini] Network error on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'network error');
      insertAnomalyLog('network_error', modelName, feature, errMsg.slice(0, 500), null);
      throw new Error(`Gemini API network error: ${errMsg.slice(0, 100)}`);
    }

    if (!errMsg.includes('API quota exceeded')) {
      insertUsageLog(modelName, feature, 0, 0, false, errMsg.slice(0, 200));
      insertAnomalyLog('unknown_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Exported: validate API key (tests all 4 models)
// ---------------------------------------------------------------------------
export async function validateApiKey() {
  const results = {};
  const ai = getClient();

  for (const [label, modelName] of Object.entries(MODELS)) {
    try {
      const response = await ai.models.generateContent({
        model: modelName,
        contents: 'Say "OK" in one word.',
        config: {
          maxOutputTokens: 8,
          thinkingConfig: { thinkingBudget: 0 },
        },
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
// Exported: get quota status (for monitoring/API endpoint)
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
// Exported: get available models info
// ---------------------------------------------------------------------------
export function getModelsInfo() {
  return {
    models: [
      {
        id: MODELS.LITE,
        label: 'Gemini 2.5 Flash-Lite',
        status: 'Stable',
        tier: 'cheapest',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.10/1M input, $0.40/1M output',
        rateLimits: MODEL_RATE_LIMITS[MODELS.LITE],
        usedFor: ['post_generation', 'dm_generation', 'seed_users'],
      },
      {
        id: MODELS.FLASH,
        label: 'Gemini 2.5 Flash',
        status: 'Stable',
        tier: 'balanced',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.30/1M input, $2.50/1M output',
        rateLimits: MODEL_RATE_LIMITS[MODELS.FLASH],
        usedFor: ['comment_generation', 'reaction_chain'],
      },
      {
        id: MODELS.FLASH3,
        label: 'Gemini 3 Flash Preview',
        status: 'Preview',
        tier: 'latest',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$0.50/1M input, $3.00/1M output',
        rateLimits: MODEL_RATE_LIMITS[MODELS.FLASH3],
        usedFor: ['available on demand'],
      },
      {
        id: MODELS.PRO,
        label: 'Gemini 2.5 Pro',
        status: 'Stable',
        tier: 'premium',
        inputTokens: '1,048,576',
        outputTokens: '65,536',
        pricing: '$1.25/1M input, $10.00/1M output',
        rateLimits: MODEL_RATE_LIMITS[MODELS.PRO],
        usedFor: ['daily_summary (ONLY)'],
      },
    ],
    deprecations: [
      {
        id: 'gemini-2.0-flash-lite',
        shutdownDate: '2026-03-31',
        replacement: MODELS.LITE,
      },
    ],
    rateLimitsReference: MODEL_RATE_LIMITS,
    source: 'https://ai.google.dev/gemini-api/docs/models',
    lastVerified: '2026-02-11',
  };
}

// ---------------------------------------------------------------------------
// Exported: get scheduling config for a model
// ---------------------------------------------------------------------------
export function getSchedulingConfig(modelName) {
  const limits = MODEL_RATE_LIMITS[modelName];
  if (limits?.scheduling) return limits.scheduling;
  return { minIntervalMs: 2000, maxIntervalMs: 3000 };
}

// ---------------------------------------------------------------------------
// Exported: get a randomized delay for scheduling (2-3s unified)
// ---------------------------------------------------------------------------
export function getRandomizedDelay(modelName) {
  const config = getSchedulingConfig(modelName);
  return config.minIntervalMs + Math.random() * (config.maxIntervalMs - config.minIntervalMs);
}
