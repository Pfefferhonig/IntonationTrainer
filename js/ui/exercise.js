// Building blocks shared by the exercise chapters: big Play button, answer buttons,
// feedback panel, level display, Next button, tucked-away reset control.

import { el, setChildren, centsText } from './dom.js';
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

/** Primary "Next" button. */
export function nextButton({ onClick, label = 'Next', keyHint = 'Enter' }) {
  return el('button', { type: 'button', class: 'btn btn-primary btn-next', onclick: onClick },
    el('span', {}, label),
    icon('chevron-right', { size: 20 }),
    keyHint ? kbd(keyHint) : null,
  );
}

/**
 * Feedback panel. show({ correct, close?, title?, message, details? }) / clear().
 * close: true for an in-between result ("nearly"), shown in a neutral amber style.
 */
export function createFeedback() {
  const element = el('div', { class: 'feedback', role: 'status', 'aria-live': 'polite' });
  element.hidden = true;
  return {
    element,
    show({ correct, close = false, title, message, details }) {
      element.hidden = false;
      element.className = `feedback ${correct ? 'is-correct' : close ? 'is-close' : 'is-wrong'}`;
      setChildren(element,
        icon(correct ? 'circle-check' : close ? 'circle-help' : 'circle-x', { size: 26, class: 'feedback-icon' }),
        el('div', { class: 'feedback-text' },
          title || !message ? el('p', { class: 'feedback-title' }, title || (correct ? 'Correct!' : 'Not quite.')) : null,
          message ? el('p', { class: title ? 'feedback-message' : 'feedback-message is-main' }, message) : null,
          details || null,
        ),
      );
    },
    clear() {
      element.hidden = true;
      element.replaceChildren();
    },
  };
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
 * update(levelCents, stats) — stats may be null.
 */
export function createLevelDisplay({ label = 'Difference' } = {}) {
  const value = el('strong', {}, '–');
  const sub = el('div', { class: 'level-sub' });
  const element = el('div', { class: 'level' },
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
          parts.push(el('span', {}, `best ${centsText(stats.bestThresholdCents)}`));
        }
      } else {
        parts.push(el('span', {}, 'Gets smaller as you improve'));
      }
      const hist = stats && Array.isArray(stats.history)
        ? stats.history.filter((d) => d && d.levelCents != null).map((d) => Number(d.levelCents)).filter(Number.isFinite).slice(-14)
        : [];
      const trend = hist.length >= 2
        ? el('span', { class: 'level-trend', title: 'Your level over recent days — lower means you hear finer differences' },
          sparkline(hist), el('span', { class: 'visually-hidden' }, 'Level over recent days'))
        : null;
      setChildren(sub, parts.flatMap((p, i) => (i ? [el('span', { class: 'dot', 'aria-hidden': 'true' }, '·'), p] : [p])), trend);
    },
  };
}

/** "A3 +12" from a describeFreq-like object (or name + cents). */
function noteText(d, fallbackName, fallbackCents) {
  const pretty = (s) => String(s || '').replace(/#/g, '♯').replace(/-/g, '−');
  if (d && typeof d.text === 'string') return pretty(d.text);
  const c = Math.round(Number(fallbackCents) || 0);
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
 * Returns the element (a div that swaps its content).
 */
export function confirmAction({ intro, buttonLabel, confirmText = 'Are you sure? This cannot be undone.',
  yesLabel = 'Yes, reset', doneText = 'Done.', onConfirm, danger = false }) {
  const area = el('div', { class: 'reset-area' });
  function showAsk() {
    setChildren(area,
      intro ? el('p', { class: 'small muted' }, intro) : null,
      el('button', { type: 'button', class: `btn btn-small${danger ? ' btn-danger' : ''}`, onclick: showConfirm },
        icon('rotate-ccw', { size: 18 }), buttonLabel),
    );
  }
  function showConfirm() {
    setChildren(area,
      el('p', { class: 'small confirm-text' }, confirmText),
      el('div', { class: 'btn-row' },
        el('button', {
          type: 'button',
          class: 'btn btn-small btn-danger',
          onclick: () => {
            try { onConfirm(); } catch (err) { console.error(err); }
            setChildren(area, el('p', { class: 'small', role: 'status' }, doneText));
            setTimeout(() => { if (area.isConnected) showAsk(); }, 2500);
          },
        }, yesLabel),
        el('button', { type: 'button', class: 'btn btn-small', onclick: showAsk }, 'Cancel'),
      ),
    );
    const first = area.querySelector('button');
    if (first) first.focus();
  }
  showAsk();
  return area;
}

/** Tucked-away "reset progress" control with an inline confirmation step. */
export function resetControl({ what = 'this chapter', onConfirm, summary = 'Reset progress' }) {
  return el('details', { class: 'reset-zone' },
    el('summary', {}, el('span', {}, summary), icon('chevron-down', { size: 16, class: 'help-chevron' })),
    confirmAction({
      intro: `Start ${what} again from the beginning. Your level and history for it will be cleared.`,
      buttonLabel: 'Reset progress',
      doneText: 'Progress reset.',
      onConfirm,
    }),
  );
}
