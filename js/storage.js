// Settings & progress persistence (localStorage).
// Every storage access is wrapped in try/catch: the app keeps working (in memory)
// when storage is unavailable, e.g. in a private window or with blocked site data.

const SETTINGS_KEY = 'choirTrainer.settings.v1';
const PROGRESS_PREFIX = 'choirTrainer.progress.';

// reverb: amount of "room echo", 0..1 (matches engine DEFAULT_REVERB).
// voiceParts: one or more voice-part keys (replaces the older single `voicePart`).
const DEFAULTS = Object.freeze({ tuning: 'just', voiceParts: Object.freeze(['any']), timbre: 'organ', volume: 0.7, reverb: 0.35 });

/** Clean list of voice-part keys (unique, non-empty strings); migrates the old `voicePart`. */
function cleanVoiceParts(list, legacy) {
  let parts = Array.isArray(list) ? list : typeof list === 'string' ? [list] : [];
  parts = [...new Set(parts.filter((p) => typeof p === 'string' && p))];
  if (!parts.length && typeof legacy === 'string' && legacy) parts = [legacy];
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

export function updateSettings(patch) {
  cache = sanitize({ ...getSettings(), ...(patch || {}) });
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

function loadPrefs() {
  if (!prefsCache) {
    const stored = readJSON(PREFS_KEY);
    prefsCache = stored && typeof stored === 'object' && !Array.isArray(stored) ? stored : {};
  }
  return prefsCache;
}

/** Read a UI preference; returns `fallback` when it was never set. */
export function getPref(name, fallback = null) {
  const prefs = loadPrefs();
  return Object.prototype.hasOwnProperty.call(prefs, name) ? prefs[name] : fallback;
}

/** Save a UI preference (JSON-serializable value). */
export function setPref(name, value) {
  const prefs = loadPrefs();
  prefs[name] = value;
  writeJSON(PREFS_KEY, prefs);
}

// Keep several open tabs in sync.
try {
  window.addEventListener('storage', (e) => {
    if (e.key === SETTINGS_KEY) {
      cache = load();
      notify();
    }
  });
} catch {
  /* not in a browser window */
}
