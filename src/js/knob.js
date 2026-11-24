// Spiders - rotary knob control (shared design with Orbit)
(function () {
  const SP = (window.Spiders = window.Spiders || {});
  const S = { toNorm: SP.toNorm, fromNorm: SP.fromNorm };
  const NS = 'http://www.w3.org/2000/svg';
  const A0 = -135, A1 = 135;

  function polar(cx, cy, r, deg) { const a = (deg - 90) * Math.PI / 180; return [cx + r * Math.cos(a), cy + r * Math.sin(a)]; }
  function arc(cx, cy, r, d0, d1) {
    if (d1 < d0) [d0, d1] = [d1, d0];
    const [x0, y0] = polar(cx, cy, r, d0), [x1, y1] = polar(cx, cy, r, d1);
    const large = d1 - d0 > 180 ? 1 : 0;
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${large} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  /**
   * opts: { key, def (param def), get(): value, set(v), commit(), color }
   */
  class Knob {
    constructor(opts) {
      this.o = opts; this.def = opts.def;
      const el = (this.el = document.createElement('div'));
      el.className = 'knob';
      el.title = this.def.label + ' — drag, scroll, double-click to reset (Shift = fine)';
      el.innerHTML = `<div class="k-label">${this.def.label}</div>`;
      const svg = document.createElementNS(NS, 'svg'); svg.setAttribute('viewBox', '0 0 40 40');
      this.track = document.createElementNS(NS, 'path'); this.track.setAttribute('d', arc(20, 20, 15, A0, A1));
      this.track.setAttribute('stroke', '#232a36'); this.track.setAttribute('stroke-width', '3.5'); this.track.setAttribute('fill', 'none'); this.track.setAttribute('stroke-linecap', 'round');
      this.val = document.createElementNS(NS, 'path');
      this.val.setAttribute('stroke', opts.color || '#ff5c8a'); this.val.setAttribute('stroke-width', '3.5'); this.val.setAttribute('fill', 'none'); this.val.setAttribute('stroke-linecap', 'round');
      const cap = document.createElementNS(NS, 'circle'); cap.setAttribute('cx', 20); cap.setAttribute('cy', 20); cap.setAttribute('r', 10.5); cap.setAttribute('fill', '#161b24'); cap.setAttribute('stroke', '#2e3646');
      this.ptr = document.createElementNS(NS, 'line'); this.ptr.setAttribute('stroke', '#e7ecf3'); this.ptr.setAttribute('stroke-width', '2'); this.ptr.setAttribute('stroke-linecap', 'round');
      svg.append(this.track, this.val, cap, this.ptr);
      el.appendChild(svg);
      this.text = document.createElement('div'); this.text.className = 'k-val'; el.appendChild(this.text);
      this.bind();
      this.render();
    }

    bind() {
      const el = this.el;
      let startY = 0, startN = 0, dragging = false;
      el.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault();
        el.setPointerCapture(e.pointerId);
        dragging = true; el.classList.add('dragging');
        startY = e.clientY; startN = S.toNorm(this.def, this.o.get());
        this._moved = false;
      });
      el.addEventListener('pointermove', e => {
        if (!dragging) return;
        const sens = e.shiftKey ? 900 : 180;
        const n = startN + (startY - e.clientY) / sens;
        const v = S.fromNorm(this.def, n);
        if (v !== this.o.get()) { this.o.set(v); this._moved = true; this.render(); }
        if (e.shiftKey) { startN = S.toNorm(this.def, this.o.get()); startY = e.clientY; }
      });
      const end = () => {
        if (!dragging) return;
        dragging = false; el.classList.remove('dragging');
        if (this._moved && this.o.commit) this.o.commit();
      };
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
      el.addEventListener('dblclick', () => { this.o.set(this.def.def); this.render(); if (this.o.commit) this.o.commit(); });
      el.addEventListener('wheel', e => {
        e.preventDefault();
        const n = S.toNorm(this.def, this.o.get()) - Math.sign(e.deltaY) * (e.shiftKey ? 0.005 : 0.025);
        let v = S.fromNorm(this.def, n);
        if (this.def.step && v === this.o.get()) v = Math.min(this.def.max, Math.max(this.def.min, v - Math.sign(e.deltaY) * this.def.step));
        this.o.set(v); this.render();
        clearTimeout(this._wt); this._wt = setTimeout(() => this.o.commit && this.o.commit(), 350);
      }, { passive: false });
    }

    render() {
      const v = this.o.get();
      const n = S.toNorm(this.def, v);
      const deg = A0 + (A1 - A0) * n;
      const bipolar = this.def.min < 0 && this.def.max > 0;
      const from = bipolar ? A0 + (A1 - A0) * S.toNorm(this.def, 0) : A0;
      this.val.setAttribute('d', Math.abs(deg - from) < 0.5 ? '' : arc(20, 20, 15, from, deg));
      const [x0, y0] = polar(20, 20, 3, deg), [x1, y1] = polar(20, 20, 9, deg);
      this.ptr.setAttribute('x1', x0); this.ptr.setAttribute('y1', y0); this.ptr.setAttribute('x2', x1); this.ptr.setAttribute('y2', y1);
      this.text.textContent = this.def.fmt ? this.def.fmt(v) : v.toFixed(2);
    }

    setInherited(on) { this.el.classList.toggle('inherit', !!on); }
  }

  SP.Knob = Knob;
})();
