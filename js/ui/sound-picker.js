// Shared pickers used by Settings and the first-run setup:
// voice part and sound (timbre, with previews, "Loading…" for recorded sounds and
// a gentle range hint).

import { VOICE_PARTS, noteName, midiToFreq } from '../music/tuning.js';
// Namespace import: optional engine features are checked with typeof.
import * as engine from '../audio/engine.js';
import { getSettings, updateSettings, onSettingsChange } from '../storage.js';
import { el } from './dom.js';
import { icon } from './icons.js';
import { choiceCards, checkCards } from './components.js';
import { chosenVoiceParts, combinedRange, rangeText } from './voices.js';
import { createPlayer, needsLoading, ensureTimbre } from './player.js';

const PREVIEW_SECONDS = 1.4;

/** Gentle hint when the voice part's range goes beyond the instrument's range. */
export function rangeHint(timbre, part) {
  const r = timbre && timbre.range;
  if (!r || !part || !Number.isFinite(r.lowMidi) || !Number.isFinite(r.highMidi)) return '';
  const below = part.lowMidi < r.lowMidi;
  const above = part.highMidi > r.highMidi;
  if (below && above) return `Some of your notes are outside its range (${noteName(r.lowMidi)}–${noteName(r.highMidi)}).`;
  if (below) return `Sounds best for higher voices: its lowest note is ${noteName(r.lowMidi)}.`;
  if (above) return `Sounds best for lower voices: its highest note is ${noteName(r.highMidi)}.`;
  return '';
}

/** A note in the middle of the voice part, kept inside the instrument's range when they overlap. */
function previewMidi(part, timbre) {
  let lo = part.lowMidi;
  let hi = part.highMidi;
  const r = timbre && timbre.range;
  if (r && Number.isFinite(r.lowMidi) && Number.isFinite(r.highMidi)) {
    const a = Math.max(lo, r.lowMidi);
    const b = Math.min(hi, r.highMidi);
    if (a <= b) { lo = a; hi = b; }
  }
  return Math.round((lo + hi) / 2);
}

/** Voice parts picker (checkbox cards, at least one). Saves immediately. */
export function voicePicker({
  legend = 'Voice parts',
  help = 'Pick one or more. Notes are chosen to fit the combined range (C4 = middle C).',
  plain = false,
} = {}) {
  const rangeLine = el('p', { class: 'combined-range', role: 'status' });
  const renderRange = (parts) => {
    const r = combinedRange(parts);
    rangeLine.replaceChildren(
      el('span', { class: 'muted' }, parts.length > 1 ? 'Combined range: ' : 'Range: '),
      el('strong', {}, rangeText(r)),
    );
  };
  const values = chosenVoiceParts();
  renderRange(values);
  return checkCards({
    legend,
    help,
    plain,
    values,
    min: 1,
    minMessage: 'Keep at least one voice part.',
    footer: rangeLine,
    options: Object.values(VOICE_PARTS).map((p) => ({
      value: p.key,
      label: p.label,
      aside: `${noteName(p.lowMidi)}–${noteName(p.highMidi)}`,
    })),
    onChange: (parts) => {
      updateSettings({ voiceParts: parts });
      renderRange(parts);
    },
  });
}

/**
 * Sound (timbre) picker with previews. Saves immediately.
 * Returns { element, preview(key), destroy() } — call destroy() when the screen closes.
 */
export function soundPicker({ legend = 'Sound', help = 'Fuller sounds make out-of-tune notes easier to hear.', plain = false } = {}) {
  const player = createPlayer();
  let destroyed = false;
  const timbres = Object.values(engine.TIMBRES || {});
  const statusEls = new Map();
  const hintEls = new Map();

  function setLoadStatus(key, state) {
    const node = statusEls.get(key);
    if (!node) return;
    node.className = `choice-status${state === 'error' ? ' is-error' : ''}`;
    node.textContent = state === 'loading' ? 'Loading…' : state === 'error' ? 'Could not load this sound.' : '';
    node.hidden = !node.textContent;
  }

  async function loadTimbre(key) {
    if (!needsLoading(key)) return true;
    setLoadStatus(key, 'loading');
    const ok = await ensureTimbre(key);
    if (!destroyed) setLoadStatus(key, ok ? 'ready' : 'error');
    return ok;
  }

  function renderHints() {
    const part = combinedRange();
    for (const t of timbres) {
      const node = hintEls.get(t.key);
      if (!node) continue;
      node.textContent = rangeHint(t, part);
      node.hidden = !node.textContent;
    }
  }

  async function preview(key) {
    const audio = engine.initAudio(); // must start inside the click
    try { await audio; } catch (err) { console.error(err); }
    const ok = await loadTimbre(key);
    if (!ok || destroyed) return;
    const part = combinedRange();
    const freq = midiToFreq(previewMidi(part, engine.TIMBRES[key]));
    player.play([{ start: () => engine.playTone(freq, { duration: PREVIEW_SECONDS, timbre: key }) }], { timbre: key });
  }

  const element = choiceCards({
    legend,
    help,
    plain,
    value: getSettings().timbre,
    options: timbres.map((t) => {
      const status = el('span', { class: 'choice-status', role: 'status' });
      status.hidden = true;
      const hint = el('span', { class: 'choice-hint' });
      hint.hidden = true;
      statusEls.set(t.key, status);
      hintEls.set(t.key, hint);
      return {
        value: t.key,
        label: t.label,
        detail: t.description,
        more: [hint, status],
        extra: el('button', {
          type: 'button',
          class: 'btn btn-small btn-icon-only',
          'aria-label': `Preview ${t.label}`,
          title: `Preview ${t.label}`,
          onclick: () => preview(t.key),
        }, icon('play', { size: 18 })),
      };
    }),
    onChange: (v) => {
      updateSettings({ timbre: v });
      if (needsLoading(v)) {
        // Choosing a sound is a user gesture: start audio, then load the recording.
        Promise.resolve(engine.initAudio())
          .catch((err) => console.error(err))
          .then(() => loadTimbre(v));
      }
    },
  });

  renderHints();
  const unsubscribe = onSettingsChange(renderHints);

  return {
    element,
    preview,
    destroy() {
      destroyed = true;
      unsubscribe();
      player.destroy();
    },
  };
}
