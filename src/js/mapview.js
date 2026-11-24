// Spiders - the map: every frame of the sound becomes a cell, coloured by its timbre group,
// with its own little radial spectrum drawn inside. Plus the strip (the whole sound along time),
// where manual cells are drawn and edited.
(function () {
  const SP = (window.Spiders = window.Spiders || {});

  class MapView {
    constructor(app, canvas, strip, tip) {
      this.app = app; this.cv = canvas; this.st = strip; this.tip = tip;
      this.sid = null; this.dirty = true; this.base = null; this.masks = new Map();
      this.hover = -1; this.down = null; this.highlightCluster = -1;
      this.stripHover = -1; this.stripDrag = null;
      this.bind();
      new ResizeObserver(() => { this.dirty = true; }).observe(canvas.parentElement);
      new ResizeObserver(() => { this.stripDirty = true; }).observe(strip);
    }
    get an() { return this.sid ? this.app.analysis.get(this.sid) : null; }
    get sample() { return this.sid ? this.app.sampleById(this.sid) : null; }
    get manual() { const s = this.sample; return !!(s && s.settings.mode === 'manual'); }
    setSample(id) { if (id !== this.sid) { this.sid = id; this.dirty = true; this.stripDirty = true; this.hover = -1; } this.updateStripMode(); }
    invalidate() { this.dirty = true; this.stripDirty = true; this.updateStripMode(); }
    updateStripMode() {
      const m = this.manual;
      if (this.st.classList.contains('manual') !== m) { this.st.classList.toggle('manual', m); this.stripDirty = true; this.dirty = true; }
    }

    // ---------- geometry ----------
    fit(W, H) {
      const an = this.an; const A = an ? an.aspect : 1.75;
      const padT = 34, pad = 16;
      const sc = Math.min((W - 2 * pad) / A, (H - padT - pad));
      const ox = (W - A * sc) / 2, oy = padT + (H - padT - pad - sc) / 2;
      return { sc, ox, oy };
    }
    toLayout(px, py) { const g = this.geo; return g ? { x: (px - g.ox) / g.sc, y: (py - g.oy) / g.sc } : null; }

    rebuild() {
      this.dirty = false; this.masks.clear();
      const cv = this.cv, dpr = window.devicePixelRatio || 1;
      const W = Math.max(50, cv.clientWidth | 0), H = Math.max(50, cv.clientHeight | 0);
      cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
      this.W = W; this.H = H; this.dpr = dpr;
      const an = this.an;
      const base = document.createElement('canvas'); base.width = cv.width; base.height = cv.height;
      const bx = base.getContext('2d');
      bx.fillStyle = '#07080b'; bx.fillRect(0, 0, base.width, base.height);
      this.base = base; this.labels = null; this.act = null;
      if (!an || !an.n) return;
      const geo = this.geo = this.fit(W, H);
      const act = [];
      for (let i = 0; i < an.n; i++) if (an.cluster[i] >= 0 && isFinite(an.x[i])) act.push(i);
      this.act = act;
      if (!act.length) return;
      const cellsMode = an.layout === 'cells';
      const sx = new Float32Array(act.length), sy = new Float32Array(act.length);
      act.forEach((i, a) => { sx[a] = geo.ox + an.x[i] * geo.sc; sy[a] = geo.oy + an.y[i] * geo.sc; });
      const area = an.layout === 'web' ? Math.PI * Math.pow(0.48 * geo.sc, 2) : an.aspect * geo.sc * geo.sc;
      const spacing = Math.sqrt(area / act.length);
      const Rmax = cellsMode ? Infinity : spacing * 0.78;
      this.spacing = spacing; this.Rmax = Rmax;
      // clip region for the full tessellation
      const cx0 = geo.ox - 2, cy0 = geo.oy - 2, cx1 = geo.ox + an.aspect * geo.sc + 2, cy1 = geo.oy + geo.sc + 2;
      // bucket grid
      const cell = cellsMode ? Math.max(6, spacing) : Rmax;
      const gw = Math.ceil(W / cell) + 1, gh = Math.ceil(H / cell) + 1;
      const head = new Int32Array(gw * gh).fill(-1), next = new Int32Array(act.length);
      for (let a = 0; a < act.length; a++) {
        const g = Math.min(gh - 1, Math.max(0, Math.floor(sy[a] / cell))) * gw + Math.min(gw - 1, Math.max(0, Math.floor(sx[a] / cell)));
        next[a] = head[g]; head[g] = a;
      }
      const labels = new Int32Array(W * H).fill(-1);
      const r1s = new Float32Array(W * H), edges = new Float32Array(W * H);
      const inR = new Float32Array(act.length).fill(cellsMode ? 1e9 : Rmax);
      const bbox = new Float32Array(act.length * 4);
      for (let a = 0; a < act.length; a++) { bbox[a * 4] = 1e9; bbox[a * 4 + 1] = 1e9; bbox[a * 4 + 2] = -1; bbox[a * 4 + 3] = -1; }
      const R2 = Rmax * Rmax;
      const maxRing = Math.max(gw, gh);
      // pass 1: nearest and second-nearest site for every pixel
      for (let y = 0; y < H; y++) {
        const gy = Math.floor(y / cell);
        for (let x = 0; x < W; x++) {
          if (cellsMode && (x < cx0 || x > cx1 || y < cy0 || y > cy1)) continue;
          const gx = Math.floor(x / cell);
          let b1 = -1, d1 = R2, d2 = cellsMode ? Infinity : R2 * 4;
          for (let ring = 0; ring <= maxRing; ring++) {
            // stop once nothing in this ring can beat the second-nearest
            const ringDist = (ring - 1) * cell;
            if (ring > 1 && ringDist > 0 && ringDist * ringDist > d2) break;
            if (!cellsMode && ring > 1) break;
            for (let oy = -ring; oy <= ring; oy++) {
              const cy = gy + oy; if (cy < 0 || cy >= gh) continue;
              const edge = oy === -ring || oy === ring;
              for (let ox = -ring; ox <= ring; ox += edge ? 1 : 2 * ring || 1) {
                const cxx = gx + ox; if (cxx < 0 || cxx >= gw) continue;
                for (let a = head[cy * gw + cxx]; a !== -1; a = next[a]) {
                  const dx = x - sx[a], dy = y - sy[a], d = dx * dx + dy * dy;
                  if (d < d1) { d2 = d1; d1 = d; b1 = a; } else if (d < d2) d2 = d;
                }
                if (ring === 0) break;
              }
            }
          }
          if (b1 < 0) continue;
          const o = y * W + x;
          labels[o] = b1;
          const r1 = Math.sqrt(d1), ed = Math.sqrt(d2) - r1;
          r1s[o] = r1; edges[o] = ed;
          if (ed < 1.5 && r1 < inR[b1]) inR[b1] = r1;
          const bb = b1 * 4;
          if (x < bbox[bb]) bbox[bb] = x; if (y < bbox[bb + 1]) bbox[bb + 1] = y; if (x > bbox[bb + 2]) bbox[bb + 2] = x; if (y > bbox[bb + 3]) bbox[bb + 3] = y;
        }
      }
      // pass 2: colour
      const img = new ImageData(W, H), px = img.data;
      const k = Math.max(1, an.k);
      const rgb = []; for (let c = 0; c < k; c++) rgb.push(SP.clusterRGB(c, k));
      let lo = Infinity, hi = -Infinity;
      for (const i of act) { lo = Math.min(lo, an.rmsDb[i]); hi = Math.max(hi, an.rmsDb[i]); }
      const SB = an.specBands;
      for (let a = 0; a < act.length; a++) if (!isFinite(inR[a]) || inR[a] > 1e8) inR[a] = spacing * 0.5;
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const o = y * W + x, b1 = labels[o];
        if (b1 < 0) continue;
        const i = act[b1], c = an.cluster[i];
        const r1 = r1s[o], edge = edges[o];
        const loud = hi > lo ? (an.rmsDb[i] - lo) / (hi - lo) : 1;
        const cellR = Math.max(3, Math.min(inR[b1], spacing * 1.1));
        let shade = 0.38 + 0.5 * loud;
        // radial spectrum glyph: low bands at the top, going clockwise
        const th = Math.atan2(x - sx[b1], -(y - sy[b1]));
        let band = Math.floor(((th + Math.PI * 2) % (Math.PI * 2)) / (Math.PI * 2) * SB);
        if (band >= SB) band = SB - 1;
        const sv = an.spec[i * SB + band];
        const glyphR = cellR * (0.2 + 0.75 * sv);
        let whiten = 0;
        if (r1 < glyphR) whiten = 0.32 + 0.25 * (1 - r1 / glyphR);
        shade *= 1 - 0.25 * Math.min(1, r1 / (cellR * 1.6));
        let a8 = 255;
        if (!cellsMode && r1 > Rmax * 0.86) a8 = Math.max(0, 255 * (1 - (r1 - Rmax * 0.86) / (Rmax * 0.14)));
        let R = rgb[c][0] * shade, G = rgb[c][1] * shade, B = rgb[c][2] * shade;
        R += (255 - R) * whiten * shade; G += (255 - G) * whiten * shade; B += (255 - B) * whiten * shade;
        if (edge < 1.6) { const e = 0.2 + 0.5 * (edge / 1.6); R *= e; G *= e; B *= e; }
        const p4 = o * 4;
        px[p4] = R; px[p4 + 1] = G; px[p4 + 2] = B; px[p4 + 3] = a8;
      }
      this.labels = labels; this.bbox = bbox; this.sx = sx; this.sy = sy; this.inR = inR;
      const tmp = document.createElement('canvas'); tmp.width = W; tmp.height = H;
      tmp.getContext('2d').putImageData(img, 0, 0);
      bx.save(); bx.scale(dpr, dpr);
      this.drawSilk(bx, an, geo, true);
      bx.imageSmoothingEnabled = true; bx.drawImage(tmp, 0, 0, W, H);
      this.drawSilk(bx, an, geo, false);
      bx.restore();
    }

    drawSilk(g, an, geo, under) {
      g.lineCap = 'round';
      if (an.layout === 'cells') return;
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
        if (!under) {
          g.strokeStyle = 'rgba(223,231,242,0.35)'; g.lineWidth = 1.2; g.beginPath();
          for (const s of an.sectors) { g.moveTo(cx + R * 0.08 * Math.cos(s.a0), cy + R * 0.08 * Math.sin(s.a0)); g.lineTo(cx + R * 1.02 * Math.cos(s.a0), cy + R * 1.02 * Math.sin(s.a0)); }
          g.stroke();
        }
      } else if (under) {
        g.strokeStyle = 'rgba(223,231,242,0.05)'; g.lineWidth = 1; g.beginPath();
        const step = 40;
        for (let x = geo.ox; x < geo.ox + an.aspect * geo.sc; x += step) { g.moveTo(x, geo.oy); g.lineTo(x, geo.oy + geo.sc); }
        for (let y = geo.oy; y < geo.oy + geo.sc; y += step) { g.moveTo(geo.ox, y); g.lineTo(geo.ox + an.aspect * geo.sc, y); }
        g.stroke();
      }
      if (!under) {
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
      const L = this.labels, W = this.W;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        const gx = x0 + x, gy = y0 + y;
        if (L[gy * W + gx] !== a) continue;
        const o = (y * w + x) * 4;
        const edge = gx === 0 || gy === 0 || gx >= W - 1 || gy >= this.H - 1 || L[gy * W + gx - 1] !== a || L[gy * W + gx + 1] !== a || L[(gy - 1) * W + gx] !== a || L[(gy + 1) * W + gx] !== a;
        d[o] = 255; d[o + 1] = 255; d[o + 2] = 255; d[o + 3] = edge ? 255 : 70;
      }
      g.putImageData(img, 0, 0);
      m = { c, x0, y0 };
      if (this.masks.size > 120) this.masks.delete(this.masks.keys().next().value);
      this.masks.set(a, m);
      return m;
    }
    actIndex(frame) { if (!this.act || frame < 0) return -1; let lo = 0, hi = this.act.length - 1; while (lo <= hi) { const m = (lo + hi) >> 1; if (this.act[m] === frame) return m; if (this.act[m] < frame) lo = m + 1; else hi = m - 1; } return -1; }
    nearestAct(px, py) {
      if (!this.act || !this.act.length) return -1;
      let best = -1, bd = Infinity;
      for (let a = 0; a < this.act.length; a++) { const dx = px - this.sx[a], dy = py - this.sy[a], d = dx * dx + dy * dy; if (d < bd) { bd = d; best = a; } }
      return best;
    }

    // ---------- per-frame drawing ----------
    draw() {
      if (this.dirty) this.rebuild();
      const cv = this.cv, g = cv.getContext('2d'), dpr = this.dpr;
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.base, 0, 0);
      const an = this.an, app = this.app;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (an && !an.n && this.manual) {
        g.fillStyle = '#8f9ab0'; g.font = '14px -apple-system, Segoe UI, sans-serif'; g.textAlign = 'center';
        g.fillText('Manual cells: drag along the strip below to cut a cell from the sound.', this.W / 2, this.H / 2);
        g.textAlign = 'left';
      }
      if (an && this.labels) {
        const now = app.engine.audibleTime();
        if (this.highlightCluster >= 0) {
          g.fillStyle = 'rgba(7,8,11,0.55)'; g.fillRect(0, 0, this.W, this.H);
          for (let a = 0; a < this.act.length; a++) if (an.cluster[this.act[a]] === this.highlightCluster) { const m = this.mask(a); if (m) { g.globalAlpha = 0.6; g.drawImage(m.c, m.x0, m.y0); } }
          g.globalAlpha = 1;
        }
        // cells with their own edits get a small ring
        const smp = this.sample;
        if (smp && smp.cells) {
          g.strokeStyle = '#fff'; g.lineWidth = 1.5;
          for (const k of Object.keys(smp.cells)) {
            const a = this.actIndex(+k); if (a < 0) continue;
            const r = Math.max(4, Math.min(10, this.inR[a] * 0.55));
            g.beginPath(); g.arc(this.sx[a], this.sy[a], r, 0, Math.PI * 2); g.stroke();
            g.fillStyle = '#ff5c8a'; g.beginPath(); g.arc(this.sx[a] + r * 0.7, this.sy[a] - r * 0.7, 2.6, 0, Math.PI * 2); g.fill();
          }
        }
        // pad labels for the selected track
        const tr = app.selTrack();
        if (tr) {
          g.textAlign = 'center'; g.textBaseline = 'middle';
          if (tr.playMode === 'pads') {
            tr.pads.forEach((p, kk) => {
              if (!p || p.sampleId !== this.sid) return;
              const a = this.actIndex(p.frame); if (a < 0) return;
              const fs = Math.max(8, Math.min(13, this.inR[a] * 0.6));
              g.font = `800 ${fs}px -apple-system, Segoe UI, sans-serif`;
              const x = this.sx[a], y = this.sy[a];
              g.fillStyle = 'rgba(7,8,11,0.75)'; g.beginPath(); g.arc(x, y, fs * 0.85, 0, Math.PI * 2); g.fill();
              g.fillStyle = '#fff'; g.fillText(SP.KEYS[kk].label, x, y + 0.5);
            });
          } else if (tr.melodic && tr.melodic.sampleId === this.sid) {
            const a = this.actIndex(tr.melodic.frame);
            if (a >= 0) { const x = this.sx[a], y = this.sy[a]; g.font = '800 13px -apple-system, Segoe UI, sans-serif'; g.fillStyle = 'rgba(7,8,11,0.75)'; g.beginPath(); g.arc(x, y, 12, 0, Math.PI * 2); g.fill(); g.fillStyle = '#6ee7ff'; g.fillText('♪', x, y + 0.5); }
          }
        }
        const sel = app.selFrame;
        if (sel && sel.sampleId === this.sid) {
          const a = this.actIndex(sel.frame);
          if (a >= 0) { const m = this.mask(a); if (m) { g.globalAlpha = 0.9; g.drawImage(m.c, m.x0, m.y0); g.globalAlpha = 1; } }
        }
        if (this.hover >= 0 && !this.down) { const m = this.mask(this.hover); if (m) { g.globalAlpha = 0.55; g.drawImage(m.c, m.x0, m.y0); g.globalAlpha = 1; } }
        // spectral voice: show the blend under the pointer
        const sp = app.spectralPointer;
        if (sp && sp.sid === this.sid && this.geo) {
          for (const [s0, s1, w] of sp.sources) {
            const f = app.frameAt(this.sid, (s0 + s1) / 2), a = this.actIndex(f);
            if (a < 0) continue;
            const m = this.mask(a); if (m) { g.globalAlpha = 0.25 + 0.75 * w; g.drawImage(m.c, m.x0, m.y0); }
          }
          g.globalAlpha = 1;
          const x = this.geo.ox + sp.x * this.geo.sc, y = this.geo.oy + sp.y * this.geo.sc;
          const grd = g.createRadialGradient(x, y, 0, x, y, 26);
          grd.addColorStop(0, 'rgba(255,255,255,0.9)'); grd.addColorStop(0.25, 'rgba(255,255,255,0.35)'); grd.addColorStop(1, 'rgba(255,255,255,0)');
          g.fillStyle = grd; g.beginPath(); g.arc(x, y, 26, 0, Math.PI * 2); g.fill();
          g.strokeStyle = '#fff'; g.lineWidth = 1.5; g.beginPath(); g.arc(x, y, 7, 0, Math.PI * 2); g.stroke();
        }
        // playing frames light up
        for (const h of app.engine.hits) {
          if (h.sampleId !== this.sid) continue;
          const age = now - h.time;
          if (age < -0.02 || age > h.dur + 0.5) continue;
          const f = h.frame != null && h.frame >= 0 ? h.frame : app.frameAt(this.sid, h.start + 1e-4);
          const a = this.actIndex(f); if (a < 0) continue;
          const life = age < h.dur ? 1 : Math.max(0, 1 - (age - h.dur) / 0.5);
          const x = this.sx[a], y = this.sy[a];
          const r = Math.min(this.inR[a] * 1.6, this.spacing * 1.4) * (1.1 + 0.5 * (1 - life));
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
      const an = this.an, manual = this.manual, smp = this.sample;
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
            let col = '#3a4152';
            if (an.n) {
              while (fi < an.n - 1 && an.starts[fi + 1] <= t) fi++;
              const inside = !an.gaps || (t >= an.starts[fi] && t <= an.ends[fi]);
              const cl = an.cluster[fi];
              if (inside && cl >= 0) col = SP.clusterColor(cl, an.k);
              else if (manual) col = '#2e3442';
            }
            bx.fillStyle = col;
            const y0 = mid - hi * mid * 0.92, y1 = mid - lo * mid * 0.92;
            bx.fillRect(x, y0, 1, Math.max(1, y1 - y0));
          }
          bx.fillStyle = 'rgba(223,231,242,0.10)';
          if (!manual && an.n < W / 3) for (let i = 1; i < an.n; i++) bx.fillRect(Math.round(an.starts[i] / an.duration * W), 0, 1, H);
          // manual cells: outlined blocks with handles
          if (manual && smp && smp.regions) {
            for (const [a, b2] of smp.regions) {
              const x0 = a / an.duration * W, x1 = b2 / an.duration * W;
              bx.fillStyle = 'rgba(255,255,255,0.06)'; bx.fillRect(x0, 0, x1 - x0, H);
              bx.strokeStyle = 'rgba(223,231,242,0.7)'; bx.lineWidth = 1; bx.strokeRect(Math.round(x0) + 0.5, 1.5, Math.max(1, x1 - x0 - 1), H - 3);
              bx.fillStyle = '#dfe7f2'; bx.fillRect(x0 - 1, H / 2 - 7, 3, 14); bx.fillRect(x1 - 2, H / 2 - 7, 3, 14);
            }
            if (!smp.regions.length) { bx.fillStyle = '#8f9ab0'; bx.font = '12px -apple-system, Segoe UI, sans-serif'; bx.fillText('Drag here to cut a cell · drag a cell edge to resize · right-click a cell to edit or delete it', 12, 18); }
          }
        } else {
          bx.fillStyle = '#586178'; bx.font = '11px -apple-system, Segoe UI, sans-serif'; bx.fillText('The whole sound appears here, coloured by timbre group.', 12, H / 2 + 4);
        }
        // cells with edited bounds: show their new extent
        if (an && smp && smp.cells) {
          bx.strokeStyle = '#ff5c8a'; bx.lineWidth = 1.5;
          for (const ed of Object.values(smp.cells)) { const x0 = ed.start / an.duration * W, x1 = ed.end / an.duration * W; bx.strokeRect(x0 + 0.5, H - 6.5, Math.max(1, x1 - x0), 4); }
        }
      }
      g.setTransform(1, 0, 0, 1, 0, 0);
      g.drawImage(this.stripBase, 0, 0);
      if (!an) return;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      const xOf = t => t / an.duration * W;
      const band = (i, style) => { if (i < 0 || i >= an.n) return; const x0 = xOf(an.starts[i]), x1 = xOf(an.ends[i]); g.fillStyle = style; g.fillRect(x0, 0, Math.max(1.5, x1 - x0), H); };
      const sel = this.app.selFrame;
      if (sel && sel.sampleId === this.sid) band(sel.frame, 'rgba(255,255,255,0.22)');
      const hv = this.stripHover >= 0 ? this.stripHover : (this.hover >= 0 && this.act ? this.act[this.hover] : -1);
      if (hv >= 0) band(hv, 'rgba(255,255,255,0.14)');
      if (this.highlightCluster >= 0) for (let i = 0; i < an.n; i++) if (an.cluster[i] === this.highlightCluster) band(i, 'rgba(255,255,255,0.12)');
      const now = this.app.engine.audibleTime();
      for (const h of this.app.engine.hits) {
        if (h.sampleId !== this.sid) continue;
        const age = now - h.time; if (age < 0 || age > h.dur + 0.3) continue;
        const life = age < h.dur ? 1 : 1 - (age - h.dur) / 0.3;
        band(h.frame != null ? h.frame : this.app.frameAt(this.sid, h.start + 1e-4), `rgba(255,255,255,${0.45 * life})`);
      }
      const sd = this.stripDrag;
      if (sd && sd.mode === 'create') {
        const x0 = xOf(Math.min(sd.t0, sd.t1)), x1 = xOf(Math.max(sd.t0, sd.t1));
        g.fillStyle = 'rgba(255,92,138,0.25)'; g.fillRect(x0, 0, x1 - x0, H);
        g.strokeStyle = '#ff5c8a'; g.lineWidth = 1.5; g.strokeRect(x0 + 0.5, 1, x1 - x0, H - 2);
      }
    }

    // ---------- interaction ----------
    pointAt(e) { const r = this.cv.getBoundingClientRect(); return { px: e.clientX - r.left, py: e.clientY - r.top }; }
    labelAt(e) {
      if (!this.labels) return -1;
      const { px, py } = this.pointAt(e);
      const x = Math.floor(px), y = Math.floor(py);
      if (x < 0 || y < 0 || x >= this.W || y >= this.H) return -1;
      return this.labels[y * this.W + x];
    }
    showTip(e, a) {
      const an = this.an, tip = this.tip;
      if (a < 0 || !an || !this.act) { tip.style.display = 'none'; return; }
      const i = this.act[a];
      const ed = this.app.cellEdit(this.sid, i);
      tip.innerHTML = `cell ${i + 1} · ${an.starts[i].toFixed(2)}–${an.ends[i].toFixed(2)} s · group ${an.cluster[i] + 1} · ${an.rmsDb[i].toFixed(0)} dB${ed ? ' · edited' : ''}`;
      const r = this.cv.getBoundingClientRect();
      tip.style.display = 'block';
      tip.style.left = Math.min(r.width - tip.offsetWidth - 6, e.clientX - r.left + 14) + 'px';
      tip.style.top = (e.clientY - r.top + 14) + 'px';
    }
    bind() {
      const cv = this.cv, app = this.app;
      cv.addEventListener('pointermove', e => {
        let a = this.labelAt(e);
        if (this.down) {
          const r = cv.getBoundingClientRect();
          const inside = e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom;
          if (!inside) {
            if (!this.down.out) { this.down.out = true; app.noteOff('map'); }
            app.dragGhost(true, e, this.down.frame);
            return;
          }
          if (this.down.out) { this.down.out = false; app.dragGhost(false); }
          const { px, py } = this.pointAt(e);
          if (app.isSpectral() && !this.down.assign) {
            if (a < 0) a = this.nearestAct(px, py);
            if (a >= 0) { this.down.frame = this.act[a]; app.mapPress(this.sid, this.act[a], true, this.toLayout(px, py)); }
          } else if (a >= 0 && a !== this.down.a && !this.down.assign) {
            this.down.a = a; this.down.frame = this.act[a];
            app.mapPress(this.sid, this.act[a], true);
          }
        }
        if (a !== this.hover) this.hover = a;
        this.showTip(e, a);
      });
      cv.addEventListener('pointerleave', () => { if (!this.down) { this.hover = -1; this.tip.style.display = 'none'; } });
      cv.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        let a = this.labelAt(e);
        const { px, py } = this.pointAt(e);
        if (a < 0 && app.isSpectral()) a = this.nearestAct(px, py);
        if (a < 0) return;
        cv.setPointerCapture(e.pointerId);
        this.down = { a, frame: this.act[a], assign: app.assignMode };
        app.mapPress(this.sid, this.act[a], false, this.toLayout(px, py));
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
      cv.addEventListener('dblclick', e => {
        const a = this.labelAt(e); if (a < 0) return;
        SP.Panels.openCellEditor(this.sid, this.act[a]);
      });

      // ---- strip ----
      const st = this.st;
      const tAt = (e) => { const an = this.an; if (!an) return 0; const r = st.getBoundingClientRect(); return Math.max(0, Math.min(an.duration, (e.clientX - r.left) / r.width * an.duration)); };
      const frameAtX = (e) => this.an ? app.frameAt(this.sid, tAt(e)) : -1;
      const regionHit = (e) => {
        const smp = this.sample, an = this.an; if (!smp || !smp.regions || !an) return null;
        const r = st.getBoundingClientRect(), px = e.clientX - r.left, pxPerSec = r.width / an.duration;
        for (let i = 0; i < smp.regions.length; i++) {
          const [a, b] = smp.regions[i];
          const xa = a * pxPerSec, xb = b * pxPerSec;
          if (Math.abs(px - xa) <= 5) return { idx: i, edge: 0 };
          if (Math.abs(px - xb) <= 5) return { idx: i, edge: 1 };
          if (px > xa && px < xb) return { idx: i, edge: -1 };
        }
        return null;
      };
      let sdown = null;
      st.addEventListener('pointermove', e => {
        const f = frameAtX(e);
        this.stripHover = f;
        const sd = this.stripDrag;
        if (sd) {
          const t = tAt(e);
          if (sd.mode === 'create') sd.t1 = t;
          else if (sd.mode === 'resize') {
            const smp = this.sample, reg = smp.regions[sd.idx];
            const prev = sd.idx > 0 ? smp.regions[sd.idx - 1][1] : 0, next = sd.idx + 1 < smp.regions.length ? smp.regions[sd.idx + 1][0] : this.an.duration;
            if (sd.edge === 0) app.updateRegion(this.sid, sd.idx, Math.max(prev, Math.min(reg[1] - 0.01, t)), reg[1], false);
            else app.updateRegion(this.sid, sd.idx, reg[0], Math.min(next, Math.max(reg[0] + 0.01, t)), false);
          }
          return;
        }
        if (this.manual) { const h = regionHit(e); st.style.cursor = h ? (h.edge >= 0 ? 'ew-resize' : 'pointer') : 'crosshair'; }
        else st.style.cursor = 'pointer';
        if (sdown && f >= 0 && f !== sdown.f) { sdown.f = f; app.mapPress(this.sid, f, true); }
      });
      st.addEventListener('pointerleave', () => { this.stripHover = -1; });
      st.addEventListener('pointerdown', e => {
        if (e.button !== 0 || !this.an) return;
        st.setPointerCapture(e.pointerId);
        if (this.manual) {
          const h = regionHit(e);
          if (h && h.edge >= 0) { this.stripDrag = { mode: 'resize', idx: h.idx, edge: h.edge }; return; }
          if (!h) { const t = tAt(e); this.stripDrag = { mode: 'create', t0: t, t1: t }; return; }
        }
        const f = frameAtX(e); if (f < 0) return;
        sdown = { f };
        app.mapPress(this.sid, f, false);
      });
      const sup = () => {
        const sd = this.stripDrag; this.stripDrag = null;
        if (sd) {
          if (sd.mode === 'create') { if (Math.abs(sd.t1 - sd.t0) >= 0.01) app.addRegion(this.sid, sd.t0, sd.t1); }
          else if (sd.mode === 'resize') { const r = this.sample.regions[sd.idx]; app.updateRegion(this.sid, sd.idx, r[0], r[1], true); }
          return;
        }
        if (sdown) { sdown = null; app.noteOff('map'); }
      };
      st.addEventListener('pointerup', sup); st.addEventListener('pointercancel', sup);
      st.addEventListener('contextmenu', e => { e.preventDefault(); const f = frameAtX(e); if (f >= 0) app.frameMenu(e, this.sid, f); });
      st.addEventListener('dblclick', e => { const f = frameAtX(e); if (f >= 0) SP.Panels.openCellEditor(this.sid, f); });
    }
  }

  SP.MapView = MapView;
})();
