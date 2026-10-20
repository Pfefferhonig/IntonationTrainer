// Note names for the UI, with a fallback while tuning.js has no describeFreq yet.

import * as tuning from '../music/tuning.js';

/** { name: 'A3', midi: 57, cents: 12.3, text: 'A3 +12' } for a frequency. */
export function describeFreq(freq) {
  if (typeof tuning.describeFreq === 'function') {
    try { return tuning.describeFreq(freq); } catch (err) { console.error(err); }
  }
  if (!(freq > 0)) return null;
  const m = tuning.freqToMidi(freq);
  const midi = Math.round(m);
  const cents = (m - midi) * 100;
  const name = tuning.noteName(midi);
  const r = Math.round(cents);
  return { name, midi, cents, text: r ? `${name} ${r > 0 ? '+' : '−'}${Math.abs(r)}` : name };
}
