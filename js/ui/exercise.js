// Building blocks shared by the exercises: big Play button, answer buttons, feedback panel,
// level display, Next button, action bar, play progress, loading state, tucked-away reset control.

import { el, setChildren, centsText, roundCentsValue, reveal, uniqueId } from './dom.js';
import { icon } from './icons.js';
import { kbd } from './components.js';

/** Big Play / Play again button. Returns { element, setLabel(text), setPlaying(bool) }. */
export function createPlayButton({ onClick, label = 'Play', shortcut = 'Space' }) {
  const text = el('span', { class: 'btn-play-label' }, label);
  const element = el('button', { type: 'button', class: 'btn btn-play', onclick: onClick },
    icon('play', { size: 26 }),
    text,
    shortcut ? kbd(shortcut) : null,
  );
  return {
    element,
    setLabel(t) { text.textContent = t; },
    setPlaying(on) { element.classList.toggle('is-playing', !!on); },
  };
}

/** Answer button with an optional icon and keyboard hint. */
export function answerButton({ label, iconName, iconAfter = false, keyHint, keyTitle, onClick, className = '', ariaLabel }) {
  const ic = iconName ? icon(iconName, { size: 22 }) : null;
  return el('button', {
    type: 'button',
    class: `btn btn-answer ${className}`.trim(),
    onclick: onClick,
    'aria-label': ariaLabel || null,
  },
    iconAfter ? null : ic,
    el('span', { class: 'btn-answer-label' }, label),
    iconAfter ? ic : null,
    keyHint ? kbd(keyHint, keyTitle) : null,
  );
}

/**
 * Primary "Next" button.
 * New form (BUILD-PLAN contract): nextButton(onNext, { label?, keyHint? })
 *   -> { element, focusAfterFeedback(feedbackId, ...alsoVisible), guard(ms = 400), trigger(), guarded }
 *   guard(ms): Next ignores clicks / Enter / trigger() for ms (no visual change) — no double-fire.
 *   focusAfterFeedback(id): aria-describedby = the feedback, guard(400), focus with preventScroll,
 *     then the smallest scroll that keeps the feedback (+ alsoVisible elements) and Next visible.
 *   trigger(): run onNext unless guarded (for a keyboard shortcut). Returns true when it ran.
 * Old form (still supported): nextButton({ onClick, label, keyHint }) -> the button element.
 */
export function nextButton(arg, opts = {}) {
  const legacy = !!arg && typeof arg === 'object';
  const { label = 'Next', keyHint = 'Enter' } = legacy ? arg : (opts || {});
  const onNext = legacy ? arg.onClick : arg;
  let guardedUntil = 0;
  const isGuarded = () => Date.now() < guardedUntil;
  const element = el('button', { type: 'button', class: 'btn btn-primary btn-next' },
    el('span', {}, label),
    icon('chevron-right', { size: 20 }),
    keyHint ? kbd(keyHint) : null,
  );
  function trigger(e) {
    if (isGuarded()) return false;
    try { if (typeof onNext === 'function') onNext(e); } catch (err) { console.error(err); }
    return true;
  }
  element.addEventListener('click', (e) => { trigger(e); });
  if (legacy) return element;
  function guard(ms = 400) { guardedUntil = Date.now() + Math.max(0, Number(ms) || 0); }
  return {
    element,
    guard,
    trigger,
    get guarded() { return isGuarded(); },
    focusAfterFeedback(feedbackId, ...alsoVisible) {
      if (feedbackId) element.setAttribute('aria-describedby', feedbackId);
      guard(400);
      const fb = feedbackId ? document.getElementById(feedbackId) : null;
      if (!element.isConnected || element.hidden || element.closest('[hidden]')) return;
      element.focus({ preventScroll: true });
      reveal(...alsoVisible, fb, element);
      // Once more after the staged entrance (parts that appear or grow a moment later).
      setTimeout(() => {
        if (element.isConnected && document.activeElement === element) reveal(...alsoVisible, fb, element);
      }, 300);
    },
  };
}

const FEEDBACK_ICONS = { 'in-tune': 'circle-check', close: 'circle-dot', 'keep-going': 'circle-arrow-right' };
const LEVELS = new Set(['in-tune', 'close', 'keep-going']);

/**
 * Feedback panel, always in the page (an empty live region, hidden by CSS while empty) with an id.
 * show({ level: 'in-tune' | 'close' | 'keep-going', message, detail?, icon? }) / clear().
 *   in-tune = green check, close = amber, keep-going = neutral (never red for practice).
 *   detail: string or node(s) for the smaller second line(s); icon: an icon name, or false for none.
 *   Classes: .feedback.is-in-tune / .is-close / .is-keep-going; staged entrance (panel, then details).
 * Old form (still supported): show({ correct, close?, title?, message, details? }).
 * Returns { element, id, show, clear, level }.
 */
export function createFeedback() {
  const id = uniqueId('feedback');
  const element = el('div', { class: 'feedback', id, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' });
  let level = null;
  return {
    element,
    id,
    get level() { return level; },
    show({ level: lv, message, detail, details, icon: iconName, correct, close = false, title } = {}) {
      level = LEVELS.has(lv) ? lv : correct ? 'in-tune' : close ? 'close' : 'keep-going';
      const extra = detail != null ? detail : details;
      const extraNode = extra == null || extra === '' ? null
        : typeof extra === 'string' ? el('p', { class: 'feedback-detail' }, extra)
          : el('div', { class: 'feedback-detail' }, extra);
      const ic = iconName === false ? null : icon(iconName || FEEDBACK_ICONS[level], { size: 26, class: 'feedback-icon' });
      setChildren(element,
        ic,
        el('div', { class: 'feedback-text' },
          title || !message ? el('p', { class: 'feedback-title' }, title || (level === 'in-tune' ? 'Right.' : 'Not this time.')) : null,
          message ? el('p', { class: title ? 'feedback-message' : 'feedback-message is-main' }, message) : null,
          extraNode,
        ),
      );
      element.hidden = false;
      element.className = `feedback is-${level}`;
      void element.offsetWidth; // restart the entrance animation
      element.classList.add('is-entering');
    },
    clear() {
      level = null;
      element.className = 'feedback';
      element.replaceChildren();
    },
  };
}

/**
 * Bar for the screen's primary action(s): inline on wide screens, a sticky bar at the bottom of the
 * window below 600 px (above the bottom tab bar). Returns { element, set(...buttons) }.
 */
export function createActionBar() {
  const inner = el('div', { class: 'action-bar-inner' });
  const element = el('div', { class: 'action-bar', 'data-inset-bottom': '' }, inner);
  return {
    element,
    set(...buttons) { setChildren(inner, buttons); },
  };
}

const progressState = new WeakMap();

function swapLabel(button, text) {
  const target = button.querySelector('.btn-play-label, .btn-label');
  if (!target) return null;
  const before = target.textContent;
  target.textContent = text;
  return () => { target.textContent = before; };
}

/**
 * While a sequence plays: a thin bar along the button's bottom edge for `ms`, and its label
 * ('.btn-play-label' or '.btn-label' inside the button) reads "Playing…". Ends by itself after ms.
 * Calling it again restarts. Returns stop(). Reduced motion: the bar shows full at once.
 */
export function playProgress(button, ms) {
  if (!button) return () => {};
  const prev = progressState.get(button);
  if (prev) prev();
  const dur = Math.max(0, Number(ms) || 0);
  const bar = el('span', { class: 'play-progress', 'aria-hidden': 'true' });
  bar.style.setProperty('--play-ms', `${dur}ms`);
  button.classList.add('has-play-progress', 'is-playing');
  button.append(bar);
  const restore = swapLabel(button, 'Playing…');
  let done = false;
  let timer = 0;
  function stop() {
    if (done) return;
    done = true;
    clearTimeout(timer);
    bar.remove();
    button.classList.remove('has-play-progress', 'is-playing');
    if (restore) restore();
    if (progressState.get(button) === stop) progressState.delete(button);
  }
  timer = setTimeout(stop, dur + 50);
  progressState.set(button, stop);
  return stop;
}

/**
 * Loading state on a sound button while a recorded sound loads: after 100 ms a spinner + "Loading…"
 * (aria-busy=true); after slowAfterMs "Still loading…" (title: "Still loading — slow connection?").
 * Restored when the promise settles. Returns the same promise.
 */
export function buttonBusy(button, promise, { slowAfterMs = 4000 } = {}) {
  const p = Promise.resolve(promise);
  if (!button) return p;
  const text = el('span', { class: 'btn-busy-text' }, 'Loading…');
  const overlay = el('span', { class: 'btn-busy' }, icon('loader-circle', { size: 18, class: 'spin' }), text);
  let shown = false;
  const showTimer = setTimeout(() => {
    shown = true;
    button.classList.add('is-busy');
    button.setAttribute('aria-busy', 'true');
    button.append(overlay);
  }, 100);
  const slowTimer = setTimeout(() => {
    text.textContent = 'Still loading…';
    button.setAttribute('title', 'Still loading — slow connection?');
  }, Math.max(100, Number(slowAfterMs) || 4000));
  const end = () => {
    clearTimeout(showTimer);
    clearTimeout(slowTimer);
    if (shown) {
      overlay.remove();
      button.classList.remove('is-busy');
      button.removeAttribute('aria-busy');
      button.removeAttribute('title');
    }
  };
  p.then(end, end);
  return p;
}

function sparkline(values) {
  const NS = 'http://www.w3.org/2000/svg';
  const w = 96;
  const h = 24;
  const pad = 3;
  const max = Math.max(...values);
  const min = Math.min(...values);
  const span = max - min || 1;
  // Larger difference = higher on the chart, so improving shows as a line going down.
  const flipped = values.map((v, i) => [
    pad + (i * (w - 2 * pad)) / (values.length - 1),
    h - pad - ((v - min) / span) * (h - 2 * pad),
  ]);
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('class', 'sparkline');
  svg.setAttribute('aria-hidden', 'true');
  const line = document.createElementNS(NS, 'polyline');
  line.setAttribute('points', flipped.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' '));
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke', 'currentColor');
  line.setAttribute('stroke-width', '2');
  line.setAttribute('stroke-linecap', 'round');
  line.setAttribute('stroke-linejoin', 'round');
  const last = flipped[flipped.length - 1];
  const dot = document.createElementNS(NS, 'circle');
  dot.setAttribute('cx', last[0].toFixed(1));
  dot.setAttribute('cy', last[1].toFixed(1));
  dot.setAttribute('r', '2.5');
  dot.setAttribute('fill', 'currentColor');
  svg.append(line, dot);
  return svg;
}

/**
 * Compact level display: "Difference: 23 cents" + one line of stats from getStats.
 * update(levelCents, stats) — stats may be null. inline: true = one short line, no card (fits in a
 * heading line). Below 600 px every level display is compact (no card, no stats line) and, when it
 * is a direct child of .screen-head, sits on the h1 line.
 */
export function createLevelDisplay({ label = 'Difference', inline = false } = {}) {
  const value = el('strong', {}, '–');
  const sub = el('div', { class: 'level-sub' });
  const element = el('div', { class: `level${inline ? ' is-inline' : ''}` },
    el('div', { class: 'level-main' }, el('span', { class: 'level-label' }, `${label}: `), value),
    sub,
  );
  return {
    element,
    update(levelCents, stats) {
      value.textContent = centsText(levelCents);
      const parts = [];
      if (stats && stats.answered > 0) {
        const pct = Math.round((100 * stats.correct) / stats.answered);
        parts.push(el('span', {}, `${stats.correct} of ${stats.answered} right (${pct}%)`));
        if (stats.streak > 1) parts.push(el('span', {}, `${stats.streak} in a row`));
        if (Number.isFinite(stats.bestThresholdCents)) {
          parts.push(el('span', {}, `finest ${centsText(stats.bestThresholdCents)}`));
        }
      } else {
        parts.push(el('span', {}, 'Gets smaller as you improve'));
      }
      const hist = stats && Array.isArray(stats.history)
        ? stats.history.filter((d) => d && d.levelCents != null).map((d) => Number(d.levelCents)).filter(Number.isFinite).slice(-14)
        : [];
      const trend = hist.length >= 2
        ? el('span', { class: 'level-trend', title: 'Difference over recent days — lower is better' },
          sparkline(hist), el('span', { class: 'visually-hidden' }, 'Difference over recent days, lower is better'))
        : null;
      setChildren(sub, parts.flatMap((p, i) => (i ? [el('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), p] : [p])), trend);
    },
  };
}

/** "A3 +12" from a describeFreq-like object (or name + cents). */
function noteText(d, fallbackName, fallbackCents) {
  const pretty = (s) => String(s || '').replace(/#/g, '♯').replace(/-/g, '−');
  if (d && typeof d.text === 'string') return pretty(d.text);
  const c = roundCentsValue(Number(fallbackCents) || 0) || 0;
  return pretty(c ? `${fallbackName} ${c > 0 ? '+' : '-'}${Math.abs(c)}` : fallbackName);
}

/**
 * Short secondary line: what actually sounded, from an exercise's describe(question).
 * heading: optional bold lead (e.g. the chord name). Notes whose played pitch differs
 * from the in-tune pitch are emphasised. Returns an element (or null without data).
 */
export function soundedLine(desc, { heading } = {}) {
  if (!desc || !Array.isArray(desc.notes) || !desc.notes.length) return null;
  const parts = [];
  desc.notes.forEach((n, i) => {
    if (i) parts.push(el('span', { class: 'sep', 'aria-hidden': 'true' }, ' · '));
    const played = n.played || null;
    const inTune = n.inTune || null;
    const off = played && inTune && (played.name !== inTune.name || Math.abs((played.cents || 0) - (inTune.cents || 0)) > 0.5);
    parts.push(el(off ? 'strong' : 'span', { class: off ? 'is-off' : null },
      `${n.label} ${noteText(played, n.name, n.cents)}`));
  });
  return el('p', { class: 'notes-line' },
    el('span', { class: 'notes-line-lead' }, 'What sounded: '),
    heading ? [el('span', { class: 'notes-line-heading' }, heading), ' — '] : null,
    parts,
  );
}

/**
 * A button that asks "Are you sure?" inline before doing something destructive.
 * Focus: the confirmation focuses Cancel (a stray Enter can't destroy anything); Cancel and the
 * finished action return focus to the first button. The status line is always in the page.
 * Returns the element.
 */
export function confirmAction({ intro, buttonLabel, confirmText = "Are you sure? This can't be undone.",
  yesLabel = 'Reset', doneText = 'Done.', onConfirm, danger = false }) {
  const area = el('div', { class: 'reset-area-body' });
  const status = el('p', { class: 'small confirm-status', role: 'status' });
  const element = el('div', { class: 'reset-area' }, area, status);
  function showAsk({ focus = false } = {}) {
    const btn = el('button', { type: 'button', class: `btn btn-small${danger ? ' btn-danger' : ''}`, onclick: () => showConfirm() },
      icon('rotate-ccw', { size: 18 }), buttonLabel);
    setChildren(area,
      intro ? el('p', { class: 'small muted' }, intro) : null,
      btn,
    );
    if (focus) btn.focus();
  }
  function showConfirm() {
    status.textContent = '';
    const cancel = el('button', { type: 'button', class: 'btn btn-small', onclick: () => showAsk({ focus: true }) }, 'Cancel');
    setChildren(area,
      el('p', { class: 'small confirm-text' }, confirmText),
      el('div', { class: 'btn-row' },
        el('button', {
          type: 'button',
          class: 'btn btn-small btn-danger',
          onclick: () => {
            try { onConfirm(); } catch (err) { console.error(err); }
            showAsk({ focus: true });
            status.textContent = doneText;
            setTimeout(() => { status.textContent = ''; }, 4000);
          },
        }, yesLabel),
        cancel,
      ),
    );
    cancel.focus();
  }
  showAsk();
  return element;
}

/** Tucked-away "reset progress" control with an inline confirmation step. */
export function resetControl({ what = 'this exercise', onConfirm, summary = 'Reset progress' }) {
  return el('details', { class: 'reset-zone' },
    el('summary', {}, el('span', {}, summary), icon('chevron-down', { size: 16, class: 'help-chevron' })),
    confirmAction({
      intro: `Start ${what} from the beginning. This clears its progress and rank.`,
      buttonLabel: 'Reset progress',
      confirmText: `Reset ${what}? This can't be undone.`,
      yesLabel: 'Reset progress',
      doneText: 'Progress reset.',
      onConfirm,
    }),
  );
}
