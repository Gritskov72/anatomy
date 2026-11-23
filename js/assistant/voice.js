// Голос: запись с микрофона, перевод в моно 16 кГц, распознавание Whisper в воркере, озвучка ответов через speechSynthesis
import { store } from '../ui.js';

const RATE = 16000;
const MAX_MS = 30000;

let ctx = null;
function audioCtx() {
  const C = window.AudioContext || window.webkitAudioContext;
  if (!ctx && C) ctx = new C();
  return ctx;
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
  }
}

async function toMono16k(buf) {
  const c = audioCtx();
  if (!c) throw new Error('Web Audio недоступен');
  const decoded = await new Promise((resolve, reject) => {
    const p = c.decodeAudioData(buf, resolve, reject);
    if (p && typeof p.then === 'function') p.then(resolve, reject);
  });
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
      try { w = this.worker = new Worker(new URL('./asr.worker.js', import.meta.url), { type: 'module' }); }
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
      w.onerror = (e) => { e.preventDefault?.(); fail(new Error(e.message || 'Воркер распознавания не запустился')); };
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
    this.ok = typeof window !== 'undefined' && 'speechSynthesis' in window && 'SpeechSynthesisUtterance' in window;
    this.enabled = store.get('assist.speak', true);
    this.unlocked = false; this.voice = null; this.pending = 0; this.gen = 0; this.fns = new Set();
    if (this.ok) {
      this.pick();
      speechSynthesis.addEventListener?.('voiceschanged', () => this.pick());
    }
  }

  on(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit() { for (const fn of this.fns) { try { fn(this); } catch (e) { console.error(e); } } }

  pick() {
    const list = speechSynthesis.getVoices().filter((v) => /^ru([-_]|$)/i.test(v.lang || ''));
    this.voice = list.find((v) => /enhanced|premium|улучш/i.test(v.name)) || list.find((v) => v.localService) || list[0] || null;
  }

  voiceLabel() {
    if (!this.ok) return 'Озвучка недоступна в этом браузере';
    return this.voice ? `Голос: ${this.voice.name}` : 'Системный голос для русского языка';
  }

  setEnabled(on) { this.enabled = !!on; store.set('assist.speak', this.enabled); if (!on) this.stop(); this.emit(); }

  /** iOS разрешает речь только из жеста пользователя: первая пустая реплика открывает доступ. */
  unlock() {
    if (!this.ok || this.unlocked) return;
    this.unlocked = true;
    try { const u = new SpeechSynthesisUtterance(' '); u.volume = 0; u.lang = 'ru-RU'; speechSynthesis.speak(u); } catch (e) { /* без звука */ }
  }

  get speaking() { return this.pending > 0; }

  _say(text, gen) {
    const t = speechText(text);
    if (!t || gen !== this.gen) return;
    for (const part of splitSpeech(t)) {
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
    try { speechSynthesis.cancel(); } catch (e) { /* очередь уже пуста */ }
    this.emit();
  }
}
