// "Tune it yourself": one or more tones are fixed, the singer slides another tone until it
// sounds in tune. Pure logic plus persistence (chapter key 'tune-it', saved shape described
// in error-store.js); no DOM, no audio. The task list, question builder and feedback messages
// are shared with "Sing the missing note" (sing.js).

import {
  INTERVALS, TUNINGS, centsBetween, shiftByCents, intervalCents, compareToTunings, randomRootFreq,
  describeFreq,
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
    description: 'Tune the smallest step, a half step above the lower note (the "Jaws" theme). Seconds rub by nature, so don\'t wait for stillness: listen for the most settled, even rub. A choir tunes it a little wider than the piano.' },
  { key: 'major-second', label: 'Major second', fixed: ['P1'], target: 'M2',
    description: 'Tune a whole step above the lower note, like the first two notes of "Frère Jacques". Seconds rub by nature, so listen for the most settled, even rub rather than for stillness.' },
  { key: 'minor-third', label: 'Minor third', fixed: ['P1'], target: 'm3',
    description: 'Tune a darker minor third above the lower note. A choir sings it a little higher than a piano plays it.' },
  { key: 'major-third', label: 'Major third', fixed: ['P1'], target: 'M3',
    description: 'Tune a bright major third above the lower note. A choir sings it lower than a piano plays it.' },
  { key: 'fourth', label: 'Fourth', fixed: ['P1'], target: 'P4',
    description: 'Tune the upper note a fourth above the lower one (like "Here Comes the Bride"). Listen for the wobble to stop.' },
  { key: 'tritone', label: 'Tritone', fixed: ['P1'], target: 'TT',
    description: 'Tune the tritone, the restless "devil\'s interval" (the start of "Maria" from West Side Story). Honestly: it has no fully calm, pure-sounding version — it keeps a restless edge even when well tuned — so it is the hardest interval to tune by ear. The target here is the 45/32 tuning, a little below the piano\'s.' },
  { key: 'fifth', label: 'Fifth', fixed: ['P1'], target: 'P5',
    description: 'Tune the upper note a fifth above the lower one (the leap at the start of "Twinkle, Twinkle, Little Star"). In tune, it sounds open and still.' },
  { key: 'minor-sixth', label: 'Minor sixth', fixed: ['P1'], target: 'm6',
    description: 'Tune a wide, bittersweet minor sixth above the lower note. A choir sings it a little higher than a piano plays it.' },
  { key: 'major-sixth', label: 'Major sixth', fixed: ['P1'], target: 'M6',
    description: 'Tune a warm major sixth above the lower note, like the start of "My Bonnie Lies over the Ocean" ("My BON-nie"). A choir sings it lower than a piano plays it.' },
  { key: 'minor-seventh', label: 'Minor seventh', fixed: ['P1'], target: 'm7',
    description: 'Tune a minor seventh above the lower note (the leap at the start of "Somewhere" from West Side Story: "There\'s a place"). For the plain interval we use the pure 9/5 tuning, a little higher than the piano; inside a dominant seventh chord a choir often sings the seventh lower (see the chord task).' },
  { key: 'major-seventh', label: 'Major seventh', fixed: ['P1'], target: 'M7',
    description: 'Tune a major seventh: it sits just below the octave and leans up towards it. A choir tunes it a little lower than the piano.' },
  { key: 'octave', label: 'Octave', fixed: ['P1'], target: 'P8',
    description: 'Tune the upper note so it sits exactly an octave above the lower one. When it is right, the two notes melt into one.' },
  // --- in a chord: major, minor, dominant 7th, major 7th ---
  { key: 'third-in-major', label: 'Third in a major chord', fixed: ['P1', 'P5'], target: 'M3',
    description: 'The root and fifth are given. Tune the middle note to make a glowing major chord.' },
  { key: 'fifth-in-major', label: 'Fifth in a major chord', fixed: ['P1', 'M3'], target: 'P5',
    description: 'The root and third are given. Tune the top note so the whole chord rings.' },
  { key: 'third-in-minor', label: 'Third in a minor chord', fixed: ['P1', 'P5'], target: 'm3',
    description: 'The root and fifth are given. Tune the middle note to make a calm, in-tune minor chord.' },
  { key: 'fifth-in-minor', label: 'Fifth (minor)', fixed: ['P1', 'm3'], target: 'P5',
    description: 'The root and minor third are given. Tune the top note so the minor chord settles and rings.' },
  { key: 'seventh-in-dom7', label: 'Seventh in a dominant 7th chord', fixed: ['P1', 'M3', 'P5'], target: 'h7',
    description: 'Root, third and fifth are given. Tune the seventh on top. A choir (and every barbershop quartet) sings it much lower than the piano, about a third of a semitone, where the chord suddenly locks and rings.' },
  { key: 'seventh-in-maj7', label: 'Seventh (major 7th)', fixed: ['P1', 'M3', 'P5'], target: 'M7',
    description: 'Root, third and fifth are given. Tune the major seventh on top: it sits just below the octave, and a choir tunes it a little lower than the piano.' },
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

const centsText = (c) => {
  const v = Math.round(Math.abs(c));
  return `${v} ${v === 1 ? 'cent' : 'cents'}`;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/**
 * Evaluate where the singer left the slider.
 * errorCents is signed vs the target in the chosen tuning and always describes the SINGER'S
 * NOTE: positive = sharp / too high. (For motion 'down' a too-low lower note means a wider
 * interval, so errorCents = -(interval error); `comparison` (compareToTunings) is about the
 * interval size, so its signs mean wider/narrower.)
 * Also returns midi: the nearest piano note of the in-tune target (for register stats),
 * intervalCents: the size of the interval produced, and motion.
 * centsAboveRoot is the played note relative to rootFreq (negative for motion 'down').
 * @param {object} question from makeQuestion (or sing.makeSingQuestion) @param {number} playedFreq
 * @param {{verb?: string}} [opts] verb used in "You ___ it like a choir would." ('tuned' | 'sang')
 * @returns {{centsAboveRoot: number, intervalCents: number, errorCents: number, absError: number,
 *   comparison: object, rating: 'excellent'|'good'|'close'|'off', message: string, midi: number,
 *   motion: 'up'|'down'}}
 */
export function evaluate(question, playedFreq, { verb = 'tuned' } = {}) {
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
  const n = down ? `${noun(key)} below` : noun(key);

  const pureName = `the pure ${n}`;
  const pianoName = `the piano's ${n}`;
  const chosenName = !tuningsDiffer ? `the ${n}` : tuning === TUNINGS.JUST ? pureName : pianoName;
  const where = Math.round(absError) === 0
    ? `right on ${chosenName}`
    : `${centsText(errorCents)} ${errorCents > 0 ? 'sharp' : 'flat'} of ${chosenName}`;
  const hint = errorCents > 0 ? 'lower' : 'higher';

  let message;
  const other = tuning === TUNINGS.JUST ? TUNINGS.EQUAL : TUNINGS.JUST;
  if (tuningsDiffer && comparison.nearest === other && rating !== 'excellent') {
    // Closer to the other tuning's target than to the chosen one.
    const otherFrom = other === TUNINGS.JUST ? comparison.centsFromJust : comparison.centsFromEqual;
    const otherName = other === TUNINGS.JUST ? pureName : pianoName;
    const lead = Math.round(Math.abs(otherFrom)) === 0
      ? `You landed right on ${otherName}`
      : `You landed ${centsText(otherFrom)} from ${otherName}`;
    const tail = tuning === TUNINGS.JUST
      ? `In a choir, try a little ${hint}.`
      : `That is how a choir would tune it; to match the piano, try a little ${hint}.`;
    message = `${lead} — ${centsText(errorCents)} ${errorCents > 0 ? 'higher' : 'lower'} than ${chosenName}. ${tail}`;
  } else if (rating === 'excellent') {
    let extra = 'Beautifully in tune.';
    if (tuningsDiffer) {
      extra = tuning === TUNINGS.JUST ? `You ${verb} it like a choir would.` : 'That matches the piano exactly.';
    }
    message = `Excellent — ${where}. ${extra}`;
  } else if (rating === 'good') {
    let extra = `Nearly there: a touch ${hint}.`;
    if (tuningsDiffer && tuning === TUNINGS.JUST) extra = `Closer to the choir's tuning than the piano's — a touch ${hint} and it will ring.`;
    message = `Good — ${where}. ${extra}`;
  } else if (rating === 'close') {
    message = `Close — ${where}. Try a little ${hint}.`;
  } else {
    message = `Not yet — ${where}. Try ${hint}, and listen for the wobble to slow down.`;
  }

  // (These explanations describe the upper note, so they are only added for ascending questions.)
  if (key === 'h7' && !down) {
    const apart = centsText(gap);
    message += tuning === TUNINGS.JUST
      ? ` The pure "barbershop" seventh sits about ${apart} lower than the piano's seventh — that is what makes the chord lock and ring.`
      : ` The piano's seventh is about ${apart} higher than the pure "barbershop" seventh a choir would sing.`;
  } else if (key === 'M7' && !down) {
    const apart = centsText(gap);
    message += tuning === TUNINGS.JUST
      ? ` The major seventh sits just below the octave; a choir tunes it about ${apart} lower than the piano.`
      : ` The major seventh sits just below the octave; the piano's is about ${apart} higher than the pure one a choir would tune.`;
  }

  return {
    centsAboveRoot,
    intervalCents: size,
    errorCents,
    absError,
    comparison,
    rating,
    message,
    midi: describeFreq(question.target.targetFreq).midi,
    motion: down ? 'down' : 'up',
  };
}

/**
 * What sounded / what was asked, for after the answer.
 * title e.g. 'Major third above D4 −8'; notes: the fixed tones, then the target.
 * The target's `played` is playedFreq if given (optional), else the in-tune target.
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
  const played = typeof playedFreq === 'number' && playedFreq > 0 ? describeFreq(playedFreq) : inTune;
  let title;
  if (task.group === 'interval') title = `${task.label} ${question.motion === 'down' ? 'below' : 'above'} ${root.text}`;
  else if (task.label.includes('(')) title = `${task.label}, root ${root.text}`;
  else title = `${task.label} (root ${root.text})`;
  return {
    title,
    notes: [...fixed, { label: question.target.label, name: played.name, cents: played.cents, played, inTune }],
  };
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
