// Per-chapter progress on top of storage.js: the staircase (difficulty) state, totals,
// current streak, best threshold, a per-day history, a bounded per-answer log for the
// blind-spot insights, and personal ranks. No DOM, no audio.
//
// Saved shape (storage key per chapter):
//   { version: 2, staircase: <staircase.state()>, answered, correct, streak, bestStreak,
//     bestThresholdCents, history: [{ date: 'YYYY-MM-DD', answered, correct, levelCents }],
//     log: [{ c: 0|1, l: levelCents, m: midi|null, d: direction|null, a: answer|null,
//             t: toneLabel|null, h: chordKey|null } ...last INSIGHT_LOG_MAX] }
// Version-1 data (no log) loads fine.

import { getProgress, saveProgress, getSettings, updateSettings } from '../storage.js';
import { CHORDS, TUNINGS, VOICE_PARTS, registerBand } from '../music/tuning.js';
import { createStaircase } from './staircase.js';
import { tuneStore, TUNE_IT_KEY, RATING_LIMITS } from './tune-it.js';
import { SING_STORES, SING_MATCH_KEY, SING_KEY } from './sing.js';

/** Every chapter key that stores progress. */
export const CHAPTER_KEYS = Object.freeze(['higher-or-lower', 'odd-one-out', 'odd-or-in-tune', TUNE_IT_KEY, SING_MATCH_KEY, SING_KEY]);

/** Chapters measured as an error in cents (no staircase): their shared stores (error-store.js). */
const ERROR_STORES = Object.freeze({
  [TUNE_IT_KEY]: tuneStore,
  [SING_MATCH_KEY]: SING_STORES[SING_MATCH_KEY],
  [SING_KEY]: SING_STORES[SING_KEY],
});
const errorStore = (key) => (Object.prototype.hasOwnProperty.call(ERROR_STORES, key) ? ERROR_STORES[key] : null);

/** Default staircase options for Chapter 1 ("Higher or lower?"), in cents. */
export const HIGHER_LOWER_STAIRCASE = Object.freeze({ start: 40, min: 1, max: 100 });
/** Default staircase options for Chapter 2 ("Odd one out"), in cents. */
export const ODD_ONE_OUT_STAIRCASE = Object.freeze({ start: 35, min: 3, max: 80 });
/** Default staircase options for the "odd one out — or all in tune?" variant, in cents. */
export const ODD_OR_IN_TUNE_STAIRCASE = Object.freeze({ start: 35, min: 3, max: 80 });
/** Default staircase options by chapter key. */
export const DEFAULT_STAIRCASE_OPTS = Object.freeze({
  'higher-or-lower': HIGHER_LOWER_STAIRCASE,
  'odd-one-out': ODD_ONE_OUT_STAIRCASE,
  'odd-or-in-tune': ODD_OR_IN_TUNE_STAIRCASE,
});

/** Maximum number of days kept in the history. */
export const HISTORY_MAX_DAYS = 365;
/** Maximum number of per-answer details kept per chapter (for insights). */
export const INSIGHT_LOG_MAX = 500;
/** Answers a group needs before insights report it. */
export const INSIGHT_MIN_GROUP = 8;
/** Smallest accuracy difference (0..1) worth a strength / blind-spot sentence. */
export const INSIGHT_MIN_DIFF = 0.15;

/** Question directions on which the staircase does not move (nothing to hear). */
const NON_ADAPTIVE_DIRECTIONS = ['same', 'none'];

const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);

function defaultOpts(chapterKey) {
  return own(DEFAULT_STAIRCASE_OPTS, chapterKey) ? DEFAULT_STAIRCASE_OPTS[chapterKey] : {};
}

function count(x) {
  return Number.isInteger(x) && x > 0 ? x : 0;
}

function posOrNull(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
}

const strOrNull = (x) => (typeof x === 'string' && x ? x : null);
const numOrNull = (x) => (typeof x === 'number' && Number.isFinite(x) ? x : null);

/** Local calendar date as 'YYYY-MM-DD'. */
function localDate(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** Saved data for a chapter, sanitized (never throws, never null). */
function load(chapterKey) {
  const raw = getProgress(chapterKey);
  const d = raw && typeof raw === 'object' ? raw : {};
  const history = Array.isArray(d.history)
    ? d.history
        .filter((h) => h && typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
        .map((h) => ({
          date: h.date,
          answered: count(h.answered),
          correct: count(h.correct),
          levelCents: posOrNull(h.levelCents),
        }))
    : [];
  const log = Array.isArray(d.log)
    ? d.log
        .filter((x) => x && (x.c === 0 || x.c === 1) && posOrNull(x.l) !== null)
        .map((x) => ({
          c: x.c, l: x.l, m: numOrNull(x.m), d: strOrNull(x.d), a: strOrNull(x.a), t: strOrNull(x.t), h: strOrNull(x.h),
        }))
        .slice(-INSIGHT_LOG_MAX)
    : [];
  return {
    version: 2,
    staircase: d.staircase && typeof d.staircase === 'object' ? d.staircase : null,
    answered: count(d.answered),
    correct: count(d.correct),
    streak: count(d.streak),
    bestStreak: count(d.bestStreak),
    bestThresholdCents: posOrNull(d.bestThresholdCents),
    history,
    log,
  };
}

function statsFrom(chapterKey, data) {
  const st = createStaircase(defaultOpts(chapterKey), data.staircase);
  return {
    answered: data.answered,
    correct: data.correct,
    streak: data.streak,
    bestStreak: data.bestStreak,
    levelCents: st.level(),
    thresholdCents: st.threshold(),
    bestThresholdCents: data.bestThresholdCents,
    history: data.history.map((h) => ({ ...h })),
  };
}

/**
 * Staircase for a chapter, resumed from saved progress if any.
 * opts override the chapter defaults (DEFAULT_STAIRCASE_OPTS).
 * @param {string} chapterKey @param {object} [opts]
 */
export function loadStaircase(chapterKey, opts) {
  const data = load(chapterKey);
  return createStaircase({ ...defaultOpts(chapterKey), ...(opts || {}) }, data.staircase);
}

/**
 * Record one answer: moves the staircase, updates totals/streak/history, logs the detail
 * for insights, and saves. `now` (optional Date) is for tests.
 * detail (optional): { midi, toneLabel?, direction, answer, chordKey?, cents } — see
 * answerDetail() in higher-lower.js / odd-one-out.js. When detail.direction is 'same' or
 * 'none' (nothing was changed, so there was nothing to hear) the staircase does NOT move,
 * but the answer still counts in totals, streak, history and insights.
 * @param {string} chapterKey @param {object} staircase from loadStaircase
 * @param {{correct: boolean, detail?: object, now?: Date}} result
 * @returns {{level: number, previousLevel: number, direction: 'harder'|'easier'|'same',
 *   moved: boolean, stats: object}}
 */
export function recordResult(chapterKey, staircase, { correct, detail = null, now = new Date() }) {
  const ok = !!correct;
  const usedLevel = staircase.level();
  const moved = !(detail && NON_ADAPTIVE_DIRECTIONS.includes(detail.direction));
  const r = moved
    ? staircase.record(ok)
    : { level: usedLevel, previousLevel: usedLevel, direction: 'same' };
  const data = load(chapterKey);

  data.staircase = staircase.state();
  data.answered += 1;
  if (ok) data.correct += 1;
  data.streak = ok ? data.streak + 1 : 0;
  data.bestStreak = Math.max(data.bestStreak, data.streak);

  const threshold = staircase.threshold();
  if (threshold !== null && (data.bestThresholdCents === null || threshold < data.bestThresholdCents)) {
    data.bestThresholdCents = threshold;
  }

  const date = localDate(now);
  let day = data.history[data.history.length - 1];
  if (!day || day.date !== date) {
    day = { date, answered: 0, correct: 0, levelCents: null };
    data.history.push(day);
  }
  day.answered += 1;
  if (ok) day.correct += 1;
  day.levelCents = r.level;
  if (data.history.length > HISTORY_MAX_DAYS) data.history = data.history.slice(-HISTORY_MAX_DAYS);

  if (detail && typeof detail === 'object') {
    data.log.push({
      c: ok ? 1 : 0,
      l: posOrNull(detail.cents) || usedLevel,
      m: numOrNull(detail.midi) === null ? null : Math.round(detail.midi),
      d: strOrNull(detail.direction),
      a: strOrNull(detail.answer),
      t: strOrNull(detail.toneLabel),
      h: strOrNull(detail.chordKey),
    });
    if (data.log.length > INSIGHT_LOG_MAX) data.log = data.log.slice(-INSIGHT_LOG_MAX);
  }

  saveProgress(chapterKey, data);
  return { ...r, moved, stats: statsFrom(chapterKey, data) };
}

/**
 * Stats for a chapter (zeros and the default start level if nothing is saved).
 * @param {string} chapterKey
 * @returns {{answered: number, correct: number, streak: number, bestStreak: number,
 *   levelCents: number, thresholdCents: number|null, bestThresholdCents: number|null,
 *   history: {date: string, answered: number, correct: number, levelCents: number|null}[]}}
 */
export function getStats(chapterKey) {
  return statsFrom(chapterKey, load(chapterKey));
}

/** Forget all progress for a chapter. */
export function resetProgress(chapterKey) {
  saveProgress(chapterKey, null);
}

/** Forget all progress for every chapter (CHAPTER_KEYS, including 'tune-it'). */
export function resetAllProgress() {
  for (const key of CHAPTER_KEYS) resetProgress(key);
}

// ---------------------------------------------------------------------------
// Insights — where are the blind spots?
// ---------------------------------------------------------------------------
//
// Accuracy depends on difficulty (the staircase level at the time), and the level drifts
// as the singer improves. So a group is never compared with the rest on raw accuracy:
// answers are put into narrow difficulty bins (levels within a factor 1.4), and the rest's
// accuracy is re-weighted to the group's mix of difficulties ("at similar difficulty").
// A sentence is only produced when the difference is >= 15 points, both sides have
// >= 8 answers, and the difference is at least twice its rough standard error.

const LEVEL_BIN_RATIO = 1.4;
const levelBin = (l) => Math.floor(Math.log(l) / Math.log(LEVEL_BIN_RATIO));
const pct = (x) => `${Math.round(x * 100)}%`;
const capFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** Difficulty-adjusted comparison of entries A vs entries B. */
function compareGroups(A, B) {
  const bins = new Map();
  const add = (x, side) => {
    const k = levelBin(x.l);
    if (!bins.has(k)) bins.set(k, { nA: 0, cA: 0, nB: 0, cB: 0 });
    const b = bins.get(k);
    b[`n${side}`] += 1;
    b[`c${side}`] += x.c;
  };
  A.forEach((x) => add(x, 'A'));
  B.forEach((x) => add(x, 'B'));
  let nA = 0, cA = 0, nB = 0, cB = 0;
  for (const b of bins.values()) {
    if (b.nA && b.nB) { nA += b.nA; cA += b.cA; nB += b.nB; cB += b.cB; }
  }
  if (!nA || !nB) return null;
  let accB = 0;
  for (const b of bins.values()) if (b.nA && b.nB) accB += (b.nA / nA) * (b.cB / b.nB);
  const accA = cA / nA;
  const diff = accA - accB;
  const p = (cA + cB) / (nA + nB);
  const se = Math.sqrt(p * (1 - p) * (1 / nA + 1 / nB));
  const clear = nA >= INSIGHT_MIN_GROUP && nB >= INSIGHT_MIN_GROUP &&
    Math.abs(diff) >= INSIGHT_MIN_DIFF && Math.abs(diff) >= 2 * se;
  return { accA, accB, diff, nA, nB, clear };
}

function groupSummary(entries) {
  const correct = entries.reduce((a, x) => a + x.c, 0);
  return { answered: entries.length, correct, accuracy: entries.length ? Math.round((correct / entries.length) * 1000) / 1000 : null };
}

const DIRECTION_LABELS = {
  'higher-or-lower': { sharp: 'Second note higher (sharp)', flat: 'Second note lower (flat)', same: 'Exactly the same' },
  default: { sharp: 'One note sharp', flat: 'One note flat', none: 'All in tune' },
};

const TONE_ORDER = ['Root', 'Third', 'Fifth', 'Seventh'];

/**
 * Blind-spot insights for a chapter, from the last INSIGHT_LOG_MAX answers recorded with a
 * `detail`. Groups (raw accuracy) only appear with >= INSIGHT_MIN_GROUP answers.
 * strengths / blindSpots are plain sentences based on difficulty-adjusted comparisons.
 * For 'tune-it', 'sing-match' and 'sing' this returns the error-based insights of that store
 * (getTuneInsights / getSingInsights: error in cents instead of accuracy).
 * @param {string} chapterKey
 * @returns {{answered: number, byRegister: object[], byDirection: object[], byTone?: object[],
 *   byChord?: object[], strengths: string[], blindSpots: string[]}}
 */
export function getInsights(chapterKey) {
  if (errorStore(chapterKey)) return errorStore(chapterKey).insights();
  const log = load(chapterKey).log;
  const isChord = chapterKey !== 'higher-or-lower';
  const subject = isChord ? 'chords rooted' : 'notes';
  const found = []; // { kind: 'strength'|'blind', text, size }
  const note = (cmp, strengthText, blindText) => {
    if (!cmp || !cmp.clear) return;
    const nums = `(${pct(cmp.accA)} vs ${pct(cmp.accB)}`;
    if (cmp.diff > 0 && strengthText) found.push({ kind: 'strength', text: strengthText(nums), size: cmp.diff });
    if (cmp.diff < 0 && blindText) found.push({ kind: 'blind', text: blindText(nums), size: -cmp.diff });
  };
  // Sharp-vs-flat difference: always a blind spot, phrased from the easier side.
  const asymmetry = (cmp, what, tail) => {
    if (!cmp || !cmp.clear) return;
    const [hi, lo, a, b] = cmp.diff > 0 ? ['sharp', 'flat', cmp.accA, cmp.accB] : ['flat', 'sharp', cmp.accB, cmp.accA];
    found.push({ kind: 'blind', text: `You catch a ${hi} ${what} much more often than a ${lo} one (${pct(a)} vs ${pct(b)}${tail}).`, size: Math.abs(cmp.diff) });
  };
  const result = { answered: log.length };

  // --- register (one band per octave, C to B) ---
  const reg = new Map();
  for (const x of log) {
    if (x.m === null) continue;
    const b = registerBand(x.m);
    if (!reg.has(b.index)) reg.set(b.index, { label: b.label, index: b.index, entries: [] });
    reg.get(b.index).entries.push(x);
  }
  const regGroups = [...reg.values()].filter((g) => g.entries.length >= INSIGHT_MIN_GROUP).sort((a, b) => a.index - b.index);
  result.byRegister = regGroups.map((g) => ({ label: g.label, ...groupSummary(g.entries) }));
  if (reg.size >= 2) {
    for (const g of regGroups) {
      const rest = log.filter((x) => x.m !== null && registerBand(x.m).index !== g.index);
      note(compareGroups(g.entries, rest),
        (n) => `You do especially well with ${subject} in the ${g.label} range ${n} elsewhere, at similar difficulty).`,
        (n) => `${capFirst(subject)} in the ${g.label} range are harder for you ${n} elsewhere, at similar difficulty).`);
    }
  }

  // --- direction ---
  const labels = DIRECTION_LABELS[chapterKey] || DIRECTION_LABELS.default;
  const byDir = (d) => log.filter((x) => x.d === d);
  result.byDirection = Object.keys(labels)
    .map((key) => ({ key, label: labels[key], ...groupSummary(byDir(key)) }))
    .filter((g) => g.answered >= INSIGHT_MIN_GROUP);
  const what = isChord ? 'note' : 'change';
  asymmetry(compareGroups(byDir('sharp'), byDir('flat')), what, ', at similar difficulty');
  const nothing = chapterKey === 'higher-or-lower' ? 'same' : 'none';
  const changed = log.filter((x) => x.d === 'sharp' || x.d === 'flat');
  if (byDir(nothing).length) {
    note(compareGroups(byDir(nothing), changed),
      (n) => nothing === 'same'
        ? `You're good at recognising when two notes are exactly the same ${n} on the other questions).`
        : `You reliably recognise a chord that is perfectly in tune ${n} on the other questions).`,
      (n) => nothing === 'same'
        ? `When the two notes are exactly the same, you often hear a difference that isn't there ${n} on the other questions).`
        : `When the chord is perfectly in tune, you often still hear a problem ${n} on the other questions).`);
  }

  if (isChord) {
    // --- tone that was off ---
    const toned = log.filter((x) => x.t !== null);
    const tones = [...new Set(toned.map((x) => x.t))].sort((a, b) => TONE_ORDER.indexOf(a) - TONE_ORDER.indexOf(b));
    result.byTone = tones
      .map((t) => ({ label: t, ...groupSummary(toned.filter((x) => x.t === t)) }))
      .filter((g) => g.answered >= INSIGHT_MIN_GROUP);
    for (const t of tones) {
      const name = t.toLowerCase();
      const mine = toned.filter((x) => x.t === t);
      if (tones.length >= 2) {
        note(compareGroups(mine, toned.filter((x) => x.t !== t)),
          (n) => `You're quick to spot a mistuned ${name} ${n} for the other notes, at similar difficulty).`,
          (n) => `A mistuned ${name} is harder for you to spot than the other notes ${n}, at similar difficulty).`);
      }
      asymmetry(compareGroups(mine.filter((x) => x.d === 'sharp'), mine.filter((x) => x.d === 'flat')), name, '');
    }

    // --- chord type ---
    // only questions with a mistuned note ("all in tune" questions are covered above)
    const chorded = log.filter((x) => x.h !== null && own(CHORDS, x.h) && (x.d === 'sharp' || x.d === 'flat'));
    const chordKeys = [...new Set(chorded.map((x) => x.h))];
    result.byChord = chordKeys
      .map((k) => ({ key: k, label: CHORDS[k].name, ...groupSummary(chorded.filter((x) => x.h === k)) }))
      .filter((g) => g.answered >= INSIGHT_MIN_GROUP);
    if (chordKeys.length >= 2) {
      for (const k of chordKeys) {
        const plural = `${CHORDS[k].name.toLowerCase()}s`;
        note(compareGroups(chorded.filter((x) => x.h === k), chorded.filter((x) => x.h !== k)),
          (n) => `You do especially well with ${plural} ${n} in the other chords, at similar difficulty).`,
          (n) => `Mistunings in ${plural} are harder for you to spot ${n} in the other chords, at similar difficulty).`);
      }
    }
  }

  const pick = (kind) => found.filter((f) => f.kind === kind).sort((a, b) => b.size - a.size).slice(0, 4).map((f) => f.text);
  result.strengths = pick('strength');
  result.blindSpots = pick('blind');
  return result;
}

// ---------------------------------------------------------------------------
// Ranks — personal skill tiers (no server, no comparison with other users)
// ---------------------------------------------------------------------------

const TIER_NAMES = ['Getting started', 'Tuning in', 'Good ear', 'Keen ear', 'Section leader', 'Golden ears'];

const LISTENING_DESCRIPTIONS = [
  'You hear clear mistunings. Every singer starts here, and the ear improves quickly with practice.',
  'You notice when a neighbour is clearly off: the obvious sour notes in a rehearsal.',
  'You catch the slips that make a chord sound sour, before the conductor has to stop the choir.',
  'You hear small drifts that most singers miss, so you can fix your own pitch while you sing.',
  'You can tell when a chord is almost, but not quite, locked in: the ear a section leader needs.',
  'You hear differences of a few cents: the level where chords ring and overtones bloom.',
];

const TUNING_DESCRIPTIONS = [
  'Your note lands in the right area. Listen for the wobble (beating) and follow it until it slows down.',
  'You get close, like a singer who finds the note but still slides around on it.',
  'Your tuning would pass in most choirs; careful listening will bring the last few cents.',
  'You place notes accurately enough that the chords around you start to blend.',
  'You tune like an experienced chorister: chords settle and ring when you join in.',
  'You place notes within a few cents: the precision of top chamber choirs.',
];

const SINGING_DESCRIPTIONS = [
  'Your voice finds the area of the note. Hold it steadily and listen — the rest comes with practice.',
  'You land near the note; in a full choir you blend in, and careful listening will bring you closer.',
  'You sing in tune well enough for most choir music; the last few cents come from listening while you sing.',
  'You place your notes accurately, so the chords around you start to ring.',
  'You sing reliably in tune: the singers next to you can lean on your pitch.',
  'You sing within a few cents of the target: the precision of top chamber choirs.',
];

// A tier is reached when the measure (cents, lower = better) is <= its maxCents.
// Chapter 1 (two notes one after another) allows the finest thresholds; Chapter 2
// (one tone inside a chord) is harder to pin down; tune-it uses the average error.
// Singing (average error of the sung note) is harder to control than a slider, so its
// cut-offs are a little wider.
const RANK_CUTOFFS = {
  'higher-or-lower': [Infinity, 30, 18, 10, 6, 3],
  'odd-one-out': [Infinity, 30, 20, 13, 8, 5],
  'odd-or-in-tune': [Infinity, 30, 20, 13, 8, 5],
  [TUNE_IT_KEY]: [Infinity, 20, 12, 8, 5, 3],
  [SING_MATCH_KEY]: [Infinity, 25, 15, 10, 6, 4],
  [SING_KEY]: [Infinity, 25, 15, 10, 7, 4],
};

const descriptionsFor = (key) => {
  if (key === TUNE_IT_KEY) return TUNING_DESCRIPTIONS;
  if (key === SING_MATCH_KEY || key === SING_KEY) return SINGING_DESCRIPTIONS;
  return LISTENING_DESCRIPTIONS;
};

/**
 * Rank tiers per chapter: { [chapterKey]: [{ name, maxCents, description }] }, lowest tier
 * first. The first tier has maxCents = Infinity (everyone starts there).
 */
export const RANK_TIERS = Object.freeze(
  Object.fromEntries(
    Object.entries(RANK_CUTOFFS).map(([key, cutoffs]) => [
      key,
      Object.freeze(
        cutoffs.map((maxCents, i) =>
          Object.freeze({
            name: TIER_NAMES[i],
            maxCents,
            description: descriptionsFor(key)[i],
          })
        )
      ),
    ])
  )
);

/** Answers needed in a listening chapter before it gets a rank. */
export const LISTENING_RANK_MIN_ANSWERS = 10;
/** Tune-it attempts needed before it gets a rank (one lucky try is not a rank). */
export const TUNE_IT_RANK_MIN_ATTEMPTS = 5;
/** Attempts at one tune-it task needed before that task gets its own rank. */
export const TUNE_IT_TASK_RANK_MIN_ATTEMPTS = 5;
/** Takes needed in a singing chapter (and per 'sing' task) before it gets a rank. */
export const SING_RANK_MIN_ATTEMPTS = 5;
/** Minimum answers / attempts before a rank is given, by chapter key. */
export const RANK_MIN_ATTEMPTS = Object.freeze({
  'higher-or-lower': LISTENING_RANK_MIN_ANSWERS,
  'odd-one-out': LISTENING_RANK_MIN_ANSWERS,
  'odd-or-in-tune': LISTENING_RANK_MIN_ANSWERS,
  [TUNE_IT_KEY]: TUNE_IT_RANK_MIN_ATTEMPTS,
  [SING_MATCH_KEY]: SING_RANK_MIN_ATTEMPTS,
  [SING_KEY]: SING_RANK_MIN_ATTEMPTS,
});
const TASK_RANK_MIN_ATTEMPTS = { [TUNE_IT_KEY]: TUNE_IT_TASK_RANK_MIN_ATTEMPTS, [SING_MATCH_KEY]: SING_RANK_MIN_ATTEMPTS, [SING_KEY]: SING_RANK_MIN_ATTEMPTS };

function posNum(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0 ? x : null;
}

const validError = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;

/**
 * Personal rank for a chapter, from the best available measure (lower cents = better):
 * listening chapters use thresholdCents if known, else levelCents; 'tune-it', 'sing-match'
 * and 'sing' use the recent average absolute error across tasks, or with opts.taskKey that
 * task's own recent average (5 attempts at that task needed). Until enough answers /
 * attempts are made there is no rank yet: basis and measureCents are null (index 0).
 * @param {string} chapterKey
 * @param {object} [stats] getStats(chapterKey), getTuneStats() or getSingStats(key)
 * @param {{taskKey?: string}} [opts] error-based chapters only: rank for one task
 * @returns {{index: number, name: string, description: string,
 *   tiers: {name: string, maxCents: number}[], nextName: string|null, nextAtCents: number|null,
 *   measureCents: number|null, basis: 'threshold'|'level'|'tuneError'|'singError'|null}}
 */
export function getRank(chapterKey, stats, opts = {}) {
  if (!own(RANK_TIERS, chapterKey)) {
    throw new Error(`getRank: unknown chapter key "${chapterKey}"`);
  }
  const tiers = RANK_TIERS[chapterKey];
  let measureCents = null;
  let basis = null;
  const store = errorStore(chapterKey);
  if (store) {
    const s = stats || store.stats();
    const taskKey = opts && opts.taskKey;
    if (taskKey !== undefined && taskKey !== null) {
      if (!store.taskKeys.includes(taskKey)) throw new Error(`getRank: unknown ${chapterKey} task "${taskKey}"`);
      const t = (s.perTask && s.perTask[taskKey]) || {};
      if ((t.attempts || 0) >= TASK_RANK_MIN_ATTEMPTS[chapterKey] && validError(t.recentAvgAbsError)) measureCents = t.recentAvgAbsError;
    } else if ((s.attempts || 0) >= RANK_MIN_ATTEMPTS[chapterKey] && validError(s.recentAvgAbsError)) {
      measureCents = s.recentAvgAbsError;
    }
    basis = measureCents === null ? null : chapterKey === TUNE_IT_KEY ? 'tuneError' : 'singError';
  } else {
    const s = stats || getStats(chapterKey);
    if ((s.answered || 0) < LISTENING_RANK_MIN_ANSWERS) {
      // not enough answers yet: no rank (basis null)
    } else if (posNum(s.thresholdCents) !== null) {
      measureCents = s.thresholdCents;
      basis = 'threshold';
    } else if (posNum(s.levelCents) !== null) {
      measureCents = s.levelCents;
      basis = 'level';
    }
  }

  let index = 0;
  if (measureCents !== null) {
    tiers.forEach((t, i) => {
      if (measureCents <= t.maxCents) index = i;
    });
  }
  const next = tiers[index + 1] || null;
  return {
    index,
    name: tiers[index].name,
    description: tiers[index].description,
    tiers: tiers.map((t) => ({ name: t.name, maxCents: t.maxCents })),
    nextName: next ? next.name : null,
    nextAtCents: next ? next.maxCents : null,
    measureCents,
    basis,
  };
}

// ---------------------------------------------------------------------------
// Overview (stats page), export and import
// ---------------------------------------------------------------------------

/** Plain chapter names for the overview. */
export const CHAPTER_LABELS = Object.freeze({
  'higher-or-lower': 'Higher or lower?',
  'odd-one-out': 'Odd one out',
  'odd-or-in-tune': 'Odd one out — or all in tune?',
  [TUNE_IT_KEY]: 'Lock it in',
  [SING_MATCH_KEY]: 'Echo',
  [SING_KEY]: 'Join the chord',
});

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Is s a real calendar date 'YYYY-MM-DD'? */
function isRealDate(s) {
  const m = typeof s === 'string' && DATE_RE.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}

/** The local calendar day before 'YYYY-MM-DD'. */
function previousDay(s) {
  const m = DATE_RE.exec(s);
  return localDate(new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]) - 1));
}

/**
 * Consecutive practice days ending today — or ending yesterday if there was no practice yet
 * today (the streak is still alive until the day is over). 0 otherwise.
 * @param {Iterable<string>} dates 'YYYY-MM-DD' @param {Date} [now]
 */
export function dailyStreak(dates, now = new Date()) {
  const set = new Set(dates);
  let day = localDate(now);
  if (!set.has(day)) day = previousDay(day);
  let n = 0;
  while (set.has(day)) {
    n += 1;
    day = previousDay(day);
  }
  return n;
}

const rankSummary = (r) => ({ name: r.name, index: r.index, tierCount: r.tiers.length, basis: r.basis });
const ratio = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 1000 : null);

/**
 * Everything the stats page needs, in one plain object. `now` (optional Date) is for tests.
 * @returns {{
 *   date: string,
 *   chapters: Array<{ key, label, rank: { name, index, tierCount, basis }, bestCents, currentCents,
 *     answered, correct, accuracy, bestStreak, daysPractised, firstDate, lastDate, tasks? }>,
 *   totals: { answered, daysPractised, currentDailyStreak, firstDate, lastDate },
 *   strengths: { chapterKey, chapter, text }[], blindSpots: { chapterKey, chapter, text }[] }}
 * Listening chapters: bestCents = best threshold so far, currentCents = current threshold (or level
 * until there is one). Tune it and the singing chapters: answered = attempts, currentCents =
 * recent average error, bestCents = best daily average error, accuracy = share of attempts within
 * 7 cents ('good' or better), bestStreak null, tasks = per-task { key, label, group, attempts,
 * recentAvgAbsError, bestAbsError, rank } (singing also has steadinessCents, overall and per task).
 */
export function getOverview({ now = new Date() } = {}) {
  const chapters = [];
  const allDates = new Set();
  const insightsByChapter = [];

  for (const key of CHAPTER_KEYS) {
    const store = errorStore(key);
    if (store) {
      const s = store.stats();
      const dates = s.history.filter((h) => h.attempts > 0).map((h) => h.date).sort();
      dates.forEach((d) => allDates.add(d));
      const dayAverages = s.history.map((h) => h.avgAbsError).filter((x) => typeof x === 'number');
      const saved = store.data();
      const log = saved ? saved.log : [];
      const chapter = {
        key,
        label: CHAPTER_LABELS[key],
        rank: rankSummary(getRank(key, s)),
        bestCents: dayAverages.length ? Math.min(...dayAverages) : null,
        currentCents: s.recentAvgAbsError,
        answered: s.attempts,
        correct: null,
        accuracy: ratio(log.filter((x) => x.e <= RATING_LIMITS.good).length, log.length),
        bestStreak: null,
        daysPractised: dates.length,
        firstDate: dates[0] || null,
        lastDate: dates[dates.length - 1] || null,
        tasks: store.tasks.map((t) => {
          const p = s.perTask[t.key];
          const task = {
            key: t.key,
            label: t.label,
            group: t.group,
            attempts: p.attempts,
            recentAvgAbsError: p.recentAvgAbsError,
            bestAbsError: p.bestAbsError,
            rank: rankSummary(getRank(key, s, { taskKey: t.key })),
          };
          if (p.steadinessCents !== undefined) task.steadinessCents = p.steadinessCents;
          return task;
        }),
      };
      if (s.steadinessCents !== undefined) chapter.steadinessCents = s.steadinessCents;
      chapters.push(chapter);
      insightsByChapter.push([key, store.insights()]);
      continue;
    }
    const stats = getStats(key);
    const dates = stats.history.filter((h) => h.answered > 0).map((h) => h.date).sort();
    dates.forEach((d) => allDates.add(d));
    chapters.push({
      key,
      label: CHAPTER_LABELS[key],
      rank: rankSummary(getRank(key, stats)),
      bestCents: stats.bestThresholdCents,
      currentCents: stats.answered > 0 ? (stats.thresholdCents ?? stats.levelCents) : null,
      answered: stats.answered,
      correct: stats.correct,
      accuracy: ratio(stats.correct, stats.answered),
      bestStreak: stats.bestStreak,
      daysPractised: dates.length,
      firstDate: dates[0] || null,
      lastDate: dates[dates.length - 1] || null,
    });
    insightsByChapter.push([key, getInsights(key)]);
  }

  // Top 1-2 strengths and blind spots: the strongest sentence of each chapter, in turn.
  const top = (field) => {
    const out = [];
    for (let i = 0; out.length < 2 && i < 4; i++) {
      for (const [key, ins] of insightsByChapter) {
        if (out.length < 2 && ins[field][i]) out.push({ chapterKey: key, chapter: CHAPTER_LABELS[key], text: ins[field][i] });
      }
    }
    return out;
  };

  const sorted = [...allDates].sort();
  return {
    date: localDate(now),
    chapters,
    totals: {
      answered: chapters.reduce((a, c) => a + c.answered, 0),
      daysPractised: sorted.length,
      currentDailyStreak: dailyStreak(sorted, now),
      firstDate: sorted[0] || null,
      lastDate: sorted[sorted.length - 1] || null,
    },
    strengths: top('strengths'),
    blindSpots: top('blindSpots'),
  };
}

/** Identifies an export file of this app. */
export const EXPORT_APP_ID = 'choir-intonation-trainer';
/**
 * Version of the export format. 2 = adds the singing chapters ('sing-match', 'sing').
 * Version-1 files (without them) still import; their singing progress is then cleared.
 */
export const EXPORT_SCHEMA_VERSION = 2;
/** Chapter keys that each export version may contain. */
const EXPORT_KEYS_BY_VERSION = {
  1: ['higher-or-lower', 'odd-one-out', 'odd-or-in-tune', TUNE_IT_KEY],
  2: [...CHAPTER_KEYS],
};

/**
 * Everything worth keeping, as a JSON-serialisable object:
 * { app, schemaVersion, exportedAt (ISO time), settings, progress: { [chapterKey]: data | null } }.
 * Progress data is the clean saved shape (staircase, totals, history, insight log; for the
 * error-based chapters the per-task stats and log); null = never practised.
 */
export function exportAllProgress() {
  const progress = {};
  for (const key of CHAPTER_KEYS) {
    if (errorStore(key)) progress[key] = errorStore(key).data();
    else progress[key] = getProgress(key) === null ? null : load(key);
  }
  return {
    app: EXPORT_APP_ID,
    schemaVersion: EXPORT_SCHEMA_VERSION,
    exportedAt: new Date().toISOString(),
    settings: getSettings(),
    progress: JSON.parse(JSON.stringify(progress)),
  };
}

// --- strict validation for import ---------------------------------------------

class ImportError extends Error {}
const fail = (msg) => { throw new ImportError(msg); };
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (x, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(x) && x >= min && x <= max;
const isNum = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const MAX_CENTS = 1200;

function checkKeys(obj, allowed, where) {
  for (const k of Object.keys(obj)) if (!allowed.includes(k)) fail(`${where} contains something unexpected ("${k}").`);
}

function checkArray(x, max, where) {
  if (!Array.isArray(x) || x.length > max) fail(`${where} is damaged.`);
  return x;
}

function checkHistoryDates(history, where) {
  const seen = new Set();
  for (const h of history) {
    if (!isObj(h) || !isRealDate(h.date) || seen.has(h.date)) fail(`${where}: the practice history is damaged.`);
    seen.add(h.date);
  }
}

function validateStaircase(s, where) {
  if (s === null) return;
  if (!isObj(s)) fail(`${where}: the difficulty level is damaged.`);
  checkKeys(s, ['version', 'level', 'lastMove', 'reversalCount', 'reversals', 'trials', 'correct'], where);
  if (s.version !== 1 || !isNum(s.level, 0.01, MAX_CENTS) || ![null, 'harder', 'easier'].includes(s.lastMove) ||
      !isInt(s.reversalCount) || !isInt(s.trials) || !isInt(s.correct, 0, s.trials)) {
    fail(`${where}: the difficulty level is damaged.`);
  }
  for (const r of checkArray(s.reversals, 20, `${where}: the difficulty level`)) {
    if (!isNum(r, 0.01, MAX_CENTS)) fail(`${where}: the difficulty level is damaged.`);
  }
}

function validateListening(d, where) {
  if (!isObj(d)) fail(`${where} is damaged.`);
  checkKeys(d, ['version', 'staircase', 'answered', 'correct', 'streak', 'bestStreak', 'bestThresholdCents', 'history', 'log'], where);
  if (d.version !== 2) fail(`${where} has an unknown format.`);
  validateStaircase(d.staircase, where);
  if (!isInt(d.answered) || !isInt(d.correct, 0, d.answered) || !isInt(d.streak, 0, d.answered) ||
      !isInt(d.bestStreak, d.streak, d.answered)) {
    fail(`${where}: the totals do not add up.`);
  }
  if (d.bestThresholdCents !== null && !isNum(d.bestThresholdCents, 0.01, MAX_CENTS)) fail(`${where}: the best result is out of range.`);
  checkArray(d.history, HISTORY_MAX_DAYS, `${where}: the practice history`);
  checkHistoryDates(d.history, where);
  for (const h of d.history) {
    checkKeys(h, ['date', 'answered', 'correct', 'levelCents'], `${where}: the practice history`);
    if (!isInt(h.answered) || !isInt(h.correct, 0, h.answered) || !(h.levelCents === null || isNum(h.levelCents, 0.01, MAX_CENTS))) {
      fail(`${where}: the practice history is damaged.`);
    }
  }
  const dirs = [null, 'sharp', 'flat', 'same', 'none'];
  for (const x of checkArray(d.log, INSIGHT_LOG_MAX, `${where}: the answer log`)) {
    if (!isObj(x)) fail(`${where}: the answer log is damaged.`);
    checkKeys(x, ['c', 'l', 'm', 'd', 'a', 't', 'h'], `${where}: the answer log`);
    const shortStr = (v) => v === null || (typeof v === 'string' && v.length > 0 && v.length <= 40);
    if (!(x.c === 0 || x.c === 1) || !isNum(x.l, 0.01, MAX_CENTS) || !(x.m === null || isInt(x.m, 0, 127)) ||
        !dirs.includes(x.d) || !shortStr(x.a) || !shortStr(x.t) || !(x.h === null || own(CHORDS, x.h))) {
      fail(`${where}: the answer log is damaged.`);
    }
  }
}

function validateSettings(s) {
  if (!isObj(s)) fail('The settings in this file are damaged.');
  if (!Object.values(TUNINGS).includes(s.tuning)) fail('The tuning setting in this file is not valid.');
  if (!Array.isArray(s.voiceParts) || s.voiceParts.length < 1 || s.voiceParts.length > Object.keys(VOICE_PARTS).length ||
      !s.voiceParts.every((v) => own(VOICE_PARTS, v)) || new Set(s.voiceParts).size !== s.voiceParts.length) {
    fail('The voice part setting in this file is not valid.');
  }
  if (typeof s.timbre !== 'string' || !/^[a-z0-9-]{1,40}$/i.test(s.timbre)) fail('The sound setting in this file is not valid.');
  if (!isNum(s.volume, 0, 1) || !isNum(s.reverb, 0, 1)) fail('The volume or echo setting in this file is out of range.');
  for (const [k, v] of Object.entries(s)) {
    if (!['string', 'number', 'boolean'].includes(typeof v) && k !== 'voiceParts') fail(`The settings in this file contain something unexpected ("${k}").`);
  }
}

/**
 * Replace all progress and settings with an export made by exportAllProgress().
 * Validates everything first; if anything is wrong NOTHING is written.
 * @param {object} data parsed JSON
 * @returns {{ ok: true } | { ok: false, error: string }} error is a plain sentence for the UI
 */
export function importAllProgress(data) {
  try {
    if (!isObj(data) || data.app !== EXPORT_APP_ID) fail('This file is not a Choir Trainer progress file.');
    if (!isInt(data.schemaVersion, 1)) fail('This file is not a Choir Trainer progress file.');
    if (data.schemaVersion > EXPORT_SCHEMA_VERSION) fail('This file was made by a newer version of the app. Please update the app first.');
    if (!own(EXPORT_KEYS_BY_VERSION, data.schemaVersion)) fail('This file was made by an older, unsupported version of the app.');
    if (typeof data.exportedAt !== 'string' || Number.isNaN(Date.parse(data.exportedAt))) fail('This file has no valid export date.');
    validateSettings(data.settings);
    if (!isObj(data.progress)) fail('The progress in this file is damaged.');
    checkKeys(data.progress, EXPORT_KEYS_BY_VERSION[data.schemaVersion], 'The progress in this file');
    for (const [key, value] of Object.entries(data.progress)) {
      if (value === null) continue;
      const where = `The progress for "${CHAPTER_LABELS[key]}"`;
      if (errorStore(key)) errorStore(key).validate(value, where, fail);
      else validateListening(value, where);
    }
  } catch (e) {
    if (e instanceof ImportError) return { ok: false, error: e.message };
    return { ok: false, error: 'This file could not be read.' };
  }

  const copy = JSON.parse(JSON.stringify(data));
  for (const key of CHAPTER_KEYS) {
    saveProgress(key, own(copy.progress, key) ? copy.progress[key] : null);
  }
  updateSettings(copy.settings);
  return { ok: true };
}
