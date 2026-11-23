// Поиск без модели: по атласу (названия и описания) и по личным документам. Русская нормализация, лёгкий стемминг, биграммы для опечаток

export const FIELD_RU = {
  summary: 'Кратко', origin: 'Начало', insertion: 'Прикрепление', action: 'Функция', innervation: 'Иннервация', blood: 'Кровоснабжение',
  parts: 'Части и ориентиры', articulations: 'Сочленения', type: 'Тип сустава', surfaces: 'Суставные поверхности', ligaments: 'Связки', motions: 'Движения',
  source: 'Откуда отходит', branches: 'Ветви и притоки', supplies: 'Что снабжает', clinical: 'Клиническое значение',
};
export const FIELD_KEYS = Object.keys(FIELD_RU);

export const normText = (s) => String(s ?? '').toLowerCase().replace(/ё/g, 'е');
export const words = (s) => normText(s).match(/[a-zа-я0-9]+/g) || [];
export const fieldText = (v) => (Array.isArray(v) ? v.join('; ') : String(v ?? ''));

export const STOP = new Set(`а без бы был была были было в во вот все вся где да для до его ее если есть еще же за и из или им их к как какая какие каким каких какое какой когда ко кто ли либо
  меня мне мной мое моего моей моем моему мои моих мой моя мы на над надо не нет ни но ну о об обо он она они оно от по под пожалуйста покажи почему при про
  расскажи с со так также такое такой там то только ты тут у уже чем что чтобы это эта эти этот я находится находятся расположен расположена расположено
  расположены располагается располагаются объясни скажи подскажи можно можешь нужно очень`.split(/\s+/).filter(Boolean));

// окончания: сначала глагольные (с ограничением по длине слова), затем именные
const VERB3 = 'ивает ывает ается яется ает яет ают яют ует уют ить ать ять еть'.split(' ').sort((a, b) => b.length - a.length);
const VERB2 = ['ет', 'ит', 'ят', 'ут', 'ют'];
const GENERIC = `иями ями ами ого его ому ему ыми ими ией иях ях ах ов ев ей ой ий ый ая яя ое ее ые ие ых их ую юю ом ем ам ям ею ою ью ия ья ье ии ию ием
  ание ение ания ения анию ению анием ением ании ении аний ений атель ателя ателю атели ателем ателей итель ителя ители ителю ация ации ацию ацией
  а я о е ы и у ю ь й`.split(/\s+/).filter(Boolean).sort((a, b) => b.length - a.length);

/** Лёгкий стемминг русского слова. Латиница и числа без изменений. */
export function stem(w) {
  if (w.length <= 3 || !/[а-я]/.test(w)) return w;
  let s = w;
  if (s.length > 5 && /(ся|сь)$/.test(s)) s = s.slice(0, -2);
  const fits = (e) => s.endsWith(e) && s.length - e.length >= 3;
  let cut = '';
  if (s.length >= 6) cut = VERB3.find(fits) || '';
  if (!cut && s.length >= 8) cut = VERB2.find(fits) || '';
  if (!cut) cut = GENERIC.find(fits) || '';
  if (cut) s = s.slice(0, -cut.length);
  // беглая гласная: позвонок и позвонка, крестец и крестца
  if (s.length >= 6) s = s.replace(/([бвгджзклмнпрстфхцчшщ])[ое]([кц])$/, '$1$2');
  return s;
}

// разговорные слова и основы прилагательных из названий
const SYN = {
  локот: ['локтев'], локт: ['локтев'], шея: ['шейн'], шеи: ['шейн'], шею: ['шейн'], поясниц: ['поясничн'], таз: ['тазов'],
  сердц: ['сердечн'], лопатк: ['лопаточн'], ребр: ['реберн'], ключиц: ['ключичн'], палец: ['пальц'], живот: ['брюшн'],
  колен: ['коленн'], плеч: ['плечев'], бедр: ['бедренн'], стоп: ['стопн'],
};

/** Слова запроса без служебных: группы вариантов (основа и синонимы). */
export function queryGroups(text) {
  const out = [], seen = new Set();
  for (const w of words(text)) {
    if (STOP.has(w) || (w.length < 2 && !/\d/.test(w))) continue;
    const s = stem(w);
    if (seen.has(s)) continue;
    seen.add(s);
    out.push([s, ...(SYN[s] || SYN[w] || [])]);
  }
  return out;
}

const bigrams = (w) => { const s = new Set(); for (let i = 0; i < w.length - 1; i++) s.add(w.slice(i, i + 2)); return s; };

function buildBigrams(vocab) {
  const idx = new Map();
  for (const t of vocab.keys()) {
    if (t.length < 3) continue;
    for (const b of bigrams(t)) { let a = idx.get(b); if (!a) idx.set(b, (a = [])); a.push(t); }
  }
  return idx;
}

/** Термы словаря, подходящие под группу запроса: точное совпадение, общий префикс, опечатка по биграммам. */
function expand(group, vocab, bigramIndex) {
  const out = new Map();
  const add = (t, f) => { if (f > (out.get(t) || 0)) out.set(t, f); };
  group.forEach((q, gi) => {
    const k = gi ? 0.9 : 1;
    if (vocab.has(q)) add(q, k);
    if (q.length >= 4 && /[а-яa-z]/.test(q)) {
      for (const t of vocab.keys()) {
        if (t === q || t.length < 4) continue;
        if (t.startsWith(q)) add(t, k * (t.length - q.length <= 3 ? 0.85 : 0.6));
        else if (q.startsWith(t)) add(t, k * 0.7);
      }
    }
  });
  const q = group[0];
  if (!out.size && q.length >= 5 && bigramIndex) {
    const bg = bigrams(q), idx = bigramIndex(), cnt = new Map();
    for (const b of bg) for (const t of idx.get(b) || []) cnt.set(t, (cnt.get(t) || 0) + 1);
    const cand = [];
    for (const [t, n] of cnt) { const dice = (2 * n) / (bg.size + bigrams(t).size); if (dice >= 0.62) cand.push([t, dice]); }
    cand.sort((a, b) => b[1] - a[1]);
    for (const [t, d] of cand.slice(0, 5)) add(t, 0.55 * d);
  }
  return out;
}

// ---------------------------------------------------------------- атлас
export class AtlasSearch {
  constructor(data) {
    this.data = data;
    this.docs = null; this.textReady = null; this._mv = null;
    this._bg = new WeakMap();
  }

  _bigrams(vocab) { let idx = this._bg.get(vocab); if (!idx) { idx = buildBigrams(vocab); this._bg.set(vocab, idx); } return idx; }

  /** Индекс названий строится сразу из каталога. Левая и правая структуры идут одним документом. */
  _names() {
    if (this.docs) return;
    const d = this.data, docs = [], pairs = new Map();
    for (const it of d.items) {
      const key = it.side ? `${it.system}|${it.parent}|${it.ru}|${it.lat}` : `#${it.id}`;
      const ex = pairs.get(key);
      if (ex) { ex.items.push(it); ex.ids.push(it.id); continue; }
      const doc = { kind: 'item', ref: it, items: [it], ids: [it.id], system: it.system, hidden: !!it.defaultHidden };
      pairs.set(key, doc); docs.push(doc);
    }
    for (const g of d.groups) if (g.total) docs.push({ kind: 'group', ref: g, items: [], ids: [g.id], system: g.system, hidden: !!g.extraOnly });
    this.nameInv = new Map(); this.byId = new Map();
    docs.forEach((doc, i) => {
      const r = doc.ref;
      doc.i = i; doc.nameTerms = new Map(); doc.ruTerms = new Set();
      const put = (text, w, ru = false) => {
        for (const x of words(text)) {
          if (STOP.has(x)) continue;
          const s = stem(x);
          if (ru) doc.ruTerms.add(s);
          if (w > (doc.nameTerms.get(s) || 0)) doc.nameTerms.set(s, w);
        }
      };
      put(r.ru, 3, true); put(r.ruAlt, 2.5); put(r.lat, 2.5); put(r.en, 1.5); put(r.code, 3);
      doc.ruNorm = words(String(r.ru || '').replace(/\([^)]*\)/g, ' ')).join(' ');
      for (const s of doc.nameTerms.keys()) { let list = this.nameInv.get(s); if (!list) this.nameInv.set(s, (list = [])); list.push(i); }
      for (const id of doc.ids) this.byId.set(id, doc);
    });
    this.docs = docs;
  }

  /** Описания из data/text/*.json подгружаются один раз при первом полном поиске. */
  full() {
    this._names();
    if (!this.textReady) {
      this.textReady = (async () => {
        const d = this.data;
        const systems = [...new Set([...d.systems.map((s) => s.id), ...d.groups.map((g) => g.system)].filter(Boolean))];
        const files = new Map();
        await Promise.all(systems.map(async (sys) => {
          await d.text({ system: sys, id: '' });
          files.set(sys, (await d._text.get(sys)) || {});
        }));
        this.textInv = new Map();
        for (const doc of this.docs) {
          const t = files.get(doc.system)?.[doc.ids[0]] || null;
          doc.text = t; doc.tf = new Map();
          if (t) for (const k of FIELD_KEYS) {
            if (!t[k]) continue;
            for (const x of words(fieldText(t[k]))) {
              if (STOP.has(x) || x.length < 2) continue;
              const s = stem(x);
              doc.tf.set(s, (doc.tf.get(s) || 0) + 1);
            }
          }
          for (const [s, n] of doc.tf) { let arr = this.textInv.get(s); if (!arr) this.textInv.set(s, (arr = [])); arr.push([doc.i, n]); }
        }
        this.vocab = new Map(this.nameInv);
        for (const k of this.textInv.keys()) if (!this.vocab.has(k)) this.vocab.set(k, null);
      })().catch((err) => { this.textReady = null; throw err; });
    }
    return this.textReady;
  }

  _hit(doc) {
    const r = doc.ref;
    return { kind: doc.kind, id: doc.ids[0], ids: doc.ids.slice(), ref: r, items: doc.items, ru: r.ru || '', lat: r.lat || '', system: doc.system, text: doc.text };
  }

  hitFor(id) { this._names(); const doc = this.byId.get(id); return doc ? this._hit(doc) : null; }

  /** Самая подходящая структура по названию (для команд показа). Только каталог, мгновенно. */
  resolve(query) {
    this._names();
    const groups = queryGroups(query);
    if (!groups.length) return null;
    const phrase = words(query).filter((w) => !STOP.has(w)).join(' ');
    const acc = new Map();
    for (const g of groups) {
      const exp = expand(g, this.nameInv, () => this._bigrams(this.nameInv));
      const best = new Map();
      for (const [t, f] of exp) for (const i of this.nameInv.get(t) || []) {
        const v = f * this.docs[i].nameTerms.get(t);
        if (v > (best.get(i) || 0)) best.set(i, v);
      }
      for (const [i, v] of best) { const a = acc.get(i) || { n: 0, w: 0 }; a.n++; a.w += v; acc.set(i, a); }
    }
    let top = null;
    for (const [i, a] of acc) {
      const doc = this.docs[i], cov = a.n / groups.length;
      if (cov < 0.6) continue;
      let score = cov * 100 + a.w * 3 - Math.max(0, doc.ruTerms.size - a.n) * 4;
      if (doc.ruNorm && doc.ruNorm === phrase) score += 60;
      else if (doc.ruNorm && phrase && doc.ruNorm.startsWith(phrase)) score += 15;
      if (doc.hidden) score -= 15;
      if (!top || score > top.score) top = { doc, score };
    }
    return top ? { ...this._hit(top.doc), score: top.score } : null;
  }

  /** Полный поиск: названия и описания. Возвращает структуры с весом и лучшими фрагментами текста. */
  async search(query, limit = 5) {
    await this.full();
    const groups = queryGroups(query);
    if (!groups.length) return [];
    const N = this.docs.length, acc = new Map(), terms = new Map();
    for (const g of groups) {
      const exp = expand(g, this.vocab, () => this._bigrams(this.vocab));
      const best = new Map();
      const slot = (i) => { let b = best.get(i); if (!b) best.set(i, (b = { n: 0, t: 0 })); return b; };
      for (const [t, f] of exp) {
        terms.set(t, Math.max(terms.get(t) || 0, f));
        const names = this.nameInv.get(t);
        if (names) {
          const idf = Math.log(1 + N / names.length);
          for (const i of names) { const v = f * this.docs[i].nameTerms.get(t) * idf * 1.6; const b = slot(i); if (v > b.n) b.n = v; }
        }
        const posts = this.textInv.get(t);
        if (posts) {
          const idf = Math.log(1 + N / posts.length);
          for (const [i, tf] of posts) { const v = (f * idf * (tf * 2.2)) / (tf + 1.2); const b = slot(i); if (v > b.t) b.t = v; }
        }
      }
      for (const [i, b] of best) { const a = acc.get(i) || { s: 0, n: 0, m: 0 }; a.s += b.n + b.t; if (b.n) a.n++; a.m++; acc.set(i, a); }
    }
    const phrase = words(query).filter((w) => !STOP.has(w)).join(' ');
    const res = [];
    for (const [i, a] of acc) {
      const doc = this.docs[i];
      let score = a.s * (0.5 + (0.5 * a.m) / groups.length) + 6 * (a.n / groups.length);
      if (a.n === groups.length) score += 8;
      if (doc.ruNorm && doc.ruNorm.length >= 5 && phrase.includes(doc.ruNorm)) score += 12;
      score -= 0.5 * Math.max(0, doc.ruTerms.size - a.n);
      if (doc.hidden) score *= 0.7;
      if (!doc.text) score *= 0.85;
      res.push({ doc, score });
    }
    res.sort((x, y) => y.score - x.score);
    return res.slice(0, limit).map((r) => ({ ...this._hit(r.doc), score: r.score, snippets: this._snippets(r.doc, terms) }));
  }

  _snippets(doc, terms, n = 2) {
    const t = doc.text;
    if (!t) return [];
    const out = [];
    for (const k of FIELD_KEYS) {
      if (!t[k]) continue;
      for (const s of fieldText(t[k]).split(/(?<=[.!?;])\s+/)) {
        let sc = 0;
        for (const w of words(s)) if (terms.has(stem(w))) sc++;
        if (sc) out.push({ key: k, label: FIELD_RU[k], text: s.trim(), sc });
      }
    }
    out.sort((a, b) => b.sc - a.sc);
    return out.slice(0, n).map(({ key, label, text }) => ({ key, label, text }));
  }

  /** Движение из каталога по словам запроса: первое слово названия (сгибание, отведение) обязано совпасть. */
  matchMovement(query, { loose = false } = {}) {
    const groups = queryGroups(query);
    if (!groups.length) return null;
    if (!this._mv) this._mv = this.data.movements.map((m) => ({ m, terms: words(m.ru).filter((w) => !STOP.has(w)).map(stem) }));
    const flat = groups.flat();
    const hit = (t) => flat.some((q) => q === t || (q.length >= 4 && t.startsWith(q)) || (t.length >= 4 && q.startsWith(t)));
    let best = null;
    for (const x of this._mv) {
      if (!x.terms.length || !hit(x.terms[0])) continue;
      const n = x.terms.filter(hit).length;
      if (n < (loose ? 1 : 2)) continue;
      const score = n + n / x.terms.length;
      if (!best || score > best.score) best = { mv: x.m, score };
    }
    return best;
  }
}

// ---------------------------------------------------------------- личные документы
/** Куски по 600-800 знаков: по абзацам, длинные абзацы по предложениям. */
export function chunkText(text, min = 600, max = 800) {
  const paras = String(text || '').replace(/\r/g, '').split(/\n{2,}/).map((s) => s.trim()).filter(Boolean);
  const out = [];
  let cur = '';
  const push = (p) => {
    if (!cur) cur = p;
    else if (cur.length + 2 + p.length <= max) cur += `\n\n${p}`;
    else { out.push(cur); cur = p; }
    if (cur.length >= min) { out.push(cur); cur = ''; }
  };
  for (const p of paras) {
    if (p.length <= max) { push(p); continue; }
    let part = '';
    for (const s of p.split(/(?<=[.!?…])\s+/)) {
      if (s.length > max) {
        if (part) { push(part); part = ''; }
        for (let i = 0; i < s.length; i += max) push(s.slice(i, i + max));
      } else if (part.length + 1 + s.length > max) { push(part); part = s; }
      else part = part ? `${part} ${s}` : s;
    }
    if (part) push(part);
  }
  if (cur) {
    const last = out[out.length - 1];
    if (last && cur.length < 200 && last.length + cur.length < max + 200) out[out.length - 1] = `${last}\n\n${cur}`;
    else out.push(cur);
  }
  return out;
}

const chunkCache = new Map();

function tfOf(text) {
  const m = new Map();
  for (const w of words(text)) {
    if (STOP.has(w) || w.length < 2) continue;
    const s = stem(w);
    m.set(s, (m.get(s) || 0) + 1);
  }
  return m;
}

/** Лучшие куски личных документов под запрос. */
export function searchDocs(docs, query, limit = 3, { skip = null, min = 0 } = {}) {
  const groups = queryGroups(query);
  if (!groups.length || !docs?.length) return [];
  const chunks = [];
  for (const doc of docs) {
    if (skip?.has(doc.id) || !doc.text) continue;
    const key = `${doc.id}:${doc.text.length}`;
    let list = chunkCache.get(key);
    if (!list) { list = chunkText(doc.text).map((text) => ({ text, tf: tfOf(text) })); chunkCache.set(key, list); }
    const title = tfOf(doc.title);
    for (const c of list) chunks.push({ doc, text: c.text, tf: c.tf, title });
  }
  if (!chunks.length) return [];
  const vocab = new Map();
  for (const c of chunks) for (const t of c.tf.keys()) vocab.set(t, (vocab.get(t) || 0) + 1);
  for (const c of chunks) for (const t of c.title.keys()) if (!vocab.has(t)) vocab.set(t, 1);
  const N = chunks.length;
  const exps = groups.map((g) => expand(g, vocab, null));
  const res = [];
  for (const c of chunks) {
    let score = 0, hit = 0;
    for (const exp of exps) {
      let best = 0;
      for (const [t, f] of exp) {
        const tf = c.tf.get(t) || 0, inTitle = c.title.has(t);
        if (!tf && !inTitle) continue;
        const idf = Math.log(1 + N / (vocab.get(t) || 1));
        const v = f * idf * ((tf * 2.2) / (tf + 1.2) + (inTitle ? 1.2 : 0));
        if (v > best) best = v;
      }
      if (best) { score += best; hit++; }
    }
    if (!hit) continue;
    score *= 0.6 + (0.4 * hit) / exps.length;
    if (score > min) res.push({ doc: c.doc, text: c.text, score });
  }
  res.sort((a, b) => b.score - a.score);
  return res.slice(0, limit);
}
