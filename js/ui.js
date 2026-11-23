// Мелкие помощники интерфейса: выборка, экранирование, хранилище, всплывающее меню, уведомление
import { icon } from './icons.js';

export const $ = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => [...r.querySelectorAll(s)];
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const KEY = 'anatomy.v1';
let cache = null;
const read = () => { if (!cache) { try { cache = JSON.parse(localStorage.getItem(KEY) || '{}') || {}; } catch (e) { cache = {}; } } return cache; };
export const store = {
  get(k, d) { const v = read()[k]; return v === undefined ? d : v; },
  set(k, v) { read()[k] = v; try { localStorage.setItem(KEY, JSON.stringify(cache)); } catch (e) { /* хранилище недоступно */ } },
};

let toastTimer = 0;
export function toast(text, ms = 2200) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('on');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('on'), ms);
}

/** Меню у кнопки. items: [{ label, icon, checked, hint, danger, onClick }] */
export function openMenu(anchor, items, { align = 'left' } = {}) {
  const layer = $('#menu-layer'), menu = $('#menu');
  menu.innerHTML = items.map((it, i) => it.sep ? '<div class="menu-sep"></div>'
    : `<button class="menu-item${it.checked ? ' checked' : ''}" role="menuitem" data-i="${i}">
        <span class="menu-ic">${it.checked ? icon('check', 20) : it.icon ? icon(it.icon, 20) : ''}</span>
        <span class="menu-label">${esc(it.label)}</span>${it.hint ? `<span class="menu-hint">${esc(it.hint)}</span>` : ''}
      </button>`).join('');
  layer.hidden = false;
  const r = anchor.getBoundingClientRect();
  const w = Math.min(300, window.innerWidth - 24);
  menu.style.width = `${w}px`;
  menu.style.top = `${r.bottom + 8}px`;
  const left = align === 'right' ? r.right - w : r.left;
  menu.style.left = `${Math.max(12, Math.min(left, window.innerWidth - w - 12))}px`;
  menu.style.maxHeight = `${window.innerHeight - r.bottom - 40}px`;
  menu.style.transformOrigin = align === 'right' ? 'top right' : 'top left';
  requestAnimationFrame(() => layer.classList.add('on'));
  const close = () => {
    layer.classList.remove('on');
    layer.removeEventListener('click', onClick);
    setTimeout(() => { if (!layer.classList.contains('on')) layer.hidden = true; }, 180);
  };
  const onClick = (e) => {
    const b = e.target.closest('.menu-item');
    close();
    if (b) items[+b.dataset.i]?.onClick?.();
  };
  layer.addEventListener('click', onClick);
  return close;
}

/** Простой Markdown: заголовки, списки, абзацы, жирный, код, ссылки. */
export function md(src) {
  const inline = (s) => esc(s)
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+[^\s<).,;])/g, '$1<a href="$2" target="_blank" rel="noopener">$2</a>');
  const out = []; let list = false, para = [];
  const flush = () => { if (para.length) { out.push(`<p>${para.map(inline).join('<br>')}</p>`); para = []; } };
  const endList = () => { if (list) { out.push('</ul>'); list = false; } };
  for (const line of String(src).replace(/^\s*#\s+.*\r?\n/, '').split(/\r?\n/)) {
    const hm = line.match(/^(#{1,4})\s+(.*)$/), lm = line.match(/^\s*[-*]\s+(.*)$/);
    if (hm) { flush(); endList(); const n = Math.min(4, hm[1].length + 1); out.push(`<h${n}>${inline(hm[2])}</h${n}>`); }
    else if (lm) { flush(); if (!list) { out.push('<ul>'); list = true; } out.push(`<li>${inline(lm[1])}</li>`); }
    else if (!line.trim()) { flush(); endList(); }
    else if (/^\s*\|/.test(line)) { flush(); endList(); if (!/^\s*\|[\s:|-]+\|\s*$/.test(line)) out.push(`<p>${inline(line.replace(/^\s*\||\|\s*$/g, '').split('|').map((c) => c.trim()).join(' · '))}</p>`); }
    else { endList(); para.push(line.trim()); }
  }
  flush(); endList();
  return out.join('');
}

export const SIDE_RU = { L: 'Л', R: 'П' };
export const SIDE_FULL = { L: 'левая сторона', R: 'правая сторона' };
