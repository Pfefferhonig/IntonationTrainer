// "Higher / lower" (#/higher-or-lower)
// Two notes: the second is the same note pushed slightly up or down — or, with
// "Sometimes no difference", sometimes exactly the same.
//
// Shared interaction model (docs/BUILD-PLAN.md): Ready -> Presenting (answers locked until the
// second note starts) -> Answering -> Feedback (compare switch) -> Next.
// This file also exports a few small helpers (lx*) used by odd-one-out.js, so the two listening
// screens behave the same.

import * as hl from '../exercise/higher-lower.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import { getSettings, getPref, setPref, onSettingsChange } from '../storage.js';
import { el, setChildren, centsText, uniqueId, reveal } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import {
  helpBox, installShortcuts, onEscape, createOptionsSummary, keyLegend, createTipCard, createCompareSwitch,
  createSessionSummary, refocusAfterPointerChange, refocusAfterClick, singleKeysEnabled, kbd,
} from '../ui/components.js';
import {
  createPlayButton, answerButton, nextButton, createFeedback, createLevelDisplay, createActionBar,
  playProgress, buttonBusy,
} from '../ui/exercise.js';
import { onPageHidden, createPausedCard } from '../ui/pause.js';
import { createPlayer } from '../ui/player.js';
import { trackHighlights } from '../ui/highlight.js';
import { chapterProgressPanel } from '../ui/chapter-progress.js';
import { voiceArg } from '../ui/voices.js';

// =====================================================================================
// Helpers shared by the two listening screens
// =====================================================================================

function reduceMotion() {
  try { return window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return false; }
}

/** Stop every sound of the screen (player + held notes + reverb tails). */
export function lxStopSound(player) {
  try { if (player) player.stop(); } catch (err) { console.error(err); }
  if (typeof engine.stopEverything === 'function') {
    try { engine.stopEverything(); } catch (err) { console.error(err); }
  }
}

/** Seconds until a playback handle really starts (scheduling lookahead), for gates and progress bars. */
export function lxLeadSeconds(handle) {
  const ctx = typeof engine.getAudioContext === 'function' ? engine.getAudioContext() : null;
  if (!ctx || !handle || !Number.isFinite(handle.startTime)) return 0;
  return Math.max(0, handle.startTime - ctx.currentTime);
}

/** Result level: the logic's `level`, else derived. */
export function lxLevelOf(result) {
  if (result && ['in-tune', 'close', 'keep-going'].includes(result.level)) return result.level;
  if (result && result.correct) return 'in-tune';
  if (result && result.noteCorrect === true && result.directionCorrect === false) return 'close';
  return 'keep-going';
}

const MARK_CLASSES = ['is-chosen', 'is-in-tune', 'is-close', 'is-keep-going', 'is-right', 'is-wrong'];

/**
 * Answer-button result: green ✓ on the right answer, a neutral (or amber for "close") ✗ on a miss —
 * never red — plus visually hidden "(your answer)" / "(correct answer)" for screen readers.
 */
export function lxMark(button, { right = false, chosen = false, level = 'keep-going', iconWhenRight = true } = {}) {
  lxUnmark(button);
  if (!right && !chosen) return;
  if (chosen) button.classList.add('is-chosen');
  button.classList.add(right ? 'is-in-tune' : level === 'close' ? 'is-close' : 'is-keep-going');
  const words = [chosen ? 'your answer' : null, right ? 'correct answer' : null].filter(Boolean).join(', ');
  button.append(el('span', { class: `lx-mark${right ? ' is-right' : ''}` },
    right && !iconWhenRight ? null : icon(right ? 'check' : 'x', { size: 18 }),
    el('span', { class: 'visually-hidden' }, ` (${words})`)));
}
export function lxUnmark(button) {
  button.classList.remove(...MARK_CLASSES);
  for (const m of button.querySelectorAll('.lx-mark')) m.remove();
}

/** Answer buttons locked while the question still sounds: they look locked, a press says why. */
export function lxLockAnswers(buttons, state) {
  for (const b of buttons) {
    b.disabled = !(state === 'answering' || state === 'presenting');
    if (state === 'presenting') b.setAttribute('aria-disabled', 'true');
    else b.removeAttribute('aria-disabled');
  }
}

// "Next difference: a little smaller" — only the first 3 times per session and exercise.
const levelNotesShown = new Map();
export function lxLevelNote(key, direction) {
  if (direction !== 'harder' && direction !== 'easier') return '';
  const n = levelNotesShown.get(key) || 0;
  if (n >= 3) return '';
  levelNotesShown.set(key, n + 1);
  return direction === 'harder' ? 'Next difference: a little smaller.' : 'Next difference: a little bigger.';
}

// Tip after 3 misses in a row: once per exercise per session.
const tipsOffered = new Set();
export function lxShouldTip(key, missStreak) {
  const limit = Number.isFinite(progress.MISS_STREAK_TIP) ? progress.MISS_STREAK_TIP : 3;
  if (missStreak < limit || tipsOffered.has(key) || typeof progress.makeEasier !== 'function') return false;
  tipsOffered.add(key);
  return true;
}

/** progress.makeEasier for a listening exercise -> the staircase to use from now on (or null). */
export function lxMakeEasier(key) {
  try {
    const r = progress.makeEasier(key);
    return r && r.staircase ? r.staircase : progress.loadStaircase(key);
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** Level display: counts to its new value (from 260 ms, 300 ms) with ▼ / ▲ for 2 s. Returns cancel(). */
export function lxUpdateLevel(level, { from, to, stats, direction, delayMs = 260 }) {
  level.update(to, stats);
  const main = level.element.querySelector('.level-main') || level.element;
  const strong = main.querySelector('strong');
  for (const a of main.querySelectorAll('.lx-level-arrow')) a.remove();
  let arrow = null;
  const timers = [];
  if (direction === 'harder' || direction === 'easier') {
    arrow = el('span', { class: 'lx-level-arrow' },
      el('span', { 'aria-hidden': 'true' }, direction === 'harder' ? '▼' : '▲'),
      el('span', { class: 'visually-hidden' }, direction === 'harder' ? ' (smaller)' : ' (bigger)'));
    main.append(arrow);
    timers.push(setTimeout(() => arrow.remove(), 2000 + delayMs));
  }
  if (strong && Number.isFinite(from) && Number.isFinite(to) && from !== to && !reduceMotion()) {
    const final = strong.textContent;
    strong.textContent = centsText(from);
    timers.push(setTimeout(() => {
      const t0 = performance.now();
      const step = () => {
        const k = Math.min(1, (performance.now() - t0) / 300);
        const eased = 1 - (1 - k) ** 3;
        strong.textContent = k >= 1 ? final : centsText(from + (to - from) * eased);
        if (k < 1) timers.push(setTimeout(step, 16));
      };
      step();
    }, delayMs));
  }
  return () => {
    timers.forEach(clearTimeout);
    if (arrow) arrow.remove();
    if (strong) strong.textContent = centsText(to);
  };
}

/** Restart (or clear) the staged reveal of names and compare controls after answering (CSS). */
export function lxStageReveal(node, on = true) {
  node.classList.remove('lx-reveal');
  if (!on) return;
  void node.offsetWidth;
  node.classList.add('lx-reveal');
}

/** Select a version on the shared compare switch (as if picked): plays or retunes. */
export function lxCompareSelect(sw, value) {
  if (!sw) return false;
  if (typeof sw.select === 'function') { sw.select(value); return true; }
  const input = Array.from(sw.element.querySelectorAll('input[type="radio"]')).find((i) => i.value === String(value));
  if (!input) return false;
  input.click();
  return true;
}

/**
 * Paused state: on tab hidden / audio interrupted, stop the sound; on return show
 * "Paused while you were away" + Continue when something was going on (isBusy()).
 * Returns { element, isShown, destroy() }.
 */
export function lxPause({ isBusy, onHide, onContinue }) {
  const card = createPausedCard({
    onContinue: () => {
      try { engine.initAudio(); } catch { /* resumes on the next play */ }
      try { onContinue(); } catch (err) { console.error(err); }
    },
  });
  let pausedSomething = false;
  const off = onPageHidden({
    onHide: (info) => {
      try { if (isBusy()) pausedSomething = true; } catch { /* ignore */ }
      try { onHide(); } catch (err) { console.error(err); }
      if (info && info.reason === 'audio' && pausedSomething) { pausedSomething = false; card.show(); }
    },
    onShow: () => {
      if (pausedSomething) { pausedSomething = false; card.show(); }
    },
  });
  return {
    element: card.element,
    get isShown() { return card.isShown; },
    destroy() { off(); },
  };
}

export { singleKeysEnabled as lxSingleKeysOn };

/** Mark a <kbd> badge as a single-key shortcut (letter / digit / =): hidden while those are off. */
export function lxSingleKey(kbdEl) {
  if (kbdEl && kbdEl.classList) kbdEl.classList.add('lx-key-single');
  return kbdEl;
}

/** Keep the screen's single-key badges in step with Settings > Single-key shortcuts. Returns unsubscribe. */
export function lxWatchSingleKeys(screen, onChange) {
  const apply = () => {
    screen.classList.toggle('is-no-single-keys', !singleKeysEnabled());
    if (typeof onChange === 'function') onChange();
  };
  screen.classList.toggle('is-no-single-keys', !singleKeysEnabled());
  try { return onSettingsChange(apply) || (() => {}); } catch { return () => {}; }
}

const WIDE_QUERY = '(min-width: 601px)';

/**
 * Where the primary action sits: on wider screens above the question until the answer (so Play is
 * visible without scrolling), then under the feedback (Next); on phones always at the end of the
 * stage, where the action bar sticks to the bottom. Real DOM order (focus order = visual order).
 * The bar's content is only replaced when the button changes, so a focused button keeps focus.
 */
export function lxPrimaryPlacer(actionBar, { top, bottom, onChange }) {
  let current = null;
  let mq = null;
  try { mq = window.matchMedia(WIDE_QUERY); } catch { mq = null; }
  if (mq && typeof onChange === 'function') mq.addEventListener('change', onChange);
  return {
    place(button, { atTop }) {
      const anchor = mq && mq.matches && atTop ? top : bottom;
      const bar = actionBar.element;
      if (anchor && anchor.parentNode && bar.nextSibling !== anchor) {
        const focused = document.activeElement;
        anchor.parentNode.insertBefore(bar, anchor);
        if (focused && bar.contains(focused) && document.activeElement !== focused) focused.focus({ preventScroll: true });
      }
      if (current !== button) {
        actionBar.set(button);
        current = button;
      }
    },
    destroy() { if (mq && typeof onChange === 'function') mq.removeEventListener('change', onChange); },
  };
}

/**
 * A single "Play again" button for rounds where nothing differs (one version only), instead of a
 * one-option compare switch. toggle() plays / stops; setPlaying(bool) shows the state.
 */
export function lxReplayButton({ onPlay, onStop }) {
  let playing = false;
  const label = el('span', { class: 'btn-label' }, 'Play again');
  const iconHolder = el('span', { class: 'lx-replay-icon' }, icon('play', { size: 18 }));
  const element = el('button', { type: 'button', class: 'btn lx-replay', 'aria-pressed': 'false' },
    iconHolder, label, lxSingleKey(kbd('R')));
  const paint = () => {
    element.classList.toggle('is-playing', playing);
    element.setAttribute('aria-pressed', playing ? 'true' : 'false');
    label.textContent = playing ? 'Stop' : 'Play again';
    setChildren(iconHolder, icon(playing ? 'square' : 'play', { size: 18 }));
  };
  const api = {
    element,
    get playing() { return playing; },
    play() { playing = true; paint(); onPlay(); },
    toggle() { if (playing) { playing = false; paint(); onStop(); } else api.play(); },
    setPlaying(on) { playing = !!on; paint(); },
  };
  element.addEventListener('click', () => api.toggle());
  return api;
}

/**
 * Phones: the difference shown inline in the heading ("Higher / lower · 40 cents") instead of the level
 * card (hidden there by CSS). Mirrors the card's value, including its count-up. Returns disconnect().
 */
export function lxInlineLevel(level, target) {
  const strong = level.element.querySelector('.level-main strong, strong');
  const copy = () => { target.textContent = strong && strong.textContent && strong.textContent !== '–' ? ` · ${strong.textContent}` : ''; };
  copy();
  if (!strong || typeof MutationObserver !== 'function') return () => {};
  const mo = new MutationObserver(copy);
  mo.observe(strong, { childList: true, characterData: true, subtree: true });
  return () => mo.disconnect();
}

/** Task line: the full sentence on wider screens, a short one on phones. */
export function lxTaskLine(long, short) {
  return el('p', { class: 'task' },
    el('span', { class: 'lx-task-long' }, long),
    el('span', { class: 'lx-task-short' }, short));
}

/**
 * Would the span from `first` to `last` fit between the sticky/fixed bars? (For "keep the off-note
 * row in view after answering if it fits", without pushing the compare controls under the bars.)
 */
export function lxFitsInView(first, last) {
  if (!first || !last) return false;
  let top = 0;
  let bottom = 0;
  for (const n of document.querySelectorAll('[data-inset-top]')) {
    const cs = getComputedStyle(n);
    if (n.getClientRects().length && (cs.position === 'fixed' || cs.position === 'sticky')) top = Math.max(top, n.getBoundingClientRect().height);
  }
  for (const n of document.querySelectorAll('[data-inset-bottom]')) {
    const cs = getComputedStyle(n);
    if (!n.getClientRects().length) continue;
    if (cs.position === 'fixed') bottom = Math.max(bottom, window.innerHeight - n.getBoundingClientRect().top);
    else if (cs.position === 'sticky') bottom = Math.max(bottom, (parseFloat(cs.bottom) || 0) + n.getBoundingClientRect().height);
  }
  const span = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
  return span <= window.innerHeight - top - bottom - 24;
}

// The explanation under the compare switch: on phones only the first 2 times per session and exercise.
const compareNotesShown = new Map();
export function lxCompareNoteSeen(key, noteEl) {
  const n = (compareNotesShown.get(key) || 0) + 1;
  compareNotesShown.set(key, n);
  noteEl.classList.toggle('is-repeat', n > 2);
}

/** In Feedback without a compare switch, Space on the focused Next plays / stops instead of moving on. */
export function lxSpaceOnNext(nextEl, handler) {
  const h = (e) => {
    if (e.key !== ' ') return;
    if (!handler(e.type === 'keydown' && !e.repeat)) return;
    e.preventDefault();
  };
  nextEl.addEventListener('keydown', h);
  nextEl.addEventListener('keyup', h);
}

// =====================================================================================
// Higher / lower
// =====================================================================================

const KEY = 'higher-or-lower';
const NOTE_SECONDS = 1.0;
const GAP_SECONDS = 0.35;
const GATE_MS = (NOTE_SECONDS + GAP_SECONDS) * 1000; // second-note onset
const SEQUENCE_MS = (2 * NOTE_SECONDS + GAP_SECONDS) * 1000;
const PLAN = [
  { key: 0, start: 0, end: NOTE_SECONDS },
  { key: 1, start: NOTE_SECONDS + GAP_SECONDS, end: 2 * NOTE_SECONDS + GAP_SECONDS },
];

export default {
  id: KEY,
  title: 'Higher / lower',

  render(container) {
    let staircase = progress.loadStaircase(KEY);
    let question = null;
    // 'ready' | 'presenting' (answers locked) | 'answering' | 'feedback'
    let state = 'ready';
    let gatePassed = false;
    let gateTimer = 0;
    let stopProgress = null;
    let cancelLevelAnim = null;
    let missStreak = 0;
    let compare = null;
    let replay = null;    // single "Play again" when both notes were the same
    let compareStarting = false;
    let lastDesc = null;
    let resolveBusy = null;
    let placer = null;
    let allowSame = getPref('higherLower.allowSame', true) !== false;
    const timbre = () => getSettings().timbre;

    // ---------- Pieces ----------
    const level = createLevelDisplay({ label: 'Difference' });
    const headLevel = el('span', { class: 'lx-head-level' });
    const feedback = createFeedback();
    const legend = keyLegend();
    const actionBar = createActionBar();
    const summary = createSessionSummary({ every: 10, levelLabel: 'difference' });
    const summarySlot = el('div', { class: 'lx-slot' });
    const status = el('p', { class: 'stage-hint lx-status', role: 'status' });
    const flashLine = el('p', { class: 'lx-flash', role: 'status' });
    const tip = createTipCard({ text: 'Finding this hard? Make the difference a little bigger for a while.', actions: [] });

    // "1" "2" markers that light up while each note sounds; captions show the names afterwards.
    const markers = [0, 1].map((i) => {
      const cap = el('span', { class: 'lx-marker-cap' });
      const node = el('div', { class: 'lx-marker' },
        el('span', { class: 'lx-marker-num', 'aria-hidden': 'true' }, String(i + 1)),
        cap);
      return { node, cap };
    });
    const pair = el('div', { class: 'lx-pair' }, markers.map((m) => m.node));
    const lightUp = (keys) => markers.forEach((m, i) => m.node.classList.toggle('is-sounding', keys.has(i)));

    const player = createPlayer({
      onChange: (s) => {
        status.classList.toggle('is-error', !!s.error);
        if (s.error) status.textContent = s.error;
        else if (s.loading) status.textContent = 'Loading sound…';
        else syncStatus();
        if (s.loading && !resolveBusy) {
          buttonBusy(state === 'feedback' ? compare && compare.element : playBtn.element,
            new Promise((resolve) => { resolveBusy = resolve; }));
        } else if (!s.loading && resolveBusy) {
          resolveBusy();
          resolveBusy = null;
        }
        playBtn.setPlaying(s.playing && s.tag === 'question');
        if (s.playing || s.error) compareStarting = false;
        if (!s.playing) {
          if (stopProgress) { stopProgress(); stopProgress = null; }
          // A new compare play() first stops the previous sound: keep the switch "playing" then.
          if (!compareStarting && compare) compare.setPlaying(false);
          if (!compareStarting && replay) replay.setPlaying(false);
          if (lastDesc) markers[1].cap.textContent = lastDesc.relation;
        }
      },
    });

    const playBtn = createPlayButton({ onClick: () => playQuestion(), label: 'Play', shortcut: 'Space' });

    const higherBtn = answerButton({
      label: 'Higher', iconName: 'arrow-up', keyHint: '↑', keyTitle: 'Arrow up key',
      className: 'answer-higher', onClick: () => answer('sharp'),
    });
    const sameBtn = answerButton({
      label: 'Same', keyHint: '=', keyTitle: 'Key =',
      className: 'answer-same', onClick: () => answer('same'),
    });
    sameBtn.prepend(el('span', { class: 'same-sign', 'aria-hidden': 'true' }, '='));
    lxSingleKey(sameBtn.querySelector('.kbd'));
    const lowerBtn = answerButton({
      label: 'Lower', iconName: 'arrow-down', keyHint: '↓', keyTitle: 'Arrow down key',
      className: 'answer-lower', onClick: () => answer('flat'),
    });
    const answerBtns = { sharp: higherBtn, same: sameBtn, flat: lowerBtn };
    const answers = el('div', { class: 'answers answers-stack lx-answers', role: 'group', 'aria-label': 'Your answer' },
      higherBtn, sameBtn, lowerBtn);

    const next = nextButton(() => onNext());
    lxSpaceOnNext(next.element, (act) => {
      if (state !== 'feedback' || !replay) return false;
      if (act) replay.toggle();
      return true;
    });

    const compareHolder = el('div', { class: 'lx-compare-holder' });
    const compareNote = el('p', { class: 'compare-note' });
    const compareArea = el('div', { class: 'lx-compare' }, compareHolder, compareNote);

    // ---------- Options ("Sometimes no difference") ----------
    const sameToggle = el('input', { type: 'checkbox', role: 'switch', id: uniqueId('hl-same') });
    sameToggle.checked = allowSame;
    sameToggle.addEventListener('change', () => {
      allowSame = sameToggle.checked;
      setPref('higherLower.allowSame', allowSame);
      optionsChanged();
    });
    const options = createOptionsSummary({
      title: 'Options',
      getSummary: () => (allowSame ? 'Sometimes no difference' : 'Always a difference'),
      buildPanel: (panel) => {
        panel.append(
          el('label', { class: 'switch', for: sameToggle.id }, sameToggle,
            el('span', { class: 'switch-track', 'aria-hidden': 'true' }),
            el('span', {}, 'Sometimes no difference')),
          el('p', { class: 'small muted lx-option-help' }, 'Sometimes both notes are exactly the same. Then the answer is "Same".'),
        );
      },
      onOpen: () => stopSound(),
      returnFocus: () => primary(),
    });

    // Options rule: before answering -> new question now; after answering -> from the next question.
    function optionsChanged() {
      options.update();
      if (state === 'ready' || state === 'presenting') {
        stopSound();
        newQuestion();
      } else if (state === 'answering') {
        stopSound();
        newQuestion();
        flash('New question with your new settings');
      } else {
        options.setPending(true);
      }
    }

    // ---------- Helpers ----------
    function syncStatus() {
      status.classList.remove('is-error');
      if (state === 'ready') status.textContent = 'Press Play, then answer.';
      else if (state === 'presenting') status.textContent = 'Listen to the end…';
      else if (state === 'answering') status.textContent = allowSame ? 'Higher, lower or the same?' : 'Higher or lower?';
      else status.textContent = '';
    }
    let flashTimer = 0;
    function flash(text) {
      flashLine.textContent = text;
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { flashLine.textContent = ''; }, 3000);
    }

    function stopSound() {
      lxStopSound(player);
      if (compare && compare.playing) compare.setPlaying(false);
      if (state === 'presenting' && !gatePassed) {
        clearTimeout(gateTimer);
        state = 'ready';
        sync();
      }
    }

    function primary() { return state === 'feedback' ? next.element : playBtn.element; }
    function focusPrimary() {
      const p = primary();
      if (p && p.isConnected && !p.disabled) p.focus({ preventScroll: true });
    }

    function legendText() {
      const single = singleKeysEnabled();
      if (state === 'ready') return 'Space or Enter: play';
      if (state === 'presenting') return 'Esc: stop';
      if (state === 'answering') {
        return ['↑ higher', '↓ lower', allowSame && single ? '= same' : null, single ? 'R play again' : null]
          .filter(Boolean).join(' · ');
      }
      const compareKeys = question && question.direction === 'same' ? 'R: play again' : '1 / 2: as played / both the same';
      return ['Enter: next', single ? compareKeys : null, 'Space: play / stop', 'Esc: stop'].filter(Boolean).join(' · ');
    }

    function sync() {
      lxLockAnswers(Object.values(answerBtns), state);
      answers.classList.toggle('is-locked', state === 'presenting');
      sameBtn.hidden = !(allowSame || (question && question.direction === 'same'));
      compareArea.hidden = state !== 'feedback';
      if (!stopProgress) playBtn.setLabel(gatePassed || state === 'presenting' ? 'Play again' : 'Play');
      if (placer) placer.place(state === 'feedback' ? next.element : playBtn.element, { atTop: state !== 'feedback' });
      legend.set(legendText());
      syncStatus();
    }

    // ---------- Sound ----------
    function sequenceStep(tag, freqs) {
      return {
        tag,
        start: () => {
          const h = engine.playSequence(freqs, { noteDuration: NOTE_SECONDS, gap: GAP_SECONDS, timbre: timbre() });
          trackHighlights(h, PLAN, lightUp);
          const lead = lxLeadSeconds(h);
          if (tag === 'question') {
            if (stopProgress) stopProgress();
            stopProgress = playProgress(playBtn.element, SEQUENCE_MS + lead * 1000);
            if (!gatePassed) {
              clearTimeout(gateTimer);
              gateTimer = setTimeout(openGate, lead * 1000 + GATE_MS);
            }
          }
          return h;
        },
      };
    }

    function playQuestion() {
      if (state === 'feedback') {
        if (compare) lxCompareSelect(compare, 'played');
        else if (replay) replay.play();
        return;
      }
      if (!gatePassed) state = 'presenting';
      sync();
      player.play([sequenceStep('question', [question.firstFreq, question.secondFreq])]);
      reveal(pair, answers, actionBar.element);
    }

    function openGate() {
      if (state !== 'presenting') return;
      gatePassed = true;
      state = 'answering';
      sync();
    }

    function playCompare(value) {
      const same = value === 'same';
      if (lastDesc) markers[1].cap.textContent = same ? `the same (${lastDesc.first})` : lastDesc.relation;
      compareStarting = true;
      player.play([sequenceStep(`compare-${value}`, [question.firstFreq, same ? question.firstFreq : question.secondFreq])]);
    }

    // ---------- Flow ----------
    function newQuestion() {
      clearTimeout(gateTimer);
      if (cancelLevelAnim) { cancelLevelAnim(); cancelLevelAnim = null; }
      question = hl.makeQuestion({ cents: staircase.level(), voicePart: voiceArg(), allowSame });
      state = 'ready';
      gatePassed = false;
      lastDesc = null;
      options.setPending(false);
      for (const b of Object.values(answerBtns)) lxUnmark(b);
      feedback.clear();
      lxStageReveal(stage, false);
      markers[0].cap.textContent = 'First note';
      markers[1].cap.textContent = 'Second note';
      if (compare) { const c = compare; compare = null; c.destroy(); }
      replay = null;
      compareHolder.replaceChildren();
      tip.hide();
      level.update(question.cents, safeStats());
      sync();
    }

    function nextQuestion(autoplay) {
      newQuestion();
      if (autoplay) {
        playQuestion();
        playBtn.element.focus({ preventScroll: true });
      }
      reveal(screen.querySelector('.screen-head'), pair, actionBar.element);
    }

    function onNext() {
      const shown = summary.maybeShow(summarySlot, {
        onKeepGoing: () => nextQuestion(true),
        onDone: () => { window.location.hash = '#/stats'; },
      });
      if (!shown) nextQuestion(true);
    }

    function detailFor(answerKey) {
      try { return hl.answerDetail(question, answerKey); } catch (err) { console.error(err); }
      return { midi: null, direction: question.direction, answer: answerKey, cents: question.cents };
    }

    function answer(direction) {
      if (state === 'presenting') { flash('Listen to the end…'); return; }
      if (state !== 'answering') return;
      if (direction === 'same' && sameBtn.hidden) return;
      state = 'feedback';
      clearTimeout(gateTimer);
      const result = hl.checkAnswer(question, direction);
      const lvl = lxLevelOf(result);
      const fromLevel = staircase.level();
      const rec = progress.recordResult(KEY, staircase, { correct: result.correct, detail: detailFor(direction) });

      // 0 ms: button states.
      const chosen = answerBtns[direction];
      const right = answerBtns[question.direction];
      if (right) lxMark(right, { right: true, chosen: chosen === right });
      if (chosen !== right) lxMark(chosen, { chosen: true, level: lvl });

      // Note names: "First note A3 · Second note 15 cents higher" (captions under the markers).
      let namesText = '';
      try {
        const d = hl.describe(question);
        if (d && d.first) {
          lastDesc = { first: d.first, relation: d.relation || '' };
          markers[0].cap.textContent = d.first;
          markers[1].cap.textContent = lastDesc.relation;
          namesText = `First note ${d.first} · Second note ${lastDesc.relation}`;
        }
      } catch (err) { console.error(err); }

      const note = rec ? lxLevelNote(KEY, rec.direction) : '';
      feedback.show({
        level: lvl,
        message: result.message,
        detail: [
          namesText ? el('p', { class: 'visually-hidden' }, `${namesText}.`) : null,
          note ? el('p', { class: 'feedback-note' }, note) : null,
        ].filter(Boolean),
      });

      buildCompare();
      const levelNow = rec ? rec.level : staircase.level();
      summary.record({ correct: result.correct, levelCents: levelNow });
      cancelLevelAnim = lxUpdateLevel(level, {
        from: fromLevel, to: levelNow, stats: rec ? rec.stats : safeStats(),
        direction: rec && rec.moved !== false ? rec.direction : null,
      });
      progressPanel.update();
      const streak = rec && rec.stats && Number.isFinite(rec.stats.missStreak) ? rec.stats.missStreak : null;
      missStreak = streak != null ? streak : (result.correct ? 0 : missStreak + 1);
      maybeTip();
      sync();
      lxStageReveal(stage);
      next.focusAfterFeedback(feedback.id, compareArea);
    }

    function buildCompare() {
      const same = question.direction === 'same';
      if (same) {
        // Nothing to compare: one "Play again" button instead of a one-option switch.
        replay = lxReplayButton({ onPlay: () => playCompare('played'), onStop: () => lxStopSound(player) });
        compareHolder.replaceChildren(replay.element);
      } else {
        compare = createCompareSwitch({
          label: 'Compare the two notes',
          options: [{ value: 'played', label: 'As played', key: '1' }, { value: 'same', label: 'Both the same', key: '2' }],
          onChange: (value) => playCompare(value),
          onStop: () => lxStopSound(player),
        });
        compareHolder.replaceChildren(compare.element);
      }
      compareNote.textContent = same
        ? 'Both notes were exactly the same. Play them again to hear no difference.'
        : 'Switch between "As played" and "Both the same" to hear the difference.';
      lxCompareNoteSeen(KEY, compareNote);
    }

    function maybeTip() {
      if (!lxShouldTip(KEY, missStreak)) return;
      tip.set({
        actions: [
          {
            label: 'Make it easier',
            onClick: () => {
              const s = lxMakeEasier(KEY);
              if (s) {
                staircase = s;
                missStreak = 0;
                if (cancelLevelAnim) { cancelLevelAnim(); cancelLevelAnim = null; }
                level.update(staircase.level(), safeStats());
                flash('Next difference: a little bigger.');
              }
              next.element.focus({ preventScroll: true });
            },
          },
          { label: 'Not now', onClick: () => { next.element.focus({ preventScroll: true }); } },
        ],
      });
      tip.show();
    }

    function safeStats() {
      try { return progress.getStats(KEY); } catch (err) { console.error(err); return null; }
    }

    const progressPanel = chapterProgressPanel(KEY, {
      onReset: () => {
        stopSound();
        staircase = progress.loadStaircase(KEY);
        newQuestion();
      },
    });

    // ---------- Keyboard (the compare switch handles 1 / 2 and Space itself in Feedback) ----------
    const answerKey = (dir) => {
      if (state !== 'answering' && state !== 'presenting') return false;
      if (dir === 'same' && sameBtn.hidden) return false;
      answer(dir);
      return true;
    };
    const removeShortcuts = installShortcuts({
      ArrowUp: () => answerKey('sharp'),
      ArrowDown: () => answerKey('flat'),
      '=': () => answerKey('same'),
      s: () => answerKey('same'),
      ' ': () => {
        if (pause.isShown || (state === 'feedback' && !replay)) return false;
        if (state === 'feedback') replay.toggle();
        else playQuestion();
        return true;
      },
      Enter: () => {
        if (pause.isShown) return false;
        if (state === 'feedback') next.trigger();
        else playQuestion();
        return true;
      },
      r: () => {
        if (pause.isShown) return false;
        playQuestion();
        return true;
      },
    }, {});
    // Esc: stop the sound (the options panel and the compare switch handle their own Esc first).
    const removeEscape = onEscape(() => {
      if (!player.playing && state !== 'presenting') return false;
      stopSound();
      return true;
    });

    // ---------- Paused ----------
    const pause = lxPause({
      isBusy: () => player.playing || state === 'presenting',
      onHide: () => stopSound(),
      onContinue: () => focusPrimary(),
    });

    // ---------- Layout ----------
    const stage = el('div', { class: 'stage lx-stage' },
      pause.element,
      pair,
      status,
      answers,
      flashLine,
      feedback.element,
      compareArea,
      tip.element,
      summarySlot,
      actionBar.element,
      legend.element,
    );
    const screen = el('section', { class: 'screen exercise lx-screen lx-hl' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Higher / lower', headLevel),
          lxTaskLine('Two notes. Is the second one higher, lower — or exactly the same?',
            'Is the second note higher, lower or the same?'),
        ),
        level.element,
      ),
      options.element,
      stage,
      helpBox({ summary: 'How it works' },
        el('p', {}, 'You hear one note, then the same note again, a tiny bit higher or lower. Say which way it moved.'),
        el('p', {}, 'With "Sometimes no difference" on, both notes are sometimes exactly the same. Then the answer is "Same".'),
        el('p', {}, 'The difference is measured in cents: 100 cents = one semitone. A right answer makes the next difference smaller; a miss makes it bigger.'),
        el('p', {}, 'After answering, switch between "As played" and "Both the same" to hear the difference.'),
        el('p', { class: 'muted small' }, 'Keys: Space or Enter = play, ↑ = higher, ↓ = lower, = = same, R = play again. After answering: Enter = next, 1 / 2 = compare, Space = play / stop, Esc = stop.'),
      ),
      progressPanel.element,
    );

    placer = lxPrimaryPlacer(actionBar, { top: pair, bottom: legend.element, onChange: () => sync() });
    const unwatchKeys = lxWatchSingleKeys(screen, () => legend.set(legendText()));
    const unmirrorLevel = lxInlineLevel(level, headLevel);
    newQuestion();
    container.append(screen);
    // Keyboard: after a mouse change of an option go back to Play / Next; after comparing, to Next.
    const removeRefocus = refocusAfterPointerChange(screen, primary);
    refocusAfterClick(compareArea, () => next.element);

    return () => {
      clearTimeout(gateTimer);
      clearTimeout(flashTimer);
      if (cancelLevelAnim) cancelLevelAnim();
      if (compare) { const c = compare; compare = null; c.destroy(); }
      if (resolveBusy) resolveBusy();
      removeRefocus();
      removeShortcuts();
      removeEscape();
      pause.destroy();
      placer.destroy();
      unwatchKeys();
      unmirrorLevel();
      player.destroy();
    };
  },
};
