// Pure tuning / music math. No DOM, no audio, no dependencies.
// Conventions: frequencies in Hz, intervals in cents (100 cents = 1 equal-tempered
// semitone, 1200 cents = 1 octave), MIDI note numbers with 60 = C4 and 69 = A4.

/** Tuning system identifiers. */
export const TUNINGS = { JUST: 'just', EQUAL: 'equal' };

/** Human-readable labels for each tuning system. */
export const TUNING_LABELS = {
  just: 'Just intonation (pure, choir)',
  equal: 'Equal temperament (piano)',
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
 * cents is rounded to 0.1; text rounds to whole cents and uses a true minus sign ('D4 −8');
 * a note within half a cent of the piano key is just its name ('A4').
 * @param {number} freq @returns {{name: string, midi: number, cents: number, text: string}}
 */
export function describeFreq(freq) {
  const exact = freqToMidi(freq);
  const midi = Math.round(exact);
  const cents = Math.round((exact - midi) * 1000) / 10;
  const whole = Math.round(cents);
  const name = noteName(midi);
  const text = whole === 0 ? name : `${name} ${whole > 0 ? '+' : '−'}${Math.abs(whole)}`;
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
 * Plain-language size in cents, rounded to 0.1, sign dropped: 12 -> "12 cents",
 * 1 -> "1 cent", 3.46 -> "3.5 cents", -5 -> "5 cents".
 * @param {number} cents @returns {string}
 */
export function formatCents(cents) {
  const v = Math.round(Math.abs(cents) * 10) / 10;
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
 * Plain chord name from the root's nearest note: chordName(293.7, 'major') -> 'D major',
 * chordName(196, 'dom7') -> 'G dominant 7th'.
 * @param {number} rootFreq @param {string} chordKey @returns {string}
 */
export function chordName(rootFreq, chordKey) {
  const chord = lookup(CHORDS, chordKey);
  if (!chord) throw new Error(`Unknown chord key: "${chordKey}"`);
  const m = Math.round(freqToMidi(rootFreq));
  return `${NOTE_NAMES[((m % 12) + 12) % 12]} ${chord.quality}`;
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

/**
 * Range covered by one voice part or several (the union: lowest low .. highest high).
 * Accepts a key or an array of keys; unknown keys are ignored; nothing valid -> 'any'.
 * label: the part's label, or several joined in table order ('Alto + Tenor').
 * @param {string|string[]} voiceParts
 * @returns {{lowMidi: number, highMidi: number, label: string}}
 */
export function voiceRange(voiceParts) {
  const keys = Array.isArray(voiceParts) ? voiceParts : [voiceParts];
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
