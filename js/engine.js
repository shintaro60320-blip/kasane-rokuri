// engine.js — 再生・録音・メトロノーム（Web Audio）。
// 音の流れ：Clip の音 → フェード → Clip の音量 → トラックの音量 → 左右 → 鳴る/鳴らない → 全体の音量 → 出力

import { scheduleSegments, audible, projectEnd, envelopePoints, beatSec, nextBeats, firstBeatIndex } from './model.js';

const TEST_CLICK_EVERY = 0.5;   // テストの入力：録音開始から 0.5 秒ごとにクリック
const TEST_TONE_HZ = 440;

export class Engine {
  constructor({ testMode = false } = {}) {
    this.testMode = testMode;
    this.ctx = null;
    this.buffers = new Map();     // audioId → AudioBuffer
    this.session = null;          // 再生中の情報
    this.rec = null;              // 録音中の情報
    this.inputNode = null;
    this.inputStream = null;
    this.inputSettings = null;
    this.workletOk = false;
    this.testToneHz = TEST_TONE_HZ;
    this.testLoopback = false;
  }

  /** 利用者の操作の中で呼ぶ（iPhone は最初のタップで resume が要る） */
  async ensure() {
    if (!this.ctx) {
      const AC = globalThis.AudioContext || globalThis.webkitAudioContext;
      if (!AC) throw new Error('この端末のブラウザは音の機能に対応していません');
      this.ctx = new AC({ latencyHint: 'interactive' });
      // 止まってから動き直したときも、時計が落ち着くのをもう一度待つ（_settle）
      this.ctx.addEventListener('statechange', () => { if (this.ctx.state !== 'running') this._settledCtx = null; });
      const p = this.ctx.resume(); // 待たずに呼ぶ（操作の直後に呼ぶ必要がある）
      this.master = this.ctx.createGain();
      this.master.connect(this.ctx.destination);
      this.metroOut = this.ctx.createGain();
      this.metroOut.gain.value = 0.5;
      this.metroOut.connect(this.ctx.destination);
      this.silent = this.ctx.createGain();
      this.silent.gain.value = 0;
      this.silent.connect(this.ctx.destination);
      try {
        if (this.ctx.audioWorklet) {
          await this.ctx.audioWorklet.addModule(new URL('./recorder-worklet.js', import.meta.url));
          this.workletOk = true;
        }
      } catch { this.workletOk = false; }
      await p.catch(() => {});
    }
    if (this.ctx.state !== 'running') { try { await this.ctx.resume(); } catch { /* 次の操作で再び試す */ } }
    return this.ctx;
  }

  get ready() { return !!this.ctx && this.ctx.state === 'running'; }
  get sampleRate() { return this.ctx ? this.ctx.sampleRate : 48000; }

  /** 端末が教えてくれる出力側の遅れ（秒）。テストのときは 0 */
  autoLatencySec() {
    if (this.testMode || !this.ctx) return 0;
    const out = Number.isFinite(this.ctx.outputLatency) ? this.ctx.outputLatency : 0;
    const base = Number.isFinite(this.ctx.baseLatency) ? this.ctx.baseLatency : 0;
    const inp = this.inputSettings && Number.isFinite(this.inputSettings.latency) ? this.inputSettings.latency : 0;
    return out + base + inp;
  }

  /** 今の曲で使わない再生用のバッファを手放す（メモリを守る） */
  releaseBuffers(keepIds) {
    for (const id of [...this.buffers.keys()]) if (!keepIds.has(id)) this.buffers.delete(id);
  }

  /** 全体の音量をすぐに合わせる */
  setMaster(gain) {
    if (!this.ctx) return;
    const g = this.master.gain;
    g.cancelScheduledValues(this.ctx.currentTime);
    g.setValueAtTime(gain, this.ctx.currentTime);
  }

  getBuffer(audio) {
    let b = this.buffers.get(audio.id);
    if (!b) {
      b = this.ctx.createBuffer(1, Math.max(1, audio.pcm.length), audio.sampleRate);
      b.copyToChannel(audio.pcm, 0);
      this.buffers.set(audio.id, b);
    }
    return b;
  }

  // ---------------- 再生 ----------------

  /**
   * from（曲の秒）から鳴らす。loop: {start,end} | null。exclude: 録音先の鳴らさない範囲。
   * 戻り値：再生が始まる AudioContext の時刻
   */
  play({ project, audios, from = 0, loop = null, exclude = null, metronome = false, autoEnd = true, onEnd = null, lead = 0.06 }) {
    this.stop();
    this.stopPreview();
    const ctx = this.ctx;
    this.setMaster(project.masterGain);
    // 再生用のバッファは、始まる時刻を決める前に作っておく。
    // 後から作ると、作るのに時間がかかった分だけ音が遅れて鳴り、重ね録りの位置がずれる。
    for (const c of project.clips) {
      const take = c.takes && c.takes[c.activeTake];
      const audio = take && audios.get(take.audioId);
      if (audio) this.getBuffer(audio);
    }
    const T0 = ctx.currentTime + lead;
    const s = {
      project, audios, loop, exclude, metronome, onEnd,
      passes: [{ ctx: T0, song: from, until: loop ? loop.end : Infinity }],
      sources: [],
      clipGains: new Map(),
      tracks: new Map(),
      timer: 0,
    };
    for (const t of project.tracks) s.tracks.set(t.id, this._trackChain(t, project));
    this.session = s;
    this._schedulePass(s, from, loop ? loop.end : Infinity, T0);
    const end = projectEnd(project);
    s.timer = setInterval(() => {
      if (this.session !== s) return;
      const pos = this.songPos();
      if (loop) {
        const last = s.passes[s.passes.length - 1];
        const lastEndCtx = last.ctx + (loop.end - last.song);
        if (lastEndCtx - ctx.currentTime < 0.3) {
          s.passes.push({ ctx: lastEndCtx, song: loop.start, until: loop.end });
          this._schedulePass(s, loop.start, loop.end, lastEndCtx);
        }
      } else if (autoEnd && pos > end + 0.05) {
        this.stop();
        if (onEnd) onEnd();
        return;
      }
      if (s.metronome) this._scheduleMetronome(s);
    }, 25);
    if (metronome) this._scheduleMetronome(s);
    return T0;
  }

  _trackChain(track, project) {
    const ctx = this.ctx;
    const gain = ctx.createGain();
    gain.gain.value = track.gain;
    let pan = null;
    if (ctx.createStereoPanner) {
      pan = ctx.createStereoPanner();
      pan.pan.value = track.pan;
    }
    const on = ctx.createGain();
    on.gain.value = audible(project, track) ? 1 : 0;
    if (pan) { gain.connect(pan); pan.connect(on); } else gain.connect(on);
    on.connect(this.master);
    return { gain, pan, on };
  }

  _schedulePass(s, from, to, when) {
    const ctx = this.ctx;
    const segs = scheduleSegments(s.project, { from, to, exclude: s.exclude });
    for (const seg of segs) {
      const audio = s.audios.get(seg.audioId);
      const chain = s.tracks.get(seg.trackId);
      if (!audio || !chain) continue;
      const buf = this.getBuffer(audio);
      if (seg.audioOffset >= buf.duration) continue;
      const clip = seg.clip;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      const fade = ctx.createGain();
      const cg = ctx.createGain();
      cg.gain.value = clip.gain;
      src.connect(fade);
      fade.connect(cg);
      cg.connect(chain.gain);
      const at = (song) => when + (song - from);
      const a = seg.songStart;
      const b = seg.songEnd;
      const g = fade.gain;
      const pts = envelopePoints(clip, a, b);
      g.setValueAtTime(pts[0][1], at(pts[0][0]));
      for (let i = 1; i < pts.length; i++) g.linearRampToValueAtTime(pts[i][1], at(pts[i][0]));
      const startAt = Math.max(at(a), ctx.currentTime);
      try {
        src.start(startAt, seg.audioOffset, b - a);
      } catch { continue; }
      s.sources.push(src);
      if (!s.clipGains.has(clip.id)) s.clipGains.set(clip.id, []);
      s.clipGains.get(clip.id).push(cg);
    }
  }

  _scheduleMetronome(s) {
    const ctx = this.ctx;
    const p = s.project;
    const beat = beatSec(p.bpm);
    const now = ctx.currentTime;
    const horizonCtx = now + 0.2;
    for (const pass of s.passes) {
      if (pass.ctx > horizonCtx) continue;
      const passEndCtx = pass.ctx + (pass.until - pass.song);
      if (passEndCtx < now) continue;
      // テンポが変わったら、次の拍番号を今のテンポで数え直す（予約済みの拍は二度予約しない）
      if (pass.nextK === undefined || pass.beat !== beat) {
        const from = pass.lastSong === undefined ? pass.song : pass.lastSong + 1e-6;
        pass.nextK = firstBeatIndex(from, beat);
        pass.beat = beat;
      }
      const horizon = pass.song + (horizonCtx - pass.ctx);
      const r = nextBeats({ nextK: pass.nextK, beat, horizon, until: pass.until });
      pass.nextK = r.nextK;
      for (const k of r.beats) {
        const song = k * beat;
        const when = pass.ctx + (song - pass.song);
        pass.lastSong = song;
        if (when < now - 0.005) continue;
        const accent = ((k % p.beatsPerBar) + p.beatsPerBar) % p.beatsPerBar === 0;
        this._click(when, accent);
        if (this.metroLog) this.metroLog.push({ when, song, k, accent });
      }
    }
  }

  _click(when, accent) {
    const ctx = this.ctx;
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0.0001, when);
    g.gain.exponentialRampToValueAtTime(accent ? 0.9 : 0.6, when + 0.002);
    g.gain.exponentialRampToValueAtTime(0.0001, when + 0.05);
    o.connect(g);
    g.connect(this.metroOut);
    o.start(when);
    o.stop(when + 0.06);
  }

  _passAt(s, t) {
    let p = s.passes[0];
    for (const x of s.passes) if (x.ctx <= t + 1e-9) p = x;
    return p;
  }

  /** 今の再生位置（曲の秒）。止まっていれば null */
  songPos() {
    const s = this.session;
    if (!s || !this.ctx) return null;
    const t = this.ctx.currentTime;
    // 鳴り始める前（予約の待ち時間）は、始まりの位置のまま（0 へ跳んだように見えないように）
    if (s.passes && s.passes.length && t < s.passes[0].ctx) return s.passes[0].song;
    const p = this._passAt(s, t);
    return p.song + (t - p.ctx);
  }

  get playing() { return !!this.session; }

  stop() {
    const s = this.session;
    if (!s) return;
    this.session = null;
    clearInterval(s.timer);
    for (const src of s.sources) { try { src.stop(); } catch { /* もう止まっている */ } try { src.disconnect(); } catch { /* */ } }
    for (const ch of s.tracks.values()) { try { ch.on.disconnect(); } catch { /* */ } }
  }

  /** 音量・左右・ミュート・ソロを、鳴らしたまま変える（プツッとならないよう滑らかに） */
  updateMix(project) {
    if (!this.ctx) return;
    const now = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(project.masterGain, now, 0.015);
    const s = this.session;
    if (!s) return;
    s.project = { ...s.project, tracks: project.tracks, masterGain: project.masterGain, bpm: project.bpm, beatsPerBar: project.beatsPerBar };
    for (const t of project.tracks) {
      const ch = s.tracks.get(t.id);
      if (!ch) continue;
      ch.gain.gain.setTargetAtTime(t.gain, now, 0.015);
      if (ch.pan) ch.pan.pan.setTargetAtTime(t.pan, now, 0.015);
      ch.on.gain.setTargetAtTime(audible(project, t) ? 1 : 0, now, 0.015);
    }
    for (const c of project.clips) {
      const list = s.clipGains.get(c.id);
      if (list) for (const g of list) g.gain.setTargetAtTime(c.gain, now, 0.015);
    }
  }

  setMetronome(on) { if (this.session) this.session.metronome = on; }

  /** 1つの録音だけを鳴らす（テイクの試し聞き） */
  previewAudio(audio, offset, duration, onEnd, masterGain = 1) {
    this.stop();
    this.stopPreview();
    this.setMaster(masterGain);
    const src = this.ctx.createBufferSource();
    src.buffer = this.getBuffer(audio);
    src.connect(this.master);
    src.onended = () => { if (this.preview === src) { this.preview = null; if (onEnd) onEnd(); } };
    src.start(this.ctx.currentTime + 0.03, Math.max(0, offset), Math.max(0.01, duration));
    this.preview = src;
  }

  stopPreview() {
    if (this.preview) { const p = this.preview; this.preview = null; try { p.stop(); } catch { /* */ } }
  }

  // ---------------- 入力 ----------------

  /** マイクを開く（テストのときはアプリの中で作った音） */
  async openInput() {
    await this.ensure();
    if (this.testMode) {
      if (!this.inputNode) {
        const ctx = this.ctx;
        this.inputNode = ctx.createGain();
        const osc = ctx.createOscillator();
        osc.frequency.value = this.testToneHz;
        const g = ctx.createGain();
        g.gain.value = 0.2;
        osc.connect(g);
        g.connect(this.inputNode);
        osc.start();
        this.testOsc = osc;
        this.inputSettings = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, test: true };
      }
      return this.inputSettings;
    }
    if (this.inputStream && this.inputStream.getAudioTracks().some((t) => t.readyState === 'live')) return this.inputSettings;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('この画面ではマイクが使えません（https で開いてください）'), { name: 'NotSupportedError' });
    }
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 },
      video: false,
    });
    this.inputStream = stream;
    this.inputNode = this.ctx.createMediaStreamSource(stream);
    const track = stream.getAudioTracks()[0];
    this.inputSettings = track && track.getSettings ? track.getSettings() : {};
    return this.inputSettings;
  }

  closeInput() {
    if (this.inputStream) {
      for (const t of this.inputStream.getTracks()) t.stop();
      this.inputStream = null;
      try { this.inputNode.disconnect(); } catch { /* */ }
      this.inputNode = null;
    }
  }

  setTestTone(hz) {
    this.testToneHz = hz;
    if (this.testOsc) this.testOsc.frequency.setValueAtTime(hz, this.ctx.currentTime);
  }

  _testClickBuffer() {
    if (this._clickBuf && this._clickBuf.sampleRate === this.ctx.sampleRate) return this._clickBuf;
    const sr = this.ctx.sampleRate;
    // 0.5秒ぶんだけ作って、くり返して鳴らす（長いバッファを作ると、その間だけ処理が止まって音が遅れる）
    const every = Math.round(TEST_CLICK_EVERY * sr);
    const b = this.ctx.createBuffer(1, every, sr);
    const d = b.getChannelData(0);
    const w = Math.max(1, Math.round(0.001 * sr));
    for (let i = 0; i < d.length; i += every) for (let k = 0; k < w && i + k < d.length; k++) d[i + k] = 0.7;
    this._clickBuf = b;
    return b;
  }

  _makeRecNode(onMsg) {
    const ctx = this.ctx;
    if (this.workletOk) {
      const node = new AudioWorkletNode(ctx, 'kasane-recorder', {
        numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 1, channelCountMode: 'explicit', channelInterpretation: 'speakers',
      });
      node.port.onmessage = (e) => onMsg(e.data);
      node.connect(this.silent);
      return { node, flush: () => node.port.postMessage('flush') };
    }
    // AudioWorklet が使えない古いブラウザ：ScriptProcessor で代わりに取る（時刻は近い値）
    const size = 2048;
    const node = ctx.createScriptProcessor(size, 1, 1);
    node.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0).slice();
      let peak = 0;
      for (let i = 0; i < data.length; i++) { const a = Math.abs(data[i]); if (a > peak) peak = a; }
      const frame = Math.round((e.playbackTime - size / ctx.sampleRate) * ctx.sampleRate);
      onMsg({ type: 'chunk', frame, data, peak });
    };
    node.connect(this.silent);
    return { node, flush: () => onMsg({ type: 'flushed' }) };
  }

  // ---------------- 録音 ----------------

  /**
   * 録音を始める。
   * mode 'normal'：recordStart から録る（countInSec 前から再生）
   * mode 'punch'：range の preroll 秒前から再生し、範囲の 1 秒後に onAutoStop を呼ぶ
   */
  async startRecording({ project, audios, mode, recordStart = 0, range = null, preroll = 2, countInSec = 0, trackId, latencySec = 0, onChunk, onAutoStop, maxSec = 600 }) {
    await this.openInput();
    this.stopPreview();
    const ctx = this.ctx;
    await this._settle();
    const sr = ctx.sampleRate;
    const chunks = [];
    const rec = { mode, recordStart, range, trackId, latencySec, chunks, sampleRate: sr, flushWait: null };
    const transportFrom = mode === 'punch' ? range.start - preroll : recordStart - countInSec;
    const exclude = mode === 'punch' ? { trackId, start: range.start, end: range.end } : { trackId, start: recordStart, end: Infinity };
    const recNode = this._makeRecNode((m) => {
      if (m.type === 'chunk') {
        chunks.push(m);
        if (onChunk) onChunk(m);
      } else if (m.type === 'flushed' && rec.flushWait) {
        rec.flushWait();
      }
    });
    rec.recNode = recNode;
    const T0 = this.play({ project, audios, from: transportFrom, exclude, metronome: project.metronomeOn, autoEnd: false, lead: 0.3 });
    this.inputNode.connect(recNode.node);
    if (this.testMode && this.testLoopback) {
      // テスト：再生している音そのものを入力にする（聞いていた音と録った音の位置を比べる）
      this.master.connect(this.inputNode);
      rec.loopback = true;
    } else if (this.testMode) {
      const src = ctx.createBufferSource();
      src.buffer = this._testClickBuffer();
      src.loop = true;
      src.connect(this.inputNode);
      src.start(T0);
      rec.testClicks = src;
    }
    rec.T0 = T0;
    rec.transportFrom = transportFrom;
    // 1回の録音の上限（maxSec）は、範囲の録り直しにも効かせる（助走を含めて数える）
    const limitSong = (mode === 'punch' ? transportFrom : recordStart) + maxSec;
    const punchEnd = mode === 'punch' ? range.end + 1.0 : Infinity;
    rec.watch = setInterval(() => {
      const pos = this.songPos();
      if (pos == null || !onAutoStop) return;
      if (pos >= limitSong) { clearInterval(rec.watch); onAutoStop('limit'); }
      else if (pos >= punchEnd) { clearInterval(rec.watch); onAutoStop('punch'); }
    }, 20);
    this.rec = rec;
    return rec;
  }

  /**
   * 音の時計が落ち着くのを待つ。
   * AudioContext は動き出した直後、時計がまとめて進むことがある。その間に「今＋0.15秒」で予約すると、
   * 予約が間に合わずに音が遅れて鳴り、重ねて録った音の位置がずれる。動き出してから最初の録音の前に一度だけ待つ。
   */
  async _settle() {
    const ctx = this.ctx;
    if (this._settledCtx === ctx && ctx.state === 'running') return;
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    let steady = 0;
    let prev = ctx.currentTime;
    let prevWall = performance.now();
    for (let i = 0; i < 40 && steady < 4; i++) {
      await wait(30);
      const now = ctx.currentTime;
      const wall = performance.now();
      const drift = Math.abs((now - prev) - (wall - prevWall) / 1000);
      steady = now > prev && drift < 0.02 ? steady + 1 : 0;
      prev = now;
      prevWall = wall;
    }
    this._settledCtx = ctx;
  }

  get recording() { return !!this.rec; }

  /** 録音を取りやめる（止める処理で問題が起きたときの後片付け。録った音は捨てる） */
  abortRecording() {
    const rec = this.rec;
    this.rec = null;
    if (!rec) return;
    clearInterval(rec.watch);
    try { this.inputNode.disconnect(rec.recNode.node); } catch { /* */ }
    try { rec.recNode.node.disconnect(); } catch { /* */ }
    if (rec.loopback) { try { this.master.disconnect(this.inputNode); } catch { /* */ } }
    if (rec.testClicks) { try { rec.testClicks.stop(); rec.testClicks.disconnect(); } catch { /* */ } }
    this.stop();
  }

  /** 録音を止めて、録れた音と曲の中の位置を返す */
  async stopRecording() {
    const rec = this.rec;
    if (!rec) return null;
    this.rec = null;
    clearInterval(rec.watch);
    const ctx = this.ctx;
    const stopCtx = ctx.currentTime;
    const stopSong = this.songPos();
    await new Promise((resolve) => {
      rec.flushWait = resolve;
      rec.recNode.flush();
      setTimeout(resolve, 400);
    });
    try { this.inputNode.disconnect(rec.recNode.node); } catch { /* */ }
    try { rec.recNode.node.disconnect(); } catch { /* */ }
    if (rec.loopback) { try { this.master.disconnect(this.inputNode); } catch { /* */ } }
    if (rec.testClicks) { try { rec.testClicks.stop(); rec.testClicks.disconnect(); } catch { /* */ } }
    this.stop();
    const sr = rec.sampleRate;
    const chunks = rec.chunks.slice().sort((a, b) => a.frame - b.frame);
    if (!chunks.length) return { pcm: new Float32Array(0), sampleRate: sr, songPos0: rec.recordStart, stopSong, mode: rec.mode, range: rec.range, recordStart: rec.recordStart, trackId: rec.trackId };
    const first = chunks[0].frame;
    let last = first;
    for (const c of chunks) last = Math.max(last, c.frame + c.data.length);
    last = Math.min(last, Math.round(stopCtx * sr) + 1);
    const pcm = new Float32Array(Math.max(0, last - first));
    for (const c of chunks) {
      const at = c.frame - first;
      if (at >= pcm.length) continue;
      pcm.set(c.data.subarray(0, Math.max(0, Math.min(c.data.length, pcm.length - at))), at);
    }
    const songPos0 = rec.transportFrom + (first / sr - rec.T0) - rec.latencySec;
    return { pcm, sampleRate: sr, songPos0, stopSong, mode: rec.mode, range: rec.range, recordStart: rec.recordStart, trackId: rec.trackId };
  }

  // ---------------- ずれの自動測定 ----------------

  /** スピーカーから短い音を鳴らしてマイクで拾い、往復の遅れ（ms）を測る */
  async measureLatency() {
    await this.openInput();
    this.stop();
    const ctx = this.ctx;
    const sr = ctx.sampleRate;
    const chunks = [];
    let flushed = null;
    const rn = this._makeRecNode((m) => { if (m.type === 'chunk') chunks.push(m); else if (m.type === 'flushed' && flushed) flushed(); });
    this.inputNode.connect(rn.node);
    const T = ctx.currentTime + 0.3;
    const times = [];
    const out = this.testMode ? this.inputNode : ctx.destination;
    for (let i = 0; i < 6; i++) {
      const when = T + i * 0.45;
      times.push(when);
      const o = ctx.createOscillator();
      const g = ctx.createGain();
      o.frequency.value = 2000;
      g.gain.setValueAtTime(0, when);
      g.gain.linearRampToValueAtTime(0.9, when + 0.0005);
      g.gain.setValueAtTime(0.9, when + 0.004);
      g.gain.linearRampToValueAtTime(0, when + 0.006);
      o.connect(g);
      g.connect(out);
      o.start(when);
      o.stop(when + 0.01);
    }
    const endAt = T + 6 * 0.45 + 0.4;
    await new Promise((r) => setTimeout(r, Math.max(0, (endAt - ctx.currentTime) * 1000)));
    await new Promise((resolve) => { flushed = resolve; rn.flush(); setTimeout(resolve, 400); });
    try { this.inputNode.disconnect(rn.node); } catch { /* */ }
    try { rn.node.disconnect(); } catch { /* */ }
    return analyzeLatency(chunks, times, sr, this.testMode ? 0.5 : 0.05);
  }
}

/** 測定の録音から遅れを出す（純粋な計算） */
export function analyzeLatency(chunks, times, sr, minLevel = 0.05) {
  if (!chunks.length) return { ok: false, reason: 'マイクの音が届きませんでした' };
  chunks.sort((a, b) => a.frame - b.frame);
  const first = chunks[0].frame;
  let last = first;
  for (const c of chunks) last = Math.max(last, c.frame + c.data.length);
  const pcm = new Float32Array(last - first);
  for (const c of chunks) pcm.set(c.data, c.frame - first);
  let peak = 0;
  for (let i = 0; i < pcm.length; i++) peak = Math.max(peak, Math.abs(pcm[i]));
  if (peak < minLevel) return { ok: false, reason: '鳴らした音が小さくて拾えませんでした。音量を上げて、イヤホンを外してください' };
  const th = peak * 0.5;
  const found = [];
  for (const t of times) {
    const s = Math.max(0, Math.round(t * sr) - first);
    const e = Math.min(pcm.length, s + Math.round(0.4 * sr));
    for (let i = s; i < e; i++) {
      if (Math.abs(pcm[i]) >= th) { found.push((i + first) / sr - t); break; }
    }
  }
  if (found.length < 4) return { ok: false, reason: '音をうまく拾えませんでした。静かな場所で、もう一度試してください' };
  found.sort((a, b) => a - b);
  const spread = found[found.length - 1] - found[0];
  if (spread > 0.012) return { ok: false, reason: '測るたびに値がばらつきました。静かな場所で、もう一度試してください' };
  const median = found[Math.floor(found.length / 2)];
  return { ok: true, ms: median * 1000, samples: found.length };
}
