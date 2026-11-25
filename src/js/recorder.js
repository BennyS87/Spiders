// Spiders - record sounds straight into the project: from a microphone or audio interface,
// or by resampling Spiders' own output. Free recording, or in time with the song (with a count-in).
(function () {
  const SP = (window.Spiders = window.Spiders || {});
  const MAX_SECONDS = 600;
  const prefs = { source: 'mic', deviceId: '', channels: 'mono', timing: 'free', bars: 0, monitor: false, normalise: true };
  let st = null; // live state of the open recorder

  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };
  const fmtClock = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return m + ':' + (r < 10 ? '0' : '') + r.toFixed(1); };

  // ---------------- input ----------------
  async function openInput(ctx) {
    closeInput();
    if (prefs.source === 'output') {
      // resample: tap the master output after the limiter
      st.inputNode = SP.app.engine.master.out;
      st.latency = 0;
      st.stream = null;
    } else {
      const native = window.spidersNative;
      if (native && native.askMic) {
        const status = await native.askMic();
        if (status !== 'granted') throw Object.assign(new Error('Microphone access is off for Spiders'), { mic: true });
      }
      if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) throw new Error('Audio input is not available here');
      const audio = { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: { ideal: 2 } };
      if (prefs.deviceId) audio.deviceId = { exact: prefs.deviceId };
      let stream;
      try { stream = await navigator.mediaDevices.getUserMedia({ audio }); }
      catch (e) {
        if (prefs.deviceId && (e.name === 'OverconstrainedError' || e.name === 'NotFoundError')) { prefs.deviceId = ''; delete audio.deviceId; stream = await navigator.mediaDevices.getUserMedia({ audio }); }
        else throw Object.assign(e, { mic: e.name === 'NotAllowedError' || e.name === 'SecurityError' });
      }
      st.stream = stream;
      st.inputNode = ctx.createMediaStreamSource(stream);
      const set = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].getSettings() : {};
      st.inputLatency = set.latency || 0;
      // what you hear back from Spiders reaches the mic after the output and input delays
      st.latency = (ctx.outputLatency || 0) + (ctx.baseLatency || 0) + st.inputLatency;
      st.deviceLabel = stream.getAudioTracks()[0] ? stream.getAudioTracks()[0].label : '';
    }
    // level meter
    st.analyser = ctx.createAnalyser(); st.analyser.fftSize = 1024;
    st.inputNode.connect(st.analyser);
    // monitoring (mic only)
    st.monitor = ctx.createGain(); st.monitor.gain.value = prefs.monitor && prefs.source === 'mic' ? 1 : 0;
    if (prefs.source === 'mic') st.inputNode.connect(st.monitor).connect(ctx.destination);
    // the capture worklet
    await SP.Spectral.prepare(ctx);
    st.rec = new AudioWorkletNode(ctx, 'spiders-recorder', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], channelCount: 2, channelCountMode: 'explicit', channelInterpretation: 'discrete' });
    st.inputNode.connect(st.rec);
    st.sink = ctx.createGain(); st.sink.gain.value = 0;
    st.rec.connect(st.sink).connect(ctx.destination);
    st.rec.port.onmessage = (e) => onData(e.data);
  }
  function closeInput() {
    if (!st) return;
    // only undo our own connections (the input may be Spiders' master output)
    if (st.inputNode) for (const n of [st.rec, st.analyser, st.monitor]) { if (n) { try { st.inputNode.disconnect(n); } catch (e) { } } }
    for (const n of ['rec', 'analyser', 'monitor', 'sink']) { if (st[n]) { try { st[n].disconnect(); } catch (e) { } st[n] = null; } }
    st.inputNode = null;
    if (st.stream) { st.stream.getTracks().forEach(t => t.stop()); st.stream = null; }
  }

  // ---------------- capture ----------------
  function onData(m) {
    if (m.type === 'data') {
      if (!st.chunks.length) st.t0 = m.t;
      st.chunks.push(m); st.samples += m.l.length;
      st.channelsSeen = Math.max(st.channelsSeen, m.ch || 1);
      if (st.samples / st.sr > MAX_SECONDS) stopRecording();
    } else if (m.type === 'stopped' && st.onStopped) { const f = st.onStopped; st.onStopped = null; f(); }
  }

  async function startRecording() {
    const app = SP.app, engine = app.engine;
    engine.init(); await engine.resume();
    const ctx = engine.ctx;
    st.sr = ctx.sampleRate; st.chunks = []; st.samples = 0; st.channelsSeen = 1; st.result = null;
    st.cutStart = null; st.cutEnd = null;
    if (!st.rec) await openInput(ctx);
    st.rec.port.postMessage({ type: 'start' });
    st.recording = true;
    if (prefs.timing === 'song') {
      const p = app.project, spb = 60 / p.bpm, bpb = p.beatsPerBar;
      const startBeat = p.loop.on ? p.loop.start : Math.floor(engine.posBeat / bpb) * bpb;
      if (engine.playing) engine.stop();
      engine.forceClick = true;
      engine.start(startBeat - bpb); // one bar count-in
      const a = engine.anchors[0];
      const downbeat = a.t + bpb * spb;
      st.cutStart = downbeat + st.latency;
      st.cutEnd = prefs.bars ? st.cutStart + prefs.bars * bpb * spb : null;
      st.countInEnd = downbeat;
      st.songMode = true;
      engine.onStopRecorder = () => { if (st && st.recording) stopRecording(); };
    } else {
      st.songMode = false;
      st.cutStart = ctx.currentTime;
    }
    render();
  }

  function stopRecording() {
    if (!st || !st.recording) return;
    const engine = SP.app.engine;
    st.recording = false;
    const stopAt = engine.ctx.currentTime;
    if (st.cutEnd == null) st.cutEnd = stopAt + (st.songMode ? st.latency : 0);
    engine.forceClick = false;
    engine.onStopRecorder = null;
    if (st.songMode && engine.playing) engine.stop();
    st.onStopped = () => finish();
    st.rec.port.postMessage({ type: 'stop' });
  }

  function finish() {
    const sr = st.sr, total = st.samples;
    const L = new Float32Array(total), R = new Float32Array(total);
    let o = 0;
    for (const c of st.chunks) { L.set(c.l, o); R.set(c.r, o); o += c.l.length; }
    st.chunks = [];
    const i0 = Math.max(0, Math.round((st.cutStart - st.t0) * sr));
    const i1 = Math.min(total, Math.round((st.cutEnd - st.t0) * sr));
    if (i1 - i0 < sr * 0.02) { st.result = null; toast('Nothing was recorded. Check the input level and try again.'); render(); return; }
    let l = L.subarray(i0, i1), r = R.subarray(i0, i1);
    // mono: use the louder side if one input is silent (e.g. a mic on input 1 of an interface), otherwise mix
    let pl = 0, pr = 0;
    for (let i = 0; i < l.length; i++) { pl = Math.max(pl, Math.abs(l[i])); pr = Math.max(pr, Math.abs(r[i])); }
    const oneSided = pr < pl * 0.05 || pl < pr * 0.05;
    const stereo = (prefs.source === 'output' || prefs.channels === 'stereo') && st.channelsSeen > 1 && !oneSided;
    let ch;
    if (stereo) ch = [Float32Array.from(l), Float32Array.from(r)];
    else if (st.channelsSeen < 2 || pr < pl * 0.05) ch = [Float32Array.from(l)];
    else if (pl < pr * 0.05) ch = [Float32Array.from(r)];
    else { const m = new Float32Array(l.length); for (let i = 0; i < l.length; i++) m[i] = (l[i] + r[i]) * 0.5; ch = [m]; }
    let peak = 0; for (const c of ch) for (let i = 0; i < c.length; i++) peak = Math.max(peak, Math.abs(c[i]));
    st.result = { ch, sr, peak, a: 0, b: ch[0].length / sr, songMode: st.songMode };
    if (!st.songMode && prefs.source === 'mic') trimSilence(false);
    render();
  }

  function trimSilence(announce) {
    const r = st.result; if (!r) return;
    const d = r.ch[0], sr = r.sr;
    const thr = Math.max(0.003, r.peak * 0.03); // about -30 dB below the peak
    let a = 0, b = d.length - 1;
    while (a < d.length && Math.abs(d[a]) < thr) a++;
    while (b > a && Math.abs(d[b]) < thr) b--;
    if (a >= b) return;
    r.a = Math.max(0, a / sr - 0.02); r.b = Math.min(d.length / sr, b / sr + 0.12);
    if (announce) drawResult();
  }

  // ---------------- preview ----------------
  function stopPreview() { if (st && st.preview) { try { st.preview.stop(); } catch (e) { } st.preview = null; } }
  function playPreview() {
    stopPreview();
    const r = st.result; if (!r) return;
    const ctx = SP.app.engine.ctx;
    const buf = buildBuffer(ctx, true);
    const src = ctx.createBufferSource(); src.buffer = buf;
    src.connect(SP.app.engine.master.input);
    src.start(); st.preview = src; st.previewStart = ctx.currentTime;
    src.onended = () => { if (st && st.preview === src) st.preview = null; };
  }
  function buildBuffer(ctx, forPreview) {
    const r = st.result;
    const i0 = Math.round(r.a * r.sr), i1 = Math.max(i0 + 1, Math.round(r.b * r.sr));
    const n = i1 - i0;
    const buf = ctx.createBuffer(r.ch.length, n, r.sr);
    let gain = 1;
    if (prefs.normalise) { let pk = 0; for (const c of r.ch) for (let i = i0; i < i1; i++) pk = Math.max(pk, Math.abs(c[i])); if (pk > 1e-4) gain = 0.89 / pk; }
    const fade = Math.min(Math.round(r.sr * 0.004), n >> 2);
    r.ch.forEach((c, k) => {
      const d = buf.getChannelData(k);
      for (let i = 0; i < n; i++) d[i] = c[i0 + i] * gain;
      for (let i = 0; i < fade; i++) { d[i] *= i / fade; d[n - 1 - i] *= i / fade; }
    });
    void forPreview;
    return buf;
  }

  async function addToProject() {
    const r = st.result; if (!r) return;
    const app = SP.app;
    const buf = buildBuffer(app.engine.ctx, false);
    const wav = SP.Export.encodeWav(buf);
    const nameIn = document.getElementById('recName');
    const name = (nameIn && nameIn.value.trim()) || nextName();
    const songMode = r.songMode;
    close();
    await app.importFiles([{ name: name + '.wav', data: wav }], songMode ? { settings: { mode: 'beats', beatDivName: '1/16', beatDiv: 0.25 } } : null);
  }
  function nextName() {
    const names = new Set(SP.app.project.samples.map(s => s.name));
    let i = 1; while (names.has('Recording ' + i)) i++;
    return 'Recording ' + i;
  }

  // ---------------- drawing ----------------
  function drawLive() {
    if (!st) return;
    st.raf = requestAnimationFrame(drawLive);
    // input meter
    if (st.analyser) {
      const buf = st.meterBuf || (st.meterBuf = new Float32Array(1024));
      st.analyser.getFloatTimeDomainData(buf);
      let pk = 0; for (let i = 0; i < buf.length; i++) pk = Math.max(pk, Math.abs(buf[i]));
      st.level = Math.max(pk, (st.level || 0) * 0.9);
      st.hold = pk > (st.hold || 0) ? pk : Math.max(0, (st.hold || 0) - 0.004);
      const db = 20 * Math.log10(st.level + 1e-6), w = Math.max(0, Math.min(1, (db + 60) / 60));
      const bar = document.querySelector('#recMeter i'), hb = document.querySelector('#recMeter b');
      if (bar) bar.style.width = (w * 100) + '%';
      if (hb) hb.style.left = (Math.max(0, Math.min(1, (20 * Math.log10(st.hold + 1e-6) + 60) / 60)) * 100) + '%';
      const clip = document.getElementById('recClip'); if (clip && pk >= 0.99) clip.style.visibility = 'visible';
    }
    const clock = document.getElementById('recClock'), state = document.getElementById('recState');
    const ctx = SP.app.engine.ctx;
    if (st.recording && clock && ctx) {
      const now = ctx.currentTime;
      if (st.songMode && now < st.countInEnd) {
        const p = SP.app.project, spb = 60 / p.bpm;
        clock.textContent = 'Count-in ' + Math.max(1, Math.ceil((st.countInEnd - now) / spb));
        state.textContent = 'Get ready: recording starts on the downbeat.';
      } else {
        const el2 = Math.max(0, now - (st.songMode ? st.countInEnd : st.cutStart));
        clock.textContent = fmtClock(el2);
        state.textContent = st.songMode ? (prefs.bars ? `Recording ${prefs.bars} bar${prefs.bars > 1 ? 's' : ''} in time with the song…` : 'Recording in time with the song… press Stop when you’re done.') : 'Recording… press Stop when you’re done.';
        if (st.cutEnd != null && now >= st.cutEnd + 0.05) stopRecording();
      }
      drawWave(true);
    } else if (st.preview && st.result && ctx) drawResult();
  }
  function drawWave(live) {
    const cv = document.getElementById('recWave'); if (!cv) return;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 600, H = cv.clientHeight || 130;
    if (cv.width !== W * dpr) { cv.width = W * dpr; cv.height = H * dpr; }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
    if (!live) return;
    // last 10 seconds, scrolling
    const span = 10 * st.sr, total = st.samples, start = Math.max(0, total - span);
    const mid = H / 2;
    g.fillStyle = '#ff5c8a';
    let idx = 0, chunkStart = 0;
    for (let x = 0; x < W; x++) {
      const a = start + Math.floor(x / W * span), b = start + Math.floor((x + 1) / W * span);
      if (a >= total) break;
      let lo = 0, hi = 0;
      for (let s = a; s < b && s < total; s += 4) {
        while (idx < st.chunks.length && s >= chunkStart + st.chunks[idx].l.length) { chunkStart += st.chunks[idx].l.length; idx++; }
        if (idx >= st.chunks.length) break;
        const c = st.chunks[idx], v = Math.max(Math.abs(c.l[s - chunkStart]), Math.abs(c.r[s - chunkStart]));
        if (v > hi) hi = v; if (-v < lo) lo = -v;
      }
      g.fillRect(x, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
    }
  }
  function drawResult() {
    const cv = document.getElementById('recWave'); if (!cv || !st.result) return;
    const r = st.result, d = r.ch[0], dur = d.length / r.sr;
    const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 600, H = cv.clientHeight || 130;
    cv.width = W * dpr; cv.height = H * dpr;
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
    const mid = H / 2, xa = r.a / dur * W, xb = r.b / dur * W;
    g.fillStyle = 'rgba(255,92,138,0.12)'; g.fillRect(xa, 0, xb - xa, H);
    for (let x = 0; x < W; x++) {
      const a = Math.floor(x / W * d.length), b = Math.max(a + 1, Math.floor((x + 1) / W * d.length));
      let lo = 0, hi = 0;
      for (const c of r.ch) for (let i = a; i < b; i += 2) { if (c[i] > hi) hi = c[i]; if (c[i] < lo) lo = c[i]; }
      g.fillStyle = x >= xa && x <= xb ? '#ff5c8a' : '#3a4152';
      g.fillRect(x, mid - hi * mid * 0.92, 1, Math.max(1, (hi - lo) * mid * 0.92));
    }
    for (const xx of [xa, xb]) { g.fillStyle = '#fff'; g.fillRect(xx - 1, 0, 2, H); g.fillRect(xx === xa ? xx : xx - 9, 0, 9, 12); }
    if (st.preview) {
      const t = r.a + (SP.app.engine.ctx.currentTime - st.previewStart);
      if (t <= r.b) { g.fillStyle = '#6ee7ff'; g.fillRect(t / dur * W, 0, 1.5, H); }
    }
    const info = document.getElementById('recInfo');
    if (info) info.innerHTML = `<b>${fmtClock(r.b - r.a)}</b> kept of ${fmtClock(dur)} · ${r.ch.length === 2 ? 'stereo' : 'mono'} · peak ${(20 * Math.log10(r.peak + 1e-9)).toFixed(1)} dB<span style="color:var(--dimmer)"> · drag the white edges to trim</span>`;
  }

  // ---------------- UI ----------------
  function toast(m, ms) { SP.app.toast(m, ms); }
  async function listDevices() {
    try {
      const all = await navigator.mediaDevices.enumerateDevices();
      return all.filter(d => d.kind === 'audioinput');
    } catch (e) { return []; }
  }

  function render() {
    const m = st && st.modal; if (!m) return;
    const p = SP.app.project;
    m.innerHTML = '';
    const head = el('div', 'cellhead', `<h2>Record a sound</h2><span class="sub">${prefs.source === 'mic' ? 'from a microphone or audio interface' : 'resample whatever Spiders is playing'}</span>`);
    const x = el('button', 'small ghost', 'Close'); x.onclick = close; head.appendChild(x);
    m.appendChild(head);
    const busy = st.recording;
    const segBtns = (opts, val, pick) => {
      const s = el('div', 'seg');
      for (const [v, l, title] of opts) { const b = el('button', v === val ? 'on' : '', l); if (title) b.title = title; b.disabled = busy; b.onclick = () => pick(v); s.appendChild(b); }
      return s;
    };
    const row = (label, ...kids) => { const r = el('div', 'recrow'); r.appendChild(el('label', '', label)); kids.forEach(k => r.appendChild(k)); m.appendChild(r); return r; };

    row('Source', segBtns([['mic', 'Microphone / interface'], ['output', 'Spiders’ own output', 'Record what Spiders plays (pads, the map, the song) into a new sound']], prefs.source, async v => { prefs.source = v; prefs.normalise = v === 'mic'; await reopen(); }));
    if (prefs.source === 'mic') {
      const sel = el('select');
      const def = el('option', '', 'Default input'); def.value = ''; sel.appendChild(def);
      for (const d of st.devices || []) { const o = el('option', '', SP.escape(d.label || 'Input ' + (d.deviceId || '').slice(0, 6))); o.value = d.deviceId; if (d.deviceId === prefs.deviceId) o.selected = true; sel.appendChild(o); }
      sel.disabled = busy;
      sel.onchange = async () => { prefs.deviceId = sel.value; await reopen(); };
      const mon = el('label', '', `<input type="checkbox" ${prefs.monitor ? 'checked' : ''}> Hear the input`); mon.style.whiteSpace = 'nowrap';
      mon.style.cssText = 'display:flex;align-items:center;gap:5px;color:var(--dim);font-size:11px;cursor:pointer';
      mon.title = 'Play the input through your speakers or headphones while you record. Use headphones to avoid feedback.';
      mon.querySelector('input').onchange = (e) => { prefs.monitor = e.target.checked; if (st.monitor) st.monitor.gain.setTargetAtTime(prefs.monitor ? 1 : 0, SP.app.engine.ctx.currentTime, 0.02); };
      row('Input', sel, mon);
      row('Channels', segBtns([['mono', 'Mono'], ['stereo', 'Stereo']], prefs.channels, v => { prefs.channels = v; render(); }));
    }
    const lvl = el('div', 'inmeter', '<i></i><b></b>'); lvl.id = 'recMeter';
    const clip = el('span', '', 'CLIP'); clip.id = 'recClip'; clip.style.cssText = 'visibility:hidden;color:#fff;background:var(--rec);font-size:9px;font-weight:800;padding:2px 5px;border-radius:4px;cursor:pointer'; clip.title = 'The input hit full scale. Click to reset.'; clip.onclick = () => { clip.style.visibility = 'hidden'; };
    row('Level', lvl, clip);
    row('Timing', segBtns([['free', 'Free'], ['song', 'In time with the song', 'One bar of count-in, then records on the downbeat with the metronome']], prefs.timing, v => { prefs.timing = v; render(); }));
    if (prefs.timing === 'song') {
      const bars = el('select');
      for (const [v, l] of [[0, 'Until I press Stop'], [1, '1 bar'], [2, '2 bars'], [4, '4 bars'], [8, '8 bars'], [16, '16 bars']]) { const o = el('option', '', l); o.value = v; if (v === prefs.bars) o.selected = true; bars.appendChild(o); }
      bars.disabled = busy;
      bars.onchange = () => { prefs.bars = +bars.value; };
      row('Length', bars, el('span', '', `<span style="color:var(--dim);font-size:11px">${p.bpm} BPM · starts at ${p.loop.on ? 'the loop start' : 'the playhead'}, after a one-bar count-in</span>`));
    }
    if (st.error) {
      const n = el('div', 'recnote', SP.escape(st.error));
      if (st.micBlocked && window.spidersNative && window.spidersNative.openMicSettings) {
        const b = el('button', 'small', 'Open microphone settings'); b.style.marginLeft = '8px';
        b.onclick = () => window.spidersNative.openMicSettings();
        n.appendChild(b);
      }
      m.appendChild(n);
    }

    const big = el('div', 'recbig');
    const go = el('button', busy ? 'stop' : '', busy ? '■ Stop' : '● Record'); go.id = 'recGo';
    go.onclick = () => { if (st.recording) stopRecording(); else startRecording().catch(e => fail(e)); };
    const clock = el('span', 'clock', st.result ? fmtClock(st.result.b - st.result.a) : '0:00.0'); clock.id = 'recClock';
    const state = el('span', 'state', st.result ? 'Recorded. Trim it, give it a name and add it to the project.' : busy ? '' : 'Press Record when you’re ready.'); state.id = 'recState';
    big.append(go, clock, state);
    m.appendChild(big);

    const wave = el('canvas', 'recwave'); wave.id = 'recWave'; m.appendChild(wave);
    const info = el('div', 'cellinfo'); info.id = 'recInfo'; m.appendChild(info);
    if (st.result) {
      bindTrim(wave);
      requestAnimationFrame(drawResult);
      const r2 = el('div', 'recrow');
      const name = el('input'); name.type = 'text'; name.id = 'recName'; name.value = st.name || nextName(); name.style.flex = '1';
      name.oninput = () => { st.name = name.value; };
      name.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') addToProject(); };
      r2.append(el('label', '', 'Name'), name);
      m.appendChild(r2);
      const r3 = el('div', 'recrow');
      const play = el('button', 'small', '▶ Play'); play.onclick = () => (st.preview ? stopPreview() : playPreview());
      const trim = el('button', 'small', 'Trim silence'); trim.onclick = () => trimSilence(true);
      const all = el('button', 'small ghost', 'Keep everything'); all.onclick = () => { st.result.a = 0; st.result.b = st.result.ch[0].length / st.result.sr; drawResult(); };
      const norm = el('label', '', `<input type="checkbox" ${prefs.normalise ? 'checked' : ''}> Normalise`);
      norm.style.cssText = 'display:flex;align-items:center;gap:5px;color:var(--dim);font-size:11px;cursor:pointer';
      norm.title = 'Raise the level so the loudest point is just under full scale';
      norm.querySelector('input').onchange = (e) => { prefs.normalise = e.target.checked; };
      r3.append(el('label', '', ''), play, trim, all, norm);
      m.appendChild(r3);
      if (st.result.songMode) m.appendChild(el('div', 'hint', 'This take starts on the downbeat, so it will be sliced on the beat (1/16). You can change that in Slicing afterwards.'));
    } else requestAnimationFrame(() => drawWave(false));

    const foot = el('div', 'foot');
    if (st.result) {
      const again = el('button', 'ghost', 'Record again'); again.onclick = () => { stopPreview(); st.result = null; st.name = null; render(); };
      const add = el('button', 'accent', 'Add to project'); add.onclick = addToProject;
      foot.append(again, add);
    } else {
      const c = el('button', 'ghost', 'Cancel'); c.onclick = close; c.disabled = busy;
      foot.append(c);
    }
    m.appendChild(foot);
    if (!st.result && !busy) m.appendChild(el('div', 'hint', prefs.source === 'mic'
      ? 'Tip: wear headphones if you turn on “Hear the input” or record in time with the song, so the speakers don’t leak into the mic. Takes are kept up to 10 minutes.'
      : 'Play pads, drag across the map or start the song while recording; the result becomes a new sound you can map and slice again.'));
  }

  function bindTrim(cv) {
    let drag = null;
    const tOf = (e) => { const r = cv.getBoundingClientRect(), res = st.result; return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * res.ch[0].length / res.sr; };
    cv.style.cursor = 'ew-resize';
    cv.addEventListener('pointerdown', (e) => {
      const r = st.result; if (!r) return;
      const t = tOf(e);
      drag = Math.abs(t - r.a) < Math.abs(t - r.b) ? 'a' : 'b';
      cv.setPointerCapture(e.pointerId);
      cv.dispatchEvent(new PointerEvent('pointermove', e));
    });
    cv.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const r = st.result, t = tOf(e);
      if (drag === 'a') r.a = Math.min(t, r.b - 0.01); else r.b = Math.max(t, r.a + 0.01);
      drawResult();
    });
    const up = () => { drag = null; };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
  }

  function fail(e) {
    console.warn(e);
    st.recording = false;
    st.micBlocked = !!e.mic;
    st.error = e.mic
      ? (window.spidersNative ? 'Spiders isn’t allowed to use the microphone. Turn it on in System Settings → Privacy & Security → Microphone, then try again.' : 'Microphone access was blocked. Allow it for this page and try again.')
      : e.name === 'NotFoundError' || /not found/i.test(e.message || '') ? 'No audio input was found. Plug in a microphone or interface, or choose “Spiders’ own output”.'
      : 'Couldn’t open the input: ' + (e.message || e.name || e);
    render();
  }

  async function reopen() {
    st.error = null; st.micBlocked = false;
    try {
      SP.app.engine.init();
      await openInput(SP.app.engine.ctx);
      if (prefs.source === 'mic') st.devices = await listDevices();
    } catch (e) { fail(e); return; }
    render();
  }

  async function open() {
    if (st) return;
    const root = document.getElementById('modalRoot');
    root.innerHTML = '';
    const back = el('div', 'modal-back'), m = el('div', 'modal recmodal');
    back.appendChild(m); root.appendChild(back);
    back.addEventListener('pointerdown', (e) => { if (e.target === back && !st.recording) close(); });
    st = { modal: m, back, chunks: [], samples: 0 };
    // close cleanly if something else replaces the modal (e.g. Escape)
    st.observer = new MutationObserver(() => { if (st && !root.contains(back)) cleanup(); });
    st.observer.observe(root, { childList: true });
    render();
    drawLive();
    await reopen();
  }
  function cleanup() {
    if (!st) return;
    if (st.recording) { st.recording = false; try { st.rec.port.postMessage({ type: 'stop' }); } catch (e) { } const eng = SP.app.engine; eng.forceClick = false; eng.onStopRecorder = null; if (st.songMode && eng.playing) eng.stop(); }
    stopPreview();
    cancelAnimationFrame(st.raf);
    if (st.observer) st.observer.disconnect();
    closeInput();
    st = null;
  }
  function close() {
    const root = document.getElementById('modalRoot');
    const s = st;
    cleanup();
    if (s && root.contains(s.back)) root.innerHTML = '';
  }

  SP.Recorder = { open, close, isOpen: () => !!st };
})();
