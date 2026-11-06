// "Tune it yourself": one or more tones are fixed, the singer slides another tone until it
// sounds in tune. Pure logic plus persistence (chapter key 'tune-it', saved shape described
// in error-store.js); no DOM, no audio. The task list, question builder and feedback messages
// are shared with "Sing the missing note" (sing.js).

import {
  INTERVALS, TUNINGS, centsBetween, shiftByCents, intervalCents, compareToTunings, randomRootFreq,
  describeFreq, formatCents, roundCents, CHORDS, rootName, spellInterval, deviation,
} from '../music/tuning.js';
import { createErrorStore, REGISTER_MIN_ATTEMPTS, INSIGHT_MIN_ATTEMPTS, TENDENCY_MIN_CENTS } from './error-store.js';

export const TUNE_IT_KEY = 'tune-it';

/** Half-width of the slider range, in cents. */
export const SLIDER_HALF_RANGE_CENTS = 120;
/** The slider's centre (= start position) is this many cents from the target, random side. */
export const SLIDER_CENTRE_OFFSET_RANGE_CENTS = Object.freeze([25, 60]);
/** Largest centre offset (so the target is >= 120 - 60 = 60 cents from either end). */
export const SLIDER_MAX_CENTRE_OFFSET_CENTS = SLIDER_CENTRE_OFFSET_RANGE_CENTS[1];
/** The start position is the slider centre, so its distance from the target is the same range. */
export const START_OFFSET_RANGE_CENTS = SLIDER_CENTRE_OFFSET_RANGE_CENTS;
/** Rating limits on the absolute error vs the chosen target (cents). */
export const RATING_LIMITS = Object.freeze({ excellent: 3, good: 7, close: 15 });
/** Attempts needed in a register band before perTask.byRegister / insights report it. */
export const TUNE_REGISTER_MIN_ATTEMPTS = REGISTER_MIN_ATTEMPTS;

/** Name of each chord tone, by its interval above the root. */
const TONE_LABELS = {
  P1: 'Root', m2: 'Second', M2: 'Second', m3: 'Third', M3: 'Third', P4: 'Fourth', TT: 'Tritone', P5: 'Fifth',
  m6: 'Sixth', M6: 'Sixth', P8: 'Octave', h7: 'Seventh', m7: 'Seventh', M7: 'Seventh',
};
const toneLabel = (k) => TONE_LABELS[k] || INTERVALS[k].name;
const noun = (k) => toneLabel(k).toLowerCase();

/**
 * Tasks: [{ key, label, description, group: 'interval'|'chord', fixed: [intervalKey...], target: intervalKey }].
 * Intervals first (easiest first), then the chord tasks grouped by chord: major, minor, dom7, maj7.
 * Fixed tones sound in the chosen tuning; the target tone is the one the singer moves.
 */
export const TUNE_TASKS = Object.freeze([
  // --- intervals, smallest first ---
  { key: 'minor-second', label: 'Minor second', fixed: ['P1'], target: 'm2',
    description: 'Tune a half step above the lower note (the "Jaws" theme). Seconds always wobble a little, so listen for the calmest wobble, not for stillness. Choirs tune it a little wider than the piano.' },
  { key: 'major-second', label: 'Major second', fixed: ['P1'], target: 'M2',
    description: 'Tune a whole step above the lower note, like the start of "Frère Jacques". Seconds always wobble a little, so listen for the calmest wobble, not for stillness.' },
  { key: 'minor-third', label: 'Minor third', fixed: ['P1'], target: 'm3',
    description: 'Tune a minor third above the lower note. Choirs sing it a little higher than the piano.' },
  { key: 'major-third', label: 'Major third', fixed: ['P1'], target: 'M3',
    description: 'Tune a major third above the lower note. Choirs sing it lower than the piano.' },
  { key: 'fourth', label: 'Fourth', fixed: ['P1'], target: 'P4',
    description: 'Tune a fourth above the lower note (like "Here Comes the Bride"). Move it until the wobble stops.' },
  { key: 'tritone', label: 'Tritone', fixed: ['P1'], target: 'TT',
    description: 'Tune the tritone (the start of "Maria" from West Side Story). It never sounds fully calm, so it\'s the hardest to tune by ear. The target is a little below the piano\'s.' },
  { key: 'fifth', label: 'Fifth', fixed: ['P1'], target: 'P5',
    description: 'Tune a fifth above the lower note (the leap at the start of "Twinkle, Twinkle, Little Star"). In tune, it sounds open and calm.' },
  { key: 'minor-sixth', label: 'Minor sixth', fixed: ['P1'], target: 'm6',
    description: 'Tune a minor sixth above the lower note. Choirs sing it a little higher than the piano.' },
  { key: 'major-sixth', label: 'Major sixth', fixed: ['P1'], target: 'M6',
    description: 'Tune a major sixth above the lower note, like the start of "My Bonnie Lies over the Ocean". Choirs sing it lower than the piano.' },
  { key: 'minor-seventh', label: 'Minor seventh', fixed: ['P1'], target: 'm7',
    description: 'Tune a minor seventh above the lower note ("Somewhere": "There\'s a place"). Here it\'s a little higher than the piano; in a dominant 7th chord, choirs sing it lower.' },
  { key: 'major-seventh', label: 'Major seventh', fixed: ['P1'], target: 'M7',
    description: 'Tune a major seventh. It sits just below the octave. Choirs tune it a little lower than the piano.' },
  { key: 'octave', label: 'Octave', fixed: ['P1'], target: 'P8',
    description: 'Tune the upper note exactly an octave above the lower one. In tune, the two notes sound like one.' },
  // --- in a chord: major, minor, dominant 7th, major 7th ---
  { key: 'third-in-major', label: 'Third in a major chord', fixed: ['P1', 'P5'], target: 'M3',
    description: 'The root and fifth are fixed. Tune the middle note until the major chord sounds calm.' },
  { key: 'fifth-in-major', label: 'Fifth in a major chord', fixed: ['P1', 'M3'], target: 'P5',
    description: 'The root and third are fixed. Tune the top note until the major chord sounds calm.' },
  { key: 'third-in-minor', label: 'Third in a minor chord', fixed: ['P1', 'P5'], target: 'm3',
    description: 'The root and fifth are fixed. Tune the middle note until the minor chord sounds calm.' },
  { key: 'fifth-in-minor', label: 'Fifth in a minor chord', fixed: ['P1', 'm3'], target: 'P5',
    description: 'The root and minor third are fixed. Tune the top note until the minor chord sounds calm.' },
  { key: 'seventh-in-dom7', label: 'Seventh in a dominant 7th chord', fixed: ['P1', 'M3', 'P5'], target: 'h7',
    description: 'The root, third and fifth are fixed. Tune the seventh on top. Choirs and barbershop quartets sing it about 31 cents lower than the piano; then the chord rings.' },
  { key: 'seventh-in-maj7', label: 'Seventh in a major 7th chord', fixed: ['P1', 'M3', 'P5'], target: 'M7',
    description: 'The root, third and fifth are fixed. Tune the major seventh on top. Choirs tune it a little lower than the piano.' },
].map((t) => Object.freeze({
  ...t,
  // 'interval' = two notes; 'chord' = the target is tuned inside a chord (the UI's two modes)
  group: t.fixed.length === 1 ? 'interval' : 'chord',
  fixed: Object.freeze(t.fixed.slice()),
})));

function getTask(taskKey) {
  const task = TUNE_TASKS.find((t) => t.key === taskKey);
  if (!task) throw new Error(`Unknown tune-it task: "${taskKey}"`);
  return task;
}

/** Frequency of an interval above root in the given tuning (exact ratio for just). */
function toneFreq(root, intervalKey, tuning) {
  const iv = INTERVALS[intervalKey];
  return tuning === TUNINGS.JUST
    ? root * (iv.justRatio[0] / iv.justRatio[1])
    : root * Math.pow(2, iv.semitones / 12);
}

/**
 * Make a question. The root is random (continuous) and leaves room for every tone and the
 * whole slider inside the voice range. The slider spans ±SLIDER_HALF_RANGE_CENTS around a
 * centre that is 25–60 cents (random side) from the target; the slider starts at its centre
 * (startFreq === centre), so the target is never the start or the middle and is always at
 * least 60 cents from either end.
 *
 * motion 'down' (interval tasks only; chord tasks ignore it): the UPPER note is fixed and the
 * singer tunes the LOWER note to the interval below it. Then rootFreq is the fixed upper note
 * (the reference), fixedTones = [{ label: 'Upper note', intervalKey: 'P1' }], and the target
 * (label e.g. 'Third below') is upper / ratio (just) or upper * 2^(-semitones/12) (equal).
 * @param {{taskKey: string, tuning?: 'just'|'equal', voicePart?: string|string[],
 *   motion?: 'up'|'down', rng?: () => number}} p
 * @returns question with an extra `motion: 'up'|'down'` (what was actually used)
 */
export function makeQuestion({ taskKey, tuning = 'just', voicePart = 'any', motion = 'up', rng = Math.random }) {
  const q = buildTaskQuestion({ taskKey, tuning, voicePart, motion, rng, reachCents: SLIDER_HALF_RANGE_CENTS + SLIDER_MAX_CENTRE_OFFSET_CENTS });
  const sign = rng() < 0.5 ? -1 : 1;
  const [lo, hi] = SLIDER_CENTRE_OFFSET_RANGE_CENTS;
  const centre = shiftByCents(q.target.targetFreq, sign * (lo + rng() * (hi - lo)));
  const slider = {
    minFreq: shiftByCents(centre, -SLIDER_HALF_RANGE_CENTS),
    maxFreq: shiftByCents(centre, SLIDER_HALF_RANGE_CENTS),
  };
  return { ...q, startFreq: centre, slider };
}

/**
 * Shared question builder (Tune it yourself and Sing the missing note): random root, fixed
 * tones and target for a task, motion handled as in makeQuestion. `reachCents` keeps that much
 * room around the target inside the voice range (the slider for tune-it; 0 for singing).
 * @returns {{ taskKey, tuning, motion, rootFreq, fixedTones, target }}
 */
export function buildTaskQuestion({ taskKey, tuning = 'just', voicePart = 'any', motion = 'up', rng = Math.random, reachCents = 0 }) {
  const task = getTask(taskKey);
  const targetCents = intervalCents(task.target, tuning); // also validates tuning
  const reach = reachCents;
  const down = motion === 'down' && task.group === 'interval';

  let rootFreq, fixedTones, justFreq, equalFreq, targetLabel;
  if (down) {
    // Positions relative to the fixed upper note: the target sits targetCents below it.
    const lowCents = -targetCents - reach;
    const highCents = Math.max(0, -targetCents + reach);
    const base = randomRootFreq(voicePart, (highCents - lowCents) / 100, rng);
    rootFreq = shiftByCents(base, -lowCents);
    fixedTones = [{ label: 'Upper note', intervalKey: 'P1', freq: rootFreq }];
    const iv = INTERVALS[task.target];
    justFreq = rootFreq * (iv.justRatio[1] / iv.justRatio[0]);
    equalFreq = rootFreq * Math.pow(2, -iv.semitones / 12);
    targetLabel = `${toneLabel(task.target)} below`;
  } else {
    const allTones = [...task.fixed, task.target];
    const highestTone = Math.max(...allTones.map((k) => Math.max(INTERVALS[k].justCents, INTERVALS[k].equalCents)));
    const lowCents = Math.min(0, targetCents - reach);
    const highCents = Math.max(highestTone, targetCents + reach);
    const base = randomRootFreq(voicePart, (highCents - lowCents) / 100, rng);
    rootFreq = shiftByCents(base, -lowCents);
    fixedTones = task.fixed.map((k) => ({ label: toneLabel(k), intervalKey: k, freq: toneFreq(rootFreq, k, tuning) }));
    justFreq = toneFreq(rootFreq, task.target, TUNINGS.JUST);
    equalFreq = toneFreq(rootFreq, task.target, TUNINGS.EQUAL);
    targetLabel = toneLabel(task.target);
  }
  const targetFreq = tuning === TUNINGS.JUST ? justFreq : equalFreq;

  return {
    taskKey,
    tuning,
    motion: down ? 'down' : 'up',
    rootFreq,
    fixedTones,
    target: { label: targetLabel, intervalKey: task.target, targetFreq, justFreq, equalFreq },
  };
}

/** Rating for an absolute error in cents (RATING_LIMITS: ≤3 excellent, ≤7 good, ≤15 close, else off). */
export function ratingFor(absError) {
  const e = absError - 1e-9; // a limit reached exactly (up to float noise) counts as within it
  if (e <= RATING_LIMITS.excellent) return 'excellent';
  if (e <= RATING_LIMITS.good) return 'good';
  if (e <= RATING_LIMITS.close) return 'close';
  return 'off';
}

const centsText = formatCents; // the one rule for showing cents (tuning.js)
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Feedback level for an absolute error in cents: ≤7 'in-tune' (Spot on ≤3 / Good ≤7), ≤15 'close', else 'keep-going'. */
export function levelFor(absError) {
  const r = ratingFor(absError);
  return r === 'excellent' || r === 'good' ? 'in-tune' : r === 'close' ? 'close' : 'keep-going';
}

/** Plain interval names used in feedback ("the pure major third"). */
const FEEDBACK_NAMES = {
  P1: 'unison', m2: 'minor second', M2: 'major second', m3: 'minor third', M3: 'major third', P4: 'fourth',
  TT: 'tritone', P5: 'fifth', m6: 'minor sixth', M6: 'major sixth', m7: 'minor seventh', M7: 'major seventh',
  P8: 'octave', h7: 'seventh',
};

/**
 * Feedback text for a produced note (shared by Lock it in, Echo and Join the chord; UX-WRITING
 * "Message patterns"). errorCents: signed, + = above the target. target: e.g. 'the pure major third'.
 * -> first line: 'Spot on — 2 cents above the pure major third. That's how a choir tunes it.' etc.
 * @param {{errorCents: number, target: string, spotOnExtra?: string|null, keepGoingTail?: string}} p
 */
export function producingMessage({ errorCents, target, spotOnExtra = null, keepGoingTail = null }) {
  const rating = ratingFor(Math.abs(errorCents));
  const where = roundCents(errorCents) === 0
    ? `right on ${target}`
    : `${centsText(errorCents)} ${errorCents > 0 ? 'above' : 'below'} ${target}`;
  const hint = errorCents > 0 ? 'lower' : 'higher';
  if (rating === 'excellent') return `Spot on — ${where}.${spotOnExtra ? ` ${spotOnExtra}` : ''}`;
  if (rating === 'good') return `Good — ${where}. A touch ${hint} next time.`;
  if (rating === 'close') return `Close — ${where}. Try a little ${hint}.`;
  return `Keep going — ${where}. ${keepGoingTail || `Go ${hint} and listen for the wobble to slow down.`}`;
}

/**
 * Evaluate where the singer left the slider.
 * errorCents is signed vs the target in the chosen tuning and always describes the SINGER'S
 * NOTE: positive = above / too high. (For motion 'down' a too-low lower note means a wider
 * interval, so errorCents = -(interval error); `comparison` (compareToTunings) is about the
 * interval size, so its signs mean wider/narrower.)
 * Also returns midi: the nearest piano note of the in-tune target (for register stats),
 * intervalCents: the size of the interval produced, and motion.
 * centsAboveRoot is the played note relative to rootFreq (negative for motion 'down').
 * message: first line (UX-WRITING patterns): 'Spot on — 2 cents above the pure major third. That's how a
 *   choir tunes it.' / 'Good — … A touch higher next time.' / 'Close — … Try a little lower.' /
 *   'Keep going — … Go higher and listen for the wobble to slow down.'; when the note is nearer the
 *   OTHER tuning (and not Spot on): "That's the piano major third (2 cents off). Pure is 14 cents lower —
 *   try a little lower." / "That's the pure major third — how a choir tunes it. For piano tuning, go 14
 *   cents higher."  detail: optional second line (seventh tips) or null.
 * level: 'in-tune' (≤7 cents) | 'close' (≤15) | 'keep-going'.
 * @param {object} question from makeQuestion (or sing.makeSingQuestion) @param {number} playedFreq
 * @param {object} [opts] (kept for compatibility; unused)
 * @returns {{centsAboveRoot: number, intervalCents: number, errorCents: number, absError: number,
 *   comparison: object, rating: 'excellent'|'good'|'close'|'off', level: string, message: string,
 *   detail: string|null, midi: number, motion: 'up'|'down'}}
 */
// eslint-disable-next-line no-unused-vars
export function evaluate(question, playedFreq, opts = {}) {
  const key = question.target.intervalKey;
  const tuning = question.tuning;
  const down = question.motion === 'down';
  const centsAboveRoot = centsBetween(question.rootFreq, playedFreq);
  const size = down ? -centsAboveRoot : centsAboveRoot;
  const sizeError = size - intervalCents(key, tuning);
  const errorCents = down ? -sizeError : sizeError;
  const absError = Math.abs(errorCents);
  const comparison = compareToTunings(size, key);
  const rating = ratingFor(absError);
  const iv = INTERVALS[key];
  const gap = iv.equalCents - iv.justCents;
  const tuningsDiffer = Math.abs(gap) > 3;
  const n = down ? `${FEEDBACK_NAMES[key]} below` : FEEDBACK_NAMES[key];
  const chosenWord = tuning === TUNINGS.JUST ? 'pure' : 'piano';
  const target = tuningsDiffer ? `the ${chosenWord} ${n}` : `the ${n}`;

  let message;
  const other = tuning === TUNINGS.JUST ? TUNINGS.EQUAL : TUNINGS.JUST;
  if (tuningsDiffer && comparison.nearest === other && rating !== 'excellent') {
    // Nearer the other tuning's target than the chosen one. Direction of the CHOSEN target seen
    // from the other one, for the note being tuned (for 'down' the lower note moves the other way).
    const chosenFreq = tuning === TUNINGS.JUST ? question.target.justFreq : question.target.equalFreq;
    const otherFreq = tuning === TUNINGS.JUST ? question.target.equalFreq : question.target.justFreq;
    const toChosen = centsBetween(otherFreq, chosenFreq);
    const way = toChosen > 0 ? 'higher' : 'lower';
    const apart = centsText(toChosen);
    if (tuning === TUNINGS.JUST) {
      const off = other === TUNINGS.JUST ? comparison.centsFromJust : comparison.centsFromEqual;
      const offText = roundCents(off) === 0 ? '' : ` (${centsText(off)} off)`;
      message = `That's the piano ${n}${offText}. Pure is ${apart} ${way} — try a little ${way}.`;
    } else {
      message = `That's the pure ${n} — how a choir tunes it. For piano tuning, go ${apart} ${way}.`;
    }
  } else {
    message = producingMessage({
      errorCents,
      target,
      spotOnExtra: tuning === TUNINGS.JUST ? "That's how a choir tunes it." : 'That matches the piano.',
    });
  }

  // Second line (tips about the upper note, so only for ascending questions).
  let detail = null;
  if (key === 'h7' && !down) {
    detail = `Tip: the pure "barbershop" seventh is about ${centsText(gap)} lower than the piano's. That's what makes the chord ring.`;
  } else if (key === 'M7' && !down) {
    detail = `Tip: the major seventh sits just below the octave. Pure is about ${centsText(gap)} lower than piano.`;
  }

  return {
    centsAboveRoot,
    intervalCents: size,
    errorCents,
    absError,
    comparison,
    rating,
    level: levelFor(absError),
    message,
    detail,
    midi: describeFreq(question.target.targetFreq).midi,
    motion: down ? 'down' : 'up',
  };
}

/**
 * What sounded / what was asked, for after the answer.
 * title e.g. 'Major third above D4 −8'; notes: the fixed tones, then the target.
 * The target's `played` is playedFreq if given (optional), else the in-tune target.
 * (title / notes name notes on the piano grid; kept until the UI uses the fields below.)
 * New, spelled for the key and compared to the TARGET (no piano offsets):
 *   heading: 'Major third above D4' | 'Fifth below A4' | 'D major' (chord tasks),
 *   chord: 'D major' | null,
 *   tones: [{ label, name: 'F♯4', deviation: { cents, text } | null, secondary: {...} | null,
 *             isOff: false, isYours }]  — fixed tones name only; your note (last) gets
 *             deviation '8 cents above pure' and secondary '6 cents below piano' when playedFreq is given,
 *   yourNote: { name, deviation, secondary, text: 'F♯4 · 8 cents above pure' } | null.
 * @param {object} question from makeQuestion @param {number} [playedFreq]
 */
export function describe(question, playedFreq) {
  const task = getTask(question.taskKey);
  const root = describeFreq(question.rootFreq);
  const fixed = question.fixedTones.map((t) => {
    const d = describeFreq(t.freq);
    return { label: t.label, name: d.name, cents: d.cents, played: d, inTune: d };
  });
  const inTune = describeFreq(question.target.targetFreq);
  const hasPlayed = typeof playedFreq === 'number' && playedFreq > 0;
  const played = hasPlayed ? describeFreq(playedFreq) : inTune;
  let title;
  if (task.group === 'interval') title = `${task.label} ${question.motion === 'down' ? 'below' : 'above'} ${root.text}`;
  else if (task.label.includes('(')) title = `${task.label}, root ${root.text}`;
  else title = `${task.label} (root ${root.text})`;

  // New (design critique #1): names spelled for the interval / chord, deviation vs the TARGET only.
  const sp = spellTask(question);
  const yours = hasPlayed ? targetDeviation(question, playedFreq) : { deviation: null, secondary: null };
  return {
    title,
    notes: [...fixed, { label: question.target.label, name: played.name, cents: played.cents, played, inTune }],
    heading: sp.heading,
    chord: sp.chord,
    tones: [
      ...question.fixedTones.map((t, i) => ({ label: t.label, name: sp.fixed[i].name, deviation: null, secondary: null, isOff: false, isYours: false })),
      { label: question.target.label, name: sp.target.name, deviation: yours.deviation, secondary: yours.secondary, isOff: false, isYours: true },
    ],
    yourNote: hasPlayed ? { name: sp.target.name, deviation: yours.deviation, secondary: yours.secondary,
      text: `${sp.target.name} · ${yours.deviation.text}` } : null,
  };
}

/** Chord of each chord task (for the heading 'D major', 'B♭ dominant 7th'). */
const TASK_CHORDS = {
  'third-in-major': 'major', 'fifth-in-major': 'major', 'third-in-minor': 'minor', 'fifth-in-minor': 'minor',
  'seventh-in-dom7': 'dom7', 'seventh-in-maj7': 'maj7',
};

/**
 * Note names of a tune-it / sing question, spelled for the key: the reference note by its nearest
 * key name, every other tone by interval from it (descending: downwards from the fixed upper note).
 * -> { reference, fixed: [spelled], target: spelled, chord: 'D major' | null,
 *      heading: 'Major third above D4' | 'Fifth below A4' | 'D major' }
 * (spelled = { name, pitchClass, letter, alter, octave, midi }, see tuning.spellInterval).
 */
export function spellTask(question) {
  const task = getTask(question.taskKey);
  const reference = rootName(question.rootFreq);
  const down = question.motion === 'down';
  const fixed = down
    ? question.fixedTones.map(() => reference)
    : question.fixedTones.map((t) => spellInterval(reference, t.intervalKey, 'up'));
  const target = spellInterval(reference, question.target.intervalKey, down ? 'down' : 'up');
  const chordKey = TASK_CHORDS[task.key] || null;
  const chord = chordKey ? `${reference.pitchClass} ${CHORDS[chordKey].quality}` : null;
  const heading = chord || `${task.label} ${down ? 'below' : 'above'} ${reference.name}`;
  return { reference, fixed, target, chord, heading };
}

/**
 * Deviation of a played / sung note from the question's target, in note direction (+ = higher):
 * vs the CHOSEN tuning ('8 cents above pure' / 'below piano'; 'the target' when pure and piano
 * coincide, e.g. the octave), plus `secondary` vs the other tuning when the two targets are more
 * than 3 cents apart ('6 cents below piano'), else null.
 * @returns {{deviation: {cents: number, text: string}, secondary: {cents: number, text: string}|null}}
 */
export function targetDeviation(question, freq) {
  const iv = INTERVALS[question.target.intervalKey];
  const gap = Math.abs(iv.equalCents - iv.justCents);
  const word = (t) => (t === TUNINGS.JUST ? 'pure' : 'piano');
  const chosen = question.tuning === TUNINGS.EQUAL ? TUNINGS.EQUAL : TUNINGS.JUST;
  const other = chosen === TUNINGS.JUST ? TUNINGS.EQUAL : TUNINGS.JUST;
  const freqOf = (t) => (t === TUNINGS.JUST ? question.target.justFreq : question.target.equalFreq);
  const label = gap < 1 ? 'the target' : word(chosen);
  const dev = deviation(centsBetween(freqOf(chosen), freq), `above ${label}`, `below ${label}`, 'in tune');
  const secondary = gap > 3
    ? deviation(centsBetween(freqOf(other), freq), `above ${word(other)}`, `below ${word(other)}`, 'in tune')
    : null;
  return { deviation: dev, secondary };
}

// ---------------------------------------------------------------------------
// Persistence, stats and insights (shared implementation: error-store.js)
// ---------------------------------------------------------------------------

/** The tune-it store (persistence, stats, insights, import validation). */
export const tuneStore = createErrorStore({ key: TUNE_IT_KEY, tasks: TUNE_TASKS, verb: 'tune' });

/**
 * Save one attempt (the result of evaluate) under chapter key 'tune-it'.
 * Uses result.absError (required), result.errorCents, result.midi and result.motion
 * (optional: sharp/flat tendency, register and up/down insights). Up and down attempts share
 * the task's stats and rank. `now` (optional Date) is for tests.
 * Returns the updated getTuneStats().
 * @param {string} taskKey @param {{absError: number, errorCents?: number, midi?: number, motion?: string}} result
 * @param {{now?: Date}} [opts]
 */
export function recordTuneResult(taskKey, result, opts = {}) {
  getTask(taskKey);
  return tuneStore.record(taskKey, result, opts);
}

/**
 * Tune-it stats. Every task in TUNE_TASKS is present in perTask (zeros / nulls if untried).
 * recentAvgAbsError (overall, last 20 attempts across tasks) is used for the overall rank.
 * perTask: meanSignedError = average of the last 10 signed errors (+ = tends sharp);
 * byRegister = [{ label, attempts, avgAbsError }] for bands with >= 5 attempts.
 */
export function getTuneStats() {
  return tuneStore.stats();
}

/** Saved tune-it data in its clean (version 2) shape, or null if nothing was ever saved. For export. */
export function getTuneData() {
  return tuneStore.data();
}

/** Tune-it insights; returned by progress.getInsights('tune-it'). */
export const TUNE_INSIGHT_MIN_ATTEMPTS = INSIGHT_MIN_ATTEMPTS;
export const TUNE_TENDENCY_MIN_CENTS = TENDENCY_MIN_CENTS;

/**
 * Insights for Tune it yourself (no staircase, so no difficulty adjustment is needed):
 * { answered, averageAbsError, byTask: [{ key, label, attempts, avgAbsError, meanSignedError }],
 *   byRegister: [{ label, answered, avgAbsError }], byDirection: [{ key, label, answered }],
 *   byMotion: [{ key: 'up'|'down', label, answered, avgAbsError }] (interval tasks only),
 *   strengths: [string], blindSpots: [string] } — groups need >= TUNE_INSIGHT_MIN_ATTEMPTS.
 */
export function getTuneInsights() {
  return tuneStore.insights();
}
