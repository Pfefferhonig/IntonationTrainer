// Voice parts in the UI: the settings hold an ARRAY of voice-part keys.

import * as tuning from '../music/tuning.js';
import { getSettings } from '../storage.js';

const { VOICE_PARTS, noteName } = tuning;

/** The chosen voice-part keys (known ones only; never empty). */
export function chosenVoiceParts(settings = getSettings()) {
  const parts = (settings.voiceParts || []).filter((k) => Object.prototype.hasOwnProperty.call(VOICE_PARTS, k));
  return parts.length ? parts : ['any'];
}

/**
 * What to pass as `voicePart` to the exercise / tuning functions: the array when the
 * music module understands arrays (voiceRange exists), otherwise the first key.
 */
export function voiceArg(settings = getSettings()) {
  const parts = chosenVoiceParts(settings);
  return typeof tuning.voiceRange === 'function' ? parts : parts[0];
}

/** Combined range { lowMidi, highMidi, label } of several voice parts. */
export function combinedRange(parts = chosenVoiceParts()) {
  if (typeof tuning.voiceRange === 'function') {
    try {
      const r = tuning.voiceRange(parts);
      if (r && Number.isFinite(r.lowMidi) && Number.isFinite(r.highMidi)) return r;
    } catch (err) { console.error(err); }
  }
  const list = parts.map((k) => VOICE_PARTS[k]).filter(Boolean);
  const use = list.length ? list : [VOICE_PARTS.any];
  return {
    lowMidi: Math.min(...use.map((p) => p.lowMidi)),
    highMidi: Math.max(...use.map((p) => p.highMidi)),
    label: use.map((p) => p.label).join(' + '),
  };
}

/** "F2–G5" */
export function rangeText(r) {
  return `${noteName(r.lowMidi)}–${noteName(r.highMidi)}`;
}

/** Short label for the chosen parts, e.g. "Alto + Tenor". */
export function partsLabel(parts = chosenVoiceParts()) {
  return parts.map((k) => (VOICE_PARTS[k] ? VOICE_PARTS[k].label : k)).join(' + ');
}
