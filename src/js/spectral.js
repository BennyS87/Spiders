// Spiders - spectral voice: holds any point of a sound as a steady texture (phase-vocoder freeze),
// blends neighbouring cells, and glides smoothly as you move across the map.
// The processor runs in an AudioWorklet created from source text, on live and offline contexts.
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  function processorSource() {
    const N = 2048, H = 512, BINS = N / 2 + 1;
    // ---- FFT ----
    const rev = new Uint32Array(N), cosT = new Float64Array(N / 2), sinT = new Float64Array(N / 2), win = new Float64Array(N);
    (function () {
      const bits = Math.log2(N);
      for (let i = 0; i < N; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
      for (let i = 0; i < N / 2; i++) { cosT[i] = Math.cos(-2 * Math.PI * i / N); sinT[i] = Math.sin(-2 * Math.PI * i / N); }
      for (let i = 0; i < N; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / N);
    })();
    function fft(re, im) {
      for (let i = 0; i < N; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
      for (let size = 2; size <= N; size <<= 1) {
        const half = size >> 1, step = N / size;
        for (let i = 0; i < N; i += size) for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cosT[k] - im[b] * sinT[k], ti = re[b] * sinT[k] + im[b] * cosT[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti; re[a] += tr; im[a] += ti;
        }
      }
    }
    const DATA = (globalThis.__spidersData = globalThis.__spidersData || {});

    class Loader extends AudioWorkletProcessor {
      constructor() {
        super();
        this.port.onmessage = (e) => { const m = e.data; if (m.type === 'load') { DATA[m.id] = { d: m.data, sr: m.sr }; this.port.postMessage({ loaded: m.id }); } else if (m.type === 'unload') delete DATA[m.id]; };
      }
      process() { return true; }
    }
    registerProcessor('spiders-loader', Loader);

    const TWO_PI = Math.PI * 2;
    class Spectral extends AudioWorkletProcessor {
      constructor(opts) {
        super();
        const o = opts.processorOptions || {};
        this.id = o.id;
        this.p = Object.assign({ pitch: 1, tilt: 0, texture: 0.15, shimmer: 0, width: 0.5, glide: 0.08, lofi: false }, o.params || {});
        this.queue = [];
        this.cache = new Map();
        this.cur = null; this.tgt = null; this.dphi = new Float64Array(BINS);
        this.phL = new Float64Array(BINS); this.phR = new Float64Array(BINS); this.rOff = new Float64Array(BINS);
        this.sh = new Float64Array(BINS);
        let s = (o.seed || 1) >>> 0;
        this.rnd = () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
        for (let k = 0; k < BINS; k++) { this.phL[k] = this.rnd() * TWO_PI; this.rOff[k] = (this.rnd() * 2 - 1) * Math.PI; this.sh[k] = this.rnd(); }
        this.ring = new Float64Array(N * 2); this.rp = 0; this.hc = H; // stereo ring buffer
        this.re = new Float64Array(N); this.im = new Float64Array(N);
        this.mag = new Float64Array(BINS);
        this.stopAt = Infinity;
        if (o.sources) this.queue.push({ at: 0, type: 'target', sources: o.sources });
        this.port.onmessage = (e) => { const m = e.data; this.queue.push(m); this.queue.sort((a, b) => (a.at || 0) - (b.at || 0)); };
      }
      // magnitude + phase advance of one analysis window centred at `c` seconds
      analyse(c) {
        const key = Math.round(c * 400);
        let r = this.cache.get(key);
        if (r) return r;
        const src = DATA[this.id]; if (!src) return null;
        const d = src.d, step = src.sr / sampleRate, len = d.length;
        const mag = new Float32Array(BINS), dph = new Float32Array(BINS);
        const re = this.re, im = this.im;
        const ph0 = new Float32Array(BINS);
        for (let pass = 0; pass < 2; pass++) {
          const startSrc = c * src.sr - (N / 2) * step + (pass ? H * step : 0);
          for (let i = 0; i < N; i++) {
            const x = startSrc + i * step, i0 = Math.floor(x), f = x - i0;
            const a = i0 >= 0 && i0 < len ? d[i0] : 0, b = i0 + 1 >= 0 && i0 + 1 < len ? d[i0 + 1] : 0;
            re[i] = (a + (b - a) * f) * win[i]; im[i] = 0;
          }
          fft(re, im);
          for (let k = 0; k < BINS; k++) {
            const ph = Math.atan2(im[k], re[k]);
            if (pass === 0) { mag[k] = Math.sqrt(re[k] * re[k] + im[k] * im[k]); ph0[k] = ph; }
            else {
              const expect = TWO_PI * k * H / N;
              let dv = ph - ph0[k] - expect;
              dv -= TWO_PI * Math.round(dv / TWO_PI);
              dph[k] = expect + dv;
            }
          }
        }
        r = { mag, dph };
        this.cache.set(key, r);
        if (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
        return r;
      }
      // sources: [[start, end, weight], ...] -> blended magnitude, phase advance of the strongest source
      target(sources) {
        const mag = new Float64Array(BINS);
        let wsum = 0, best = null, bw = -1;
        for (const [s0, s1, w] of sources) {
          if (w <= 0) continue;
          const span = Math.max(0, s1 - s0), nw = Math.max(1, Math.min(4, Math.round(span / 0.05)));
          for (let q = 0; q < nw; q++) {
            const c = nw === 1 ? (s0 + s1) / 2 : s0 + span * (q + 0.5) / nw;
            const a = this.analyse(c); if (!a) return null;
            const ww = w / nw;
            for (let k = 0; k < BINS; k++) mag[k] += a.mag[k] * ww;
            if (ww > bw) { bw = ww; best = a; }
            wsum += ww;
          }
        }
        if (!wsum) return null;
        for (let k = 0; k < BINS; k++) mag[k] /= wsum;
        return { mag, dph: best.dph };
      }
      synth() {
        const p = this.p;
        if (this.pending) { const t = this.target(this.pending); if (t) { this.tgt = t; this.pending = null; if (!this.cur) { this.cur = Float64Array.from(t.mag); } } }
        const out = this.ring, rp = this.rp;
        if (this.cur && this.tgt) {
          const a = 1 - Math.exp(-H / sampleRate / Math.max(0.004, p.glide));
          const cur = this.cur, tg = this.tgt.mag, dph = this.tgt.dph;
          const ratio = p.pitch, tilt = p.tilt, sh = p.shimmer, tex = p.texture, width = p.width;
          const mag = this.mag;
          for (let k = 0; k < BINS; k++) cur[k] += (tg[k] - cur[k]) * a;
          for (let k = 0; k < BINS; k++) {
            const srcK = k / ratio;
            let m;
            if (srcK >= BINS - 1) m = 0;
            else if (p.lofi) m = cur[Math.round(srcK)];
            else { const i0 = Math.floor(srcK), f = srcK - i0; m = cur[i0] * (1 - f) + cur[i0 + 1] * f; }
            if (p.lofi) m = Math.round(m * 6 / (1 + m)) / 6 * (1 + m) * 0.9;
            if (tilt && k > 0) m *= Math.pow(2, tilt * Math.log2(Math.max(1, k * sampleRate / N) / 1000) / 6.02);
            if (sh > 0) { this.sh[k] += (this.rnd() - this.sh[k]) * 0.08; m *= 1 - sh * this.sh[k]; }
            mag[k] = m;
            const i0 = Math.min(BINS - 1, Math.round(srcK));
            const adv = (srcK < BINS - 1 ? dph[i0] : TWO_PI * k * H / N) * ratio;
            this.phL[k] += adv + (tex ? tex * Math.PI * (this.rnd() * 2 - 1) : 0);
            if (this.phL[k] > 1e6 || this.phL[k] < -1e6) this.phL[k] %= TWO_PI;
          }
          // pack left + i*right into one inverse FFT (both outputs are real)
          const re = this.re, im = this.im;
          for (let k = 0; k < BINS; k++) {
            const m = mag[k], pl = this.phL[k], pr = pl + width * this.rOff[k];
            const lr = m * Math.cos(pl), li = m * Math.sin(pl), rr = m * Math.cos(pr), ri = m * Math.sin(pr);
            // Z = L + iR
            re[k] = lr - ri; im[k] = li + rr;
            if (k > 0 && k < N / 2) { re[N - k] = lr + ri; im[N - k] = -li + rr; }
          }
          // inverse FFT via conjugation
          for (let i = 0; i < N; i++) im[i] = -im[i];
          fft(re, im);
          const norm = 1 / (N * 0.85);
          for (let i = 0; i < N; i++) {
            const w = win[i] * norm;
            const j = ((rp + i) % N) * 2;
            out[j] += re[i] * w; out[j + 1] += -im[i] * w;
          }
        }
      }
      process(inputs, outputs) {
        const now = currentTime, end = now + 128 / sampleRate;
        while (this.queue.length && (this.queue[0].at || 0) <= end) {
          const m = this.queue.shift();
          if (m.type === 'target') this.pending = m.sources;
          else if (m.type === 'params') Object.assign(this.p, m.params);
          else if (m.type === 'stop') this.stopAt = m.at || 0;
        }
        if (now >= this.stopAt) return false;
        const o = outputs[0], L = o[0], R = o[1] || o[0];
        const ring = this.ring;
        for (let i = 0; i < L.length; i++) {
          if (this.hc >= H) { this.hc = 0; this.synth(); }
          const j = this.rp * 2;
          L[i] = ring[j]; R[i] = ring[j + 1]; ring[j] = 0; ring[j + 1] = 0;
          this.rp = (this.rp + 1) % N; this.hc++;
        }
        return true;
      }
    }
    registerProcessor('spiders-spectral', Spectral);
  }

  const src = '(' + processorSource.toString() + ')();';
  let url = null;
  const ready = new WeakMap(); // ctx -> {promise, loader, loaded:Set, waits:Map}

  /** Prepare a context: load the worklet module and a loader node. */
  function prepare(ctx) {
    let r = ready.get(ctx);
    if (r) return r.promise;
    // a data: URL loads in both file:// pages and the packaged app (blob: worklets don't under file://)
    url = url || 'data:text/javascript;charset=utf-8,' + encodeURIComponent(src);
    r = { loaded: new Set(), waits: new Map(), loader: null };
    r.promise = ctx.audioWorklet.addModule(url).then(() => {
      r.loader = new AudioWorkletNode(ctx, 'spiders-loader', { numberOfInputs: 0, numberOfOutputs: 1 });
      r.loader.port.onmessage = (e) => { const id = e.data.loaded; r.loaded.add(id); const w = r.waits.get(id); if (w) { w(); r.waits.delete(id); } };
      return true;
    });
    ready.set(ctx, r);
    return r.promise;
  }
  /** Send a sound's samples to the worklet (once per context). mono: Float32Array */
  async function load(ctx, id, mono, sr) {
    await prepare(ctx);
    const r = ready.get(ctx);
    if (r.loaded.has(id)) return;
    if (r.waits.has(id)) return new Promise(res => { const prev = r.waits.get(id); r.waits.set(id, () => { prev(); res(); }); });
    return new Promise((res) => { r.waits.set(id, res); r.loader.port.postMessage({ type: 'load', id, data: mono, sr }); });
  }
  function isReady(ctx, id) { const r = ready.get(ctx); return !!(r && r.loader && r.loaded.has(id)); }
  function isPrepared(ctx) { const r = ready.get(ctx); return !!(r && r.loader); }

  /** Create a held spectral voice. Returns an AudioWorkletNode (stereo output). */
  function voice(ctx, id, sources, params, seed) {
    return new AudioWorkletNode(ctx, 'spiders-spectral', {
      numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [2],
      processorOptions: { id, sources, params, seed: seed || (Math.random() * 1e9) | 0 }
    });
  }

  SP.Spectral = { prepare, load, isReady, isPrepared, voice, processorSource };
})();
