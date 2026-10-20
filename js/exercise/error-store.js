// Shared persistence, stats, insights and import validation for the chapters that measure an
// error in cents rather than right/wrong answers: Tune it yourself ('tune-it'), Sing it back
// ('sing-match') and Sing the missing note ('sing'). No DOM, no audio.
//
// Saved shape (one storage key per chapter):
//   { version: 2, attempts, recent: [absError...last 20, all tasks],
//     perTask: { [taskKey]: { attempts, recent: [absError...last 10], recentSigned: [errorCents...last 10],
//                             bestAbsError, recentSteadiness?: [cents...last 10] } },
//     log: [{ k: taskKey, e: absError, s: errorCents|null, m: midi|null, o: 'up'|'down', v?: steadiness|null }
//           ...last 500],
//     history: [{ date: 'YYYY-MM-DD', attempts, avgAbsError }] }
// The `?` fields exist only in stores created with { steadiness: true } (the singing chapters).
// Version-1 tune-it data (no recentSigned / log) loads fine.

import { getProgress, saveProgress } from '../storage.js';
import { registerBand } from '../music/tuning.js';

/** Attempts needed in a register band before perTask.byRegister reports it. */
export const REGISTER_MIN_ATTEMPTS = 5;
/** Attempts a group (task / register / direction / motion) needs before insights compare it. */
export const INSIGHT_MIN_ATTEMPTS = 8;
/** Average signed error worth a "you tend to ... sharp/flat" sentence. */
export const TENDENCY_MIN_CENTS = 4;
/** Errors above this count as "too high/low" in byDirection (= the 'excellent' limit). */
const DIRECTION_MIN_CENTS = 3;

const RECENT_PER_TASK = 10;
const RECENT_OVERALL = 20;
const LOG_MAX = 500;
const HISTORY_MAX_DAYS = 365;
const MAX_CENTS = 1200;

function localDate(d) {
  const pad = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const count = (x) => (Number.isInteger(x) && x > 0 ? x : 0);
const nonNeg = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0;
const finite = (x) => typeof x === 'number' && Number.isFinite(x);
const round1 = (x) => Math.round(x * 10) / 10;
const mean = (xs) => (xs.length ? round1(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const own = (o, k) => o !== null && typeof o === 'object' && Object.prototype.hasOwnProperty.call(o, k);
const centsText = (c) => {
  const v = Math.round(Math.abs(c));
  return `${v} ${v === 1 ? 'cent' : 'cents'}`;
};
const cap = (s) => s.charAt(0).toUpperCase() + s.slice(1);

const WORDS = {
  tune: { verb: 'tune', inTune: 'tune', wellIn: 'You tune especially well in the' },
  sing: { verb: 'sing', inTune: 'sing in tune', wellIn: 'You sing especially accurately in the' },
};

/**
 * @param {{ key: string, tasks: { key: string, label: string, group?: string, phrase?: string }[],
 *   steadiness?: boolean, verb?: 'tune'|'sing' }} config
 *   phrase: how sentences name the task (default 'the <label>').
 */
export function createErrorStore({ key, tasks, steadiness = false, verb = 'tune' }) {
  const taskKeys = tasks.map((t) => t.key);
  const words = WORDS[verb] || WORDS.tune;
  const phraseOf = (t) => t.phrase || `the ${t.label.charAt(0).toLowerCase()}${t.label.slice(1)}`;

  function load() {
    const raw = getProgress(key);
    const d = raw && typeof raw === 'object' ? raw : {};
    const perTask = {};
    for (const k of taskKeys) {
      const s = own(d.perTask, k) && d.perTask[k] && typeof d.perTask[k] === 'object' ? d.perTask[k] : {};
      perTask[k] = {
        attempts: count(s.attempts),
        recent: Array.isArray(s.recent) ? s.recent.filter(nonNeg).slice(-RECENT_PER_TASK) : [],
        recentSigned: Array.isArray(s.recentSigned) ? s.recentSigned.filter(finite).slice(-RECENT_PER_TASK) : [],
        bestAbsError: nonNeg(s.bestAbsError) ? s.bestAbsError : null,
      };
      if (steadiness) {
        perTask[k].recentSteadiness = Array.isArray(s.recentSteadiness) ? s.recentSteadiness.filter(nonNeg).slice(-RECENT_PER_TASK) : [];
      }
    }
    const keys = new Set(taskKeys);
    return {
      version: 2,
      attempts: count(d.attempts),
      recent: Array.isArray(d.recent) ? d.recent.filter(nonNeg).slice(-RECENT_OVERALL) : [],
      perTask,
      log: Array.isArray(d.log)
        ? d.log
            .filter((x) => x && keys.has(x.k) && nonNeg(x.e))
            .map((x) => {
              const entry = { k: x.k, e: x.e, s: finite(x.s) ? x.s : null, m: finite(x.m) ? x.m : null, o: x.o === 'down' ? 'down' : 'up' };
              if (steadiness) entry.v = nonNeg(x.v) ? x.v : null;
              return entry;
            })
            .slice(-LOG_MAX)
        : [],
      history: Array.isArray(d.history)
        ? d.history
            .filter((h) => h && typeof h.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(h.date))
            .map((h) => ({ date: h.date, attempts: count(h.attempts), avgAbsError: nonNeg(h.avgAbsError) ? h.avgAbsError : null }))
        : [],
    };
  }

  function registerGroups(entries, min) {
    const groups = new Map();
    for (const x of entries) {
      if (x.m === null) continue;
      const b = registerBand(x.m);
      if (!groups.has(b.index)) groups.set(b.index, { index: b.index, label: b.label, errors: [] });
      groups.get(b.index).errors.push(x.e);
    }
    return [...groups.values()]
      .filter((g) => g.errors.length >= min)
      .sort((a, b) => a.index - b.index)
      .map((g) => ({ label: g.label, attempts: g.errors.length, avgAbsError: mean(g.errors) }));
  }

  function statsFrom(d) {
    const perTask = {};
    for (const k of taskKeys) {
      const s = d.perTask[k];
      perTask[k] = {
        attempts: s.attempts,
        recentAvgAbsError: mean(s.recent),
        bestAbsError: s.bestAbsError,
        meanSignedError: mean(s.recentSigned),
        byRegister: registerGroups(d.log.filter((x) => x.k === k), REGISTER_MIN_ATTEMPTS),
      };
      if (steadiness) perTask[k].steadinessCents = mean(s.recentSteadiness);
    }
    const out = {
      attempts: d.attempts,
      recentAvgAbsError: mean(d.recent),
      perTask,
      history: d.history.map((h) => ({ ...h, avgAbsError: h.avgAbsError === null ? null : round1(h.avgAbsError) })),
    };
    if (steadiness) out.steadinessCents = mean(d.log.map((x) => x.v).filter((v) => v !== null).slice(-RECENT_OVERALL));
    return out;
  }

  /** Save one attempt; returns the updated stats. */
  function record(taskKey, result, { now = new Date() } = {}) {
    if (!taskKeys.includes(taskKey)) throw new Error(`Unknown task for ${key}: "${taskKey}"`);
    const err = result && result.absError;
    if (!nonNeg(err)) throw new Error(`${key}: result.absError must be a number >= 0, got ${err}`);
    const e = round1(err);
    const signed = finite(result.errorCents) ? round1(result.errorCents) : null;
    const midi = finite(result.midi) ? Math.round(result.midi) : null;
    const steady = steadiness && nonNeg(result.steadinessCents) ? round1(result.steadinessCents) : null;
    const d = load();

    d.attempts += 1;
    d.recent = [...d.recent, e].slice(-RECENT_OVERALL);
    const s = d.perTask[taskKey];
    s.attempts += 1;
    s.recent = [...s.recent, e].slice(-RECENT_PER_TASK);
    if (signed !== null) s.recentSigned = [...s.recentSigned, signed].slice(-RECENT_PER_TASK);
    if (s.bestAbsError === null || e < s.bestAbsError) s.bestAbsError = e;
    if (steadiness && steady !== null) s.recentSteadiness = [...s.recentSteadiness, steady].slice(-RECENT_PER_TASK);
    const entry = { k: taskKey, e, s: signed, m: midi, o: result.motion === 'down' ? 'down' : 'up' };
    if (steadiness) entry.v = steady;
    d.log = [...d.log, entry].slice(-LOG_MAX);

    const date = localDate(now);
    let day = d.history[d.history.length - 1];
    if (!day || day.date !== date) {
      day = { date, attempts: 0, avgAbsError: null };
      d.history.push(day);
    }
    // stored unrounded so the running average does not drift; stats round it
    day.avgAbsError = ((day.avgAbsError || 0) * day.attempts + e) / (day.attempts + 1);
    day.attempts += 1;
    if (d.history.length > HISTORY_MAX_DAYS) d.history = d.history.slice(-HISTORY_MAX_DAYS);

    saveProgress(key, d);
    return statsFrom(d);
  }

  /**
   * Insights (no staircase here, so no difficulty adjustment is needed):
   * { answered, averageAbsError, byTask, byRegister, byDirection, byMotion, strengths, blindSpots
   *   (+ steadinessCents for singing) } — groups need >= INSIGHT_MIN_ATTEMPTS.
   */
  function insights() {
    const log = load().log;
    const overall = log.length ? log.reduce((a, x) => a + x.e, 0) / log.length : null;
    const strengths = [];
    const blindSpots = [];

    const byTask = [];
    for (const t of tasks) {
      const entries = log.filter((x) => x.k === t.key);
      if (entries.length < INSIGHT_MIN_ATTEMPTS) continue;
      const signed = entries.map((x) => x.s).filter((x) => x !== null);
      const item = {
        key: t.key,
        label: t.label,
        attempts: entries.length,
        avgAbsError: mean(entries.slice(-20).map((x) => x.e)),
        meanSignedError: signed.length >= INSIGHT_MIN_ATTEMPTS ? mean(signed.slice(-20)) : null,
      };
      byTask.push(item);
      if (item.meanSignedError !== null && Math.abs(item.meanSignedError) >= TENDENCY_MIN_CENTS) {
        const up = item.meanSignedError > 0;
        blindSpots.push(`You tend to ${words.verb} ${phraseOf(t)} ${up ? 'sharp' : 'flat'}: on average ${centsText(item.meanSignedError)} too ${up ? 'high' : 'low'}.`);
      }
    }
    if (byTask.length >= 2) {
      for (const item of byTask) {
        const others = log.filter((x) => x.k !== item.key).slice(-100);
        if (others.length < INSIGHT_MIN_ATTEMPTS) continue;
        const rest = others.reduce((a, x) => a + x.e, 0) / others.length;
        const name = phraseOf(tasks.find((t) => t.key === item.key));
        if (item.avgAbsError <= rest * 0.6 && rest - item.avgAbsError >= 3) {
          strengths.push(`You ${words.verb} ${name} especially accurately (${centsText(item.avgAbsError)} off on average, vs ${centsText(rest)} for the other tasks).`);
        } else if (item.avgAbsError >= rest * 1.6 && item.avgAbsError - rest >= 4) {
          blindSpots.push(`${cap(name)} is your hardest task (${centsText(item.avgAbsError)} off on average, vs ${centsText(rest)} for the other tasks).`);
        }
      }
    }

    const byRegister = registerGroups(log, INSIGHT_MIN_ATTEMPTS).map((g) => ({ label: g.label, answered: g.attempts, avgAbsError: g.avgAbsError }));
    if (byRegister.length >= 2) {
      for (const g of byRegister) {
        const others = log.filter((x) => x.m !== null && registerBand(x.m).label !== g.label);
        if (others.length < INSIGHT_MIN_ATTEMPTS) continue;
        const rest = others.reduce((a, x) => a + x.e, 0) / others.length;
        if (g.avgAbsError >= rest * 1.5 && g.avgAbsError - rest >= 4) {
          blindSpots.push(`Notes in the ${g.label} range are harder for you to ${words.inTune} (${centsText(g.avgAbsError)} off on average, vs ${centsText(rest)} elsewhere).`);
        } else if (g.avgAbsError <= rest * 0.66 && rest - g.avgAbsError >= 3) {
          strengths.push(`${words.wellIn} ${g.label} range (${centsText(g.avgAbsError)} off on average, vs ${centsText(rest)} elsewhere).`);
        }
      }
    }

    const sharp = log.filter((x) => x.s !== null && x.s > DIRECTION_MIN_CENTS).length;
    const flat = log.filter((x) => x.s !== null && x.s < -DIRECTION_MIN_CENTS).length;
    const byDirection = [
      { key: 'sharp', label: 'Ended too high (sharp)', answered: sharp },
      { key: 'flat', label: 'Ended too low (flat)', answered: flat },
    ].filter((g) => g.answered >= INSIGHT_MIN_ATTEMPTS);

    // Ascending vs descending, interval tasks only, compared task by task.
    const intervalKeys = new Set(tasks.filter((t) => t.group === 'interval').map((t) => t.key));
    const intervalLog = log.filter((x) => intervalKeys.has(x.k));
    const byMotion = [
      { key: 'up', label: `Ascending (you ${words.verb} the upper note)` },
      { key: 'down', label: `Descending (you ${words.verb} the lower note)` },
    ]
      .map((g) => {
        const errs = intervalLog.filter((x) => x.o === g.key).map((x) => x.e);
        return { ...g, answered: errs.length, avgAbsError: mean(errs) };
      })
      .filter((g) => g.answered >= INSIGHT_MIN_ATTEMPTS);
    const motionCmp = compareMotion(intervalLog);
    if (motionCmp) {
      const { downMean, upMean } = motionCmp;
      if (downMean >= upMean * 1.5 && downMean - upMean >= 3) {
        blindSpots.push(`Descending intervals are harder for you to ${words.inTune} (${centsText(downMean)} off on average, vs ${centsText(upMean)} going up, on the same intervals).`);
      } else if (upMean >= downMean * 1.5 && upMean - downMean >= 3) {
        strengths.push(`You ${words.verb} descending intervals especially well (${centsText(downMean)} off on average, vs ${centsText(upMean)} going up, on the same intervals).`);
      }
    }

    const result = {
      answered: log.length,
      averageAbsError: overall === null ? null : round1(overall),
      byTask,
      byRegister,
      byDirection,
      byMotion,
      strengths,
      blindSpots,
    };

    if (steadiness) {
      const vs = log.map((x) => x.v).filter((v) => v !== null).slice(-20);
      result.steadinessCents = vs.length ? mean(vs) : null;
      if (vs.length >= INSIGHT_MIN_ATTEMPTS) {
        const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
        if (avg >= 15) blindSpots.push(`Your held notes wobble (±${centsText(avg)} on average) — a straighter tone makes it easier to sing in tune.`);
        else if (avg <= 6) strengths.push(`You hold notes very steadily (±${centsText(avg)} on average).`);
      }
    }
    return result;
  }

  function compareMotion(intervalLog) {
    let w = 0, up = 0, down = 0, nUp = 0, nDown = 0;
    for (const t of tasks) {
      const u = intervalLog.filter((x) => x.k === t.key && x.o === 'up').map((x) => x.e);
      const dn = intervalLog.filter((x) => x.k === t.key && x.o === 'down').map((x) => x.e);
      if (!u.length || !dn.length) continue;
      const weight = (u.length * dn.length) / (u.length + dn.length);
      up += weight * (u.reduce((a, b) => a + b, 0) / u.length);
      down += weight * (dn.reduce((a, b) => a + b, 0) / dn.length);
      w += weight;
      nUp += u.length;
      nDown += dn.length;
    }
    if (!w || nUp < INSIGHT_MIN_ATTEMPTS || nDown < INSIGHT_MIN_ATTEMPTS) return null;
    return { upMean: up / w, downMean: down / w };
  }

  /** Clean saved data, or null if nothing was ever saved (for export). */
  function data() {
    return getProgress(key) === null ? null : load();
  }

  /**
   * Strict check of exported data (for import). Calls fail(plainMessage) on the first problem.
   * @param {object} d @param {string} where e.g. 'The progress for "Tune it yourself"' @param {(msg: string) => never} fail
   */
  function validate(d, where, fail) {
    const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
    const isInt = (x, min = 0, max = Number.MAX_SAFE_INTEGER) => Number.isInteger(x) && x >= min && x <= max;
    const isNum = (x, min, max) => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
    const err = (x) => isNum(x, 0, MAX_CENTS);
    const keysOnly = (o, allowed, w) => {
      for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${w} contains something unexpected ("${k}").`);
    };
    const arr = (x, max, w) => {
      if (!Array.isArray(x) || x.length > max) fail(`${w} is damaged.`);
      return x;
    };
    if (!isObj(d)) fail(`${where} is damaged.`);
    keysOnly(d, ['version', 'attempts', 'recent', 'perTask', 'log', 'history'], where);
    if (d.version !== 2) fail(`${where} has an unknown format.`);
    if (!isInt(d.attempts)) fail(`${where}: the totals are damaged.`);
    for (const e of arr(d.recent, RECENT_OVERALL, `${where}: the recent results`)) if (!err(e)) fail(`${where}: a result is out of range.`);
    if (!isObj(d.perTask)) fail(`${where}: the per-task results are damaged.`);
    keysOnly(d.perTask, taskKeys, `${where}: the per-task results`);
    const perTaskKeys = ['attempts', 'recent', 'recentSigned', 'bestAbsError', ...(steadiness ? ['recentSteadiness'] : [])];
    for (const [k, s] of Object.entries(d.perTask)) {
      const w = `${where}: the results for "${k}"`;
      if (!isObj(s)) fail(`${w} are damaged.`);
      keysOnly(s, perTaskKeys, w);
      if (!isInt(s.attempts, 0, d.attempts) || !(s.bestAbsError === null || err(s.bestAbsError))) fail(`${w} are damaged.`);
      for (const e of arr(s.recent, RECENT_PER_TASK, w)) if (!err(e)) fail(`${where}: a result is out of range.`);
      for (const e of arr(s.recentSigned, RECENT_PER_TASK, w)) if (!isNum(e, -MAX_CENTS, MAX_CENTS)) fail(`${where}: a result is out of range.`);
      if (s.recentSteadiness !== undefined) {
        for (const e of arr(s.recentSteadiness, RECENT_PER_TASK, w)) if (!err(e)) fail(`${where}: a result is out of range.`);
      }
    }
    const logKeys = ['k', 'e', 's', 'm', 'o', ...(steadiness ? ['v'] : [])];
    for (const x of arr(d.log, LOG_MAX, `${where}: the attempt log`)) {
      if (!isObj(x)) fail(`${where}: the attempt log is damaged.`);
      keysOnly(x, logKeys, `${where}: the attempt log`);
      if (!taskKeys.includes(x.k) || !err(x.e) || !(x.s === null || isNum(x.s, -MAX_CENTS, MAX_CENTS)) ||
          !(x.m === null || isInt(x.m, 0, 127)) || !['up', 'down'].includes(x.o) ||
          !(x.v === undefined || x.v === null || err(x.v))) {
        fail(`${where}: the attempt log is damaged.`);
      }
    }
    arr(d.history, HISTORY_MAX_DAYS, `${where}: the practice history`);
    const seen = new Set();
    for (const h of d.history) {
      if (!isObj(h) || typeof h.date !== 'string' || !isRealDate(h.date) || seen.has(h.date)) fail(`${where}: the practice history is damaged.`);
      seen.add(h.date);
      keysOnly(h, ['date', 'attempts', 'avgAbsError'], `${where}: the practice history`);
      if (!isInt(h.attempts) || !(h.avgAbsError === null || err(h.avgAbsError))) fail(`${where}: the practice history is damaged.`);
    }
  }

  return {
    key,
    tasks,
    taskKeys,
    load,
    stats: () => statsFrom(load()),
    record,
    insights,
    data,
    validate,
  };
}

/** Is s a real calendar date 'YYYY-MM-DD'? */
export function isRealDate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return false;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return d.getFullYear() === Number(m[1]) && d.getMonth() === Number(m[2]) - 1 && d.getDate() === Number(m[3]);
}
