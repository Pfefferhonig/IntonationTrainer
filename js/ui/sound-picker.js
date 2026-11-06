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
import { chosenVoiceParts, combinedRange, rangeText, voiceChosen, REAL_PARTS } from './voices.js';
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

/**
 * Voice parts picker: Soprano / Alto / Tenor / Bass as checkboxes (several allowed, at least
 * one once chosen). Saves immediately. While nothing is chosen yet (the internal 'any'
 * fallback), nothing is ticked and a gentle line asks to pick. onChange(parts) after a change.
 */
export function voicePicker({
  legend = 'Voice parts',
  help = 'Tick the part(s) you sing — several are fine. Notes are chosen to fit the combined range (C4 = middle C).',
  plain = false,
  heading = false,
  onChange,
} = {}) {
  const rangeLine = el('p', { class: 'combined-range', role: 'status' });
  const notChosen = el('p', { class: 'voice-not-chosen' }, 'Not chosen yet — tick your part(s) so the notes suit your voice.');
  const renderRange = (parts) => {
    const chosen = parts.length > 0;
    notChosen.hidden = chosen;
    const r = combinedRange(chosen ? parts : ['any']);
    rangeLine.replaceChildren(
      el('span', { class: 'muted' }, !chosen ? 'Range for now: ' : parts.length > 1 ? 'Combined range: ' : 'Range: '),
      el('strong', {}, rangeText(r)),
    );
  };
  const values = voiceChosen() ? chosenVoiceParts().filter((k) => REAL_PARTS.includes(k)) : [];
  renderRange(values);
  return checkCards({
    legend,
    help,
    plain,
    heading,
    values,
    min: 1,
    minMessage: 'Keep at least one voice part.',
    footer: [notChosen, rangeLine],
    options: REAL_PARTS.map((k) => VOICE_PARTS[k]).map((p) => ({
      value: p.key,
      label: p.label,
      aside: `${noteName(p.lowMidi)}–${noteName(p.highMidi)}`,
    })),
    onChange: (parts) => {
      updateSettings({ voiceParts: parts }); // real parts replace the 'any' fallback
      renderRange(parts);
      if (typeof onChange === 'function') onChange(parts);
    },
  });
}

/**
 * Sound (timbre) picker with previews. Saves immediately.
 * Returns { element, preview(key), destroy() } — call destroy() when the screen closes.
 */
export function soundPicker({ legend = 'Sound', help = 'Fuller sounds make out-of-tune notes easier to hear.', plain = false, heading = false } = {}) {
  const previewBtns = new Map();
  let playingKey = null;
  // The ▶ of the sound that is playing turns into a stop button.
  function syncPreviewButtons() {
    for (const [key, btn] of previewBtns) {
      const on = key === playingKey;
      const label = engine.TIMBRES[key] ? engine.TIMBRES[key].label : key;
      btn.replaceChildren(icon(on ? 'square' : 'play', { size: 18 }));
      btn.setAttribute('aria-label', on ? `Stop the ${label} preview` : `Preview ${label}`);
      btn.setAttribute('title', on ? 'Stop' : `Preview ${label}`);
      btn.setAttribute('aria-pressed', on ? 'true' : 'false');
      btn.classList.toggle('is-playing', on);
    }
  }
  const player = createPlayer({
    onChange: (st) => {
      playingKey = st && st.playing ? st.tag : null;
      syncPreviewButtons();
      if (st && st.error) {
        const node = statusEls.get(lastPreview);
        if (node) { node.className = 'choice-status is-error'; node.textContent = st.error; }
      }
    },
  });
  let lastPreview = null;
  let destroyed = false;
  const timbres = Object.values(engine.TIMBRES || {});
  const statusEls = new Map();
  const hintEls = new Map();

  function setLoadStatus(key, state) {
    const node = statusEls.get(key);
    if (!node) return;
    node.className = `choice-status${state === 'error' ? ' is-error' : ''}`;
    node.textContent = state === 'loading' ? 'Loading…' : state === 'error' ? "This sound didn't load. Try again or choose another sound." : '';
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
    if (playingKey === key) { player.stop(); return; } // the ▶ is a stop button while playing
    lastPreview = key;
    const audio = engine.initAudio(); // must start inside the click
    // Previewing a sound also chooses it.
    const radio = element.querySelector(`input[type="radio"][value="${key}"]`);
    if (radio && !radio.checked) {
      radio.checked = true;
      updateSettings({ timbre: key });
    }
    try { await audio; } catch (err) { console.error(err); }
    const ok = await loadTimbre(key);
    if (!ok || destroyed) return;
    const part = combinedRange();
    const freq = midiToFreq(previewMidi(part, engine.TIMBRES[key]));
    player.play([{ tag: key, start: () => engine.playTone(freq, { duration: PREVIEW_SECONDS, timbre: key }) }], { timbre: key });
  }

  const element = choiceCards({
    legend,
    help,
    plain,
    heading,
    value: getSettings().timbre,
    options: timbres.map((t) => {
      const status = el('span', { class: 'choice-status', role: 'status' });
      const hint = el('span', { class: 'choice-hint' });
      hint.hidden = true;
      statusEls.set(t.key, status);
      hintEls.set(t.key, hint);
      return {
        value: t.key,
        label: t.label,
        detail: t.description,
        more: [hint, status],
        extra: (() => {
          const b = el('button', {
            type: 'button',
            class: 'btn btn-small btn-icon-only btn-preview',
            'aria-label': `Preview ${t.label}`,
            title: `Preview ${t.label}`,
            'aria-pressed': 'false',
            onclick: () => preview(t.key),
          }, icon('play', { size: 18 }));
          previewBtns.set(t.key, b);
          return b;
        })(),
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
