// testkit.js — ?test=1 のときだけ読み込む。ブラウザのコンソールから通しで確かめるための仕掛け（設計図 §9）。
// 入力はマイクの代わりに、アプリの中で作った音（440Hz の持続音＋AudioContext の時計で録音開始から 0.5 秒ごとのクリック）。

import * as M from './model.js';
import * as H from './history.js';
import * as store from './store.js';
import { decodeWav } from './wav.js';
import { openMixerSheet, openTempoSheet, openSettingsSheet, openMoreSheet, openSongsSheet, openClipSheet, closeSheet, currentSheet } from './ui-sheets.js';

const CLICK_TH = 0.45;

function waitCtx(app, sec) {
  const ctx = app.engine.ctx;
  const end = ctx.currentTime + sec;
  return new Promise((resolve) => {
    const tick = () => (ctx.currentTime >= end ? resolve() : setTimeout(tick, 15));
    tick();
  });
}

function waitUntil(fn, timeoutMs = 20000) {
  const t0 = performance.now();
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (fn()) resolve();
      else if (performance.now() - t0 > timeoutMs) reject(new Error('時間切れ'));
      else setTimeout(tick, 20);
    };
    tick();
  });
}

/** Clip の中のクリックの位置（曲の秒）。録音データの生の値から探す */
function clickTimes(app, clipId) {
  const c = app.project.clips.find((x) => x.id === clipId);
  if (!c) return null;
  const take = M.activeTake(c);
  const a = app.audios.get(take.audioId);
  if (!a) return null;
  const sr = a.sampleRate;
  const i0 = Math.max(0, Math.round(take.offset * sr));
  const i1 = Math.min(a.pcm.length, Math.round((take.offset + c.duration) * sr));
  const out = [];
  const gap = Math.round(0.1 * sr);
  for (let i = i0; i < i1; i++) {
    if (Math.abs(a.pcm[i]) >= CLICK_TH) {
      out.push(c.start + (i / sr - take.offset));
      i += gap;
    }
  }
  return out;
}

function checksum(pcm) {
  let s = 0;
  for (let i = 0; i < pcm.length; i++) s += pcm[i] * ((i % 97) + 1);
  return Math.round(s * 1e4) / 1e4;
}

function rms(a) {
  let s = 0;
  for (let i = 0; i < a.length; i++) s += a[i] * a[i];
  return Math.sqrt(s / Math.max(1, a.length));
}

function nearestDiffs(a, b) {
  return a.map((t) => Math.min(...b.map((u) => Math.abs(u - t))));
}

const ms = (s) => Math.round(s * 100000) / 100;

export function install(app) {
  const k = {
    state() {
      return {
        project: structuredClone(app.project),
        playhead: app.playhead,
        playing: app.engine.playing,
        recording: app.isRecording,
        undo: app.history.past.length,
        redo: app.history.future.length,
        selectedClipId: app.selectedClipId,
        recTrackId: app.recTrackId,
        ctxState: app.engine.ctx ? app.engine.ctx.state : 'none',
        sampleRate: app.engine.ctx ? app.engine.ctx.sampleRate : null,
      };
    },
    clips: () => structuredClone(app.project.clips),
    audio(id) {
      const a = app.audios.get(id);
      return a ? { id: a.id, sampleRate: a.sampleRate, length: a.pcm.length, seconds: a.pcm.length / a.sampleRate, createdAt: a.createdAt } : null;
    },
    audioPcm: (id) => { const a = app.audios.get(id); return a ? a.pcm.slice() : null; },
    async ensure() { await app.engine.ensure(); return app.engine.ctx.state; },
    newProject: () => app.newProject(),
    addTrack() { app.addTrack(); return app.recTrackId; },
    selectTrack: (id) => app.setRecTrack(id),
    setTrack: (id, patch) => app.updateTrack(id, patch),
    setFields: (patch) => app.commitFields(patch),
    setLatency: (v) => app.setSetting('latencyMs', v),
    setTestTone: (hz) => app.engine.setTestTone(hz),
    setLoopback: (on) => { app.engine.testLoopback = !!on; },
    setPlayhead(t) { app.playhead = t; app.timeline.setPlayhead(t); },
    startRecording: (opts = {}) => app.startRecord(app.project.selection && !opts.normal ? { mode: 'punch', range: { ...app.project.selection } } : { mode: 'normal', trackId: opts.trackId }),
    stopRecording: () => app.stopRecord(),
    /** sec 秒（AudioContext の時計）録って止める */
    async record(sec, { from = 0, trackId = null } = {}) {
      k.setPlayhead(from);
      const ok = await app.startRecord({ mode: 'normal', trackId });
      if (!ok) throw new Error('録音を始められませんでした');
      await waitCtx(app, sec);
      const clipId = await app.stopRecord();
      return { clipId, last: app.lastRecord };
    },
    play(from = 0) { k.setPlayhead(from); app.startPlay(from); },
    stop: () => app.stopPlay(),
    setRange: (s, e) => app.commit(M.setSelection(app.project, e == null ? null : { start: s, end: e })),
    /** 範囲の録り直し（範囲の 1 秒後に自動で止まるのを待つ） */
    async punch() {
      const sel = app.project.selection;
      if (!sel) throw new Error('範囲がありません');
      const ok = await app.startRecord({ mode: 'punch', range: { ...sel } });
      if (!ok) throw new Error('録音を始められませんでした');
      await waitUntil(() => !app.session, 30000);
      return app.lastRecord;
    },
    undo: () => app.undo(),
    redo: () => app.redo(),
    /** 書き出しと同じ混ぜ方の結果（Float32Array） */
    exportFloat() { const m = app.mixdown(); return { sampleRate: m.sampleRate, left: m.left, right: m.right }; },
    /** 実際に WAV ファイルを作って読み直した結果 */
    async exportWav() {
      const r = await app.renderWav();
      if (!r) return null;
      const d = decodeWav(await r.blob.arrayBuffer());
      return { sampleRate: d.sampleRate, left: d.channels[0], right: d.channels[1], bytes: r.blob.size, filename: r.filename };
    },
    clickTimes: (clipId) => clickTimes(app, clipId),

    /** ダイアログを全部閉じる（背景を押したのと同じ） */
    closeDialogs() {
      let n = 0;
      for (const b of document.querySelectorAll('.dialog-backdrop')) { b.click(); n++; }
      return n;
    },
    async pendingCount() { return (await store.loadPending()).length; },

    /** ダイアログの中のボタンを押す（文言で探す）。見つかるまで待つ */
    async clickDialog(title, label, timeoutMs = 8000) {
      let btn = null;
      await waitUntil(() => {
        const d = [...document.querySelectorAll('.dialog')].find((x) => x.textContent.includes(title));
        btn = d && [...d.querySelectorAll('button')].find((b) => b.textContent === label);
        return !!btn;
      }, timeoutMs);
      btn.click();
      return true;
    },

    /** Codex レビュー 2 回目の直しを、画面の中で確かめる */
    async review2Steps(step, { track1 }) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      const { encodeWav16 } = await import('./wav.js');

      // 追加1 音源の読み込み中は、録音・曲の切り替えをしない。読み込みは始めた曲に入る
      const pidA = app.project.id;
      const pcm = new Float32Array(48000).map((_, i) => Math.sin(i / 30) * 0.2);
      const file = new File([encodeWav16([pcm], 48000)], '読み込み.wav', { type: 'audio/wav' });
      const imp = app.importAudio(file);
      const recDuring = await app.startRecord({ mode: 'normal' });
      const switchDuring = await app.newProject();
      await imp;
      const importedHere = app.project.id === pidA && app.project.tracks.some((t) => t.name === '読み込み');
      step('追加1 音源の読み込み中は録音・曲の切り替えを止め、始めた曲に入る', recDuring === false && switchDuring === false && importedHere && !app.session, { recDuring, switchDuring, importedHere });
      app.undo();
      await app.flushSave();

      // 追加10 保存に失敗した編集が残っていれば、曲を切り替えない
      app.testHooks.failSaves = 2; // 1回目＝flushSave、2回目＝切り替え前の保存
      app.commit(M.setProjectFields(app.project, { name: `${app.project.name}・改` }));
      const flushed = await app.flushSave();
      const blocked = (await app.newProject()) === false;
      k.closeDialogs();
      const flushed2 = await app.flushSave();
      step('追加10 保存に失敗した編集があれば未保存のまま扱い、曲を切り替えない', flushed === false && blocked && flushed2 === true && !app.hasUnsaved(), { flushed, blocked, flushed2 });

      // 追加7 書き出しても、このアプリの中に保存できるまでは持ち続ける
      app.testHooks.failSaves = 1000;
      const r7 = await k.record(0.6, { from: 0, trackId: track1 });
      k.closeDialogs();
      const aid = app.lastRecord.audioId;
      app.markExported(aid);
      const keptAfterExport = app.unsavedAudio.has(aid) && app.unsavedAudio.get(aid).exported === true;
      app.testHooks.failSaves = 0;
      const saved7 = await app.flushSave();
      const stored7 = await store.loadAudio(aid);
      step('追加7 書き出しても保存対象から外さず、保存できたら外す', keptAfterExport && saved7 && !!stored7 && !app.unsavedAudio.has(aid), { keptAfterExport, saved7, audioStored: !!stored7 });
      void r7;

      // 追加8・9 止める処理で例外が起きても作業中の印が解ける。控えは最後の断片まで書かれ、欠けなく戻せる
      app.testHooks.failPending = 3; // 情報と最初の断片の保存を何度か失敗させる
      const orig = app.engine.stopRecording;
      app.engine.stopRecording = async function () { await orig.call(this); throw new Error('テスト用の停止の失敗'); };
      k.setPlayhead(0);
      await app.startRecord({ mode: 'normal', trackId: track1 });
      await waitCtx(app, 4.6);
      const warned = [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('録音の控えを保存できていません'));
      const startCtx = app.recState.rec.T0;
      const stopRet = await app.stopRecord();
      const stopCtx = app.engine.ctx.currentTime;
      app.engine.stopRecording = orig;
      const unlocked = !app.session && !app.isRecording && !app.recState;
      await k.clickDialog('録音を止めるときに問題', 'OK').catch(() => {});
      const pend8 = await store.loadPending();
      const g8 = pend8.find((x) => x.meta);
      const asm = g8 ? M.assemblePending(g8.chunks, g8.meta.sampleRate) : null;
      step('追加8 止める処理で例外が起きても、作業中・録音中の印が解ける', stopRet === null && unlocked, { stopRet, session: !!app.session, isRecording: app.isRecording });
      step('追加9 控えの保存の失敗を一度知らせ、最後の断片まで書く（欠けなし）', warned && !!g8 && asm.gapSec === 0 && asm.pcm.length / g8.meta.sampleRate > stopCtx - startCtx - 0.3, { warned, pendingGroups: pend8.length, gapSec: asm && asm.gapSec, pendingSec: asm && asm.pcm.length / g8.meta.sampleRate, recordedAbout: stopCtx - startCtx });
      // 控えから戻せる
      const rec8 = app.offerRecovery();
      await k.clickDialog('前回の録音が残っています', '曲に戻す');
      await rec8;
      const c8 = app.lastRecovered && app.project.clips.find((c) => c.id === app.lastRecovered.clipId);
      step('追加8b 止める処理で失敗した録音も、控えから曲に戻せる', !!c8 && (await k.pendingCount()) === 0, { duration: c8 && c8.duration });

      // 追加3 同じ控えは二度戻さない
      const sr = 48000;
      const mkPending = async (projectId) => {
        const sid = M.newId('r');
        await store.putPending({ key: `${sid}:meta`, sid, kind: 'meta', meta: { projectId, trackId: 'nope', mode: 'normal', recordStart: 0, range: null, transportFrom: 0, T0: 0, sampleRate: sr, latencySec: 0, createdAt: Date.now() } });
        await store.putPending({ key: `${sid}:000001`, sid, kind: 'chunk', parts: [{ frame: 0, data: new Float32Array(sr).fill(0.1) }] });
        return sid;
      };
      const sid3 = await mkPending(app.project.id);
      const g3 = (await store.loadPending()).find((g) => g.sid === sid3);
      const first3 = await app.recoverPending(g3);
      const clips3 = app.project.clips.length;
      const second3 = await app.recoverPending(g3);
      step('追加3 同じ控えは二度戻さない', !!first3 && second3 === null && app.project.clips.length === clips3, { first: !!first3, second: second3 });

      // 追加5 元の曲が無い控えは、新しい曲「復旧した録音」に戻す（今の曲へは入れない）
      const curId = app.project.id;
      const curClips = JSON.stringify(app.project.clips);
      const sid5 = await mkPending('p_deleted_song');
      const g5 = (await store.loadPending()).find((g) => g.sid === sid5);
      await app.recoverPending(g5);
      const newSong = app.lastRecovered && app.lastRecovered.newSong;
      const intoNew = app.project.id !== curId && app.project.name === '復旧した録音' && app.project.clips.length === 1;
      const curStored = M.normalizeProject(await store.loadProject(curId));
      step('追加5 元の曲が無い録音は新しい曲「復旧した録音」に戻し、今の曲は変えない', newSong && intoNew && JSON.stringify(curStored.clips) === curClips, { newSong, songName: app.project.name });
      await app.openProject(curId);

      // 追加12 今の位置に録音が無いテイクへは切り替えない（テイクを2つにして、1つ目の録音を短いことにする）
      const base12 = app.project.clips[0];
      app.commit(M.addTake(app.project, base12.id, base12.takes[0].audioId, base12.takes[0].offset));
      const saved12 = app.audioSecOf;
      app.audioSecOf = () => 0.001;
      const before12 = JSON.stringify(app.project.clips);
      const r12 = app.setActiveTake(base12.id, 0);
      app.audioSecOf = saved12;
      const shown12 = [...document.querySelectorAll('.toast')].some((t) => t.textContent.includes('このテイクには、今の位置の録音がありません'));
      const same12 = JSON.stringify(app.project.clips) === before12;
      app.undo();
      step('追加12 録音が無いテイクへは切り替えず、知らせる', r12 === false && same12 && shown12, { result: r12, unchanged: same12, shown: shown12 });

      // 追加11 低い倍率・離れた位置でも描き直しが止まる（幅 375・6px/秒・40 秒）
      const ppsKeep = app.timeline.pps;
      let err11 = null;
      try {
        app.timeline.pps = 6;
        app.playhead = 40;
        app.render();
        app.timeline.setPlayhead(40);
        app.timeline.setPlayhead(40);
      } catch (e) { err11 = String(e); }
      const w11 = app.timeline.contentW;
      app.timeline.pps = ppsKeep;
      app.playhead = 0;
      app.render();
      step('追加11 幅 375・6px/秒・40 秒で描き直しが止まる', !err11 && w11 >= 40 * 6 + 200, { error: err11, contentW: w11, viewport: document.documentElement.clientWidth });

      // 1画面だけ：この画面は排他ロックを持っている
      step('1画面だけ：この画面が排他ロックを持ち、掃除はロックがあるときだけ', app.instance === 'locked' && (await app.sweepSafely()) === 'swept', { instance: app.instance });
      await sleep(10);
    },
    /** Codex レビュー 1 回目の直しを、画面の中で確かめる（runAll の後半） */
    async reviewSteps(step, { track1, track2, r4 }) {
      const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
      // 21 テイクの表示を押すと、テイクの一覧が出る
      app.render();
      const badge = document.querySelector(`.clip[data-clip="${r4.clipId}"] .take-badge`);
      if (badge) badge.click();
      const sh = currentSheet();
      step('21 テイクの表示を押すとテイクの一覧が出る', !!badge && sh && String(sh.id).startsWith('takes:'), { sheet: sh && sh.id });
      closeSheet();

      // 12 全体の音量が再生に効く
      app.commitMaster(0);
      k.play(0); await sleep(150);
      const g0 = app.engine.master.gain.value;
      k.stop();
      app.commitMaster(1);
      k.play(0); await sleep(150);
      const g1 = app.engine.master.gain.value;
      k.stop();
      step('12 全体の音量が再生に効く（0 → 1）', g0 === 0 && Math.abs(g1 - 1) < 1e-6, { gainAtZero: g0, gainAtOne: g1 });

      // 13 メトロノームの同じ拍を二度予約しない
      app.engine.metroLog = [];
      app.commitFields({ metronomeOn: true });
      k.play(0); await waitCtx(app, 2.2);
      k.stop();
      app.commitFields({ metronomeOn: false });
      const log = app.engine.metroLog;
      app.engine.metroLog = null;
      const ks = log.map((x) => x.k);
      const gaps = log.slice(1).map((x, i) => x.when - log[i].when);
      step('13 メトロノームの拍は一度ずつだけ予約される', log.length >= 4 && new Set(ks).size === ks.length && gaps.every((d) => Math.abs(d - 0.5) < 1e-6), { scheduled: log.length, beats: ks.join(','), minGap: Math.min(...gaps), maxGap: Math.max(...gaps) });

      // 17 再生中の「再生位置で分ける」は聞こえている位置で分ける
      const c1 = app.project.clips.filter((c) => c.trackId === track2).sort((a, b) => b.duration - a.duration)[0];
      k.play(0); await waitCtx(app, 0.9);
      const heard = app.engine.songPos();
      app.splitClipAtPlayhead(c1.id);
      k.stop();
      const left = app.project.clips.find((c) => c.id === c1.id);
      step('17 再生中は聞こえている位置で分ける', left && Math.abs(M.clipEnd(left) - heard) < 0.06, { splitAt: left && M.clipEnd(left), heard });
      app.undo();

      // 15 範囲をなぞる途中で2本目の指を置くと、なぞる前に戻り、取り消しの基準も残らない
      const selBefore = JSON.stringify(app.project.selection);
      const undoBefore = app.history.past.length;
      app.liveSelection({ start: 0.1, end: 1.9 });
      app.timeline.g = { id: 1, type: 'range', active: true };
      const t = { clientX: 10, clientY: 10 };
      app.timeline.onTouchStart({ touches: [t, { clientX: 60, clientY: 10 }], preventDefault() {} });
      app.timeline.pinch = null;
      step('15 ピンチに切り替えると範囲の操作は取りやめになる', app.liveBase === null && JSON.stringify(app.project.selection) === selBefore && app.history.past.length === undoBefore, { selection: app.project.selection });

      // 14 録音中にタイムラインが先へ伸びる
      app.timeline.recStart(track1, 0, '#e5484d');
      app.timeline.recUpdate(40, null, 48000, 0);
      const widthSec = app.timeline.contentW / app.timeline.pps;
      app.timeline.recEnd();
      app.render();
      step('14 録音の終わりに合わせてタイムラインが伸びる', widthSec >= 60, { widthSec: Math.round(widthSec) });

      // 6 範囲の録り直しで隠れたフレーズは残り、戻せる
      const t2clip = app.project.clips.filter((c) => c.trackId === track2).sort((a, b) => a.start - b.start)[0];
      app.setRecTrack(track2);
      k.setRange(Math.max(0, t2clip.start - 0.1), M.clipEnd(t2clip) + 0.1);
      await k.punch();
      k.closeDialogs();
      const shelved = (app.project.shelved || []).find((c) => c.id === t2clip.id);
      const tracksBefore = app.project.tracks.length;
      app.restoreShelved(t2clip.id);
      const restored = app.project.clips.find((c) => c.id === t2clip.id);
      step('6 隠れたフレーズは残り、新しいトラックの元の位置に戻せる', !!shelved && !!restored && restored.trackId !== track2 && restored.start === t2clip.start && app.project.tracks.length === tracksBefore + 1 && M.referencedAudioIds([app.project]).has(t2clip.takes[0].audioId), { shelved: !!shelved, restoredStart: restored && restored.start });
      app.undo();
      const backShelved = (app.project.shelved || []).some((c) => c.id === t2clip.id);
      step('6b 戻したのを取り消すと、また隠れた状態に戻る', backShelved && app.project.tracks.length === tracksBefore, {});
      k.setRange(null);
      app.setRecTrack(track1);

      // 10 範囲の録り直しにも 10 分の上限（ここでは 2.5 秒にして確かめる）
      app.maxRecSec = 2.5;
      k.setRange(0.5, 3.0);
      const r10 = await k.punch();
      app.maxRecSec = 600;
      k.closeDialogs();
      const pc10 = app.project.clips.find((c) => c.id === r10.clipId);
      step('10 範囲の録り直しも上限で止まり、録れた分は置かれる', r10.reason === 'limit' && pc10 && Math.abs(pc10.start - 0.5) < 1e-9 && pc10.duration > 0.3 && pc10.duration < 0.7, { reason: r10.reason, duration: pc10 && pc10.duration });
      app.undo();
      k.setRange(null);

      // 1 録音中は、曲の切り替え・次の録音・編集ができない。結果は開始時の曲に入る
      const pid = app.project.id;
      k.setPlayhead(0);
      await app.startRecord({ mode: 'normal', trackId: track1 });
      await waitCtx(app, 0.6);
      const newOk = await app.newProject();
      const secondRec = await app.startRecord({ mode: 'normal' });
      const editOk = app.commit(M.setProjectFields(app.project, { bpm: 99 }));
      const stopP = app.stopRecord();
      const duringSave = await app.newProject();
      await stopP;
      const landed = app.project.id === pid && app.project.clips.some((c) => c.id === app.lastRecord.clipId);
      const stored = M.normalizeProject(await store.loadProject(pid));
      step('1 録音〜保存の間は曲の切り替え・次の録音・編集を止め、結果は開始時の曲に入る', newOk === false && secondRec === false && editOk === false && duringSave === false && landed && stored.clips.some((c) => c.id === app.lastRecord.clipId) && app.lastRecord.saved, { newOk, secondRec, editOk, duringSave, landed });
      app.undo();
      await app.saveNow();

      // 2・3 保存できない録音は持ち続け、曲と一緒に保存する。保存できるまで曲は切り替えない
      app.testHooks.failSaves = 1000;
      const rr = await k.record(0.8, { from: 0, trackId: track1 });
      k.closeDialogs();
      const notSaved = app.lastRecord.saved === false && app.unsavedAudio.has(app.lastRecord.audioId);
      const pend1 = await k.pendingCount();
      const switched = await app.newProject();
      k.closeDialogs();
      app.testHooks.failSaves = 0;
      const retried = await app.retryUnsaved();
      const storedP = M.normalizeProject(await store.loadProject(app.project.id));
      const storedA = await store.loadAudio(app.lastRecord.audioId);
      const pend2 = await k.pendingCount();
      step('2・3 保存できない録音は持ち続け、曲と一緒に保存する', notSaved && pend1 >= 1 && switched === false && retried && app.unsavedAudio.size === 0 && !!storedA && storedP.clips.some((c) => c.id === rr.clipId) && pend2 === 0, { notSaved, pendingWhileUnsaved: pend1, switched, retried, pendingAfter: pend2, audioStored: !!storedA });

      // 8 録音が欠けた曲は丸ごと保存を作らない
      const someId = [...M.referencedAudioIds([app.project])][0];
      const keepA = app.audios.get(someId);
      app.audios.delete(someId);
      const bad = app.buildBackup();
      app.audios.set(someId, keepA);
      const good = app.buildBackup();
      step('8 録音が欠けていたら丸ごと保存を作らない', !!bad.error && !good.error && good.blob.size > 0, { error: bad.error });

      // 20 補正のつまみを動かした後の ±ボタン
      const sheet = openSettingsSheet(app);
      const range = sheet.body.querySelector('input[type="range"]');
      range.value = '150';
      range.dispatchEvent(new Event('input'));
      range.dispatchEvent(new Event('change'));
      const plus = [...currentSheet().body.querySelectorAll('button')].find((b) => b.textContent === '+1');
      plus.click();
      const after20 = app.settings.latencyMs;
      closeSheet();
      app.setSetting('latencyMs', 0);
      step('20 つまみの後に +1 を押すと 151ms になる', after20 === 151, { value: after20 });

      // 11 曲を切り替えたら再生用のバッファを手放す
      const before11 = app.engine.buffers.size;
      const pidKeep = app.project.id;
      await app.newProject();
      const after11 = app.engine.buffers.size;
      await app.openProject(pidKeep);
      step('11 曲を切り替えると再生用のバッファを手放す', before11 > 0 && after11 === 0, { before: before11, after: after11 });

      // 4 ほかの画面が開いているときは掃除しない（この画面が「開いている」印を持っている）
      const keepInst = app.instance;
      app.instance = 'unknown';
      const sw = await app.sweepSafely();
      app.instance = keepInst;
      step('4 この画面だけと確かめられないときは掃除をしない', sw === 'skipped', { sweep: sw });
    },

    /** 5 の確かめ（1）：録音を始めて sec 秒たったら、画面が閉じられたことにする（保存しない） */
    async crashDuringRecording(sec = 3) {
      k.setPlayhead(0);
      const ok = await app.startRecord({ mode: 'normal' });
      if (!ok) throw new Error('録音を始められませんでした');
      await waitCtx(app, sec);
      app.testHooks.ignoreHide = true;
      const st = app.recState;
      await app.flushPending(st);
      localStorage.setItem('kasane-test.crash', JSON.stringify({ projectId: app.project.id, sec, sid: st.sid }));
      return { pending: await k.pendingCount(), sid: st.sid };
    },
    /** 5 の確かめ（2）：開き直した後に呼ぶ。復旧を聞かれているか、戻すと Clip になるか */
    async crashCheck() {
      const info = JSON.parse(localStorage.getItem('kasane-test.crash') || 'null');
      const dlg = [...document.querySelectorAll('.dialog')].find((d) => d.textContent.includes('前回の録音が残っています'));
      if (!dlg) return { ok: false, reason: '復旧のダイアログが出ていません', info };
      [...dlg.querySelectorAll('button')].find((b) => b.textContent === '曲に戻す').click();
      await waitUntil(() => !!app.lastRecovered, 10000);
      const c = app.project.clips.find((x) => x.id === app.lastRecovered.clipId);
      const pend = await k.pendingCount();
      const stored = M.normalizeProject(await store.loadProject(app.project.id));
      return {
        ok: !!c && app.project.id === info.projectId && c.duration > info.sec - 2.1 && c.duration <= info.sec + 0.3 && pend === 0 && stored.clips.some((x) => x.id === c.id),
        duration: c && c.duration, expectedAbout: info.sec, sameProject: app.project.id === info.projectId, pendingLeft: pend,
      };
    },
    /** 閉じる前に呼ぶ：今の曲と録音の指紋を残す */
    async fingerprint() {
      await app.flushSave();
      const fp = {
        projectId: app.project.id,
        clips: JSON.stringify(app.project.clips),
        tracks: JSON.stringify(app.project.tracks),
        audios: [...M.referencedAudioIds([app.project])].sort().map((id) => {
          const a = app.audios.get(id);
          return { id, length: a ? a.pcm.length : -1, sum: a ? checksum(a.pcm) : null };
        }),
      };
      localStorage.setItem('kasane-test.fingerprint', JSON.stringify(fp));
      return { saved: true, clips: app.project.clips.length, audios: fp.audios.length };
    },
    /** 開き直した後に呼ぶ：指紋と同じ曲・録音が残っているか */
    async reloadCheck() {
      const fp = JSON.parse(localStorage.getItem('kasane-test.fingerprint') || 'null');
      if (!fp) return { ok: false, reason: '指紋がありません（先に fingerprint() を呼ぶ）' };
      const stored = await store.loadProject(fp.projectId);
      const p = app.project;
      const res = {
        sameProjectOpen: p.id === fp.projectId,
        clipsSame: JSON.stringify(p.clips) === fp.clips,
        tracksSame: JSON.stringify(p.tracks) === fp.tracks,
        storedClipsSame: !!stored && JSON.stringify(M.normalizeProject(stored).clips) === fp.clips,
        audios: [],
      };
      for (const f of fp.audios) {
        const a = await store.loadAudio(f.id);
        res.audios.push({ id: f.id, ok: !!a && a.pcm.length === f.length && checksum(a.pcm) === f.sum });
      }
      res.ok = res.sameProjectOpen && res.clipsSame && res.tracksSame && res.storedClipsSame && res.audios.every((x) => x.ok);
      return res;
    },

    /** 横にはみ出していないか、押すものが 44px 以上か。sheets=true でシートも開いて調べる */
    async layoutCheck({ sheets = true } = {}) {
      const vw = document.documentElement.clientWidth;
      const one = (where) => {
        const small = [];
        const outside = [];
        const nodes = document.querySelectorAll('button, [role="button"], input, select, a[href], [role="switch"], .sel-handle, .clip-handle');
        for (const el of nodes) {
          if (el.closest('[hidden]') || el.type === 'file') continue;
          const r = el.getBoundingClientRect();
          if (!r.width && !r.height) continue;
          const inTimeline = !!el.closest('.timeline');
          if (el.classList.contains('clip')) continue; // フレーズは長さで幅が変わる（中身）
          if (r.width < 43.5 || r.height < 43.5) small.push({ where, el: describe(el), w: Math.round(r.width), h: Math.round(r.height) });
          if (!inTimeline && (r.right > vw + 0.5 || r.left < -0.5)) outside.push({ where, el: describe(el), left: Math.round(r.left), right: Math.round(r.right) });
        }
        return { small, outside, docScrollW: document.documentElement.scrollWidth, bodyScrollW: document.body.scrollWidth };
      };
      const results = [one('画面')];
      if (sheets) {
        const firstClip = app.project.clips[0];
        const openers = [
          ['ミキサー', () => openMixerSheet(app)],
          ['テンポ', () => openTempoSheet(app)],
          ['その他', () => openMoreSheet(app)],
          ['設定', () => openSettingsSheet(app)],
          ['曲の一覧', () => openSongsSheet(app)],
        ];
        if (firstClip) openers.push(['フレーズ', () => { app.selectedClipId = firstClip.id; app.render(); openClipSheet(app, firstClip.id); }]);
        for (const [name, open] of openers) {
          open();
          await new Promise((r) => setTimeout(r, 250));
          results.push(one(name));
          closeSheet();
        }
      }
      const small = results.flatMap((r) => r.small);
      const outside = results.flatMap((r) => r.outside);
      const overflow = results.some((r) => r.docScrollW > vw || r.bodyScrollW > vw);
      return { ok: !small.length && !outside.length && !overflow, viewport: vw, overflow, small, outside };
    },

    /** §9 の 1〜5 を通しで回す。結果を返す（6 は fingerprint→開き直し→reloadCheck、7 は layoutCheck） */
    async runAll({ recSec = 2.0 } = {}) {
      const report = { steps: [] };
      const step = (name, ok, detail) => { report.steps.push({ name, ok: !!ok, ...detail }); return ok; };
      await app.engine.ensure();
      if (app.engine.ctx.state !== 'running') return { ok: false, reason: `AudioContext が動いていません（state=${app.engine.ctx.state}）。画面を一度押してから呼んでください` };
      app.setSetting('latencyMs', 0);
      app.setSetting('preroll', 2);
      app.engine.testLoopback = false;
      app.engine.setTestTone(440);
      await app.newProject();
      app.commitFields({ metronomeOn: false });
      report.sampleRate = app.engine.ctx.sampleRate;

      // 1. 録音すると Clip ができ、長さが録った時間と合う（±50ms）
      const r1 = await k.record(recSec, { from: 0 });
      const c1 = app.project.clips.find((c) => c.id === r1.clipId);
      const expected1 = r1.last.stopSong - 0;
      const clicks1 = clickTimes(app, r1.clipId);
      const gridErr1 = Math.max(...clicks1.map((t) => Math.abs(t - Math.round(t / 0.5) * 0.5)));
      step('1 録音で Clip ができ、長さが合う', c1 && Math.abs(c1.duration - expected1) <= 0.05, {
        clipStart: c1 && c1.start, clipDuration: c1 && c1.duration, recordedFor: expected1, diffMs: c1 && ms(c1.duration - expected1),
        clicks: clicks1.length, clickGridMaxErrMs: ms(gridErr1),
      });
      const track1 = c1.trackId;

      // 2. 重ねて録った Clip の位置が合う（補正0で ±5ms）
      app.addTrack();
      const track2 = app.recTrackId;
      const r2 = await k.record(recSec, { from: 0, trackId: track2 });
      const clicks2 = clickTimes(app, r2.clipId);
      const d2 = nearestDiffs(clicks2, clicks1);
      const ok2a = clicks2.length >= 3 && Math.max(...d2) <= 0.005;
      step('2a 重ね録り（時計のクリック）の位置が1本目と合う', ok2a, { clicks: clicks2.length, maxDiffMs: ms(Math.max(...d2)) });
      // 2b. 再生している音そのものを録る（聞いていた音＝録った音か）
      app.addTrack();
      const track3 = app.recTrackId;
      app.engine.testLoopback = true;
      app.updateTrack(track2, { mute: true });
      const r3 = await k.record(recSec, { from: 0, trackId: track3 });
      app.engine.testLoopback = false;
      const clicks3 = clickTimes(app, r3.clipId);
      const d3 = nearestDiffs(clicks3, clicks1);
      step('2b 再生していた音を録ると、元の音と同じ位置に置かれる', clicks3.length >= 3 && Math.max(...d3) <= 0.005, { clicks: clicks3.length, maxDiffMs: ms(Math.max(...d3)) });
      // 2b のぶん（トラック3・ミュート）を取り消しで戻す
      app.undo(); app.undo(); app.undo();
      step('2c 取り消しで 2b の前に戻る', app.project.tracks.length === 2 && app.project.clips.length === 2 && !app.project.tracks.find((t) => t.id === track2).mute, { tracks: app.project.tracks.length, clips: app.project.clips.length });

      // 3. 範囲の録り直しで、範囲の外の音が1サンプルも変わらない
      app.setRecTrack(track1);
      const range = { start: 0.75, end: 1.25 };
      k.setRange(range.start, range.end);
      const beforeClips = JSON.stringify(app.project.clips);
      const before = app.mixdown();
      app.engine.setTestTone(660);
      const r4 = await k.punch();
      app.engine.setTestTone(440);
      const after = app.mixdown();
      const sr = before.sampleRate;
      const s = Math.round(range.start * sr);
      const e = Math.round(range.end * sr);
      let outside = 0;
      let inside = 0;
      const n = Math.max(before.left.length, after.left.length);
      for (let i = 0; i < n; i++) {
        const diff = before.left[i] !== after.left[i] || before.right[i] !== after.right[i];
        if (!diff) continue;
        if (i < s || i >= e) outside++; else inside++;
      }
      const pc = app.project.clips.find((c) => c.id === r4.clipId);
      step('3 範囲の録り直しで、範囲の外は1サンプルも変わらない', outside === 0 && inside > 0 && before.left.length === after.left.length && pc && Math.abs(pc.start - range.start) < 1e-9 && Math.abs(pc.duration - 0.5) < 1e-9, {
        changedOutside: outside, changedInside: inside, lengthBefore: before.left.length, lengthAfter: after.left.length, punchClip: pc && { start: pc.start, duration: pc.duration, takes: pc.takes.length },
      });
      // 同じ範囲をもう一度 → テイクが増える
      const r5 = await k.punch();
      const pc2 = app.project.clips.find((c) => c.id === r5.clipId);
      const after2 = app.mixdown();
      let outside2 = 0;
      for (let i = 0; i < after2.left.length; i++) if ((i < s || i >= e) && after2.left[i] !== before.left[i]) outside2++;
      step('3b 同じ範囲をもう一度録るとテイクが足される', r5.addedTake && pc2.takes.length === 2 && r5.clipId === r4.clipId && outside2 === 0, { takes: pc2.takes.length, changedOutside: outside2 });

      // 4. 取り消しで録り直す前に戻る
      app.undo();
      const t1 = app.project.clips.find((c) => c.id === r4.clipId);
      app.undo();
      const back = app.mixdown();
      let diffBack = 0;
      for (let i = 0; i < before.left.length; i++) if (back.left[i] !== before.left[i]) diffBack++;
      step('4 取り消しで録り直す前に戻る', t1 && t1.takes.length === 1 && JSON.stringify(app.project.clips) === beforeClips && diffBack === 0, { takesAfterFirstUndo: t1 && t1.takes.length, samplesDifferent: diffBack });
      app.redo(); app.redo();
      step('4b やり直しで録り直した後に戻る', app.project.clips.find((c) => c.id === r4.clipId).takes.length === 2, {});

      // 5. ミュート・ソロ・音量が書き出した WAV に反映される
      const full = await k.exportWav();
      app.updateTrack(track2, { mute: true });
      const muted = await k.exportWav();
      app.updateTrack(track2, { mute: false });
      app.updateTrack(track1, { solo: true });
      const solo = await k.exportWav();
      app.updateTrack(track1, { solo: false });
      app.updateTrack(track2, { mute: true });
      app.updateTrack(track1, { gain: 0.5 });
      const half = await k.exportWav();
      app.updateTrack(track1, { gain: 1 });
      app.updateTrack(track2, { mute: false });
      const sameAs = (a, b) => a.left.length === b.left.length && a.left.every((v, i) => v === b.left[i]) && a.right.every((v, i) => v === b.right[i]);
      const ratio = rms(half.left) / rms(muted.left);
      step('5 ミュート・ソロ・音量が WAV に反映される', sameAs(muted, solo) && !sameAs(full, muted) && Math.abs(ratio - 0.5) < 0.01 && full.sampleRate === sr, {
        muteEqualsSolo: sameAs(muted, solo), fullDiffersFromMuted: !sameAs(full, muted), halfGainRmsRatio: Math.round(ratio * 10000) / 10000, wavBytes: full.bytes, wavRate: full.sampleRate,
      });

      await k.reviewSteps(step, { track1, track2, r4 });
      await k.review2Steps(step, { track1 });
      report.ok = report.steps.every((x) => x.ok);
      report.historyDepth = H.canUndo(app.history) ? app.history.past.length : 0;
      return report;
    },
  };

  function describe(el) {
    const label = el.getAttribute('aria-label') || (el.textContent || '').trim().slice(0, 20);
    return `${el.tagName.toLowerCase()}${el.className && typeof el.className === 'string' ? '.' + el.className.split(' ').filter(Boolean).join('.') : ''}「${label}」`;
  }

  window.__kasane = k;
  document.documentElement.dataset.kasaneTest = 'ready';
}
