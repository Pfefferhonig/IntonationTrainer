// "Lock it in" (#/tune): two modes (interval training / in a chord). The fixed notes
// sound; the singer brings in their own note by moving the slider in its row of the
// little score, tunes it, then compares their version with pure and piano.
//
// Interaction model (docs/reviews/INTERACTION-DESIGN.md): Ready → Tuning{silent → on} → Feedback
// {Idle ⇄ Comparing}; Paused when the page is hidden or the sound is interrupted.
// The slider is relative: pressing never moves the note (the first press only brings it in),
// dragging moves it by the distance dragged.

// Namespace imports: newer exports are feature-checked.
import * as tuneIt from '../exercise/tune-it.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import { INTERVALS, centsBetween, shiftByCents } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, centsText, roundCentsValue } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented, helpBox, kbd, refocusAfterPointerChange } from '../ui/components.js';
import { createPlayButton } from '../ui/exercise.js';
import { createPlayer, needsLoading, ensureTimbre } from '../ui/player.js';
import { createProgressPanel } from '../ui/progress-panel.js';
import { safeRank, safeInsights } from '../ui/chapter-progress.js';
import { trackHighlights } from '../ui/highlight.js';
import { voiceArg } from '../ui/voices.js';
import { groupOf, shortTaskLabel, taskChips } from '../ui/task-labels.js';
import {
  optionsSummary, actionBar, feedbackPanel, nextControl, compareSwitch, keyLegend, tipCard, sessionSummary,
  onPageHidden, pausedCard, onEscape, installScreenKeys, levelOf, rankTexts,
  stopAllSound, tuningLink, tuningWord, focusAndReveal, fitVisible, tryAgainButton, longShort, exerciseHead,
} from '../ui/sing-common.js';

const {
  TUNE_TASKS, TUNE_IT_KEY, makeQuestion, evaluate, recordTuneResult, getTuneStats,
} = tuneIt;

const COMPARE_MAX_SECONDS = 8;
const NOTE_SECONDS = 1.6; // a fixed note heard alone
const NUDGES = [-5, -1, 1, 5];
const TENDENCY_MIN = Number.isFinite(tuneIt.TUNE_TENDENCY_MIN_CENTS) ? tuneIt.TUNE_TENDENCY_MIN_CENTS : 4;
const TASK_RANK_MIN = Number.isFinite(progress.TUNE_IT_TASK_RANK_MIN_ATTEMPTS) ? progress.TUNE_IT_TASK_RANK_MIN_ATTEMPTS : 5;
// Relative drag: cents per pixel dragged (mouse / touch / with Shift or Alt for fine moves).
const GAIN_MOUSE = 0.35;
const GAIN_TOUCH = 0.6;
const GAIN_FINE = 0.1;
// Fine-tune buttons: press and hold repeats.
const REPEAT_DELAY = 400;
const REPEAT_EVERY = 80;
const REPEAT_FAST = 40;
const REPEAT_FAST_AFTER = 1500;

const MODES = [
  { value: 'interval', label: 'Interval training' },
  { value: 'chord', label: 'In a chord' },
];
/** 'interval' | 'chord' — from the logic's `group`, else one fixed note = interval. */
const tasksOf = (mode) => TUNE_TASKS.filter((t) => groupOf(t) === mode);
const taskOf = (key) => TUNE_TASKS.find((t) => t.key === key) || null;

/** Does makeQuestion understand `motion: 'down'` (descending intervals)? */
const MOTION_SUPPORTED = (() => {
  const t = TUNE_TASKS.find((x) => groupOf(x) === 'interval');
  if (!t) return false;
  try {
    return makeQuestion({ taskKey: t.key, motion: 'down' }).motion === 'down';
  } catch {
    return false;
  }
})();

const MOTION_OPTIONS = [
  { value: 'up', label: 'Ascending' },
  { value: 'down', label: 'Descending' },
  { value: 'mixed', label: 'Both' },
];
const MOTION_WORDS = { up: 'ascending', down: 'descending', mixed: 'both directions' };

/** The task's description, turned round for descending intervals (you tune the lower note). */
function taskDescription(task, motion) {
  if (motion !== 'down') return task.description;
  const interval = INTERVALS[task.target];
  const name = interval ? interval.name.toLowerCase() : 'interval';
  const article = /^[aeiou]/.test(name) ? 'an' : 'a';
  return `The upper note is fixed. Tune the lower note so it sits exactly ${article} ${name} below it.`;
}

/** Per-task rank (or null when not available / not ranked yet). */
function taskRank(stats, taskKey) {
  if (typeof progress.getRank !== 'function') return null;
  try {
    const r = progress.getRank(TUNE_IT_KEY, stats, { taskKey });
    return r && r.basis ? r : null;
  } catch (err) {
    console.error(err);
    return null;
  }
}

/** An easier task to suggest after three tricky rounds (logic's EASIER_TASKS, else a local guess; null = none). */
function easierTaskFor(key) {
  if (progress.EASIER_TASKS && Object.prototype.hasOwnProperty.call(progress.EASIER_TASKS, key)) {
    return progress.EASIER_TASKS[key] ? taskOf(progress.EASIER_TASKS[key]) : null;
  }
  const t = taskOf(key);
  const k = t ? easierTask(key, groupOf(t)) : null;
  return k ? taskOf(k) : null;
}
const MISS_TIP = Number.isFinite(progress.MISS_STREAK_TIP) ? progress.MISS_STREAK_TIP : 3;

function easierTask(key, mode) {
  const has = (k) => tasksOf(mode).some((t) => t.key === k);
  const order = mode === 'interval' ? ['octave', 'fifth', 'fourth'] : ['fifth-in-major', 'third-in-major'];
  const i = order.indexOf(key);
  const pick = i === 0 ? null : order.slice(0, i < 0 ? order.length : i).reverse().find(has) || null;
  return pick === key ? null : pick;
}

// ---------- Result scale: your note against the pure and the piano note (static) ----------
function resultScale(question, playedFreq) {
  // Positions in cents on a pitch axis (lower .. higher), relative to the pure note —
  // works for ascending and descending intervals alike.
  const pianoPos = centsBetween(question.target.justFreq, question.target.equalFreq);
  const youPos = centsBetween(question.target.justFreq, playedFreq);
  const same = Math.abs(pianoPos) <= 3;
  const extent = Math.max(15, Math.abs(youPos) + 6, Math.abs(pianoPos) + 6);
  const W = 520;
  const H = 104;
  const pad = 26;
  const x = (c) => pad + ((c + extent) / (2 * extent)) * (W - 2 * pad);
  const NS = 'http://www.w3.org/2000/svg';
  const s = (tag, attrs, text) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    if (text != null) n.textContent = text;
    return n;
  };
  const above = (c) => (c > 0 ? 'above' : 'below');
  const rel = (c, name) => (!roundCentsValue(c) ? `right on ${name}` : `${centsText(Math.abs(c))} ${above(c)} ${name}`);
  const summary = same
    ? `Your note: ${rel(youPos, 'the in-tune note')}.`
    : `Your note: ${rel(youPos, 'pure')}, ${rel(youPos - pianoPos, 'piano')}.`;

  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, class: 'result-scale', role: 'img', 'aria-label': summary });
  svg.append(
    s('line', { x1: pad, x2: W - pad, y1: 46, y2: 46, class: 'scale-axis' }),
    s('text', { x: pad, y: 100, class: 'scale-end', 'text-anchor': 'start' }, 'lower'),
    s('text', { x: W - pad, y: 100, class: 'scale-end', 'text-anchor': 'end' }, 'higher'),
  );
  const mark = (c, label, cls, anchorShift = 0) => {
    svg.append(
      s('line', { x1: x(c), x2: x(c), y1: 34, y2: 58, class: `scale-mark ${cls}` }),
      s('text', { x: x(c) + anchorShift, y: 26, class: 'scale-label', 'text-anchor': 'middle' }, label),
    );
  };
  if (same) {
    mark(0, 'in tune', 'is-pure');
  } else {
    // Nudge the labels apart if the marks are close together.
    const gap = Math.abs(x(pianoPos) - x(0));
    const shift = gap < 56 ? (56 - gap) / 2 : 0;
    const dir = pianoPos > 0 ? 1 : -1;
    mark(0, 'pure', 'is-pure', -dir * shift);
    mark(pianoPos, 'piano', 'is-piano', dir * shift);
  }
  svg.append(
    s('circle', { cx: x(youPos), cy: 46, r: 7, class: 'scale-you' }),
    s('text', { x: x(youPos), y: 74, class: 'scale-label scale-you-label', 'text-anchor': 'middle' }, 'you'),
  );
  return el('figure', { class: 'result-figure' }, svg, el('figcaption', { class: 'small muted' }, summary));
}

export default {
  id: 'tune',
  title: 'Lock it in',

  render(container) {
    if (typeof engine.startSustain !== 'function') {
      container.append(el('section', { class: 'screen soon' },
        el('div', { class: 'soon-icon' }, icon('sliders-horizontal', { size: 32 })),
        el('h1', {}, 'Lock it in'),
        el('p', { class: 'task' }, 'This exercise needs an app update. Reload the page to get it.'),
      ));
      return undefined;
    }

    // ---------- Mode + task (remembered; last task per mode) ----------
    const legacyTask = taskOf(getPref('tune.task', null));
    let mode = getPref('tune.mode', null);
    if (!MODES.some((m) => m.value === mode)) mode = legacyTask ? groupOf(legacyTask) : 'interval';
    if (!tasksOf(mode).length) mode = MODES.find((m) => tasksOf(m.value).length).value;
    function savedTask(m) {
      const k = getPref(`tune.task.${m}`, null);
      if (tasksOf(m).some((t) => t.key === k)) return k;
      if (legacyTask && groupOf(legacyTask) === m) return legacyTask.key;
      // Newcomers start on the easiest interval (the octave), not the first in size order.
      if (m === 'interval' && tasksOf(m).some((t) => t.key === 'octave')) return 'octave';
      return tasksOf(m)[0].key;
    }
    let taskKey = savedTask(mode);
    let motionPref = getPref('tune.motion', 'up');
    if (!MOTION_OPTIONS.some((o) => o.value === motionPref)) motionPref = 'up';

    let question = null;
    let result = null;
    let state = 'ready';      // 'ready' | 'tuning' | 'answered'
    let paused = false;       // "Paused while you were away" is showing
    let currentFreq = 0;
    let sustain = null;       // the held notes while tuning
    let compareHold = null;   // the held comparison sound after answering
    let compareToken = 0;
    let canMute = true;       // engine supports silent start + setMuted (checked on start)
    let targetOn = false;     // the user has brought in their note (first touch)
    let fixedOnly = false;    // "Hear the fixed notes alone"
    let destroyed = false;
    let startToken = 0;
    let rows = [];            // [{ idx, fixed, row, nameEl }] top row first; idx = sustain index
    let compareLit = null;    // stop function of a single-note highlight
    let soundWasOn = false;   // sound state when the options opened
    let optionsChanged = false;
    let inertUntil = 0;       // primary actions ignore presses right after a state change
    const lowStreak = new Map(); // taskKey -> rounds in a row below "close" (this visit)
    const tipShown = new Set();
    const targetIndex = () => question.fixedTones.length;
    const guard = (ms = 400) => { inertUntil = performance.now() + ms; };
    const inert = () => performance.now() < inertUntil;

    // ---------- Status line ----------
    const statusLine = el('p', { class: 'stage-status', role: 'status' });
    let statusTimer = 0;
    function setStatus(text, kind = '', ms = 0) {
      clearTimeout(statusTimer);
      statusLine.textContent = text || '';
      statusLine.classList.toggle('is-error', kind === 'error');
      statusLine.classList.toggle('is-warn', kind === 'warn');
      if (ms && text) statusTimer = setTimeout(() => setStatus(''), ms);
    }

    // Single fixed notes (note head buttons).
    const player = createPlayer({
      onChange: (s) => {
        if (s.error) setStatus(s.error, 'warn');
        else if (s.loading) setStatus('Loading sound…');
        else if (statusLine.textContent === 'Loading sound…') setStatus('');
      },
    });

    // Note heads light up while their note sounds.
    function lightUp(keys) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keys.has(r.idx));
    }
    function lightSustain() {
      if (compareLit) return; // a single note is showing its own highlight
      const on = new Set();
      if (sustain || compareHold) {
        question.fixedTones.forEach((t, i) => on.add(i));
        if (compareHold || !targetSilent()) on.add(targetIndex());
      }
      lightUp(on);
    }

    function stopSustain() {
      startToken += 1;
      if (sustain) {
        const h = sustain;
        sustain = null;
        try { h.stop(); } catch (err) { console.error(err); }
      }
      syncTuningUi();
    }

    const targetSilent = () => !targetOn || fixedOnly;

    async function soundReady() {
      const ready = engine.initAudio(); // inside the user gesture
      try {
        await ready;
        const s = getSettings();
        engine.setMasterVolume(s.volume);
        if (typeof engine.setReverb === 'function') engine.setReverb(s.reverb);
      } catch (err) {
        console.error(err);
        setStatus("Sound can't start in this browser. Reload the page.", 'warn');
        return false;
      }
      const timbre = getSettings().timbre;
      if (needsLoading(timbre)) {
        setStatus('Loading sound…');
        const ok = await ensureTimbre(timbre);
        if (!ok) { setStatus("This sound didn't load. Choose another sound in Settings.", 'warn'); return false; }
        setStatus('');
      }
      return true;
    }

    // Start (or restart) the held notes. Call from a click / key press.
    async function startSound() {
      player.stop();
      stopCompare();
      stopSustain();
      const mine = startToken;
      if (!(await soundReady())) return;
      if (mine !== startToken || destroyed || state !== 'tuning' || paused) return;
      const timbre = getSettings().timbre;
      const freqs = [...question.fixedTones.map((t) => t.freq), currentFreq];
      const silent = targetSilent();
      let h = engine.startSustain(freqs, { timbre, muted: silent ? [targetIndex()] : [] });
      if (h && typeof h.setMuted !== 'function') {
        // Older engine: no silent start — the note sounds right away.
        canMute = false;
        targetOn = true;
        if (fixedOnly) {
          try { h.stop(); } catch { /* ignore */ }
          h = engine.startSustain(freqs.slice(0, targetIndex()), { timbre });
        }
      }
      sustain = h;
      const ended = () => { if (sustain === h) { sustain = null; syncTuningUi(); } };
      if (h && typeof h.onEnd === 'function') h.onEnd(ended);
      else if (h && h.done) h.done.then(ended);
      syncTuningUi();
    }

    function applyMute() {
      if (!sustain) return;
      if (canMute) {
        try { sustain.setMuted(targetIndex(), targetSilent()); } catch (err) { console.error(err); }
        syncTuningUi();
      } else {
        startSound(); // fallback: restart with / without the moving note
      }
    }

    // The first touch of the slider, a fine-tune button or an arrow key brings the note in
    // (at the pitch where it is — the first press never moves it).
    function touch() {
      if (state !== 'tuning' || targetOn) return;
      targetOn = true;
      if (!sustain) startSound();
      else if (!fixedOnly) applyMute();
      syncTuningUi();
    }

    // ---------- The slider (relative drag; position in cents from the slider's low end) ----------
    let range = 240;
    let pos = 120;
    const thumb = el('span', { class: 'pc-slider-thumb' });
    const fill = el('span', { class: 'pc-slider-track' }, thumb);
    const slider = el('div', {
      class: 'pc-slider',
      role: 'slider',
      tabindex: '0',
      'aria-label': 'Your note',
      'aria-orientation': 'horizontal',
      'aria-valuemin': '0',
    }, fill);
    const endLow = el('span', { class: 'slider-end pc-end', 'aria-hidden': 'true' }, 'lower');
    const endHigh = el('span', { class: 'slider-end pc-end', 'aria-hidden': 'true' }, 'higher');
    let flashTimer = 0;
    let vibrated = false;
    function flashEnd(which) {
      const node = which < 0 ? endLow : endHigh;
      node.classList.add('is-flash');
      clearTimeout(flashTimer);
      flashTimer = setTimeout(() => { endLow.classList.remove('is-flash'); endHigh.classList.remove('is-flash'); }, 150);
      if (!vibrated && navigator.vibrate && /Android/i.test(navigator.userAgent)) {
        vibrated = true;
        try { navigator.vibrate(8); } catch { /* ignore */ }
      }
    }
    function paintSlider() {
      thumb.style.left = `${((pos / range) * 100).toFixed(2)}%`;
      const n = Math.round(pos);
      slider.setAttribute('aria-valuemax', String(Math.round(range)));
      slider.setAttribute('aria-valuenow', String(n));
      slider.setAttribute('aria-valuetext', `position ${n} of ${Math.round(range)}`);
    }
    /** Move to a new position (clamped). Returns false when it hit an end. */
    function setPos(p) {
      const clamped = Math.min(range, Math.max(0, p));
      const hit = clamped !== p;
      if (hit) flashEnd(p < 0 ? -1 : 1);
      pos = clamped;
      currentFreq = shiftByCents(question.slider.minFreq, pos);
      paintSlider();
      if (sustain && (canMute || !fixedOnly)) {
        try { sustain.setFreq(targetIndex(), currentFreq); } catch (err) { console.error(err); }
      }
      return !hit;
    }
    const nudge = (c) => {
      if (state !== 'tuning') return;
      const wasOn = targetOn;
      touch();
      // The very first touch only brings the note in (never moves it).
      if (wasOn) setPos(pos + c);
    };

    let drag = null; // { id, lastX }
    slider.addEventListener('pointerdown', (e) => {
      if (state !== 'tuning' || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      try { slider.setPointerCapture(e.pointerId); } catch { /* ignore */ }
      drag = { id: e.pointerId, lastX: e.clientX, gain: e.pointerType === 'touch' || e.pointerType === 'pen' ? GAIN_TOUCH : GAIN_MOUSE };
      slider.classList.add('is-dragging');
      try { slider.focus({ preventScroll: true }); } catch { /* ignore */ }
      touch(); // first press: the note comes in where it is
    });
    slider.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id || state !== 'tuning') return;
      const dx = e.clientX - drag.lastX;
      drag.lastX = e.clientX;
      if (!dx) return;
      setPos(pos + dx * (e.shiftKey || e.altKey ? GAIN_FINE : drag.gain));
    });
    const endDrag = () => { drag = null; slider.classList.remove('is-dragging'); };
    slider.addEventListener('pointerup', endDrag);
    slider.addEventListener('pointercancel', endDrag);
    slider.addEventListener('lostpointercapture', endDrag);
    slider.addEventListener('keydown', (e) => {
      if (e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.key === 'Enter') {
        e.preventDefault();
        if (!e.repeat) answer();
        return;
      }
      if (e.key === 'Home' || e.key === 'End') { e.preventDefault(); return; } // no jumps to the ends
      if (e.key === ' ') {
        e.preventDefault();
        if (!e.repeat && state === 'tuning') { if (sustain) stopSustain(); else startSound(); }
        return;
      }
      const step = {
        ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1, PageUp: 10, PageDown: -10,
      }[e.key];
      if (!step) return;
      e.preventDefault();
      nudge(Math.abs(step) === 1 && e.shiftKey ? step * 5 : step);
    });

    // Fine-tune buttons: one step per press; press and hold repeats.
    const nudgeBtns = NUDGES.map((c) => {
      const n = Math.abs(c);
      const b = el('button', {
        type: 'button',
        class: 'btn btn-small btn-nudge',
        'aria-label': `${c > 0 ? '+' : '−'}${n} ${n === 1 ? 'cent' : 'cents'} (${c > 0 ? 'higher' : 'lower'})`,
      }, c > 0 ? `+${c}` : `−${n}`);
      let timer = 0;
      let t0 = 0;
      let byPointer = false;
      const stop = () => { clearTimeout(timer); timer = 0; };
      const repeat = () => {
        if (state !== 'tuning' || b.disabled) { stop(); return; }
        nudge(c);
        timer = setTimeout(repeat, performance.now() - t0 > REPEAT_FAST_AFTER ? REPEAT_FAST : REPEAT_EVERY);
      };
      b.addEventListener('pointerdown', (e) => {
        if (e.button !== undefined && e.button !== 0) return;
        byPointer = true;
        t0 = performance.now();
        nudge(c);
        stop();
        timer = setTimeout(repeat, REPEAT_DELAY);
      });
      for (const ev of ['pointerup', 'pointerleave', 'pointercancel', 'blur']) b.addEventListener(ev, stop);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
      b.addEventListener('click', (e) => {
        if (byPointer && e.detail !== 0) { byPointer = false; return; } // already nudged on press
        byPointer = false;
        nudge(c);
      });
      return b;
    });
    const nudgeRow = el('div', { class: 'nudge-row tscore-nudge', role: 'group', 'aria-label': 'Fine tune' }, nudgeBtns);
    const yourResult = el('strong', { class: 'pc-your-result' });
    const sliderWrap = el('div', { class: 'slider-wrap tscore-slider pc-slider-wrap' }, endLow, slider, endHigh, yourResult);

    // ---------- Sound toggle + fixed notes alone ----------
    const soundBtn = el('button', {
      type: 'button',
      class: 'btn btn-small pc-sound-toggle',
      'aria-pressed': 'false',
      onclick: () => (sustain ? stopSustain() : startSound()),
    });
    const fixedBtn = el('button', {
      type: 'button',
      class: 'btn btn-small',
      'aria-pressed': 'false',
      onclick: () => {
        fixedOnly = !fixedOnly;
        if (sustain) applyMute(); else startSound();
        syncTuningUi();
      },
    });
    const soundRow = el('div', { class: 'btn-row sound-row' }, soundBtn, fixedBtn);

    const touchHintText = el('span', {});
    const touchHint = el('p', { class: 'silent-hint', role: 'status' },
      el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }), touchHintText);

    const score = el('div', { class: 'score tscore', role: 'group', 'aria-label': 'The notes: fixed notes and your note' });

    // A fixed note alone (stops the held notes; "Sound" brings them back).
    function playFixed(i) {
      stopSustain();
      stopCompare();
      player.play([{
        tag: `fixed-${i}`,
        start: () => {
          const h = engine.playTone(question.fixedTones[i].freq, { duration: NOTE_SECONDS, timbre: getSettings().timbre });
          if (compareLit) compareLit();
          const stop = trackHighlights(h, [{ key: i, start: 0, end: NOTE_SECONDS }], lightUp);
          compareLit = () => { compareLit = null; stop(); };
          if (h && h.done) h.done.then(() => { if (compareLit) { compareLit = null; lightSustain(); } });
          return h;
        },
      }]);
    }

    // ---------- Score: one row per tone, highest on top ----------
    function buildScore() {
      // Ordered by actual pitch (highest on top), so descending intervals put your note at the bottom.
      const tones = [
        ...question.fixedTones.map((t, i) => ({ label: t.label, freq: t.freq, idx: i, fixed: true })),
        { label: question.target.label, freq: question.target.targetFreq, idx: targetIndex(), fixed: false },
      ].sort((a, b) => b.freq - a.freq);
      rows = tones.map((t) => {
        const name = t.label.toLowerCase();
        // Note name, filled in only after answering (nothing gives the answer away before).
        const nameEl = t.fixed ? el('span', { class: 'tscore-name' }) : yourResult;
        const head = t.fixed
          ? el('button', {
            type: 'button',
            class: 'score-head-btn',
            'aria-label': `Hear the ${name} alone`,
            title: `Hear the ${name} alone`,
            onclick: () => playFixed(t.idx),
          }, el('span', { class: 'score-head', 'aria-hidden': 'true' }), icon('volume-2', { size: 12, class: 'score-head-icon' }))
          : el('span', { class: 'score-head-btn is-static', 'aria-hidden': 'true' }, el('span', { class: 'score-head' }));
        const row = el('div', { class: `score-row tscore-row ${t.fixed ? 'is-fixed' : 'is-target'}` },
          el('div', { class: 'score-note' },
            el('span', { class: 'score-verdict' }, t.fixed ? 'fixed' : 'your note'),
            head,
            t.fixed ? icon('lock', { size: 18, class: 'tscore-lock', label: `${t.label}: fixed note` }) : null,
            el('span', { class: 'score-label' }, t.label),
          ),
          ...(t.fixed ? [nameEl] : [sliderWrap, nudgeRow]),
        );
        return { idx: t.idx, fixed: t.fixed, row, nameEl };
      });
      setChildren(score, rows.map((r) => r.row));
    }

    /** After answering: note names from describe(question, playedFreq) (spelled for the key). */
    function showNoteNames() {
      if (typeof tuneIt.describe !== 'function') return;
      let desc = null;
      try { desc = tuneIt.describe(question, currentFreq); } catch (err) { console.error(err); return; }
      if (!desc) return;
      const tones = Array.isArray(desc.tones) ? desc.tones : null;
      for (const r of rows) {
        if (!r.fixed) continue;
        const t = tones ? tones[r.idx] : null;
        r.nameEl.textContent = t ? t.name : '';
      }
      yourResult.textContent = desc.yourNote && desc.yourNote.text ? desc.yourNote.text : '';
    }

    function syncTuningUi() {
      const on = !!sustain;
      soundBtn.setAttribute('aria-pressed', String(on));
      setChildren(soundBtn, icon(on ? 'volume-2' : 'volume-x', { size: 18 }), on ? 'Sound on' : 'Sound off');
      soundBtn.title = on ? 'Stop the sound (Space)' : 'Play the sound (Space)';
      fixedBtn.setAttribute('aria-pressed', String(fixedOnly));
      setChildren(fixedBtn, fixedOnly
        ? [icon('play', { size: 16 }), longShort('Back to all notes', 'All notes')]
        : [icon('volume-2', { size: 16 }), longShort('Hear the fixed notes alone', 'Fixed notes alone')]);
      // Keep the space reserved (visibility, not display) so nothing jumps on the first touch.
      fixedBtn.style.visibility = targetOn ? '' : 'hidden';
      if (!question) return;
      const tuning = state === 'tuning';
      const answered = state === 'answered';
      slider.setAttribute('aria-disabled', String(!tuning));
      slider.tabIndex = tuning ? 0 : -1;
      slider.classList.toggle('is-disabled', !tuning);
      for (const b of nudgeBtns) b.disabled = !tuning;
      nudgeRow.hidden = answered;
      sliderWrap.classList.toggle('is-answered', answered);
      soundRow.hidden = !tuning;
      touchHint.hidden = !tuning;
      touchHint.classList.toggle('is-in', targetOn);
      setChildren(touchHintText, targetOn
        ? longShort('Your note is on — move it until the sound is calm', 'Your note is on — move until calm')
        : longShort('Move the slider (or press ← / →) to bring in your note', 'Move the slider to bring in your note'));
      doneBtn.disabled = !targetOn;
      doneNote.style.visibility = tuning && !targetOn ? '' : 'hidden';
      doneNote.hidden = !tuning;
      score.classList.toggle('is-silent-target', targetSilent());
      lightSustain();
      paintKeys();
    }

    // ---------- Primary actions ----------
    const startBtn = createPlayButton({ onClick: () => beginTuning(), label: 'Start', shortcut: 'Enter' });
    const doneBtn = el('button', { type: 'button', class: 'btn btn-primary btn-done', onclick: () => answer() },
      icon('check', { size: 20 }), "I'm in tune", kbd('Enter'));
    const doneNote = el('p', { class: 'small muted center done-note' }, '"I\'m in tune" unlocks once your note is on.');
    const tryAgainBtn = tryAgainButton(() => tryAgain());
    const next = nextControl(() => nextQuestion());
    const bar = actionBar();
    let barState = '';
    function paintBar() {
      if (barState === state) return;
      barState = state;
      if (state === 'ready') bar.set(startBtn.element);
      else if (state === 'tuning') bar.set(doneBtn);
      else bar.set(tryAgainBtn, next.element);
    }
    const keys = keyLegend();
    function paintKeys() {
      if (state === 'ready') keys.set('Enter start');
      else if (state === 'tuning') keys.set('← → tune (Shift ×5, Page Up/Down ×10) · Enter I\'m in tune · Space sound on/off · Esc stop sound');
      else keys.set(`${compareOptions().map((o) => o.key).join(' ')} compare · Space play/stop · Enter next`);
    }

    // ---------- After answering ----------
    const feedback = feedbackPanel();
    const scaleHolder = el('div', { class: 'scale-holder' });
    const resultRank = el('p', { class: 'task-rank-line' });
    const tipHolder = el('div', { class: 'pc-tip-holder' });
    const summary = sessionSummary({ every: 10, levelLabel: 'off by' });
    const summaryHolder = el('div', { class: 'pc-summary-holder' });

    // Compare: Your version | Pure | Piano (or Your version | In tune), one held sound retuned in place.
    function pureEqualsPiano() {
      const iv = INTERVALS[question.target.intervalKey];
      return Math.abs(iv.equalCents - iv.justCents) <= 3;
    }
    function compareOptions() {
      if (!question || pureEqualsPiano()) {
        return [{ value: 'yours', label: longShort('Your version', 'Yours'), key: '1' }, { value: 'pure', label: 'In tune', key: '2' }];
      }
      return [{ value: 'yours', label: longShort('Your version', 'Yours'), key: '1' }, { value: 'pure', label: 'Pure', key: '2' },
        { value: 'piano', label: 'Piano', key: '3' }];
    }
    const compareFreq = (v) => (v === 'pure' ? question.target.justFreq : v === 'piano' ? question.target.equalFreq : currentFreq);
    function stopCompare() {
      compareToken += 1;
      if (compareHold) {
        const h = compareHold;
        compareHold = null;
        try { h.stop(); } catch { /* ignore */ }
      }
      if (sw) sw.stop();
      lightSustain();
    }
    async function playCompare(v) {
      if (player.playing) player.stop(); // (stop() would also end the held comparison sound)
      if (compareLit) compareLit();
      const f = compareFreq(v);
      if (compareHold && (typeof compareHold.isPlaying !== 'function' || compareHold.isPlaying())) {
        try { compareHold.setFreq(targetIndex(), f, 0.025); } catch (err) { console.error(err); }
        return;
      }
      const mine = ++compareToken;
      if (!(await soundReady()) || mine !== compareToken || destroyed || state !== 'answered') return;
      const h = engine.startSustain([...question.fixedTones.map((t) => t.freq), f], { timbre: getSettings().timbre, maxDuration: COMPARE_MAX_SECONDS });
      compareHold = h;
      const ended = () => { if (compareHold === h) { compareHold = null; if (sw) sw.ended(); lightSustain(); } };
      if (h && typeof h.onEnd === 'function') h.onEnd(ended);
      else if (h && h.done) h.done.then(ended);
      lightSustain();
    }
    let sw = null;
    const compareHolder = el('div', { class: 'pc-compare-holder' });
    function buildCompare() {
      if (sw) sw.destroy();
      sw = compareSwitch({
        options: compareOptions(),
        label: 'Listen and compare',
        onChange: (v) => playCompare(v),
        onStop: () => stopCompare(),
      });
      setChildren(compareHolder, sw.element);
    }

    // A tuning tip (sevenths) sits under the compare switch, so the feedback stays two lines at most.
    const resultTip = el('p', { class: 'small muted pc-result-tip' });
    const after = el('div', { class: 'after-answer' }, compareHolder, resultTip, scaleHolder, tipHolder, resultRank, summaryHolder);

    // ---------- Options: mode, task, direction (folded into a summary line) ----------
    const pickerHolder = el('div', { class: 'task-picker' });
    let taskInputs = [];
    const taskBadges = new Map();
    const motionSeg = segmented({
      name: 'tune-motion',
      legend: 'Direction',
      compact: true,
      options: MOTION_OPTIONS,
      value: motionPref,
      onChange: (v) => {
        motionPref = v;
        setPref('tune.motion', v);
        optionChanged();
      },
    });
    const motionHolder = el('div', { class: 'motion-holder' }, motionSeg.element);
    const nextMotion = () => {
      if (!MOTION_SUPPORTED || mode !== 'interval') return 'up';
      if (motionPref === 'mixed') return Math.random() < 0.5 ? 'up' : 'down';
      return motionPref;
    };
    function buildPicker() {
      const picker = taskChips({
        tasks: tasksOf(mode),
        mode,
        value: taskKey,
        legend: mode === 'interval' ? 'Interval' : 'Note to tune',
        onChoose: (k) => chooseTask(k),
      });
      taskInputs = [...picker.inputs];
      taskBadges.clear();
      for (const [k, b] of picker.badges) taskBadges.set(k, b);
      setChildren(pickerHolder, picker.element);
      motionHolder.hidden = !(MOTION_SUPPORTED && mode === 'interval');
      renderBadges();
    }
    const modeSeg = segmented({
      name: 'tune-mode',
      legend: 'Mode',
      hideLegend: true,
      options: MODES.filter((m) => tasksOf(m.value).length),
      value: mode,
      onChange: (v) => {
        if (v === mode) return;
        mode = v;
        setPref('tune.mode', v);
        taskKey = savedTask(v);
        buildPicker();
        optionChanged();
        progressPanel.update();
      },
    });
    const tuningHolder = el('p', { class: 'pc-tuning-line small' });
    function chooseTask(key) {
      taskKey = key;
      setPref(`tune.task.${mode}`, key);
      optionChanged();
    }
    function summaryText() {
      const t = taskOf(taskKey);
      const parts = [t ? t.label : taskKey];
      if (MOTION_SUPPORTED && mode === 'interval') parts.push(MOTION_WORDS[motionPref] || 'ascending');
      parts.push(tuningWord(getSettings().tuning));
      return parts.join(' · ');
    }
    const opts = optionsSummary({
      title: 'Exercise',
      getSummary: summaryText,
      buildPanel: (panel) => panel.append(
        el('div', { class: 'mode-row' }, modeSeg.element),
        el('div', { class: 'options-row' }, pickerHolder, motionHolder),
        tuningHolder,
      ),
      onOpen: () => {
        soundWasOn = !!sustain;
        optionsChanged = false;
        player.stop();
        stopCompare();
        stopSustain();
      },
      onClose: () => {
        if (state === 'tuning' && soundWasOn && !optionsChanged) startSound();
      },
      returnFocus: () => mainAction(),
    });
    // The options rule (INTERACTION 10): before answering → a new round at once; after
    // answering → the result stays and the change applies from the next round.
    function optionChanged() {
      optionsChanged = true;
      player.stop();
      stopCompare();
      if (state === 'answered') {
        opts.setPending(true);
        opts.update();
        renderRanks();
        return;
      }
      const wasTuning = state === 'tuning';
      stopSustain();
      newQuestion();
      if (wasTuning) setStatus('New round with your new settings.', '', 3000);
    }
    function updateTuning(tuning) {
      setChildren(tuningHolder, 'Tuning: ', tuningLink(tuning));
      opts.update();
    }

    // ---------- Ranks: picker badges, top-right box, result line ----------
    const chip = el('div', { class: 'level' });
    const statsNow = () => { try { return getTuneStats(); } catch (err) { console.error(err); return null; } };
    function renderBadges(stats = statsNow()) {
      for (const [key, badge] of taskBadges) {
        const r = stats ? taskRank(stats, key) : null;
        badge.className = `task-rank${r ? '' : ' is-none'}`;
        if (r) badge.textContent = r.name;
        else setChildren(badge, el('span', { 'aria-hidden': 'true' }, '–'), el('span', { class: 'visually-hidden' }, 'no rank yet'));
        badge.title = r ? `Your rank for this task: ${r.name}` : 'No rank yet for this task';
      }
    }
    function renderRanks() {
      const stats = statsNow();
      renderBadges(stats);
      const key = question && state === 'answered' ? question.taskKey : taskKey;
      const t = stats && stats.perTask ? stats.perTask[key] : null;
      const r = stats ? taskRank(stats, key) : null;
      const texts = rankTexts({
        rank: r, attempts: t ? t.attempts : 0, avg: t ? t.recentAvgAbsError : NaN, meanSigned: t ? t.meanSignedError : NaN,
        minAttempts: TASK_RANK_MIN, tendencyMin: TENDENCY_MIN, verb: 'go',
      });
      const label = taskOf(key) ? taskOf(key).label : key;
      setChildren(chip,
        el('div', { class: 'level-main' }, el('span', { class: 'level-label' }, `${label}: `), el('strong', {}, texts.main)),
        texts.sub ? el('div', { class: 'level-sub' }, texts.sub) : null,
      );
      if (r) {
        setChildren(resultRank,
          el('span', { class: 'muted' }, `${label} rank:`), ' ',
          el('span', { class: 'task-rank' }, r.name), ' ',
          r.nextName && Number.isFinite(r.nextAtCents)
            ? el('span', { class: 'muted small' }, `next: ${r.nextName} at ${centsText(r.nextAtCents)} or less`)
            : el('span', { class: 'muted small' }, 'top rank'));
      } else {
        setChildren(resultRank, el('span', { class: 'muted small' },
          texts.left > 0 ? `Your rank for this task appears after ${texts.left} more ${texts.left === 1 ? 'round' : 'rounds'}.` : 'No rank yet for this task.'));
      }
    }

    function taskRanksList(stats) {
      return el('div', { class: 'task-ranks' },
        el('p', { class: 'insight-group-title' }, `Rank per task — ${MODES.find((m) => m.value === mode).label.toLowerCase()}`),
        el('ul', { class: 'task-rank-list' }, tasksOf(mode).map((t) => {
          const r = taskRank(stats, t.key);
          const pt = stats.perTask ? stats.perTask[t.key] : null;
          const avg = pt && pt.attempts > 0 && Number.isFinite(pt.recentAvgAbsError) ? `${centsText(pt.recentAvgAbsError)} off on average` : 'Not tried yet';
          return el('li', {},
            el('span', { class: 'task-rank-name' }, shortTaskLabel(t)),
            r ? el('span', { class: 'task-rank' }, r.name)
              : el('span', { class: 'task-rank is-none' }, el('span', { 'aria-hidden': 'true' }, '–'), el('span', { class: 'visually-hidden' }, 'no rank yet')),
            el('span', { class: 'muted small' }, avg));
        })),
      );
    }

    const progressPanel = createProgressPanel({
      what: 'Lock it in',
      onReset: () => {
        progress.resetProgress(TUNE_IT_KEY);
        renderRanks();
      },
      read: () => {
        const stats = getTuneStats();
        const bests = Object.values(stats.perTask || {}).map((t) => t.bestAbsError).filter(Number.isFinite);
        return {
          rank: safeRank(TUNE_IT_KEY, stats),
          noData: !(stats.attempts > 0),
          best: bests.length ? Math.min(...bests) : null,
          bestLabel: 'Closest round',
          bestNote: bests.length ? 'Your closest single round, in any task.' : 'Appears after your first round.',
          extra: taskRanksList(stats),
          caption: 'Cents off per day (average) — lower is better',
          unit: 'cents',
          points: (stats.history || [])
            .filter((d) => d && d.avgAbsError != null)
            .map((d) => ({ date: d.date, value: Number(d.avgAbsError), note: `${d.attempts} ${d.attempts === 1 ? 'round' : 'rounds'}` })),
          empty: 'Tune a few notes to see your progress here.',
          insights: safeInsights(TUNE_IT_KEY),
        };
      },
    });

    // ---------- Paused (page hidden / sound interrupted) ----------
    const pausedBox = pausedCard({ onContinue: () => resume() });
    function pause() {
      const wasSounding = !!sustain;
      player.stop();
      stopCompare();
      stopSustain();
      stopAllSound();
      if (state === 'tuning' && wasSounding && !paused) {
        paused = true;
        pausedBox.show();
        paintKeys();
      }
    }
    function resume() {
      if (!paused) return;
      paused = false;
      pausedBox.hide();
      if (state === 'tuning') {
        startSound(); // the held notes come back at the remembered pitch
        focusAndReveal(slider, score);
      }
    }

    // ---------- Flow ----------
    const taskDesc = el('p', { class: 'task-desc' });
    const taskHelp = el('p', { class: 'pc-phone-only' }); // phones: the task description lives in "How it works"

    function sync() {
      paintBar();
      after.hidden = state !== 'answered';
      syncTuningUi();
    }

    function newQuestion({ same = false } = {}) {
      if (!same) {
        const { tuning } = getSettings();
        question = makeQuestion({ taskKey, tuning, voicePart: voiceArg(), motion: nextMotion() });
      }
      result = null;
      state = 'ready';
      targetOn = false;
      fixedOnly = false;
      if (compareLit) compareLit();
      range = centsBetween(question.slider.minFreq, question.slider.maxFreq);
      setPos(centsBetween(question.slider.minFreq, question.startFreq)); // the slider centre
      const task = taskOf(question.taskKey);
      setChildren(taskDesc, task ? [el('strong', {}, task.label), ' — ', taskDescription(task, question.motion)] : []);
      setChildren(taskHelp, task ? [el('strong', {}, task.label), ' — ', taskDescription(task, question.motion)] : []);
      for (const input of taskInputs) input.checked = input.value === taskKey;
      buildScore();
      feedback.clear();
      scaleHolder.replaceChildren();
      summaryHolder.replaceChildren();
      tipHolder.replaceChildren();
      resultTip.textContent = '';
      for (const r of rows) r.nameEl.textContent = '';
      yourResult.textContent = '';
      opts.setPending(false);
      opts.update();
      updateTuning(getSettings().tuning);
      renderRanks();
      sync();
    }

    function beginTuning() {
      if (state !== 'ready' || paused) return;
      state = 'tuning';
      guard();
      sync();
      startSound();
      focusAndReveal(slider, score, bar.element);
    }

    function nextQuestion() {
      if (state !== 'answered') return;
      const go = () => {
        player.stop();
        stopCompare();
        stopSustain();
        newQuestion();
        beginTuning();
      };
      if (summary.maybeShow(summaryHolder, { onKeepGoing: go, onDone: () => { window.location.hash = '#/stats'; } })) return;
      go();
    }

    function tryAgain() {
      if (state !== 'answered' || inert()) return;
      player.stop();
      stopCompare();
      newQuestion({ same: true });
      beginTuning();
    }

    function answer() {
      if (state !== 'tuning' || !targetOn || inert() || paused) return;
      result = evaluate(question, currentFreq);
      stopSustain();
      state = 'answered';
      const level = levelOf(result);
      try { recordTuneResult(question.taskKey, result); } catch (err) { console.error(err); }
      summary.record({ levelCents: result.absError });
      const dir = result.errorCents > 0 ? 'down' : 'up';
      feedback.show({
        level,
        message: result.message,
        detail: result.detail && !/^Tip:/.test(result.detail) ? result.detail : null,
        icon: level === 'in-tune' ? 'circle-check' : `arrow-${dir}`,
      });
      resultTip.textContent = result.detail && /^Tip:/.test(result.detail) ? result.detail : '';
      setChildren(scaleHolder, resultScale(question, currentFreq));
      showNoteNames();
      buildCompare();
      renderRanks();
      progressPanel.update();
      maybeTip(level);
      sync();
      guard();
      next.guard(400);
      next.focusAfterFeedback(feedback.element.id, ...fitVisible(score, feedback.element, compareHolder));
    }

    // Tip after three rounds in a row more than 15 cents off (once per task per visit).
    function maybeTip(level) {
      const key = question.taskKey;
      const n = level === 'keep-going' ? (lowStreak.get(key) || 0) + 1 : 0;
      lowStreak.set(key, n);
      let streak = n;
      const st = statsNow();
      const saved = st && st.perTask && st.perTask[key] ? st.perTask[key].missStreak : undefined;
      if (Number.isFinite(saved)) streak = saved;
      if (streak < MISS_TIP || tipShown.has(key)) return;
      const easier = easierTaskFor(key);
      if (!easier) return;
      tipShown.add(key);
      const tip = tipCard({
        text: `Three tricky rounds in a row. An easier task can help: ${easier.label}.`,
        actions: [
          {
            label: 'Make it easier',
            onClick: () => {
              let target = easier;
              if (typeof progress.makeEasier === 'function') {
                try {
                  const r = progress.makeEasier(TUNE_IT_KEY, key);
                  if (r && r.kind === 'task' && taskOf(r.taskKey)) target = taskOf(r.taskKey);
                } catch (err) { console.error(err); }
              }
              lowStreak.set(key, 0);
              const g = groupOf(target);
              if (g !== mode) {
                mode = g;
                setPref('tune.mode', g);
                modeSeg.setValue(g);
              }
              taskKey = target.key;
              setPref(`tune.task.${mode}`, target.key);
              buildPicker();
              opts.setPending(true);
              opts.update();
              tip.hide();
              setStatus(`From the next round: ${target.label}.`, '', 4000);
              next.element.focus({ preventScroll: true });
            },
          },
          { label: 'Not now', onClick: () => { tip.hide(); next.element.focus({ preventScroll: true }); } },
        ],
      });
      setChildren(tipHolder, tip.element);
      tip.show();
    }

    // ---------- Keyboard ----------
    const removeShortcuts = installScreenKeys((e) => {
      const k = e.key;
      if (paused) {
        if (k === 'Enter') { resume(); return true; }
        return false;
      }
      if (k === 'Enter') {
        if (state === 'ready') beginTuning();
        else if (state === 'tuning') answer();
        else next.click();
        return true;
      }
      if (k === ' ') {
        if (state === 'ready') beginTuning();
        else if (state === 'tuning') { if (sustain) stopSustain(); else startSound(); }
        else if (sw && !sw.ownKeys) sw.toggle();
        else return false;
        return true;
      }
      if (state === 'tuning') {
        const step = { ArrowRight: 1, ArrowLeft: -1, PageUp: 10, PageDown: -10 }[k];
        if (step) { nudge(Math.abs(step) === 1 && e.shiftKey ? step * 5 : step); return true; }
      }
      if (state === 'answered' && sw && !sw.ownKeys) {
        const o = compareOptions().find((x) => x.key === k);
        if (o) { sw.select(o.value); return true; }
      }
      return false;
    }, { allowRepeat: ['ArrowLeft', 'ArrowRight', 'PageUp', 'PageDown'] });

    // Esc: stop the sound (the options panel closes itself first when it is open).
    const offEsc = onEscape(() => {
      if (sustain) { stopSustain(); return true; }
      if (compareHold) { stopCompare(); return true; }
      if (player.playing) { player.stop(); return true; }
      return false;
    });

    const offHidden = onPageHidden({
      onHide: () => pause(),
      onShow: () => { if (paused && typeof pausedBox.focus === 'function') pausedBox.focus(); },
    });

    const unsubscribe = onSettingsChange((s) => updateTuning(s.tuning));

    // ---------- Layout ----------
    buildPicker();
    const screen = el('section', { class: 'screen exercise producing tune' },
      exerciseHead({
        title: 'Lock it in',
        task: 'Some notes are fixed. Bring in your note with the slider and tune it until everything sounds calm.',
        taskShort: 'Slide your note until the chord is calm.',
        chip,
      }),
      opts.element,
      taskDesc,
      el('div', { class: 'stage' },
        statusLine,
        pausedBox.element,
        touchHint,
        score,
        feedback.element,
        after,
        soundRow,
        doneNote,
        bar.element,
        keys.element,
      ),
      helpBox({ summary: 'How it works' },
        taskHelp,
        el('p', {}, '"Interval training" tunes one note against one fixed note. "In a chord" tunes one note of a chord while the others are fixed. The notes are drawn like a little score, highest on top: fixed notes have a lock, your note has the slider.'),
        MOTION_SUPPORTED ? el('p', {}, 'In interval training, "Descending" turns it round: the upper note is fixed and you tune the lower one. "Both" picks a direction at random each round.') : null,
        el('p', {}, 'Press Start: first only the fixed notes sound. Touch the slider (or a fine-tune button, or an arrow key) and your note comes in where it is. Then drag to move it: the slider has no markings and starts in a different place each round, so trust your ears.'),
        el('p', {}, 'Move your note until the wobble stops and the sound is calm. The fine-tune buttons move it by 1 or 5 cents (100 cents = one semitone); hold a button to keep moving. "Hear the fixed notes alone" silences your note for a moment; tap a fixed note head to hear just that note.'),
        el('p', {}, 'When it sounds right, press "I\'m in tune". You see how close you got and can switch between your version, pure and piano while the sound keeps playing. "Try again (same notes)" gives you the same round once more.'),
        el('p', {}, 'Each task has its own rank, shown on the task buttons. It appears after a few rounds and is based on how many cents off you were on average.'),
        el('p', { class: 'muted small' }, 'Keys: Enter = Start / I\'m in tune / Next. ← → = 1 cent (Shift = 5, Page Up/Down = 10). Space = sound on/off. After a round: 1 2 3 = your version / pure / piano, Space = play/stop. Esc = stop the sound.'),
      ),
      progressPanel.element,
    );

    newQuestion();
    container.append(screen);
    // Keyboard: after a mouse change of an option go back to the main action.
    function mainAction() {
      if (paused) return pausedBox.element.querySelector('button');
      return state === 'answered' ? next.element : state === 'tuning' ? slider : startBtn.element;
    }
    const removeRefocus = refocusAfterPointerChange(screen, () => (opts.isOpen ? null : mainAction()));

    return () => {
      removeRefocus();
      destroyed = true;
      clearTimeout(statusTimer);
      unsubscribe();
      removeShortcuts();
      offEsc();
      offHidden();
      stopSustain();
      stopCompare();
      if (compareLit) compareLit();
      if (sw) sw.destroy();
      player.destroy();
    };
  },
};
