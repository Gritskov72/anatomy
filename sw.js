// Service worker: оболочка приложения в кэше, модели и данные кэшируются по мере открытия
const VERSION = 'v11';
const SHELL = `atlas-shell-${VERSION}`;
const DATA = 'atlas-data-v1';
const MODELS = 'atlas-models-v1';
// библиотеки ассистента (web-llm, transformers, файлы .wasm): кэш при первом обращении, без предзагрузки
const VENDOR_AI = 'atlas-vendor-ai-v1';

const PRECACHE = [
  './', 'index.html', 'manifest.webmanifest', 'css/app.css',
  'js/main.js', 'js/data.js', 'js/viewer.js', 'js/ui.js', 'js/icons.js', 'js/sheet.js', 'js/panels.js',
  'vendor/three/build/three.module.js', 'vendor/three/build/three.core.js',
  'vendor/three/examples/jsm/controls/OrbitControls.js',
  'vendor/three/examples/jsm/loaders/GLTFLoader.js',
  'vendor/three/examples/jsm/utils/BufferGeometryUtils.js', 'vendor/three/examples/jsm/utils/SkeletonUtils.js',
  'vendor/three/examples/jsm/libs/meshopt_decoder.module.js',
  'icons/apple-touch-icon.png', 'icons/icon-192.png', 'icons/icon-512.png', 'icons/favicon-32.png',
  'about/licenses.md',
];

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    await Promise.all(PRECACHE.map((url) => cache.add(new Request(url, { cache: 'reload' })).catch(() => null)));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = new Set([SHELL, DATA, MODELS, VENDOR_AI]);
    for (const key of await caches.keys()) if (key.startsWith('atlas-') && !keep.has(key)) await caches.delete(key);
    await self.clients.claim();
  })());
});

const ok = (res) => res && res.status === 200 && res.type === 'basic';

// модели: сначала кэш; новая версия файла приходит с другим параметром ?v= и вытесняет старую
async function model(request) {
  const cache = await caches.open(MODELS);
  const hit = await cache.match(request);
  if (hit) return hit;
  const res = await fetch(request);
  if (ok(res)) {
    const url = new URL(request.url);
    for (const old of await cache.keys()) if (new URL(old.url).pathname === url.pathname) await cache.delete(old);
    await cache.put(request, res.clone());
  }
  return res;
}

// библиотеки ассистента: файлы не меняются, отдаём из кэша, в сеть только при первом обращении
async function cacheFirst(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: true });
  if (hit) return hit;
  const res = await fetch(request);
  // ответы CDN приходят с типом cors, свои файлы с типом basic
  if (res && res.status === 200 && (res.type === 'basic' || res.type === 'cors')) event.waitUntil(cache.put(request, res.clone()).catch(() => null));
  return res;
}

// каталог: сначала сеть, без сети из кэша
async function networkFirst(request) {
  const cache = await caches.open(DATA);
  try {
    const res = await fetch(request);
    if (ok(res)) await cache.put(request.url, res.clone());
    else if (res.status === 404) await cache.delete(request.url);
    return res;
  } catch (err) {
    const hit = await cache.match(request.url);
    if (hit) return hit;
    throw err;
  }
}

// остальное: отдаём из кэша сразу и обновляем в фоне (новые js/assistant/* попадают в кэш при первом обращении)
async function staleWhileRevalidate(request, cacheName, event) {
  const cache = await caches.open(cacheName);
  const hit = await cache.match(request, { ignoreSearch: request.mode === 'navigate' });
  const update = fetch(request).then(async (res) => { if (ok(res)) await cache.put(request, res.clone()); return res; });
  if (hit) { event.waitUntil(update.catch(() => null)); return hit; }
  try { return await update; } catch (err) {
    if (request.mode === 'navigate') { const index = await cache.match('index.html'); if (index) return index; }
    throw err;
  }
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;
  // запросы с Range и на другие домены (huggingface.co, raw.githubusercontent.com, CDN) идут мимо service worker
  if (request.headers.has('range')) return;
  const url = new URL(request.url);
  // библиотека распознавания речи берётся с CDN и хранится в кэше для работы без сети
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.includes('/@huggingface/transformers@')) { event.respondWith(cacheFirst(request, VENDOR_AI, event)); return; }
  // Piper: среда onnxruntime-web и piper-wasm с CDN, тоже в кэш для работы без сети (модели голосов хранятся в OPFS)
  if (url.hostname === 'cdnjs.cloudflare.com' && url.pathname.startsWith('/ajax/libs/onnxruntime-web/')) { event.respondWith(cacheFirst(request, VENDOR_AI, event)); return; }
  if (url.hostname === 'cdn.jsdelivr.net' && url.pathname.startsWith('/npm/@diffusionstudio/piper-wasm@')) { event.respondWith(cacheFirst(request, VENDOR_AI, event)); return; }
  if (url.origin !== self.location.origin) return;
  const path = url.pathname;
  if (path.endsWith('.glb')) event.respondWith(model(request));
  else if (path.includes('/vendor/web-llm/') || path.includes('/vendor/transformers/') || path.includes('/vendor/piper/')) event.respondWith(cacheFirst(request, VENDOR_AI, event));
  else if (path.endsWith('catalog.json')) event.respondWith(networkFirst(request));
  else if (path.includes('/data/')) event.respondWith(staleWhileRevalidate(request, DATA, event));
  else event.respondWith(staleWhileRevalidate(request, SHELL, event));
});
