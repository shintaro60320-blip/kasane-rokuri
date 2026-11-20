// backup.js — 「曲を丸ごと保存」：曲のデータと録音を1つのファイルにまとめる／戻す。純粋な関数。
// 形：'KASANE01'(8) + JSON の長さ(4, little endian) + JSON(UTF-8) + 詰め物(4の倍数へ) + 録音(Float32 を順に)

const MAGIC = 'KASANE01';

/** audios: [{ id, sampleRate, length, createdAt, pcm: Float32Array }] → Uint8Array */
export function packBackup(project, audios) {
  const list = [];
  let bytes = 0;
  for (const a of audios) {
    list.push({ id: a.id, sampleRate: a.sampleRate, length: a.pcm.length, createdAt: a.createdAt || 0, byteOffset: bytes });
    bytes += a.pcm.length * 4;
  }
  const json = new TextEncoder().encode(JSON.stringify({ version: 1, project, audios: list }));
  const head = 8 + 4 + json.length;
  const pad = (4 - (head % 4)) % 4;
  const out = new Uint8Array(head + pad + bytes);
  for (let i = 0; i < 8; i++) out[i] = MAGIC.charCodeAt(i);
  new DataView(out.buffer).setUint32(8, json.length, true);
  out.set(json, 12);
  const base = head + pad;
  for (let i = 0; i < audios.length; i++) {
    const pcm = audios[i].pcm;
    out.set(new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength), base + list[i].byteOffset);
  }
  return out;
}

/** Uint8Array / ArrayBuffer → { project, audios } */
export function unpackBackup(input) {
  const u8 = input instanceof Uint8Array ? input : new Uint8Array(input);
  if (u8.length < 12) throw new Error('ファイルが短すぎます');
  for (let i = 0; i < 8; i++) if (u8[i] !== MAGIC.charCodeAt(i)) throw new Error('かさね録りの保存ファイルではありません');
  const jsonLen = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true);
  if (12 + jsonLen > u8.length) throw new Error('ファイルが壊れています');
  const meta = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + jsonLen)));
  const head = 12 + jsonLen;
  const base = head + ((4 - (head % 4)) % 4);
  const audios = meta.audios.map((m) => {
    const start = base + m.byteOffset;
    const end = start + m.length * 4;
    if (end > u8.length) throw new Error('録音のデータが足りません');
    const copy = u8.slice(start, end);
    return { id: m.id, sampleRate: m.sampleRate, length: m.length, createdAt: m.createdAt, pcm: new Float32Array(copy.buffer) };
  });
  return { project: meta.project, audios };
}
