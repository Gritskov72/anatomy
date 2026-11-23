// Экраны «Каталог», «Движения», «Поиск», «О приложении»
import { $, esc, store, md, SIDE_RU, toast } from './ui.js';
import { icon } from './icons.js';
import { norm } from './data.js';

function itemRow(app, item, { depth = 0, hl = null, caption = null, bare = false } = {}) {
  const sys = app.data.systemById.get(item.system);
  const sub = caption ?? item.lat ?? '';
  return `<button class="row row-item" data-act="item" data-id="${esc(item.id)}" style="--d:${depth}">
    <i class="dot" style="--c:${esc(sys?.color || '#999')}"></i>
    <span class="row-main"><span class="row-title">${mark(item.ru, hl)}</span>${sub ? `<span class="row-lat">${mark(sub, hl)}</span>` : ''}</span>
    ${bare ? '' : `${item.side ? `<span class="side">${SIDE_RU[item.side]}</span>` : ''}${icon('chevR', 18)}`}
  </button>`;
}

/** Строки структур: левая и правая сторона одной структуры идут одной строкой с двумя кнопками. */
export function itemRows(app, items, opts = {}) {
  const pairs = new Map(), order = [];
  for (const it of items) {
    const key = it.side ? `${it.system}|${it.parent}|${it.ru}|${it.lat}` : `#${it.id}`;
    if (!pairs.has(key)) { pairs.set(key, []); order.push(key); }
    pairs.get(key).push(it);
  }
  let html = '';
  for (const key of order) {
    const list = pairs.get(key);
    const l = list.find((x) => x.side === 'L'), r = list.find((x) => x.side === 'R');
    if (list.length === 2 && l && r) {
      html += `<div class="row-wrap pair" style="--d:${opts.depth || 0}">${itemRow(app, l, { ...opts, bare: true })}
        <button class="side-btn" data-act="item" data-id="${esc(l.id)}" aria-label="Левая сторона">Л</button><button class="side-btn" data-act="item" data-id="${esc(r.id)}" aria-label="Правая сторона">П</button></div>`;
    } else for (const it of list) html += itemRow(app, it, opts);
  }
  return html;
}

function mark(text, tokens) {
  const s = String(text ?? '');
  if (!tokens?.length) return esc(s);
  const low = norm(s);
  if (low.length !== s.length) return esc(s);
  const spans = [];
  for (const t of tokens) { const i = low.indexOf(t); if (i >= 0) spans.push([i, i + t.length]); }
  if (!spans.length) return esc(s);
  spans.sort((a, b) => a[0] - b[0]);
  let out = '', pos = 0;
  for (const [a, b] of spans) { if (a < pos) continue; out += esc(s.slice(pos, a)) + '<mark>' + esc(s.slice(a, b)) + '</mark>'; pos = b; }
  return out + esc(s.slice(pos));
}

// ---------------------------------------------------------------- Каталог
export class CatalogPanel {
  constructor(app) {
    this.app = app; this.el = $('#panel-catalog');
    this.system = app.data.systems[0]?.id; this.region = null;
    this.toggled = new Set();
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  open({ system, region, group } = {}) {
    if (system) this.system = system;
    if (region !== undefined) this.region = region;
    let target = null;
    if (group) {
      const d = this.app.data;
      const first = d.groupItems(group).find((it) => it.system === this.system);
      const reg = this.region || first?.region;
      if (!this.region && reg) this.setOpen(`r:${this.system}|${reg}`, d.count(this.system, reg), true);
      for (const g of d.groupPath(group)) this.setOpen(`${this.system}|${reg}|${g.id}`, d.groupCount(g, this.system, reg), true);
      target = group;
    }
    this.render();
    if (target) requestAnimationFrame(() => this.el.querySelector(`[data-group="${CSS.escape(target)}"]`)?.scrollIntoView({ block: 'center' }));
  }

  defOpen(count) { return count <= 14; }
  isOpen(key, count) { return this.toggled.has(key) ? !this.defOpen(count) : this.defOpen(count); }
  setOpen(key, count, open) { if (this.isOpen(key, count) !== open) { if (this.toggled.has(key)) this.toggled.delete(key); else this.toggled.add(key); } }

  render() {
    const d = this.app.data;
    const sysChips = d.systems.map((s) => `<button class="chip${s.id === this.system ? ' on' : ''}" data-act="sys" data-id="${s.id}"><i style="--c:${esc(s.color)}"></i>${esc(s.ru)}<b>${d.count(s.id)}</b></button>`).join('');
    const regs = d.regions.filter((r) => d.count(this.system, r.id) > 0);
    const regChips = `<button class="chip plain${!this.region ? ' on' : ''}" data-act="reg" data-id="">Все области</button>`
      + regs.map((r) => `<button class="chip plain${r.id === this.region ? ' on' : ''}" data-act="reg" data-id="${r.id}">${esc(r.ru)}<b>${d.count(this.system, r.id)}</b></button>`).join('');
    const sys = d.systemById.get(this.system);
    const crumbs = `<div class="crumbs"><span>${esc(sys?.ru || '')}</span>${this.region ? `${icon('chevR', 12)}<span>${esc(d.regionById.get(this.region)?.ru || '')}</span>` : ''}<em>${d.count(this.system, this.region)}</em></div>`;

    let list = '';
    if (this.region) list = this.level(this.region, null, 0);
    else {
      for (const r of regs) {
        const key = `r:${this.system}|${r.id}`, n = d.count(this.system, r.id);
        const open = this.isOpen(key, n);
        list += `<div class="row-wrap"><button class="row row-group row-region${open ? ' open' : ''}" data-act="toggle" data-key="${key}" data-count="${n}" style="--d:0">
          <span class="chev">${icon('chevR', 16)}</span><span class="row-main"><span class="row-title">${esc(r.ru)}</span></span><span class="row-count">${n}</span></button>
          <button class="row-eye" data-act="region-show" data-id="${r.id}" aria-label="Показать в атласе">${icon('eye', 20)}</button></div>`;
        if (open) list += this.level(r.id, null, 1);
      }
      const noRegion = d.items.filter((it) => it.system === this.system && !d.regionById.has(it.region));
      if (noRegion.length) list += itemRows(this.app, noRegion, { depth: 0 });
    }
    this.el.innerHTML = `<div class="panel-scroll">
      <header class="panel-head"><h1>Каталог</h1></header>
      <div class="chips chips-panel">${sysChips}</div>
      <div class="chips chips-panel">${regChips}</div>
      ${crumbs}
      <div class="list">${list || '<div class="empty">В этом разделе пока пусто</div>'}</div>
    </div>`;
  }

  level(region, parentId, depth) {
    const d = this.app.data;
    const { groups, items } = d.children(this.system, region, parentId);
    // дополнительные структуры (фасции, сумки) идут после основных
    groups.sort((a, b) => (a.extraOnly ? 1 : 0) - (b.extraOnly ? 1 : 0));
    items.sort((a, b) => (a.defaultHidden ? 1 : 0) - (b.defaultHidden ? 1 : 0));
    depth = Math.min(depth, 6);
    let html = '';
    for (const g of groups) {
      const n = d.groupCount(g, this.system, region);
      const key = `${this.system}|${region}|${g.id}`;
      const open = this.isOpen(key, n);
      html += `<div class="row-wrap" data-group="${esc(g.id)}"><button class="row row-group${open ? ' open' : ''}" data-act="toggle" data-key="${esc(key)}" data-count="${n}" style="--d:${depth}">
        <span class="chev">${icon('chevR', 16)}</span><span class="row-main"><span class="row-title">${esc(g.ru)}</span></span><span class="row-count">${n}</span></button>
        <button class="row-eye" data-act="group" data-id="${esc(g.id)}" aria-label="Показать группу в атласе">${icon('eye', 20)}</button></div>`;
      if (open) html += this.level(region, g.id, depth + 1);
    }
    html += itemRows(this.app, items, { depth });
    return html;
  }

  onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'sys') { this.system = id; this.region = this.app.data.count(id, this.region) ? this.region : null; this.keepScroll(() => this.render(), true); }
    else if (act === 'reg') { this.region = id || null; this.keepScroll(() => this.render(), true); }
    else if (act === 'toggle') { const k = b.dataset.key; if (this.toggled.has(k)) this.toggled.delete(k); else this.toggled.add(k); this.keepScroll(() => this.render()); }
    else if (act === 'item') this.app.openItem(id);
    else if (act === 'group') this.app.openGroup(id, this.system);
    else if (act === 'region-show') this.app.openRegion(this.system, id);
  }

  keepScroll(fn, chips = false) {
    const sc = this.el.querySelector('.panel-scroll');
    const top = sc?.scrollTop || 0;
    const lefts = [...this.el.querySelectorAll('.chips')].map((c) => c.scrollLeft);
    fn();
    const sc2 = this.el.querySelector('.panel-scroll');
    if (sc2) sc2.scrollTop = chips ? 0 : top;
    [...this.el.querySelectorAll('.chips')].forEach((c, i) => {
      c.scrollLeft = lefts[i] || 0;
      const on = c.querySelector('.chip.on');
      if (on) { const a = on.offsetLeft - c.offsetLeft, b = a + on.offsetWidth; if (a < c.scrollLeft + 16) c.scrollLeft = a - 20; else if (b > c.scrollLeft + c.clientWidth - 16) c.scrollLeft = b - c.clientWidth + 20; }
    });
  }
}

// ---------------------------------------------------------------- Поиск
export class SearchPanel {
  constructor(app) {
    this.app = app; this.el = $('#panel-search'); this.q = '';
    this.el.innerHTML = `<div class="panel-scroll">
      <header class="panel-head"><h1>Поиск</h1></header>
      <div class="search-box"><label class="search-field">${icon('search', 20)}
        <input id="search-input" type="search" inputmode="search" enterkeyhint="search" autocomplete="off" autocorrect="off" autocapitalize="off" spellcheck="false" placeholder="Название на русском или латыни" aria-label="Поиск структуры">
        <button class="search-clear" data-act="clear" aria-label="Очистить" hidden>${icon('x', 16)}</button></label></div>
      <div id="search-out"></div></div>`;
    this.input = $('#search-input'); this.out = $('#search-out');
    this.input.addEventListener('input', () => { this.q = this.input.value; this.results(); });
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter') this.input.blur(); });
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  open() {
    this.results();
    if (!this.q && !this.app.favs().length && !this.app.recents().length) this.input.focus();
  }

  results() {
    const q = this.q.trim();
    this.el.querySelector('.search-clear').hidden = !this.q;
    const d = this.app.data;
    if (!q) {
      const favs = this.app.favs().map((id) => d.itemById.get(id)).filter(Boolean);
      const rec = this.app.recents().map((id) => d.itemById.get(id)).filter(Boolean);
      let html = '';
      if (favs.length) html += `<h2 class="sec">${icon('starFill', 16)}Избранное</h2><div class="list">${favs.map((it) => itemRow(this.app, it)).join('')}</div>`; // без объединения сторон: порядок важен
      if (rec.length) html += `<h2 class="sec">${icon('clock', 16)}Недавние<button class="link" data-act="clear-recents">Очистить</button></h2><div class="list">${rec.map((it) => itemRow(this.app, it)).join('')}</div>`;
      if (!html) html = `<div class="empty"><b>${d.items.length}</b> структур в атласе<br>Начните вводить название, например «атлант» или «biceps»</div>`;
      this.out.innerHTML = html;
      return;
    }
    const tokens = norm(q).split(/\s+/).filter(Boolean);
    const res = d.search(q, 60);
    if (!res.length) { this.out.innerHTML = '<div class="empty">Ничего не найдено<br>Проверьте написание или попробуйте латинское название</div>'; return; }
    // левая и правая сторона одной структуры в выдаче объединяются
    const seen = new Map(), rows = [];
    for (const e of res) {
      if (e.kind === 'item' && e.ref.side) {
        const key = `${e.ref.system}|${e.ref.parent}|${e.ref.ru}|${e.ref.lat}`;
        if (seen.has(key)) { seen.get(key).items.push(e.ref); continue; }
        const row = { kind: 'items', items: [e.ref] }; seen.set(key, row); rows.push(row);
      } else rows.push(e);
    }
    this.out.innerHTML = `<div class="list">${rows.map((e) => {
      if (e.kind === 'items') return itemRows(this.app, e.items, { hl: tokens });
      if (e.kind === 'group') {
        const g = e.ref;
        return `<button class="row row-item" data-act="group" data-id="${esc(g.id)}" style="--d:0"><i class="dot sq" style="--c:${esc(d.systemById.get(g.system)?.color || '#999')}"></i>
          <span class="row-main"><span class="row-title">${mark(g.ru, tokens)}</span><span class="row-lat plain">Группа · ${g.total} ${plural(g.total)}</span></span>${icon('chevR', 18)}</button>`;
      }
      return itemRow(this.app, e.ref, { hl: tokens });
    }).join('')}</div>`;
  }

  onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'item') { this.input.blur(); this.app.openItem(id); }
    else if (act === 'group') { this.input.blur(); this.app.openGroup(id); }
    else if (act === 'clear') { this.q = this.input.value = ''; this.results(); this.input.focus(); }
    else if (act === 'clear-recents') { store.set('recents', []); this.results(); }
  }
}

const plural = (n) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? 'структура' : a >= 2 && a <= 4 && (b < 12 || b > 14) ? 'структуры' : 'структур'; };

// ---------------------------------------------------------------- Движения
export class MovesPanel {
  constructor(app) {
    this.app = app; this.el = $('#panel-moves');
    this.el.addEventListener('click', (e) => { const b = e.target.closest('[data-act="move"]'); if (b) this.app.openMovement(b.dataset.id); });
  }

  open() {
    const d = this.app.data;
    const groups = new Map();
    for (const m of d.movements) { const k = m.jointName || 'Другие движения'; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(m); }
    let html = '';
    for (const [name, list] of groups) {
      html += `<h2 class="sec">${esc(name)}</h2><div class="list">${list.map((m) => `<button class="row row-item" data-act="move" data-id="${esc(m.id)}" style="--d:0">
        <span class="mv-ic">${icon('moves', 20)}</span><span class="row-main"><span class="row-title">${esc(m.ru)}</span>
        <span class="row-lat plain">${m.range[0]}-${m.range[1]}° · ${m.agonists.length ? `агонистов ${m.agonists.length}` : 'без подсветки мышц'}${m.antagonists.length ? ` · антагонистов ${m.antagonists.length}` : ''}</span></span>${icon('chevR', 18)}</button>`).join('')}</div>`;
    }
    this.el.innerHTML = `<div class="panel-scroll"><header class="panel-head"><h1>Движения</h1><p>Выберите движение, чтобы увидеть его на модели и работающие мышцы</p></header>
      ${html || '<div class="empty">Движения появятся вместе с данными атласа</div>'}</div>`;
  }
}

// ---------------------------------------------------------------- О приложении
export class AboutPanel {
  constructor(app) {
    this.app = app; this.el = $('#panel-about');
    this.el.addEventListener('click', (e) => this.onClick(e));
  }

  async open() {
    const d = this.app.data;
    const theme = store.get('theme', 'dark');
    const total = d.models.reduce((s, m) => s + (m.bytes || 0), 0);
    this.el.innerHTML = `<div class="panel-scroll">
      <header class="panel-head with-close"><button class="glass round" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button><h1>О приложении</h1></header>
      <div class="about-card"><div class="about-mark"><i></i><i></i><i></i><i></i><i></i><i></i><i></i></div>
        <div><b>Анатомия</b><span>3D-атлас анатомии человека</span></div></div>
      <div class="kv"><div><span>Структур</span><b>${d.items.length}</b></div><div><span>Движений</span><b>${d.movements.length}</b></div><div><span>Моделей</span><b>${d.models.length}</b></div></div>
      ${d.isMock ? '<p class="note">Сейчас подключён временный набор данных с условными фигурами. Настоящие модели появятся автоматически, когда будет готов каталог</p>' : ''}
      <h2 class="sec">Оформление</h2>
      <div class="seg" role="group" aria-label="Тема"><button data-act="theme" data-id="dark" class="${theme === 'dark' ? 'on' : ''}">${icon('moon', 18)}Тёмная</button><button data-act="theme" data-id="light" class="${theme === 'light' ? 'on' : ''}">${icon('sun', 18)}Светлая</button></div>
      <h2 class="sec">Работа без сети</h2>
      <p class="note">Открытые модели сохраняются на устройстве сами. Можно скачать весь атлас сразу${total ? `, это около ${fmtMB(total)}` : ''}</p>
      <button class="btn wide" data-act="offline">${icon('download', 20)}<span id="offline-label">Скачать все модели</span></button>
      <div class="progress" id="offline-progress" hidden><i></i></div>
      <h2 class="sec">Источники и лицензии</h2>
      <div class="md" id="about-md"><p class="note">Загрузка</p></div>
      <h2 class="sec">Программная часть</h2>
      <div class="md"><p>Трёхмерная графика: three.js, лицензия MIT, авторы three.js. Приложение работает целиком на устройстве и не передаёт данные</p></div>
    </div>`;
    try {
      const res = await fetch('about/licenses.md', { cache: 'no-cache' });
      $('#about-md').innerHTML = res.ok ? md(await res.text()) : '<p class="note">Список источников появится вместе с данными атласа</p>';
    } catch (e) { $('#about-md').innerHTML = '<p class="note">Список источников недоступен без сети</p>'; }
  }

  async onClick(e) {
    const b = e.target.closest('[data-act]'); if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'close') this.app.closeAbout();
    else if (act === 'theme') { this.app.setTheme(id); this.el.querySelectorAll('.seg button').forEach((x) => x.classList.toggle('on', x.dataset.id === id)); }
    else if (act === 'offline') this.download(b);
  }

  async download(btn) {
    if (this.busy) return;
    this.busy = true; btn.disabled = true;
    const d = this.app.data, label = $('#offline-label'), bar = $('#offline-progress');
    const total = d.models.reduce((s, m) => s + (m.bytes || 1), 0);
    let done = 0, failed = 0;
    bar.hidden = false;
    for (const m of d.models) {
      try { const r = await fetch(m.url); if (!r.ok) throw new Error(r.status); await r.arrayBuffer(); } catch (err) { failed++; }
      done += m.bytes || 1;
      const k = Math.round((done / total) * 100);
      bar.firstElementChild.style.width = `${k}%`;
      if (label.isConnected) label.textContent = `Скачивание ${k}%`;
    }
    for (const s of d.systems) await d.text({ system: s.id, id: '' });
    this.busy = false; btn.disabled = false;
    if (label.isConnected) label.textContent = failed ? `Не скачано файлов: ${failed}. Повторить` : 'Атлас сохранён на устройстве';
    toast(failed ? 'Часть моделей не скачалась' : 'Атлас доступен без сети');
  }
}

export const fmtMB = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(bytes > 10485760 ? 0 : 1).replace('.', ',')} МБ` : `${Math.max(1, Math.round(bytes / 1024))} КБ`);
