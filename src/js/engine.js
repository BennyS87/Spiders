// Spiders - audio engine: frame voices, track strips with effect chains, transport, scheduler, offline render.
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  SP.SOUND_DEFAULTS = { gain: 1, pitch: 0, fine: 0, attack: 0.003, release: 0.08, length: 1, mode: 'oneshot', reverse: false, scatter: 0, velSens: 0.6,
    spread: 0.25, glide: 0.12, tilt: 0, texture: 0.1, shimmer: 0, width: 0.5, quality: 'clean' };
  // used by the Spectral (held) playback mode
  SP.SPECTRAL_PARAMS = [
    { key: 'spread', label: 'Spread', min: 0, max: 1, def: 0.25, fmt: SP.fmt.pct },
    { key: 'glide', label: 'Glide', min: 0.005, max: 3, def: 0.12, curve: 'log', fmt: SP.fmt.ms },
    { key: 'tilt', label: 'Tilt', min: -6, max: 6, def: 0, fmt: v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB/oct' },
    { key: 'texture', label: 'Texture', min: 0, max: 1, def: 0.1, fmt: SP.fmt.pct },
    { key: 'shimmer', label: 'Shimmer', min: 0, max: 1, def: 0, fmt: SP.fmt.pct },
    { key: 'width', label: 'Width', min: 0, max: 1, def: 0.5, fmt: SP.fmt.pct }
  ];
  SP.SOUND_PARAMS = [
    { key: 'gain', label: 'Gain', min: 0, max: 2, def: 1, fmt: SP.fmt.pct },
    { key: 'pitch', label: 'Pitch', min: -24, max: 24, def: 0, step: 1, fmt: SP.fmt.st },
    { key: 'fine', label: 'Fine', min: -100, max: 100, def: 0, fmt: SP.fmt.cents },
    { key: 'attack', label: 'Attack', min: 0.001, max: 2, def: 0.003, curve: 'log', fmt: SP.fmt.ms },
    { key: 'release', label: 'Release', min: 0.005, max: 4, def: 0.08, curve: 'log', fmt: SP.fmt.ms },
    { key: 'length', label: 'Length', min: 0.1, max: 8, def: 1, curve: 'log', fmt: SP.fmt.x },
    { key: 'scatter', label: 'Scatter', min: 0, max: 1, def: 0, fmt: SP.fmt.pct },
    { key: 'velSens', label: 'Velocity', min: 0, max: 1, def: 0.6, fmt: SP.fmt.pct }
  ];

  const MAX_VOICES = 96;

  // ---------------- master bus ----------------
  function buildMaster(ctx, volume) {
    const input = ctx.createGain(); input.gain.value = volume;
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -6; comp.knee.value = 8; comp.ratio.value = 4; comp.attack.value = 0.004; comp.release.value = 0.2;
    const lim = ctx.createWaveShaper();
    const n = 2048, c = new Float32Array(n);
    for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.abs(x) < 0.8 ? x : Math.sign(x) * (0.8 + 0.2 * Math.tanh((Math.abs(x) - 0.8) / 0.2)); }
    lim.curve = c;
    input.connect(comp).connect(lim);
    return { input, comp, out: lim };
  }

  // ---------------- an ordered effect chain ----------------
  class FxChain {
    constructor(ctx, input, output) { this.ctx = ctx; this.input = input; this.output = output; this.fx = []; this.sig = null; }
    update(effects, bpm) {
      const active = (effects || []).filter(f => f.on);
      const sig = active.map(f => f.id).join('|');
      if (sig !== this.sig) this.rebuild(active, bpm);
      else for (let i = 0; i < active.length; i++) this.fx[i].update(active[i].p, bpm);
    }
    rebuild(active, bpm) {
      const old = this.fx;
      const byId = new Map(old.map(n => [n.id, n]));
      try { this.input.disconnect(); } catch (e) { }
      for (const n of old) { try { n.output.disconnect(); } catch (e) { } }
      const next = [];
      for (const f of active) {
        let node = byId.get(f.id);
        if (node) { byId.delete(f.id); node.update(f.p, bpm); }
        else node = SP.FX.build(this.ctx, f, bpm);
        next.push(node);
      }
      for (const [, n] of byId) { try { n.input.disconnect(); } catch (e) { } n.dispose && n.dispose(); }
      let prev = this.input;
      for (const n of next) { prev.connect(n.input); prev = n.output; }
      prev.connect(this.output);
      this.fx = next; this.sig = active.map(f => f.id).join('|');
    }
    schedule(t0, b0, b1, spb) { for (const n of this.fx) if (n.schedule) n.schedule(t0, b0, b1, spb); }
    reset(t) { for (const n of this.fx) if (n.reset) n.reset(t); }
    dispose() { try { this.input.disconnect(); } catch (e) { } for (const n of this.fx) n.dispose && n.dispose(); this.fx = []; }
  }
  const stereoGain = (ctx, v) => { const n = ctx.createGain(); n.gain.value = v == null ? 1 : v; n.channelCount = 2; n.channelCountMode = 'explicit'; return n; };

  // ---------------- track strip ----------------
  class Strip {
    constructor(ctx, dest) {
      this.ctx = ctx;
      this.input = stereoGain(ctx); this.fxOut = stereoGain(ctx);
      this.panner = ctx.createStereoPanner();
      this.vol = stereoGain(ctx); this.mute = stereoGain(ctx);
      this.fxOut.connect(this.panner).connect(this.vol).connect(this.mute).connect(dest);
      this.chain = new FxChain(ctx, this.input, this.fxOut);
      this.chain.rebuild([], 120);
      this.cells = new Map(); // edited cells with their own effects: key -> {chain, input, sig}
      this.sound = Object.assign({}, SP.SOUND_DEFAULTS);
    }
    get fx() { return this.chain.fx; }
    update(track, bpm, audible) {
      const ctx = this.ctx, now = ctx.currentTime;
      this.panner.pan.setTargetAtTime(track.pan, now, 0.02);
      this.vol.gain.setTargetAtTime(track.volume, now, 0.02);
      this.mute.gain.setTargetAtTime(audible ? 1 : 0, now, 0.01);
      this.sound = Object.assign({}, SP.SOUND_DEFAULTS, track.sound);
      this.chain.update(track.effects, bpm);
      this.bpm = bpm;
    }
    /** Destination for a cell with its own effects (created on first use). */
    cellInput(key, effects, bpm) {
      if (!effects || !effects.some(f => f.on)) return this.input;
      let c = this.cells.get(key);
      if (!c) { const input = stereoGain(this.ctx); c = { input, chain: new FxChain(this.ctx, input, this.input) }; this.cells.set(key, c); }
      c.chain.update(effects, bpm || this.bpm || 120);
      return c.input;
    }
    syncCells(lookup, bpm) {
      for (const [key, c] of this.cells) {
        const ed = lookup(key);
        if (!ed || !ed.effects || !ed.effects.some(f => f.on)) { c.chain.dispose(); this.cells.delete(key); }
        else c.chain.update(ed.effects, bpm);
      }
    }
    scheduleFx(t0, b0, b1, spb) { this.chain.schedule(t0, b0, b1, spb); for (const [, c] of this.cells) c.chain.schedule(t0, b0, b1, spb); }
    resetFx(t) { this.chain.reset(t); for (const [, c] of this.cells) c.chain.reset(t); }
    dispose() {
      try { this.mute.disconnect(); } catch (e) { }
      this.chain.dispose();
      for (const [, c] of this.cells) c.chain.dispose();
    }
  }

  function reversed(ctx, buf) {
    const r = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) { const s = buf.getChannelData(c), d = r.getChannelData(c), n = s.length; for (let i = 0; i < n; i++) d[i] = s[n - 1 - i]; }
    return r;
  }

  /**
   * Play one frame of a sample.
   * hit: {start, end, pitch, vel}; hold: seconds the note is held (null = held live until release()).
   */
  function playFrame(ctx, strip, entry, hit, when, hold, voices, opt) {
    const s = strip.sound || SP.SOUND_DEFAULTS;
    opt = opt || {};
    const rev = opt.reverse != null ? opt.reverse : s.reverse;
    const buf = rev ? (entry.rev || (entry.rev = reversed(ctx, entry.buf))) : entry.buf;
    const dur = entry.buf.duration;
    const rate = Math.pow(2, ((hit.pitch || 0) + s.pitch + s.fine / 100) / 12);
    const segLen = Math.max(0.005, (hit.end - hit.start) * s.length);
    let r0 = hit.start, r1 = Math.min(dur, hit.start + segLen);
    if (rev) { const a = dur - r1, b = dur - r0; r0 = a; r1 = b; }
    const playDur = (r1 - r0) / rate;
    const src = ctx.createBufferSource();
    src.buffer = buf; src.playbackRate.value = rate;
    const g = ctx.createGain();
    src.connect(g).connect(opt.dest || strip.input);
    const vel = hit.vel == null ? 0.9 : hit.vel;
    const peak = s.gain * (opt.gainMul == null ? 1 : opt.gainMul) * (1 - s.velSens * (1 - vel)) * 0.9;
    const atk = Math.min(s.attack, Math.max(0.001, playDur * 0.5));
    const rel = s.release;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(peak, when + atk);
    let endT;
    if (s.mode === 'loop') {
      src.loop = true; src.loopStart = r0; src.loopEnd = Math.max(r0 + 0.005, r1);
      endT = hold == null ? when + 120 : when + Math.max(atk, hold);
    } else if (s.mode === 'gate') {
      endT = when + (hold == null ? playDur : Math.max(atk, Math.min(hold, playDur)));
    } else endT = when + Math.max(atk, playDur);
    g.gain.setValueAtTime(peak, endT);
    g.gain.linearRampToValueAtTime(0, endT + rel);
    src.start(when, Math.max(0, Math.min(r0, dur - 0.001)));
    src.stop(endT + rel + 0.05);
    const v = {
      src, g, when, endT, live: hold == null,
      release(t) {
        if (s.mode === 'oneshot') return;
        t = Math.max(t, when + atk);
        if (t >= v.endT) return;
        try { g.gain.cancelAndHoldAtTime(t); } catch (e) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(peak, t); }
        g.gain.linearRampToValueAtTime(0, t + rel);
        try { src.stop(t + rel + 0.05); } catch (e) { }
        v.endT = t;
      },
      kill(t) {
        try { g.gain.cancelAndHoldAtTime(t); } catch (e) { g.gain.cancelScheduledValues(t); }
        g.gain.linearRampToValueAtTime(0, t + 0.015);
        try { src.stop(t + 0.03); } catch (e) { }
      }
    };
    src.onended = () => { try { g.disconnect(); } catch (e) { } if (voices) { const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); } };
    if (voices) {
      voices.push(v);
      if (voices.length > MAX_VOICES) voices.shift().kill(ctx.currentTime);
    }
    return v;
  }

  /**
   * Held spectral voice: freezes the sound at a point on the map and glides as the point moves.
   * hit.sources: [[start, end, weight], ...]; hit.path: optional [[secondsAfterStart, sources], ...]
   */
  function playSpectral(ctx, strip, sampleId, hit, when, hold, voices, opt) {
    if (!SP.Spectral.isPrepared(ctx)) return null;
    const s = strip.sound || SP.SOUND_DEFAULTS;
    opt = opt || {};
    const params = {
      pitch: Math.pow(2, ((hit.pitch || 0) + s.pitch + s.fine / 100) / 12),
      tilt: s.tilt, texture: s.texture, shimmer: s.shimmer, width: s.width, glide: s.glide, lofi: s.quality === 'lofi'
    };
    const node = SP.Spectral.voice(ctx, sampleId, hit.sources, params);
    const g = ctx.createGain();
    node.connect(g).connect(opt.dest || strip.input);
    const vel = hit.vel == null ? 0.9 : hit.vel;
    const peak = s.gain * (opt.gainMul == null ? 1 : opt.gainMul) * (1 - s.velSens * (1 - vel)) * 0.8;
    const atk = Math.max(0.01, s.attack), rel = Math.max(0.03, s.release);
    // the voice needs one window (about 45 ms) to fill before it sounds
    const start = when + 0.045;
    g.gain.setValueAtTime(0, when);
    g.gain.setValueAtTime(0, start);
    g.gain.linearRampToValueAtTime(peak, start + atk);
    if (hit.path) for (const [dt, src] of hit.path) node.port.postMessage({ type: 'target', at: when + dt, sources: src });
    const v = {
      node, g, when, live: hold == null, endT: Infinity, spectral: true,
      move(sources, t) { node.port.postMessage({ type: 'target', at: t || 0, sources }); },
      setParams(p2) { node.port.postMessage({ type: 'params', at: 0, params: p2 }); },
      release(t) {
        t = Math.max(t, start + 0.01);
        if (t >= v.endT) return;
        try { g.gain.cancelAndHoldAtTime(t); } catch (e) { g.gain.cancelScheduledValues(t); g.gain.setValueAtTime(peak, t); }
        g.gain.linearRampToValueAtTime(0, t + rel);
        node.port.postMessage({ type: 'stop', at: t + rel + 0.06 });
        v.endT = t;
        setTimeout(() => { try { g.disconnect(); node.disconnect(); } catch (e) { } if (voices) { const i = voices.indexOf(v); if (i >= 0) voices.splice(i, 1); } }, Math.max(0, (t + rel - ctx.currentTime) * 1000 + 300));
      },
      kill(t) { v.release(t); }
    };
    if (hold != null) v.release(when + Math.max(0.06, hold));
    if (voices) {
      voices.push(v);
      if (voices.filter(x => x.spectral).length > 16) { const old = voices.find(x => x.spectral && x !== v); old.kill(ctx.currentTime); }
    }
    return v;
  }

  function click(ctx, dest, t, accent) {
    const o = ctx.createOscillator(), g = ctx.createGain();
    o.frequency.value = accent ? 1760 : 1175;
    g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(accent ? 0.35 : 0.22, t + 0.001); g.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);
    o.connect(g).connect(dest); o.start(t); o.stop(t + 0.06);
  }

  function monoOf(entry) {
    if (entry.mono) return entry.mono;
    const b = entry.buf, n = b.length, out = new Float32Array(n), C = b.numberOfChannels;
    for (let c = 0; c < C; c++) { const d = b.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / C; }
    entry.mono = out;
    return out;
  }

  /** Play one hit on a strip: applies scatter, the cell's own edits (bounds, gain, pitch, effects) and the track's playback mode. */
  function triggerOn(ctx, strip, entries, ev, when, hold, r, hooks, voices) {
    const entry = entries.get(ev.sampleId);
    if (!entry) return null;
    let hit = ev;
    const s = strip.sound || SP.SOUND_DEFAULTS;
    if (s.mode !== 'spectral' && s.scatter > 0 && hooks.scatterPick && r < s.scatter) {
      const alt = hooks.scatterPick(ev.sampleId, ev.start, ev.end, SP.hash01(String(r), 3));
      if (alt) hit = Object.assign({}, ev, alt);
    }
    const ed = hooks.cellEdit ? hooks.cellEdit(hit.sampleId, hit.frame) : null;
    const opt = {};
    if (ed) {
      hit = Object.assign({}, hit, { start: ed.start, end: ed.end, pitch: (hit.pitch || 0) + (ed.pitch || 0) });
      opt.gainMul = Math.pow(10, (ed.gain || 0) / 20);
      if (ed.reverse) opt.reverse = !s.reverse;
      opt.dest = strip.cellInput(hit.sampleId + ':' + hit.frame, ed.effects, strip.bpm);
    }
    let v;
    if (s.mode === 'spectral') {
      if (!hit.sources && hooks.spectralSources) hit = Object.assign({}, hit, { sources: hooks.spectralSources(hit, s.spread) });
      if (hit.path && hooks.spectralSources) {
        const spb = hooks.spb ? hooks.spb() : 0.5;
        hit = Object.assign({}, hit, { path: hit.path.map(([db, x, y]) => [db * spb, hooks.spectralSources({ sampleId: hit.sampleId, x, y }, s.spread)]) });
      }
      v = playSpectral(ctx, strip, hit.sampleId, hit, when, hold, voices, opt);
    } else v = playFrame(ctx, strip, entry, hit, when, hold, voices, opt);
    if (v) v.hit = hit;
    return v;
  }

  // ---------------- realtime engine ----------------
  class Engine {
    constructor() {
      this.ctx = null; this.strips = new Map(); this.buffers = new Map(); this.voices = [];
      this.project = null; this.masterVolume = 0.8;
      this.playing = false; this.posBeat = 0; this.anchors = []; this.pass = 0;
      this.hits = []; // {sampleId, start, time, trackId}
      this.scatterPick = null; // (sampleId, start, end, r) => {start,end}
      this.cellEdit = null;    // (sampleId, frame) => edit or null
      this.spectralSources = null; // (hit, spread) => [[start, end, weight], ...]
      this.onStop = null;
    }
    init() {
      if (this.ctx) return;
      this.ctx = new (window.AudioContext || window.webkitAudioContext)({ latencyHint: 'interactive' });
      this.master = buildMaster(this.ctx, this.masterVolume);
      this.analyser = this.ctx.createAnalyser(); this.analyser.fftSize = 2048;
      this.master.out.connect(this.analyser);
      this.master.out.connect(this.ctx.destination);
      this.clickBus = this.ctx.createGain(); this.clickBus.gain.value = 0.8; this.clickBus.connect(this.ctx.destination);
      this.audition = new Strip(this.ctx, this.master.input);
      SP.Spectral.prepare(this.ctx).then(() => { for (const [id] of this.buffers) this.loadSpectral(id); }).catch(e => console.warn('Spectral voices unavailable', e));
      this.freeBeat = 0; this.freeTime = 0;
      this.timer = setInterval(() => this.tick(), 25);
      if (this.project) this.sync(this.project);
    }
    resume() { this.init(); if (this.ctx.state !== 'running') return this.ctx.resume(); return Promise.resolve(); }
    get sampleRate() { this.init(); return this.ctx.sampleRate; }
    setMasterVolume(v) { this.masterVolume = v; if (this.master) this.master.input.gain.setTargetAtTime(v, this.ctx.currentTime, 0.02); }
    setBuffer(id, buf) { this.buffers.set(id, { buf, rev: null }); if (this.ctx && SP.Spectral.isPrepared(this.ctx)) this.loadSpectral(id); }
    loadSpectral(id) {
      const e = this.buffers.get(id); if (!e) return;
      SP.Spectral.load(this.ctx, id, monoOf(e), e.buf.sampleRate);
    }
    removeBuffer(id) { this.buffers.delete(id); }

    sync(project) {
      this.project = project;
      if (!this.ctx) return;
      const anySolo = project.tracks.some(t => t.solo);
      const seen = new Set();
      for (const t of project.tracks) {
        seen.add(t.id);
        let st = this.strips.get(t.id);
        if (!st) { st = new Strip(this.ctx, this.master.input); this.strips.set(t.id, st); }
        st.update(t, project.bpm, !t.mute && (!anySolo || t.solo));
        if (this.cellEditByKey) st.syncCells(this.cellEditByKey, project.bpm);
      }
      if (this.cellEditByKey) this.audition.syncCells(this.cellEditByKey, project.bpm);
      for (const [id, st] of this.strips) if (!seen.has(id)) { st.dispose(); this.strips.delete(id); }
    }

    spb() { return 60 / this.project.bpm; }

    // ---- transport ----
    start(fromBeat) {
      this.init(); this.resume();
      if (this.playing) return;
      const t = this.ctx.currentTime + 0.06;
      this.playing = true;
      this.cursorTime = t; this.cursorBeat = fromBeat == null ? this.posBeat : fromBeat;
      const L = this.project.loop;
      if (L.on && this.cursorBeat >= L.end) this.cursorBeat = L.start;
      this.anchors = [{ t, b: this.cursorBeat }];
      this.pass = 0;
      for (const [, st] of this.strips) st.resetFx(t);
      this.tick();
    }
    stop() {
      if (!this.playing) return;
      this.posBeat = this.beatNow();
      this.playing = false;
      const t = this.ctx.currentTime;
      for (const v of this.voices.slice()) if (v.when > t || !v.live) v.kill(t);
      for (const [, st] of this.strips) st.resetFx(t);
      this.freeTime = t; this.freeBeat = 0;
      if (this.onStop) this.onStop();
    }
    locate(beat) {
      if (this.playing) { this.stop(); this.posBeat = Math.max(0, beat); this.start(); }
      else this.posBeat = Math.max(0, beat);
    }
    setTempoChanged() {
      // re-anchor so the playhead stays continuous
      if (this.playing) this.anchors.push({ t: this.cursorTime, b: this.cursorBeat });
    }
    beatAt(time) {
      if (!this.playing || !this.anchors.length) return this.posBeat;
      let a = this.anchors[0];
      for (const x of this.anchors) if (x.t <= time) a = x;
      if (time < a.t) return a.b;
      return a.b + (time - a.t) / this.spb();
    }
    latency() { return this.ctx ? (this.ctx.outputLatency || this.ctx.baseLatency || 0) : 0; }
    beatNow() { return this.ctx ? this.beatAt(this.ctx.currentTime - this.latency()) : this.posBeat; }
    audibleTime() { return this.ctx ? this.ctx.currentTime - this.latency() : 0; }

    tick() {
      if (!this.ctx || !this.project) return;
      const now = this.ctx.currentTime, horizon = now + 0.13;
      const spb = this.spb();
      if (!this.playing) {
        // free-running clock so trance gates still pulse while you jam with the transport stopped
        if (this.freeTime < now) { this.freeBeat += (now - this.freeTime) / spb; this.freeTime = now; }
        if (this.freeTime < horizon) {
          const b1 = this.freeBeat + (horizon - this.freeTime) / spb;
          for (const [, st] of this.strips) st.scheduleFx(this.freeTime, this.freeBeat, b1, spb);
          this.audition.scheduleFx(this.freeTime, this.freeBeat, b1, spb);
          this.freeBeat = b1; this.freeTime = horizon;
        }
        return;
      }
      if (this.cursorTime < now) { // recover from a stall without a burst
        this.cursorBeat += (now - this.cursorTime) / spb; this.cursorTime = now;
        this.anchors.push({ t: this.cursorTime, b: this.cursorBeat });
      }
      const L = this.project.loop;
      const looping = L.on && L.end - L.start >= 0.25;
      let guard = 0;
      while (this.cursorTime < horizon && guard++ < 16) {
        let b1 = this.cursorBeat + (horizon - this.cursorTime) / spb;
        let wrap = false;
        if (looping && this.cursorBeat < L.end && b1 >= L.end) { b1 = L.end; wrap = true; }
        this.scheduleRange(this.cursorTime, this.cursorBeat, b1, spb);
        this.cursorTime += (b1 - this.cursorBeat) * spb;
        this.cursorBeat = b1;
        if (wrap) {
          this.cursorBeat = L.start; this.pass++;
          this.anchors.push({ t: this.cursorTime, b: L.start });
        }
      }
      if (this.anchors.length > 8) this.anchors = this.anchors.slice(-6);
      const cut = now - 2;
      if (this.hits.length > 300) this.hits = this.hits.filter(h => h.time > cut);
      if (!looping && !this.recording && this.autoStopBeat != null && this.beatNow() > this.autoStopBeat) this.stop();
    }

    scheduleRange(t0, b0, b1, spb) {
      const p = this.project;
      const anySolo = p.tracks.some(x => x.solo);
      for (const tr of p.tracks) {
        const st = this.strips.get(tr.id);
        if (!st) continue;
        st.scheduleFx(t0, b0, b1, spb);
        if (tr.mute || (anySolo && !tr.solo)) continue;
        for (const ev of tr.events) {
          if (ev.t < b0 || ev.t >= b1) continue;
          if (ev._skipPass === this.pass) continue;
          const when = t0 + (ev.t - b0) * spb;
          this.trigger(tr, st, ev, when, ev.len * spb, SP.hash01(ev.id, this.pass));
        }
      }
      if (p.metronome) {
        for (let b = Math.ceil(b0 - 1e-9); b < b1; b++) click(this.ctx, this.clickBus, t0 + (b - b0) * spb, b % p.beatsPerBar === 0);
      }
    }

    trigger(track, strip, ev, when, hold, r) {
      const v = triggerOn(this.ctx, strip, this.buffers, ev, when, hold, r, this, this.voices);
      if (v) this.hits.push({ sampleId: v.hit.sampleId, start: v.hit.start, frame: v.hit.frame, time: when, trackId: track ? track.id : null, dur: Math.min(hold || 0.3, 1.5) });
      return v;
    }

    /** Live play (mouse, keys, MIDI). Returns a voice with release(). */
    playLive(track, hit) {
      this.init(); this.resume();
      const strip = (track && this.strips.get(track.id)) || this.audition;
      const r = Math.random();
      return this.trigger(track, strip, hit, this.ctx.currentTime + 0.005, null, r);
    }
    releaseLive(v) { if (v && this.ctx) v.release(this.ctx.currentTime); }
  }

  // ---------------- offline render (export) ----------------
  /**
   * opts: { project, buffers (Map id->AudioBuffer), b0, b1, repeats, tail, trackIds (null = all audible), sampleRate, scatterPick, masterVolume, wrapTail }
   */
  async function renderOffline(opts) {
    const p = opts.project, sr = opts.sampleRate || 44100;
    const spb = 60 / p.bpm;
    const span = (opts.b1 - opts.b0) * spb;
    const total = span * (opts.repeats || 1) + (opts.tail || 0);
    const ctx = new OfflineAudioContext(2, Math.max(1, Math.ceil(total * sr)), sr);
    const master = buildMaster(ctx, opts.masterVolume == null ? 0.8 : opts.masterVolume);
    master.out.connect(ctx.destination);
    const anySolo = p.tracks.some(t => t.solo);
    const entries = new Map();
    for (const [id, buf] of opts.buffers) entries.set(id, { buf, rev: null, mono: opts.monos ? opts.monos.get(id) : null });
    const tracks = p.tracks.filter(t => opts.trackIds ? opts.trackIds.includes(t.id) : (!t.mute && (!anySolo || t.solo)));
    if (tracks.some(t => t.sound && t.sound.mode === 'spectral')) {
      await SP.Spectral.prepare(ctx);
      const used = new Set(); for (const t of tracks) for (const e of t.events) used.add(e.sampleId);
      for (const id of used) { const e = entries.get(id); if (e) await SP.Spectral.load(ctx, id, monoOf(e), e.buf.sampleRate); }
    }
    const hooks = { scatterPick: opts.scatterPick, cellEdit: opts.cellEdit, spectralSources: opts.spectralSources, spb: () => spb };
    for (const tr of tracks) {
      const st = new Strip(ctx, master.input);
      st.update(tr, p.bpm, true);
      if (opts.cellEdit) for (const ev of tr.events) { const ed = opts.cellEdit(ev.sampleId, ev.frame); if (ed) st.cellInput(ev.sampleId + ':' + ev.frame, ed.effects, p.bpm); }
      for (let rep = 0; rep < (opts.repeats || 1); rep++) {
        const t0 = rep * span;
        st.scheduleFx(t0, opts.b0, opts.b1, spb);
        for (const ev of tr.events) {
          if (ev.t < opts.b0 || ev.t >= opts.b1) continue;
          triggerOn(ctx, st, entries, ev, t0 + (ev.t - opts.b0) * spb, ev.len * spb, SP.hash01(ev.id, rep), hooks, null);
        }
      }
      if (opts.tail) st.scheduleFx(span * (opts.repeats || 1), opts.b1, opts.b1 + opts.tail / spb, spb);
    }
    const out = await ctx.startRendering();
    if (opts.wrapTail && opts.tail) {
      // seamless loop: fold the tail back onto the start
      const L = Math.round(span * (opts.repeats || 1) * sr);
      const res = new AudioBuffer({ numberOfChannels: 2, length: L, sampleRate: sr });
      for (let c = 0; c < 2; c++) {
        const s = out.getChannelData(c), d = res.getChannelData(c);
        d.set(s.subarray(0, L));
        for (let i = L; i < s.length; i++) d[(i - L) % L] += s[i];
      }
      return res;
    }
    return out;
  }

  /** Render a single frame to a buffer (for "export this frame"). */
  async function renderFrame(buf, start, end, sr) {
    sr = sr || buf.sampleRate;
    const dur = Math.max(0.01, end - start);
    const ctx = new OfflineAudioContext(buf.numberOfChannels > 1 ? 2 : 1, Math.ceil(dur * sr), sr);
    const src = ctx.createBufferSource(); src.buffer = buf;
    const g = ctx.createGain();
    const fade = Math.min(0.004, dur / 4);
    g.gain.setValueAtTime(0, 0); g.gain.linearRampToValueAtTime(1, fade); g.gain.setValueAtTime(1, dur - fade); g.gain.linearRampToValueAtTime(0, dur);
    src.connect(g).connect(ctx.destination); src.start(0, start); src.stop(dur);
    return ctx.startRendering();
  }

  SP.Engine = Engine;
  SP.renderOffline = renderOffline;
  SP.renderFrame = renderFrame;
})();
