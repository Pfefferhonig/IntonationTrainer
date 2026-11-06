// Singing chapters — pure logic (NO DOM, NO audio):
//   "Sing it back" (progress key 'sing-match'): a note is played, the singer matches it.
//   "Sing the missing note" (progress key 'sing'): the Tune it yourself tasks, sung instead of slid.
// Questions, feedback messages and persistence are shared with tune-it.js / error-store.js.

import { randomRootFreq, describeFreq, formatCents, roundCents, rootName, shiftOctave, deviation } from '../music/tuning.js';
import {
  TUNE_TASKS, buildTaskQuestion, evaluate, describe, ratingFor, levelFor, producingMessage, spellTask, targetDeviation,
} from './tune-it.js';
import { createErrorStore } from './error-store.js';

export const SING_MATCH_KEY = 'sing-match';
export const SING_KEY = 'sing';

/** Frames below this clarity (0..1) are ignored. */
export const SING_MIN_CLARITY = 0.85;
/** The steady stretch must last at least this long (seconds). */
export const MIN_STEADY_SECONDS = 1.0;
/** Voiced frames further apart than this (seconds) break a stretch. */
export const MAX_GAP_SECONDS = 0.2;

/** Plain reasons when a recording cannot be measured (UX-WRITING error patterns). */
export const TAKE_REASONS = Object.freeze({
  'no-voice': "We didn't hear your voice. Check the microphone, then hold and sing again.",
  'too-short': 'That was too short to measure. Hold the button and sing for 2–3 seconds.',
  'cant-measure': "We couldn't measure that. Hold the button and sing again.",
});

/** The one "task" of Sing it back. */
export const MATCH_TASKS = Object.freeze([Object.freeze({ key: 'match', label: 'Matching a note', group: 'match', phrase: 'the note' })]);

/** Stores (persistence, stats, insights, import validation) by progress key. */
export const SING_STORES = Object.freeze({
  [SING_MATCH_KEY]: createErrorStore({ key: SING_MATCH_KEY, tasks: MATCH_TASKS, steadiness: true, verb: 'sing' }),
  [SING_KEY]: createErrorStore({ key: SING_KEY, tasks: TUNE_TASKS, steadiness: true, verb: 'sing' }),
});

function storeFor(key) {
  const store = Object.prototype.hasOwnProperty.call(SING_STORES, key) ? SING_STORES[key] : null;
  if (!store) throw new Error(`Unknown singing progress key: "${key}" (expected 'sing-match' or 'sing')`);
  return store;
}

// ---------------------------------------------------------------------------
// Questions
// ---------------------------------------------------------------------------

/**
 * "Sing it back": one note at a random, non-grid pitch inside the voice range (the union when
 * several voice parts are given).
 * @param {{voicePart?: string|string[], rng?: () => number}} p
 * @returns {{kind: 'match', taskKey: 'match', tuning: null, motion: 'up', rootFreq: number, fixedTones: [],
 *   target: {label: string, intervalKey: 'P1', targetFreq: number, justFreq: number, equalFreq: number}}}
 */
export function makeMatchQuestion({ voicePart = 'any', rng = Math.random } = {}) {
  const targetFreq = randomRootFreq(voicePart, 0, rng);
  return {
    kind: 'match',
    taskKey: 'match',
    tuning: null,
    motion: 'up',
    rootFreq: targetFreq,
    fixedTones: [],
    target: { label: 'The note', intervalKey: 'P1', targetFreq, justFreq: targetFreq, equalFreq: targetFreq },
  };
}

/**
 * "Sing the missing note": same tasks, motion and fields as tune-it makeQuestion, minus the
 * slider (TUNE_TASKS; motion 'down' for interval tasks = sing the lower note).
 * @param {{taskKey: string, tuning?: 'just'|'equal', voicePart?: string|string[], motion?: 'up'|'down', rng?: () => number}} p
 */
export function makeSingQuestion({ taskKey, tuning = 'just', voicePart = 'any', motion = 'up', rng = Math.random }) {
  return { kind: 'sing', ...buildTaskQuestion({ taskKey, tuning, voicePart, motion, rng, reachCents: 0 }) };
}

// ---------------------------------------------------------------------------
// Analysis of a sung take
// ---------------------------------------------------------------------------

const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round1 = (x) => Math.round(x * 10) / 10;

function median(xs) {
  const s = xs.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Measure a take. frames: [{ time (s), freq (Hz or null), clarity (0..1) }] from startMic.
 * 1. keeps voiced frames with clarity >= SING_MIN_CLARITY; drops the first skipSeconds after the
 *    voice starts (the scoop into the note);
 * 2. folds to the octave nearest targetFreq (any octave counts; single-frame octave slips of the
 *    detector are folded back too);
 * 3. finds the steadiest stretch of >= 1 s (lowest spread in cents; among nearly-as-steady
 *    stretches the latest, then extended while it stays that steady);
 * 4. sungFreq = median there (folded), rawFreq = what was actually sung (octaveShift octaves away:
 *    -1 = an octave lower), steadinessCents = standard deviation in the stretch.
 * trace: every voiced frame as { time, cents } relative to the target, after folding.
 * Not ok -> { ok: false, code: 'no-voice' | 'too-short', reason: plain sentence, trace }.
 * @param {object[]} frames @param {{targetFreq: number, skipSeconds?: number}} opts
 */
export function analyzeTake(frames, { targetFreq, skipSeconds = 0.4 } = {}) {
  if (!finite(targetFreq) || targetFreq <= 0) throw new Error(`analyzeTake: targetFreq must be a positive number, got ${targetFreq}`);
  const voiced = (Array.isArray(frames) ? frames : [])
    .filter((f) => f && finite(f.time) && finite(f.freq) && f.freq > 0 && finite(f.clarity) && f.clarity >= SING_MIN_CLARITY)
    .sort((a, b) => a.time - b.time);

  const result = (fields) => ({
    ok: false, code: null, reason: null, sungFreq: null, rawFreq: null, sungCents: null, octaveShift: 0,
    steadyStart: null, steadyEnd: null, steadinessCents: null, trace: [], voicedSeconds: 0, ...fields,
  });
  if (!voiced.length) return result({ code: 'no-voice', reason: TAKE_REASONS['no-voice'] });

  const raw = voiced.map((f) => 1200 * Math.log2(f.freq / targetFreq));
  const start = voiced[0].time;
  const usable = [];
  voiced.forEach((f, i) => { if (f.time >= start + skipSeconds - 1e-9) usable.push(i); });

  // Octave: from the median of what counts (or of everything if nothing is left after the skip).
  const ref = median(usable.length ? usable.map((i) => raw[i]) : raw);
  const octaveShift = Math.round(ref / 1200);
  const centre = ref - 1200 * octaveShift;
  const folded = raw.map((c) => {
    let x = c - 1200 * octaveShift;
    while (x - centre > 600) x -= 1200;
    while (x - centre < -600) x += 1200;
    return x;
  });
  const trace = voiced.map((f, i) => ({ time: f.time, cents: round1(folded[i]) }));
  const diffs = voiced.slice(1).map((f, i) => f.time - voiced[i].time).filter((d) => d > 0);
  const dt = diffs.length ? Math.min(0.05, median(diffs)) : 0.02;
  const voicedSeconds = round1(voiced.length * dt);
  const tooShort = () => result({ code: 'too-short', reason: TAKE_REASONS['too-short'], trace, octaveShift: 0, voicedSeconds });
  if (!usable.length) return tooShort();

  // Continuous segments of usable frames.
  const segments = [];
  let seg = [usable[0]];
  for (let n = 1; n < usable.length; n++) {
    const i = usable[n];
    if (voiced[i].time - voiced[seg[seg.length - 1]].time > MAX_GAP_SECONDS) {
      segments.push(seg);
      seg = [];
    }
    seg.push(i);
  }
  segments.push(seg);

  // All >= 1 s windows: (segment, a, b) with spread in cents.
  const windows = [];
  const prepared = segments.map((s) => {
    const t = s.map((i) => voiced[i].time);
    const c = s.map((i) => folded[i]);
    const s1 = [0], s2 = [0];
    c.forEach((x, k) => { s1.push(s1[k] + x); s2.push(s2[k] + x * x); });
    const sd = (a, b) => {
      const n = b - a + 1;
      const m = (s1[b + 1] - s1[a]) / n;
      return Math.sqrt(Math.max(0, (s2[b + 1] - s2[a]) / n - m * m));
    };
    return { t, c, sd };
  });
  prepared.forEach((p, si) => {
    let b = 0;
    for (let a = 0; a < p.t.length; a++) {
      if (b < a) b = a;
      while (b < p.t.length && p.t[b] - p.t[a] + dt < MIN_STEADY_SECONDS - 1e-3) b++;
      if (b >= p.t.length) break;
      windows.push({ si, a, b, sd: p.sd(a, b), time: p.t[a] });
    }
  });
  if (!windows.length) return tooShort();

  const sdMin = Math.min(...windows.map((w) => w.sd));
  const limit = Math.max(sdMin + 3, sdMin * 1.3);
  const pick = windows.filter((w) => w.sd <= limit).reduce((best, w) => (w.time > best.time ? w : best));
  const p = prepared[pick.si];
  let { a, b } = pick;
  while (b + 1 < p.t.length && p.sd(a, b + 1) <= limit) b++;
  while (a - 1 >= 0 && p.sd(a - 1, b) <= limit) a--;

  const stretch = p.c.slice(a, b + 1);
  const sungCents = median(stretch);
  const sungFreq = targetFreq * Math.pow(2, sungCents / 1200);
  return {
    ok: true,
    code: null,
    reason: null,
    sungFreq,
    rawFreq: sungFreq * Math.pow(2, octaveShift),
    sungCents: round1(sungCents),
    octaveShift,
    steadyStart: p.t[a],
    steadyEnd: p.t[b],
    steadinessCents: round1(p.sd(a, b)),
    trace,
    voicedSeconds,
  };
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

const centsText = formatCents; // the one rule for showing cents (tuning.js)

/** Plain sentence about how steady the held note was (second feedback line). */
export function steadinessSentence(sd) {
  const n = Math.abs(roundCents(sd));
  const c = formatCents(n);
  if (n <= 8) return `Held steady (±${c}).`;
  if (n <= 15) return `Fairly steady (±${c}).`;
  return `Your note wobbled (±${c}). Try a straighter tone.`;
}

/** Friendly remark when the note was sung in another octave (null when not). */
export function octaveSentence(shift) {
  if (!shift) return null;
  const n = Math.abs(shift);
  const amount = n === 1 ? 'an octave' : n === 2 ? 'two octaves' : `${n} octaves`;
  return `You sang ${amount} ${shift < 0 ? 'lower' : 'higher'} — that's fine.`;
}

/**
 * Feedback on a recording: the same levels, patterns and closer-to-other-tuning sentences as
 * tune-it evaluate (descending included). message = first line; detail = second line: tip (sevenths),
 * steadiness ('Held steady (±4 cents).') and, when sung in another octave, 'You sang an octave
 * lower — that's fine.'. Echo: 'Spot on — 2 cents above the note.' / 'Good — … A touch lower next
 * time.' / 'Close — … Try a little higher.' / 'Keep going — 24 cents below the note. Listen once more,
 * then go higher.' (no tuning comparison: it is a unison).
 * level: 'in-tune' (≤7 cents) | 'close' (≤15) | 'keep-going'.
 * Not-ok analysis -> { ok: false, level: null, rating: null, message: analysis.reason, detail: null, ... }.
 * @param {object} question makeMatchQuestion / makeSingQuestion @param {object} analysis analyzeTake result
 */
export function evaluateSing(question, analysis) {
  if (!analysis || !analysis.ok) {
    return {
      ok: false, errorCents: null, absError: null, comparison: null, rating: null, level: null,
      message: (analysis && analysis.reason) || TAKE_REASONS['cant-measure'], detail: null,
      midi: null, motion: question.motion || 'up', steadinessCents: null, octaveShift: 0,
    };
  }
  const second = [steadinessSentence(analysis.steadinessCents), octaveSentence(analysis.octaveShift)].filter(Boolean).join(' ');
  const midi = describeFreq(question.target.targetFreq).midi;

  if (question.kind === 'match') {
    const errorCents = 1200 * Math.log2(analysis.sungFreq / question.target.targetFreq);
    const absError = Math.abs(errorCents);
    const hint = errorCents > 0 ? 'lower' : 'higher';
    const message = producingMessage({ errorCents, target: 'the note', keepGoingTail: `Listen once more, then go ${hint}.` });
    return {
      ok: true, errorCents, absError, comparison: null, rating: ratingFor(absError), level: levelFor(absError),
      message, detail: second, midi, motion: 'up', steadinessCents: analysis.steadinessCents, octaveShift: analysis.octaveShift,
    };
  }

  const r = evaluate(question, analysis.sungFreq);
  return {
    ok: true, ...r, detail: [r.detail, second].filter(Boolean).join(' '),
    steadinessCents: analysis.steadinessCents, octaveShift: analysis.octaveShift,
  };
}

/**
 * Hands-free singing (tap to start / tap to stop): should the recording end now?
 * Ends after `silenceMs` without clear voice once at least `minVoiceMs` of voice was heard, or
 * after `maxMs` in total. frames: [{ time (s), freq, clarity }] since the recording started.
 * @param {object[]} frames @param {{silenceMs?: number, minVoiceMs?: number, maxMs?: number}} [opts]
 * @returns {{end: boolean, reason: 'silence'|'max'|null, voicedMs: number, silentMs: number}}
 */
export function detectTakeEnd(frames, { silenceMs = 700, minVoiceMs = 2000, maxMs = 6000 } = {}) {
  const list = (Array.isArray(frames) ? frames : []).filter((f) => f && finite(f.time)).sort((a, b) => a.time - b.time);
  if (!list.length) return { end: false, reason: null, voicedMs: 0, silentMs: 0 };
  const isVoiced = (f) => finite(f.freq) && f.freq > 0 && finite(f.clarity) && f.clarity >= SING_MIN_CLARITY;
  const diffs = list.slice(1).map((f, i) => f.time - list[i].time).filter((d) => d > 0);
  const dt = diffs.length ? Math.min(0.05, median(diffs)) : 0.02;
  const voiced = list.filter(isVoiced);
  const voicedMs = Math.round(voiced.length * dt * 1000);
  const now = list[list.length - 1].time;
  const lastVoice = voiced.length ? voiced[voiced.length - 1].time : null;
  const silentMs = lastVoice === null ? Math.round((now - list[0].time) * 1000) : Math.round((now - lastVoice) * 1000);
  if ((now - list[0].time) * 1000 >= maxMs - 1e-6) return { end: true, reason: 'max', voicedMs, silentMs };
  if (voicedMs >= minVoiceMs && lastVoice !== null && silentMs >= silenceMs) return { end: true, reason: 'silence', voicedMs, silentMs };
  return { end: false, reason: null, voicedMs, silentMs };
}

/**
 * Note names after a take: the target(s) and what was sung (in the octave actually sung).
 * -> { title, notes: [{ label, name, cents, played, inTune }], sung: 'You sang A3 +12' | null, octaveShift }
 * (piano-grid names; kept until the UI uses the fields below), plus — design critique #1 —
 * names spelled for the key / interval / chord and the deviation measured against the TARGET:
 *   heading: 'The note: F♯4' (Echo) | tune-it heading ('Major third above D4', 'D major'),
 *   chord: 'D major' | null,
 *   tones: [{ label, name, deviation, secondary, isOff: false, isYours }] — given notes name only;
 *     the last entry is what you sang (isYours, named in the octave actually sung),
 *   yourNote: { name: 'D5', deviation: { cents, text: '8 cents above the note' }, secondary: null,
 *               text: 'You sang D5 · 8 cents above the note' } | null (no usable take).
 *   Join the chord: deviation '8 cents above pure' (chosen tuning), secondary '6 cents below piano'
 *   when pure and piano differ by more than 3 cents.
 */
export function describeSing(question, analysis) {
  const ok = analysis && analysis.ok;
  const sung = ok ? describeFreq(analysis.rawFreq) : null;
  const shift = ok ? analysis.octaveShift : 0;
  if (question.kind === 'match') {
    const target = describeFreq(question.target.targetFreq);
    const played = sung || target;
    const note = rootName(question.target.targetFreq);
    const yours = ok ? shiftOctave(note, shift) : null;
    const dev = ok ? deviation(analysis.sungCents, 'above the note', 'below the note', 'in tune') : null;
    return {
      title: `The note: ${target.text}`,
      notes: [{ label: 'The note', name: played.name, cents: played.cents, played, inTune: target }],
      sung: sung ? `You sang ${sung.text}` : null,
      octaveShift: shift,
      heading: `The note: ${note.name}`,
      chord: null,
      tones: [
        { label: 'The note', name: note.name, deviation: null, secondary: null, isOff: false, isYours: false },
        ...(ok ? [{ label: 'You sang', name: yours.name, deviation: dev, secondary: null, isOff: false, isYours: true }] : []),
      ],
      yourNote: ok ? { name: yours.name, deviation: dev, secondary: null, text: `You sang ${yours.name} \u00b7 ${dev.text}` } : null,
    };
  }
  const d = describe(question, ok ? analysis.rawFreq : undefined);
  const sp = spellTask(question);
  const fixedTones = question.fixedTones.map((t, i) => ({ label: t.label, name: sp.fixed[i].name, deviation: null, secondary: null, isOff: false, isYours: false }));
  let tones = [...fixedTones, { label: question.target.label, name: sp.target.name, deviation: null, secondary: null, isOff: false, isYours: true }];
  let yourNote = null;
  if (ok) {
    const name = shiftOctave(sp.target, shift).name;
    const { deviation: dev, secondary } = targetDeviation(question, analysis.sungFreq); // folded: vs the target octave
    tones = [...fixedTones, { label: question.target.label, name, deviation: dev, secondary, isOff: false, isYours: true }];
    yourNote = { name, deviation: dev, secondary, text: `You sang ${name} \u00b7 ${dev.text}` };
  }
  return {
    ...d,
    sung: sung ? `You sang ${sung.text}` : null,
    octaveShift: shift,
    heading: sp.heading,
    chord: sp.chord,
    tones,
    yourNote,
  };
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

/**
 * Save one take's result (from evaluateSing). key: 'sing-match' (taskKey 'match') or 'sing'
 * (a TUNE_TASKS key). Results that are not ok are not recorded (returns null).
 * `now` (optional Date) is for tests. Returns the updated getSingStats(key).
 */
export function recordSingResult(key, taskKey, result, opts = {}) {
  const store = storeFor(key);
  if (!result || !result.ok) return null;
  return store.record(taskKey, result, opts);
}

/**
 * Stats, same shape as getTuneStats, plus steadinessCents (overall and per task: average of the
 * recent standard deviations).
 */
export function getSingStats(key) {
  return storeFor(key).stats();
}

/** Insights (same shape as getTuneInsights, plus steadinessCents and steadiness sentences). */
export function getSingInsights(key) {
  return storeFor(key).insights();
}

/** Clean saved data or null (for export). */
export function getSingData(key) {
  return storeFor(key).data();
}
