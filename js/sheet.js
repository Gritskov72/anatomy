// Карточка снизу с тремя положениями: кратко, половина, весь экран
import { $ } from './ui.js';

export class Sheet {
  constructor({ onChange, onDismiss }) {
    this.el = $('#sheet');
    this.grab = $('#sheet-grab');
    this.head = $('#sheet-head');
    this.controls = $('#sheet-controls');
    this.body = $('#sheet-body');
    this.onChange = onChange; this.onDismiss = onDismiss;
    this.open = false; this.detent = 'peek'; this.h = 0;
    this._drag();
    window.addEventListener('resize', () => { if (this.open) this.setDetent(this.detent, false); });
  }

  heights() {
    const avail = this.el.parentElement.clientHeight - this.bottomOffset();
    const peek = Math.min(this.grab.offsetHeight + this.controls.offsetHeight + 2, avail * 0.6);
    const topGap = (parseFloat(getComputedStyle($('#hud-top')).paddingTop) || 8) + 52;
    const full = Math.max(peek + 40, avail - topGap);
    const half = Math.max(peek + 40, Math.min(full, Math.round(avail * 0.56)));
    return { peek, half, full };
  }

  bottomOffset() { return parseFloat(getComputedStyle(this.el).bottom) || 0; }

  show(detent = 'peek') {
    this.open = true;
    this.el.setAttribute('aria-hidden', 'false');
    this.el.classList.add('on');
    this.setDetent(detent);
  }

  hide() {
    if (!this.open) return;
    this.open = false;
    this.el.classList.remove('on');
    this.el.setAttribute('aria-hidden', 'true');
    this.el.style.height = '0px';
    this.h = 0;
    this.onChange?.();
  }

  setDetent(detent, animate = true) {
    this.detent = detent;
    const h = this.heights()[detent];
    this.el.classList.toggle('no-anim', !animate);
    this.el.dataset.detent = detent;
    this.el.style.height = `${h}px`;
    this.h = h;
    if (detent === 'peek') this.body.scrollTop = 0;
    this.onChange?.();
  }

  /** Пересчитать высоту после смены содержимого. */
  refresh() { if (this.open) requestAnimationFrame(() => this.open && this.setDetent(this.detent)); }

  _drag() {
    let st = null;
    const start = (e) => {
      if (e.target.closest('button, a, input')) return;
      st = { y: e.clientY, h: this.h, t: performance.now(), moved: false, lastY: e.clientY, lastT: performance.now(), v: 0 };
      this.grab.setPointerCapture?.(e.pointerId);
    };
    const move = (e) => {
      if (!st) return;
      const dy = e.clientY - st.y;
      if (!st.moved && Math.abs(dy) < 5) return;
      st.moved = true;
      const now = performance.now();
      st.v = (e.clientY - st.lastY) / Math.max(1, now - st.lastT); st.lastY = e.clientY; st.lastT = now;
      const { peek, full } = this.heights();
      const h = Math.max(peek * 0.35, Math.min(full + 12, st.h - dy));
      this.el.classList.add('no-anim');
      this.el.style.height = `${h}px`; this.h = h;
    };
    const end = () => {
      if (!st) return;
      const s = st; st = null;
      this.el.classList.remove('no-anim');
      const hs = this.heights();
      if (!s.moved) { this.setDetent(this.detent === 'peek' ? 'half' : 'peek'); return; }
      if (this.h < hs.peek * 0.72 || (this.detent === 'peek' && s.v > 0.7)) { this.onDismiss?.(); return; }
      const order = ['peek', 'half', 'full'];
      let best = order.reduce((a, b) => (Math.abs(hs[b] - this.h) < Math.abs(hs[a] - this.h) ? b : a));
      if (Math.abs(s.v) > 0.45) {
        const i = order.indexOf(this.detent);
        best = order[Math.max(0, Math.min(2, i + (s.v < 0 ? 1 : -1)))];
      }
      this.setDetent(best);
    };
    this.grab.addEventListener('pointerdown', start);
    this.grab.addEventListener('pointermove', move);
    this.grab.addEventListener('pointerup', end);
    this.grab.addEventListener('pointercancel', end);
  }
}
