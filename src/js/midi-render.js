// Spiders - MIDI file import: reads a Standard MIDI File and renders it to audio with built-in sounds,
// so it can be sliced and mapped like any other sound.
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  function parseMidi(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = 0;
    const str = (n) => { let s = ''; for (let i = 0; i < n; i++) s += String.fromCharCode(bytes[p + i]); p += n; return s; };
    const u32 = () => { const v = dv.getUint32(p); p += 4; return v; };
    const u16 = () => { const v = dv.getUint16(p); p += 2; return v; };
    const vlq = () => { let v = 0, b; do { b = bytes[p++]; v = (v << 7) | (b & 0x7f); } while (b & 0x80 && p < bytes.length); return v; };
    if (str(4) !== 'MThd') throw new Error('Not a MIDI file');
    const hl = u32(); const format = u16(); const ntrk = u16(); const div = u16(); p += hl - 6;
    if (div & 0x8000) throw new Error('SMPTE-timed MIDI files are not supported');
    const ppq = div;
    const tempos = [{ tick: 0, uspq: 500000 }];
    const notes = []; // {tick, endTick, ch, note, vel, prog}
    let name = '';
    for (let t = 0; t < ntrk && p < bytes.length; t++) {
      if (str(4) !== 'MTrk') break;
      const tl = u32(); const end = p + tl;
      let tick = 0, running = 0;
      const prog = new Array(16).fill(0);
      const open = new Map();
      while (p < end) {
        tick += vlq();
        let st = bytes[p];
        if (st & 0x80) { p++; if (st < 0xf0) running = st; } else st = running;
        const type = st & 0xf0, ch = st & 0x0f;
        if (st === 0xff) {
          const mt = bytes[p++]; const l = vlq();
          if (mt === 0x51 && l === 3) tempos.push({ tick, uspq: (bytes[p] << 16) | (bytes[p + 1] << 8) | bytes[p + 2] });
          if (mt === 0x03 && !name) { name = String.fromCharCode(...bytes.subarray(p, p + l)).trim(); }
          p += l;
        } else if (st === 0xf0 || st === 0xf7) { const l = vlq(); p += l; }
        else if (type === 0x90 || type === 0x80) {
          const note = bytes[p++], vel = bytes[p++];
          const key = ch * 128 + note;
          if (type === 0x90 && vel > 0) {
            if (!open.has(key)) open.set(key, []);
            open.get(key).push({ tick, ch, note, vel, prog: prog[ch] });
          } else {
            const list = open.get(key);
            if (list && list.length) { const n = list.shift(); n.endTick = tick; notes.push(n); }
          }
        } else if (type === 0xc0) { prog[ch] = bytes[p++]; }
        else if (type === 0xd0) { p += 1; }
        else if (type === 0xa0 || type === 0xb0 || type === 0xe0) { p += 2; }
        else { p++; }
      }
      for (const [, list] of open) for (const n of list) { n.endTick = tick; notes.push(n); }
      p = end;
    }
    tempos.sort((a, b) => a.tick - b.tick);
    const tickToSec = (tk) => {
      let sec = 0, lastTick = 0, uspq = 500000;
      for (const tp of tempos) {
        if (tp.tick >= tk) break;
        sec += (tp.tick - lastTick) / ppq * uspq / 1e6; lastTick = tp.tick; uspq = tp.uspq;
      }
      return sec + (tk - lastTick) / ppq * uspq / 1e6;
    };
    const out = notes.map(n => ({ t: tickToSec(n.tick), d: Math.max(0.03, tickToSec(n.endTick) - tickToSec(n.tick)), ch: n.ch, note: n.note, vel: n.vel / 127, prog: n.prog }));
    out.sort((a, b) => a.t - b.t);
    const t0 = tempos.filter(tp => tp.tick === 0).pop() || tempos[0];
    const bpm = Math.round(60e6 / t0.uspq);
    return { notes: out, bpm, name, format };
  }

  const mtof = m => 440 * Math.pow(2, (m - 69) / 12);

  function noise(ctx) {
    const b = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate), d = b.getChannelData(0);
    let s = 9;
    for (let i = 0; i < d.length; i++) { s = (s * 1103515245 + 12345) & 0x7fffffff; d[i] = s / 0x3fffffff - 1; }
    return b;
  }

  function voice(ctx, out, n, nz) {
    const t = n.t + 0.05, v = n.vel;
    if (n.ch === 9) { // GM drums
      const g = ctx.createGain(); g.connect(out);
      const k = n.note;
      if (k === 35 || k === 36) {
        const o = ctx.createOscillator(); o.frequency.setValueAtTime(160, t); o.frequency.exponentialRampToValueAtTime(48, t + 0.08);
        g.gain.setValueAtTime(v * 1.1, t); g.gain.setTargetAtTime(0, t, 0.09); o.connect(g); o.start(t); o.stop(t + 0.6);
      } else if (k === 38 || k === 40 || k === 39) {
        const s = ctx.createBufferSource(); s.buffer = nz; s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = k === 39 ? 900 : 1500;
        g.gain.setValueAtTime(v * 0.7, t); g.gain.setTargetAtTime(0, t, k === 39 ? 0.05 : 0.06); s.connect(f).connect(g); s.start(t); s.stop(t + 0.5);
        const o = ctx.createOscillator(); o.type = 'triangle'; o.frequency.value = 190; const og = ctx.createGain(); og.gain.setValueAtTime(v * 0.5, t); og.gain.setTargetAtTime(0, t, 0.04); o.connect(og).connect(out); o.start(t); o.stop(t + 0.3);
      } else if (k === 42 || k === 44 || k === 46 || (k >= 49 && k <= 59)) {
        const s = ctx.createBufferSource(); s.buffer = nz; s.loop = true;
        const f = ctx.createBiquadFilter(); f.type = 'highpass'; f.frequency.value = 7000;
        const dec = k === 46 ? 0.18 : k >= 49 ? 0.5 : 0.035;
        g.gain.setValueAtTime(v * 0.35, t); g.gain.setTargetAtTime(0, t, dec); s.connect(f).connect(g); s.start(t); s.stop(t + dec * 6);
      } else {
        const o = ctx.createOscillator(); const f0 = 90 + (k % 12) * 20; o.frequency.setValueAtTime(f0 * 1.6, t); o.frequency.exponentialRampToValueAtTime(f0, t + 0.05);
        g.gain.setValueAtTime(v * 0.8, t); g.gain.setTargetAtTime(0, t, 0.08); o.connect(g); o.start(t); o.stop(t + 0.6);
      }
      return;
    }
    const fam = Math.floor(n.prog / 8);
    const f = mtof(n.note);
    let wave = 'triangle', atk = 0.004, rel = 0.25, dec = 0.6, sus = 0.25, cut = 6000, detune = 0, lvl = 0.25;
    if (fam === 0 || fam === 1) { wave = 'triangle'; dec = 0.8; sus = 0.15; rel = 0.3; cut = 4000; }        // piano, chromatic perc
    else if (fam === 2) { wave = 'square'; dec = 1; sus = 0.8; cut = 2500; lvl = 0.16; }                      // organ
    else if (fam === 3) { wave = 'sawtooth'; dec = 0.5; sus = 0.2; cut = 3200; lvl = 0.18; }                  // guitar
    else if (fam === 4) { wave = 'sawtooth'; dec = 0.3; sus = 0.6; cut = 900; lvl = 0.3; }                     // bass
    else if (fam === 5 || fam === 6) { wave = 'sawtooth'; atk = 0.08; sus = 0.8; rel = 0.4; cut = 3000; detune = 8; lvl = 0.13; } // strings, ensemble
    else if (fam === 7 || fam === 8) { wave = 'square'; atk = 0.03; sus = 0.7; cut = 2600; lvl = 0.15; }    // brass, reed
    else if (fam === 9) { wave = 'sine'; atk = 0.04; sus = 0.8; lvl = 0.3; }                                   // pipe
    else if (fam === 10) { wave = 'sawtooth'; sus = 0.7; cut = 5000; lvl = 0.16; detune = 6; }                 // synth lead
    else if (fam === 11) { wave = 'sawtooth'; atk = 0.3; sus = 0.9; rel = 0.8; cut = 1800; detune = 12; lvl = 0.12; } // pads
    const end = t + n.d;
    const g = ctx.createGain();
    const flt = ctx.createBiquadFilter(); flt.type = 'lowpass'; flt.frequency.value = Math.min(cut + f * 2, ctx.sampleRate * 0.45); flt.Q.value = 0.7;
    flt.connect(g).connect(out);
    const peak = v * lvl;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + atk);
    g.gain.setTargetAtTime(peak * sus, t + atk, dec / 3);
    g.gain.setTargetAtTime(0, end, rel / 4);
    const voices = detune ? [-detune, detune] : [0];
    for (const dt of voices) {
      const o = ctx.createOscillator(); o.type = wave; o.frequency.value = f; o.detune.value = dt;
      o.connect(flt); o.start(t); o.stop(end + rel * 1.5 + 0.05);
    }
  }

  /** Render a list of notes {t, d, ch, note, vel, prog} (seconds) to a stereo AudioBuffer. */
  SP.renderNotes = async function (notes, sampleRate) {
    const MAX = 600;
    const last = notes.reduce((m, n) => Math.max(m, n.t + n.d), 0);
    const dur = Math.min(MAX, last + 1.2);
    const sr = sampleRate || 44100;
    const ctx = new OfflineAudioContext(2, Math.ceil(dur * sr), sr);
    const bus = ctx.createGain(); bus.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -10; comp.ratio.value = 4;
    bus.connect(comp).connect(ctx.destination);
    const nz = noise(ctx);
    for (const n of notes) if (n.t < MAX) voice(ctx, bus, n, nz);
    return ctx.startRendering();
  };

  /** Render MIDI bytes to an AudioBuffer (stereo). */
  SP.renderMidi = async function (bytes, sampleRate) {
    const midi = parseMidi(bytes);
    if (!midi.notes.length) throw new Error('This MIDI file has no notes');
    const buf = await SP.renderNotes(midi.notes, sampleRate);
    return { buffer: buf, bpm: midi.bpm, noteCount: midi.notes.length };
  };
  SP.parseMidi = parseMidi;
})();
