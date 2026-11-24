// Spiders - the map: every frame of the sound becomes a cell, coloured by its timbre group,
// with its own little radial spectrum drawn inside. Plus the strip (the whole sound along time).
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  class MapView {
    constructor(app, canvas, strip, tip) {
      this.app = app; this.cv = canvas; this.st = strip; this.tip = tip;
      this.sid = null; this.dirty = true; this.base = null; this.masks = new Map();
      this.hover = -1; this.down = null; this.highlightCluster = -1;
      this.stripHover = -1;
      this.bind();
      new ResizeObserver(() => { this.dirty = true; }).observe(canvas.parentElement);
      new ResizeObserver(() => { this.stripDirty = true; }).observe(strip);
    }
    get an() { return this.sid ? this.app.analysis.get(this.sid) : null; }
    setSample(id) { if (id !== this.sid) { this.sid = id; this.dirty = true; this.hover = -1; } }
    invalidate() { this.dirty = true; this.stripDirty = true; }

    // ---------- geometry ----------
    fit(W, H) {
      const an = this.an; const A = an ? an.aspect : 1.75;
      const padT = 34, pad = 16;
      const sc = Math.min((W - 2 * pad) / A, (H - padT - pad));
      const ox = (W - A * sc) / 2, oy = padT + (H - padT - pad - sc) / 2;
      return { sc, ox, oy };
    }
    site(i) { const an = this.an, f = this.geo; return [f.ox + an.x[i] * f.sc, f.oy + an.y[i] * f.sc]; }

    rebuild() {
      this.dirty = false; this.masks.clear();
      const cv = this.cv, dpr = window.devicePixelRatio || 1;
      const W = Math.max(50, cv.clientWidth | 0), H = Math.max(50, cv.clientHeight | 0);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      this.W = W; this.H = H; this.dpr = dpr;
      const an = this.an;
      const base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
      const bx = base.getContext('2d');
      // background web texture
      bx.fillStyle = '#07080b'; bx.fillRect(0, 0, base.width, base.height);
      this.base = base;
      if (!an || !an.n) { this.labels = null; return; }
      const geo = this.geo = this.fit(W, H);
      const act = [];
      for (let i = 0; i < an.n; i++) if (an.cluster[i] >= 0) act.push(i);
      this.act = act;
      if (!act.length) { this.labels = null; return; }
      const sx = new Float32Array(act.length), sy = new Float32Array(act.length);
      act.forEach((i, a) => { sx[a] = geo.ox + an.x[i] * geo.sc; sy[a] = geo.oy + an.y[i] * geo.sc; });
      const area = an.layout === 'web' ? Math.PI * Math.pow(0.48 * geo.sc, 2) : an.aspect * geo.sc * geo.sc;
      const spacing = Math.sqrt(area / act.length);
      const Rmax = spacing * 0.78;
      this.spacing = spacing; this.Rmax = Rmax;
      // bucket grid
      const cell = Rmax, gw = Math.ceil(W / cell) + 1, gh = Math.ceil(H / cell) + 1;
      const head = new Int32Array(gw * gh).fill(-1), next = new Int32Array(act.length);
      for (let a = 0; a < act.length; a++) {
        const g = Math.min(gh - 1, Math.max(0, Math.floor(sy[a] / cell))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(sx[a] / cell)));
        next[a] = head[g]; head[g] = a;
      }
      const labels = new Int32Array(W * H).fill(-1);
      const img = new ImageData(W, H), px = img.data;
      const k = Math.max(1, an.k);
      const rgb = []; for (let c = 0; c < k; c++) rgb.push(SP.clusterRGB(c, k));
      // loudness normalisation
      let lo = Infinity, hi = -Infinity;
      for (const i of act) { lo = Math.min(lo, an.rmsDb[i]); hi = Math.max(hi, an.rmsDb[i]); }
      const SB = an.specBands;
      const bbox = new Float32Array(act.length * 4);
      for (let a = 0; a < act.length; a++) { bbox[a * 4] = 1e9; bbox[a * 4 + 1] = 1e9; bbox[a * 4 + 2] = -1; bbox[a * 4 + 3] = -1; }
      const R2 = Rmax * Rmax;
      for (let y = 0; y < H; y++) {
        const gy = Math.floor(y / cell);
        for (let x = 0; x < W; x++) {
          const gx = Math.floor(x / cell);
          let b1 = -1, d1 = R2, d2 = R2 * 4;
          for (let oy = -1; oy <= 1; oy++) {
            const cy = gy + oy; if (cy < 0 || cy >= gh) continue;
            for (let ox = -1; ox <= 1; ox++) {
              const cx = gx + ox; if (cx < 0 || cx >= gw) continue;
              for (let a = head[cy * gw + cx]; a !== -1; a = next[a]) {
                const dx = x - sx[a], dy = y - sy[a], d = dx * dx + dy * dy;
                if (d < d1) { d2 = d1; d1 = d; b1 = a; } else if (d < d2) d2 = d;
              }
            }
          }
          if (b1 < 0) continue;
          const o = y * W + x;
          labels[o] = b1;
          const bb = b1 * 4;
          if (x < bbox[bb]) bbox[bb] = x; if (y < bbox[bb + 1]) bbox[bb + 1] = y; if (x > bbox[bb + 2]) bbox[bb + 2] = x; if (y > bbox[bb + 3]) bbox[bb + 3] = y;
          const i = act[b1], c = an.cluster[i];
          const r1 = Math.sqrt(d1), r2 = Math.sqrt(d2);
          const edge = r2 - r1; // distance to the border with the next cell
          const loud = hi > lo ? (an.rmsDb[i] - lo) / (hi - lo) : 1;
          let shade = 0.38 + 0.5 * loud;
          // radial spectrum glyph: low bands at the top, clockwise
          const th = Math.atan2(x - sx[b1], -(y - sy[b1]));
          let band = Math.floor(((th + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SB);
          if (band >= SB) band = SB - 1;
          const sv = an.spec[i * SB + band];
          const glyphR = Rmax * (0.18 + 0.62 * sv);
          let whiten = 0;
          if (r1 < glyphR) whiten = 0.32 + 0.25 * (1 - r1 / glyphR);
          shade *= 1 - 0.25 * (r1 / Rmax);
          let a8 = 255;
          if (r1 > Rmax * 0.86) a8 = Math.max(0, 255 * (1 - (r1 - Rmax * 0.86) / (Rmax * 0.14)));
          let R = rgb[c][0] * shade, G = rgb[c][1] * shade, B = rgb[c][2] * shade;
          R += (255 - R) * whiten * shade; G += (255 - G) * whiten * shade; B += (255 - B) * whiten * shade;
          if (edge < 1.6) { const e = 0.25 + 0.5 * (edge / 1.6); R *= e; G *= e; B *= e; }
          const p4 = o * 4;
          px[p4] = R; px[p4 + 1] = G; px[p4 + 2] = B; px[p4 + 3] = a8;
        }
      }
      this.labels = labels; this.bbox = bbox; this.sx = sx; this.sy = sy;
      const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
      tmp.getContext('2d').putImageData(img, 0, 0);
      bx.save(); bx.scale(dpr, dpr);
      // silk: the web behind and over the cells
      this.drawSilk(bx, an, geo, true);
      bx.imageSmoothingEnabled = true; bx.drawImage(tmp, 0, 0, W, H);
      this.drawSilk(bx, an, geo, false);
      bx.restore();
    }

    drawSilk(g, an, geo, under) {
      g.lineCap = 'round';
      if (an.layout === 'web' && an.sectors && an.sectors.length) {
        const cx = geo.ox + an.aspect / 2 * geo.sc, cy = geo.oy + 0.5 * geo.sc, R = 0.5 * geo.sc;
        g.strokeStyle = under ? 'rgba(223,231,242,0.16)' : 'rgba(223,231,242,0.10)';
        g.lineWidth = under ? 1.2 : 0.8;
        const spokes = [];
        for (const s of an.sectors) {
          spokes.push(s.a0);
          const span = s.a1 - s.a0, extra = Math.max(0, Math.round(span / 0.45) - 1);
          for (let e = 1; e <= extra; e++) spokes.push(s.a0 + span * e / (extra + 1));
        }
        spokes.sort((a, b) => a - b);
        g.beginPath();
        for (const a of spokes) { g.moveTo(cx, cy); g.lineTo(cx + R * Math.cos(a), cy + R * Math.sin(a)); }
        g.stroke();
        // spiral-ish rings that sag between spokes
        const rings = 9;
        g.beginPath();
        for (let r = 1; r <= rings; r++) {
          const rr = R * (0.12 + 0.88 * r / rings);
          for (let q = 0; q < spokes.length; q++) {
            const a0 = spokes[q], a1 = q + 1 < spokes.length ? spokes[q + 1] : spokes[0] + Math.PI * 2;
            const p0x = cx + rr * Math.cos(a0), p0y = cy + rr * Math.sin(a0), p1x = cx + rr * Math.cos(a1), p1y = cy + rr * Math.sin(a1);
            const mx = cx + (rr * 0.93) * Math.cos((a0 + a1) / 2), my = cy + (rr * 0.93) * Math.sin((a0 + a1) / 2);
            g.moveTo(p0x, p0y); g.quadraticCurveTo(mx, my, p1x, p1y);
          }
        }
        g.stroke();
        if (!under) { // group sector borders
          g.strokeStyle = 'rgba(223,231,242,0.35)'; g.lineWidth = 1.2; g.beginPath();
          for (const s of an.sectors) { g.moveTo(cx + R * 0.08 * Math.cos(s.a0), cy + R * 0.08 * Math.sin(s.a0)); g.lineTo(cx + R * 1.02 * Math.cos(s.a0), cy + R * 1.02 * Math.sin(s.a0)); }
          g.stroke();
        }
      } else if (under) {
        // faint grid of silk
        g.strokeStyle = 'rgba(223,231,242,0.05)'; g.lineWidth = 1; g.beginPath();
        const step = 40;
        for (let x = geo.ox; x < geo.ox + an.aspect * geo.sc; x += step) { g.moveTo(x, geo.oy); g.lineTo(x, geo.oy + geo.sc); }
        for (let y = geo.oy; y < geo.oy + geo.sc; y += step) { g.moveTo(geo.ox, y); g.lineTo(geo.ox + an.aspect * geo.sc, y); }
        g.stroke();
      }
      if (!under) {
        // the thread through time: joins each frame to the next one
        g.strokeStyle = 'rgba(223,231,242,0.07)'; g.lineWidth = 0.7; g.beginPath();
        let first = true;
        for (let i = 0; i < an.n; i++) {
          if (an.cluster[i] < 0) { first = true; continue; }
          const x = geo.ox + an.x[i] * geo.sc, y = geo.oy + an.y[i] * geo.sc;
          if (first) g.moveTo(x, y); else g.lineTo(x, y);
          first = false;
        }
        g.stroke();
      }
    }

    mask(a) {
      let m = this.masks.get(a);
      if (m) return m;
      const bb = this.bbox, x0 = bb[a * 4], y0 = bb[a * 4 + 1], x1 = bb[a * 4 + 2], y1 = bb[a * 4 + 3];
      if (x1 < x0) return null;
      const w = x1 - x0 + 1, h = y1 - y0 + 1;
      const c = document.createElement('canvas'); c.width = w; c.height = h;
      const g = c.getContext('2d'), img = g.createImageData(w, h), d = img.data;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (this.labels[(y0 + y) * this.W + x0 + x] === a) {
          // outline-ish: brighter near the edge
          const o = (y * w + x) * 4;
          const L = this.labels, W = this.W, gx = x0 + x, gy = y0 + y;
          const edge = gx === 0 || gy === 0 || gx >= W - 1 || gy >= this.H - 1 || L[gy * W + gx - 1] !== a || L[gy * W + gx + 1] !== a || L[(gy - 1) * W + gx] !== a || L[(gy + 1) * W + gx] !== a;
          d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = edge ? 255 : 70;
        }
      }
      g.putImageData(img, 0, 0);
      m = { c, x0, y0 };
      if (this.masks.size > 80) this.masks.delete(this.masks.keys().next().value);
      this.masks.set(a, m);
      return m;
    }
    actIndex(frame) { if (!this.act) return -1; let lo = 0, hi = this.act.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (this.act[m] === frame) return m; if (this.act[m] < frame) lo = m + 1; else hi = m - 1; } return -1; }

    // ---------- per-frame drawing ----------
    draw() {
      if (this.dirty) this.rebuild();
      const cv = this.cv, g = cv.getContext('2d'), dpr = this.dpr;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.base, 0, 0);
      const an = this.an;
      if (an && this.labels) {
        g.setTransform(dpr, 0, 0, dpr, 0, 0);
        const app = this.app, now = app.engine.audibleTime();
        // cluster highlight from legend hover
        if (this.highlightCluster >= 0) {
          g.fillStyle = 'rgba(7,8,11,0.55)'; g.fillRect(0, 0, this.W, this.H);
          for (let a = 0; a < this.act.length; a++) if (an.cluster[this.act[a]] === this.highlightCluster) { const m = this.mask(a); if (m) { g.globalAlpha = 0.6; g.drawImage(m.c, m.x0, m.y0); } }
          g.globalAlpha = 1;
        }
        // pad labels for the selected track
        const tr = app.selTrack();
        if (tr) {
          g.font = '700 10px ' + getComputedStyle(document.body).fontFamily;
          g.textAlign = 'center'; g.textBaseline = 'middle';
          const fs = Math.max(9, Math.min(13, this.spacing * 0.32));
          g.font = `800 ${fs}px -apple-system, Segoe UI, sans-serif`;
          if (tr.playMode === 'pads') {
            tr.pads.forEach((p, k) => {
              if (!p || p.sampleId !== this.sid) return;
              const a = this.actIndex(p.frame); if (a < 0) return;
              const x = this.sx[a], y = this.sy[a];
              g.fillStyle = 'rgba(7,8,11,0.75)'; g.beginPath(); g.arc(x, y, fs * 0.85, 0, Math.PI * 2); g.fill();
              g.fillStyle = '#fff'; g.fillText(SP.KEYS[k].label, x, y + 0.5);
            });
          } else if (tr.melodic && tr.melodic.sampleId === this.sid) {
            const a = this.actIndex(tr.melodic.frame);
            if (a >= 0) { const x = this.sx[a], y = this.sy[a]; g.fillStyle = 'rgba(7,8,11,0.75)'; g.beginPath(); g.arc(x, y, fs, 0, Math.PI * 2); g.fill(); g.fillStyle = '#6ee7ff'; g.fillText('♪', x, y + 0.5); }
          }
        }
        // selected
        const sel = app.selFrame;
        if (sel && sel.sampleId === this.sid) {
          const a = this.actIndex(sel.frame);
          if (a >= 0) { const m = this.mask(a); if (m) { g.globalAlpha = 0.9; g.drawImage(m.c, m.x0, m.y0); g.globalAlpha = 1; } }
        }
        // hover
        if (this.hover >= 0) { const m = this.mask(this.hover); if (m) { g.globalAlpha = 0.55; g.drawImage(m.c, m.x0, m.y0); g.globalAlpha = 1; } }
        // playing frames light up
        for (const h of app.engine.hits) {
          if (h.sampleId !== this.sid) continue;
          const age = now - h.time;
          if (age < -0.02 || age > h.dur + 0.5) continue;
          const f = app.frameAt(this.sid, h.start + 1e-4);
          const a = this.actIndex(f); if (a < 0) continue;
          const life = age < h.dur ? 1 : Math.max(0, 1 - (age - h.dur) / 0.5);
          const x = this.sx[a], y = this.sy[a];
          const r = this.Rmax * (1.1 + 0.5 * (1 - life));
          const grd = g.createRadialGradient(x, y, 0, x, y, r);
          grd.addColorStop(0, `rgba(255,255,255,${0.75 * life})`); grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(x, y, r, 0, Math.PI * 2); g.fill();
          const m = this.mask(a); if (m) { g.globalAlpha = life; g.drawImage(m.c, m.x0, m.y0); g.globalAlpha = 1; }
        }
      }
      this.drawStrip();
    }

    drawStrip() {
      const cv = this.st, dpr = window.devicePixelRatio || 1;
      const W = cv.clientWidth | 0, H = cv.clientHeight | 0;
      if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); this.stripDirty = true; }
      const g = cv.getContext('2d');
      const an = this.an;
      if (this.stripDirty || this.stripSid !== this.sid) {
        this.stripDirty = false; this.stripSid = this.sid;
        const b = this.stripBase || (this.stripBase = document.createElement('canvas'));
        b.width = cv.width; b.height = cv.height;
        const bx = b.getContext('2d');
        bx.setTransform(dpr, 0, 0, dpr, 0, 0);
        bx.fillStyle = '#090b0f'; bx.fillRect(0, 0, W, H);
        if (an) {
          const cols = an.peaks.length / 2, mid = H / 2;
          let fi = 0;
          for (let x = 0; x < W; x++) {
            const c0 = Math.floor(x / W * cols), c1 = Math.max(c0 + 1, Math.floor((x + 1) / W * cols));
            let lo = 0, hi = 0;
            for (let c = c0; c < c1 && c < cols; c++) { lo = Math.min(lo, an.peaks[c * 2]); hi = Math.max(hi, an.peaks[c * 2 + 1]); }
            const t = (x + 0.5) / W * an.duration;
            while (fi < an.n - 1 && an.starts[fi + 1] <= t) fi++;
            const cl = an.cluster[fi];
            bx.fillStyle = cl >= 0 ? SP.clusterColor(cl, an.k) : '#3a4152';
            const y0 = mid - hi * mid * 0.92, y1 = mid - lo * mid * 0.92;
            bx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
          }
          // frame boundaries
          bx.fillStyle = 'rgba(223,231,242,0.10)';
          if (an.n < W / 3) for (let i = 1; i < an.n; i++) bx.fillRect(Math.round(an.starts[i] / an.duration * W), 0, 1, H);
        } else {
          bx.fillStyle = '#586178'; bx.font = '11px -apple-system, Segoe UI, sans-serif'; bx.fillText('The whole sound appears here, coloured by timbre group.', 12, H / 2 + 4);
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.stripBase, 0, 0);
      if (!an) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const xOf = t => t / an.duration * W;
      const band = (i, style) => { const x0 = xOf(an.starts[i]), x1 = xOf(an.ends[i]); g.fillStyle = style; g.fillRect(x0, 0, Math.max(1.5, x1 - x0), H); };
      const sel = this.app.selFrame;
      if (sel && sel.sampleId === this.sid) band(sel.frame, 'rgba(255,255,255,0.22)');
      const hv = this.stripHover >= 0 ? this.stripHover : (this.hover >= 0 ? this.act[this.hover] : -1);
      if (hv >= 0) band(hv, 'rgba(255,255,255,0.14)');
      if (this.highlightCluster >= 0) for (let i = 0; i < an.n; i++) if (an.cluster[i] === this.highlightCluster) band(i, 'rgba(255,255,255,0.12)');
      const now = this.app.engine.audibleTime();
      for (const h of this.app.engine.hits) {
        if (h.sampleId !== this.sid) continue;
        const age = now - h.time; if (age < 0 || age > h.dur + 0.3) continue;
        const life = age < h.dur ? 1 : 1 - (age - h.dur) / 0.3;
        const f = this.app.frameAt(this.sid, h.start + 1e-4);
        band(f, `rgba(255,255,255,${0.45 * life})`);
      }
    }

    // ---------- interaction ----------
    labelAt(e) {
      if (!this.labels) return -1;
      const r = this.cv.getBoundingClientRect();
      const x = Math.floor(e.clientX - r.left), y = Math.floor(e.clientY - r.top);
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
      return this.labels[y * this.W + x];
    }
    showTip(e, a) {
      const an = this.an, tip = this.tip;
      if (a < 0 || !an) { tip.style.display = 'none'; return; }
      const i = this.act[a];
      tip.innerHTML = `frame ${i + 1} · ${an.starts[i].toFixed(2)}–${an.ends[i].toFixed(2)} s · group ${an.cluster[i] + 1} · ${an.rmsDb[i].toFixed(0)} dB`;
      const r = this.cv.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = Math.min(r.width - tip.offsetWidth - 6, e.clientX - r.left + 14) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
    }
    bind() {
      const cv = this.cv, app = this.app;
      cv.addEventListener('pointermove', e => {
        const a = this.labelAt(e);
        if (this.down) {
          const r = cv.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) {
            if (!this.down.out) { this.down.out = true; app.noteOff('map'); app.dragGhost(true, e, this.down.frame); }
            else app.dragGhost(true, e, this.down.frame);
            return;
          }
          if (this.down.out) { this.down.out = false; app.dragGhost(false); }
          if (a >= 0 && a !== this.down.a && !this.down.assign) {
            this.down.a = a; this.down.frame = this.act[a];
            app.mapPress(this.sid, this.act[a], true);
          }
        }
        if (a !== this.hover) { this.hover = a; }
        this.showTip(e, a);
      });
      cv.addEventListener('pointerleave', () => { if (!this.down) { this.hover = -1; this.tip.style.display = 'none'; } });
      cv.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const a = this.labelAt(e);
        if (a < 0) return;
        cv.setPointerCapture(e.pointerId);
        this.down = { a, frame: this.act[a], assign: app.assignMode };
        app.mapPress(this.sid, this.act[a], false);
      });
      const up = (e) => {
        if (!this.down) return;
        const d = this.down; this.down = null;
        app.noteOff('map');
        if (d.out) { app.dragGhost(false); app.dropFrame(e, this.sid, d.frame); }
      };
      cv.addEventListener('pointerup', up);
      cv.addEventListener('pointercancel', up);
      cv.addEventListener('contextmenu', e => {
        e.preventDefault();
        const a = this.labelAt(e); if (a < 0) return;
        app.frameMenu(e, this.sid, this.act[a]);
      });

      // strip
      const st = this.st;
      const frameAtX = (e) => {
        const an = this.an; if (!an) return -1;
        const r = st.getBoundingClientRect();
        const t = (e.clientX - r.left) / r.width * an.duration;
        return app.frameAt(this.sid, t);
      };
      let sdown = null;
      st.addEventListener('pointermove', e => {
        const f = frameAtX(e);
        this.stripHover = f;
        if (sdown && f >= 0 && f !== sdown.f) { sdown.f = f; app.mapPress(this.sid, f, true); }
      });
      st.addEventListener('pointerleave', () => { this.stripHover = -1; });
      st.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        const f = frameAtX(e); if (f < 0) return;
        st.setPointerCapture(e.pointerId);
        sdown = { f };
        app.mapPress(this.sid, f, false);
      });
      const sup = () => { if (sdown) { sdown = null; app.noteOff('map'); } };
      st.addEventListener('pointerup', sup); st.addEventListener('pointercancel', sup);
      st.addEventListener('contextmenu', e => { e.preventDefault(); const f = frameAtX(e); if (f >= 0) app.frameMenu(e, this.sid, f); });
    }
  }

  SP.MapView = MapView;
})();
