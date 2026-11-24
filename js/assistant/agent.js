// Логика ответа: команды показа в 3D без модели, поиск по атласу и личным данным, потоковый ответ модели или ответ из описаний атласа
import { FIELD_RU, FIELD_KEYS, fieldText, searchDocs, words, stem, normText } from './search.js';
import { PIN_LIMIT } from './profile.js';

export const SUGGESTIONS = [
  'Где находится седалищный нерв', 'Покажи пятый поясничный позвонок', 'Какие мышцы сгибают локоть',
  'Что иннервирует лучевой нерв', 'Покажи сгибание в коленном суставе', 'Что у меня с позвоночником',
];

const BUDGET_CHARS = 2500 * 3; // весь запрос до 2500 токенов, 1 токен на 3 знака
const MAX_ANSWER = 480;
const HISTORY = 6;
const CHIP_NAMES = { bones: 'Кости', joints: 'Суставы', muscles: 'Мышцы', nerves: 'Нервы', vessels: 'Сосуды', organs: 'Органы' };
const SIDE_SHORT = { L: 'слева', R: 'справа' };

const SYSTEM = 'Ты личный ассистент Степана по анатомии и его здоровью. Отвечай по-русски, коротко и по делу, обычно в 3-6 предложениях. '
  + 'Опирайся на данные атласа и личные данные Степана из контекста. Названия структур давай по-русски и в скобках по-латыни. '
  + 'Если нужного нет в контексте, отвечай из общих знаний анатомии спокойно и уверенно. '
  + 'Не добавляй предупреждений, оговорок и советов обратиться к врачу. Вместо длинного тире ставь дефис.';

const DEFAULT_KEYS = {
  muscles: ['action', 'innervation', 'origin', 'insertion'], bones: ['parts', 'articulations'], joints: ['type', 'motions', 'ligaments'],
  nerves: ['source', 'supplies', 'branches'], vessels: ['source', 'supplies', 'branches'], organs: ['parts', 'blood'],
};

const INTENTS = [
  [/иннерв/, ['innervation', 'supplies']],
  [/кровоснаб|кровоток|питает/, ['blood', 'supplies']],
  [/функци|делает|работа|сгиба|разгиба|отвод|привод|враща|поворач|поднима|опуска|действ|движени/, ['action', 'motions']],
  [/начин|начало|прикрепл|крепит/, ['origin', 'insertion']],
  [/(^|\s)где(\s|$)|располож|находит|лежит|проходит/, ['summary', 'parts', 'source']],
  [/ветв|отходит|отдает/, ['branches', 'source']],
  [/сочлен|соедин/, ['articulations', 'surfaces']],
  [/связк/, ['ligaments']],
  [/(^|\s)тип(\s|$)|вид сустава|форма сустава/, ['type']],
  [/снабжа/, ['supplies']],
  [/клиник|травм|болит|боль|поврежд|симптом|перелом|защем|грыж/, ['clinical']],
];

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);

const cut = (s, n) => {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const i = s.lastIndexOf(' ', n - 1);
  return `${s.slice(0, i > n * 0.6 ? i : n - 1).replace(/[\s,;:.-]+$/, '')}…`;
};
const firstSentence = (s) => { const m = String(s || '').match(/^[\s\S]+?[.!?](?=\s|$)/); return cut(m ? m[0] : s, 220); };
const nameLat = (ru, lat) => `**${ru}**${lat ? ` (${lat})` : ''}`;

// ---------------------------------------------------------------- разбор запроса
const prep = (s) => normText(s).replace(/[«»"“”„.,!?;:()]+/g, ' ').replace(/\s+/g, ' ').trim();
const FILLER = /^(а|ну|слушай|скажи|подскажи|пожалуйста|можешь|можно|давай|ассистент|мне)\s+/;
function strip(q) {
  let prev;
  do { prev = q; q = q.replace(FILLER, '').replace(/\s+пожалуйста$/, ''); } while (q !== prev);
  return q;
}

export const isPersonal = (q) => /(^|\s)(у меня|меня|мне|мой|моя|мое|мои|моего|моей|моих|моим|моему|мною|я|степан\S*)(\s|$)|мрт|анализ|диагноз|снимк|снимок|заключени|самочувств|жалоб/.test(q);
export const isLocation = (q) => /(^|\s)где(\s|$)|располож|находит|проходит|(^|\s)лежит/.test(q);

function sideOf(q) {
  if (/(^|\s)(лев\S*|слева)(?=\s|$)/.test(q)) return 'L';
  if (/(^|\s)(прав\S*|справа)(?=\s|$)/.test(q)) return 'R';
  return null;
}
const noSide = (q) => q.replace(/(^|\s)(лев(ый|ая|ое|ые|ого|ой|ую|ом|ых|ому)?|прав(ый|ая|ое|ые|ого|ой|ую|ом|ых|ому)?|слева|справа)(?=\s|$)/g, ' ').replace(/\s+/g, ' ').trim();

const SYS_STEMS = { кост: 'bones', скелет: 'bones', сустав: 'joints', связк: 'joints', мышц: 'muscles', мускулатур: 'muscles', нерв: 'nerves', сосуд: 'vessels', артер: 'vessels', вен: 'vessels', орган: 'organs', внутренн: 'organs' };
const LAYER_NOISE = new Set(['слой', 'слои', 'слоя', 'и', 'все', 'тоже', 'еще', 'мне']);
function layerSystems(t) {
  const ws = words(t).filter((w) => !LAYER_NOISE.has(w));
  if (!ws.length) return null;
  const out = new Set();
  for (const w of ws) { const id = SYS_STEMS[stem(w)]; if (!id) return null; out.add(id); }
  return [...out];
}

const MOVE_RE = /^(движени|сгибани|разгибани|отведени|приведени|вращени|ротаци|пронаци|супинаци|наклон|поворот|подъем|подняти|опускани|кругов|оппозици|тыльн|подошвенн|выдвижени|экстензи|флекси)/;

/** Команда показа или null. */
export function parseCommand(text) {
  const q = strip(prep(text));
  let m;
  if ((m = q.match(/^(?:покажи|покажите|запусти|включи)\s+(?:мне\s+)?движение(?:\s+(.+))?$/))) return { type: 'move', target: m[1] || '', q };
  if ((m = q.match(/^(?:включи|выключи|отключи|покажи|скрой|убери|спрячь|добавь)\s+(?:слой\s+|слои\s+)?(.+)$/))) {
    const systems = layerSystems(m[1]);
    if (systems) return { type: 'layer', on: /^(включи|покажи|добавь)/.test(q), systems, q };
  }
  if ((m = q.match(/^(?:покажи|покажите|запусти|открой)\s+(?:мне\s+)?(.+)$/)) && MOVE_RE.test(m[1])) return { type: 'move', target: m[1], q };
  if (/^(?:покажи|открой|включи)\s+(?:мне\s+)?(?:режим\s+)?(?:позвоночник|позвоночный столб|позвоночника)$/.test(q)) return { type: 'spine', q };
  if ((m = q.match(/^(?:изолируй|изолировать|оставь только)(?:\s+(.*))?$/))) return { type: 'isolate', target: m[1] || '', q };
  if ((m = q.match(/^(?:скрой|убери|спрячь|скрыть)(?:\s+(.*))?$/))) return { type: 'hide', target: m[1] || '', q };
  if ((m = q.match(/^где\s+(?:находится\s+|находятся\s+|расположен[аоы]?\s+|располагается\s+|располагаются\s+|лежит\s+|лежат\s+|проходит\s+|проходят\s+)?(.+)$/))) return { type: 'where', target: m[1], q };
  if ((m = q.match(/^(?:покажи|покажите|открой|откройте|найди|найдите|выдели|выделите|подсвети|подсветите|показать|найти)\s+(?:мне\s+)?(?:где\s+(?:находится\s+|находятся\s+)?)?(.+)$/))) {
    return { type: /(^|\s)где(\s|$)/.test(q) ? 'where' : 'show', target: m[1], q };
  }
  return null;
}

// позвонок по словам: «пятый поясничный позвонок», «L5», «Th12»
const ORD = [['одиннадцат', 11], ['двенадцат', 12], ['перв', 1], ['втор', 2], ['трет', 3], ['четверт', 4], ['пят', 5], ['шест', 6], ['седьм', 7], ['восьм', 8], ['девят', 9], ['десят', 10]];
const SEC = [['шейн', 'C'], ['грудн', 'Th'], ['поясничн', 'L']];
const ROMAN = ['', 'I', 'II', 'III', 'IV', 'V', 'VI', 'VII', 'VIII', 'IX', 'X', 'XI', 'XII'];
function vertebra(q, data) {
  const find = (label) => data.spine.find((v) => v.label === label)?.item || null;
  let sec = null, n = null;
  for (const w of q.split(' ')) {
    const s = SEC.find(([p]) => w.startsWith(p)); if (s) sec = s[1];
    const o = ORD.find(([p]) => w.startsWith(p)); if (o && n == null) n = o[1];
    if (/^\d{1,2}$/.test(w) && n == null) n = +w;
  }
  const code = q.match(/(?:^|\s)(th|c|с|t|т|l|л)\s?(\d{1,2})(?=\s|$)/);
  if (code) { sec = /^(c|с)$/.test(code[1]) ? 'C' : /^(l|л)$/.test(code[1]) ? 'L' : 'Th'; n = +code[2]; }
  if (!code && !/позвон/.test(q)) {
    if (/(^|\s)крест(ец|ца|цу|цом)(\s|$)/.test(q)) return find('S');
    if (/(^|\s)копчик/.test(q)) return find('Co');
    return null;
  }
  if (!sec || !n || n > 12) return null;
  return find(sec + ROMAN[n]);
}

function intentFields(text) {
  const q = normText(text), out = [];
  for (const [re, keys] of INTENTS) if (re.test(q)) for (const k of keys) if (!out.includes(k)) out.push(k);
  return out;
}

const orderKeys = (intent, sys) => [...new Set([...intent, 'summary', ...(DEFAULT_KEYS[sys] || []), ...FIELD_KEYS])];

function itemNames(data, ids) { return [...new Set(ids.map((id) => data.itemById.get(id)?.ru).filter(Boolean))]; }

function moveBlock(mv, data) {
  const ag = itemNames(data, mv.agonists), an = itemNames(data, mv.antagonists);
  return `Движение «${mv.ru}»${mv.jointName ? `, ${mv.jointName}` : ''}, амплитуда ${mv.range[0]}-${mv.range[1]}°\n`
    + `Агонисты: ${ag.join(', ') || 'нет данных'}\nАнтагонисты: ${an.join(', ') || 'нет данных'}`;
}

function structBlock(h, text) {
  const t = h.text || {};
  const lines = [`${h.ru}${h.lat ? ` (${h.lat})` : ''}${h.kind === 'group' ? ', группа структур' : h.items.length > 1 ? ', парная' : ''}`];
  for (const k of orderKeys(intentFields(text), h.system)) if (t[k]) lines.push(`${FIELD_RU[k]}: ${cut(fieldText(t[k]), k === 'summary' ? 320 : 220)}`);
  if (lines.length === 1) for (const s of h.snippets || []) lines.push(`${s.label}: ${cut(s.text, 220)}`);
  return cut(lines.join('\n'), 560);
}

function alternate(list) {
  const out = [];
  for (const m of list) {
    if (!out.length && m.role !== 'user') continue;
    if (out.length && out[out.length - 1].role === m.role) out[out.length - 1] = m;
    else out.push(m);
  }
  if (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

const DISCLAIM = /[^.!?\n]*(не (являюсь|заменя\S*)|обрат\S* к (врач|специалист)\S*|консультац\S* (врача|специалиста)|проконсультир\S*|не врач|языков\S* модел\S*|искусственн\S* интеллект\S*)[^.!?\n]*[.!?]?/gi;
const tidy = (t) => String(t || '').replace(/[—–]/g, '-');
const tidyModel = (t) => tidy(t).replace(DISCLAIM, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').replace(/^\s+/, '');

const hitChip = (data, h) => ({ kind: h.kind, id: h.id, ids: h.ids, label: h.ru, sub: h.kind === 'group' ? 'группа' : '', color: data.systemById.get(h.system)?.color || '' });
/** Миофасциальная линия по словам запроса: совпадение по началам слов названия. */
function findLine(data, text) {
  const cut = (s) => (String(s).toLowerCase().replace(/ё/g, 'е').match(/[а-я]+/g) || []).filter((w) => !/^(лини|миофасц|меридиан|покаж|откро)/.test(w)).map((w) => w.slice(0, 5));
  const q = cut(text);
  let best = null, top = 0;
  for (const l of data.lines || []) {
    const name = cut(l.ru);
    const hits = name.filter((w) => q.includes(w)).length;
    const score = hits === name.length ? 10 + hits : hits;
    if (score > top) { top = score; best = l; }
  }
  return best;
}
const moveChip = (mv) => ({ kind: 'move', id: mv.id, ids: [], label: mv.ru, sub: 'движение', color: '' });
const itemChip = (data, id) => { const it = data.itemById.get(id); return it ? { kind: 'item', id, ids: [id], label: it.ru, sub: it.side ? SIDE_SHORT[it.side] : '', color: data.systemById.get(it.system)?.color || '' } : null; };
function uniqChips(list) {
  const seen = new Set(), out = [];
  for (const c of list) { if (!c) continue; const k = `${c.kind}:${c.id}`; if (seen.has(k)) continue; seen.add(k); out.push(c); }
  return out;
}

const pack = (m) => ({ id: m.id, role: m.role, text: m.text || '', chips: m.chips || [], hint: m.hint || null, status: m.status === 'stopped' ? 'stopped' : 'done', at: m.at });

// ---------------------------------------------------------------- агент
export class Agent {
  constructor(app, { llm, search, profile }) {
    this.app = app; this.llm = llm; this.search = search; this.profile = profile;
    this.messages = []; this.run = null;
  }

  async load() {
    const saved = (await this.profile.loadDialog()).filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.text === 'string').map(pack);
    const ids = new Set(saved.map((m) => m.id));
    this.messages = [...saved, ...this.messages.filter((m) => !ids.has(m.id))];
  }

  async newDialog() {
    this.stop();
    this.messages = [];
    await this.profile.clearDialog();
  }

  get busy() { return !!this.run; }

  stop() {
    if (this.run) this.run.stopped = true;
    this.llm.stop();
  }

  historyFor() {
    return this.messages.filter((m) => m.text && (m.role === 'user' || m.role === 'assistant')).slice(-HISTORY);
  }

  /** Ответ на вопрос. onMessage(сообщение) на каждое изменение, onDelta(кусок текста) для озвучки. */
  async ask(text, { onMessage = () => {}, onDelta = () => {} } = {}) {
    const run = (this.run = { stopped: false });
    const history = this.historyFor();
    const user = { id: uid(), role: 'user', text: String(text).trim(), at: Date.now() };
    const bot = { id: uid(), role: 'assistant', text: '', chips: [], hint: null, status: 'thinking', at: Date.now() };
    this.messages.push(user, bot);
    onMessage(user); onMessage(bot);
    const hooks = {
      run, history,
      set: (patch) => { Object.assign(bot, patch); onMessage(bot); },
      say: (t) => { if (!t) return; const add = bot.text ? `\n\n${t}` : t; bot.text = tidy(bot.text + add); onDelta(add); onMessage(bot); },
      stream: (d) => { bot.raw = (bot.raw || '') + d; bot.text = tidy(bot.raw).replace(/^\s+/, ''); onDelta(d); onMessage(bot); },
    };
    try { await this.answer(user.text, bot, hooks); }
    catch (err) { console.error(err); if (!bot.text) bot.text = 'Не получилось ответить. Попробуйте ещё раз'; }
    if (bot.raw) bot.text = tidyModel(bot.raw); // оговорки и тире чистятся один раз по готовому тексту
    delete bot.raw; delete bot.progress;
    bot.status = run.stopped ? 'stopped' : 'done';
    bot.text = bot.text.trim();
    if (this.run === run) this.run = null;
    onMessage(bot);
    this.profile.saveDialog(this.messages.map(pack));
    return bot;
  }

  async answer(text, bot, { run, history, set, say, stream }) {
    const S = this.search, data = this.app.data;
    const q = prep(text);

    // шаг 1: команды выполняются сразу, без модели
    const cmd = parseCommand(text);
    let shown = null, showFirst = false;
    if (cmd) {
      const r = await this.exec(cmd);
      if (r?.chips) bot.chips = uniqChips(r.chips);
      if (r?.done) { say(r.text); return; }
      shown = r?.shown || null;
      showFirst = !shown && ['show', 'where', 'isolate'].includes(cmd.type);
    }
    if (run.stopped) return;

    // шаг 2: поиск по атласу и личным данным
    set({ status: 'search' });
    const personal = isPersonal(q);
    let hits = [];
    try { hits = await S.search(text, 6); } catch (err) { console.warn('Поиск по атласу не удался', err); }
    const top = hits[0]?.score || 0;
    hits = hits.filter((h) => h.score >= Math.max(2, top * 0.35)).slice(0, 5);
    if (shown) { shown = S.hitFor(shown.id) || shown; hits = [shown, ...hits.filter((h) => h.id !== shown.id)].slice(0, 5); }
    const mv = S.matchMovement(text)?.mv || null;
    await this.profile.init();
    const pin = this.profile.pinned();
    const skip = pin && pin.text.length <= PIN_LIMIT ? new Set([pin.id]) : null;
    const docs = searchDocs(this.profile.list(), text, 3, { skip, min: personal ? 0 : 1.5 });
    if (!shown && !personal && (showFirst || isLocation(q)) && hits[0]) shown = this.showHit(hits[0], sideOf(q));
    bot.chips = uniqChips([...bot.chips, mv && moveChip(mv), ...hits.map((h) => hitChip(data, h))]).slice(0, 6);
    set({});
    if (run.stopped) return;
    const ctx = { text, history, hits, docs, pin, mv, personal };

    // шаг 3: модель, если скачана
    if (this.llm.supported && (this.llm.ready || (await this.llm.isCached()))) {
      try {
        if (!this.llm.ready) {
          set({ status: 'loading', progress: 0 });
          await this.llm.load((p) => { if (bot.status === 'loading') set({ progress: p }); });
        }
        if (run.stopped) return;
        const messages = this.prompt(ctx);
        set({ status: 'stream', progress: null, source: 'model' });
        await this.llm.chat(messages, { maxTokens: MAX_ANSWER, onDelta: (d) => { if (!run.stopped) stream(d); } });
        return;
      } catch (err) {
        console.warn('Модель не ответила', err);
        if (run.stopped || bot.text) return;
        bot.hint = `Модель не ответила, ответ собран из атласа · ${String(err?.message || err || '').replace(/\s+/g, ' ').slice(0, 140)}`;
      }
    }
    if (run.stopped) return;
    say(this.local(ctx));
    bot.source = 'atlas';
    if (!bot.hint && this.llm.supported) bot.hint = 'model';
  }

  // ---------- команды ----------
  async exec(cmd) {
    const app = this.app, data = app.data, S = this.search;

    if (cmd.type === 'layer') {
      const ids = cmd.systems.filter((id) => data.systemById.has(id));
      if (!ids.length) return { done: true, text: 'Такого слоя в атласе нет' };
      app.setTab('atlas');
      if (cmd.on && app.s.mode !== 'atlas') app.exitMode();
      app.act((s) => { for (const id of ids) { if (cmd.on) s.systems.add(id); else s.systems.delete(id); } if (cmd.on) s.isolated = null; });
      const names = ids.map((id) => `«${CHIP_NAMES[id] || data.systemById.get(id)?.ru || id}»`);
      const many = names.length > 1;
      return { done: true, text: `${many ? 'Слои' : 'Слой'} ${names.join(', ')} ${cmd.on ? (many ? 'включены' : 'включён') : (many ? 'выключены' : 'выключен')}` };
    }

    if (cmd.type === 'spine') {
      app.setTab('atlas');
      app.enterSpine();
      return { done: true, text: 'Открыл режим позвоночника. Позвонки переключаются на ленте слева' };
    }

    if (cmd.type === 'move') {
      const hit = cmd.target ? S.matchMovement(cmd.target, { loose: true }) : null;
      if (!hit) {
        if (!cmd.target || /^движени\S*$/.test(cmd.target)) { app.setTab('moves'); return { done: true, text: 'Открыл список движений' }; }
        return null;
      }
      const mv = hit.mv, side = sideOf(cmd.q);
      const idx = side ? Math.max(0, mv.variants.findIndex((v) => v.side === side)) : 0;
      const v = mv.variants[idx] || mv;
      app.openMovement(mv.id, idx);
      app.startPlay();
      const ag = itemNames(data, v.agonists), an = itemNames(data, v.antagonists);
      let text = `${nameLat(mv.ru)}${mv.jointName ? `, ${mv.jointName.toLowerCase()}` : ''}. Движение запущено: агонисты подсвечены красным, антагонисты синим`;
      if (ag.length) text += `\nАгонисты: ${ag.join(', ')}`;
      if (an.length) text += `\nАнтагонисты: ${an.join(', ')}`;
      return { done: true, text, chips: [moveChip(mv), ...v.agonists.slice(0, 4).map((id) => itemChip(data, id))] };
    }

    if ((cmd.type === 'hide' || cmd.type === 'isolate') && !cmd.target) {
      const id = app.s.selected;
      if (!id) return { done: true, text: 'Сначала выберите структуру в атласе' };
      const it = app.item(id);
      app.setTab('atlas');
      if (cmd.type === 'hide') app.hide(); else if (!app.s.isolated) app.isolate();
      return { done: true, text: `${cmd.type === 'hide' ? 'Скрыл' : 'Изолировал'}: ${nameLat(it.ru, it.lat)}` };
    }

    const target = cmd.target || '';
    const line = cmd.type !== 'hide' && /лини|меридиан/i.test(target) ? findLine(data, target) : null;
    if (line) {
      app.openLine(line.id);
      return { done: true, text: `${line.ru}. Показал в атласе${line.summary ? `\n${firstSentence(line.summary)}` : ''}`, chips: [{ kind: 'line', id: line.id, ids: [], label: line.ru, sub: 'линия', color: '#35d6c1' }] };
    }
    const vt = vertebra(target, data);
    const hit = vt ? S.hitFor(vt.id) : S.resolve(noSide(target));
    if (!hit) return { shown: null };
    const side = sideOf(target);

    if (cmd.type === 'hide') {
      let ids = hit.kind === 'group' ? data.groupItems(hit.id).map((it) => it.id) : hit.ids;
      if (side && hit.items.length > 1) ids = hit.items.filter((it) => it.side === side).map((it) => it.id);
      app.setTab('atlas');
      app.act((s) => { for (const id of ids) { s.hidden.add(id); s.pinned.delete(id); s.isolated?.delete(id); if (s.selected === id) s.selected = null; } });
      return { done: true, text: `Скрыл: ${nameLat(hit.ru, hit.lat)}. Вернуть можно кнопкой «Назад»` };
    }

    const shown = this.showHit(hit, side, { isolate: cmd.type === 'isolate' });
    const chips = [hitChip(data, hit)];
    if (cmd.type === 'where') return { shown, chips };
    const t = await this.textOf(hit);
    const lead = t?.summary ? firstSentence(t.summary) : '';
    const count = hit.kind === 'group' ? data.groupItems(hit.id).length : 0;
    const verb = cmd.type === 'isolate' ? 'Изолировал в атласе' : hit.kind === 'group' ? `Показал группу в атласе, структур: ${count}` : 'Показал в атласе';
    return { done: true, shown, chips, text: `${nameLat(hit.ru, hit.lat)}. ${verb}${lead ? `\n${lead}` : ''}` };
  }

  textOf(hit) {
    if (hit.text !== undefined) return Promise.resolve(hit.text);
    return Promise.race([this.app.data.text(hit.ref).catch(() => null), new Promise((r) => setTimeout(() => r(null), 900))]);
  }

  // ---------- показ в 3D через методы приложения ----------
  showHit(hit, side = null, { isolate = false } = {}) {
    if (hit.kind === 'group') { this.app.openGroup(hit.id); return hit; }
    let ids = hit.ids.slice();
    if (side && hit.items.length > 1) { const one = hit.items.find((it) => it.side === side); if (one) ids = [one.id]; }
    this.showIds(ids, { isolate });
    return hit;
  }

  showIds(ids, { isolate = false } = {}) {
    const app = this.app;
    const primary = ids.length > 1 ? (ids.find((id) => app.item(id)?.side === 'R') || ids[0]) : ids[0];
    app.setTab('atlas');
    if (!isolate && app.s.mode === 'spine' && app.data.spineIds.has(primary)) { app.spineGo(primary); return; }
    app.stopPlay();
    app.act((s) => {
      s.mode = 'atlas'; s.selected = primary;
      if (isolate) { s.isolated = new Set(ids); s.isoLabel = ''; s.isoGroup = null; s.fade = false; }
      else if (s.isolated && !ids.every((id) => s.isolated.has(id))) s.isolated = null;
      for (const id of ids) { s.hidden.delete(id); const it = app.item(id); if (it && !app.baseVisible(it)) s.pinned.add(id); }
    });
    app.pushRecent(primary);
    app.viewer.focus(ids, { pad: ids.length > 1 ? 1.25 : 1.9 });
  }

  openChip(chip) {
    const app = this.app;
    if (chip.kind === 'move') { if (app.data.movementById.has(chip.id)) { app.openMovement(chip.id); app.startPlay(); } return; }
    if (chip.kind === 'line') { app.openLine(chip.id); return; }
    if (chip.kind === 'group') { app.openGroup(chip.id); return; }
    const ids = (chip.ids?.length ? chip.ids : [chip.id]).filter((id) => app.item(id));
    if (ids.length) this.showIds(ids);
  }

  // ---------- запрос к модели ----------
  prompt({ text, history, hits, docs, pin, mv }) {
    const data = this.app.data;
    let atlas = mv ? `${moveBlock(mv, data)}\n\n` : '';
    for (const h of hits) { const b = structBlock(h, text); if (atlas.length + b.length > 2300) break; atlas += `${b}\n\n`; }
    let mine = pin ? `Главное («${pin.title}»):\n${cut(pin.text, PIN_LIMIT)}\n\n` : '';
    const docCap = pin ? 1600 : 2400;
    let docLen = 0;
    for (const d of docs) {
      const b = `Из документа «${d.doc.title}»:\n${cut(d.text, 800)}\n\n`;
      if (docLen + b.length > docCap) break;
      docLen += b.length; mine += b;
    }
    let ctx = '';
    if (atlas) ctx += `Данные атласа:\n${atlas}`;
    if (mine) ctx += `Личные данные Степана:\n${mine}`;
    const tail = `Вопрос: ${cut(text, 600)}`;
    const room = BUDGET_CHARS - SYSTEM.length - tail.length - 60;
    if (ctx.length > room) ctx = cut(ctx, Math.max(0, room));
    const user = `${ctx ? `${ctx.trim()}\n\n` : ''}${tail}`;
    let used = SYSTEM.length + user.length + 40;
    const hist = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i], t = cut(m.text, m.role === 'assistant' ? 500 : 300);
      if (used + t.length + 16 > BUDGET_CHARS) break;
      used += t.length + 16;
      hist.unshift({ role: m.role, content: t });
    }
    const msgs = alternate(hist);
    msgs.push({ role: 'user', content: user });
    // у Gemma нет отдельной системной роли: инструкция идёт в начало первой реплики
    if (/^gemma/i.test(this.llm.loadedId || this.llm.modelId)) msgs[0] = { role: 'user', content: `${SYSTEM}\n\n${msgs[0].content}` };
    else msgs.unshift({ role: 'system', content: SYSTEM });
    return msgs;
  }

  // ---------- ответ без модели ----------
  local({ text, hits, docs, pin, mv, personal }) {
    const data = this.app.data, intent = intentFields(text), out = [];
    if (personal) {
      if (docs.length) out.push(`**Из ваших данных**\n${docs.slice(0, 2).map((d) => `«${d.doc.title}»: ${cut(d.text.replace(/\s+/g, ' '), 360)}`).join('\n')}`);
      else if (pin) out.push(`**Из ваших данных** («${pin.title}»)\n${cut(pin.text, 500)}`);
      else out.push('Личных документов пока нет. Добавьте их в настройках ассистента, раздел «Мои данные»');
    }
    if (mv) {
      const ag = itemNames(data, mv.agonists), an = itemNames(data, mv.antagonists);
      const lines = [`**${mv.ru}**`];
      if (ag.length) lines.push(`Агонисты: ${ag.join(', ')}`);
      if (an.length) lines.push(`Антагонисты: ${an.join(', ')}`);
      if (lines.length > 1) out.push(lines.join('\n'));
    }
    const top = hits[0];
    if (top) {
      const t = top.text || {};
      const lines = [nameLat(top.ru, top.lat)];
      if (t.summary) lines.push(t.summary);
      const keys = (intent.length ? intent : DEFAULT_KEYS[top.system] || []).filter((k) => k !== 'summary' && t[k]).slice(0, 3);
      for (const k of keys) lines.push(`${FIELD_RU[k]}: ${fieldText(t[k])}`);
      if (lines.length === 1) for (const s of top.snippets || []) lines.push(`${s.label}: ${s.text}`);
      out.push(lines.join('\n'));
      const more = hits.slice(1, 3).filter((h) => h.text?.summary);
      if (more.length) out.push(`Ещё по теме:\n${more.map((h) => `- ${nameLat(h.ru, h.lat)} - ${firstSentence(h.text.summary)}`).join('\n')}`);
    }
    if (!out.length) out.push('В атласе по этому вопросу ничего не нашлось. Попробуйте назвать структуру по-другому или по-латыни');
    return out.join('\n\n');
  }
}
