// Spiders - timeline: tracks of recorded frames, ruler with loop region, editing.
(function () {
  const SP = (window.Spiders = window.Spiders || {});
  const RULER = 26, LANE = 64;

  class Timeline {
    constructor(app, canvas, headersInner) {
      this.app = app; this.cv = canvas; this.hdr = headersInner;
      this.ppb = 26; this.scrollX = 0; this.scrollY = 0;
      this.sel = new Set();
      this.drag = null; this.follow = true;
      this.bind();
      new ResizeObserver(() => this.resize()).observe(canvas);
      this.resize();
    }
    get p() { return this.app.project; }
    snapBeats() { const s = this.p.snap; if (s === 'Off') return 0; if (s === '1 bar') return this.p.beatsPerBar; return SP.DIVS[s] || 0.25; }
    snap(b, force) { const q = this.snapBeats(); return q && !force ? Math.round(b / q) * q : b; }
    resize() {
      const dpr = window.devicePixelRatio || 1;
      this.W = this.cv.clientWidth | 0; this.H = this.cv.clientHeight | 0;
      this.cv.width = Math.max(1, Math.round(this.W * dpr)); this.cv.height = Math.max(1, Math.round(this.H * dpr));
      this.dpr = dpr;
      this.clampScroll();
    }
    clampScroll() {
      const maxY = Math.max(0, this.p ? this.p.tracks.length * LANE - (this.H - RULER) + 20 : 0);
      this.scrollY = Math.min(maxY, Math.max(0, this.scrollY));
      this.scrollX = Math.max(0, this.scrollX);
      this.hdr.style.transform = `translateY(${-this.scrollY}px)`;
    }
    xOf(b) { return (b - this.scrollX) * this.ppb; }
    bOf(x) { return x / this.ppb + this.scrollX; }
    rowOf(y) { return Math.floor((y - RULER + this.scrollY) / LANE); }
    laneTop(r) { return RULER + r * LANE - this.scrollY; }

    // ---------- headers ----------
    renderHeaders() {
      const app = this.app, p = this.p;
      this.hdr.innerHTML = '';
      p.tracks.forEach((t, r) => {
        const d = document.createElement('div');
        d.className = 'trk' + (t.id === p.selectedTrack ? ' sel' : '');
        d.style.setProperty('--c', t.color);
        d.innerHTML = `<div class="top"><span class="tn" title="Double-click to rename">${SP.escape(t.name)}</span><span class="arm">● ARMED</span>
          <button class="ms m ${t.mute ? 'on' : ''}" title="Mute">M</button><button class="ms s ${t.solo ? 'on' : ''}" title="Solo">S</button></div>
          <div class="bot"><input type="range" class="vol" min="0" max="1.25" step="0.01" value="${t.volume}" title="Volume"><input type="range" class="pan" min="-1" max="1" step="0.01" value="${t.pan}" title="Pan (double-click to centre)"></div>`;
        d.addEventListener('pointerdown', (e) => { if (e.target.tagName !== 'INPUT' && e.target.tagName !== 'BUTTON') app.selectTrack(t.id); });
        const nm = d.querySelector('.tn');
        nm.addEventListener('dblclick', () => this.rename(t, nm));
        d.querySelector('.m').onclick = () => { t.mute = !t.mute; app.commit('Mute'); this.renderHeaders(); };
        d.querySelector('.s').onclick = () => { t.solo = !t.solo; app.commit('Solo'); this.renderHeaders(); };
        const vol = d.querySelector('.vol'), pan = d.querySelector('.pan');
        vol.oninput = () => { t.volume = +vol.value; app.touch(); };
        vol.onchange = () => app.commit('Volume');
        pan.oninput = () => { t.pan = +pan.value; app.touch(); };
        pan.onchange = () => app.commit('Pan');
        pan.ondblclick = () => { t.pan = 0; pan.value = 0; app.commit('Pan'); };
        d.addEventListener('contextmenu', (e) => { e.preventDefault(); app.trackMenu(e, t, () => this.rename(t, nm)); });
        this.hdr.appendChild(d);
      });
      this.clampScroll();
    }
    rename(t, el) {
      el.contentEditable = 'true'; el.focus();
      const r = document.createRange(); r.selectNodeContents(el); const s = window.getSelection(); s.removeAllRanges(); s.addRange(r);
      const done = () => { el.contentEditable = 'false'; const v = el.textContent.trim(); if (v && v !== t.name) { t.name = v.slice(0, 40); this.app.commit('Rename track'); } el.textContent = t.name; this.app.refreshPanel(); };
      el.onblur = done;
      el.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') { e.preventDefault(); el.blur(); } if (e.key === 'Escape') { el.textContent = t.name; el.blur(); } };
    }

    // ---------- events ----------
    eventColor(ev, track) {
      const an = this.app.analysis.get(ev.sampleId);
      if (!an) return track.color;
      const c = an.cluster[ev.frame];
      return c >= 0 ? SP.clusterColor(c, an.k) : '#5b6478';
    }
    rows(track) {
      // vertical placement: by pitch if the track has melodies, otherwise by timbre group
      let lo = Infinity, hi = -Infinity;
      for (const e of track.events) { lo = Math.min(lo, e.pitch || 0); hi = Math.max(hi, e.pitch || 0); }
      if (hi > lo) return (e) => ((e.pitch || 0) - lo) / (hi - lo);
      return (e) => { const an = this.app.analysis.get(e.sampleId); if (!an || an.k < 2) return 0.5; const c = an.cluster[e.frame]; return c < 0 ? 0 : c / (an.k - 1); };
    }
    evRect(ev, r, rowFn, nowBeat) {
      const len = ev._recording ? Math.max(0.05, this.wrapLen(ev, nowBeat)) : ev.len;
      const x = this.xOf(ev.t), w = Math.max(3, len * this.ppb);
      const h = 11, top = this.laneTop(r) + 6;
      const y = top + (1 - rowFn(ev)) * (LANE - 12 - h);
      return { x, y, w, h };
    }
    wrapLen(ev, nowBeat) {
      const L = this.p.loop;
      let l = nowBeat - ev.t;
      if (l < 0 && L.on) l = L.end - ev.t + (nowBeat - L.start);
      return l;
    }
    hitTest(x, y) {
      const r = this.rowOf(y), tr = this.p.tracks[r];
      if (!tr || y < RULER) return null;
      const rowFn = this.rows(tr), now = this.app.engine.beatNow();
      for (let i = tr.events.length - 1; i >= 0; i--) {
        const ev = tr.events[i];
        const q = this.evRect(ev, r, rowFn, now);
        if (x >= q.x - 2 && x <= q.x + q.w + 2 && y >= q.y - 3 && y <= q.y + q.h + 3) return { ev, track: tr, row: r, rect: q, edge: x > q.x + q.w - 6 && q.w > 10 };
      }
      return null;
    }
    selectedEvents() {
      const out = [];
      for (const t of this.p.tracks) for (const e of t.events) if (this.sel.has(e.id)) out.push({ ev: e, track: t });
      return out;
    }
    deleteSelected() {
      if (!this.sel.size) return false;
      for (const t of this.p.tracks) t.events = t.events.filter(e => !this.sel.has(e.id));
      this.sel.clear();
      this.app.commit('Delete notes');
      return true;
    }
    duplicateSelected() {
      const items = this.selectedEvents(); if (!items.length) return;
      const lo = Math.min(...items.map(i => i.ev.t)), hi = Math.max(...items.map(i => i.ev.t + i.ev.len));
      const span = Math.ceil((hi - lo) / this.p.beatsPerBar - 1e-6) * this.p.beatsPerBar || this.p.beatsPerBar;
      this.sel.clear();
      for (const { ev, track } of items) { const c = Object.assign({}, ev, { id: SP.uid('ev'), t: ev.t + span }); delete c._skipPass; track.events.push(c); this.sel.add(c.id); }
      this.app.commit('Duplicate notes');
    }
    quantize() {
      const q = this.snapBeats() || 0.25;
      let items = this.selectedEvents();
      if (!items.length) { const t = this.app.selTrack(); if (t) items = t.events.map(ev => ({ ev, track: t })); }
      if (!items.length) return;
      for (const { ev } of items) ev.t = Math.max(0, Math.round(ev.t / q) * q);
      this.app.commit('Quantize');
      this.app.toast(`Quantized ${items.length} note${items.length > 1 ? 's' : ''} to ${this.p.snap === 'Off' ? '1/16' : this.p.snap}`);
    }
    selectAll() { const t = this.app.selTrack(); if (!t) return; this.sel = new Set(t.events.map(e => e.id)); }
    insertFrame(track, hit, beat) {
      const q = this.snapBeats() || 0.25;
      const ev = { id: SP.uid('ev'), sampleId: hit.sampleId, frame: hit.frame, start: hit.start, end: hit.end, t: Math.max(0, beat), len: q, pitch: hit.pitch || 0, vel: 0.85, note: hit.note == null ? 60 : hit.note };
      track.events.push(ev);
      this.sel = new Set([ev.id]);
      this.app.commit('Add note');
      return ev;
    }

    // ---------- drawing ----------
    draw() {
      const g = this.cv.getContext('2d'), p = this.p, app = this.app;
      if (!p) return;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
      const W = this.W, H = this.H;
      g.fillStyle = '#0b0d12'; g.fillRect(0, 0, W, H);
      const bpb = p.beatsPerBar;
      const b0 = this.scrollX, b1 = this.bOf(W);
      const nowBeat = app.engine.beatNow();
      // follow playhead
      if (app.engine.playing && this.follow && !this.drag) {
        if (nowBeat > b1 - 1 || nowBeat < b0) this.scrollX = Math.max(0, nowBeat - (b1 - b0) * 0.1);
      }
      // lanes
      p.tracks.forEach((t, r) => {
        const y = this.laneTop(r);
        if (y > H || y + LANE < RULER) return;
        g.fillStyle = t.id === p.selectedTrack ? '#121621' : (r % 2 ? '#0c0e13' : '#0d1016');
        g.fillRect(0, y, W, LANE);
        g.fillStyle = '#1a1f2b'; g.fillRect(0, y + LANE - 1, W, 1);
      });
      // loop region
      const L = p.loop;
      if (L.on) { g.fillStyle = 'rgba(110,231,255,0.045)'; g.fillRect(this.xOf(L.start), RULER, (L.end - L.start) * this.ppb, H); }
      // grid
      const q = this.snapBeats();
      const showSub = q && q * this.ppb >= 7;
      for (let b = Math.floor(b0 / (q || 1)) * (q || 1); b <= b1; b += (showSub ? q : 1)) {
        const x = Math.round(this.xOf(b)) + 0.5;
        const isBar = Math.abs(b / bpb - Math.round(b / bpb)) < 1e-6, isBeat = Math.abs(b - Math.round(b)) < 1e-6;
        g.fillStyle = isBar ? '#2a3244' : isBeat ? '#1a2030' : '#13171f';
        if (!isBeat && this.ppb < 14) continue;
        g.fillRect(x, RULER, 1, H);
      }
      // events
      p.tracks.forEach((t, r) => {
        const y = this.laneTop(r);
        if (y > H || y + LANE < RULER) return;
        const rowFn = this.rows(t);
        for (const ev of t.events) {
          const q2 = this.evRect(ev, r, rowFn, nowBeat);
          if (q2.x > W || q2.x + q2.w < 0) continue;
          g.globalAlpha = t.mute ? 0.35 : 1;
          g.fillStyle = this.eventColor(ev, t);
          this.rr(g, q2.x, q2.y, q2.w, q2.h, 3); g.fill();
          if (this.sel.has(ev.id)) { g.strokeStyle = '#fff'; g.lineWidth = 1.5; this.rr(g, q2.x - 0.5, q2.y - 0.5, q2.w + 1, q2.h + 1, 3); g.stroke(); }
          if (ev._recording) { g.strokeStyle = '#ff3b4e'; g.lineWidth = 1.5; this.rr(g, q2.x, q2.y, q2.w, q2.h, 3); g.stroke(); }
          g.globalAlpha = 1;
        }
      });
      // playhead lines for hits (velocity of the pattern): faint
      // marquee
      if (this.drag && this.drag.mode === 'marquee') {
        const d = this.drag;
        g.fillStyle = 'rgba(223,231,242,0.08)'; g.strokeStyle = 'rgba(223,231,242,0.5)'; g.lineWidth = 1;
        const x = Math.min(d.x0, d.x1), y = Math.min(d.y0, d.y1), w = Math.abs(d.x1 - d.x0), h = Math.abs(d.y1 - d.y0);
        g.fillRect(x, y, w, h); g.strokeRect(x + 0.5, y + 0.5, w, h);
      }
      // ruler
      g.fillStyle = '#10131a'; g.fillRect(0, 0, W, RULER);
      g.fillStyle = '#1d2330'; g.fillRect(0, RULER - 1, W, 1);
      if (L.on || true) {
        g.fillStyle = L.on ? 'rgba(110,231,255,0.35)' : 'rgba(143,154,176,0.18)';
        g.fillRect(this.xOf(L.start), 2, (L.end - L.start) * this.ppb, 8);
      }
      g.font = '10px ui-monospace, SF Mono, Menlo, monospace'; g.fillStyle = '#8f9ab0'; g.textBaseline = 'alphabetic';
      const barPx = bpb * this.ppb, every = barPx < 26 ? Math.ceil(26 / barPx) : 1;
      for (let bar = Math.floor(b0 / bpb); bar * bpb <= b1; bar++) {
        if (bar < 0 || bar % every) continue;
        const x = this.xOf(bar * bpb);
        g.fillStyle = '#2e3646'; g.fillRect(Math.round(x), 12, 1, RULER - 12);
        g.fillStyle = '#8f9ab0'; g.fillText(String(bar + 1), x + 4, RULER - 6);
      }
      // song end marker
      const end = app.songEnd();
      if (end > 0) { const x = this.xOf(end); g.fillStyle = 'rgba(255,92,138,0.35)'; g.fillRect(x, RULER, 1, H); }
      // playhead
      const ph = this.xOf(nowBeat);
      if (ph >= -2 && ph <= W + 2) {
        g.fillStyle = app.recording ? '#ff3b4e' : '#dfe7f2';
        g.fillRect(Math.round(ph), 0, 1.5, H);
        g.beginPath(); g.moveTo(ph - 5, 0); g.lineTo(ph + 5, 0); g.lineTo(ph, 7); g.fill();
      }
      if (!p.tracks.length) { g.fillStyle = '#586178'; g.font = '12px -apple-system, Segoe UI, sans-serif'; g.fillText('Add a track to start recording.', 16, RULER + 28); }
    }
    rr(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

    // ---------- interaction ----------
    pos(e) { const r = this.cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
    bind() {
      const cv = this.cv, app = this.app;
      cv.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
          const { x } = this.pos(e), b = this.bOf(x);
          this.ppb = Math.min(240, Math.max(4, this.ppb * Math.exp(-e.deltaY * 0.0025)));
          this.scrollX = Math.max(0, b - x / this.ppb);
        } else if (e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) {
          this.scrollX = Math.max(0, this.scrollX + (e.deltaX || e.deltaY) / this.ppb);
          this.follow = !app.engine.playing;
        } else {
          this.scrollY += e.deltaY;
        }
        this.clampScroll();
      }, { passive: false });
      this.hdr.parentElement.addEventListener('wheel', e => { e.preventDefault(); this.scrollY += e.deltaY; this.clampScroll(); }, { passive: false });

      cv.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const { x, y } = this.pos(e);
        cv.setPointerCapture(e.pointerId);
        this.follow = true;
        if (y < RULER) { this.drag = { mode: 'ruler', x0: x, b0: this.bOf(x), moved: false }; return; }
        const hit = this.hitTest(x, y);
        if (hit) {
          app.selectTrack(hit.track.id, true);
          if (e.shiftKey) { if (this.sel.has(hit.ev.id)) this.sel.delete(hit.ev.id); else this.sel.add(hit.ev.id); }
          else if (!this.sel.has(hit.ev.id)) this.sel = new Set([hit.ev.id]);
          if (e.altKey) { // duplicate then drag the copies
            const copies = [];
            let anchorCopy = null;
            for (const { ev, track } of this.selectedEvents()) { const c = Object.assign({}, ev, { id: SP.uid('ev') }); delete c._skipPass; track.events.push(c); copies.push(c.id); if (ev === hit.ev) anchorCopy = c; }
            this.sel = new Set(copies);
            if (anchorCopy) hit.ev = anchorCopy;
          }
          const items = this.selectedEvents().map(({ ev, track }) => ({ ev, row: this.p.tracks.indexOf(track), t: ev.t, len: ev.len }));
          this.drag = { mode: hit.edge ? 'resize' : 'move', x0: x, y0: y, items, row0: hit.row, moved: false, anchor: hit.ev, dup: e.altKey };
          app.auditionEvent(hit.ev, hit.track);
          return;
        }
        const r = this.rowOf(y);
        if (this.p.tracks[r]) app.selectTrack(this.p.tracks[r].id, true);
        if (!e.shiftKey) this.sel.clear();
        this.drag = { mode: 'marquee', x0: x, y0: y, x1: x, y1: y, base: new Set(this.sel) };
      });
      cv.addEventListener('pointermove', e => {
        const d = this.drag; const { x, y } = this.pos(e);
        if (!d) {
          const h = y >= RULER ? this.hitTest(x, y) : null;
          cv.style.cursor = y < RULER ? 'pointer' : h ? (h.edge ? 'ew-resize' : 'grab') : 'default';
          return;
        }
        if (Math.abs(x - d.x0) > 3 || (d.y0 != null && Math.abs(y - d.y0) > 3)) d.moved = true;
        if (d.mode === 'ruler') {
          if (!d.moved) return;
          const a = this.snap(Math.max(0, d.b0), false), b = this.snap(Math.max(0, this.bOf(x)), false);
          const lo = Math.min(a, b), hi = Math.max(a, b);
          if (hi - lo >= 0.25) { this.p.loop.start = lo; this.p.loop.end = hi; this.p.loop.on = true; app.refreshTransport(); }
        } else if (d.mode === 'move') {
          const a0 = (d.items.find(i => i.ev === d.anchor) || d.items[0]).t;
          const db = this.snap(a0 + this.bOf(x) - this.bOf(d.x0)) - a0;
          const dr = this.rowOf(y) - d.row0;
          const minRow = Math.min(...d.items.map(i => i.row)), maxRow = Math.max(...d.items.map(i => i.row));
          const drc = Math.max(-minRow, Math.min(this.p.tracks.length - 1 - maxRow, dr));
          const minT = Math.min(...d.items.map(i => i.t));
          const dbc = Math.max(-minT, db);
          for (const it of d.items) {
            it.ev.t = it.t + dbc;
            const want = this.p.tracks[it.row + drc];
            const cur = this.p.tracks.find(t => t.events.includes(it.ev));
            if (want && cur !== want) { cur.events.splice(cur.events.indexOf(it.ev), 1); want.events.push(it.ev); }
          }
        } else if (d.mode === 'resize') {
          const q = this.snapBeats();
          const dl = (x - d.x0) / this.ppb;
          for (const it of d.items) { let l = it.len + dl; if (q) l = Math.round((it.t + l) / q) * q - it.t; it.ev.len = Math.max(q || 0.0625, l); }
        } else if (d.mode === 'marquee') {
          d.x1 = x; d.y1 = y;
          const x0 = Math.min(d.x0, x), x1 = Math.max(d.x0, x), y0 = Math.min(d.y0, y), y1 = Math.max(d.y0, y);
          this.sel = new Set(d.base);
          const now = app.engine.beatNow();
          this.p.tracks.forEach((t, r) => {
            const rowFn = this.rows(t);
            for (const ev of t.events) { const q2 = this.evRect(ev, r, rowFn, now); if (q2.x + q2.w >= x0 && q2.x <= x1 && q2.y + q2.h >= y0 && q2.y <= y1) this.sel.add(ev.id); }
          });
        }
      });
      const up = (e) => {
        const d = this.drag; this.drag = null;
        if (!d) return;
        app.noteOff('tl');
        if (d.mode === 'ruler') {
          if (!d.moved) app.locate(this.snap(Math.max(0, d.b0), false));
          else app.commit('Set loop');
        } else if ((d.mode === 'move' || d.mode === 'resize') && (d.moved || d.dup)) {
          app.commit(d.mode === 'move' ? (d.dup ? 'Duplicate notes' : 'Move notes') : 'Change note length');
        }
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('dblclick', e => {
        const { x, y } = this.pos(e);
        if (y < RULER) return;
        if (this.hitTest(x, y)) return;
        const tr = this.p.tracks[this.rowOf(y)];
        if (!tr) { app.addTrack(); return; }
        const hit = app.currentHit(tr);
        if (!hit) { app.toast('Click a cell in the map first, then double-click here to place it.'); return; }
        this.insertFrame(tr, hit, this.snap(this.bOf(x)));
      });
      cv.addEventListener('contextmenu', e => {
        e.preventDefault();
        const { x, y } = this.pos(e);
        const hit = y >= RULER ? this.hitTest(x, y) : null;
        if (hit) {
          if (!this.sel.has(hit.ev.id)) this.sel = new Set([hit.ev.id]);
          const shift = (d) => () => { for (const { ev } of this.selectedEvents()) ev.pitch = Math.max(-36, Math.min(36, (ev.pitch || 0) + d)); app.commit('Change pitch'); };
          app.menu(e.clientX, e.clientY, [
            { label: 'Delete', action: () => this.deleteSelected() },
            { label: 'Duplicate after', action: () => this.duplicateSelected() },
            { label: 'Quantize', action: () => this.quantize() },
            '-',
            { label: 'Pitch up a semitone', action: shift(1) }, { label: 'Pitch down a semitone', action: shift(-1) },
            { label: 'Pitch up an octave', action: shift(12) }, { label: 'Pitch down an octave', action: shift(-12) },
            '-',
            { label: 'Show this frame in the map', action: () => app.revealFrame(hit.ev.sampleId, hit.ev.frame) }
          ]);
        } else if (y >= RULER) {
          const tr = this.p.tracks[this.rowOf(y)];
          const b = this.snap(this.bOf(x));
          const items = [];
          if (tr) {
            const h = app.currentHit(tr);
            if (h) items.push({ label: 'Place the selected frame here', action: () => this.insertFrame(tr, h, b) });
            if (app.clipboard && app.clipboard.length) items.push({ label: 'Paste here', action: () => app.paste(tr, b) });
          }
          items.push({ label: 'Move playhead here', action: () => app.locate(b) });
          items.push({ label: 'Add track', action: () => app.addTrack() });
          app.menu(e.clientX, e.clientY, items);
        }
      });
    }
    zoom(f) { const mid = this.bOf(this.W / 2); this.ppb = Math.min(240, Math.max(4, this.ppb * f)); this.scrollX = Math.max(0, mid - this.W / 2 / this.ppb); }
  }

  SP.Timeline = Timeline;
  SP.TL_LANE = LANE;
})();
