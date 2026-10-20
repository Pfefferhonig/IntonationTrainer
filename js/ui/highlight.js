// Light up UI elements in time with notes that are sounding.

import * as engine from '../audio/engine.js';

/**
 * Follow a playback handle and call apply(activeKeys: Set) whenever the set of
 * sounding notes changes. Timing comes from the AudioContext clock, starting at
 * handle.startTime (falls back to "now").
 * plan: [{ key, start, end }] in seconds from the playback start.
 * Returns a function that stops tracking (and clears the highlight).
 */
export function trackHighlights(handle, plan, apply) {
  const ctx = typeof engine.getAudioContext === 'function' ? engine.getAudioContext() : null;
  let stopped = false;
  let raf = 0;
  let last = null;

  function set(keys) {
    const sig = [...keys].sort().join('|');
    if (sig === last) return;
    last = sig;
    try { apply(keys); } catch (err) { console.error(err); }
  }

  function finish() {
    if (stopped) return;
    stopped = true;
    if (raf) clearTimeout(raf);
    set(new Set());
  }

  if (!ctx || !handle || !plan.length) {
    finish();
    return finish;
  }

  const t0 = Number.isFinite(handle.startTime) ? handle.startTime : ctx.currentTime;
  // A short timer (~30 per second) rather than animation frames: frames can pause in
  // embedded or background views, timers keep the highlight in step with the audio clock.
  const schedule = (f) => setTimeout(f, 33);
  const endAll = Math.max(...plan.map((p) => p.end));

  function frame() {
    if (stopped) return;
    const t = ctx.currentTime - t0;
    set(new Set(plan.filter((p) => t >= p.start && t < p.end).map((p) => p.key)));
    if (t > endAll + 0.05) { finish(); return; }
    raf = schedule(frame);
  }

  if (handle.done && typeof handle.done.then === 'function') handle.done.then(finish, finish);
  raf = schedule(frame);
  return finish;
}

/** Highlight plan for playChord(freqs low->high, { duration, arpeggio }). keys = indexes. */
export function chordPlan(count, duration, arpeggio = 0) {
  const end = (count - 1) * arpeggio + duration;
  return Array.from({ length: count }, (_, i) => ({ key: i, start: i * arpeggio, end }));
}
