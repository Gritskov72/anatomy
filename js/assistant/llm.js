// Модель ответов на устройстве: web-llm в отдельном воркере. Загрузка с прогрессом, потоковый ответ, остановка, выгрузка, удаление из кэша
import { store } from '../ui.js';

// порядок от лёгкой к тяжёлой: первая в списке ставится по умолчанию и помещается в память телефона
export const IS_IOS = typeof navigator !== 'undefined'
  && (/iPhone|iPad|iPod/i.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));
export const MODEL_IDS = ['gemma3-1b-it-q4f16_1-MLC', 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC', 'gemma-2-2b-it-q4f16_1-MLC', 'gemma-4-E2B-it-q4f16_1-MLC'];
export const MODEL_NAMES = {
  'gemma3-1b-it-q4f16_1-MLC': 'Gemma 3 1B',
  'gemma-4-E2B-it-q4f16_1-MLC': 'Gemma 4 E2B',
  'gemma-2-2b-it-q4f16_1-MLC': 'Gemma 2 2B',
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC': 'Qwen 2.5 1.5B',
};
export const MODEL_MB = {
  'gemma3-1b-it-q4f16_1-MLC': 711,
  'Qwen2.5-1.5B-Instruct-q4f16_1-MLC': 1630,
  'gemma-2-2b-it-q4f16_1-MLC': 1895,
  'gemma-4-E2B-it-q4f16_1-MLC': 3387,
};

/** Грубая оценка: 1 токен на 3 знака русского текста. */
export const tokens = (s) => Math.ceil(String(s || '').length / 3);
export const fmtGB = (mb) => (mb >= 1024 ? `${(mb / 1024).toFixed(1).replace('.', ',')} ГБ` : `${Math.max(1, Math.round(mb))} МБ`);

// библиотека большая: грузим её только когда она действительно нужна
let libP = null;
const lib = () => {
  if (!libP) libP = import('../../vendor/web-llm/web-llm.js').catch((err) => { libP = null; throw err; });
  return libP;
};

export class Llm {
  constructor() {
    this.supported = typeof navigator !== 'undefined' && !!navigator.gpu;
    this.enabled = store.get('assist.llmOn', !IS_IOS);
    const saved = store.get('assist.model', MODEL_IDS[0]);
    this.modelId = MODEL_IDS.includes(saved) ? saved : MODEL_IDS[0];
    // метка ставится перед загрузкой и снимается после неё: если она осталась, страница в прошлый раз закрылась посреди загрузки
    const guard = store.get('assist.guard', null);
    this.crashed = MODEL_IDS.includes(guard) ? guard : null;
    if (guard) store.set('assist.guard', null);
    if (this.crashed && this.modelId === this.crashed && this.crashed !== MODEL_IDS[0]) {
      this.modelId = MODEL_IDS[0];
      store.set('assist.model', this.modelId);
    }
    this.engine = null; this.worker = null; this.loadedId = null;
    this.state = 'idle'; this.progress = 0; this.error = null;
    this.generating = false; this._loading = null;
    this.cache = new Map(); this.fns = new Set();
    // модель, которая загрузилась, но не смогла ответить: без нажатия пользователя её больше не грузим
    this.failedId = store.get('assist.llmFail', null);
  }

  on(fn) { this.fns.add(fn); return () => this.fns.delete(fn); }
  emit() { for (const fn of this.fns) { try { fn(this); } catch (e) { console.error(e); } } }

  get ready() { return this.state === 'ready' && !!this.engine && this.loadedId === this.modelId; }

  /** Список моделей и их размер. */
  async models() {
    return MODEL_IDS.map((id) => ({ id, name: MODEL_NAMES[id] || id, mb: MODEL_MB[id] || 0, available: true }));
  }

  async isCached(id = this.modelId) {
    if (!this.supported) return false;
    if (this.cache.has(id)) return this.cache.get(id);
    let timer;
    try {
      const check = (async () => {
        const { hasModelInCache } = await lib();
        return !!(await hasModelInCache(id));
      })();
      const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(null), 4000); });
      const v = await Promise.race([check, timeout]);
      if (v === null) { check.catch(() => {}); return false; }
      this.cache.set(id, v);
      return v;
    } catch (e) { return false; } finally { clearTimeout(timer); }
  }

  setEnabled(on) {
    this.enabled = !!on;
    store.set('assist.llmOn', this.enabled);
    if (!this.enabled) this.unload();
    this.emit();
  }

  setModel(id) {
    if (!MODEL_IDS.includes(id) || id === this.modelId || this.state === 'loading') return;
    this.modelId = id;
    store.set('assist.model', id);
    if (this.loadedId && this.loadedId !== id) this.unload();
    if (this.state === 'error') { this.state = 'idle'; this.error = null; }
    this.emit();
  }

  /** Скачивание (если весов нет в кэше) и загрузка в память видеокарты. */
  load(onProgress) {
    if (!this.supported) return Promise.reject(new Error('WebGPU недоступен'));
    if (this.ready) return Promise.resolve(this.engine);
    if (this._loading) return this._loading;
    const id = this.modelId;
    this._loading = (async () => {
      await this.unload();
      this.state = 'loading'; this.progress = 0; this.error = null;
      store.set('assist.guard', id);
      this.emit();
      const { CreateWebWorkerMLCEngine } = await lib();
      const worker = new Worker(new URL('./llm.worker.js', import.meta.url), { type: 'module' });
      this.worker = worker;
      try {
        const engine = await CreateWebWorkerMLCEngine(worker, id, {
          initProgressCallback: (r) => {
            this.progress = Math.max(0, Math.min(1, +r?.progress || 0));
            onProgress?.(this.progress);
            this.emit();
          },
        });
        this.engine = engine; this.loadedId = id; this.state = 'ready'; this.progress = 1;
        this.cache.set(id, true);
        return engine;
      } catch (err) {
        try { worker.terminate(); } catch (e) { /* уже остановлен */ }
        this.worker = null; this.engine = null; this.loadedId = null;
        this.state = 'error'; this.error = err;
        this.cache.delete(id);
        throw err;
      } finally {
        this._loading = null;
        store.set('assist.guard', null);
        this.emit();
      }
    })();
    return this._loading;
  }

  markFailed(on) { this.failedId = on ? this.modelId : null; store.set('assist.llmFail', this.failedId); this.emit(); }
  get usable() { return this.supported && this.enabled && this.failedId !== this.modelId; }

  /** Потоковый ответ. onDelta(кусок, весь текст). */
  async chat(messages, { onDelta, maxTokens = 480 } = {}) {
    if (!this.engine) throw new Error('Модель не загружена');
    this.generating = true;
    let out = '';
    try {
      const stream = await this.engine.chat.completions.create({ messages, stream: true, temperature: 0.3, max_tokens: maxTokens });
      for await (const chunk of stream) {
        const d = chunk?.choices?.[0]?.delta?.content || '';
        if (d) { out += d; onDelta?.(d, out); }
      }
    } finally {
      this.generating = false;
    }
    return out;
  }

  stop() {
    if (!this.generating) return;
    try { this.engine?.interruptGenerate(); } catch (e) { /* уже остановлено */ }
  }

  async unload() {
    const engine = this.engine, worker = this.worker;
    this.engine = null; this.worker = null; this.loadedId = null;
    if (this.state === 'ready') this.state = 'idle';
    if (engine) { try { await engine.unload(); } catch (e) { /* воркер мог уже закрыться */ } }
    if (worker) { try { worker.terminate(); } catch (e) { /* уже остановлен */ } }
    this.emit();
  }

  async remove(id = this.modelId) {
    if (this.loadedId === id) await this.unload();
    const { deleteModelAllInfoInCache } = await lib();
    await deleteModelAllInfoInCache(id);
    this.cache.set(id, false);
    if (this.crashed === id) this.crashed = null;
    if (this.state === 'error') { this.state = 'idle'; this.error = null; }
    this.emit();
  }

  errorText() {
    const m = String(this.error?.message || this.error || '');
    if (/f16|shader|feature/i.test(m)) return 'видеокарта не поддерживает нужный формат вычислений';
    if (/quota|storage|space/i.test(m)) return 'не хватает места на устройстве';
    if (/fetch|network|load failed/i.test(m)) return 'нет сети или сервер недоступен';
    if (/memory|oom|device lost|lost/i.test(m)) return 'не хватило памяти, закройте другие приложения';
    return m ? m.slice(0, 120) : 'неизвестная ошибка';
  }
}
