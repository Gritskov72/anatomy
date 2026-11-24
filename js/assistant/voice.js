// Голос: запись с микрофона, перевод в моно 16 кГц, распознавание Whisper в воркере, озвучка ответов голосами Piper или через speechSynthesis
import { store } from '../ui.js';

const RATE = 16000;
const MAX_MS = 30000;

let ctx = null;
function audioCtx() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!ctx && C) ctx = new C();
  return ctx;
}

function decode(c, buf) {
  return new Promise((resolve, reject) => {
    const p = c.decodeAudioData(buf, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
}

// iOS: тип аудиосессии (Safari 16.4+). playback - звук не глушится беззвучным режимом, play-and-record - на время записи
function audioSession(type) {
  try { if (navigator.audioSession && navigator.audioSession.type !== type) navigator.audioSession.type = type; } catch (e) { /* не поддерживается */ }
}

// ---------------------------------------------------------------- запись
export class Recorder {
  constructor() { this.rec = null; this.stream = null; }

  get active() { return !!this.rec; }
  elapsed() { return this.rec ? performance.now() - this.t0 : 0; }

  /** Нажал - пошла запись. Через 30 секунд onAuto остановит её сам. */
  async start({ onAuto } = {}) {
    if (this.rec) return;
    if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) throw new Error('Запись звука недоступна');
    try { audioCtx()?.resume?.(); } catch (e) { /* контекст разблокируется позже */ }
    audioSession('play-and-record');
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    const type = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm'].find((t) => MediaRecorder.isTypeSupported?.(t));
    let rec;
    try { rec = new MediaRecorder(stream, type ? { mimeType: type } : undefined); }
    catch (e) { stream.getTracks().forEach((t) => t.stop()); throw e; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data?.size) chunks.push(e.data); };
    this.done = new Promise((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type: rec.mimeType || type || 'audio/mp4' })); });
    rec.start();
    this.rec = rec; this.stream = stream; this.t0 = performance.now();
    this.timer = setTimeout(() => onAuto?.(), MAX_MS);
  }

  /** Остановить и получить Float32Array моно 16 кГц или null, если запись слишком короткая. */
  async stop() {
    const rec = this.rec;
    if (!rec) return null;
    clearTimeout(this.timer);
    this.rec = null;
    if (rec.state !== 'inactive') rec.stop();
    const blob = await this.done;
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    audioSession('playback');
    if (!blob.size) return null;
    const pcm = await toMono16k(await blob.arrayBuffer());
    return pcm.length < RATE * 0.4 ? null : pcm;
  }

  cancel() {
    if (!this.rec) return;
    clearTimeout(this.timer);
    try { if (this.rec.state !== 'inactive') this.rec.stop(); } catch (e) { /* уже остановлен */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    this.rec = null; this.stream = null;
    audioSession('playback');
  }
}

async function toMono16k(buf) {
  const c = audioCtx();
  if (!c) throw new Error('Web Audio недоступен');
  const decoded = await decode(c, buf);
  try {
    const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(decoded.duration * RATE)), RATE);
    const src = off.createBufferSource();
    src.buffer = decoded;
    src.connect(off.destination);
    src.start();
    const out = await off.startRendering();
    return out.getChannelData(0).slice();
  } catch (e) {
    return resample(decoded);
  }
}

// запасной путь: смешать каналы и пересчитать частоту линейной интерполяцией
function resample(b) {
  const n = b.numberOfChannels, len = b.length, mono = new Float32Array(len);
  for (let ch = 0; ch < n; ch++) { const d = b.getChannelData(ch); for (let i = 0; i < len; i++) mono[i] += d[i] / n; }
  const ratio = b.sampleRate / RATE, out = new Float32Array(Math.floor(len / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    out[i] = mono[j] * (1 - f) + (mono[j + 1] ?? mono[j]) * f;
  }
  return out;
}

// ---------------------------------------------------------------- распознавание
const JUNK = /(субтитр|продолжение следует|спасибо за просмотр|подписывайтесь|dimatorzok|amara\.org)/i;
function cleanAsr(t) {
  const s = String(t || '').replace(/\[[^\]]*\]|\([^)]*музык[^)]*\)/gi, ' ').replace(/\s+/g, ' ').trim();
  return !s || JUNK.test(s) ? '' : s;
}

export class Asr {
  constructor() {
    this.state = 'idle'; this.progress = 0; this.loaded = 0; this.total = 0; this.error = null;
    this.cached = store.get('assist.asr', false);
    this.worker = null; this._ready = null; this.jobs = new Map(); this.seq = 0; this.fns = new Set();
  }

  on(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit() { for (const fn of this.fns) { try { fn(this); } catch (e) { console.error(e); } } }

  /** Запустить воркер и загрузить модель (из сети при первом запуске, дальше из кэша). */
  ensure() {
    if (this._ready) return this._ready;
    this.state = 'loading'; this.progress = 0; this.error = null;
    this.emit();
    this._ready = new Promise((resolve, reject) => {
      const fail = (err) => {
        this.state = 'error'; this.error = err;
        try { this.worker?.terminate(); } catch (e) { /* уже остановлен */ }
        this.worker = null; this._ready = null;
        for (const j of this.jobs.values()) j.reject(err);
        this.jobs.clear();
        this.emit();
        reject(err);
      };
      let w;
      try { w = this.worker = new Worker(new URL('./asr.worker.js?v=4', import.meta.url), { type: 'module' }); }
      catch (err) { fail(err); return; }
      w.onmessage = (e) => {
        const m = e.data || {};
        if (m.type === 'progress') {
          this.loaded = m.loaded || 0; this.total = m.total || 0;
          this.progress = this.total ? Math.min(1, this.loaded / this.total) : 0;
          this.emit();
        } else if (m.type === 'ready') {
          this.state = 'ready'; this.cached = true; this.progress = 1;
          store.set('assist.asr', true);
          this.emit();
          resolve();
        } else if (m.type === 'result') {
          this.jobs.get(m.id)?.resolve(m.text || '');
          this.jobs.delete(m.id);
        } else if (m.type === 'error') {
          if (m.id != null) { this.jobs.get(m.id)?.reject(new Error(m.message)); this.jobs.delete(m.id); }
          else fail(new Error(m.message || 'Модель распознавания не загрузилась'));
        }
      };
      w.onerror = (e) => { e.preventDefault?.(); fail(new Error(`${e.message || 'Воркер распознавания не запустился'}${e.filename ? ` · ${String(e.filename).split('/').pop()}:${e.lineno || 0}` : ''}`)); };
      w.postMessage({ type: 'load' });
    });
    return this._ready;
  }

  async transcribe(audio) {
    await this.ensure();
    const id = ++this.seq;
    const text = await new Promise((resolve, reject) => {
      this.jobs.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'run', id, audio }, [audio.buffer]);
    });
    return cleanAsr(text);
  }
}

// ---------------------------------------------------------------- озвучка
// Нейросетевые голоса Piper: модели около 60 МБ, хранятся в OPFS, синтез в основном потоке
// (import map для onnxruntime-web в воркерах не действует)
export const PIPER_VOICES = [
  { id: 'ru_RU-irina-medium', name: 'Ирина', sub: 'женский' },
  { id: 'ru_RU-ruslan-medium', name: 'Руслан', sub: 'мужской' },
  { id: 'ru_RU-dmitri-medium', name: 'Дмитрий', sub: 'мужской' },
  { id: 'ru_RU-denis-medium', name: 'Денис', sub: 'мужской' },
];
export const PIPER_MB = 60;
const PREVIEW = 'Это бедренная кость, самая длинная кость скелета';

let piperLib = null;
function piper() {
  if (!piperLib) piperLib = import('../../vendor/piper/piper-tts-web.js').catch((e) => { piperLib = null; throw e; });
  return piperLib;
}

// для Piper: сокращения словами, остатки разметки убираются
function piperText(t) {
  return t
    .replace(/(^|[\s(])т\.\s?е\./gi, '$1то есть')
    .replace(/(^|[\s(])т\.\s?д\./gi, '$1так далее')
    .replace(/(^|[\s(])т\.\s?п\./gi, '$1тому подобное')
    .replace(/(\d+)\s*[-–]\s*(\d+)/g, 'от $1 до $2')
    .replace(/[*_#`~<>[\]{}|\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function speechText(t) {
  return String(t || '')
    .replace(/\*\*|__|`/g, '')
    .replace(/^\s*[-*•]\s+/gm, '')
    .replace(/^\s*#+\s*/gm, '')
    .replace(/\(([^()]*[a-z][^()]*)\)/gi, '')
    .replace(/\s*·\s*/g, ', ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
}

function splitSpeech(t, max = 220) {
  const out = [];
  for (const s of t.split(/(?<=[.!?…])\s+|\n+/)) {
    const x = s.trim();
    if (!x) continue;
    if (x.length <= max) { out.push(x); continue; }
    let cur = '';
    for (const part of x.split(/(?<=[,;:])\s+/)) {
      if (cur && cur.length + part.length + 1 > max) { out.push(cur); cur = part; }
      else cur = cur ? `${cur} ${part}` : part;
    }
    if (cur) out.push(cur);
  }
  return out;
}

export class Speaker {
  constructor() {
    const w = typeof window !== 'undefined' ? window : {};
    this.sys = 'speechSynthesis' in w && 'SpeechSynthesisUtterance' in w;
    this.audio = !!(w.AudioContext || w.webkitAudioContext);
    this.ok = this.sys || this.audio;
    this.enabled = store.get('assist.speak', true);
    this.piperId = store.get('assist.piper', ''); // пусто - системный голос
    this.have = new Set(store.get('assist.piperHave', [])); // скачанные голоса Piper
    this.dl = new Map(); // id -> доля загрузки
    this.unlocked = false; this.voice = null; this.pending = 0; this.gen = 0; this.fns = new Set();
    this.q = null; this.src = null; this.srcDone = null; this._sync = null;
    if (this.sys) {
      this.pick();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pick());
    }
  }

  get usePiper() { return this.audio && !!this.piperId && this.have.has(this.piperId); }

  setVoice(id) {
    this.piperId = id && this.have.has(id) ? id : '';
    store.set('assist.piper', this.piperId);
    this.stop();
  }

  _saveHave() { store.set('assist.piperHave', [...this.have]); }

  /** Сверить список скачанных голосов с OPFS (первый вызов загружает библиотеку). */
  syncPiper(force = false) {
    if (!this._sync || force) {
      this._sync = piper().then((tts) => tts.stored()).then((ids) => {
        const known = new Set(PIPER_VOICES.map((v) => v.id));
        this.have = new Set((ids || []).filter((id) => known.has(id)));
        this._saveHave();
        this.emit();
      }).catch((e) => { console.warn('Piper недоступен', e); this._sync = null; });
    }
    return this._sync;
  }

  async download(id) {
    if (this.dl.has(id)) return;
    this.dl.set(id, 0); this.emit();
    try {
      const tts = await piper();
      let last = -1;
      await tts.download(id, (p) => {
        const k = p?.total ? Math.min(1, p.loaded / p.total) : 0, pct = Math.floor(k * 100);
        if (pct === last) return;
        last = pct; this.dl.set(id, k); this.emit();
      });
      // библиотека не ждёт конца записи файла голоса: ждём, пока размер в хранилище перестанет расти
      try {
        const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('piper', { create: true });
        let prev = -1;
        for (let i = 0; i < 120; i++) {
          let size = 0;
          try { size = (await (await dir.getFileHandle(`${id}.onnx`)).getFile()).size; } catch (e) { size = 0; }
          if (size > 1e6 && size === prev) break;
          prev = size;
          await new Promise((r) => setTimeout(r, 500));
        }
      } catch (e) { /* хранилище недоступно: первая реплика уйдёт системному голосу */ }
      try { tts.TtsSession._instance = null; } catch (e) { /* сессии ещё нет */ }
      this.have.add(id); this._saveHave();
      this.piperId = id; store.set('assist.piper', id);
    } finally { this.dl.delete(id); this.emit(); }
  }

  async remove(id) {
    if (this.q?.voiceId === id) this.stop();
    const tts = await piper();
    await tts.remove(id);
    this.have.delete(id); this._saveHave();
    this.emit();
  }

  /** Прослушать голос Piper из настроек. */
  preview(id) {
    if (!this.ok) return;
    this.unlock(); this.stop();
    this._piper(splitSpeech(PREVIEW), this.gen, id);
  }

  on(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit() { for (const fn of this.fns) { try { fn(this); } catch (e) { console.error(e); } } }

  pick() {
    const list = speechSynthesis.getVoices().filter((v) => /^ru([-_]|$)/i.test(v.lang || ''));
    this.voice = list.find((v) => /enhanced|premium|улучш/i.test(v.name)) || list.find((v) => v.localService) || list[0] || null;
  }

  voiceLabel() {
    if (!this.ok) return 'Озвучка недоступна в этом браузере';
    if (this.usePiper) return `Голос: ${PIPER_VOICES.find((v) => v.id === this.piperId)?.name || this.piperId} - Piper`;
    if (!this.sys) return 'Системный голос недоступен - скачайте голос Piper';
    return this.voice ? `Голос: ${this.voice.name}` : 'Системный голос для русского языка';
  }

  setEnabled(on) { this.enabled = !!on; store.set('assist.speak', this.enabled); if (!on) this.stop(); this.emit(); }

  /** iOS разрешает звук только из жеста пользователя: пустая реплика и тихий буфер открывают доступ. */
  unlock() {
    if (this.audio) {
      try {
        const c = audioCtx();
        if (c && c.state !== 'running') {
          if (navigator.audioSession?.type === 'auto') audioSession('playback');
          c.resume?.();
          const s = c.createBufferSource();
          s.buffer = c.createBuffer(1, 1, 22050);
          s.connect(c.destination);
          s.start(0);
        }
      } catch (e) { /* без звука */ }
    }
    if (!this.sys || this.unlocked) return;
    this.unlocked = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = 'ru-RU'; speechSynthesis.speak(u); } catch (e) { /* без звука */ }
  }

  get speaking() { return this.pending > 0; }

  _say(text, gen) {
    const t = speechText(text);
    if (!t || gen !== this.gen) return;
    if (this.usePiper) this._piper(splitSpeech(piperText(t)), gen, this.piperId);
    else this._sys(splitSpeech(t), gen);
  }

  // ---- Piper: очередь предложений, следующее синтезируется, пока играет текущее
  _piper(parts, gen, voiceId) {
    if (!parts.length || gen !== this.gen) return;
    let q = this.q;
    if (!q || q.gen !== gen) q = this.q = { gen, voiceId, items: [], running: false, failed: false };
    if (q.failed) { this._sys(parts, gen); return; }
    q.items.push(...parts);
    this.pending += parts.length;
    this.emit();
    if (!q.running) this._run(q);
  }

  async _run(q) {
    q.running = true;
    const alive = () => q.gen === this.gen;
    const synth = (tts, text) => { const p = tts.predict({ text, voiceId: q.voiceId }); p.catch(() => {}); return { text, p }; };
    let cur = null, next = null;
    try {
      await this.syncPiper();
      if (!this.have.has(q.voiceId)) throw new Error('Голос Piper не скачан');
      const tts = await piper();
      while (alive()) {
        if (!next) { if (!q.items.length) break; next = synth(tts, q.items.shift()); }
        cur = next; next = null;
        const wav = await cur.p;
        if (!alive()) break;
        const buf = await decode(audioCtx(), await wav.arrayBuffer());
        if (!alive()) break;
        if (q.items.length) next = synth(tts, q.items.shift());
        await this._play(buf, q);
        cur = null;
        if (alive()) { this.pending = Math.max(0, this.pending - 1); this.emit(); }
      }
    } catch (err) {
      if (alive()) {
        // ошибка в любой точке: остаток реплики читает системный голос
        console.warn('Piper: переход на системный голос', err);
        piper().then((tts) => { try { tts.TtsSession._instance = null; } catch (e) { /* нет сессии */ } }).catch(() => {});
        q.failed = true;
        const rest = [cur?.text, next?.text, ...q.items].filter(Boolean);
        q.items = [];
        this.pending = Math.max(0, this.pending - rest.length);
        this._sys(rest, q.gen);
        this.emit();
      }
    }
    q.running = false;
    if (alive() && !q.failed && q.items.length) this._run(q);
  }

  async _play(buf, q) {
    const c = audioCtx();
    if (c.state !== 'running') {
      try { await Promise.race([c.resume(), new Promise((r) => setTimeout(r, 400))]); } catch (e) { /* проверка ниже */ }
    }
    if (c.state !== 'running') throw new Error('Звук заблокирован');
    if (q.gen !== this.gen) return;
    await new Promise((resolve) => {
      const s = c.createBufferSource();
      s.buffer = buf;
      s.connect(c.destination);
      s.onended = () => { if (this.src === s) { this.src = null; this.srcDone = null; } resolve(); };
      this.src = s; this.srcDone = resolve;
      s.start();
    });
  }

  // ---- системный голос
  _sys(parts, gen) {
    if (!this.sys || gen !== this.gen) return;
    for (const part of parts) {
      const u = new SpeechSynthesisUtterance(part);
      u.lang = 'ru-RU';
      if (this.voice) u.voice = this.voice;
      u.rate = 1.04;
      this.pending++;
      const done = () => { if (gen === this.gen) { this.pending = Math.max(0, this.pending - 1); this.emit(); } };
      u.onend = done; u.onerror = done;
      speechSynthesis.speak(u);
    }
    this.emit();
  }

  say(text) { if (!this.ok) return; this.stop(); this._say(text, this.gen); }

  /** Озвучка по мере прихода текста: каждое законченное предложение сразу в очередь. */
  stream() {
    if (!this.ok) return { push() {}, end() {} };
    const gen = this.gen;
    let buf = '';
    return {
      push: (d) => {
        if (gen !== this.gen) return;
        buf += d;
        let cut = -1;
        const re = /[.!?…\n](?=\s)/g;
        let m;
        while ((m = re.exec(buf))) cut = m.index + 1;
        if (cut > 0) { this._say(buf.slice(0, cut), gen); buf = buf.slice(cut); }
      },
      end: () => { if (gen === this.gen && buf.trim()) this._say(buf, gen); buf = ''; },
    };
  }

  stop() {
    if (!this.ok) return;
    this.gen++;
    this.pending = 0;
    this.q = null;
    const s = this.src, done = this.srcDone;
    this.src = null; this.srcDone = null;
    if (s) { try { s.onended = null; s.stop(); } catch (e) { /* уже остановлен */ } done?.(); }
    if (this.sys) { try { speechSynthesis.cancel(); } catch (e) { /* очередь уже пуста */ } }
    this.emit();
  }
}
