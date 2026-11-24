// Spiders - side panels: the sound library (left) and the track panel with Pads / Sound / Effects (right).
(function () {
  const SP = (window.Spiders = window.Spiders || {});
  const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

  function drawSpec(canvas, an, frame, color) {
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 100, H = canvas.clientHeight || 40;
    canvas.width = W * dpr; canvas.height = H * dpr;
    const g = canvas.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, W, H);
    if (!an || frame == null || frame < 0) return;
    const SB = an.specBands, bw = W / SB;
    g.fillStyle = color || '#fff';
    for (let b = 0; b < SB; b++) { const v = an.spec[frame * SB + b]; g.fillRect(b * bw + 0.5, H - v * H, Math.max(1, bw - 1), v * H); }
  }
  SP.drawSpec = drawSpec;

  function seg(options, value, onPick, wide) {
    const s = el('div', 'seg' + (wide ? ' wide' : ''));
    for (const o of options) {
      const [val, label, title] = Array.isArray(o) ? o : [o, o];
      const b = el('button', val === value ? 'on' : '', label); if (title) b.title = title;
      b.onclick = () => onPick(val);
      s.appendChild(b);
    }
    return s;
  }
  function row(label, control, valText) {
    const r = el('div', 'row');
    r.appendChild(el('label', '', label));
    const g = el('div', 'grow'); g.appendChild(control); r.appendChild(g);
    if (valText != null) { const v = el('span', 'val', valText); r.appendChild(v); r._val = v; }
    return r;
  }
  function range(min, max, step, value, onInput, onChange) {
    const r = el('input'); r.type = 'range'; r.min = min; r.max = max; r.step = step; r.value = value;
    r.oninput = () => onInput(+r.value); r.onchange = () => onChange && onChange(+r.value);
    return r;
  }
  function select(options, value, onChange) {
    const s = el('select');
    for (const o of options) { const [v, l] = Array.isArray(o) ? o : [o, o]; const op = el('option', '', l); op.value = v; if (String(v) === String(value)) op.selected = true; s.appendChild(op); }
    s.onchange = () => onChange(s.value);
    return s;
  }

  // ======================= library =======================
  function renderLibrary() {
    const app = SP.app, p = app.project, list = document.getElementById('sampleList');
    list.innerHTML = '';
    if (!p.samples.length) list.appendChild(el('div', 'empty-note', 'No sounds yet. Import WAV, MP3 or MIDI files, or drop them on the window.'));
    for (const s of p.samples) {
      const an = app.analysis.get(s.id);
      const d = el('div', 'sample' + (s.id === p.selectedSample ? ' sel' : ''));
      const dur = an ? SP.fmtTime(an.duration) : '';
      d.innerHTML = `<div class="nm" title="${SP.escape(s.name)}">${s.kind === 'midi' ? '♫ ' : ''}${SP.escape(s.name)}</div>
        <div class="meta">${an ? `${dur} · ${an.n} frames · ${an.k} groups` : s._error ? 'Could not read this file' : 'Mapping…'}</div>`;
      if (an && an.k) {
        const bar = el('div', 'bar');
        an.sizes.forEach((sz, c) => { const i = el('i'); i.style.flex = sz; i.style.background = SP.clusterColor(c, an.k); bar.appendChild(i); });
        d.appendChild(bar);
      }
      if (s._busy) { const pr = el('div', 'prog', '<i></i>'); pr.firstChild.style.width = Math.round((s._progress || 0) * 100) + '%'; d.appendChild(pr); d._prog = pr.firstChild; }
      const x = el('button', 'x', '×'); x.title = 'Remove this sound from the project';
      x.onclick = (e) => { e.stopPropagation(); app.removeSample(s.id); };
      d.appendChild(x);
      d.onclick = () => app.selectSample(s.id);
      s._el = d;
      list.appendChild(d);
    }
    renderLibDetail();
  }
  function setProgress(s) { if (s._el) { const i = s._el.querySelector('.prog i'); if (i) i.style.width = Math.round((s._progress || 0) * 100) + '%'; } }

  let remapTimer = null;
  function renderLibDetail() {
    const app = SP.app, p = app.project, box = document.getElementById('libDetail');
    box.innerHTML = '';
    const s = p.samples.find(x => x.id === p.selectedSample);
    if (!s) return;
    const st = s.settings, an = app.analysis.get(s.id);
    const change = (fn) => { fn(); clearTimeout(remapTimer); remapTimer = setTimeout(() => { app.commit('Mapping settings'); app.reanalyse(s.id); }, 350); renderLibDetail(); };

    const b1 = el('div', 'block'); b1.appendChild(el('h3', '', 'Slicing'));
    b1.appendChild(seg([['transients', 'Transients', 'Cut where each new sound starts'], ['grid', 'Grid', 'Equal slices of a fixed length'], ['beats', 'Beats', 'Slices in time with the project tempo']], st.mode, v => change(() => { st.mode = v; }), true));
    if (st.mode === 'transients') {
      const r1 = row('Sensitivity', range(0, 1, 0.01, st.sensitivity, v => { st.sensitivity = v; r1._val.textContent = Math.round(v * 100) + '%'; }, () => change(() => { })), Math.round(st.sensitivity * 100) + '%');
      const r2 = row('Longest', range(50, 2000, 10, st.maxSliceMs, v => { st.maxSliceMs = v; r2._val.textContent = Math.round(v) + ' ms'; }, () => change(() => { })), Math.round(st.maxSliceMs) + ' ms');
      r2.title = 'Long sounds are split so no frame is longer than this';
      b1.append(r1, r2);
    } else if (st.mode === 'grid') {
      const r = row('Slice length', range(20, 2000, 5, st.sliceMs, v => { st.sliceMs = v; r._val.textContent = Math.round(v) + ' ms'; }, () => change(() => { })), Math.round(st.sliceMs) + ' ms');
      b1.appendChild(r);
    } else {
      b1.appendChild(row('Slice every', select(['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'], st.beatDivName || '1/16', v => change(() => { st.beatDivName = v; st.beatDiv = SP.DIVS[v]; }))));
      b1.appendChild(el('div', 'hint', `Uses the project tempo (${p.bpm} BPM). Set the BPM to match the sound first.`));
    }
    const groups = [['0', 'Auto']].concat(Array.from({ length: 23 }, (_, i) => [String(i + 2), String(i + 2)]));
    b1.appendChild(row('Timbre groups', select(groups, String(st.clusters || 0), v => change(() => { st.clusters = +v; }))));
    b1.appendChild(row('Layout', seg([['web', 'Web', 'One wedge per timbre group, time spirals out from the centre'], ['map', 'Map', 'Similar sounds sit close together']], st.layout, v => change(() => { st.layout = v; }))));
    const rb = el('button', 'small', s._busy ? 'Mapping…' : 'Re-map now'); rb.disabled = !!s._busy; rb.onclick = () => app.reanalyse(s.id);
    const tb = el('div', 'toolbar'); tb.appendChild(rb); b1.appendChild(tb);
    box.appendChild(b1);

    if (an) {
      const b2 = el('div', 'block'); b2.appendChild(el('h3', '', 'Timbre groups'));
      b2.appendChild(el('div', 'hint', 'Ordered dark to bright. Hover to find a group in the map, click to hear its most typical frame.'));
      const lg = el('div', 'legend');
      for (let c = 0; c < an.k; c++) {
        const ch = el('div', 'chip', `<i style="background:${SP.clusterColor(c, an.k)}"></i>${c + 1} <span style="color:var(--dimmer)">${an.sizes[c]}</span>`);
        ch.onmouseenter = () => { app.map.highlightCluster = c; };
        ch.onmouseleave = () => { app.map.highlightCluster = -1; };
        ch.onpointerdown = () => { const f = an.typical[c]; if (f >= 0) { app.selFrame = { sampleId: s.id, frame: f }; app.noteOn('legend', app.hitFor(s.id, f), 60, 0.9); renderFrameBlock(); } };
        ch.onpointerup = ch.onpointerleave = () => app.noteOff('legend');
        lg.appendChild(ch);
      }
      b2.appendChild(lg);
      const silent = an.n - an.sizes.reduce((a, b) => a + b, 0);
      b2.appendChild(el('div', 'stats', `<br>${an.n} frames over ${SP.fmtTime(an.duration)}${silent ? ` · ${silent} quiet frame${silent > 1 ? 's' : ''} left off the map` : ''}`));
      box.appendChild(b2);
      const b3 = el('div', 'block'); b3.id = 'frameBlock'; box.appendChild(b3);
      renderFrameBlock();
    }
  }
  function renderFrameBlock() {
    const app = SP.app, box = document.getElementById('frameBlock');
    if (!box) return;
    box.innerHTML = '';
    const sel = app.selFrame;
    if (!sel || sel.sampleId !== app.project.selectedSample) { box.appendChild(el('h3', '', 'Frame')); box.appendChild(el('div', 'hint', 'Click a cell in the map to select a frame.')); return; }
    const an = app.analysis.get(sel.sampleId); if (!an) return;
    const i = sel.frame, c = an.cluster[i];
    box.appendChild(el('h3', '', `Frame ${i + 1}`));
    const cv = el('canvas', 'specprev'); box.appendChild(cv);
    requestAnimationFrame(() => drawSpec(cv, an, i, c >= 0 ? SP.clusterColor(c, an.k) : '#5b6478'));
    box.appendChild(el('div', 'stats', `${an.starts[i].toFixed(3)}–${an.ends[i].toFixed(3)} s (${Math.round((an.ends[i] - an.starts[i]) * 1000)} ms)<br>${c >= 0 ? 'Group ' + (c + 1) : 'Quiet frame'} · ${an.rmsDb[i].toFixed(1)} dB · brightness ${Math.round(an.centroid[i])} Hz`));
    const tb = el('div', 'toolbar');
    const b1 = el('button', 'small', 'Put on selected pad'); b1.onclick = () => app.assignPad(app.selPad, sel.sampleId, i);
    const b2 = el('button', 'small', 'Place at playhead'); b2.onclick = () => app.placeAtPlayhead(sel.sampleId, i);
    const b3 = el('button', 'small', 'Export WAV…'); b3.onclick = () => app.exportFrame(sel.sampleId, i);
    tb.append(b1, b2, b3); box.appendChild(tb);
  }

  // ======================= right panel =======================
  function renderPanel() {
    const app = SP.app, p = app.project, tr = app.selTrack();
    const title = document.getElementById('panelTitle'), body = document.getElementById('panelBody');
    document.querySelectorAll('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === p.tab));
    body.innerHTML = '';
    if (!tr) { title.innerHTML = ''; body.appendChild(el('div', 'empty-note', 'Add a track to play and record frames.')); return; }
    title.innerHTML = `<span class="dot" style="background:${tr.color}"></span><b>${SP.escape(tr.name)}</b><span style="color:var(--dimmer);font-size:11px">plays your keys &amp; MIDI</span>`;
    if (p.tab === 'pads') renderPads(body, tr);
    else if (p.tab === 'sound') renderSound(body, tr);
    else renderEffects(body, tr);
  }

  function padHit(tr, i) { return tr.pads[i]; }
  function renderPads(body, tr) {
    const app = SP.app;
    body.appendChild(seg([['pads', 'Pads', 'Each key plays its own frame'], ['melodic', 'Melodic', 'One frame played up and down the keyboard']], tr.playMode, v => { tr.playMode = v; app.commit('Play mode'); renderPanel(); }, true));
    if (tr.playMode === 'melodic') { renderMelodic(body, tr); return; }
    const tb = el('div', 'toolbar');
    const assign = el('button', 'small toggle' + (app.assignMode ? ' on' : ''), app.assignMode ? 'Assigning… (Esc)' : 'Assign from map');
    assign.title = 'Then click cells in the map: each one goes onto the selected pad and the next pad is selected';
    assign.onclick = () => { app.setAssignMode(!app.assignMode); };
    const fill = select([['', 'Fill pads…'], ['cluster', 'One per timbre group'], ['time', 'In time order'], ['loud', 'Loudest first'], ['bright', 'Dark to bright'], ['random', 'Random']], '', v => { if (v) app.autoFill(tr, v); });
    fill.style.width = '130px';
    const clr = el('button', 'small ghost', 'Clear'); clr.onclick = () => { tr.pads = tr.pads.map(() => null); app.commit('Clear pads'); renderPanel(); };
    tb.append(assign, fill, clr); body.appendChild(tb);
    body.appendChild(el('div', 'hint', 'Play pads with your keyboard (rows 1–0, Q–P, A–;, Z–/) or a MIDI keyboard. Drag a cell out of the map onto a pad to put it there.'));
    const grid = el('div', 'pads');
    for (let i = 0; i < 40; i++) {
      const pd = tr.pads[i];
      const d = el('div', 'pad' + (pd ? ' has' : '') + (i === app.selPad ? ' sel' : '') + (i === app.learnPad ? ' learn' : ''));
      d.dataset.pad = i;
      const an = pd ? app.analysis.get(pd.sampleId) : null;
      const c = an ? an.cluster[pd.frame] : -1;
      if (pd) { const f = el('div', 'fill'); f.style.background = an && c >= 0 ? SP.clusterColor(c, an.k) : '#5b6478'; d.appendChild(f); }
      d.appendChild(el('span', 'k', SP.KEYS[i].label));
      d.appendChild(el('span', 'n', SP.noteName(tr.padNotes[i])));
      if (pd && an) { const cv = el('canvas'); d.appendChild(cv); requestAnimationFrame(() => drawSpec(cv, an, pd.frame, 'rgba(255,255,255,0.85)')); }
      d.title = pd ? `${SP.KEYS[i].label} · MIDI ${SP.noteName(tr.padNotes[i])} · ${app.sampleName(pd.sampleId)} frame ${pd.frame + 1}` : `${SP.KEYS[i].label} · empty`;
      d.addEventListener('pointerdown', (e) => {
        if (e.button !== 0) return;
        d.setPointerCapture(e.pointerId);
        const prev = app.selPad; app.selPad = i;
        if (prev !== i) { grid.querySelectorAll('.pad.sel').forEach(x => x.classList.remove('sel')); d.classList.add('sel'); renderPadInfo(tr); }
        app.padDown(i, 'pad', 0.9);
      });
      d.addEventListener('pointerup', () => app.noteOff('pad'));
      d.addEventListener('pointercancel', () => app.noteOff('pad'));
      d.addEventListener('contextmenu', (e) => {
        e.preventDefault(); app.selPad = i; renderPanel();
        const items = [];
        if (app.selFrame) items.push({ label: 'Put the selected frame here', action: () => app.assignPad(i, app.selFrame.sampleId, app.selFrame.frame) });
        items.push({ label: 'Learn MIDI note…', action: () => app.learnMidi(i) });
        if (pd) items.push({ label: 'Show in map', action: () => app.revealFrame(pd.sampleId, pd.frame) }, { label: 'Clear pad', action: () => { tr.pads[i] = null; app.commit('Clear pad'); renderPanel(); } });
        app.menu(e.clientX, e.clientY, items);
      });
      grid.appendChild(d);
    }
    body.appendChild(grid);
    const info = el('div', 'padinfo'); info.id = 'padInfo'; body.appendChild(info);
    renderPadInfo(tr);
  }
  function renderPadInfo(tr) {
    const app = SP.app, info = document.getElementById('padInfo'); if (!info) return;
    const i = app.selPad, pd = tr.pads[i];
    info.innerHTML = `<b>Pad ${SP.KEYS[i].label}</b> · MIDI note <b>${SP.noteName(tr.padNotes[i])}</b> (${tr.padNotes[i]})<br>` +
      (pd ? `${SP.escape(app.sampleName(pd.sampleId))} · frame ${pd.frame + 1} · ${Math.round((pd.end - pd.start) * 1000)} ms` : 'Empty: click “Assign from map”, or drag a cell here.');
    const tb = el('div', 'toolbar');
    const learn = el('button', 'small' + (app.learnPad === i ? ' toggle on' : ''), app.learnPad === i ? 'Press a MIDI key…' : 'Learn MIDI note'); learn.onclick = () => app.learnMidi(app.learnPad === i ? -1 : i);
    tb.appendChild(learn);
    if (app.selFrame) { const u = el('button', 'small', 'Use selected frame'); u.onclick = () => app.assignPad(i, app.selFrame.sampleId, app.selFrame.frame); tb.appendChild(u); }
    if (pd) { const c = el('button', 'small ghost', 'Clear'); c.onclick = () => { tr.pads[i] = null; app.commit('Clear pad'); renderPanel(); }; tb.appendChild(c); }
    info.appendChild(tb);
  }

  function renderMelodic(body, tr) {
    const app = SP.app;
    body.appendChild(el('div', 'hint', 'One frame, played at different pitches. Click a cell in the map to choose it. Play with A W S E D F T G Y H U J K (Z and X change octave) or a MIDI keyboard, where middle C plays it at its own pitch.'));
    const m = tr.melodic;
    const an = m ? app.analysis.get(m.sampleId) : null;
    const cv = el('canvas', 'specprev'); body.appendChild(cv);
    if (m && an) requestAnimationFrame(() => drawSpec(cv, an, m.frame, SP.clusterColor(Math.max(0, an.cluster[m.frame]), an.k)));
    body.appendChild(el('div', 'padinfo', m ? `<b>${SP.escape(app.sampleName(m.sampleId))}</b> · frame ${m.frame + 1} · ${Math.round((m.end - m.start) * 1000)} ms<br>Keyboard octave: <b>${app.octave >= 0 ? '+' : ''}${app.octave}</b> (Z / X)` : 'No frame chosen yet: click a cell in the map.'));
    const tb = el('div', 'toolbar');
    if (app.selFrame) { const b = el('button', 'small', 'Use selected frame'); b.onclick = () => { app.setMelodic(tr, app.selFrame.sampleId, app.selFrame.frame); }; tb.appendChild(b); }
    body.appendChild(tb);
    body.appendChild(el('div', 'hint', 'Tip: on the Sound tab, set Playback to Loop and raise Release for a held, pad-like tone.'));
  }

  function knobFor(def, get, set, commit) {
    return new SP.Knob({ def, get, set, commit }).el;
  }

  function renderSound(body, tr) {
    const app = SP.app;
    const s = tr.sound;
    const modeHints = { oneshot: 'Each hit plays the whole frame, however short the press.', gate: 'Plays while the key is held, up to the end of the frame.', loop: 'Loops the frame for as long as the key is held: good for drones and pads.' };
    const r = el('div', 'row'); r.appendChild(el('label', '', 'Playback'));
    r.appendChild(seg([['oneshot', 'One shot'], ['gate', 'Gate'], ['loop', 'Loop']], s.mode, v => { s.mode = v; app.commit('Playback mode'); renderPanel(); }));
    body.appendChild(r);
    body.appendChild(el('div', 'hint', modeHints[s.mode] || ''));
    const rv = el('div', 'row'); rv.appendChild(el('label', '', 'Direction'));
    rv.appendChild(seg([[false, 'Forward'], [true, 'Reverse']], !!s.reverse, v => { s.reverse = v; app.commit('Reverse'); renderPanel(); }));
    body.appendChild(rv);
    const k = el('div', 'knobs');
    for (const d of SP.SOUND_PARAMS) k.appendChild(knobFor(d, () => s[d.key], v => { s[d.key] = v; app.touch(); }, () => app.commit(d.label)));
    body.appendChild(k);
    body.appendChild(el('div', 'hint', '<b>Length</b> sets how much of each frame plays: 1× is the frame itself, more runs on into the sound after it. <b>Scatter</b> is the chance each hit swaps in a different frame from the same timbre group. <b>Velocity</b> sets how much key velocity changes the level.'));
    body.appendChild(el('h3', '', 'Track'));
    const k2 = el('div', 'knobs');
    k2.appendChild(knobFor({ label: 'Volume', min: 0, max: 1.25, def: 0.85, fmt: SP.fmt.pct }, () => tr.volume, v => { tr.volume = v; app.touch(); }, () => { app.commit('Volume'); app.timeline.renderHeaders(); }));
    k2.appendChild(knobFor({ label: 'Pan', min: -1, max: 1, def: 0, fmt: SP.fmt.pan }, () => tr.pan, v => { tr.pan = v; app.touch(); }, () => { app.commit('Pan'); app.timeline.renderHeaders(); }));
    body.appendChild(k2);
  }

  // ----- effects -----
  function renderEffects(body, tr) {
    const app = SP.app;
    const add = select([['', '+ Add effect…']].concat(SP.FX.ORDER.map(t => [t, SP.FX.TYPES[t].name])), '', v => { if (!v) return; tr.effects.push(SP.FX.create(v)); app.commit('Add ' + SP.FX.TYPES[v].name); renderPanel(); });
    add.style.width = '100%';
    body.appendChild(add);
    if (!tr.effects.length) body.appendChild(el('div', 'hint', 'Effects run top to bottom. The same set as Reel Studio and Orbit: EQ, filter, compressor, saturation, distortion, phaser / flanger / chorus, echo, reverb, trance gate and vocoder. You can add any of them more than once.'));
    tr.effects.forEach((fx, idx) => body.appendChild(fxCard(tr, fx, idx)));
  }

  function fxCard(tr, fx, idx) {
    const app = SP.app, T = SP.FX.TYPES[fx.type];
    const card = el('div', 'fxcard' + (fx.on ? '' : ' off'));
    const head = el('div', 'fxhead');
    const sw = el('button', 'switch' + (fx.on ? ' on' : '')); sw.title = fx.on ? 'Switch off' : 'Switch on';
    sw.onclick = () => { fx.on = !fx.on; app.commit(fx.on ? 'Effect on' : 'Effect off'); renderPanel(); };
    const up = el('button', 'ghost', '↑'); up.title = 'Earlier'; up.disabled = idx === 0;
    up.onclick = () => { tr.effects.splice(idx - 1, 0, tr.effects.splice(idx, 1)[0]); app.commit('Reorder effects'); renderPanel(); };
    const dn = el('button', 'ghost', '↓'); dn.title = 'Later'; dn.disabled = idx === tr.effects.length - 1;
    dn.onclick = () => { tr.effects.splice(idx + 1, 0, tr.effects.splice(idx, 1)[0]); app.commit('Reorder effects'); renderPanel(); };
    const rm = el('button', 'ghost', '×'); rm.title = 'Remove';
    rm.onclick = () => { tr.effects.splice(idx, 1); app.commit('Remove effect'); renderPanel(); };
    head.append(sw, el('b', '', T.name), up, dn, rm);
    card.appendChild(head);
    const body = el('div', 'fxbody');
    if (T.choices.length) {
      const ch = el('div', 'choices');
      for (const c of T.choices) {
        const f = el('div', 'field'); f.appendChild(el('label', '', c.label));
        f.appendChild(select(c.options, fx.p[c.key], v => { fx.p[c.key] = v; app.commit(c.label); if (fx.type === 'gate') renderPanel(); }));
        ch.appendChild(f);
      }
      body.appendChild(ch);
    }
    let knobs = T.params;
    let redraw = null;
    if (fx.type === 'eq') { const r = eqEditor(fx); body.appendChild(r.canvas); redraw = r.draw; knobs = T.params.filter(q => ['q3', 'q4', 'out'].includes(q.key)); }
    if (fx.type === 'gate') body.appendChild(gateEditor(fx));
    if (fx.type === 'echo' && fx.p.time !== 'Free (ms)') knobs = knobs.filter(q => q.key !== 'ms');
    if ((fx.type === 'filter' || fx.type === 'mod') && fx.p.sync !== 'Free (Hz)') knobs = knobs.filter(q => q.key !== 'rate');
    if (fx.type === 'mod' && fx.p.mode !== 'Phaser') { /* stages only used by the phaser */ }
    const k = el('div', 'knobs');
    for (const d of knobs) k.appendChild(knobFor(d, () => fx.p[d.key], v => { fx.p[d.key] = v; app.touch(); if (redraw) redraw(); }, () => app.commit(d.label)));
    body.appendChild(k);
    card.appendChild(body);
    return card;
  }

  // EQ curve editor
  let eqCtx = null;
  function eqEditor(fx) {
    const cv = el('canvas', 'eqcanvas');
    const p = fx.p;
    const fMin = 20, fMax = 20000, gMax = 18;
    const N = 200;
    const freqs = new Float32Array(N); for (let i = 0; i < N; i++) freqs[i] = fMin * Math.pow(fMax / fMin, i / (N - 1));
    const xOf = (f, W) => Math.log(f / fMin) / Math.log(fMax / fMin) * W;
    const fOf = (x, W) => fMin * Math.pow(fMax / fMin, Math.min(1, Math.max(0, x / W)));
    const yOf = (g, H) => H / 2 - g / (gMax * 1.15) * H / 2;
    const gOf = (y, H) => Math.max(-gMax, Math.min(gMax, (H / 2 - y) / (H / 2) * gMax * 1.15));
    const bands = [{ f: 'f1' }, { f: 'f2', g: 'g2' }, { f: 'f3', g: 'g3', q: 'q3' }, { f: 'f4', g: 'g4', q: 'q4' }, { f: 'f5', g: 'g5' }, { f: 'f6' }];
    const defs = Object.fromEntries(SP.FX.TYPES.eq.params.map(d => [d.key, d]));
    function response() {
      eqCtx = eqCtx || new OfflineAudioContext(1, 128, 44100);
      const mk = (type, f, g, q) => { const b = eqCtx.createBiquadFilter(); b.type = type; b.frequency.value = f; if (g != null) b.gain.value = g; if (q != null) b.Q.value = q; return b; };
      const lc = p.f1 <= 20.5 ? 5 : p.f1, hc = p.f6 >= 19900 ? 22000 : p.f6;
      const twice = p.slope === '24 dB/oct';
      const list = [mk('highpass', lc, null, 0.707), mk('lowshelf', p.f2, p.g2), mk('peaking', p.f3, p.g3, p.q3), mk('peaking', p.f4, p.g4, p.q4), mk('highshelf', p.f5, p.g5), mk('lowpass', Math.min(22000, hc), null, 0.707)];
      const tot = new Float32Array(N).fill(0), mag = new Float32Array(N), ph = new Float32Array(N);
      list.forEach((b, i) => { b.getFrequencyResponse(freqs, mag, ph); for (let q = 0; q < N; q++) tot[q] += 20 * Math.log10(Math.max(1e-6, mag[q])) * (twice && (i === 0 || i === 5) ? 2 : 1); });
      return tot;
    }
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 130;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
      g.strokeStyle = '#1a1f2b'; g.lineWidth = 1; g.beginPath();
      for (const f of [50, 100, 200, 500, 1000, 2000, 5000, 10000]) { const x = Math.round(xOf(f, W)) + 0.5; g.moveTo(x, 0); g.lineTo(x, H); }
      for (const db of [-12, -6, 0, 6, 12]) { const y = Math.round(yOf(db, H)) + 0.5; g.moveTo(0, y); g.lineTo(W, y); }
      g.stroke();
      const tot = response();
      g.beginPath();
      for (let i = 0; i < N; i++) { const x = xOf(freqs[i], W), y = yOf(Math.max(-30, tot[i] + p.out), H); if (i) g.lineTo(x, y); else g.moveTo(x, y); }
      g.strokeStyle = '#ff5c8a'; g.lineWidth = 2; g.stroke();
      g.lineTo(W, H); g.lineTo(0, H); g.closePath(); g.fillStyle = 'rgba(255,92,138,0.08)'; g.fill();
      g.font = '9px ui-monospace, Menlo, monospace'; g.textAlign = 'center'; g.textBaseline = 'middle';
      bands.forEach((b, i) => {
        const x = xOf(p[b.f], W), y = b.g ? yOf(p[b.g], H) : yOf(0, H);
        g.fillStyle = drag === i ? '#fff' : '#dfe7f2'; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.fill();
        g.fillStyle = '#0a0c10'; g.fillText(String(i + 1), x, y + 0.5);
      });
      g.fillStyle = '#586178'; g.textAlign = 'left'; g.fillText(drag >= 0 ? `${SP.fmt.hz(p[bands[drag].f])}${bands[drag].g ? ' · ' + SP.fmt.db(p[bands[drag].g]) : ''}` : 'drag points · scroll on 3/4 = width · double-click = reset', 6, H - 8);
    }
    let drag = -1;
    const hitBand = (e) => {
      const r = cv.getBoundingClientRect(), x = e.clientX - r.left, y = e.clientY - r.top;
      let best = -1, bd = 14 * 14;
      bands.forEach((b, i) => { const bx = xOf(p[b.f], r.width), by = b.g ? yOf(p[b.g], r.height) : yOf(0, r.height); const d = (bx - x) ** 2 + (by - y) ** 2; if (d < bd) { bd = d; best = i; } });
      return { best, x, y, r };
    };
    cv.addEventListener('pointerdown', e => { const h = hitBand(e); if (h.best < 0) return; drag = h.best; cv.setPointerCapture(e.pointerId); draw(); });
    cv.addEventListener('pointermove', e => {
      if (drag < 0) return;
      const r = cv.getBoundingClientRect(), b = bands[drag];
      const df = defs[b.f]; p[b.f] = Math.min(df.max, Math.max(df.min, fOf(e.clientX - r.left, r.width)));
      if (b.g) p[b.g] = Math.round(gOf(e.clientY - r.top, r.height) * 10) / 10;
      SP.app.touch(); draw();
    });
    const up = () => { if (drag >= 0) { drag = -1; SP.app.commit('EQ'); draw(); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    cv.addEventListener('dblclick', e => { const h = hitBand(e); if (h.best < 0) return; const b = bands[h.best]; for (const k of [b.f, b.g, b.q]) if (k) p[k] = defs[k].def; SP.app.commit('Reset EQ band'); draw(); });
    cv.addEventListener('wheel', e => {
      const h = hitBand(e); if (h.best < 0 || !bands[h.best].q) return;
      e.preventDefault(); const k = bands[h.best].q, d = defs[k];
      p[k] = Math.min(d.max, Math.max(d.min, p[k] * Math.exp(-e.deltaY * 0.004)));
      SP.app.touch(); draw(); clearTimeout(cv._wt); cv._wt = setTimeout(() => SP.app.commit('EQ width'), 300);
    }, { passive: false });
    requestAnimationFrame(draw);
    return { canvas: cv, draw };
  }

  function gateEditor(fx) {
    const cv = el('canvas', 'gatecanvas');
    const p = fx.p;
    const n = () => parseInt(p.steps, 10) || 16;
    function draw() {
      const dpr = window.devicePixelRatio || 1, W = cv.clientWidth || 300, H = cv.clientHeight || 70;
      cv.width = W * dpr; cv.height = H * dpr;
      const g = cv.getContext('2d'); g.scale(dpr, dpr);
      g.fillStyle = '#0a0c10'; g.fillRect(0, 0, W, H);
      const N = n(), w = W / N;
      for (let i = 0; i < N; i++) {
        const v = p.pattern[i] || 0;
        g.fillStyle = i % 4 === 0 ? '#1d2330' : '#151a24'; g.fillRect(i * w + 1, 2, w - 2, H - 4);
        if (v > 0) { g.fillStyle = `rgba(255,92,138,${0.35 + 0.65 * v})`; g.fillRect(i * w + 1, 2 + (H - 4) * (1 - v), w - 2, (H - 4) * v); }
      }
    }
    let painting = null;
    const stepAt = (e) => { const r = cv.getBoundingClientRect(); return { i: Math.floor((e.clientX - r.left) / r.width * n()), v: Math.max(0.1, Math.min(1, 1 - (e.clientY - r.top) / r.height)) }; };
    cv.addEventListener('pointerdown', e => {
      const s = stepAt(e); if (s.i < 0 || s.i >= n()) return;
      cv.setPointerCapture(e.pointerId);
      const on = (p.pattern[s.i] || 0) <= 0;
      painting = { on, startY: e.clientY, i0: s.i, moved: false };
      p.pattern[s.i] = on ? 1 : 0;
      SP.app.touch(); draw();
    });
    cv.addEventListener('pointermove', e => {
      if (!painting) return;
      const s = stepAt(e); if (s.i < 0 || s.i >= n()) return;
      if (Math.abs(e.clientY - painting.startY) > 4) painting.moved = true;
      if (painting.moved && painting.on) p.pattern[s.i] = s.v; // drag to set levels
      else if (s.i !== painting.i0) p.pattern[s.i] = painting.on ? 1 : 0;
      SP.app.touch(); draw();
    });
    const up = () => { if (painting) { painting = null; SP.app.commit('Gate steps'); } };
    cv.addEventListener('pointerup', up); cv.addEventListener('pointercancel', up);
    requestAnimationFrame(draw);
    return cv;
  }

  function flashPad(i) {
    const d = document.querySelector(`.pad[data-pad="${i}"]`);
    if (!d) return;
    d.classList.add('hit'); clearTimeout(d._t); d._t = setTimeout(() => d.classList.remove('hit'), 140);
  }

  SP.Panels = { renderLibrary, renderLibDetail, renderFrameBlock, renderPanel, renderPadInfo, setProgress, flashPad };
  void padHit;
})();
