// General UI building blocks: segmented choice, collapsible help, small tag link, keyboard
// shortcuts, Esc stack, options summary, key legend, tip card, compare switch, session summary.
// Shared contracts: docs/BUILD-PLAN.md "Shared component contracts" (names are binding).

import { el, setChildren, reveal, uniqueId } from './dom.js';
import { icon } from './icons.js';
import { getSettings } from '../storage.js';

let groupCount = 0;

const prefersReducedMotion = () => {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
};

/** Re-start a CSS entrance animation on `node` (class `cls`). */
function replayAnimation(node, cls = 'is-entering') {
  node.classList.remove(cls);
  void node.offsetWidth; // reflow so the animation starts again
  node.classList.add(cls);
}

/**
 * Row of pill-shaped radio buttons.
 * options: [{ value, label, title? }]
 * Returns { element, setValue(v) }.
 */
export function segmented({ name, legend, options, value, onChange, hideLegend = false, compact = false }) {
  groupCount += 1;
  const group = `seg-${name}-${groupCount}`;
  const inputs = [];
  const wrap = el('div', { class: 'segmented' });
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const input = el('input', { type: 'radio', name: group, id, value: String(o.value) });
    input.checked = o.value === value;
    input.addEventListener('change', () => {
      if (input.checked) onChange(o.value);
    });
    inputs.push([input, o.value]);
    wrap.append(input, el('label', { for: id, title: o.title || null }, o.label));
  });
  const element = el('fieldset', { class: `segmented-group${compact ? ' is-compact' : ''}` },
    el('legend', { class: hideLegend ? 'visually-hidden' : null }, legend),
    wrap,
  );
  return {
    element,
    setValue(v) {
      for (const [input, val] of inputs) input.checked = val === v;
    },
  };
}

/** Collapsible "How it works" box (closed by default). */
export function helpBox({ summary = 'How it works', open = false }, ...content) {
  return el('details', { class: 'help-box', open: open || null },
    el('summary', {},
      icon('circle-help', { size: 18 }),
      el('span', {}, summary),
      icon('chevron-down', { size: 18, class: 'help-chevron' }),
    ),
    el('div', { class: 'help-body' }, ...content),
  );
}

/** Small pill link, e.g. the current tuning linking to Settings. */
export function tagLink({ href, label, title }) {
  return el('a', { class: 'tag', href, title: title || null }, label, icon('chevron-right', { size: 14 }));
}

// ---------------------------------------------------------------------------
// Keyboard shortcuts
// ---------------------------------------------------------------------------

// Keys a focused radio / switch handles itself.
const OWN_KEYS = new Set([' ', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Tab']);
// "Single-key shortcuts" (WCAG 2.1.4): letters, digits and "=" — can be turned off in Settings.
const SINGLE_KEY = /^[a-z0-9=]$/i;

/** True when the "Single-key shortcuts" setting is on (default). */
export function singleKeysEnabled() {
  try { return getSettings().keyShortcuts !== false; } catch { return true; }
}

/** Should a document-level shortcut ignore this key event (typing, focused control, ...)? */
function ignoredTarget(e) {
  const t = e.target instanceof Element ? e.target : null;
  if (!t) return false;
  const tag = t.tagName;
  // Option radios and switches only need Space, arrows and Tab themselves; every other
  // shortcut (letters, digits, Enter) still works while one of them has focus.
  const isChoice = tag === 'INPUT' && (t.type === 'radio' || t.type === 'checkbox');
  if (isChoice && OWN_KEYS.has(e.key)) return true;
  if (!isChoice && (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || t.isContentEditable)) return true;
  // Enter/Space on a focused button or link: the browser already activates it.
  if ((e.key === 'Enter' || e.key === ' ') && t.closest('button, a, summary, [role="button"]')) return true;
  return false;
}

/**
 * Global keyboard shortcuts for a screen. Returns an uninstall function.
 *
 * New form (BUILD-PLAN contract): installShortcuts(map, { allowRepeat = [] })
 *   map: { [key]: (event) => any } — keys as in KeyboardEvent.key ('Enter', 'ArrowUp', 'r', '1', '=');
 *   'Space' is accepted as an alias of ' '. Letters match both cases. A handler that returns
 *   exactly `false` did not use the key; anything else counts as used (preventDefault).
 *   Held-down key repeats are ignored, except for keys listed in allowRepeat (e.g. ['ArrowLeft', 'ArrowRight']).
 * Old form (still supported): installShortcuts((event) => boolean) — true = used; repeats pass through
 *   unless a second argument is given.
 * Both forms: ignored while typing in a field, with Ctrl/Alt/Cmd held, for Enter/Space on a focused button
 * or link, and for events another handler already handled (defaultPrevented). Single letters/digits/"="
 * are ignored while Settings > "Single-key shortcuts" is off. Esc: use onEscape().
 */
export function installShortcuts(handler, options) {
  const isMap = !!handler && typeof handler === 'object';
  const filterRepeat = isMap || options != null;
  const allowRepeat = new Set(((options && options.allowRepeat) || []).map((k) => (k === 'Space' ? ' ' : k)));

  function lookup(key) {
    if (!isMap) return null;
    if (typeof handler[key] === 'function') return handler[key];
    if (key.length === 1) {
      const lower = key.toLowerCase();
      if (typeof handler[lower] === 'function') return handler[lower];
      const upper = key.toUpperCase();
      if (typeof handler[upper] === 'function') return handler[upper];
    }
    if (key === ' ' && typeof handler.Space === 'function') return handler.Space;
    return null;
  }

  function onKey(e) {
    if (e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey) return;
    if (ignoredTarget(e)) return;
    if (SINGLE_KEY.test(e.key) && !singleKeysEnabled()) return;
    const fn = isMap ? lookup(e.key) : handler;
    if (!fn) return;
    if (filterRepeat && e.repeat && !allowRepeat.has(e.key)) {
      if (isMap) e.preventDefault(); // a known key held down: swallow the repeat (no page scroll)
      return;
    }
    let used = false;
    try {
      const r = fn(e);
      used = isMap ? r !== false : r === true;
    } catch (err) { console.error(err); }
    if (used) e.preventDefault();
  }
  document.addEventListener('keydown', onKey);
  return () => document.removeEventListener('keydown', onKey);
}

// Global Esc stack: the most recently registered handler runs first. A handler that returns
// exactly `false` passes Esc on to the next one.
const escapeStack = [];
let escapeInstalled = false;

function onEscapeKey(e) {
  if (e.key !== 'Escape' || e.defaultPrevented || e.isComposing) return;
  for (let i = escapeStack.length - 1; i >= 0; i -= 1) {
    let r;
    try { r = escapeStack[i](e); } catch (err) { console.error(err); }
    if (r !== false) {
      e.preventDefault();
      return;
    }
  }
}

/** Register an Esc handler (stop sound, discard a take, close options). Returns unregister. */
export function onEscape(fn) {
  if (typeof fn !== 'function') return () => {};
  if (!escapeInstalled) {
    document.addEventListener('keydown', onEscapeKey);
    escapeInstalled = true;
  }
  const entry = (e) => fn(e);
  escapeStack.push(entry);
  return () => {
    const i = escapeStack.indexOf(entry);
    if (i >= 0) escapeStack.splice(i, 1);
  };
}

/**
 * After an option (radio, switch, chip) is changed with the mouse or a finger, give focus back
 * to the screen's main action, so the shown key hints (Space, arrows, letters) keep working.
 * Keyboard changes keep focus on the option (the user is navigating the options).
 * getTarget() returns the element to focus (or null). Returns an uninstall function.
 */
export function refocusAfterPointerChange(root, getTarget) {
  let byPointer = false;
  const onDown = (e) => {
    const t = e.target instanceof Element ? e.target : null;
    byPointer = !!(t && t.closest('label, input[type="radio"], input[type="checkbox"]'));
  };
  const onChange = (e) => {
    const t = e.target;
    if (!byPointer || !(t instanceof HTMLInputElement) || !(t.type === 'radio' || t.type === 'checkbox')) return;
    byPointer = false;
    setTimeout(() => {
      const target = getTarget();
      if (target && target.isConnected && !target.hidden && !target.disabled) target.focus({ preventScroll: true });
    }, 0);
  };
  root.addEventListener('pointerdown', onDown, true);
  root.addEventListener('change', onChange, true);
  return () => {
    root.removeEventListener('pointerdown', onDown, true);
    root.removeEventListener('change', onChange, true);
  };
}

/**
 * After clicking a listen-again / compare button inside `container`, move focus to `target`
 * (usually Next), so Enter goes on to the next question.
 */
export function refocusAfterClick(container, getTarget) {
  container.addEventListener('click', (e) => {
    const b = e.target instanceof Element ? e.target.closest('button') : null;
    const target = getTarget();
    if (!b || !target || b === target || !container.contains(b)) return;
    setTimeout(() => {
      if (target.isConnected && !target.hidden && !target.disabled) target.focus({ preventScroll: true });
    }, 0);
  });
}

// ---------------------------------------------------------------------------
// Options summary ("Major 3rd · ascending · pure — Change")
// ---------------------------------------------------------------------------

/**
 * Exercise options folded into one summary line with a "Change" button.
 *   createOptionsSummary({ title, buildPanel(panelEl), getSummary() -> string,
 *                          onOpen?, onClose?, returnFocus?() -> element, open? })
 * buildPanel runs once, at creation (the panel's controls exist even while folded).
 * Opening calls onOpen (screens stop sound there) and dispatches 'optionsopen' on element;
 * closing with Done calls onClose, dispatches 'optionsclose' and returns focus to returnFocus() (the
 * screen's primary action) or the Change button. Esc closes an open panel and focuses the Change button.
 * Returns { element, update(), open(), close(), setPending(bool), isOpen }.
 * setPending(true) adds "(from the next question)" to the summary line.
 */
export function createOptionsSummary({ title = 'Options', buildPanel, getSummary, onOpen, onClose, returnFocus, open: startOpen = false } = {}) {
  const panelId = uniqueId('options-panel');
  const text = el('span', { class: 'options-summary-text' });
  const pending = el('span', { class: 'options-summary-pending' }, '(from the next question)');
  pending.hidden = true;
  const btnLabel = el('span', {}, 'Change');
  const toggle = el('button', {
    type: 'button',
    class: 'btn btn-small options-summary-toggle',
    'aria-expanded': 'false',
    'aria-controls': panelId,
  }, btnLabel, icon('chevron-down', { size: 16, class: 'help-chevron' }));
  const panel = el('div', { class: 'options-panel', id: panelId, role: 'group', 'aria-label': title });
  panel.hidden = true;
  const doneBtn = el('button', { type: 'button', class: 'btn btn-small options-panel-done' }, 'Done');
  const element = el('section', { class: 'options-summary', 'aria-label': title },
    el('div', { class: 'options-summary-line' },
      el('p', { class: 'options-summary-main' },
        el('span', { class: 'options-summary-title' }, `${title}: `),
        text, ' ', pending),
      toggle),
    panel,
  );

  if (typeof buildPanel === 'function') {
    try { buildPanel(panel); } catch (err) { console.error(err); }
  }
  panel.append(el('div', { class: 'options-panel-foot' }, doneBtn));

  let isOpen = false;
  let offEsc = null;
  let closeTimer = 0;

  function update() {
    let s = '';
    try { s = typeof getSummary === 'function' ? String(getSummary() || '') : ''; } catch (err) { console.error(err); }
    text.textContent = s;
  }

  function open() {
    if (isOpen) return;
    isOpen = true;
    clearTimeout(closeTimer);
    panel.classList.remove('is-closing');
    panel.hidden = false;
    replayAnimation(panel, 'is-opening');
    element.classList.add('is-open');
    toggle.setAttribute('aria-expanded', 'true');
    btnLabel.textContent = 'Done';
    offEsc = onEscape(() => { close({ toToggle: true }); });
    try { if (typeof onOpen === 'function') onOpen(); } catch (err) { console.error(err); }
    element.dispatchEvent(new CustomEvent('optionsopen'));
  }

  function close({ focus = true, toToggle = false } = {}) {
    if (!isOpen) return;
    isOpen = false;
    if (offEsc) { offEsc(); offEsc = null; }
    element.classList.remove('is-open');
    toggle.setAttribute('aria-expanded', 'false');
    btnLabel.textContent = 'Change';
    update();
    panel.classList.remove('is-opening');
    if (prefersReducedMotion()) {
      panel.hidden = true;
    } else {
      panel.classList.add('is-closing');
      closeTimer = setTimeout(() => { panel.hidden = true; panel.classList.remove('is-closing'); }, 150);
    }
    try { if (typeof onClose === 'function') onClose(); } catch (err) { console.error(err); }
    element.dispatchEvent(new CustomEvent('optionsclose'));
    if (focus) {
      let target = null;
      try { target = !toToggle && typeof returnFocus === 'function' ? returnFocus() : null; } catch { target = null; }
      if (!target || !target.isConnected || target.disabled || target.closest('[hidden]')) target = toggle;
      target.focus({ preventScroll: true });
      reveal(target);
    }
  }

  toggle.addEventListener('click', () => (isOpen ? close() : open()));
  doneBtn.addEventListener('click', () => close());

  update();
  if (startOpen) open();

  return {
    element,
    update,
    open,
    close,
    setPending(on) { pending.hidden = !on; },
    get isOpen() { return isOpen; },
  };
}

// ---------------------------------------------------------------------------
// Key legend, tip card
// ---------------------------------------------------------------------------

/**
 * One-line key hints for the current state, e.g. "← → tune · Enter I'm in tune · Space sound on/off".
 * Hidden on touch-only devices and while empty. set(text | nodes).
 */
export function keyLegend() {
  const element = el('p', { class: 'key-legend' });
  element.hidden = true;
  return {
    element,
    set(content) {
      if (content == null || content === '' || (Array.isArray(content) && !content.length)) {
        element.replaceChildren();
        element.hidden = true;
        return;
      }
      setChildren(element, el('span', { class: 'visually-hidden' }, 'Keys: '), content);
      element.hidden = false;
    },
  };
}

/**
 * A small inline tip with actions, e.g. after 3 misses:
 *   createTipCard({ text: 'Want it a bit easier for now?', actions: [{ label: 'Make it easier', onClick }, { label: 'Not now', onClick }] })
 * Rendered hidden; show() fades it in (focus is not moved). An action's onClick runs, then the card hides
 * (return false from onClick to keep it open). Extra: set({ text, actions }).
 */
export function createTipCard({ text = '', actions = [] } = {}) {
  const textEl = el('p', { class: 'tip-card-text' });
  const row = el('div', { class: 'tip-card-actions' });
  const element = el('div', { class: 'tip-card', role: 'status' },
    icon('lightbulb', { size: 20, class: 'tip-card-icon' }),
    el('div', { class: 'tip-card-body' }, textEl, row));
  element.hidden = true;

  function set({ text: t, actions: a } = {}) {
    if (t != null) textEl.textContent = t;
    if (Array.isArray(a)) {
      setChildren(row, a.map((act, i) => el('button', {
        type: 'button',
        class: `btn btn-small${i === 0 ? ' btn-tip-main' : ''}`,
        onclick: (e) => {
          let keep = false;
          try { keep = typeof act.onClick === 'function' && act.onClick(e) === false; } catch (err) { console.error(err); }
          if (!keep) hide();
        },
      }, act.label)));
    }
  }
  function show() {
    element.hidden = false;
    replayAnimation(element);
  }
  function hide() { element.hidden = true; }
  set({ text, actions });
  return { element, show, hide, set };
}

// ---------------------------------------------------------------------------
// Compare switch (As played | In tune; Your version | Pure | Piano)
// ---------------------------------------------------------------------------

/**
 * Segmented A/B(/C) switch for comparing versions after answering. The SCREEN makes the sound:
 *   createCompareSwitch({
 *     options: [{ value, label, key? }],          // key: '1' | '2' | '3' (shown as a hint, works as a shortcut)
 *     scopes?: [{ value, label }],               // optional second choice, e.g. Whole chord | Just the third
 *     onChange(value, scope),                    // start the held sound, or retune it in place if sounding
 *     onStop(),                                  // stop the sound
 *     label?: 'Compare', scopeLabel?: 'Notes', keys?: true,
 *   }) -> { element, value, scope, playing, select(value), stop(), destroy(), setPlaying(bool), reset() }
 * The first option is shown as chosen from the start (silent). Picking an option (click, arrow keys,
 * its digit key) selects it and calls onChange; picking the chosen one again while silent plays it.
 * With ONE option the switch is just a play/stop button labelled with that option. The Play/Stop button (and Space, while the switch is
 * visible) toggles: stop -> onStop(); play -> onChange(current value or the first option, scope).
 * Esc stops while playing. Keys are only active while the switch is visible; the digit keys respect
 * the "Single-key shortcuts" setting. Call setPlaying(false) when the sound ends by itself
 * (e.g. the 8-second cap). stop() calls onStop when playing. reset() clears the choice (new question).
 */
export function createCompareSwitch({ options = [], scopes = null, onChange, onStop, label = 'Compare',
  scopeLabel = 'Notes', keys = true } = {}) {
  groupCount += 1;
  const group = `compare-${groupCount}`;
  let value = null;
  let scope = Array.isArray(scopes) && scopes.length ? scopes[0].value : null;
  let playing = false;
  let offEsc = null;

  const inputs = [];
  const single = options.length === 1;
  const seg = el('div', { class: 'segmented compare-options' });
  if (!single) options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const input = el('input', { type: 'radio', name: group, id, value: String(o.value) });
    input.addEventListener('click', () => {
      // Clicking the already chosen version while silent plays it again.
      if (input.checked && value === o.value && !playing) choose(o.value);
    });
    input.addEventListener('change', () => { if (input.checked) choose(o.value); });
    inputs.push([input, o.value]);
    seg.append(input, el('label', { for: id },
      el('span', {}, o.label),
      o.key ? kbd(o.key) : null));
  });
  const legendId = uniqueId('compare-legend');
  const optionsField = single ? null : el('fieldset', { class: 'segmented-group compare-field', 'aria-labelledby': legendId },
    el('legend', { class: 'visually-hidden', id: legendId }, label), seg);

  let scopeField = null;
  const scopeInputs = [];
  if (Array.isArray(scopes) && scopes.length) {
    const sseg = el('div', { class: 'segmented is-compact compare-scopes' });
    scopes.forEach((s, i) => {
      const id = `${group}-s${i}`;
      const input = el('input', { type: 'radio', name: `${group}-scope`, id, value: String(s.value) });
      input.checked = s.value === scope;
      input.addEventListener('change', () => {
        if (!input.checked) return;
        scope = s.value;
        if (value != null) {
          playing = true;
          syncPlayButton();
          fire();
        }
      });
      scopeInputs.push([input, s.value, s]);
      sseg.append(input, el('label', { for: id }, s.label));
    });
    scopeField = el('fieldset', { class: 'segmented-group is-compact compare-scope-field' },
      el('legend', { class: 'visually-hidden' }, scopeLabel), sseg);
  }

  const playIcon = el('span', { class: 'compare-play-icon' });
  const playText = el('span', {});
  const playBtn = el('button', { type: 'button', class: `btn compare-play${single ? '' : ' btn-small'}` },
    playIcon, playText, kbd('Space'));
  playBtn.addEventListener('click', () => togglePlay());

  const element = el('div', { class: 'compare-switch', role: 'group', 'aria-label': label },
    optionsField, scopeField, playBtn);

  function syncPlayButton() {
    setChildren(playIcon, icon(playing ? 'square' : 'play', { size: 16 }));
    // One option: the button itself names it ("Both the same" / "Stop").
    playText.textContent = playing ? 'Stop' : single ? options[0].label : 'Play';
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    element.classList.toggle('is-playing', playing);
    if (playing && !offEsc) offEsc = onEscape(() => { stop(); });
    if (!playing && offEsc) { offEsc(); offEsc = null; }
  }

  function fire() {
    try { if (typeof onChange === 'function') onChange(value, scope); } catch (err) { console.error(err); }
  }

  function choose(v) {
    value = v;
    for (const [inp, val] of inputs) inp.checked = val === v;
    playing = true;
    syncPlayButton();
    fire();
  }

  function stop() {
    if (!playing) return;
    playing = false;
    syncPlayButton();
    try { if (typeof onStop === 'function') onStop(); } catch (err) { console.error(err); }
  }

  function togglePlay() {
    if (playing) stop();
    else choose(value != null ? value : (options[0] && options[0].value));
  }

  function visible() {
    return element.isConnected && !element.closest('[hidden]') && element.getClientRects().length > 0;
  }

  function onKey(e) {
    if (!keys || e.defaultPrevented || e.altKey || e.ctrlKey || e.metaKey || !visible()) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && (t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable
      || (t.tagName === 'INPUT' && !['radio', 'checkbox', 'range'].includes(t.type)))) return;
    if (e.key === ' ') {
      // Space = play / stop while the switch is on screen (also when Next has focus).
      if (t && t.closest && t.closest('button, a, summary') && !element.contains(t) && !t.closest('.btn-next')) return;
      e.preventDefault();
      if (!e.repeat) togglePlay();
      return;
    }
    const opt = options.find((o) => o.key && String(o.key) === e.key);
    if (!opt) return;
    if (!singleKeysEnabled()) return;
    e.preventDefault();
    if (!e.repeat) choose(opt.value);
  }
  // Space on a focused button would activate it on key-up; stop that while we use Space here.
  function onKeyUp(e) {
    if (!keys || e.key !== ' ' || !visible()) return;
    const t = e.target instanceof Element ? e.target : null;
    if (t && t.closest && t.closest('.btn-next')) e.preventDefault();
  }
  if (keys) {
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('keyup', onKeyUp, true);
  }

  // The first version is shown as chosen from the start (silent), so the state is clear.
  function preselect() {
    value = options[0] ? options[0].value : null;
    for (const [inp, val] of inputs) inp.checked = val === value;
  }
  preselect();
  syncPlayButton();

  return {
    element,
    get value() { return value; },
    get scope() { return scope; },
    get playing() { return playing; },
    stop,
    /** Pick an option from code, exactly as if chosen (selects it and calls onChange). */
    select(v) {
      if (!options.some((o) => o.value === v)) return;
      choose(v);
    },
    setPlaying(on) {
      playing = !!on;
      syncPlayButton();
    },
    reset() {
      playing = false;
      preselect();
      syncPlayButton();
    },
    /** Change the label of a scope option (e.g. "Just the seventh"). */
    setScopeLabel(scopeValue, text) {
      const hit = scopeInputs.find(([, v]) => v === scopeValue);
      if (hit) {
        const lab = hit[0].nextElementSibling;
        if (lab) lab.textContent = text;
      }
    },
    destroy() {
      document.removeEventListener('keydown', onKey, true);
      document.removeEventListener('keyup', onKeyUp, true);
      if (offEsc) { offEsc(); offEsc = null; }
      if (playing) stop();
    },
  };
}

// ---------------------------------------------------------------------------
// Session summary (every 10th round)
// ---------------------------------------------------------------------------

/**
 * "10 rounds done · 7 right · difference 31 → 24 cents · best streak 4"
 *   createSessionSummary({ every = 10, levelLabel = 'difference' })
 *   -> { record({ correct?, levelCents? }), maybeShow(container, { onKeepGoing?, onDone? }) -> boolean }
 * record() after each round (correct: boolean, or omit for singing; levelCents: the difference now, or
 * cents off for singing). maybeShow() — call from Next: after every `every` rounds it appends a card to
 * `container`, focuses "Keep going" and returns true (the screen waits for onKeepGoing before the next
 * question). "Done for now" calls onDone (default: open Your stats). Never blocks otherwise.
 */
export function createSessionSummary({ every = 10, levelLabel = 'difference' } = {}) {
  let count = 0;
  let right = 0;
  let judged = 0;
  let streak = 0;
  let bestStreak = 0;
  let firstLevel = null;
  let lastLevel = null;
  let shownAt = 0;

  function record({ correct, levelCents } = {}) {
    count += 1;
    if (typeof correct === 'boolean') {
      judged += 1;
      if (correct) { right += 1; streak += 1; bestStreak = Math.max(bestStreak, streak); } else streak = 0;
    }
    const lv = Number(levelCents);
    if (Number.isFinite(lv)) {
      if (firstLevel == null) firstLevel = lv;
      lastLevel = lv;
    }
  }

  function centsWord(v) {
    const r = Math.abs(v) < 9.95 ? Math.round(v * 10) / 10 : Math.round(v);
    return `${r} ${r === 1 ? 'cent' : 'cents'}`;
  }

  function maybeShow(container, { onKeepGoing, onDone } = {}) {
    if (!container || count === 0 || count % every !== 0 || shownAt === count) return false;
    shownAt = count;
    const parts = [`${count} rounds done`];
    if (judged) parts.push(`${right} right`);
    if (firstLevel != null && lastLevel != null) {
      parts.push(firstLevel === lastLevel ? `${levelLabel} ${centsWord(lastLevel)}`
        : `${levelLabel} ${centsWord(firstLevel).replace(/ cents?$/, '')} → ${centsWord(lastLevel)}`);
    }
    if (bestStreak > 1) parts.push(`best streak ${bestStreak}`);
    const keep = el('button', { type: 'button', class: 'btn btn-primary' }, 'Keep going',
      el('kbd', { class: 'kbd', 'aria-hidden': 'true' }, 'Enter'));
    const done = el('button', { type: 'button', class: 'btn' }, 'Done for now');
    const card = el('div', { class: 'session-summary', role: 'status' },
      icon('circle-check', { size: 24, class: 'session-summary-icon' }),
      el('div', { class: 'session-summary-body' },
        el('p', { class: 'session-summary-title' }, 'Nice practice.'),
        el('p', { class: 'session-summary-line' }, parts.join(' · ')),
        el('div', { class: 'btn-row' }, keep, done)));
    keep.addEventListener('click', () => {
      card.remove();
      try { if (typeof onKeepGoing === 'function') onKeepGoing(); } catch (err) { console.error(err); }
    });
    done.addEventListener('click', () => {
      card.remove();
      try {
        if (typeof onDone === 'function') onDone();
        else window.location.hash = '#/stats';
      } catch (err) { console.error(err); }
    });
    container.append(card);
    replayAnimation(card);
    // Next block starts from here.
    firstLevel = lastLevel;
    keep.focus({ preventScroll: true });
    reveal(card);
    return true;
  }

  return { record, maybeShow };
}

// ---------------------------------------------------------------------------
// Option cards
// ---------------------------------------------------------------------------

/**
 * A card with a group of large radio "cards".
 * options: [{ value, label, detail?, aside?, extra?, more? }]
 *   aside: small text after the label; extra: a node at the right (e.g. a preview button);
 *   more: extra nodes under the detail (status / hint lines).
 * headingLevel: wrap the legend text in an <h2> (a11y: Settings card titles are headings).
 * Returns the card element.
 */
export function choiceCards({ legend, help, options, value, onChange, plain = false, heading = false }) {
  groupCount += 1;
  const group = `choice-${groupCount}`;
  const list = el('div', { class: 'choice-list' });
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const detailId = o.detail ? `${id}-d` : null;
    const input = el('input', { type: 'radio', name: group, id, value: String(o.value), 'aria-describedby': detailId });
    input.checked = o.value === value;
    input.addEventListener('change', () => { if (input.checked) onChange(o.value); });
    list.append(el('div', { class: 'choice' },
      input,
      el('label', { for: id, class: 'choice-text' },
        el('span', { class: 'choice-label' }, o.label, o.aside ? el('span', { class: 'choice-range' }, o.aside) : null),
        o.detail ? el('span', { class: 'choice-detail', id: detailId }, o.detail) : null,
        o.more || null,
      ),
      o.extra || null,
    ));
  });
  const fieldset = el('fieldset', { class: 'choice-group' },
    el('legend', {}, heading ? el('h2', { class: 'card-title' }, legend) : legend),
    help ? el('p', { class: 'help' }, help) : null,
    list,
  );
  return plain ? fieldset : el('div', { class: 'card' }, fieldset);
}

/**
 * A card with large checkbox "cards" (several can be chosen; at least `min`).
 * options: [{ value, label, detail?, aside? }]; values: array of chosen values.
 * onChange(values) is called with the new array. `footer` nodes go under the list.
 * Returns the card element.
 */
export function checkCards({ legend, help, options, values, onChange, min = 1, minMessage, footer, plain = false, heading = false }) {
  groupCount += 1;
  const group = `check-${groupCount}`;
  const list = el('div', { class: 'choice-list' });
  const note = el('p', { class: 'choice-min-note', role: 'status' });
  const inputs = [];
  options.forEach((o, i) => {
    const id = `${group}-${i}`;
    const input = el('input', { type: 'checkbox', id, value: String(o.value) });
    input.checked = values.includes(o.value);
    input.addEventListener('change', () => {
      const chosen = inputs.filter(([inp]) => inp.checked).map(([, v]) => v);
      if (chosen.length < min) {
        input.checked = true; // keep at least `min`
        note.textContent = minMessage || `Choose at least ${min}.`;
        return;
      }
      note.textContent = '';
      onChange(chosen);
    });
    inputs.push([input, o.value]);
    list.append(el('div', { class: 'choice is-check' },
      input,
      el('label', { for: id, class: 'choice-text' },
        el('span', { class: 'choice-label' }, o.label, o.aside ? el('span', { class: 'choice-range' }, o.aside) : null),
        o.detail ? el('span', { class: 'choice-detail' }, o.detail) : null,
      ),
    ));
  });
  const fieldset = el('fieldset', { class: 'choice-group' },
    el('legend', {}, heading ? el('h2', { class: 'card-title' }, legend) : legend),
    help ? el('p', { class: 'help' }, help) : null,
    list,
    note,
    footer || null,
  );
  return plain ? fieldset : el('div', { class: 'card' }, fieldset);
}

/**
 * A small "?" button that shows help text in a popover (for moving descriptions off the page on phones).
 *   helpPopover({ label = '?', content, title = 'More about this', align = 'right' }) -> { element, open(), close() }
 * content: string or node(s). Click / Enter / Space toggles; Esc, a click outside or Tab away closes it and
 * focus returns to the button. align: 'right' (panel's right edge under the button) or 'left'.
 */
export function helpPopover({ label = '?', content, title = 'More about this', align = 'right' } = {}) {
  const panelId = uniqueId('help-pop');
  const btn = el('button', {
    type: 'button',
    class: 'help-pop-btn',
    'aria-expanded': 'false',
    'aria-controls': panelId,
    'aria-label': title,
    title,
  }, el('span', { 'aria-hidden': 'true' }, label));
  const panel = el('div', { class: `help-pop-panel${align === 'left' ? ' is-left' : ''}`, id: panelId, role: 'note' },
    typeof content === 'string' ? el('p', {}, content) : content);
  panel.hidden = true;
  const element = el('span', { class: 'help-pop' }, btn, panel);
  let offEsc = null;
  function onDocDown(e) { if (!element.contains(e.target)) close(); }
  function onFocusOut(e) { if (e.relatedTarget && !element.contains(e.relatedTarget)) close(); }
  function open() {
    if (!panel.hidden) return;
    panel.hidden = false;
    btn.setAttribute('aria-expanded', 'true');
    offEsc = onEscape(() => { close(); btn.focus(); });
    document.addEventListener('pointerdown', onDocDown, true);
    element.addEventListener('focusout', onFocusOut);
  }
  function close() {
    if (panel.hidden) return;
    panel.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    if (offEsc) { offEsc(); offEsc = null; }
    document.removeEventListener('pointerdown', onDocDown, true);
    element.removeEventListener('focusout', onFocusOut);
  }
  btn.addEventListener('click', () => (panel.hidden ? open() : close()));
  return { element, open, close };
}

/**
 * On/off switch (a checkbox with role=switch): switchControl({ label, checked, onChange(bool), description? })
 * -> { element, input, set(bool) }. description goes on a muted line under it (aria-describedby).
 */
export function switchControl({ label, checked = false, onChange, description } = {}) {
  const id = uniqueId('switch');
  const descId = description ? `${id}-d` : null;
  const input = el('input', { type: 'checkbox', role: 'switch', id, 'aria-describedby': descId });
  input.checked = !!checked;
  input.addEventListener('change', () => {
    try { if (typeof onChange === 'function') onChange(input.checked); } catch (err) { console.error(err); }
  });
  const element = el('div', { class: 'switch-field' },
    el('label', { class: 'switch', for: id }, input, el('span', { class: 'switch-track', 'aria-hidden': 'true' }), el('span', {}, label)),
    description ? el('p', { class: 'switch-desc small muted', id: descId }, description) : null);
  return { element, input, set(on) { input.checked = !!on; } };
}

const SINGLE_KEY_HINT = /^\s*[a-z0-9=](\s*[/,]\s*[a-z0-9=])*\s*$/i;

/** True for a key hint that is only letters / digits / "=" (hidden while single-key shortcuts are off). */
export function isSingleKeyHint(text) {
  return SINGLE_KEY_HINT.test(String(text == null ? '' : text));
}

/** <kbd> hint shown inside buttons. Letter/digit hints get .is-single-key. */
export function kbd(text, title) {
  return el('kbd', { class: `kbd${isSingleKeyHint(text) ? ' is-single-key' : ''}`, title: title || null, 'aria-hidden': 'true' }, text);
}
