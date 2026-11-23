// Воркер распознавания речи: Whisper base через transformers.js на wasm. Модель качается при первой необходимости
import { pipeline, env } from 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.2/dist/transformers.web.min.js';

env.allowLocalModels = false;
const wasm = env.backends.onnx.wasm || (env.backends.onnx.wasm = {});
wasm.wasmPaths = new URL('../../vendor/transformers/ort/', import.meta.url).href;

const MODEL = 'onnx-community/whisper-base';
let asr = null;
let loading = null;
const files = new Map();

function load() {
  if (!loading) {
    loading = pipeline('automatic-speech-recognition', MODEL, {
      dtype: 'q8',
      device: 'wasm',
      progress_callback: (p) => {
        if (p?.status !== 'progress' || !p.file) return;
        files.set(p.file, [p.loaded || 0, p.total || 0]);
        let loaded = 0, total = 0;
        for (const [a, b] of files.values()) { loaded += a; total += b; }
        self.postMessage({ type: 'progress', loaded, total });
      },
    }).then((p) => {
      asr = p;
      self.postMessage({ type: 'ready' });
      return p;
    }, (err) => {
      loading = null;
      throw err;
    });
  }
  return loading;
}

self.onmessage = async (e) => {
  const m = e.data || {};
  if (m.type === 'load') {
    try { await load(); } catch (err) { self.postMessage({ type: 'error', message: String(err?.message || err) }); }
  } else if (m.type === 'run') {
    try {
      const p = asr || (await load());
      const out = await p(m.audio, { language: 'russian', task: 'transcribe' });
      const text = Array.isArray(out) ? out.map((x) => x?.text || '').join(' ') : out?.text || '';
      self.postMessage({ type: 'result', id: m.id, text });
    } catch (err) {
      self.postMessage({ type: 'error', id: m.id, message: String(err?.message || err) });
    }
  }
};
