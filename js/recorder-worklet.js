// recorder-worklet.js — マイクの音を、そのまま（加工なしの Float32）でメインへ送る。
// 各かたまりに「1サンプル目の AudioContext のフレーム番号」を付けるので、録った位置を正確に計算できる。

class KasaneRecorder extends AudioWorkletProcessor {
  constructor() {
    super();
    this.size = 2048;
    this.buf = new Float32Array(this.size);
    this.n = 0;
    this.startFrame = 0;
    this.peak = 0;
    this.port.onmessage = (e) => {
      if (e.data === 'flush') {
        this.post();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }

  post() {
    if (!this.n) return;
    const data = this.buf.slice(0, this.n);
    this.port.postMessage({ type: 'chunk', frame: this.startFrame, data, peak: this.peak }, [data.buffer]);
    this.n = 0;
    this.peak = 0;
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input.length ? input[0] : null;
    const len = ch ? ch.length : 128;
    for (let i = 0; i < len; i++) {
      if (this.n === 0) this.startFrame = currentFrame + i;
      const v = ch ? ch[i] : 0;
      this.buf[this.n++] = v;
      const a = v < 0 ? -v : v;
      if (a > this.peak) this.peak = a;
      if (this.n === this.size) this.post();
    }
    return true;
  }
}

registerProcessor('kasane-recorder', KasaneRecorder);
