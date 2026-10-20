// The singing exercise screen, shared by "Echo" (kind 'match': sing the note you
// heard) and "Join the chord" (kind 'missing': intervals / chords, like Lock it
// yourself, but you sing). Score-style layout: fixed notes with padlocks, your row with
// "sing here" and a live pitch trace.

import * as tuneIt from '../exercise/tune-it.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import { TUNINGS, INTERVALS, centsBetween } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, reveal, centsText } from './dom.js';
import { icon } from './icons.js';
import { segmented, helpBox, tagLink, installShortcuts, kbd } from './components.js';
import { createPlayButton, nextButton, createFeedback } from './exercise.js';
import { createPlayer, needsLoading, ensureTimbre } from './player.js';
import { createProgressPanel } from './progress-panel.js';
import { safeRank, safeInsights } from './chapter-progress.js';
import { voiceArg } from './voices.js';
import { describeFreq } from './notes.js';
import { groupOf, shortTaskLabel, taskChips } from './task-labels.js';
import {
  loadSingModules, fakeMicEnabled, micSetupDone, micSetupPanel, micErrorHelp, openMic,
  setFakeTarget, createTrace, foldedCents, setMicActive,
} from './sing-common.js';

// Hold-to-sing: the microphone is only analysed and recorded while the button (or Space) is held.
const ENOUGH_SECONDS = 2.5;      // the bar is full: "That's enough — let go when ready"
const MAX_SECONDS = 15;          // safety stop
const REFERENCE_SECONDS = 1.5;   // "Sing it back": how long the note plays first
const COMPARE_SECONDS = 1.7;
const TRACE_SECONDS = 4;         // the trace widens by itself for longer takes

/** The Tune task text, worded for singing (and turned round for descending intervals). */
function singDescription(task, motion) {
  if (motion === 'down') {
    const interval = INTERVALS[task.target];
    const name = interval ? interval.name.toLowerCase() : 'interval';
    const article = /^[aeiou]/.test(name) ? 'an' : 'a';
    return `The upper note is fixed. Sing the lower note exactly ${article} ${name} below it.`;
  }
  return task.description.replace(/\bTune\b/g, 'Sing');
}

const MODES = [
  { value: 'interval', label: 'Interval training' },
  { value: 'chord', label: 'In a chord' },
];
const MOTION_OPTIONS = [
  { value: 'up', label: 'Ascending' },
  { value: 'down', label: 'Descending' },
  { value: 'mixed', label: 'Both (mixed)' },
];
const tasksOf = (mode) => tuneIt.TUNE_TASKS.filter((t) => groupOf(t) === mode);
const shortLabel = shortTaskLabel;
const prettyNote = (d) => (d && d.text ? d.text.replace(/#/g, '♯').replace(/-/g, '−') : '');

function tuningTagLabel(tuning) {
  return tuning === TUNINGS.EQUAL ? 'Tuning: piano' : 'Tuning: pure (choir)';
}

function rankFor(key, stats, opts) {
  if (typeof progress.getRank !== 'function') return null;
  try {
    const r = opts ? progress.getRank(key, stats, opts) : progress.getRank(key, stats);
    return r && r.basis ? r : null;
  } catch {
    return null;
  }
}

/**
 * Render a singing exercise.
 * cfg: { kind: 'match' | 'missing', title, task }
 * Returns a cleanup function.
 */
export function renderSingExercise(container, cfg) {
  const isMatch = cfg.kind === 'match';
  let destroyed = false;
  let cleanupFns = [];
  const onCleanup = (fn) => cleanupFns.push(fn);

  const screen = el('section', { class: 'screen exercise sing' },
    el('div', { class: 'screen-head' }, el('div', {}, el('h1', {}, cfg.title), el('p', { class: 'task' }, cfg.task))),
    el('p', { class: 'muted' }, 'Getting the microphone part ready…'),
  );
  container.append(screen);

  loadSingModules().then(({ pitch, sing }) => {
    if (destroyed) return;
    const micReady = fakeMicEnabled() || (pitch && typeof pitch.startMic === 'function');
    const logicReady = sing && typeof sing.analyzeTake === 'function' && typeof sing.evaluateSing === 'function'
      && typeof (isMatch ? sing.makeMatchQuestion : sing.makeSingQuestion) === 'function';
    if (!micReady || !logicReady) {
      setChildren(screen,
        el('div', { class: 'soon-icon' }, icon('mic', { size: 32 })),
        el('h1', {}, cfg.title),
        el('p', { class: 'task' }, 'This exercise is coming together — the singing part of the app is still being finished. Please check back soon.'),
      );
      return;
    }
    if (!fakeMicEnabled() && typeof pitch.micSupported === 'function' && !pitch.micSupported()) {
      setChildren(screen,
        el('div', { class: 'soon-icon' }, icon('mic', { size: 32 })),
        el('h1', {}, cfg.title),
        el('p', { class: 'task' }, micErrorHelp({ code: 'unsupported' })),
      );
      return;
    }
    if (micSetupDone()) build(sing);
    else showSetup(sing);
  });

  function showSetup(sing, { back = false } = {}) {
    const panel = micSetupPanel({
      onDone: () => { panel.destroy(); if (!destroyed) build(sing); },
      title: back ? 'Check your microphone' : 'Before you sing',
    });
    onCleanup(() => panel.destroy());
    setChildren(screen,
      el('div', { class: 'screen-head' }, el('div', {}, el('h1', {}, cfg.title), el('p', { class: 'task' }, cfg.task))),
      panel.element,
    );
  }

  // -------------------------------------------------------------------------
  // The exercise
  // -------------------------------------------------------------------------
  function build(sing) {
    for (const fn of cleanupFns) { try { fn(); } catch { /* ignore */ } }
    cleanupFns = [];

    const KEY = isMatch ? (sing.SING_MATCH_KEY || 'sing-match') : (sing.SING_KEY || 'sing');
    const MOTION_SUPPORTED = !isMatch && (() => {
      const t = tasksOf('interval')[0];
      try { return !!t && sing.makeSingQuestion({ taskKey: t.key, motion: 'down' }).motion === 'down'; } catch { return false; }
    })();

    // ---- remembered choices
    let mode = getPref('sing.mode', 'interval');
    if (!MODES.some((m) => m.value === mode) || !tasksOf(mode).length) mode = 'interval';
    const savedTask = (m) => {
      const k = getPref(`sing.task.${m}`, null);
      if (tasksOf(m).some((t) => t.key === k)) return k;
      // Newcomers start on the easiest interval (the octave), not the first in size order.
      if (m === 'interval' && tasksOf(m).some((t) => t.key === 'octave')) return 'octave';
      return tasksOf(m)[0].key;
    };
    let taskKey = isMatch ? 'match' : savedTask(mode);
    let motionPref = getPref('sing.motion', 'up');
    if (!MOTION_OPTIONS.some((o) => o.value === motionPref)) motionPref = 'up';
    let showGuide = getPref('sing.showGuide', false) === true;
    let keepSounding = getPref('singBack.keepSounding', false) === true;

    // ---- state
    let question = null;
    let state = 'ready';       // ready | listening | singing | analyzing | retry | answered
    let mic = null;
    let micOpening = false;
    let sustain = null;
    let refTimer = 0;
    let pressed = false;       // the hold button / Space is down right now
    let recT0 = 0;
    let take = [];
    let buffer = null;
    let analysis = null;
    let result = null;
    let rows = [];

    const targetFreq = () => question.target.targetFreq;
    const fixedFreqs = () => question.fixedTones.map((t) => t.freq);

    // ---- pieces
    const statusLine = el('p', { class: 'stage-status', role: 'status' });
    statusLine.hidden = true;
    const setStatus = (text, isError = false) => {
      statusLine.textContent = text || '';
      statusLine.hidden = !text;
      statusLine.classList.toggle('is-error', !!isError);
    };
    const player = createPlayer({ onChange: (s) => { if (s.error) setStatus(s.error, true); } });

    const trace = createTrace({ seconds: TRACE_SECONDS });
    const micLevel = el('span', { class: 'mic-level', 'aria-hidden': 'true' }, el('span'));
    const recDot = el('span', { class: 'rec-dot' }, 'Recording');
    const yourName = el('strong', { class: 'sing-name' });
    // "Hold to sing": records and analyses only while held (pointer or Space). It stays in
    // place during the take (pointer capture), so a small finger slip does not end it.
    const holdLabel = el('span', {}, 'Hold to sing');
    const holdBtn = el('button', {
      type: 'button',
      class: 'btn btn-sing btn-hold',
      'aria-label': 'Hold to sing: keep pressing while you sing, let go when you are done',
    }, icon('mic', { size: 22 }), holdLabel, kbd('hold Space'));
    holdBtn.addEventListener('pointerdown', (e) => {
      if (e.button !== undefined && e.button !== 0) return;
      e.preventDefault();
      try { holdBtn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      press();
    });
    const releaseHold = () => release();
    holdBtn.addEventListener('pointerup', releaseHold);
    holdBtn.addEventListener('pointercancel', releaseHold);
    holdBtn.addEventListener('lostpointercapture', releaseHold);
    holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    holdBtn.addEventListener('click', (e) => e.preventDefault()); // keyboard "click" is handled via Space keydown/keyup

    const singHere = el('div', { class: 'sing-here' },
      el('span', {}, 'sing here'),
      el('span', { class: 'small' }, 'Hold the button below while you sing — let go when you are done.'));
    const waitHere = el('div', { class: 'sing-here is-waiting' }, el('span', { class: 'small' }, 'Press Start first, then sing here'));
    const yourCell = el('div', { class: 'sing-cell' });

    const holdFill = el('span', { class: 'hold-fill' });
    const holdText = el('span', { class: 'small' });
    const hold = el('div', { class: 'hold', 'aria-live': 'polite' },
      el('span', { class: 'hold-track' }, holdFill), holdText);

    const stopBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => stopReference() });
    const againBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => playReference() },
      icon('repeat', { size: 16 }), isMatch ? 'Hear the note again' : 'Play the notes again');
    const controls = el('div', { class: 'btn-row sound-row' }, stopBtn, againBtn);

    const feedback = createFeedback();
    const compare = el('div', { class: 'compare', role: 'group', 'aria-label': 'Compare' });
    const resultRank = el('p', { class: 'task-rank-line' });
    const octaveNote = el('p', { class: 'small muted center octave-note' }, 'Any octave counts — singing it an octave lower or higher is fine.');
    const next = nextButton({ onClick: () => nextQuestion(true) });
    const after = el('div', { class: 'after-answer' }, compare, resultRank, octaveNote, next);
    const startBtn = createPlayButton({ onClick: () => start(), label: 'Start', shortcut: 'Enter' });
    const score = el('div', { class: 'score tscore sscore', role: 'group', 'aria-label': 'The notes' });

    // ---- lighting
    function lightUp(keys) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keys.has(r.idx));
    }
    function lightSustain() {
      const on = new Set();
      if (sustain) {
        if (isMatch) on.add(-1);
        else question.fixedTones.forEach((t, i) => on.add(i));
      }
      lightUp(on);
    }

    // ---- reference sound (fixed notes / the note)
    async function soundReady() {
      const ready = engine.initAudio();
      try {
        await ready;
        const s = getSettings();
        engine.setMasterVolume(s.volume);
        if (typeof engine.setReverb === 'function') engine.setReverb(s.reverb);
      } catch (err) { console.error(err); return false; }
      const timbre = getSettings().timbre;
      if (needsLoading(timbre)) {
        setStatus('Loading sound…');
        if (!(await ensureTimbre(timbre))) { setStatus('This sound could not be loaded. Try another sound in Settings.', true); return false; }
        setStatus('');
      }
      return true;
    }

    function stopReference() {
      clearTimeout(refTimer);
      if (sustain) { try { sustain.stop(); } catch { /* ignore */ } sustain = null; }
      lightSustain();
      syncUi();
    }

    async function playReference() {
      player.stop();
      stopReference();
      if (!(await soundReady()) || destroyed || !question) return;
      const freqs = isMatch ? [targetFreq()] : fixedFreqs();
      if (!freqs.length) return;
      sustain = engine.startSustain(freqs, { timbre: getSettings().timbre, maxDuration: 60 });
      const h = sustain;
      if (h && h.done) h.done.then(() => { if (sustain === h) { sustain = null; lightSustain(); syncUi(); } });
      // "Sing it back" from memory: the note plays for a moment, then stops.
      if (isMatch && !keepSounding) {
        refTimer = setTimeout(() => { if (state !== 'singing') stopReference(); }, REFERENCE_SECONDS * 1000);
      }
      lightSustain();
      syncUi();
    }

    // ---- microphone: frames are only used while the button is held
    function onFrame(f) {
      if (state !== 'singing') return; // not held: nothing is analysed or kept
      if (recT0 === null) recT0 = f.time;
      const time = f.time - recT0;
      take.push({ ...f, time });
      if (f.freq && f.clarity >= 0.6) trace.add(time, foldedCents(f.freq, targetFreq()));
      const lvl = Math.min(1, Math.sqrt(Math.max(0, f.rms || 0)) * 2.4);
      micLevel.firstChild.style.height = `${Math.round(lvl * 100)}%`;
      holdFill.style.width = `${Math.min(100, (time / ENOUGH_SECONDS) * 100)}%`;
      if (time >= ENOUGH_SECONDS) {
        holdText.textContent = 'That\'s enough — let go when ready';
        hold.classList.add('is-enough');
      } else {
        holdText.textContent = `${time.toFixed(1)} s — keep holding`;
      }
      if (time >= MAX_SECONDS) release(); // safety stop
    }

    // The stream is opened on the first press of this visit and kept open while you stay on
    // the tab (so later takes start instantly); it is closed when you leave the tab.
    async function ensureMic() {
      if (mic) return true;
      if (micOpening) return false;
      micOpening = true;
      try {
        mic = await openMic({ onFrame: (f) => { if (!destroyed) onFrame(f); } });
        micStatus.textContent = 'Microphone ready';
        micStatus.className = 'mic-status is-on';
        return true;
      } catch (err) {
        setStatus(micErrorHelp(err), true);
        return false;
      } finally {
        micOpening = false;
      }
    }

    function releaseMic() {
      if (mic) { try { mic.stop(); } catch { /* ignore */ } mic = null; }
      micStatus.textContent = micSetupDone() ? 'Microphone set up' : 'Microphone off';
      micStatus.className = 'mic-status';
    }

    // ---- flow
    function start() {
      if (state !== 'ready') return;
      playReference(); // starts inside the click
      state = 'listening';
      setStatus('');
      syncUi();
      holdBtn.focus({ preventScroll: true });
    }

    // Press: start recording (opening the mic first if needed). Release: analyse.
    async function press() {
      if (pressed || (state !== 'listening')) return;
      pressed = true;
      setStatus('');
      if (!mic) {
        holdLabel.textContent = 'Starting the microphone…';
        const ok = await ensureMic();
        holdLabel.textContent = 'Hold to sing';
        if (!ok || destroyed) { pressed = false; syncUi(); return; }
        if (!pressed) return; // let go before the microphone was ready
      }
      if (isMatch && sustain && !keepSounding) stopReference(); // from memory: the note stops
      state = 'singing';
      take = [];
      trace.reset();
      trace.setGuide(showGuide ? [{ cents: 0, kind: 'guide' }] : null);
      recT0 = null; // the first frame of the take sets time zero
      setMicActive(mic, true);
      try { mic.startRecording(); } catch (err) { console.error(err); }
      holdFill.style.width = '0%';
      hold.classList.remove('is-enough');
      holdText.textContent = 'Keep holding while you sing…';
      syncUi();
    }

    function release() {
      if (!pressed) return;
      pressed = false;
      if (state === 'singing') finishTake();
    }

    async function finishTake() {
      if (state !== 'singing') return;
      state = 'analyzing';
      syncUi();
      setMicActive(mic, false);
      try { buffer = await mic.stopRecording(); } catch (err) { console.error(err); buffer = null; }
      try {
        analysis = sing.analyzeTake(take, { targetFreq: targetFreq() });
      } catch (err) {
        console.error(err);
        analysis = { ok: false, reason: 'Something went wrong while listening. Please try again.' };
      }
      if (!analysis || !analysis.ok) {
        // Too short / no clear voice: say why, record nothing, and let them hold again.
        state = 'listening';
        setStatus((analysis && analysis.reason) || 'We could not hear a steady note — hold the button for 2–3 seconds while you sing.');
        trace.showResult({ points: tracePoints(), bands: [] });
        syncUi();
        return;
      }
      stopReference();      result = sing.evaluateSing(question, analysis);
      try { sing.recordSingResult(KEY, taskKey, result); } catch (err) { console.error(err); }
      state = 'answered';
      showResult();
      syncUi();
      next.focus();
    }

    const tracePoints = () => take.filter((f) => f.freq && f.clarity >= 0.6)
      .map((f) => ({ time: f.time, cents: foldedCents(f.freq, targetFreq()) }));

    function bands() {
      if (isMatch) return [{ cents: 0, label: 'the note', kind: 'pure' }];
      const pure = centsBetween(targetFreq(), question.target.justFreq);
      const piano = centsBetween(targetFreq(), question.target.equalFreq);
      if (Math.abs(pure - piano) <= 3) return [{ cents: pure, label: 'in tune', kind: 'pure' }];
      return [{ cents: pure, label: 'pure', kind: 'pure' }, { cents: piano, label: 'piano', kind: 'piano' }];
    }

    function showResult() {
      trace.showResult({ points: tracePoints(), steadyStart: analysis.steadyStart, steadyEnd: analysis.steadyEnd, bands: bands() });
      const good = result.rating === 'excellent' || result.rating === 'good';
      // The logic's message ends with the steadiness sentence; show that as its own line.
      let message = String(result.message || '');
      let steady = '';
      if (typeof sing.steadinessSentence === 'function' && Number.isFinite(analysis.steadinessCents)) {
        const s = sing.steadinessSentence(analysis.steadinessCents);
        if (s && message.includes(s)) {
          message = message.replace(s, '').replace(/\s{2,}/g, ' ').trim();
          steady = s;
        }
      }
      feedback.show({
        correct: good,
        close: result.rating === 'close',
        message,
        details: steady ? el('p', { class: 'feedback-note' }, steady) : null,
      });
      // Note names in the rows (fixed beside the padlocks, yours over the trace).
      for (const r of rows) {
        if (r.fixed) r.nameEl.textContent = prettyNote(describeFreq(question.fixedTones[r.idx].freq));
      }
      const sung = describeFreq(analysis.rawFreq || analysis.sungFreq);
      yourName.textContent = sung ? `You sang ${prettyNote(sung)}` : '';
      // Compare buttons
      const canPlayback = buffer && typeof engine.playRecordingWith === 'function';
      const btns = [];
      if (canPlayback) {
        btns.push(el('button', {
          type: 'button',
          class: 'btn btn-compare btn-yours',
          onclick: () => playCompare(() => engine.playRecordingWith(buffer, isMatch ? [] : fixedFreqs(), { timbre: getSettings().timbre })),
        }, icon('play', { size: 18 }),
        isMatch ? 'Hear yourself' : question.fixedTones.length > 1 ? 'Hear yourself with the chord' : 'Hear yourself with the other note',
        kbd('1')));
        if (isMatch) {
          btns.push(el('button', {
            type: 'button',
            class: 'btn btn-compare',
            onclick: () => playCompare(() => engine.playRecordingWith(buffer, [targetFreq()], { timbre: getSettings().timbre })),
          }, icon('play', { size: 18 }), 'Hear yourself with the note', kbd('2')));
        }
      }
      if (isMatch) {
        btns.push(el('button', { type: 'button', class: 'btn btn-compare btn-pure', onclick: () => playCompare(() => engine.playTone(targetFreq(), { duration: COMPARE_SECONDS, timbre: getSettings().timbre })) },
          icon('play', { size: 18 }), 'Hear the note', kbd(canPlayback ? '3' : '1')));
      } else {
        const pianoBand = bands()[1];
        const chord = (f) => () => engine.playChord([...fixedFreqs(), f], { duration: COMPARE_SECONDS, timbre: getSettings().timbre });
        btns.push(el('button', { type: 'button', class: 'btn btn-compare btn-pure', onclick: () => playCompare(chord(question.target.justFreq)) },
          icon('play', { size: 18 }), pianoBand ? 'Pure' : 'In tune', kbd(canPlayback ? '2' : '1')));
        if (pianoBand) {
          btns.push(el('button', { type: 'button', class: 'btn btn-compare btn-piano', onclick: () => playCompare(chord(question.target.equalFreq)) },
            icon('play', { size: 18 }), 'Piano', kbd(canPlayback ? '3' : '2')));
        }
      }
      setChildren(compare, btns);
      renderRanks();
      progressPanel.update();
    }

    function playCompare(makeHandle) {
      stopReference();
      player.play([{ start: makeHandle }]);
    }

    // ---- score rows
    function buildScore() {
      const tones = isMatch
        ? [{ label: 'Your note', freq: targetFreq(), idx: -1, fixed: false }]
        : [
          ...question.fixedTones.map((t, i) => ({ label: t.label, freq: t.freq, idx: i, fixed: true })),
          { label: question.target.label, freq: targetFreq(), idx: question.fixedTones.length, fixed: false },
        ].sort((a, b) => b.freq - a.freq);
      rows = tones.map((t) => {
        const nameEl = t.fixed ? el('span', { class: 'tscore-name' }) : null;
        const head = t.fixed
          ? el('button', {
            type: 'button',
            class: 'score-head-btn',
            'aria-label': `Listen: hear the ${t.label.toLowerCase()} alone`,
            title: `Hear the ${t.label.toLowerCase()} alone`,
            onclick: () => playCompare(() => engine.playTone(t.freq, { duration: 1.6, timbre: getSettings().timbre })),
          }, el('span', { class: 'score-head', 'aria-hidden': 'true' }))
          : el('span', { class: 'score-head-btn is-static', 'aria-hidden': 'true' }, el('span', { class: 'score-head' }));
        const row = el('div', { class: `score-row tscore-row ${t.fixed ? 'is-fixed' : 'is-target'}` },
          el('div', { class: 'score-note' },
            el('span', { class: 'score-verdict' }, t.fixed ? 'fixed' : 'your note'),
            head,
            t.fixed ? icon('lock', { size: 18, class: 'tscore-lock', label: `${t.label}: fixed note` }) : null,
            el('span', { class: 'score-label' }, t.label),
          ),
          t.fixed ? nameEl : yourCell,
        );
        return { idx: t.idx, fixed: t.fixed, row, nameEl };
      });
      setChildren(score, rows.map((r) => r.row));
    }

    function renderYourCell() {
      if (state === 'ready') setChildren(yourCell, waitHere);
      else if (state === 'listening') setChildren(yourCell, singHere);
      else setChildren(yourCell, micLevel, state === 'singing' ? recDot : null, trace.element, state === 'answered' ? yourName : null);
      yourCell.classList.toggle('is-live', state === 'singing');
    }

    function syncUi() {
      startBtn.element.hidden = state !== 'ready';
      renderYourCell();
      hold.hidden = state !== 'singing';
      holdBtn.hidden = !(state === 'listening' || state === 'singing' || state === 'analyzing');
      holdBtn.disabled = state === 'analyzing';
      holdBtn.classList.toggle('is-held', state === 'singing');
      controls.hidden = !(state === 'listening' || state === 'singing');
      setChildren(stopBtn, icon('square', { size: 16 }), 'Stop sound');
      stopBtn.hidden = !sustain;
      againBtn.hidden = state !== 'listening';
      after.hidden = state !== 'answered';
      if (state !== 'answered') feedback.clear();
      if (state === 'analyzing') setStatus('Listening back…');
      else if (statusLine.textContent === 'Listening back…') setStatus('');
    }

    // ---- choosing tasks / modes (missing note only)
    const pickerHolder = el('div', { class: 'task-picker' });
    const taskInputs = [];
    const taskBadges = new Map();
    const pickerName = `sing-task-${Math.random().toString(36).slice(2, 8)}`;
    function buildPicker() {
      if (isMatch) return;
      const picker = taskChips({
        tasks: tasksOf(mode),
        mode,
        value: taskKey,
        legend: mode === 'interval' ? 'Interval' : 'Note to sing',
        onChoose: (k) => chooseTask(k),
      });
      taskInputs.length = 0;
      taskInputs.push(...picker.inputs);
      taskBadges.clear();
      for (const [k, b] of picker.badges) taskBadges.set(k, b);
      setChildren(pickerHolder, picker.element);
      motionHolder.hidden = !(MOTION_SUPPORTED && mode === 'interval');
    }
    const motionSeg = segmented({
      name: 'sing-motion', legend: 'Direction', compact: true, options: MOTION_OPTIONS, value: motionPref,
      onChange: (v) => { motionPref = v; setPref('sing.motion', v); resetQuestion(); },
    });
    const motionHolder = el('div', { class: 'motion-holder' }, motionSeg.element);
    const nextMotion = () => {
      if (!MOTION_SUPPORTED || mode !== 'interval') return 'up';
      return motionPref === 'mixed' ? (Math.random() < 0.5 ? 'up' : 'down') : motionPref;
    };
    const modeSeg = isMatch ? null : segmented({
      name: 'sing-mode', legend: 'Mode', hideLegend: true, options: MODES, value: mode,
      onChange: (v) => {
        mode = v;
        setPref('sing.mode', v);
        taskKey = savedTask(v);
        buildPicker();
        resetQuestion();
        progressPanel.update();
      },
    });
    function chooseTask(key) {
      taskKey = key;
      setPref(`sing.task.${mode}`, key);
      resetQuestion();
    }
    const taskDesc = el('p', { class: 'task-desc' });
    let tuningTag = tagLink({ href: '#/settings', label: tuningTagLabel(getSettings().tuning), title: 'Change tuning in Settings' });
    const tagHolder = el('span', { class: 'tag-holder' }, tuningTag);
    const updateTag = (t) => {
      const fresh = tagLink({ href: '#/settings', label: tuningTagLabel(t), title: 'Change tuning in Settings' });
      tuningTag.replaceWith(fresh);
      tuningTag = fresh;
    };

    // ---- switches: show guide, keep the note sounding (Sing it back)
    function switchEl(id, label, checked, onChange) {
      const input = el('input', { type: 'checkbox', role: 'switch', id });
      input.checked = checked;
      input.addEventListener('change', () => onChange(input.checked));
      return el('label', { class: 'switch', for: id }, input, el('span', { class: 'switch-track', 'aria-hidden': 'true' }), el('span', {}, label));
    }
    const guideSwitch = switchEl(`${pickerName}-guide`, 'Show guide', showGuide, (v) => {
      showGuide = v;
      setPref('sing.showGuide', v);
      if (state === 'singing') trace.setGuide(v ? [{ cents: 0, kind: 'guide' }] : null);
    });
    const keepSwitch = isMatch ? switchEl(`${pickerName}-keep`, 'Keep the note sounding while I sing', keepSounding, (v) => {
      keepSounding = v;
      setPref('singBack.keepSounding', v);
    }) : null;

    // ---- mic status + "Check microphone"
    const micStatus = el('span', { class: 'mic-status' }, micSetupDone() ? 'Microphone set up' : 'Microphone off');
    const micBar = el('div', { class: 'mic-bar' },
      icon('mic', { size: 16 }), micStatus,
      el('button', { type: 'button', class: 'btn-link-inline', onclick: () => { teardown(); showSetup(sing, { back: true }); } }, 'Check microphone'),
      fakeMicEnabled() ? el('span', { class: 'badge' }, 'test microphone') : null,
    );

    // ---- ranks + progress
    const chip = el('div', { class: 'level' });
    const statsNow = () => {
      try { return typeof sing.getSingStats === 'function' ? sing.getSingStats(KEY) : null; } catch { return null; }
    };
    function renderRanks() {
      const stats = statsNow();
      for (const [key, badge] of taskBadges) {
        const r = stats ? rankFor(KEY, stats, { taskKey: key }) : null;
        badge.textContent = r ? r.name : '–';
        badge.className = `task-rank${r ? '' : ' is-none'}`;
      }
      const t = stats && stats.perTask ? (stats.perTask[taskKey] || null) : null;
      const src = t || stats;
      const r = stats ? (isMatch ? rankFor(KEY, stats) : rankFor(KEY, stats, { taskKey })) : null;
      const attempts = src ? src.attempts || 0 : 0;
      const parts = [];
      if (attempts > 0 && src && Number.isFinite(src.recentAvgAbsError)) parts.push(`avg ${centsText(src.recentAvgAbsError)} off`);
      const m = src && src.meanSignedError;
      if (Number.isFinite(m) && Math.abs(m) >= 4) parts.push(m > 0 ? 'you tend to sing a little sharp' : 'you tend to sing a little flat');
      if (!parts.length) parts.push(attempts ? `${attempts} ${attempts === 1 ? 'try' : 'tries'}` : 'Smaller numbers are better');
      const name = isMatch ? 'Echo' : (tuneIt.TUNE_TASKS.find((x) => x.key === taskKey) || {}).label;
      setChildren(chip,
        el('div', { class: 'level-main' }, el('span', { class: 'level-label' }, `${name}: `), el('strong', {}, r ? r.name : attempts ? 'no rank yet' : 'new')),
        el('div', { class: 'level-sub' }, parts.join(' · ')));
      if (r) {
        setChildren(resultRank, el('span', { class: 'muted' }, `${name} rank:`), ' ', el('span', { class: 'task-rank' }, r.name), ' ',
          r.nextName && Number.isFinite(r.nextAtCents)
            ? el('span', { class: 'muted small' }, `next: ${r.nextName} at ${centsText(r.nextAtCents)} or less`)
            : el('span', { class: 'muted small' }, 'top rank — wonderful!'));
      } else {
        setChildren(resultRank, el('span', { class: 'muted small' }, 'Your rank appears after a few more tries.'));
      }
    }
    const progressPanel = createProgressPanel({
      what: cfg.title,
      onReset: () => { progress.resetProgress(KEY); renderRanks(); },
      read: () => {
        const stats = statsNow() || { attempts: 0, perTask: {}, history: [] };
        const bests = Object.values(stats.perTask || {}).map((t) => t.bestAbsError).filter(Number.isFinite);
        return {
          rank: safeRank(KEY, stats),
          noData: !(stats.attempts > 0),
          best: bests.length ? Math.min(...bests) : null,
          bestLabel: 'Closest note',
          bestNote: bests.length ? 'Your most accurate take.' : 'Appears after your first take.',
          extra: isMatch ? null : el('div', { class: 'task-ranks' },
            el('p', { class: 'insight-group-title' }, `Rank per task — ${MODES.find((x) => x.value === mode).label.toLowerCase()}`),
            el('ul', { class: 'task-rank-list' }, tasksOf(mode).map((t) => {
              const rr = rankFor(KEY, stats, { taskKey: t.key });
              const pt = stats.perTask ? stats.perTask[t.key] : null;
              return el('li', {}, el('span', { class: 'task-rank-name' }, shortLabel(t)),
                el('span', { class: `task-rank${rr ? '' : ' is-none'}` }, rr ? rr.name : '–'),
                el('span', { class: 'muted small' }, pt && pt.attempts > 0 && Number.isFinite(pt.recentAvgAbsError) ? `avg ${centsText(pt.recentAvgAbsError)} off` : 'not tried yet'));
            }))),
          caption: 'Average distance from in tune, per day (lower = better)',
          unit: 'cents',
          points: (stats.history || []).filter((h) => h && h.avgAbsError != null)
            .map((h) => ({ date: h.date, value: Number(h.avgAbsError), note: `${h.attempts} ${h.attempts === 1 ? 'take' : 'takes'}` })),
          empty: 'Sing a few notes to see your progress here.',
          insights: safeInsights(KEY),
        };
      },
    });

    // ---- question lifecycle
    function newQuestion() {
      const s = getSettings();
      question = isMatch
        ? sing.makeMatchQuestion({ voicePart: voiceArg(s) })
        : sing.makeSingQuestion({ taskKey, tuning: s.tuning, voicePart: voiceArg(s), motion: nextMotion() });
      setFakeTarget(targetFreq());
      state = 'ready';
      analysis = null;
      result = null;
      buffer = null;
      take = [];
      trace.reset();
      yourName.textContent = '';
      if (!isMatch) {
        const task = tuneIt.TUNE_TASKS.find((t) => t.key === taskKey);
        setChildren(taskDesc, task ? [el('strong', {}, task.label), ' — ', singDescription(task, question.motion)] : []);
        for (const input of taskInputs) input.checked = input.value === taskKey;
      } else {
        taskDesc.textContent = 'A note plays. Then sing it back and hold it steady for about 3 seconds.';
      }
      buildScore();
      setStatus('');
      updateTag(s.tuning);
      renderRanks();
      syncUi();
    }

    function resetQuestion() {
      player.stop();
      stopReference();
      newQuestion();
    }

    async function nextQuestion(autostart) {
      resetQuestion();
      reveal(screen, startBtn.element);
      if (autostart) start();
    }

    function teardown() {
      player.stop();
      stopReference();
      releaseMic();
    }
    onCleanup(() => { teardown(); player.destroy(); });

    // ---- keyboard: hold Space to sing (keydown starts, keyup stops; auto-repeat ignored)
    const typing = (t) => t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const holdActive = () => state === 'listening' || state === 'singing' || pressed;
    function onSpaceDown(e) {
      if (e.key !== ' ' || typing(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!holdActive()) return;
      e.preventDefault(); // no page scroll, no button "click"
      e.stopPropagation();
      if (!e.repeat) press();
    }
    function onSpaceUp(e) {
      if (e.key !== ' ' || !pressed) return;
      e.preventDefault();
      e.stopPropagation();
      release();
    }
    document.addEventListener('keydown', onSpaceDown, true);
    document.addEventListener('keyup', onSpaceUp, true);
    const onBlur = () => release(); // switching windows mid-take ends it
    window.addEventListener('blur', onBlur);
    onCleanup(() => {
      document.removeEventListener('keydown', onSpaceDown, true);
      document.removeEventListener('keyup', onSpaceUp, true);
      window.removeEventListener('blur', onBlur);
    });
    const removeShortcuts = installShortcuts((e) => {
      const k = e.key;
      if (state === 'answered' && ['1', '2', '3'].includes(k)) {
        const b = compare.querySelectorAll('button')[Number(k) - 1];
        if (b) { b.click(); return true; }
      }
      if (k === 'Enter' || k === ' ') {
        if (state === 'ready') { start(); return true; }
        if (state === 'answered') { nextQuestion(true); return true; }
      }
      return false;
    });
    onCleanup(removeShortcuts);
    const unsub = onSettingsChange((s) => updateTag(s.tuning));
    onCleanup(unsub);

    // ---- layout
    buildPicker();
    setChildren(screen,
      el('div', { class: 'screen-head' },
        el('div', {}, el('h1', {}, cfg.title), el('p', { class: 'task' }, cfg.task)),
        chip,
      ),
      modeSeg ? el('div', { class: 'mode-row' }, modeSeg.element) : null,
      isMatch ? null : el('div', { class: 'options-row' }, pickerHolder, motionHolder, tagHolder),
      taskDesc,
      el('div', { class: 'options-row sing-options' }, keepSwitch, guideSwitch, micBar),
      el('div', { class: 'stage' },
        startBtn.element,
        statusLine,
        score,
        hold,
        controls,
        holdBtn,
        feedback.element,
        after,
      ),
      helpBox({ summary: 'How it works' },
        isMatch
          ? el('p', {}, 'Press Start: a note plays for a moment. Then hold the "Hold to sing" button (or the Space bar) while you sing it back, and let go after 2–3 steady seconds. Nothing is recorded unless you hold the button. Turn on "Keep the note sounding" to sing along with it instead of from memory.')
          : el('p', {}, 'Press Start: the fixed note(s) sound. Then hold the "Hold to sing" button (or the Space bar) while you sing the missing note, and let go after 2–3 steady seconds. Nothing is recorded unless you hold the button.'),
        el('p', {}, 'Your pitch is drawn as a line while you sing. There is no target line, so you tune by ear; "Show guide" adds a band where the note should be. Afterwards you see the line with the target band(s); the shaded part is the steady stretch that was measured (the first scoop into the note is ignored).'),
        el('p', {}, 'Any octave counts. Headphones help a lot: otherwise the microphone also hears the app\'s notes. The sound is analysed on this device only.'),
        el('p', { class: 'muted small' }, 'Keys: Enter = start / next. Hold Space = sing. After the result: 1, 2, 3 = the listening buttons.'),
      ),
      progressPanel.element,
    );
    newQuestion();
  }

  return () => {
    destroyed = true;
    for (const fn of cleanupFns) { try { fn(); } catch { /* ignore */ } }
    cleanupFns = [];
  };
}
