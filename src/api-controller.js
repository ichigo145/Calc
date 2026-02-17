// ===========================================================================
// api-controller.js - API自動制御 + 自動管理 + ポイントシステム (A-Talk v4.0)
// ===========================================================================
// v4.0: DM削除、ポイントデイリーリセット統合
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
  getRecentThreadSummaries,
  isAutoManagementEnabled,
  getAllAutoManagement,
  setAutoManagement,
  grantDailyPoints,
  getAllUserPoints,
  getAllPopularity,
} from './database.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const DAILY_HARD_LIMIT = 10000;
const DAILY_SOFT_LIMIT = 9500;
const RESERVE_MIN = 200;

const THRESHOLD_WARN = 0.70;
const THRESHOLD_RESTRICT = 0.80;
const THRESHOLD_CRITICAL = 0.90;

// DM removed from features
const ON_DEMAND_FEATURES = ['comment_generation', 'reaction_chain'];
const ALL_FEATURES = ['post_generation', ...ON_DEMAND_FEATURES];

const FOLLOWER_RECALC_INTERVAL_MS = 60_000;
let followerRecalcTimer = null;

const ANOMALY_CHECK_INTERVAL_MS = 30_000;
let anomalyCheckTimer = null;

// Daily point grant timer
const DAILY_POINT_CHECK_INTERVAL_MS = 60_000; // Check every minute
let dailyPointTimer = null;
let lastDailyPointDate = '';

let currentPostIntervalMultiplier = 1.0;

// ---------------------------------------------------------------------------
// Auto-control
// ---------------------------------------------------------------------------
export function evaluateAndControl() {
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
        setPauseState(feature, true, `自動停止: 使用率 ${Math.round(usageRatio * 100)}% (危険)`);
        actions.push(`自動停止: ${feature}`);
      }
    }
    return { level: 'critical', usage: todayUsage, remaining, actions };
  }

  if (usageRatio >= THRESHOLD_RESTRICT) {
    for (const feature of ON_DEMAND_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `自動停止: 使用率 ${Math.round(usageRatio * 100)}% (制限)`);
        actions.push(`自動停止: ${feature}`);
      }
    }
    return { level: 'restricted', usage: todayUsage, remaining, actions };
  }

  if (usageRatio >= THRESHOLD_WARN) {
    return { level: 'warning', usage: todayUsage, remaining, actions };
  }

  const pauseStates = getAllPauseStates();
  for (const state of pauseStates) {
    if (state.paused === 1 && state.reason && state.reason.startsWith('自動停止:')) {
      setPauseState(state.feature, false, null);
      actions.push(`自動復帰: ${state.feature}`);
    }
  }

  return { level: 'normal', usage: todayUsage, remaining, actions };
}

// ---------------------------------------------------------------------------
// Rate adjustment
// ---------------------------------------------------------------------------
export function evaluateRateAdjustment() {
  if (!isAutoManagementEnabled('auto_rate_adjust')) {
    currentPostIntervalMultiplier = 1.0;
    return { multiplier: 1.0, reason: '自動レート調整無効' };
  }

  const todayUsage = getTodayApiUsage();
  const usageRatio = todayUsage / DAILY_SOFT_LIMIT;

  if (usageRatio >= 0.90) {
    currentPostIntervalMultiplier = 5.0;
    return { multiplier: 5.0, reason: `危険 (${Math.round(usageRatio * 100)}%)` };
  }
  if (usageRatio >= 0.80) {
    currentPostIntervalMultiplier = 3.0;
    return { multiplier: 3.0, reason: `高 (${Math.round(usageRatio * 100)}%)` };
  }
  if (usageRatio >= 0.60) {
    currentPostIntervalMultiplier = 1.5;
    return { multiplier: 1.5, reason: `中 (${Math.round(usageRatio * 100)}%)` };
  }

  currentPostIntervalMultiplier = 1.0;
  return { multiplier: 1.0, reason: `通常 (${Math.round(usageRatio * 100)}%)` };
}

export function getPostIntervalMultiplier() {
  return currentPostIntervalMultiplier;
}

// ---------------------------------------------------------------------------
// Anomaly monitoring
// ---------------------------------------------------------------------------
function checkAnomaliesAndAct() {
  if (!isAutoManagementEnabled('auto_pause_resume')) return;

  const anomalyCounts = getAnomalyCountToday();
  let total429 = 0;
  let totalAuth = 0;

  for (const ac of anomalyCounts) {
    if (ac.type === 'rate_limit_429') total429 += ac.count;
    if (ac.type === 'auth_error') totalAuth += ac.count;
  }

  if (total429 >= 10) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `自動停止: ${total429}件のレート制限エラー`);
        console.log(`[auto-mgmt] 自動停止 ${feature}: ${total429}件の429エラー`);
      }
    }
  }

  if (totalAuth >= 3) {
    for (const feature of ALL_FEATURES) {
      if (!isFeaturePaused(feature)) {
        setPauseState(feature, true, `自動停止: ${totalAuth}件の認証エラー - APIキー確認`);
        console.log(`[auto-mgmt] 自動停止 ${feature}: ${totalAuth}件の認証エラー`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Daily point grant (毎日0時に100 Point付与)
// ---------------------------------------------------------------------------
function checkDailyPointGrant() {
  const today = new Date().toISOString().slice(0, 10);
  if (lastDailyPointDate !== today) {
    lastDailyPointDate = today;
    try {
      const granted = grantDailyPoints();
      if (granted > 0) {
        console.log(`[point-system] デイリーボーナス: ${granted}人に100 Point付与`);
      }
    } catch (err) {
      console.warn(`[point-system] デイリーボーナスエラー: ${err.message}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Follower recalc
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
    console.log(`[auto-mgmt] フォロワー再計算: ${result.length}人更新`);
  } catch (err) {
    console.warn(`[auto-mgmt] フォロワー再計算エラー: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Start/stop
// ---------------------------------------------------------------------------
export function startAutoManagement() {
  if (!followerRecalcTimer) {
    followerRecalcTimer = setInterval(doFollowerRecalc, FOLLOWER_RECALC_INTERVAL_MS);
    console.log(`[auto-mgmt] フォロワー再計算タイマー開始 (${FOLLOWER_RECALC_INTERVAL_MS / 1000}秒間隔)`);
  }

  if (!anomalyCheckTimer) {
    anomalyCheckTimer = setInterval(checkAnomaliesAndAct, ANOMALY_CHECK_INTERVAL_MS);
    console.log(`[auto-mgmt] 異常監視開始 (${ANOMALY_CHECK_INTERVAL_MS / 1000}秒間隔)`);
  }

  if (!dailyPointTimer) {
    checkDailyPointGrant(); // Initial check
    dailyPointTimer = setInterval(checkDailyPointGrant, DAILY_POINT_CHECK_INTERVAL_MS);
    console.log(`[auto-mgmt] デイリーポイント監視開始`);
  }
}

export function stopAutoManagement() {
  if (followerRecalcTimer) { clearInterval(followerRecalcTimer); followerRecalcTimer = null; }
  if (anomalyCheckTimer) { clearInterval(anomalyCheckTimer); anomalyCheckTimer = null; }
  if (dailyPointTimer) { clearInterval(dailyPointTimer); dailyPointTimer = null; }
  console.log('[auto-mgmt] 全タイマー停止');
}

// ---------------------------------------------------------------------------
// Manual control
// ---------------------------------------------------------------------------
export function manualPause(feature, reason = '手動停止') {
  if (!ALL_FEATURES.includes(feature)) {
    return { success: false, error: `不明な機能: ${feature}` };
  }
  setPauseState(feature, true, reason);
  return { success: true, feature, paused: true };
}

export function manualResume(feature) {
  if (!ALL_FEATURES.includes(feature)) {
    return { success: false, error: `不明な機能: ${feature}` };
  }
  setPauseState(feature, false, null);
  return { success: true, feature, paused: false };
}

export function pauseAll(reason = '全機能手動停止') {
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

export function toggleAutoManagement(feature, enabled) {
  const validFeatures = ['auto_rate_adjust', 'auto_follower_recalc', 'auto_pause_resume'];
  if (!validFeatures.includes(feature)) {
    return { success: false, error: `不明な自動管理機能: ${feature}` };
  }
  setAutoManagement(feature, enabled);
  return { success: true, feature, enabled };
}

// ---------------------------------------------------------------------------
// Dashboard data
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
  const threadSummaries = getRecentThreadSummaries(5);
  const autoMgmt = getAllAutoManagement();
  const userPoints = getAllUserPoints();
  const popularityRanking = getAllPopularity();

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
    recentLogs: recentLogs.map(l => ({ ...l, success: l.success === 1 })),
    anomalies: {
      recent: recentAnomalies,
      todayCounts: anomalyCounts,
    },
    dbInfo,
    dailySummaries,
    threadSummaries,
    controlledFeatures: ALL_FEATURES,
    userPoints: userPoints.slice(0, 20),
    popularityRanking: popularityRanking.slice(0, 20),
  };
}
