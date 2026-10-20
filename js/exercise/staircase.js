// Adaptive difficulty ("staircase"), measured in cents. Pure logic: no DOM, no audio.
//
// Weighted up/down rule (Kaernbach 1991): after a correct answer the level goes down
// (harder) by one step; after a miss it goes up (easier) by `upRatio` steps. With
// upRatio = 3 the staircase settles where the listener is right about 75% of the time
// (p = up / (up + down) = 3/4). Steps are multiplicative (the same percentage at any
// level), i.e. additive in log space. Big steps are used until the first couple of
// reversals so a beginner or an expert reaches their zone quickly, then small steps.
// No single step up is larger than `maxUpFactor` (x1.4), so a miss is never a big jump back.

const DEFAULTS = Object.freeze({
  start: 40,                // first level, cents
  min: 2,                   // smallest (hardest) level, cents
  max: 80,                  // largest (easiest) level, cents
  bigStep: 0.15,            // natural-log step down after a hit before `bigStepReversals` (x0.861)
  smallStep: 0.08,          // natural-log step down after a hit afterwards (x0.923)
  upRatio: 3,               // step up after a miss = upRatio * step down (small phase: x1.27)
  maxUpFactor: 1.4,         // cap on any single step up, so one miss never feels like a punishment.
                            // Only binds in the big-step phase (x1.57 -> x1.40); the small-step
                            // phase keeps the exact 3:1 ratio that converges near 75% correct.
  bigStepReversals: 2,      // reversals made with big steps (excluded from the threshold)
  thresholdReversals: 6,    // threshold = geometric mean of this many most recent reversals
  minThresholdReversals: 4, // fewer usable reversals than this -> threshold() is null
});

const MAX_STORED_REVERSALS = 20;
const STATE_VERSION = 1;

/** Round to 0.1 cent. */
function round1(x) {
  return Math.round(x * 10) / 10;
}

function isPosNumber(x) {
  return typeof x === 'number' && Number.isFinite(x) && x > 0;
}

function normalizeOpts(opts) {
  const o = { ...DEFAULTS, ...(opts || {}) };
  for (const k of ['start', 'min', 'max', 'bigStep', 'smallStep', 'upRatio']) {
    if (!isPosNumber(o[k])) throw new Error(`createStaircase: option "${k}" must be a positive number, got ${o[k]}`);
  }
  if (!(typeof o.maxUpFactor === 'number' && o.maxUpFactor > 1)) {
    throw new Error(`createStaircase: option "maxUpFactor" must be a number above 1, got ${o.maxUpFactor}`);
  }
  if (o.max < o.min) throw new Error(`createStaircase: max (${o.max}) is smaller than min (${o.min})`);
  o.start = Math.min(o.max, Math.max(o.min, o.start));
  return o;
}

/**
 * Create a staircase, optionally resuming from a previously saved state().
 * Options come from `opts` (so changed min/max apply on resume); progress comes from `state`.
 * An invalid or foreign state is ignored and the staircase starts fresh.
 * @param {{start?: number, min?: number, max?: number}} [opts]
 * @param {object|null} [state]
 */
export function createStaircase(opts = {}, state = null) {
  const o = normalizeOpts(opts);
  const clamp = (x) => Math.min(o.max, Math.max(o.min, x));

  let level = o.start;      // internal, unrounded
  let lastMove = null;      // 'harder' | 'easier' | null (intended direction of last move)
  let reversalCount = 0;    // all reversals so far
  let reversals = [];       // levels at reversals after the big-step phase (most recent last)
  let trials = 0;
  let correctCount = 0;

  if (state && typeof state === 'object' && isPosNumber(state.level)) {
    level = clamp(state.level);
    lastMove = state.lastMove === 'harder' || state.lastMove === 'easier' ? state.lastMove : null;
    reversalCount = Number.isInteger(state.reversalCount) && state.reversalCount > 0 ? state.reversalCount : 0;
    reversals = Array.isArray(state.reversals) ? state.reversals.filter(isPosNumber).slice(-MAX_STORED_REVERSALS) : [];
    trials = Number.isInteger(state.trials) && state.trials > 0 ? state.trials : 0;
    correctCount = Number.isInteger(state.correct) && state.correct > 0 ? state.correct : 0;
  }

  return {
    /** Cents to use for the next question (rounded to 0.1). */
    level() {
      return round1(level);
    },

    /**
     * Record an answer at the current level and move the level.
     * @param {boolean} correct
     * @returns {{level: number, previousLevel: number, direction: 'harder'|'easier'|'same'}}
     */
    record(correct) {
      const previous = level;
      const move = correct ? 'harder' : 'easier';
      trials++;
      if (correct) correctCount++;

      if (lastMove !== null && move !== lastMove) {
        reversalCount++;
        if (reversalCount > o.bigStepReversals) {
          reversals.push(previous);
          if (reversals.length > MAX_STORED_REVERSALS) reversals = reversals.slice(-MAX_STORED_REVERSALS);
        }
      }
      lastMove = move;

      const step = reversalCount >= o.bigStepReversals ? o.smallStep : o.bigStep;
      const factor = correct ? Math.exp(-step) : Math.min(o.maxUpFactor, Math.exp(step * o.upRatio));
      level = clamp(previous * factor);

      const newRounded = round1(level);
      const prevRounded = round1(previous);
      return {
        level: newRounded,
        previousLevel: prevRounded,
        direction: newRounded === prevRounded ? 'same' : move,
      };
    },

    /** Estimated threshold in cents (geometric mean of recent reversal levels), or null. */
    threshold() {
      if (reversals.length < o.minThresholdReversals) return null;
      const recent = reversals.slice(-o.thresholdReversals);
      const meanLog = recent.reduce((sum, x) => sum + Math.log(x), 0) / recent.length;
      return round1(Math.exp(meanLog));
    },

    /** Plain JSON-serializable snapshot, to pass back to createStaircase later. */
    state() {
      return {
        version: STATE_VERSION,
        level,
        lastMove,
        reversalCount,
        reversals: reversals.slice(),
        trials,
        correct: correctCount,
      };
    },
  };
}
