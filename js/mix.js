// mix.js — 全トラックを混ぜてステレオにする（書き出し用）。純粋な関数。
// 再生（engine.js）と同じ決まり：トラック音量×フレーズ音量×全体の音量、左右の位置、ミュート・ソロ、フェード。
// 同じ曲なら必ず同じ数字が出るように、位置とフェードはサンプル番号（整数）で計算する。

import { audible, panGains, activeTake, projectEnd } from './model.js';

/** 書き出しのサンプルレート：録音と同じ方（44,100 か 48,000）。分からなければ 48,000 */
export function chooseExportRate(audios) {
  for (const a of audios.values()) {
    if (a.sampleRate === 44100 || a.sampleRate === 48000) return a.sampleRate;
  }
  return 48000;
}

/**
 * project を混ぜる。audios: Map(audioId → { sampleRate, pcm })。
 * 戻り値 { sampleRate, left, right }（Float32Array）
 */
export function mixProject(p, audios, { sampleRate, start = 0, end } = {}) {
  const sr = sampleRate || chooseExportRate(audios);
  const endSec = end ?? projectEnd(p);
  const startN = Math.round(start * sr);
  const N = Math.max(0, Math.round(endSec * sr) - startN);
  const left = new Float32Array(N);
  const right = new Float32Array(N);
  const master = p.masterGain;
  for (const track of p.tracks) {
    if (!audible(p, track)) continue;
    const { l, r } = panGains(track.pan);
    for (const clip of p.clips) {
      if (clip.trackId !== track.id) continue;
      const take = activeTake(clip);
      const a = take && audios.get(take.audioId);
      if (!a) continue;
      const g = track.gain * clip.gain * master;
      if (g === 0) continue;
      const s0 = Math.round(clip.start * sr);
      const s1 = Math.round((clip.start + clip.duration) * sr);
      const fi = Math.round(clip.fadeIn * sr);
      const fo = Math.round(clip.fadeOut * sr);
      const n0 = Math.max(0, s0 - startN);
      const n1 = Math.min(N, s1 - startN);
      const same = a.sampleRate === sr;
      const shift = Math.round((clip.start - take.offset) * sr); // 録音の0サンプル目が曲のどのサンプルか
      // 切る前の元のフェード（keep）もサンプル番号にしておく
      const keeps = (clip.keep || []).map((kp) => (kp.kind === 'in'
        ? { in: true, a: Math.round((clip.start + kp.at) * sr), L: Math.round(kp.len * sr) }
        : { in: false, b: Math.round((clip.start + kp.end) * sr), L: Math.round(kp.len * sr) }));
      const pcm = a.pcm;
      for (let n = n0; n < n1; n++) {
        const abs = n + startN;
        let v;
        if (same) {
          const idx = abs - shift;
          if (idx < 0 || idx >= pcm.length) continue;
          v = pcm[idx];
        } else {
          const pos = (abs / sr - clip.start + take.offset) * a.sampleRate;
          const i0 = Math.floor(pos);
          if (i0 < 0 || i0 >= pcm.length) continue;
          const f = pos - i0;
          const b = i0 + 1 < pcm.length ? pcm[i0 + 1] : pcm[i0];
          v = pcm[i0] + (b - pcm[i0]) * f;
        }
        let env = 1;
        const k = abs - s0;
        if (k < fi) env *= k / fi;
        const m = s1 - abs;
        if (m < fo) env *= m / fo;
        for (const kp of keeps) {
          const d = kp.in ? abs - kp.a : kp.b - abs;
          if (d < 0) { env = 0; break; }
          if (d < kp.L) env *= d / kp.L;
        }
        const out = v * g * env;
        left[n] += out * l;
        right[n] += out * r;
      }
    }
  }
  return { sampleRate: sr, left, right };
}
