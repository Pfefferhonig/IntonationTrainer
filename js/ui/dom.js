// Tiny DOM helpers shared by all screens.

// Namespace import: roundCents (the app-wide cents rounding rule) is feature-checked.
import * as tuning from '../music/tuning.js';

/**
 * Create an element.
 *   el('button', { class: 'btn', type: 'button', onclick: fn }, 'Label', childNode)
 * props: 'class' -> className, 'text' -> textContent, on<event> functions -> listeners,
 * true -> empty attribute, null/undefined/false -> skipped, anything else -> attribute.
 * Children: nodes or strings; arrays are flattened; null/false are skipped.
 */
export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c == null || c === false) continue;
    node.append(c instanceof Node ? c : String(c));
  }
}

/** Replace all children of a node. */
export function setChildren(node, ...children) {
  node.replaceChildren();
  append(node, children);
  return node;
}

/**
 * Round cents the same way everywhere in the app: whole numbers from 10 up, one decimal below 10
 * (tuning.roundCents when available, else the same rule here).
 */
export function roundCentsValue(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return NaN;
  if (typeof tuning.roundCents === 'function') {
    try {
      const r = tuning.roundCents(n);
      if (Number.isFinite(r)) return r;
    } catch { /* fall back */ }
  }
  return Math.abs(n) < 9.95 ? Math.round(n * 10) / 10 : Math.round(n);
}

/** Format a cents value for display: 1 decimal below 10, otherwise whole numbers. */
export function fmtCents(c) {
  const r = roundCentsValue(c);
  return Number.isFinite(r) ? String(Object.is(r, -0) ? 0 : r) : '–';
}

/** fmtCents plus the unit: "23 cents", "1 cent", "3.5 cents". */
export function centsText(c) {
  const s = fmtCents(c);
  return `${s} ${s === '1' ? 'cent' : 'cents'}`;
}

/** Signed cents with a real minus sign, same rounding as fmtCents: +2, −14, +3.5, 0. */
export function signedCents(c) {
  const r = roundCentsValue(c);
  if (!Number.isFinite(r)) return '–';
  if (r === 0) return '0';
  return (r > 0 ? '+' : '−') + Math.abs(r);
}

const SCROLL_MS = 250;
let scrollAnim = null;

function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/**
 * Space taken by sticky/fixed bars marked [data-inset-top] / [data-inset-bottom].
 * Bars can be stacked (phone: the sticky action bar sits on top of the fixed bottom tab bar).
 * A fixed bar counts where it is; a sticky bar counts with its offset + height (where it WILL sit once
 * stuck, so scrolling never ends with content under it). The inset is the furthest edge of all of them.
 */
function viewportInsets() {
  const h = window.innerHeight;
  let top = 0;
  let bottom = 0;
  const px = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  for (const n of document.querySelectorAll('[data-inset-top]')) {
    if (!n.getClientRects().length) continue;
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    if (cs.position === 'fixed') { if (r.bottom > 0 && r.top < h) top = Math.max(top, r.bottom); }
    else if (cs.position === 'sticky') top = Math.max(top, px(cs.top) + r.height);
  }
  for (const n of document.querySelectorAll('[data-inset-bottom]')) {
    if (!n.getClientRects().length) continue;
    const cs = getComputedStyle(n);
    const r = n.getBoundingClientRect();
    if (cs.position === 'fixed') { if (r.top < h && r.bottom > 0) bottom = Math.max(bottom, h - r.top); }
    else if (cs.position === 'sticky') bottom = Math.max(bottom, px(cs.bottom) + r.height);
  }
  return { top, bottom };
}

// cubic-bezier(.2, 0, 0, 1) ("standard" easing), solved numerically.
function easeStandard(t) {
  const bez = (a, b, u) => 3 * a * u * (1 - u) * (1 - u) + 3 * b * u * u * (1 - u) + u * u * u;
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 20; i += 1) {
    const mid = (lo + hi) / 2;
    if (bez(0.2, 0, mid) < t) lo = mid; else hi = mid;
  }
  return bez(0, 1, (lo + hi) / 2);
}

function scrollByAnimated(delta) {
  if (scrollAnim) scrollAnim.cancel();
  if (reducedMotion() || Math.abs(delta) < 4) {
    window.scrollBy(0, delta);
    return;
  }
  const from = window.scrollY;
  const to = from + delta;
  const t0 = performance.now();
  let cancelled = false;
  const anim = { cancel() { cancelled = true; } };
  scrollAnim = anim;
  const step = (now) => {
    if (cancelled) return;
    const t = Math.min(1, (now - t0) / SCROLL_MS);
    window.scrollTo(0, from + (to - from) * easeStandard(t));
    if (t < 1) requestAnimationFrame(step);
    else if (scrollAnim === anim) scrollAnim = null;
  };
  requestAnimationFrame(step);
  // Background tabs pause animation frames: make sure we still end up there.
  setTimeout(() => {
    if (!cancelled && scrollAnim === anim) {
      window.scrollTo(0, to);
      scrollAnim = null;
    }
  }, SCROLL_MS + 200);
}

/**
 * The smallest scroll that keeps all given elements visible (between sticky header/bottom bars).
 * If they don't fit together, the first (topmost) one goes to the top. 250 ms with the standard
 * easing; instant with reduced motion. Old calls reveal(top, mustSee) work the same way.
 */
export function reveal(...elements) {
  const els = elements.flat().filter((e) => e && e.isConnected && e.getClientRects().length
    && !(e.closest && e.closest('[data-inset-bottom], [data-inset-top]')
      && ['sticky', 'fixed'].includes(getComputedStyle(e.closest('[data-inset-bottom], [data-inset-top]')).position)));
  if (!els.length) return;
  const inset = viewportInsets();
  const margin = 12;
  const viewTop = inset.top + margin;
  const viewBottom = window.innerHeight - inset.bottom - margin;
  let top = Infinity;
  let bottom = -Infinity;
  for (const e of els) {
    const r = e.getBoundingClientRect();
    top = Math.min(top, r.top);
    bottom = Math.max(bottom, r.bottom);
  }
  // The top of the group always stays visible; otherwise scroll as little as possible
  // (when the group is taller than the free space, its top ends at the top of that space).
  let delta = 0;
  if (top < viewTop) delta = top - viewTop;
  else if (bottom > viewBottom) delta = Math.min(top - viewTop, bottom - viewBottom);
  if (Math.abs(delta) < 1) return;
  scrollByAnimated(delta);
}

let uid = 0;
/** Unique id for label/aria wiring. */
export function uniqueId(prefix = 'id') {
  uid += 1;
  return `${prefix}-${uid}`;
}
