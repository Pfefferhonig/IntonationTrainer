// Settings & progress persistence (localStorage).
// Every storage access is wrapped in try/catch: the app keeps working (in memory)
// when storage is unavailable, e.g. in a private window or with blocked site data.

// Namespace import: cleanVoiceParts is feature-checked (the music module has no storage dependency).
import * as tuning from './music/tuning.js';

const SETTINGS_KEY = 'choirTrainer.settings.v1';
const PROGRESS_PREFIX = 'choirTrainer.progress.';

// reverb: amount of "room echo", 0..1 (matches engine DEFAULT_REVERB).
// voiceParts: one or more voice-part keys (replaces the older single `voicePart`).
// keyShortcuts: single-key shortcuts (letters, digits, =) on/off (WCAG 2.1.4); arrows/Space/Enter/Esc always work.
// audioQuality: 'auto' | 'high' | 'light' (engine.setAudioQuality). handsFree: tap to start / tap to stop singing.
const DEFAULTS = Object.freeze({
  tuning: 'just', voiceParts: Object.freeze(['any']), timbre: 'organ', volume: 0.7, reverb: 0.35,
  keyShortcuts: true, audioQuality: 'auto', handsFree: false,
});
const AUDIO_QUALITIES = ['auto', 'high', 'light'];

/**
 * Clean list of voice-part keys (unique, non-empty strings); migrates the old `voicePart`.
 * 'any' is only the internal fallback ("not chosen yet"): as soon as a real part is in the
 * list, 'any' is dropped (['any', 'bass'] -> ['bass']). Uses tuning.cleanVoiceParts when
 * available, with the same rule here as a fallback.
 */
function cleanVoiceParts(list, legacy) {
  let parts = Array.isArray(list) ? list : typeof list === 'string' ? [list] : [];
  parts = [...new Set(parts.filter((p) => typeof p === 'string' && p))];
  if (!parts.length && typeof legacy === 'string' && legacy) parts = [legacy];
  if (typeof tuning.cleanVoiceParts === 'function') {
    try {
      const cleaned = tuning.cleanVoiceParts(parts);
      if (Array.isArray(cleaned) && cleaned.length) return [...cleaned];
    } catch { /* fall back to the rule below */ }
  }
  if (parts.length > 1) parts = parts.filter((p) => p !== 'any');
  return parts.length ? parts : [...DEFAULTS.voiceParts];
}

function unit(value, fallback) {
  const v = Number(value);
  return Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : fallback;
}

let cache = null;              // current settings (in memory)
const memoryProgress = {};     // fallback when localStorage is unavailable
const listeners = new Set();

function readJSON(key) {
  try {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

/**
 * Read a stored object fresh from localStorage. { ok: false } when storage can't be read (private
 * window, blocked site data): callers then keep their in-memory copy. A missing key reads as {}.
 */
function readStoredObject(key) {
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return { ok: true, value: {} };
    const v = JSON.parse(raw);
    return { ok: true, value: v && typeof v === 'object' && !Array.isArray(v) ? v : {} };
  } catch {
    return { ok: false, value: null };
  }
}

function writeJSON(key, value) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

function sanitize(s) {
  const src = s || {};
  const out = { ...DEFAULTS, ...src };
  for (const k of ['tuning', 'timbre']) {
    if (typeof out[k] !== 'string' || !out[k]) out[k] = DEFAULTS[k];
  }
  out.voiceParts = cleanVoiceParts(src.voiceParts, src.voicePart);
  delete out.voicePart; // migrated
  out.volume = unit(out.volume, DEFAULTS.volume);
  out.reverb = unit(out.reverb, DEFAULTS.reverb);
  for (const k of ['keyShortcuts', 'handsFree']) {
    if (typeof out[k] !== 'boolean') out[k] = DEFAULTS[k];
  }
  if (!AUDIO_QUALITIES.includes(out.audioQuality)) out.audioQuality = DEFAULTS.audioQuality;
  return out;
}

const copy = (s) => ({ ...s, voiceParts: [...s.voiceParts] });

function load() {
  const stored = readJSON(SETTINGS_KEY);
  return sanitize(stored && typeof stored === 'object' ? stored : {});
}

function notify() {
  for (const cb of [...listeners]) {
    try {
      cb(copy(cache));
    } catch (err) {
      console.error('Settings listener failed:', err);
    }
  }
}

export function getSettings() {
  if (!cache) cache = load();
  return copy(cache);
}

/**
 * Change some settings. Re-reads the stored settings first and merges in only the changed keys, so a
 * second open tab never overwrites what this one did not change.
 */
export function updateSettings(patch) {
  const stored = readStoredObject(SETTINGS_KEY);
  const base = stored.ok && Object.keys(stored.value).length ? sanitize(stored.value) : getSettings();
  cache = sanitize({ ...base, ...(patch || {}) });
  writeJSON(SETTINGS_KEY, cache);
  notify();
  return copy(cache);
}

export function onSettingsChange(callback) {
  listeners.add(callback);
  return () => {
    listeners.delete(callback);
  };
}

export function getProgress(chapterKey) {
  const key = PROGRESS_PREFIX + chapterKey;
  const stored = readJSON(key);
  if (stored !== null) return stored;
  return Object.prototype.hasOwnProperty.call(memoryProgress, key) ? memoryProgress[key] : null;
}

export function saveProgress(chapterKey, data) {
  const key = PROGRESS_PREFIX + chapterKey;
  memoryProgress[key] = data;
  writeJSON(key, data);
}

// --- Small UI preferences (last opened tab, playback style, ...).
// Separate from settings so the settings contract stays unchanged.
const PREFS_KEY = 'choirTrainer.prefs.v1';
let prefsCache = null;

/** The current preferences, read fresh (another tab may have changed them); the cache is the fallback. */
function loadPrefs() {
  const stored = readStoredObject(PREFS_KEY);
  if (stored.ok) prefsCache = stored.value;
  else if (!prefsCache) prefsCache = {};
  return prefsCache;
}

/** Read a UI preference; returns `fallback` when it was never set. */
export function getPref(name, fallback = null) {
  const prefs = loadPrefs();
  return Object.prototype.hasOwnProperty.call(prefs, name) ? prefs[name] : fallback;
}

/**
 * Save a UI preference (JSON-serializable value). Re-reads the stored preferences right before writing
 * and changes only this key, so preferences saved by another open tab are kept.
 */
export function setPref(name, value) {
  const prefs = { ...loadPrefs(), [name]: value };
  prefsCache = prefs;
  writeJSON(PREFS_KEY, prefs);
}

// Keep several open tabs in sync: another tab changed settings or preferences (or cleared storage).
try {
  window.addEventListener('storage', (e) => {
    if (e.key === SETTINGS_KEY || e.key === null) {
      cache = load();
      notify();
    }
    if (e.key === PREFS_KEY || e.key === null) {
      const stored = readStoredObject(PREFS_KEY);
      if (stored.ok) prefsCache = stored.value;
    }
  });
} catch {
  /* not in a browser window */
}
