// Pure tuning / music math. No DOM, no audio, no dependencies.
// Conventions: frequencies in Hz, intervals in cents (100 cents = 1 equal-tempered
// semitone, 1200 cents = 1 octave), MIDI note numbers with 60 = C4 and 69 = A4.

/** Tuning system identifiers. */
export const TUNINGS = { JUST: 'just', EQUAL: 'equal' };

/** Human-readable labels for each tuning system. */
export const TUNING_LABELS = {
  just: 'Pure (choir tuning)',
  equal: 'Piano (equal steps)',
};

const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];

/**
 * Size of the interval from f1 up to f2, in cents (negative if f2 is lower).
 * @param {number} f1 @param {number} f2 @returns {number}
 */
export function centsBetween(f1, f2) {
  return 1200 * Math.log2(f2 / f1);
}

/**
 * Raise (positive cents) or lower (negative cents) a frequency.
 * @param {number} freq @param {number} cents @returns {number}
 */
export function shiftByCents(freq, cents) {
  return freq * Math.pow(2, cents / 1200);
}

/**
 * Equal-tempered frequency of a (possibly fractional) MIDI note number.
 * @param {number} midi @param {number} [a4=440] @returns {number}
 */
export function midiToFreq(midi, a4 = 440) {
  return a4 * Math.pow(2, (midi - 69) / 12);
}

/**
 * Fractional MIDI note number of a frequency (inverse of midiToFreq).
 * @param {number} freq @param {number} [a4=440] @returns {number}
 */
export function freqToMidi(freq, a4 = 440) {
  return 69 + 12 * Math.log2(freq / a4);
}

/**
 * Note name with sharps and octave number, rounding to the nearest MIDI note.
 * 60 -> "C4", 69 -> "A4", 61 -> "C#4".
 * @param {number} midi @returns {string}
 */
export function noteName(midi) {
  const m = Math.round(midi);
  const pc = ((m % 12) + 12) % 12;
  const octave = Math.floor(m / 12) - 1;
  return NOTE_NAMES[pc] + octave;
}

/**
 * Nearest piano note of a frequency and the offset from it.
 * describeFreq(224) -> { name: 'A3', midi: 57, cents: 31.1, text: 'A3 +31' }.
 * cents is rounded to 0.1; text uses the roundCents rule (whole from 10 cents, one decimal
 * below: 'D4 −8.2', 'A3 +12') and a true minus sign; an offset that rounds to 0 shows just the
 * name ('A4').
 * @param {number} freq @returns {{name: string, midi: number, cents: number, text: string}}
 */
export function describeFreq(freq) {
  const exact = freqToMidi(freq);
  const midi = Math.round(exact);
  const cents = Math.round((exact - midi) * 1000) / 10;
  const shown = roundCents((exact - midi) * 100);
  const name = noteName(midi);
  const text = shown === 0 ? name : `${name} ${shown > 0 ? '+' : '−'}${Math.abs(shown)}`;
  return { name, midi, cents: cents === 0 ? 0 : cents, text };
}

/**
 * Register band (one octave, C to B) of a MIDI note, for grouping results:
 * registerBand(57) -> { index: 4, label: 'C3–B3', lowMidi: 48, highMidi: 59 }.
 * @param {number} midi @returns {{index: number, label: string, lowMidi: number, highMidi: number}}
 */
export function registerBand(midi) {
  const m = Math.round(midi);
  const index = Math.floor(m / 12);
  const octave = index - 1;
  return { index, label: `C${octave}–B${octave}`, lowMidi: index * 12, highMidi: index * 12 + 11 };
}

/**
 * The one rounding rule for showing cents: whole numbers from 10 cents up, one decimal below 10
 * (".0" never shown by JavaScript anyway). Keeps the sign: roundCents(-86.14) -> -86,
 * roundCents(3.46) -> 3.5, roundCents(9.96) -> 10. For UI code that formats numbers itself.
 * @param {number} cents @returns {number}
 */
export function roundCents(cents) {
  const a = Math.abs(cents);
  const tenth = Math.round(a * 10) / 10;
  const r = tenth >= 10 ? Math.round(a) : tenth;
  return r === 0 ? 0 : Math.sign(cents) * r;
}

/**
 * Plain-language size in cents with the roundCents rule, sign dropped: 86.1 -> "86 cents",
 * 3.46 -> "3.5 cents", 1 -> "1 cent", -5 -> "5 cents". Every user-visible message uses this.
 * @param {number} cents @returns {string}
 */
export function formatCents(cents) {
  const v = Math.abs(roundCents(cents));
  return `${v} ${v === 1 ? 'cent' : 'cents'}`;
}

// ---------------------------------------------------------------------------
// Intervals
// ---------------------------------------------------------------------------

// [key, plain-English name, equal-tempered semitones, just ratio]
const INTERVAL_DEFS = [
  ['P1', 'Unison', 0, [1, 1]],
  ['m2', 'Minor second', 1, [16, 15]],
  ['M2', 'Major second', 2, [9, 8]],
  ['m3', 'Minor third', 3, [6, 5]],
  ['M3', 'Major third', 4, [5, 4]],
  ['P4', 'Perfect fourth', 5, [4, 3]],
  ['TT', 'Tritone', 6, [45, 32]],
  ['P5', 'Perfect fifth', 7, [3, 2]],
  ['m6', 'Minor sixth', 8, [8, 5]],
  ['M6', 'Major sixth', 9, [5, 3]],
  ['m7', 'Minor seventh', 10, [9, 5]],
  ['M7', 'Major seventh', 11, [15, 8]],
  ['P8', 'Octave', 12, [2, 1]],
  // Harmonic (natural) seventh: the 7th overtone, much lower than the piano's minor
  // seventh. Its nearest equal-tempered counterpart is the minor seventh (10 semitones).
  ['h7', 'Harmonic seventh', 10, [7, 4]],
];

/**
 * Interval table keyed by interval key ('P1','m2',...,'P8','h7').
 * Each entry: { key, name, semitones, justRatio: [num, den], justCents, equalCents }.
 */
export const INTERVALS = Object.freeze(
  Object.fromEntries(
    INTERVAL_DEFS.map(([key, name, semitones, justRatio]) => [
      key,
      Object.freeze({
        key,
        name,
        semitones,
        justRatio: Object.freeze(justRatio.slice()),
        justCents: 1200 * Math.log2(justRatio[0] / justRatio[1]),
        equalCents: 100 * semitones,
      }),
    ])
  )
);

/** Own-property lookup, so keys like 'toString' never hit Object.prototype. */
function lookup(table, key) {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

function getInterval(intervalKey) {
  const iv = lookup(INTERVALS, intervalKey);
  if (!iv) throw new Error(`Unknown interval key: "${intervalKey}"`);
  return iv;
}

function checkTuning(tuning) {
  if (tuning !== TUNINGS.JUST && tuning !== TUNINGS.EQUAL) {
    throw new Error(`Unknown tuning: "${tuning}" (expected 'just' or 'equal')`);
  }
}

/**
 * Size of an interval in cents in the given tuning.
 * @param {string} intervalKey e.g. 'M3' @param {'just'|'equal'} tuning @returns {number}
 */
export function intervalCents(intervalKey, tuning) {
  const iv = getInterval(intervalKey);
  checkTuning(tuning);
  return tuning === TUNINGS.JUST ? iv.justCents : iv.equalCents;
}

/** Frequency ratio of an interval in the given tuning. */
function intervalRatio(intervalKey, tuning) {
  const iv = getInterval(intervalKey);
  checkTuning(tuning);
  return tuning === TUNINGS.JUST
    ? iv.justRatio[0] / iv.justRatio[1]
    : Math.pow(2, iv.semitones / 12);
}

// ---------------------------------------------------------------------------
// Chords
// ---------------------------------------------------------------------------

// To add a chord, add one entry here. Intervals are measured from the root and must be
// listed low to high; degreeLabels runs parallel to intervals. `quality` is what follows
// the note name in chordName(), e.g. 'D major', 'G dominant 7th'.
const SEVENTH_LABELS = ['Root', 'Third', 'Fifth', 'Seventh'];
const CHORD_DEFS = [
  { key: 'major', name: 'Major chord', quality: 'major', intervals: ['P1', 'M3', 'P5'], degreeLabels: ['Root', 'Third', 'Fifth'] },
  { key: 'minor', name: 'Minor chord', quality: 'minor', intervals: ['P1', 'm3', 'P5'], degreeLabels: ['Root', 'Third', 'Fifth'] },
  // Just ratios 4:5:6:7 — the harmonic ("barbershop") seventh, ~31 cents below the piano's.
  { key: 'dom7', name: 'Dominant seventh chord', quality: 'dominant 7th', intervals: ['P1', 'M3', 'P5', 'h7'], degreeLabels: SEVENTH_LABELS },
  // Just ratios 8:10:12:15.
  { key: 'maj7', name: 'Major seventh chord', quality: 'major 7th', intervals: ['P1', 'M3', 'P5', 'M7'], degreeLabels: SEVENTH_LABELS },
  // Just ratios 10:12:15:18.
  { key: 'min7', name: 'Minor seventh chord', quality: 'minor 7th', intervals: ['P1', 'm3', 'P5', 'm7'], degreeLabels: SEVENTH_LABELS },
];

/**
 * Chord table keyed by chord key ('major', 'minor', 'dom7', 'maj7', 'min7').
 * Each entry: { key, name, quality, intervals: [intervalKey...], degreeLabels: [...] }.
 */
export const CHORDS = Object.freeze(
  Object.fromEntries(
    CHORD_DEFS.map((c) => [
      c.key,
      Object.freeze({
        key: c.key,
        name: c.name,
        quality: c.quality,
        intervals: Object.freeze(c.intervals.slice()),
        degreeLabels: Object.freeze(c.degreeLabels.slice()),
      }),
    ])
  )
);

/**
 * Plain chord name from the root's nearest note, in key spelling (KEY_NAMES): chordName(293.7, 'major') -> 'D major',
 * chordName(196, 'dom7') -> 'G dominant 7th'.
 * @param {number} rootFreq @param {string} chordKey @returns {string}
 */
export function chordName(rootFreq, chordKey) {
  const chord = lookup(CHORDS, chordKey);
  if (!chord) throw new Error(`Unknown chord key: "${chordKey}"`);
  const m = Math.round(freqToMidi(rootFreq));
  return `${KEY_NAMES[((m % 12) + 12) % 12]} ${chord.quality}`;
}

// ---------------------------------------------------------------------------
// Note spelling (names for the key, not the piano grid)
// ---------------------------------------------------------------------------

/**
 * Conventional key spelling of the 12 pitch classes (C = 0), used for roots and keys:
 * C, D♭, D, E♭, E, F, F♯, G, A♭, A, B♭, B.
 */
export const KEY_NAMES = Object.freeze(['C', 'D♭', 'D', 'E♭', 'E', 'F', 'F♯', 'G', 'A♭', 'A', 'B♭', 'B']);

const LETTERS = ['C', 'D', 'E', 'F', 'G', 'A', 'B'];
const LETTER_SEMITONES = [0, 2, 4, 5, 7, 9, 11];
const ACCIDENTALS = { '-2': '𝄫', '-1': '♭', 0: '', 1: '♯', 2: '𝄪' };
/** Letter steps of each interval: a second is 1 letter, a third 2, ...; the tritone is an augmented fourth (3). */
const INTERVAL_LETTER_STEPS = { P1: 0, m2: 1, M2: 1, m3: 2, M3: 2, P4: 3, TT: 3, P5: 4, m6: 5, M6: 5, m7: 6, M7: 6, h7: 6, P8: 7 };

/** A spelled note: { name: 'B♭3', pitchClass: 'B♭', letter: 'B', alter: -1, octave: 3, midi: 58 }. */
function makeSpelled(letterIndex, alter, octave) {
  const letter = LETTERS[letterIndex];
  const acc = ACCIDENTALS[alter];
  if (acc === undefined) throw new Error(`Cannot spell a note with ${alter} accidentals`);
  const pitchClass = letter + acc;
  return { name: pitchClass + octave, pitchClass, letter, alter, octave, midi: (octave + 1) * 12 + LETTER_SEMITONES[letterIndex] + alter };
}

/**
 * Root / key note of a frequency: its nearest pitch class in key spelling (KEY_NAMES), octave in
 * scientific pitch (60 = C4). Random non-grid pitches are named by the nearest key, without any
 * piano offset: rootName(233.1) -> { name: 'B♭3', pitchClass: 'B♭', letter: 'B', alter: -1,
 * octave: 3, midi: 58 }.
 * @param {number} freq
 * @returns {{name: string, pitchClass: string, letter: string, alter: number, octave: number, midi: number}}
 */
export function rootName(freq) {
  const midi = Math.round(freqToMidi(freq));
  const pc = ((midi % 12) + 12) % 12;
  const letterIndex = LETTERS.indexOf(KEY_NAMES[pc][0]);
  return makeSpelled(letterIndex, pc - LETTER_SEMITONES[letterIndex], Math.floor(midi / 12) - 1);
}

/**
 * Parse a note name such as 'B♭3', 'Bb3', 'F♯4', 'F#4', 'C4', 'E𝄫5', 'Fx4' into a spelled note.
 * @param {string} name @returns {object} spelled note (see rootName)
 */
export function parseNoteName(name) {
  const m = /^([A-Ga-g])(𝄪|𝄫|##|bb|x|[♯#♭b]?)(-?\d+)$/.exec(String(name).trim());
  if (!m) throw new Error(`Not a note name: "${name}"`);
  const alter = { '': 0, '♯': 1, '#': 1, '♭': -1, b: -1, '##': 2, x: 2, '𝄪': 2, bb: -2, '𝄫': -2 }[m[2]];
  return makeSpelled(LETTERS.indexOf(m[1].toUpperCase()), alter, Number(m[3]));
}

/**
 * Spell the note an interval above (or below) a root, by interval: the letter moves by the
 * interval's number (second = 1 letter, third = 2, fourth = 3, fifth = 4, sixth = 5, seventh = 6,
 * octave = 7; the tritone is an augmented fourth) and the accidental makes the size exact.
 * Octave numbers follow the letter (scientific pitch: C♭4 = B3's key, B♯3 = C4's key).
 * spellInterval('G3', 'm7').name -> 'F4'; spellInterval('B♭3', 'm7').name -> 'A♭4';
 * spellInterval('C4', 'TT').name -> 'F♯4'; spellInterval('E4', 'M3', 'down').name -> 'C4'.
 * Double sharps/flats appear only when the interval demands them (a minor second above A♭ is B𝄫).
 * @param {string|object} root note name or spelled note (rootName / parseNoteName / spellInterval)
 * @param {string} intervalKey @param {'up'|'down'} [direction='up']
 * @returns {{name: string, pitchClass: string, letter: string, alter: number, octave: number, midi: number}}
 */
export function spellInterval(root, intervalKey, direction = 'up') {
  const r = typeof root === 'string' ? parseNoteName(root) : root;
  if (!r || !LETTERS.includes(r.letter)) throw new Error('spellInterval: root must be a note name or a spelled note');
  const iv = getInterval(intervalKey);
  const steps = INTERVAL_LETTER_STEPS[intervalKey];
  if (steps === undefined) throw new Error(`spellInterval: no spelling for "${intervalKey}"`);
  const sign = direction === 'down' ? -1 : 1;
  const targetIndex = LETTERS.indexOf(r.letter) + r.octave * 7 + sign * steps;
  const letterIndex = ((targetIndex % 7) + 7) % 7;
  const octave = Math.floor(targetIndex / 7);
  const targetMidi = r.midi + sign * iv.semitones;
  return makeSpelled(letterIndex, targetMidi - ((octave + 1) * 12 + LETTER_SEMITONES[letterIndex]), octave);
}

/** The same spelled note, `shift` octaves up (+) or down (-). */
export function shiftOctave(spelled, shift) {
  return makeSpelled(LETTERS.indexOf(spelled.letter), spelled.alter, spelled.octave + shift);
}

/**
 * Plain size of a pitch difference compared with a semitone, for |cents| >= 20 when it is close
 * to a simple fraction: 56 -> 'about half a semitone', 26 -> 'about a quarter of a semitone';
 * null otherwise.
 * @param {number} cents @returns {string|null}
 */
export function semitoneFraction(cents) {
  const c = Math.abs(cents);
  if (c < 20) return null;
  const options = [[25, 'a quarter of a semitone'], [100 / 3, 'a third of a semitone'], [50, 'half a semitone'],
    [200 / 3, 'two thirds of a semitone'], [75, 'three quarters of a semitone'], [100, 'a semitone']];
  let best = null;
  for (const [v, text] of options) {
    if (Math.abs(c - v) <= 8 && (!best || Math.abs(c - v) < Math.abs(c - best[0]))) best = [v, text];
  }
  return best ? `about ${best[1]}` : null;
}

/**
 * Plain deviation of a note from its target, using the one cents rule:
 * deviation(35, 'too high', 'too low') -> { cents: 35, text: '35 cents too high' };
 * deviation(-8, 'above pure', 'below pure') -> { cents: -8, text: '8 cents below pure' };
 * rounds to 0 -> { cents: 0, text: onTarget } (default 'in tune').
 * @param {number} cents signed (+ = higher) @param {string} upWords @param {string} downWords
 * @param {string} [onTarget='in tune']
 * @returns {{cents: number, text: string}}
 */
export function deviation(cents, upWords, downWords, onTarget = 'in tune') {
  const c = roundCents(cents);
  if (c === 0) return { cents: 0, text: onTarget };
  return { cents: c, text: `${formatCents(c)} ${c > 0 ? upWords : downWords}` };
}

/**
 * Frequencies of a chord built on rootFreq, ordered low to high.
 * Just: rootFreq * ratio. Equal: rootFreq * 2^(semitones/12).
 * @param {number} rootFreq @param {string} chordKey @param {'just'|'equal'} tuning
 * @returns {{label: string, intervalKey: string, freq: number}[]}
 */
export function buildChord(rootFreq, chordKey, tuning) {
  const chord = lookup(CHORDS, chordKey);
  if (!chord) throw new Error(`Unknown chord key: "${chordKey}"`);
  checkTuning(tuning);
  return chord.intervals
    .map((intervalKey, i) => ({
      label: chord.degreeLabels[i],
      intervalKey,
      freq: rootFreq * intervalRatio(intervalKey, tuning),
    }))
    .sort((a, b) => a.freq - b.freq);
}

// ---------------------------------------------------------------------------
// Feedback
// ---------------------------------------------------------------------------

/**
 * Compare a produced interval (cents above the root) with its just and equal targets.
 * All deviations are signed: positive = sharp (too high) of that target.
 * If the two targets are within 1 cent of each other (e.g. unison, octave), nearest is 'just'.
 * Exact ties also go to 'just'.
 * @param {number} centsAboveRoot @param {string} intervalKey
 * @returns {{nearest: 'just'|'equal', centsFromJust: number, centsFromEqual: number, centsFromNearest: number}}
 */
export function compareToTunings(centsAboveRoot, intervalKey) {
  const iv = getInterval(intervalKey);
  const centsFromJust = centsAboveRoot - iv.justCents;
  const centsFromEqual = centsAboveRoot - iv.equalCents;
  let nearest = TUNINGS.JUST;
  if (Math.abs(iv.justCents - iv.equalCents) > 1 && Math.abs(centsFromEqual) < Math.abs(centsFromJust)) {
    nearest = TUNINGS.EQUAL;
  }
  return {
    nearest,
    centsFromJust,
    centsFromEqual,
    centsFromNearest: nearest === TUNINGS.JUST ? centsFromJust : centsFromEqual,
  };
}

// ---------------------------------------------------------------------------
// Voice parts
// ---------------------------------------------------------------------------

// Comfortable ranges (roughly the middle of each part's tessitura, not the extremes),
// so that amateur singers can hum along without strain:
//   soprano C4-G5, alto F3-C5, tenor C3-G4, bass F2-C4 (all ~19 semitones).
//   'any' G3-E5 (21 semitones): the zone where pitch is clearest for most listeners,
//   comfortable to hear for everyone and singable (possibly an octave down) by all.
const VOICE_PART_DEFS = [
  { key: 'any', label: 'Any voice', lowMidi: 55, highMidi: 76 },     // G3-E5
  { key: 'soprano', label: 'Soprano', lowMidi: 60, highMidi: 79 },   // C4-G5
  { key: 'alto', label: 'Alto', lowMidi: 53, highMidi: 72 },         // F3-C5
  { key: 'tenor', label: 'Tenor', lowMidi: 48, highMidi: 67 },       // C3-G4
  { key: 'bass', label: 'Bass', lowMidi: 41, highMidi: 60 },         // F2-C4
];

/**
 * Voice-part ranges: { any, soprano, alto, tenor, bass } -> { key, label, lowMidi, highMidi }.
 */
export const VOICE_PARTS = Object.freeze(
  Object.fromEntries(VOICE_PART_DEFS.map((v) => [v.key, Object.freeze({ ...v })]))
);

/** The real voice parts, in display order (soprano -> bass). 'any' is only the fallback. */
const REAL_PARTS = ['soprano', 'alto', 'tenor', 'bass'];

/**
 * Clean a voice-part selection: unknown keys dropped, duplicates removed, order soprano -> bass,
 * and 'any' removed when at least one real part is present. Only 'any' -> ['any']; nothing
 * valid -> [] (voiceRange then falls back to 'any').
 * @param {string|string[]} list @returns {string[]}
 */
export function cleanVoiceParts(list) {
  const keys = Array.isArray(list) ? list : typeof list === 'string' ? [list] : [];
  const real = REAL_PARTS.filter((k) => keys.includes(k));
  if (real.length) return real;
  return keys.includes('any') ? ['any'] : [];
}

/**
 * True when the selection contains at least one real voice part (soprano/alto/tenor/bass);
 * false for nothing, only 'any', or only unknown keys (the user has not picked yet).
 * @param {string|string[]} voiceParts @returns {boolean}
 */
export function isVoiceChosen(voiceParts) {
  return cleanVoiceParts(voiceParts).some((k) => k !== 'any');
}

/**
 * Range covered by one voice part or several (the union: lowest low .. highest high).
 * Accepts a key or an array of keys, cleaned with cleanVoiceParts ('any' is ignored next to a
 * real part); nothing valid -> 'any' (the fallback for users who have not picked a part yet).
 * label: the part's label, or several joined soprano -> bass ('Alto + Tenor').
 * @param {string|string[]} voiceParts
 * @returns {{lowMidi: number, highMidi: number, label: string}}
 */
export function voiceRange(voiceParts) {
  const keys = cleanVoiceParts(voiceParts);
  const parts = VOICE_PART_DEFS.filter((v) => keys.includes(v.key));
  if (parts.length === 0) parts.push(VOICE_PARTS.any);
  return {
    lowMidi: Math.min(...parts.map((p) => p.lowMidi)),
    highMidi: Math.max(...parts.map((p) => p.highMidi)),
    label: parts.map((p) => p.label).join(' + '),
  };
}

/**
 * Random root frequency (continuous, not snapped to piano keys, A4 = 440) such that
 * root .. root + spanSemitones fits inside the voice part's range.
 * voicePartKey may be a key or an array of keys (see voiceRange); unknown -> 'any'.
 * Throws if the span does not fit.
 * @param {string|string[]} voicePartKey @param {number} spanSemitones
 * @param {() => number} [rng=Math.random] returns a number in [0, 1)
 * @returns {number} frequency in Hz
 */
export function randomRootFreq(voicePartKey, spanSemitones, rng = Math.random) {
  const part = voiceRange(voicePartKey);
  if (typeof spanSemitones !== 'number' || !Number.isFinite(spanSemitones) || spanSemitones < 0) {
    throw new Error(`randomRootFreq: spanSemitones must be a non-negative number, got ${spanSemitones}`);
  }
  const room = part.highMidi - part.lowMidi - spanSemitones;
  if (room < 0) {
    throw new Error(
      `randomRootFreq: a span of ${spanSemitones} semitones does not fit in the ${part.label} range ` +
        `(${noteName(part.lowMidi)}-${noteName(part.highMidi)}, ${part.highMidi - part.lowMidi} semitones)`
    );
  }
  const rootMidi = part.lowMidi + rng() * room;
  return midiToFreq(rootMidi);
}
