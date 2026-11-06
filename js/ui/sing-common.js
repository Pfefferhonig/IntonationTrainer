// Shared pieces for the producing exercises ("Lock it in", "Echo", "Join the chord"):
// - the singing modules (pitch / sing, loaded with dynamic import so the rest of the app keeps
//   working without them), the microphone session (with a dev-only fake), the one-time
//   microphone setup, plain-language microphone errors, the live pitch trace;
// - a small "producing kit": thin wrappers around the shared component contracts in
//   docs/BUILD-PLAN.md (createOptionsSummary, createActionBar, createFeedback, nextButton,
//   createCompareSwitch, keyLegend, createTipCard, createSessionSummary, onEscape, pause.js).
//   Each wrapper uses the shared component when it exists (feature-checked) and a small local
//   fallback otherwise, so the screens keep working while the shared parts are being built.

import * as engine from '../audio/engine.js';
import * as components from './components.js';
import * as exercise from './exercise.js';
import * as dom from './dom.js';
import * as pauseModule from './pause.js';
import { getPref, setPref, getSettings, updateSettings } from '../storage.js';
import { el, setChildren, centsText, uniqueId } from './dom.js';
import { icon } from './icons.js';

const SETUP_PREF = 'mic.setupDone';

// ===========================================================================
// Small helpers
// ===========================================================================

export function reducedMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Smallest scroll that keeps all elements visible (shared reveal(); older reveal(top, mustSee) also works). */
export function revealAll(...els) {
  const list = els.filter((e) => e && e.isConnected && !e.hidden);
  if (!list.length) return;
  try { dom.reveal(...list); } catch (err) { console.error(err); }
}

/**
 * The elements to keep in view after a result: `optional` (e.g. the score) is dropped when it would not
 * fit together with `required` (feedback + compare switch) above the phone's sticky bars.
 */
export function fitVisible(optional, ...required) {
  const list = required.filter((e) => e && e.isConnected && e.getClientRects().length);
  if (!optional || !optional.isConnected) return list;
  const all = [optional, ...list];
  const top = Math.min(...all.map((e) => e.getBoundingClientRect().top));
  const bottom = Math.max(...all.map((e) => e.getBoundingClientRect().bottom));
  let insets = 0;
  for (const n of document.querySelectorAll('[data-inset-bottom], [data-inset-top]')) {
    const cs = n.getClientRects().length ? getComputedStyle(n) : null;
    if (cs && (cs.position === 'sticky' || cs.position === 'fixed')) insets += n.getBoundingClientRect().height;
  }
  return bottom - top <= window.innerHeight - insets - 24 ? all : list;
}

/** Text with a shorter phone version: [long (wide screens), short (phones)]; only one is displayed. */
export function longShort(long, short) {
  return [el('span', { class: 'pc-long' }, long), el('span', { class: 'pc-short' }, short)];
}

/**
 * Exercise heading [div(h1, task), rank chip] — the shared phone styles put the chip on the h1 line;
 * the task is a shorter one-liner on phones. -> element
 */
export function exerciseHead({ title, task, taskShort, chip }) {
  return el('div', { class: 'screen-head pc-head' },
    el('div', {}, el('h1', {}, title), el('p', { class: 'task' }, taskShort ? longShort(task, taskShort) : task)),
    chip || null);
}

/** "Try again (same notes)" — "Again" on phones (full name kept for screen readers and voice control). */
export function tryAgainButton(onClick) {
  return el('button', { type: 'button', class: 'btn pc-try-again', 'aria-label': 'Try again (same notes)', onclick: onClick },
    icon('rotate-ccw', { size: 18 }),
    el('span', { class: 'pc-long', 'aria-hidden': 'true' }, 'Try again (same notes)'),
    el('span', { class: 'pc-short', 'aria-hidden': 'true' }, 'Again'));
}

/** Focus without scrolling, then reveal the given elements. */
export function focusAndReveal(target, ...alsoVisible) {
  if (!target || !target.isConnected || target.hidden || target.disabled) return;
  try { target.focus({ preventScroll: true }); } catch { target.focus(); }
  revealAll(...alsoVisible, target);
}

/** 'in-tune' | 'close' | 'keep-going' — from the logic's `level`, else from the older `rating`. */
export function levelOf(result) {
  if (!result) return 'keep-going';
  if (result.level === 'in-tune' || result.level === 'close' || result.level === 'keep-going') return result.level;
  if (result.rating === 'excellent' || result.rating === 'good') return 'in-tune';
  if (result.rating === 'close') return 'close';
  return 'keep-going';
}

/** Stop every sound (engine.stopEverything when available, else stopAll). */
export function stopAllSound() {
  try {
    if (typeof engine.stopEverything === 'function') engine.stopEverything();
    else engine.stopAll();
  } catch (err) { console.error(err); }
}

/** engine.onAudioInterrupted(cb) when available; returns an unsubscribe function. */
export function onAudioInterrupted(cb) {
  if (typeof engine.onAudioInterrupted !== 'function') return () => {};
  try {
    const off = engine.onAudioInterrupted(cb);
    return typeof off === 'function' ? off : () => {};
  } catch (err) {
    console.error(err);
    return () => {};
  }
}

/** Single-key shortcuts (letters, digits, =) switched off in Settings? */
function singleKeysOff() {
  try { return getSettings().keyShortcuts === false; } catch { return false; }
}

/** Hands-free singing ("Tap to start / tap to stop"): a setting when present, else a UI preference. */
export function getHandsFree() {
  try {
    const s = getSettings();
    if (typeof s.handsFree === 'boolean') return s.handsFree;
  } catch { /* ignore */ }
  return getPref('sing.handsFree', false) === true;
}
export function setHandsFree(on) {
  try {
    const s = getSettings();
    if (typeof s.handsFree === 'boolean') { updateSettings({ handsFree: !!on }); return; }
  } catch { /* ignore */ }
  setPref('sing.handsFree', !!on);
}

/** A labelled switch (checkbox role=switch), styled by the shared .switch rules. */
export function switchControl({ label, checked, onChange, description }) {
  const id = uniqueId('pc-switch');
  const descId = description ? `${id}-d` : null;
  const input = el('input', { type: 'checkbox', role: 'switch', id, 'aria-describedby': descId });
  input.checked = !!checked;
  input.addEventListener('change', () => onChange(input.checked));
  const sw = el('label', { class: 'switch', for: id }, input, el('span', { class: 'switch-track', 'aria-hidden': 'true' }), el('span', {}, label));
  const element = description
    ? el('div', { class: 'pc-switch-field' }, sw, el('p', { class: 'small muted pc-switch-desc', id: descId }, description))
    : sw;
  return { element, input, set(v) { input.checked = !!v; } };
}

/** "Pure tuning ›" — a plain link to Settings (not a toggle-looking chip). */
export function tuningLink(tuning) {
  const word = tuning === 'equal' ? 'Piano tuning' : 'Pure tuning';
  return el('a', { class: 'pc-link', href: '#/settings', title: 'Change in Settings' }, word, el('span', { 'aria-hidden': 'true' }, ' ›'));
}
export const tuningWord = (tuning) => (tuning === 'equal' ? 'piano' : 'pure');

// ===========================================================================
// Keyboard: shortcuts with repeat filtering + an Esc stack
// ===========================================================================

const OWN_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab', 'PageUp', 'PageDown', 'Home', 'End']);

/**
 * Screen shortcuts. handler(event) returns true when it used the key.
 * Key repeats are ignored except for keys in allowRepeat. Single letters/digits/= are off when
 * Settings → "Single-key shortcuts" is off. Ignored while typing, with Ctrl/Alt/Cmd, and for
 * Enter/Space on a focused button or link (those activate the control themselves).
 */
export function installScreenKeys(handler, { allowRepeat = [] } = {}) {
  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (e.key === 'Escape') return; // handled by the Esc stack
    if (e.repeat && !allowRepeat.includes(e.key)) {
      if (e.key === 'Enter' || e.key === ' ') e.preventDefault(); // a held Enter never "clicks" through
      return;
    }
    if (/^[a-z0-9=]$/i.test(e.key) && singleKeysOff()) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t) {
      const tag = t.tagName;
      const isChoice = tag === 'INPUT' && (t.type === 'radio' || t.type === 'checkbox');
      if (isChoice && OWN_KEYS.has(e.key)) return;
      if (!isChoice && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable)) return;
      if ((e.key === 'Enter' || e.key === ' ') && t.closest('button, a, summary, [role="button"]')) return;
      if (t.closest('[role="slider"]') && OWN_KEYS.has(e.key)) return;
    }
    let used = false;
    try { used = handler(e) === true; } catch (err) { console.error(err); }
    if (used) e.preventDefault();
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

const escStack = [];
let escListening = false;
function onEscKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented) return;
  for (let i = escStack.length - 1; i >= 0; i -= 1) {
    let used = false;
    try { used = escStack[i]() !== false; } catch (err) { console.error(err); }
    if (used) { e.preventDefault(); return; }
  }
}
/** Esc handler (shared onEscape stack when available). fn may return false to pass Esc on. */
export function onEscape(fn) {
  if (typeof components.onEscape === 'function') {
    try { return components.onEscape(fn); } catch (err) { console.error(err); }
  }
  escStack.push(fn);
  if (!escListening) { document.addEventListener('keydown', onEscKey); escListening = true; }
  return () => {
    const i = escStack.indexOf(fn);
    if (i >= 0) escStack.splice(i, 1);
  };
}

// ===========================================================================
// Shared component wrappers (contract first, local fallback second)
// ===========================================================================

/**
 * Options folded into one summary line + "Change".
 * -> { element, update(), open(), close(), setPending(bool), isOpen }
 * Extra (passed through to the shared component too): onOpen(), onClose().
 */
export function optionsSummary({ title, buildPanel, getSummary, onOpen, onClose, returnFocus }) {
  if (typeof components.createOptionsSummary === 'function') {
    try {
      const o = components.createOptionsSummary({ title, buildPanel, getSummary, onOpen, onClose, returnFocus });
      if (o && o.element) return o;
    } catch (err) { console.error(err); }
  }
  const panelId = uniqueId('pc-opts');
  const text = el('span', { class: 'pc-opts-text' });
  const pending = el('span', { class: 'pc-opts-pending' }, ' (from the next round)');
  pending.hidden = true;
  const changeBtn = el('button', { type: 'button', class: 'btn btn-small pc-opts-change', 'aria-expanded': 'false', 'aria-controls': panelId }, 'Change');
  const panel = el('div', { class: 'pc-opts-panel', id: panelId, role: 'group', 'aria-label': title });
  panel.hidden = true;
  buildPanel(panel);
  const doneBtn = el('button', { type: 'button', class: 'btn btn-small pc-opts-done' }, 'Done');
  panel.append(el('div', { class: 'pc-opts-foot' }, doneBtn));
  const element = el('div', { class: 'pc-opts' },
    el('div', { class: 'pc-opts-line' },
      el('span', { class: 'pc-opts-title' }, `${title}: `), text, pending, changeBtn),
    panel);
  let offEsc = null;
  const api = {
    element,
    get isOpen() { return !panel.hidden; },
    update() { text.textContent = getSummary(); },
    setPending(on) { pending.hidden = !on; },
    open() {
      if (!panel.hidden) return;
      panel.hidden = false;
      changeBtn.setAttribute('aria-expanded', 'true');
      changeBtn.textContent = 'Close';
      element.classList.add('is-open');
      if (typeof onOpen === 'function') onOpen();
      offEsc = onEscape(() => { api.close(); return true; });
      const first = panel.querySelector('input:checked, input, button, a');
      if (first) { try { first.focus({ preventScroll: true }); } catch { /* ignore */ } }
    },
    close() {
      if (panel.hidden) return;
      panel.hidden = true;
      changeBtn.setAttribute('aria-expanded', 'false');
      changeBtn.textContent = 'Change';
      element.classList.remove('is-open');
      if (offEsc) { offEsc(); offEsc = null; }
      if (typeof onClose === 'function') onClose();
      let target = null;
      try { target = typeof returnFocus === 'function' ? returnFocus() : null; } catch { target = null; }
      focusAndReveal(target && target.isConnected && !target.closest('[hidden]') ? target : changeBtn);
    },
  };
  changeBtn.addEventListener('click', () => (panel.hidden ? api.open() : api.close()));
  doneBtn.addEventListener('click', () => api.close());
  api.update();
  return api;
}

/** Primary action area: inline on desktop, sticky bottom bar on phones. -> { element, set(...nodes) } */
export function actionBar() {
  if (typeof exercise.createActionBar === 'function') {
    try {
      const b = exercise.createActionBar();
      if (b && b.element && typeof b.set === 'function') return b;
    } catch (err) { console.error(err); }
  }
  const element = el('div', { class: 'pc-action-bar' });
  return { element, set(...nodes) { setChildren(element, nodes); } };
}

const FEEDBACK_ICON = { 'in-tune': 'circle-check', close: 'circle-dot', 'keep-going': 'circle-arrow-right' };
/**
 * 3-level feedback panel: show({ level, message, detail?, icon? }) / clear().
 * Always rendered (status region keeps its place in the tree); has an id for aria-describedby.
 */
export function feedbackPanel() {
  if (typeof exercise.createFeedback === 'function') {
    try {
      const f = exercise.createFeedback();
      // The new contract renders the element at once and gives it an id; the older one is hidden.
      if (f && f.element && f.element.id && !f.element.hidden) return f;
    } catch (err) { console.error(err); }
  }
  const element = el('div', { class: 'feedback pc-feedback', role: 'status', id: uniqueId('pc-feedback') });
  return {
    element,
    show({ level, message, detail, icon: iconName }) {
      const lv = FEEDBACK_ICON[level] ? level : 'keep-going';
      element.className = `feedback pc-feedback is-${lv}`;
      setChildren(element,
        icon(iconName || FEEDBACK_ICON[lv], { size: 26, class: 'feedback-icon' }),
        el('div', { class: 'feedback-text' },
          el('p', { class: 'feedback-message is-main' }, message),
          detail ? el('p', { class: 'feedback-note' }, detail) : null));
    },
    clear() {
      element.className = 'feedback pc-feedback';
      element.replaceChildren();
    },
  };
}

/**
 * Next button with a 400 ms guard after feedback (no double-fire).
 * -> { element, focusAfterFeedback(feedbackId), guard(ms), click() }
 */
export function nextControl(onNext) {
  let inertUntil = 0;
  const go = () => {
    if (performance.now() < inertUntil) return;
    onNext();
  };
  if (typeof exercise.nextButton === 'function') {
    try {
      // The newer nextButton(onNext) takes a function; the older nextButton({ onClick }) an
      // object. A function with an onClick property works with both.
      const handler = () => go();
      handler.onClick = handler;
      const r = exercise.nextButton(handler);
      if (r instanceof Element) {
        return {
          element: r,
          focusAfterFeedback(id, ...visible) {
            if (id) r.setAttribute('aria-describedby', id);
            focusAndReveal(r, ...visible);
          },
          guard(ms = 400) { inertUntil = performance.now() + ms; },
          click() { r.click(); },
        };
      }
      if (r && r.element) {
        return {
          element: r.element,
          focusAfterFeedback(id, ...visible) {
            if (typeof r.focusAfterFeedback === 'function') r.focusAfterFeedback(id, ...visible);
            else focusAndReveal(r.element, ...visible);
          },
          guard(ms = 400) {
            inertUntil = performance.now() + ms;
            if (typeof r.guard === 'function') { try { r.guard(ms); } catch { /* ignore */ } }
          },
          click() { if (typeof r.trigger === 'function') r.trigger(); else r.element.click(); },
        };
      }
    } catch (err) { console.error(err); }
  }
  const element = el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: go },
    el('span', {}, 'Next'), icon('chevron-right', { size: 20 }));
  return {
    element,
    focusAfterFeedback(id, ...visible) { if (id) element.setAttribute('aria-describedby', id); focusAndReveal(element, ...visible); },
    guard(ms = 400) { inertUntil = performance.now() + ms; },
    click() { element.click(); },
  };
}

/**
 * Compare switch (segmented A/B/C). The screen plays / retunes the sound in onChange(value)
 * and stops it in onStop(). -> { element, value, stop(), destroy(), select(value), toggle() }
 * select / toggle are local helpers for the keys 1/2/3 and Space (they also work with the shared
 * component: they press its option buttons).
 */
export function compareSwitch({ options, label = 'Listen and compare', onChange, onStop }) {
  if (typeof components.createCompareSwitch === 'function') {
    try {
      const sw = components.createCompareSwitch({ options, label, onChange: (v, scope) => onChange(v, scope), onStop });
      if (sw && sw.element) {
        const buttonFor = (v) => {
          const i = options.findIndex((o) => o.value === v);
          return sw.element.querySelector(`[data-value="${CSS.escape(String(v))}"]`)
            || [...sw.element.querySelectorAll('button, [role="radio"]')].filter((b) => !/stop/i.test(b.textContent))[i] || null;
        };
        return {
          element: sw.element,
          ownKeys: true, // the shared switch handles its digit keys, Space and Esc itself
          get value() { return sw.value; },
          stop() { sw.stop(); },
          ended() { if (typeof sw.setPlaying === 'function') sw.setPlaying(false); else sw.stop(); },
          destroy() { if (typeof sw.destroy === 'function') sw.destroy(); },
          select(v) {
            if (typeof sw.select === 'function') { sw.select(v); return; }
            const b = buttonFor(v);
            if (b) b.click();
          },
          toggle() {
            if (typeof sw.toggle === 'function') { sw.toggle(); return; }
            if (sw.playing) { sw.stop(); if (onStop) onStop(); return; }
            const b = buttonFor(sw.value || options[0].value);
            if (b) b.click();
          },
        };
      }
    } catch (err) { console.error(err); }
  }
  let value = null; // the option sounding now (null = silent)
  let last = options[0] ? options[0].value : null;
  const btns = options.map((o) => el('button', {
    type: 'button',
    class: `btn pc-seg-btn${o.className ? ` ${o.className}` : ''}`,
    'aria-pressed': 'false',
    'data-value': String(o.value),
    onclick: () => (value === o.value ? stopBtnPress() : choose(o.value)),
  }, icon('play', { size: 16, class: 'pc-seg-play' }), el('span', {}, o.label), o.key ? components.kbd(o.key) : null));
  const stopBtn = el('button', {
    type: 'button', class: 'btn btn-small pc-compare-stop', onclick: () => stopBtnPress(), disabled: true,
  }, icon('square', { size: 14 }), 'Stop');
  const element = el('div', { class: 'pc-compare', role: 'group', 'aria-label': label },
    el('div', { class: 'pc-seg' }, btns), stopBtn);
  function paint() {
    btns.forEach((b, i) => {
      const on = options[i].value === value;
      b.setAttribute('aria-pressed', String(on));
      b.classList.toggle('is-on', on);
    });
    stopBtn.disabled = value === null;
  }
  function choose(v) {
    value = v;
    last = v;
    paint();
    onChange(v);
  }
  function stopBtnPress() {
    value = null;
    paint();
    if (onStop) onStop();
  }
  return {
    element,
    ownKeys: false,
    get value() { return value; },
    stop() { value = null; paint(); },
    ended() { value = null; paint(); },
    destroy() {},
    select(v) { if (options.some((o) => o.value === v)) choose(v); },
    toggle() { if (value !== null) stopBtnPress(); else choose(last); },
    setHidden(v, hidden) {
      const i = options.findIndex((o) => o.value === v);
      if (i >= 0) btns[i].hidden = hidden;
    },
  };
}

/** One-line key hints for the current state (hidden on touch screens). -> { element, set(text) } */
export function keyLegend() {
  if (typeof components.keyLegend === 'function') {
    try {
      const k = components.keyLegend();
      if (k && k.element && typeof k.set === 'function') return k;
    } catch (err) { console.error(err); }
  }
  const element = el('p', { class: 'pc-keys' });
  return { element, set(text) { element.textContent = text || ''; } };
}

/** Tip card with actions. -> { element, show(), hide() } */
export function tipCard({ text, actions }) {
  if (typeof components.createTipCard === 'function') {
    try {
      const t = components.createTipCard({ text, actions });
      if (t && t.element) return t;
    } catch (err) { console.error(err); }
  }
  const element = el('div', { class: 'pc-tip', role: 'status' },
    icon('lightbulb', { size: 20, class: 'pc-tip-icon' }),
    el('div', {}, el('p', {}, text),
      el('div', { class: 'btn-row' }, actions.map((a, i) => el('button', {
        type: 'button', class: `btn btn-small${i === 0 ? ' btn-primary' : ''}`, onclick: a.onClick,
      }, a.label)))));
  element.hidden = true;
  return { element, show() { element.hidden = false; }, hide() { element.hidden = true; } };
}

/** Session summary every 10th round (shared component, or none). -> { record(), maybeShow() → bool } */
export function sessionSummary(opts = {}) {
  const make = typeof components.createSessionSummary === 'function' ? components.createSessionSummary
    : typeof exercise.createSessionSummary === 'function' ? exercise.createSessionSummary : null;
  if (make) {
    try {
      const s = make(opts);
      if (s && typeof s.record === 'function') {
        return {
          record(r) { try { s.record(r); } catch (err) { console.error(err); } },
          maybeShow(container, handlers) {
            try { return s.maybeShow(container, handlers) === true; } catch (err) { console.error(err); return false; }
          },
        };
      }
    } catch (err) { console.error(err); }
  }
  return { record() {}, maybeShow() { return false; } };
}

/**
 * Page hidden / shown (pause.js onPageHidden when available, else visibilitychange + pagehide +
 * engine.onAudioInterrupted).
 * Returns an unregister function.
 */
export function onPageHidden({ onHide, onShow }) {
  let off = null;
  const local = () => {
    const vis = () => { if (document.hidden) onHide({ reason: 'hidden' }); else onShow({ reason: 'visible' }); };
    const hide = () => onHide({ reason: 'pagehide' });
    document.addEventListener('visibilitychange', vis);
    window.addEventListener('pagehide', hide);
    const offAudio = onAudioInterrupted((info) => {
      if (info && (info.state === 'interrupted' || info.state === 'suspended')) onHide({ reason: 'audio' });
    });
    return () => { document.removeEventListener('visibilitychange', vis); window.removeEventListener('pagehide', hide); offAudio(); };
  };
  const useModule = (m) => {
    if (m && typeof m.onPageHidden === 'function') {
      try {
        const o = m.onPageHidden({ onHide, onShow });
        if (typeof o === 'function') return o;
      } catch (err) { console.error(err); }
    }
    return null;
  };
  off = useModule(pauseModule) || local();
  return () => { if (off) off(); };
}

/** "Paused while you were away" + Continue. -> { element, show(), hide(), isShown } */
export function pausedCard({ onContinue }) {
  if (pauseModule && typeof pauseModule.createPausedCard === 'function') {
    try {
      const c = pauseModule.createPausedCard({ onContinue });
      if (c && c.element) {
        return {
          element: c.element,
          show: () => c.show(),
          hide: () => c.hide(),
          get isShown() { return !c.element.hidden; },
          focus() { focusAndReveal(c.element.querySelector('button'), c.element); },
        };
      }
    } catch (err) { console.error(err); }
  }
  const titleId = uniqueId('pc-paused');
  const btn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => onContinue() }, icon('play', { size: 18 }), 'Continue');
  const element = el('div', { class: 'pc-paused', role: 'group', 'aria-labelledby': titleId },
    icon('pause', { size: 22, class: 'pc-paused-icon' }),
    el('div', {},
      el('p', { class: 'pc-paused-title', id: titleId }, 'Paused while you were away'),
      el('p', { class: 'small muted' }, 'The sound and the microphone stopped. Continue when you are ready.'),
      btn));
  element.hidden = true;
  return {
    element,
    show() { element.hidden = false; },
    hide() { element.hidden = true; },
    get isShown() { return !element.hidden; },
    focus() { focusAndReveal(btn, element); },
  };
}

/**
 * Rank chip / result line text for a producing task (UX-WRITING wording).
 * -> { main: 'Section leader' | 'Rank after 2 more rounds' | 'Not tried yet', sub: '6 cents off on average · you tend to go a little high' }
 */
export function rankTexts({ rank, attempts, avg, meanSigned, minAttempts = 5, tendencyMin = 4, verb = 'go' }) {
  const n = attempts || 0;
  const left = Math.max(0, minAttempts - n);
  const rounds = (k) => `${k} ${k === 1 ? 'round' : 'rounds'}`;
  const main = rank ? rank.name : n === 0 ? 'Not tried yet' : left > 0 ? `Rank after ${left} more ${left === 1 ? 'round' : 'rounds'}` : 'No rank yet';
  const parts = [];
  if (n > 0 && Number.isFinite(avg)) parts.push(`${centsText(avg)} off on average`);
  else if (n > 0) parts.push(rounds(n));
  if (n >= 3 && Number.isFinite(meanSigned) && Math.abs(meanSigned) >= tendencyMin) {
    parts.push(`you tend to ${verb} a little ${meanSigned > 0 ? 'high' : 'low'}`);
  }
  return { main, sub: parts.join(' · '), left };
}

// ===========================================================================
// Singing modules and the microphone
// ===========================================================================

let modulesPromise = null;
/** -> { pitch, sing } (each null when that module is missing). Cached. */
export function loadSingModules() {
  if (!modulesPromise) {
    const tryImport = (path) => import(path).catch(() => null);
    modulesPromise = Promise.all([tryImport('../audio/pitch.js'), tryImport('../exercise/sing.js')])
      .then(([pitch, sing]) => ({ pitch, sing }));
  }
  return modulesPromise;
}

/** Dev-only: `?fakeMic=1` in the page address feeds synthetic voice frames (for testing). */
export function fakeMicEnabled() {
  try {
    return new URLSearchParams(window.location.search).get('fakeMic') === '1';
  } catch {
    return false;
  }
}

export function micSetupDone() { return getPref(SETUP_PREF, false) === true; }
export function markMicSetupDone() { setPref(SETUP_PREF, true); }

/** Switch analysis on/off on a mic handle (no-op for handles without setActive). */
export function setMicActive(mic, on) {
  if (mic && typeof mic.setActive === 'function') {
    try { mic.setActive(!!on); } catch (err) { console.error(err); }
  }
}

/** Running from this computer (start.bat / python server) rather than the published site? */
function isLocalHost() {
  try {
    const h = window.location.hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1' || window.location.protocol === 'file:';
  } catch {
    return false;
  }
}

/** The one privacy sentence (UX-WRITING). */
export const PRIVACY_TEXT = 'Your singing is analysed on this device. The recording is deleted when you leave the page; only your results are saved.';

/** Plain help for startMic's error codes: [first line, ...more lines]. */
export function micErrorLines(err) {
  const code = err && err.code;
  if (code === 'denied') {
    return ['The microphone is blocked. Allow it for this site, then try again.',
      'Computer: click the lock icon next to the web address.',
      'Phone: browser settings → Site settings → Microphone.'];
  }
  if (code === 'no-device') return ['No microphone found. Plug one in or switch it on, then try again.'];
  if (code === 'unsupported') {
    const lines = ["This browser can't use the microphone. Try an up-to-date Chrome, Edge, Firefox or Safari."];
    if (isLocalHost()) lines.push('On this computer, open the app with start.bat.');
    return lines;
  }
  if (code === 'ended' || code === 'device-lost') return ['The microphone stopped (was a headset unplugged?). Reconnect it, then try again.'];
  return ["The microphone didn't start. Try again."];
}
/** Plain help as one string. */
export function micErrorHelp(err) { return micErrorLines(err).join(' '); }
/** Plain help as an element (first line bold-ish, the rest as small lines). */
export function micErrorNode(err) {
  const [first, ...rest] = micErrorLines(err);
  return el('div', { class: 'pc-mic-error-text' }, el('p', {}, first), rest.map((r) => el('p', { class: 'small' }, r)));
}

// ---------------------------------------------------------------------------
// Fake microphone (dev only): a scoop into the note, then steady at target + 8 cents.
// ---------------------------------------------------------------------------

const fakeState = { targetFreq: 220, offsetCents: 8, voiced: true };
/** Tell the fake mic which note to "sing" (no effect with a real microphone). */
export function setFakeTarget(freq, { offsetCents = 8 } = {}) {
  fakeState.targetFreq = freq;
  fakeState.offsetCents = offsetCents;
}

function startFakeMic({ onFrame, frameMs = 20, onEnded }) {
  const t0 = performance.now();
  let voiceStart = null; // the fake singer starts 0.3 s after the mic opens / is switched on
  let rec = null;
  let level = 0;
  let id = 0;
  const tick = () => {
    const time = (performance.now() - t0) / 1000;
    if (voiceStart === null) voiceStart = time + 0.3;
    const into = time - voiceStart;
    // Dev aid: window.__fakeMic.silent = true makes the fake singer stop (hands-free auto-stop test).
    if (into < 0 || (window.__fakeMic && window.__fakeMic.silent)) {
      level = 0.002;
      onFrame({ time, freq: null, clarity: 0.1, rms: level });
      return;
    }
    const scoop = into < 0.35 ? -120 * (1 - into / 0.35) : 0;
    const noise = (Math.random() - 0.5) * 6;
    const cents = fakeState.offsetCents + scoop + noise;
    const freq = fakeState.targetFreq * 2 ** (cents / 1200);
    level = 0.18 + Math.random() * 0.04;
    if (rec) rec.push(freq);
    onFrame({ time, freq, clarity: 0.95, rms: level });
  };
  id = setInterval(tick, frameMs);
  const handle = {
    stop() { clearInterval(id); },
    setActive(on) { if (on) voiceStart = (performance.now() - t0) / 1000 + 0.3; },
    level() { return level; },
    startRecording() { rec = []; },
    stopRecording() {
      // A synthetic "recording": a soft sine following the fake pitch, so playback works.
      const ctx = typeof engine.getAudioContext === 'function' ? engine.getAudioContext() : null;
      const freqs = rec || [];
      rec = null;
      if (!ctx || !freqs.length) return null;
      const sr = ctx.sampleRate;
      const per = Math.round((sr * frameMs) / 1000);
      const buf = ctx.createBuffer(1, per * freqs.length, sr);
      const data = buf.getChannelData(0);
      let phase = 0;
      for (let i = 0; i < data.length; i += 1) {
        const f = freqs[Math.min(freqs.length - 1, Math.floor(i / per))];
        phase += (2 * Math.PI * f) / sr;
        const env = Math.min(1, i / (sr * 0.05), (data.length - i) / (sr * 0.05));
        data[i] = 0.25 * env * (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
      }
      return buf;
    },
    fake: true,
  };
  // Dev aid: window.__fakeMic.end() simulates an unplugged headset.
  window.__fakeMic = Object.assign(window.__fakeMic || {}, {
    end() {
      clearInterval(id);
      handle.ended = true;
      if (typeof onEnded === 'function') onEnded({ reason: 'device-lost', message: 'The microphone stopped (was a headset unplugged?).' });
    },
  });
  return Promise.resolve(handle);
}

/**
 * Open the microphone (call from a click). Uses the real pitch.startMic, or the fake one
 * with ?fakeMic=1. Resolves to { stop, level, startRecording, stopRecording, fake? }.
 * Rejects with { code, message }. onEnded({ reason, message }) fires once if the microphone
 * stops by itself (headset unplugged, device lost).
 */
export async function openMic({ onFrame, frameMs = 20, active = false, onEnded } = {}) {
  let fired = false;
  const ended = (info) => {
    if (fired) return;
    fired = true;
    if (typeof onEnded === 'function') { try { onEnded(info || {}); } catch (err) { console.error(err); } }
  };
  if (fakeMicEnabled()) return startFakeMic({ onFrame, frameMs, onEnded: ended });
  const { pitch } = await loadSingModules();
  if (!pitch || typeof pitch.startMic !== 'function') {
    const e = new Error('The microphone part of the app is still being finished.');
    e.code = 'not-ready';
    throw e;
  }
  // Hold-to-sing: opened inactive; setMicActive(handle, true/false) on press / release.
  return pitch.startMic({ onFrame, frameMs, active, onEnded: ended });
}

// ---------------------------------------------------------------------------
// One-time microphone setup: allow, headphones, "say aah" check
// ---------------------------------------------------------------------------

/**
 * Builds the setup panel. onDone() is called when the user continues; onBack() (optional)
 * adds a "Back" button. Returns { element, destroy(), focusTitle() } — destroy() releases the
 * microphone; focusTitle() moves keyboard focus to the panel heading (call after rendering).
 */
export function micSetupPanel({ onDone, onBack, title = 'Before you sing' } = {}) {
  let mic = null;
  let timer = 0;
  let voicedMs = 0;
  let heard = false;
  const bars = Array.from({ length: 10 }, () => el('span'));
  const meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, bars);
  const meterNote = el('p', { class: 'small muted', role: 'status' }, 'Hold the button and sing for a second.');
  let holding = false;
  let lastPointerUp = 0;
  const holdBtn = el('button', { type: 'button', class: 'btn btn-small btn-hold', disabled: true, 'aria-pressed': 'false' },
    icon('mic', { size: 16 }), el('span', {}, 'Hold to say "aah"'));
  const holdLabel = holdBtn.lastChild;
  const setHolding = (on) => {
    holding = on;
    setMicActive(mic, on);
    holdBtn.classList.toggle('is-held', on);
    holdBtn.setAttribute('aria-pressed', String(on));
    if (!on) paint(0);
  };
  holdBtn.addEventListener('pointerdown', (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    e.preventDefault();
    try { holdBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    setHolding(true);
  });
  const letGo = () => { if (holding) setHolding(false); };
  holdBtn.addEventListener('pointerup', () => { lastPointerUp = performance.now(); letGo(); });
  holdBtn.addEventListener('pointercancel', letGo);
  holdBtn.addEventListener('lostpointercapture', letGo);
  holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  // Voice control / switch access / screen readers send only a click: tap to start, tap to stop.
  holdBtn.addEventListener('click', (e) => {
    if (e.detail !== 0 && performance.now() - lastPointerUp < 300) return; // the click after a hold
    setHolding(!holding);
    holdLabel.textContent = holding ? 'Stop' : 'Hold to say "aah"';
  });
  holdBtn.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); setHolding(true); } });
  holdBtn.addEventListener('keyup', (e) => { if (e.key === ' ') { e.preventDefault(); letGo(); } });
  holdBtn.addEventListener('blur', () => { letGo(); holdLabel.textContent = 'Hold to say "aah"'; });
  const errorBox = el('div', { class: 'mic-error', role: 'alert' });
  errorBox.hidden = true;

  const step1Num = el('span', { class: 'num' }, '1');
  const allowBtn = el('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => allow() },
    icon('mic', { size: 18 }), 'Allow the microphone');
  const continueBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => finish() },
    'Continue', icon('chevron-right', { size: 20 }));
  continueBtn.disabled = true;
  const backBtn = typeof onBack === 'function'
    ? el('button', { type: 'button', class: 'btn', onclick: () => { release(); onBack(); } }, 'Back')
    : null;
  const step3 = el('div', { class: 'setup-step' },
    el('span', { class: 'num' }, '3'),
    el('div', {},
      el('strong', {}, 'Quick check: hold to say "aah"'),
      el('p', { class: 'muted small' }, 'Hold the button and sing a comfortable "aah". The bars should reach the green part. This check is not kept.'),
      holdBtn,
      meter,
      meterNote,
    ),
  );
  step3.classList.add('is-waiting');

  function paint(rms) {
    const lvl = Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.4);
    const on = Math.round(lvl * bars.length);
    bars.forEach((b, i) => {
      b.style.height = `${30 + i * 7}%`;
      b.className = i < on ? (i >= 8 ? 'hot' : 'on') : '';
    });
  }
  paint(0);

  async function allow() {
    errorBox.hidden = true;
    allowBtn.disabled = true;
    try { await engine.initAudio(); } catch { /* playback is not needed for the check */ }
    try {
      mic = await openMic({
        onFrame: (f) => {
          if (!holding) return; // only while the button is held
          if (f.freq && f.clarity >= 0.8 && f.rms >= 0.02) voicedMs += 20; else voicedMs = Math.max(0, voicedMs - 10);
          if (!heard && voicedMs >= 500) {
            heard = true;
            meterNote.textContent = 'Microphone ready. We can hear you clearly.';
            meterNote.className = 'small mic-ok';
          }
        },
        onEnded: () => {
          mic = null;
          setHolding(false);
          holdBtn.disabled = true;
          allowBtn.disabled = false;
          setChildren(errorBox, micErrorNode({ code: 'ended' }));
          errorBox.hidden = false;
        },
      });
    } catch (err) {
      allowBtn.disabled = false;
      setChildren(errorBox, micErrorNode(err));
      errorBox.hidden = false;
      return;
    }
    step1Num.replaceChildren(icon('check', { size: 16 }));
    step1Num.parentElement.classList.add('is-done');
    setChildren(allowBtn, icon('mic', { size: 18 }), 'Microphone allowed');
    step3.classList.remove('is-waiting');
    continueBtn.disabled = false;
    holdBtn.disabled = false;
    timer = setInterval(() => { if (holding && mic) { try { paint(mic.level()); } catch { /* ignore */ } } }, 60);
  }

  function release() {
    clearInterval(timer);
    timer = 0;
    if (mic) { try { mic.stop(); } catch { /* ignore */ } mic = null; }
  }

  function finish() {
    release();
    markMicSetupDone();
    if (typeof onDone === 'function') onDone();
  }

  const heading = el('h2', { class: 'mic-setup-title', tabindex: '-1' }, title);
  const element = el('div', { class: 'mic-setup' },
    heading,
    el('div', { class: 'card setup-steps' },
      el('div', { class: 'setup-step' },
        step1Num,
        el('div', {},
          el('strong', {}, 'Allow the microphone'),
          el('p', { class: 'muted small' }, `Your browser asks once. ${PRIVACY_TEXT}`),
          allowBtn,
          errorBox,
        ),
      ),
      el('div', { class: 'setup-step' },
        el('span', { class: 'num' }, '2'),
        el('div', {},
          el('strong', {}, 'Put on headphones'),
          el('p', { class: 'muted small' }, "Strongly recommended. Through speakers, the microphone also hears the app's notes and can't tell which one is you."),
        ),
      ),
      step3,
    ),
    el('div', { class: 'btn-row pc-setup-nav' }, backBtn, continueBtn),
  );

  return {
    element,
    destroy: release,
    focusTitle() { try { heading.focus({ preventScroll: false }); } catch { /* ignore */ } },
  };
}

// ---------------------------------------------------------------------------
// Live pitch trace: your pitch in cents around the target, left to right
// ---------------------------------------------------------------------------

/**
 * createTrace({ seconds, rangeCents }) -> { element, reset(), add(time, cents), setGuide(bands|null),
 *   showResult({ points, steadyStart, steadyEnd, bands }) }
 * cents: relative to the target (0 = in tune in the chosen tuning); zoomed to ±rangeCents (points
 * further out sit on the edge). bands: [{ cents, label, kind: 'pure'|'piano'|'guide'|'target', zone? }]
 * — a band with zone draws the real in-tune zone (±zone cents) around it. Labels are HTML (no
 * stretched text) and pushed apart so they never overlap. No target line unless a band is set.
 */
export const IN_TUNE_ZONE = 7;   // ≤ 7 cents = in tune (Spot on / Good)
export const CLOSE_ZONE = 15;    // ≤ 15 cents = close
export function createTrace({ seconds: baseSeconds = 4, rangeCents = 50 } = {}) {
  let seconds = baseSeconds; // widens by itself for longer recordings
  const NS = 'http://www.w3.org/2000/svg';
  const W = 400;
  const H = 100;
  const s = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'trace-svg', 'aria-hidden': 'true' });
  const bandLayer = s('g');
  const steadyRect = s('rect', { class: 'trace-steady', y: 0, height: H, x: 0, width: 0, visibility: 'hidden' });
  const scoopLine = s('polyline', { class: 'trace-line is-faded', points: '' });
  const line = s('polyline', { class: 'trace-line', points: '' });
  svg.append(steadyRect, bandLayer, scoopLine, line);
  const labels = el('div', { class: 'pc-trace-labels', 'aria-hidden': 'true' });
  const axis = el('div', { class: 'pc-trace-axis', 'aria-hidden': 'true' },
    el('span', {}, 'higher'), el('span', {}, 'lower'));
  const summary = el('span', { class: 'visually-hidden' });
  let pts = [];

  const x = (t) => Math.max(0, Math.min(W, (t / seconds) * W));
  const y = (c) => H / 2 - (Math.max(-rangeCents, Math.min(rangeCents, c)) / rangeCents) * (H / 2 - 4);
  const fmt = (list) => list.map((p) => `${x(p.time).toFixed(1)},${y(p.cents).toFixed(1)}`).join(' ');

  function drawBands(bands, withLabels) {
    bandLayer.replaceChildren();
    labels.replaceChildren();
    const list = (bands || []).filter((b) => Number.isFinite(b.cents));
    for (const b of list) {
      const kind = b.kind || 'target';
      if (b.zone) {
        bandLayer.append(
          s('rect', { class: 'trace-zone is-close', x: 0, width: W, y: y(b.cents + CLOSE_ZONE), height: Math.max(1, y(b.cents - CLOSE_ZONE) - y(b.cents + CLOSE_ZONE)) }),
          s('rect', { class: `trace-band is-${kind}`, x: 0, width: W, y: y(b.cents + b.zone), height: Math.max(2, y(b.cents - b.zone) - y(b.cents + b.zone)) }),
        );
      }
      bandLayer.append(s('line', { class: `trace-band-line is-${kind}`, x1: 0, x2: W, y1: y(b.cents), y2: y(b.cents) }));
    }
    if (!withLabels) return;
    // Labels at the right edge, at least 14 % of the height apart (no overlap).
    const placed = list.filter((b) => b.label).map((b) => ({ b, pos: (y(b.cents) / H) * 100 }))
      .sort((p, q) => p.pos - q.pos);
    const GAP = 15;
    for (let i = 1; i < placed.length; i += 1) {
      if (placed[i].pos - placed[i - 1].pos < GAP) placed[i].pos = placed[i - 1].pos + GAP;
    }
    const overflow = placed.length ? placed[placed.length - 1].pos - 92 : 0;
    if (overflow > 0) for (const p of placed) p.pos -= overflow;
    for (const p of placed) {
      labels.append(el('span', { class: `pc-trace-label is-${p.b.kind || 'target'}`, style: `top:${Math.max(6, p.pos).toFixed(1)}%` }, p.b.label));
    }
  }

  return {
    element: el('div', { class: 'trace-wrap pc-trace' }, axis, svg, labels, summary),
    reset() {
      seconds = baseSeconds;
      pts = [];
      line.setAttribute('points', '');
      scoopLine.setAttribute('points', '');
      steadyRect.setAttribute('visibility', 'hidden');
      summary.textContent = '';
      drawBands([], false);
    },
    add(time, cents) {
      if (!Number.isFinite(cents)) return;
      pts.push({ time, cents });
      if (time > seconds * 0.95) seconds = time * 1.3;
      line.setAttribute('points', fmt(pts));
    },
    setGuide(bands) { drawBands(bands, false); },
    showResult({ points, steadyStart, steadyEnd, bands, text }) {
      const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p.cents)) : pts;
      const last = list.length ? list[list.length - 1].time : 0;
      seconds = Math.max(baseSeconds, last * 1.05);
      const hasSteady = Number.isFinite(steadyStart) && Number.isFinite(steadyEnd) && steadyEnd > steadyStart;
      if (hasSteady) {
        steadyRect.setAttribute('x', x(steadyStart));
        steadyRect.setAttribute('width', Math.max(2, x(steadyEnd) - x(steadyStart)));
        steadyRect.setAttribute('visibility', 'visible');
        scoopLine.setAttribute('points', fmt(list.filter((p) => p.time <= steadyStart)));
        line.setAttribute('points', fmt(list.filter((p) => p.time >= steadyStart)));
      } else {
        steadyRect.setAttribute('visibility', 'hidden');
        scoopLine.setAttribute('points', '');
        line.setAttribute('points', fmt(list));
      }
      summary.textContent = text || '';
      drawBands(bands, true);
    },
  };
}

/** Fold a frequency to the octave nearest `ref` and return cents from ref (any octave counts). */
export function foldedCents(freq, ref) {
  if (!(freq > 0) || !(ref > 0)) return NaN;
  let c = 1200 * Math.log2(freq / ref);
  c -= 1200 * Math.round(c / 1200);
  return c;
}
