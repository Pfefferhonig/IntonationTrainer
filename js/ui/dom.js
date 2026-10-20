// Tiny DOM helpers shared by all screens.

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

/** Format a cents value for display: 1 decimal below 10, otherwise whole numbers. */
export function fmtCents(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return '–';
  const a = Math.abs(n);
  return a < 9.95 ? (Math.round(n * 10) / 10).toString() : Math.round(n).toString();
}

/** fmtCents plus the unit: "23 cents", "1 cent", "3.5 cents". */
export function centsText(c) {
  const s = fmtCents(c);
  return `${s} ${s === '1' ? 'cent' : 'cents'}`;
}

/** Signed whole cents with a real minus sign: +2, −14, 0. */
export function signedCents(c) {
  const r = Math.round(c);
  if (r === 0) return '0';
  return (r > 0 ? '+' : '−') + Math.abs(r);
}

/**
 * Scroll so that `top` starts at the top of the window, unless `top` and `mustSee`
 * are both already fully visible. Smooth unless the user prefers reduced motion.
 */
export function reveal(top, mustSee = top) {
  if (!top || !top.isConnected) return;
  const a = top.getBoundingClientRect();
  const b = mustSee.getBoundingClientRect();
  if (a.top >= 0 && b.bottom <= window.innerHeight) return;
  let reduce = false;
  try { reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { /* old browser */ }
  top.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
}

let uid = 0;
/** Unique id for label/aria wiring. */
export function uniqueId(prefix = 'id') {
  uid += 1;
  return `${prefix}-${uid}`;
}
