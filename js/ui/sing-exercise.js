// The singing exercise screen, shared by "Echo" (kind 'match': sing the note you heard) and
// "Join the chord" (kind 'missing': intervals / chords, like Lock it in, but you sing).
// Score-style layout: fixed notes with padlocks, your row with "sing here" and a live pitch trace.
//
// Interaction model (docs/reviews/INTERACTION-DESIGN.md 2, 8, 9; ACCESSIBILITY 1, 7, 8, 9):
//   Ready ─Start─► Arming (the microphone opens from the Start click) ─► Armed ⇄ Recording ─► Checking ─► Feedback
//   Recording: hold the button / Space (main mode), or tap to start + tap to stop (screen readers, voice
//   control, switch access: a click without a held pointer), or "Hands-free" (3-2-1 count-in, stops by itself).
//   A tap (< 0.5 s) or Esc goes back to Armed. Page hidden / sound interrupted → Paused. Microphone lost →
//   "The microphone stopped…" + Reconnect.

import * as tuneIt from '../exercise/tune-it.js';
import * as progress from '../exercise/progress.js';
import * as engine from '../audio/engine.js';
import { INTERVALS, centsBetween } from '../music/tuning.js';
import { getSettings, onSettingsChange, getPref, setPref } from '../storage.js';
import { el, setChildren, centsText } from './dom.js';
import { icon } from './icons.js';
import { segmented, helpBox, kbd, refocusAfterPointerChange } from './components.js';
import { createPlayButton } from './exercise.js';
import { createPlayer, needsLoading, ensureTimbre } from './player.js';
import { createProgressPanel } from './progress-panel.js';
import { safeRank, safeInsights } from './chapter-progress.js';
import { voiceArg } from './voices.js';
import { describeFreq } from './notes.js';
import { groupOf, shortTaskLabel, taskChips } from './task-labels.js';
import {
  loadSingModules, fakeMicEnabled, micSetupDone, micSetupPanel, micErrorNode, openMic,
  setFakeTarget, createTrace, foldedCents, setMicActive, IN_TUNE_ZONE, PRIVACY_TEXT,
  optionsSummary, actionBar, feedbackPanel, nextControl, compareSwitch, keyLegend, tipCard, sessionSummary,
  onPageHidden, pausedCard, onEscape, installScreenKeys, levelOf, rankTexts,
  stopAllSound, tuningLink, tuningWord, focusAndReveal, revealAll, switchControl, fitVisible, tryAgainButton, longShort, exerciseHead, getHandsFree, setHandsFree, reducedMotion,
} from './sing-common.js';

const ENOUGH_SECONDS = 2.5;      // the bar turns green: "That's enough — let go when ready"
const MIN_USEFUL_SECONDS = 2;    // a mark on the bar: the shortest recording that is really useful
const TAP_MS = 500;              // shorter holds are taps: explain how to hold
const TAP_HELP = "Keep pressing the button while you sing. Let go when you're done.";
const MAX_SECONDS = 15;          // safety stop (hold / tap-to-stop)
const HANDS_FREE_MAX_MS = 6000;  // hands-free: stops by itself at the latest after 6 s
const COUNT_IN_MS = 600;
const REFERENCE_SECONDS = 1.5;   // Echo from memory: how long the note plays first
const COMPARE_MAX_SECONDS = 8;
const CHECKING_AFTER_MS = 300;   // "Checking your note…" only when the analysis takes longer
const TRACE_SECONDS = 4;

/** The Lock it in task text, worded for singing (and turned round for descending intervals). */
function singDescription(task, motion) {
  if (motion === 'down') {
    const interval = INTERVALS[task.target];
    const name = interval ? interval.name.toLowerCase() : 'interval';
    const article = /^[aeiou]/.test(name) ? 'an' : 'a';
    return `The upper note is fixed. Sing the lower note exactly ${article} ${name} below it.`;
  }
  return task.description.replace(/\bTune\b/g, 'Sing').replace(/\btune\b/g, 'sing');
}

const MODES = [
  { value: 'interval', label: 'Interval training' },
  { value: 'chord', label: 'In a chord' },
];
const MOTION_OPTIONS = [
  { value: 'up', label: 'Ascending' },
  { value: 'down', label: 'Descending' },
  { value: 'mixed', label: 'Both' },
];
const MOTION_WORDS = { up: 'ascending', down: 'descending', mixed: 'both directions' };
const tasksOf = (mode) => tuneIt.TUNE_TASKS.filter((t) => groupOf(t) === mode);
const taskOf = (key) => tuneIt.TUNE_TASKS.find((t) => t.key === key) || null;

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
  const head = (chip) => exerciseHead({ title: cfg.title, task: cfg.task, taskShort: cfg.taskShort, chip });

  const screen = el('section', { class: 'screen exercise producing sing' },
    head(),
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
        el('p', { class: 'task' }, 'This exercise needs an app update. Reload the page to get it.'),
      );
      return;
    }
    if (!fakeMicEnabled() && typeof pitch.micSupported === 'function' && !pitch.micSupported()) {
      setChildren(screen,
        el('div', { class: 'soon-icon' }, icon('mic', { size: 32 })),
        el('h1', {}, cfg.title),
        micErrorNode({ code: 'unsupported' }),
      );
      return;
    }
    if (micSetupDone()) build(sing);
    else showSetup(sing);
  });

  function runCleanups() {
    for (const fn of cleanupFns) { try { fn(); } catch { /* ignore */ } }
    cleanupFns = [];
  }

  function showSetup(sing, { back = false } = {}) {
    runCleanups();
    const panel = micSetupPanel({
      onDone: () => { panel.destroy(); if (!destroyed) build(sing, { focusStart: true }); },
      onBack: back ? () => { panel.destroy(); if (!destroyed) build(sing, { focusStart: true }); } : undefined,
      title: back ? 'Check your microphone' : 'Before you sing',
    });
    onCleanup(() => panel.destroy());
    setChildren(screen, head(), panel.element);
    // Focus moves to the panel heading (it replaced the screen; focus would fall to the page).
    if (back) setTimeout(() => panel.focusTitle(), 0);
  }

  // -------------------------------------------------------------------------
  // The exercise
  // -------------------------------------------------------------------------
  function build(sing, { focusStart = false } = {}) {
    runCleanups();

    const KEY = isMatch ? (sing.SING_MATCH_KEY || 'sing-match') : (sing.SING_KEY || 'sing');
    const MOTION_SUPPORTED = !isMatch && (() => {
      const t = tasksOf('interval')[0];
      try { return !!t && sing.makeSingQuestion({ taskKey: t.key, motion: 'down' }).motion === 'down'; } catch { return false; }
    })();

    // ---- remembered choices (Join the chord starts "In a chord" for new users)
    let mode = getPref('sing.mode', 'chord');
    if (!MODES.some((m) => m.value === mode) || !tasksOf(mode).length) mode = tasksOf('chord').length ? 'chord' : 'interval';
    const savedTask = (m) => {
      const k = getPref(`sing.task.${m}`, null);
      if (tasksOf(m).some((t) => t.key === k)) return k;
      if (m === 'interval' && tasksOf(m).some((t) => t.key === 'octave')) return 'octave';
      if (m === 'chord' && tasksOf(m).some((t) => t.key === 'fifth-in-major')) return 'fifth-in-major';
      return tasksOf(m)[0].key;
    };
    let taskKey = isMatch ? 'match' : savedTask(mode);
    let motionPref = getPref('sing.motion', 'up');
    if (!MOTION_OPTIONS.some((o) => o.value === motionPref)) motionPref = 'up';
    let showGuide = getPref('sing.showGuide', false) === true;
    let keepSounding = getPref('singBack.keepSounding', false) === true;
    let handsFree = getHandsFree();

    // ---- state
    let question = null;
    let state = 'ready';       // ready | arming | armed | countin | recording | checking | answered | micerror
    let paused = false;
    let mic = null;
    let armToken = 0;
    let sustain = null;        // the reference (fixed notes / the note)
    let refTimer = 0;
    let refStoppedForTake = false;
    let recMode = 'hold';      // 'hold' | 'toggle' (tap to start / tap to stop) | 'handsfree'
    let pressT0 = 0;
    let recT0 = null;
    let take = [];
    let buffer = null;
    let analysis = null;
    let result = null;
    let rows = [];
    let countTimer = 0;
    let checkingTimer = 0;
    let armingTimer = 0;
    let enoughSaid = false;
    let lastPointerUp = 0;
    let compareHold = null;
    let recPlay = null;
    let compareToken = 0;
    let soundWasOn = false;
    let optionsChanged = false;
    let inertUntil = 0;
    const lowStreak = new Map();
    const tipShown = new Set();
    const guard = (ms = 400) => { inertUntil = performance.now() + ms; };
    const inert = () => performance.now() < inertUntil;

    const targetFreq = () => question.target.targetFreq;
    const fixedFreqs = () => question.fixedTones.map((t) => t.freq);
    const micBusy = () => ['arming', 'armed', 'countin', 'recording', 'checking', 'micerror'].includes(state);

    // ---- pieces
    const taskDesc = el('p', { class: 'task-desc' });
    const taskHelp = el('p', { class: 'pc-phone-only' }); // phones: the task description lives in "How it works"
    const statusLine = el('p', { class: 'stage-status', role: 'status' });
    let statusTimer = 0;
    const setStatus = (text, kind = '', ms = 0) => {
      clearTimeout(statusTimer);
      statusLine.textContent = text || '';
      statusLine.classList.toggle('is-warn', kind === 'warn');
      if (ms && text) statusTimer = setTimeout(() => setStatus(''), ms);
    };
    const player = createPlayer({ onChange: (s) => { if (s.error) setStatus(s.error, 'warn'); } });

    const trace = createTrace({ seconds: TRACE_SECONDS });
    const micLevel = el('span', { class: 'mic-level', 'aria-hidden': 'true' }, el('span'));
    const recDot = el('span', { class: 'rec-dot' }, 'Recording');
    const yourName = el('strong', { class: 'sing-name' });

    // ---- the hold / tap button, with its messages directly underneath
    const holdIcon = el('span', { class: 'pc-hold-icon' }, icon('mic', { size: 22 }));
    const holdLabel = el('span', { class: 'pc-hold-label' }, 'Hold to sing');
    const holdKbd = el('span', { class: 'pc-hold-kbd' });
    const holdBtn = el('button', { type: 'button', class: 'btn btn-sing btn-hold', 'aria-pressed': 'false' }, holdIcon, holdLabel, holdKbd);
    const holdMsg = el('p', { class: 'pc-hold-msg', role: 'status' });
    const milestone = el('span', { class: 'visually-hidden', role: 'status' });
    const holdFill = el('span', { class: 'hold-fill' });
    const holdText = el('span', { class: 'small' });
    const holdProg = el('div', { class: 'hold' },
      el('span', { class: 'hold-track' }, holdFill,
        el('span', { class: 'hold-mark', style: `left:${(MIN_USEFUL_SECONDS / ENOUGH_SECONDS) * 100}%`, title: 'About 2 seconds: long enough to measure' })),
      holdText);
    const micErrorText = el('div', {});
    const micErrorBtn = el('button', { type: 'button', class: 'btn btn-small btn-primary', onclick: () => arm() });
    const micErrorBox = el('div', { class: 'pc-mic-error', role: 'alert' }, micErrorText, micErrorBtn);
    micErrorBox.hidden = true;
    const holdBox = el('div', { class: 'pc-hold-box' }, micErrorBox, holdProg, holdBtn, holdMsg, milestone);

    let shakeTimer = 0;
    function holdMessage(text, kind = 'warn', { shake = false } = {}) {
      holdMsg.textContent = text || '';
      holdMsg.className = `pc-hold-msg${text && kind === 'warn' ? ' is-warn' : ''}`;
      if (shake && !reducedMotion()) {
        holdBtn.classList.remove('is-shake');
        void holdBtn.offsetWidth; // restart the animation
        holdBtn.classList.add('is-shake');
        clearTimeout(shakeTimer);
        shakeTimer = setTimeout(() => holdBtn.classList.remove('is-shake'), 320);
      }
    }

    holdBtn.addEventListener('pointerdown', (e) => {
      if (handsFree || (e.button !== undefined && e.button !== 0)) return;
      e.preventDefault();
      if (state !== 'armed') return;
      try { holdBtn.setPointerCapture(e.pointerId); } catch { /* older browsers */ }
      startRecording('hold');
    });
    holdBtn.addEventListener('pointerup', () => {
      if (handsFree) return;
      lastPointerUp = performance.now();
      releaseHold();
    });
    holdBtn.addEventListener('pointercancel', () => {
      if (!handsFree && state === 'recording' && recMode === 'hold') discardTake('Recording discarded.');
    });
    holdBtn.addEventListener('lostpointercapture', () => { if (!handsFree) releaseHold(); });
    holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
    // A click without a held pointer (keyboard Enter, screen readers, voice control, switch access)
    // toggles: first click starts, second click stops. Hands-free: every tap toggles.
    holdBtn.addEventListener('click', (e) => {
      if (!handsFree && e.detail !== 0 && performance.now() - lastPointerUp < 300) return; // the end of a hold
      tapToggle();
    });

    const singHereText = el('span', { class: 'small' });
    const singHere = el('div', { class: 'sing-here' }, el('span', {}, 'sing here'), singHereText);
    const waitHere = el('div', { class: 'sing-here is-waiting' }, el('span', { class: 'small' }, 'Press Start first, then sing here'));
    const yourCell = el('div', { class: 'sing-cell' });

    // ---- reference sound controls (during the round)
    const soundBtn = el('button', { type: 'button', class: 'btn btn-small pc-sound-toggle', 'aria-pressed': 'false',
      onclick: () => (sustain ? stopReference() : playReference()) });
    const againBtn = el('button', { type: 'button', class: 'btn btn-small', onclick: () => playReference() },
      icon('repeat', { size: 16 }), longShort(isMatch ? 'Hear the note again' : 'Play the notes again', 'Play again'), kbd('R'));
    const soundRow = el('div', { class: 'btn-row sound-row' }, soundBtn, againBtn);

    // ---- after the round
    const feedback = feedbackPanel();
    const compareHolder = el('div', { class: 'pc-compare-holder' });
    const resultRank = el('p', { class: 'task-rank-line' });
    const octaveNote = el('p', { class: 'small muted center octave-note' }, 'Any octave counts: singing it an octave lower or higher is fine.');
    const tipHolder = el('div', { class: 'pc-tip-holder' });
    const summary = sessionSummary({ every: 10, levelLabel: 'off by' });
    const summaryHolder = el('div', { class: 'pc-summary-holder' });
    // A tuning tip (sevenths) sits under the compare switch, so the feedback stays two lines at most.
    const resultTip = el('p', { class: 'small muted pc-result-tip' });
    const after = el('div', { class: 'after-answer' }, compareHolder, resultTip, tipHolder, resultRank, octaveNote, summaryHolder);
    const score = el('div', { class: 'score tscore sscore', role: 'group', 'aria-label': 'The notes' });

    // ---- primary actions
    const startBtn = createPlayButton({ onClick: () => start(), label: 'Start', shortcut: 'Enter' });
    const tryAgainBtn = tryAgainButton(() => tryAgain());
    const next = nextControl(() => nextQuestion());
    const bar = actionBar();
    let barMode = '';
    function paintBar() {
      const m = state === 'ready' ? 'ready' : state === 'answered' ? 'answered' : 'sing';
      if (m === barMode) return;
      barMode = m;
      if (m === 'ready') bar.set(startBtn.element);
      else if (m === 'answered') bar.set(tryAgainBtn, next.element);
      else bar.set(holdBox);
    }
    const keys = keyLegend();

    // ---- lighting
    function lightUp(keysOn) {
      for (const r of rows) r.row.classList.toggle('is-sounding', keysOn.has(r.idx));
    }
    function lightSustain() {
      const on = new Set();
      if (sustain || compareHold) {
        if (isMatch) on.add(-1);
        else question.fixedTones.forEach((t, i) => on.add(i));
      }
      if (compareHold && !isMatch) on.add(question.fixedTones.length);
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
      } catch (err) {
        console.error(err);
        setStatus("Sound can't start in this browser. Reload the page.", 'warn');
        return false;
      }
      const timbre = getSettings().timbre;
      if (needsLoading(timbre)) {
        setStatus('Loading sound…');
        if (!(await ensureTimbre(timbre))) { setStatus("This sound didn't load. Choose another sound in Settings.", 'warn'); return false; }
        setStatus('');
      }
      return true;
    }

    function stopReference() {
      clearTimeout(refTimer);
      if (sustain) { const h = sustain; sustain = null; try { h.stop(); } catch { /* ignore */ } }
      lightSustain();
      syncUi();
    }

    async function playReference() {
      player.stop();
      stopCompare();
      stopReference();
      refStoppedForTake = false;
      if (!(await soundReady()) || destroyed || !question || paused) return;
      const freqs = isMatch ? [targetFreq()] : fixedFreqs();
      if (!freqs.length || state === 'answered' || state === 'recording') return;
      const h = engine.startSustain(freqs, { timbre: getSettings().timbre, maxDuration: 60 });
      sustain = h;
      const ended = () => { if (sustain === h) { sustain = null; lightSustain(); syncUi(); } };
      if (h && typeof h.onEnd === 'function') h.onEnd(ended);
      else if (h && h.done) h.done.then(ended);
      // Echo from memory: the note plays for a moment, then stops.
      if (isMatch && !keepSounding) {
        refTimer = setTimeout(() => { if (state !== 'recording' && sustain === h) stopReference(); }, REFERENCE_SECONDS * 1000);
      }
      lightSustain();
      syncUi();
    }

    // ---- microphone: frames are only used while recording
    function onFrame(f) {
      if (state !== 'recording') return;
      if (recT0 === null) recT0 = f.time;
      const time = f.time - recT0;
      take.push({ ...f, time });
      if (f.freq && f.clarity >= 0.6) trace.add(time, foldedCents(f.freq, targetFreq()));
      const lvl = Math.min(1, Math.sqrt(Math.max(0, f.rms || 0)) * 2.4);
      micLevel.firstChild.style.height = `${Math.round(lvl * 100)}%`;
      const enoughAt = recMode === 'handsfree' ? HANDS_FREE_MAX_MS / 1000 : ENOUGH_SECONDS;
      holdFill.style.width = `${Math.min(100, (time / enoughAt) * 100)}%`;
      if (time >= ENOUGH_SECONDS) {
        holdProg.classList.add('is-enough');
        holdText.textContent = recMode === 'hold' ? "That's enough — let go when ready" : "That's enough — stop when ready";
        if (!enoughSaid) { enoughSaid = true; milestone.textContent = holdText.textContent; }
      } else {
        holdText.textContent = `${time.toFixed(1)} s`;
      }
      if (recMode === 'handsfree' && handsFreeShouldEnd(time)) { finishTake(); return; }
      if (time >= MAX_SECONDS) finishTake(); // safety stop
    }

    function handsFreeShouldEnd(time) {
      if (typeof sing.detectTakeEnd === 'function') {
        try { return !!sing.detectTakeEnd(take, { silenceMs: 700, minVoiceMs: 2000, maxMs: HANDS_FREE_MAX_MS }).end; } catch { /* fall back */ }
      }
      if (time * 1000 >= HANDS_FREE_MAX_MS) return true;
      const voiced = take.filter((x) => x.freq && x.clarity >= 0.85);
      if (!voiced.length) return false;
      const voicedMs = voiced.length * 20;
      return voicedMs >= 2000 && (time - voiced[voiced.length - 1].time) * 1000 >= 700;
    }

    function onMicEnded() {
      if (destroyed) return;
      mic = null;
      paintMicStatus();
      if (state === 'recording' || state === 'countin') abandonRecording();
      if (micBusy() && !paused) {
        showMicError({ code: 'ended' }, 'Reconnect');
      }
    }

    // Open the microphone from the Start click (Arming), so a permission prompt never interrupts a recording.
    async function arm() {
      if (paused || destroyed) return;
      micErrorBox.hidden = true;
      if (mic && !mic.ended) { state = 'armed'; syncUi(); return; }
      mic = null;
      const mine = ++armToken;
      state = 'arming';
      syncUi();
      clearTimeout(armingTimer);
      armingTimer = setTimeout(() => { if (state === 'arming') holdBtn.classList.add('is-busy'); }, 300);
      try {
        const m = await openMic({ onFrame: (f) => { if (!destroyed) onFrame(f); }, onEnded: () => onMicEnded() });
        if (mine !== armToken || destroyed || paused) { try { m.stop(); } catch { /* ignore */ } return; }
        mic = m;
        state = 'armed';
        holdMessage('');
      } catch (err) {
        if (mine !== armToken || destroyed) return;
        showMicError(err, 'Try again');
        return;
      } finally {
        clearTimeout(armingTimer);
        holdBtn.classList.remove('is-busy');
      }
      paintMicStatus();
      syncUi();
      const a = document.activeElement;
      if (!a || a === document.body || !a.isConnected) focusAndReveal(holdBtn, score);
    }

    function showMicError(err, buttonLabel) {
      state = 'micerror';
      micBlocked = !!err && err.code === 'denied';
      paintMicStatus();
      setChildren(micErrorText, micErrorNode(err));
      setChildren(micErrorBtn, icon('mic', { size: 16 }), buttonLabel);
      micErrorBox.hidden = false;
      syncUi();
      focusAndReveal(micErrorBtn, micErrorBox);
    }

    function releaseMic() {
      armToken += 1;
      if (mic) { try { mic.stop(); } catch { /* ignore */ } mic = null; }
      paintMicStatus();
    }

    // ---- recording
    function startRecording(kind) {
      if (state !== 'armed' && state !== 'countin') return;
      if (!mic || paused) return;
      clearTimeout(countTimer);
      recMode = kind;
      pressT0 = performance.now();
      holdMessage('');
      milestone.textContent = '';
      enoughSaid = false;
      // Echo from memory: the note stops while you sing.
      if (isMatch && sustain && !keepSounding) { stopReference(); refStoppedForTake = true; }
      state = 'recording';
      take = [];
      trace.reset();
      trace.setGuide(showGuide ? guideBands() : null);
      recT0 = null;
      setMicActive(mic, true);
      try { mic.startRecording(); } catch (err) { console.error(err); }
      holdFill.style.width = '0%';
      holdProg.classList.remove('is-enough');
      holdText.textContent = '0.0 s';
      syncUi();
      // The live trace must stay visible above the (now taller) sticky bar on phones.
      setTimeout(() => revealAll(yourCell), 0);
    }

    function releaseHold() {
      if (state === 'recording' && recMode === 'hold') finishTake(performance.now() - pressT0);
    }

    function tapToggle() {
      if (paused || inert()) return;
      if (state === 'armed') {
        if (handsFree) countIn();
        else startRecording('toggle');
      } else if (state === 'countin') {
        cancelCountIn();
      } else if (state === 'recording') {
        finishTake();
      }
    }

    function countIn() {
      state = 'countin';
      let n = 3;
      holdMessage('');
      const step = () => {
        if (state !== 'countin') return;
        if (n === 0) { startRecording('handsfree'); return; }
        holdLabel.textContent = String(n);
        tick();
        n -= 1;
        countTimer = setTimeout(step, COUNT_IN_MS);
      };
      syncUi();
      step();
    }
    function cancelCountIn() {
      clearTimeout(countTimer);
      if (state === 'countin') { state = 'armed'; syncUi(); }
    }
    function tick() {
      try {
        if (getSettings().volume <= 0 || typeof engine.playNotes !== 'function') return;
        engine.playNotes([{ freq: 1320, start: 0, duration: 0.05, gain: 0.12 }], { timbre: 'sine' });
      } catch { /* a missing tick is fine */ }
    }

    /** Stop recording and throw it away (no result). */
    function abandonRecording() {
      clearTimeout(countTimer);
      if (state === 'recording') {
        setMicActive(mic, false);
        try { if (mic) mic.stopRecording(); } catch { /* ignore */ }
      }
      take = [];
      trace.reset();
    }
    function discardTake(text) {
      if (state !== 'recording' && state !== 'countin') return;
      abandonRecording();
      state = 'armed';
      holdMessage(text, 'info');
      syncUi();
    }

    async function finishTake(heldMs = Infinity) {
      if (state !== 'recording') return;
      const mode = recMode;
      state = 'checking';
      syncUi();
      clearTimeout(checkingTimer);
      checkingTimer = setTimeout(() => { if (state === 'checking') holdMessage('Checking your note…', 'info'); }, CHECKING_AFTER_MS);
      setMicActive(mic, false);
      try { buffer = mic ? await mic.stopRecording() : null; } catch (err) { console.error(err); buffer = null; }
      if (destroyed || state !== 'checking') return;
      if (mode === 'hold' && heldMs < TAP_MS) {
        // A tap, not a hold: explain how the button works (nothing is measured or kept).
        clearTimeout(checkingTimer);
        state = 'armed';
        trace.reset();
        holdMessage(TAP_HELP, 'warn', { shake: true });
        if (refStoppedForTake) playReference();
        syncUi();
        return;
      }
      try {
        analysis = sing.analyzeTake(take, { targetFreq: targetFreq() });
      } catch (err) {
        console.error(err);
        analysis = { ok: false, code: null };
      }
      clearTimeout(checkingTimer);
      if (!analysis || !analysis.ok) {
        // Too short / no clear voice: say why, keep nothing, and let them sing again.
        state = 'armed';
        holdMessage(takeProblem(analysis), 'warn');
        trace.showResult({ points: tracePoints(), bands: [] });
        syncUi();
        return;
      }
      stopReference();
      result = sing.evaluateSing(question, analysis);
      state = 'answered';
      holdMessage('');
      const level = levelOf(result);
      try { sing.recordSingResult(KEY, question.taskKey || taskKey, result); } catch (err) { console.error(err); }
      summary.record({ levelCents: result.absError });
      showResult(level);
      maybeTip(level);
      syncUi();
      guard();
      next.guard(400);
      next.focusAfterFeedback(feedback.element.id, ...fitVisible(isMatch ? yourCell : score, feedback.element, compareHolder));
    }

    function takeProblem(a) {
      const code = a && a.code;
      const verb = handsFree ? 'tap' : 'hold';
      if (code === 'too-short') {
        return handsFree ? 'That was too short to measure. Tap, then sing for 2–3 seconds.'
          : 'That was too short to measure. Hold the button and sing for 2–3 seconds.';
      }
      if (code === 'no-voice') return `We didn't hear your voice. Check the microphone, then ${verb} and sing again.`;
      return handsFree ? "We couldn't measure that. Tap and sing again." : "We couldn't measure that. Hold the button and sing again.";
    }

    const tracePoints = () => take.filter((f) => f.freq && f.clarity >= 0.6)
      .map((f) => ({ time: f.time, cents: foldedCents(f.freq, targetFreq()) }));

    function guideBands() {
      return [{ cents: 0, kind: 'guide', zone: IN_TUNE_ZONE }];
    }
    function bands() {
      if (isMatch) return [{ cents: 0, label: 'the note', kind: 'pure', zone: IN_TUNE_ZONE }];
      const pure = centsBetween(targetFreq(), question.target.justFreq);
      const piano = centsBetween(targetFreq(), question.target.equalFreq);
      if (Math.abs(pure - piano) <= 3) return [{ cents: 0, label: 'in tune', kind: 'pure', zone: IN_TUNE_ZONE }];
      const chosenIsPiano = question.tuning === 'equal';
      return [
        { cents: pure, label: 'pure', kind: 'pure', zone: chosenIsPiano ? 0 : IN_TUNE_ZONE },
        { cents: piano, label: 'piano', kind: 'piano', zone: chosenIsPiano ? IN_TUNE_ZONE : 0 },
      ];
    }

    // ---- result
    function showResult(level) {
      let desc = null;
      if (typeof sing.describeSing === 'function') {
        try { desc = sing.describeSing(question, analysis); } catch (err) { console.error(err); }
      }
      const yourText = desc && desc.yourNote && desc.yourNote.text
        ? desc.yourNote.text
        : (() => { const d = describeFreq(analysis.rawFreq || analysis.sungFreq); return d && d.name ? `You sang ${d.name}` : ''; })();
      trace.showResult({ points: tracePoints(), steadyStart: analysis.steadyStart, steadyEnd: analysis.steadyEnd, bands: bands() });
      // Older logic put the steadiness sentence into the message: show it as the second line.
      let message = String(result.message || '');
      let detail = result.detail || '';
      if (!detail && typeof sing.steadinessSentence === 'function' && Number.isFinite(analysis.steadinessCents)) {
        const s = sing.steadinessSentence(analysis.steadinessCents);
        if (s && message.includes(s)) { message = message.replace(s, '').replace(/\s{2,}/g, ' ').trim(); detail = s; }
      }
      const dir = result.errorCents > 0 ? 'down' : 'up';
      let tip = '';
      if (/^Tip:/.test(detail)) {
        const tail = [
          typeof sing.steadinessSentence === 'function' && Number.isFinite(analysis.steadinessCents) ? sing.steadinessSentence(analysis.steadinessCents) : '',
          typeof sing.octaveSentence === 'function' ? sing.octaveSentence(analysis.octaveShift) : '',
        ].filter(Boolean).join(' ');
        if (tail && detail.endsWith(tail)) { tip = detail.slice(0, detail.length - tail.length).trim(); detail = tail; } else { tip = detail; detail = ''; }
      }
      resultTip.textContent = tip;
      feedback.show({ level, message, detail: detail || null, icon: level === 'in-tune' ? 'circle-check' : `arrow-${dir}` });
      // Note names: fixed notes beside the padlocks (name only), yours over the trace.
      const tones = desc && Array.isArray(desc.tones) ? desc.tones : null;
      for (const r of rows) {
        if (r.fixed) r.nameEl.textContent = tones && tones[r.idx] ? tones[r.idx].name : '';
      }
      yourName.textContent = yourText;
      buildCompare();
      renderRanks();
      progressPanel.update();
    }

    // ---- compare: Your version (+ note / + chord) | Pure | Piano  (Echo: Your version | + note | The note)
    const canPlayback = () => !!buffer && typeof engine.playRecordingWith === 'function';
    function compareOptions() {
      const list = [];
      if (isMatch) {
        if (canPlayback()) list.push({ value: 'yours', label: longShort('Your version', 'Yours') }, { value: 'yours-with', label: longShort('Your version + note', 'Yours + note') });
        list.push({ value: 'note', label: 'The note' });
      } else {
        if (canPlayback()) {
          list.push({ value: 'yours-with', label: question.fixedTones.length > 1 ? longShort('Your version + chord', 'Yours + chord') : longShort('Your version + note', 'Yours + note') });
        }
        const iv = INTERVALS[question.target.intervalKey];
        const same = Math.abs(iv.equalCents - iv.justCents) <= 3;
        list.push({ value: 'pure', label: same ? 'In tune' : 'Pure' });
        if (!same) list.push({ value: 'piano', label: 'Piano' });
      }
      return list.map((o, i) => ({ ...o, key: String(i + 1) }));
    }
    let sw = null;
    function buildCompare() {
      if (sw) sw.destroy();
      sw = compareSwitch({ options: compareOptions(), label: 'Listen and compare', onChange: (v) => playCompare(v), onStop: () => stopCompare() });
      setChildren(compareHolder, sw.element);
    }
    function stopCompare() {
      compareToken += 1;
      if (compareHold) { const h = compareHold; compareHold = null; try { h.stop(); } catch { /* ignore */ } }
      if (recPlay) { const h = recPlay; recPlay = null; try { h.stop(); } catch { /* ignore */ } }
      if (sw) sw.stop();
      lightSustain();
    }
    async function playCompare(v) {
      if (player.playing) player.stop(); // (stop() would also end the held comparison sound)
      const mine = ++compareToken;
      const timbre = getSettings().timbre;
      if (v === 'yours' || v === 'yours-with') {
        if (compareHold) { try { compareHold.stop(); } catch { /* ignore */ } compareHold = null; }
        if (recPlay) { try { recPlay.stop(); } catch { /* ignore */ } recPlay = null; }
        lightSustain();
        if (!(await soundReady()) || mine !== compareToken || destroyed) return;
        const freqs = v === 'yours' ? [] : isMatch ? [targetFreq()] : fixedFreqs();
        const h = engine.playRecordingWith(buffer, freqs, { timbre });
        recPlay = h;
        if (h && h.done) h.done.then(() => { if (recPlay === h) { recPlay = null; if (sw) sw.ended(); } });
        return;
      }
      const f = v === 'piano' ? question.target.equalFreq : v === 'pure' ? question.target.justFreq : targetFreq();
      const idx = isMatch ? 0 : question.fixedTones.length;
      if (recPlay) { try { recPlay.stop(); } catch { /* ignore */ } recPlay = null; }
      if (compareHold && (typeof compareHold.isPlaying !== 'function' || compareHold.isPlaying())) {
        try { compareHold.setFreq(idx, f, 0.025); } catch (err) { console.error(err); }
        return;
      }
      if (!(await soundReady()) || mine !== compareToken || destroyed || state !== 'answered') return;
      const h = engine.startSustain(isMatch ? [f] : [...fixedFreqs(), f], { timbre, maxDuration: COMPARE_MAX_SECONDS });
      compareHold = h;
      const ended = () => { if (compareHold === h) { compareHold = null; if (sw) sw.ended(); lightSustain(); } };
      if (h && typeof h.onEnd === 'function') h.onEnd(ended);
      else if (h && h.done) h.done.then(ended);
      lightSustain();
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
        const headEl = t.fixed
          ? el('button', {
            type: 'button',
            class: 'score-head-btn',
            'aria-label': `Hear the ${t.label.toLowerCase()} alone`,
            title: `Hear the ${t.label.toLowerCase()} alone`,
            onclick: () => { stopReference(); stopCompare(); player.play([{ start: () => engine.playTone(t.freq, { duration: 1.6, timbre: getSettings().timbre }) }]); },
          }, el('span', { class: 'score-head', 'aria-hidden': 'true' }), icon('volume-2', { size: 12, class: 'score-head-icon' }))
          : el('span', { class: 'score-head-btn is-static', 'aria-hidden': 'true' }, el('span', { class: 'score-head' }));
        const row = el('div', { class: `score-row tscore-row ${t.fixed ? 'is-fixed' : 'is-target'}` },
          el('div', { class: 'score-note' },
            // Echo has one row: its label is enough (no "your note" above "Your note").
            el('span', { class: 'score-verdict' }, t.fixed ? 'fixed' : isMatch ? '' : 'your note'),
            headEl,
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
      singHereText.textContent = handsFree
        ? 'Tap the button, then sing. It stops by itself when you stop.'
        : "Hold the button while you sing. Let go when you're done.";
      const live = state === 'recording' || state === 'checking' || state === 'answered'
        || ((state === 'armed') && (take.length > 0));
      if (state === 'ready') setChildren(yourCell, waitHere);
      else if (!live) setChildren(yourCell, singHere);
      else setChildren(yourCell, micLevel, state === 'recording' ? recDot : null, trace.element, state === 'answered' ? yourName : null);
      yourCell.classList.toggle('is-live', state === 'recording');
    }

    function paintHoldButton() {
      const rec = state === 'recording';
      const busy = state === 'arming' || state === 'checking' || state === 'micerror';
      holdBtn.setAttribute('aria-pressed', String(rec || state === 'countin'));
      holdBtn.setAttribute('aria-disabled', String(busy));
      holdBtn.classList.toggle('is-held', rec);
      holdBtn.classList.toggle('is-counting', state === 'countin');
      holdBtn.classList.toggle('is-handsfree', handsFree);
      if (state === 'countin') return; // the count-in writes its own numbers
      let label;
      if (state === 'arming') label = 'Microphone…';
      else if (rec) label = recMode === 'hold' ? 'Singing… let go to finish' : 'Stop singing';
      else label = handsFree ? 'Tap to sing' : 'Hold to sing';
      holdLabel.textContent = label;
      setChildren(holdIcon, icon(state === 'arming' ? 'loader-circle' : rec ? 'square' : 'mic', { size: 22 }));
      setChildren(holdKbd, rec ? null : kbd(handsFree ? 'Space' : 'hold Space'));
    }

    function paintKeys() {
      if (paused) keys.set('Enter continue');
      else if (state === 'ready') keys.set('Enter start');
      else if (state === 'answered') keys.set(`${compareOptions().map((o) => o.key).join(' ')} compare · Space play/stop · Enter next`);
      else if (state === 'recording') keys.set(recMode === 'hold' ? 'Let go of Space to finish · Esc discard' : 'Space or Enter stop · Esc discard');
      else keys.set(`${handsFree ? 'Space start singing' : 'Hold Space to sing'} · R play again · Esc stop sound`);
    }

    function syncUi() {
      paintBar();
      renderYourCell();
      paintHoldButton();
      holdProg.hidden = state !== 'recording';
      const during = ['arming', 'armed', 'countin', 'recording', 'checking', 'micerror'].includes(state);
      soundRow.hidden = !during;
      const on = !!sustain;
      soundBtn.setAttribute('aria-pressed', String(on));
      setChildren(soundBtn, icon(on ? 'volume-2' : 'volume-x', { size: 16 }), on ? 'Sound on' : 'Sound off');
      againBtn.disabled = state === 'recording';
      handsFreeSwitch.element.hidden = state === 'answered';
      screen.classList.toggle('pc-answered', state === 'answered'); // phones: the microphone row folds away
      after.hidden = state !== 'answered';
      if (state !== 'answered') feedback.clear();
      if (state !== 'micerror') micErrorBox.hidden = true;
      paintKeys();
    }

    // ---- options (folded into a summary line)
    const pickerHolder = el('div', { class: 'task-picker' });
    let taskInputs = [];
    const taskBadges = new Map();
    function buildPicker() {
      if (isMatch) return;
      const picker = taskChips({
        tasks: tasksOf(mode),
        mode,
        value: taskKey,
        legend: mode === 'interval' ? 'Interval' : 'Note to sing',
        onChoose: (k) => { taskKey = k; setPref(`sing.task.${mode}`, k); optionChanged(); },
      });
      taskInputs = [...picker.inputs];
      taskBadges.clear();
      for (const [k, b] of picker.badges) taskBadges.set(k, b);
      setChildren(pickerHolder, picker.element);
      motionHolder.hidden = !(MOTION_SUPPORTED && mode === 'interval');
    }
    const motionSeg = segmented({
      name: 'sing-motion', legend: 'Direction', compact: true, options: MOTION_OPTIONS, value: motionPref,
      onChange: (v) => { motionPref = v; setPref('sing.motion', v); optionChanged(); },
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
        renderRanks();
        optionChanged();
        progressPanel.update();
      },
    });
    const tuningHolder = el('p', { class: 'pc-tuning-line small' });
    const guideSwitch = switchControl({
      label: 'Show the target',
      checked: showGuide,
      onChange: (v) => {
        showGuide = v;
        setPref('sing.showGuide', v);
        if (state === 'recording') trace.setGuide(v ? guideBands() : null);
        opts.update();
      },
    });
    const keepSwitch = isMatch ? switchControl({
      label: 'Keep the note playing while you sing',
      checked: keepSounding,
      onChange: (v) => { keepSounding = v; setPref('singBack.keepSounding', v); opts.update(); },
    }) : null;
    function summaryText() {
      const parts = [];
      if (isMatch) {
        parts.push(keepSounding ? 'note keeps playing' : 'note from memory');
      } else {
        const t = taskOf(taskKey);
        parts.push(t ? t.label : taskKey);
        if (MOTION_SUPPORTED && mode === 'interval') parts.push(MOTION_WORDS[motionPref] || 'ascending');
        parts.push(tuningWord(getSettings().tuning));
      }
      if (showGuide) parts.push('target shown');
      const s = parts.join(' · ');
      return s.charAt(0).toUpperCase() + s.slice(1);
    }
    const opts = optionsSummary({
      title: isMatch ? 'Options' : 'Exercise',
      getSummary: summaryText,
      buildPanel: (panel) => panel.append(
        modeSeg ? el('div', { class: 'mode-row' }, modeSeg.element) : null,
        isMatch ? null : el('div', { class: 'options-row' }, pickerHolder, motionHolder),
        isMatch ? null : tuningHolder,
        el('div', { class: 'options-row pc-switches' }, keepSwitch ? keepSwitch.element : null, guideSwitch.element),
      ),
      onOpen: () => {
        soundWasOn = !!sustain;
        optionsChanged = false;
        if (state === 'recording' || state === 'countin') discardTake('Recording discarded.');
        player.stop();
        stopCompare();
        stopReference();
      },
      onClose: () => {
        if (micBusy() && soundWasOn && !optionsChanged) playReference();
      },
      returnFocus: () => mainAction(),
    });
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
      const wasActive = state !== 'ready';
      if (state === 'recording' || state === 'countin') abandonRecording();
      stopReference();
      newQuestion();
      if (wasActive) setStatus('New round with your new settings.', '', 3000);
    }
    function updateTuning(t) {
      setChildren(tuningHolder, 'Tuning: ', tuningLink(t));
      opts.update();
    }

    // ---- visible "Hands-free" switch + microphone status
    const handsFreeSwitch = switchControl({
      label: 'Hands-free',
      description: 'Hands-free singing — tap once to start; it stops by itself when you stop singing.',
      checked: handsFree,
      onChange: (v) => {
        handsFree = v;
        setHandsFree(v);
        if (state === 'recording' || state === 'countin') discardTake('');
        holdMessage('');
        syncUi();
      },
    });
    const micStatus = el('span', { class: 'mic-status' });
    let micBlocked = false;
    function paintMicStatus() {
      if (mic) micBlocked = false;
      micStatus.textContent = mic ? 'Microphone ready' : micBlocked ? 'Microphone blocked' : 'Microphone off';
      micStatus.className = `mic-status${mic ? ' is-on' : micBlocked ? ' is-blocked' : ''}`;
    }
    const micBar = el('div', { class: 'mic-bar' },
      el('span', { class: 'pc-mic-state' }, icon('mic', { size: 16 }), micStatus),
      el('button', { type: 'button', class: 'btn-link-inline', onclick: () => { teardown(); showSetup(sing, { back: true }); } }, longShort('Check microphone', 'Check')),
      fakeMicEnabled() ? el('span', { class: 'badge', title: 'Test microphone (?fakeMic=1)' }, 'test mic') : null,
    );

    // ---- ranks + progress
    const chip = el('div', { class: 'level' });
    const statsNow = () => {
      try { return typeof sing.getSingStats === 'function' ? sing.getSingStats(KEY) : null; } catch { return null; }
    };
    const rankMin = Number.isFinite(progress.SING_RANK_MIN_ATTEMPTS) ? progress.SING_RANK_MIN_ATTEMPTS : 5;
    function renderRanks() {
      const stats = statsNow();
      for (const [key, badge] of taskBadges) {
        const r = stats ? rankFor(KEY, stats, { taskKey: key }) : null;
        badge.className = `task-rank${r ? '' : ' is-none'}`;
        if (r) badge.textContent = r.name;
        else setChildren(badge, el('span', { 'aria-hidden': 'true' }, '–'), el('span', { class: 'visually-hidden' }, 'no rank yet'));
      }
      const key = !isMatch && question && state === 'answered' ? question.taskKey : taskKey;
      const t = stats && stats.perTask ? (stats.perTask[key] || null) : null;
      const src = isMatch ? (t || stats) : t;
      const r = stats ? (isMatch ? rankFor(KEY, stats) : rankFor(KEY, stats, { taskKey: key })) : null;
      const texts = rankTexts({
        rank: r, attempts: src ? src.attempts : 0, avg: src ? src.recentAvgAbsError : NaN,
        meanSigned: src ? src.meanSignedError : NaN, minAttempts: rankMin, verb: 'sing',
      });
      const name = isMatch ? 'Echo' : (taskOf(key) || {}).label;
      setChildren(chip,
        el('div', { class: 'level-main' }, el('span', { class: 'level-label' }, `${name}: `), el('strong', {}, texts.main)),
        texts.sub ? el('div', { class: 'level-sub' }, texts.sub) : null);
      if (r) {
        setChildren(resultRank, el('span', { class: 'muted' }, `${name} rank:`), ' ', el('span', { class: 'task-rank' }, r.name), ' ',
          r.nextName && Number.isFinite(r.nextAtCents)
            ? el('span', { class: 'muted small' }, `next: ${r.nextName} at ${centsText(r.nextAtCents)} or less`)
            : el('span', { class: 'muted small' }, 'top rank'));
      } else {
        setChildren(resultRank, el('span', { class: 'muted small' },
          texts.left > 0 ? `Your rank appears after ${texts.left} more ${texts.left === 1 ? 'round' : 'rounds'}.` : 'No rank yet.'));
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
          bestLabel: 'Closest round',
          bestNote: bests.length ? 'Your closest single round.' : 'Appears after your first round.',
          extra: isMatch ? null : el('div', { class: 'task-ranks' },
            el('p', { class: 'insight-group-title' }, `Rank per task — ${MODES.find((x) => x.value === mode).label.toLowerCase()}`),
            el('ul', { class: 'task-rank-list' }, tasksOf(mode).map((t) => {
              const rr = rankFor(KEY, stats, { taskKey: t.key });
              const pt = stats.perTask ? stats.perTask[t.key] : null;
              return el('li', {}, el('span', { class: 'task-rank-name' }, shortTaskLabel(t)),
                rr ? el('span', { class: 'task-rank' }, rr.name)
                  : el('span', { class: 'task-rank is-none' }, el('span', { 'aria-hidden': 'true' }, '–'), el('span', { class: 'visually-hidden' }, 'no rank yet')),
                el('span', { class: 'muted small' }, pt && pt.attempts > 0 && Number.isFinite(pt.recentAvgAbsError) ? `${centsText(pt.recentAvgAbsError)} off on average` : 'Not tried yet'));
            }))),
          caption: 'Cents off per day (average) — lower is better',
          unit: 'cents',
          points: (stats.history || []).filter((h) => h && h.avgAbsError != null)
            .map((h) => ({ date: h.date, value: Number(h.avgAbsError), note: `${h.attempts} ${h.attempts === 1 ? 'round' : 'rounds'}` })),
          empty: 'Sing a few notes to see your progress here.',
          insights: safeInsights(KEY),
        };
      },
    });

    // ---- tip after three rounds in a row more than 15 cents off (once per task per visit)
    const MISS_TIP = Number.isFinite(progress.MISS_STREAK_TIP) ? progress.MISS_STREAK_TIP : 3;
    function easierFor(key) {
      if (isMatch) return null;
      if (progress.EASIER_TASKS && Object.prototype.hasOwnProperty.call(progress.EASIER_TASKS, key)) {
        return progress.EASIER_TASKS[key] ? taskOf(progress.EASIER_TASKS[key]) : null;
      }
      const order = mode === 'interval' ? ['octave', 'fifth', 'fourth'] : ['fifth-in-major', 'third-in-major'];
      const i = order.indexOf(key);
      const k = i === 0 ? null : order.slice(0, i < 0 ? order.length : i).reverse().find((x) => tasksOf(mode).some((t) => t.key === x));
      return k ? taskOf(k) : null;
    }
    function maybeTip(level) {
      const key = question.taskKey || taskKey;
      const n = level === 'keep-going' ? (lowStreak.get(key) || 0) + 1 : 0;
      lowStreak.set(key, n);
      let streak = n;
      const st = statsNow();
      const saved = st && st.perTask && st.perTask[key] ? st.perTask[key].missStreak : undefined;
      if (Number.isFinite(saved)) streak = saved;
      if (streak < MISS_TIP || tipShown.has(key)) return;
      let text;
      let action;
      const resetStreak = () => {
        lowStreak.set(key, 0);
        if (typeof progress.makeEasier === 'function') {
          try { return progress.makeEasier(KEY, key); } catch (err) { console.error(err); }
        }
        return null;
      };
      const easier = easierFor(key);
      if (!showGuide) {
        text = 'Three tricky rounds in a row. Showing the target line while you sing can help.';
        action = {
          label: 'Show the target',
          run: () => {
            resetStreak();
            showGuide = true;
            setPref('sing.showGuide', true);
            guideSwitch.set(true);
            opts.update();
          },
        };
      } else if (easier) {
        text = `Three tricky rounds in a row. An easier task can help: ${easier.label}.`;
        action = {
          label: 'Make it easier',
          run: () => {
            const r = resetStreak();
            const target = r && r.kind === 'task' && taskOf(r.taskKey) ? taskOf(r.taskKey) : easier;
            const g = groupOf(target);
            if (g !== mode) { mode = g; setPref('sing.mode', g); if (modeSeg) modeSeg.setValue(g); }
            taskKey = target.key;
            setPref(`sing.task.${mode}`, target.key);
            buildPicker();
            renderRanks();
            opts.setPending(true);
            opts.update();
            setStatus(`From the next round: ${target.label}.`, '', 4000);
          },
        };
      } else {
        return;
      }
      tipShown.add(key);
      const tip = tipCard({
        text,
        actions: [
          { label: action.label, onClick: () => { action.run(); tip.hide(); next.element.focus({ preventScroll: true }); } },
          { label: 'Not now', onClick: () => { tip.hide(); next.element.focus({ preventScroll: true }); } },
        ],
      });
      setChildren(tipHolder, tip.element);
      tip.show();
    }

    // ---- paused (page hidden / sound interrupted)
    const pausedBox = pausedCard({ onContinue: () => resume() });
    function pause() {
      if (state === 'recording' || state === 'countin') abandonRecording();
      player.stop();
      stopCompare();
      stopReference();
      stopAllSound();
      const active = micBusy();
      releaseMic(); // never keep the microphone open in the background
      if (active && !paused) {
        paused = true;
        state = 'armed'; // comes back armed after Continue
        holdMessage('');
        pausedBox.show();
        syncUi();
      }
    }
    function resume() {
      if (!paused) return;
      paused = false;
      pausedBox.hide();
      playReference();
      arm();
      focusAndReveal(holdBtn, score);
    }

    // ---- question lifecycle
    function newQuestion({ same = false } = {}) {
      const s = getSettings();
      if (!same) {
        question = isMatch
          ? sing.makeMatchQuestion({ voicePart: voiceArg(s) })
          : sing.makeSingQuestion({ taskKey, tuning: s.tuning, voicePart: voiceArg(s), motion: nextMotion() });
      }
      setFakeTarget(targetFreq());
      state = 'ready';
      analysis = null;
      result = null;
      buffer = null;
      take = [];
      trace.reset();
      yourName.textContent = '';
      if (!isMatch) {
        const task = taskOf(question.taskKey);
        setChildren(taskDesc, task ? [el('strong', {}, task.label), ' — ', singDescription(task, question.motion)] : []);
        setChildren(taskHelp, task ? [el('strong', {}, task.label), ' — ', singDescription(task, question.motion)] : []);
        for (const input of taskInputs) input.checked = input.value === taskKey;
      } else {
        taskDesc.textContent = 'A note plays. Then sing it back and hold it steady for 2–3 seconds.';
        taskHelp.textContent = '';
      }
      buildScore();
      feedback.clear();
      setChildren(compareHolder);
      tipHolder.replaceChildren();
      resultTip.textContent = '';
      summaryHolder.replaceChildren();
      holdMessage('');
      opts.setPending(false);
      updateTuning(s.tuning);
      renderRanks();
      syncUi();
    }

    // Start: the reference plays and the microphone opens, both from this click.
    function start() {
      if (state !== 'ready' || paused) return;
      setStatus('');
      guard();
      playReference();
      arm();
      syncUi();
      focusAndReveal(holdBtn, score);
    }

    function nextQuestion() {
      if (state !== 'answered') return;
      const go = () => {
        player.stop();
        stopCompare();
        stopReference();
        newQuestion();
        start();
      };
      if (summary.maybeShow(summaryHolder, { onKeepGoing: go, onDone: () => { window.location.hash = '#/stats'; } })) return;
      go();
    }

    function tryAgain() {
      if (state !== 'answered' || inert()) return;
      player.stop();
      stopCompare();
      newQuestion({ same: true });
      start();
    }

    function teardown() {
      if (state === 'recording' || state === 'countin') abandonRecording();
      clearTimeout(countTimer);
      clearTimeout(checkingTimer);
      clearTimeout(armingTimer);
      clearTimeout(statusTimer);
      clearTimeout(shakeTimer);
      player.stop();
      stopCompare();
      stopReference();
      releaseMic();
    }
    onCleanup(() => { teardown(); if (sw) sw.destroy(); player.destroy(); });

    // ---- keyboard: hold Space to sing (keydown starts, keyup stops; auto-repeat ignored)
    const typing = (t) => t instanceof Element && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
    const spaceSings = () => !paused && (state === 'armed' || state === 'recording' || state === 'countin');
    function onSpaceDown(e) {
      if (e.key !== ' ' || typing(e.target) || e.ctrlKey || e.altKey || e.metaKey) return;
      if (!spaceSings()) return;
      e.preventDefault(); // no page scroll, no button "click"
      e.stopPropagation();
      if (e.repeat) return;
      if (handsFree || (state === 'recording' && recMode !== 'hold')) tapToggle();
      else if (state === 'armed') startRecording('hold');
    }
    function onSpaceUp(e) {
      if (e.key !== ' ') return;
      if (state === 'recording' && recMode === 'hold' && !handsFree) {
        e.preventDefault();
        e.stopPropagation();
        releaseHold();
      } else if (spaceSings()) {
        e.preventDefault(); // a focused button must not "click" on keyup
      }
    }
    document.addEventListener('keydown', onSpaceDown, true);
    document.addEventListener('keyup', onSpaceUp, true);
    // Switching windows mid-hold: the release would never arrive, so the recording is discarded.
    const onBlur = () => { if (state === 'recording' && recMode === 'hold') discardTake('Recording discarded.'); };
    window.addEventListener('blur', onBlur);
    onCleanup(() => {
      document.removeEventListener('keydown', onSpaceDown, true);
      document.removeEventListener('keyup', onSpaceUp, true);
      window.removeEventListener('blur', onBlur);
    });
    onCleanup(installScreenKeys((e) => {
      const k = e.key;
      if (paused) {
        if (k === 'Enter') { resume(); return true; }
        return false;
      }
      if (state === 'answered') {
        if (k === 'Enter') { next.click(); return true; }
        if (!sw || sw.ownKeys) return false; // the shared compare switch handles 1 2 3 and Space itself
        if (k === ' ') { sw.toggle(); return true; }
        const o = compareOptions().find((x) => x.key === k);
        if (o) { sw.select(o.value); return true; }
        return false;
      }
      if (state === 'ready' && (k === 'Enter' || k === ' ')) { start(); return true; }
      if (k === 'Enter' && (state === 'armed' || state === 'recording' || state === 'countin') && recMode !== 'hold') { tapToggle(); return true; }
      if ((k === 'r' || k === 'R') && (state === 'armed' || state === 'micerror')) { playReference(); return true; }
      return false;
    }));
    // Esc: discard a recording / count-in, else stop the sound.
    onCleanup(onEscape(() => {
      if (state === 'recording' || state === 'countin') { discardTake('Recording discarded.'); return true; }
      if (compareHold || recPlay) { stopCompare(); return true; }
      if (sustain) { stopReference(); return true; }
      if (player.playing) { player.stop(); return true; }
      return false;
    }));
    onCleanup(onPageHidden({
      onHide: () => pause(),
      onShow: () => { if (paused && typeof pausedBox.focus === 'function') pausedBox.focus(); },
    }));
    onCleanup(onSettingsChange((s) => {
      updateTuning(s.tuning);
      if (typeof s.handsFree === 'boolean' && s.handsFree !== handsFree && state !== 'recording' && state !== 'countin') {
        handsFree = s.handsFree;
        handsFreeSwitch.set(handsFree);
        syncUi();
      }
    }));

    // ---- layout
    buildPicker();
    setChildren(screen,
      head(chip),
      opts.element,
      taskDesc,
      el('div', { class: 'options-row sing-options' }, handsFreeSwitch.element, micBar),
      el('div', { class: 'stage' },
        statusLine,
        pausedBox.element,
        score,
        feedback.element,
        after,
        soundRow,
        bar.element,
        keys.element,
      ),
      helpBox({ summary: 'How it works' },
        taskHelp,
        isMatch
          ? el('p', {}, 'Press Start: a note plays for a moment. Then hold "Hold to sing" (or the Space bar) while you sing it back, and let go after 2–3 steady seconds. Turn on "Keep the note playing while you sing" to sing along with it instead of from memory.')
          : el('p', {}, 'Press Start: the fixed notes sound. Then hold "Hold to sing" (or the Space bar) while you sing the missing note, and let go after 2–3 steady seconds.'),
        el('p', {}, '"Hands-free": tap once, sing after the count of 3, and the recording stops by itself when you stop singing (you can also tap again). With a screen reader or voice control, activating the button starts singing and activating it again stops. Esc throws a recording away.'),
        el('p', {}, 'Your pitch is drawn as a line while you sing. There is no target line, so you tune by ear; "Show the target" adds a band where the note should be. Afterwards you see the line with the in-tune band; the shaded part is the steady stretch that was measured (the first scoop into the note is ignored).'),
        el('p', {}, `Any octave counts. Headphones help a lot: otherwise the microphone also hears the app's notes. ${PRIVACY_TEXT}`),
        el('p', { class: 'muted small' }, 'Keys: Enter = Start / Next. Hold Space = sing (Hands-free: Space starts and stops). R = play again. After a round: 1 2 3 = compare, Space = play/stop. Esc = stop the sound or throw a recording away.'),
      ),
      progressPanel.element,
    );
    paintMicStatus();
    function mainAction() {
      if (paused) return pausedBox.element.querySelector('button');
      return state === 'answered' ? next.element : state === 'ready' ? startBtn.element : holdBtn;
    }
    onCleanup(refocusAfterPointerChange(screen, () => {
      if (opts.isOpen) return null;
      const a = document.activeElement;
      if (a && a.closest && a.closest('.sing-options')) return null; // the Hands-free switch keeps focus
      return mainAction();
    }));
    newQuestion();
    if (focusStart) setTimeout(() => focusAndReveal(startBtn.element, score), 0);
  }

  return () => {
    destroyed = true;
    runCleanups();
  };
}
