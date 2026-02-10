// ===========================================================================
// gemini-client.js - Multi-model Gemini API client (A-Talk v3.1)
// ===========================================================================
// SDK: @google/genai (Google Gen AI unified SDK)
//
// 利用モデル (2026-02-10 公式調査結果):
//   1. gemini-2.5-flash-lite  (Stable) - デフォルト: 最安、高速、日常投稿生成向き
//   2. gemini-2.5-flash       (Stable) - 高品質: コメント/DM/リアクション生成向き
//   3. gemini-3-flash-preview (Preview) - 最新: 重要な生成や複雑な文脈が必要な場合
//
// CRITICAL FIX (v3.1):
//   - incrementApiUsage() は API成功レスポンス受信後のみ実行する
//   - ネットワークエラー/サーバーエラー/無効APIキーの場合はカウントしない
//   - 失敗した呼び出しはカウントされないため、日次ソフトリミットが不正に消費されない
//
// 調査結果 (2026-02-10, ai.google.dev/gemini-api/docs/models):
//   - gemini-2.5-flash-lite: Stable, 入力1M/出力65K tokens, 最安 $0.10/1M入力
//   - gemini-2.5-flash:      Stable, 入力1M/出力65K tokens, $0.30/1M入力
//   - gemini-3-flash-preview: Preview, 入力1M/出力65K tokens, $0.50/1M入力
//   - gemini-3-flash-lite は 2026-02-10 時点で未発表・未リリース
//   - gemini-2.0-flash-lite は 2026-03-31 に廃止予定
//
// Gemini 2.5 Pro notes (for reference): RPM 150, TPM 2M, RPD 1K
// Gemini 2.5 Flash Lite: rate limits looser; schedule 2-3s randomized
//
// 制約:
//   - APIキーは process.env.GEMINI_API_KEY から取得
//   - このモジュールの外からAPIキーに直接触れない
//   - 全てのAPI呼び出しはこのモジュールを通る
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
};

// Default model assignment per feature
export const MODEL_ASSIGNMENT = {
  post_generation: MODELS.LITE,
  comment_generation: MODELS.FLASH,
  dm_generation: MODELS.LITE,
  reaction_chain: MODELS.FLASH,
  seed_users: MODELS.LITE,
  api_validation: MODELS.LITE,
  daily_summary: MODELS.FLASH,
};

// ---------------------------------------------------------------------------
// Rate limits per model (from gemini_rate_limits.csv / official docs)
// ---------------------------------------------------------------------------
export const MODEL_RATE_LIMITS = {
  [MODELS.LITE]: {
    rpm: 30, rpd: 1500, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Cheapest, highest quota',
    scheduling: { minIntervalMs: 2000, maxIntervalMs: 3000 }, // 2-3s randomized
  },
  [MODELS.FLASH]: {
    rpm: 15, rpd: 1000, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Balanced price-performance',
    scheduling: { minIntervalMs: 4000, maxIntervalMs: 5000 },
  },
  [MODELS.FLASH3]: {
    rpm: 10, rpd: 500, tpm_input: 1_000_000, tpm_output: 65_536,
    tier: 'Free/Tier1', note: 'Preview, latest',
    scheduling: { minIntervalMs: 6000, maxIntervalMs: 8000 },
  },
  // Reference only - not used in this app
  'gemini-2.5-pro': {
    rpm: 150, rpd: 1000, tpm_input: 2_000_000, tpm_output: 65_536,
    tier: 'Paid', note: 'Reference: Gemini 2.5 Pro',
  },
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 1000;    // 絶対上限 (Free/Tier1 の RPD)
const DAILY_SOFT_LIMIT = 950;     // 運用上限: 50リクエストの余裕を常に確保
const RESERVE_MIN = 50;           // 最低50リクエストを常時確保
const RPM_LIMIT = 15;             // 15 requests per minute

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
// Per-minute rate limiter (sliding window)
// ---------------------------------------------------------------------------
const requestTimestamps = [];

function canMakeRequestRPM() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }
  return requestTimestamps.length < RPM_LIMIT;
}

function recordRequest() {
  requestTimestamps.push(Date.now());
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

  // Check RPM
  if (!canMakeRequestRPM()) {
    return {
      allowed: false,
      reason: `RPM limit reached: ${RPM_LIMIT} requests in the last minute`,
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
 * Failed calls (network error, 429, 503, invalid key) do NOT consume quota.
 *
 * @param {string} systemInstruction - System instruction for the model
 * @param {string} userPrompt - User prompt
 * @param {object} [options] - Optional generation config overrides
 * @param {number} [options.temperature] - 0.0 - 2.0
 * @param {number} [options.maxOutputTokens] - Maximum output tokens
 * @param {string} [options.model] - Model override (default: from feature assignment)
 * @param {string} [options.feature] - Feature name for logging and pause check
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
    recordRequest(); // Record RPM timestamp before request (for rate limiting)
    // NOTE: incrementApiUsage() is NOT called here - only after success

    const response = await ai.models.generateContent({
      model: modelName,
      contents: userPrompt,
      config,
    });

    const text = response.text;

    if (!text || text.trim().length === 0) {
      // Empty response is a partial failure - do NOT count as usage
      insertUsageLog(modelName, feature, 0, 0, false, 'Empty response');
      insertAnomalyLog('empty_response', modelName, feature, 'Gemini returned empty response', null);
      throw new Error('Gemini returned empty response');
    }

    // SUCCESS: Only now do we increment the daily usage counter
    incrementApiUsage();

    // Log success
    insertUsageLog(modelName, feature, 0, 0, true, null);

    return text.trim();
  } catch (error) {
    const errMsg = error.message || 'Unknown error';
    const statusMatch = errMsg.match(/(\d{3})/);
    const httpStatus = statusMatch ? parseInt(statusMatch[1], 10) : null;

    // If the error is a 429 (rate limit)
    if (errMsg.includes('429')) {
      console.error(`[Gemini] Rate limit hit (429) on ${modelName}. Skipping.`);
      insertUsageLog(modelName, feature, 0, 0, false, '429 rate limit');
      insertAnomalyLog('rate_limit_429', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API rate limit exceeded (429)');
    }

    // 503 - Model overloaded
    if (errMsg.includes('503')) {
      console.error(`[Gemini] Model overloaded (503) on ${modelName}. Skipping.`);
      insertUsageLog(modelName, feature, 0, 0, false, '503 model overloaded');
      insertAnomalyLog('model_overloaded_503', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error('Gemini API model overloaded (503)');
    }

    // 400 - Bad request (e.g., invalid API key, invalid model)
    if (errMsg.includes('400') || errMsg.includes('INVALID_ARGUMENT')) {
      console.error(`[Gemini] Bad request (400) on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, '400 bad request');
      insertAnomalyLog('bad_request_400', modelName, feature, errMsg.slice(0, 500), 400);
      throw new Error(`Gemini API bad request: ${errMsg.slice(0, 100)}`);
    }

    // 401/403 - Authentication error
    if (errMsg.includes('401') || errMsg.includes('403') || errMsg.includes('API_KEY')) {
      console.error(`[Gemini] Auth error on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'auth error');
      insertAnomalyLog('auth_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
      throw new Error(`Gemini API auth error: ${errMsg.slice(0, 100)}`);
    }

    // Network/timeout errors
    if (errMsg.includes('ECONNREFUSED') || errMsg.includes('ETIMEDOUT') || errMsg.includes('ENOTFOUND') || errMsg.includes('fetch failed')) {
      console.error(`[Gemini] Network error on ${modelName}: ${errMsg.slice(0, 100)}`);
      insertUsageLog(modelName, feature, 0, 0, false, 'network error');
      insertAnomalyLog('network_error', modelName, feature, errMsg.slice(0, 500), null);
      throw new Error(`Gemini API network error: ${errMsg.slice(0, 100)}`);
    }

    // Log other errors (don't count quota-exceeded re-throws)
    if (!errMsg.includes('API quota exceeded')) {
      insertUsageLog(modelName, feature, 0, 0, false, errMsg.slice(0, 200));
      insertAnomalyLog('unknown_error', modelName, feature, errMsg.slice(0, 500), httpStatus);
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Exported: validate API key
// ---------------------------------------------------------------------------

/**
 * Validate the Gemini API key by making a minimal request.
 * Returns model info and whether the key works.
 * NOTE: Validation calls do NOT count toward daily usage.
 */
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

/**
 * Get current quota status (comprehensive).
 */
export function getQuotaStatus() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }

  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;

  return {
    dailyUsage: todayUsage,
    dailyLimit: DAILY_SOFT_LIMIT,
    dailyHardLimit: DAILY_HARD_LIMIT,
    remaining,
    reserveMin: RESERVE_MIN,
    rpmWindowCount: requestTimestamps.length,
    rpmLimit: RPM_LIMIT,
    models: MODELS,
    modelAssignment: MODEL_ASSIGNMENT,
    autoStopActive: remaining <= RESERVE_MIN,
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
        usedFor: ['comment_generation', 'reaction_chain', 'daily_summary'],
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
    lastVerified: '2026-02-10',
  };
}

// ---------------------------------------------------------------------------
// Exported: get scheduling config for a model
// ---------------------------------------------------------------------------
export function getSchedulingConfig(modelName) {
  const limits = MODEL_RATE_LIMITS[modelName];
  if (limits?.scheduling) return limits.scheduling;
  return { minIntervalMs: 4000, maxIntervalMs: 6000 };
}

// ---------------------------------------------------------------------------
// Exported: get a randomized delay for scheduling
// ---------------------------------------------------------------------------
export function getRandomizedDelay(modelName) {
  const config = getSchedulingConfig(modelName);
  return config.minIntervalMs + Math.random() * (config.maxIntervalMs - config.minIntervalMs);
}
