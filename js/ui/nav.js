// The persistent tab bar.

import { el } from './dom.js';
import { icon } from './icons.js';

// route = the part after '#/'. Order = order in the tab bar.
// label: short text on the tab; title: full name (tooltip).
export const TABS = [
  { route: 'higher-or-lower', label: 'Higher / lower', title: 'Higher or lower?', icon: 'arrow-up-down' },
  { route: 'odd-one-out', label: 'Odd one out', title: 'Odd one out', icon: 'music' },
  { route: 'tune', label: 'Lock it in', title: 'Lock it in — slide a note until it locks into tune', icon: 'sliders-horizontal' },
  { route: 'sing-back', label: 'Echo', title: 'Echo — sing back the note you heard', icon: 'repeat-2' },
  { route: 'sing', label: 'Join the chord', title: 'Join the chord — sing the missing note', icon: 'mic-vocal' },
  { route: 'stats', label: 'Your stats', title: 'Your stats — an overview to share', icon: 'trending-up' },
];

// Routes that highlight a tab other than their own (sub-pages).
export const TAB_FOR_ROUTE = { 'settings/sound-check': 'settings' };

export const SETTINGS_TAB = { route: 'settings', label: 'Settings', icon: 'settings' };

/** Build the tab bar into `host`. Returns { setActive(route) }. */
export function renderTabBar(host) {
  const links = new Map();

  const list = el('ul', { class: 'tabs' });
  for (const t of TABS) {
    const a = el('a', { class: `tab${t.soon ? ' is-soon' : ''}`, href: `#/${t.route}`, title: t.title || null },
      icon(t.icon, { size: 18 }),
      el('span', { class: 'tab-label' }, t.label),
      t.soon ? el('span', { class: 'tab-soon' }, 'soon') : null,
    );
    links.set(t.route, a);
    list.append(el('li', {}, a));
  }

  const gear = el('a', {
    class: 'tab tab-settings',
    href: `#/${SETTINGS_TAB.route}`,
    'aria-label': SETTINGS_TAB.label,
    title: SETTINGS_TAB.label,
  }, icon(SETTINGS_TAB.icon, { size: 20 }));
  links.set(SETTINGS_TAB.route, gear);

  const scroller = el('div', { class: 'tabs-scroll' }, list);
  host.replaceChildren(el('div', { class: 'container tabbar-inner' }, scroller, gear));

  // Fade the edge(s) where more tabs are hidden.
  function updateFades() {
    const max = scroller.scrollWidth - scroller.clientWidth;
    scroller.classList.toggle('fade-left', scroller.scrollLeft > 2);
    scroller.classList.toggle('fade-right', max > 2 && scroller.scrollLeft < max - 2);
  }
  scroller.addEventListener('scroll', updateFades, { passive: true });
  window.addEventListener('resize', updateFades);
  if (typeof ResizeObserver === 'function') new ResizeObserver(updateFades).observe(scroller);

  // A plain mouse wheel scrolls the bar sideways (only when it actually overflows).
  scroller.addEventListener('wheel', (e) => {
    if (e.ctrlKey || Math.abs(e.deltaX) > Math.abs(e.deltaY)) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    if (max <= 0) return;
    const next = Math.max(0, Math.min(max, scroller.scrollLeft + e.deltaY));
    if (next === scroller.scrollLeft) return;
    scroller.scrollLeft = next;
    e.preventDefault();
  }, { passive: false });

  // Keep a focused tab fully visible (keyboard users).
  scroller.addEventListener('focusin', (e) => {
    const a = e.target.closest && e.target.closest('.tab');
    if (a) showTab(a);
  });

  function showTab(a) {
    const left = a.offsetLeft - list.offsetLeft;
    const right = left + a.offsetWidth;
    const pad = 32; // room for the fade
    if (left - pad < scroller.scrollLeft) scroller.scrollLeft = Math.max(0, left - pad);
    else if (right + pad > scroller.scrollLeft + scroller.clientWidth) {
      scroller.scrollLeft = right + pad - scroller.clientWidth;
    }
  }

  updateFades();

  return {
    setActive(route) {
      if (Object.prototype.hasOwnProperty.call(TAB_FOR_ROUTE, route)) route = TAB_FOR_ROUTE[route];
      for (const [r, a] of links) {
        if (r === route) {
          a.setAttribute('aria-current', 'page');
          if (scroller.contains(a)) showTab(a);
        } else {
          a.removeAttribute('aria-current');
        }
      }
      updateFades();
    },
  };
}
