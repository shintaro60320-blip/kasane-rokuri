// model.js — 曲のデータと編集。純粋な関数だけ（DOM も Web Audio も触らない）。
// どの関数も引数の project を書き換えず、新しい project を返す。
// 録音データ（Audio）はここでは扱わない。Clip の数字（start / offset / duration / takes / activeTake）だけを変える。

export const XFADE = 0.01;          // 範囲の録り直しの境目のつなぎ（秒）
export const DEFAULT_FADE = 0.005;  // ふつうのフレーズの頭と終わり（秒）
export const MIN_CLIP = 0.02;       // フレーズの最短の長さ（秒）
const TOL = 1e-9;

export const TRACK_COLORS = ['#6cc3b5', '#d6a65c', '#8ea7d6', '#c48db0', '#9bbf7a', '#bdb6a8'];

export const LIMITS = {
  trackGain: [0, 1.5],
  pan: [-1, 1],
  clipGain: [0, 1.5],
  masterGain: [0, 1.5],
  bpm: [40, 240],
  beatsPerBar: [1, 12],
  countInBars: [0, 4],
  latencyMs: [-100, 400],
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clone = (o) => structuredClone(o);

// ---- id ----
let idSource = () => {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID().replace(/-/g, '').slice(0, 16);
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
};
/** テストで id を決まった値にするため */
export function setIdSource(fn) { idSource = fn; }
export function newId(prefix) { return `${prefix}_${idSource()}`; }

// ---- 作る ----
export function createProject({ name = '新しい曲', now = Date.now(), id } = {}) {
  return {
    id: id || newId('p'),
    name,
    createdAt: now,
    updatedAt: now,
    bpm: 120,
    beatsPerBar: 4,
    metronomeOn: false,
    countInBars: 1,
    snap: false,
    loop: { on: false, start: 0, end: 0 },
    selection: null,
    masterGain: 1,
    latencyMs: 0,
    tracks: [],
    clips: [],
    shelved: [],   // 録り直しなどで完全に隠れたフレーズ（鳴らさないが、録音への参照は残す）
  };
}

export function addTrack(p, { name, id } = {}) {
  const q = clone(p);
  const n = q.tracks.length;
  const used = new Set(q.tracks.map((t) => t.name));
  let k = n + 1;
  let auto = `トラック${k}`;
  while (used.has(auto)) auto = `トラック${++k}`;
  const t = {
    id: id || newId('t'),
    name: name || auto,
    color: TRACK_COLORS[n % TRACK_COLORS.length],
    gain: 1,
    pan: 0,
    mute: false,
    solo: false,
  };
  q.tracks.push(t);
  return { project: q, trackId: t.id };
}

export function updateTrack(p, id, patch) {
  const q = clone(p);
  const t = q.tracks.find((x) => x.id === id);
  if (!t) return q;
  if ('name' in patch) t.name = String(patch.name).slice(0, 40) || t.name;
  if ('color' in patch) t.color = String(patch.color);
  if ('gain' in patch) t.gain = clamp(num(patch.gain, t.gain), ...LIMITS.trackGain);
  if ('pan' in patch) t.pan = clamp(num(patch.pan, t.pan), ...LIMITS.pan);
  if ('mute' in patch) t.mute = !!patch.mute;
  if ('solo' in patch) t.solo = !!patch.solo;
  return q;
}

export function removeTrack(p, id) {
  const q = clone(p);
  q.tracks = q.tracks.filter((t) => t.id !== id);
  q.clips = q.clips.filter((c) => c.trackId !== id);
  return q;
}

export function setProjectFields(p, patch) {
  const q = clone(p);
  if ('name' in patch) q.name = String(patch.name).slice(0, 60) || q.name;
  if ('bpm' in patch) q.bpm = Math.round(clamp(num(patch.bpm, q.bpm), ...LIMITS.bpm));
  if ('beatsPerBar' in patch) q.beatsPerBar = Math.round(clamp(num(patch.beatsPerBar, q.beatsPerBar), ...LIMITS.beatsPerBar));
  if ('countInBars' in patch) q.countInBars = Math.round(clamp(num(patch.countInBars, q.countInBars), ...LIMITS.countInBars));
  if ('metronomeOn' in patch) q.metronomeOn = !!patch.metronomeOn;
  if ('snap' in patch) q.snap = !!patch.snap;
  if ('masterGain' in patch) q.masterGain = clamp(num(patch.masterGain, q.masterGain), ...LIMITS.masterGain);
  if ('latencyMs' in patch) q.latencyMs = clamp(num(patch.latencyMs, q.latencyMs), ...LIMITS.latencyMs);
  return q;
}

// ---- 時間の計算 ----
export const clipEnd = (c) => c.start + c.duration;
export const beatSec = (bpm) => 60 / bpm;
export function snapToBeat(t, bpm) {
  const b = beatSec(bpm);
  return Math.max(0, Math.round(t / b) * b);
}
export function projectEnd(p) {
  let e = 0;
  for (const c of p.clips) e = Math.max(e, clipEnd(c));
  return e;
}

// ---- Clip の部品 ----
export function activeTake(c) { return c.takes[c.activeTake]; }

function syncOffset(c) { c.offset = c.takes[c.activeTake].offset; }

/** 頭を delta 秒だけ後ろへ（負なら前へ）。全テイクの頭出しを同じだけ動かす */
function shiftHead(c, delta) {
  c.start += delta;
  c.duration -= delta;
  for (const t of c.takes) t.offset += delta;
  if (c.keep) for (const k of c.keep) { if (k.kind === 'in') k.at -= delta; else k.end -= delta; }
  syncOffset(c);
}

/**
 * フェードの長さを正しい数にするだけ。フレーズより長くてもよい（切った後も元のフェードの形を保つため）。
 * 頭と終わりのフェードが重なる所は掛け算になる。
 */
function normFades(c) {
  c.fadeIn = Math.max(0, num(c.fadeIn, 0));
  c.fadeOut = Math.max(0, num(c.fadeOut, 0));
}

/**
 * keep＝切る前の元のフェード（もう端にないもの）。切った後も同じ形で掛かるように残す。
 * { kind:'in', at, len }：clip.start から at 秒の所から len 秒かけて 0→1（at より前は 0）
 * { kind:'out', end, len }：clip.start から end 秒の所で 0 になるよう len 秒かけて 1→0（end より後は 0）
 */
function pruneKeep(c) {
  if (!c.keep) { c.keep = []; return; }
  c.keep = c.keep.filter((k) => (k.kind === 'in' ? k.at + k.len > 0 : k.end - k.len < c.duration));
}

/** 終わりを newEnd で切る。元の終わりのフェードが残る部分に掛かるなら keep に移す */
function cutEnd(c, newEnd, fade) {
  const oe = clipEnd(c);
  if (newEnd >= oe - TOL) return;
  if (!c.keep) c.keep = [];
  if (c.fadeOut > 0 && oe - c.fadeOut < newEnd) c.keep.push({ kind: 'out', end: oe - c.start, len: c.fadeOut });
  c.duration = newEnd - c.start;
  c.fadeOut = fade;
  pruneKeep(c);
  normFades(c);
}

/** 頭を newStart で切る。元の頭のフェードが残る部分に掛かるなら keep に移す */
function cutStart(c, newStart, fade) {
  const os = c.start;
  if (newStart <= os + TOL) return;
  if (!c.keep) c.keep = [];
  const fi = c.fadeIn;
  shiftHead(c, newStart - os);
  if (fi > 0 && os + fi > newStart) c.keep.push({ kind: 'in', at: os - newStart, len: fi });
  c.fadeIn = fade;
  pruneKeep(c);
  normFades(c);
}

export function makeClip({ id, trackId, start, duration, audioId, offset = 0, fadeIn = DEFAULT_FADE, fadeOut = DEFAULT_FADE, gain = 1 }) {
  const c = {
    id: id || newId('c'),
    trackId,
    start,
    offset,
    duration,
    gain,
    fadeIn,
    fadeOut,
    takes: [{ audioId, offset }],
    activeTake: 0,
    keep: [],
  };
  normFades(c);
  return c;
}

/**
 * 同じトラックで topId の Clip と重なる Clip を切り詰める（topId が上に乗る）。
 * xfade > 0 のときは、切られた側を top の中へ xfade 秒だけ残し、境目をつなぐ（範囲の録り直し用）。
 * つなぎのフェードは top の範囲の内側にだけ掛かり、残す側の元のフェードの形は変えない。
 * すっぽり覆われた Clip は消さずに shelved（退避）へ移す（録音への参照を残す）。q をその場で書き換える（内部用）。
 */
function resolveOverlapsMut(q, topId, xfade = 0) {
  const top = q.clips.find((c) => c.id === topId);
  if (!top) return;
  const s = top.start;
  const e = clipEnd(top);
  const out = [];
  const cutFade = xfade > 0 ? xfade : DEFAULT_FADE;
  if (!Array.isArray(q.shelved)) q.shelved = [];
  for (const o of q.clips) {
    if (o === top || o.trackId !== top.trackId) { out.push(o); continue; }
    const os = o.start;
    const oe = clipEnd(o);
    if (oe <= s + TOL || os >= e - TOL) { out.push(o); continue; }
    const keepLeft = os < s - TOL;
    const keepRight = oe > e + TOL;
    if (!keepLeft && !keepRight) {
      q.shelved.push({ ...clone(o), shelvedBy: top.id });
      continue;
    }
    if (keepLeft) {
      const L = clone(o);
      cutEnd(L, Math.min(oe, s + xfade), cutFade);
      out.push(L);
    }
    if (keepRight) {
      const R = clone(o);
      if (keepLeft) R.id = newId('c');
      cutStart(R, Math.max(os, e - xfade), cutFade);
      out.push(R);
    }
  }
  q.clips = out;
}

function findClip(q, id) {
  const c = q.clips.find((x) => x.id === id);
  if (!c) throw new Error(`フレーズが見つかりません: ${id}`);
  return c;
}

// ---- 録音を置く ----

/** ふつうの録音を置く。重なった古いフレーズは切り詰める */
export function recordClip(p, { trackId, start, duration, audioId, offset = 0 }) {
  const q = clone(p);
  const c = makeClip({ trackId, start, duration, audioId, offset });
  q.clips.push(c);
  resolveOverlapsMut(q, c.id, 0);
  return { project: q, clipId: c.id };
}

/**
 * 範囲の録り直し。範囲とぴったり同じ Clip がそのトラックにあれば、テイクを足すだけ。
 * なければ範囲の Clip を新しく置き、古いフレーズを境目で切って 10ms でつなぐ。
 */
export function punchIn(p, { trackId, range, audioId, offset, xfade = XFADE }) {
  const q = clone(p);
  const len = range.end - range.start;
  const match = q.clips.find((c) => c.trackId === trackId && Math.abs(c.start - range.start) < 1e-3 && Math.abs(c.duration - len) < 1e-3);
  if (match) {
    match.takes.push({ audioId, offset });
    match.activeTake = match.takes.length - 1;
    syncOffset(match);
    return { project: q, clipId: match.id, addedTake: true };
  }
  const c = makeClip({ trackId, start: range.start, duration: len, audioId, offset, fadeIn: xfade, fadeOut: xfade });
  q.clips.push(c);
  resolveOverlapsMut(q, c.id, xfade);
  return { project: q, clipId: c.id, addedTake: false };
}

/** フレーズにテイクを足す（同じ位置・長さで録り直したとき） */
export function addTake(p, clipId, audioId, offset) {
  const q = clone(p);
  const c = findClip(q, clipId);
  c.takes.push({ audioId, offset });
  c.activeTake = c.takes.length - 1;
  syncOffset(c);
  return q;
}

/**
 * テイク index で、今のフレーズの位置に鳴らせる録音がある区間（曲の秒）。
 * audioSecOf(audioId)＝録音の長さ（秒）。分からなければ終わりの制限なし。
 */
function takeSpan(c, index, audioSecOf) {
  const t = c.takes[index];
  const sec = audioSecOf ? audioSecOf(t.audioId) : Infinity;
  const a0 = c.start - t.offset; // その録音の 0 秒目が曲のどこか
  const a = Math.max(c.start, a0);
  const b = Math.min(clipEnd(c), Number.isFinite(sec) ? a0 + sec : Infinity);
  return { a, b };
}

/** テイク index に切り替えられるか（今の位置に、そのテイクの録音が MIN_CLIP 以上あるか） */
export function canUseTake(c, index, audioSecOf = null) {
  if (index < 0 || index >= c.takes.length) return false;
  const { a, b } = takeSpan(c, index, audioSecOf);
  return b - a >= MIN_CLIP - 1e-9;
}

/** 使うテイクが変わったとき、そのテイクの録音がある所だけに縮める（頭と終わり） */
function fitToTake(c, audioSecOf) {
  const { a, b } = takeSpan(c, c.activeTake, audioSecOf);
  syncOffset(c);
  if (a > c.start + TOL) shiftHead(c, a - c.start);
  c.duration = Math.max(MIN_CLIP, b - c.start);
  pruneKeep(c);
  normFades(c);
}

/** 使うテイクを切り替える。今の位置にそのテイクの録音がなければ、切り替えない（元の project を返す） */
export function setActiveTake(p, clipId, index, audioSecOf = null) {
  const c0 = p.clips.find((x) => x.id === clipId);
  if (!c0 || !canUseTake(c0, index, audioSecOf)) return p;
  const q = clone(p);
  const c = findClip(q, clipId);
  c.activeTake = index;
  fitToTake(c, audioSecOf);
  return q;
}

/** テイクを消す。最後の1つは消さない（フレーズの削除を使う） */
export function removeTake(p, clipId, index, audioSecOf = null) {
  const q = clone(p);
  const c = findClip(q, clipId);
  if (c.takes.length <= 1 || index < 0 || index >= c.takes.length) return p;
  const wasActive = c.activeTake === index;
  c.takes.splice(index, 1);
  if (c.activeTake > index) c.activeTake -= 1;
  else if (wasActive) {
    // 使っていたテイクを消したら、今の位置に録音がある別のテイクを使う。無ければ消さない
    const order = [Math.min(index, c.takes.length - 1), ...c.takes.map((_, i) => i)];
    const usable = order.find((i) => canUseTake(c, i, audioSecOf));
    if (usable === undefined) return p;
    c.activeTake = usable;
    fitToTake(c, audioSecOf);
  }
  return q;
}

// ---- フレーズの編集 ----

export function splitClip(p, clipId, t) {
  const q = clone(p);
  const c = findClip(q, clipId);
  if (t <= c.start + MIN_CLIP || t >= clipEnd(c) - MIN_CLIP) return { project: p, ok: false };
  const R = clone(c);
  R.id = newId('c');
  cutEnd(c, t, 0);
  cutStart(R, t, 0);
  q.clips.splice(q.clips.indexOf(c) + 1, 0, R);
  return { project: q, ok: true, leftId: c.id, rightId: R.id };
}

/**
 * フレーズを動かす・伸ばすときは、同じトラックのほかのフレーズを削らない（隣の端で止まる）。
 * freeStart：trackId のトラックで、長さ dur のフレーズを want 秒に置きたいとき、
 * ほかのフレーズに重ならない一番近い位置を返す。min より前には置かない。
 */
export function freeStart(p, clipId, want, trackId, { min = 0 } = {}) {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return Math.max(min, want);
  const dur = c.duration;
  const tid = trackId || c.trackId;
  const others = p.clips.filter((o) => o.id !== clipId && o.trackId === tid).sort((a, b) => a.start - b.start);
  want = Math.max(min, want);
  let best = null;
  let a = min;
  const tryGap = (lo, hi) => {
    if (hi - lo < dur - 1e-7) return;
    const s = Math.min(Math.max(want, lo), Math.max(lo, hi - dur));
    if (best === null || Math.abs(s - want) < Math.abs(best - want) - 1e-9) best = s;
  };
  for (const o of others) {
    const oe = clipEnd(o);
    if (oe <= a + TOL) continue;
    tryGap(a, o.start);
    a = Math.max(a, oe);
  }
  tryGap(a, Infinity);
  return best === null ? a : best;
}

/** 縮める・伸ばすときに動かせる範囲（隣のフレーズの端まで）。minStart＝頭の下限、maxEnd＝終わりの上限 */
export function trimBounds(p, clipId) {
  const c = p.clips.find((x) => x.id === clipId);
  let minStart = 0;
  let maxEnd = Infinity;
  if (!c) return { minStart, maxEnd };
  const mid = c.start + c.duration / 2;
  for (const o of p.clips) {
    if (o.id === clipId || o.trackId !== c.trackId) continue;
    const oe = clipEnd(o);
    if (o.start + o.duration / 2 <= mid) minStart = Math.max(minStart, Math.min(oe, c.start));
    else maxEnd = Math.min(maxEnd, Math.max(o.start, clipEnd(c)));
  }
  return { minStart, maxEnd };
}

/** 頭を newStart へ（縮める・伸ばす）。録音の頭より前や、0秒より前、隣のフレーズの中には伸ばせない */
export function trimStart(p, clipId, newStart) {
  const q = clone(p);
  const c = findClip(q, clipId);
  let delta = Math.max(newStart, trimBounds(q, clipId).minStart) - c.start;
  delta = Math.max(delta, -c.offset, -c.start); // 今のテイクの録音がある所まで
  delta = Math.min(delta, c.duration - MIN_CLIP);
  shiftHead(c, delta);
  if (delta < 0 && c.keep) c.keep = c.keep.filter((k) => k.kind !== 'in'); // 伸ばして戻したら、切ったときのフェードは外す
  pruneKeep(c);
  normFades(c);
  resolveOverlapsMut(q, c.id, 0);
  return q;
}

/** 終わりを newEnd へ。audioSec＝使っているテイクの録音の長さ（秒）。分からなければ伸ばす上限なし */
export function trimEnd(p, clipId, newEnd, audioSec = Infinity) {
  const q = clone(p);
  const c = findClip(q, clipId);
  let d = Math.min(newEnd, trimBounds(q, clipId).maxEnd) - c.start;
  d = Math.min(d, audioSec - c.offset);
  d = Math.max(d, MIN_CLIP);
  const longer = d > c.duration + TOL;
  c.duration = d;
  if (longer && c.keep) c.keep = c.keep.filter((k) => k.kind !== 'out');
  pruneKeep(c);
  normFades(c);
  resolveOverlapsMut(q, c.id, 0);
  return q;
}

export function moveClip(p, clipId, { start, trackId }) {
  const q = clone(p);
  const c = findClip(q, clipId);
  // 隣のフレーズは削らない。重なる所へ置こうとしたら、重ならない一番近い位置に置く
  const tid = trackId && q.tracks.some((t) => t.id === trackId) ? trackId : c.trackId;
  const want = typeof start === 'number' && Number.isFinite(start) ? Math.max(0, start) : c.start;
  c.start = freeStart(q, c.id, want, tid);
  c.trackId = tid;
  return q;
}

export function nudgeClip(p, clipId, delta) {
  const c = p.clips.find((x) => x.id === clipId);
  if (!c) return p;
  return moveClip(p, clipId, { start: c.start + delta });
}

export function duplicateClip(p, clipId) {
  const q = clone(p);
  const c = findClip(q, clipId);
  const d = clone(c);
  d.id = newId('c');
  q.clips.push(d);
  d.start = freeStart(q, d.id, clipEnd(c), c.trackId, { min: clipEnd(c) }); // 後ろのフレーズを削らず、空いている所へ
  return { project: q, clipId: d.id };
}

export function deleteClip(p, clipId) {
  const q = clone(p);
  q.clips = q.clips.filter((c) => c.id !== clipId);
  return q;
}

export function setClipGain(p, clipId, gain) {
  const q = clone(p);
  const c = findClip(q, clipId);
  c.gain = clamp(num(gain, c.gain), ...LIMITS.clipGain);
  return q;
}

// ---- 範囲・くり返し ----
export function setSelection(p, range) {
  const q = clone(p);
  if (!range) { q.selection = null; return q; }
  const a = Math.max(0, Math.min(range.start, range.end));
  const b = Math.max(0, Math.max(range.start, range.end));
  q.selection = b - a >= MIN_CLIP ? { start: a, end: b } : null;
  return q;
}

export function setLoop(p, patch) {
  const q = clone(p);
  q.loop = { ...q.loop, ...patch };
  q.loop.on = !!q.loop.on;
  return q;
}

/** くり返す区間：範囲があればその範囲、なければ曲の頭から終わりまで */
export function loopRegion(p) {
  if (p.selection) return { start: p.selection.start, end: p.selection.end };
  const e = projectEnd(p);
  return e > MIN_CLIP ? { start: 0, end: e } : null;
}

// ---- 音を鳴らす側のための計算 ----

export function audible(p, track) {
  const anySolo = p.tracks.some((t) => t.solo);
  return !track.mute && (!anySolo || track.solo);
}

/** StereoPannerNode（モノラル入力）と同じ計算 */
export function panGains(pan) {
  const x = (clamp(pan, -1, 1) + 1) / 2;
  return { l: Math.cos((x * Math.PI) / 2), r: Math.sin((x * Math.PI) / 2) };
}

/** フェードの掛かり具合（0〜1）。t は曲の中の時刻 */
export function envelopeAt(c, t) {
  const local = t - c.start;
  if (local < 0 || local > c.duration) return 0;
  let g = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
  const rest = c.duration - local;
  if (c.fadeOut > 0 && rest < c.fadeOut) g *= rest / c.fadeOut;
  if (c.keep) {
    for (const k of c.keep) {
      if (k.kind === 'in') {
        const d = local - k.at;
        if (d < 0) return 0;
        if (d < k.len) g *= d / k.len;
      } else {
        const d = k.end - local;
        if (d < 0) return 0;
        if (d < k.len) g *= d / k.len;
      }
    }
  }
  return g;
}

/**
 * 再生のときの音量の折れ線（[曲の秒, 値] の列）。a〜b の間。
 * フェードが掛け算で重なる所は直線ではないので、細かく点を打つ。
 */
export function envelopePoints(c, a, b) {
  const pts = new Set([a, b]);
  const edges = [];
  if (c.fadeIn > 0) edges.push([c.start, c.start + c.fadeIn]);
  if (c.fadeOut > 0) edges.push([clipEnd(c) - c.fadeOut, clipEnd(c)]);
  for (const k of c.keep || []) {
    if (k.kind === 'in') edges.push([c.start + k.at, c.start + k.at + k.len]);
    else edges.push([c.start + k.end - k.len, c.start + k.end]);
  }
  for (const [x0, x1] of edges) {
    for (let i = 0; i <= 4; i++) {
      const t = x0 + ((x1 - x0) * i) / 4;
      if (t > a && t < b) pts.add(t);
    }
  }
  const ts = [...pts].sort((x, y) => x - y);
  const endT = clipEnd(c);
  return ts.map((t) => [t, envelopeAt(c, Math.min(t, endT))]);
}

/**
 * メトロノームの次の拍。拍番号 nextK から、horizon（曲の秒）までと until より前の拍を返す。
 * 同じ拍を二度返さないよう、次に予約する拍番号を返す。
 */
export function nextBeats({ nextK, beat, horizon, until = Infinity }) {
  const beats = [];
  let k = nextK;
  for (; k * beat <= horizon + 1e-9 && k * beat < until - 1e-9; k++) beats.push(k);
  return { beats, nextK: k };
}
export const firstBeatIndex = (song, beat) => Math.ceil(song / beat - 1e-9) + 0;

/**
 * 再生で予約する区間を出す。from〜to の間で、exclude（録音先トラックの録る範囲）を除いた部分。
 * 戻り値：[{ clip, trackId, songStart, songEnd, audioId, audioOffset }]
 */
export function scheduleSegments(p, { from = 0, to = Infinity, exclude = null } = {}) {
  const out = [];
  for (const c of p.clips) {
    const take = activeTake(c);
    if (!take) continue;
    let parts = [[Math.max(c.start, from), Math.min(clipEnd(c), to)]];
    if (exclude && exclude.trackId === c.trackId) {
      const next = [];
      for (const [a, b] of parts) {
        if (b <= exclude.start || a >= exclude.end) { next.push([a, b]); continue; }
        if (a < exclude.start) next.push([a, exclude.start]);
        if (b > exclude.end) next.push([exclude.end, b]);
      }
      parts = next;
    }
    for (const [a, b] of parts) {
      if (b - a <= 1e-6) continue;
      out.push({ clip: c, trackId: c.trackId, songStart: a, songEnd: b, audioId: take.audioId, audioOffset: take.offset + (a - c.start) });
    }
  }
  out.sort((x, y) => x.songStart - y.songStart);
  return out;
}

// ---- 録音を曲のどこに置くか（§6） ----

/** 録音データの1サンプル目が、曲のどの位置に当たるか */
export function recordingSongPos0({ transportFrom, transportCtxStart, firstFrame, sampleRate, latencySec }) {
  return transportFrom + (firstFrame / sampleRate - transportCtxStart) - latencySec;
}

/** ふつうの録音：recordStart から先を Clip にする */
export function placeRecording({ recordStart, songPos0, pcmSec }) {
  let start = recordStart;
  let offset = recordStart - songPos0;
  if (offset < 0) { start = songPos0; offset = 0; }
  const duration = pcmSec - offset;
  if (duration < MIN_CLIP) return null;
  return { start, offset, duration };
}

/** 範囲の録り直し：範囲の分だけを Clip にする（途中で止めたら、そこまで） */
export function placePunch({ range, songPos0, pcmSec }) {
  const offset = range.start - songPos0;
  if (offset < 0) return null;
  const available = pcmSec - offset;
  if (available < MIN_CLIP) return null;
  const end = Math.min(range.end, range.start + available);
  if (end - range.start < MIN_CLIP) return null;
  return { range: { start: range.start, end }, offset };
}

// ---- 録音の控え ----

/**
 * 録音中に保存した控えの断片（[{ parts: [{ frame, data }] }]）を1本につなぐ。
 * 途中が欠けていた長さ（秒）も返す（欠けた所は無音）。
 */
export function assemblePending(chunks, sampleRate) {
  const parts = chunks.flatMap((c) => c.parts).sort((a, b) => a.frame - b.frame);
  if (!parts.length) return { pcm: new Float32Array(0), first: 0, gapSec: 0 };
  const first = parts[0].frame;
  let expect = first;
  let gap = 0;
  for (const p of parts) {
    if (p.frame > expect) gap += p.frame - expect;
    expect = Math.max(expect, p.frame + p.data.length);
  }
  const pcm = new Float32Array(expect - first);
  for (const p of parts) pcm.set(p.data, p.frame - first);
  return { pcm, first, gapSec: gap / sampleRate };
}

// ---- 隠れたフレーズ ----

/** 退避したフレーズを、新しいトラックの元の位置に戻す */
export function restoreShelved(p, shelvedId, { name } = {}) {
  const q = clone(p);
  const i = (q.shelved || []).findIndex((c) => c.id === shelvedId);
  if (i < 0) return { project: p, ok: false };
  const c = q.shelved.splice(i, 1)[0];
  delete c.shelvedBy;
  const from = q.tracks.find((t) => t.id === c.trackId);
  const r = addTrack(q, { name: name || `${from ? from.name : 'トラック'}（戻した音）`.slice(0, 40) });
  const q2 = r.project;
  c.trackId = r.trackId;
  q2.clips.push(c);
  return { project: q2, ok: true, trackId: r.trackId, clipId: c.id };
}

// ---- 保存の掃除 ----
export function referencedAudioIds(projects) {
  const s = new Set();
  for (const p of projects) {
    for (const c of p.clips) for (const t of c.takes) s.add(t.audioId);
    for (const c of p.shelved || []) for (const t of c.takes) s.add(t.audioId);
  }
  return s;
}

/** 開くときに古い形のデータを直す */
export function normalizeProject(raw) {
  const base = createProject({ id: raw.id, name: raw.name || '名前のない曲', now: raw.createdAt || Date.now() });
  const p = { ...base, ...raw };
  p.loop = { ...base.loop, ...(raw.loop || {}) };
  p.tracks = Array.isArray(raw.tracks) ? raw.tracks : [];
  const fix = (list) => (Array.isArray(list) ? list : []).filter((c) => Array.isArray(c.takes) && c.takes.length > 0).map((c) => {
    c.takes = c.takes.map((t) => (typeof t === 'string' ? { audioId: t, offset: c.offset || 0 } : t));
    c.activeTake = clamp(c.activeTake | 0, 0, c.takes.length - 1);
    if (!Array.isArray(c.keep)) c.keep = [];
    syncOffset(c);
    return c;
  });
  p.clips = fix(raw.clips);
  p.shelved = fix(raw.shelved);
  return p;
}
