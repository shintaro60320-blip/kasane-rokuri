// align.js — 重ねて録った音のずれを見つける（純粋な計算。画面や音の部品には触らない）
//
// 考え方：ハモリや重ねた楽器は、前の音と「音の出だし（言葉や音符の頭）」の位置がそろう。
// 新しいフレーズと、ほかのトラックの音の「出だしの強さ」を細かい時間ごとに出し、
// 少しずつずらしながら一番よく重なる位置を探す。重なり方がはっきりしないときは「分からない」と返す
// （わざとずらして歌った所などで、外れた位置へ勝手に動かさないため）。

import { activeTake } from './model.js';

export const HOP = 0.0025;      // 2.5ms ごとに調べる
export const MAX_LAG = 0.4;     // 前後 0.4 秒まで探す
const MAX_WINDOW = 30;          // 長いフレーズは頭の 30 秒だけで調べる

/**
 * 時間 from〜to の、指定したフレーズたちの音の大きさを hop ごとに出す。
 * mode 'mean'＝平均の大きさ（ずれ探し用）／'peak'＝一番大きい所（絵を描く用）
 */
export function envelopeOf(project, audios, { from, to, hop = HOP, include, mode = 'mean' }) {
  const n = Math.max(0, Math.ceil((to - from) / hop));
  const env = new Float32Array(n);
  for (const c of project.clips) {
    if (!include(c)) continue;
    const take = activeTake(c);
    const a = audios.get(take.audioId);
    if (!a || !a.pcm) continue;
    const sr = a.sampleRate;
    const s = Math.max(from, c.start);
    const e = Math.min(to, c.start + c.duration);
    if (e <= s) continue;
    const gain = Number.isFinite(c.gain) ? c.gain : 1;
    const i0 = Math.max(0, Math.floor((s - from) / hop));
    const i1 = Math.min(n, Math.ceil((e - from) / hop));
    for (let i = i0; i < i1; i++) {
      const t0 = Math.max(s, from + i * hop);
      const t1 = Math.min(e, from + (i + 1) * hop);
      if (t1 <= t0) continue;
      let k0 = Math.floor((t0 - c.start + take.offset) * sr);
      let k1 = Math.floor((t1 - c.start + take.offset) * sr);
      k0 = Math.max(0, k0);
      k1 = Math.min(a.pcm.length, k1);
      if (k1 <= k0) continue;
      let v = 0;
      if (mode === 'peak') {
        for (let k = k0; k < k1; k++) { const x = Math.abs(a.pcm[k]); if (x > v) v = x; }
      } else {
        for (let k = k0; k < k1; k++) v += Math.abs(a.pcm[k]);
        v /= (k1 - k0);
      }
      env[i] += v * gain;
    }
  }
  return env;
}

/** 音の出だしの強さ（大きさが急に増えた所ほど大きい） */
export function onsetStrength(env) {
  const n = env.length;
  const out = new Float32Array(n);
  let prev = Math.log(1e-4 + (n ? env[0] : 0));
  for (let i = 1; i < n; i++) {
    const l = Math.log(1e-4 + env[i]);
    out[i] = Math.max(0, l - prev);
    prev = l;
  }
  // 平均を引いて、ずっと続く小さな揺れの影響を減らす
  let m = 0;
  for (let i = 0; i < n; i++) m += out[i];
  m = n ? m / n : 0;
  for (let i = 0; i < n; i++) out[i] = Math.max(0, out[i] - m);
  // 人の歌は、出だしが1つずつ少しばらつく。尖った山のままだと重なりにくいので、15ms ほどならす
  const rad = Math.max(1, Math.round(0.015 / HOP));
  return smooth(smooth(out, rad), rad);
}

function smooth(a, rad) {
  const n = a.length;
  const out = new Float32Array(n);
  let s = 0;
  for (let i = 0; i < Math.min(n, rad); i++) s += a[i];
  for (let i = 0; i < n; i++) {
    if (i + rad < n) s += a[i + rad];
    if (i - rad - 1 >= 0) s -= a[i - rad - 1];
    out[i] = s / (2 * rad + 1);
  }
  return out;
}

/**
 * ref（前の音）と x（新しい音）を比べて、x が何コマ遅れているかを返す。
 * 戻り値：{ lag（コマ・小数あり）, score（0〜1の重なり具合）, margin（2番目の候補との差） }
 */
export function bestLag(ref, x, maxLag) {
  const n = Math.min(ref.length, x.length);
  let nr = 0;
  let nx = 0;
  for (let i = 0; i < n; i++) { nr += ref[i] * ref[i]; nx += x[i] * x[i]; }
  if (nr <= 1e-12 || nx <= 1e-12) return null;
  const norm = Math.sqrt(nr * nx);
  const scores = new Float64Array(2 * maxLag + 1);
  for (let L = -maxLag; L <= maxLag; L++) {
    let s = 0;
    const i0 = Math.max(0, -L);
    const i1 = Math.min(n, n - L);
    for (let i = i0; i < i1; i++) s += ref[i] * x[i + L];
    scores[L + maxLag] = s / norm;
  }
  let bi = 0;
  for (let i = 1; i < scores.length; i++) if (scores[i] > scores[bi]) bi = i;
  // 2番目の候補：一番の山から 20ms 以上離れた所で一番高い所
  const away = Math.max(2, Math.round(0.02 / HOP));
  let second = 0;
  for (let i = 0; i < scores.length; i++) if (Math.abs(i - bi) > away && scores[i] > second) second = scores[i];
  // 山の頂点を、両隣から細かく出す
  let frac = 0;
  if (bi > 0 && bi < scores.length - 1) {
    const a = scores[bi - 1];
    const b = scores[bi];
    const c = scores[bi + 1];
    const d = a - 2 * b + c;
    if (d < 0) frac = Math.max(-0.5, Math.min(0.5, 0.5 * (a - c) / d));
  }
  return { lag: bi - maxLag + frac, score: scores[bi], margin: scores[bi] - second };
}

/**
 * フレーズ clipId が、ほかのトラックの音に対してどれだけ遅れているか（秒）を探す。
 * 戻り値：{ ok:true, lagSec（プラス＝遅れている。前へ lagSec 動かせば合う）, score, margin }
 *        { ok:false, reason } … 重なる音がない・はっきりしない
 */
export function findLag(project, audios, clipId, { maxLag = MAX_LAG, minScore = 0.5, minMargin = 0.1 } = {}) {
  const c = project.clips.find((x) => x.id === clipId);
  if (!c) return { ok: false, reason: 'no-clip' };
  const a = c.start;
  const b = Math.min(c.start + c.duration, c.start + MAX_WINDOW);
  const from = Math.max(0, a - maxLag);
  const to = b + maxLag;
  const others = (x) => x.trackId !== c.trackId;
  // 重なる時間に、ほかのトラックの音があるか
  if (!project.clips.some((x) => others(x) && x.start < b && x.start + x.duration > a)) return { ok: false, reason: 'no-overlap' };
  const refEnv = envelopeOf(project, audios, { from, to, include: others });
  const xEnv = envelopeOf(project, audios, { from, to, include: (x) => x.id === clipId });
  const r = bestLag(onsetStrength(refEnv), onsetStrength(xEnv), Math.round(maxLag / HOP));
  if (!r) return { ok: false, reason: 'silent' };
  if (r.score < minScore || r.margin < minMargin) return { ok: false, reason: 'unclear', score: r.score, margin: r.margin };
  return { ok: true, lagSec: r.lag * HOP, score: r.score, margin: r.margin };
}
