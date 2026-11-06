// App navigation, grouped: Listen (Higher / lower · Odd one out · Lock it in), Sing (Echo · Join the chord),
// Your stats, Settings.
//   Wide screens (>= 600 px): one tab bar under the app name, with the groups labelled.
//   Phones (< 600 px): a bottom tab bar with the four groups, plus a row with the current group's
//   exercises at the top of the page.

import { el } from './dom.js';
import { icon } from './icons.js';
import { getPref, setPref } from '../storage.js';

// One-liners (UX-WRITING): shown as tooltips here and as the exercise map at the end of the setup.
export const TABS = [
  { route: 'higher-or-lower', group: 'listen', label: 'Higher / lower', title: 'Higher / lower', blurb: 'Hear which note is higher.', icon: 'arrow-up-down' },
  { route: 'odd-one-out', group: 'listen', label: 'Odd one out', title: 'Odd one out', blurb: 'Find the out-of-tune note in a chord.', icon: 'music' },
  { route: 'tune', group: 'listen', label: 'Lock it in', title: 'Lock it in', blurb: 'Slide a note until the chord is calm.', icon: 'sliders-horizontal' },
  { route: 'sing-back', group: 'sing', label: 'Echo', title: 'Echo', blurb: 'Sing back a note you hear.', icon: 'repeat-2' },
  { route: 'sing', group: 'sing', label: 'Join the chord', title: 'Join the chord', blurb: 'Sing the missing note of a chord.', icon: 'mic-vocal' },
  { route: 'stats', group: 'stats', label: 'Your stats', title: 'Your stats', blurb: 'Your ranks and practice days.', icon: 'trending-up' },
];

export const GROUPS = [
  { key: 'listen', label: 'Listen', icon: 'ear', routes: ['higher-or-lower', 'odd-one-out', 'tune'] },
  { key: 'sing', label: 'Sing', icon: 'mic', routes: ['sing-back', 'sing'] },
  { key: 'stats', label: 'Your stats', icon: 'trending-up', routes: ['stats'] },
  { key: 'settings', label: 'Settings', icon: 'settings', routes: ['settings'] },
];

// Routes that highlight a tab other than their own (sub-pages).
export const TAB_FOR_ROUTE = { 'settings/sound-check': 'settings' };

export const SETTINGS_TAB = { route: 'settings', label: 'Settings', icon: 'settings' };

const tabFor = (route) => TABS.find((t) => t.route === route) || null;
const groupOf = (route) => GROUPS.find((g) => g.routes.includes(route)) || null;

/** Last exercise used in a group (the bottom-bar Listen / Sing buttons open it). */
function lastInGroup(group) {
  const saved = getPref(`nav.last.${group.key}`, null);
  return typeof saved === 'string' && group.routes.includes(saved) ? saved : group.routes[0];
}

function tabLink(t, { withIcon = true } = {}) {
  return el('a', { class: 'tab', href: `#/${t.route}`, title: t.blurb || null, 'data-route': t.route },
    withIcon ? icon(t.icon, { size: 18 }) : null,
    el('span', { class: 'tab-label' }, t.label));
}

/**
 * Build the navigation. `host` is the header's <nav id="tabbar">; the phone bottom bar is added to
 * the end of <body>. Returns { setActive(route) }.
 */
export function renderTabBar(host) {
  const topLinks = [];
  const groupLists = [];

  // ---- Wide screens: one bar, grouped.
  const groupsList = el('ul', { class: 'tab-groups' });
  for (const g of GROUPS) {
    if (g.key === 'settings') continue;
    const tabs = TABS.filter((t) => t.group === g.key);
    const labelId = `tabgroup-${g.key}`;
    const list = el('ul', { class: 'tabs', 'aria-labelledby': g.key === 'stats' ? null : labelId });
    for (const t of tabs) {
      const a = tabLink(t);
      topLinks.push(a);
      list.append(el('li', {}, a));
    }
    groupsList.append(el('li', { class: `tab-group tab-group-${g.key}` },
      g.key === 'stats' ? null : el('span', { class: 'tab-group-label', id: labelId },
        icon(g.icon, { size: 15 }), el('span', { class: 'tab-group-text' }, g.label)),
      list));
  }
  const gear = el('a', { class: 'tab tab-settings', href: '#/settings', 'data-route': 'settings' },
    icon('settings', { size: 20 }), el('span', { class: 'tab-label' }, 'Settings'));
  topLinks.push(gear);
  const scroller = el('div', { class: 'tabs-scroll' }, groupsList);
  const wide = el('div', { class: 'container tabbar-inner tabbar-wide' }, scroller, gear);

  // ---- Phones: the current group's exercises, at the top of the page.
  const subnav = el('div', { class: 'container tabbar-sub' });
  for (const g of GROUPS) {
    const tabs = TABS.filter((t) => t.group === g.key);
    if (tabs.length < 2) continue;
    const list = el('ul', { class: 'subtabs', 'data-group': g.key, 'aria-label': `${g.label} exercises` });
    for (const t of tabs) {
      const a = el('a', { class: 'subtab', href: `#/${t.route}`, 'data-route': t.route, title: t.blurb || null }, t.label);
      topLinks.push(a);
      list.append(el('li', {}, a));
    }
    list.hidden = true;
    groupLists.push(list);
    subnav.append(list);
  }

  host.replaceChildren(wide, subnav);

  // ---- Phones: bottom tab bar with the four groups.
  const bottomLinks = new Map();
  const bottomList = el('ul', { class: 'bottom-tabs' });
  for (const g of GROUPS) {
    const a = el('a', { class: 'bottom-tab', href: `#/${g.key === 'settings' ? 'settings' : lastInGroup(g)}`, 'data-group': g.key },
      icon(g.icon, { size: 22 }), el('span', { class: 'bottom-tab-label' }, g.label));
    bottomLinks.set(g.key, a);
    bottomList.append(el('li', {}, a));
  }
  const bottom = el('nav', { class: 'bottom-nav', 'aria-label': 'Sections', 'data-inset-bottom': '' }, bottomList);
  document.body.append(bottom);

  // Fade the edge(s) of the wide bar where more tabs are hidden (narrow desktop windows).
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
    const left = a.getBoundingClientRect().left - scroller.getBoundingClientRect().left + scroller.scrollLeft;
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
      for (const a of topLinks) {
        if (a.dataset.route === route) {
          a.setAttribute('aria-current', 'page');
          if (scroller.contains(a)) showTab(a);
        } else {
          a.removeAttribute('aria-current');
        }
      }
      const group = groupOf(route);
      if (group && tabFor(route)) setPref(`nav.last.${group.key}`, route);
      for (const list of groupLists) list.hidden = !group || list.dataset.group !== group.key;
      const hasSub = groupLists.some((l) => !l.hidden);
      subnav.classList.toggle('is-empty', !hasSub);
      const header = host.closest('.app-header');
      if (header) header.classList.toggle('has-subnav', hasSub);
      for (const g of GROUPS) {
        const a = bottomLinks.get(g.key);
        if (g.key !== 'settings') a.setAttribute('href', `#/${lastInGroup(g)}`);
        if (group && group.key === g.key) a.setAttribute('aria-current', 'true');
        else a.removeAttribute('aria-current');
      }
      updateFades();
    },
  };
}
