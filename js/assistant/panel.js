// Экран «Ассистент»: чат, голос, настройки и мини-ассистент поверх сцены на вкладке «Атлас»
import { $, esc, toast, md } from '../ui.js';
import { icon } from '../icons.js';
import { Llm, MODEL_IDS, MODEL_NAMES, MODEL_MB, IS_IOS, fmtGB } from './llm.js';
import { AtlasSearch } from './search.js';
import { Profile } from './profile.js';
import { Recorder, Asr, Speaker, PIPER_VOICES, PIPER_MB } from './voice.js';
import { Agent, SUGGESTIONS } from './agent.js';

const fmtSize = (b) => (b >= 1073741824 ? `${(b / 1073741824).toFixed(1).replace('.', ',')} ГБ` : b >= 1048576 ? `${Math.round(b / 1048576)} МБ` : `${Math.max(1, Math.round(b / 1024))} КБ`);
const fmtDate = (t) => { try { return new Date(t).toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }); } catch (e) { return ''; } };
const plural = (n, one, few, many) => { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; };
const fmtChars = (n) => `${n.toLocaleString('ru-RU')} ${plural(n, 'знак', 'знака', 'знаков')}`;
const guessTitle = (t) => String(t || '').split('\n').map((s) => s.replace(/^#+\s*/, '').trim()).find(Boolean)?.slice(0, 60) || 'Заметка';

/** Лёгкий Markdown для ответов: абзацы, списки, жирный и курсив. */
function fmt(text) {
  const inline = (s) => esc(s)
    .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=$|[\s).,;:!?])/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,;:!?])/g, '$1<i>$2</i>');
  const out = [];
  let list = null, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const endList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const raw of String(text || '').split('\n')) {
    const line = raw.trimEnd();
    const ul = line.match(/^\s*[-*•]\s+(.*)$/), ol = line.match(/^\s*\d+[.)]\s+(.*)$/), h = line.match(/^\s*#{1,4}\s+(.*)$/);
    if (ul || ol) {
      flush();
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { endList(); out.push(`<${tag}>`); list = tag; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
    } else if (h) { flush(); endList(); out.push(`<p><b>${inline(h[1])}</b></p>`); }
    else if (!line.trim()) { flush(); endList(); }
    else { endList(); para.push(line.trim()); }
  }
  flush(); endList();
  return out.join('');
}

const TYPING = '<i></i><i></i><i></i>';

export class AssistantPanel {
  constructor(app) {
    this.app = app;
    this.el = $('#panel-assistant');
    this.setEl = $('#panel-assist-settings');
    this.llm = new Llm();
    this.search = new AtlasSearch(app.data);
    this.profile = new Profile();
    this.asr = new Asr();
    // на iPhone распознавание не запускается, пока модель ответов занимает память: сначала распознавание, потом модель
    const asrEnsure = this.asr.ensure.bind(this.asr);
    this.asr.ensure = () => {
      if (this.asr._ready) return asrEnsure();
      if (this._asrSeq) return this._asrSeq;
      if (!(this.llm.usable && (this.llm.ready || this.llm.state === 'loading'))) return asrEnsure();
      this._asrSeq = (async () => {
        try { await this.llm._loading; } catch (e) { /* загрузка модели сорвалась */ }
        await this.llm.unload();
        try { await asrEnsure(); } finally { this._asrSeq = null; if (this.llm.usable) this.llm.load().catch(() => {}); }
      })();
      return this._asrSeq;
    };
    this.rec = new Recorder();
    this.speaker = new Speaker();
    this.agent = new Agent(app, { llm: this.llm, search: this.search, profile: this.profile });
    this.busy = false; this.recording = null; this.transcribing = null;
    this.view = 'main'; this.mini = null; this.models = null; this.cached = new Map();
    this.dirty = new Map(); this._raf = 0; this._llmLoading = false;

    this.build();
    this.bindViewport();
    this.initMini();
    this.llm.on(() => this.onLlm());
    this.asr.on(() => this.onAsr());
    this.speaker.on(() => this.onSpeaker());
    this.profile.persist();
    this.profile.init().then(() => this.agent.load()).catch(() => {}).then(() => this.renderLog());
    this.updateStatus();
  }

  // ---------------------------------------------------------------- разметка чата
  build() {
    this.el.innerHTML = `<div class="chat">
      <header class="chat-head"><div class="chat-title"><h1>Ассистент</h1><p id="chat-status"></p></div>
        <button class="icon-btn" data-act="new" aria-label="Новый диалог">${icon('compose', 21)}</button>
        <button class="icon-btn" data-act="settings" aria-label="Настройки ассистента">${icon('sliders', 21)}</button></header>
      <div class="chat-log" id="chat-log"></div>
      <div class="composer-note" id="chat-note" hidden></div>
      <form class="composer" id="chat-form" autocomplete="off">
        <button type="button" class="cbtn" id="chat-mic" aria-label="Спросить голосом">${icon('mic', 22)}</button>
        <label class="composer-field"><textarea id="chat-input" rows="1" enterkeyhint="send" placeholder="Спросите про анатомию" aria-label="Вопрос ассистенту"></textarea></label>
        <button type="submit" class="cbtn send" id="chat-send" aria-label="Отправить">${icon('send', 22)}</button>
      </form></div>`;
    this.log = $('#chat-log'); this.input = $('#chat-input'); this.note = $('#chat-note');
    this.micBtn = $('#chat-mic'); this.sendBtn = $('#chat-send'); this.head = this.el.querySelector('.chat-head');
    $('#chat-form').addEventListener('submit', (e) => { e.preventDefault(); this.onSend(); });
    this.input.addEventListener('input', () => this.autosize());
    this.input.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); this.onSend(); } });
    this.micBtn.addEventListener('click', () => this.onMic('chat'));
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.log.addEventListener('scroll', () => this.head.classList.toggle('line', this.log.scrollTop > 4), { passive: true });
    this.setEl.addEventListener('click', (e) => this.onSettingsClick(e));
    this.setEl.addEventListener('change', (e) => this.onSettingsChange(e));
  }

  /** Клавиатура iOS: панель чата занимает ровно видимую часть экрана, нижняя панель вкладок прячется. */
  bindViewport() {
    const vv = window.visualViewport, root = $('#app');
    const update = () => {
      const h = vv ? vv.height : window.innerHeight, top = vv ? vv.offsetTop : 0;
      root.style.setProperty('--vv-h', `${Math.round(h)}px`);
      root.style.setProperty('--vv-top', `${Math.max(0, Math.round(top))}px`);
      const kb = window.innerHeight - h > 140;
      if (kb !== root.classList.contains('kb')) {
        root.classList.toggle('kb', kb);
        if (kb && this.app.tab === 'assistant') requestAnimationFrame(() => this.scrollEnd());
      }
    };
    vv?.addEventListener('resize', update);
    vv?.addEventListener('scroll', update);
    window.addEventListener('resize', update);
    update();
    this.input.addEventListener('blur', () => setTimeout(() => { if (!root.classList.contains('kb')) window.scrollTo(0, 0); }, 80));
  }

  autosize() {
    this.input.style.height = 'auto';
    this.input.style.height = `${Math.min(132, Math.max(24, this.input.scrollHeight))}px`;
  }

  /** Вкладка открыта. */
  open() {
    this.updateStatus(); this.updateButtons(); this.updateNote();
    if (!this.log.firstElementChild) this.renderLog();
    requestAnimationFrame(() => this.scrollEnd());
    const first = this.asr.cached && this.asr.state === 'idle' ? this.asr.ensure().catch(() => {}) : Promise.resolve();
    if (!this.llm.usable) return;
    Promise.all([first, this.refreshCached()]).then(() => {
      // скачанная модель прогревается заранее, чтобы первый ответ шёл без ожидания
      if (this.llm.usable && !this.llm.crashed && this.cached.get(this.llm.modelId) && this.llm.state === 'idle') {
        this.llm.load().catch(() => {});
      }
    });
  }

  async refreshCached() {
    if (!this.llm.supported) return;
    await Promise.all(MODEL_IDS.map(async (id) => this.cached.set(id, await this.llm.isCached(id))));
    this.updateStatus();
  }

  updateStatus() {
    const el = $('#chat-status');
    if (!el) return;
    const l = this.llm, name = MODEL_NAMES[l.modelId] || l.modelId;
    let t = 'Ответы из атласа и ваших данных', on = false;
    if (l.usable) {
      if (l.state === 'loading') t = `Загрузка модели ${Math.round(l.progress * 100)}%`;
      else if (l.ready) { t = `${name} · работает на устройстве`; on = true; }
      else if (this.cached.get(l.modelId)) t = `${name} · скачана`;
      else t = 'Без модели · ответы из атласа';
    }
    el.textContent = t;
    el.classList.toggle('on', on);
  }

  // ---------------------------------------------------------------- лента сообщений
  scrollEnd() { this.log.scrollTop = this.log.scrollHeight; }
  nearEnd() { return this.log.scrollHeight - this.log.scrollTop - this.log.clientHeight < 90; }

  emptyHtml() {
    return `<div class="chat-empty"><div class="hello"><span class="hello-ic">${icon('assistant', 28)}</span>
        <h2>Спросите про анатомию или своё здоровье</h2>
        <p>Ассистент покажет структуру в 3D, ответит по атласу и вашим документам. Можно спрашивать голосом</p></div>
      <div class="suggest">${SUGGESTIONS.map((s) => `<button data-act="suggest">${esc(s)}</button>`).join('')}</div></div>`;
  }

  renderLog() {
    const list = this.agent.messages;
    this.log.innerHTML = list.length ? list.map((m) => this.msgWrap(m)).join('') : this.emptyHtml();
    this.head.classList.remove('line');
    this.scrollEnd();
  }

  msgWrap(m) { return `<div class="msg ${m.role === 'user' ? 'user' : 'bot'}" data-id="${esc(m.id)}">${this.msgHtml(m)}</div>`; }

  statusLabel(m) {
    if (m.status === 'search') return 'Ищу в атласе';
    if (m.status === 'loading') return `Загрузка модели ${Math.round((m.progress || 0) * 100)}%`;
    return '';
  }

  chipHtml(c, mid, i) {
    const mark = c.color ? `<i class="dot" style="--c:${esc(c.color)}"></i>` : c.kind === 'move' ? icon('moves', 16) : '';
    return `<button class="mchip" data-act="chip" data-mid="${esc(mid)}" data-i="${i}">${mark}<span>${esc(c.label)}</span>${c.sub ? `<em>${esc(c.sub)}</em>` : ''}</button>`;
  }

  chipsHtml(m) { return m.chips?.length ? `<div class="msg-chips">${m.chips.map((c, i) => this.chipHtml(c, m.id, i)).join('')}</div>` : ''; }

  hintHtml(m) {
    if (!m.hint) return '';
    if (!this.llm.enabled && (m.hint === 'model' || String(m.hint).startsWith('Модель не ответила'))) return '';
    if (m.hint === 'model') return '<p class="msg-hint">Для развёрнутых ответов скачайте модель <button data-act="settings">в настройках</button></p>';
    return `<p class="msg-hint">${esc(m.hint)}</p>`;
  }

  msgHtml(m) {
    if (m.role === 'user') return `<div class="bubble">${esc(m.text)}</div>`;
    const busy = m.status && m.status !== 'done' && m.status !== 'stopped';
    let html = '';
    if (m.text) html += `<div class="bubble">${fmt(m.text)}${busy ? '<i class="caret"></i>' : ''}</div>`;
    else if (busy) { const s = this.statusLabel(m); html += `<div class="bubble typing">${s ? `<span>${esc(s)}</span>` : ''}${TYPING}</div>`; }
    else html += '<div class="bubble muted">Ответ остановлен</div>';
    html += this.chipsHtml(m);
    if (!busy) {
      html += this.hintHtml(m);
      if (m.text) html += `<div class="msg-tools"><button class="msg-tool" data-act="say" data-id="${esc(m.id)}" aria-label="Озвучить ответ">${icon('speaker', 18)}</button>${m.status === 'stopped' ? '<span>Остановлено</span>' : ''}</div>`;
    }
    return html;
  }

  queueRender(m) {
    this.dirty.set(m.id, m);
    if (this._raf) return;
    this._raf = requestAnimationFrame(() => {
      this._raf = 0;
      const list = [...this.dirty.values()];
      this.dirty.clear();
      for (const x of list) this.updateMsg(x);
    });
  }

  updateMsg(m) {
    const near = this.nearEnd();
    const node = this.log.querySelector(`.msg[data-id="${CSS.escape(m.id)}"]`);
    if (node) node.innerHTML = this.msgHtml(m);
    else {
      this.log.querySelector('.chat-empty')?.remove();
      this.log.insertAdjacentHTML('beforeend', this.msgWrap(m));
    }
    if (near || m.role === 'user') this.scrollEnd();
  }

  // ---------------------------------------------------------------- вопрос и ответ
  onSend() {
    this.speaker.unlock();
    if (this.busy) { this.stop(); return; }
    const text = this.input.value.trim();
    if (!text) return;
    this.input.value = '';
    this.autosize();
    this.ask(text);
  }

  async ask(text, { mini = false } = {}) {
    text = String(text || '').trim();
    if (!text || this.busy) return;
    this.speaker.unlock();
    this.speaker.stop();
    this.busy = true;
    if (mini) this.mini = { q: text, bot: null };
    this.updateButtons();
    const tts = mini || this.speaker.enabled ? this.speaker.stream() : null;
    try {
      await this.agent.ask(text, { onMessage: (m) => this.onMessage(m, text), onDelta: (d) => tts?.push(d) });
    } catch (err) {
      console.error(err);
      toast('Ассистент не ответил');
    }
    tts?.end();
    this.busy = false;
    this.updateButtons();
    if (this.mini?.bot) this.renderMini();
  }

  onMessage(m, q) {
    this.queueRender(m);
    if (m.role !== 'assistant' || this.app.tab !== 'atlas') return;
    // ответ на вкладке «Атлас» показывается плашкой поверх сцены
    if (this.mini?.bot?.id !== m.id) { this.mini = { q, bot: m }; document.activeElement?.blur?.(); }
    this.renderMini();
  }

  stop() { this.agent.stop(); this.speaker.stop(); }

  async newDialog() {
    this.stop();
    await this.agent.newDialog();
    this.mini = null; this.renderMini();
    this.renderLog();
  }

  sayMsg(id) {
    if (this.speaker.speaking) { this.speaker.stop(); return; }
    const m = this.agent.messages.find((x) => x.id === id);
    const text = m?.speech || m?.text;
    if (!text) return;
    this.speaker.unlock();
    this.speaker.say(text);
  }

  openChip(b) {
    const m = this.agent.messages.find((x) => x.id === b.dataset.mid);
    const chip = m?.chips?.[+b.dataset.i];
    if (!chip) return;
    this.closeSettings();
    this.input.blur();
    this.agent.openChip(chip);
  }

  onClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const act = b.dataset.act;
    if (act === 'suggest') { this.speaker.unlock(); this.ask(b.textContent); }
    else if (act === 'settings') this.openSettings();
    else if (act === 'new') this.newDialog();
    else if (act === 'chip') this.openChip(b);
    else if (act === 'say') this.sayMsg(b.dataset.id);
  }

  // ---------------------------------------------------------------- голос
  async onMic(where) {
    this.speaker.unlock();
    if (this.recording) { this.finishRec(); return; }
    if (this.transcribing) return;
    if (this.speaker.speaking) { this.speaker.stop(); return; }
    if (this.busy) { this.stop(); return; }
    try {
      await this.rec.start({ onAuto: () => this.finishRec() });
    } catch (err) {
      console.warn(err);
      toast(err?.name === 'NotAllowedError' ? 'Нет доступа к микрофону. Разрешите его в настройках Safari' : 'Микрофон недоступен');
      return;
    }
    this.recording = where;
    if (where === 'mini') this.mini = { q: '', bot: null, note: 'listen' };
    this.updateButtons(); this.updateNote(); this.renderMini();
    this.asr.ensure().catch(() => {}); // модель распознавания грузится, пока идёт запись
  }

  async finishRec() {
    const where = this.recording;
    if (!where) return;
    this.recording = null;
    this.transcribing = where;
    if (where === 'mini') this.mini = { q: '', bot: null, note: 'asr' };
    this.updateButtons(); this.updateNote(); this.renderMini();
    let text = '';
    try {
      const audio = await this.rec.stop();
      if (audio) text = await this.asr.transcribe(audio);
      else toast('Запись слишком короткая');
    } catch (err) {
      console.warn(err);
      toast(this.asr.state === 'error' ? 'Модель распознавания не загрузилась' : 'Не удалось распознать речь');
    }
    this.transcribing = null;
    this.updateButtons(); this.updateNote();
    if (!text) { if (where === 'mini') { this.mini = null; this.renderMini(); } return; }
    if (where === 'mini') this.ask(text, { mini: true });
    else this.ask(text);
  }

  asrProgress() {
    const a = this.asr;
    if (a.state !== 'loading') return '';
    if (a.cached && (!a.loaded || !Math.round(a.progress * 100))) return '';
    return `Загрузка распознавания речи ${Math.round(a.progress * 100)}%${a.total ? ` · ${fmtSize(a.loaded)} из ${fmtSize(a.total)}` : ''}`;
  }

  noteText(where) {
    const load = this.asrProgress();
    if (this.recording === where) return load ? `Слушаю. ${load}` : 'Слушаю. Нажмите на микрофон ещё раз, чтобы закончить';
    if (this.transcribing === where) return load || 'Распознаю речь';
    return where === 'chat' ? load : '';
  }

  updateNote() {
    const t = this.noteText('chat');
    this.note.hidden = !t;
    this.note.textContent = t;
    if (this.mini?.note) this.renderMini();
  }

  updateButtons() {
    const recC = this.recording === 'chat', busyC = this.transcribing === 'chat';
    this.micBtn.classList.toggle('rec', recC);
    this.micBtn.classList.toggle('busy', busyC);
    this.micBtn.innerHTML = icon(recC ? 'stop' : this.speaker.speaking && !this.busy ? 'speaker' : 'mic', 22);
    this.micBtn.setAttribute('aria-label', recC ? 'Закончить запись' : this.speaker.speaking ? 'Остановить озвучку' : 'Спросить голосом');
    this.sendBtn.innerHTML = icon(this.busy ? 'stop' : 'send', 22);
    this.sendBtn.setAttribute('aria-label', this.busy ? 'Стоп' : 'Отправить');
    this.sendBtn.classList.toggle('stop', this.busy);
    const recM = this.recording === 'mini', busyM = this.transcribing === 'mini' || (this.busy && !!this.mini && !this.mini.bot?.text);
    this.miniBtn.classList.toggle('rec', recM);
    this.miniBtn.classList.toggle('busy', busyM && !recM);
    this.miniBtn.innerHTML = icon(recM ? 'stop' : this.busy ? 'stop' : this.speaker.speaking ? 'speaker' : 'mic', 24);
    this.miniBtn.setAttribute('aria-label', recM ? 'Закончить запись' : this.busy ? 'Остановить ответ' : this.speaker.speaking ? 'Остановить озвучку' : 'Спросить голосом');
    for (const t of this.el.querySelectorAll('.msg-tool[data-act="say"]')) t.classList.toggle('on', this.speaker.speaking);
  }

  // ---------------------------------------------------------------- мини-ассистент на вкладке «Атлас»
  initMini() {
    this.miniEl = $('#mini'); this.miniBtn = $('#mini-mic'); this.miniBox = $('#mini-reply');
    this.miniBtn.innerHTML = icon('mic', 24);
    this.miniEl.hidden = false;
    this.miniBtn.addEventListener('click', () => {
      if (!this.recording && !this.transcribing && this.busy) { this.stop(); return; }
      this.onMic('mini');
    });
    this.miniBox.addEventListener('click', (e) => {
      const b = e.target.closest('[data-act]');
      if (!b) return;
      if (b.dataset.act === 'mini-close') { if (this.busy) this.stop(); this.speaker.stop(); this.mini = null; this.renderMini(); }
      else if (b.dataset.act === 'chip') this.openChip(b);
      else if (b.dataset.act === 'settings') { this.app.setTab('assistant'); this.openSettings(); }
    });
  }

  renderMini() {
    const m = this.mini, box = this.miniBox;
    if (!m || (!m.note && !m.bot && !m.q)) { box.hidden = true; box.innerHTML = ''; this.updateButtons(); return; }
    const bot = m.bot;
    let a = '';
    if (!bot) {
      const t = this.noteText('mini') || (m.note === 'asr' ? 'Распознаю речь' : 'Слушаю');
      a = `<p class="mini-note">${esc(t)}</p>`;
    } else if (bot.text) a = fmt(bot.text);
    else if (bot.status === 'stopped') a = '<p class="mini-note">Ответ остановлен</p>';
    else { const s = this.statusLabel(bot); a = `<div class="bubble typing">${s ? `<span>${esc(s)}</span>` : ''}${TYPING}</div>`; }
    const done = bot && (bot.status === 'done' || bot.status === 'stopped');
    box.hidden = false;
    box.innerHTML = `<div class="mini-top"><span class="mini-q">${esc(m.q || (this.recording === 'mini' ? 'Голосовой вопрос' : 'Ассистент'))}</span>
      <button class="mini-x" data-act="mini-close" aria-label="Закрыть">${icon('x', 16)}</button></div>
      <div class="mini-a">${a}</div>${bot ? this.chipsHtml(bot) : ''}${done ? this.hintHtml(bot) : ''}`;
    box.scrollTop = box.scrollHeight;
    this.updateButtons();
  }

  // ---------------------------------------------------------------- настройки
  openSettings(view = 'main') {
    this.view = view;
    this.input.blur();
    this.setEl.classList.add('on');
    this.setEl.setAttribute('aria-hidden', 'false');
    this.renderSettings();
  }

  closeSettings() {
    if (!this.setEl.classList.contains('on')) return;
    this.setEl.classList.remove('on');
    this.setEl.setAttribute('aria-hidden', 'true');
    this.view = 'main';
  }

  async renderSettings() {
    if (this.view.startsWith('doc:')) return this.renderDoc(this.view.slice(4));
    if (this.view === 'paste') return this.renderPaste();
    return this.renderMain();
  }

  async renderMain() {
    const llm = this.llm;
    await this.profile.init();
    if (this.speaker.have.size) this.speaker.syncPiper();
    if (this.view !== 'main' || !this.setEl.classList.contains('on')) return;
    this.models = MODEL_IDS.map((id) => ({ id, name: MODEL_NAMES[id] || id, mb: MODEL_MB[id] || 0, available: true }));
    const docs = this.profile.list();
    const sc = this.setEl.querySelector('.panel-scroll')?.scrollTop || 0;
    const llmSub = IS_IOS
      ? 'На iPhone модель может не запуститься. Без неё ассистент отвечает по атласу и вашим документам'
      : 'Модель работает на этом устройстве';
    this.setEl.innerHTML = `<div class="panel-scroll">
      <header class="panel-head with-close"><button class="glass round" data-act="close" aria-label="Закрыть">${icon('x', 20)}</button><h1>Ассистент</h1>
        <p>Модель, распознавание речи и ваши данные хранятся только на этом устройстве</p></header>
      <h2 class="sec">Модель ответов</h2>
      <div class="list"><button class="row" data-act="llm-toggle" role="switch" aria-checked="${llm.enabled}">
        <span class="row-main"><span class="row-title">Отвечать с помощью модели</span><span class="row-lat plain">${llmSub}</span></span><span class="switch"></span></button></div>
      ${llm.supported ? '' : '<p class="note">В этом браузере нет WebGPU. Ассистент отвечает по атласу и вашим документам без модели</p>'}
      ${llm.enabled ? `<div class="list" id="as-models">${this.models.map((m) => this.modelRow(m)).join('')}</div>
      ${llm.crashed ? `<p class="note">Загрузка модели ${esc(MODEL_NAMES[llm.crashed] || '')} прервалась: телефону не хватило памяти. Для iPhone подходит Gemma 3 1B</p>
        <button class="btn small" data-act="purge">${icon('trash', 18)}<span>Удалить недокачанные файлы</span></button>` : ''}
      ${llm.failedId === llm.modelId ? '<p class="note">Эта модель загрузилась, но не смогла ответить на этом устройстве. Ассистент отвечает по атласу и вашим документам. Кнопка ниже запускает модель ещё раз</p>' : ''}
      <p class="note">Перед загрузкой закройте другие приложения. Модели тяжелее 1 ГБ на телефоне могут закрыть страницу</p>
      <div class="as-ctl" id="as-model">${this.modelCtl()}</div>` : ''}
      <p class="note" id="as-storage"></p>
      <h2 class="sec">Распознавание речи</h2>
      <div class="as-ctl" id="as-asr">${this.asrCtl()}</div>
      <h2 class="sec">Озвучка</h2>
      <div class="list"><button class="row" data-act="speak-toggle" role="switch" aria-checked="${this.speaker.enabled}"${this.speaker.ok ? '' : ' disabled'}>
        <span class="row-main"><span class="row-title">Озвучивать ответы</span><span class="row-lat plain" id="as-voice-label">${esc(this.speaker.voiceLabel())}</span></span><span class="switch"></span></button></div>
      <h2 class="sec">Голос</h2>
      <div class="list" id="as-voice">${this.voiceRows()}</div>
      <p class="note">Голоса Piper звучат естественнее системного и работают без сети, каждый около ${PIPER_MB} МБ. Если голос не сработал, ответ прочитает системный</p>
      <p class="note">Мини-ассистент на вкладке «Атлас» озвучивает ответы всегда. Нажатие на микрофон во время речи останавливает её</p>
      <h2 class="sec">Мои данные</h2>
      <div class="list">${docs.length ? docs.map((d) => this.docRow(d)).join('') : '<div class="empty small">Документов пока нет</div>'}</div>
      <div class="btn-row"><button class="btn small" data-act="import">${icon('upload', 18)}<span>Импорт</span></button>
        <button class="btn small" data-act="paste">${icon('paste', 18)}<span>Вставить</span></button>
        <button class="btn small" data-act="export"${docs.length ? '' : ' disabled'}>${icon('download', 18)}<span>Экспорт</span></button></div>
      <p class="note">Файлы .md, .txt и .json, можно несколько сразу. Закреплённый документ всегда идёт в запрос к модели целиком, до 1500 знаков. Сам закрепляется документ, чьё имя начинается с 00 или содержит «кратко»</p>
      <h2 class="sec">Приложение</h2>
      <button class="btn wide" data-act="app-update">${icon('reset', 20)}<span>Обновить приложение</span></button>
      <p class="note">Загружает свежую версию с сайта. Модели, голоса и ваши документы остаются на устройстве</p>
      <input type="file" id="as-file" multiple accept=".md,.markdown,.txt,.json,text/plain,text/markdown,application/json" hidden>
    </div>`;
    this.setEl.querySelector('.panel-scroll').scrollTop = sc;
    this.storageNote();
    if (llm.enabled && llm.supported) this.refreshCached().then(() => {
      if (this.view !== 'main' || !this.setEl.classList.contains('on')) return;
      const list = this.setEl.querySelector('#as-models');
      if (list) list.innerHTML = this.models.map((m) => this.modelRow(m)).join('');
      const ctl = this.setEl.querySelector('#as-model');
      if (ctl) ctl.innerHTML = this.modelCtl();
    });
  }

  modelRow(m) {
    const llm = this.llm, on = m.id === llm.modelId;
    const loaded = llm.loadedId === m.id && llm.state === 'ready';
    const sub = [m.mb ? fmtGB(m.mb) : '', loaded ? 'в памяти' : this.cached.get(m.id) ? 'скачана' : '', m.available ? '' : 'нет в этой версии библиотеки'].filter(Boolean).join(' · ');
    const off = !llm.supported || !m.available || llm.state === 'loading';
    return `<button class="row${on ? ' on' : ''}" data-act="model" data-id="${esc(m.id)}"${off ? ' disabled' : ''}><span class="radio">${on ? icon('check', 14) : ''}</span>
      <span class="row-main"><span class="row-title">${esc(m.name)}</span>${sub ? `<span class="row-lat plain">${esc(sub)}</span>` : ''}</span></button>`;
  }

  modelCtl() {
    const llm = this.llm;
    if (!llm.supported) return '';
    const m = this.models?.find((x) => x.id === llm.modelId), size = m?.mb ? fmtGB(m.mb) : '';
    if (llm.state === 'loading') {
      const k = Math.round(llm.progress * 100);
      return `<div class="progress"><i style="width:${Math.max(2, k)}%"></i></div>
        <p class="note">Загрузка ${k}%${m?.mb ? ` · ${fmtGB(m.mb * llm.progress)} из ${size}` : ''}. Держите приложение открытым до конца загрузки</p>`;
    }
    const err = llm.state === 'error' ? `<p class="note">Модель не загрузилась: ${esc(llm.errorText())}</p>` : '';
    const trash = `<button class="btn small danger" data-act="remove">${icon('trash', 18)}<span>Удалить</span></button>`;
    if (llm.ready) return `<p class="note">Модель в памяти и отвечает на вопросы</p><div class="btn-row two"><button class="btn small" data-act="unload">Выгрузить из памяти</button>${trash}</div>`;
    if (this.cached.get(llm.modelId)) return `${err}<div class="btn-row two"><button class="btn small accent" data-act="load">Загрузить в память</button>${trash}</div>`;
    return `${err}<button class="btn wide" data-act="download"${m && !m.available ? ' disabled' : ''}>${icon('download', 20)}<span>Скачать модель${size ? ` · ${size}` : ''}</span></button>`;
  }

  voiceRows() {
    const sp = this.speaker, cur = sp.usePiper ? sp.piperId : '';
    const radio = (on) => `<span class="radio">${on ? icon('check', 14) : ''}</span>`;
    const sys = `<button class="row${cur ? '' : ' on'}" data-act="voice" data-id=""${sp.sys ? '' : ' disabled'}>${radio(!cur)}
      <span class="row-main"><span class="row-title">Системный</span><span class="row-lat plain">${esc(sp.sys ? sp.voice?.name || 'Голос устройства' : 'Недоступен в этом браузере')}</span></span></button>`;
    return sys + PIPER_VOICES.map((v) => {
      const on = cur === v.id, have = sp.have.has(v.id), dl = sp.dl.get(v.id), id = esc(v.id);
      const pct = dl != null ? Math.round(dl * 100) : 0;
      const sub = [v.sub, dl != null ? `загрузка ${pct}%` : have ? 'скачан' : `${PIPER_MB} МБ`].join(' · ');
      const acts = dl != null ? `<button class="vbtn" disabled>${pct}%</button>`
        : have ? `<button class="vbtn" data-act="voice-play" data-id="${id}">Прослушать</button><button class="vbtn danger" data-act="voice-del" data-id="${id}">Удалить</button>`
        : `<button class="vbtn" data-act="voice-dl" data-id="${id}"${sp.audio ? '' : ' disabled'}>${icon('download', 16)}<span>Скачать</span></button>`;
      return `<div class="row-wrap"><button class="row${on ? ' on' : ''}" data-act="voice" data-id="${id}">${radio(on)}
        <span class="row-main"><span class="row-title">${esc(v.name)}</span><span class="row-lat plain">${esc(sub)}</span></span></button><span class="voice-acts">${acts}</span></div>`;
    }).join('');
  }

  onSpeaker() {
    this.updateButtons();
    if (!this.setEl.classList.contains('on') || this.view !== 'main') return;
    const box = this.setEl.querySelector('#as-voice');
    if (box) box.innerHTML = this.voiceRows();
    const lab = this.setEl.querySelector('#as-voice-label');
    if (lab) lab.textContent = this.speaker.voiceLabel();
  }

  onVoiceClick(act, id) {
    const sp = this.speaker, name = PIPER_VOICES.find((v) => v.id === id)?.name || '';
    if (act === 'voice') {
      if (id && !sp.have.has(id)) { toast('Сначала скачайте голос'); return; }
      sp.unlock(); sp.setVoice(id);
    } else if (act === 'voice-dl') {
      sp.download(id).then(() => { toast(`Голос ${name} скачан`); this.storageNote(); }, (err) => { console.warn(err); toast('Не удалось скачать голос'); });
    } else if (act === 'voice-play') {
      if (sp.speaking) sp.stop(); else sp.preview(id);
    } else if (act === 'voice-del') {
      if (!confirm(`Удалить голос ${name} с устройства?`)) return;
      sp.remove(id).then(() => { toast('Голос удалён'); this.storageNote(); }, (err) => { console.warn(err); toast('Не удалось удалить голос'); });
    }
  }

  asrCtl() {
    const a = this.asr;
    const status = a.state === 'loading' ? (this.asrProgress() || 'Подготовка') : a.state === 'ready' ? 'Готово к работе' : a.state === 'error' ? `Не загрузилось: ${String(a.error?.message || a.error || 'причина неизвестна').slice(0, 160)}`
      : a.cached ? 'Скачано на устройство' : 'Скачается при первом голосовом вопросе';
    let html = `<div class="list"><div class="row static"><span class="row-main"><span class="row-title">Whisper base</span><span class="row-lat plain">${esc(status)}</span></span></div></div>`;
    if (a.state === 'loading') html += `<div class="progress"><i style="width:${Math.max(2, Math.round(a.progress * 100))}%"></i></div>`;
    else if (a.state !== 'ready' && !a.cached) html += `<button class="btn wide" data-act="asr-download">${icon('download', 20)}<span>Скачать распознавание</span></button>`;
    return html;
  }

  docRow(d) {
    return `<div class="row-wrap"><button class="row" data-act="doc" data-id="${esc(d.id)}"><span class="dot-ic">${icon('doc', 20)}</span>
      <span class="row-main"><span class="row-title">${esc(d.title)}</span><span class="row-lat plain">${d.pinned ? 'Закреплён · ' : ''}${fmtChars(d.text.length)} · ${esc(fmtDate(d.addedAt))}</span></span></button>
      <button class="row-eye${d.pinned ? ' on' : ''}" data-act="pin" data-id="${esc(d.id)}" aria-label="${d.pinned ? 'Открепить' : 'Закрепить'}">${icon(d.pinned ? 'pinFill' : 'pin', 20)}</button></div>`;
  }

  renderDoc(id) {
    const d = this.profile.get(id);
    if (!d) { this.view = 'main'; this.renderMain(); return; }
    this.setEl.innerHTML = `<div class="panel-scroll">
      <header class="panel-head with-close"><button class="glass round" data-act="back-main" aria-label="Назад">${icon('chevL', 20)}</button><h1 class="doc-title">${esc(d.title)}</h1>
        <p>${fmtChars(d.text.length)} · ${esc(fmtDate(d.addedAt))}</p></header>
      <div class="btn-row two"><button class="btn small toggle${d.pinned ? ' on' : ''}" data-act="pin" data-id="${esc(d.id)}">${icon(d.pinned ? 'pinFill' : 'pin', 18)}<span>${d.pinned ? 'Закреплён' : 'Закрепить'}</span></button>
        <button class="btn small danger" data-act="del" data-id="${esc(d.id)}">${icon('trash', 18)}<span>Удалить</span></button></div>
      <div class="md doc-md">${md(d.text) || '<p class="note">Пустой документ</p>'}</div>
    </div>`;
  }

  renderPaste() {
    this.setEl.innerHTML = `<div class="panel-scroll">
      <header class="panel-head with-close"><button class="glass round" data-act="back-main" aria-label="Назад">${icon('chevL', 20)}</button><h1>Новый документ</h1>
        <p>Вставьте текст из буфера обмена или наберите его здесь</p></header>
      <input class="field" id="as-title" type="text" placeholder="Название" autocomplete="off" aria-label="Название документа">
      <textarea class="field area" id="as-text" placeholder="Текст документа" aria-label="Текст документа"></textarea>
      <div class="btn-row two"><button class="btn small" data-act="clip">${icon('paste', 18)}<span>Из буфера</span></button>
        <button class="btn small accent" data-act="save-doc">${icon('check', 18)}<span>Сохранить</span></button></div>
    </div>`;
  }

  async storageNote() {
    const el = this.setEl.querySelector('#as-storage');
    if (!el || !navigator.storage?.estimate) return;
    try {
      const { usage = 0, quota = 0 } = await navigator.storage.estimate();
      el.textContent = `Занято на устройстве: ${fmtSize(usage)}${quota ? ` из ${fmtSize(quota)} доступных` : ''}`;
    } catch (e) { /* оценка недоступна */ }
  }

  onLlm() {
    this.updateStatus();
    const box = this.setEl.classList.contains('on') ? this.setEl.querySelector('#as-model') : null;
    if (box && this.view === 'main') {
      const loading = this.llm.state === 'loading';
      if (loading && box.querySelector('.progress')) {
        // во время загрузки обновляем только полосу и подпись
        const k = Math.round(this.llm.progress * 100), m = this.models?.find((x) => x.id === this.llm.modelId);
        box.querySelector('.progress i').style.width = `${Math.max(2, k)}%`;
        box.querySelector('.note').textContent = `Загрузка ${k}%${m?.mb ? ` · ${fmtGB(m.mb * this.llm.progress)} из ${fmtGB(m.mb)}` : ''}. Держите приложение открытым до конца загрузки`;
      } else if (loading !== this._llmLoading) this.renderMain();
      else box.innerHTML = this.modelCtl();
    }
    this._llmLoading = this.llm.state === 'loading';
  }

  onAsr() {
    const box = this.setEl.classList.contains('on') ? this.setEl.querySelector('#as-asr') : null;
    if (box && this.view === 'main') box.innerHTML = this.asrCtl();
    this.updateNote();
  }

  async loadModel() {
    if (!this.llm.enabled || !this.llm.supported) return;
    this.llm.markFailed(false);
    try {
      await this.llm.load();
      this.cached.set(this.llm.modelId, true);
      toast('Модель готова');
    } catch (err) {
      console.error(err);
      toast('Модель не загрузилась');
    }
    if (this.view === 'main') this.renderMain();
    this.updateStatus();
  }

  async exportDocs() {
    const { name, text } = this.profile.exportMd();
    const file = new File([text], name, { type: 'text/markdown' });
    if (navigator.canShare?.({ files: [file] })) {
      try { await navigator.share({ files: [file], title: 'Мои данные' }); return; } catch (err) { if (err?.name === 'AbortError') return; }
    }
    const url = URL.createObjectURL(file), a = document.createElement('a');
    a.href = url; a.download = name;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }

  async pasteClipboard() {
    const ta = this.setEl.querySelector('#as-text'), title = this.setEl.querySelector('#as-title');
    if (!ta) return;
    try {
      const t = await navigator.clipboard.readText();
      if (!t) { toast('Буфер обмена пуст'); return; }
      ta.value = t;
      if (!title.value) title.value = guessTitle(t);
    } catch (err) {
      toast('Нет доступа к буферу. Вставьте текст в поле');
      ta.focus();
    }
  }

  async saveDoc() {
    const ta = this.setEl.querySelector('#as-text'), title = this.setEl.querySelector('#as-title');
    const text = ta?.value.trim();
    if (!text) { toast('Добавьте текст'); return; }
    await this.profile.add({ title: title.value.trim() || guessTitle(text), text });
    this.view = 'main';
    this.renderMain();
    toast('Документ сохранён');
  }

  async onSettingsClick(e) {
    const b = e.target.closest('[data-act]');
    if (!b) return;
    const { act, id } = b.dataset;
    if (act === 'close') this.closeSettings();
    else if (act === 'back-main') { this.view = 'main'; this.renderMain(); }
    else if (act === 'llm-toggle') { this.llm.setEnabled(!this.llm.enabled); this.renderMain(); if (this.agent.messages.length) this.renderLog(); }
    else if (act === 'model') { this.llm.setModel(id); this.renderMain(); }
    else if (act === 'download' || act === 'load') this.loadModel();
    else if (act === 'purge') {
      try { await this.llm.remove(this.llm.crashed); toast('Файлы удалены'); } catch (err) { console.warn(err); toast('Не удалось удалить файлы'); }
      await this.refreshCached();
      this.renderMain();
    }
    else if (act === 'app-update') {
      toast('Обновляю приложение');
      try {
        const reg = await navigator.serviceWorker?.getRegistration();
        await reg?.update();
        for (const k of await caches.keys()) if (/shell|data/i.test(k)) await caches.delete(k);
      } catch (err) { console.warn(err); }
      location.reload();
    }
    else if (act === 'unload') { await this.llm.unload(); this.renderMain(); }
    else if (act === 'remove') {
      if (!confirm(`Удалить модель ${MODEL_NAMES[this.llm.modelId] || ''} с устройства?`)) return;
      try { await this.llm.remove(this.llm.modelId); toast('Модель удалена'); } catch (err) { console.warn(err); toast('Не удалось удалить модель'); }
      this.cached.set(this.llm.modelId, false);
      this.renderMain();
    }
    else if (act === 'asr-download') this.asr.ensure().then(() => toast('Распознавание речи готово'), () => toast('Не удалось скачать распознавание'));
    else if (act === 'speak-toggle') { this.speaker.unlock(); this.speaker.setEnabled(!this.speaker.enabled); b.setAttribute('aria-checked', String(this.speaker.enabled)); }
    else if (act.startsWith('voice')) this.onVoiceClick(act, id || '');
    else if (act === 'import') this.setEl.querySelector('#as-file')?.click();
    else if (act === 'paste') { this.view = 'paste'; this.renderPaste(); }
    else if (act === 'export') this.exportDocs();
    else if (act === 'doc') { this.view = `doc:${id}`; this.renderDoc(id); }
    else if (act === 'pin') {
      const on = await this.profile.togglePin(id);
      toast(on ? 'Документ закреплён' : 'Документ откреплён');
      this.renderSettings();
    }
    else if (act === 'del') {
      const d = this.profile.get(id);
      if (!d || !confirm(`Удалить «${d.title}»?`)) return;
      await this.profile.remove(id);
      this.view = 'main';
      this.renderMain();
      toast('Документ удалён');
    }
    else if (act === 'clip') this.pasteClipboard();
    else if (act === 'save-doc') this.saveDoc();
  }

  async onSettingsChange(e) {
    if (e.target.id !== 'as-file') return;
    const files = [...(e.target.files || [])];
    e.target.value = '';
    if (!files.length) return;
    try {
      const n = await this.profile.importFiles(files);
      toast(n ? `Добавлено документов: ${n}` : 'В файлах нет текста');
    } catch (err) {
      console.warn(err);
      toast('Не удалось прочитать файлы');
    }
    this.renderMain();
  }
}
