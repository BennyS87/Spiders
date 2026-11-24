// Spiders - spectral analysis: slicing a sound into frames, timbre features, clustering and map layout.
// The whole core lives inside one function so it can run inside a Web Worker (built from its source text),
// on the main thread as a fallback, or in Node for testing.
function spidersAnalysisCore() {
  'use strict';

  // ---------------- seeded RNG ----------------
  function rng(seed) {
    let s = (seed >>> 0) || 1;
    return () => { s = (Math.imul(s, 1664525) + 1013904223) >>> 0; return s / 4294967296; };
  }

  // ---------------- FFT (radix-2, in place) ----------------
  const fftCache = new Map();
  function fftTables(n) {
    let t = fftCache.get(n);
    if (t) return t;
    const rev = new Uint32Array(n);
    const bits = Math.log2(n) | 0;
    for (let i = 0; i < n; i++) { let r = 0, x = i; for (let b = 0; b < bits; b++) { r = (r << 1) | (x & 1); x >>= 1; } rev[i] = r; }
    const cos = new Float64Array(n / 2), sin = new Float64Array(n / 2);
    for (let i = 0; i < n / 2; i++) { cos[i] = Math.cos(-2 * Math.PI * i / n); sin[i] = Math.sin(-2 * Math.PI * i / n); }
    const win = new Float64Array(n);
    for (let i = 0; i < n; i++) win[i] = 0.5 - 0.5 * Math.cos(2 * Math.PI * i / (n - 1));
    t = { rev, cos, sin, win };
    fftCache.set(n, t);
    return t;
  }
  function fft(re, im) {
    const n = re.length, { rev, cos, sin } = fftTables(n);
    for (let i = 0; i < n; i++) { const j = rev[i]; if (j > i) { let t = re[i]; re[i] = re[j]; re[j] = t; t = im[i]; im[i] = im[j]; im[j] = t; } }
    for (let size = 2; size <= n; size <<= 1) {
      const half = size >> 1, step = n / size;
      for (let i = 0; i < n; i += size) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const a = i + j, b = a + half;
          const tr = re[b] * cos[k] - im[b] * sin[k];
          const ti = re[b] * sin[k] + im[b] * cos[k];
          re[b] = re[a] - tr; im[b] = im[a] - ti;
          re[a] += tr; im[a] += ti;
        }
      }
    }
  }

  // ---------------- mel filterbank ----------------
  const hzToMel = f => 2595 * Math.log10(1 + f / 700);
  const melToHz = m => 700 * (Math.pow(10, m / 2595) - 1);
  function melBank(nfft, sr, nb, fmin, fmax) {
    const bins = nfft / 2 + 1;
    const mMin = hzToMel(fmin), mMax = hzToMel(fmax);
    const pts = [];
    for (let i = 0; i < nb + 2; i++) pts.push(melToHz(mMin + (mMax - mMin) * i / (nb + 1)));
    const binHz = sr / nfft;
    const bands = [];
    for (let b = 0; b < nb; b++) {
      const lo = pts[b], c = pts[b + 1], hi = pts[b + 2];
      const i0 = Math.max(1, Math.floor(lo / binHz)), i1 = Math.min(bins - 1, Math.ceil(hi / binHz));
      const w = [];
      for (let i = i0; i <= i1; i++) {
        const f = i * binHz;
        let v = 0;
        if (f >= lo && f <= c) v = (f - lo) / Math.max(1e-9, c - lo);
        else if (f > c && f <= hi) v = (hi - f) / Math.max(1e-9, hi - c);
        if (v > 0) w.push(i, v);
      }
      if (!w.length) { const i = Math.min(bins - 1, Math.max(1, Math.round(c / binHz))); w.push(i, 1); }
      bands.push({ w, centre: c });
    }
    return bands;
  }

  function median(arr) {
    const a = Array.from(arr).sort((x, y) => x - y);
    return a.length ? a[a.length >> 1] : 0;
  }
  function percentile(arr, p) {
    const a = Array.from(arr).filter(v => isFinite(v)).sort((x, y) => x - y);
    if (!a.length) return 0;
    return a[Math.min(a.length - 1, Math.max(0, Math.round((a.length - 1) * p)))];
  }

  // ---------------- k-means ----------------
  function dist2(X, d, i, C, j) {
    let s = 0;
    const a = i * d, b = j * d;
    for (let q = 0; q < d; q++) { const t = X[a + q] - C[b + q]; s += t * t; }
    return s;
  }
  function kmeans(X, n, d, k, rand, iters) {
    // k-means++ init
    const C = new Float64Array(k * d);
    const first = Math.floor(rand() * n);
    for (let q = 0; q < d; q++) C[q] = X[first * d + q];
    const D = new Float64Array(n).fill(Infinity);
    for (let c = 1; c < k; c++) {
      let sum = 0;
      for (let i = 0; i < n; i++) { const v = dist2(X, d, i, C, c - 1); if (v < D[i]) D[i] = v; sum += D[i]; }
      let r = rand() * sum, pick = n - 1;
      for (let i = 0; i < n; i++) { r -= D[i]; if (r <= 0) { pick = i; break; } }
      for (let q = 0; q < d; q++) C[c * d + q] = X[pick * d + q];
    }
    const lab = new Int32Array(n).fill(-1);
    const cnt = new Int32Array(k);
    let inertia = 0;
    for (let it = 0; it < iters; it++) {
      let changed = 0; inertia = 0;
      for (let i = 0; i < n; i++) {
        let best = 0, bd = Infinity;
        for (let c = 0; c < k; c++) { const v = dist2(X, d, i, C, c); if (v < bd) { bd = v; best = c; } }
        if (lab[i] !== best) { lab[i] = best; changed++; }
        inertia += bd;
      }
      C.fill(0); cnt.fill(0);
      for (let i = 0; i < n; i++) { const c = lab[i]; cnt[c]++; for (let q = 0; q < d; q++) C[c * d + q] += X[i * d + q]; }
      for (let c = 0; c < k; c++) {
        if (cnt[c] === 0) { // re-seed empty cluster with a random point
          const p = Math.floor(rand() * n);
          for (let q = 0; q < d; q++) C[c * d + q] = X[p * d + q];
        } else for (let q = 0; q < d; q++) C[c * d + q] /= cnt[c];
      }
      if (!changed && it > 0) break;
    }
    return { lab, C, inertia };
  }
  function bestKmeans(X, n, d, k, rand, tries, iters) {
    let best = null;
    for (let t = 0; t < tries; t++) {
      const r = kmeans(X, n, d, k, rand, iters);
      if (!best || r.inertia < best.inertia) best = r;
    }
    return best;
  }
  function silhouette(X, n, d, lab, k, idx) {
    // idx: subset of point indices
    let total = 0, m = 0;
    const sums = new Float64Array(k), cnts = new Int32Array(k);
    for (const i of idx) {
      sums.fill(0); cnts.fill(0);
      for (const j of idx) { if (i === j) continue; sums[lab[j]] += Math.sqrt(dist2(X, d, i, X, j)); cnts[lab[j]]++; }
      const own = lab[i];
      if (cnts[own] === 0) continue;
      const a = sums[own] / cnts[own];
      let b = Infinity;
      for (let c = 0; c < k; c++) if (c !== own && cnts[c] > 0) b = Math.min(b, sums[c] / cnts[c]);
      if (!isFinite(b)) continue;
      total += (b - a) / Math.max(a, b); m++;
    }
    return m ? total / m : -1;
  }

  // ---------------- PCA (top 2 components by power iteration) ----------------
  function pca2(X, n, d, rand) {
    const cov = new Float64Array(d * d);
    for (let i = 0; i < n; i++) {
      const o = i * d;
      for (let a = 0; a < d; a++) { const va = X[o + a]; for (let b = a; b < d; b++) cov[a * d + b] += va * X[o + b]; }
    }
    for (let a = 0; a < d; a++) for (let b = a; b < d; b++) { cov[a * d + b] /= Math.max(1, n - 1); cov[b * d + a] = cov[a * d + b]; }
    const comps = [];
    for (let c = 0; c < 2; c++) {
      let v = new Float64Array(d); for (let q = 0; q < d; q++) v[q] = rand() - 0.5;
      for (let it = 0; it < 80; it++) {
        const w = new Float64Array(d);
        for (let a = 0; a < d; a++) { let s = 0; for (let b = 0; b < d; b++) s += cov[a * d + b] * v[b]; w[a] = s; }
        for (const p of comps) { let dot = 0; for (let q = 0; q < d; q++) dot += w[q] * p[q]; for (let q = 0; q < d; q++) w[q] -= dot * p[q]; }
        let norm = 0; for (let q = 0; q < d; q++) norm += w[q] * w[q]; norm = Math.sqrt(norm) || 1;
        for (let q = 0; q < d; q++) w[q] /= norm;
        v = w;
      }
      comps.push(v);
    }
    const P = new Float64Array(n * 2);
    for (let i = 0; i < n; i++) for (let c = 0; c < 2; c++) { let s = 0; for (let q = 0; q < d; q++) s += X[i * d + q] * comps[c][q]; P[i * 2 + c] = s; }
    return P;
  }

  // ---------------- relaxation (spreads points into even cells, keeping neighbours together) ----------------
  function relax(pos, target, n, W, H, r0, iters, constrain) {
    const cell = r0;
    const gw = Math.max(1, Math.ceil(W / cell)), gh = Math.max(1, Math.ceil(H / cell));
    const head = new Int32Array(gw * gh), next = new Int32Array(n);
    for (let it = 0; it < iters; it++) {
      head.fill(-1);
      for (let i = 0; i < n; i++) {
        const gx = Math.min(gw - 1, Math.max(0, Math.floor(pos[i * 2] / cell))), gy = Math.min(gh - 1, Math.max(0, Math.floor(pos[i * 2 + 1] / cell)));
        const g = gy * gw + gx; next[i] = head[g]; head[g] = i;
      }
      const pull = it < iters * 0.6 ? 0.03 : 0.012;
      for (let i = 0; i < n; i++) {
        const x = pos[i * 2], y = pos[i * 2 + 1];
        const gx = Math.min(gw - 1, Math.max(0, Math.floor(x / cell))), gy = Math.min(gh - 1, Math.max(0, Math.floor(y / cell)));
        let fx = 0, fy = 0;
        for (let oy = -1; oy <= 1; oy++) for (let ox = -1; ox <= 1; ox++) {
          const cx = gx + ox, cy = gy + oy;
          if (cx < 0 || cy < 0 || cx >= gw || cy >= gh) continue;
          for (let j = head[cy * gw + cx]; j !== -1; j = next[j]) {
            if (j === i) continue;
            let dx = x - pos[j * 2], dy = y - pos[j * 2 + 1];
            let dd = Math.sqrt(dx * dx + dy * dy);
            if (dd >= r0) continue;
            if (dd < 1e-6) { dx = (Math.sin(i * 12.9898 + j) * 0.5); dy = Math.cos(i * 78.233 + j) * 0.5; dd = Math.sqrt(dx * dx + dy * dy) || 1; }
            const push = (r0 - dd) / r0;
            fx += dx / dd * push; fy += dy / dd * push;
          }
        }
        pos[i * 2] += fx * r0 * 0.25 + (target[i * 2] - x) * pull;
        pos[i * 2 + 1] += fy * r0 * 0.25 + (target[i * 2 + 1] - y) * pull;
        if (constrain) constrain(i, pos);
        pos[i * 2] = Math.min(W - r0 * 0.5, Math.max(r0 * 0.5, pos[i * 2]));
        pos[i * 2 + 1] = Math.min(H - r0 * 0.5, Math.max(r0 * 0.5, pos[i * 2 + 1]));
      }
    }
  }

  // ======================= main entry =======================
  function analyse(input, progress) {
    progress = progress || (() => { });
    const { mono, sr } = input;
    const st = Object.assign({ mode: 'transients', sliceMs: 150, sensitivity: 0.5, beatDiv: 0.25, bpm: 120, clusters: 0, layout: 'web', maxSliceMs: 1000, aspect: 1.75, seed: 7 }, input.settings || {});
    const len = mono.length;
    const rand = rng(st.seed * 7919 + len);
    const MAX_FRAMES = 1024;

    // ---- STFT -> log-mel per hop ----
    const N = sr >= 32000 ? 2048 : 1024, hop = N / 4, NB = 40;
    const bank = melBank(N, sr, NB, 30, Math.min(16000, sr / 2 - 100));
    const nh = Math.max(1, Math.ceil(len / hop));
    const logmel = new Float32Array(nh * NB);
    const flux = new Float32Array(nh);
    const hopDb = new Float32Array(nh);
    const re = new Float64Array(N), im = new Float64Array(N);
    const { win } = fftTables(N);
    const bins = N / 2 + 1;
    let prev = new Float32Array(bins), cur = new Float32Array(bins);
    const pow = new Float64Array(bins);
    for (let h = 0; h < nh; h++) {
      const c0 = h * hop - N / 2;
      let e = 0;
      for (let i = 0; i < N; i++) {
        const idx = c0 + i;
        const v = idx >= 0 && idx < len ? mono[idx] : 0;
        re[i] = v * win[i]; im[i] = 0; e += v * v;
      }
      hopDb[h] = 10 * Math.log10(e / N + 1e-12);
      fft(re, im);
      let fl = 0;
      for (let i = 0; i < bins; i++) {
        const p = re[i] * re[i] + im[i] * im[i];
        pow[i] = p;
        const m = Math.log(1 + 40 * Math.sqrt(p));
        cur[i] = m;
        const dlt = m - prev[i];
        if (dlt > 0) fl += dlt;
      }
      flux[h] = fl;
      const t = prev; prev = cur; cur = t;
      for (let b = 0; b < NB; b++) {
        const w = bank[b].w;
        let s = 0;
        for (let q = 0; q < w.length; q += 2) s += pow[w[q]] * w[q + 1];
        logmel[h * NB + b] = Math.log10(s + 1e-10);
      }
      if ((h & 255) === 0) progress(0.05 + 0.45 * h / nh, 'Listening to the spectrum');
    }

    // onset strength: positive change of the log-mel spectrum (each band counts equally, so low sounds register too)
    {
      let top = -Infinity;
      for (let q = 0; q < logmel.length; q++) if (logmel[q] > top) top = logmel[q];
      const floor = top - 8;
      for (let h = 0; h < nh; h++) {
        let fl = 0;
        if (h > 0) for (let b = 0; b < NB; b++) {
          const a = Math.max(floor, logmel[h * NB + b]), p = Math.max(floor, logmel[(h - 1) * NB + b]);
          if (a > p) fl += a - p;
        }
        flux[h] = 0.5 * flux[h] / (bins * 0.05) + fl;
      }
    }

    // ---- slicing ----
    let bounds = [0];
    if (st.mode === 'grid' || st.mode === 'beats') {
      let L = st.mode === 'grid' ? st.sliceMs / 1000 * sr : st.beatDiv * 60 / st.bpm * sr;
      L = Math.max(L, sr * 0.01);
      if (len / L > MAX_FRAMES) L = len / MAX_FRAMES;
      for (let p = L; p < len - L * 0.25; p += L) bounds.push(Math.round(p));
    } else {
      // onset detection on spectral flux
      const p99 = percentile(flux, 0.99) || 1;
      const o = new Float32Array(nh);
      for (let h = 0; h < nh; h++) o[h] = Math.min(1.5, flux[h] / p99);
      const sens = Math.min(1, Math.max(0, st.sensitivity));
      const delta = 0.04 + (1 - sens) * 0.5;
      const minGap = Math.max(1, Math.round(0.045 * sr / hop));
      const W = 10;
      const onsets = [];
      let last = -1e9;
      for (let h = 1; h < nh - 1; h++) {
        if (o[h] < o[h - 1] || o[h] < o[h + 1]) continue;
        let isMax = true;
        for (let q = Math.max(0, h - 3); q <= Math.min(nh - 1, h + 3); q++) if (o[q] > o[h]) { isMax = false; break; }
        if (!isMax) continue;
        const seg = o.subarray(Math.max(0, h - W), Math.min(nh, h + W + 1));
        let mean = 0; for (let q = 0; q < seg.length; q++) mean += seg[q]; mean /= seg.length;
        const thr = Math.max(median(seg), mean * 0.8) + delta;
        if (o[h] < thr || hopDb[h] < -70) continue;
        if (h - last < minGap) continue;
        onsets.push({ h, s: o[h] - thr });
        last = h;
      }
      let picked = onsets;
      if (picked.length > MAX_FRAMES - 1) picked = picked.slice().sort((a, b) => b.s - a.s).slice(0, MAX_FRAMES - 1).sort((a, b) => a.h - b.h);
      for (const on of picked) {
        const pos = Math.max(0, on.h * hop - Math.round(hop * 0.75));
        if (pos - bounds[bounds.length - 1] > sr * 0.02) bounds.push(pos);
      }
      // split slices longer than the maximum length
      const maxL = Math.max(0.05, st.maxSliceMs / 1000) * sr;
      const out = [bounds[0]];
      const all = bounds.concat([len]);
      for (let i = 1; i < all.length; i++) {
        const a = all[i - 1], b = all[i];
        const parts = Math.ceil((b - a) / maxL);
        for (let q = 1; q < parts; q++) out.push(Math.round(a + (b - a) * q / parts));
        if (i < all.length - 1) out.push(b);
      }
      bounds = out;
      if (bounds.length > MAX_FRAMES) { // too many after splitting: fall back to an even grid
        const L = len / MAX_FRAMES; bounds = [0];
        for (let p = L; p < len - L * 0.25; p += L) bounds.push(Math.round(p));
      }
    }
    const n = bounds.length;
    const starts = new Float32Array(n), ends = new Float32Array(n);
    for (let i = 0; i < n; i++) { starts[i] = bounds[i] / sr; ends[i] = (i + 1 < n ? bounds[i + 1] : len) / sr; }
    progress(0.55, 'Measuring each frame');

    // ---- per-frame features ----
    const FD = 17; // feature dims
    const F = new Float64Array(n * FD);
    const SPEC = 24;
    const spec = new Float32Array(n * SPEC);
    const rmsDb = new Float32Array(n), centroid = new Float32Array(n);
    const mean = new Float64Array(NB);
    let maxRms = -200;
    for (let i = 0; i < n; i++) {
      const s0 = bounds[i], s1 = i + 1 < n ? bounds[i + 1] : len;
      let e = 0; for (let q = s0; q < s1; q++) e += mono[q] * mono[q];
      rmsDb[i] = 10 * Math.log10(e / Math.max(1, s1 - s0) + 1e-12);
      if (rmsDb[i] > maxRms) maxRms = rmsDb[i];
    }
    const silentThr = Math.max(-72, maxRms - 48);
    for (let i = 0; i < n; i++) {
      const s0 = bounds[i], s1 = i + 1 < n ? bounds[i + 1] : len;
      let h0 = Math.ceil(s0 / hop), h1 = Math.floor((s1 - 1) / hop);
      if (h1 < h0) { h0 = h1 = Math.min(nh - 1, Math.round((s0 + s1) / 2 / hop)); }
      mean.fill(0);
      let loudMax = -200, loudFirst = hopDb[Math.min(nh - 1, h0)], loudSum = 0, loudSq = 0;
      const cntH = h1 - h0 + 1;
      for (let h = h0; h <= h1; h++) {
        for (let b = 0; b < NB; b++) mean[b] += logmel[h * NB + b];
        const l = hopDb[h]; loudSum += l; loudSq += l * l; if (l > loudMax) loudMax = l;
      }
      for (let b = 0; b < NB; b++) mean[b] /= cntH;
      const loudMean = loudSum / cntH;
      const loudVar = Math.sqrt(Math.max(0, loudSq / cntH - loudMean * loudMean));
      // MFCC (DCT-II of log-mel), coefficients 1..12
      for (let c = 1; c <= 12; c++) {
        let s = 0;
        for (let b = 0; b < NB; b++) s += mean[b] * Math.cos(Math.PI * c * (b + 0.5) / NB);
        F[i * FD + (c - 1)] = s;
      }
      // centroid & flatness on band powers
      let ps = 0, pc = 0, logSum = 0;
      for (let b = 0; b < NB; b++) { const p = Math.pow(10, mean[b]); ps += p; pc += p * bank[b].centre; logSum += Math.log(p + 1e-12); }
      const cent = pc / (ps + 1e-12);
      centroid[i] = cent;
      const flat = Math.exp(logSum / NB) / (ps / NB + 1e-12);
      F[i * FD + 12] = Math.log2(Math.max(20, cent));
      F[i * FD + 13] = Math.log10(flat + 1e-6);
      F[i * FD + 14] = rmsDb[i];
      F[i * FD + 15] = loudVar;
      F[i * FD + 16] = loudMax - loudFirst;
      // 24-band spectrum picture
      for (let q = 0; q < SPEC; q++) {
        const pos = q * (NB - 1) / (SPEC - 1), a = Math.floor(pos), t = pos - a;
        spec[i * SPEC + q] = mean[a] * (1 - t) + mean[Math.min(NB - 1, a + 1)] * t;
      }
    }
    // normalise spectrum pictures to 0..1 across the sound
    const sLo = percentile(spec, 0.03), sHi = percentile(spec, 0.995);
    for (let q = 0; q < spec.length; q++) spec[q] = Math.min(1, Math.max(0, (spec[q] - sLo) / Math.max(1e-6, sHi - sLo)));
    // sharpen each frame's own shape so the picture shows where its energy sits
    for (let i = 0; i < n; i++) {
      let lo = 1, hi = 0;
      for (let q = 0; q < SPEC; q++) { const v = spec[i * SPEC + q]; if (v < lo) lo = v; if (v > hi) hi = v; }
      const span = hi - lo;
      if (span < 1e-6) continue;
      for (let q = 0; q < SPEC; q++) { const v = spec[i * SPEC + q]; spec[i * SPEC + q] = 0.45 * v + 0.55 * hi * (v - lo) / span; }
    }

    // active (non-silent) frames
    const active = [];
    for (let i = 0; i < n; i++) if (rmsDb[i] > silentThr) active.push(i);
    const na = active.length;
    const cluster = new Int16Array(n).fill(-1);
    const xs = new Float32Array(n).fill(NaN), ys = new Float32Array(n).fill(NaN);
    let k = 0, typical = [], sectors = [], sizes = [];
    if (na > 0) {
      // z-score + weights
      const W8 = [1, 1, 1, 1, 0.9, 0.9, 0.8, 0.8, 0.7, 0.7, 0.6, 0.6, 1.6, 1.0, 0.45, 0.4, 0.35];
      const X = new Float64Array(na * FD);
      for (let q = 0; q < FD; q++) {
        let m = 0, v = 0;
        for (let a = 0; a < na; a++) m += F[active[a] * FD + q];
        m /= na;
        for (let a = 0; a < na; a++) { const t = F[active[a] * FD + q] - m; v += t * t; }
        const sd = Math.sqrt(v / Math.max(1, na - 1)) || 1;
        for (let a = 0; a < na; a++) X[a * FD + q] = (F[active[a] * FD + q] - m) / sd * W8[q];
      }
      progress(0.65, 'Grouping frames by timbre');
      // choose k
      if (na <= 3) k = na;
      else if (st.clusters > 0) k = Math.min(st.clusters, na);
      else {
        const kMax = Math.min(12, Math.max(3, Math.floor(na / 3)));
        const sub = [];
        const step = Math.max(1, Math.floor(na / 260));
        for (let a = 0; a < na; a += step) sub.push(a);
        let bestScore = -Infinity; k = 3;
        for (let kk = 3; kk <= kMax; kk++) {
          const r = bestKmeans(X, na, FD, kk, rand, 2, 30);
          const s = silhouette(X, na, FD, r.lab, kk, sub) + 0.012 * kk;
          if (s > bestScore) { bestScore = s; k = kk; }
          progress(0.65 + 0.15 * (kk - 2) / (kMax - 2), 'Grouping frames by timbre');
        }
      }
      const km = bestKmeans(X, na, FD, k, rand, 4, 60);
      // order clusters dark -> bright by mean centroid
      const cm = new Float64Array(k), cc = new Int32Array(k);
      for (let a = 0; a < na; a++) { cm[km.lab[a]] += F[active[a] * FD + 12]; cc[km.lab[a]]++; }
      const order = Array.from({ length: k }, (_, c) => c).filter(c => cc[c] > 0).sort((p, q) => cm[p] / cc[p] - cm[q] / cc[q]);
      const remap = new Int32Array(k).fill(-1);
      order.forEach((c, idx) => { remap[c] = idx; });
      const K = order.length;
      const lab = new Int32Array(na);
      for (let a = 0; a < na; a++) { lab[a] = remap[km.lab[a]]; cluster[active[a]] = lab[a]; }
      k = K;
      sizes = new Array(k).fill(0);
      for (let a = 0; a < na; a++) sizes[lab[a]]++;
      // typical frame: nearest to its centroid
      typical = new Array(k).fill(-1);
      const best = new Array(k).fill(Infinity);
      for (let a = 0; a < na; a++) {
        const c = order[lab[a]];
        const dd = dist2(X, FD, a, km.C, c);
        if (dd < best[lab[a]]) { best[lab[a]] = dd; typical[lab[a]] = active[a]; }
      }
      progress(0.85, 'Spinning the web');

      // ---- layout ----
      const A = st.aspect, H = 1;
      const P = pca2(X, na, FD, rand);
      const norm = (c) => {
        const vals = []; for (let a = 0; a < na; a++) vals.push(P[a * 2 + c]);
        const lo = percentile(vals, 0.02), hi = percentile(vals, 0.98), sp = (hi - lo) || 1;
        for (let a = 0; a < na; a++) P[a * 2 + c] = Math.min(1.08, Math.max(-0.08, (P[a * 2 + c] - lo) / sp));
      };
      norm(0); norm(1);
      // blend each axis with its rank so frames spread over the whole area instead of piling up
      const rankBlend = (c, w) => {
        const idx = Array.from({ length: na }, (_, a) => a).sort((p, q) => P[p * 2 + c] - P[q * 2 + c] || p - q);
        const r = new Float64Array(na); idx.forEach((a, k) => { r[a] = na > 1 ? k / (na - 1) : 0.5; });
        for (let a = 0; a < na; a++) P[a * 2 + c] = (1 - w) * Math.min(1, Math.max(0, P[a * 2 + c])) + w * r[a];
      };
      rankBlend(0, 0.55); rankBlend(1, 0.55);
      const pos = new Float64Array(na * 2), target = new Float64Array(na * 2);
      const r0 = Math.sqrt(A * H / Math.max(1, na)) * 0.98;
      if (st.layout === 'map') {
        const m = r0 * 0.8;
        for (let a = 0; a < na; a++) {
          target[a * 2] = m + P[a * 2] * (A - 2 * m);
          target[a * 2 + 1] = m + P[a * 2 + 1] * (H - 2 * m);
          pos[a * 2] = target[a * 2] + (rand() - 0.5) * r0; pos[a * 2 + 1] = target[a * 2 + 1] + (rand() - 0.5) * r0;
        }
        relax(pos, target, na, A, H, r0, 240, null);
      } else {
        // spider web: one sector per cluster (dark -> bright clockwise), time runs from the hub outwards
        const cx = A / 2, cy = H / 2, R = 0.48, Rmin = Math.max(0.05, Math.min(0.12, r0 * 1.2));
        const share = sizes.map(s => Math.max(s, na * 0.025));
        const tot = share.reduce((p, q) => p + q, 0);
        let ang = -Math.PI / 2;
        sectors = [];
        for (let c = 0; c < k; c++) { const w = share[c] / tot * Math.PI * 2; sectors.push({ c, a0: ang, a1: ang + w }); ang += w; }
        const Rw = R;
        // web is drawn on a circle; fit relaxation area to it
        const byC = Array.from({ length: k }, () => []);
        for (let a = 0; a < na; a++) byC[lab[a]].push(a);
        for (let c = 0; c < k; c++) {
          const list = byC[c].sort((p, q) => active[p] - active[q]);
          const sec = sectors[c];
          // angle inside the wedge: rank of the second timbre axis (ties keep time order)
          const byAng = list.slice().sort((p, q) => P[p * 2 + 1] - P[q * 2 + 1] || p - q);
          const angRank = new Map(byAng.map((a, k) => [a, list.length > 1 ? k / (list.length - 1) : 0.5]));
          // golden-ratio jitter keeps time-rank and angle-rank from lining up into stripes
          list.forEach((a, rank) => {
            const t = list.length > 1 ? rank / (list.length - 1) : 0.5;
            const r = Rmin + (Rw - Rmin) * Math.sqrt(t);
            const u = 0.1 + 0.8 * ((0.5 * angRank.get(a) + 0.5 * ((rank * 0.6180339887) % 1)));
            const th = sec.a0 + (sec.a1 - sec.a0) * u;
            target[a * 2] = cx + r * Math.cos(th); target[a * 2 + 1] = cy + r * Math.sin(th);
            pos[a * 2] = target[a * 2] + (rand() - 0.5) * r0 * 0.3; pos[a * 2 + 1] = target[a * 2 + 1] + (rand() - 0.5) * r0 * 0.3;
          });
        }
        const wrap = (x) => { while (x < -Math.PI) x += 2 * Math.PI; while (x > Math.PI) x -= 2 * Math.PI; return x; };
        const r0w = Math.sqrt(Math.PI * Rw * Rw / Math.max(1, na)) * 0.95;
        relax(pos, target, na, A, H, r0w, 160, (a, p) => {
          const sec = sectors[lab[a]];
          let dx = p[a * 2] - cx, dy = p[a * 2 + 1] - cy;
          let r = Math.sqrt(dx * dx + dy * dy), th = Math.atan2(dy, dx);
          const mid = (sec.a0 + sec.a1) / 2, half = (sec.a1 - sec.a0) / 2;
          let rel = wrap(th - mid);
          const margin = Math.min(half * 0.45, (r0w * 0.45) / Math.max(r, 0.02));
          if (rel > half - margin) rel = half - margin; if (rel < -half + margin) rel = -half + margin;
          r = Math.min(Rw - r0w * 0.4, Math.max(Rmin * 0.7, r));
          th = mid + rel;
          p[a * 2] = cx + r * Math.cos(th); p[a * 2 + 1] = cy + r * Math.sin(th);
        });
      }
      for (let a = 0; a < na; a++) { xs[active[a]] = pos[a * 2]; ys[active[a]] = pos[a * 2 + 1]; }
    }

    // ---- waveform overview for the strip ----
    const COLS = 2000;
    const peaks = new Float32Array(COLS * 2);
    for (let c = 0; c < COLS; c++) {
      const a = Math.floor(c * len / COLS), b = Math.max(a + 1, Math.floor((c + 1) * len / COLS));
      let lo = 0, hi = 0;
      for (let q = a; q < b && q < len; q++) { const v = mono[q]; if (v < lo) lo = v; if (v > hi) hi = v; }
      peaks[c * 2] = lo; peaks[c * 2 + 1] = hi;
    }
    progress(1, 'Done');
    return {
      n, k, starts, ends, cluster, x: xs, y: ys, rmsDb, centroid, spec, specBands: SPEC,
      sizes, typical, sectors, layout: st.layout === 'map' ? 'map' : 'web', aspect: st.aspect, peaks, duration: len / sr, silentThr
    };
  }

  return { analyse, fft, kmeans, rng };
}

// Browser wrapper: run in a worker when possible
(function () {
  if (typeof window === 'undefined') return;
  const SP = (window.Spiders = window.Spiders || {});
  let worker = null, workerFailed = false, jobId = 0;
  const jobs = new Map();

  function getWorker() {
    if (worker || workerFailed) return worker;
    try {
      const src = spidersAnalysisCore.toString() + `
        const A = spidersAnalysisCore();
        self.onmessage = (e) => {
          const { id, input } = e.data;
          try {
            const r = A.analyse(input, (p, label) => self.postMessage({ id, progress: p, label }));
            const transfer = [r.starts.buffer, r.ends.buffer, r.cluster.buffer, r.x.buffer, r.y.buffer, r.rmsDb.buffer, r.centroid.buffer, r.spec.buffer, r.peaks.buffer];
            self.postMessage({ id, result: r }, transfer);
          } catch (err) { self.postMessage({ id, error: String(err && err.stack || err) }); }
        };`;
      const url = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (e) => {
        const job = jobs.get(e.data.id); if (!job) return;
        if (e.data.progress != null) job.progress(e.data.progress, e.data.label);
        else { jobs.delete(e.data.id); if (e.data.error) job.reject(new Error(e.data.error)); else job.resolve(e.data.result); }
      };
      worker.onerror = (e) => { console.warn('Analysis worker failed, using main thread', e); workerFailed = true; worker = null; for (const [, j] of jobs) j.fallback(); jobs.clear(); };
    } catch (err) { console.warn('No worker:', err); workerFailed = true; worker = null; }
    return worker;
  }

  let core = null;
  function runHere(input, progress) {
    core = core || spidersAnalysisCore();
    return new Promise((resolve, reject) => setTimeout(() => { try { resolve(core.analyse(input, progress)); } catch (e) { reject(e); } }, 20));
  }

  SP.analyse = function (mono, sr, settings, progress) {
    progress = progress || (() => { });
    const input = { mono: new Float32Array(mono), sr, settings };
    const w = getWorker();
    if (!w) return runHere(input, progress);
    return new Promise((resolve, reject) => {
      const id = ++jobId;
      jobs.set(id, { resolve, reject, progress, fallback: () => runHere(input, progress).then(resolve, reject) });
      w.postMessage({ id, input });
    });
  };
})();

if (typeof module !== 'undefined') module.exports = { spidersAnalysisCore };
