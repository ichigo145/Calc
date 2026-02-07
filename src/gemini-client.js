// ===========================================================================
// gemini-client.js - Gemini API client wrapper (A-Talk)
// ===========================================================================
// SDK: @google/genai (Google Gen AI unified SDK)
// Model: gemini-2.5-flash-lite (Stable)
//
// 調査結果 (2026-02-07):
//   - 「Gemini 3.0 Flash Lite」は2026年2月時点で未発表・未リリース
//   - Gemini 2.0 Flash-Lite は 2026-03-31 に廃止予定
//   - Gemini 2.5 Flash-Lite は Stable リリース済み (2025年7月)
//   - 同一の無料枠を継承: 15 RPM, 1,000 RPD, 250,000 TPM
//   - 出力トークン上限: 8,192 → 65,536 に大幅増加
//   - Thinking サポート追加
//
// 制約:
//   - 無料枠: 15 RPM, 1,000 RPD, 250,000 TPM
//   - 実運用上限: 950 RPD
//   - APIキーは process.env.GEMINI_API_KEY から取得
//   - このモジュールの外からAPIキーに直接触れない
//
// 将来の移行:
//   gemini-3-flash-lite がリリースされた場合、
//   MODEL_NAME を1行変更するだけで移行可能。
// ===========================================================================

import { GoogleGenAI } from '@google/genai';
import { getTodayApiUsage, incrementApiUsage } from './database.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const MODEL_NAME = 'gemini-2.5-flash-lite';
const DAILY_SOFT_LIMIT = 950;   // 1,000 RPD のうち 50 を安全マージンとして確保
const RPM_LIMIT = 15;           // 15 requests per minute

// ---------------------------------------------------------------------------
// Singleton client instance
// ---------------------------------------------------------------------------
let aiClient = null;

/**
 * Get or create the GoogleGenAI client singleton.
 * API key is read from environment variable only.
 * @returns {GoogleGenAI}
 */
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

/**
 * Check if we can make a request without exceeding RPM limit.
 * @returns {boolean}
 */
function canMakeRequestRPM() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;

  // Remove timestamps older than 1 minute
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }

  return requestTimestamps.length < RPM_LIMIT;
}

/**
 * Record a request timestamp.
 */
function recordRequest() {
  requestTimestamps.push(Date.now());
}

// ---------------------------------------------------------------------------
// Exported: check if API call is allowed
// ---------------------------------------------------------------------------

/**
 * Check if we can make an API call (both RPM and RPD limits).
 * @returns {{ allowed: boolean, reason: string | null, todayUsage: number }}
 */
export function checkApiQuota() {
  const todayUsage = getTodayApiUsage();

  if (todayUsage >= DAILY_SOFT_LIMIT) {
    return {
      allowed: false,
      reason: `Daily limit reached: ${todayUsage}/${DAILY_SOFT_LIMIT}`,
      todayUsage,
    };
  }

  if (!canMakeRequestRPM()) {
    return {
      allowed: false,
      reason: `RPM limit reached: ${RPM_LIMIT} requests in the last minute`,
      todayUsage,
    };
  }

  return { allowed: true, reason: null, todayUsage };
}

// ---------------------------------------------------------------------------
// Exported: generate content
// ---------------------------------------------------------------------------

/**
 * Call Gemini API to generate text content.
 *
 * @param {string} systemInstruction - System instruction for the model
 * @param {string} userPrompt - User prompt
 * @param {object} [options] - Optional generation config overrides
 * @param {number} [options.temperature] - 0.0 - 2.0
 * @param {number} [options.maxOutputTokens] - Maximum output tokens
 * @returns {Promise<string>} Generated text
 * @throws {Error} If quota exceeded or API call fails
 */
export async function generateContent(systemInstruction, userPrompt, options = {}) {
  // --- Quota check ---
  const quota = checkApiQuota();
  if (!quota.allowed) {
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
    // Record the request timestamp BEFORE the call
    recordRequest();
    incrementApiUsage();

    const response = await ai.models.generateContent({
      model: MODEL_NAME,
      contents: userPrompt,
      config,
    });

    const text = response.text;

    if (!text || text.trim().length === 0) {
      throw new Error('Gemini returned empty response');
    }

    return text.trim();
  } catch (error) {
    // If the error is a 429 (rate limit), provide clear message
    if (error.message && error.message.includes('429')) {
      console.error('[Gemini] Rate limit hit (429). Skipping this cycle.');
      throw new Error('Gemini API rate limit exceeded (429)');
    }
    // Re-throw other errors
    throw error;
  }
}

/**
 * Get current quota status (for monitoring/API endpoint).
 * @returns {{ dailyUsage: number, dailyLimit: number, rpmWindowCount: number, rpmLimit: number, model: string }}
 */
export function getQuotaStatus() {
  const now = Date.now();
  const oneMinuteAgo = now - 60_000;
  while (requestTimestamps.length > 0 && requestTimestamps[0] < oneMinuteAgo) {
    requestTimestamps.shift();
  }

  return {
    dailyUsage: getTodayApiUsage(),
    dailyLimit: DAILY_SOFT_LIMIT,
    rpmWindowCount: requestTimestamps.length,
    rpmLimit: RPM_LIMIT,
    model: MODEL_NAME,
  };
}
