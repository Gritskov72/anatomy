// Личные данные Степана: документы и история диалога в IndexedDB (база anatomy-profile). Всё хранится только на устройстве

const DB_NAME = 'anatomy-profile';
const DB_VER = 1;
export const PIN_LIMIT = 1500;

let dbp = null;
function openDb() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VER);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('docs')) db.createObjectStore('docs', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('dialog')) db.createObjectStore('dialog', { keyPath: 'id' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => { dbp = null; reject(req.error); };
    });
  }
  return dbp;
}

/** Одна транзакция: fn получает хранилище и может вернуть запрос, его результат придёт в промисе. */
async function run(storeName, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(storeName, mode);
    const req = fn(tx.objectStore(storeName));
    tx.oncomplete = () => resolve(req ? req.result : undefined);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`);
const autoPin = (title) => /^\s*00/.test(title || '') || /кратко/i.test(title || '');
const cutText = (s, n) => { s = String(s || '').trim(); return s.length <= n ? s : `${s.slice(0, n).replace(/\s+\S*$/, '')}…`; };

// JSON без своей структуры документов превращаем в строки «путь: значение»
function flatJson(v, path = '', out = []) {
  if (v == null) return out;
  if (Array.isArray(v)) { for (const x of v) flatJson(x, path, out); return out; }
  if (typeof v === 'object') { for (const [k, x] of Object.entries(v)) flatJson(x, path ? `${path} / ${k}` : k, out); return out; }
  out.push(path ? `${path}: ${v}` : String(v));
  return out;
}

export class Profile {
  constructor() { this.docs = []; this.ready = null; }

  init() {
    if (!this.ready) {
      this.ready = run('docs', 'readonly', (s) => s.getAll())
        .then((list) => { this.docs = Array.isArray(list) ? list : []; this.sort(); })
        .catch((err) => { console.warn('Личные данные недоступны', err); this.docs = []; });
    }
    return this.ready;
  }

  /** Просим браузер не стирать данные при нехватке места. */
  persist() { try { navigator.storage?.persist?.().catch(() => {}); } catch (e) { /* не поддерживается */ } }

  sort() { this.docs.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0) || (b.addedAt || 0) - (a.addedAt || 0)); }
  list() { return this.docs; }
  get(id) { return this.docs.find((d) => d.id === id) || null; }
  pinned() { return this.docs.find((d) => d.pinned) || null; }
  pinnedText() { const d = this.pinned(); return d ? cutText(d.text, PIN_LIMIT) : ''; }

  async add({ title, text, pinned }) {
    await this.init();
    const name = String(title || '').trim() || 'Без названия';
    const doc = { id: uid(), title: name, text: String(text || '').replace(/\r\n?/g, '\n').trim(), addedAt: Date.now(), pinned: pinned ?? autoPin(name) };
    if (doc.pinned) await this.unpinAll();
    await run('docs', 'readwrite', (s) => s.put(doc));
    this.docs.push(doc);
    this.sort();
    return doc;
  }

  async unpinAll(except = null) {
    for (const d of this.docs) {
      if (!d.pinned || d.id === except) continue;
      d.pinned = false;
      await run('docs', 'readwrite', (s) => s.put(d));
    }
  }

  /** Закреплён может быть один документ: он целиком идёт в каждый запрос к модели. */
  async togglePin(id) {
    const d = this.get(id);
    if (!d) return false;
    const on = !d.pinned;
    if (on) await this.unpinAll(id);
    d.pinned = on;
    await run('docs', 'readwrite', (s) => s.put(d));
    this.sort();
    return on;
  }

  async remove(id) {
    await run('docs', 'readwrite', (s) => s.delete(id));
    this.docs = this.docs.filter((d) => d.id !== id);
  }

  /** Импорт .md, .txt, .json. Возвращает число добавленных документов. */
  async importFiles(files) {
    let n = 0;
    for (const f of files) {
      const name = f.name || 'Документ';
      const title = name.replace(/\.(md|markdown|txt|json)$/i, '');
      let text = '';
      try { text = await f.text(); } catch (e) { continue; }
      if (/\.json$/i.test(name) || f.type === 'application/json') {
        let data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        const list = Array.isArray(data) ? data : Array.isArray(data?.docs) ? data.docs : null;
        if (list && list.length && list.every((d) => d && typeof d.text === 'string')) {
          for (const d of list) { await this.add({ title: d.title || title, text: d.text, pinned: typeof d.pinned === 'boolean' ? d.pinned : undefined }); n++; }
          continue;
        }
        if (data != null && typeof data === 'object') text = flatJson(data).join('\n');
      }
      if (!text.trim()) continue;
      await this.add({ title, text });
      n++;
    }
    return n;
  }

  /** Все документы одним файлом Markdown. */
  exportMd() {
    const date = new Date().toISOString().slice(0, 10);
    const text = this.docs.map((d) => `# ${d.title}\n\n${d.text.trim()}\n`).join('\n');
    return { name: `moi-dannye-${date}.md`, text };
  }

  // ---------- история диалога ----------
  async loadDialog() {
    try { const r = await run('dialog', 'readonly', (s) => s.get('current')); return Array.isArray(r?.messages) ? r.messages : []; }
    catch (e) { return []; }
  }

  saveDialog(messages) {
    return run('dialog', 'readwrite', (s) => s.put({ id: 'current', messages: messages.slice(-100), savedAt: Date.now() })).catch(() => {});
  }

  clearDialog() { return run('dialog', 'readwrite', (s) => s.delete('current')).catch(() => {}); }
}
