// Chapter 1 — "Higher or lower?": the same note twice, the second one slightly sharp
// (higher) or flat (lower) — or, with allowSame, sometimes exactly the same.
// Pure logic: no DOM, no audio.

import { randomRootFreq, shiftByCents, formatCents, describeFreq } from '../music/tuning.js';

/** Share of 'same' questions when allowSame is on. */
export const SAME_PROBABILITY = 0.25;

const ANSWERS = ['sharp', 'flat', 'same'];

function checkCents(cents) {
  if (typeof cents !== 'number' || !Number.isFinite(cents) || cents <= 0) {
    throw new Error(`higher-lower: cents must be a positive number, got ${cents}`);
  }
}

/**
 * Make a question. Direction is sharp/flat 50/50, or with allowSame: 'same' 25%, sharp and
 * flat 37.5% each. The first note is random (not on the piano grid) with `cents` of
 * headroom on both sides, so both notes stay in the voice range whichever way it goes.
 * For 'same', secondFreq === firstFreq and `cents` is still the current level (for stats).
 * @param {{cents: number, voicePart?: string|string[], allowSame?: boolean, rng?: () => number}} p
 * @returns {{firstFreq: number, secondFreq: number, direction: 'sharp'|'flat'|'same', cents: number}}
 */
export function makeQuestion({ cents, voicePart = 'any', allowSame = false, rng = Math.random }) {
  checkCents(cents);
  const u = rng();
  let direction;
  if (allowSame) {
    direction = u < SAME_PROBABILITY ? 'same' : u < SAME_PROBABILITY + (1 - SAME_PROBABILITY) / 2 ? 'sharp' : 'flat';
  } else {
    direction = u < 0.5 ? 'sharp' : 'flat';
  }
  const headroomSemitones = cents / 100;
  // Lowest possible note of the pair .. +2*headroom fits; then centre the first note.
  const firstFreq = shiftByCents(randomRootFreq(voicePart, 2 * headroomSemitones, rng), cents);
  const shift = direction === 'sharp' ? cents : direction === 'flat' ? -cents : 0;
  const secondFreq = direction === 'same' ? firstFreq : shiftByCents(firstFreq, shift);
  return { firstFreq, secondFreq, direction, cents };
}

/**
 * Check an answer.
 * @param {{direction: 'sharp'|'flat'|'same', cents: number}} question
 * @param {'sharp'|'flat'|'same'} answer
 * @returns {{correct: boolean, message: string}}
 */
export function checkAnswer(question, answer) {
  if (!ANSWERS.includes(answer)) {
    throw new Error(`higher-lower: answer must be 'sharp', 'flat' or 'same', got ${answer}`);
  }
  const correct = answer === question.direction;
  if (question.direction === 'same') {
    return {
      correct,
      message: correct ? 'Yes — they were exactly the same.' : 'They were actually the same note.',
    };
  }
  const size = formatCents(question.cents);
  const actual = question.direction === 'sharp' ? 'higher (sharp)' : 'lower (flat)';
  let message;
  if (correct) message = `Yes, the second note was ${size} ${actual}.`;
  else if (answer === 'same') message = `They were not quite the same: the second note was ${size} ${actual}.`;
  else message = `Not this time: the second note was ${size} ${actual}.`;
  return { correct, message };
}

/**
 * What actually sounded, for after the answer.
 * title e.g. 'First note: A3 +12; second note: A3 +27'.
 * notes: [{ label, name, cents, played, inTune }] — for the second note, inTune is the first
 * note (where it would have been with no change).
 * @param {object} question from makeQuestion
 */
export function describe(question) {
  const first = describeFreq(question.firstFreq);
  const second = describeFreq(question.secondFreq);
  return {
    title: `First note: ${first.text}; second note: ${second.text}`,
    notes: [
      { label: 'First note', name: first.name, cents: first.cents, played: first, inTune: first },
      { label: 'Second note', name: second.name, cents: second.cents, played: second, inTune: first },
    ],
  };
}

/**
 * Detail object for progress.recordResult(..., { correct, detail }) (feeds the insights).
 * @param {object} question @param {'sharp'|'flat'|'same'} answer
 * @returns {{midi: number, direction: string, answer: string, cents: number}}
 */
export function answerDetail(question, answer) {
  return {
    midi: describeFreq(question.firstFreq).midi,
    direction: question.direction,
    answer,
    cents: question.cents,
  };
}
