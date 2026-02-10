// ===========================================================================
// api-controller.js - API自動制御システム (A-Talk v3.1)
// ===========================================================================
//
// v3.1 Changes:
//   - Anomaly data included in dashboard
//   - DB info for admin viewing
//   - Daily summary retrieval
//   - Rate limits per model from gemini_rate_limits.csv
// ===========================================================================

import {
  getTodayApiUsage,
  getAllPauseStates,
  setPauseState,
  isFeaturePaused,
  getUsageHistory,
  getUsageLogToday,
  getRecentUsageLogs,
  getRecentAnomalies,
  getAnomalyCountToday,
  getDbInfo,
  getRecentDailySummaries,
} from './database.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 1000;
const DAILY_SOFT_LIMIT = 950;
const RESERVE_MIN = 50;

// Auto-pause thresholds (percentage of DAILY_SOFT_LIMIT)
const THRESHOLD_WARN = 0.70;    // 70%: 警告開始
const THRESHOLD_RESTRICT = 0.80; // 80%: オンデマンド機能を自動一時停止
const THRESHOLD_CRITICAL = 0.90; // 90%: 全機能を自動一時停止

// Features controlled
const ON_DEMAND_FEATURES = ['comment_generation', 'dm_generation', 'reaction_chain'];
const ALL_FEATURES = ['post_generation', ...ON_DEMAND_FEATURES];

// ---------------------------------------------------------------------------
// Auto-control check (called periodically and on each API request)
// ---------------------------------------------------------------------------

/**
 * Evaluate current usage and auto-pause/resume features as needed.
 * @returns {{ level: string, usage: number, remaining: number, actions: string[] }}
 */
export function evaluateAndControl() {
  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;
  const usageRatio = todayUsage / DAILY_SOFT_LIMIT;
  const actions = [];

  // CRITICAL: 90%+ - pause everything
  if (usageRatio >= THRESHOLD_CRITICAL) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: usage at ${Math.round(usageRatio * 100)}% (critical)`);
        actions.push(`auto-paused: ${feature}`);
      }
    }
    return { level: 'critical', usage: todayUsage, remaining, actions };
  }

  // RESTRICT: 80%+ - pause on-demand features only
  if (usageRatio >= THRESHOLD_RESTRICT) {
    for (const feature of ON_DEMAND_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: usage at ${Math.round(usageRatio * 100)}% (restricted)`);
        actions.push(`auto-paused: ${feature}`);
      }
    }
    return { level: 'restricted', usage: todayUsage, remaining, actions };
  }

  // WARN: 70%+ - log warning but don't pause
  if (usageRatio >= THRESHOLD_WARN) {
    return { level: 'warning', usage: todayUsage, remaining, actions };
  }

  // NORMAL: auto-resume any auto-paused features
  const pauseStates = getAllPauseStates();
  for (const state of pauseStates) {
    if (state.paused === 1 && state.reason && state.reason.startsWith('Auto-paused:')) {
      setPauseState(state.feature, false, null);
      actions.push(`auto-resumed: ${state.feature}`);
    }
  }

  return { level: 'normal', usage: todayUsage, remaining, actions };
}

// ---------------------------------------------------------------------------
// Manual control
// ---------------------------------------------------------------------------

export function manualPause(feature, reason = 'Manual pause') {
  if (!ALL_FEATURES.includes(feature)) {
    return { success: false, error: `Unknown feature: ${feature}` };
  }
  setPauseState(feature, true, reason);
  return { success: true, feature, paused: true };
}

export function manualResume(feature) {
  if (!ALL_FEATURES.includes(feature)) {
    return { success: false, error: `Unknown feature: ${feature}` };
  }
  setPauseState(feature, false, null);
  return { success: true, feature, paused: false };
}

export function pauseAll(reason = 'Manual pause all') {
  for (const feature of ALL_FEATURES) {
    setPauseState(feature, true, reason);
  }
  return { success: true, features: ALL_FEATURES, paused: true };
}

export function resumeAll() {
  for (const feature of ALL_FEATURES) {
    setPauseState(feature, false, null);
  }
  return { success: true, features: ALL_FEATURES, paused: false };
}

// ---------------------------------------------------------------------------
// Dashboard data (comprehensive)
// ---------------------------------------------------------------------------

export function getDashboardData() {
  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;
  const usageRatio = todayUsage / DAILY_SOFT_LIMIT;
  const pauseStates = getAllPauseStates();
  const usageHistory = getUsageHistory(7);
  const usageLogToday = getUsageLogToday();
  const recentLogs = getRecentUsageLogs(30);
  const recentAnomalies = getRecentAnomalies(20);
  const anomalyCounts = getAnomalyCountToday();
  const dbInfo = getDbInfo();
  const dailySummaries = getRecentDailySummaries(3);

  let level = 'normal';
  if (usageRatio >= THRESHOLD_CRITICAL) level = 'critical';
  else if (usageRatio >= THRESHOLD_RESTRICT) level = 'restricted';
  else if (usageRatio >= THRESHOLD_WARN) level = 'warning';

  return {
    quota: {
      todayUsage,
      dailySoftLimit: DAILY_SOFT_LIMIT,
      dailyHardLimit: DAILY_HARD_LIMIT,
      remaining,
      reserveMin: RESERVE_MIN,
      usagePercent: Math.round(usageRatio * 100),
      level,
    },
    thresholds: {
      warn: Math.round(THRESHOLD_WARN * 100),
      restrict: Math.round(THRESHOLD_RESTRICT * 100),
      critical: Math.round(THRESHOLD_CRITICAL * 100),
    },
    pauseStates: pauseStates.map(s => ({
      feature: s.feature,
      paused: s.paused === 1,
      pausedAt: s.paused_at,
      reason: s.reason,
    })),
    usageHistory,
    usageByModelAndFeature: usageLogToday,
    recentLogs: recentLogs.map(l => ({
      ...l,
      success: l.success === 1,
    })),
    anomalies: {
      recent: recentAnomalies,
      todayCounts: anomalyCounts,
    },
    dbInfo,
    dailySummaries,
    controlledFeatures: ALL_FEATURES,
  };
}
