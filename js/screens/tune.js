// "Lock it in" (#/tune): two modes (interval training / in a chord). The fixed notes
// sound; the singer brings in their own note by touching the slider in its row of the
// little score, tunes it, then compares their version with pure and piano.

// Namespace imports: newer exports (describe, TUNE_TENDENCY_MIN_CENTS, per-task ranks,
// insights, startSustain muting, task groups) are feature-checked.
import * as tuneIt from '../exercise/tune-it.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import { TUNINGS, INTERVALS, centsBetween, shiftByCents } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, reveal, centsText } from '../ui/dom.js';
import { icon } from '../ui/icons.js';
import { segmented, helpBox, tagLink, installShortcuts, kbd } from '../ui/components.js';
import { createPlayButton, nextButton, createFeedback } from '../ui/exercise.js';
import { createPlayer, needsLoading, ensureTimbre } from '../ui/player.js';
import { createProgressPanel } from '../ui/progress-panel.js';
import { safeRank, safeInsights } from '../ui/chapter-progress.js';
import { trackHighlights, chordPlan } from '../ui/highlight.js';
import { voiceArg } from '../ui/voices.js';
import { groupOf, shortTaskLabel, taskChips } from '../ui/task-labels.js';

const {
  TUNE_TASKS, TUNE_IT_KEY, makeQuestion, evaluate, recordTuneResult, getTuneStats,
} = tuneIt;

const COMPARE_SECONDS = 1.7;
const NOTE_SECONDS = 1.6; // a fixed note heard alone
const NUDGES = [-5, -1, 1, 5];
const TENDENCY_MIN = Number.isFinite(tuneIt.TUNE_TENDENCY_MIN_CENTS) ? tuneIt.TUNE_TENDENCY_MIN_CENTS : 4;
const TASK_RANK_MIN = Number.isFinite(progress.TUNE_IT_TASK_RANK_MIN_ATTEMPTS) ? progress.TUNE_IT_TASK_RANK_MIN_ATTEMPTS : 5;

const MODES = [
  { value: 'interval', label: 'Interval training' },
  { value: 'chord', label: 'In a chord' },
];
/** 'interval' | 'chord' — from the logic's `group`, else one fixed note = interval. */
const tasksOf = (mode) => TUNE_TASKS.filter((t) => groupOf(t) === mode);

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

/** The task's description, turned round for descending intervals (you tune the lower note). */
function taskDescription(task, motion) {
  if (motion !== 'down') return task.description;
  const interval = INTERVALS[task.target];
  const name = interval ? interval.name.toLowerCase() : 'interval';
  const article = /^[aeiou]/.test(name) ? 'an' : 'a';
  return `The upper note is fixed. Tune the lower note so it sits exactly ${article} ${name} below it.`;
}

function tuningTagLabel(tuning) {
  return tuning === TUNINGS.EQUAL ? 'Tuning: piano' : 'Tuning: pure (choir)';
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

function tendencyText(t) {
  const m = t && t.meanSignedError;
  if (!Number.isFinite(m) || Math.abs(m) < TENDENCY_MIN) return '';
  return m > 0 ? 'you tend to go a little sharp' : 'you tend to go a little flat';
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
  const rel = (c, name) => (Math.round(Math.abs(c)) === 0 ? `right on ${name}` : `${centsText(Math.abs(c))} ${above(c)} ${name}`);
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
        el('p', { class: 'task' }, 'This exercise needs a newer sound engine, which is on its way. Please reload the page in a little while.'),
      ));
      return undefined;
    }

    // ---------- Mode + task (remembered; last task per mode) ----------
    const legacyTask = TUNE_TASKS.find((t) => t.key === getPref('tune.task', null));
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

    let question = null;
    let result = null;
    let state = 'ready';      // 'ready' | 'tuning' | 'answered'
    let currentFreq = 0;
    let sustain = null;
    let canMute = true;       // engine supports silent start + setMuted (checked on start)
    let targetOn = false;     // the user has brought in their note (first touch)
    let fixedOnly = false;    // "Hear the fixed notes alone"
    let destroyed = false;
    let startToken = 0;
    let rows = [];            // [{ idx, fixed, row, head }] top row first; idx = sustain index
    let compareLit = null;    // stop function of a running compare / single-note highlight
    const targetIndex = () => question.fixedTones.length;

    // ---------- Sound ----------
    const statusLine = el('p', { class: 'stage-status', role: 'status' });
    statusLine.hidden = true;
    function setStatus(text, isError = false) {
      statusLine.textContent = text || '';
      statusLine.hidden = !text;
      statusLine.classList.toggle('is-error', !!isError);
    }

    // Comparisons and single fixed notes. (No "which option is sounding" highlight, by request.)
    const player = createPlayer({
      onChange: (s) => {
        if (s.error) setStatus(s.error, true);
        else if (s.loading) setStatus('Loading sound…');
        else if (state !== 'tuning') setStatus('');
      },
    });

    // Note heads light up while their note sounds.
    function lightUp(keys) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keys.has(r.idx));
    }
    function lightSustain() {
      if (compareLit) return; // a compare / single note is showing its own highlight
      const on = new Set();
      if (sustain) {
        question.fixedTones.forEach((t, i) => on.add(i));
        if (!targetSilent()) on.add(targetIndex());
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

    // Start (or restart) the held notes. Call from a click / key press.
    async function startSound() {
      const ready = engine.initAudio(); // inside the user gesture
      player.stop();
      stopSustain();
      const mine = startToken;
      try {
        await ready;
        const s = getSettings();
        engine.setMasterVolume(s.volume);
        if (typeof engine.setReverb === 'function') engine.setReverb(s.reverb);
      } catch (err) {
        console.error(err);
        setStatus('Sound could not be started in this browser.', true);
        return;
      }
      const timbre = getSettings().timbre;
      if (needsLoading(timbre)) {
        setStatus('Loading sound…');
        const ok = await ensureTimbre(timbre);
        if (!ok) { setStatus('This sound could not be loaded. Try another sound in Settings.', true); return; }
      }
      if (mine !== startToken || destroyed || state !== 'tuning') return;
      setStatus('');
      const freqs = [...question.fixedTones.map((t) => t.freq), currentFreq];
      const silent = targetSilent();
      let h = engine.startSustain(freqs, { timbre, muted: silent ? [targetIndex()] : [] });
      if (h && typeof h.setMuted !== 'function') {
        // Older engine: no silent start. Fall back to the previous behaviour —
        // the note sounds right away (and "fixed notes alone" restarts without it).
        canMute = false;
        targetOn = true;
        if (fixedOnly) {
          try { h.stop(); } catch { /* ignore */ }
          h = engine.startSustain(freqs.slice(0, targetIndex()), { timbre });
        }
      }
      sustain = h;
      if (h && h.done) h.done.then(() => { if (sustain === h) { sustain = null; syncTuningUi(); } });
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

    // The first touch of the slider, a fine-tune button or an arrow key brings the note in.
    function touch() {
      if (state !== 'tuning' || targetOn) return;
      targetOn = true;
      if (!fixedOnly) applyMute();
      syncTuningUi();
    }

    function setFreqLive(f) {
      currentFreq = Math.min(question.slider.maxFreq, Math.max(question.slider.minFreq, f));
      slider.value = String(centsBetween(question.slider.minFreq, currentFreq));
      if (sustain && (canMute || !fixedOnly)) {
        try { sustain.setFreq(targetIndex(), currentFreq); } catch (err) { console.error(err); }
      }
    }
    const nudge = (c) => {
      if (state !== 'tuning') return;
      setFreqLive(shiftByCents(currentFreq, c));
      touch();
    };

    function runLit(h, plan) {
      if (compareLit) compareLit();
      const stop = trackHighlights(h, plan, lightUp);
      compareLit = () => { compareLit = null; stop(); };
      if (h && h.done) h.done.then(() => { if (compareLit) { compareLit = null; lightSustain(); } });
      return h;
    }

    const compareSteps = {
      yours: () => [...question.fixedTones.map((t) => t.freq), currentFreq],
      pure: () => [...question.fixedTones.map((t) => t.freq), question.target.justFreq],
      piano: () => [...question.fixedTones.map((t) => t.freq), question.target.equalFreq],
    };
    function playCompare(which) {
      stopSustain();
      player.play([{
        tag: which,
        start: () => runLit(
          engine.playChord(compareSteps[which](), { duration: COMPARE_SECONDS, timbre: getSettings().timbre }),
          chordPlan(question.fixedTones.length + 1, COMPARE_SECONDS, 0).map((p, i) => ({ ...p, key: i })),
        ),
      }]);
    }
    // A fixed note alone (stops the held notes; "Play sound" brings them back).
    function playFixed(i) {
      stopSustain();
      player.play([{
        tag: `fixed-${i}`,
        start: () => runLit(
          engine.playTone(question.fixedTones[i].freq, { duration: NOTE_SECONDS, timbre: getSettings().timbre }),
          [{ key: i, start: 0, end: NOTE_SECONDS }],
        ),
      }]);
    }

    // ---------- Controls ----------
    const startBtn = createPlayButton({ onClick: () => beginTuning(), label: 'Start', shortcut: 'Enter' });

    const slider = el('input', {
      type: 'range',
      class: 'tune-slider',
      min: '0',
      max: '240',
      step: '0.1',
      'aria-label': 'Your note: slide left to go lower, right to go higher',
    });
    slider.addEventListener('input', () => {
      setFreqLive(shiftByCents(question.slider.minFreq, Number(slider.value)));
      touch();
    });
    slider.addEventListener('pointerdown', () => touch());
    slider.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') { e.preventDefault(); answer(); return; }
      const dir = { ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 }[e.key];
      if (!dir) return;
      e.preventDefault();
      nudge(dir * (e.shiftKey ? 5 : 1));
    });

    const nudgeBtns = NUDGES.map((c) => el('button', {
      type: 'button',
      class: 'btn btn-small btn-nudge',
      'aria-label': `${c > 0 ? 'Raise' : 'Lower'} by ${Math.abs(c)} ${Math.abs(c) === 1 ? 'cent' : 'cents'}`,
      onclick: () => nudge(c),
    }, c > 0 ? `+${c}` : `−${Math.abs(c)}`));
    const nudgeRow = el('div', { class: 'nudge-row tscore-nudge', role: 'group', 'aria-label': 'Fine tune' },
      el('span', { class: 'nudge-end', 'aria-hidden': 'true' }, 'lower'),
      nudgeBtns,
      el('span', { class: 'nudge-end', 'aria-hidden': 'true' }, 'higher'));
    // The slider sits in your note's row, its track on the same line as the staff line.
    const playedName = el('strong', { class: 'tscore-name tscore-played' });
    const sliderWrap = el('div', { class: 'slider-wrap tscore-slider' },
      playedName,
      el('span', { class: 'slider-end', 'aria-hidden': 'true' }, 'lower'),
      slider,
      el('span', { class: 'slider-end', 'aria-hidden': 'true' }, 'higher'),
    );

    const soundBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => (sustain ? stopSustain() : startSound()) });
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

    const touchHintText = el('span', {}, 'Touch the slider to bring in your note');
    const touchHint = el('p', { class: 'silent-hint', role: 'status' },
      el('span', { class: 'pulse-dot', 'aria-hidden': 'true' }), touchHintText);
    const doneBtn = el('button', { type: 'button', class: 'btn btn-primary btn-done', onclick: () => answer() },
      icon('check', { size: 20 }), "I'm in tune", kbd('Enter'));
    const doneNote = el('p', { class: 'small muted center done-note' }, '"I\'m in tune" unlocks once your note is sounding.');
    const score = el('div', { class: 'score tscore', role: 'group', 'aria-label': 'The notes: fixed notes and your note' });

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
        const nameEl = t.fixed ? el('span', { class: 'tscore-name' }) : playedName;
        const head = t.fixed
          ? el('button', {
            type: 'button',
            class: 'score-head-btn',
            'aria-label': `Listen: hear the ${name} alone`,
            title: `Hear the ${name} alone`,
            onclick: () => playFixed(t.idx),
          }, el('span', { class: 'score-head', 'aria-hidden': 'true' }), icon('volume-2', { size: 12, class: 'score-head-icon' }))
          : el('span', { class: 'score-head-btn is-static', 'aria-hidden': 'true' }, el('span', { class: 'score-head' }));
        const row = el('div', { class: `score-row tscore-row ${t.fixed ? 'is-fixed' : 'is-target'}` },
          el('div', { class: 'score-note' },
            el('span', { class: 'score-verdict' }, t.fixed ? 'fixed' : 'your note'),
            head,
            // The padlock right next to a fixed note head says "this one stays put".
            t.fixed ? icon('lock', { size: 18, class: 'tscore-lock', label: `${t.label}: fixed note` }) : null,
            el('span', { class: 'score-label' }, t.label),
          ),
          ...(t.fixed ? [nameEl] : [sliderWrap, nudgeRow]),
        );
        return { idx: t.idx, fixed: t.fixed, row, nameEl };
      });
      setChildren(score, rows.map((r) => r.row));
    }

    /** After answering: each row's note name from describe(question, playedFreq). */
    function showNoteNames(desc) {
      if (!desc || !Array.isArray(desc.notes)) return;
      const pretty = (n) => {
        const d = n.played || {};
        const text = typeof d.text === 'string' ? d.text : `${n.name || ''}`;
        return text.replace(/#/g, '♯').replace(/-/g, '−');
      };
      const nFixed = question.fixedTones.length;
      for (const r of rows) {
        const n = r.fixed ? desc.notes[r.idx] : desc.notes[nFixed] || desc.notes[desc.notes.length - 1];
        r.nameEl.textContent = n ? pretty(n) : '';
      }
    }

    function syncTuningUi() {
      setChildren(soundBtn, sustain ? [icon('square', { size: 16 }), 'Stop sound'] : [icon('play', { size: 16 }), 'Play sound']);
      fixedBtn.setAttribute('aria-pressed', String(fixedOnly));
      setChildren(fixedBtn, fixedOnly
        ? [icon('play', { size: 16 }), 'Back to all notes']
        : [icon('volume-2', { size: 16 }), 'Hear the fixed notes alone']);
      // Keep the space reserved (visibility, not display) so nothing jumps on the first touch.
      fixedBtn.style.visibility = targetOn ? '' : 'hidden';
      if (!question) return;
      const tuning = state === 'tuning';
      slider.disabled = !tuning;
      for (const b of nudgeBtns) b.disabled = !tuning;
      nudgeRow.hidden = state === 'answered';
      soundRow.hidden = !tuning;
      touchHint.hidden = !tuning;
      touchHint.classList.toggle('is-in', targetOn);
      touchHintText.textContent = targetOn
        ? 'Your note is in — tune until it sounds calm'
        : 'Touch the slider to bring in your note';
      doneBtn.hidden = !tuning;
      doneBtn.disabled = !targetOn;
      doneNote.hidden = !tuning;
      doneNote.style.visibility = targetOn ? 'hidden' : '';
      score.classList.toggle('is-silent-target', targetSilent());
      lightSustain();
    }

    const feedback = createFeedback();
    const scaleHolder = el('div', { class: 'scale-holder' });
    const compareBtns = {
      yours: el('button', { type: 'button', class: 'btn btn-compare', onclick: () => playCompare('yours') }, icon('play', { size: 18 }), 'Your version', kbd('1')),
      pure: el('button', { type: 'button', class: 'btn btn-compare btn-pure', onclick: () => playCompare('pure') }, icon('play', { size: 18 }), 'Pure', kbd('2')),
      piano: el('button', { type: 'button', class: 'btn btn-compare btn-piano', onclick: () => playCompare('piano') }, icon('play', { size: 18 }), 'Piano', kbd('3')),
    };
    const resultRank = el('p', { class: 'task-rank-line' });
    const next = nextButton({ onClick: () => nextQuestion(true) });
    const after = el('div', { class: 'after-answer' },
      scaleHolder,
      el('div', { class: 'compare', role: 'group', 'aria-label': 'Compare' }, compareBtns.yours, compareBtns.pure, compareBtns.piano),
      resultRank,
      next,
    );

    // ---------- Mode switch + task picker (with a rank badge per task) ----------
    const pickerHolder = el('div', { class: 'task-picker' });
    const taskInputs = [];
    const taskBadges = new Map();
    function buildPicker() {
      const picker = taskChips({
        tasks: tasksOf(mode),
        mode,
        value: taskKey,
        legend: mode === 'interval' ? 'Interval' : 'Note to tune',
        onChoose: (k) => chooseTask(k),
      });
      taskInputs.length = 0;
      taskInputs.push(...picker.inputs);
      taskBadges.clear();
      for (const [k, b] of picker.badges) taskBadges.set(k, b);
      setChildren(pickerHolder, picker.element);
      motionHolder.hidden = !(MOTION_SUPPORTED && mode === 'interval');
    }
    // Interval training: ascending / descending / both (mixed, random per question).
    const MOTION_OPTIONS = [
      { value: 'up', label: 'Ascending' },
      { value: 'down', label: 'Descending' },
      { value: 'mixed', label: 'Both (mixed)' },
    ];
    let motionPref = getPref('tune.motion', 'up');
    if (!MOTION_OPTIONS.some((o) => o.value === motionPref)) motionPref = 'up';
    const motionSeg = segmented({
      name: 'tune-motion',
      legend: 'Direction',
      compact: true,
      options: MOTION_OPTIONS,
      value: motionPref,
      onChange: (v) => {
        motionPref = v;
        setPref('tune.motion', v);
        player.stop();
        stopSustain();
        newQuestion();
      },
    });
    const motionHolder = el('div', { class: 'motion-holder' }, motionSeg.element);
    const nextMotion = () => {
      if (!MOTION_SUPPORTED || mode !== 'interval') return 'up';
      if (motionPref === 'mixed') return Math.random() < 0.5 ? 'up' : 'down';
      return motionPref;
    };

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
        player.stop();
        stopSustain();
        newQuestion();
        progressPanel.update();
      },
    });

    const taskDesc = el('p', { class: 'task-desc' });
    let tuningTag = tagLink({ href: '#/settings', label: tuningTagLabel(getSettings().tuning), title: 'Change tuning in Settings' });
    const tagHolder = el('span', { class: 'tag-holder' }, tuningTag);
    function updateTag(tuning) {
      const fresh = tagLink({ href: '#/settings', label: tuningTagLabel(tuning), title: 'Change tuning in Settings' });
      tuningTag.replaceWith(fresh);
      tuningTag = fresh;
    }

    function chooseTask(key) {
      taskKey = key;
      setPref(`tune.task.${mode}`, key);
      player.stop();
      stopSustain();
      newQuestion();
    }

    // ---------- Ranks: picker badges, top-right box, result line ----------
    const chip = el('div', { class: 'level' });
    const taskLabel = (key) => {
      const t = TUNE_TASKS.find((x) => x.key === key);
      return t ? t.label : key;
    };

    function renderRanks() {
      let stats = null;
      try { stats = getTuneStats(); } catch (err) { console.error(err); }
      for (const [key, badge] of taskBadges) {
        const r = stats ? taskRank(stats, key) : null;
        badge.textContent = r ? r.name : '–';
        badge.className = `task-rank${r ? '' : ' is-none'}`;
        badge.title = r ? `Your rank for this task: ${r.name}` : 'No rank yet for this task';
      }
      const t = stats && stats.perTask ? stats.perTask[taskKey] : null;
      const r = stats ? taskRank(stats, taskKey) : null;
      const attempts = t ? t.attempts || 0 : 0;
      const parts = [];
      if (t && attempts > 0 && Number.isFinite(t.recentAvgAbsError)) parts.push(`avg ${centsText(t.recentAvgAbsError)} off`);
      const tend = tendencyText(t);
      if (tend) parts.push(tend);
      if (!parts.length) parts.push(attempts ? `${attempts} ${attempts === 1 ? 'try' : 'tries'}` : 'Smaller numbers are better');
      setChildren(chip,
        el('div', { class: 'level-main' },
          el('span', { class: 'level-label' }, `${taskLabel(taskKey)}: `),
          el('strong', {}, r ? r.name : attempts ? 'no rank yet' : 'new task')),
        el('div', { class: 'level-sub' }, parts.join(' · ')),
      );
      if (r) {
        setChildren(resultRank,
          el('span', { class: 'muted' }, `${taskLabel(taskKey)} rank:`), ' ',
          el('span', { class: 'task-rank' }, r.name), ' ',
          r.nextName && Number.isFinite(r.nextAtCents)
            ? el('span', { class: 'muted small' }, `next: ${r.nextName} at ${centsText(r.nextAtCents)} or less`)
            : el('span', { class: 'muted small' }, 'top rank — wonderful!'));
      } else {
        const left = Math.max(0, TASK_RANK_MIN - attempts);
        setChildren(resultRank, el('span', { class: 'muted small' },
          left > 0 ? `Your rank for this task appears after ${left} more ${left === 1 ? 'try' : 'tries'}.` : 'No rank yet for this task.'));
      }
    }

    function taskRanksList(stats) {
      return el('div', { class: 'task-ranks' },
        el('p', { class: 'insight-group-title' }, `Rank per task — ${MODES.find((m) => m.value === mode).label.toLowerCase()}`),
        el('ul', { class: 'task-rank-list' }, tasksOf(mode).map((t) => {
          const r = taskRank(stats, t.key);
          const pt = stats.perTask ? stats.perTask[t.key] : null;
          const avg = pt && pt.attempts > 0 && Number.isFinite(pt.recentAvgAbsError) ? `avg ${centsText(pt.recentAvgAbsError)} off` : 'not tried yet';
          return el('li', {},
            el('span', { class: 'task-rank-name' }, shortTaskLabel(t)),
            el('span', { class: `task-rank${r ? '' : ' is-none'}` }, r ? r.name : '–'),
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
          bestLabel: 'Closest tuning',
          bestNote: bests.length ? 'Your most accurate try, in any task.' : 'Appears after your first try.',
          extra: taskRanksList(stats),
          caption: 'Average distance from in tune, per day (lower = better)',
          unit: 'cents',
          points: (stats.history || [])
            .filter((d) => d && d.avgAbsError != null)
            .map((d) => ({ date: d.date, value: Number(d.avgAbsError), note: `${d.attempts} ${d.attempts === 1 ? 'try' : 'tries'}` })),
          empty: 'Tune a few notes to see your progress here.',
          insights: safeInsights(TUNE_IT_KEY),
        };
      },
    });

    // ---------- Flow ----------
    function sync() {
      startBtn.element.hidden = state !== 'ready';
      after.hidden = state !== 'answered';
      syncTuningUi();
    }

    function newQuestion() {
      const { tuning } = getSettings();
      question = makeQuestion({ taskKey, tuning, voicePart: voiceArg(), motion: nextMotion() });
      result = null;
      state = 'ready';
      targetOn = false;
      fixedOnly = false;
      if (compareLit) compareLit();
      currentFreq = question.startFreq; // the slider centre
      slider.max = String(centsBetween(question.slider.minFreq, question.slider.maxFreq));
      slider.value = String(centsBetween(question.slider.minFreq, currentFreq));
      const task = TUNE_TASKS.find((t) => t.key === taskKey);
      setChildren(taskDesc, task ? [el('strong', {}, task.label), ' — ', taskDescription(task, question.motion)] : []);
      for (const input of taskInputs) input.checked = input.value === taskKey;
      buildScore();
      feedback.clear();
      scaleHolder.replaceChildren();
      for (const r of rows) r.nameEl.textContent = '';
      setStatus('');
      updateTag(tuning);
      renderRanks();
      sync();
    }

    function beginTuning() {
      if (state !== 'ready') return;
      state = 'tuning';
      sync();
      startSound();
      slider.focus({ preventScroll: true });
    }

    function nextQuestion(autostart) {
      player.stop();
      stopSustain();
      newQuestion();
      reveal(screen, startBtn.element);
      if (autostart) beginTuning();
    }

    function answer() {
      if (state !== 'tuning' || !targetOn) return;
      result = evaluate(question, currentFreq);
      stopSustain();
      state = 'answered';
      try { recordTuneResult(taskKey, result); } catch (err) { console.error(err); }
      const good = result.rating === 'excellent' || result.rating === 'good';
      feedback.show({
        correct: good,
        close: result.rating === 'close',
        message: result.message,
      });
      setChildren(scaleHolder, resultScale(question, currentFreq));
      if (typeof tuneIt.describe === 'function') {
        try { showNoteNames(tuneIt.describe(question, currentFreq)); } catch (err) { console.error(err); }
      }
      // Octave, fifth, fourth: pure and piano are (almost) the same note — one button is enough.
      const iv = INTERVALS[question.target.intervalKey];
      const same = Math.abs(iv.equalCents - iv.justCents) <= 3;
      compareBtns.piano.hidden = same;
      setChildren(compareBtns.pure, icon('play', { size: 18 }), same ? 'In tune' : 'Pure', kbd('2'));
      renderRanks();
      progressPanel.update();
      sync();
      next.focus();
    }

    // ---------- Keyboard ----------
    const removeShortcuts = installShortcuts((e) => {
      const k = e.key;
      if (k === 'Enter') {
        if (state === 'ready') beginTuning();
        else if (state === 'tuning') answer();
        else nextQuestion(true);
        return true;
      }
      if (k === ' ') {
        if (state === 'ready') beginTuning();
        else if (state === 'tuning') { if (sustain) stopSustain(); else startSound(); }
        else nextQuestion(true);
        return true;
      }
      if (state === 'tuning' && (k === 'ArrowLeft' || k === 'ArrowRight')) {
        nudge((k === 'ArrowRight' ? 1 : -1) * (e.shiftKey ? 5 : 1));
        return true;
      }
      if (state === 'answered') {
        if (k === '1') { playCompare('yours'); return true; }
        if (k === '2') { playCompare('pure'); return true; }
        if (k === '3' && !compareBtns.piano.hidden) { playCompare('piano'); return true; }
      }
      return false;
    });

    const unsubscribe = onSettingsChange((s) => updateTag(s.tuning));

    // ---------- Layout ----------
    buildPicker();
    const screen = el('section', { class: 'screen exercise' },
      el('div', { class: 'screen-head' },
        el('div', {},
          el('h1', {}, 'Lock it in'),
          el('p', { class: 'task' }, 'Some notes are fixed. Bring in your note with the slider and tune it until everything sounds calm.'),
        ),
        chip,
      ),
      el('div', { class: 'mode-row' }, modeSeg.element),
      el('div', { class: 'options-row' }, pickerHolder, motionHolder, tagHolder),
      taskDesc,
      el('div', { class: 'stage' },
        startBtn.element,
        statusLine,
        touchHint,
        score,
        soundRow,
        doneBtn,
        doneNote,
        feedback.element,
        after,
      ),
      helpBox({ summary: 'How it works' },
        el('p', {}, '"Interval training" tunes one note against one fixed note; "In a chord" tunes one note of a chord while the others are fixed. The notes are drawn like a little score, highest on top: fixed notes have a lock, your note has the slider.'),
        MOTION_SUPPORTED ? el('p', {}, 'In interval training, "Descending" turns it round: the upper note is fixed and you tune the lower one. "Both (mixed)" picks a direction at random each time.') : null,
        el('p', {}, 'Press Start: first only the fixed note(s) sound. Touch the slider (or a fine-tune button, or an arrow key) and your note comes in. Note heads light up while they sound. The slider always starts in the middle, so its position gives nothing away — and there are no markings: trust your ears.'),
        el('p', {}, 'Move your note until the wobble disappears and the sound is calm. The fine-tune buttons move it by 1 or 5 cents (100 cents = one piano semitone). "Hear the fixed notes alone" silences your note for a moment to reset your ear; tap a fixed note head to hear just that note.'),
        el('p', {}, 'When it sounds right, press "I\'m in tune". You see how close you got, which notes sounded, and whether you were closer to the pure (choir) note or the piano note — and can listen to your version, pure and piano.'),
        el('p', {}, 'Each task has its own rank, shown on the task buttons. It appears after a few tries and is based on your recent average distance from in tune.'),
        el('p', { class: 'muted small' }, 'Keys: Enter = start / I\'m in tune / next. ← → = 1 cent, Shift + ← → = 5 cents. Space = sound on/off. After answering: 1 = your version, 2 = pure, 3 = piano.'),
      ),
      progressPanel.element,
    );

    newQuestion();
    container.append(screen);

    return () => {
      destroyed = true;
      unsubscribe();
      removeShortcuts();
      stopSustain();
      if (compareLit) compareLit();
      player.destroy();
    };
  },
};
