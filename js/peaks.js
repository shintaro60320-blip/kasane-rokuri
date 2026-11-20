// peaks.js — 波形の絵のための山（最小・最大）の計算。純粋な関数。

export const PEAK_BUCKET = 256;

/** pcm を bucket サンプルずつに分け、[min, max, min, max, ...] を返す */
export function computePeaks(pcm, bucket = PEAK_BUCKET) {
  const n = Math.ceil(pcm.length / bucket);
  const data = new Float32Array(n * 2);
  for (let b = 0; b < n; b++) {
    let mn = 0;
    let mx = 0;
    const end = Math.min(pcm.length, (b + 1) * bucket);
    for (let i = b * bucket; i < end; i++) {
      const v = pcm[i];
      if (v < mn) mn = v;
      if (v > mx) mx = v;
    }
    data[b * 2] = mn;
    data[b * 2 + 1] = mx;
  }
  return { bucket, data };
}

/** 録音中にかたまりを足していく用 */
export class PeakBuilder {
  constructor(bucket = PEAK_BUCKET) {
    this.bucket = bucket;
    this.data = new Float32Array(1024);
    this.n = 0;        // 確定した山の数
    this.fill = 0;     // 今の山に入ったサンプル数
    this.mn = 0;
    this.mx = 0;
  }
  push(chunk) {
    for (let i = 0; i < chunk.length; i++) {
      const v = chunk[i];
      if (v < this.mn) this.mn = v;
      if (v > this.mx) this.mx = v;
      if (++this.fill === this.bucket) this._close();
    }
  }
  _close() {
    if ((this.n + 1) * 2 > this.data.length) {
      const d = new Float32Array(this.data.length * 2);
      d.set(this.data);
      this.data = d;
    }
    this.data[this.n * 2] = this.mn;
    this.data[this.n * 2 + 1] = this.mx;
    this.n++;
    this.fill = 0;
    this.mn = 0;
    this.mx = 0;
  }
  get peaks() {
    const d = this.data.slice(0, this.n * 2 + (this.fill ? 2 : 0));
    if (this.fill) { d[this.n * 2] = this.mn; d[this.n * 2 + 1] = this.mx; }
    return { bucket: this.bucket, data: d };
  }
}

/**
 * 画面の columns 本の縦線にまとめる。startSample〜endSample の範囲（録音データのサンプル番号）。
 * 戻り値 Float32Array(columns * 2)
 */
export function peaksForRange(peaks, startSample, endSample, columns) {
  const out = new Float32Array(Math.max(0, columns) * 2);
  if (columns <= 0 || endSample <= startSample) return out;
  const nb = peaks.data.length / 2;
  const per = (endSample - startSample) / columns;
  for (let c = 0; c < columns; c++) {
    const s0 = startSample + c * per;
    const s1 = s0 + per;
    let b0 = Math.floor(s0 / peaks.bucket);
    let b1 = Math.max(b0 + 1, Math.ceil(s1 / peaks.bucket));
    b0 = Math.max(0, b0);
    b1 = Math.min(nb, b1);
    let mn = 0;
    let mx = 0;
    for (let b = b0; b < b1; b++) {
      if (peaks.data[b * 2] < mn) mn = peaks.data[b * 2];
      if (peaks.data[b * 2 + 1] > mx) mx = peaks.data[b * 2 + 1];
    }
    out[c * 2] = mn;
    out[c * 2 + 1] = mx;
  }
  return out;
}
