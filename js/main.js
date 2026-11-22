// main.js — 起動と画面のつなぎ。曲の状態はここが持ち、編集はすべて model.js の関数を通す。

import * as M from './model.js';
import * as H from './history.js';
import * as store from './store.js';
import { Engine } from './engine.js';
import { Timeline } from './ui-timeline.js';
import { computePeaks, PeakBuilder } from './peaks.js';
import { mixProject } from './mix.js';
import { findLag, envelopeOf } from './align.js';
import { encodeWav16 } from './wav.js';
import { packBackup, unpackBackup } from './backup.js';
import {
  openClipSheet, openTakesSheet, openMixerSheet, openTrackListSheet, openSyncSheet, openTempoSheet, openSongsSheet, openMoreSheet, openFileSheet,
  closeSheet, currentSheet, refreshSheet, dialog, confirmDialog, promptDialog, toast, fmtTime,
} from './ui-sheets.js';

export const VERSION = 'v1.8.0';
const MAX_REC_SEC = 600;
const PENDING_FLUSH_MS = 2000;          // 録音中、断片を保存する間隔
const WAIT_MSG = '保存が終わるまでお待ちください';
const $ = (id) => document.getElementById(id);

class App {
  constructor() {
    this.version = VERSION;
    this.testMode = new URLSearchParams(location.search).get('test') === '1';
    this.prefix = this.testMode ? 'kasane-test' : 'kasane';
    store.setDBName(this.prefix);
    this.engine = new Engine({ testMode: this.testMode });
    this.project = M.createProject();
    this.history = H.createHistory();
    this.audios = new Map();
    this.peaks = new Map();
    /** 保存できていない録音（曲を切り替えても持ち続ける）：audioId → { audio, projectId, sid } */
    this.unsavedAudio = new Map();
    this.playhead = 0;
    this.selectedClipId = null;
    this.recTrackId = null;
    this.isRecording = false;
    this.cutMode = false;
    /** 録音の準備〜録音〜停止〜保存完了までの「作業中」。この間は曲の切り替えや次の録音をしない */
    this.session = null;
    this.liveBase = null;
    this.saveTimer = 0;
    this.saveChain = Promise.resolve(true);
    this.editGen = 0;   // 編集の世代（編集のたびに増える）
    this.savedGen = 0;  // 保存できた世代
    /** この画面だけが開いているか：'locked'（確かめた）| 'channel'（ほかの画面の返事がない）| 'unknown'（確かめられない） */
    this.instance = 'unknown';
    this.maxRecSec = MAX_REC_SEC;
    this.testHooks = { failSaves: 0, failPending: 0, ignoreHide: false };
    this.settings = this.loadSettings();
    this.timeline = new Timeline($('timeline'), this);
  }

  // ---------- 設定（この端末だけ） ----------
  loadSettings() {
    const def = { latencyMs: 0, preroll: 2, micNoticeShown: false, overdubTipShown: false, lastProject: null };
    try {
      const raw = localStorage.getItem(`${this.prefix}.settings`);
      return raw ? { ...def, ...JSON.parse(raw) } : def;
    } catch { return def; }
  }

  setSetting(k, v) {
    if (k === 'latencyMs') v = Math.max(M.LIMITS.latencyMs[0], Math.min(M.LIMITS.latencyMs[1], Math.round(v)));
    this.settings = { ...this.settings, [k]: v };
    try { localStorage.setItem(`${this.prefix}.settings`, JSON.stringify(this.settings)); } catch { /* 保存できなくても動く */ }
  }

  // ---------- 起動 ----------
  async init() {
    this.bindUI();
    if (this.testMode) $('testBadge').hidden = false;
    // 同時に開けるのは1画面だけ。保存の場所に触る前に確かめる
    this.instance = await this.acquireInstance();
    while (this.instance === 'busy') {
      await this.showBusyScreen();
      this.instance = await this.acquireInstance();
    }
    this.hideBusyScreen();
    try {
      if (!this.testMode) store.requestPersist();
      const all = (await store.loadAllProjects()).map(M.normalizeProject);
      let p = all.find((x) => x.id === this.settings.lastProject) || all.sort((a, b) => b.updatedAt - a.updatedAt)[0];
      if (!p) {
        p = M.createProject({ name: '最初の曲' });
        await store.saveProject(p);
      }
      await this.loadProjectData(p);
    } catch (e) {
      this.render();
      toast(`保存の場所を開けませんでした：${e.message || e}。この画面では録音を保存できません。`, { error: true, duration: 8000 });
    }
    this.loop();
    document.addEventListener('visibilitychange', () => { if (document.hidden) this.onHide(); });
    window.addEventListener('pagehide', () => this.onHide());
    window.addEventListener('beforeunload', (e) => {
      if (this.session || this.unsavedAudio.size) { e.preventDefault(); e.returnValue = ''; }
    });
    document.addEventListener('pointerdown', () => { this.engine.ensure().catch(() => {}); }, { once: true, capture: true });
    this.registerSW();
    if (this.testMode) {
      const m = await import('./testkit.js');
      m.install(this);
    }
    try { await this.offerRecovery(); } catch { /* 戻せなくても起動は続ける */ }
    this.sweepSafely().catch(() => {});
  }

  /**
   * この画面だけが開いている印を取る。Web Locks の排他ロックを閉じるまで持ち続ける。
   * Web Locks が無いときは BroadcastChannel で先客に聞く。戻り値：'locked' | 'channel' | 'unknown' | 'busy'
   */
  acquireInstance() {
    const name = `${this.prefix}-app`;
    if (navigator.locks && navigator.locks.request) {
      return new Promise((resolve) => {
        navigator.locks.request(name, { mode: 'exclusive', ifAvailable: true }, (lock) => {
          if (!lock) { resolve('busy'); return undefined; }
          resolve('locked');
          return new Promise((release) => { this.releaseInstance = release; });
        }).catch(() => resolve('unknown'));
      });
    }
    if ('BroadcastChannel' in globalThis) {
      return new Promise((resolve) => {
        if (!this.channel) {
          this.channel = new BroadcastChannel(name);
          this.channel.onmessage = (e) => {
            if (e.data === 'who' && this.instance !== 'busy' && this.instance !== 'unknown-wait') this.channel.postMessage('here');
            else if (e.data === 'here' && this.channelWait) this.channelWait('busy');
          };
        }
        this.instance = 'unknown-wait';
        this.channelWait = (v) => { this.channelWait = null; resolve(v); };
        this.channel.postMessage('who');
        setTimeout(() => { if (this.channelWait) this.channelWait('channel'); }, 400);
      });
    }
    return Promise.resolve('unknown');
  }

  showBusyScreen() {
    return new Promise((resolve) => {
      let el = document.getElementById('busyScreen');
      if (!el) {
        el = document.createElement('div');
        el.id = 'busyScreen';
        el.className = 'busy-screen';
        el.setAttribute('role', 'alertdialog');
        const box = document.createElement('div');
        box.className = 'dialog';
        const h = document.createElement('h2');
        h.textContent = '別の画面で開いています';
        const p = document.createElement('p');
        p.textContent = 'かさね録りは、同時に1つの画面でしか使えません（録音を守るためです）。そちらを使うか、そちらを閉じてから「もう一度開く」を押してください。';
        const row = document.createElement('div');
        row.className = 'row';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'btn primary';
        b.textContent = 'もう一度開く';
        row.append(b);
        box.append(h, p, row);
        el.append(box);
        document.body.append(el);
      }
      el.hidden = false;
      const b = el.querySelector('button');
      b.onclick = () => resolve();
    });
  }

  hideBusyScreen() {
    const el = document.getElementById('busyScreen');
    if (el) el.hidden = true;
  }

  /**
   * 使われていない録音の掃除。この画面だけが開いていると確かめられたとき（排他ロックを持っているとき）だけ行う。
   * 確かめられない環境では消さない側に倒す。戻り値：'swept' | 'skipped'
   */
  async sweepSafely() {
    if (this.instance !== 'locked') { this.lastSweep = 'skipped'; return 'skipped'; }
    const all = (await store.loadAllProjects()).map(M.normalizeProject);
    const refs = M.referencedAudioIds(all);
    for (const id of M.referencedAudioIds([this.project])) refs.add(id);
    for (const id of H.historyAudioIds(this.history)) refs.add(id);
    for (const id of this.unsavedAudio.keys()) refs.add(id);
    await store.sweepAudio(refs);
    this.lastSweep = 'swept';
    return 'swept';
  }

  registerSW() {
    if (!('serviceWorker' in navigator)) return;
    const okHost = location.protocol === 'https:' || ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    if (!okHost) return;
    navigator.serviceWorker.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'version-ready' && e.data.version !== VERSION) {
        toast('新しい版があります。このアプリの画面をすべて閉じてから開き直すと、更新されます', { duration: 9000 });
      }
    });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(() => { /* なくても動く */ });
  }

  async loadProjectData(p) {
    this.engine.stop();
    this.project = p;
    this.history = H.createHistory();
    this.liveBase = null;
    this.selectedClipId = null;
    this.playhead = 0;
    this.recTrackId = p.tracks[0] ? p.tracks[0].id : null;
    this.audios = new Map();
    this.peaks = new Map();
    this.engine.releaseBuffers(new Set());
    let missing = 0;
    for (const id of M.referencedAudioIds([p])) {
      const u = this.unsavedAudio.get(id);
      if (u) { this.audios.set(id, u.audio); continue; }
      try {
        const a = await store.loadAudio(id);
        if (a) this.audios.set(id, a); else missing++;
      } catch { missing++; }
    }
    this.engine.setMaster(p.masterGain);
    this.editGen = 0;
    this.savedGen = 0;
    this.setSetting('lastProject', p.id);
    this.render();
    if (missing) toast(`見つからない録音が ${missing} 件あります（保存が消された可能性があります）`, { error: true, duration: 7000 });
  }

  bindUI() {
    $('btnPlay').addEventListener('click', () => this.togglePlay());
    $('btnRec').addEventListener('click', () => this.toggleRecord());
    $('btnHome').addEventListener('click', () => this.goHome());
    $('btnMixer').addEventListener('click', () => { this.engine.ensure().catch(() => {}); openMixerSheet(this); });
    $('btnCut').addEventListener('click', () => this.setCutMode(!this.cutMode));
    $('btnCutDone').addEventListener('click', () => this.setCutMode(false));
    $('btnUndo').addEventListener('click', () => this.undo());
    $('btnRedo').addEventListener('click', () => this.redo());
    $('btnSongs').addEventListener('click', () => { if (this.guardBusy()) return; this.flushSave(); openSongsSheet(this); });
    $('btnMore').addEventListener('click', () => openMoreSheet(this));
    $('songName').addEventListener('click', () => this.renameProject());
    $('btnTempo').addEventListener('click', () => openTempoSheet(this));
    $('btnMetro').addEventListener('click', () => this.commitFields({ metronomeOn: !this.project.metronomeOn }));
    $('btnLoop').addEventListener('click', () => this.toggleLoop());
    $('fileAudio').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.importAudio(f); });
    $('fileBackup').addEventListener('change', (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) this.loadBackup(f); });
    document.addEventListener('keydown', (e) => {
      if (e.target.closest('input, textarea, select') || document.querySelector('.dialog-backdrop')) return;
      if (e.code === 'Space') { e.preventDefault(); this.togglePlay(); }
      else if (e.key === 'r' || e.key === 'R') this.toggleRecord();
      else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) this.redo(); else this.undo(); }
    });
  }

  /** テストのときだけ：保存をわざと失敗させる */
  testFail() {
    if (this.testHooks.failSaves > 0) {
      this.testHooks.failSaves--;
      throw Object.assign(new Error('テスト用の保存失敗'), { name: 'QuotaExceededError' });
    }
  }

  /** 曲を切り替える前に保存する。保存できなければ切り替えない（保存できていない録音を失わないため） */
  async saveBeforeSwitch() {
    if (await this.flushSave()) return true;
    dialog({ title: '曲を切り替えられません', message: 'いまの曲を保存できなかったため、切り替えを止めました。いらない曲を消して空きを作るか、「その他」から書き出してから、もう一度お試しください。' });
    return false;
  }

  /** 作業中なら知らせて true を返す（曲の切り替えなどを止める） */
  guardBusy() {
    if (!this.session) return false;
    toast(this.isRecording ? '録音中です。録音を止めて、保存が終わるまでお待ちください' : WAIT_MSG);
    return true;
  }

  /**
   * 曲の切り替えなどを、作業中の印を持ったまま行う。最初の await より前に印を取り、終わるまで持つ。
   * 作業中なら何もせず undefined を返す。
   */
  async withSession(kind, projectId, fn) {
    if (this.guardBusy()) return undefined;
    const s = { phase: kind, projectId };
    this.session = s;
    this.updateBars();
    try {
      return await fn(s);
    } finally {
      if (this.session === s) this.session = null;
      this.updateBars();
    }
  }

  // ---------- 描く ----------
  render() {
    const p = this.project;
    if (this.selectedClipId && !p.clips.some((c) => c.id === this.selectedClipId)) this.selectedClipId = null;
    if (!p.tracks.some((t) => t.id === this.recTrackId)) this.recTrackId = p.tracks[0] ? p.tracks[0].id : null;
    this.timeline.render();
    this.updateBars();
  }

  updateBars() {
    const p = this.project;
    $('songName').textContent = p.name;
    document.title = `${p.name} — かさね録り`;
    $('btnUndo').disabled = !H.canUndo(this.history) || !!this.session;
    $('btnRedo').disabled = !H.canRedo(this.history) || !!this.session;
    $('tempoText').textContent = String(p.bpm);
    $('btnMetro').setAttribute('aria-pressed', String(p.metronomeOn));
    $('btnLoop').setAttribute('aria-pressed', String(p.loop.on));
    this.updateTransport();
  }

  updateTransport() {
    const playing = this.engine.playing && !this.isRecording;
    $('icoPlay').toggleAttribute('hidden', playing || this.isRecording);
    $('icoStop').toggleAttribute('hidden', !(playing || this.isRecording));
    $('btnPlay').setAttribute('aria-label', playing || this.isRecording ? '停止' : '再生');
    const rb = $('btnRec');
    rb.classList.toggle('on', this.isRecording);
    rb.setAttribute('aria-label', this.isRecording ? '録音を止める' : this.project.selection ? '範囲を録り直す' : '録音');
    $('recMode').hidden = !this.project.selection || this.isRecording;
    $('meter').hidden = !this.isRecording;
    this.timeline.setRecordingLook(this.isRecording);
  }

  /** 今の再生位置（再生中は音の位置） */
  currentPos() {
    if (this.engine.playing) {
      const sp = this.engine.songPos();
      if (sp != null) return Math.max(0, sp);
    }
    return this.playhead;
  }

  loop() {
    const tick = () => {
      const scrub = this.timeline.scrubT;
      const pos = scrub != null ? scrub : this.currentPos();
      if (this.engine.playing && scrub == null) this.timeline.setPlayhead(pos, true);
      this.syncWakeLock();
      if (this.isRecording && this.recState) this.drawRecording();
      $('timeText').textContent = fmtTime(pos);
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  peaksOf(audio) {
    let pk = this.peaks.get(audio.id);
    if (!pk) { pk = computePeaks(audio.pcm); this.peaks.set(audio.id, pk); }
    return pk;
  }

  audioSecOf = (id) => {
    const a = this.audios.get(id);
    return a ? a.pcm.length / a.sampleRate : Infinity;
  };

  // ---------- 編集の入口（取り消しに積む） ----------
  /** 録音の作業中は、録音の結果（force）以外の編集を受け付けない */
  commit(next, { force = false } = {}) {
    if (this.session && !force) { toast(this.isRecording ? '録音中は編集できません' : WAIT_MSG); return false; }
    const base = this.liveBase || this.project;
    this.liveBase = null;
    if (JSON.stringify(base) === JSON.stringify(next)) { this.project = next; this.render(); return true; }
    this.history = H.record(this.history, base);
    this.setProject(next);
    return true;
  }

  setProject(next) {
    const prev = this.project;
    this.project = next;
    this.scheduleSave();
    if (this.engine.playing && !this.isRecording) {
      const structural = JSON.stringify(prev.clips) !== JSON.stringify(next.clips)
        || prev.tracks.map((t) => t.id).join() !== next.tracks.map((t) => t.id).join()
        || JSON.stringify(prev.loop) !== JSON.stringify(next.loop) || JSON.stringify(prev.selection) !== JSON.stringify(next.selection);
      if (structural) this.restartPlay();
      else {
        this.engine.updateMix(next);
        this.engine.setMetronome(next.metronomeOn);
      }
    } else this.engine.updateMix(next);
    this.render();
    refreshSheet();
  }

  /** つまみを動かしている間：取り消しには積まず、音だけすぐ変える */
  live(next) {
    if (!this.liveBase) this.liveBase = this.project;
    this.project = next;
    this.engine.updateMix(next);
  }

  commitLive() {
    const base = this.liveBase;
    this.liveBase = null;
    if (!base) return;
    if (JSON.stringify(base) !== JSON.stringify(this.project)) {
      this.history = H.record(this.history, base);
      this.scheduleSave();
    }
    this.render();
  }

  /** 確定していない操作（範囲をなぞっている途中など）を取りやめて、元の状態に戻す */
  cancelLive() {
    const base = this.liveBase;
    this.liveBase = null;
    if (!base) return;
    this.project = base;
    this.engine.updateMix(base);
    this.render();
  }

  undo() {
    if (this.session) { this.guardBusy(); return; }
    if (this.liveBase) this.commitLive();
    const r = H.undo(this.history, this.project);
    if (!r) return;
    this.history = r.history;
    this.setProject(r.state);
  }

  redo() {
    if (this.session) { this.guardBusy(); return; }
    if (this.liveBase) this.commitLive();
    const r = H.redo(this.history, this.project);
    if (!r) return;
    this.history = r.history;
    this.setProject(r.state);
  }

  // ---------- 保存 ----------
  scheduleSave() {
    this.editGen++;
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 500);
  }

  /** この曲が使っていて、まだ保存できていない録音 */
  unsavedFor(p) {
    const refs = M.referencedAudioIds([p]);
    return [...this.unsavedAudio.values()].filter((u) => u.projectId === p.id && refs.has(u.audio.id));
  }

  /** まだ保存できていない編集や録音があるか */
  hasUnsaved() {
    return this.savedGen < this.editGen || this.unsavedFor(this.project).length > 0;
  }

  /**
   * 曲を保存する（前の保存が終わってから、1つずつ）。保存できていない録音があれば、
   * 同じトランザクションで一緒に保存し、その録音の控え（pending）も消す。結果を返す
   */
  saveNow() {
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    this.saveChain = this.saveChain.then(() => this.doSave(), () => this.doSave());
    return this.saveChain;
  }

  async doSave() {
    const p = this.project;
    const gen = this.editGen;
    const extra = this.unsavedFor(p);
    try {
      this.testFail();
      await store.saveProjectWithAudios({ ...p, updatedAt: Date.now() }, extra.map((u) => u.audio), extra.map((u) => u.sid).filter(Boolean));
      if (this.project.id === p.id) this.savedGen = Math.max(this.savedGen, gen);
      for (const u of extra) this.unsavedAudio.delete(u.audio.id);
      return true;
    } catch (e) {
      toast(store.isQuotaError(e) ? '端末の空き容量が足りず、保存できませんでした。いらない曲を消すか、書き出して逃がしてください。' : `保存できませんでした：${e.message || e}`, { error: true, duration: 8000 });
      return false;
    }
  }

  /** 保存し終わるのを待つ。保存できていない編集や録音が残っていれば false */
  async flushSave() {
    if (this.saveTimer || this.hasUnsaved()) await this.saveNow();
    else await this.saveChain;
    return !this.hasUnsaved();
  }

  onHide() {
    if (this.testHooks.ignoreHide) return;
    if (this.isRecording) this.stopRecord('hidden');
    else if (this.engine.playing) this.stopPlay();
    if (!this.session) this.flushSave();
  }

  // ---------- 再生 ----------
  async togglePlay() {
    const ready = this.engine.ensure();
    if (this.isRecording) { await this.stopRecord(); return; }
    if (this.session) { this.guardBusy(); return; }
    if (this.engine.playing) { this.stopPlay(); return; }
    try { await ready; } catch (e) { toast(e.message || String(e), { error: true }); return; }
    this.startPlay(this.playhead);
  }

  startPlay(from) {
    const p = this.project;
    let loop = null;
    if (p.loop.on) {
      loop = M.loopRegion(p);
      if (loop && (from < loop.start || from >= loop.end - 0.01)) from = loop.start;
    }
    if (!loop && from >= M.projectEnd(p) - 0.01) from = 0;
    if (!p.clips.length && !p.metronomeOn) { toast('まだ録音がありません。赤い丸を押すと録音できます'); return; }
    this.engine.stopPreview();
    this.playFrom = from;
    this.engine.play({
      project: p, audios: this.audios, from, loop, metronome: p.metronomeOn,
      autoEnd: p.clips.length > 0,
      onEnd: () => { this.playhead = this.playFrom; this.timeline.setPlayhead(this.playhead); this.updateTransport(); },
    });
    this.updateTransport();
  }

  restartPlay() {
    const pos = this.engine.songPos();
    this.engine.stop();
    if (pos != null) this.startPlay(Math.max(0, pos));
  }

  stopPlay() {
    const pos = this.engine.songPos();
    this.engine.stop();
    if (pos != null) this.playhead = Math.max(0, pos);
    this.timeline.setPlayhead(this.playhead);
    this.updateTransport();
  }

  goHome() {
    const p = this.project;
    let target = p.loop.on && p.selection ? p.selection.start : 0;
    if (this.isRecording) return;
    // すでに範囲の始まりにいるなら、もう一度押すと曲の頭へ
    if (target > 0 && Math.abs(this.currentPos() - target) < 0.3) target = 0;
    const was = this.engine.playing;
    if (was) this.engine.stop();
    this.playhead = target;
    this.timeline.setPlayhead(target);
    this.timeline.el.scrollLeft = Math.max(0, target * this.timeline.pps - 40);
    if (was) this.startPlay(target);
    this.updateTransport();
  }

  /** 再生位置の三角を動かして離した所へ（範囲の選択はそのまま） */
  seek(t) {
    if (this.isRecording) return;
    t = Math.max(0, t);
    this.playhead = t;
    this.timeline.setPlayhead(t);
    if (this.engine.playing) { this.engine.stop(); this.startPlay(t); }
    this.updateTransport();
  }

  tapTime(t, fromLane) {
    if (this.isRecording) return;
    const sel = this.project.selection;
    if (fromLane) this.deselectClip();
    if (!fromLane && sel && (t < sel.start || t > sel.end) && !this.session) this.commit(M.setSelection(this.project, null));
    this.playhead = t;
    this.timeline.setPlayhead(t);
    if (this.engine.playing) { this.engine.stop(); this.startPlay(t); }
    this.updateTransport();
  }

  toggleLoop() {
    const p = this.project;
    if (!p.loop.on && !M.loopRegion(p)) { toast('くり返す音がまだありません'); }
    this.commit(M.setLoop(p, { on: !p.loop.on }));
  }

  // ---------- 録音 ----------
  async toggleRecord() {
    const ready = this.engine.ensure();
    ready.catch(() => {});
    if (this.isRecording) { await this.stopRecord(); return; }
    if (this.session) { this.guardBusy(); return; }
    if (!this.settings.micNoticeShown && !this.testMode) {
      const ok = await dialog({
        title: '録音の前に',
        message: 'イヤホンを付けると、前に録った音やメトロノームが録音に入りません。\n初めての録音では、マイクを使ってよいか聞かれます。「許可」を選んでください。',
        buttons: [{ label: 'やめる', value: false }, { label: '録音を始める', value: true, cls: 'primary' }],
      });
      if (!ok) return;
      this.setSetting('micNoticeShown', true);
    }
    const sel = this.project.selection;
    return this.startRecord(sel ? { mode: 'punch', range: { ...sel } } : { mode: 'normal' });
  }

  async startRecord({ mode, range = null, trackId = null }) {
    if (this.session) { this.guardBusy(); return false; }
    if (this.liveBase) this.commitLive();
    this.session = { phase: 'starting', projectId: this.project.id };
    try {
      this.engine.stop();
      this.engine.stopPreview();
      await this.engine.ensure();
      if (!this.engine.ready) throw new Error('音の準備ができませんでした。もう一度押してください');
      if (!this.project.tracks.length) {
        const r = M.addTrack(this.project);
        this.recTrackId = r.trackId;
        this.commit(r.project, { force: true });
      }
      this.fixRecTrack();
      trackId = trackId || this.recTrackId || this.project.tracks[0].id;
      this.recTrackId = trackId;
      const p = this.project;
      // マイクを開いて実際の設定を取ってから、この録音の補正を決める（初回と2回目で変わらないように）
      await this.engine.openInput();
      const latencySec = this.engine.autoLatencySec() + this.settings.latencyMs / 1000;
      const countInSec = mode === 'normal' && p.metronomeOn ? (p.countInBars * p.beatsPerBar * 60) / p.bpm : 0;
      const recordStart = mode === 'normal' ? this.playhead : range.start;
      const peaks = new PeakBuilder();
      const sid = M.newId('r');
      const st = { sid, mode, range, recordStart, trackId, latencySec, peaks, firstFrame: null, level: 0, rec: null, buf: [], seq: 0, chain: Promise.resolve(), projectId: p.id };
      this.recState = st;
      st.rec = await this.engine.startRecording({
        project: p, audios: this.audios, mode, recordStart, range, preroll: this.settings.preroll, countInSec, trackId, latencySec, maxSec: this.maxRecSec,
        onChunk: (m) => {
          if (st.firstFrame === null) st.firstFrame = m.frame;
          peaks.push(m.data);
          st.level = Math.max(st.level * 0.7, m.peak);
          st.buf.push({ frame: m.frame, data: m.data });
        },
        onAutoStop: (why) => this.stopRecord(why),
      });
      // 画面が閉じられても戻せるように、録音の情報と断片を保存していく
      st.meta = { projectId: p.id, trackId, mode, recordStart, range, transportFrom: st.rec.transportFrom, T0: st.rec.T0, sampleRate: st.rec.sampleRate, latencySec, createdAt: Date.now() };
      this.flushPending(st);
      st.flushTimer = setInterval(() => this.flushPending(st), PENDING_FLUSH_MS);
      this.setCutMode(false);
      this.isRecording = true;
      this.session.phase = 'recording';
      const track = p.tracks.find((t) => t.id === trackId);
      this.timeline.recStart(trackId, recordStart, track ? track.color : '#e5484d');
      this.requestWakeLock();
      this.updateBars();
      return true;
    } catch (e) {
      if (this.recState) clearInterval(this.recState.flushTimer);
      this.recState = null;
      this.session = null;
      this.engine.stop();
      this.showMicError(e);
      this.updateBars();
      return false;
    }
  }

  /** テストのときだけ：控えの保存をわざと失敗させる */
  testFailPending() {
    if (this.testHooks.failPending > 0) {
      this.testHooks.failPending--;
      throw new Error('テスト用の控えの保存失敗');
    }
  }

  /**
   * 録音の控え（情報と断片）を保存する。順番に1つずつ。
   * 保存できた断片だけを手元の列から外す（失敗したものは次の回にもう一度試す）。
   * 続けて失敗したら一度だけ知らせる。戻り値：手元に保存できていない断片が残っていないか
   */
  flushPending(st) {
    st.chain = st.chain.then(async () => {
      try {
        if (!st.metaSaved) {
          this.testFailPending();
          await store.putPending({ key: `${st.sid}:meta`, sid: st.sid, kind: 'meta', meta: st.meta });
          st.metaSaved = true;
        }
        const n = st.buf.length;
        if (n) {
          const parts = st.buf.slice(0, n);
          this.testFailPending();
          await store.putPending({ key: `${st.sid}:${String(st.seq + 1).padStart(6, '0')}`, sid: st.sid, kind: 'chunk', parts });
          st.seq++;
          st.buf.splice(0, n);
        }
        st.failCount = 0;
      } catch {
        st.failCount = (st.failCount || 0) + 1;
        if (st.failCount >= 2 && !st.warned) {
          st.warned = true;
          toast('録音の控えを保存できていません。録音は続いています', { error: true, duration: 6000 });
        }
      }
      return st.metaSaved && st.buf.length === 0;
    });
    return st.chain;
  }

  drawRecording() {
    const st = this.recState;
    const rec = st.rec;
    const pos = this.engine.songPos();
    if (pos == null || !rec) return;
    const heard = pos - st.latencySec;
    let end;
    if (st.mode === 'punch') end = Math.min(st.range.end, Math.max(st.range.start, heard));
    else end = Math.max(st.recordStart, heard);
    let offset = 0;
    if (st.firstFrame !== null) {
      const pos0 = M.recordingSongPos0({ transportFrom: rec.transportFrom, transportCtxStart: rec.T0, firstFrame: st.firstFrame, sampleRate: rec.sampleRate, latencySec: st.latencySec });
      offset = st.recordStart - pos0;
    }
    this.timeline.recUpdate(end, st.peaks.peaks, rec.sampleRate, offset);
    const bar = document.querySelector('.meter-bar');
    if (bar) bar.style.width = `${Math.min(100, st.level * 140)}%`;
    st.level *= 0.92;
  }

  /**
   * 録音を止めて保存する。何が起きても、作業中の印・録音中の印・タイマー・画面の状態は必ず片付ける。
   * 保存できなかったときは、録音（PCM）と控え（pending）を残す。
   */
  async stopRecord(reason) {
    const s = this.session;
    if (!s || s.phase !== 'recording') return null;
    s.phase = 'stopping';
    const st = this.recState;
    clearInterval(st.flushTimer);
    try {
      const res = await this.engine.stopRecording();
      this.cleanupRecordingUI();
      s.phase = 'saving';
      this.updateBars();
      // 最後の断片まで控えに書いてから確定する（本保存に失敗して閉じても、最後まで戻せるように）
      st.pendingComplete = await this.flushPending(st);
      if (!res || !res.pcm.length) {
        await store.deletePending(st.sid).catch(() => {});
        toast('録音できませんでした（マイクの音が届いていません）', { error: true });
        return null;
      }
      const pcmSec = res.pcm.length / res.sampleRate;
      const place = res.mode === 'punch'
        ? M.placePunch({ range: res.range, songPos0: res.songPos0, pcmSec })
        : M.placeRecording({ recordStart: res.recordStart, songPos0: res.songPos0, pcmSec });
      if (!place) {
        await store.deletePending(st.sid).catch(() => {});
        toast(res.mode === 'punch' ? '範囲に入る前に止めたので、録音しませんでした' : '録音が短すぎたので、置きませんでした');
        return null;
      }
      const audio = { id: M.newId('a'), sampleRate: res.sampleRate, length: res.pcm.length, createdAt: Date.now(), pcm: res.pcm };
      this.audios.set(audio.id, audio);
      // 開始したときの曲へ入れる（作業中は曲を切り替えられないので、今の曲と同じはず）
      let base = this.project;
      const sameProject = base.id === s.projectId;
      if (!sameProject) base = M.normalizeProject((await store.loadProject(s.projectId)) || base);
      const r = res.mode === 'punch'
        ? M.punchIn(base, { trackId: res.trackId, range: place.range, audioId: audio.id, offset: place.offset })
        : M.recordClip(base, { trackId: res.trackId, start: place.start, duration: place.duration, audioId: audio.id, offset: place.offset });
      let saved = false;
      let err = null;
      try {
        this.testFail();
        await store.saveProjectWithAudios({ ...r.project, updatedAt: Date.now() }, [audio], [st.sid]);
        saved = true;
      } catch (e) {
        err = e;
        this.unsavedAudio.set(audio.id, { audio, projectId: s.projectId, sid: st.sid });
      }
      if (sameProject) {
        this.commit(r.project, { force: true });
        if (saved) this.savedGen = this.editGen;
      }
      this.lastRecord = { clipId: r.clipId, audioId: audio.id, mode: res.mode, songPos0: res.songPos0, stopSong: res.stopSong, addedTake: !!r.addedTake, saved, reason };
      if (!saved) { this.reportAudioSaveError(err, audio); return r.clipId; }
      if (reason === 'limit') dialog({ title: '録音を止めました', message: '1回の録音は10分までです。ここまでの録音は保存しました。' });
      else if (reason === 'hidden') toast('画面を離れたので、録音を止めて保存しました');
      else if (res.mode === 'punch') toast(r.addedTake ? '新しいテイクを足しました' : '範囲を録り直しました', { action: { label: '取り消す', run: () => this.undo() } });
      else if (sameProject && this.project.clips.some((c) => c.trackId !== res.trackId)) {
        // 重ねて録ったとき：ずれを探して、見つかれば「合わせる」を出す
        this.offerAutoAlign(r.clipId);
      }
      return r.clipId;
    } catch (e) {
      // 止める途中で問題が起きた：控えに残っている分は、次に開いたときに戻せる
      this.lastRecord = { error: String((e && e.message) || e), reason };
      try { await this.flushPending(st); } catch { /* 控えの保存も失敗した */ }
      dialog({
        title: '録音を止めるときに問題が起きました',
        message: `${(e && e.message) || e}\nそこまでの録音の控えは端末に残っています。このアプリを開き直すと「前回の録音が残っています」と出るので、そこから曲に戻せます。`,
      });
      return null;
    } finally {
      this.cleanupRecordingUI();
      this.session = null;
      this.updateBars();
    }
  }

  /** 録音中の印・タイマー・Wake Lock・画面の録音中の表示を片付ける（何度呼んでもよい） */
  cleanupRecordingUI() {
    if (this.recState) clearInterval(this.recState.flushTimer);
    this.isRecording = false;
    this.recState = null;
    this.releaseWakeLock();
    this.timeline.recEnd();
    if (this.engine.recording) { try { this.engine.abortRecording(); } catch { /* */ } }
  }

  reportAudioSaveError(e, audio) {
    const msg = store.isQuotaError(e) ? '端末の空き容量が足りず、録音を保存できませんでした。' : `録音を保存できませんでした（${(e && e.message) || e}）。`;
    dialog({
      title: '録音を保存できませんでした',
      message: `${msg}\nこの録音は、もう一度保存するか書き出すまで、この画面の中に残しておきます（画面を閉じると消えます）。いらない曲を消して空きを作ってから「もう一度保存する」を押すか、書き出して逃がしてください。`,
      buttons: [{ label: 'あとで', value: 'later' }, { label: '書き出す', value: 'export' }, { label: 'もう一度保存する', value: 'retry', cls: 'primary' }],
    }).then((v) => {
      if (v === 'export') this.exportUnsaved(audio.id);
      else if (v === 'retry') this.retryUnsaved();
    });
  }

  /** 保存できていない録音を、もう一度保存する（曲と一緒に。控えの削除も同じトランザクション） */
  async retryUnsaved() {
    if (!this.unsavedAudio.size) return true;
    let ok = true;
    const byProject = new Map();
    for (const u of this.unsavedAudio.values()) {
      if (!byProject.has(u.projectId)) byProject.set(u.projectId, []);
      byProject.get(u.projectId).push(u);
    }
    for (const [pid, list] of byProject) {
      try {
        this.testFail();
        const isCur = pid === this.project.id;
        const gen = this.editGen;
        const stored = isCur ? null : await store.loadProject(pid);
        if (!isCur && !stored) throw new Error('元の曲が見つかりません');
        const p = isCur ? this.project : M.normalizeProject(stored);
        // 曲に入っていない録音（保存前に取り消した等）も、音だけは保存する
        await store.saveProjectWithAudios({ ...p, updatedAt: Date.now() }, list.map((u) => u.audio), list.map((u) => u.sid).filter(Boolean));
        if (isCur) this.savedGen = Math.max(this.savedGen, gen);
        for (const u of list) this.unsavedAudio.delete(u.audio.id);
      } catch { ok = false; }
    }
    toast(ok ? '録音を保存しました' : 'まだ保存できませんでした。空きを作るか、書き出してください', { error: !ok });
    refreshSheet();
    return ok;
  }

  /** 書き出したことだけを記録する（このアプリの中への保存とは別。保存できるまで持ち続ける） */
  markExported(audioId) {
    const x = this.unsavedAudio.get(audioId);
    if (x) x.exported = true;
    refreshSheet();
  }

  /** 保存できていない録音を書き出す。書き出しても、端末の保存ができるまでは持ち続ける */
  exportUnsaved(audioId) {
    const u = this.unsavedAudio.get(audioId);
    const audio = u ? u.audio : this.audios.get(audioId);
    if (!audio) return;
    const blob = new Blob([encodeWav16([audio.pcm], audio.sampleRate)], { type: 'audio/wav' });
    const filename = `録音_${new Date(audio.createdAt).toISOString().slice(0, 19).replace(/[-:T]/g, '')}.wav`;
    openFileSheet(this, {
      title: '保存できていない録音を書き出す',
      note: 'この録音だけを WAV ファイルにします。書き出しても、このアプリの中に保存できるまでは「保存できていない録音」に残ります。',
      make: async () => ({ blob, filename, desc: `${(audio.pcm.length / audio.sampleRate).toFixed(1)} 秒` }),
      onDone: () => this.markExported(audioId),
    });
  }

  showMicError(e) {
    const name = e && e.name;
    let msg = (e && e.message) || String(e);
    if (name === 'NotAllowedError' || name === 'SecurityError') msg = 'マイクの使用が許可されていません。ブラウザの設定で、このページのマイクを「許可」にしてから、もう一度押してください。';
    else if (name === 'NotFoundError' || name === 'OverconstrainedError') msg = 'マイクが見つかりませんでした。マイクが付いているか確かめてください。';
    else if (name === 'NotReadableError') msg = 'マイクを開けませんでした。ほかのアプリがマイクを使っていないか確かめてください。';
    dialog({ title: '録音を始められませんでした', message: msg });
  }

  /** 画面を点けたままにする必要があるか（録音中・録音の準備中・再生中・テイクの試し聞き中） */
  wakeNeeded() {
    return !!(this.isRecording || this.engine.playing || this.previewing || (this.session && this.session.phase === 'starting'));
  }

  /**
   * 再生中・録音中は画面が自動で消えないようにする（消えると録音が止まるため）。
   * 毎フレーム呼ばれる：必要な間は持ち続け、端末に外されたら取り直し、要らなくなったら返す。
   */
  syncWakeLock() {
    const need = this.wakeNeeded();
    if (!need) { if (this.wakeLock) this.releaseWakeLock(); return; }
    if (this.wakeLock || this.wakePending || document.hidden) return;
    if (!navigator.wakeLock) { this.warnNoWakeLock(); return; }
    const now = Date.now();
    if (this.wakeRetryAt && now < this.wakeRetryAt) return;
    this.wakePending = true;
    navigator.wakeLock.request('screen').then((lock) => {
      this.wakePending = false;
      this.wakeFails = 0;
      if (!this.wakeNeeded()) { lock.release().catch(() => {}); return; }
      this.wakeLock = lock;
      // 端末の都合で外されたら（画面を離れた・省電力など）、次のフレームで取り直す
      lock.addEventListener('release', () => { if (this.wakeLock === lock) this.wakeLock = null; });
    }).catch(() => {
      this.wakePending = false;
      this.wakeFails = (this.wakeFails || 0) + 1;
      this.wakeRetryAt = Date.now() + 2000;
      if (this.wakeFails >= 2) this.warnNoWakeLock();
    });
  }

  warnNoWakeLock() {
    if (this.wakeWarned) return;
    this.wakeWarned = true;
    toast('この端末では、画面を点けたままにできませんでした。長く録るときは、端末の設定で「自動ロック」を長めにしてください', { duration: 9000 });
  }

  requestWakeLock() { this.syncWakeLock(); }

  releaseWakeLock() {
    const lock = this.wakeLock;
    this.wakeLock = null;
    if (lock) lock.release().catch(() => {});
  }

  // ---------- 前回の録音を戻す ----------

  /** 録音中に画面が閉じられた録音が残っていれば、曲に戻すか聞く */
  async offerRecovery() {
    const groups = await store.loadPending();
    for (const g of groups) {
      if (!g.meta || !g.chunks.length) {
        // 戻せる音がない控え。この画面だけが開いていると確かめられたときだけ消す
        if (this.instance === 'locked') await store.deletePending(g.sid);
        continue;
      }
      const { pcm, gapSec } = M.assemblePending(g.chunks, g.meta.sampleRate);
      const sec = pcm.length / g.meta.sampleRate;
      const when = new Date(g.meta.createdAt).toLocaleString('ja-JP', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' });
      const gapText = gapSec > 0.001 ? `\n途中の約 ${gapSec.toFixed(1)} 秒は控えに残っておらず、無音になります。` : '';
      const v = await dialog({
        title: '前回の録音が残っています',
        message: `${when} に始めた録音（約 ${sec.toFixed(1)} 秒）が、保存の途中で終わっていました。曲に戻しますか。${gapText}`,
        buttons: [{ label: '捨てる', value: 'discard', cls: 'danger' }, { label: '曲に戻す', value: 'restore', cls: 'primary' }],
      });
      if (v === 'restore') await this.recoverPending(g);
      else if (v === 'discard') {
        if (await confirmDialog('録音を捨てますか', 'この録音は元に戻せません。', '捨てる', true)) await store.deletePending(g.sid);
      }
      // 背景を押して閉じたときは残しておく（次に開いたときにもう一度聞く）
    }
  }

  async recoverPending(g) {
    const meta = g.meta;
    const { pcm, first, gapSec } = M.assemblePending(g.chunks, meta.sampleRate);
    const songPos0 = M.recordingSongPos0({ transportFrom: meta.transportFrom, transportCtxStart: meta.T0, firstFrame: first, sampleRate: meta.sampleRate, latencySec: meta.latencySec });
    const pcmSec = pcm.length / meta.sampleRate;
    const place = meta.mode === 'punch'
      ? M.placePunch({ range: meta.range, songPos0, pcmSec })
      : M.placeRecording({ recordStart: meta.recordStart, songPos0, pcmSec });
    if (!place) { toast('戻せる長さの録音がありませんでした'); await store.deletePending(g.sid); return null; }
    const stored = await store.loadProject(meta.projectId);
    let p;
    let newSong = false;
    if (stored) p = M.normalizeProject(stored);
    else {
      // 元の曲がないときは、今の曲へは入れず、新しい曲を作ってそこへ戻す
      p = M.createProject({ name: '復旧した録音' });
      newSong = true;
    }
    let trackId = meta.trackId;
    if (!p.tracks.some((t) => t.id === trackId)) {
      const r = M.addTrack(p, { name: '戻した録音' });
      p = r.project;
      trackId = r.trackId;
    }
    const audio = { id: M.newId('a'), sampleRate: meta.sampleRate, length: pcm.length, createdAt: Date.now(), pcm };
    const r = meta.mode === 'punch'
      ? M.punchIn(p, { trackId, range: place.range, audioId: audio.id, offset: place.offset })
      : M.recordClip(p, { trackId, start: place.start, duration: place.duration, audioId: audio.id, offset: place.offset });
    try {
      // 控えがまだ残っているときだけ保存する（同じ控えを二度戻さない）
      await store.saveProjectWithAudios({ ...r.project, updatedAt: Date.now() }, [audio], [g.sid], { requirePending: g.sid });
    } catch (e) {
      if (e && e.name === 'PendingGone') { toast('この録音は、もう戻してあります'); return null; }
      dialog({ title: '戻せませんでした', message: store.isQuotaError(e) ? '端末の空き容量が足りません。空きを作ってから開き直してください。' : String((e && e.message) || e) });
      return null;
    }
    await this.loadProjectData(r.project);
    this.lastRecovered = { clipId: r.clipId, projectId: r.project.id, newSong, gapSec, seconds: place.duration || (place.range.end - place.range.start) };
    toast(newSong ? '元の曲が見つからなかったので、新しい曲「復旧した録音」に戻しました' : gapSec > 0.001 ? '前回の録音を曲に戻しました（途中に無音の所があります）' : '前回の録音を曲に戻しました');
    return r.clipId;
  }

  // ---------- トラック ----------
  addTrack() {
    const r = M.addTrack(this.project);
    if (!this.commit(r.project)) return;
    this.recTrackId = r.trackId;
    this.render();
    requestAnimationFrame(() => { this.timeline.el.scrollTop = this.timeline.el.scrollHeight; });
    toast(`${r.project.tracks.find((t) => t.id === r.trackId).name} を録音先にしました`);
  }

  setRecTrack(id) {
    if (this.session) return;
    this.recTrackId = id;
    this.render();
  }

  updateTrack(id, patch) { this.commit(M.updateTrack(this.project, id, patch)); }
  liveTrack(id, patch) { this.live(M.updateTrack(this.project, id, patch)); }
  commitTrack(id, patch) { this.live(M.updateTrack(this.project, id, patch)); this.commitLive(); }
  liveMaster(v) { this.live(M.setProjectFields(this.project, { masterGain: v })); }
  commitMaster(v) { this.liveMaster(v); this.commitLive(); }
  liveFields(patch) { this.live(M.setProjectFields(this.project, patch)); $('tempoText').textContent = String(this.project.bpm); }
  commitFields(patch) {
    if (this.liveBase) { this.live(M.setProjectFields(this.project, patch)); this.commitLive(); refreshSheet(); return; }
    this.commit(M.setProjectFields(this.project, patch));
  }

  async removeTrack(id) {
    const t = this.project.tracks.find((x) => x.id === id);
    if (!t) return;
    const has = this.project.clips.some((c) => c.trackId === id);
    if (has && !(await confirmDialog('トラックを削除しますか', `「${t.name}」とその録音を削除します。取り消しで戻せます。`, '削除する', true))) return;
    if (!this.commit(M.removeTrack(this.project, id))) return;
    this.fixRecTrack();
    this.render();
    toast(`「${t.name}」を削除しました`, { action: { label: '取り消す', run: () => this.undo() } });
  }

  /** 録音先のトラックが無くなっていたら、残っている一番上のトラックにする */
  fixRecTrack() {
    const ts = this.project.tracks;
    if (!ts.some((x) => x.id === this.recTrackId)) this.recTrackId = ts.length ? ts[0].id : null;
  }

  openTrackList() { if (this.session) { this.guardBusy(); return; } openTrackListSheet(this); }

  // ---------- 重ねた音を合わせる ----------
  openSync(clipId) { if (this.session) { this.guardBusy(); return; } openSyncSheet(this, clipId); }

  beginSync(clipId) {
    if (this.liveBase) this.commitLive();
    this.syncState = { clipId, shift: 0, applyNext: true, viewFrom: null };
  }

  /** 合わせる画面の絵：ほかのトラック（ref）とこのフレーズ（x）の波形。窓は開いた時の位置で止めておく（動いたのが見えるように） */
  syncWaves(widthPx, pxSec) {
    const st = this.syncState;
    const c = st && this.project.clips.find((x) => x.id === st.clipId);
    if (!c) return null;
    if (st.viewFrom == null) {
      // フレーズの最初の大きな音の少し前から見せる（頭の無音だけが映らないように）
      const env = envelopeOf(this.project, this.audios, { from: c.start, to: c.start + Math.min(c.duration, 30), hop: 0.01, include: (x) => x.id === c.id, mode: 'peak' });
      let mx = 0;
      for (const v of env) mx = Math.max(mx, v);
      let i = 0;
      while (i < env.length && env[i] < mx * 0.3) i++;
      st.viewFrom = Math.max(0, c.start + i * 0.01 - 0.25);
    }
    const from = st.viewFrom;
    const to = from + widthPx * pxSec;
    const opt = { from, to, hop: pxSec, mode: 'peak' };
    return {
      from,
      ref: envelopeOf(this.project, this.audios, { ...opt, include: (x) => x.trackId !== c.trackId && x.id !== c.id }),
      x: envelopeOf(this.project, this.audios, { ...opt, include: (x) => x.id === c.id }),
      color: (this.project.tracks.find((t) => t.id === c.trackId) || {}).color,
    };
  }

  /** 合わせる画面の「自動で合わせる」：見つけた分だけ動かして流す */
  syncAuto() {
    const st = this.syncState;
    if (!st) return { ok: false };
    const f = findLag(this.project, this.audios, st.clipId);
    if (!f.ok) return f;
    if (Math.abs(f.lagSec) >= 0.001) this.syncNudge(-f.lagSec);
    return f;
  }

  /** 重ねて録った直後：ずれを探して、見つかれば「合わせますか」を出す */
  offerAutoAlign(clipId) {
    let f;
    try { f = findLag(this.project, this.audios, clipId); } catch { f = { ok: false }; }
    if (f.ok && Math.abs(f.lagSec) >= 0.008) {
      const ms = Math.round(Math.abs(f.lagSec) * 1000);
      toast(`重ねた音が ${ms}ms ${f.lagSec > 0 ? '遅れて' : '早く'}入っていました`, { action: { label: '合わせる', run: () => this.applyAutoAlign(clipId) }, duration: 10000 });
    } else if (f.ok) {
      toast('重ねて録りました（ずれはほとんどありません）');
    } else {
      toast('重ねて録りました。ずれて聞こえたら合わせられます', { action: { label: 'ずれを合わせる', run: () => this.openSync(clipId) }, duration: 8000 });
    }
  }

  /** 見つけたずれの分だけフレーズを動かす。大きくずれていたら、次からの録音も同じだけ合わせる */
  applyAutoAlign(clipId) {
    if (this.session) { this.guardBusy(); return; }
    const f = findLag(this.project, this.audios, clipId);
    if (!f.ok) { this.openSync(clipId); return; }
    const prevLatency = this.settings.latencyMs;
    if (!this.commit(M.slipClip(this.project, clipId, -f.lagSec, this.audioSecOf))) return;
    let msg = '合わせました';
    if (Math.abs(f.lagSec) >= 0.03) {
      this.setSetting('latencyMs', prevLatency + f.lagSec * 1000);
      msg = '合わせました。次からの録音も、同じだけ合わせて置きます';
    }
    toast(msg, { action: { label: '取り消す', run: () => { this.undo(); this.setSetting('latencyMs', prevLatency); } }, duration: 7000 });
  }

  /** フレーズを d 秒動かして（取り消しにはまだ積まない）、少し前から流す */
  syncNudge(d) {
    const st = this.syncState;
    if (!st || this.session) return;
    const c = this.project.clips.find((x) => x.id === st.clipId);
    if (!c) return;
    // 枠はそのままで中の音をずらす（曲の頭にあるフレーズも前へ合わせられる）
    const next = M.slipClip(this.project, st.clipId, d, this.audioSecOf);
    const moved = next.clips.find((x) => x.id === st.clipId);
    st.shift += M.contentStart(moved) - M.contentStart(c);
    this.live(next);
    this.render();
    this.syncListen(true);
  }

  syncListen(restart = false) {
    const st = this.syncState;
    if (!st) return;
    if (this.engine.playing && !restart) { this.stopPlay(); return; }
    const c = this.project.clips.find((x) => x.id === st.clipId);
    if (!c) return;
    this.engine.stop();
    const from = Math.max(0, c.start - 1.5);
    this.playhead = from;
    this.engine.ensure().then(() => this.startPlay(from)).catch((e) => toast(e.message || String(e), { error: true }));
  }

  /** ok=true：動かした位置で決める（次からの補正にも足す）／false：元の位置に戻す */
  finishSync(ok) {
    const st = this.syncState;
    if (!st) { closeSheet(); return; }
    if (this.engine.playing) this.stopPlay();
    if (ok) {
      this.commitLive();
      if (st.applyNext && Math.abs(st.shift) > 1e-6) {
        // 前へ動かした（shift がマイナス）分だけ、次の録音を前へ置く
        this.setSetting('latencyMs', this.settings.latencyMs - st.shift * 1000);
        const v = Math.round(this.settings.latencyMs);
        toast(v === 0 ? '合わせました。次の録音からは、ずらさずに置きます' : `合わせました。次の録音から ${Math.abs(v)} ms ${v > 0 ? '前' : '後ろ'}へずらして置きます`, { duration: 5000 });
      } else if (Math.abs(st.shift) > 1e-6) toast('合わせました');
    } else {
      this.cancelLive();
    }
    this.syncState = null;
    closeSheet();
  }

  /** シートを閉じたとき：決めていなければ、動かした位置のまま確定する（次からの補正には足さない） */
  endSync() {
    if (!this.syncState) return;
    this.syncState = null;
    if (this.engine.playing) this.stopPlay();
    this.commitLive();
  }

  // ---------- フレーズ ----------
  tapClip(id) {
    if (this.isRecording || this.cutMode) return;
    this.selectedClipId = id;
    this.render();
    openClipSheet(this, id);
  }

  openTakes(id) {
    if (this.isRecording) return;
    this.selectedClipId = id;
    this.render();
    openTakesSheet(this, id);
  }

  deselectClip() {
    if (!this.selectedClipId) return;
    this.selectedClipId = null;
    const cur = currentSheet();
    if (cur && cur.id && cur.id.startsWith('clip:')) closeSheet();
    this.render();
  }

  onClipSheetClosed(id) {
    if (this.selectedClipId === id) { this.selectedClipId = null; this.render(); }
  }

  moveClip(id, pos) { if (!this.commit(M.moveClip(this.project, id, pos))) this.render(); }

  trimClip(id, side, value) {
    const c = this.project.clips.find((x) => x.id === id);
    if (!c) return;
    let ok;
    if (side === 'l') ok = this.commit(M.trimStart(this.project, id, value));
    else ok = this.commit(M.trimEnd(this.project, id, value, this.audioSecOf(M.activeTake(c).audioId)));
    if (!ok) this.render();
  }

  splitClipAtPlayhead(id) {
    // 再生中は、聞こえている位置で分ける
    const t = this.currentPos();
    const r = M.splitClip(this.project, id, t);
    if (!r.ok) { toast('再生位置をフレーズの中に合わせてから押してください'); return; }
    this.commit(r.project);
  }

  /** はさみ：入にすると、フレーズの上で指を離した所で切れる */
  setCutMode(on) {
    on = !!on;
    if (on) {
      if (this.isRecording) { toast('録音中は切れません'); return; }
      if (!this.project.clips.length) { toast('切るフレーズがまだありません'); return; }
      closeSheet();
      this.selectedClipId = null;
    }
    if (on === this.cutMode) return;
    this.cutMode = on;
    $('btnCut').setAttribute('aria-pressed', String(on));
    $('cutHint').hidden = !on;
    document.body.classList.toggle('cutting', on);
    this.render();
  }

  /** はさみで、フレーズ id を曲の t 秒の所で2つに分ける */
  cutClipAt(id, t) {
    if (!this.project.clips.some((c) => c.id === id)) return false;
    const r = M.splitClip(this.project, id, t);
    if (!r.ok) { toast('端に近すぎて切れません。もう少し内側で離してください'); return false; }
    if (!this.commit(r.project)) return false;
    toast('切りました', { action: { label: '取り消す', run: () => this.undo() } });
    return true;
  }

  duplicateClip(id) {
    const r = M.duplicateClip(this.project, id);
    if (!this.commit(r.project)) return;
    closeSheet();
    this.selectedClipId = r.clipId;
    this.render();
    openClipSheet(this, r.clipId);
  }

  deleteClip(id) {
    closeSheet();
    if (this.commit(M.deleteClip(this.project, id))) toast('フレーズを削除しました', { action: { label: '取り消す', run: () => this.undo() } });
  }

  nudgeClip(id, d) { this.commit(M.nudgeClip(this.project, id, d)); }
  liveClipGain(id, v) { this.live(M.setClipGain(this.project, id, v)); }
  commitClipGain(id, v) { this.liveClipGain(id, v); this.commitLive(); }

  selectClipRange(id) {
    const c = this.project.clips.find((x) => x.id === id);
    if (!c) return;
    closeSheet();
    if (this.commit(M.setSelection(this.project, { start: c.start, end: M.clipEnd(c) }))) toast('範囲を選びました。赤い丸を押すと、この範囲だけ録り直せます');
  }

  async retakeClip(id) {
    const c = this.project.clips.find((x) => x.id === id);
    if (!c) return;
    if (this.session) { this.guardBusy(); return; }
    this.engine.ensure().catch(() => {});
    closeSheet();
    this.recTrackId = c.trackId;
    await this.startRecord({ mode: 'punch', range: { start: c.start, end: M.clipEnd(c) }, trackId: c.trackId });
  }

  setActiveTake(id, i) {
    const next = M.setActiveTake(this.project, id, i, this.audioSecOf);
    if (next === this.project) { toast('このテイクには、今の位置の録音がありません'); return false; }
    return this.commit(next);
  }

  removeTake(id, i) {
    const next = M.removeTake(this.project, id, i, this.audioSecOf);
    if (next === this.project) { toast('ほかのテイクには今の位置の録音がないので、このテイクは消せません'); return false; }
    return this.commit(next);
  }

  previewTake(clipId, i, onEnd) {
    const c = this.project.clips.find((x) => x.id === clipId);
    if (!c) return;
    const t = c.takes[i];
    const a = this.audios.get(t.audioId);
    if (!a) { toast('この録音が見つかりません', { error: true }); return; }
    this.engine.ensure().then(() => {
      if (this.engine.playing) this.stopPlay();
      this.previewing = `${clipId}:${i}`;
      const dur = Math.min(c.duration, a.pcm.length / a.sampleRate - Math.max(0, t.offset));
      this.engine.previewAudio(a, t.offset, dur, () => { this.previewing = null; if (onEnd) onEnd(); }, this.project.masterGain);
    }).catch(() => {});
  }

  stopPreview() { this.previewing = null; this.engine.stopPreview(); }

  // ---------- 隠れたフレーズ ----------
  restoreShelved(id) {
    const r = M.restoreShelved(this.project, id);
    if (!r.ok) return;
    if (this.commit(r.project)) toast('新しいトラックの元の位置に戻しました', { action: { label: '取り消す', run: () => this.undo() } });
  }

  // ---------- 範囲 ----------
  liveSelection(range) {
    if (this.session) return;
    if (!this.liveBase) this.liveBase = this.project;
    this.project = M.setSelection(this.project, range);
    this.timeline.updateSelection();
    this.updateTransport();
  }

  commitSelection() {
    this.commitLive();
    this.updateTransport();
    if (this.project.selection) toast('範囲を選びました。赤い丸で、この範囲だけ録り直せます。外側の目盛りを押すと解除します', { duration: 4500 });
  }

  // ---------- 曲 ----------
  async listProjects() {
    await this.flushSave();
    const all = (await store.loadAllProjects()).map(M.normalizeProject);
    return all.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  async openProject(id) {
    return this.withSession('switch', this.project.id, async () => {
      if (!(await this.saveBeforeSwitch())) return false;
      const p = await store.loadProject(id);
      if (!p) return false;
      closeSheet();
      await this.loadProjectData(M.normalizeProject(p));
      return true;
    });
  }

  async newProject() {
    const r = await this.withSession('switch', this.project.id, async () => {
      if (!(await this.saveBeforeSwitch())) return false;
      const all = await store.loadAllProjects();
      const p = M.createProject({ name: `曲 ${all.length + 1}` });
      await store.saveProject(p);
      closeSheet();
      await this.loadProjectData(p);
      return true;
    });
    return r === true;
  }

  async renameProject() {
    if (this.guardBusy()) return;
    const v = await promptDialog('曲の名前', this.project.name);
    if (v) this.commit(M.setProjectFields(this.project, { name: v }));
  }

  async duplicateProject(id) {
    return this.withSession('duplicate', id, async () => {
      if (!(await this.flushSave())) return;
      const p = await store.loadProject(id);
      if (!p) return;
      const now = Date.now();
      const copy = { ...structuredClone(p), id: M.newId('p'), name: `${p.name}（コピー）`.slice(0, 60), createdAt: now, updatedAt: now };
      await store.saveProject(copy);
      toast('曲を複製しました');
    });
  }

  async deleteProject(id) {
    return this.withSession('delete', id, async () => {
      const p = await store.loadProject(id);
      if (!p) return;
      const ok = await confirmDialog('曲を削除しますか', `「${p.name}」を削除します。この操作は取り消せません。`, '削除する', true);
      if (!ok) return;
      await store.deleteProject(id);
      for (const [k, u] of this.unsavedAudio) if (u.projectId === id) this.unsavedAudio.delete(k);
      if (id === this.project.id) {
        const rest = (await store.loadAllProjects()).map(M.normalizeProject).sort((a, b) => b.updatedAt - a.updatedAt);
        let next = rest[0];
        if (!next) { next = M.createProject({ name: '新しい曲' }); await store.saveProject(next); }
        await this.loadProjectData(next);
      }
      toast('曲を削除しました');
    });
  }

  // ---------- 書き出し・読み込み ----------
  openExport() {
    openFileSheet(this, {
      title: '一曲に書き出す',
      note: '全部のトラックを混ぜて、1つの WAV ファイル（16bit・ステレオ）にします。ミュートしたトラックは入りません。',
      makeLabel: '書き出す',
      make: async () => {
        const r = await this.renderWav();
        return r && { blob: r.blob, filename: r.filename, desc: `${r.seconds.toFixed(1)} 秒・${(r.blob.size / 1048576).toFixed(1)} MB` };
      },
      emptyText: '書き出す音がありません。',
    });
  }

  mixdown() { return mixProject(this.project, this.audios, {}); }

  async renderWav() {
    if (!this.project.clips.length) return null;
    await new Promise((r) => setTimeout(r, 20));
    const m = this.mixdown();
    if (!m.left.length) return null;
    const blob = new Blob([encodeWav16([m.left, m.right], m.sampleRate)], { type: 'audio/wav' });
    return { blob, filename: `${safeName(this.project.name)}.wav`, seconds: m.left.length / m.sampleRate };
  }

  /** 端末に保存（ダウンロード）。保存されたかは分からないので、確かめ方を知らせる */
  downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
    return 'downloaded';
  }

  canShare(blob, filename) {
    try { return !!(navigator.canShare && navigator.canShare({ files: [new File([blob], filename, { type: blob.type })] })); } catch { return false; }
  }

  /** 共有。戻り値：'shared' | 'cancelled' | 'failed' */
  async shareBlob(blob, filename) {
    try {
      await navigator.share({ files: [new File([blob], filename, { type: blob.type })], title: this.project.name });
      return 'shared';
    } catch (e) {
      return e && e.name === 'AbortError' ? 'cancelled' : 'failed';
    }
  }

  /** 丸ごと保存のファイルを作る。録音が欠けていたら作らない */
  buildBackup() {
    const ids = [...M.referencedAudioIds([this.project])];
    const audios = ids.map((id) => this.audios.get(id) || (this.unsavedAudio.get(id) || {}).audio);
    const missing = audios.filter((a) => !a).length;
    if (missing) return { error: `この曲の録音が ${missing} 件見つからないため、丸ごと保存を作れませんでした。` };
    const u8 = packBackup(this.project, audios);
    return { blob: new Blob([u8], { type: 'application/octet-stream' }), filename: `${safeName(this.project.name)}.kasane` };
  }

  saveBackup() {
    openFileSheet(this, {
      title: '曲を丸ごと保存',
      note: '曲と録音をまとめた1つのファイル（.kasane）を作ります。「曲の一覧」→「保存ファイルを読み込む」で戻せます。',
      makeLabel: 'ファイルを作る',
      make: async () => {
        await this.flushSave();
        const r = this.buildBackup();
        if (r.error) throw new Error(r.error);
        return { blob: r.blob, filename: r.filename, desc: `${(r.blob.size / 1048576).toFixed(1)} MB` };
      },
    });
  }

  pickBackup() { if (this.guardBusy()) return; $('fileBackup').click(); }
  pickAudio() { if (this.guardBusy()) return; this.engine.ensure().catch(() => {}); $('fileAudio').click(); }

  async loadBackup(file) {
    return this.withSession('load', this.project.id, async () => {
      try {
        const { project, audios } = unpackBackup(await file.arrayBuffer());
        const p = M.normalizeProject(project);
        if (await store.loadProject(p.id)) { p.id = M.newId('p'); p.name = `${p.name}（読み込み）`.slice(0, 60); }
        const toSave = [];
        for (const a of audios) if (!(await store.loadAudio(a.id))) toSave.push(a);
        if (!(await this.saveBeforeSwitch())) return;
        await store.saveProjectWithAudios(p, toSave);
        closeSheet();
        await this.loadProjectData(p);
        toast('曲を読み込みました');
      } catch (e) {
        dialog({ title: '読み込めませんでした', message: store.isQuotaError(e) ? '端末の空き容量が足りません。' : (e.message || String(e)) });
      }
    });
  }

  async importAudio(file) {
    // 読み込む先の曲を最初に決め、終わるまで作業中の印を持つ（その間は録音や曲の切り替えをしない）
    return this.withSession('import', this.project.id, async (s) => {
      try {
        await this.engine.ensure();
        const buf = await file.arrayBuffer();
        const ab = await new Promise((resolve, reject) => {
          const r = this.engine.ctx.decodeAudioData(buf, resolve, reject);
          if (r && r.then) r.then(resolve, reject);
        });
        const n = ab.length;
        const pcm = new Float32Array(n);
        for (let c = 0; c < ab.numberOfChannels; c++) {
          const d = ab.getChannelData(c);
          for (let i = 0; i < n; i++) pcm[i] += d[i] / ab.numberOfChannels;
        }
        if (this.project.id !== s.projectId) throw new Error('曲が切り替わったため、読み込みをやめました');
        const audio = { id: M.newId('a'), sampleRate: ab.sampleRate, length: n, createdAt: Date.now(), pcm };
        const name = file.name.replace(/\.[^.]+$/, '').slice(0, 20) || '読み込んだ音';
        const t = M.addTrack(this.project, { name });
        const r = M.recordClip(t.project, { trackId: t.trackId, start: 0, duration: n / ab.sampleRate, audioId: audio.id, offset: 0 });
        const gen = this.editGen;
        await store.saveProjectWithAudios({ ...r.project, updatedAt: Date.now() }, [audio]);
        this.audios.set(audio.id, audio);
        this.commit(r.project, { force: true });
        if (gen === this.savedGen) this.savedGen = this.editGen;
        closeSheet();
        toast(`「${name}」を新しいトラックに置きました`);
      } catch (e) {
        dialog({ title: '読み込めませんでした', message: store.isQuotaError(e) ? '端末の空き容量が足りません。' : e.message && e.message.includes('切り替わった') ? e.message : 'この音声ファイルは読み込めませんでした。WAV・MP3・M4A などを試してください。' });
      }
    });
  }

  // ---------- 設定 ----------
  async measureLatency() {
    if (this.session) return { ok: false, reason: '録音中は測れません' };
    if (this.engine.playing) this.stopPlay();
    try {
      const r = await this.engine.measureLatency();
      if (!r.ok) return r;
      const correctionMs = r.ms - this.engine.autoLatencySec() * 1000;
      this.setSetting('latencyMs', correctionMs);
      return { ok: true, correctionMs: this.settings.latencyMs, roundTripMs: r.ms };
    } catch (e) {
      const n = e && e.name;
      return { ok: false, reason: n === 'NotAllowedError' ? 'マイクの使用が許可されていません' : (e.message || String(e)) };
    }
  }

  micStatus() {
    const s = this.engine.inputSettings;
    if (!s) return { text: 'まだマイクを使っていません。録音を始めると、ここに状態が出ます。' };
    const on = ['echoCancellation', 'noiseSuppression', 'autoGainControl'].filter((k) => s[k] === true);
    if (on.length) return { warn: true, text: 'この端末では、マイクの音の自動調整（エコーの除去・雑音の除去・音量の自動調整）を切れませんでした。音が加工されることがあります。' };
    return { text: s.test ? 'テスト用の音を入力にしています。' : '音を加工せずに録音しています。' };
  }

  async storageInfo() {
    const est = await store.estimate();
    let persisted = false;
    try { persisted = !!(navigator.storage && navigator.storage.persisted && (await navigator.storage.persisted())); } catch { /* */ }
    const mb = (b) => `${(b / 1048576).toFixed(1)} MB`;
    const usage = est && Number.isFinite(est.usage) ? `使っている量：${mb(est.usage)}${Number.isFinite(est.quota) ? `（使える目安：${mb(est.quota)}）` : ''}。` : '使っている量は、この端末では分かりません。';
    return `${usage}\n${persisted ? '保存は「消されにくい」状態です。' : '保存は、端末の空きが少ないときなどに消されることがあります。大事な曲は書き出しておいてください。'}`;
  }
}

function safeName(name) {
  return (String(name || 'かさね録り').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim() || 'かさね録り').slice(0, 60);
}

const app = new App();
window.addEventListener('DOMContentLoaded', () => app.init());
export default app;
