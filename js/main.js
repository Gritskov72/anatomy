// Главный модуль: состояние вида, история шагов, связь сцены, карточки и вкладок
import { loadDataset, SPINE_SECTION_NAMES } from './data.js';
import { Viewer } from './viewer.js';
import { $, $$, esc, store, toast, openMenu, SIDE_FULL } from './ui.js';
import { icon } from './icons.js';
import { Sheet } from './sheet.js';
import { CatalogPanel, SearchPanel, MovesPanel, AboutPanel, fmtMB, itemRows } from './panels.js';

const FIELDS = [
  ['origin', 'Начало'], ['insertion', 'Прикрепление'], ['action', 'Функция'], ['innervation', 'Иннервация'], ['blood', 'Кровоснабжение'],
  ['parts', 'Части и ориентиры'], ['articulations', 'Сочленения'],
  ['type', 'Тип сустава'], ['surfaces', 'Суставные поверхности'], ['ligaments', 'Связки'], ['motions', 'Движения'],
  ['source', 'Откуда отходит'], ['branches', 'Ветви и притоки'], ['supplies', 'Что снабжает'],
];
const VIEWS = [['front', 'Спереди'], ['back', 'Сзади'], ['left', 'Слева'], ['right', 'Справа'], ['top', 'Сверху'], ['bottom', 'Снизу']];
const HISTORY_MAX = 60;
const CHIP_NAMES = { bones: 'Кости', joints: 'Суставы', muscles: 'Мышцы', fascia: 'Фасции', nerves: 'Нервы', vessels: 'Сосуды', organs: 'Органы' };

class App {
  constructor(data) {
    this.data = data;
    const saved = (store.get('systems', null) || []).filter((id) => data.systemById.has(id));
    const first = data.systemById.has('bones') ? 'bones' : data.systems[0]?.id;
    this.s = {
      systems: new Set(saved.length ? saved : [first]), region: null,
      hidden: new Set(), pinned: new Set(), isolated: null, isoLabel: '', isoGroup: null, fade: false, selected: null,
      mode: 'atlas', lineId: null, lineSide: 0, spineId: null, spineContext: false, moveId: null, moveSide: 0, angle: 0,
    };
    this.history = []; this.tab = 'atlas'; this.sheetKey = null; this.playing = false; this.modeReturn = null;
  }

  init() {
    this.icons();
    this.viewer = new Viewer($('#scene'), this.data, {
      onTap: (id) => this.onTap(id), onDoubleTap: (id) => this.onDoubleTap(id),
      onProgress: (p) => this.onProgress(p),
      onError: () => { clearTimeout(this._errT); this._errT = setTimeout(() => toast('Часть моделей не загрузилась. Проверьте сеть'), 300); },
    });
    this.sheet = new Sheet({ onChange: () => this.updateInsets(), onDismiss: () => this.closeSheet() });
    this.catalog = new CatalogPanel(this); this.search = new SearchPanel(this);
    this.moves = new MovesPanel(this); this.about = new AboutPanel(this);
    this.loadAssistant();
    this.bind();
    this.setTheme(store.get('theme', 'dark'), false);
    this.sync();
    this.updateInsets(); this.viewer.snapInsets();
    this.viewer.fitVisible({ animate: false, dir: [0.42, 0.1, 1] });
    window.addEventListener('online', () => { this.viewer.retryFailed(); this.sync(); });
    requestAnimationFrame(() => { const b = $('#boot'); b.classList.add('done'); setTimeout(() => b.remove(), 500); });
  }

  icons() {
    $('#btn-back').innerHTML = icon('back'); $('#btn-spine').innerHTML = icon('spine'); $('#btn-more').innerHTML = icon('more');
    $('#btn-region .ic-chev').outerHTML = icon('chevD', 16); $('#btn-mode-exit .ic-x').outerHTML = icon('x', 16);
    const names = { atlas: 'atlas', catalog: 'catalog', moves: 'moves', search: 'search', assistant: 'assistant' };
    for (const t of $$('#tabbar .tab')) t.querySelector('i').outerHTML = icon(names[t.dataset.tab], 24);
  }

  /** Ассистент грузится отдельно: если его модуль не загрузится, остальные вкладки работают как прежде. */
  loadAssistant() {
    import('./assistant/panel.js')
      .then(({ AssistantPanel }) => { this.assistant = new AssistantPanel(this); if (this.tab === 'assistant') this.setTab('assistant'); })
      .catch((err) => {
        console.error('Ассистент не загрузился', err);
        const t = $('#tabbar .tab[data-tab="assistant"]');
        if (t) t.hidden = true;
        $('#tabbar').classList.add('four');
        if (this.tab === 'assistant') this.setTab('atlas');
      });
  }

  // ---------- видимость ----------
  baseVisible(item) {
    const s = this.s;
    return s.pinned.has(item.id) || (s.systems.has(item.system) && (!s.region || item.region === s.region) && !item.defaultHidden);
  }

  roleOf = (item) => {
    const s = this.s, id = item.id;
    if (s.mode === 'spine') {
      if (id === s.spineId) return 'normal';
      return s.spineContext && this.data.spineIds.has(id) ? 'faded' : null;
    }
    if (s.mode === 'move') {
      const r = this.moveRoles;
      if (r.ag.has(id)) return 'agonist';
      if (r.an.has(id)) return 'antagonist';
      if (r.mv.has(id)) return item.system === 'bones' ? 'normal' : 'faded';
      return item.system === 'bones' && !item.defaultHidden && s.systems.has('bones') ? 'normal' : null;
    }
    if (s.lineId && s.isolated) {
      if (s.isolated.has(id)) return id === s.selected ? 'selected' : 'normal';
      return item.system === 'bones' && !item.defaultHidden ? 'faded' : null;
    }
    if (s.hidden.has(id)) return null;
    if (s.isolated) return s.isolated.has(id) ? (id === s.selected && s.isolated.size > 1 ? 'selected' : 'normal') : null;
    if (!this.baseVisible(item)) return null;
    if (id === s.selected) return 'selected';
    return s.fade && s.selected ? 'faded' : 'normal';
  };

  // ---------- история ----------
  snapshot() {
    const s = this.s;
    return { ...s, systems: [...s.systems], hidden: [...s.hidden], pinned: [...s.pinned], isolated: s.isolated ? [...s.isolated] : null, cam: this.viewer.getPose() };
  }

  restore(snap) {
    const { cam, ...rest } = snap;
    this.s = { ...rest, systems: new Set(rest.systems), hidden: new Set(rest.hidden), pinned: new Set(rest.pinned), isolated: rest.isolated ? new Set(rest.isolated) : null };
  }

  /** Шаг с записью в историю. */
  act(fn) {
    this.history.push(this.snapshot());
    if (this.history.length > HISTORY_MAX) this.history.shift();
    fn(this.s);
    this.sync();
  }

  back() {
    const snap = this.history.pop();
    if (!snap) return;
    this.stopPlay();
    this.restore(snap);
    this.sync();
    this.viewer.setPose(snap.cam);
  }

  // ---------- синхронизация вида ----------
  sync() {
    const s = this.s, d = this.data;
    if (!s.isolated) { s.isoGroup = null; s.isoLabel = ''; s.lineId = null; }
    const mv = s.mode === 'move' ? this.currentMove() : null;
    this.moveRoles = mv ? { ag: new Set(mv.agonists), an: new Set(mv.antagonists), mv: new Set(mv.moving) } : null;
    this.viewer.apply(this.roleOf);
    this.viewer.setMovement(mv, s.angle);

    const app = $('#app');
    app.dataset.mode = s.mode;
    $('#btn-back').hidden = !this.history.length;
    $('#region-label').textContent = s.region ? d.regionById.get(s.region)?.ru || 'Область' : 'Всё тело';
    const modeLabel = s.mode === 'spine' ? 'Позвоночник' : s.mode === 'move' ? 'Движение' : s.isolated ? (s.isoLabel || 'Изоляция') : '';
    $('#btn-mode-exit').hidden = !modeLabel; $('#mode-label').textContent = modeLabel;
    $('#btn-region').hidden = s.mode !== 'atlas' || !!s.isolated;
    $('#btn-spine').hidden = s.mode !== 'atlas';
    this.renderChips();
    this.renderRail();
    this.renderSheet();
    store.set('systems', [...s.systems]);
    requestAnimationFrame(() => this.updateInsets());
  }

  renderChips() {
    const el = $('#system-chips'), s = this.s;
    el.hidden = s.mode !== 'atlas' || !!s.isolated;
    el.innerHTML = this.data.systems.map((sys) => `<button class="chip${s.systems.has(sys.id) ? ' on' : ''}${this.loadingSystems?.has(sys.id) ? ' loading' : ''}" data-sys="${sys.id}" aria-pressed="${s.systems.has(sys.id)}"><i style="--c:${esc(sys.color)}"></i>${esc(CHIP_NAMES[sys.id] || sys.ru)}</button>`).join('');
  }

  onProgress(p) {
    this.loadingSystems = new Set(p.systems);
    for (const c of $$('#system-chips .chip')) c.classList.toggle('loading', this.loadingSystems.has(c.dataset.sys));
    const el = $('#loader');
    clearTimeout(this._loaderT);
    if (!p.busy) { el.classList.remove('on'); this._loaderT = setTimeout(() => { el.hidden = true; }, 300); return; }
    el.hidden = false; requestAnimationFrame(() => el.classList.add('on'));
    const k = p.total ? Math.min(1, p.loaded / p.total) : 0;
    el.querySelector('i').style.width = `${Math.max(4, k * 100)}%`;
    const names = p.systems.map((id) => (CHIP_NAMES[id] || this.data.systemById.get(id)?.ru || '').toLowerCase()).filter(Boolean).join(', ');
    $('#loader-text').textContent = `Загрузка: ${names}${p.total ? ` · ${fmtMB(p.total)}` : ''}`;
  }

  updateInsets() {
    const H = window.innerHeight;
    const top = $('#hud-top').getBoundingClientRect().bottom;
    let bottom = H - $('#tabbar').getBoundingClientRect().top;
    if (this.sheet.open) bottom = Math.min(this.sheet.bottomOffset() + this.sheet.h, H * 0.46);
    $('#app').style.setProperty('--free-bottom', `${Math.round(bottom)}px`);
    $('#app').dataset.sheet = this.sheet.open ? this.sheet.detent : '';
    this.viewer.setInsets(this.tab === 'atlas' ? top : 0, bottom, this.s.mode === 'spine' ? 70 : 0);
  }

  // ---------- действия со структурой ----------
  item(id) { return this.data.itemById.get(id); }

  select(id, { focus = false } = {}) {
    const item = this.item(id); if (!item) return;
    this.act((s) => {
      s.selected = id; s.hidden.delete(id);
      if (s.isolated && !s.isolated.has(id)) { s.isolated = null; s.lineId = null; }
      if (!this.baseVisible(item)) s.pinned.add(id);
    });
    this.pushRecent(id);
    if (focus) this.viewer.focus([id]);
  }

  deselect() { if (this.s.selected) this.act((s) => { s.selected = null; }); }

  toggleSystem(id) { this.act((s) => { if (s.systems.has(id)) s.systems.delete(id); else s.systems.add(id); }); }

  setRegion(id) {
    if (this.s.region === id) return;
    this.act((s) => { s.region = id; if (s.selected && !this.baseVisible(this.item(s.selected))) s.selected = null; });
    this.viewer.fitVisible();
  }

  isolate() {
    const s = this.s;
    if (s.isolated) { this.act((x) => { x.isolated = null; x.isoLabel = ''; x.lineId = null; }); this.viewer.fitVisible(); return; }
    if (!s.selected) return;
    const id = s.selected;
    this.act((x) => { x.isolated = new Set([id]); x.isoLabel = ''; x.isoGroup = null; x.lineId = null; x.fade = false; });
    this.viewer.focus([id]);
  }

  hide() {
    const id = this.s.selected; if (!id) return;
    this.act((s) => { s.hidden.add(id); s.pinned.delete(id); s.isolated?.delete(id); s.selected = null; });
    toast('Скрыто. Вернуть можно кнопкой «Назад»');
  }

  toggleFade() { this.act((s) => { s.fade = !s.fade; if (s.fade) s.isolated = null; }); }

  resetView() {
    this.stopPlay();
    this.act((s) => { s.hidden.clear(); s.pinned.clear(); s.isolated = null; s.isoLabel = ''; s.fade = false; s.selected = null; s.mode = 'atlas'; s.region = null; });
    this.viewer.fitVisible({ dir: [0.42, 0.1, 1] });
  }

  // ---------- переходы из других экранов ----------
  openItem(id) {
    const item = this.item(id); if (!item) return;
    this.setTab('atlas');
    if (this.s.mode === 'spine' && this.data.spineIds.has(id)) { this.spineGo(id); return; }
    this.stopPlay();
    this.act((s) => {
      s.mode = 'atlas'; s.selected = id; s.hidden.delete(id);
      if (s.isolated && !s.isolated.has(id)) { s.isolated = null; s.lineId = null; }
      if (!this.baseVisible(item)) s.pinned.add(id);
    });
    this.pushRecent(id);
    this.viewer.focus([id], { pad: 1.9 });
  }

  openGroup(id, system) {
    const g = this.data.groupById.get(id); if (!g) return;
    let items = this.data.groupItems(id);
    if (system && items.some((it) => it.system === system)) items = items.filter((it) => it.system === system);
    if (!items.length) return;
    this.setTab('atlas'); this.stopPlay();
    const ids = items.map((it) => it.id);
    this.act((s) => { s.mode = 'atlas'; s.isolated = new Set(ids); s.isoLabel = g.ru; s.isoGroup = id; s.lineId = null; s.selected = null; s.fade = false; for (const i of ids) s.hidden.delete(i); });
    this.viewer.focus(ids);
  }

  /** Миофасциальная линия: её структуры в цвете, скелет полупрозрачным фоном. */
  openLine(id, sideIndex = 0) {
    const line = this.data.lineById.get(id); if (!line) return;
    const v = line.variants[sideIndex] || line.variants[0];
    if (!v.ids.length) return;
    this.setTab('atlas'); this.stopPlay();
    this.act((s) => { s.mode = 'atlas'; s.isolated = new Set(v.ids); s.isoLabel = line.ru; s.isoGroup = null; s.lineId = id; s.lineSide = line.variants.indexOf(v); s.selected = null; s.fade = false; for (const i of v.ids) s.hidden.delete(i); });
    this.viewer.focus(v.ids, { dir: /задн|спирал/i.test(line.ru) ? [-0.5, 0.1, -1] : /латерал/i.test(line.ru) ? [1, 0.1, 0.25] : [0.42, 0.1, 1] });
  }

  openRegion(system, region) {
    this.setTab('atlas'); this.stopPlay();
    this.act((s) => { s.mode = 'atlas'; s.systems.add(system); s.region = region; s.isolated = null; s.selected = null; });
    this.viewer.fitVisible();
  }

  // ---------- позвоночник ----------
  enterSpine(id) {
    const d = this.data;
    if (!d.spine.length) { toast('В данных пока нет позвонков'); return; }
    const target = id && d.spineIds.has(id) ? id : d.spineIds.has(this.s.selected) ? this.s.selected : d.spine[0].item.id;
    const before = this.snapshot();
    this.stopPlay();
    this.act((s) => { if (s.mode === 'atlas') this.modeReturn = before; s.mode = 'spine'; s.spineId = target; s.selected = null; });
    this.viewer.focus([target], { dir: [0.6, 0.35, 1], pad: 1.08 });
  }

  spineGo(id) {
    if (!this.data.spineIds.has(id) || id === this.s.spineId) return;
    this.s.spineId = id;
    this.sync();
    this.viewer.focus([id], { pad: 1.08 });
  }

  spineStep(delta) {
    const list = this.data.spine, i = list.findIndex((v) => v.item.id === this.s.spineId);
    const next = list[i + delta];
    if (next) this.spineGo(next.item.id);
  }

  renderRail() {
    const el = $('#spine-rail'), s = this.s;
    el.hidden = s.mode !== 'spine';
    if (s.mode !== 'spine') return;
    if (!el.firstChild) {
      el.innerHTML = `<div class="rail-inner">${this.data.spine.map((v) => `<button class="rail-item sec-${v.section}" data-id="${esc(v.item.id)}" title="${esc(v.item.ru)}">${esc(v.label)}</button>`).join('')}</div>`;
    }
    let active = null;
    for (const b of $$('.rail-item', el)) { const on = b.dataset.id === s.spineId; b.classList.toggle('on', on); if (on) active = b; }
    active?.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }

  // ---------- движения ----------
  currentMove() {
    const base = this.data.movementById.get(this.s.moveId);
    return base ? base.variants[this.s.moveSide] || base : null;
  }

  openMovement(id, sideIndex = 0) {
    const base = this.data.movementById.get(id); if (!base) return;
    const mv = base.variants[sideIndex] || base;
    this.setTab('atlas'); this.stopPlay();
    const before = this.snapshot();
    this.act((s) => { if (s.mode === 'atlas') this.modeReturn = before; s.mode = 'move'; s.moveId = id; s.moveSide = base.variants.indexOf(mv); s.angle = mv.range[0]; s.selected = null; });
    this.focusMove(mv);
  }

  focusMove(mv) {
    const involved = [...new Set([...mv.moving, ...mv.agonists, ...mv.antagonists])];
    const p = mv.pivot, box = this.viewer.boxOf(mv.moving);
    let r = 0.12;
    if (!box.isEmpty()) for (const x of [box.min.x, box.max.x]) for (const y of [box.min.y, box.max.y]) for (const z of [box.min.z, box.max.z]) r = Math.max(r, Math.hypot(x - p[0], y - p[1], z - p[2]));
    const a = mv.axis.map(Math.abs), sx = p[0] >= 0 ? 1 : -1;
    const dir = a[0] >= a[1] && a[0] >= a[2] ? [sx, 0.12, 0.55] : a[2] >= a[1] ? [0.18 * sx, 0.1, 1] : [0.3 * sx, 0.75, 1];
    const extra = a[0] >= a[1] && a[0] >= a[2] ? [[p[0], p[1] + r, p[2]], [p[0], p[1] - r, p[2]], [p[0], p[1], p[2] + r], [p[0], p[1], p[2] - r]]
      : a[2] >= a[1] ? [[p[0] + r, p[1], p[2]], [p[0] - r, p[1], p[2]], [p[0], p[1] + r, p[2]], [p[0], p[1] - r, p[2]]]
        : [[p[0] + r, p[1], p[2]], [p[0] - r, p[1], p[2]], [p[0], p[1], p[2] + r], [p[0], p[1], p[2] - r]];
    this.viewer.focus(involved.length ? involved : mv.moving, { dir, extra, pad: 0.86 });
  }

  setAngle(deg, fromPlay = false) {
    this.s.angle = deg;
    this.viewer.setAngle(deg);
    const out = $('#mv-out'), range = $('#mv-range');
    if (out) out.textContent = `${Math.round(deg)}°`;
    if (range && fromPlay) range.value = deg;
    if (range) range.style.setProperty('--k', `${((deg - range.min) / Math.max(1, range.max - range.min)) * 100}%`);
  }

  togglePlay() { if (this.playing) this.stopPlay(); else this.startPlay(); }

  startPlay() {
    const mv = this.currentMove(); if (!mv) return;
    const [min, max] = mv.range, T = 2800;
    const k = Math.min(1, Math.max(0, (this.s.angle - min) / Math.max(1e-6, max - min)));
    const t0 = performance.now() - (Math.acos(1 - 2 * k) / (2 * Math.PI)) * T;
    this.playing = true;
    this.viewer.onFrame = (now) => {
      if (!this.playing) return false;
      const ph = ((now - t0) / T) * 2 * Math.PI;
      this.setAngle(min + (max - min) * (1 - Math.cos(ph)) / 2, true);
      return true;
    };
    this.viewer.requestRender();
    this.updatePlayBtn();
  }

  stopPlay() {
    if (!this.playing) return;
    this.playing = false; this.viewer.onFrame = null;
    this.updatePlayBtn();
  }

  updatePlayBtn() {
    const b = $('#sheet [data-act="play"]'); if (!b) return;
    b.innerHTML = icon(this.playing ? 'pause' : 'play', 24);
    b.setAttribute('aria-label', this.playing ? 'Пауза' : 'Воспроизвести');
  }

  exitMode() {
    const s = this.s;
    this.stopPlay();
    if (s.mode === 'atlas') { if (s.isolated) { this.act((x) => { x.isolated = null; x.isoLabel = ''; x.lineId = null; }); this.viewer.fitVisible(); } return; }
    const ret = this.modeReturn; this.modeReturn = null;
    this.act(() => {
      if (ret) this.restore(ret); else { this.s.mode = 'atlas'; this.s.selected = null; }
      this.s.mode = 'atlas';
    });
    if (ret?.cam) this.viewer.setPose(ret.cam); else this.viewer.fitVisible();
  }

  // ---------- жесты сцены ----------
  onTap(id) {
    const s = this.s;
    if (s.mode === 'spine') { if (id && id !== s.spineId && this.data.spineIds.has(id)) this.spineGo(id); return; }
    if (s.mode === 'move') { if (id) toast(this.item(id)?.ru || ''); return; }
    if (id) { if (id !== s.selected) this.select(id); } else this.deselect();
  }

  onDoubleTap(id) {
    const s = this.s;
    if (s.mode === 'spine') { this.viewer.focus([s.spineId], { pad: 1.08 }); return; }
    if (!id) { this.viewer.fitVisible(); return; }
    if (s.mode === 'atlas' && id !== s.selected) this.select(id);
    this.viewer.focus([id], { pad: 1.5 });
  }

  // ---------- карточка ----------
  closeSheet() {
    if (this.s.mode !== 'atlas' || (!this.s.selected && this.s.isolated)) this.exitMode(); else this.deselect();
  }

  renderSheet() {
    const s = this.s, d0 = this.data;
    const key = s.mode === 'move' ? `move:${s.moveId}:${s.moveSide}` : s.mode === 'spine' ? `spine:${s.spineId}` : s.selected ? `item:${s.selected}` : s.isolated && s.lineId ? `line:${s.lineId}:${s.lineSide}` : s.isolated && s.isoGroup ? `group:${s.isoGroup}` : null;
    if (!key) { this.sheetKey = null; this.sheet.hide(); return; }
    if (key !== this.sheetKey) {
      const wasOpen = this.sheet.open, sameKind = this.sheetKey?.split(':')[0] === key.split(':')[0];
      this.sheetKey = key;
      if (s.mode === 'move') this.buildMoveSheet(); else if (key.startsWith('line:')) this.buildLineSheet(d0.lineById.get(s.lineId)); else if (key.startsWith('group:')) this.buildGroupSheet(d0.groupById.get(s.isoGroup), key); else this.buildItemSheet(this.item(s.mode === 'spine' ? s.spineId : s.selected), key);
      this.sheet.body.scrollTop = 0;
      this.sheet.show(wasOpen && sameKind ? this.sheet.detent : 'peek');
      this.sheet.refresh();
    }
    this.updateSheetState();
  }

  updateSheetState() {
    const s = this.s, el = this.sheet.el;
    const set = (act, on, label) => { const b = el.querySelector(`[data-act="${act}"]`); if (!b) return; b.classList.toggle('on', !!on); if (label) b.querySelector('span').textContent = label; };
    set('isolate', s.isolated, s.isolated ? 'Показать всё' : 'Изолировать');
    set('fade', s.fade);
    set('spine-context', s.spineContext);
    const back = el.querySelector('[data-act="back"]'); if (back) back.disabled = !this.history.length;
    const fav = el.querySelector('[data-act="fav"]');
    if (fav) { const on = this.favs().includes(fav.dataset.id); fav.classList.toggle('on', on); fav.innerHTML = icon(on ? 'starFill' : 'star', 22); fav.setAttribute('aria-label', on ? 'Убрать из избранного' : 'В избранное'); }
    if (s.mode === 'spine') {
      const list = this.data.spine, i = list.findIndex((v) => v.item.id === s.spineId);
      const up = el.querySelector('[data-act="spine-up"]'), down = el.querySelector('[data-act="spine-down"]');
      if (up) up.disabled = i <= 0; if (down) down.disabled = i >= list.length - 1;
    }
  }

  crumbs(item) {
    const d = this.data, parts = [];
    const sys = d.systemById.get(item.system), reg = d.regionById.get(item.region);
    if (sys) parts.push(`<button data-act="crumb" data-system="${esc(sys.id)}">${esc(sys.ru)}</button>`);
    if (reg) parts.push(`<button data-act="crumb" data-system="${esc(item.system)}" data-region="${esc(reg.id)}">${esc(reg.ru)}</button>`);
    for (const g of d.groupPath(item.parent)) parts.push(`<button data-act="crumb" data-system="${esc(item.system)}" data-region="${esc(item.region || '')}" data-group="${esc(g.id)}">${esc(g.ru)}</button>`);
    return `<nav class="crumbs scroll" aria-label="Путь в каталоге">${parts.join(icon('chevR', 12))}</nav>`;
  }

  buildItemSheet(item, key) {
    const spine = this.s.mode === 'spine';
    this.sheet.head.innerHTML = `<div class="sheet-title"><h2>${esc(item.ru)}</h2>${item.lat || item.side ? `<p class="lat">${esc(item.lat || '')}${item.side ? `<span class="lat-side">${item.side === 'L' ? 'слева' : 'справа'}</span>` : ''}</p>` : ''}</div>
      <div class="sheet-btns"><button class="icon-btn" data-act="fav" data-id="${esc(item.id)}"></button><button class="icon-btn" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button></div>`;
    if (spine) {
      this.sheet.controls.innerHTML = `<div class="spine-ctl">
          <button class="btn" data-act="spine-up">${icon('up', 20)}<span>Выше</span></button>
          <button class="btn" data-act="spine-down">${icon('down', 20)}<span>Ниже</span></button>
          <button class="btn toggle" data-act="spine-context">${icon('layers', 20)}<span>В столбе</span></button></div>
        <div class="views scroll">${VIEWS.map(([id, ru]) => `<button class="chip plain" data-act="view" data-id="${id}">${ru}</button>`).join('')}</div>`;
    } else {
      this.sheet.controls.innerHTML = `${this.crumbs(item)}<div class="actions">
        <button data-act="isolate">${icon('isolate', 22)}<span>Изолировать</span></button>
        <button data-act="hide">${icon('hide', 22)}<span>Скрыть</span></button>
        <button data-act="fade">${icon('fade', 22)}<span>Прозрачность остального</span></button>
        <button data-act="back">${icon('back', 22)}<span>Назад</span></button></div>`;
    }
    this.sheet.body.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
    this.data.text(item).then((t) => {
      if (this.sheetKey !== key) return;
      this.sheet.body.innerHTML = this.textHtml(item, t, spine);
    });
  }

  textHtml(item, t, spine) {
    const d = this.data;
    const val = (v) => (Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p>${esc(v)}</p>`);
    let html = '';
    if (spine) { const v = d.spine.find((x) => x.item.id === item.id); if (v) html += `<p class="tagline">${esc(SPINE_SECTION_NAMES[v.section] || '')}</p>`; }
    if (t?.summary) html += `<p class="lead">${esc(t.summary)}</p>`;
    for (const [k, label] of FIELDS) { const v = t?.[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue; html += `<section class="fld"><h3>${label}</h3>${val(v)}</section>`; }
    if (t?.clinical) html += `<section class="fld clinical"><h3>Клиническое значение</h3>${val(t.clinical)}</section>`;
    if (!t) html += '<p class="note">Описание этой структуры пока не добавлено</p>';
    const tools = [`<button class="btn small" data-act="focus">${icon('focus', 18)}<span>Навести камеру</span></button>`];
    if (!spine && d.spineIds.has(item.id)) tools.push(`<button class="btn small" data-act="to-spine" data-id="${esc(item.id)}">${icon('spine', 18)}<span>Режим позвоночника</span></button>`);
    html += `<div class="tools">${tools.join('')}</div>`;
    const meta = [];
    if (item.ruAlt) meta.push(['Другое название', esc(item.ruAlt)]);
    if (item.en) meta.push(['Английское название', esc(item.en)]);
    if (item.side) meta.push(['Сторона', SIDE_FULL[item.side]]);
    const part = item.partOf && d.itemById.get(item.partOf);
    if (part) meta.push(['Часть структуры', `<button class="link" data-act="item" data-id="${esc(part.id)}">${esc(part.ru)}</button>`]);
    if (item.ta98) meta.push(['TA98', esc(item.ta98)]);
    if (item.fma) meta.push(['FMA', esc(String(item.fma).replace(/^FMA:?/i, ''))]);
    if (meta.length) html += `<dl class="meta">${meta.map(([k, v]) => `<div><dt>${k}</dt><dd>${v}</dd></div>`).join('')}</dl>`;
    if (item.ruSource === 'перевод') html += '<p class="note">Русское название дано в переводе по анатомической номенклатуре</p>';
    return html;
  }

  buildGroupSheet(g, key) {
    const d = this.data;
    const items = d.groupItems(g.id).filter((it) => this.s.isolated.has(it.id));
    const sys = d.systemById.get(items[0]?.system || g.system);
    const path = d.groupPath(g.parent);
    const crumbs = [sys ? `<button data-act="crumb" data-system="${esc(sys.id)}">${esc(sys.ru)}</button>` : '', ...path.map((p) => `<button data-act="crumb" data-system="${esc(sys?.id || '')}" data-region="" data-group="${esc(p.id)}">${esc(p.ru)}</button>`)].filter(Boolean);
    this.sheet.head.innerHTML = `<div class="sheet-title"><h2>${esc(g.ru)}</h2>${g.lat ? `<p class="lat">${esc(g.lat)}</p>` : ''}</div>
      <div class="sheet-btns"><button class="icon-btn" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button></div>`;
    this.sheet.controls.innerHTML = `<nav class="crumbs scroll" aria-label="Путь в каталоге">${crumbs.join(icon('chevR', 12))}<em>Группа · ${items.length}</em></nav>
      <div class="spine-ctl two"><button class="btn" data-act="close">${icon('eye', 20)}<span>Показать всё</span></button><button class="btn" data-act="back">${icon('back', 20)}<span>Назад</span></button></div>`;
    const list = `<section class="fld"><h3>Структуры группы</h3><div class="list inset">${itemRows(this, items.slice(0, 120))}</div>${items.length > 120 ? `<p class="note">Показаны первые 120 из ${items.length}. Остальные есть в каталоге</p>` : ''}</section>`;
    this.sheet.body.innerHTML = '<div class="skeleton"><i></i><i></i><i></i></div>';
    d.text(g).then((t) => {
      if (this.sheetKey !== key) return;
      let html = '';
      if (t?.summary) html += `<p class="lead">${esc(t.summary)}</p>`;
      for (const [k, label] of FIELDS) { const v = t?.[k]; if (v == null || v === '' || (Array.isArray(v) && !v.length)) continue; html += `<section class="fld"><h3>${label}</h3>${Array.isArray(v) ? `<ul>${v.map((x) => `<li>${esc(x)}</li>`).join('')}</ul>` : `<p>${esc(v)}</p>`}</section>`; }
      if (t?.clinical) html += `<section class="fld clinical"><h3>Клиническое значение</h3><p>${esc(t.clinical)}</p></section>`;
      this.sheet.body.innerHTML = html + list;
    });
  }

  buildLineSheet(line) {
    const d = this.data, v = line.variants[this.s.lineSide] || line.variants[0];
    this.sheet.head.innerHTML = `<div class="sheet-title"><h2>${esc(line.ru)}</h2><p class="lat plain">Миофасциальная линия · ${esc(line.en || '')}</p></div>
      <div class="sheet-btns"><button class="icon-btn" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button></div>`;
    this.sheet.controls.innerHTML = `${line.variants.length > 1 ? `<div class="seg seg-side" role="group" aria-label="Сторона">${line.variants.map((x, i) => `<button data-act="line-side" data-id="${i}" class="${x === v ? 'on' : ''}">${x.side === 'L' ? 'От левой стороны' : 'От правой стороны'}</button>`).join('')}</div>` : ''}
      <div class="spine-ctl two"><button class="btn" data-act="close">${icon('eye', 20)}<span>Показать всё</span></button><button class="btn" data-act="back">${icon('back', 20)}<span>Назад</span></button></div>`;
    let html = '';
    if (line.summary) html += `<p class="lead">${esc(line.summary)}</p>`;
    if (line.action) html += `<section class="fld"><h3>Функция</h3><p>${esc(line.action)}</p></section>`;
    if (line.clinical) html += `<section class="fld clinical"><h3>Практическое значение</h3><p>${esc(line.clinical)}</p></section>`;
    html += '<section class="fld"><h3>Звенья линии по порядку</h3>';
    v.stations.forEach((st, i) => {
      const items = st.ids.map((id) => d.itemById.get(id)).filter(Boolean);
      html += `<h4 class="station"><b>${i + 1}</b>${esc(st.ru)}</h4>${items.length ? `<div class="list inset">${itemRows(this, items)}</div>` : '<p class="note">Этого звена нет в трёхмерной модели</p>'}`;
    });
    html += '</section><p class="note">Состав линий дан по схеме миофасциальных меридианов Томаса Майерса</p>';
    this.sheet.body.innerHTML = html;
  }

  buildMoveSheet() {
    const d = this.data, mv = this.currentMove();
    const [min, max] = mv.range;
    this.sheet.head.innerHTML = `<div class="sheet-title"><h2>${esc(mv.ru)}</h2>${mv.jointName ? `<p class="lat plain">${esc(mv.jointName)}</p>` : ''}</div>
      <div class="sheet-btns"><button class="icon-btn" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button></div>`;
    this.sheet.controls.innerHTML = `<div class="mv-ctl"><button class="play" data-act="play" aria-label="Воспроизвести">${icon('play', 24)}</button>
        <input type="range" id="mv-range" min="${min}" max="${max}" step="1" value="${this.s.angle}" aria-label="Амплитуда"><output id="mv-out">${Math.round(this.s.angle)}°</output></div>
      <div class="legend"><span><i class="ag"></i>Агонисты</span><span><i class="an"></i>Антагонисты</span><em>${min}-${max}°</em></div>
      ${mv.variants.length > 1 ? `<div class="seg seg-side" role="group" aria-label="Сторона">${mv.variants.map((x, i) => `<button data-act="move-side" data-id="${i}" class="${x === mv ? 'on' : ''}">${x.side === 'L' ? 'Левая сторона' : x.side === 'R' ? 'Правая сторона' : `Вариант ${i + 1}`}</button>`).join('')}</div>` : ''}`;
    const rows = (ids) => ids.map((id) => d.itemById.get(id)).filter(Boolean).map((it) => `<button class="row row-item" data-act="item" data-id="${esc(it.id)}" style="--d:0">
      <span class="row-main"><span class="row-title">${esc(it.ru)}</span>${it.lat ? `<span class="row-lat">${esc(it.lat)}</span>` : ''}</span>${icon('chevR', 18)}</button>`).join('');
    let html = '';
    if (mv.agonists.length) html += `<section class="fld"><h3><i class="lg ag"></i>Агонисты, выполняют движение</h3><div class="list inset">${rows(mv.agonists)}</div></section>`;
    if (mv.antagonists.length) html += `<section class="fld"><h3><i class="lg an"></i>Антагонисты, противодействуют</h3><div class="list inset">${rows(mv.antagonists)}</div></section>`;
    if (!mv.agonists.length && !mv.antagonists.length) html += '<p class="note">Для этого движения мышцы в данных пока не указаны</p>';
    html += `<p class="note">Движется структур: ${mv.moving.length}</p>`;
    this.sheet.body.innerHTML = html;
    this.setAngle(this.s.angle);
  }

  // ---------- избранное и недавние ----------
  favs() { return store.get('favs', []); }
  recents() { return store.get('recents', []); }
  toggleFav(id) { const f = this.favs(); const i = f.indexOf(id); if (i >= 0) f.splice(i, 1); else f.unshift(id); store.set('favs', f); this.updateSheetState(); toast(i >= 0 ? 'Убрано из избранного' : 'Добавлено в избранное'); }
  pushRecent(id) { const r = this.recents().filter((x) => x !== id); r.unshift(id); store.set('recents', r.slice(0, 20)); }

  // ---------- вкладки, меню, тема ----------
  setTab(tab, arg) {
    if (tab === 'assistant' && !this.assistant) { toast('Ассистент ещё загружается'); return; }
    if (tab !== 'atlas') this.stopPlay();
    this.tab = tab;
    $('#app').dataset.tab = tab;
    for (const t of $$('#tabbar .tab')) { if (t.dataset.tab === tab) t.setAttribute('aria-current', 'page'); else t.removeAttribute('aria-current'); }
    for (const [name, panel] of [['catalog', this.catalog], ['moves', this.moves], ['search', this.search], ['assistant', this.assistant]]) {
      if (!panel) continue;
      const on = name === tab;
      panel.el.setAttribute('aria-hidden', String(!on)); panel.el.classList.toggle('on', on);
      if (on) panel.open(arg);
    }
    this.assistant?.closeSettings();
    this.closeAbout();
    this.updateInsets();
    if (tab === 'atlas') this.viewer.requestRender();
  }

  openAbout() { this.about.el.classList.add('on'); this.about.el.setAttribute('aria-hidden', 'false'); this.about.open(); }
  closeAbout() { this.about.el.classList.remove('on'); this.about.el.setAttribute('aria-hidden', 'true'); }

  setTheme(theme, save = true) {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]').content = theme === 'light' ? '#F3F4F6' : '#0B0E13';
    this.viewer.setAccent(theme === 'light' ? 0x12b3a0 : 0x35d6c1);
    if (save) store.set('theme', theme);
  }

  regionMenu(anchor) {
    const d = this.data, s = this.s;
    const items = [{ label: 'Всё тело', checked: !s.region, onClick: () => this.setRegion(null) }, { sep: true }];
    for (const r of d.regions) {
      const n = d.items.reduce((k, it) => k + (it.region === r.id && s.systems.has(it.system) && !it.defaultHidden ? 1 : 0), 0);
      items.push({ label: r.ru, checked: s.region === r.id, hint: n ? String(n) : '', onClick: () => this.setRegion(r.id) });
    }
    openMenu(anchor, items);
  }

  moreMenu(anchor) {
    const s = this.s, light = document.documentElement.dataset.theme === 'light';
    const items = [{ label: 'Сбросить вид', icon: 'reset', onClick: () => this.resetView() }];
    if (s.hidden.size) items.push({ label: 'Показать скрытые', icon: 'eye', hint: String(s.hidden.size), onClick: () => this.act((x) => x.hidden.clear()) });
    items.push({ label: light ? 'Тёмная тема' : 'Светлая тема', icon: light ? 'moon' : 'sun', onClick: () => this.setTheme(light ? 'dark' : 'light') });
    items.push({ sep: true }, { label: 'О приложении', icon: 'info', onClick: () => this.openAbout() });
    openMenu(anchor, items, { align: 'right' });
  }

  bind() {
    $('#tabbar').addEventListener('click', (e) => { const t = e.target.closest('.tab'); if (t) this.setTab(t.dataset.tab); });
    $('#system-chips').addEventListener('click', (e) => { const c = e.target.closest('.chip'); if (c) this.toggleSystem(c.dataset.sys); });
    $('#btn-back').addEventListener('click', () => this.back());
    $('#btn-region').addEventListener('click', (e) => this.regionMenu(e.currentTarget));
    $('#btn-more').addEventListener('click', (e) => this.moreMenu(e.currentTarget));
    $('#btn-spine').addEventListener('click', () => this.enterSpine());
    $('#btn-mode-exit').addEventListener('click', () => this.exitMode());
    $('#spine-rail').addEventListener('click', (e) => { const b = e.target.closest('.rail-item'); if (b) this.spineGo(b.dataset.id); });
    const sheet = this.sheet.el;
    sheet.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]'); if (!b) return;
      const { act, id } = b.dataset, s = this.s;
      if (act === 'close') this.closeSheet();
      else if (act === 'fav') this.toggleFav(id);
      else if (act === 'isolate') this.isolate();
      else if (act === 'hide') this.hide();
      else if (act === 'fade') this.toggleFade();
      else if (act === 'back') this.back();
      else if (act === 'focus') { this.sheet.setDetent('peek'); this.viewer.focus([s.mode === 'spine' ? s.spineId : s.selected], { pad: 1.4 }); }
      else if (act === 'to-spine') this.enterSpine(id);
      else if (act === 'item') this.openItem(id);
      else if (act === 'crumb') this.setTab('catalog', { system: b.dataset.system, region: b.dataset.region || null, group: b.dataset.group });
      else if (act === 'spine-up') this.spineStep(-1);
      else if (act === 'spine-down') this.spineStep(1);
      else if (act === 'spine-context') { s.spineContext = !s.spineContext; this.sync(); }
      else if (act === 'view') this.viewer.setView(id);
      else if (act === 'play') this.togglePlay();
      else if (act === 'line-side') this.openLine(s.lineId, +id);
      else if (act === 'move-side') { this.stopPlay(); s.moveSide = +id; s.angle = this.currentMove().range[0]; this.sync(); this.focusMove(this.currentMove()); }
    });
    sheet.addEventListener('input', (e) => { if (e.target.id === 'mv-range') { this.stopPlay(); this.setAngle(+e.target.value); } });
    document.addEventListener('gesturestart', (e) => e.preventDefault());
    document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.tab === 'atlas') this.closeSheet(); });
    window.addEventListener('resize', () => this.updateInsets());
  }
}

async function boot() {
  const text = $('#boot-text'), retry = $('#boot-retry');
  try {
    const data = await loadDataset();
    const app = new App(data);
    window.__app = app;
    app.init();
  } catch (err) {
    console.error(err);
    text.textContent = 'Не удалось загрузить атлас. Проверьте сеть и повторите';
    retry.hidden = false;
    retry.onclick = () => location.reload();
  }
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    // ?nosw отключает кэш оболочки на время разработки
    if (new URLSearchParams(location.search).has('nosw')) {
      navigator.serviceWorker.getRegistrations().then((list) => list.forEach((r) => r.unregister()));
      caches?.keys().then((keys) => keys.filter((k) => k.startsWith('atlas-shell')).forEach((k) => caches.delete(k)));
    } else navigator.serviceWorker.register('sw.js').catch((e) => console.warn('Service worker не установлен', e));
  }
}

boot();
