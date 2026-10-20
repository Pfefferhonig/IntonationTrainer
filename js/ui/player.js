// Playback helper shared by screens: starts audio from a click, plays one or more
// sounds in a row, and lets a new click (or Stop) cancel whatever is playing.

import * as engine from '../audio/engine.js';
import { getSettings } from '../storage.js';

const { initAudio, setMasterVolume, stopAll } = engine;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** True when `key` is a recorded (sampled) timbre that is not loaded yet. */
export function needsLoading(key) {
  const t = engine.TIMBRES && engine.TIMBRES[key];
  if (!t || !t.sampled || typeof engine.preloadTimbre !== 'function') return false;
  if (typeof engine.isTimbreReady === 'function') {
    try { return !engine.isTimbreReady(key); } catch { return true; }
  }
  return true;
}

/**
 * Load a recorded timbre if needed (no-op for synthesized ones or an older engine).
 * Resolves true when ready, false when loading failed.
 */
export async function ensureTimbre(key) {
  if (!needsLoading(key)) return true;
  try {
    await engine.preloadTimbre(key);
    return true;
  } catch (err) {
    console.error(`Loading sound "${key}" failed:`, err);
    return false;
  }
}

/**
 * @param {{ onChange?: (state: { playing: boolean, loading?: boolean, label: string, tag: any, error?: string }) => void,
 *           pauseMs?: number }} [opts]
 * @returns {{ play(steps: Array<{label?: string, tag?: any, start: () => {stop(): void, done: Promise<void>}}>,
 *                  opts?: { timbre?: string }): Promise<boolean>,
 *             stop(): void, destroy(): void, readonly playing: boolean }}
 *   play() must be called directly from a click/keyboard handler (initAudio needs the gesture).
 *   It resolves true when every step finished, false when it was interrupted.
 */
export function createPlayer({ onChange = () => {}, pauseMs = 500 } = {}) {
  let generation = 0;
  let current = null;
  let playing = false;
  let destroyed = false;

  function emit(state) {
    if (destroyed) return;
    try { onChange(state); } catch (err) { console.error(err); }
  }

  function halt(silent = false) {
    generation += 1;
    if (current) {
      try { current.stop(); } catch { /* already stopped */ }
      current = null;
    }
    try { stopAll(); } catch (err) { console.error(err); }
    if (playing || !silent) {
      playing = false;
      emit({ playing: false, label: '', tag: null });
    }
  }

  // opts.timbre: the sound the steps use (default: the saved setting); a recorded
  // sound is loaded first, with a { loading: true } state emitted meanwhile.
  async function play(steps, { timbre } = {}) {
    const ready = initAudio(); // keep this first: it must run inside the user gesture
    halt(true);
    const mine = generation;
    try {
      await ready;
      const s = getSettings();
      setMasterVolume(s.volume);
      if (typeof engine.setReverb === 'function') engine.setReverb(s.reverb);
    } catch (err) {
      console.error(err);
      emit({ playing: false, label: '', tag: null, error: 'Sound could not be started in this browser.' });
      return false;
    }
    const key = timbre || getSettings().timbre;
    if (needsLoading(key)) {
      emit({ playing: false, loading: true, label: 'Loading sound…', tag: null });
      const ok = await ensureTimbre(key);
      if (mine !== generation || destroyed) return false;
      if (!ok) {
        emit({ playing: false, label: '', tag: null, error: 'This sound could not be loaded. Try another sound in Settings.' });
        return false;
      }
    }
    for (let i = 0; i < steps.length; i += 1) {
      if (mine !== generation || destroyed) return false;
      if (i > 0) {
        await sleep(pauseMs);
        if (mine !== generation || destroyed) return false;
      }
      playing = true;
      emit({ playing: true, label: steps[i].label || '', tag: steps[i].tag ?? null });
      try {
        current = steps[i].start();
        await current.done;
      } catch (err) {
        console.error(err);
      }
    }
    if (mine !== generation || destroyed) return false;
    current = null;
    playing = false;
    emit({ playing: false, label: '', tag: null });
    return true;
  }

  return {
    play,
    stop: () => halt(false),
    destroy() {
      halt(true);
      destroyed = true;
    },
    get playing() {
      return playing;
    },
  };
}
