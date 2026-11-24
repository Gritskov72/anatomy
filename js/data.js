// Загрузка каталога и индексы по нему. Настоящие данные: data/catalog.json, временные: data/mock/catalog.json

const SOURCES = [
  { name: 'real', catalog: 'data/catalog.json', textBase: 'data/text/', modelBase: '' },
  { name: 'mock', catalog: 'data/mock/catalog.json', textBase: 'data/mock/text/', modelBase: 'data/mock/' },
];

export const SYSTEM_ORDER = ['bones', 'joints', 'muscles', 'fascia', 'nerves', 'vessels', 'organs'];
const FALLBACK_COLORS = { bones: '#E8DCC8', joints: '#9FC4D6', muscles: '#B5483F', fascia: '#9CC3CF', nerves: '#F0CB4A', vessels: '#D43A3A', organs: '#C98383' };

export const norm = (s) => (s || '').toString().toLowerCase().replace(/ё/g, 'е').normalize('NFD').replace(/[\u0300-\u036f]/g, '');

const ROMAN = { I: 1, II: 2, III: 3, IV: 4, V: 5, VI: 6, VII: 7, VIII: 8, IX: 9, X: 10, XI: 11, XII: 12 };
const TO_ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
const SPINE_SECTIONS = ['C', 'Th', 'L', 'S', 'Co'];

export async function loadDataset() {
  const forced = new URLSearchParams(location.search).get('data');
  const list = forced ? SOURCES.filter((s) => s.name === forced) : SOURCES;
  for (const src of list) {
    try {
      const res = await fetch(src.catalog, { cache: 'no-cache' });
      if (!res.ok) continue;
      const raw = await res.json();
      if (!raw || !Array.isArray(raw.items) || !raw.items.length || !Array.isArray(raw.models)) continue;
      // миофасциальные линии лежат отдельным файлом: без него атлас работает как прежде
      try { const lr = await fetch(src.catalog.replace('catalog.json', 'lines.json'), { cache: 'no-cache' }); if (lr.ok) raw.lines = (await lr.json()).lines; } catch (e) { /* линий нет */ }
      return new Dataset(raw, src);
    } catch (e) { /* пробуем следующий источник */ }
  }
  throw new Error('Каталог не найден');
}

export class Dataset {
  constructor(raw, src) {
    this.src = src;
    this.isMock = src.name === 'mock';
    this.version = raw.version ?? 1;
    this.raw = raw;

    const known = new Map((raw.systems || []).map((s) => [s.id, s]));
    const used = new Set(raw.items.map((i) => i.system));
    this.systems = SYSTEM_ORDER.filter((id) => known.has(id) || used.has(id))
      .map((id) => ({ id, ru: known.get(id)?.ru || id, color: known.get(id)?.color || FALLBACK_COLORS[id] || '#CCCCCC' }));
    for (const s of raw.systems || []) if (!SYSTEM_ORDER.includes(s.id)) this.systems.push({ color: '#CCCCCC', ...s });
    this.systemById = new Map(this.systems.map((s) => [s.id, s]));

    this.regions = (raw.regions || []).slice();
    this.regionById = new Map(this.regions.map((r) => [r.id, r]));

    this.groups = (raw.groups || []).map((g) => ({ ...g, groups: [], items: [], count: new Map(), total: 0 }));
    this.groupById = new Map(this.groups.map((g) => [g.id, g]));
    for (const g of this.groups) {
      const p = g.parent && this.groupById.get(g.parent);
      if (p && p !== g) p.groups.push(g); else g.parent = null;
    }

    this.models = raw.models.map((m) => ({ ...m, items: [], regions: new Set(), url: src.modelBase + m.file + (m.bytes ? `?v=${m.bytes}` : '') }));
    this.modelByFile = new Map(this.models.map((m) => [m.file, m]));

    this.items = [];
    this.itemById = new Map();
    for (const it of raw.items) {
      if (!it || !it.id || this.itemById.has(it.id)) continue;
      const item = { ...it };
      item.side = item.side === 'L' || item.side === 'R' ? item.side : null;
      item.node = item.node || item.id;
      let model = this.modelByFile.get(item.model);
      if (!model && item.model) {
        model = { file: item.model, system: item.system, bytes: 0, items: [], regions: new Set(), url: src.modelBase + item.model };
        this.models.push(model); this.modelByFile.set(model.file, model);
      }
      item.modelRef = model || null;
      if (model) { model.items.push(item); if (item.region) model.regions.add(item.region); }
      const g = item.parent && this.groupById.get(item.parent);
      if (g) g.items.push(item); else item.parent = null;
      this.items.push(item); this.itemById.set(item.id, item);
    }

    // счётчики по группам: ключ «система|область»
    for (const item of this.items) {
      let g = item.parent && this.groupById.get(item.parent);
      const guard = new Set();
      while (g && !guard.has(g)) {
        guard.add(g);
        for (const key of [`${item.system}|${item.region}`, `${item.system}|*`]) g.count.set(key, (g.count.get(key) || 0) + 1);
        g.total++;
        g = g.parent && this.groupById.get(g.parent);
      }
    }
    for (const g of this.groups) g.extraOnly = g.total > 0 && this.groupItems(g.id).every((it) => it.defaultHidden);
    this.counts = new Map();
    for (const item of this.items) for (const key of [`${item.system}|${item.region}`, `${item.system}|*`]) this.counts.set(key, (this.counts.get(key) || 0) + 1);

    this.lines = (Array.isArray(raw.lines) ? raw.lines : []).map((l) => ({
      ...l,
      variants: (l.variants || []).map((v) => {
        const stations = (v.stations || []).map((st) => ({ ru: st.ru, ids: (st.ids || []).filter((id) => this.itemById.has(id)) }));
        return { side: v.side || null, stations, ids: [...new Set(stations.flatMap((st) => st.ids))] };
      }),
    })).filter((l) => l.variants.length);
    this.lineById = new Map(this.lines.map((l) => [l.id, l]));
    this._buildSearch();
    this._buildSpine();
    this._buildMovements(raw.movements || []);
    this._text = new Map();
  }

  count(system, region) { return this.counts.get(`${system}|${region || '*'}`) || 0; }
  groupCount(g, system, region) { return g.count.get(`${system}|${region || '*'}`) || 0; }

  /** Дети узла дерева каталога. parent: null (корень системы) или id группы. */
  children(system, region, parentId) {
    const inRegion = (it) => it.system === system && (!region || it.region === region);
    if (parentId) {
      const g = this.groupById.get(parentId);
      if (!g) return { groups: [], items: [] };
      return { groups: g.groups.filter((c) => this.groupCount(c, system, region) > 0), items: g.items.filter(inRegion) };
    }
    return {
      groups: this.groups.filter((g) => !g.parent && this.groupCount(g, system, region) > 0),
      items: this.items.filter((it) => !it.parent && inRegion(it)),
    };
  }

  /** Все элементы группы с вложенными. */
  groupItems(groupId, out = [], guard = new Set()) {
    const g = this.groupById.get(groupId);
    if (!g || guard.has(g)) return out;
    guard.add(g);
    out.push(...g.items);
    for (const c of g.groups) this.groupItems(c.id, out, guard);
    return out;
  }

  /** Цепочка групп от корня до элемента или группы. */
  groupPath(parentId) {
    const path = [];
    let g = parentId && this.groupById.get(parentId);
    const guard = new Set();
    while (g && !guard.has(g)) { guard.add(g); path.unshift(g); g = g.parent && this.groupById.get(g.parent); }
    return path;
  }

  // ---------- поиск ----------
  _buildSearch() {
    this.searchIndex = [];
    for (const it of this.items) this.searchIndex.push({ kind: 'item', ref: it, ru: norm(it.ru), alt: norm(it.ruAlt), lat: norm(it.lat), en: norm(it.en) });
    for (const g of this.groups) if (g.total) this.searchIndex.push({ kind: 'group', ref: g, ru: norm(g.ru), lat: norm(g.lat), en: norm(g.en) });
    for (const l of this.lines) this.searchIndex.push({ kind: 'line', ref: l, ru: norm(l.ru), alt: norm('миофасциальная линия меридиан'), en: norm(l.en) });
  }

  search(query, limit = 60) {
    const tokens = norm(query).split(/\s+/).filter(Boolean);
    if (!tokens.length) return [];
    const out = [];
    for (const e of this.searchIndex) {
      let score = 0, ok = true;
      for (const t of tokens) {
        let best = 0;
        for (const [field, w] of [['ru', 3], ['alt', 2], ['lat', 2], ['en', 1]]) {
          const s = e[field]; if (!s) continue;
          const i = s.indexOf(t); if (i < 0) continue;
          const v = i === 0 ? 30 + w : /[\s(\-.,]/.test(s[i - 1]) ? 20 + w : 10 + w;
          if (v > best) best = v;
        }
        if (!best) { ok = false; break; }
        score += best;
      }
      if (!ok) continue;
      if (e.kind === 'group') score += 1;
      if (e.kind === 'line') score += 2;
      score -= Math.min(e.ru.length, 80) / 100;
      out.push({ e, score });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, limit).map((r) => r.e);
  }

  // ---------- позвоночник ----------
  _buildSpine() {
    const isVertebra = (it) => {
      if (it.system !== 'bones' || it.side || it.partOf) return false;
      const ru = norm(it.ru), lat = norm(it.lat), en = norm(it.en);
      return /(^|\s)позвонок/.test(ru) || /^(атлант|крестец|копчик)(\s|$|\()/.test(ru)
        || /^(atlas|axis|vertebra\s|os sacrum|sacrum|os coccygis|coccyx)/.test(lat)
        || /^(atlas|axis|sacrum|coccyx)$/.test(en) || /\bvertebra\b/.test(en);
    };
    const list = this.items.filter(isVertebra).map((it) => ({ item: it, ...spineLabel(it) }));
    const allCentered = list.every((v) => Array.isArray(v.item.center));
    const allParsed = list.every((v) => v.order != null);
    if (allCentered) list.sort((a, b) => b.item.center[1] - a.item.center[1]);
    else if (allParsed) list.sort((a, b) => a.order - b.order);
    // секция для непонятых подписей берётся от соседа сверху
    let last = 'C';
    list.forEach((v, i) => { if (!v.section) { v.section = last; v.label = v.label || String(i + 1); } last = v.section; });
    this.spine = list;
    this.spineIds = new Set(list.map((v) => v.item.id));
  }

  // ---------- движения ----------
  _buildMovements(list) {
    const ok = (id) => this.itemById.has(id);
    this.movements = [];
    for (const m of list) {
      if (!m || !m.id || !Array.isArray(m.pivot) || !Array.isArray(m.axis)) continue;
      const mv = {
        ...m,
        range: Array.isArray(m.range) && m.range.length === 2 ? m.range : [0, 90],
        moving: (m.moving || []).filter(ok), agonists: (m.agonists || []).filter(ok), antagonists: (m.antagonists || []).filter(ok),
      };
      const jg = this.groupById.get(m.joint), ji = this.itemById.get(m.joint);
      mv.jointName = m.jointRu || jg?.ru || ji?.ru || '';
      mv.jointKey = (jg || ji)?.id || m.joint || '';
      // вторая сторона тела: тот же набор полей в mirror
      const side = m.side === 'L' || m.side === 'R' ? m.side : null;
      mv.side = side;
      mv.variants = [mv];
      const mr = m.mirror;
      if (mr && Array.isArray(mr.pivot) && Array.isArray(mr.axis)) {
        const other = { ...mv, pivot: mr.pivot, axis: mr.axis, side: side === 'L' ? 'R' : side === 'R' ? 'L' : null,
          moving: (mr.moving || []).filter(ok), agonists: (mr.agonists || []).filter(ok), antagonists: (mr.antagonists || []).filter(ok) };
        mv.variants.push(other); other.variants = mv.variants;
      }
      delete mv.mirror;
      this.movements.push(mv);
    }
    this.movementById = new Map(this.movements.map((m) => [m.id, m]));
  }

  // ---------- описания ----------
  async text(item) {
    const sys = item.system;
    if (!this._text.has(sys)) {
      this._text.set(sys, fetch(`${this.src.textBase}${sys}.json`).then((r) => (r.ok ? r.json() : {})).catch(() => ({})));
    }
    const all = await this._text.get(sys);
    return all?.[item.id] || null;
  }
}

function spineLabel(it) {
  const ru = it.ru || '';
  const cm = typeof it.code === 'string' && it.code.match(/^(Co|Th|C|T|L|S)\s?([IVX]+)?$/);
  if (cm) {
    const sec = cm[1] === 'T' ? 'Th' : cm[1];
    return { section: sec, label: sec + (cm[2] || ''), order: SPINE_SECTIONS.indexOf(sec) * 100 + (ROMAN[cm[2]] || 0) };
  }
  let m = ru.match(/(?:^|[\s(])(Co|Th|C|T|L|S)\s?(XII|XI|IX|IV|VIII|VII|VI|V|X|III|II|I)(?:\s?-\s?(?:Co|Th|C|T|L|S)?\s?([IVX]+))?(?=$|[\s),.])/);
  if (m) {
    const sec = m[1] === 'T' ? 'Th' : m[1];
    const n = ROMAN[m[2]] || 0;
    return { section: sec, label: m[3] ? sec : sec + m[2], order: SPINE_SECTIONS.indexOf(sec) * 100 + n };
  }
  m = (it.id || '').match(/-(co|th|c|t|l|s)-?(\d{1,2})$/i);
  if (m) {
    const k = m[1].toLowerCase();
    const sec = k === 'co' ? 'Co' : k === 'c' ? 'C' : k === 'l' ? 'L' : k === 's' ? 'S' : 'Th';
    const n = +m[2];
    return { section: sec, label: sec + (TO_ROMAN[n] || n), order: SPINE_SECTIONS.indexOf(sec) * 100 + n };
  }
  const all = norm(`${it.ru} ${it.lat} ${it.en}`);
  if (/^(атлант|atlas)/.test(norm(it.ru)) || /^atlas/.test(norm(it.lat))) return { section: 'C', label: 'CI', order: 1 };
  if (/осевой позвонок|(^|\s)axis(\s|$)/.test(all)) return { section: 'C', label: 'CII', order: 2 };
  if (/vertebra prominens|выступающий позвонок/.test(all)) return { section: 'C', label: 'CVII', order: 7 };
  if (/крестец|sacrum/.test(all)) return { section: 'S', label: 'S', order: 300 };
  if (/копчик|coccy/.test(all)) return { section: 'Co', label: 'Co', order: 400 };
  return { section: null, label: null, order: null };
}

export const SPINE_SECTION_NAMES = { C: 'Шейный отдел', Th: 'Грудной отдел', L: 'Поясничный отдел', S: 'Крестец', Co: 'Копчик' };
