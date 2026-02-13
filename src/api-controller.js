// ===========================================================================
// api-controller.js - API自動制御 + 自動管理システム (A-Talk v3.2)
// ===========================================================================
// v3.2 Changes:
//   - Auto-management ON/OFF toggles (auto_rate_adjust, auto_follower_recalc, auto_pause_resume)
//   - Follower recalculation every 60 seconds (when enabled)
//   - Auto-adjust posting rate based on API usage
//   - Auto-pause/resume based on anomaly monitoring
//   - Updated limits for loose rate limits (RPD 10K)
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
  isAutoManagementEnabled,
  getAllAutoManagement,
  setAutoManagement,
} from './database.js';

// ---------------------------------------------------------------------------
// Constants - Updated for loose rate limits
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 10000;
const DAILY_SOFT_LIMIT = 9500;
const RESERVE_MIN = 200;

// Auto-pause thresholds (percentage of DAILY_SOFT_LIMIT)
const THRESHOLD_WARN = 0.70;
const THRESHOLD_RESTRICT = 0.80;
const THRESHOLD_CRITICAL = 0.90;

// Features controlled
const ON_DEMAND_FEATURES = ['comment_generation', 'dm_generation', 'reaction_chain'];
const ALL_FEATURES = ['post_generation', ...ON_DEMAND_FEATURES];

// Follower recalc interval (1 minute)
const FOLLOWER_RECALC_INTERVAL_MS = 60_000;
let followerRecalcTimer = null;

// Anomaly monitoring interval (30 seconds)
const ANOMALY_CHECK_INTERVAL_MS = 30_000;
let anomalyCheckTimer = null;

// Rate adjustment state
let currentPostIntervalMultiplier = 1.0; // 1.0 = normal, >1.0 = slower, <1.0 = faster

// ---------------------------------------------------------------------------
// Auto-control check
// ---------------------------------------------------------------------------
export function evaluateAndControl() {
  // Only auto-pause/resume if the feature is enabled
  if (!isAutoManagementEnabled('auto_pause_resume')) {
    const todayUsage = getTodayApiUsage();
    const remaining = DAILY_HARD_LIMIT - todayUsage;
    return { level: 'manual', usage: todayUsage, remaining, actions: [] };
  }

  const todayUsage = getTodayApiUsage();
  const remaining = DAILY_HARD_LIMIT - todayUsage;
  const usageRatio = todayUsage / DAILY_SOFT_LIMIT;
  const actions = [];

  if (usageRatio >= THRESHOLD_CRITICAL) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: usage at ${Math.round(usageRatio * 100)}% (critical)`);
        actions.push(`auto-paused: ${feature}`);
      }
    }
    return { level: 'critical', usage: todayUsage, remaining, actions };
  }

  if (usageRatio >= THRESHOLD_RESTRICT) {
    for (const feature of ON_DEMAND_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: usage at ${Math.round(usageRatio * 100)}% (restricted)`);
        actions.push(`auto-paused: ${feature}`);
      }
    }
    return { level: 'restricted', usage: todayUsage, remaining, actions };
  }

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
// Auto rate adjustment - dynamically adjust post interval
// ---------------------------------------------------------------------------
export function evaluateRateAdjustment() {
  if (!isAutoManagementEnabled('auto_rate_adjust')) {
    currentPostIntervalMultiplier = 1.0;
    return { multiplier: 1.0, reason: 'auto_rate_adjust disabled' };
  }

  const todayUsage = getTodayApiUsage();
  const usageRatio = todayUsage / DAILY_SOFT_LIMIT;

  if (usageRatio >= 0.90) {
    currentPostIntervalMultiplier = 5.0; // Very slow
    return { multiplier: 5.0, reason: `Critical usage (${Math.round(usageRatio * 100)}%)` };
  }
  if (usageRatio >= 0.80) {
    currentPostIntervalMultiplier = 3.0; // Slow
    return { multiplier: 3.0, reason: `High usage (${Math.round(usageRatio * 100)}%)` };
  }
  if (usageRatio >= 0.60) {
    currentPostIntervalMultiplier = 1.5;
    return { multiplier: 1.5, reason: `Moderate usage (${Math.round(usageRatio * 100)}%)` };
  }

  // Low usage: post faster
  currentPostIntervalMultiplier = 1.0;
  return { multiplier: 1.0, reason: `Normal usage (${Math.round(usageRatio * 100)}%)` };
}

export function getPostIntervalMultiplier() {
  return currentPostIntervalMultiplier;
}

// ---------------------------------------------------------------------------
// Anomaly monitoring - auto-pause on repeated errors
// ---------------------------------------------------------------------------
function checkAnomaliesAndAct() {
  if (!isAutoManagementEnabled('auto_pause_resume')) return;

  const anomalyCounts = getAnomalyCountToday();
  let total429 = 0;
  let total503 = 0;
  let totalAuth = 0;

  for (const ac of anomalyCounts) {
    if (ac.type === 'rate_limit_429') total429 += ac.count;
    if (ac.type === 'model_overloaded_503') total503 += ac.count;
    if (ac.type === 'auth_error') totalAuth += ac.count;
  }

  // If too many 429s, slow down everything
  if (total429 >= 10) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: ${total429} rate limit errors today`);
        console.log(`[auto-mgmt] Auto-paused ${feature} due to ${total429} 429 errors`);
      }
    }
  }

  // If auth errors, pause everything
  if (totalAuth >= 3) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `Auto-paused: ${totalAuth} auth errors - check API key`);
        console.log(`[auto-mgmt] Auto-paused ${feature} due to ${totalAuth} auth errors`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Follower recalculation timer
// ---------------------------------------------------------------------------
let computeFollowersFunc = null;

export function setFollowerComputer(fn) {
  computeFollowersFunc = fn;
}

function doFollowerRecalc() {
  if (!isAutoManagementEnabled('auto_follower_recalc')) return;
  if (!computeFollowersFunc) return;
  try {
    const result = computeFollowersFunc();
    console.log(`[auto-mgmt] Follower recalc: ${result.length} users updated`);
  } catch (err) {
    console.warn(`[auto-mgmt] Follower recalc failed: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Start/stop auto-management timers
// ---------------------------------------------------------------------------
export function startAutoManagement() {
  // Follower recalc timer (every 60s)
  if (!followerRecalcTimer) {
    followerRecalcTimer = setInterval(doFollowerRecalc, FOLLOWER_RECALC_INTERVAL_MS);
    console.log(`[auto-mgmt] Follower recalc timer started (every ${FOLLOWER_RECALC_INTERVAL_MS / 1000}s)`);
  }

  // Anomaly check timer (every 30s)
  if (!anomalyCheckTimer) {
    anomalyCheckTimer = setInterval(checkAnomaliesAndAct, ANOMALY_CHECK_INTERVAL_MS);
    console.log(`[auto-mgmt] Anomaly monitor started (every ${ANOMALY_CHECK_INTERVAL_MS / 1000}s)`);
  }
}

export function stopAutoManagement() {
  if (followerRecalcTimer) {
    clearInterval(followerRecalcTimer);
    followerRecalcTimer = null;
  }
  if (anomalyCheckTimer) {
    clearInterval(anomalyCheckTimer);
    anomalyCheckTimer = null;
  }
  console.log('[auto-mgmt] All auto-management timers stopped');
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
// Auto-management toggle
// ---------------------------------------------------------------------------
export function toggleAutoManagement(feature, enabled) {
  const validFeatures = ['auto_rate_adjust', 'auto_follower_recalc', 'auto_pause_resume'];
  if (!validFeatures.includes(feature)) {
    return { success: false, error: `Unknown auto-management feature: ${feature}` };
  }
  setAutoManagement(feature, enabled);
  return { success: true, feature, enabled };
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
  const autoMgmt = getAllAutoManagement();

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
    autoManagement: autoMgmt.map(a => ({
      feature: a.feature,
      enabled: a.enabled === 1,
      updatedAt: a.updated_at,
    })),
    rateAdjustment: evaluateRateAdjustment(),
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
