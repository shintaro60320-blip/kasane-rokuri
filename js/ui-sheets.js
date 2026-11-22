// ui-sheets.js — 下から出るシート（ミキサー・フレーズ操作・テイク・設定など）、ダイアログ、お知らせ。
// 利用者が入れた文字（曲名・トラック名）は必ず textContent / value で入れる（innerHTML に入れない）。

import { TRACK_COLORS, activeTake, clipEnd, LIMITS } from './model.js';

// ---- 小さな部品 ----

export function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === false || v == null) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k === 'style') Object.assign(el.style, v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (k === 'value') el.value = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

// アイコン（決まった文字列だけ。利用者の文字は入らない）
const ICONS = {
  close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M6 6l12 12M18 6 6 18"/></svg>',
  chevDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>',
  chevUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 15 6-6 6 6"/></svg>',
  split: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 3v18"/><path d="M8 8 4 12l4 4M16 8l4 4-4 4"/></svg>',
  copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
  trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/></svg>',
  range: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M5 4v16M19 4v16"/><path d="M8 12h8"/></svg>',
  rec: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="6" fill="#e5484d"/></svg>',
  takes: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M4 7h16M4 12h16M4 17h10"/></svg>',
  play: '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.8v14.4a.8.8 0 0 0 1.2.7l11.4-7.2a.8.8 0 0 0 0-1.4L8.2 4.1A.8.8 0 0 0 7 4.8Z"/></svg>',
  stop: '<svg viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
  plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
  download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 4v11M7 10l5 5 5-5M5 20h14"/></svg>',
  upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 20V9M7 14l5-5 5 5M5 4h14"/></svg>',
  share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3v12M8 7l4-4 4 4"/><path d="M6 12v7a1 1 0 0 0 1 1h10a1 1 0 0 0 1-1v-7"/></svg>',
  gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4 1a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.6a7 7 0 0 0-2 1.2l-2.4-1-2 3.4 2 1.6A7 7 0 0 0 5 12c0 .4 0 .8.1 1.2l-2 1.6 2 3.4 2.4-1a7 7 0 0 0 2 1.2L10 21h4l.5-2.6a7 7 0 0 0 2-1.2l2.4 1 2-3.4-2-1.6c.1-.4.1-.8.1-1.2Z"/></svg>',
  file: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M14 3H6a1 1 0 0 0-1 1v16a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1V8l-5-5Z"/><path d="M14 3v5h5"/></svg>',
  help: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="9"/><path d="M9.5 9.5a2.5 2.5 0 1 1 3.5 2.3c-.6.3-1 .9-1 1.6V14"/><circle cx="12" cy="17.2" r=".6" fill="currentColor"/></svg>',
};

export function icon(name) {
  const t = document.createElement('template');
  t.innerHTML = ICONS[name] || '';
  return t.content.firstElementChild || document.createTextNode('');
}

function button(text, opts = {}) {
  const { onClick, cls = '', ico, disabled, aria } = opts;
  return h('button', { type: 'button', class: `btn ${cls}`.trim(), onClick, disabled: !!disabled, 'aria-label': aria }, ico ? icon(ico) : null, text);
}

function switchRow(label, checked, onToggle, note) {
  const sw = h('button', { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(!!checked), 'aria-label': label });
  sw.addEventListener('click', () => {
    const v = sw.getAttribute('aria-checked') !== 'true';
    sw.setAttribute('aria-checked', String(v));
    onToggle(v);
  });
  return h('div', {}, h('div', { class: 'switch-row' }, h('span', { text: label }), sw), note ? h('p', { class: 'note', text: note }) : null);
}

function seg(options, value, onPick, aria) {
  const wrap = h('div', { class: 'seg', role: 'group', 'aria-label': aria });
  for (const [v, label] of options) {
    const b = h('button', { type: 'button', 'aria-pressed': String(v === value), text: label });
    b.addEventListener('click', () => {
      for (const x of wrap.children) x.setAttribute('aria-pressed', 'false');
      b.setAttribute('aria-pressed', 'true');
      onPick(v);
    });
    wrap.append(b);
  }
  return wrap;
}

/** スライダー。2回押しで resetTo に戻る */
export function slider({ label, min, max, step, value, format, onInput, onChange, resetTo }) {
  const out = h('output', { text: format(value) });
  const input = h('input', { type: 'range', min, max, step, value: String(value), 'aria-label': label });
  input.addEventListener('input', () => { out.textContent = format(+input.value); onInput && onInput(+input.value); });
  input.addEventListener('change', () => onChange && onChange(+input.value));
  if (resetTo !== undefined) {
    let last = 0;
    const reset = () => {
      input.value = String(resetTo);
      out.textContent = format(resetTo);
      onInput && onInput(resetTo);
      onChange && onChange(resetTo);
    };
    input.addEventListener('pointerdown', () => {
      const now = performance.now();
      if (now - last < 320) { reset(); last = 0; } else last = now;
    });
  }
  return { el: h('div', { class: 'slider-row' }, h('label', { text: label }), out, input), input, out };
}

export function fmtTime(sec, digits = 1) {
  const f = 10 ** digits;
  const s = Math.floor(Math.max(0, sec || 0) * f + 1e-6) / f;
  const m = Math.floor(s / 60);
  const r = s - m * 60;
  const whole = Math.floor(r);
  const frac = digits ? '.' + String(Math.min(f - 1, Math.round((r - whole) * f))).padStart(digits, '0') : '';
  return `${m}:${String(whole).padStart(2, '0')}${frac}`;
}

const pct = (v) => `${Math.round(v * 100)}%`;
const panText = (v) => (Math.abs(v) < 0.005 ? '中央' : v < 0 ? `左 ${Math.round(-v * 100)}` : `右 ${Math.round(v * 100)}`);

// ---- シートの土台 ----

let current = null;
// たたんだ状態は、同じ種類のシート（例：フレーズ）を次に開いたときも引き継ぐ。別のフレーズを押しても、たたんだまま作業を続けられる
const foldedKinds = new Set();

/**
 * シートを開く。build(body, sheet) で中身を作る。modal=false なら後ろの画面も触れる（ミキサー・フレーズ用）。
 */
export function openSheet({ id, title, build, modal = false, compact = false, onClose }) {
  closeSheet(true);
  const host = document.getElementById('sheetHost');
  const body = h('div', { class: 'sheet-body' });
  const titleEl = h('h2', { text: title });
  const closeBtn = h('button', { type: 'button', class: 'icon-btn', 'aria-label': '閉じる' }, icon('close'));
  // 後ろを触れるシートは、たたんで見出しだけにできる（フレーズの端を引くときなどに邪魔にならないように）
  const foldBtn = modal ? null : h('button', { type: 'button', class: 'fold-btn' });
  const sheet = h('section', { class: `sheet enter${compact ? ' compact' : ''}`, role: 'dialog', 'aria-label': title },
    h('div', { class: 'sheet-head' }, titleEl, foldBtn, closeBtn), body);
  const kind = String(id || '').split(':')[0];
  let folded = foldedKinds.has(kind);
  const setFold = (on) => {
    folded = on;
    if (on) foldedKinds.add(kind); else foldedKinds.delete(kind);
    sheet.classList.toggle('folded', on);
    foldBtn.replaceChildren(icon(on ? 'chevUp' : 'chevDown'), on ? 'ひらく' : 'たたむ');
    foldBtn.setAttribute('aria-expanded', String(!on));
  };
  if (foldBtn) {
    setFold(folded);
    foldBtn.addEventListener('click', () => setFold(!folded));
    titleEl.addEventListener('click', () => { if (folded) setFold(false); });
  }
  const backdrop = modal ? h('div', { class: 'sheet-backdrop' }) : null;
  const s = {
    id, sheet, body, backdrop, onClose, build,
    setTitle(t) { titleEl.textContent = t; },
    refresh() {
      const top = body.scrollTop;
      body.replaceChildren();
      build(body, s);
      body.scrollTop = top;
    },
  };
  closeBtn.addEventListener('click', () => closeSheet());
  if (backdrop) backdrop.addEventListener('click', () => closeSheet());
  if (backdrop) host.append(backdrop);
  if (!modal) {
    // 後ろを触れるシートは、再生・録音の帯の上に出す（再生しながら音量を変えられる）
    const bar = document.querySelector('.statusbar');
    const top = bar ? bar.getBoundingClientRect().top : window.innerHeight;
    sheet.classList.add('docked');
    sheet.style.bottom = `${Math.max(0, window.innerHeight - top)}px`;
    sheet.style.maxHeight = `${Math.max(180, Math.min(top * 0.62, 520))}px`;
  }
  host.append(sheet);
  build(body, s);
  requestAnimationFrame(() => sheet.classList.remove('enter'));
  current = s;
  return s;
}

export function closeSheet(silent = false) {
  if (!current) return;
  const s = current;
  current = null;
  s.sheet.remove();
  if (s.backdrop) s.backdrop.remove();
  if (s.onClose) s.onClose();
  void silent;
}

export function currentSheet() { return current; }

export function refreshSheet() { if (current) current.refresh(); }

// ---- ダイアログ・お知らせ ----

/** buttons: [{ label, value, cls }]。戻り値 Promise<value>（背景を押すと null） */
export function dialog({ title, message, buttons = [{ label: 'OK', value: true, cls: 'primary' }], content = null }) {
  return new Promise((resolve) => {
    const back = h('div', { class: 'dialog-backdrop' });
    const box = h('div', { class: 'dialog', role: 'alertdialog', 'aria-label': title });
    box.append(h('h2', { text: title }));
    if (message) box.append(h('p', { text: message }));
    if (content) box.append(content);
    const row = h('div', { class: 'row' });
    const finish = (v) => { back.remove(); document.removeEventListener('keydown', onKey); resolve(v); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    for (const b of buttons) row.append(button(b.label, { cls: b.cls || '', onClick: () => finish(typeof b.value === 'function' ? b.value() : b.value) }));
    box.append(row);
    back.append(box);
    back.addEventListener('click', (e) => { if (e.target === back) finish(null); });
    document.addEventListener('keydown', onKey);
    document.body.append(back);
    const first = row.querySelector('.primary, .danger') || row.lastElementChild;
    if (first) first.focus();
  });
}

export async function confirmDialog(title, message, okLabel, danger = false) {
  const v = await dialog({ title, message, buttons: [{ label: 'やめる', value: false }, { label: okLabel, value: true, cls: danger ? 'danger solid' : 'primary' }] });
  return v === true;
}

export async function promptDialog(title, value, okLabel = '決定') {
  const input = h('input', { class: 'text-input', type: 'text', value, maxlength: '60', 'aria-label': title });
  const p = dialog({ title, content: input, buttons: [{ label: 'やめる', value: null }, { label: okLabel, value: () => input.value.trim(), cls: 'primary' }] });
  setTimeout(() => { input.focus(); input.select(); }, 30);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { const b = input.closest('.dialog').querySelector('.primary'); if (b) b.click(); } });
  const v = await p;
  return v || null;
}

export function toast(message, { error = false, action = null, duration = 3200 } = {}) {
  const host = document.getElementById('toastHost');
  const el = h('div', { class: `toast${error ? ' error' : ''}`, role: error ? 'alert' : 'status' }, h('span', { text: message }));
  let timer = 0;
  const hide = () => { clearTimeout(timer); el.classList.add('hide'); setTimeout(() => el.remove(), 220); };
  if (action) el.append(button(action.label, { cls: 'small', onClick: () => { hide(); action.run(); } }));
  host.append(el);
  timer = setTimeout(hide, action ? Math.max(duration, 7000) : duration);
  return hide;
}

// ---- 各シート ----

export function openClipSheet(app, clipId) {
  return openSheet({
    id: 'clip:' + clipId,
    title: 'フレーズ',
    compact: true,
    onClose: () => app.onClipSheetClosed(clipId),
    build(body, s) {
      const p = app.project;
      const c = p.clips.find((x) => x.id === clipId);
      if (!c) { body.append(h('p', { class: 'note', text: 'このフレーズはもうありません。' })); return; }
      const track = p.tracks.find((t) => t.id === c.trackId);
      s.setTitle(`フレーズ（${track ? track.name : ''}）`);
      body.append(
        h('div', { class: 'group' },
          h('p', { class: 'note', text: `${fmtTime(c.start, 2)} から ${fmtTime(clipEnd(c), 2)} まで（${(Math.floor(c.duration * 100 + 1e-6) / 100).toFixed(2)} 秒）。端のつまみを引くと、縮めたり伸ばしたりできます。長押しして動かすと、時間やトラックを変えられます。` }),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            button('再生位置で分ける', { ico: 'split', onClick: () => app.splitClipAtPlayhead(clipId) }),
            button('複製', { ico: 'copy', onClick: () => app.duplicateClip(clipId) }),
            button('削除', { ico: 'trash', cls: 'danger', onClick: () => app.deleteClip(clipId) }),
          ),
        ),
        h('div', { class: 'group' },
          h('h3', { text: '録り直し' }),
          h('div', { class: 'row' },
            button('録り直す', { ico: 'rec', onClick: () => app.retakeClip(clipId) }),
            button(`テイクを選ぶ（${c.takes.length}）`, { ico: 'takes', onClick: () => openTakesSheet(app, clipId) }),
            button('この範囲を選ぶ', { ico: 'range', onClick: () => app.selectClipRange(clipId) }),
          ),
          h('p', { class: 'note', text: '「録り直す」は、このフレーズと同じ位置・長さで録音し、新しいテイクとして足します。前のテイクは残ります。' }),
        ),
        h('div', { class: 'group' },
          h('h3', { text: '少しずらす' }),
          h('div', { class: 'row nowrap' },
            button('−10ms', { cls: 'small grow', onClick: () => app.nudgeClip(clipId, -0.01) }),
            button('−1ms', { cls: 'small grow', onClick: () => app.nudgeClip(clipId, -0.001) }),
            button('+1ms', { cls: 'small grow', onClick: () => app.nudgeClip(clipId, 0.001) }),
            button('+10ms', { cls: 'small grow', onClick: () => app.nudgeClip(clipId, 0.01) }),
          ),
          h('div', { class: 'row', style: { marginTop: '8px' } },
            button('聞きながら合わせる', { onClick: () => openSyncSheet(app, clipId) })),
        ),
      );
      const sl = slider({
        label: 'このフレーズの音量', min: 0, max: LIMITS.clipGain[1], step: 0.01, value: c.gain, format: pct, resetTo: 1,
        onInput: (v) => app.liveClipGain(clipId, v),
        onChange: (v) => app.commitClipGain(clipId, v),
      });
      body.append(h('div', { class: 'group' }, sl.el, h('p', { class: 'note', text: 'つまみを2回押すと 100% に戻ります。' })));
    },
  });
}

export function openTakesSheet(app, clipId) {
  return openSheet({
    id: 'takes:' + clipId,
    title: 'テイク',
    compact: true,
    onClose: () => app.stopPreview(),
    build(body) {
      const c = app.project.clips.find((x) => x.id === clipId);
      if (!c) { body.append(h('p', { class: 'note', text: 'このフレーズはもうありません。' })); return; }
      body.append(h('p', { class: 'note', text: '録り直すたびにテイクが増えます。使うテイクを選んでください。いらないテイクは消せます。' }));
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      c.takes.forEach((t, i) => {
        const a = app.audios.get(t.audioId);
        const using = i === c.activeTake;
        const when = a && a.createdAt ? new Date(a.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) : '';
        const playBtn = h('button', { type: 'button', class: 'btn small', 'aria-label': `テイク ${i + 1} を試し聞き` }, icon('play'));
        playBtn.addEventListener('click', () => {
          if (app.previewing === `${clipId}:${i}`) { app.stopPreview(); return; }
          app.previewTake(clipId, i, () => { playBtn.replaceChildren(icon('play')); });
          for (const b of list.querySelectorAll('[data-play]')) b.replaceChildren(icon('play'));
          playBtn.replaceChildren(icon('stop'));
        });
        playBtn.dataset.play = '1';
        list.append(h('div', { class: `list-item take-row${using ? ' current' : ''}` },
          playBtn,
          h('div', { class: 'main' }, h('div', { class: 'label', text: `テイク ${i + 1}${using ? '（使用中）' : ''}` }), h('div', { class: 'meta', text: when ? `${when} に録音` : '' })),
          using ? null : button('使う', { cls: 'small primary', onClick: () => app.setActiveTake(clipId, i) }),
          c.takes.length > 1 ? h('button', { type: 'button', class: 'btn small danger', 'aria-label': `テイク ${i + 1} を消す`, onClick: () => app.removeTake(clipId, i) }, icon('trash')) : null,
        ));
      });
      body.append(list);
    },
  });
}

export function openMixerSheet(app) {
  return openSheet({
    id: 'mixer',
    title: 'ミキサー',
    build(body) {
      const p = app.project;
      if (!p.tracks.length) body.append(h('p', { class: 'note', text: 'まだトラックがありません。赤い丸を押すと、最初のトラックができます。' }));
      for (const t of p.tracks) {
        const name = h('input', { class: 'text-input', type: 'text', value: t.name, maxlength: '40', 'aria-label': 'トラックの名前' });
        name.addEventListener('change', () => app.updateTrack(t.id, { name: name.value.trim() || t.name }));
        const m = h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(t.mute), 'aria-label': 'ミュート', text: 'M' });
        const so = h('button', { type: 'button', class: 'btn small', 'aria-pressed': String(t.solo), 'aria-label': 'ソロ', text: 'S' });
        m.classList.toggle('primary', t.mute);
        so.classList.toggle('primary', t.solo);
        m.addEventListener('click', () => app.updateTrack(t.id, { mute: !t.mute }));
        so.addEventListener('click', () => app.updateTrack(t.id, { solo: !t.solo }));
        const vol = slider({
          label: '音量', min: 0, max: LIMITS.trackGain[1], step: 0.01, value: t.gain, format: pct, resetTo: 1,
          onInput: (v) => app.liveTrack(t.id, { gain: v }), onChange: (v) => app.commitTrack(t.id, { gain: v }),
        });
        const pan = slider({
          label: '左右の位置', min: -1, max: 1, step: 0.01, value: t.pan, format: panText, resetTo: 0,
          onInput: (v) => app.liveTrack(t.id, { pan: v }), onChange: (v) => app.commitTrack(t.id, { pan: v }),
        });
        const sw = h('div', { class: 'swatches', role: 'group', 'aria-label': '色' });
        for (const col of TRACK_COLORS) {
          const b = h('button', { type: 'button', class: 'swatch', 'aria-pressed': String(col === t.color), 'aria-label': '色を選ぶ' }, h('span', { style: { background: col } }));
          b.addEventListener('click', () => app.updateTrack(t.id, { color: col }));
          sw.append(b);
        }
        body.append(h('div', { class: 'mix-track' },
          h('div', { class: 'mix-top' }, name, m, so),
          vol.el,
          pan.el,
          h('div', { class: 'pan-labels' }, h('span', { text: '左' }), h('span', { text: '右' })),
          h('div', { class: 'row', style: { justifyContent: 'space-between', marginTop: '4px' } }, sw,
            button('トラックを削除', { ico: 'trash', cls: 'small danger', aria: `${t.name} を削除`, onClick: () => app.removeTrack(t.id) })),
        ));
      }
      const master = slider({
        label: '全体の音量', min: 0, max: LIMITS.masterGain[1], step: 0.01, value: p.masterGain, format: pct, resetTo: 1,
        onInput: (v) => app.liveMaster(v), onChange: (v) => app.commitMaster(v),
      });
      body.append(h('div', { class: 'group', style: { borderTop: '1px solid var(--line)', marginTop: '6px' } }, master.el,
        h('p', { class: 'note', text: 'M＝その音を消す、S＝その音だけ鳴らす。音量のつまみは2回押すと 100% に戻ります。' })));
    },
  });
}

/** トラックを消すシート（タイムラインの「トラックを消す」から開く） */
export function openTrackListSheet(app) {
  return openSheet({
    id: 'tracks',
    title: 'トラックを消す',
    compact: true,
    build(body) {
      const p = app.project;
      if (!p.tracks.length) { body.append(h('p', { class: 'note', text: 'トラックがありません。' })); return; }
      body.append(h('p', { class: 'note', text: '消したいトラックの「削除」を押してください。間違えたときは、上の取り消し（左向きの矢印）で戻せます。' }));
      const list = h('div', { class: 'list', style: { marginTop: '10px' } });
      for (const t of p.tracks) {
        const n = p.clips.filter((c) => c.trackId === t.id).length;
        list.append(h('div', { class: 'list-item' },
          h('span', { class: 'track-swatch', style: { background: t.color } }),
          h('div', { class: 'main' }, h('div', { class: 'label', text: t.name }), h('div', { class: 'meta', text: n ? `フレーズ ${n} 個` : 'フレーズなし' })),
          button('削除', { ico: 'trash', cls: 'small danger', aria: `${t.name} を削除`, onClick: () => app.removeTrack(t.id) }),
        ));
      }
      body.append(list);
    },
  });
}

/**
 * 重ねた音を合わせるシート。押すたびにフレーズを少し動かし、少し前から流して聞かせる。
 * 動かした量は「次の録音から」の補正にも足せる（同じ端末・同じイヤホンなら、次からは合った位置に入る）。
 */
export function openSyncSheet(app, clipId) {
  app.beginSync(clipId);
  return openSheet({
    id: 'sync:' + clipId,
    title: '重ねた音を合わせる',
    compact: true,
    onClose: () => app.endSync(),
    build(body, s) {
      const st = app.syncState;
      const c = app.project.clips.find((x) => x.id === clipId);
      if (!st || !c) { body.append(h('p', { class: 'note', text: 'このフレーズはもうありません。' })); return; }
      const ms = Math.round(st.shift * 1000);
      const now = ms === 0 ? 'まだ動かしていません' : ms < 0 ? `${-ms} ms 前へ動かしました` : `${ms} ms 後ろへ動かしました`;
      const step = (d) => button(d < 0 ? `前へ ${-d * 1000}` : `後ろへ ${d * 1000}`, { cls: 'small grow', onClick: () => { app.syncNudge(d); s.refresh(); } });
      const listen = button(app.engine.playing ? '止める' : 'もう一度聞く', { ico: app.engine.playing ? 'stop' : 'play', onClick: () => { app.syncListen(); s.refresh(); } });
      const apply = h('input', { type: 'checkbox', id: 'syncApply' });
      apply.checked = st.applyNext;
      apply.addEventListener('change', () => { st.applyNext = apply.checked; });
      const result = h('p', { class: 'note', 'aria-live': 'polite' });
      const measure = button('自動で測る', { onClick: async () => {
        measure.disabled = true;
        result.textContent = '測っています…（スピーカーから音が出ます）';
        const r = await app.measureLatency();
        measure.disabled = false;
        result.textContent = r.ok ? `測れました。次の録音から ${Math.round(r.correctionMs)} ms で合わせます。` : r.reason;
      } });
      body.append(
        h('div', { class: 'group' },
          h('p', { class: 'note', text: '重ねた音が遅れて聞こえるなら「前へ」、早く聞こえるなら「後ろへ」を押します。押すたびに、少し前から流して聞かせます。数字の単位は ms（1000分の1秒）です。' }),
          h('p', { class: 'sync-now', text: now }),
          h('div', { class: 'row nowrap' }, step(-0.02), step(-0.005), step(0.005), step(0.02)),
          h('div', { class: 'row', style: { marginTop: '10px' } }, listen),
        ),
        h('div', { class: 'group' },
          h('label', { class: 'check-row', for: 'syncApply' }, apply, h('span', { text: '次からの録音も、同じだけ合わせる' })),
          h('div', { class: 'row', style: { marginTop: '10px' } },
            button('これで決める', { cls: 'primary grow', onClick: () => app.finishSync(true) }),
            button('元に戻す', { cls: 'grow', onClick: () => app.finishSync(false) })),
        ),
        h('div', { class: 'group' },
          h('h3', { text: '端末のずれを測る' }),
          h('p', { class: 'note', text: 'イヤホンを外して、静かな所で押してください。スピーカーから短い音を鳴らしてマイクで拾い、次の録音からのずれを合わせます。Bluetooth のイヤホンは音が大きく遅れるので、線のあるイヤホンの方がずれません。' }),
          h('div', { class: 'row' }, measure), result,
        ),
      );
    },
  });
}

export function openTempoSheet(app) {
  return openSheet({
    id: 'tempo',
    title: 'テンポとメトロノーム',
    compact: true,
    build(body) {
      const p = app.project;
      const bpm = slider({
        label: 'テンポ（1分間の拍の数）', min: LIMITS.bpm[0], max: LIMITS.bpm[1], step: 1, value: p.bpm, format: (v) => String(Math.round(v)), resetTo: 120,
        onInput: (v) => app.liveFields({ bpm: v }), onChange: (v) => app.commitFields({ bpm: v }),
      });
      body.append(
        h('div', { class: 'group' }, switchRow('メトロノーム', p.metronomeOn, (v) => app.commitFields({ metronomeOn: v }), 'イヤホンを付けていれば、メトロノームの音は録音に入りません。')),
        h('div', { class: 'group' }, bpm.el,
          h('div', { class: 'row nowrap' },
            button('−1', { cls: 'small grow', onClick: () => app.commitFields({ bpm: app.project.bpm - 1 }) }),
            button('+1', { cls: 'small grow', onClick: () => app.commitFields({ bpm: app.project.bpm + 1 }) }))),
        h('div', { class: 'group' }, h('h3', { text: '拍子' }), seg([[2, '2拍子'], [3, '3拍子'], [4, '4拍子'], [6, '6拍子']], p.beatsPerBar, (v) => app.commitFields({ beatsPerBar: v }), '拍子')),
        h('div', { class: 'group' }, h('h3', { text: '録音の前のカウント' }), seg([[0, 'なし'], [1, '1小節'], [2, '2小節']], p.countInBars, (v) => app.commitFields({ countInBars: v }), 'カウント'),
          h('p', { class: 'note', text: 'メトロノームが切のときはカウントしません。' })),
        h('div', { class: 'group' }, switchRow('拍に合わせる', p.snap, (v) => app.commitFields({ snap: v }), 'フレーズを動かすとき、拍の位置に吸い付きます。')),
      );
    },
  });
}

export function openSongsSheet(app) {
  return openSheet({
    id: 'songs',
    title: '曲の一覧',
    modal: true,
    build(body, s) {
      body.append(h('div', { class: 'row', style: { marginBottom: '12px' } },
        button('新しい曲', { ico: 'plus', cls: 'primary', onClick: () => app.newProject() }),
        button('保存ファイルを読み込む', { ico: 'upload', onClick: () => app.pickBackup() })));
      const list = h('div', { class: 'list' });
      body.append(list);
      app.listProjects().then((projects) => {
        list.replaceChildren();
        for (const p of projects) {
          const isCur = p.id === app.project.id;
          const open = h('button', { type: 'button', class: 'open' },
            h('div', { class: 'title', text: p.name }),
            h('div', { class: 'meta', text: `${isCur ? '開いている曲 ・ ' : ''}${new Date(p.updatedAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })} ・ トラック ${p.tracks.length}` }));
          open.addEventListener('click', () => app.openProject(p.id));
          list.append(h('div', { class: `list-item${isCur ? ' current' : ''}` }, open,
            h('button', { type: 'button', class: 'btn small', 'aria-label': `${p.name} を複製` , onClick: () => app.duplicateProject(p.id).then(() => s.refresh()) }, icon('copy')),
            h('button', { type: 'button', class: 'btn small danger', 'aria-label': `${p.name} を削除`, onClick: () => app.deleteProject(p.id).then(() => s.refresh()) }, icon('trash'))));
        }
      });
    },
  });
}

export function openMoreSheet(app) {
  return openSheet({
    id: 'more',
    title: 'その他',
    modal: true,
    build(body) {
      if (app.unsavedAudio.size) {
        const list = h('div', { class: 'list' });
        for (const u of app.unsavedAudio.values()) {
          const sec = u.audio.pcm.length / u.audio.sampleRate;
          list.append(h('div', { class: 'list-item' },
            h('div', { class: 'main' }, h('div', { class: 'title', text: `録音（${sec.toFixed(1)} 秒）` }),
              h('div', { class: 'meta', text: new Date(u.audio.createdAt).toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' }) + ' に録音' + (u.exported ? '・書き出し済み（このアプリの中にはまだ保存されていません）' : '') })),
            button('書き出す', { cls: 'small', onClick: () => app.exportUnsaved(u.audio.id) })));
        }
        body.append(h('div', { class: 'group' },
          h('h3', { text: `保存できていない録音（${app.unsavedAudio.size}）` }),
          h('p', { class: 'note warn', text: '画面を閉じると消えます。空きを作ってからもう一度保存するか、書き出してください。' }),
          button('もう一度保存する', { cls: 'primary block', onClick: () => app.retryUnsaved() }),
          h('div', { style: { height: '8px' } }),
          list));
      }
      body.append(
        h('div', { class: 'group' },
          h('h3', { text: '書き出し' }),
          h('div', { class: 'list' },
            button('一曲に書き出す（WAV）', { ico: 'download', cls: 'block', onClick: () => app.openExport() }),
            button('曲を丸ごと保存（あとで読み込めます）', { ico: 'file', cls: 'block', onClick: () => app.saveBackup() })),
          h('p', { class: 'note', text: 'iPhone の Safari は、長く使わないと保存した録音を消すことがあります。大事な曲は書き出しておいてください。' })),
        h('div', { class: 'group' },
          h('h3', { text: '読み込み' }),
          button('音源を読み込む（カラオケ音源など）', { ico: 'upload', cls: 'block', onClick: () => app.pickAudio() })),
      );
      const shelved = app.project.shelved || [];
      if (shelved.length) {
        const list = h('div', { class: 'list' });
        for (const c of shelved) {
          const t = app.project.tracks.find((x) => x.id === c.trackId);
          list.append(h('div', { class: 'list-item' },
            h('div', { class: 'main' },
              h('div', { class: 'title', text: `${t ? t.name : '消したトラック'}・${fmtTime(c.start, 1)} から` }),
              h('div', { class: 'meta', text: `${c.duration.toFixed(1)} 秒${c.takes.length > 1 ? `・テイク ${c.takes.length}` : ''}` })),
            button('戻す', { cls: 'small primary', onClick: () => app.restoreShelved(c.id) })));
        }
        body.append(h('div', { class: 'group' },
          h('h3', { text: `録り直しで隠れたフレーズ（${shelved.length}）` }),
          h('p', { class: 'note', text: '新しい録音ですっぽり隠れたフレーズです。鳴りませんが、録音は残っています。「戻す」を押すと、新しいトラックの元の位置に戻ります。' }),
          list));
      }
      body.append(
        h('div', { class: 'group' },
          h('div', { class: 'list' },
            button('設定（ずれの補正・助走・保存）', { ico: 'gear', cls: 'block', onClick: () => openSettingsSheet(app) }),
            button('使い方', { ico: 'help', cls: 'block', onClick: () => openHelpSheet() }))),
      );
    },
  });
}

/**
 * ファイルを作ってから「端末に保存」「共有」を選ぶシート（iPhone は共有を操作の直後に呼ぶ必要があるため、作るのと分ける）。
 * make() → { blob, filename, desc } | null。onDone(結果) は保存・共有が済んだときに呼ぶ。
 */
export function openFileSheet(app, { title, note, make, makeLabel = 'ファイルを作る', emptyText = '作れるものがありません。', onDone = null }) {
  return openSheet({
    id: 'file',
    title,
    modal: true,
    build(body) {
      const status = h('p', { class: 'note', text: note });
      const result = h('p', { class: 'note', role: 'status' });
      const actions = h('div', { class: 'row', style: { marginTop: '12px' } });
      const go = button(makeLabel, { cls: 'primary', ico: 'download', onClick: async () => {
        go.disabled = true;
        status.textContent = '作っています…';
        try {
          const r = await make();
          if (!r) { status.textContent = emptyText; go.disabled = false; return; }
          status.textContent = `できました（${r.desc}）。保存のしかたを選んでください。`;
          const save = button('端末に保存', { ico: 'download', cls: 'primary', onClick: () => {
            app.downloadBlob(r.blob, r.filename);
            result.className = 'note';
            result.textContent = `「${r.filename}」の保存を始めました。ダウンロードの一覧に入っているか確かめてください。`;
            if (onDone) onDone('downloaded');
          } });
          const share = app.canShare(r.blob, r.filename) ? button('共有', { ico: 'share', onClick: async () => {
            const v = await app.shareBlob(r.blob, r.filename);
            result.className = v === 'failed' ? 'note warn' : 'note';
            result.textContent = v === 'shared' ? '共有しました。' : v === 'cancelled' ? '共有をやめました。ファイルはまだ保存されていません。' : '共有できませんでした。「端末に保存」を使ってください。';
            if (v === 'shared' && onDone) onDone('shared');
          } }) : null;
          actions.replaceChildren(save, share);
        } catch (e) {
          status.className = 'note warn';
          status.textContent = `作れませんでした：${e.message || e}`;
          go.disabled = false;
        }
      } });
      actions.append(go);
      body.append(status, actions, result, h('p', { class: 'note', text: '大事な曲は、作ったファイルを別の場所にも残しておくと安心です。' }));
    },
  });
}

export function openSettingsSheet(app) {
  return openSheet({
    id: 'settings',
    title: '設定',
    modal: true,
    build(body, s) {
      const st = app.settings;
      const lat = slider({
        label: 'ずれの補正（重ねた音を前へずらす量）', min: LIMITS.latencyMs[0], max: LIMITS.latencyMs[1], step: 1, value: st.latencyMs, format: (v) => `${Math.round(v)} ms`,
        onInput: () => {}, onChange: (v) => { app.setSetting('latencyMs', v); s.refresh(); },
      });
      const result = h('p', { class: 'note' });
      const measure = button('自動で測る', { onClick: async () => {
        measure.disabled = true;
        result.className = 'note';
        result.textContent = '測っています…（数回、短い音が鳴ります）';
        const r = await app.measureLatency();
        measure.disabled = false;
        if (r.ok) { result.textContent = `測れました：${Math.round(r.correctionMs)} ms に合わせました。`; s.refresh(); }
        else { result.className = 'note warn'; result.textContent = `${r.reason}。補正の値は変えていません。`; }
      } });
      body.append(h('div', { class: 'group' },
        h('h3', { text: '音のずれ' }),
        lat.el,
        h('div', { class: 'row nowrap' },
          button('−10', { cls: 'small grow', onClick: () => { app.setSetting('latencyMs', app.settings.latencyMs - 10); s.refresh(); } }),
          button('−1', { cls: 'small grow', onClick: () => { app.setSetting('latencyMs', app.settings.latencyMs - 1); s.refresh(); } }),
          button('+1', { cls: 'small grow', onClick: () => { app.setSetting('latencyMs', app.settings.latencyMs + 1); s.refresh(); } }),
          button('+10', { cls: 'small grow', onClick: () => { app.setSetting('latencyMs', app.settings.latencyMs + 10); s.refresh(); } })),
        h('p', { class: 'note', text: '重ねて録った音が後ろにずれて聞こえるときは、値を大きくします。前にずれて聞こえるときは小さくします。この値はこの端末に保存され、次の録音から効きます。' }),
        h('div', { class: 'row', style: { marginTop: '8px' } }, measure),
        h('p', { class: 'note', text: '自動で測るときは、イヤホンを外して、静かな場所で行ってください。スピーカーの音をマイクで拾って測ります。' }),
        result));
      body.append(h('div', { class: 'group' },
        h('h3', { text: '範囲の録り直しの助走' }),
        seg([[1, '1秒'], [2, '2秒'], [3, '3秒'], [4, '4秒']], st.preroll, (v) => app.setSetting('preroll', v), '助走の秒数'),
        h('p', { class: 'note', text: '範囲の何秒前から再生を始めるかです。' })));
      const mic = app.micStatus();
      body.append(h('div', { class: 'group' },
        h('h3', { text: 'マイク' }),
        h('p', { class: mic.warn ? 'note warn' : 'note', text: mic.text })));
      const storage = h('p', { class: 'note', text: '保存の状態を調べています…', style: { whiteSpace: 'pre-line' } });
      app.storageInfo().then((t) => { storage.textContent = t; });
      body.append(h('div', { class: 'group' }, h('h3', { text: '保存' }), storage));
      body.append(h('div', { class: 'group' },
        h('h3', { text: 'ホーム画面に置く' }),
        h('p', { class: 'note', text: 'iPhone：Safari の下の共有ボタン → 「ホーム画面に追加」。\nAndroid：Chrome の右上のメニュー → 「ホーム画面に追加」または「アプリをインストール」。\nホーム画面から開くと、保存した録音が消されにくくなります。' })));
      body.lastElementChild.querySelector('p').style.whiteSpace = 'pre-line';
      body.append(h('p', { class: 'note', text: `かさね録り ${app.version}` }));
    },
  });
}

export function openHelpSheet() {
  return openSheet({
    id: 'help',
    title: '使い方',
    modal: true,
    build(body) {
      const items = [
        ['録る', '赤い丸を押すと録音が始まります。もう一度押すと止まり、録った音が「フレーズ」として置かれます。保存は自動です。'],
        ['重ねる（ハモリ）', '「トラックを足す」を押してから赤い丸を押します。前の音を聞きながら録れます。イヤホンを付けると、前の音が録音に入りません。'],
        ['重ねた音のずれを合わせる', '重ねて録ると「ずれを合わせる」が出ます。押すと、「前へ」「後ろへ」でフレーズを少しずつ動かしながら、少し前から聞けます。「これで決める」を押すと、次からの録音も同じだけ合わせて置きます。あとからでも、フレーズを押して「聞きながら合わせる」で開けます。'],
        ['再生位置を動かす', '上の目盛りを押すと、そこへ飛びます。目盛りを横になぞると、時間を送れます。三角の印をつまんで動かすと、離した所へ行きます。左上の「はじめ」を押すと曲の頭に戻ります。'],
        ['トラックを消す', 'トラックの下の「トラックを消す」を押して、消したいトラックの「削除」を押します。間違えたら取り消しで戻せます。'],
        ['一部分だけ録り直す', '上の目盛りを長押ししたまま横になぞると、範囲が選べます。その状態で赤い丸を押すと、範囲の少し前から再生が始まり、範囲の中だけが録り直されます。'],
        ['テイク', 'フレーズを押して「録り直す」を選ぶと、同じ位置にもう一度録れます。前の録音は「テイク」として残り、あとから選び直せます。'],
        ['切る', '下の「はさみ」を押してから、フレーズの切りたい所に指を置きます。左右に動かすと黄色い線が付いてきて、指を離した所で切れます。指を上下に大きく外して離すと、切らずにやめられます。2本指で広げると、細かい位置で切れます。'],
        ['フレーズを動かす', 'フレーズを長押しして、そのまま動かします。左右で時間、上下で別のトラックに移せます。'],
        ['端を縮める', 'フレーズを押すと、両端に白いつまみが出ます。引くと、波形はそのままで端から切り取られます。下に出たメニューが邪魔なときは、右上の「たたむ」で小さくできます。'],
        ['音量', '下の「ミキサー」で、トラックごとの音量・左右の位置・ミュート（M）・ソロ（S）を変えられます。'],
        ['取り消し', '上の矢印で、直前の操作を取り消せます（50回まで）。'],
        ['書き出し', '右上の「…」→「一曲に書き出す」で、WAV ファイルにして保存や共有ができます。'],
        ['拡大・縮小', '2本の指でつまむと、時間の幅を変えられます。'],
      ];
      for (const [t, d] of items) body.append(h('div', { class: 'group' }, h('h3', { text: t }), h('p', { class: 'note', text: d })));
    },
  });
}

export { activeTake };
