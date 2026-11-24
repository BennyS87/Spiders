// Spiders - shared helpers: namespace, ids, parameter maths, colours, base64
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  let idCounter = 0;
  SP.uid = (prefix) => (prefix || 'id') + '_' + Date.now().toString(36) + '_' + (idCounter++).toString(36) + Math.random().toString(36).slice(2, 6);

  SP.clamp = (v, a, b) => Math.min(b, Math.max(a, v));
  SP.lerp = (a, b, t) => a + (b - a) * t;
  SP.deepCopy = (o) => JSON.parse(JSON.stringify(o));

  // ---- parameter definitions: {min,max,def,curve:'lin'|'log'|'pow',step,fmt} ----
  SP.toNorm = (d, v) => {
    v = SP.clamp(v, d.min, d.max);
    if (d.curve === 'log') return Math.log(v / d.min) / Math.log(d.max / d.min);
    if (d.curve === 'pow') return Math.pow((v - d.min) / (d.max - d.min), 1 / (d.pow || 2));
    return (v - d.min) / (d.max - d.min);
  };
  SP.fromNorm = (d, n) => {
    n = SP.clamp(n, 0, 1);
    let v;
    if (d.curve === 'log') v = d.min * Math.pow(d.max / d.min, n);
    else if (d.curve === 'pow') v = d.min + Math.pow(n, d.pow || 2) * (d.max - d.min);
    else v = d.min + n * (d.max - d.min);
    if (d.step) v = Math.round(v / d.step) * d.step;
    return SP.clamp(v, d.min, d.max);
  };

  SP.fmt = {
    pct: v => Math.round(v * 100) + '%',
    db: v => (v > 0 ? '+' : '') + v.toFixed(1) + ' dB',
    hz: v => v >= 1000 ? (v / 1000).toFixed(v >= 10000 ? 1 : 2) + ' kHz' : Math.round(v) + ' Hz',
    ms: v => v >= 1 ? v.toFixed(2) + ' s' : Math.round(v * 1000) + ' ms',
    msRaw: v => v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms',
    sec: v => v.toFixed(v < 10 ? 2 : 1) + ' s',
    st: v => (v > 0 ? '+' : '') + Math.round(v) + ' st',
    cents: v => (v > 0 ? '+' : '') + Math.round(v) + ' ct',
    ratio: v => v.toFixed(1) + ':1',
    x: v => v.toFixed(2) + '×',
    num: v => v.toFixed(2),
    int: v => String(Math.round(v)),
    pan: v => Math.abs(v) < 0.01 ? 'C' : (v < 0 ? 'L' : 'R') + Math.round(Math.abs(v) * 100),
    oct: v => (v > 0 ? '+' : '') + v.toFixed(1) + ' oct',
    hzLfo: v => v.toFixed(2) + ' Hz'
  };

  // ---- colours for clusters (ordered dark -> bright timbre) ----
  SP.clusterColor = (i, k, alpha) => {
    // walk the hue wheel from deep violet (dark sounds) through to warm yellow (bright sounds)
    const t = k <= 1 ? 0.5 : i / (k - 1);
    const h = 265 - t * 225; // 265 (violet) -> 40 (amber)
    const s = 78, l = 58 + Math.sin(t * Math.PI) * 4;
    return alpha == null ? `hsl(${h.toFixed(0)} ${s}% ${l}%)` : `hsla(${h.toFixed(0)}, ${s}%, ${l}%, ${alpha})`;
  };
  SP.clusterRGB = (i, k) => {
    const t = k <= 1 ? 0.5 : i / (k - 1);
    const h = (265 - t * 225) / 360, s = 0.78, l = 0.58 + Math.sin(t * Math.PI) * 0.04;
    const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
    const f = (t2) => { if (t2 < 0) t2 += 1; if (t2 > 1) t2 -= 1; if (t2 < 1 / 6) return p + (q - p) * 6 * t2; if (t2 < 1 / 2) return q; if (t2 < 2 / 3) return p + (q - p) * (2 / 3 - t2) * 6; return p; };
    return [Math.round(f(h + 1 / 3) * 255), Math.round(f(h) * 255), Math.round(f(h - 1 / 3) * 255)];
  };
  SP.TRACK_COLORS = ['#ff5c8a', '#3cf0b4', '#49c6ff', '#ffb547', '#b48cff', '#f2e35c', '#ff7a4d', '#6ee7ff'];

  // ---- base64 for binary payloads ----
  SP.bytesToBase64 = (bytes) => {
    let s = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  SP.base64ToBytes = (b64) => {
    const s = atob(b64);
    const out = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };
  SP.f32ToB64 = (arr) => SP.bytesToBase64(new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength));
  SP.b64ToF32 = (b64) => { const b = SP.base64ToBytes(b64); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); };

  // deterministic hash -> [0,1)
  SP.hash01 = (str, n) => {
    let h = 2166136261 ^ (n || 0);
    for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
    h ^= h >>> 13; h = Math.imul(h, 0x5bd1e995); h ^= h >>> 15;
    return (h >>> 0) / 4294967296;
  };

  SP.escape = (s) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  SP.fmtTime = (sec) => {
    const m = Math.floor(sec / 60), s = sec - m * 60;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(2);
  };

  // Note grid divisions in beats
  SP.DIVS = {
    'Off': 0, '1/4': 1, '1/8': 0.5, '1/8T': 1 / 3, '1/16': 0.25, '1/16T': 1 / 6, '1/32': 0.125
  };
  SP.SYNC = { '1/32': 0.125, '1/16T': 1 / 6, '1/16': 0.25, '1/16D': 0.375, '1/8T': 1 / 3, '1/8': 0.5, '1/8D': 0.75, '1/4T': 2 / 3, '1/4': 1, '1/4D': 1.5, '1/2': 2, '1 bar': 4, '2 bars': 8, '4 bars': 16 };

  SP.NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  SP.noteName = (m) => SP.NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
})();
