// sw.js — オフライン用。アプリ本体（app\ の中のファイル）だけをキャッシュする。録音はキャッシュしない（IndexedDB にある）。
//
// 版の扱い：
//   ・install で、その版のファイル一式を全部取り直してキャッシュする（cache: 'reload'。1つでも失敗したらその版は使わない）
//   ・取り終えた新しい版は「待機」になり、次に開いたときから効く（使っている間に新旧のファイルが混ざらない）
//   ・取り終えたら画面へ知らせる（「新しい版があります。開き直すと更新されます」）
//   ・ファイルは「今の版のキャッシュ」を先に返す。キャッシュに無いものだけネットワークへ
//   ・HTTP エラーの応答はキャッシュに入れない。ネットワークが失敗・エラーのときは今の版のキャッシュへ戻る
//   ・localhost での開発中は何もしない（ブラウザにそのまま任せる）
//
// 版を上げるとき：このファイルの VERSION と js/main.js の VERSION を同じ値に変える。

const VERSION = 'v1.8.0';
const CACHE = `kasane-app-${VERSION}`;
const FILES = [
  './',
  'index.html',
  'manifest.webmanifest',
  'css/app.css',
  'js/main.js',
  'js/model.js',
  'js/align.js',
  'js/history.js',
  'js/store.js',
  'js/engine.js',
  'js/recorder-worklet.js',
  'js/wav.js',
  'js/mix.js',
  'js/backup.js',
  'js/peaks.js',
  'js/ui-timeline.js',
  'js/ui-sheets.js',
  'js/testkit.js',
  'icons/icon-192.png',
  'icons/icon-512.png',
  'icons/icon-maskable-512.png',
  'icons/apple-touch-icon.png',
];
const DEV = ['localhost', '127.0.0.1', '[::1]'].includes(self.location.hostname);

self.addEventListener('install', (event) => {
  if (DEV) { self.skipWaiting(); return; }
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // 一式そろわなければ install を失敗させる（中途半端な版は使わない）
    await Promise.all(FILES.map(async (f) => {
      const res = await fetch(new Request(f, { cache: 'reload' }));
      if (!res.ok) throw new Error(`${f}: ${res.status}`);
      await cache.put(f, res);
    }));
    const clients = await self.clients.matchAll({ includeUncontrolled: true, type: 'window' });
    for (const c of clients) c.postMessage({ type: 'version-ready', version: VERSION });
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('kasane-app-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

function offline() {
  return new Response('オフラインのため読み込めません', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}

self.addEventListener('fetch', (event) => {
  if (DEV) return;
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  const scope = new URL(self.registration.scope);
  if (!url.pathname.startsWith(scope.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const isNav = req.mode === 'navigate';
    const hit = isNav ? (await cache.match('index.html')) || (await cache.match('./')) : await cache.match(req, { ignoreSearch: true });
    if (hit) return hit;
    try {
      const res = await fetch(req);
      if (res.ok) return res; // 一式に入っていないものはキャッシュしない
      const fallback = isNav ? await cache.match('index.html') : null;
      return fallback || res;
    } catch {
      const fallback = isNav ? await cache.match('index.html') : null;
      return fallback || offline();
    }
  })());
});
