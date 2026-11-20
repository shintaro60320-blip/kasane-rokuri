// wav.js — WAV（16bit PCM）への書き出しと読み込み、リサンプル。純粋な関数。

function writeStr(view, at, s) {
  for (let i = 0; i < s.length; i++) view.setUint8(at + i, s.charCodeAt(i));
}

export function floatToInt16(v) {
  const s = v > 1 ? 1 : v < -1 ? -1 : v;
  return s < 0 ? Math.round(s * 32768) : Math.round(s * 32767);
}

/** channels: Float32Array の配列（同じ長さ）。戻り値 ArrayBuffer */
export function encodeWav16(channels, sampleRate) {
  const nch = channels.length;
  if (nch < 1) throw new Error('チャンネルがありません');
  const len = channels[0].length;
  for (const ch of channels) if (ch.length !== len) throw new Error('チャンネルの長さが違います');
  const dataBytes = len * nch * 2;
  const buf = new ArrayBuffer(44 + dataBytes);
  const v = new DataView(buf);
  writeStr(v, 0, 'RIFF');
  v.setUint32(4, 36 + dataBytes, true);
  writeStr(v, 8, 'WAVE');
  writeStr(v, 12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, nch, true);
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * nch * 2, true);
  v.setUint16(32, nch * 2, true);
  v.setUint16(34, 16, true);
  writeStr(v, 36, 'data');
  v.setUint32(40, dataBytes, true);
  let at = 44;
  for (let i = 0; i < len; i++) {
    for (let c = 0; c < nch; c++) {
      v.setInt16(at, floatToInt16(channels[c][i]), true);
      at += 2;
    }
  }
  return buf;
}

/** 16bit PCM と 32bit float の WAV を読む。戻り値 { sampleRate, channels } */
export function decodeWav(buffer) {
  const v = new DataView(buffer);
  const str = (at, n) => String.fromCharCode(...new Uint8Array(buffer, at, n));
  if (str(0, 4) !== 'RIFF' || str(8, 4) !== 'WAVE') throw new Error('WAV ではありません');
  let at = 12;
  let fmt = null;
  while (at + 8 <= buffer.byteLength) {
    const id = str(at, 4);
    const size = v.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      fmt = {
        format: v.getUint16(body, true),
        nch: v.getUint16(body + 2, true),
        sampleRate: v.getUint32(body + 4, true),
        bits: v.getUint16(body + 14, true),
      };
    } else if (id === 'data') {
      if (!fmt) throw new Error('fmt がありません');
      const bytesPer = fmt.bits / 8;
      const frames = Math.floor(Math.min(size, buffer.byteLength - body) / (bytesPer * fmt.nch));
      const channels = Array.from({ length: fmt.nch }, () => new Float32Array(frames));
      let p = body;
      for (let i = 0; i < frames; i++) {
        for (let c = 0; c < fmt.nch; c++) {
          if (fmt.format === 1 && fmt.bits === 16) {
            const s = v.getInt16(p, true);
            channels[c][i] = s < 0 ? s / 32768 : s / 32767;
          } else if (fmt.format === 3 && fmt.bits === 32) {
            channels[c][i] = v.getFloat32(p, true);
          } else {
            throw new Error('この形式の WAV には対応していません');
          }
          p += bytesPer;
        }
      }
      return { sampleRate: fmt.sampleRate, channels };
    }
    at = body + size + (size % 2);
  }
  throw new Error('data がありません');
}

/** 直線でつなぐリサンプル */
export function resampleLinear(pcm, from, to) {
  if (from === to) return pcm.slice();
  const outLen = Math.max(0, Math.round((pcm.length * to) / from));
  const out = new Float32Array(outLen);
  const ratio = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio;
    const i0 = Math.floor(pos);
    const f = pos - i0;
    const a = pcm[i0] ?? 0;
    const b = pcm[i0 + 1] ?? a;
    out[i] = a + (b - a) * f;
  }
  return out;
}
