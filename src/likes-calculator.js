// ===========================================================================
// likes-calculator.js - 人気スコア → いいね数 変換ロジック
// ===========================================================================
//
// 人気スコア (0〜100) からいいね数を算出する。
// AIは使わない。コード側のみで処理する。
//
// ## 変換ロジックの詳細
//
// ### 基本方針
// 人気スコアが高いほどいいね数が多くなるが、線形ではなく指数的に増加する。
// これにより、スコア90の投稿とスコア50の投稿のいいね数に大きな差がつき、
// 現実のSNSに近い分布になる。
//
// ### 数式
//
//   baseLikes = floor(A * e^(B * score))
//
//   A = 1.0 (スケーリング定数)
//   B = 0.06 (増加率)
//   score = 人気スコア (0〜100)
//
// ### ランダム補正
//
//   randomFactor = 1.0 + (Math.random() * 2 - 1) * 0.2
//                = 0.8 〜 1.2 の一様乱数
//
//   finalLikes = floor(baseLikes * randomFactor)
//
// ### スコア別の期待値 (ランダム補正前)
//
//   score=0   → baseLikes = floor(1.0 * e^(0.06*0))   = floor(1.0)     = 1
//   score=10  → baseLikes = floor(1.0 * e^(0.06*10))  = floor(1.822)   = 1
//   score=20  → baseLikes = floor(1.0 * e^(0.06*20))  = floor(3.320)   = 3
//   score=30  → baseLikes = floor(1.0 * e^(0.06*30))  = floor(6.050)   = 6
//   score=40  → baseLikes = floor(1.0 * e^(0.06*40))  = floor(11.023)  = 11
//   score=50  → baseLikes = floor(1.0 * e^(0.06*50))  = floor(20.086)  = 20
//   score=60  → baseLikes = floor(1.0 * e^(0.06*60))  = floor(36.598)  = 36
//   score=70  → baseLikes = floor(1.0 * e^(0.06*70))  = floor(66.686)  = 66
//   score=80  → baseLikes = floor(1.0 * e^(0.06*80))  = floor(121.510) = 121
//   score=90  → baseLikes = floor(1.0 * e^(0.06*90))  = floor(221.406) = 221
//   score=100 → baseLikes = floor(1.0 * e^(0.06*100)) = floor(403.429) = 403
//
// ### ランダム補正後の範囲 (score=50 の場合)
//   baseLikes = 20
//   min = floor(20 * 0.8) = 16
//   max = floor(20 * 1.2) = 24
//   → 16〜24 のいいね数になる
//
// ### 設計根拠
// - score=0〜20: ほぼ反応なし (1〜3いいね)。現実でもほとんどの投稿は埋もれる。
// - score=30〜50: そこそこの反応 (6〜24いいね)。一般的な投稿。
// - score=60〜80: 良い反応 (29〜145いいね)。注目される投稿。
// - score=90〜100: バズ (177〜483いいね)。稀に出現する人気投稿。
//
// ===========================================================================

const A = 1.0;   // スケーリング定数
const B = 0.06;  // 増加率

/**
 * 人気スコアからいいね数を算出する。
 *
 * @param {number} score - 人気スコア (0〜100 の整数)
 * @returns {number} いいね数 (0以上の整数)
 */
export function popularityScoreToLikes(score) {
  // 入力の検証
  if (typeof score !== 'number' || score < 0 || score > 100) {
    throw new Error(`Invalid popularity score: ${score}. Must be 0-100.`);
  }

  // 基本いいね数 (指数関数)
  const baseLikes = Math.floor(A * Math.exp(B * score));

  // ランダム補正 (0.8〜1.2 の範囲)
  const randomFactor = 1.0 + (Math.random() * 2 - 1) * 0.2;

  // 最終いいね数
  const finalLikes = Math.max(0, Math.floor(baseLikes * randomFactor));

  return finalLikes;
}
