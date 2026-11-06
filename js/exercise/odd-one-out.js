// Chapter 2 — "Odd one out": a chord in which exactly one tone is sharp or flat; the
// other tones stay perfectly in tune with each other. Variant (allowNone, progress key
// 'odd-or-in-tune'): sometimes the whole chord is in tune. Pure logic: no DOM, no audio.

import {
  CHORDS, INTERVALS, buildChord, randomRootFreq, shiftByCents, formatCents, describeFreq, chordName,
  centsBetween, rootName, spellInterval, deviation,
} from '../music/tuning.js';

/** Share of all-in-tune questions when allowNone is on. */
export const ALL_IN_TUNE_PROBABILITY = 0.22;

function checkCents(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) {
    throw new Error(`odd-one-out: cents must be a positive number, got ${cents}`);
  }
}

/** Widest interval above the root in the chord, in semitones (either tuning). */
function chordSpanSemitones(chordKey) {
  if (!Object.prototype.hasOwnProperty.call(CHORDS, chordKey)) {
    throw new Error(`Unknown chord key: "${chordKey}"`);
  }
  const chord = CHORDS[chordKey];
  return Math.max(...chord.intervals.map((k) => Math.max(INTERVALS[k].justCents, INTERVALS[k].equalCents) / 100));
}

/**
 * Make a question: an in-tune chord (buildChord in the given tuning) with one tone,
 * chosen uniformly, moved sharp or flat (50/50) by `cents`. With allowNone, about 22% of
 * questions have nothing off: oddIndex -1, direction 'none', every freq === correctFreq.
 * The root is placed so that the whole chord plus the detune stays in the voice range.
 * Tones are low to high (only one tone moves, by less than the smallest gap between
 * chord tones — 267 cents in dom7 — so the order never changes for cents < ~260).
 * @param {{cents: number, chordKey?: string, tuning?: 'just'|'equal', voicePart?: string|string[],
 *   allowNone?: boolean, rng?: () => number}} p
 * @returns {{chordKey: string, tuning: string, cents: number, oddIndex: number,
 *   direction: 'sharp'|'flat'|'none', tones: {label: string, intervalKey: string, freq: number, correctFreq: number}[]}}
 */
export function makeQuestion({ cents, chordKey = 'major', tuning = 'just', voicePart = 'any', allowNone = false, rng = Math.random }) {
  checkCents(cents);
  const span = chordSpanSemitones(chordKey);
  const headroom = cents / 100;
  const root = shiftByCents(randomRootFreq(voicePart, span + 2 * headroom, rng), cents);
  const chord = buildChord(root, chordKey, tuning);

  let oddIndex = -1;
  let direction = 'none';
  if (!(allowNone && rng() < ALL_IN_TUNE_PROBABILITY)) {
    oddIndex = Math.min(chord.length - 1, Math.floor(rng() * chord.length));
    direction = rng() < 0.5 ? 'sharp' : 'flat';
  }
  const shift = direction === 'sharp' ? cents : -cents;

  const tones = chord.map((t, i) => ({
    label: t.label,
    intervalKey: t.intervalKey,
    freq: i === oddIndex ? shiftByCents(t.freq, shift) : t.freq,
    correctFreq: t.freq,
  }));
  return { chordKey, tuning, cents, oddIndex, direction, tones };
}

/**
 * Check an answer: which tone was off, and was it sharp or flat? `correct` only when both
 * are right. { index: -1, direction: 'none' } means "all in tune".
 * @param {object} question from makeQuestion
 * @param {{index: number, direction: 'sharp'|'flat'|'none'}} answer
 * Messages (UX-WRITING patterns): 'Right — the third was 12 cents too high.' /
 * 'Close — right note, wrong way: the third was 12 cents too high.' /
 * 'Not this time — the third was 12 cents too high. The root was in tune.' /
 * 'Right — every note was in tune.' / 'Not this time — every note was in tune.'
 * level: 'in-tune' when right, 'close' for the right note in the wrong direction, else 'keep-going'.
 * @returns {{correct: boolean, noteCorrect: boolean, directionCorrect: boolean,
 *   level: 'in-tune'|'close'|'keep-going', message: string}}
 */
export function checkAnswer(question, { index, direction }) {
  const answeredNone = index === -1 || direction === 'none';

  if (question.oddIndex === -1) {
    const correct = answeredNone;
    return {
      correct,
      noteCorrect: correct,
      directionCorrect: correct,
      level: correct ? 'in-tune' : 'keep-going',
      message: `${correct ? 'Right' : 'Not this time'} — every note was in tune.`,
    };
  }

  const odd = question.tones[question.oddIndex];
  const fact = `the ${odd.label.toLowerCase()} was ${formatCents(question.cents)} too ${question.direction === 'sharp' ? 'high' : 'low'}`;

  if (answeredNone) {
    return { correct: false, noteCorrect: false, directionCorrect: false, level: 'keep-going', message: `Not this time — ${fact}.` };
  }

  const noteCorrect = index === question.oddIndex;
  const directionCorrect = direction === question.direction;
  const correct = noteCorrect && directionCorrect;

  let message;
  let level;
  if (correct) {
    message = `Right — ${fact}.`;
    level = 'in-tune';
  } else if (noteCorrect) {
    message = `Close — right note, wrong way: ${fact}.`;
    level = 'close';
  } else {
    const picked = question.tones[index];
    const pickedPart = picked ? ` ${cap(`the ${picked.label.toLowerCase()}`)} was in tune.` : '';
    message = `Not this time — ${fact}.${pickedPart}`;
    level = 'keep-going';
  }
  return { correct, noteCorrect, directionCorrect, level, message };
}

/**
 * What actually sounded, for after the answer.
 * title e.g. 'D major chord (root D4 −8)'; notes: each tone low to high with
 * { label, name, cents } of the tone as played, plus played / inTune (describeFreq).
 * (Piano-grid names; kept until the UI uses the fields below.)
 * New (design critique #1), names spelled for the chord, deviation only on the off tone:
 *   heading / chord: 'B♭ dominant 7th' (key spelling),
 *   tones: [{ label, name: 'D4', deviation: { cents (signed), text: '35 cents too high' } | null,
 *             isOff, isYours: false }] low to high — in-tune tones name only; "all in tune" -> no deviations.
 * @param {object} question from makeQuestion
 */
export function describe(question) {
  const root = question.tones.find((t) => t.intervalKey === 'P1') || question.tones[0];
  const title = `${chordName(root.correctFreq, question.chordKey)} chord (root ${describeFreq(root.correctFreq).text})`;
  const key = rootName(root.correctFreq);
  const chord = `${key.pitchClass} ${CHORDS[question.chordKey].quality}`;
  return {
    title,
    notes: question.tones.map((t) => {
      const played = describeFreq(t.freq);
      return { label: t.label, name: played.name, cents: played.cents, played, inTune: describeFreq(t.correctFreq) };
    }),
    heading: chord,
    chord,
    tones: question.tones.map((t, i) => {
      const isOff = i === question.oddIndex;
      return {
        label: t.label,
        name: spellInterval(key, t.intervalKey).name,
        deviation: isOff ? deviation(centsBetween(t.correctFreq, t.freq), 'too high', 'too low') : null,
        isOff,
        isYours: false,
      };
    }),
  };
}

/**
 * Detail object for progress.recordResult(..., { correct, detail }) (feeds the insights).
 * answer is stored as 'none' or '<Label> <direction>', e.g. 'Third sharp'.
 * @param {object} question @param {{index: number, direction: string}} answer
 */
export function answerDetail(question, { index, direction }) {
  const root = question.tones.find((t) => t.intervalKey === 'P1') || question.tones[0];
  const odd = question.oddIndex >= 0 ? question.tones[question.oddIndex] : null;
  const picked = index >= 0 ? question.tones[index] : null;
  return {
    midi: describeFreq(root.correctFreq).midi,
    toneLabel: odd ? odd.label : null,
    direction: question.direction,
    answer: picked && direction !== 'none' ? `${picked.label} ${direction}` : 'none',
    chordKey: question.chordKey,
    cents: question.cents,
  };
}

function cap(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
