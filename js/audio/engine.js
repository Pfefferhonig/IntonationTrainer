/**
 * Web Audio sound engine for the choir intonation trainer.
 *
 * Plain ES module, no DOM access, no dependencies (besides ./reverb.js).
 *
 * Design goals (this tool trains differences of a few cents):
 *  - Exact frequencies: every oscillator's frequency is set directly to the
 *    requested value. No rounding, no detune, no random drift, no vibrato,
 *    no chorus, no detuned unison layers, no pitch modulation of any kind.
 *  - Click-free envelopes: every gain change is a ramp, including stop().
 *  - Loudness normalized across chord sizes, timbres and pitches.
 *  - Sample-accurate scheduling on the AudioContext clock.
 *
 * Everything added for realism is either a linear time-invariant filter
 * (formants, body resonances, room reverb), which cannot change any
 * frequency, or unpitched noise (onset "chiff", bow noise, breath).
 *
 * Signal graph:
 *
 *   per note:      Oscillator (or looped recording at exact playbackRate)
 *                             ---------------> envelope Gain --+
 *                  Noise -> bandpass --------> noise Gain -----+  (organ / strings / voice)
 *                                                              |
 *   per playback:  input Gain -> [timbre filters] -> output Gain (stop fade)
 *                                                       |            |
 *                                                       |       reverb send Gain -> Convolver A|B -> return Gain A|B
 *                                                       |       (two convolvers used in turn; send disconnected at 0)
 *                                                       v                                               |
 *   shared:        master Gain (volume) <-------------------------------------------------------------- +
 *                     -> DynamicsCompressor (peak limiter) -> destination
 *
 * Timbre filters are linear and time-invariant, so one filter chain per
 * playback is exactly equivalent to one chain per note (and much cheaper).
 */

import { createRoomImpulse, createNoiseBuffer } from './reverb.js';
import { SAMPLE_SETS } from './samples-manifest.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Seconds between "now" and the first scheduled sound (scheduling headroom). */
const LOOKAHEAD = 0.05;
/** The same on light quality (phones: slower main thread, bigger output buffers). */
const LOOKAHEAD_LIGHT = 0.12;

/** Auto quality: render slower than this % of real time (benchmark) -> light. */
const BENCH_LIGHT_PERCENT = 12; // this dev desktop: 3.8 % (1 s render incl. setup)

/** Fade-out time used by stop(), in seconds. */
const STOP_FADE = 0.04;

/** Extra time after a release ends before a source is stopped. */
const STOP_PAD = 0.02;

/** Shortest note we will schedule, in seconds. */
const MIN_DURATION = 0.01;

/**
 * Target RMS level (linear, before master volume) of one sounding note.
 * Chosen with headroom so a 3-note chord at full volume rarely reaches the
 * limiter threshold (the limiter should normally do nothing at all).
 */
const BASE_RMS = 0.16;

/**
 * Maximum master gain (at setMasterVolume(1)). With it the loudest chord
 * (4-note organ, full room echo) peaks at about -3.4 dBFS before the limiter,
 * below the limiter's -1 dBFS threshold: the limiter normally never acts.
 */
const MASTER_MAX_GAIN = 0.8;

/** Default master volume, matches the storage.js default setting. */
const DEFAULT_VOLUME = 0.7;

/** Default reverb amount (0..1). */
export const DEFAULT_REVERB = 0.35;

/**
 * Wet gain at reverb amount 1. The impulse response is energy-normalized, so
 * the default 0.35 gives a reverberant level about 15 dB below the direct
 * sound: a small, quiet room rather than a church.
 */
const REVERB_MAX_WET = 0.5;

/** White noise RMS (uniform in [-1, 1)). */
const NOISE_RMS = 1 / Math.sqrt(3);

// ---------------------------------------------------------------------------
// Public timbre table
// ---------------------------------------------------------------------------

/** Key of the timbre used when none (or an unknown one) is given. */
export const DEFAULT_TIMBRE = 'organ';

/**
 * Available timbres. { key, label, description } with descriptions written
 * for singers, not engineers.
 * @type {Readonly<Record<string, {key: string, label: string, description: string}>>}
 */
export const TIMBRES = Object.freeze({
  sine: Object.freeze({
    key: 'sine',
    label: 'Pure tone',
    description:
      'A plain, smooth tone with no overtones, like a tuning fork. Good for comparing ' +
      'two single notes, but chords are harder to judge with it.',
  }),
  organ: Object.freeze({
    key: 'organ',
    label: 'Organ',
    description:
      'A steady organ pipe tone with strong overtones. Best for chords: when a note is out of ' +
      'tune you hear the sound "wobble" (beating), and it goes calm when the chord is in tune.',
  }),
  voice: Object.freeze({
    key: 'voice',
    label: 'Voice ("oh")',
    description:
      'A soft, straight-tone sung "oh/aah" vowel that fades in like a singer, with a ' +
      'touch of breath and no vibrato, so the tuning stays easy to hear.',
  }),
  strings: Object.freeze({
    key: 'strings',
    label: 'Strings',
    description:
      'A warm, bowed-string sound that swells in gently. Played without vibrato so the ' +
      'tuning stays easy to hear.',
  }),
  clarinet: Object.freeze({
    key: 'clarinet',
    label: 'Clarinet (recorded)',
    description:
      'A real clarinet recording, held perfectly steady with no vibrato. A warm, slightly ' +
      'hollow woodwind sound, close to a sung "oo". Sounds most natural in the middle ' +
      'of the singing range.',
    sampled: true,
    // Where it sounds natural: the recordings cover D3..D5 (MIDI 50..74); we
    // allow 4 semitones of shift beyond each end. Outside this range it still
    // plays (shifted further), it just sounds less natural.
    range: Object.freeze({ lowMidi: 46, highMidi: 78 }),
    attribution: (SAMPLE_SETS.clarinet && SAMPLE_SETS.clarinet.attribution) || '',
  }),
});

// ---------------------------------------------------------------------------
// Internal timbre specifications
// ---------------------------------------------------------------------------

/**
 * Build a harmonic amplitude series a_1..a_count.
 * @param {number} count
 * @param {(k: number) => number} fn amplitude of harmonic k (1-based)
 * @returns {number[]}
 */
function series(count, fn) {
  const out = [];
  for (let k = 1; k <= count; k++) out.push(fn(k));
  return out;
}

/** Sawtooth phase convention (alternating signs) for bowed-string spectra. */
const sawSign = (k) => (k % 2 ? 1 : -1);

function dbToGain(db) {
  return Math.pow(10, db / 20);
}

/**
 * Per-timbre specification.
 *  harmonics: fixed amplitudes of harmonics 1..N (sine phase; sign allowed), or
 *  spectra:   register-dependent spectra [{ freq, harmonics }] (ascending freq);
 *             a note uses the log-frequency interpolation of its two neighbours.
 *  native:    use a built-in oscillator type instead of a PeriodicWave.
 *  attack / release: envelope ramp times in seconds.
 *  trim:      rough perceptual loudness correction on top of RMS normalization.
 *  filters:   fixed BiquadFilter chain (fixed formants -> stable spectrum).
 *  noise:     optional unpitched noise layer:
 *             { center(freq) -> Hz, Q, burstDb, attack, decay, sustainDb|null }
 *             levels in dB relative to the note's own RMS.
 */
const TIMBRE_SPECS = {
  sine: {
    native: 'sine',
    harmonics: [1],
    attack: 0.03,
    release: 0.1,
    // A pure tone of equal RMS sounds softer than a rich tone (its energy sits
    // where the ear is less sensitive), so give it a small boost.
    trim: 1.25,
    filters: [],
    noise: null, // stays perfectly pure
  },
  organ: {
    // Open principal (diapason) pipe. Bass pipes are rich in harmonics, treble
    // pipes get progressively closer to the fundamental. Partials 2..6 (which
    // collide and beat between mistuned chord notes) stay strong in the
    // singing range.
    spectra: [
      { freq: 110, harmonics: [1, 0.8, 0.62, 0.5, 0.4, 0.32, 0.25, 0.19, 0.14, 0.1, 0.075, 0.055] },
      { freq: 330, harmonics: [1, 0.72, 0.52, 0.38, 0.28, 0.2, 0.14, 0.1, 0.07, 0.05] },
      { freq: 880, harmonics: [1, 0.55, 0.34, 0.22, 0.14, 0.09, 0.06] },
    ],
    attack: 0.04,
    release: 0.12,
    trim: 1.0,
    filters: [],
    // Pipe "chiff": a brief puff of air noise as the pipe starts to speak.
    noise: {
      center: (f) => Math.min(5000, Math.max(700, 4 * f)),
      Q: 1.0,
      burstDb: -17,
      attack: 0.004,
      decay: 0.06,
      sustainDb: null,
    },
  },
  voice: {
    // Smooth glottal-like source (steeper roll-off than before = less buzz),
    // shaped by fixed vowel formants for a dark, blended choir "oh/aw".
    harmonics: series(24, (k) => 1 / Math.pow(k, 1.5)),
    attack: 0.15,
    release: 0.22,
    trim: 0.95,
    filters: [
      { type: 'lowpass', frequency: 2800, Q: 0.5 }, // remove fizz
      { type: 'peaking', frequency: 480, Q: 2.5, gain: 10 }, // F1
      { type: 'peaking', frequency: 850, Q: 3, gain: 7 }, // F2
      { type: 'peaking', frequency: 2500, Q: 3, gain: 3 }, // F3 (a little presence)
    ],
    // Breath: a soft onset and a very low steady breath during the note. It
    // passes through the vowel formants above, so it sounds like the vowel.
    noise: {
      center: () => 1800,
      Q: 0.5,
      burstDb: -24,
      attack: 0.03,
      decay: 0.2,
      sustainDb: -36,
    },
  },
  strings: {
    // Bowed string (sawtooth-like Helmholtz motion). Low register: weaker
    // fundamental and strong 2nd/3rd harmonics (cello-like); high register:
    // fewer, softer upper partials (violin E-string-like).
    spectra: [
      { freq: 130, harmonics: series(30, (k) => sawSign(k) * (k === 1 ? 0.65 : k === 2 ? 1.0 : 2.2 / Math.pow(k, 1.05))) },
      { freq: 330, harmonics: series(24, (k) => sawSign(k) / Math.pow(k, 0.8)) },
      { freq: 880, harmonics: series(12, (k) => sawSign(k) / Math.pow(k, 1.2)) },
    ],
    attack: 0.22,
    release: 0.3,
    trim: 0.95,
    filters: [
      { type: 'lowpass', frequency: 4000, Q: 0.5 },
      { type: 'peaking', frequency: 280, Q: 1.2, gain: 3 }, // body (air) resonance
      { type: 'peaking', frequency: 2600, Q: 1.4, gain: 2.5 }, // "bridge hill"
    ],
    // Bow noise: a short rosin scratch as the bow starts, then a faint hiss.
    noise: {
      center: () => 2200,
      Q: 0.7,
      burstDb: -22,
      attack: 0.04,
      decay: 0.22,
      sustainDb: -40,
    },
  },
  clarinet: {
    // Recorded samples (see samples-manifest.js). The recording keeps its own
    // attack, so the engine attack only prevents a click; no extra noise.
    sampled: 'clarinet',
    attack: 0.008,
    release: 0.15,
    trim: 1.0,
    filters: [],
    noise: null,
  },
};

/** Synth timbre used while a sampled timbre is loading or failed to load. */
const SAMPLE_FALLBACK_TIMBRE = 'organ';

// ---------------------------------------------------------------------------
// Module state
// ---------------------------------------------------------------------------

/** @type {AudioContext|null} */
let ctx = null;
/** @type {GainNode|null} */
let masterGain = null;
/** @type {DynamicsCompressorNode|null} */
let limiter = null;
let masterVolume = DEFAULT_VOLUME;

/**
 * Shared reverb (null if the browser could not create it). Two convolvers
 * used in turn ("ping-pong"), so cutting the tail (stopAll) never has to build
 * a new convolver on the main thread: the send just switches to the other,
 * idle one. The send is disconnected entirely while the amount is 0, so the
 * convolvers then cost nothing.
 * @type {{send: GainNode, conv: ConvolverNode[], ret: GainNode[], cur: number,
 *         connected: boolean, kind: string}|null}
 */
let reverb = null;
let reverbAmount = DEFAULT_REVERB;
let reverbOffTimer = null;

/** @type {AudioBuffer|null} */
let noiseBuffer = null;
let noiseOffset = 0;

/** Cached { harmonics, wave } per timbre/register key, per AudioContext
 *  (PeriodicWaves belong to the context that made them; offline renders get their own). */
const waveCaches = new WeakMap();
function getWaveCache() {
  let m = waveCaches.get(ctx);
  if (!m) {
    m = new Map();
    waveCaches.set(ctx, m);
  }
  return m;
}

/** Cached frequency grid for noise RMS estimation, per Nyquist. */
let noiseGrid = null;

/** Currently active playback handles. */
const activePlaybacks = new Set();

// ---------------------------------------------------------------------------
// Audio quality ('high' | 'light'; 'auto' picks light on phones/tablets and
// on devices that render slowly) and output buffer size (latencyHint)
// ---------------------------------------------------------------------------

/** @type {'auto'|'high'|'light'} */
let qualitySetting = 'auto';
/** Result of the render-speed benchmark (auto mode on non-mobile devices). */
let benchmark = null; // { renderPercent, light }
let benchmarkScheduled = false;
/** Used by the benchmark to measure the high-quality graph. */
let forcedQuality = null;
/** latencyHint the live context was created with. */
let ctxLatencyHint = null;
/** The live context must be recreated (new latencyHint) at the next safe moment. */
let recreatePending = false;
/** Number of users (e.g. the microphone) that need the live context to stay. */
let contextHolds = 0;

/**
 * Developer/test override from the page address, e.g. ?latency=0.2,
 * ?latency=playback, ?latency=interactive, ?latency=balanced
 * (lets the owner compare buffer sizes on a phone without a new upload).
 * @returns {number|string|null}
 */
function latencyFromUrl() {
  try {
    const q = globalThis.location && globalThis.location.search;
    if (!q) return null;
    const v = new URLSearchParams(q).get('latency');
    if (!v) return null;
    if (v === 'interactive' || v === 'balanced' || v === 'playback') return v;
    const n = Number(v);
    return Number.isFinite(n) && n > 0 && n <= 1 ? n : null;
  } catch (e) {
    return null;
  }
}

/** Phones and tablets (Android, iOS, iPadOS), from the user agent and touch screen. */
function isMobileDevice() {
  const nav = globalThis.navigator;
  if (!nav) return false;
  if (nav.userAgentData && nav.userAgentData.mobile) return true;
  const ua = nav.userAgent || '';
  if (/Android|iPhone|iPad|iPod|Mobile|Silk|Kindle/i.test(ua)) return true;
  // iPadOS reports itself as a Mac; it has a touch screen.
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return true;
  const scr = globalThis.screen;
  return nav.maxTouchPoints > 1 && !!scr && Math.min(scr.width, scr.height) < 820;
}

/** @returns {{quality: 'high'|'light', reason: string}} */
function resolveQuality() {
  if (forcedQuality) return { quality: forcedQuality, reason: 'forced' };
  if (qualitySetting === 'high' || qualitySetting === 'light') return { quality: qualitySetting, reason: 'setting' };
  if (isMobileDevice()) return { quality: 'light', reason: 'phone or tablet' };
  if (benchmark && benchmark.light) return { quality: 'light', reason: 'slow device (render benchmark)' };
  return { quality: 'high', reason: benchmark ? 'render benchmark' : 'desktop' };
}

function effectiveQuality() {
  return resolveQuality().quality;
}

/**
 * Output buffer size. 'interactive' (the smallest buffers, the browser
 * default for most apps) makes some Android phones stutter at random (seen on
 * a Samsung Galaxy S22 with a Chromium browser). This app does not need low
 * latency, so phones get 'playback' (large buffers) and desktops 'balanced'.
 * A ?latency=... URL parameter overrides it.
 */
function latencyHintFor(quality) {
  const fromUrl = latencyFromUrl();
  if (fromUrl != null) return fromUrl;
  return quality === 'light' ? 'playback' : 'balanced';
}

/** Scheduling headroom: more on light quality (slower main thread, bigger buffers). */
function lookahead() {
  return effectiveQuality() === 'light' ? LOOKAHEAD_LIGHT : LOOKAHEAD;
}

/** Reverb impulse for a quality: high = 1.4 s stereo room, light = 0.7 s mono. */
function reverbKindFor(quality) {
  return quality === 'light' ? 'light' : 'high';
}

/**
 * Choose the audio quality: 'high' (full room echo, breath/bow noise,
 * 'balanced' output buffers), 'light' (large output buffers, shorter mono
 * room echo, onset noise only, more scheduling headroom) or 'auto' (light on
 * phones/tablets and on devices that render slowly; the default).
 * Pitch accuracy is identical in all modes.
 * A change of buffer size takes effect at the next initAudio() (the next
 * button press) while nothing is playing and the microphone is closed.
 * @param {'auto'|'high'|'light'} q
 */
export function setAudioQuality(q) {
  if (q !== 'auto' && q !== 'high' && q !== 'light') return;
  qualitySetting = q;
  applyQuality();
}

/** @returns {'auto'|'high'|'light'} the setting (see getAudioQualityInfo for what is in effect). */
export function getAudioQuality() {
  return qualitySetting;
}

/**
 * What is in effect, with device details (for a "sound problems?" panel or
 * the console).
 * @returns {{setting: string, effective: 'high'|'light', reason: string,
 *   latencyHint: (string|number|null), sampleRate: number|null, baseLatency: number|null,
 *   outputLatency: number|null, state: string|null, renderPercent: number|null,
 *   pendingRestart: boolean, userAgent: string}}
 */
export function getAudioQualityInfo() {
  const { quality, reason } = resolveQuality();
  const live = ctx && !isOffline(ctx) ? ctx : null;
  const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 10000) / 10000 : null);
  return {
    setting: qualitySetting,
    effective: quality,
    reason,
    latencyHint: ctxLatencyHint,
    sampleRate: live ? live.sampleRate : null,
    baseLatency: live ? num(live.baseLatency) : null,
    outputLatency: live ? num(live.outputLatency) : null,
    state: live ? live.state : null,
    renderPercent: benchmark ? benchmark.renderPercent : null,
    pendingRestart: recreatePending,
    userAgent: (globalThis.navigator && navigator.userAgent) || '',
  };
}

/** Log the audio setup to the console (no UI needed: chrome://inspect / remote debugging). */
function logAudioInfo(when) {
  try {
    console.info(`[audio] ${when}:`, JSON.stringify(getAudioQualityInfo()));
  } catch (e) { /* ignore */ }
}

/** Apply a (possibly) changed effective quality to the live context. */
function applyQuality() {
  if (!ctx || isOffline(ctx)) return;
  const q = effectiveQuality();
  if (latencyHintFor(q) !== ctxLatencyHint) recreatePending = true;
  if (reverb && reverb.kind !== reverbKindFor(q)) {
    try {
      buildReverb();
    } catch (e) {
      console.warn('[audio] reverb rebuild failed:', e);
    }
  }
}

/**
 * Keep the live AudioContext (no recreation for a new buffer size) while
 * held. Used by the microphone (js/audio/pitch.js). Returns a release function.
 * @returns {() => void}
 */
export function holdAudioContext() {
  contextHolds += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    contextHolds = Math.max(0, contextHolds - 1);
  };
}

/**
 * Auto mode on non-mobile devices: render 1 s of a 4-note voice chord with
 * room echo offline (the high-quality graph) and time it. Rendering slower
 * than BENCH_LIGHT_PERCENT of real time switches to light quality.
 * Runs once, about 2 s after the first initAudio, only while nothing plays.
 */
function scheduleBenchmark() {
  if (benchmarkScheduled || benchmark || qualitySetting !== 'auto' || isMobileDevice()) return;
  if (!(globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext)) return;
  benchmarkScheduled = true;
  const attempt = (tries) => {
    if (activePlaybacks.size > 0 && tries > 0) {
      setTimeout(() => attempt(tries - 1), 2000);
      return;
    }
    const r = 196;
    forcedQuality = 'high';
    let job;
    try {
      job = renderOffline(1, () => playChord([r, r * 1.25, r * 1.5, r * 1.75], { duration: 0.9, timbre: 'voice' }));
    } catch (e) {
      job = Promise.reject(e);
    } finally {
      forcedQuality = null;
    }
    job.then(
      ({ renderMs }) => {
        const renderPercent = Math.round(renderMs) / 10; // ms per 1 s of audio -> %
        benchmark = { renderPercent, light: renderPercent > BENCH_LIGHT_PERCENT };
        applyQuality();
      },
      () => { benchmark = { renderPercent: null, light: false }; },
    );
  };
  setTimeout(() => attempt(5), 2000);
}

/**
 * Pre-create the PeriodicWaves of the synth timbres over the singing range
 * in small idle chunks after the context is created, so that pressing Play
 * never has to build them (no main-thread spike at play time).
 */
function prewarmWaves() {
  const live = ctx;
  const jobs = [];
  for (const key of Object.keys(TIMBRE_SPECS)) {
    const spec = TIMBRE_SPECS[key];
    if (spec.native || spec.sampled) continue;
    if (!spec.spectra) {
      jobs.push([key, spec, 220]);
      continue;
    }
    // 1/6-octave grid from ~55 Hz to ~1400 Hz (the same grid timbreAt uses)
    for (let step = 35; step <= 63; step++) jobs.push([key, spec, Math.pow(2, step / 6)]);
  }
  const tick = () => {
    if (ctx !== live || !jobs.length) return;
    for (let i = 0; i < 4 && jobs.length; i++) {
      const [key, spec, f] = jobs.shift();
      try { timbreAt(key, spec, f); } catch (e) { /* ignore */ }
    }
    setTimeout(tick, 16);
  };
  setTimeout(tick, 50);
}

// ---------------------------------------------------------------------------
// Context management
// ---------------------------------------------------------------------------

function clamp(v, lo, hi) {
  return Math.min(hi, Math.max(lo, v));
}

/** Perceptual volume curve: slider position 0..1 -> linear gain. */
function volumeToGain(v) {
  return MASTER_MAX_GAIN * v * v;
}

function reverbToGain(v) {
  return REVERB_MAX_WET * v;
}

/**
 * iOS/iPadOS Safari 16.4+: play through the speaker even when the ring/silent
 * switch is on ('playback'); the microphone code switches to 'play-and-record'
 * while the microphone is open. No-op in other browsers.
 * @param {'playback'|'play-and-record'} type
 */
export function setAudioSessionType(type) {
  try {
    const s = globalThis.navigator && navigator.audioSession;
    if (s && s.type !== type) s.type = type;
  } catch (e) { /* ignore */ }
}

/**
 * Create the shared AudioContext and master chain if needed (synchronous).
 * @returns {AudioContext}
 */
function ensureContext() {
  if (ctx) return ctx;
  const Ctor = globalThis.AudioContext || globalThis.webkitAudioContext;
  if (!Ctor) throw new Error('This browser does not support the Web Audio API.');
  // The sample rate is never forced: the device's own rate avoids resampling.
  const hint = latencyHintFor(effectiveQuality());
  try {
    ctx = new Ctor({ latencyHint: hint });
    ctxLatencyHint = hint;
  } catch (e) {
    ctx = new Ctor();
    ctxLatencyHint = 'default';
  }
  recreatePending = false;
  if (contextHolds === 0) setAudioSessionType('playback');
  const live = ctx;
  try {
    let wasRunning = false;
    let interrupted = false;
    live.addEventListener('statechange', () => {
      if (ctx !== live) return;
      const st = live.state;
      // System interruptions (phone call, iOS audio interruption, OS suspend)
      // after the sound had been running, and the recovery from them.
      if (st === 'running') {
        if (interrupted) notifyInterruption(st);
        wasRunning = true;
        interrupted = false;
      } else if ((st === 'suspended' || st === 'interrupted') && wasRunning && !interrupted) {
        interrupted = true;
        notifyInterruption(st);
      }
      logAudioInfo(`state ${st}`);
      // outputLatency is only known a moment after the output has started.
      if (live.state === 'running') setTimeout(() => { if (ctx === live) logAudioInfo('running 1 s'); }, 1000);
    });
  } catch (e) { /* ignore */ }
  buildGraph();
  logAudioInfo('context created');
  prewarmWaves();
  scheduleBenchmark();
  return ctx;
}

/** Build the shared master chain (limiter, volume, reverb, noise) on `ctx`. */
function buildGraph() {
  // Safety limiter only: its threshold (-1 dBFS) sits above the loudest chord
  // at full volume (about -3.4 dBFS before the limiter), so in normal use it
  // does nothing (gain riding would modulate the beating we want people to
  // hear) and adds almost no make-up gain.
  limiter = ctx.createDynamicsCompressor();
  limiter.threshold.value = -1;
  limiter.knee.value = 2;
  limiter.ratio.value = 12;
  limiter.attack.value = 0.003;
  limiter.release.value = 0.15;

  masterGain = ctx.createGain();
  masterGain.gain.value = volumeToGain(masterVolume);
  masterGain.connect(limiter);
  limiter.connect(ctx.destination);

  reverb = null;
  try {
    buildReverb();
  } catch (e) {
    console.warn('[audio] reverb unavailable:', e);
    reverb = null;
  }

  try {
    noiseBuffer = createNoiseBuffer(ctx);
  } catch (e) {
    noiseBuffer = null;
  }
}

/** (Re)build the reverb for the current quality (keeps the existing send node). */
function buildReverb() {
  const kind = reverbKindFor(effectiveQuality());
  const impulse = kind === 'light'
    ? createRoomImpulse(ctx, { duration: 0.7, rt60: 0.6, channels: 1 })
    : createRoomImpulse(ctx, { duration: 1.4, rt60: 1.2 });
  let send;
  if (reverb) {
    send = reverb.send;
    try { send.disconnect(); } catch (e) { /* ignore */ }
    for (const n of [...reverb.conv, ...reverb.ret]) {
      try { n.disconnect(); } catch (e) { /* ignore */ }
    }
  } else {
    send = ctx.createGain();
    send.gain.value = reverbToGain(reverbAmount);
  }
  const conv = [];
  const ret = [];
  for (let i = 0; i < 2; i++) {
    const c = ctx.createConvolver();
    c.normalize = false; // the impulse is already energy-normalized
    c.buffer = impulse;
    const r = ctx.createGain();
    r.gain.value = i === 0 ? 1 : 0;
    c.connect(r);
    r.connect(masterGain);
    conv.push(c);
    ret.push(r);
  }
  reverb = { send, conv, ret, cur: 0, connected: false, kind };
  if (reverbAmount > 0) connectReverbSend();
}

function connectReverbSend() {
  if (!reverb || reverb.connected) return;
  reverb.send.connect(reverb.conv[reverb.cur]);
  reverb.connected = true;
}

function disconnectReverbSend() {
  if (!reverb || !reverb.connected) return;
  try { reverb.send.disconnect(); } catch (e) { /* ignore */ }
  reverb.connected = false;
}

function isOffline(ac) {
  return typeof OfflineAudioContext !== 'undefined' && ac instanceof OfflineAudioContext;
}

/** Resume the context if it is suspended/interrupted. Never rejects. */
function resumeIfNeeded() {
  if (!ctx || ctx.state === 'running' || ctx.state === 'closed' || isOffline(ctx)) return Promise.resolve();
  try {
    const p = ctx.resume();
    return p && typeof p.then === 'function' ? p.catch(() => {}) : Promise.resolve();
  } catch (e) {
    return Promise.resolve();
  }
}

/** Close the live context so the next ensureContext() creates one with the new buffer size. */
function recreateContextIfPending() {
  if (!recreatePending || !ctx || isOffline(ctx) || activePlaybacks.size > 0 || contextHolds > 0) return;
  const old = ctx;
  ctx = null;
  masterGain = limiter = null;
  reverb = null;
  noiseBuffer = null;
  try {
    const p = old.close();
    if (p && typeof p.catch === 'function') p.catch(() => {});
  } catch (e) { /* ignore */ }
}

/**
 * Create (lazily) and resume the shared AudioContext.
 * Must be called from a user gesture (click) before the first sound in most
 * browsers; safe to call any number of times. Also recovers from iOS
 * interruptions (phone call, other app): call it from the next button press.
 * @returns {Promise<AudioContext>} the shared context (extra: the contract only requires a Promise)
 */
export async function initAudio() {
  recreateContextIfPending();
  ensureContext();
  await resumeIfNeeded();
  return ctx;
}

/**
 * The shared AudioContext, created lazily if it does not exist yet (it may
 * still be suspended until initAudio() is called from a user gesture).
 * Useful for later features such as microphone input or UI timing that
 * follows `handle.startTime`.
 * @returns {AudioContext}
 */
export function getAudioContext() {
  return ensureContext();
}

/**
 * Render engine output offline (for tests, level checks and the speed
 * benchmark): builds the same master chain (volume, reverb, limiter) in an
 * OfflineAudioContext, runs `build()` — which calls playNotes / playChord /
 * startSustain ... as usual — then renders. The live context is untouched.
 * `build` must schedule synchronously (live retuning is not rendered).
 * @param {number} seconds
 * @param {() => void} build
 * @param {{sampleRate?: number, limiter?: boolean}} [opts] limiter: false = measure the
 *   signal before the limiter (level checks)
 * @returns {Promise<{buffer: AudioBuffer, renderMs: number}>}
 */
export async function renderOffline(seconds, build, { sampleRate = 48000, limiter: useLimiter = true } = {}) {
  const OAC = globalThis.OfflineAudioContext || globalThis.webkitOfflineAudioContext;
  if (!OAC) throw new Error('OfflineAudioContext not supported');
  const oc = new OAC(2, Math.max(1, Math.ceil(seconds * sampleRate)), sampleRate);
  const saved = { ctx, masterGain, limiter, reverb, noiseBuffer };
  try {
    ctx = oc;
    buildGraph();
    if (!useLimiter) {
      masterGain.disconnect();
      masterGain.connect(oc.destination);
    }
    build();
  } finally {
    ({ ctx, masterGain, limiter, reverb, noiseBuffer } = saved);
  }
  const t0 = performance.now();
  const buffer = await oc.startRendering();
  return { buffer, renderMs: performance.now() - t0 };
}

/**
 * Set the master volume.
 * @param {number} v 0..1 (mapped through a perceptual curve, gain = 0.8 * v^2)
 */
export function setMasterVolume(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return;
  masterVolume = clamp(n, 0, 1);
  if (ctx && masterGain) {
    // Smooth change so dragging a slider never clicks.
    masterGain.gain.setTargetAtTime(volumeToGain(masterVolume), ctx.currentTime, 0.015);
  }
}

/**
 * Current master volume as last set (0..1).
 * @returns {number}
 */
export function getMasterVolume() {
  return masterVolume;
}

/**
 * Set the amount of room reverb (0 = completely dry, 1 = quite roomy).
 * The reverb is a fixed linear filter: it does not change pitch or beat
 * rates. Default DEFAULT_REVERB (0.35), a small quiet room. Can be called
 * before initAudio(); the value is remembered. At 0 the reverb is fully
 * disconnected (no processing at all).
 * @param {number} amount 0..1
 */
export function setReverb(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return;
  reverbAmount = clamp(n, 0, 1);
  if (!ctx || !reverb) return;
  clearTimeout(reverbOffTimer);
  reverb.send.gain.setTargetAtTime(reverbToGain(reverbAmount), ctx.currentTime, 0.03);
  if (reverbAmount > 0) {
    connectReverbSend();
  } else {
    // Disconnect once the send has faded out (the tail then rings out by itself).
    reverbOffTimer = setTimeout(() => {
      if (reverbAmount === 0) disconnectReverbSend();
    }, 250);
  }
}

/**
 * Current reverb amount as last set (0..1).
 * @returns {number}
 */
export function getReverb() {
  return reverbAmount;
}

/**
 * Silence the reverb tail quickly (used by stopAll so leaving a screen or
 * pressing stop feels immediate): fade the current convolver's return out and
 * switch the send to the other (idle) convolver. No new nodes, no timers.
 */
function flushReverb() {
  if (!ctx || !reverb || !reverb.connected) return;
  const now = ctx.currentTime;
  const oldRet = reverb.ret[reverb.cur].gain;
  try {
    oldRet.cancelScheduledValues(now);
    oldRet.setValueAtTime(oldRet.value, now);
    oldRet.linearRampToValueAtTime(0, now + STOP_FADE);
    reverb.send.disconnect();
    reverb.cur = 1 - reverb.cur;
    reverb.send.connect(reverb.conv[reverb.cur]);
    const newRet = reverb.ret[reverb.cur].gain;
    newRet.cancelScheduledValues(now);
    newRet.setValueAtTime(newRet.value, now);
    newRet.linearRampToValueAtTime(1, now + 0.02);
  } catch (e) { /* ignore */ }
}

// ---------------------------------------------------------------------------
// Recorded samples
// ---------------------------------------------------------------------------

/**
 * Loading state per sampled timbre:
 * { state: 'idle'|'loading'|'ready'|'failed', promise, zones, buffers }
 */
const sampleState = new Map();

/** Decode audio data with both the promise and the old callback API. */
function decodeAudio(ab) {
  return new Promise((resolve, reject) => {
    try {
      const p = ctx.decodeAudioData(ab, resolve, reject);
      if (p && typeof p.then === 'function') p.then(resolve, reject);
    } catch (e) {
      reject(e);
    }
  });
}

/**
 * Start (or retry) loading a timbre's recordings. Synth timbres (and unknown
 * keys) need no loading and resolve to true immediately.
 * Never rejects: resolves to true when ready, false if loading failed (the
 * engine then keeps using the synthesized fallback, with a console warning).
 * Creates the AudioContext if needed (allowed without a user gesture; it
 * just stays suspended until initAudio()).
 * @param {string} key timbre key
 * @returns {Promise<boolean>}
 */
export function preloadTimbre(key) {
  const spec = TIMBRE_SPECS[key];
  if (!spec || !spec.sampled) return Promise.resolve(true);
  let entry = sampleState.get(key);
  if (entry && (entry.state === 'ready' || entry.state === 'loading')) return entry.promise;

  const set = SAMPLE_SETS[spec.sampled];
  entry = { state: 'loading', promise: null, zones: [], buffers: [] };
  sampleState.set(key, entry);
  if (!set || !Array.isArray(set.zones) || !set.zones.length) {
    console.warn(`[audio] no sample data for timbre "${key}"; using the synthesized organ instead.`);
    entry.state = 'failed';
    entry.promise = Promise.resolve(false);
    return entry.promise;
  }

  try {
    ensureContext(); // decoding needs the context
  } catch (e) {
    console.warn(`[audio] cannot load "${key}":`, e);
    entry.state = 'failed';
    entry.promise = Promise.resolve(false);
    return entry.promise;
  }

  const zones = set.zones.filter(
    (z) => z && z.file && z.f0 > 0 && z.loopEnd > z.loopStart && z.rms > 0,
  );
  entry.promise = Promise.all(
    zones.map((z) => {
      // Files are relative to the project root; this module is js/audio/.
      const url = new URL('../../' + z.file, import.meta.url).href;
      return fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status} for ${z.file}`);
          return r.arrayBuffer();
        })
        .then(decodeAudio);
    }),
  )
    .then((buffers) => {
      if (!buffers.length) throw new Error('no usable zones');
      entry.zones = zones;
      entry.buffers = buffers;
      entry.state = 'ready';
      return true;
    })
    .catch((err) => {
      console.warn(`[audio] could not load recordings for "${key}"; using the synthesized organ instead.`, err);
      entry.state = 'failed';
      return false;
    });
  return entry.promise;
}

/**
 * Whether a timbre can play right now with its own sound. Always true for
 * synthesized timbres (and unknown keys, which fall back to the default);
 * for recorded timbres, true once preloadTimbre() has finished successfully.
 * @param {string} key
 * @returns {boolean}
 */
export function isTimbreReady(key) {
  const spec = TIMBRE_SPECS[key];
  if (!spec || !spec.sampled) return true;
  const entry = sampleState.get(key);
  return !!entry && entry.state === 'ready';
}

/** Index of the zone whose f0 is nearest to `freq` (by frequency ratio). */
function nearestZone(zones, freq) {
  let best = 0;
  let bestDist = Infinity;
  for (let i = 0; i < zones.length; i++) {
    const d = Math.abs(Math.log(freq / zones[i].f0));
    if (d < bestDist) {
      bestDist = d;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Timbre helpers
// ---------------------------------------------------------------------------

/**
 * Harmonic amplitudes (and a cached, unnormalized PeriodicWave) for a timbre
 * at a given frequency. Register-dependent timbres are interpolated on a
 * 1/6-octave grid so the number of distinct waves stays small. The grid only
 * selects the *spectrum*; the oscillator frequency is always exact.
 * @param {string} timbre
 * @param {object} spec
 * @param {number} freq
 * @returns {{harmonics: number[], wave: PeriodicWave|null}}
 */
function timbreAt(timbre, spec, freq) {
  let key = timbre;
  let step = 0;
  if (spec.spectra) {
    step = Math.round(Math.log2(freq) * 6);
    key = timbre + '@' + step;
  }
  const waveCache = getWaveCache();
  let entry = waveCache.get(key);
  if (entry) return entry;

  let harmonics = spec.harmonics;
  if (spec.spectra) {
    const sp = spec.spectra;
    const qf = Math.pow(2, step / 6);
    let a = sp[0];
    let b = sp[0];
    let t = 0;
    if (qf >= sp[sp.length - 1].freq) {
      a = b = sp[sp.length - 1];
    } else if (qf > sp[0].freq) {
      for (let i = 0; i < sp.length - 1; i++) {
        if (qf >= sp[i].freq && qf <= sp[i + 1].freq) {
          a = sp[i];
          b = sp[i + 1];
          t = Math.log2(qf / a.freq) / Math.log2(b.freq / a.freq);
          break;
        }
      }
    }
    const n = Math.max(a.harmonics.length, b.harmonics.length);
    harmonics = [];
    for (let k = 0; k < n; k++) {
      harmonics.push((1 - t) * (a.harmonics[k] || 0) + t * (b.harmonics[k] || 0));
    }
  }

  let wave = null;
  if (!spec.native) {
    const n = harmonics.length + 1;
    const real = new Float32Array(n); // cosine terms (all zero)
    const imag = new Float32Array(n); // sine terms
    for (let k = 1; k < n; k++) imag[k] = harmonics[k - 1];
    // Unnormalized, so amplitudes are exactly `harmonics` (needed for our own
    // RMS normalization).
    wave = ctx.createPeriodicWave(real, imag, { disableNormalization: true });
  }
  entry = { harmonics, wave };
  waveCache.set(key, entry);
  return entry;
}

/**
 * RMS of one note with these harmonic amplitudes at `freq`, after the
 * playback's filter chain, assuming unit oscillator gain. Only harmonics
 * below Nyquist count (the browser band-limits the rest away).
 * @param {number[]} harmonics
 * @param {BiquadFilterNode[]} filters
 * @param {number} freq
 * @param {number} nyquist
 * @returns {number}
 */
function filteredRms(harmonics, filters, freq, nyquist) {
  const amps = [];
  const fr = [];
  for (let k = 1; k <= harmonics.length; k++) {
    const fk = k * freq;
    if (fk >= nyquist) break;
    fr.push(fk);
    amps.push(harmonics[k - 1]);
  }
  const n = fr.length;
  if (!n) return 0;
  const gainAt = new Float32Array(n).fill(1);
  if (filters.length) {
    const freqs = new Float32Array(fr);
    const mag = new Float32Array(n);
    const phase = new Float32Array(n);
    for (const f of filters) {
      f.getFrequencyResponse(freqs, mag, phase);
      for (let i = 0; i < n; i++) {
        if (Number.isFinite(mag[i])) gainAt[i] *= mag[i];
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const a = amps[i] * gainAt[i];
    sum += a * a;
  }
  return Math.sqrt(sum / 2);
}

/**
 * RMS of the white-noise buffer after a filter chain (power averaged over a
 * linear frequency grid from 0 to Nyquist).
 * @param {BiquadFilterNode[]} filters
 * @param {number} nyquist
 * @returns {number}
 */
function noiseRms(filters, nyquist) {
  const N = 256;
  if (!noiseGrid || noiseGrid.nyquist !== nyquist) {
    const freqs = new Float32Array(N);
    for (let i = 0; i < N; i++) freqs[i] = ((i + 0.5) * nyquist) / N;
    noiseGrid = { nyquist, freqs, mag: new Float32Array(N), phase: new Float32Array(N) };
  }
  const { freqs, mag, phase } = noiseGrid;
  const pow = new Float32Array(N).fill(1);
  for (const f of filters) {
    f.getFrequencyResponse(freqs, mag, phase);
    for (let i = 0; i < N; i++) {
      if (Number.isFinite(mag[i])) pow[i] *= mag[i] * mag[i];
    }
  }
  let sum = 0;
  for (let i = 0; i < N; i++) sum += pow[i];
  return NOISE_RMS * Math.sqrt(sum / N);
}

/**
 * Largest number of notes sounding at the same moment (attack..release start).
 * @param {{start: number, duration: number}[]} notes
 * @returns {number} at least 1
 */
function maxOverlap(notes) {
  const events = [];
  for (const n of notes) {
    events.push([n.start, 1]);
    // Tiny epsilon so back-to-back notes (gap = 0) do not count as overlapping
    // because of floating-point rounding.
    events.push([n.start + n.duration - 1e-6, -1]);
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]); // ends before starts at equal times
  let count = 0;
  let max = 0;
  for (const e of events) {
    count += e[1];
    if (count > max) max = count;
  }
  return Math.max(1, max);
}

/**
 * Add the timbre's unpitched noise layer (onset transient, optional steady
 * breath/bow hiss) to one note. Levels are relative to the note's own RMS
 * (`level`), so they follow the same loudness normalization.
 * @returns {{src: AudioBufferSourceNode, filt: BiquadFilterNode, env: GainNode}|null}
 */
function addNoiseLayer(ac, nz, timbreFilters, input, freq, level, start, releaseStart, releaseEnd, nyquist) {
  const prep = prepareNoise(ac, nz, timbreFilters, freq, level, nyquist);
  return prep ? scheduleNoise(ac, prep, input, start, releaseStart, releaseEnd) : null;
}

/** Noise layer, part 1 (the costly part, done before reading the clock). */
function prepareNoise(ac, nz, timbreFilters, freq, level, nyquist) {
  if (!nz || !noiseBuffer || !(level > 0)) return null;
  const filt = ac.createBiquadFilter();
  filt.type = 'bandpass';
  filt.frequency.value = clamp(nz.center(freq), 100, nyquist * 0.9);
  filt.Q.value = nz.Q;
  const rms = noiseRms([filt, ...timbreFilters], nyquist);
  if (!(rms > 0)) return null;
  const burst = (level * dbToGain(nz.burstDb)) / rms;
  // Light mode: onset only (the steady breath/bow hiss would run for the whole note).
  const sustainDb = effectiveQuality() === 'light' ? null : nz.sustainDb;
  const sus = sustainDb == null ? 0 : (level * dbToGain(sustainDb)) / rms;
  return { nz, filt, burst, sus };
}

/** Noise layer, part 2: envelope and start/stop at the scheduled times. */
function scheduleNoise(ac, prep, input, start, releaseStart, releaseEnd) {
  const { nz, filt, burst, sus } = prep;
  const src = ac.createBufferSource();
  src.buffer = noiseBuffer;
  src.loop = true;
  const env = ac.createGain();
  env.gain.value = 0;

  const g = env.gain;
  const tA = Math.min(start + nz.attack, releaseStart);
  const tD = Math.max(tA, Math.min(tA + nz.decay, releaseStart));
  g.setValueAtTime(0, start);
  g.linearRampToValueAtTime(burst, tA);
  if (tD > tA) g.linearRampToValueAtTime(sus, tD);
  let end;
  if (sus > 0) {
    if (releaseStart > tD) g.setValueAtTime(sus, releaseStart);
    g.linearRampToValueAtTime(0, releaseEnd);
    end = releaseEnd;
  } else if (tD > tA) {
    end = tD; // already ramped to zero
  } else {
    end = tA + 0.01;
    g.linearRampToValueAtTime(0, end);
  }

  src.connect(filt);
  filt.connect(env);
  env.connect(input);
  // Different offset per note so the noise of chord notes is uncorrelated.
  noiseOffset = (noiseOffset + 0.6180339887) % 1;
  src.start(start, noiseOffset * noiseBuffer.duration);
  src.stop(end + STOP_PAD);
  return { src, filt, env };
}

// ---------------------------------------------------------------------------
// Core scheduler
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PlaybackHandle
 * @property {() => void} stop  Fade out quickly (~40 ms) and stop. Safe to call repeatedly.
 * @property {Promise<void>} done Resolves when the last note's release has ended, or right after stop().
 * @property {number} startTime  (extra) AudioContext time corresponding to note offset 0.
 * @property {number} endTime    (extra) AudioContext time when the last release ends.
 * @property {string} timbre     (extra) timbre key actually used.
 */

/** A handle for a playback that has nothing to play. */
function emptyHandle(timbre) {
  const t = ctx ? ctx.currentTime : 0;
  return { stop() {}, done: Promise.resolve(), startTime: t, endTime: t, timbre };
}

/**
 * Core scheduler: schedules all notes up front on the AudioContext clock.
 *
 * @param {{freq: number, start: number, duration: number, gain?: number}[]} notes
 *   freq in Hz (used exactly); start = offset in seconds from the beginning of
 *   this playback; duration = seconds from onset until the release begins (the
 *   attack is included, the release tail is added after); gain 0..1 (default 1).
 * @param {{timbre?: string}} [opts] timbre key from TIMBRES (default 'organ').
 *   A recorded timbre that is not loaded yet starts loading and this call
 *   plays the synthesized organ instead (handle.timbre says which was used).
 * @returns {PlaybackHandle}
 */
export function playNotes(notes, opts = {}) {
  return schedulePlayback(notes, opts).handle;
}

/**
 * Internal scheduler behind playNotes and startSustain.
 * @returns {{handle: PlaybackHandle, voices: Array<{index: number, freq: number,
 *   osc: OscillatorNode|AudioBufferSourceNode, zone: object|null}>, nyquist: number}}
 *   voices[].index = position of the note in the `notes` argument.
 */
function schedulePlayback(notes, opts = {}) {
  const ac = ensureContext();
  resumeIfNeeded(); // works when triggered from a click even without initAudio()

  let timbre = opts && TIMBRE_SPECS[opts.timbre] ? opts.timbre : DEFAULT_TIMBRE;
  let samples = null;
  if (TIMBRE_SPECS[timbre].sampled) {
    if (isTimbreReady(timbre)) {
      samples = sampleState.get(timbre);
    } else {
      // Not loaded yet: start loading (unless it already failed) and play the
      // synthesized fallback for this call. Never block, never throw.
      const entry = sampleState.get(timbre);
      if (!entry || entry.state === 'idle') preloadTimbre(timbre);
      timbre = SAMPLE_FALLBACK_TIMBRE;
    }
  }
  const spec = TIMBRE_SPECS[timbre];
  const nyquist = ac.sampleRate / 2;

  const list = [];
  const input0 = Array.isArray(notes) ? notes : [];
  for (let index = 0; index < input0.length; index++) {
    const n = input0[index];
    if (!n) continue;
    const freq = Number(n.freq);
    if (!Number.isFinite(freq) || freq <= 0 || freq >= nyquist) {
      console.warn('[audio] skipping note with invalid frequency:', n.freq);
      continue;
    }
    const start = Number(n.start);
    const duration = Number(n.duration);
    const gain = n.gain == null ? 1 : Number(n.gain);
    list.push({
      index,
      freq,
      start: Number.isFinite(start) && start > 0 ? start : 0,
      duration: Number.isFinite(duration) ? Math.max(MIN_DURATION, duration) : 1,
      gain: Number.isFinite(gain) ? clamp(gain, 0, 1) : 1,
    });
  }
  if (!list.length) return { handle: emptyHandle(timbre), voices: [], nyquist, isStopped: () => true };

  // --- per-playback chain -------------------------------------------------
  const input = ac.createGain();
  const output = ac.createGain();
  const filters = spec.filters.map((f) => {
    const b = ac.createBiquadFilter();
    b.type = f.type;
    b.frequency.value = f.frequency;
    b.Q.value = f.Q;
    if (f.gain != null) b.gain.value = f.gain;
    return b;
  });
  let node = input;
  for (const f of filters) {
    node.connect(f);
    node = f;
  }
  node.connect(output);
  output.connect(masterGain);
  if (reverb) output.connect(reverb.send); // post-fader send: stop() fades it too

  // --- loudness -----------------------------------------------------------
  // Equal-power scaling: n uncorrelated notes at 1/sqrt(n) each have the same
  // total power as one note. Constant for the whole playback, so notes do not
  // jump in level when others enter or leave.
  const polyScale = 1 / Math.sqrt(maxOverlap(list));

  // --- phase 1: build the sound sources and compute levels -----------------
  // (all the costly work happens BEFORE the start time is read from the
  // clock, so a slow device can never schedule an attack in the past)
  const prepared = [];
  for (const n of list) {
    const level = BASE_RMS * spec.trim * n.gain * polyScale; // target RMS of this note
    let osc; // the note's sound source: OscillatorNode or AudioBufferSourceNode
    let peak;
    let zone = null;
    if (samples) {
      // Recorded: nearest zone by ratio, exact pitch via playbackRate, looped
      // sustain. The zone's f0 is the exact pitch of its loop.
      const zi = nearestZone(samples.zones, n.freq);
      zone = samples.zones[zi];
      osc = ac.createBufferSource();
      osc.buffer = samples.buffers[zi];
      osc.loop = true;
      osc.loopStart = zone.loopStart;
      osc.loopEnd = zone.loopEnd;
      osc.playbackRate.value = n.freq / zone.f0; // exact, no detune, no modulation
      peak = level / zone.rms;
    } else {
      const { harmonics, wave } = timbreAt(timbre, spec, n.freq);
      const rms = filteredRms(harmonics, filters, n.freq, nyquist);
      peak = rms > 0 ? level / rms : 0;
      osc = ac.createOscillator();
      if (spec.native) osc.type = spec.native;
      else osc.setPeriodicWave(wave);
      osc.frequency.value = n.freq; // exact, no detune, no modulation
    }
    const noisePrep = prepareNoise(ac, spec.noise, filters, n.freq, peak > 0 ? level : 0, nyquist);
    prepared.push({ n, osc, peak, level, zone, noisePrep });
  }

  // --- phase 2: schedule ----------------------------------------------------
  const t0 = ac.currentTime + lookahead();
  const voices = [];
  let endTime = t0;

  for (const { n, osc, peak, level, zone, noisePrep } of prepared) {
    const env = ac.createGain();
    env.gain.value = 0;

    const start = t0 + n.start;
    const attack = Math.min(spec.attack, n.duration);
    const releaseStart = start + n.duration;
    const releaseEnd = releaseStart + spec.release;

    const g = env.gain;
    g.setValueAtTime(0, start);
    g.linearRampToValueAtTime(peak, start + attack);
    if (releaseStart > start + attack) g.setValueAtTime(peak, releaseStart);
    g.linearRampToValueAtTime(0, releaseEnd);

    // Optional per-note mute gain (startSustain): sits after the envelope and
    // the noise layer, so a muted note keeps running silently, ready to fade in.
    let mute = null;
    if (opts.mutable) {
      mute = ac.createGain();
      mute.gain.value = opts.muted && opts.muted.has(n.index) ? 0 : 1;
      mute.connect(input);
    }
    const dest = mute || input;

    osc.connect(env);
    env.connect(dest);
    osc.start(start);
    osc.stop(releaseEnd + STOP_PAD);

    const noise = noisePrep ? scheduleNoise(ac, noisePrep, dest, start, releaseStart, releaseEnd) : null;

    voices.push({
      osc, env, mute, noises: noise ? [noise] : [], zone,
      index: n.index, freq: n.freq, level: peak > 0 ? level : 0, releaseStart,
    });
    if (releaseEnd + STOP_PAD > endTime) endTime = releaseEnd + STOP_PAD;
  }

  // --- lifecycle ----------------------------------------------------------
  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  let finished = false;
  let stopped = false;
  let cleaned = false;
  let remaining = voices.length;
  let watchdog = null;

  function finish() {
    if (finished) return;
    finished = true;
    resolveDone();
  }

  function cleanup() {
    if (cleaned) return;
    cleaned = true;
    clearTimeout(watchdog);
    for (const v of voices) {
      v.osc.onended = null;
      try { v.osc.disconnect(); } catch (e) { /* already disconnected */ }
      try { v.env.disconnect(); } catch (e) { /* already disconnected */ }
      if (v.mute) {
        try { v.mute.disconnect(); } catch (e) { /* already disconnected */ }
      }
      for (const nz of v.noises) {
        try { nz.src.stop(); } catch (e) { /* already stopped */ }
        try { nz.src.disconnect(); } catch (e) { /* already disconnected */ }
        try { nz.filt.disconnect(); } catch (e) { /* already disconnected */ }
        try { nz.env.disconnect(); } catch (e) { /* already disconnected */ }
      }
    }
    for (const f of filters) {
      try { f.disconnect(); } catch (e) { /* already disconnected */ }
    }
    try { input.disconnect(); } catch (e) { /* already disconnected */ }
    try { output.disconnect(); } catch (e) { /* already disconnected */ }
    activePlaybacks.delete(handle);
  }

  // Oscillators always outlast their noise layers, so only they are counted.
  function onVoiceEnded() {
    remaining -= 1;
    if (remaining <= 0) {
      cleanup();
      finish();
    }
  }
  for (const v of voices) v.osc.onended = onVoiceEnded;

  // Safety net in case 'ended' events are not delivered: checks the audio
  // clock (not wall time), so a suspended context never resolves early.
  function watch() {
    if (cleaned) return;
    const left = endTime - ac.currentTime;
    if ((left <= 0 && ac.state === 'running') || ac.state === 'closed') {
      cleanup();
      finish();
      return;
    }
    watchdog = setTimeout(watch, Math.max(250, (left + 0.3) * 1000));
  }
  watchdog = setTimeout(watch, Math.max(250, (endTime - ac.currentTime + 0.3) * 1000));

  const handle = {
    stop() {
      if (stopped || cleaned) {
        finish();
        return;
      }
      stopped = true;
      const now = ac.currentTime;
      const og = output.gain;
      try {
        og.cancelScheduledValues(now);
        og.setValueAtTime(og.value, now);
        og.linearRampToValueAtTime(0, now + STOP_FADE);
      } catch (e) { /* ignore */ }
      const stopAt = now + STOP_FADE + 0.01;
      for (const v of voices) {
        // Re-scheduling stop() is allowed by the spec; older engines may throw,
        // in which case the output fade above still silences the note.
        try { v.osc.stop(stopAt); } catch (e) { /* ignore */ }
        for (const nz of v.noises) {
          try { nz.src.stop(stopAt); } catch (e) { /* ignore */ }
        }
      }
      finish();
      clearTimeout(watchdog);
      activePlaybacks.delete(handle); // stopped: no longer counts as playing
      setTimeout(cleanup, (STOP_FADE + 0.15) * 1000);
    },
    done,
    startTime: t0,
    endTime,
    timbre,
  };
  if (!isOffline(ac)) activePlaybacks.add(handle); // offline renders never block the live context
  return {
    handle, voices, nyquist, spec, filters, input,
    isStopped: () => stopped || cleaned,
    wasStopped: () => stopped,
  };
}

// ---------------------------------------------------------------------------
// Convenience wrappers
// ---------------------------------------------------------------------------

/**
 * Play a single tone.
 * @param {number} freq Hz (exact)
 * @param {{duration?: number, timbre?: string}} [opts]
 * @returns {PlaybackHandle}
 */
export function playTone(freq, { duration = 1.5, timbre } = {}) {
  return playNotes([{ freq, start: 0, duration }], { timbre });
}

/**
 * Play a chord. With arpeggio > 0 the notes enter one by one from lowest to
 * highest, `arpeggio` seconds apart, and all sustain to a common end, so the
 * last `duration` seconds are the full chord.
 * @param {number[]} freqs Hz (exact), any order
 * @param {{duration?: number, arpeggio?: number, timbre?: string}} [opts]
 *   duration: length of the full-chord part (after the last onset), seconds.
 * @returns {PlaybackHandle}
 */
export function playChord(freqs, { duration = 2.5, arpeggio = 0, timbre } = {}) {
  const sorted = (Array.isArray(freqs) ? freqs : []).slice().sort((a, b) => a - b);
  const arp = Math.max(0, Number(arpeggio) || 0);
  const count = sorted.length;
  duration = Number(duration) > 0 ? Number(duration) : 2.5;
  const notes = sorted.map((freq, i) => ({
    freq,
    start: i * arp,
    duration: (count - 1 - i) * arp + duration,
  }));
  return playNotes(notes, { timbre });
}

/**
 * Play notes one after another.
 * @param {number[]} freqs Hz (exact), in playing order
 * @param {{noteDuration?: number, gap?: number, timbre?: string}} [opts]
 *   gap: silence between the end of one note and the start of the next, seconds
 *   (release tails may softly overlap the gap).
 * @returns {PlaybackHandle}
 */
export function playSequence(freqs, { noteDuration = 1.0, gap = 0.25, timbre } = {}) {
  noteDuration = Number(noteDuration) > 0 ? Number(noteDuration) : 1.0;
  const step = noteDuration + Math.max(0, Number(gap) || 0);
  const notes = (Array.isArray(freqs) ? freqs : []).map((freq, i) => ({
    freq,
    start: i * step,
    duration: noteDuration,
  }));
  return playNotes(notes, { timbre });
}

/** Minimum glide time for setFreq, in seconds (avoids stepped jumps). */
const MIN_GLIDE = 0.005;

/** Onset noise level when a muted sustain note is switched on, relative to a normal onset (dB). */
const UNMUTE_ONSET_DB = -6;

/**
 * Glide an AudioParam to `value`, starting smoothly from wherever it is right
 * now (even mid-glide). Safe to call at a high rate (slider drags).
 *
 * Method: setTargetAtTime (time constant ramp/3, ~95% there after `ramp`)
 * continues seamlessly from the current curve, and a final setValueAtTime
 * after 12 time constants (residual < 0.001 % of the step, i.e. far below
 * 0.01 cent) makes the value exact. The next call only cancels events in the
 * future (that pending snap), never the curve that is currently running.
 *
 * Avoided on purpose (both tested in Chrome): cancelAndHoldAtTime chained
 * with exponential ramps collapsed the value to 0 after ~10 rapid calls, and
 * cancelling an unfinished ramp makes a k-rate param (playbackRate) fall back
 * to the previous anchor for a moment (an audible pitch dip).
 * @param {AudioParam} param
 * @param {number} value
 * @param {number} ramp seconds
 */
function glideParam(param, value, ramp) {
  const now = ctx.currentTime;
  const tau = ramp / 3;
  param.cancelScheduledValues(now); // removes only a pending snap / not-yet-started glide
  param.setTargetAtTime(value, now, tau);
  param.setValueAtTime(value, now + 12 * tau);
}

/**
 * @typedef {Object} SustainHandle
 * @property {(index: number, freq: number, rampSec?: number) => boolean} setFreq
 *   Glide note `index` (position in `freqs`) to `freq` Hz over `rampSec`
 *   (default 0.03 s). Returns false if ignored (bad index/frequency, stopped).
 * @property {(index: number) => number|undefined} getFreq (extra) last requested frequency of a note.
 * @property {(index: number, muted: boolean, rampSec?: number) => boolean} setMuted
 *   Fade note `index` out (muted = true) or in (false) over `rampSec` (default 0.08 s, ~95 %).
 *   Switching on adds a subtle onset noise (synth timbres). Returns false if ignored.
 * @property {(index: number) => boolean|undefined} isMuted (extra)
 * @property {(freqs: Array<number|null>, rampSec?: number) => boolean} setFreqs
 *   Retune several notes at once (position i -> note i; null = leave as is), same glide as setFreq.
 * @property {() => boolean} isPlaying  false once stopped or ended
 * @property {(cb: (e: {reason: 'stopped'|'ended'}) => void) => () => void} onEnd
 *   cb after the notes have finished: 'stopped' (stop()/stopAll()/stopEverything()) or 'ended'
 *   (maxDuration reached and released). Returns an unsubscribe function.
 * @property {() => void} stop  Fade out quickly (~40 ms) and stop.
 * @property {Promise<void>} done Resolves when the notes have ended, or right after stop().
 * @property {string} timbre    Timbre key actually used ('organ' while a recorded timbre is not loaded).
 * @property {number} startTime AudioContext time at which the notes start.
 * @property {number} endTime   (extra) AudioContext time when maxDuration's release would end.
 */

/**
 * Start notes that keep sounding until stop() (or maxDuration seconds, after
 * which they fade out with the normal release), and that can be retuned live
 * with setFreq. Same timbres, loudness rules (1/sqrt(n) for n notes), onset
 * noise, reverb and limiter as playNotes.
 *
 * Retuning changes only the oscillator frequency (all partials of a note come
 * from one oscillator, so they move together) or, for recorded timbres, the
 * playbackRate of the running loop (same recording, never re-triggered). The
 * timbre's formant/body filters and each note's level stay fixed.
 * After a glide has finished the frequency is exact.
 *
 * Muting: `muted` lists indices that start silent. A muted note is still
 * running (and can be retuned with setFreq), so setMuted(index, false) fades
 * it in at exactly the right pitch. Loudness normalization counts ALL notes,
 * muted ones included, so levels never jump when a note is switched on.
 *
 * @param {number[]} freqs Hz (exact)
 * @param {{timbre?: string, maxDuration?: number, muted?: number[]}} [opts]
 * @returns {SustainHandle}
 */
export function startSustain(freqs, { timbre, maxDuration = 120, muted = [] } = {}) {
  const list = Array.isArray(freqs) ? freqs : [];
  const dur = Number(maxDuration) > 0 ? Number(maxDuration) : 120;
  const mutedSet = new Set((Array.isArray(muted) ? muted : []).map(Number));
  const pb = schedulePlayback(
    list.map((freq) => ({ freq, start: 0, duration: dur })),
    { timbre, mutable: true, muted: mutedSet },
  );
  const byIndex = new Map();
  for (const v of pb.voices) {
    v.on = !mutedSet.has(v.index);
    byIndex.set(v.index, v);
  }

  const handle = {
    setMuted(index, mute, rampSec = 0.08) {
      const v = byIndex.get(index);
      if (!v || !v.mute || pb.isStopped()) return false;
      const on = !mute;
      if (v.on === on) return true;
      v.on = on;
      const ramp = Math.max(MIN_GLIDE, Number(rampSec) || 0);
      try {
        glideParam(v.mute.gain, on ? 1 : 0, ramp);
      } catch (e) {
        return false;
      }
      // A subtle onset (the timbre's chiff/bow/breath noise, 6 dB softer than
      // at a normal note start) so switching on sounds like the note begins.
      // Recorded timbres have no noise layer: their running loop just fades in.
      const nz = pb.spec.noise;
      const now = ctx.currentTime;
      if (on && nz && v.level > 0 && now < v.releaseStart) {
        const extra = addNoiseLayer(
          ctx, { ...nz, burstDb: nz.burstDb + UNMUTE_ONSET_DB, sustainDb: null },
          pb.filters, pb.input, v.freq, v.level, now, v.releaseStart, v.releaseStart, pb.nyquist,
        );
        if (extra) {
          v.noises.push(extra);
          extra.src.onended = () => {
            const i = v.noises.indexOf(extra);
            if (i >= 0) v.noises.splice(i, 1);
            try { extra.src.disconnect(); extra.filt.disconnect(); extra.env.disconnect(); } catch (e) { /* ignore */ }
          };
        }
      }
      return true;
    },
    isMuted(index) {
      const v = byIndex.get(index);
      return v ? !v.on : undefined;
    },
    setFreq(index, freq, rampSec = 0.03) {
      const v = byIndex.get(index);
      const f = Number(freq);
      if (!v || pb.isStopped() || !Number.isFinite(f) || f <= 0 || f >= pb.nyquist) return false;
      const ramp = Math.max(MIN_GLIDE, Number(rampSec) || 0);
      try {
        if (v.zone) {
          // Keep the same zone and loop running, whatever the distance.
          glideParam(v.osc.playbackRate, f / v.zone.f0, ramp);
        } else {
          glideParam(v.osc.frequency, f, ramp);
        }
      } catch (e) {
        return false;
      }
      v.freq = f;
      return true;
    },
    getFreq(index) {
      const v = byIndex.get(index);
      return v ? v.freq : undefined;
    },
    setFreqs(freqs, rampSec = 0.03) {
      if (!Array.isArray(freqs)) return false;
      let ok = true;
      freqs.forEach((f, i) => {
        if (f != null && !handle.setFreq(i, f, rampSec)) ok = false;
      });
      return ok;
    },
    isPlaying() {
      return !pb.isStopped();
    },
    onEnd(cb) {
      let cancelled = false;
      pb.handle.done.then(() => {
        if (cancelled) return;
        try {
          cb({ reason: pb.wasStopped() ? 'stopped' : 'ended' });
        } catch (e) {
          console.error('[audio] onEnd callback threw:', e);
        }
      });
      return () => { cancelled = true; };
    },
    stop: pb.handle.stop,
    done: pb.handle.done,
    timbre: pb.handle.timbre,
    startTime: pb.handle.startTime,
    endTime: pb.handle.endTime,
  };
  return handle;
}

/** Most the recording may be boosted by playRecordingWith (+30 dB). */
const RECORDING_MAX_GAIN = 31.6;

/**
 * Loudness of a recording: RMS over its active (non-silent) parts, i.e. the
 * 20 ms blocks within 20 dB of the loudest block, plus its peak.
 * @param {Float32Array} data
 * @param {number} sr
 */
function activeLevel(data, sr) {
  const block = Math.max(1, Math.round(sr * 0.02));
  const powers = [];
  let peak = 0;
  for (let i = 0; i < data.length; i += block) {
    let s = 0;
    const end = Math.min(data.length, i + block);
    for (let j = i; j < end; j++) {
      const v = data[j];
      s += v * v;
      const a = v < 0 ? -v : v;
      if (a > peak) peak = a;
    }
    powers.push(s / (end - i));
  }
  let maxP = 0;
  for (const p of powers) if (p > maxP) maxP = p;
  let sum = 0;
  let n = 0;
  for (const p of powers) {
    if (p >= maxP * 0.01) {
      sum += p;
      n++;
    }
  }
  return { rms: n ? Math.sqrt(sum / n) : 0, peak };
}

/**
 * Play the user's recording together with sustained notes (e.g. the in-tune
 * chord) for the recording's length: "hear yourself with the chord".
 * The recording is level-matched to the notes (its active parts get the same
 * RMS as the whole chord, times `gain`), stays dry (no reverb, so it sounds
 * like you), and goes through the same master volume and limiter; the notes
 * get the usual timbre, loudness rules and reverb. Both start sample-aligned.
 *
 * @param {AudioBuffer} buffer the take (e.g. from startMic().stopRecording())
 * @param {number[]} freqs Hz (exact) of the notes to sound with it (may be empty)
 * @param {{timbre?: string, gain?: number}} [opts] gain: extra factor for the recording (1 = balanced)
 * @returns {{stop: () => void, done: Promise<void>, startTime: number, endTime: number, timbre: string}}
 */
export function playRecordingWith(buffer, freqs, { timbre, gain = 1 } = {}) {
  const ac = ensureContext();
  resumeIfNeeded();
  if (!buffer || !(buffer.length > 0) || typeof buffer.getChannelData !== 'function') {
    return emptyHandle(timbre || DEFAULT_TIMBRE);
  }
  const dur = buffer.duration;
  const list = Array.isArray(freqs) ? freqs : [];
  const pb = schedulePlayback(
    list.map((freq) => ({ freq, start: 0, duration: Math.max(MIN_DURATION, dur - 0.05) })),
    { timbre },
  );
  const startTime = list.length ? pb.handle.startTime : ac.currentTime + lookahead();

  // Level-match the recording to the chord (whose total RMS is about
  // BASE_RMS * trim thanks to the 1/sqrt(n) rule).
  const { rms, peak } = activeLevel(buffer.getChannelData(0), buffer.sampleRate);
  const spec = TIMBRE_SPECS[pb.handle.timbre] || TIMBRE_SPECS[DEFAULT_TIMBRE];
  const g = Number(gain);
  let recGain = rms > 0 ? (BASE_RMS * spec.trim * (Number.isFinite(g) && g >= 0 ? g : 1)) / rms : 1;
  recGain = Math.min(recGain, RECORDING_MAX_GAIN);
  if (peak > 0) recGain = Math.min(recGain, 0.9 / peak); // keep peaks below clipping

  const src = ac.createBufferSource();
  src.buffer = buffer;
  const fade = ac.createGain(); // short fades at both ends (no clicks), stop fade
  fade.gain.value = 0;
  const level = ac.createGain();
  level.gain.value = recGain;
  src.connect(fade);
  fade.connect(level);
  level.connect(masterGain); // dry: straight to master volume + limiter, no reverb send

  const edge = Math.min(0.01, dur / 4);
  fade.gain.setValueAtTime(0, startTime);
  fade.gain.linearRampToValueAtTime(1, startTime + edge);
  fade.gain.setValueAtTime(1, startTime + dur - edge);
  fade.gain.linearRampToValueAtTime(0, startTime + dur);
  src.start(startTime);
  src.stop(startTime + dur + STOP_PAD);

  let resolveDone;
  const done = new Promise((r) => {
    resolveDone = r;
  });
  let recEnded = false;
  let notesEnded = !list.length;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    resolveDone();
  };
  const cleanupRec = () => {
    try { src.disconnect(); fade.disconnect(); level.disconnect(); } catch (e) { /* ignore */ }
    activePlaybacks.delete(recHandle);
  };
  src.onended = () => {
    recEnded = true;
    cleanupRec();
    if (notesEnded) finish();
  };
  pb.handle.done.then(() => {
    notesEnded = true;
    if (recEnded) finish();
  });

  let stopped = false;
  const recHandle = {
    stop() {
      if (stopped) return;
      stopped = true;
      const now = ac.currentTime;
      try {
        fade.gain.cancelScheduledValues(now);
        fade.gain.setValueAtTime(fade.gain.value, now);
        fade.gain.linearRampToValueAtTime(0, now + STOP_FADE);
        src.stop(now + STOP_FADE + 0.01);
      } catch (e) { /* ignore */ }
      activePlaybacks.delete(recHandle);
    },
  };
  if (!isOffline(ac)) activePlaybacks.add(recHandle);

  return {
    stop() {
      recHandle.stop();
      pb.handle.stop();
      finish();
    },
    done,
    startTime,
    endTime: startTime + dur,
    timbre: pb.handle.timbre,
  };
}

/**
 * Stop (with a short fade) every playback that is currently active, and cut
 * the room reverb tail quickly so stopping feels immediate.
 */
export function stopAll() {
  for (const h of Array.from(activePlaybacks)) h.stop();
  flushReverb();
}

/**
 * Stop every sound now: all playbacks, held/sustained notes and recording
 * playback (short 40 ms fades), and cut the room-echo tail. Safe to call at
 * any time, also before any sound or when nothing plays. For Esc, opening an
 * options panel and the page being hidden.
 */
export function stopEverything() {
  try {
    stopAll();
  } catch (e) {
    console.error('[audio] stopEverything:', e);
  }
}

const interruptionListeners = new Set();

function notifyInterruption(state) {
  for (const cb of Array.from(interruptionListeners)) {
    try {
      cb({ state });
    } catch (e) {
      console.error('[audio] onAudioInterrupted callback threw:', e);
    }
  }
}

/**
 * Be told when the system interrupts the sound (phone call, iOS audio
 * interruption, the OS suspending audio): cb({ state: 'interrupted' |
 * 'suspended' }), and when it runs again: cb({ state: 'running' }).
 * Only fires after the sound had been running. Recovery needs a user gesture
 * on iOS: call initAudio() from the next button press (e.g. "Continue").
 * @param {(e: {state: string}) => void} cb
 * @returns {() => void} unsubscribe
 */
export function onAudioInterrupted(cb) {
  if (typeof cb !== 'function') return () => {};
  interruptionListeners.add(cb);
  return () => interruptionListeners.delete(cb);
}
