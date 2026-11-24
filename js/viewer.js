// 3D-сцена: ленивая загрузка моделей, роли элементов, выбор тапом, камера, движения. Рендер по требованию.
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import { SYSTEM_ORDER } from './data.js';

const V = (a) => new THREE.Vector3(a[0], a[1], a[2]);
const easeOut = (t) => 1 - Math.pow(1 - t, 3);

export const VIEW_DIRS = {
  front: [0, 0, 1], back: [0, 0, -1], left: [1, 0, 0], right: [-1, 0, 0], top: [0, 1, 0.001], bottom: [0, -1, 0.001],
};

export class Viewer {
  constructor(canvas, data, handlers = {}) {
    this.canvas = canvas;
    this.data = data;
    this.h = handlers;
    this.frames = 0;

    const renderer = this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x000000, 0);
    // прозрачные оболочки рисуем от ближних к дальним с записью глубины: виден один чистый слой
    renderer.setTransparentSort((a, b) => a.groupOrder - b.groupOrder || a.renderOrder - b.renderOrder || a.z - b.z || a.id - b.id);

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(30, 1, 0.01, 60);
    this.camera.position.set(0.9, 1.1, 4.2);
    this.scene.add(this.camera);

    this.scene.add(new THREE.HemisphereLight(0xffffff, 0x9aa3b5, 1.15));
    const key = new THREE.DirectionalLight(0xffffff, 1.9); key.position.set(0.35, 0.55, 1); this.camera.add(key);
    const fill = new THREE.DirectionalLight(0xdfe8ff, 0.5); fill.position.set(-1, -0.2, 0.3); this.camera.add(fill);
    const rim = new THREE.DirectionalLight(0xffffff, 0.55); rim.position.set(0, 2, -3); this.scene.add(rim);

    const controls = this.controls = new OrbitControls(this.camera, canvas);
    controls.enableDamping = true; controls.dampingFactor = 0.14;
    controls.rotateSpeed = 0.85; controls.zoomSpeed = 1.1; controls.panSpeed = 0.9;
    controls.screenSpacePanning = true;
    controls.minDistance = 0.02; controls.maxDistance = 9;
    controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
    controls.target.set(0, 0.9, 0);
    controls.addEventListener('change', () => this.requestRender());

    this.root = new THREE.Group(); this.scene.add(this.root);
    this.objs = new Map();        // id -> { meshes, box, hasVC }
    this.roles = new Map();       // id -> роль или null
    this.modelState = new Map();  // file -> 'queued' | 'loading' | 'ready' | 'error'
    this.queue = []; this.active = 0; this.progress = new Map();
    this.pickList = [];
    this.insets = { top: 0, bottom: 0, left: 0 }; this.shiftY = 0; this.shiftTarget = 0; this.shiftX = 0; this.shiftXTarget = 0;
    this.raycaster = new THREE.Raycaster();
    this.movement = null; this.angle = 0;

    this._materials();
    this._loader = new GLTFLoader();
    this._loader.setMeshoptDecoder(MeshoptDecoder);
    this._gestures();

    new ResizeObserver(() => this._resize()).observe(canvas.parentElement);
    this._resize();
    canvas.addEventListener('webglcontextrestored', () => this.requestRender());
  }

  // ---------- материалы ----------
  _materials() {
    const std = (o) => new THREE.MeshStandardMaterial({ roughness: 0.62, metalness: 0, side: THREE.DoubleSide, ...o });
    const faded = (o) => new THREE.MeshStandardMaterial({ roughness: 0.8, metalness: 0, transparent: true, opacity: 0.16, depthWrite: true, side: THREE.FrontSide, ...o });
    const m = this.mat = { sys: new Map(), sysFaded: new Map() };
    for (const s of this.data.systems) {
      m.sys.set(s.id, std({ color: s.color, roughness: s.id === 'bones' ? 0.72 : 0.55, ...(s.id === 'fascia' ? { transparent: true, opacity: 0.5 } : {}) }));
      m.sysFaded.set(s.id, faded({ color: s.color }));
    }
    m.vc = std({ color: 0xffffff, vertexColors: true });
    m.vcFaded = faded({ color: 0xffffff, vertexColors: true });
    m.vein = std({ color: 0x3f6fc4, roughness: 0.55 });
    m.selected = std({ color: 0x35d6c1, emissive: 0x0b6f63, emissiveIntensity: 0.55, roughness: 0.45 });
    m.agonist = std({ color: 0xff6a55, emissive: 0x7a1c10, emissiveIntensity: 0.45, roughness: 0.5 });
    m.antagonist = std({ color: 0x5aa9ff, emissive: 0x123f7a, emissiveIntensity: 0.45, roughness: 0.5 });
  }

  setAccent(hex) { this.mat.selected.color.set(hex); this.requestRender(); }

  _material(item, o, role) {
    const m = this.mat;
    if (role === 'selected') return m.selected;
    if (role === 'agonist') return m.agonist;
    if (role === 'antagonist') return m.antagonist;
    if (role === 'faded') return o.hasVC ? m.vcFaded : m.sysFaded.get(item.system) || m.vcFaded;
    if (o.hasVC) return m.vc;
    if (item.system === 'vessels' && /^(вен|vena|vein|v\.)/i.test(`${item.ru || ''}`) ) return m.vein;
    if (item.system === 'vessels' && /^(vena|venae|v\.)\b/i.test(`${item.lat || ''}`)) return m.vein;
    return m.sys.get(item.system) || m.vc;
  }

  // ---------- роли и видимость ----------
  /** roleOf(item) -> null | 'normal' | 'faded' | 'selected' | 'agonist' | 'antagonist' */
  apply(roleOf) {
    const need = new Set();
    for (const item of this.data.items) {
      const role = roleOf(item) || null;
      this.roles.set(item.id, role);
      if (role && item.modelRef) need.add(item.modelRef);
      const o = this.objs.get(item.id);
      if (o) this._setRole(item, o, role);
    }
    this._rebuildPickList();
    this._ensure(need);
    this.requestRender();
  }

  _setRole(item, o, role) {
    for (const mesh of o.meshes) {
      mesh.visible = !!role;
      if (role) { mesh.material = this._material(item, o, role); mesh.renderOrder = role === 'faded' ? 2 : 0; }
    }
  }

  _rebuildPickList() {
    this.pickList.length = 0;
    for (const [id, o] of this.objs) if (this.roles.get(id)) this.pickList.push(...o.meshes);
  }

  // ---------- загрузка ----------
  _ensure(need) {
    this.queue = this.queue.filter((m) => need.has(m) || (this.modelState.delete(m.file), false));
    for (const m of need) {
      if (this.modelState.has(m.file)) continue;
      this.modelState.set(m.file, 'queued');
      this.queue.push(m);
    }
    const rank = (m) => { const i = SYSTEM_ORDER.indexOf(m.system); return i < 0 ? 99 : i; };
    this.queue.sort((a, b) => rank(a) - rank(b) || (a.bytes || 0) - (b.bytes || 0));
    this._pump();
  }

  _pump() {
    while (this.active < 2 && this.queue.length) {
      const m = this.queue.shift();
      this.active++;
      this.modelState.set(m.file, 'loading');
      this.progress.set(m.file, { model: m, loaded: 0, total: m.bytes || 0 });
      this._emitProgress();
      this._load(m).then(() => {
        this.modelState.set(m.file, 'ready');
      }).catch((err) => {
        this.modelState.set(m.file, 'error');
        console.warn('Модель не загружена:', m.file, err?.message || err);
        this.h.onError?.(m, err);
      }).finally(() => {
        this.active--;
        this.progress.delete(m.file);
        this._emitProgress();
        this._pump();
      });
    }
  }

  _emitProgress() {
    let loaded = 0, total = 0; const systems = new Set();
    for (const p of this.progress.values()) { loaded += p.loaded; total += p.total; systems.add(p.model.system); }
    for (const m of this.queue) { total += m.bytes || 0; systems.add(m.system); }
    this.h.onProgress?.({ busy: this.active > 0 || this.queue.length > 0, loaded, total, systems: [...systems] });
  }

  /** Повторить загрузку моделей, которые упали с ошибкой. */
  retryFailed() {
    for (const [file, st] of this.modelState) if (st === 'error') this.modelState.delete(file);
  }

  async _fetch(m) {
    const res = await fetch(m.url);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const p = this.progress.get(m.file);
    const len = +res.headers.get('content-length') || 0;
    if (p && !p.total) p.total = len;
    if (!res.body?.getReader) return res.arrayBuffer();
    const reader = res.body.getReader();
    const chunks = []; let size = 0, last = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value); size += value.byteLength;
      if (p) { p.loaded = size; if (size > p.total) p.total = size; }
      const now = performance.now();
      if (now - last > 80) { last = now; this._emitProgress(); }
    }
    const out = new Uint8Array(size); let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.byteLength; }
    return out.buffer;
  }

  async _load(m) {
    const buf = await this._fetch(m);
    const head = new TextDecoder().decode(new Uint8Array(buf, 0, Math.min(buf.byteLength, 4096)));
    if (head.includes('KHR_draco_mesh_compression') && !this._draco) {
      const { DRACOLoader } = await import('three/addons/loaders/DRACOLoader.js');
      this._draco = new DRACOLoader();
      this._draco.setDecoderPath(new URL('../vendor/three/examples/jsm/libs/draco/gltf/', import.meta.url).href);
      this._loader.setDRACOLoader(this._draco);
    }
    const gltf = await new Promise((ok, fail) => this._loader.parse(buf, '', ok, fail));
    const scene = gltf.scene;
    scene.updateMatrixWorld(true);
    const byName = new Map();
    scene.traverse((o) => {
      if (o.isMesh) o.visible = false;
      for (const n of [o.userData?.name, o.name]) if (n && !byName.has(n)) byName.set(n, o);
    });
    let missing = 0;
    for (const item of m.items) {
      const obj = byName.get(item.node) || byName.get(item.id) || byName.get(THREE.PropertyBinding.sanitizeNodeName(item.node));
      if (!obj) { missing++; continue; }
      const meshes = [];
      obj.traverse((c) => { if (c.isMesh && !c.userData.itemId) { c.userData.itemId = item.id; meshes.push(c); } });
      if (!meshes.length) { missing++; continue; }
      const box = new THREE.Box3(); let hasVC = false;
      for (const mesh of meshes) {
        const g = mesh.geometry;
        if (!g.attributes.normal) g.computeVertexNormals();
        if (g.attributes.color) hasVC = true;
        if (!g.boundingBox) g.computeBoundingBox();
        box.union(g.boundingBox.clone().applyMatrix4(mesh.matrixWorld));
        mesh.userData.baseLocal = mesh.matrix.clone();
        mesh.userData.baseWorld = mesh.matrixWorld.clone();
        if (mesh.material?.dispose && !mesh.userData.keptMat) mesh.material.dispose();
      }
      const o = { meshes, box, hasVC };
      this.objs.set(item.id, o);
      this._setRole(item, o, this.roles.get(item.id) || null);
    }
    if (missing) console.warn(`В ${m.file} не найдено узлов: ${missing} из ${m.items.length}`);
    this.root.add(scene);
    this._rebuildPickList();
    if (this.movement) this._applyMovement();
    this.h.onModel?.(m);
    if (this._pendingFocus && this._pendingFocus.ids.every((id) => this.objs.has(id) || !this.data.itemById.get(id)?.modelRef || this.modelState.get(this.data.itemById.get(id).modelRef.file) === 'error')) {
      const p = this._pendingFocus; this._pendingFocus = null;
      this.focus(p.ids, p.opts);
    }
    this.requestRender();
  }

  isLoaded(id) { return this.objs.has(id); }

  // ---------- габариты и камера ----------
  itemBox(item, out = new THREE.Box3()) {
    const o = this.objs.get(item.id);
    if (o && !o.box.isEmpty()) return out.copy(o.box);
    if (Array.isArray(item.bbox) && item.bbox.length === 2) return out.set(V(item.bbox[0]), V(item.bbox[1]));
    if (Array.isArray(item.center)) { const c = V(item.center); return out.setFromCenterAndSize(c, new THREE.Vector3(0.05, 0.05, 0.05)); }
    return out.makeEmpty();
  }

  boxOf(ids) {
    const box = new THREE.Box3(), tmp = new THREE.Box3();
    for (const id of ids) {
      const item = this.data.itemById.get(id); if (!item) continue;
      this.itemBox(item, tmp); if (!tmp.isEmpty()) box.union(tmp);
    }
    return box;
  }

  visibleIds({ solidOnly = false } = {}) {
    const ids = [];
    for (const [id, role] of this.roles) if (role && !(solidOnly && role === 'faded')) ids.push(id);
    return ids;
  }

  /** Навести камеру на элементы. opts: { dir: [x,y,z], animate, pad, extra: [точки] } */
  focus(ids, opts = {}) {
    const box = this.boxOf(ids);
    for (const p of opts.extra || []) box.expandByPoint(V(p));
    if (box.isEmpty()) return;
    if (opts.wait !== false && ids.some((id) => !this.objs.has(id) && this.roles.get(id))) this._pendingFocus = { ids: ids.slice(), opts: { ...opts, wait: false } };
    this.fitBox(box, opts);
  }

  fitVisible(opts = {}) {
    let ids = this.visibleIds({ solidOnly: true });
    if (!ids.length) ids = this.visibleIds();
    if (ids.length) this.focus(ids, { wait: false, ...opts });
  }

  fitBox(box, { dir, animate = true, pad = 1.12 } = {}) {
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    const size = box.getSize(new THREE.Vector3());
    const w = this.width || 1, h = this.height || 1;
    const visH = Math.max(120, h - this.insets.top - this.insets.bottom);
    const tanV = Math.tan(THREE.MathUtils.degToRad(this.camera.fov) / 2);
    const tanVis = tanV * (visH / h), tanH = tanV * (Math.max(120, w - this.insets.left) / h);
    const d = dir ? V(dir).normalize() : this.camera.position.clone().sub(this.controls.target).normalize();
    // вытянутые объекты (тело целиком) подгоняем по высоте и ширине, компактные по сфере
    const r = Math.max(sphere.radius, 0.012);
    const up = Math.abs(d.y) > 0.9;
    const halfH = up ? Math.max(size.x, size.z) / 2 : size.y / 2;
    const halfW = Math.max(size.x, size.z) / 2;
    const byBox = Math.max(halfH / tanVis, halfW / tanH) + Math.max(size.x, size.z) / 2;
    const bySphere = r / Math.sin(Math.atan(Math.min(tanVis, tanH)));
    const dist = Math.min(bySphere, Math.max(byBox, r * 1.6)) * pad;
    const target = sphere.center.clone();
    const pos = target.clone().add(d.multiplyScalar(THREE.MathUtils.clamp(dist, this.controls.minDistance * 2, this.controls.maxDistance)));
    this.moveCamera(pos, target, animate);
  }

  moveCamera(pos, target, animate = true) {
    if (!animate) {
      this.tween = null;
      this.camera.position.copy(pos); this.controls.target.copy(target);
      this.controls.update(); this.requestRender();
      return;
    }
    this.tween = { t0: performance.now(), dur: 520, p0: this.camera.position.clone(), q0: this.controls.target.clone(), p1: pos.clone(), q1: target.clone() };
    this.requestRender();
  }

  setView(name) {
    const dir = VIEW_DIRS[name]; if (!dir) return;
    const target = this.controls.target.clone();
    const dist = this.camera.position.distanceTo(target);
    this.moveCamera(target.clone().add(V(dir).normalize().multiplyScalar(dist)), target, true);
  }

  getPose() { return { p: this.camera.position.toArray(), t: this.controls.target.toArray() }; }
  setPose(pose, animate = true) { if (pose) this.moveCamera(V(pose.p), V(pose.t), animate); }

  /** Области экрана, закрытые панелями: сцена центрируется в свободной части. */
  setInsets(top, bottom, left = 0) {
    this.insets = { top, bottom, left };
    this.shiftTarget = (bottom - top) / 2;
    this.shiftXTarget = -left / 2;
    this.requestRender();
  }

  snapInsets() { this.shiftY = this.shiftTarget; this.shiftX = this.shiftXTarget; this._applyShift(); }

  _resize() {
    const el = this.canvas.parentElement;
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    this.width = w; this.height = h;
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this._applyShift();
    this.requestRender();
  }

  _applyShift() {
    if (Math.abs(this.shiftY) < 0.5 && Math.abs(this.shiftX) < 0.5) this.camera.clearViewOffset();
    else this.camera.setViewOffset(this.width, this.height, this.shiftX, this.shiftY, this.width, this.height);
    this.camera.updateProjectionMatrix();
  }

  // ---------- рендер по требованию ----------
  requestRender() { if (!this._raf) this._raf = requestAnimationFrame((t) => this._frame(t)); }

  _frame(now) {
    this._raf = 0;
    let again = false;
    if (this.tween) {
      const k = Math.min(1, (now - this.tween.t0) / this.tween.dur), e = easeOut(k);
      this.camera.position.lerpVectors(this.tween.p0, this.tween.p1, e);
      this.controls.target.lerpVectors(this.tween.q0, this.tween.q1, e);
      if (k >= 1) this.tween = null; else again = true;
    }
    if (Math.abs(this.shiftTarget - this.shiftY) > 0.5 || Math.abs(this.shiftXTarget - this.shiftX) > 0.5) {
      this.shiftY += (this.shiftTarget - this.shiftY) * 0.22; this.shiftX += (this.shiftXTarget - this.shiftX) * 0.22; again = true; this._applyShift();
    } else if (this.shiftY !== this.shiftTarget || this.shiftX !== this.shiftXTarget) { this.shiftY = this.shiftTarget; this.shiftX = this.shiftXTarget; this._applyShift(); }
    if (this.onFrame && this.onFrame(now)) again = true;
    if (this.controls.update()) again = true;
    const dist = this.camera.position.distanceTo(this.controls.target);
    const near = Math.max(0.002, dist / 60), far = dist + 30;
    if (Math.abs(this.camera.near - near) / near > 0.2) { this.camera.near = near; this.camera.far = far; this.camera.updateProjectionMatrix(); }
    this.renderer.render(this.scene, this.camera);
    this.frames++;
    if (again) this.requestRender();
  }

  // ---------- жесты: тап и двойной тап ----------
  _gestures() {
    const c = this.canvas;
    const downs = new Map(); let multi = false, lastTap = null;
    c.addEventListener('pointerdown', (e) => {
      downs.set(e.pointerId, { x: e.clientX, y: e.clientY, t: performance.now() });
      if (downs.size > 1) multi = true;
      this.tween = null;
    });
    const up = (e) => {
      const d = downs.get(e.pointerId); downs.delete(e.pointerId);
      const wasMulti = multi; if (!downs.size) multi = false;
      if (!d || wasMulti || e.type === 'pointercancel') return;
      const now = performance.now();
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 9 || now - d.t > 450) return;
      const id = this.pick(e.clientX, e.clientY);
      const dbl = lastTap && now - lastTap.t < 330 && Math.hypot(e.clientX - lastTap.x, e.clientY - lastTap.y) < 34;
      lastTap = dbl ? null : { t: now, x: e.clientX, y: e.clientY };
      if (dbl) this.h.onDoubleTap?.(id); else this.h.onTap?.(id);
    };
    c.addEventListener('pointerup', up);
    c.addEventListener('pointercancel', up);
    c.addEventListener('gesturestart', (e) => e.preventDefault());
    c.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  /** id структуры под точкой экрана или null. Тонкие структуры ловятся с допуском. */
  pick(x, y) {
    const rect = this.canvas.getBoundingClientRect();
    const cast = (px, py) => {
      const ndc = new THREE.Vector2(((px - rect.left) / rect.width) * 2 - 1, -((py - rect.top) / rect.height) * 2 + 1);
      this.raycaster.setFromCamera(ndc, this.camera);
      const hits = this.raycaster.intersectObjects(this.pickList, false);
      if (!hits.length) return null;
      const solid = hits.find((hit) => this.roles.get(hit.object.userData.itemId) !== 'faded');
      return (solid || hits[0]).object.userData.itemId || null;
    };
    let id = cast(x, y);
    if (id) return id;
    for (const r of [7, 13]) for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      id = cast(x + Math.cos(a) * r, y + Math.sin(a) * r);
      if (id) return id;
    }
    return null;
  }

  // ---------- движения ----------
  setMovement(mv, angle = 0) {
    if (this.movement && this.movement !== mv) this._resetMovement();
    this.movement = mv || null;
    this.angle = angle;
    if (mv) this._applyMovement();
    this.requestRender();
  }

  setAngle(deg) { this.angle = deg; if (this.movement) this._applyMovement(); this.requestRender(); }

  _resetMovement() {
    for (const id of this.movement.moving) {
      const o = this.objs.get(id); if (!o) continue;
      for (const mesh of o.meshes) { mesh.matrix.copy(mesh.userData.baseLocal); mesh.matrixAutoUpdate = false; mesh.matrixWorldNeedsUpdate = true; }
    }
  }

  _applyMovement() {
    const mv = this.movement;
    const pivot = V(mv.pivot), axis = V(mv.axis).normalize();
    const R = new THREE.Matrix4().makeTranslation(pivot.x, pivot.y, pivot.z)
      .multiply(new THREE.Matrix4().makeRotationAxis(axis, THREE.MathUtils.degToRad(this.angle)))
      .multiply(new THREE.Matrix4().makeTranslation(-pivot.x, -pivot.y, -pivot.z));
    const inv = new THREE.Matrix4();
    for (const id of mv.moving) {
      const o = this.objs.get(id); if (!o) continue;
      for (const mesh of o.meshes) {
        inv.copy(mesh.parent.matrixWorld).invert();
        mesh.matrix.copy(inv).multiply(R).multiply(mesh.userData.baseWorld);
        mesh.matrixAutoUpdate = false; mesh.matrixWorldNeedsUpdate = true;
      }
    }
  }
}
