// ui-timeline.js — トラックと波形の画面、指の操作。
// はさみが入のとき：フレーズの上で指を動かして離す＝そこで切る
// 押す＝選ぶ／長押しして動かす＝フレーズを動かす／目盛りを長押ししてなぞる＝範囲を選ぶ／2本指でつまむ＝拡大・縮小

import { h, fmtTime } from './ui-sheets.js';
import { activeTake, clipEnd, projectEnd, snapToBeat, freeStart, trimBounds, MIN_CLIP } from './model.js';
import { peaksForRange } from './peaks.js';

const LONG_PRESS = 380;
const MOVE_TOL = 10;
const MIN_PPS = 6;
const MAX_PPS = 600;
const MAX_CANVAS_CSS = 4096;

function hexToRgba(hex, a) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  const n = m ? parseInt(m[1], 16) : 0x6cc3b5;
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

export class Timeline {
  constructor(el, app) {
    this.el = el;
    this.app = app;
    this.pps = 48;
    this.head = 92;
    this.contentW = 0;
    this.waveCache = new Map();
    this.g = null;
    this.pinch = null;
    this.rowEls = new Map();
    this.clipEls = new Map();
    this.recEl = null;
    this.playheadT = 0;

    el.addEventListener('pointerdown', (e) => this.onDown(e));
    el.addEventListener('pointermove', (e) => this.onMove(e));
    el.addEventListener('pointerup', (e) => this.onUp(e));
    el.addEventListener('pointercancel', () => this.onCancel());
    el.addEventListener('touchstart', (e) => this.onTouchStart(e), { passive: false });
    el.addEventListener('touchmove', (e) => this.onTouchMove(e), { passive: false });
    el.addEventListener('touchend', (e) => this.onTouchEnd(e));
    el.addEventListener('touchcancel', (e) => this.onTouchEnd(e));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      this.zoomAround(e.clientX, this.pps * Math.exp(-e.deltaY * 0.01));
    }, { passive: false });
    el.addEventListener('scroll', () => this.drawRuler(), { passive: true });
    let rt = 0;
    window.addEventListener('resize', () => { cancelAnimationFrame(rt); rt = requestAnimationFrame(() => this.render()); });
  }

  // ---------- 描く ----------

  timeAt(clientX) {
    const r = this.el.getBoundingClientRect();
    return Math.max(0, (clientX - r.left + this.el.scrollLeft - this.head) / this.pps);
  }

  render() {
    const app = this.app;
    const p = app.project;
    const sl = this.el.scrollLeft;
    const st = this.el.scrollTop;
    this.head = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--head')) || 92;
    const viewW = this.el.clientWidth;
    // 幅：曲の終わり・再生位置・録音中の終わりより先まで（録音で末端に近づいたら伸ばす）
    // 余白は「末端から 200px 以内なら描き直す」の判定より必ず大きく取る（低い倍率でも描き直しが続かないように）
    const margin = Math.max(20, 400 / this.pps);
    const recEnd = this.rec ? this.rec.end : 0;
    const lenSec = Math.max(projectEnd(p) + margin, (viewW - this.head) / this.pps + 1, (app.playhead || 0) + margin, (this.playheadT || 0) + margin, recEnd + margin);
    this.contentW = Math.ceil(lenSec * this.pps);
    const inner = h('div', { class: 'tl-inner', style: { width: `${this.head + this.contentW}px` } });

    this.rulerCanvas = h('canvas', { 'aria-hidden': 'true' });
    this.rulerEl = h('div', { class: 'ruler', style: { width: `${this.contentW}px` }, 'aria-label': '時間の目盛り（押すと再生位置、長押ししてなぞると範囲を選べます）' }, this.rulerCanvas);
    inner.append(h('div', { class: 'ruler-row' }, h('div', { class: 'corner', text: '' }), this.rulerEl));

    this.rowEls.clear();
    const oldClips = this.clipEls;
    this.clipEls = new Map();
    const used = new Set();
    const anySolo = p.tracks.some((t) => t.solo);
    for (const t of p.tracks) {
      const nameBtn = h('button', { type: 'button', class: 'track-name', 'aria-label': `${t.name}（押すと録音先になります）` },
        h('span', { class: 'dot' }), h('span', { class: 'nm', text: t.name }));
      nameBtn.addEventListener('click', () => app.setRecTrack(t.id));
      const m = h('button', { type: 'button', 'aria-pressed': String(t.mute), 'aria-label': `${t.name} のミュート`, text: 'M' });
      const s = h('button', { type: 'button', 'aria-pressed': String(t.solo), 'aria-label': `${t.name} のソロ`, text: 'S' });
      m.addEventListener('click', () => app.updateTrack(t.id, { mute: !t.mute }));
      s.addEventListener('click', () => app.updateTrack(t.id, { solo: !t.solo }));
      const lane = h('div', { class: 'lane', style: { width: `${this.contentW}px` }, dataset: { track: t.id } });
      const quiet = t.mute || (anySolo && !t.solo);
      for (const c of p.clips) {
        if (c.trackId !== t.id) continue;
        const ce = this.makeClipEl(c, t, quiet, used);
        lane.append(ce);
        this.clipEls.set(c.id, ce);
      }
      const row = h('div', { class: `track-row${app.recTrackId === t.id ? ' rec-target' : ''}`, dataset: { track: t.id } },
        h('div', { class: 'track-head' }, nameBtn, h('div', { class: 'ms' }, m, s)), lane);
      this.rowEls.set(t.id, row);
      inner.append(row);
    }
    void oldClips;
    for (const k of [...this.waveCache.keys()]) if (!used.has(k)) this.waveCache.delete(k);

    const add = h('button', { type: 'button', class: 'add-track' }, h('span', { 'aria-hidden': 'true', style: { fontSize: '18px', lineHeight: '1' }, text: '＋' }), 'トラックを足す');
    add.addEventListener('click', () => app.addTrack());
    inner.append(h('div', { class: 'add-row' }, h('div', { class: 'track-head' }, add)));
    if (!p.clips.length && !app.isRecording) {
      inner.append(h('div', { class: 'empty-hint' },
        h('strong', { text: '赤い丸を押すと録音が始まります' }),
        p.tracks.length > 1 ? '録音先は、トラックの名前を押して選べます。' : '止めると、録った音が「フレーズ」として置かれます。'));
    }

    this.selEl = null;
    this.selHandles = null;
    if (p.selection) {
      const sel = h('div', { class: 'selection', style: { left: `${this.head + p.selection.start * this.pps}px`, width: `${(p.selection.end - p.selection.start) * this.pps}px` } });
      this.selEl = sel;
      // つまみは目盛りの中に置く（目盛りの帯の下に隠れないように）
      this.selHandles = [
        h('div', { class: 'sel-handle l', dataset: { side: 'l' }, role: 'slider', 'aria-label': '範囲の始まり' }),
        h('div', { class: 'sel-handle r', dataset: { side: 'r' }, role: 'slider', 'aria-label': '範囲の終わり' }),
      ];
      this.rulerEl.append(...this.selHandles);
      this.placeSelHandles(p.selection);
      inner.append(sel);
    }
    this.rulerHead = h('div', { class: 'ruler-head' });
    this.rulerEl.append(this.rulerHead);
    this.playheadEl = h('div', { class: `playhead${app.isRecording ? ' rec' : ''}` });
    inner.append(this.playheadEl);
    this.inner = inner;
    this.el.replaceChildren(inner);
    const addRow = inner.querySelector('.add-row');
    const tracksH = addRow ? addRow.offsetTop : inner.scrollHeight;
    this.playheadEl.style.height = `${tracksH}px`;
    if (this.selEl) this.selEl.style.height = `${tracksH}px`;
    this.el.scrollLeft = sl;
    this.el.scrollTop = st;
    this.rendering = true;
    try { this.setPlayhead(app.engine.playing ? this.playheadT || 0 : app.playhead || 0); } finally { this.rendering = false; }
    this.drawRuler();
    if (this.recEl && this.rec) this.attachRec();
  }

  makeClipEl(c, track, quiet, used) {
    const app = this.app;
    const w = Math.max(2, c.duration * this.pps);
    const el = h('div', {
      class: `clip${app.selectedClipId === c.id ? ' selected' : ''}`,
      style: { left: `${c.start * this.pps}px`, width: `${w}px`, background: hexToRgba(track.color, quiet ? 0.08 : 0.2), borderColor: app.selectedClipId === c.id ? '' : hexToRgba(track.color, 0.55) },
      dataset: { clip: c.id },
      role: 'button',
      'aria-label': `フレーズ ${c.start.toFixed(1)} 秒から ${c.duration.toFixed(1)} 秒`,
    });
    el.append(this.waveCanvas(c, track, quiet, w, used));
    if (c.takes.length > 1) {
      const badge = h('button', { type: 'button', class: 'take-badge', dataset: { takes: c.id }, 'aria-label': `テイク ${c.activeTake + 1}/${c.takes.length}（押すと一覧）` },
        h('span', { text: w >= 84 ? `テイク ${c.activeTake + 1}/${c.takes.length}` : `${c.activeTake + 1}/${c.takes.length}` }));
      badge.addEventListener('click', (e) => { e.stopPropagation(); app.openTakes(c.id); });
      el.append(badge);
      el.classList.add('has-takes');
    }
    if (app.selectedClipId === c.id) {
      el.append(h('div', { class: 'clip-handle l', dataset: { side: 'l' }, 'aria-label': '頭を縮める・伸ばす' }));
      el.append(h('div', { class: 'clip-handle r', dataset: { side: 'r' }, 'aria-label': '終わりを縮める・伸ばす' }));
    }
    return el;
  }

  waveCanvas(c, track, quiet, cssW, used) {
    const take = activeTake(c);
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssH = (parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row')) || 96) - 14;
    const drawW = Math.max(1, Math.min(MAX_CANVAS_CSS, Math.round(cssW)));
    const key = `${c.id}|${take.audioId}|${take.offset}|${c.duration}|${drawW}|${track.color}|${quiet}|${dpr}`;
    used.add(key);
    let cv = this.waveCache.get(key);
    if (cv) return cv;
    cv = document.createElement('canvas');
    cv.width = Math.round(drawW * dpr);
    cv.height = Math.round(cssH * dpr);
    const audio = this.app.audios.get(take.audioId);
    const peaks = audio ? this.app.peaksOf(audio) : null;
    if (peaks) {
      const sr = audio.sampleRate;
      const s0 = take.offset * sr;
      const s1 = (take.offset + c.duration) * sr;
      const cols = cv.width;
      const data = peaksForRange(peaks, s0, s1, cols);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = hexToRgba(track.color, quiet ? 0.35 : 0.95);
      const mid = cv.height / 2;
      const amp = cv.height / 2 - 2 * dpr;
      for (let i = 0; i < cols; i++) {
        const mn = data[i * 2];
        const mx = data[i * 2 + 1];
        const y0 = mid - Math.min(1, mx) * amp;
        const y1 = mid - Math.max(-1, mn) * amp;
        ctx.fillRect(i, y0, 1, Math.max(1, y1 - y0));
      }
    }
    this.waveCache.set(key, cv);
    return cv;
  }

  drawRuler() {
    const cv = this.rulerCanvas;
    if (!cv) return;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const w = Math.max(1, this.el.clientWidth - this.head);
    const hgt = cv.parentElement ? cv.parentElement.clientHeight || 44 : 44;
    if (cv.width !== Math.round(w * dpr) || cv.height !== Math.round(hgt * dpr)) {
      cv.width = Math.round(w * dpr);
      cv.height = Math.round(hgt * dpr);
      cv.style.width = `${w}px`;
      cv.style.height = `${hgt}px`;
    }
    const ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, hgt);
    const t0 = this.el.scrollLeft / this.pps;
    const t1 = t0 + w / this.pps;
    const steps = [0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 60, 120];
    const step = steps.find((s) => s * this.pps >= 56) || 120;
    const minor = step / (step >= 1 && step % 5 === 0 ? 5 : step === 2 ? 4 : 2);
    ctx.fillStyle = '#323844';
    for (let t = Math.floor(t0 / minor) * minor; t <= t1; t += minor) {
      const x = Math.round((t - t0) * this.pps) + 0.5;
      ctx.fillRect(x, hgt - 6, 1, 6);
    }
    ctx.font = '11px system-ui, -apple-system, sans-serif';
    ctx.textBaseline = 'top';
    for (let t = Math.floor(t0 / step) * step; t <= t1; t += step) {
      const x = Math.round((t - t0) * this.pps) + 0.5;
      ctx.fillStyle = '#4a5160';
      ctx.fillRect(x, hgt - 12, 1, 12);
      ctx.fillStyle = '#a1a8b4';
      const m = Math.floor(t / 60);
      const s = t - m * 60;
      const label = step < 1 ? `${m}:${s.toFixed(step < 0.5 ? 2 : 1).padStart(step < 0.5 ? 5 : 4, '0')}` : `${m}:${String(Math.round(s)).padStart(2, '0')}`;
      ctx.fillText(label, x + 4, 6);
    }
    const sel = this.app.project.selection;
    if (sel) {
      ctx.fillStyle = 'rgba(108,195,181,.25)';
      ctx.fillRect((sel.start - t0) * this.pps, 0, (sel.end - sel.start) * this.pps, hgt);
    }
  }

  setPlayhead(t, follow = false) {
    this.playheadT = t;
    if (!this.playheadEl) return;
    const x = this.head + t * this.pps;
    this.playheadEl.style.transform = `translateX(${x}px)`;
    if (this.rulerHead) this.rulerHead.style.transform = `translateX(${t * this.pps}px)`;
    // 末端に近づいたら幅を伸ばす（描いている最中は呼び返さない）
    if (!this.rendering && x > this.head + this.contentW - 200) { this.render(); return; }
    if (follow) {
      const left = this.el.scrollLeft + this.head;
      const right = this.el.scrollLeft + this.el.clientWidth - 24;
      if (x > right || x < left) this.el.scrollLeft = Math.max(0, x - this.head - (this.el.clientWidth - this.head) * 0.25);
    }
  }

  /** 範囲だけ描き直す（なぞっている間は軽く） */
  updateSelection() {
    const sel = this.app.project.selection;
    if (!sel || !this.selEl) { this.render(); return; }
    this.selEl.style.left = `${this.head + sel.start * this.pps}px`;
    this.selEl.style.width = `${(sel.end - sel.start) * this.pps}px`;
    this.placeSelHandles(sel);
    this.drawRuler();
  }

  placeSelHandles(sel) {
    if (!this.selHandles) return;
    this.selHandles[0].style.left = `${sel.start * this.pps - 22}px`;
    this.selHandles[1].style.left = `${sel.end * this.pps - 22}px`;
  }

  setRecordingLook(on) {
    if (this.playheadEl) this.playheadEl.classList.toggle('rec', on);
    if (this.rulerHead) this.rulerHead.classList.toggle('rec', on);
  }

  // ---------- 録音中のフレーズ ----------

  recStart(trackId, startSong, color) {
    this.rec = { trackId, start: startSong, end: startSong, color, peaks: null, sr: 48000, offset: 0, lastDraw: 0 };
    this.recEl = h('div', { class: 'clip recording', style: { background: hexToRgba(color, 0.2) } }, h('canvas'));
    this.attachRec();
  }

  attachRec() {
    const row = this.rowEls.get(this.rec.trackId);
    const lane = row && row.querySelector('.lane');
    if (lane) lane.append(this.recEl);
    this.updateRecEl(true);
  }

  recUpdate(endSong, peaks, sampleRate, offsetSec) {
    if (!this.rec) return;
    this.rec.end = endSong;
    this.rec.peaks = peaks;
    this.rec.sr = sampleRate;
    this.rec.offset = offsetSec;
    if (!this.rendering && this.head + endSong * this.pps > this.head + this.contentW - 200) { this.render(); return; }
    this.updateRecEl(false);
  }

  updateRecEl(force) {
    const r = this.rec;
    if (!r || !this.recEl) return;
    const w = Math.max(2, (r.end - r.start) * this.pps);
    this.recEl.style.left = `${r.start * this.pps}px`;
    this.recEl.style.width = `${w}px`;
    const now = performance.now();
    if (!force && now - r.lastDraw < 120) return;
    r.lastDraw = now;
    if (!r.peaks) return;
    const cv = this.recEl.querySelector('canvas');
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const cssW = Math.min(MAX_CANVAS_CSS, Math.round(w));
    const cssH = this.recEl.clientHeight || 80;
    cv.width = Math.max(1, Math.round(cssW * dpr));
    cv.height = Math.max(1, Math.round(cssH * dpr));
    const ctx = cv.getContext('2d');
    const s0 = Math.max(0, r.offset * r.sr);
    const s1 = s0 + (r.end - r.start) * r.sr;
    const data = peaksForRange(r.peaks, s0, s1, cv.width);
    ctx.fillStyle = '#e5484d';
    const mid = cv.height / 2;
    const amp = cv.height / 2 - 2;
    for (let i = 0; i < cv.width; i++) {
      const y0 = mid - Math.min(1, data[i * 2 + 1]) * amp;
      const y1 = mid - Math.max(-1, data[i * 2]) * amp;
      ctx.fillRect(i, y0, 1, Math.max(1, y1 - y0));
    }
  }

  recEnd() {
    if (this.recEl) this.recEl.remove();
    this.recEl = null;
    this.rec = null;
  }

  // ---------- 拡大・縮小 ----------

  zoomAround(clientX, newPps) {
    const pps = Math.min(MAX_PPS, Math.max(MIN_PPS, newPps));
    if (Math.abs(pps - this.pps) < 0.01) return;
    const r = this.el.getBoundingClientRect();
    const t = this.timeAt(clientX);
    this.pps = pps;
    this.render();
    this.el.scrollLeft = Math.max(0, t * pps + this.head - (clientX - r.left));
    this.drawRuler();
  }

  // ---------- 指の操作 ----------

  onTouchStart(e) {
    if (e.touches.length === 2) {
      this.cancelGesture(true);
      const [a, b] = e.touches;
      this.pinch = { d0: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1, pps0: this.pps, raf: 0 };
      e.preventDefault();
    }
  }

  onTouchMove(e) {
    if (this.pinch && e.touches.length === 2) {
      e.preventDefault();
      const [a, b] = e.touches;
      const d = Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY);
      const mid = (a.clientX + b.clientX) / 2;
      const target = this.pinch.pps0 * (d / this.pinch.d0);
      cancelAnimationFrame(this.pinch.raf);
      this.pinch.raf = requestAnimationFrame(() => this.zoomAround(mid, target));
      return;
    }
    if (this.g && this.g.active) e.preventDefault();
  }

  onTouchEnd(e) {
    if (this.pinch && e.touches.length < 2) this.pinch = null;
  }

  onDown(e) {
    if (this.pinch || (e.pointerType === 'mouse' && e.button !== 0)) return;
    if (this.app.isRecording) return;
    const t = e.target;
    const base = { id: e.pointerId, x0: e.clientX, y0: e.clientY, sl0: this.el.scrollLeft, active: false };
    const handle = t.closest('.clip-handle');
    if (handle) {
      const clipEl = handle.closest('.clip');
      const c = this.app.project.clips.find((x) => x.id === clipEl.dataset.clip);
      if (!c) return;
      this.g = { ...base, type: 'trim', side: handle.dataset.side, clip: structuredClone(c), el: clipEl, active: true };
      this.capture(e);
      e.preventDefault();
      return;
    }
    const sh = t.closest('.sel-handle');
    if (sh) {
      this.g = { ...base, type: 'selEdge', side: sh.dataset.side, sel: { ...this.app.project.selection }, active: true };
      this.capture(e);
      e.preventDefault();
      return;
    }
    if (t.closest('.take-badge') || t.closest('button')) return;
    const clipEl = t.closest('.clip');
    if (clipEl && !clipEl.classList.contains('recording') && this.app.cutMode) {
      const c = this.app.project.clips.find((x) => x.id === clipEl.dataset.clip);
      if (!c) return;
      const line = h('div', { class: 'cut-line' }, h('b', { text: '' }));
      clipEl.append(line);
      this.g = { ...base, type: 'cut', clip: structuredClone(c), el: clipEl, line, active: true };
      this.capture(e);
      e.preventDefault();
      this.placeCut(e);
      return;
    }
    if (clipEl && !clipEl.classList.contains('recording')) {
      this.g = { ...base, type: 'clip', clipId: clipEl.dataset.clip, el: clipEl };
      this.g.timer = setTimeout(() => this.activate(), LONG_PRESS);
      return;
    }
    if (t.closest('.ruler')) {
      this.g = { ...base, type: 'ruler' };
      this.g.timer = setTimeout(() => this.activate(), LONG_PRESS);
      return;
    }
    if (t.closest('.lane')) {
      this.g = { ...base, type: 'lane' };
    }
  }

  capture(e) {
    try { this.el.setPointerCapture(e.pointerId); } catch { /* */ }
  }

  activate() {
    const g = this.g;
    if (!g || g.active) return;
    g.active = true;
    if (navigator.vibrate) { try { navigator.vibrate(12); } catch { /* */ } }
    try { this.el.setPointerCapture(g.id); } catch { /* */ }
    if (g.type === 'clip') {
      const c = this.app.project.clips.find((x) => x.id === g.clipId);
      if (!c) { this.g = null; return; }
      g.type = 'move';
      g.clip = structuredClone(c);
      g.el.classList.add('dragging');
      g.trackId = c.trackId;
      g.start = c.start;
    } else if (g.type === 'ruler') {
      g.type = 'range';
      g.anchor = this.timeAt(g.x0);
      this.app.liveSelection({ start: g.anchor, end: g.anchor + MIN_CLIP * 2 });
    }
  }

  /** はさみの線を指の位置に置く。指が上下に大きく外れたら「やめる」（離しても切らない） */
  placeCut(e) {
    const g = this.g;
    const c = g.clip;
    const p = this.app.project;
    const end = clipEnd(c);
    let t = this.timeAt(e.clientX);
    if (p.snap) t = snapToBeat(t, p.bpm);
    // 再生位置（白い線）の近くでは、そこに吸い付く（聞いて止めた所で切れるように）
    const ph = this.app.currentPos();
    if (Math.abs(t - ph) * this.pps < 10) t = ph;
    // 端ぎりぎりで離しても、見えないほど短いかけらができないようにする
    const edge = Math.max(MIN_CLIP * 1.01, 0.05);
    const lo = c.start + edge;
    const hi = end - edge;
    const r = g.el.getBoundingClientRect();
    const away = e.clientY < r.top - 56 || e.clientY > r.bottom + 56;
    g.ok = !away && hi > lo;
    t = Math.min(Math.max(t, lo), Math.max(lo, hi));
    g.t = t;
    const x = (t - c.start) * this.pps;
    g.line.style.left = `${x}px`;
    g.line.classList.toggle('off', !g.ok);
    g.line.classList.toggle('at-edge', x < 40);
    g.line.firstChild.textContent = g.ok ? fmtTime(t, 2) : 'やめる';
  }

  autoscroll(x) {
    const r = this.el.getBoundingClientRect();
    if (x > r.right - 32) this.el.scrollLeft += 10;
    else if (x < r.left + this.head + 24 && this.el.scrollLeft > 0) this.el.scrollLeft -= 10;
  }

  onMove(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    if (!g.active) {
      if (Math.hypot(e.clientX - g.x0, e.clientY - g.y0) > MOVE_TOL) this.cancelGesture();
      return;
    }
    e.preventDefault();
    this.autoscroll(e.clientX);
    if (g.type === 'cut') { this.placeCut(e); return; }
    const dx = (e.clientX - g.x0 + (this.el.scrollLeft - g.sl0)) / this.pps;
    const p = this.app.project;
    const snap = (t) => (p.snap ? snapToBeat(t, p.bpm) : t);
    if (g.type === 'move') {
      for (const [tid, row] of this.rowEls) {
        const rr = row.getBoundingClientRect();
        if (e.clientY >= rr.top && e.clientY < rr.bottom) {
          if (tid !== g.trackId) {
            g.trackId = tid;
            row.querySelector('.lane').append(g.el);
          }
          break;
        }
      }
      // 隣のフレーズには重ねない（端で止まる）
      g.start = freeStart(p, g.clip.id, Math.max(0, snap(g.clip.start + dx)), g.trackId);
      g.el.style.left = `${g.start * this.pps}px`;
    } else if (g.type === 'trim') {
      const c = g.clip;
      const minOff = Math.min(...c.takes.map((t) => t.offset));
      if (g.side === 'l') {
        let ns = snap(c.start + dx);
        ns = Math.max(ns, c.start - minOff, 0, trimBounds(p, c.id).minStart);
        ns = Math.min(ns, clipEnd(c) - MIN_CLIP);
        g.value = ns;
        g.el.style.left = `${ns * this.pps}px`;
        g.el.style.width = `${(clipEnd(c) - ns) * this.pps}px`;
      } else {
        const audio = this.app.audios.get(activeTake(c).audioId);
        const maxEnd = audio ? c.start + audio.pcm.length / audio.sampleRate - c.offset : Infinity;
        let ne = snap(clipEnd(c) + dx);
        ne = Math.min(Math.max(ne, c.start + MIN_CLIP), maxEnd, trimBounds(p, c.id).maxEnd);
        g.value = ne;
        g.el.style.width = `${(ne - c.start) * this.pps}px`;
      }
    } else if (g.type === 'range') {
      this.app.liveSelection({ start: g.anchor, end: this.timeAt(e.clientX) });
    } else if (g.type === 'selEdge') {
      const t = this.timeAt(e.clientX);
      const sel = g.side === 'l' ? { start: t, end: g.sel.end } : { start: g.sel.start, end: t };
      this.app.liveSelection(sel);
    }
  }

  onUp(e) {
    const g = this.g;
    if (!g || e.pointerId !== g.id) return;
    clearTimeout(g.timer);
    this.g = null;
    if (!g.active) {
      if (g.type === 'clip') this.app.tapClip(g.clipId);
      else if (g.type === 'ruler' || g.type === 'lane') {
        this.app.tapTime(this.timeAt(e.clientX), g.type === 'lane');
      }
      return;
    }
    if (g.type === 'cut') {
      g.line.remove();
      if (g.ok) this.app.cutClipAt(g.clip.id, g.t);
      return;
    }
    if (g.type === 'move') {
      g.el.classList.remove('dragging');
      if (Math.abs(g.start - g.clip.start) < 1e-6 && g.trackId === g.clip.trackId) { this.render(); return; }
      this.app.moveClip(g.clip.id, { start: g.start, trackId: g.trackId });
    } else if (g.type === 'trim') {
      if (g.value === undefined) { this.render(); return; }
      this.app.trimClip(g.clip.id, g.side, g.value);
    } else if (g.type === 'range' || g.type === 'selEdge') {
      this.app.commitSelection();
    }
  }

  onCancel() {
    const g = this.g;
    if (!g) return;
    clearTimeout(g.timer);
    this.g = null;
    if (g.active) {
      if (g.type === 'range' || g.type === 'selEdge') this.app.commitSelection();
      else this.render();
    }
  }

  /** 指の操作を取りやめる。範囲をなぞっている途中なら、なぞる前の状態に戻す（取り消しの基準も残さない） */
  cancelGesture(revert = false) {
    const g = this.g;
    if (!g) return;
    clearTimeout(g.timer);
    this.g = null;
    if (!g.active || !revert) return;
    if (g.type === 'range' || g.type === 'selEdge') this.app.cancelLive();
    else this.render();
  }
}
