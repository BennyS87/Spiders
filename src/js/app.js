// Spiders - app state, undo, import / analysis, live playing (mouse, keys, MIDI), recording, files, export.
(function () {
  const SP = window.Spiders;
  const native = window.spidersNative || null;
  const $ = (id) => document.getElementById(id);

  // keyboard pads: four rows, laid out like the keys
  const ROWS = [
    ['Digit1', '1'], ['Digit2', '2'], ['Digit3', '3'], ['Digit4', '4'], ['Digit5', '5'], ['Digit6', '6'], ['Digit7', '7'], ['Digit8', '8'], ['Digit9', '9'], ['Digit0', '0'],
    ['KeyQ', 'Q'], ['KeyW', 'W'], ['KeyE', 'E'], ['KeyR', 'R'], ['KeyT', 'T'], ['KeyY', 'Y'], ['KeyU', 'U'], ['KeyI', 'I'], ['KeyO', 'O'], ['KeyP', 'P'],
    ['KeyA', 'A'], ['KeyS', 'S'], ['KeyD', 'D'], ['KeyF', 'F'], ['KeyG', 'G'], ['KeyH', 'H'], ['KeyJ', 'J'], ['KeyK', 'K'], ['KeyL', 'L'], ['Semicolon', ';'],
    ['KeyZ', 'Z'], ['KeyX', 'X'], ['KeyC', 'C'], ['KeyV', 'V'], ['KeyB', 'B'], ['KeyN', 'N'], ['KeyM', 'M'], ['Comma', ','], ['Period', '.'], ['Slash', '/']
  ];
  SP.KEYS = ROWS.map(([code, label]) => ({ code, label }));
  const KEY_INDEX = Object.fromEntries(ROWS.map(([c], i) => [c, i]));
  const MELODIC = { KeyA: 0, KeyW: 1, KeyS: 2, KeyE: 3, KeyD: 4, KeyF: 5, KeyT: 6, KeyG: 7, KeyY: 8, KeyH: 9, KeyU: 10, KeyJ: 11, KeyK: 12, KeyO: 13, KeyL: 14, KeyP: 15, Semicolon: 16 };

  const DEFAULT_SETTINGS = { mode: 'transients', sensitivity: 0.7, maxSliceMs: 400, sliceMs: 150, beatDiv: 0.25, beatDivName: '1/16', clusters: 0, layout: 'web' };

  function newTrack(i) {
    return {
      id: SP.uid('trk'), name: 'Track ' + (i + 1), color: SP.TRACK_COLORS[i % SP.TRACK_COLORS.length],
      volume: 0.85, pan: 0, mute: false, solo: false,
      sound: Object.assign({}, SP.SOUND_DEFAULTS), effects: [],
      playMode: 'pads', melodic: null,
      pads: new Array(40).fill(null), padNotes: Array.from({ length: 40 }, (_, k) => 36 + k),
      events: []
    };
  }
  function newProject() {
    const t = newTrack(0);
    return {
      app: 'Spiders', version: 1, bpm: 120, beatsPerBar: 4,
      loop: { on: true, start: 0, end: 16 }, metronome: false, quantize: '1/16', snap: '1/16', master: 0.8,
      samples: [], tracks: [t], selectedTrack: t.id, selectedSample: null, tab: 'pads'
    };
  }

  const app = SP.app = {
    project: newProject(), analysis: new Map(), audio: new Map(),
    engine: new SP.Engine(),
    undoStack: [], redoStack: [], lastSnap: null, dirty: false, filePath: null, fileName: 'Untitled',
    selFrame: null, selPad: 0, assignMode: false, learnPad: -1, octave: 0,
    recording: false, held: new Map(), clipboard: null
  };
  const engine = app.engine;

  // ---------------- helpers ----------------
  const snapReplacer = (k, v) => (k && k[0] === '_' ? undefined : v);
  const snap = () => JSON.stringify(app.project, snapReplacer);
  app.selTrack = () => app.project.tracks.find(t => t.id === app.project.selectedTrack) || null;
  app.sampleName = (id) => { const s = app.project.samples.find(x => x.id === id); return s ? s.name : '(missing sound)'; };
  app.frameAt = (sid, t) => {
    const an = app.analysis.get(sid); if (!an) return -1;
    if (!an.n) return -1;
    let lo = 0, hi = an.n - 1;
    while (lo < hi) { const m = (lo + hi + 1) >> 1; if (an.starts[m] <= t) lo = m; else hi = m - 1; }
    if (an.gaps && (t > an.ends[lo] + 1e-6 || t < an.starts[lo] - 1e-6)) return -1; // manual cells can leave gaps
    return lo;
  };
  app.sampleById = (id) => app.project.samples.find(x => x.id === id) || null;
  /** A cell's own edits (bounds, gain, pitch, reverse, effects), or null. */
  app.cellEdit = (sid, frame) => { const s = app.sampleById(sid); return s && s.cells && frame != null && frame >= 0 ? s.cells[frame] || null : null; };
  app.hitFor = (sid, frame) => {
    const an = app.analysis.get(sid); if (!an || frame < 0 || frame >= an.n) return null;
    const ed = app.cellEdit(sid, frame);
    return { sampleId: sid, frame, start: ed ? ed.start : an.starts[frame], end: ed ? ed.end : an.ends[frame] };
  };
  /**
   * Which cells a spectral voice should blend at a point of the map (layout units).
   * Returns [[start, end, weight], ...]; Spread widens the blend to neighbouring cells.
   */
  app.sourcesAt = (sid, x, y, spread) => {
    const an = app.analysis.get(sid); if (!an || !an.n) return [];
    const near = [];
    for (let i = 0; i < an.n; i++) {
      if (an.cluster[i] < 0 || !isFinite(an.x[i])) continue;
      const dx = an.x[i] - x, dy = an.y[i] - y;
      near.push([dx * dx + dy * dy, i]);
    }
    if (!near.length) return [];
    near.sort((a, b) => a[0] - b[0]);
    if (!an._spacing) { let cnt = 0; for (let i = 0; i < an.n; i++) if (an.cluster[i] >= 0) cnt++; an._spacing = Math.sqrt((an.aspect || 1.75) / Math.max(1, cnt)); }
    const sig = an._spacing * (0.05 + 2.4 * (spread || 0));
    const out = [];
    const d0 = near[0][0];
    for (let q = 0; q < Math.min(10, near.length); q++) {
      const [d, i] = near[q];
      const w = (spread || 0) < 0.01 ? (q ? 0 : 1) : Math.exp(-(d - d0) / (sig * sig));
      if (w < 0.03) break;
      const ed = app.cellEdit(sid, i);
      out.push([ed ? ed.start : an.starts[i], ed ? ed.end : an.ends[i], w]);
    }
    return out;
  };
  engine.spectralSources = (hit, spread) => {
    const an = app.analysis.get(hit.sampleId); if (!an) return [[hit.start, hit.end, 1]];
    let x = hit.x, y = hit.y;
    if (x == null && hit.frame >= 0 && isFinite(an.x[hit.frame])) { x = an.x[hit.frame]; y = an.y[hit.frame]; }
    if (x == null) return [[hit.start, hit.end, 1]];
    const out = app.sourcesAt(hit.sampleId, x, y, spread);
    // the struck cell always leads, with its own (possibly edited) bounds
    if (hit.x == null && hit.start != null) { if (out.length) { out[0][0] = hit.start; out[0][1] = hit.end; } else out.push([hit.start, hit.end, 1]); }
    return out;
  };
  engine.cellEdit = (sid, frame) => app.cellEdit(sid, frame);
  engine.cellEditByKey = (key) => { const i = key.lastIndexOf(':'); return app.cellEdit(key.slice(0, i), +key.slice(i + 1)); };
  app.songEnd = () => { let e = 0; for (const t of app.project.tracks) for (const ev of t.events) e = Math.max(e, ev.t + ev.len); return e; };
  const toast = app.toast = (msg, ms) => { const t = $('toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), ms || 2600); };

  engine.scatterPick = (sid, start, end, r) => {
    const an = app.analysis.get(sid); if (!an) return null;
    const i = app.frameAt(sid, start + 1e-5); if (i < 0) return null;
    const c = an.cluster[i];
    if (c < 0) return null;
    const list = an.byCluster[c]; if (!list || list.length < 2) return null;
    const f = list[Math.floor(r * list.length) % list.length];
    return { start: an.starts[f], end: an.ends[f], frame: f };
  };

  // ---------------- undo / commit ----------------
  function markDirty(d) {
    app.dirty = d;
    if (native) { native.setDirty(d); native.setTitle(`${app.fileName}${d ? ' •' : ''} — Spiders`); }
    else document.title = `${app.fileName}${d ? ' •' : ''} — Spiders`;
  }
  app.commit = (label) => {
    const s = snap();
    if (s === app.lastSnap) { refreshAfterChange(); return; }
    if (app.lastSnap) app.undoStack.push(app.lastSnap);
    if (app.undoStack.length > 150) app.undoStack.shift();
    app.redoStack = [];
    app.lastSnap = s;
    markDirty(true);
    refreshAfterChange();
    void label;
  };
  app.touch = () => { engine.sync(app.project); };
  function refreshAfterChange() {
    engine.sync(app.project);
    app.timeline.clampScroll();
    app.map.dirtyPads = true;
  }
  function restore(s) {
    const p = JSON.parse(s);
    app.project = p;
    app.lastSnap = s;
    const ids = new Set(); for (const t of p.tracks) for (const e of t.events) ids.add(e.id);
    for (const id of [...app.timeline.sel]) if (!ids.has(id)) app.timeline.sel.delete(id);
    refreshAll();
    markDirty(true);
  }
  app.undo = () => { if (!app.undoStack.length) return toast('Nothing to undo'); app.redoStack.push(app.lastSnap); restore(app.undoStack.pop()); };
  app.redo = () => { if (!app.redoStack.length) return toast('Nothing to redo'); app.undoStack.push(app.lastSnap); restore(app.redoStack.pop()); };

  // ---------------- refresh ----------------
  function refreshAll() {
    const p = app.project;
    engine.sync(p);
    engine.setMasterVolume(p.master);
    app.map.setSample(p.selectedSample);
    app.map.invalidate();
    $('welcome').style.display = p.samples.length ? 'none' : '';
    app.timeline.renderHeaders();
    SP.Panels.renderLibrary();
    SP.Panels.renderPanel();
    app.refreshTransport();
    renderMapBar();
  }
  app.refreshAll = refreshAll;
  app.refreshPanel = () => SP.Panels.renderPanel();
  app.refreshLibrary = () => SP.Panels.renderLibrary();
  app.refreshTransport = () => {
    const p = app.project;
    $('bpm').value = p.bpm;
    $('quantize').value = p.quantize;
    $('snap').value = p.snap;
    $('loopBtn').classList.toggle('on', p.loop.on);
    $('metroBtn').classList.toggle('on', !!p.metronome);
    $('master').value = p.master;
    const len = p.loop.end - p.loop.start, sel = $('loopLen');
    sel.value = [...sel.options].some(o => +o.value === len) ? len : '';
    $('recBtn').classList.toggle('on', app.recording);
    $('playBtn').classList.toggle('playing', engine.playing);
    $('playIcon').setAttribute('d', engine.playing ? 'M6 5h4.5v14H6zm7.5 0H18v14h-4.5z' : 'M7 4.5v15l13-7.5z');
    engine.autoStopBeat = p.loop.on ? null : Math.max(app.songEnd(), 4) + p.beatsPerBar;
  };
  function renderMapBar() {
    const bar = $('mapBar'), p = app.project;
    bar.innerHTML = '';
    const s = p.samples.find(x => x.id === p.selectedSample);
    if (!s) return;
    const an = app.analysis.get(s.id);
    const t = document.createElement('span'); t.className = 'map-title'; t.textContent = s.name; bar.appendChild(t);
    if (an) { const sub = document.createElement('span'); sub.className = 'map-sub'; sub.textContent = `${an.n} cells · ${an.k} timbre groups · ${an.layout === 'web' ? 'web: time spirals outwards, one wedge per group' : an.layout === 'cells' ? 'cells: similar timbres crowd into small cells, unusual sounds get big ones' + (app.isSpectral() ? ' · press and drag to play' : '') : 'map: similar sounds sit together'}`; bar.appendChild(sub); }
    if (s._busy) { const b = document.createElement('span'); b.className = 'badge cyan'; b.textContent = 'Mapping… ' + Math.round((s._progress || 0) * 100) + '%'; bar.appendChild(b); }
    if (app.assignMode) { const b = document.createElement('span'); b.className = 'badge'; b.textContent = `Click cells to fill pads · now ${SP.KEYS[app.selPad].label} · Esc to stop`; bar.appendChild(b); }
    if (s.settings.mode === 'manual') { const b = document.createElement('span'); b.className = 'badge cyan'; b.textContent = 'Manual cells: drag on the strip below'; bar.appendChild(b); }
    const seg = document.createElement('div'); seg.className = 'seg'; seg.title = 'Layout';
    for (const [v, l] of [['web', 'Web'], ['map', 'Map'], ['cells', 'Cells']]) {
      const b = document.createElement('button'); b.textContent = l; if (s.settings.layout === v) b.className = 'on';
      b.onclick = () => { if (s.settings.layout === v || s._busy) return; app.chooseLayout(s, v); app.commit('Layout'); app.reanalyse(s.id); SP.Panels.renderLibDetail(); renderMapBar(); };
      seg.appendChild(b);
    }
    bar.appendChild(seg);
  }
  app.renderMapBar = renderMapBar;

  // ---------------- selection ----------------
  app.selectTrack = (id, quiet) => {
    if (app.project.selectedTrack === id) return;
    app.releaseAll();
    app.project.selectedTrack = id;
    app.timeline.renderHeaders();
    SP.Panels.renderPanel();
    void quiet;
  };
  app.selectSample = (id) => {
    if (app.project.selectedSample === id) return;
    app.project.selectedSample = id;
    app.map.setSample(id);
    SP.Panels.renderLibrary();
    renderMapBar();
  };
  app.revealFrame = (sid, frame) => {
    app.selectSample(sid);
    app.selFrame = { sampleId: sid, frame };
    SP.Panels.renderFrameBlock();
  };
  app.setAssignMode = (on) => {
    app.assignMode = on;
    if (on && app.selTrack() && app.selTrack().playMode !== 'pads') { app.selTrack().playMode = 'pads'; app.commit('Play mode'); }
    SP.Panels.renderPanel(); renderMapBar();
  };
  app.learnMidi = (i) => { app.learnPad = i; SP.Panels.renderPanel(); if (i >= 0) toast('Press a key on your MIDI keyboard for pad ' + SP.KEYS[i].label); };

  // ---------------- tracks ----------------
  app.addTrack = () => {
    const p = app.project, t = newTrack(p.tracks.length);
    const cur = app.selTrack();
    if (cur) { t.pads = cur.pads.map(x => x && Object.assign({}, x)); t.padNotes = cur.padNotes.slice(); t.melodic = cur.melodic && Object.assign({}, cur.melodic); }
    else if (p.selectedSample && app.analysis.get(p.selectedSample)) fillPads(t, 'cluster', p.selectedSample);
    p.tracks.push(t); p.selectedTrack = t.id;
    app.commit('Add track');
    app.timeline.renderHeaders(); SP.Panels.renderPanel();
    app.timeline.scrollY = 1e9; app.timeline.clampScroll();
  };
  app.duplicateTrack = (t) => {
    t = t || app.selTrack(); if (!t) return;
    const c = JSON.parse(JSON.stringify(t, snapReplacer));
    c.id = SP.uid('trk'); c.name = t.name + ' copy'; c.color = SP.TRACK_COLORS[app.project.tracks.length % SP.TRACK_COLORS.length];
    for (const e of c.events) e.id = SP.uid('ev');
    for (const f of c.effects) f.id = SP.uid('fx');
    app.project.tracks.splice(app.project.tracks.indexOf(t) + 1, 0, c);
    app.project.selectedTrack = c.id;
    app.commit('Duplicate track'); app.timeline.renderHeaders(); SP.Panels.renderPanel();
  };
  app.deleteTrack = async (t) => {
    t = t || app.selTrack(); if (!t) return;
    if (t.events.length && !(await confirmBox(`Delete “${t.name}” and its ${t.events.length} notes?`))) return;
    const p = app.project, i = p.tracks.indexOf(t);
    p.tracks.splice(i, 1);
    p.selectedTrack = p.tracks.length ? p.tracks[Math.max(0, i - 1)].id : null;
    app.commit('Delete track'); app.timeline.renderHeaders(); SP.Panels.renderPanel();
  };
  app.trackMenu = (e, t, rename) => {
    app.menu(e.clientX, e.clientY, [
      { label: 'Rename', action: rename },
      { label: 'Duplicate track', action: () => app.duplicateTrack(t) },
      { label: 'Clear notes', action: () => { t.events = []; app.commit('Clear notes'); } },
      '-',
      { label: 'Delete track', action: () => app.deleteTrack(t) }
    ]);
  };

  // ---------------- pads ----------------
  function fillPads(track, mode, sid) {
    const an = app.analysis.get(sid); if (!an) return;
    let list = [];
    for (let i = 0; i < an.n; i++) if (an.cluster[i] >= 0) list.push(i);
    if (mode === 'cluster') {
      // typical frame of each group first, then the next most typical, round-robin
      const per = an.byCluster.map(l => l.slice());
      const typ = an.typical;
      list = [];
      per.forEach((l, c) => { const t = typ[c]; if (t >= 0) { list.push(t); l.splice(l.indexOf(t), 1); } });
      const rest = per.map(l => { const step = Math.max(1, Math.floor(l.length / 5)); return l.filter((_, i) => i % step === 0); });
      let k = 0;
      while (list.length < 40 && rest.some(l => l.length)) { const l = rest[k % rest.length]; if (l.length) list.push(l.shift()); k++; }
    } else if (mode === 'loud') list.sort((a, b) => an.rmsDb[b] - an.rmsDb[a]);
    else if (mode === 'bright') { const step = Math.max(1, list.length / 40); const s = list.slice().sort((a, b) => an.centroid[a] - an.centroid[b]); list = []; for (let q = 0; q < 40 && Math.floor(q * step) < s.length; q++) list.push(s[Math.floor(q * step)]); }
    else if (mode === 'random') { for (let i = list.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; } }
    else if (mode === 'time') { const step = Math.max(1, list.length / 40); const s = list; list = []; for (let q = 0; q < 40 && Math.floor(q * step) < s.length; q++) list.push(s[Math.floor(q * step)]); }
    track.pads = new Array(40).fill(null).map((_, i) => i < list.length ? { sampleId: sid, frame: list[i], start: an.starts[list[i]], end: an.ends[list[i]] } : null);
  }
  app.autoFill = (track, mode) => {
    const sid = app.project.selectedSample;
    if (!sid || !app.analysis.get(sid)) return toast('Import and select a sound first');
    fillPads(track, mode, sid);
    app.commit('Fill pads'); SP.Panels.renderPanel();
  };
  app.assignPad = (i, sid, frame) => {
    const tr = app.selTrack(); if (!tr) return;
    const h = app.hitFor(sid, frame); if (!h) return;
    tr.pads[i] = { sampleId: sid, frame, start: h.start, end: h.end };
    app.selPad = i;
    app.commit('Assign pad');
    SP.Panels.renderPanel();
  };
  app.setMelodic = (tr, sid, frame) => {
    const h = app.hitFor(sid, frame); if (!h) return;
    tr.melodic = { sampleId: sid, frame, start: h.start, end: h.end };
    app.commit('Melodic frame'); SP.Panels.renderPanel();
  };
  app.currentHit = (tr) => {
    if (app.selFrame) return Object.assign(app.hitFor(app.selFrame.sampleId, app.selFrame.frame) || {}, { note: noteForFrame(tr, app.selFrame.sampleId, app.selFrame.frame) });
    if (tr && tr.playMode === 'melodic' && tr.melodic) return Object.assign({}, tr.melodic, { note: 60 });
    return null;
  };
  function noteForFrame(tr, sid, frame) {
    if (!tr) return 60;
    const i = tr.pads.findIndex(p => p && p.sampleId === sid && p.frame === frame);
    return i >= 0 ? tr.padNotes[i] : 60;
  }

  // ---------------- live playing & recording ----------------
  app.noteOn = (key, hit, note, vel) => {
    if (!hit) return;
    if (app.held.has(key)) app.noteOff(key);
    const tr = app.selTrack();
    const v = engine.playLive(tr, Object.assign({ pitch: 0 }, hit));
    let rec = null;
    if (app.recording && engine.playing && tr) {
      const beat = Math.max(0, engine.beatNow());
      rec = { id: SP.uid('ev'), sampleId: hit.sampleId, frame: hit.frame, start: hit.start, end: hit.end, t: beat, len: 0.25, pitch: hit.pitch || 0, vel: vel == null ? 0.85 : vel, note: note == null ? 60 : note, _recording: true, _skipPass: engine.pass };
      tr.events.push(rec);
    }
    app.held.set(key, { v, rec, track: tr });
  };
  app.noteOff = (key) => {
    const h = app.held.get(key); if (!h) return;
    app.held.delete(key);
    if (key === 'map') app.spectralPointer = null;
    engine.releaseLive(h.v);
    if (h.rec) finishRec(h.rec);
  };
  function finishRec(ev) {
    const p = app.project, L = p.loop;
    const now = engine.beatNow();
    let len = now - ev.t;
    if (len < 0 && L.on) len = L.end - ev.t + (now - L.start);
    const q = SP.DIVS[p.quantize] || 0;
    if (q) {
      let t = Math.round(ev.t / q) * q;
      if (L.on && t >= L.end - 1e-6) t = L.start;
      ev.t = Math.max(0, t);
      len = Math.max(q, Math.round(len / q) * q);
    }
    ev.len = Math.max(0.0625, len);
    delete ev._recording;
  }
  app.releaseAll = () => { for (const k of [...app.held.keys()]) app.noteOff(k); };
  app.padDown = (i, key, vel) => {
    const tr = app.selTrack(); if (!tr) return;
    const pd = tr.pads[i];
    SP.Panels.flashPad(i);
    if (!pd) { if (key === 'pad' && app.selFrame) toast('Empty pad: click “Use selected frame” below, or drag a cell onto it'); return; }
    app.noteOn(key, Object.assign({}, pd, { pitch: 0 }), tr.padNotes[i], vel);
  };
  function melodicDown(semi, key, vel, note) {
    const tr = app.selTrack(); if (!tr) return;
    let m = tr.melodic;
    if (!m && app.selFrame) { app.setMelodic(tr, app.selFrame.sampleId, app.selFrame.frame); m = tr.melodic; }
    if (!m) return toast('Click a cell in the map to choose the frame to play');
    app.noteOn(key, Object.assign({}, m, { pitch: semi }), note == null ? 60 + semi : note, vel);
  }

  // map / strip presses
  const isSpectral = (tr) => tr && tr.sound && tr.sound.mode === 'spectral';
  app.isSpectral = () => isSpectral(app.selTrack());
  app.updateLiveSpectral = () => {
    const tr = app.selTrack(); if (!isSpectral(tr)) return;
    const s = Object.assign({}, SP.SOUND_DEFAULTS, tr.sound);
    for (const [, h] of app.held) if (h.v && h.v.spectral) h.v.setParams({ tilt: s.tilt, texture: s.texture, shimmer: s.shimmer, width: s.width, glide: s.glide, lofi: s.quality === 'lofi' });
    const h = app.held.get('map');
    if (h && h.v && h.v.spectral && app.spectralPointer) app.spectralMove(app.spectralPointer.sid, app.spectralPointer.x, app.spectralPointer.y);
  };
  /** Switch a sound's layout. Cells is the playable landscape: fine frames, and the track plays spectral voices. */
  app.chooseLayout = (smp, layout) => {
    smp.settings.layout = layout;
    if (layout === 'cells') {
      if (smp.settings.mode !== 'manual' && !(smp.settings.mode === 'grid' && smp.settings.sliceMs <= 120)) { smp.settings.mode = 'grid'; smp.settings.sliceMs = 60; }
      const tr = app.selTrack();
      if (tr && tr.sound.mode !== 'spectral') { tr.sound.mode = 'spectral'; toast(`${tr.name} now plays spectral voices: press and drag across the cells. Change it on the Sound tab.`, 4500); SP.Panels.renderPanel(); }
    }
  };
  app.mapPress = (sid, frame, strum, pt) => {
    const tr = app.selTrack();
    app.selFrame = { sampleId: sid, frame };
    if (isSpectral(tr) && !(app.assignMode && !strum)) {
      // held spectral voice: press starts it, moving glides it across the cells
      const h = app.held.get('map');
      const an = app.analysis.get(sid);
      const p0 = pt || (an && isFinite(an.x[frame]) ? { x: an.x[frame], y: an.y[frame] } : null);
      if (strum && h && h.sid === sid) {
        if (p0) app.spectralMove(sid, p0.x, p0.y);
      } else {
        const hit = Object.assign(app.hitFor(sid, frame) || {}, p0 && pt ? { x: p0.x, y: p0.y } : {});
        app.noteOn('map', hit, noteForFrame(tr, sid, frame), 0.9);
        const nh = app.held.get('map'); if (nh) { nh.sid = sid; if (nh.rec && p0) { nh.rec.x = p0.x; nh.rec.y = p0.y; } }
        if (p0) app.spectralPointer = { sid, x: p0.x, y: p0.y, sources: app.sourcesAt(sid, p0.x, p0.y, tr.sound.spread) };
      }
      clearTimeout(app._fbT); app._fbT = setTimeout(() => SP.Panels.renderFrameBlock(), 60);
      return;
    }
    if (!strum && app.assignMode && tr) {
      app.assignPad(app.selPad, sid, frame);
      app.noteOn('map', app.hitFor(sid, frame), tr.padNotes[app.selPad], 0.9);
      app.selPad = (app.selPad + 1) % 40;
      SP.Panels.renderPanel(); renderMapBar();
    } else if (tr && tr.playMode === 'melodic' && !strum) {
      if (!tr.melodic || tr.melodic.frame !== frame || tr.melodic.sampleId !== sid) app.setMelodic(tr, sid, frame);
      app.noteOn('map', app.hitFor(sid, frame), 60, 0.9);
    } else {
      app.noteOn('map', app.hitFor(sid, frame), noteForFrame(tr, sid, frame), 0.9);
    }
    clearTimeout(app._fbT); app._fbT = setTimeout(() => SP.Panels.renderFrameBlock(), 60);
  };
  app.spectralMove = (sid, x, y) => {
    const h = app.held.get('map'), tr = app.selTrack();
    if (!h || !tr) return;
    const sources = app.sourcesAt(sid, x, y, tr.sound.spread);
    if (!sources.length) return;
    if (h.v && h.v.spectral) h.v.move(sources, 0);
    app.spectralPointer = { sid, x, y, sources };
    if (h.rec) {
      const now = engine.beatNow();
      let dt = now - h.rec.t; if (dt < 0 && app.project.loop.on) dt = app.project.loop.end - h.rec.t + (now - app.project.loop.start);
      const path = h.rec.path || (h.rec.path = []);
      const last = path[path.length - 1];
      if (!last || dt - last[0] > 0.02) path.push([Math.max(0, dt), x, y]);
    }
  };
  app.auditionEvent = (ev, tr) => {
    const strip = engine.strips.get(tr.id);
    void strip;
    app.noteOn('tl', { sampleId: ev.sampleId, frame: ev.frame, start: ev.start, end: ev.end, pitch: ev.pitch }, ev.note, ev.vel);
    if (app.held.get('tl')) app.held.get('tl').rec = null;
  };

  // drag a frame out of the map onto a pad or the timeline
  const ghost = document.createElement('div');
  ghost.style.cssText = 'position:fixed;z-index:80;pointer-events:none;padding:4px 8px;border-radius:6px;background:#ff5c8a;color:#2a0612;font-weight:700;font-size:11px;display:none';
  document.body.appendChild(ghost);
  app.dragGhost = (show, e, frame) => {
    if (!show) { ghost.style.display = 'none'; return; }
    ghost.style.display = 'block';
    ghost.textContent = `Frame ${frame + 1} → drop on a pad or a track`;
    ghost.style.left = e.clientX + 12 + 'px'; ghost.style.top = e.clientY + 12 + 'px';
  };
  app.dropFrame = (e, sid, frame) => {
    const t = document.elementFromPoint(e.clientX, e.clientY);
    if (!t) return;
    const pad = t.closest && t.closest('.pad');
    if (pad) { app.assignPad(+pad.dataset.pad, sid, frame); return; }
    if (t.id === 'timeline') {
      const tl = app.timeline, r = t.getBoundingClientRect();
      const x = e.clientX - r.left, y = e.clientY - r.top;
      const tr = app.project.tracks[tl.rowOf(y)];
      if (!tr) return;
      const h = app.hitFor(sid, frame); h.note = noteForFrame(tr, sid, frame);
      app.selectTrack(tr.id);
      tl.insertFrame(tr, h, tl.snap(tl.bOf(x)));
    }
  };
  app.placeAtPlayhead = (sid, frame) => {
    const tr = app.selTrack(); if (!tr) return toast('Add a track first');
    const h = app.hitFor(sid, frame); h.note = noteForFrame(tr, sid, frame);
    app.timeline.insertFrame(tr, h, app.timeline.snap(engine.beatNow()));
  };
  app.frameMenu = (e, sid, frame) => {
    app.selFrame = { sampleId: sid, frame };
    SP.Panels.renderFrameBlock();
    const tr = app.selTrack();
    const an = app.analysis.get(sid), c = an ? an.cluster[frame] : -1;
    const ed = app.cellEdit(sid, frame);
    const items = [
      { label: 'Edit cell…', action: () => SP.Panels.openCellEditor(sid, frame) },
      ...(ed ? [{ label: 'Reset this cell', action: () => app.resetCell(sid, frame) }] : []),
      '-',
      { label: `Put on pad ${SP.KEYS[app.selPad].label}`, action: () => app.assignPad(app.selPad, sid, frame) },
      { label: 'Put on the next empty pad', action: () => { const i = tr ? tr.pads.findIndex(p => !p) : -1; if (i < 0) return toast('All pads are full'); app.assignPad(i, sid, frame); } },
      { label: 'Play it melodically', action: () => { if (!tr) return; tr.playMode = 'melodic'; app.setMelodic(tr, sid, frame); } },
      { label: 'Place at the playhead', action: () => app.placeAtPlayhead(sid, frame) },
      '-',
      { label: 'Export this frame as WAV…', action: () => app.exportFrame(sid, frame) }
    ];
    if (c >= 0) items.push({ label: `Export all of group ${c + 1} as WAV…`, action: () => app.exportGroup(sid, c) });
    const smp = app.sampleById(sid);
    if (smp && smp.settings.mode === 'manual') items.push('-', { label: 'Delete this cell', action: () => app.deleteRegion(sid, frame) });
    app.menu(e.clientX, e.clientY, items);
  };

  // ---------------- context menu / modal ----------------
  const menuEl = $('ctxMenu');
  app.menu = (x, y, items) => {
    menuEl.innerHTML = '';
    for (const it of items) {
      if (it === '-') { menuEl.appendChild(document.createElement('hr')); continue; }
      const b = document.createElement('button'); b.textContent = it.label;
      b.onclick = () => { hideMenu(); it.action(); };
      menuEl.appendChild(b);
    }
    menuEl.style.display = 'block';
    const r = menuEl.getBoundingClientRect();
    menuEl.style.left = Math.min(x, innerWidth - r.width - 6) + 'px';
    menuEl.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  };
  const hideMenu = () => { menuEl.style.display = 'none'; };
  window.addEventListener('pointerdown', (e) => { if (!menuEl.contains(e.target)) hideMenu(); }, true);

  function modal(html) {
    const root = $('modalRoot');
    root.innerHTML = `<div class="modal-back"><div class="modal">${html}</div></div>`;
    const back = root.firstChild;
    back.addEventListener('pointerdown', e => { if (e.target === back) close(); });
    function close() { root.innerHTML = ''; }
    return { el: back.firstChild, close };
  }
  async function confirmBox(message, detail, buttons) {
    if (native) return (await native.confirm({ message, detail, buttons: buttons || ['OK', 'Cancel'] })) === 0;
    return window.confirm(message + (detail ? '\n\n' + detail : ''));
  }

  // ---------------- import & analysis ----------------
  const AUDIO_RE = /\.(wav|wave|mp3|aif|aiff|flac|ogg|oga|m4a|aac|mp4|webm)$/i, MIDI_RE = /\.(mid|midi|smf)$/i;
  app.importFiles = async (files, opts) => {
    let added = 0;
    for (const f of files) {
      const isMidi = MIDI_RE.test(f.name);
      if (!isMidi && !AUDIO_RE.test(f.name)) { toast(`${f.name}: not a sound or MIDI file`); continue; }
      const id = SP.uid('smp');
      const meta = { id, name: f.name.replace(/\.[^.]+$/, ''), kind: isMidi ? 'midi' : 'audio', settings: Object.assign({}, DEFAULT_SETTINGS) };
      if (isMidi) meta.settings.mode = 'transients';
      if (opts && opts.settings) Object.assign(meta.settings, opts.settings);
      meta._busy = true; meta._progress = 0;
      app.project.samples.push(meta);
      app.project.selectedSample = id;
      $('welcome').style.display = 'none';
      SP.Panels.renderLibrary(); renderMapBar();
      try {
        const buf = await decode(meta.kind, f.data, meta);
        app.audio.set(id, { buf, bytes: f.data, kind: meta.kind });
        engine.setBuffer(id, buf);
        await runAnalysis(meta);
        added++;
      } catch (err) {
        console.error(err);
        meta._busy = false; meta._error = true;
        app.project.samples.splice(app.project.samples.indexOf(meta), 1);
        if (app.project.selectedSample === id) app.project.selectedSample = app.project.samples.length ? app.project.samples[app.project.samples.length - 1].id : null;
        toast(`Couldn't read ${f.name}: ${err.message || err}`, 5000);
      }
    }
    if (added) {
      const tr = app.selTrack(), sid = app.project.selectedSample;
      if (tr && sid && tr.pads.every(p => !p)) fillPads(tr, 'cluster', sid);
      app.commit('Import');
    }
    refreshAll();
  };
  async function decode(kind, bytes, meta) {
    engine.init();
    if (kind === 'midi') {
      const r = await SP.renderMidi(bytes, engine.sampleRate);
      if (meta && !app.project.samples.some(s => s !== meta && app.analysis.get(s.id)) && !app.songEnd() && r.bpm >= 40 && r.bpm <= 240) { app.project.bpm = r.bpm; engine.setTempoChanged(); }
      toast(`MIDI rendered with built-in sounds (${r.noteCount} notes)`);
      return r.buffer;
    }
    const copy = bytes.slice().buffer;
    return await engine.ctx.decodeAudioData(copy);
  }
  function mono(buf) {
    const n = buf.length, out = new Float32Array(n), C = buf.numberOfChannels;
    for (let c = 0; c < C; c++) { const d = buf.getChannelData(c); for (let i = 0; i < n; i++) out[i] += d[i] / C; }
    return out;
  }
  function mapAspect() { const w = $('mapwrap'); const a = (w.clientWidth - 32) / Math.max(100, w.clientHeight - 50); return Math.min(2.6, Math.max(1.1, a || 1.75)); }
  async function runAnalysis(meta) {
    const au = app.audio.get(meta.id); if (!au) return;
    meta._busy = true; meta._progress = 0; SP.Panels.renderLibrary(); renderMapBar();
    const st = meta.settings;
    let lastUi = 0;
    if (!au.mono) { au.mono = mono(au.buf); const e = engine.buffers.get(meta.id); if (e) e.mono = au.mono; }
    const res = await SP.analyse(au.mono, au.buf.sampleRate, {
      mode: st.mode, sliceMs: st.sliceMs, sensitivity: st.sensitivity, maxSliceMs: st.maxSliceMs,
      beatDiv: SP.DIVS[st.beatDivName] || st.beatDiv || 0.25, bpm: app.project.bpm,
      clusters: st.clusters, layout: st.layout, aspect: mapAspect(), seed: 7,
      regions: st.mode === 'manual' ? (meta.regions || []) : null, cacheKey: meta.id
    }, (p) => {
      meta._progress = p;
      const now = performance.now();
      if (now - lastUi > 80) { lastUi = now; SP.Panels.setProgress(meta); renderMapBar(); }
    });
    finishAnalysis(meta.id, res);
    meta._busy = false;
  }
  function finishAnalysis(id, res) {
    res.byCluster = Array.from({ length: res.k }, () => []);
    for (let i = 0; i < res.n; i++) if (res.cluster[i] >= 0) res.byCluster[res.cluster[i]].push(i);
    app.analysis.set(id, res);
    // keep pads, melodic frames and recorded notes pointing at the right frames
    const remap = (o) => { if (o && o.sampleId === id) o.frame = app.frameAt(id, (o.start + o.end) / 2); };
    for (const t of app.project.tracks) { t.pads.forEach(remap); remap(t.melodic); t.events.forEach(remap); }
    const smp = app.sampleById(id);
    if (smp && smp.cells && res._remapCells !== false) {
      const next = {};
      for (const [k, ed] of Object.entries(smp.cells)) {
        const f = ed.anchor != null ? app.frameAt(id, ed.anchor) : +k;
        if (f >= 0 && !next[f]) next[f] = ed;
      }
      smp.cells = next;
    }
    if (app.selFrame && app.selFrame.sampleId === id) app.selFrame = null;
    if (app.project.selectedSample === id) { app.map.setSample(id); app.map.invalidate(); }
  }
  app.reanalyse = async (id) => {
    const meta = app.project.samples.find(s => s.id === id); if (!meta || meta._busy) return;
    try { await runAnalysis(meta); } catch (e) { console.error(e); meta._busy = false; toast('Mapping failed: ' + e.message); }
    refreshAll();
  };
  app.removeSample = async (id) => {
    const p = app.project, s = p.samples.find(x => x.id === id); if (!s) return;
    const used = p.tracks.reduce((n, t) => n + t.events.filter(e => e.sampleId === id).length, 0);
    if (!(await confirmBox(`Remove “${s.name}” from the project?`, used ? `${used} recorded notes use it and will be removed too.` : ''))) return;
    p.samples.splice(p.samples.indexOf(s), 1);
    for (const t of p.tracks) {
      t.events = t.events.filter(e => e.sampleId !== id);
      t.pads = t.pads.map(x => x && x.sampleId === id ? null : x);
      if (t.melodic && t.melodic.sampleId === id) t.melodic = null;
    }
    if (p.selectedSample === id) p.selectedSample = p.samples.length ? p.samples[0].id : null;
    if (app.selFrame && app.selFrame.sampleId === id) app.selFrame = null;
    app.commit('Remove sound');
    refreshAll();
  };

  // demo sound: a little groove rendered with the built-in MIDI sounds
  app.loadDemo = async () => {
    engine.init();
    const notes = [];
    const spb = 60 / 112;
    for (let bar = 0; bar < 4; bar++) for (let s = 0; s < 16; s++) {
      const t = (bar * 16 + s) * spb / 4;
      if (s % 4 === 0 || (bar % 2 && s === 10)) notes.push({ t, d: 0.2, ch: 9, note: 36, vel: 0.95, prog: 0 });
      if (s === 4 || s === 12) notes.push({ t, d: 0.2, ch: 9, note: 38, vel: 0.85, prog: 0 });
      if (s % 2 === 0) notes.push({ t, d: 0.05, ch: 9, note: s % 8 === 6 ? 46 : 42, vel: 0.5 + (s % 4 ? 0 : 0.2), prog: 0 });
      if (s === 14 && bar === 3) notes.push({ t, d: 0.3, ch: 9, note: 39, vel: 0.9, prog: 0 });
    }
    const bass = [36, 36, 43, 41], chords = [[60, 63, 67], [58, 63, 67], [55, 60, 63], [53, 58, 62]];
    for (let bar = 0; bar < 4; bar++) {
      const t0 = bar * 4 * spb;
      [0, 0.75, 1.5, 2.5, 3].forEach((b, i) => notes.push({ t: t0 + b * spb, d: 0.3, ch: 1, note: bass[bar] + (i === 3 ? 12 : 0), vel: 0.9, prog: 33 }));
      for (const n of chords[bar]) notes.push({ t: t0 + 0.5 * spb, d: 1.2, ch: 2, note: n, vel: 0.6, prog: 89 });
      [[2, 72], [2.5, 75], [3, 79], [3.5, 77]].forEach(([b, n]) => notes.push({ t: t0 + b * spb, d: 0.25, ch: 3, note: n + (bar === 2 ? -2 : 0), vel: 0.7, prog: 80 }));
      notes.push({ t: t0 + 1 * spb, d: 0.5, ch: 4, note: 84 - bar * 2, vel: 0.5, prog: 11 });
    }
    const r = await SP.renderNotes(notes, engine.sampleRate);
    const wav = SP.Export.encodeWav(r);
    if (!app.songEnd()) { app.project.bpm = 112; engine.setTempoChanged(); }
    await app.importFiles([{ name: 'Demo groove.wav', data: wav }]);
  };

  // ---------------- editing single cells ----------------
  app.ensureCellEdit = (sid, frame) => {
    const s = app.sampleById(sid), an = app.analysis.get(sid); if (!s || !an) return null;
    s.cells = s.cells || {};
    if (!s.cells[frame]) s.cells[frame] = { start: an.starts[frame], end: an.ends[frame], anchor: (an.starts[frame] + an.ends[frame]) / 2, gain: 0, pitch: 0, reverse: false, effects: [] };
    return s.cells[frame];
  };
  app.resetCell = (sid, frame) => {
    const s = app.sampleById(sid); if (!s || !s.cells || !s.cells[frame]) return;
    delete s.cells[frame];
    app.commit('Reset cell'); app.map.invalidate();
  };
  // keep pads that point at this cell in step with its new bounds
  app.syncCellBounds = (sid, frame) => {
    const ed = app.cellEdit(sid, frame); if (!ed) return;
    for (const t of app.project.tracks) for (const p of t.pads.concat([t.melodic])) if (p && p.sampleId === sid && p.frame === frame) { p.start = ed.start; p.end = ed.end; }
  };

  // ---------------- manual cells (drawn on the strip) ----------------
  let regionTimer = null;
  function regionsChanged(s) {
    s.regions.sort((a, b) => a[0] - b[0]);
    app.commit('Edit cells');
    app.map.stripDirty = true;
    clearTimeout(regionTimer);
    regionTimer = setTimeout(() => app.reanalyse(s.id), 250);
  }
  app.seedRegions = (sid) => {
    const s = app.sampleById(sid), an = app.analysis.get(sid); if (!s) return;
    if (s.regions && s.regions.length) return;
    s.regions = [];
    if (an && !an.gaps) for (let i = 0; i < an.n; i++) if (an.cluster[i] >= 0) s.regions.push([+an.starts[i].toFixed(4), +an.ends[i].toFixed(4)]);
  };
  app.addRegion = (sid, a, b) => {
    const s = app.sampleById(sid); if (!s) return;
    s.regions = s.regions || [];
    let lo = Math.min(a, b), hi = Math.max(a, b);
    // don't overlap neighbours
    for (const r of s.regions) { if (r[1] <= lo || r[0] >= hi) continue; if (r[0] <= lo) lo = r[1]; else hi = Math.min(hi, r[0]); }
    if (hi - lo < 0.01) return toast('Cells need at least 10 ms of free space');
    s.regions.push([lo, hi]);
    regionsChanged(s);
  };
  app.updateRegion = (sid, idx, a, b, final) => {
    const s = app.sampleById(sid); if (!s || !s.regions[idx]) return;
    s.regions[idx] = [Math.min(a, b), Math.max(a, b)];
    if (final) regionsChanged(s); else app.map.stripDirty = true;
  };
  app.deleteRegion = (sid, frame) => {
    const s = app.sampleById(sid), an = app.analysis.get(sid); if (!s || !s.regions) return;
    const t0 = an ? an.starts[frame] : null;
    const idx = s.regions.findIndex(r => Math.abs(r[0] - t0) < 1e-3);
    if (idx < 0) return;
    s.regions.splice(idx, 1);
    if (s.cells && s.cells[frame]) delete s.cells[frame];
    regionsChanged(s);
  };
  app.clearRegions = (sid) => { const s = app.sampleById(sid); if (!s) return; s.regions = []; s.cells = {}; regionsChanged(s); };

  // ---------------- transport ----------------
  app.togglePlay = () => {
    if (engine.playing) { engine.stop(); }
    else { engine.init(); engine.sync(app.project); engine.start(); }
    app.refreshTransport();
  };
  app.toggleRecord = () => {
    if (app.recording) { stopRecording(); app.refreshTransport(); return; }
    const tr = app.selTrack(); if (!tr) return toast('Add a track to record onto');
    if (!app.analysis.size) return toast('Import a sound first');
    app.recording = true; engine.recording = true;
    if (!engine.playing) { engine.init(); engine.sync(app.project); const L = app.project.loop; engine.start(L.on && (engine.posBeat < L.start || engine.posBeat >= L.end) ? L.start : engine.posBeat); }
    toast(`Recording onto ${tr.name}: play pads, keys, MIDI or the map`);
    app.refreshTransport();
  };
  function stopRecording() {
    if (!app.recording) return;
    for (const [k, h] of app.held) if (h.rec) { finishRec(h.rec); h.rec = null; void k; }
    app.recording = false; engine.recording = false;
    for (const t of app.project.tracks) for (const e of t.events) { delete e._skipPass; delete e._recording; }
    app.commit('Record');
  }
  engine.onStop = () => {
    stopRecording();
    for (const t of app.project.tracks) for (const e of t.events) delete e._skipPass;
    app.refreshTransport();
  };
  app.locate = (b) => { engine.locate(b); };
  app.home = () => { engine.locate(0); app.timeline.scrollX = 0; };

  // ---------------- clipboard ----------------
  app.copy = () => {
    const items = app.timeline.selectedEvents(); if (!items.length) return false;
    const lo = Math.min(...items.map(i => i.ev.t));
    app.clipboard = items.map(i => Object.assign(JSON.parse(JSON.stringify(i.ev, snapReplacer)), { t: i.ev.t - lo }));
    toast(`Copied ${items.length} note${items.length > 1 ? 's' : ''}`);
    return true;
  };
  app.paste = (tr, beat) => {
    tr = tr || app.selTrack(); if (!tr || !app.clipboard) return;
    const b = beat == null ? app.timeline.snap(engine.beatNow()) : beat;
    app.timeline.sel.clear();
    for (const c of app.clipboard) { const e = Object.assign({}, c, { id: SP.uid('ev'), t: b + c.t }); tr.events.push(e); app.timeline.sel.add(e.id); }
    app.commit('Paste');
  };

  // ---------------- files ----------------
  function encAnalysis(a) {
    const o = {};
    for (const [k, v] of Object.entries(a)) {
      if (k === 'byCluster') continue;
      if (ArrayBuffer.isView(v)) o[k] = { __ta: v.constructor.name, b64: SP.bytesToBase64(new Uint8Array(v.buffer, v.byteOffset, v.byteLength)) };
      else o[k] = v;
    }
    return o;
  }
  function decAnalysis(o) {
    const a = {};
    const T = { Float32Array, Int16Array, Int32Array, Float64Array, Uint8Array };
    for (const [k, v] of Object.entries(o)) {
      if (v && v.__ta) { const b = SP.base64ToBytes(v.b64); a[k] = new T[v.__ta](b.buffer, 0, b.byteLength / T[v.__ta].BYTES_PER_ELEMENT); }
      else a[k] = v;
    }
    return a;
  }
  function serialize() {
    const data = { app: 'Spiders', version: 1, project: JSON.parse(snap()), analysis: {}, audio: {} };
    for (const s of app.project.samples) {
      const a = app.analysis.get(s.id), au = app.audio.get(s.id);
      if (a) data.analysis[s.id] = encAnalysis(a);
      if (au) data.audio[s.id] = { kind: au.kind, b64: SP.bytesToBase64(au.bytes) };
    }
    return JSON.stringify(data);
  }
  async function deserialize(text) {
    const data = JSON.parse(text);
    if (!data || data.app !== 'Spiders' || !data.project) throw new Error('This is not a Spiders project');
    engine.stop();
    app.releaseAll();
    const p = data.project;
    const analysis = new Map(), audio = new Map();
    for (const s of p.samples) {
      const au = data.audio[s.id]; if (!au) continue;
      const bytes = SP.base64ToBytes(au.b64);
      const buf = await decode(au.kind, bytes, null);
      audio.set(s.id, { buf, bytes, kind: au.kind });
      if (data.analysis[s.id]) analysis.set(s.id, decAnalysis(data.analysis[s.id]));
    }
    for (const t of p.tracks) { t.sound = Object.assign({}, SP.SOUND_DEFAULTS, t.sound); for (const f of t.effects) f.p = Object.assign(SP.FX.defaults(f.type), f.p); }
    app.project = p; app.analysis = new Map(); app.audio = audio;
    engine.buffers.clear();
    for (const [id, au] of audio) engine.setBuffer(id, au.buf);
    for (const [id, a] of analysis) finishAnalysis(id, a);
    for (const s of p.samples) if (!analysis.has(s.id) && audio.has(s.id)) await runAnalysis(s);
    app.undoStack = []; app.redoStack = []; app.lastSnap = snap();
    app.selFrame = null; app.timeline.sel.clear();
    refreshAll();
  }
  app.save = async (as) => {
    try {
      const data = serialize();
      const name = app.fileName.replace(/\.spiders$/, '') + '.spiders';
      if (native) {
        const path = await native.saveFile({ defaultPath: name, filters: [{ name: 'Spiders project', extensions: ['spiders'] }], data, path: as ? null : app.filePath });
        if (!path) return false;
        app.filePath = path; app.fileName = path.split(/[\\/]/).pop().replace(/\.spiders$/, '');
      } else download(new Blob([data], { type: 'application/json' }), name);
      markDirty(false);
      toast('Saved');
      return true;
    } catch (e) { console.error(e); toast('Could not save: ' + e.message, 5000); return false; }
  };
  app.open = async () => {
    if (app.dirty && !(await confirmBox('Open another project? Unsaved changes will be lost.'))) return;
    if (native) {
      const r = await native.openFile({ filters: [{ name: 'Spiders project', extensions: ['spiders'] }] });
      if (r) await openText(r.content, r.path);
    } else $('fileInput').click();
  };
  async function openText(content, path) {
    try {
      await deserialize(content);
      app.filePath = path || null; app.fileName = path ? path.split(/[\\/]/).pop().replace(/\.spiders$/, '') : 'Untitled';
      markDirty(false);
      toast('Opened ' + app.fileName);
    } catch (e) { console.error(e); toast('Could not open: ' + e.message, 5000); }
  }
  app.openText = openText;
  app.newProject = async () => {
    if (app.dirty && !(await confirmBox('Start a new project? Unsaved changes will be lost.'))) return;
    engine.stop(); app.releaseAll();
    app.project = newProject(); app.analysis = new Map(); app.audio = new Map(); engine.buffers.clear();
    app.undoStack = []; app.redoStack = []; app.lastSnap = snap(); app.selFrame = null; app.filePath = null; app.fileName = 'Untitled';
    app.timeline.sel.clear(); app.timeline.scrollX = 0;
    refreshAll(); markDirty(false);
  };
  function download(blob, name) {
    const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name;
    document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  async function saveBinary(bytes, name, ext, label) {
    if (native) return native.saveFile({ defaultPath: name, filters: [{ name: label, extensions: [ext] }], data: bytes, encoding: 'binary' });
    download(new Blob([bytes]), name); return name;
  }

  // ---------------- export ----------------
  function tailSeconds(tracks) {
    let t = 0.6;
    for (const tr of tracks) {
      t = Math.max(t, (tr.sound.release || 0.1) + 0.2);
      for (const f of tr.effects) {
        if (!f.on) continue;
        if (f.type === 'reverb') t = Math.max(t, f.p.decay + f.p.predelay + 0.3);
        if (f.type === 'echo') { const beats = SP.SYNC[f.p.time]; const d = f.p.time === 'Free (ms)' || !beats ? f.p.ms / 1000 : beats * 60 / app.project.bpm; t = Math.max(t, Math.min(12, d * Math.log(0.001) / Math.log(Math.max(0.01, f.p.feedback)) + d)); }
      }
    }
    return Math.min(14, t);
  }
  app.openExport = () => {
    const p = app.project;
    if (!p.tracks.some(t => t.events.length)) return toast('Record or place some notes on a track first');
    const m = modal(`<h2>Export</h2>
      <div class="row"><label>What</label><select id="exWhat" class="grow"><option value="mix">The full mix</option><option value="stems">Each track as its own file</option><option value="track">Only the selected track</option><option value="midi">MIDI notes (one track each)</option></select></div>
      <div class="row"><label>Range</label><select id="exRange" class="grow"><option value="song">Whole song (bar 1 to the last note)</option><option value="loop">Loop region</option></select></div>
      <div class="row" id="exRepRow"><label>Repeats</label><input id="exRep" type="number" min="1" max="32" value="1"></div>
      <div class="row" id="exEndRow"><label>Ending</label><select id="exEnd" class="grow"><option value="ring">Let echoes and reverb ring out</option><option value="loop">Seamless loop (tails wrap to the start)</option><option value="cut">Cut off at the end</option></select></div>
      <div class="row" id="exFmtRow"><label>Format</label><select id="exFmt" class="grow"><option value="wav">WAV (44.1 kHz, 16-bit)</option><option value="mp3-320">MP3 320 kbps</option><option value="mp3-192">MP3 192 kbps</option><option value="mp3-128">MP3 128 kbps</option></select></div>
      <div class="hint" id="exHint"></div>
      <div class="progress" id="exProg"><i></i></div>
      <div class="foot"><button id="exCancel" class="ghost">Cancel</button><button id="exGo" class="accent">Export</button></div>`);
    const q = (s) => m.el.querySelector(s);
    const upd = () => {
      const w = q('#exWhat').value, r = q('#exRange').value;
      q('#exRepRow').style.display = r === 'loop' && w !== 'midi' ? '' : 'none';
      q('#exEndRow').style.display = w === 'midi' ? 'none' : '';
      q('#exFmtRow').style.display = w === 'midi' ? 'none' : '';
      q('#exHint').textContent = w === 'stems' ? 'You choose a folder; each track with notes is saved as its own file, with its effects. Muted tracks are skipped.' : w === 'midi' ? 'Each note becomes the MIDI note of the pad that played it.' : '';
    };
    q('#exWhat').onchange = upd; q('#exRange').onchange = upd; upd();
    q('#exCancel').onclick = m.close;
    q('#exGo').onclick = async () => {
      const opt = { what: q('#exWhat').value, range: q('#exRange').value, repeats: Math.max(1, Math.min(32, +q('#exRep').value || 1)), ending: q('#exEnd').value, fmt: q('#exFmt').value };
      q('#exGo').disabled = true; q('#exProg').style.display = 'block';
      const bar = q('#exProg i');
      try { await doExport(opt, f => { bar.style.width = Math.round(f * 100) + '%'; }); m.close(); }
      catch (e) { console.error(e); toast('Export failed: ' + e.message, 5000); q('#exGo').disabled = false; }
    };
  };
  async function doExport(opt, progress) {
    const p = app.project, bpb = p.beatsPerBar;
    const name = app.fileName || 'Spiders';
    let b0, b1, repeats = 1;
    if (opt.range === 'loop') { b0 = p.loop.start; b1 = p.loop.end; repeats = opt.repeats; }
    else { b0 = 0; b1 = Math.max(bpb, Math.ceil(app.songEnd() / bpb - 1e-6) * bpb); }
    if (opt.what === 'midi') {
      const tracks = p.tracks.filter(t => t.events.length).map(t => ({ name: t.name, events: t.events.filter(e => e.t >= b0 && e.t < b1).map(e => ({ t: e.t - b0, len: e.len, note: (e.note == null ? 60 : e.note) + (e.pitch || 0), vel: e.vel })) }));
      const bytes = SP.Export.buildMidi(tracks, p.bpm, bpb);
      const path = await saveBinary(bytes, name + '.mid', 'mid', 'MIDI file');
      if (path) toast('Exported MIDI');
      return;
    }
    const buffers = new Map([...app.audio].map(([id, a]) => [id, a.buf]));
    const anySolo = p.tracks.some(t => t.solo);
    const audible = p.tracks.filter(t => !t.mute && (!anySolo || t.solo));
    const jobs = opt.what === 'mix' ? [{ ids: null, label: name, tracks: audible }]
      : opt.what === 'track' ? [{ ids: [p.selectedTrack], label: `${name} - ${app.selTrack().name}`, tracks: [app.selTrack()] }]
        : p.tracks.filter(t => !t.mute && t.events.length).map(t => ({ ids: [t.id], label: `${name} - ${t.name}`, tracks: [t] }));
    if (!jobs.length) throw new Error('No tracks to export');
    let folder = null;
    if (opt.what === 'stems' && native) { folder = await native.chooseFolder({ title: 'Choose a folder for the track files' }); if (!folder) return; }
    const isMp3 = opt.fmt.startsWith('mp3'), kbps = isMp3 ? +opt.fmt.split('-')[1] : 0;
    const ext = isMp3 ? 'mp3' : 'wav';
    let done = 0;
    for (const job of jobs) {
      const tail = opt.ending === 'cut' ? 0 : tailSeconds(job.tracks);
      let buf = await SP.renderOffline({ project: p, buffers, b0, b1, repeats, tail, trackIds: job.ids, sampleRate: 44100, scatterPick: engine.scatterPick, cellEdit: engine.cellEdit, spectralSources: engine.spectralSources, monos: new Map([...app.audio].map(([id, a]) => [id, a.mono])), masterVolume: p.master, wrapTail: opt.ending === 'loop' });
      if (opt.ending === 'ring') buf = SP.Export.trimTail(buf, (b1 - b0) * repeats * 60 / p.bpm);
      progress((done + 0.4) / jobs.length);
      const bytes = isMp3 ? await SP.Export.encodeMp3(buf, kbps, f => progress((done + 0.4 + f * 0.6) / jobs.length)) : SP.Export.encodeWav(buf);
      const fname = `${job.label}.${ext}`;
      if (folder) await native.writeInFolder({ folder, name: fname, data: bytes });
      else { const pth = await saveBinary(bytes, fname, ext, isMp3 ? 'MP3 audio' : 'WAV audio'); if (!pth) return; }
      done++; progress(done / jobs.length);
    }
    if (folder) native.reveal(folder);
    toast(jobs.length > 1 ? `Exported ${jobs.length} track files` : 'Exported ' + jobs[0].label + '.' + ext);
  }
  app.exportFrame = async (sid, frame) => {
    const au = app.audio.get(sid), an = app.analysis.get(sid); if (!au || !an) return;
    const buf = await SP.renderFrame(au.buf, an.starts[frame], an.ends[frame], 44100);
    await saveBinary(SP.Export.encodeWav(buf), `${app.sampleName(sid)} frame ${frame + 1}.wav`, 'wav', 'WAV audio');
  };
  app.exportGroup = async (sid, c) => {
    const au = app.audio.get(sid), an = app.analysis.get(sid); if (!au || !an) return;
    const parts = [];
    for (const f of an.byCluster[c]) parts.push(await SP.renderFrame(au.buf, an.starts[f], an.ends[f], 44100));
    const len = parts.reduce((n, b) => n + b.length, 0), ch = Math.max(...parts.map(b => b.numberOfChannels));
    const out = new AudioBuffer({ numberOfChannels: ch, length: Math.max(1, len), sampleRate: 44100 });
    let o = 0;
    for (const b of parts) { for (let c2 = 0; c2 < ch; c2++) out.getChannelData(c2).set(b.getChannelData(Math.min(c2, b.numberOfChannels - 1)), o); o += b.length; }
    await saveBinary(SP.Export.encodeWav(out), `${app.sampleName(sid)} group ${c + 1}.wav`, 'wav', 'WAV audio');
  };

  // ---------------- keyboard ----------------
  const typing = (e) => { const t = e.target; return t && (t.tagName === 'INPUT' && t.type !== 'range') || (t && (t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable)); };
  window.addEventListener('keydown', (e) => {
    if (typing(e)) { if (e.key === 'Escape') e.target.blur(); return; }
    const mod = e.metaKey || e.ctrlKey;
    if (e.code === 'Space') { e.preventDefault(); if (!e.repeat) app.togglePlay(); return; }
    if (mod) {
      if (native) return; // the app menu handles these
      const k = e.key.toLowerCase();
      const acts = { z: () => (e.shiftKey ? app.redo() : app.undo()), s: () => app.save(e.shiftKey), o: () => app.open(), e: () => app.openExport(), d: () => app.timeline.duplicateSelected(), r: () => (e.shiftKey ? SP.Recorder.open() : app.toggleRecord()), l: () => toggleLoop(), k: () => toggleMetro(), t: () => app.addTrack(), u: () => app.timeline.quantize(), a: () => app.timeline.selectAll(), i: () => importDialog(), c: () => app.copy(), v: () => app.paste() };
      if (acts[k]) { e.preventDefault(); acts[k](); }
      return;
    }
    if (e.code === 'Enter') { e.preventDefault(); app.home(); return; }
    if (e.code === 'Escape' && $('modalRoot').firstChild) { $('modalRoot').innerHTML = ''; app.releaseAll(); app.map.invalidate(); return; }
    if (e.code === 'Escape') { if (app.assignMode) app.setAssignMode(false); if (app.learnPad >= 0) app.learnMidi(-1); app.timeline.sel.clear(); hideMenu(); return; }
    if (e.code === 'Delete' || e.code === 'Backspace') { if (app.timeline.deleteSelected()) e.preventDefault(); return; }
    if (e.altKey) return;
    const tr = app.selTrack(); if (!tr) return;
    if (tr.playMode === 'pads') {
      const i = KEY_INDEX[e.code];
      if (i != null) { e.preventDefault(); if (!e.repeat) app.padDown(i, 'k' + e.code, e.shiftKey ? 1 : 0.8); }
    } else {
      if (e.code === 'KeyZ' || e.code === 'KeyX') { e.preventDefault(); if (!e.repeat) { app.octave = Math.max(-3, Math.min(3, app.octave + (e.code === 'KeyX' ? 1 : -1))); toast('Keyboard octave ' + (app.octave >= 0 ? '+' : '') + app.octave); SP.Panels.renderPanel(); } return; }
      const s = MELODIC[e.code];
      if (s != null) { e.preventDefault(); if (!e.repeat) melodicDown(s + app.octave * 12, 'k' + e.code, e.shiftKey ? 1 : 0.8); }
    }
  });
  window.addEventListener('keyup', (e) => { app.noteOff('k' + e.code); });
  window.addEventListener('blur', () => app.releaseAll());
  document.addEventListener('copy', (e) => { if (!typing(e) && app.copy()) e.preventDefault(); });
  document.addEventListener('cut', (e) => { if (!typing(e) && app.copy()) { e.preventDefault(); app.timeline.deleteSelected(); } });
  document.addEventListener('paste', (e) => { if (!typing(e) && app.clipboard) { e.preventDefault(); app.paste(); } });

  // ---------------- MIDI keyboards ----------------
  function setupMidi() {
    if (!navigator.requestMIDIAccess) { $('midiPill').textContent = 'MIDI: unavailable'; return; }
    navigator.requestMIDIAccess({ sysex: false }).then(acc => {
      const bind = () => {
        let n = 0;
        for (const inp of acc.inputs.values()) { inp.onmidimessage = onMidi; n++; }
        const pill = $('midiPill');
        const names = [...acc.inputs.values()].map(i => i.name).join(', ');
        pill.textContent = n ? `MIDI: ${n} in` : 'MIDI: none'; pill.title = names || 'No MIDI keyboards connected';
        pill.classList.toggle('live', n > 0);
      };
      bind(); acc.onstatechange = bind;
    }).catch((err) => { const pill = $('midiPill'); pill.textContent = 'MIDI: unavailable'; pill.title = 'MIDI could not start: ' + (err && err.message || err); });
  }
  function onMidi(e) {
    const [st, d1, d2] = e.data, type = st & 0xf0;
    if (type === 0x90 && d2 > 0) midiOn(d1, d2 / 127);
    else if (type === 0x80 || (type === 0x90 && d2 === 0)) app.noteOff('m' + d1);
  }
  function midiOn(note, vel) {
    const tr = app.selTrack(); if (!tr) return;
    if (app.learnPad >= 0) {
      const i = app.learnPad, other = tr.padNotes.indexOf(note);
      if (other >= 0 && other !== i) tr.padNotes[other] = tr.padNotes[i];
      tr.padNotes[i] = note; app.learnPad = -1;
      app.commit('Learn MIDI'); SP.Panels.renderPanel();
      toast(`Pad ${SP.KEYS[i].label} now plays on ${SP.noteName(note)}`);
      return;
    }
    if (tr.playMode === 'pads') { const i = tr.padNotes.indexOf(note); if (i >= 0) app.padDown(i, 'm' + note, vel); }
    else melodicDown(note - 60, 'm' + note, vel, note);
  }

  // ---------------- top bar & wiring ----------------
  function toggleLoop() { app.project.loop.on = !app.project.loop.on; app.commit('Loop'); app.refreshTransport(); }
  function toggleMetro() { app.project.metronome = !app.project.metronome; app.commit('Metronome'); app.refreshTransport(); }
  async function importDialog() {
    if (native) { const files = await native.openAudio(); if (files && files.length) app.importFiles(files); }
    else $('audioInput').click();
  }
  app.importDialog = importDialog;

  function wire() {
    $('playBtn').onclick = app.togglePlay;
    $('recBtn').onclick = app.toggleRecord;
    $('homeBtn').onclick = app.home;
    $('loopBtn').onclick = toggleLoop;
    $('metroBtn').onclick = toggleMetro;
    const bpm = $('bpm');
    bpm.onchange = () => { const v = Math.max(30, Math.min(300, Math.round(+bpm.value || 120))); engine.setTempoChanged(); app.project.bpm = v; bpm.value = v; app.commit('Tempo'); };
    $('quantize').onchange = (e) => { app.project.quantize = e.target.value; app.commit('Record quantize'); };
    $('snap').onchange = (e) => { app.project.snap = e.target.value; app.commit('Snap'); };
    $('loopLen').onchange = (e) => { const L = app.project.loop; L.end = L.start + +e.target.value; L.on = true; app.commit('Loop length'); app.refreshTransport(); };
    $('master').oninput = (e) => { app.project.master = +e.target.value; engine.setMasterVolume(app.project.master); };
    $('master').onchange = () => app.commit('Master volume');
    $('newBtn').onclick = app.newProject;
    $('openBtn').onclick = app.open;
    $('saveBtn').onclick = () => app.save(false);
    $('exportBtn').onclick = app.openExport;
    $('importBtn').onclick = importDialog;
    $('recSoundBtn').onclick = () => SP.Recorder.open();
    $('welcomeRecord').onclick = () => SP.Recorder.open();
    $('welcomeImport').onclick = importDialog;
    $('welcomeDemo').onclick = () => app.loadDemo();
    $('addTrackBtn').onclick = app.addTrack;
    $('quantizeBtn').onclick = () => app.timeline.quantize();
    $('zoomIn').onclick = () => app.timeline.zoom(1.4);
    $('zoomOut').onclick = () => app.timeline.zoom(1 / 1.4);
    document.querySelectorAll('#tabs button').forEach(b => b.onclick = () => { app.project.tab = b.dataset.tab; SP.Panels.renderPanel(); });
    $('fileInput').onchange = async (e) => { const f = e.target.files[0]; if (f) await openText(await f.text(), null); e.target.value = ''; };
    $('audioInput').onchange = async (e) => { const fs = [...e.target.files]; e.target.value = ''; app.importFiles(await Promise.all(fs.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) })))); };
    // drag & drop files
    let dragDepth = 0;
    window.addEventListener('dragenter', (e) => { if (e.dataTransfer && [...e.dataTransfer.types].includes('Files')) { dragDepth++; document.body.classList.add('dragover'); } });
    window.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (!dragDepth) document.body.classList.remove('dragover'); });
    window.addEventListener('dragover', (e) => e.preventDefault());
    window.addEventListener('drop', async (e) => {
      e.preventDefault(); dragDepth = 0; document.body.classList.remove('dragover');
      const fs = [...(e.dataTransfer ? e.dataTransfer.files : [])];
      const proj = fs.find(f => /\.spiders$/i.test(f.name));
      if (proj) { if (!app.dirty || await confirmBox('Open this project? Unsaved changes will be lost.')) openText(await proj.text(), null); return; }
      if (fs.length) app.importFiles(await Promise.all(fs.map(async f => ({ name: f.name, data: new Uint8Array(await f.arrayBuffer()) }))));
    });
    // splitter between map and timeline
    const sp = $('splitter'), tlw = $('timelineWrap');
    sp.addEventListener('pointerdown', (e) => {
      sp.setPointerCapture(e.pointerId);
      const startY = e.clientY, startH = tlw.getBoundingClientRect().height;
      const move = (ev) => { const h = Math.max(140, Math.min(innerHeight - 330, startH - (ev.clientY - startY))); tlw.style.flexBasis = h + 'px'; };
      const up = () => { sp.removeEventListener('pointermove', move); sp.removeEventListener('pointerup', up); app.map.invalidate(); };
      sp.addEventListener('pointermove', move); sp.addEventListener('pointerup', up);
    });
    // keep keyboard focus free for the pads: buttons and menus give it back after use
    document.addEventListener('click', (e) => { const b = e.target.closest && e.target.closest('button'); if (b && !b.closest('.modal')) b.blur(); });
    document.addEventListener('change', (e) => { if (e.target.tagName === 'SELECT' && !e.target.closest('.modal')) e.target.blur(); });
    // unlock audio on the first gesture
    const unlock = () => { engine.resume(); window.removeEventListener('pointerdown', unlock, true); window.removeEventListener('keydown', unlock, true); };
    window.addEventListener('pointerdown', unlock, true); window.addEventListener('keydown', unlock, true);

    if (native) {
      if (native.platform === 'darwin') document.body.classList.add('mac');
      native.onMenu(async (cmd) => {
        const acts = {
          new: app.newProject, open: app.open, save: () => app.save(false), 'save-as': () => app.save(true), export: app.openExport, import: importDialog,
          undo: app.undo, redo: app.redo, duplicate: () => app.timeline.duplicateSelected(), quantize: () => app.timeline.quantize(), 'select-all': () => app.timeline.selectAll(),
          'toggle-play': app.togglePlay, record: app.toggleRecord, home: app.home, loop: toggleLoop, metronome: toggleMetro,
          'add-track': app.addTrack, 'record-sound': () => SP.Recorder.open(), 'duplicate-track': () => app.duplicateTrack(), 'delete-track': () => app.deleteTrack(),
          'save-then-close': async () => { if (await app.save(false)) native.closeNow(); }
        };
        if (acts[cmd]) acts[cmd]();
      });
      native.onOpenProject(async ({ path, content }) => {
        if (app.dirty && !(await confirmBox('Open this project? Unsaved changes will be lost.'))) return;
        openText(content, path);
      });
    }
  }

  // ---------------- animation loop ----------------
  const meter = $('meter'), mg = meter.getContext('2d');
  const tbuf = new Float32Array(2048);
  let lastPos = '';
  function frame() {
    requestAnimationFrame(frame);
    const p = app.project;
    // position
    const b = engine.beatNow(), bpb = p.beatsPerBar;
    const bar = Math.floor(b / bpb) + 1, beat = Math.floor(b % bpb) + 1, six = Math.floor((b % 1) * 4) + 1;
    const pos = `${bar}.${beat}.${six}`;
    if (pos !== lastPos) { lastPos = pos; $('pos').firstChild.nodeValue = pos; $('posTime').textContent = SP.fmtTime(b * 60 / p.bpm); }
    if ($('playBtn').classList.contains('playing') !== engine.playing) app.refreshTransport();
    app.map.draw();
    app.timeline.draw();
    // meter
    let peak = 0;
    if (engine.analyser) { engine.analyser.getFloatTimeDomainData(tbuf); for (let i = 0; i < tbuf.length; i++) peak = Math.max(peak, Math.abs(tbuf[i])); }
    app._meter = Math.max(peak, (app._meter || 0) * 0.92);
    const W = meter.width, H = meter.height;
    mg.fillStyle = '#0a0c10'; mg.fillRect(0, 0, W, H);
    const db = 20 * Math.log10(app._meter + 1e-6), w = Math.max(0, Math.min(1, (db + 48) / 48)) * W;
    const grd = mg.createLinearGradient(0, 0, W, 0); grd.addColorStop(0, '#3cf0b4'); grd.addColorStop(0.75, '#f2e35c'); grd.addColorStop(1, '#ff3b4e');
    mg.fillStyle = grd; mg.fillRect(0, H * 0.25, w, H * 0.5);
  }

  // ---------------- boot ----------------
  function boot() {
    app.map = new SP.MapView(app, $('map'), $('strip'), $('mapTip'));
    app.timeline = new SP.Timeline(app, $('timeline'), $('trackHeadersInner'));
    wire();
    setupMidi();
    app.lastSnap = snap();
    refreshAll();
    markDirty(false);
    requestAnimationFrame(frame);
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();
})();
