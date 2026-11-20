// store.js — IndexedDB への保存と読み込み。
// projects：曲のデータ（小さい）／audio：録音（Float32Array。保存後は書き換えない）

let DB_NAME = 'kasane';
const DB_VERSION = 2;
let dbPromise = null;

/** テストのときは別の保存場所を使う（利用者の曲と混ぜない） */
export function setDBName(name) { DB_NAME = name; dbPromise = null; }

function req(r) {
  return new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

function done(tx) {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new DOMException('保存が中断されました', 'AbortError'));
  });
}

export function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    if (!('indexedDB' in globalThis)) { reject(new Error('この端末では保存ができません（IndexedDB がありません）')); return; }
    const r = indexedDB.open(DB_NAME, DB_VERSION);
    r.onupgradeneeded = () => {
      const db = r.result;
      const tx = r.transaction;
      if (!db.objectStoreNames.contains('projects')) db.createObjectStore('projects', { keyPath: 'id' });
      const audio = db.objectStoreNames.contains('audio') ? tx.objectStore('audio') : db.createObjectStore('audio', { keyPath: 'id' });
      if (!audio.indexNames.contains('createdAt')) audio.createIndex('createdAt', 'createdAt');
      // 録音中の断片（画面が閉じられても戻せるように）。key＝'<録音id>:meta' または '<録音id>:<番号>'
      if (!db.objectStoreNames.contains('pending')) db.createObjectStore('pending', { keyPath: 'key' });
    };
    r.onsuccess = () => {
      const db = r.result;
      db.onversionchange = () => db.close();
      resolve(db);
    };
    r.onerror = () => { dbPromise = null; reject(r.error); };
    r.onblocked = () => { /* 別のタブが古い版を開いている。閉じられるのを待つ */ };
  });
  return dbPromise;
}

async function put(store, value) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).put(value);
  await done(tx);
}

async function get(store, key) {
  const db = await openDB();
  return req(db.transaction(store).objectStore(store).get(key));
}

async function del(store, key) {
  const db = await openDB();
  const tx = db.transaction(store, 'readwrite');
  tx.objectStore(store).delete(key);
  await done(tx);
}

export const saveProject = (p) => put('projects', p);
export const loadProject = (id) => get('projects', id);
export const deleteProject = (id) => del('projects', id);
export async function loadAllProjects() {
  const db = await openDB();
  return req(db.transaction('projects').objectStore('projects').getAll());
}

const audioRecord = (a) => ({ id: a.id, sampleRate: a.sampleRate, length: a.pcm.length, createdAt: a.createdAt || Date.now(), pcm: a.pcm });

/** a: { id, sampleRate, length, createdAt, pcm: Float32Array } */
export const saveAudio = (a) => put('audio', audioRecord(a));

/**
 * 曲と録音を同じトランザクションで保存する（片方だけ残ることがない）。
 * pendingIds の控え（録音中の断片）も、同じトランザクションで消す。
 * requirePending を渡すと、その控えがまだ残っているときだけ保存する（無ければ PendingGone で何も保存しない）。
 */
export async function saveProjectWithAudios(project, audios = [], pendingIds = [], { requirePending = null } = {}) {
  const ids = (Array.isArray(pendingIds) ? pendingIds : [pendingIds]).filter(Boolean);
  const db = await openDB();
  const usePending = ids.length > 0 || !!requirePending;
  const tx = db.transaction(usePending ? ['projects', 'audio', 'pending'] : ['projects', 'audio'], 'readwrite');
  let gone = false;
  if (requirePending) {
    const r = tx.objectStore('pending').get(`${requirePending}:meta`);
    r.onsuccess = () => { if (!r.result) { gone = true; tx.abort(); } };
  }
  for (const a of audios) tx.objectStore('audio').put(audioRecord(a));
  tx.objectStore('projects').put(project);
  for (const sid of ids) tx.objectStore('pending').delete(IDBKeyRange.bound(`${sid}:`, `${sid}:\uffff`));
  try {
    await done(tx);
  } catch (e) {
    if (gone) throw Object.assign(new Error('この録音の控えは、もうありません'), { name: 'PendingGone' });
    throw e;
  }
}

// ---- 録音中の断片 ----
export const putPending = (rec) => put('pending', rec);
export async function loadPending() {
  const db = await openDB();
  const all = await req(db.transaction('pending').objectStore('pending').getAll());
  const groups = new Map();
  for (const r of all) {
    const g = groups.get(r.sid) || { sid: r.sid, meta: null, chunks: [] };
    if (r.kind === 'meta') g.meta = r.meta; else g.chunks.push(r);
    groups.set(r.sid, g);
  }
  return [...groups.values()];
}
export async function deletePending(sid) {
  const db = await openDB();
  const tx = db.transaction('pending', 'readwrite');
  tx.objectStore('pending').delete(IDBKeyRange.bound(`${sid}:`, `${sid}:￿`));
  await done(tx);
}
export const loadAudio = (id) => get('audio', id);
export const deleteAudio = (id) => del('audio', id);
export async function audioKeys() {
  const db = await openDB();
  return req(db.transaction('audio').objectStore('audio').getAllKeys());
}

/**
 * どの曲からも使われていない録音を消す（アプリを開いたときだけ呼ぶ）。
 * onlyKeys を渡したときは、その中だけを対象にする（ほかの画面の取り消し用を守るため）。
 */
export async function sweepAudio(referenced, onlyKeys = null) {
  const keys = onlyKeys || (await audioKeys());
  let n = 0;
  for (const k of keys) {
    if (!referenced.has(k)) { await deleteAudio(k); n++; }
  }
  return n;
}

export async function requestPersist() {
  try {
    if (navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted())) return true;
    if (navigator.storage && navigator.storage.persist) return await navigator.storage.persist();
  } catch { /* 頼めない端末もある */ }
  return false;
}

export async function estimate() {
  try {
    if (navigator.storage && navigator.storage.estimate) return await navigator.storage.estimate();
  } catch { /* 取れない端末もある */ }
  return null;
}

export function isQuotaError(e) {
  return !!e && (e.name === 'QuotaExceededError' || e.code === 22 || /quota/i.test(String(e.message || '')));
}
