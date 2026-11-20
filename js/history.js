// history.js — 取り消し／やり直し。曲のデータ（project）の写しを積むだけの純粋な仕組み。
// 録音データは書き換えないので、project の写しを戻せば音も戻る。

export const HISTORY_LIMIT = 50;

export function createHistory(limit = HISTORY_LIMIT) {
  return { past: [], future: [], limit };
}

/** 編集の直前の状態 prev を積む。やり直しの列は捨てる */
export function record(h, prev) {
  const past = h.past.concat([structuredClone(prev)]);
  while (past.length > h.limit) past.shift();
  return { past, future: [], limit: h.limit };
}

export const canUndo = (h) => h.past.length > 0;
export const canRedo = (h) => h.future.length > 0;

/** 取り消し。current は今の状態。戻り値 { history, state } または null */
export function undo(h, current) {
  if (!canUndo(h)) return null;
  const past = h.past.slice(0, -1);
  const state = h.past[h.past.length - 1];
  return { history: { past, future: h.future.concat([structuredClone(current)]), limit: h.limit }, state: structuredClone(state) };
}

export function redo(h, current) {
  if (!canRedo(h)) return null;
  const future = h.future.slice(0, -1);
  const state = h.future[h.future.length - 1];
  return { history: { past: h.past.concat([structuredClone(current)]), future, limit: h.limit }, state: structuredClone(state) };
}

/** 履歴の中で使われている録音の id（掃除で消してはいけないもの） */
export function historyAudioIds(h) {
  const s = new Set();
  for (const p of h.past.concat(h.future)) for (const c of p.clips) for (const t of c.takes) s.add(t.audioId);
  return s;
}
