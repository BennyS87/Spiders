// Spiders - effects (the same family as Reel Studio and Orbit): EQ, Filter, Compressor, Saturation,
// Distortion, Modulation (phaser / flanger / chorus), Echo, Reverb, Trance Gate and Vocoder.
// Every builder works on both a live AudioContext and an OfflineAudioContext (for export).
(function () {
  const SP = (window.Spiders = window.Spiders || {});
  const F = SP.fmt;
  const dbToGain = db => Math.pow(10, db / 20);
  const SYNC_NAMES = Object.keys(SP.SYNC);

  // ---------------- definitions ----------------
  const P = (key, label, min, max, def, fmt, curve, step) => ({ key, label, min, max, def, fmt, curve: curve || 'lin', step });
  const C = (key, label, options, def) => ({ key, label, options, def });

  const TYPES = {
    eq: {
      name: 'EQ', hint: 'Six bands: low cut, low shelf, two bells, high shelf, high cut. Drag the points on the curve.',
      params: [
        P('f1', 'Low cut', 20, 2000, 20, F.hz, 'log'),
        P('f2', 'Low freq', 30, 1000, 120, F.hz, 'log'), P('g2', 'Low gain', -18, 18, 0, F.db),
        P('f3', 'Bell 1 freq', 60, 8000, 400, F.hz, 'log'), P('g3', 'Bell 1 gain', -18, 18, 0, F.db), P('q3', 'Bell 1 width', 0.2, 10, 1, F.num, 'log'),
        P('f4', 'Bell 2 freq', 300, 16000, 2500, F.hz, 'log'), P('g4', 'Bell 2 gain', -18, 18, 0, F.db), P('q4', 'Bell 2 width', 0.2, 10, 1, F.num, 'log'),
        P('f5', 'High freq', 1000, 16000, 8000, F.hz, 'log'), P('g5', 'High gain', -18, 18, 0, F.db),
        P('f6', 'High cut', 1000, 20000, 20000, F.hz, 'log'),
        P('out', 'Output', -24, 12, 0, F.db)
      ],
      choices: [C('slope', 'Cut slope', ['12 dB/oct', '24 dB/oct'], '24 dB/oct')]
    },
    filter: {
      name: 'Filter', hint: 'Resonant filter with an optional tempo-synced sweep.',
      params: [
        P('cutoff', 'Cutoff', 20, 20000, 2400, F.hz, 'log'), P('reso', 'Resonance', 0.5, 20, 1.2, F.num, 'log'),
        P('depth', 'Sweep depth', 0, 4, 0, F.oct), P('rate', 'Sweep rate', 0.02, 10, 0.5, F.hzLfo, 'log'), P('mix', 'Mix', 0, 1, 1, F.pct)
      ],
      choices: [C('mode', 'Type', ['Low pass', 'High pass', 'Band pass', 'Notch'], 'Low pass'), C('slope', 'Slope', ['12 dB/oct', '24 dB/oct'], '12 dB/oct'), C('sync', 'Sweep timing', ['Free (Hz)', '1/4', '1/2', '1 bar', '2 bars', '4 bars'], '1 bar')]
    },
    comp: {
      name: 'Compressor', hint: 'Evens out levels and adds punch.',
      params: [
        P('threshold', 'Threshold', -60, 0, -18, F.db), P('ratio', 'Ratio', 1, 20, 4, F.ratio, 'log'), P('knee', 'Knee', 0, 30, 6, F.db),
        P('attack', 'Attack', 0.0001, 0.1, 0.01, F.ms, 'log'), P('release', 'Release', 0.01, 2, 0.15, F.ms, 'log'),
        P('makeup', 'Makeup', -12, 24, 0, F.db), P('mix', 'Mix', 0, 1, 1, F.pct)
      ],
      choices: []
    },
    sat: {
      name: 'Saturation', hint: 'Warm harmonic drive in six characters.',
      params: [P('drive', 'Drive', 0, 36, 9, F.db), P('colour', 'Colour', -1, 1, 0, v => v < -0.02 ? 'Dark ' + Math.round(-v * 100) : v > 0.02 ? 'Bright ' + Math.round(v * 100) : 'Neutral'), P('output', 'Output', -24, 12, -3, F.db), P('mix', 'Mix', 0, 1, 1, F.pct)],
      choices: [C('type', 'Character', ['Analog', 'Tape', 'Tube', 'Hard clip', 'Wave fold', 'Digital'], 'Analog')]
    },
    dist: {
      name: 'Distortion', hint: 'From overdrive to bit crush.',
      params: [P('drive', 'Drive', 0, 1, 0.45, F.pct), P('tone', 'Tone', 0, 1, 0.7, F.pct), P('bias', 'Bias', -1, 1, 0, v => String(Math.round(v * 100))), P('mix', 'Amount', 0, 1, 0.7, F.pct), P('output', 'Output', -24, 12, -3, F.db)],
      choices: [C('type', 'Character', ['Overdrive', 'Fuzz', 'Bit crush', 'Rectify', 'Foldback'], 'Overdrive')]
    },
    mod: {
      name: 'Phaser / Flanger / Chorus', short: 'Modulation', hint: 'Moving, swirling stereo effects.',
      params: [P('rate', 'Rate', 0.02, 10, 0.4, F.hzLfo, 'log'), P('depth', 'Depth', 0, 1, 0.7, F.pct), P('centre', 'Centre', 0, 1, 0.5, F.pct), P('feedback', 'Feedback', -0.95, 0.95, 0.5, F.pct), P('spread', 'Stereo spread', 0, 180, 90, v => Math.round(v) + '°'), P('mix', 'Mix', 0, 1, 0.5, F.pct)],
      choices: [C('mode', 'Type', ['Phaser', 'Flanger', 'Chorus'], 'Phaser'), C('stages', 'Stages', ['2', '4', '6', '8', '12'], '6'), C('sync', 'Rate', ['Free (Hz)', '1/4', '1/2', '1 bar', '2 bars', '4 bars'], 'Free (Hz)')]
    },
    echo: {
      name: 'Echo', hint: 'Tempo-synced stereo or ping-pong delay with a wobbly tape feel.',
      params: [P('ms', 'Free time', 1, 2000, 375, F.msRaw, 'log'), P('feedback', 'Repeats', 0, 0.95, 0.4, F.pct), P('spread', 'Right offset', 0, 0.5, 0, F.pct), P('lowcut', 'Low cut', 20, 2000, 120, F.hz, 'log'), P('highcut', 'High cut', 500, 20000, 7000, F.hz, 'log'), P('wobble', 'Wobble', 0, 1, 0.1, F.pct), P('mix', 'Amount', 0, 1, 0.35, F.pct)],
      choices: [C('mode', 'Mode', ['Stereo', 'Ping-pong'], 'Stereo'), C('time', 'Timing', ['Free (ms)'].concat(SYNC_NAMES), '1/8D')]
    },
    reverb: {
      name: 'Reverb', hint: 'Rooms, halls and huge washes.',
      params: [P('size', 'Size', 0, 1, 0.5, F.pct), P('decay', 'Decay', 0.2, 20, 2.2, F.sec, 'log'), P('damping', 'High decay', 1000, 20000, 7000, F.hz, 'log'), P('predelay', 'Pre-delay', 0, 0.2, 0.012, F.ms), P('lowcut', 'Low cut', 20, 1000, 100, F.hz, 'log'), P('highcut', 'High cut', 1000, 20000, 12000, F.hz, 'log'), P('width', 'Width', 0, 1, 1, F.pct), P('mix', 'Amount', 0, 1, 0.3, F.pct)],
      choices: []
    },
    gate: {
      name: 'Trance Gate', hint: 'Chops the sound in time with the song. Click steps to switch them on and off, drag up and down to set their level.',
      params: [P('attack', 'Attack', 0.0005, 0.2, 0.003, F.ms, 'log'), P('release', 'Release', 0.001, 1, 0.04, F.ms, 'log'), P('gatelen', 'Length', 0.1, 1, 0.6, F.pct), P('swing', 'Swing', 0, 1, 0, F.pct), P('mix', 'Mix', 0, 1, 1, F.pct)],
      choices: [C('rate', 'Rate', ['1/8', '1/8T', '1/16', '1/16T', '1/32'], '1/16'), C('steps', 'Steps', ['4', '8', '12', '16', '24', '32'], '16')]
    },
    vocoder: {
      name: 'Vocoder', hint: 'Makes a synth voice speak with the rhythm and vowels of the sound.',
      params: [P('sharpness', 'Sharpness', 2, 20, 6, v => v.toFixed(1), 'log'), P('smooth', 'Release', 0.005, 0.5, 0.06, F.ms, 'log'), P('formant', 'Formant shift', -12, 12, 0, F.st, 'lin', 1), P('sibilance', 'Sibilance', 0, 1, 0.3, F.pct), P('level', 'Output', 0, 1.5, 0.8, F.pct), P('mix', 'Amount', 0, 1, 1, F.pct)],
      choices: [C('carrier', 'Voice', ['Single note', 'Chord', 'Whisper'], 'Chord'), C('note', 'Note', ['C1', 'C2', 'G2', 'C3', 'E3', 'G3', 'A3', 'C4', 'D4', 'E4', 'G4', 'C5'], 'C3'), C('bands', 'Bands', ['8', '12', '16', '20', '24'], '16')]
    }
  };
  const ORDER = ['eq', 'filter', 'comp', 'sat', 'dist', 'mod', 'echo', 'reverb', 'gate', 'vocoder'];

  function defaults(type) {
    const d = TYPES[type], p = {};
    for (const q of d.params) p[q.key] = q.def;
    for (const c of d.choices) p[c.key] = c.def;
    if (type === 'gate') p.pattern = [1, 0, 0.7, 0, 1, 0, 0.7, 1, 1, 0, 0.7, 0, 1, 0.5, 0, 0.7].concat(new Array(16).fill(0).map((_, i) => (i % 2 ? 0 : 0.8)));
    return p;
  }
  function create(type) { return { id: SP.uid('fx'), type, on: true, p: defaults(type) }; }

  // ---------------- shared helpers ----------------
  const curveCache = new Map();
  function curve(kind, amount, bias) {
    const key = kind + '|' + Math.round(amount * 400) + '|' + Math.round((bias || 0) * 100);
    let c = curveCache.get(key);
    if (c) return c;
    const n = 4096; c = new Float32Array(n);
    const b = (bias || 0) * 0.5;
    const f = {
      tanh: (x) => Math.tanh(x),
      tape: (x) => Math.tanh(x * 0.9 + 0.08 * x * x * Math.sign(x)) * 0.98,
      tube: (x) => Math.tanh(x + 0.25 * x * x),
      hard: (x) => Math.max(-1, Math.min(1, x)),
      fold: (x) => Math.sin(x * Math.PI / 2),
      digital: (x) => Math.round(Math.max(-1, Math.min(1, x)) * 24) / 24,
      fuzz: (x) => x > 0 ? 1 - Math.exp(-x * 3) : -(1 - Math.exp(x * 1.2)) * 0.8,
      crush: (x) => { const bits = 12 - amount * 10.5, lv = Math.pow(2, bits) / 2; return Math.round(Math.max(-1, Math.min(1, x)) * lv) / lv; },
      rect: (x) => (1 - amount) * x + amount * Math.abs(x),
      foldback: (x) => { let y = x; for (let i = 0; i < 6 && Math.abs(y) > 1; i++) y = Math.sign(y) * 2 - y; return y; }
    }[kind] || ((x) => x);
    const g = kind === 'crush' || kind === 'rect' ? 1 : 1;
    for (let i = 0; i < n; i++) {
      const x = (i / (n - 1)) * 2 - 1;
      c[i] = f(x * g + b) - f(b);
    }
    // normalise peak
    let mx = 0; for (let i = 0; i < n; i++) mx = Math.max(mx, Math.abs(c[i]));
    if (mx > 0) for (let i = 0; i < n; i++) c[i] /= mx;
    curveCache.set(key, c);
    return c;
  }
  const absCurve = (() => { const n = 1024, c = new Float32Array(n); for (let i = 0; i < n; i++) c[i] = Math.abs((i / (n - 1)) * 2 - 1); return c; })();

  function stereoGain(ctx, v) {
    const g = ctx.createGain(); g.gain.value = v == null ? 1 : v;
    g.channelCount = 2; g.channelCountMode = 'explicit'; g.channelInterpretation = 'speakers';
    return g;
  }
  function mixShell(ctx) {
    const input = stereoGain(ctx), output = stereoGain(ctx), dry = stereoGain(ctx, 0), wet = stereoGain(ctx, 1);
    input.connect(dry).connect(output);
    wet.connect(output);
    return { input, output, dry, wet, setMix(m, t) { const now = ctx.currentTime; dry.gain.setTargetAtTime(1 - m, now, t || 0.02); wet.gain.setTargetAtTime(m, now, t || 0.02); } };
  }
  const setP = (ctx, param, v) => { try { param.setTargetAtTime(v, ctx.currentTime, 0.02); } catch (e) { param.value = v; } };
  const nyq = (ctx, f) => Math.min(ctx.sampleRate * 0.45, Math.max(10, f));
  const syncHz = (name, bpm) => { const beats = { '1/4': 1, '1/2': 2, '1 bar': 4, '2 bars': 8, '4 bars': 16 }[name]; return beats ? bpm / 60 / beats : null; };
  function phasedWave(ctx, deg) {
    const ph = deg * Math.PI / 180;
    const real = new Float32Array([0, Math.sin(ph)]), imag = new Float32Array([0, Math.cos(ph)]);
    return ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  }
  function lfo(ctx, phaseDeg) {
    const o = ctx.createOscillator();
    if (phaseDeg) o.setPeriodicWave(phasedWave(ctx, phaseDeg));
    o.start(0);
    return o;
  }

  // ---------------- reverb impulse ----------------
  const irCache = new WeakMap();
  function impulse(ctx, size, decay, damping) {
    let c = irCache.get(ctx); if (!c) { c = new Map(); irCache.set(ctx, c); }
    const key = size.toFixed(2) + '|' + decay.toFixed(2) + '|' + Math.round(damping / 100);
    if (c.has(key)) return c.get(key);
    const sr = ctx.sampleRate;
    const len = Math.max(1, Math.floor(sr * Math.min(12, decay * 1.15 + 0.1)));
    const b = ctx.createBuffer(2, len, sr);
    const dampCoef = Math.exp(-2 * Math.PI * damping / sr);
    for (let ch = 0; ch < 2; ch++) {
      const d = b.getChannelData(ch);
      let seed = 1234 + ch * 7777, lp = 0;
      for (let i = 0; i < len; i++) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        const w = seed / 2147483648 - 1;
        const t = i / sr;
        // the high end dies faster: lowpass that closes over time
        const a = Math.min(0.995, dampCoef + (1 - dampCoef) * Math.min(1, t / decay) * 0.9);
        lp = lp * a + w * (1 - a);
        d[i] = lp * Math.exp(-6.9 * t / decay) * (1.2 + (1 - a) * 0.3);
      }
      // early reflections
      const taps = 6 + Math.round(size * 10);
      for (let k = 0; k < taps; k++) {
        const tt = 0.004 + (k / taps) * (0.015 + size * 0.07) * (1 + 0.3 * Math.sin(k * 7.3 + ch * 2));
        const idx = Math.floor(tt * sr);
        if (idx < len) d[idx] += (0.6 - k / taps * 0.45) * (k % 2 ? -1 : 1);
      }
    }
    c.set(key, b);
    return b;
  }

  // ---------------- builders ----------------
  const builders = {};

  builders.eq = (ctx) => {
    const sh = mixShell(ctx); sh.dry.gain.value = 0; sh.wet.gain.value = 1;
    const bq = (type) => { const f = ctx.createBiquadFilter(); f.type = type; return f; };
    const lc1 = bq('highpass'), lc2 = bq('highpass'), ls = bq('lowshelf'), b1 = bq('peaking'), b2 = bq('peaking'), hs = bq('highshelf'), hc1 = bq('lowpass'), hc2 = bq('lowpass');
    const out = stereoGain(ctx);
    let slope = null;
    const wire = (s) => {
      if (s === slope) return; slope = s;
      [sh.input, lc1, lc2, ls, b1, b2, hs, hc1, hc2].forEach(n => { try { n.disconnect(); } catch (e) { } });
      sh.input.connect(sh.dry);
      const chain = s === '24 dB/oct' ? [lc1, lc2, ls, b1, b2, hs, hc1, hc2] : [lc1, ls, b1, b2, hs, hc1];
      let prev = sh.input; for (const n of chain) { prev.connect(n); prev = n; } prev.connect(out); out.connect(sh.wet);
    };
    return {
      input: sh.input, output: sh.output,
      update(p) {
        wire(p.slope);
        const lcF = p.f1 <= 20.5 ? 5 : p.f1, hcF = p.f6 >= 19900 ? ctx.sampleRate * 0.49 : p.f6;
        for (const f of [lc1, lc2]) { setP(ctx, f.frequency, nyq(ctx, lcF)); f.Q.value = 0.707; }
        for (const f of [hc1, hc2]) { setP(ctx, f.frequency, Math.min(ctx.sampleRate * 0.49, hcF)); f.Q.value = 0.707; }
        setP(ctx, ls.frequency, p.f2); setP(ctx, ls.gain, p.g2);
        setP(ctx, b1.frequency, nyq(ctx, p.f3)); setP(ctx, b1.gain, p.g3); setP(ctx, b1.Q, p.q3);
        setP(ctx, b2.frequency, nyq(ctx, p.f4)); setP(ctx, b2.gain, p.g4); setP(ctx, b2.Q, p.q4);
        setP(ctx, hs.frequency, nyq(ctx, p.f5)); setP(ctx, hs.gain, p.g5);
        setP(ctx, out.gain, dbToGain(p.out));
      },
      dispose() { }
    };
  };

  builders.filter = (ctx) => {
    const sh = mixShell(ctx);
    const f1 = ctx.createBiquadFilter(), f2 = ctx.createBiquadFilter();
    const osc = lfo(ctx), lg = ctx.createGain(); lg.gain.value = 0;
    osc.connect(lg); lg.connect(f1.detune); lg.connect(f2.detune);
    let slope = null;
    return {
      input: sh.input, output: sh.output,
      update(p, bpm) {
        const type = { 'Low pass': 'lowpass', 'High pass': 'highpass', 'Band pass': 'bandpass', 'Notch': 'notch' }[p.mode] || 'lowpass';
        f1.type = type; f2.type = type;
        if (slope !== p.slope) {
          slope = p.slope;
          try { sh.input.disconnect(f1); } catch (e) { } try { f1.disconnect(); f2.disconnect(); } catch (e) { }
          sh.input.connect(f1);
          if (p.slope === '24 dB/oct') f1.connect(f2).connect(sh.wet); else f1.connect(sh.wet);
        }
        const q = type === 'lowpass' || type === 'highpass' ? Math.min(30, p.reso) : Math.max(0.2, p.reso * 0.8);
        for (const f of [f1, f2]) { setP(ctx, f.frequency, nyq(ctx, p.cutoff)); setP(ctx, f.Q, slope === '24 dB/oct' ? Math.sqrt(q) : q); }
        const hz = p.sync === 'Free (Hz)' ? p.rate : syncHz(p.sync, bpm) || p.rate;
        setP(ctx, osc.frequency, hz);
        setP(ctx, lg.gain, p.depth * 1200);
        sh.setMix(p.mix);
      },
      dispose() { try { osc.stop(); } catch (e) { } }
    };
  };

  builders.comp = (ctx) => {
    const sh = mixShell(ctx);
    const c = ctx.createDynamicsCompressor(), mk = stereoGain(ctx);
    sh.input.connect(c).connect(mk).connect(sh.wet);
    return {
      input: sh.input, output: sh.output,
      update(p) {
        setP(ctx, c.threshold, p.threshold); setP(ctx, c.ratio, p.ratio); setP(ctx, c.knee, Math.min(40, p.knee));
        setP(ctx, c.attack, Math.min(1, p.attack)); setP(ctx, c.release, Math.min(1, p.release));
        setP(ctx, mk.gain, dbToGain(p.makeup)); sh.setMix(p.mix);
      },
      reduction() { return c.reduction; },
      dispose() { }
    };
  };

  builders.sat = (ctx) => {
    const sh = mixShell(ctx);
    const pre = stereoGain(ctx), lo = ctx.createBiquadFilter(), hi = ctx.createBiquadFilter(), ws = ctx.createWaveShaper(), post = ctx.createBiquadFilter(), out = stereoGain(ctx);
    lo.type = 'lowshelf'; lo.frequency.value = 300; hi.type = 'highshelf'; hi.frequency.value = 3000;
    post.type = 'lowpass'; post.frequency.value = ctx.sampleRate * 0.45;
    ws.oversample = '4x';
    sh.input.connect(pre).connect(lo).connect(hi).connect(ws).connect(post).connect(out).connect(sh.wet);
    let key = '';
    return {
      input: sh.input, output: sh.output,
      update(p) {
        const kind = { 'Analog': 'tanh', 'Tape': 'tape', 'Tube': 'tube', 'Hard clip': 'hard', 'Wave fold': 'fold', 'Digital': 'digital' }[p.type] || 'tanh';
        if (key !== kind) { key = kind; ws.curve = curve(kind, 1, 0); }
        const g = dbToGain(p.drive);
        setP(ctx, pre.gain, kind === 'fold' ? Math.min(6, g) : g);
        setP(ctx, lo.gain, -p.colour * 6); setP(ctx, hi.gain, p.colour * 6);
        setP(ctx, post.frequency, kind === 'tape' ? 11000 : ctx.sampleRate * 0.45);
        setP(ctx, out.gain, dbToGain(p.output) / Math.max(1, Math.pow(g, 0.35)));
        sh.setMix(p.mix);
      },
      dispose() { }
    };
  };

  builders.dist = (ctx) => {
    const sh = mixShell(ctx);
    const pre = stereoGain(ctx), ws = ctx.createWaveShaper(), tone = ctx.createBiquadFilter(), out = stereoGain(ctx);
    tone.type = 'lowpass'; ws.oversample = '2x';
    sh.input.connect(pre).connect(ws).connect(tone).connect(out).connect(sh.wet);
    let key = '';
    return {
      input: sh.input, output: sh.output,
      update(p) {
        const kind = { 'Overdrive': 'tanh', 'Fuzz': 'fuzz', 'Bit crush': 'crush', 'Rectify': 'rect', 'Foldback': 'foldback' }[p.type] || 'tanh';
        const k = kind + p.drive.toFixed(3) + p.bias.toFixed(2);
        if (k !== key) { key = k; ws.curve = curve(kind, p.drive, p.bias); }
        const g = kind === 'crush' || kind === 'rect' ? 1 : 1 + p.drive * p.drive * (kind === 'fuzz' ? 60 : kind === 'foldback' ? 5 : 30);
        setP(ctx, pre.gain, g);
        setP(ctx, tone.frequency, nyq(ctx, 700 * Math.pow(24, p.tone)));
        setP(ctx, out.gain, dbToGain(p.output));
        sh.setMix(p.mix);
      },
      dispose() { }
    };
  };

  builders.mod = (ctx) => {
    const sh = mixShell(ctx);
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    sh.input.connect(split);
    merge.connect(sh.wet);
    const lfoL = lfo(ctx, 0);
    let lfoR = lfo(ctx, 90), spread = 90;
    let inner = [], mode = null, stages = 0;
    const depthL = ctx.createGain(), depthR = ctx.createGain();
    lfoL.connect(depthL); lfoR.connect(depthR);
    const fbs = [];
    function build(p) {
      for (const n of inner) { try { n.disconnect(); } catch (e) { } }
      try { split.disconnect(); } catch (e) { }
      try { depthL.disconnect(); depthR.disconnect(); } catch (e) { }
      inner = []; fbs.length = 0;
      mode = p.mode; stages = parseInt(p.stages, 10) || 6;
      for (let ch = 0; ch < 2; ch++) {
        const dg = ch ? depthR : depthL;
        const inG = ctx.createGain(); split.connect(inG, ch); inner.push(inG);
        const fb = ctx.createGain(); fbs.push(fb); inner.push(fb);
        if (mode === 'Phaser') {
          let prev = inG;
          const aps = [];
          for (let s = 0; s < stages; s++) { const ap = ctx.createBiquadFilter(); ap.type = 'allpass'; ap.Q.value = 0.6; prev.connect(ap); prev = ap; aps.push(ap); dg.connect(ap.detune); inner.push(ap); }
          prev.connect(merge, 0, ch);
          const fd = ctx.createDelay(0.01); fd.delayTime.value = 0; inner.push(fd);
          prev.connect(fb); fb.connect(fd); fd.connect(aps[0]);
          inner._aps = (inner._aps || []).concat(aps);
        } else {
          const d = ctx.createDelay(0.1); inG.connect(d); d.connect(merge, 0, ch); d.connect(fb); fb.connect(d);
          dg.connect(d.delayTime); inner.push(d);
          inner._delays = (inner._delays || []).concat([d]);
        }
      }
    }
    return {
      input: sh.input, output: sh.output,
      update(p, bpm) {
        if (p.mode !== mode || (p.mode === 'Phaser' && parseInt(p.stages, 10) !== stages)) build(p);
        if (Math.abs(p.spread - spread) > 1) {
          spread = p.spread;
          try { lfoR.disconnect(); lfoR.stop(); } catch (e) { }
          lfoR = lfo(ctx, spread); lfoR.connect(depthR);
        }
        const hz = p.sync === 'Free (Hz)' ? p.rate : syncHz(p.sync, bpm) || p.rate;
        setP(ctx, lfoL.frequency, hz); setP(ctx, lfoR.frequency, hz);
        if (mode === 'Phaser') {
          const centre = 200 * Math.pow(16, p.centre);
          for (const ap of inner._aps || []) setP(ctx, ap.frequency, nyq(ctx, centre));
          setP(ctx, depthL.gain, p.depth * 2400); setP(ctx, depthR.gain, p.depth * 2400);
          for (const fb of fbs) setP(ctx, fb.gain, p.feedback * 0.9);
        } else {
          const base = mode === 'Flanger' ? 0.0012 + p.centre * 0.006 : 0.012 + p.centre * 0.02;
          const dep = mode === 'Flanger' ? base * 0.9 * p.depth : 0.006 * p.depth;
          for (const d of inner._delays || []) setP(ctx, d.delayTime, base);
          setP(ctx, depthL.gain, dep); setP(ctx, depthR.gain, dep);
          for (const fb of fbs) setP(ctx, fb.gain, mode === 'Flanger' ? p.feedback * 0.9 : p.feedback * 0.3);
        }
        sh.setMix(p.mix);
      },
      dispose() { try { lfoL.stop(); lfoR.stop(); } catch (e) { } }
    };
  };

  builders.echo = (ctx) => {
    const sh = mixShell(ctx);
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const dL = ctx.createDelay(6), dR = ctx.createDelay(6);
    const mk = () => { const hp = ctx.createBiquadFilter(); hp.type = 'highpass'; const lp = ctx.createBiquadFilter(); lp.type = 'lowpass'; hp.connect(lp); return { hp, lp }; };
    const fL = mk(), fR = mk();
    const fbL = ctx.createGain(), fbR = ctx.createGain();
    const sum = ctx.createGain(); sum.channelCount = 1; sum.channelCountMode = 'explicit';
    const wob = lfo(ctx, 0), wobG = ctx.createGain(); wob.frequency.value = 0.6; wob.connect(wobG); wobG.connect(dL.delayTime); wobG.connect(dR.delayTime);
    dL.connect(fL.hp); dR.connect(fR.hp);
    fL.lp.connect(merge, 0, 0); fR.lp.connect(merge, 0, 1);
    merge.connect(sh.wet);
    let mode = null;
    return {
      input: sh.input, output: sh.output,
      update(p, bpm) {
        if (p.mode !== mode) {
          mode = p.mode;
          [split, sum, fL.lp, fR.lp, fbL, fbR].forEach(n => { try { n.disconnect(); } catch (e) { } });
          fL.lp.connect(merge, 0, 0); fR.lp.connect(merge, 0, 1);
          try { sh.input.disconnect(split); } catch (e) { } try { sh.input.disconnect(sum); } catch (e) { }
          if (mode === 'Ping-pong') {
            sh.input.connect(sum); sum.connect(dL);
            fL.lp.connect(dR);              // left repeats bounce to the right
            fR.lp.connect(fbR); fbR.connect(dL); // ...and back
          } else {
            sh.input.connect(split); split.connect(dL, 0); split.connect(dR, 1);
            fL.lp.connect(fbL); fbL.connect(dL); fR.lp.connect(fbR); fbR.connect(dR);
          }
        }
        const beats = SP.SYNC[p.time];
        const t = p.time === 'Free (ms)' || !beats ? p.ms / 1000 : beats * 60 / bpm;
        setP(ctx, dL.delayTime, Math.min(5.5, t));
        setP(ctx, dR.delayTime, Math.min(5.5, mode === 'Ping-pong' ? t : t * (1 + p.spread)));
        setP(ctx, fbL.gain, p.feedback); setP(ctx, fbR.gain, p.feedback);
        for (const f of [fL, fR]) { setP(ctx, f.hp.frequency, p.lowcut); setP(ctx, f.lp.frequency, nyq(ctx, p.highcut)); }
        setP(ctx, wobG.gain, p.wobble * 0.004);
        sh.setMix(p.mix);
      },
      dispose() { try { wob.stop(); } catch (e) { } }
    };
  };

  builders.reverb = (ctx) => {
    const sh = mixShell(ctx);
    const pre = ctx.createDelay(1), conv = ctx.createConvolver(), lc = ctx.createBiquadFilter(), hc = ctx.createBiquadFilter();
    lc.type = 'highpass'; hc.type = 'lowpass';
    const split = ctx.createChannelSplitter(2), merge = ctx.createChannelMerger(2);
    const LL = ctx.createGain(), LR = ctx.createGain(), RL = ctx.createGain(), RR = ctx.createGain();
    sh.input.connect(pre).connect(conv).connect(lc).connect(hc).connect(split);
    split.connect(LL, 0); split.connect(LR, 0); split.connect(RR, 1); split.connect(RL, 1);
    LL.connect(merge, 0, 0); RL.connect(merge, 0, 0); RR.connect(merge, 0, 1); LR.connect(merge, 0, 1);
    merge.connect(sh.wet);
    let irKey = '', timer = null;
    return {
      input: sh.input, output: sh.output,
      update(p) {
        const key = p.size.toFixed(2) + p.decay.toFixed(2) + Math.round(p.damping / 100);
        if (key !== irKey) {
          irKey = key;
          const apply = () => { conv.buffer = impulse(ctx, p.size, p.decay, p.damping); };
          if (!conv.buffer || ctx instanceof OfflineAudioContext) apply(); else { clearTimeout(timer); timer = setTimeout(apply, 120); }
        }
        setP(ctx, pre.delayTime, p.predelay + p.size * 0.02);
        setP(ctx, lc.frequency, p.lowcut); setP(ctx, hc.frequency, nyq(ctx, p.highcut));
        const a = (1 + p.width) / 2, b = (1 - p.width) / 2;
        setP(ctx, LL.gain, a); setP(ctx, RR.gain, a); setP(ctx, LR.gain, b); setP(ctx, RL.gain, b);
        sh.setMix(p.mix);
      },
      dispose() { clearTimeout(timer); }
    };
  };

  builders.gate = (ctx) => {
    const sh = mixShell(ctx);
    const vca = stereoGain(ctx, 1);
    sh.input.connect(vca).connect(sh.wet);
    let P_ = null, lastScheduled = -Infinity;
    const RATE = { '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125 };
    return {
      input: sh.input, output: sh.output,
      update(p) { P_ = p; sh.setMix(p.mix); },
      reset(t) { vca.gain.cancelScheduledValues(t); vca.gain.setValueAtTime(1, t); lastScheduled = -Infinity; },
      // beat0..beat1 is a straight stretch of song time that starts at ctx time t0
      schedule(t0, beat0, beat1, spb) {
        if (!P_) return;
        const p = P_;
        const step = RATE[p.rate] || 0.25, n = parseInt(p.steps, 10) || 16;
        const swingDelay = step * 0.33 * p.swing;
        let k = Math.ceil(beat0 / step - 1e-9);
        for (; k * step < beat1; k++) {
          let b = k * step;
          if (k % 2 === 1) b += swingDelay;
          const t = t0 + (b - beat0) * spb;
          if (t <= lastScheduled + 1e-4) continue;
          const lvl = Math.max(0, Math.min(1, p.pattern[((k % n) + n) % n] || 0));
          const len = step * spb * p.gatelen;
          vca.gain.setTargetAtTime(lvl, t, Math.max(0.0003, p.attack / 3));
          vca.gain.setTargetAtTime(0, t + Math.max(p.attack, len), Math.max(0.0005, p.release / 3));
          lastScheduled = t;
        }
      },
      dispose() { }
    };
  };

  builders.vocoder = (ctx) => {
    const sh = mixShell(ctx);
    const out = stereoGain(ctx); out.connect(sh.wet);
    let built = null, sig = '';
    const NOTE = { 'C1': 24, 'C2': 36, 'G2': 43, 'C3': 48, 'E3': 52, 'G3': 55, 'A3': 57, 'C4': 60, 'D4': 62, 'E4': 64, 'G4': 67, 'C5': 72 };
    function build(p) {
      if (built) { for (const n of built.nodes) { try { n.disconnect(); } catch (e) { } } for (const s of built.srcs) { try { s.stop(); } catch (e) { } } }
      const nodes = [], srcs = [];
      const modIn = ctx.createGain(); modIn.channelCount = 1; modIn.channelCountMode = 'explicit';
      sh.input.connect(modIn); nodes.push(modIn);
      const carrier = ctx.createGain(); nodes.push(carrier);
      const root = NOTE[p.note] || 48;
      const mtof = m => 440 * Math.pow(2, (m - 69) / 12);
      if (p.carrier === 'Whisper') {
        const len = ctx.sampleRate * 2, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
        let s = 3; for (let i = 0; i < len; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
        const nz = ctx.createBufferSource(); nz.buffer = b; nz.loop = true; nz.connect(carrier); nz.start(0); srcs.push(nz); nodes.push(nz);
      } else {
        const notes = p.carrier === 'Chord' ? [root, root + 7, root + 12, root + 16] : [root];
        for (const m of notes) for (const dt of [-7, 7]) {
          const o = ctx.createOscillator(); o.type = 'sawtooth'; o.frequency.value = mtof(m); o.detune.value = dt;
          const g = ctx.createGain(); g.gain.value = 0.5 / notes.length; o.connect(g).connect(carrier); o.start(0); srcs.push(o); nodes.push(o, g);
        }
        // a little noise for consonants
        const len = ctx.sampleRate, b = ctx.createBuffer(1, len, ctx.sampleRate), d = b.getChannelData(0);
        let s = 5; for (let i = 0; i < len; i++) { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; d[i] = s / 2147483648 - 1; }
        const nz = ctx.createBufferSource(); nz.buffer = b; nz.loop = true; const ng = ctx.createGain(); ng.gain.value = 0.08; nz.connect(ng).connect(carrier); nz.start(0); srcs.push(nz); nodes.push(nz, ng);
      }
      const nb = parseInt(p.bands, 10) || 16;
      const bands = [];
      const shift = Math.pow(2, p.formant / 12);
      for (let i = 0; i < nb; i++) {
        const f = 100 * Math.pow(80, i / (nb - 1)); // 100 Hz .. 8 kHz
        const mb = ctx.createBiquadFilter(); mb.type = 'bandpass'; mb.frequency.value = nyq(ctx, f);
        const rect = ctx.createWaveShaper(); rect.curve = absCurve;
        const env = ctx.createBiquadFilter(); env.type = 'lowpass';
        const eg = ctx.createGain(); eg.gain.value = 16;
        const cb = ctx.createBiquadFilter(); cb.type = 'bandpass'; cb.frequency.value = nyq(ctx, f * shift);
        const vca = ctx.createGain(); vca.gain.value = 0;
        modIn.connect(mb); mb.connect(rect).connect(env).connect(eg).connect(vca.gain);
        carrier.connect(cb).connect(vca).connect(out);
        nodes.push(mb, rect, env, eg, cb, vca);
        bands.push({ mb, env, cb });
      }
      const sib = ctx.createBiquadFilter(); sib.type = 'highpass'; sib.frequency.value = 6000;
      const sg = ctx.createGain(); modIn.connect(sib).connect(sg).connect(out); nodes.push(sib, sg);
      built = { nodes, srcs, bands, sg };
    }
    return {
      input: sh.input, output: sh.output,
      update(p) {
        const s = p.carrier + p.note + p.bands + p.formant;
        if (s !== sig) { sig = s; build(p); }
        const envHz = 1 / (2 * Math.PI * Math.max(0.003, p.smooth));
        for (const b of built.bands) { setP(ctx, b.mb.Q, p.sharpness); setP(ctx, b.cb.Q, p.sharpness); setP(ctx, b.env.frequency, envHz); }
        setP(ctx, built.sg.gain, p.sibilance * 0.6);
        setP(ctx, out.gain, p.level * 3.2);
        sh.setMix(p.mix);
      },
      dispose() { if (built) for (const s of built.srcs) { try { s.stop(); } catch (e) { } } }
    };
  };

  function build(ctx, fx, bpm) {
    const node = builders[fx.type](ctx);
    node.type = fx.type; node.id = fx.id;
    node.update(fx.p, bpm);
    return node;
  }

  SP.FX = { TYPES, ORDER, defaults, create, build, impulse };
})();
