/**
 * Microphone input and pitch detection for the singing chapters. NO DOM.
 *
 * Pitch detection: McLeod Pitch Method (MPM) — normalized square difference
 * function (NSDF) computed with an FFT autocorrelation, "first key maximum
 * above 0.9 x the highest" peak picking (avoids octave errors on voices with a
 * weak fundamental), parabolic interpolation, then a multi-period refinement
 * (the same peak measured at m periods) for sub-cent precision on high notes.
 *
 * Microphone: getUserMedia with echoCancellation / noiseSuppression /
 * autoGainControl OFF (they distort pitch), analysed in ~20 ms hops over a
 * ~43 ms window (>= 2.8 periods of 65 Hz). Samples are collected by an
 * AudioWorklet (js/audio/mic-worklet.js) and analysed on the main thread
 * (~0.2 ms per frame); fallback: ScriptProcessorNode. The microphone is
 * NEVER routed to the speakers (the tap's silent output goes through a zero
 * gain only to keep it processing). Uses the engine's AudioContext, so
 * recordings and frame times share the playback clock.
 */

import { getAudioContext } from './engine.js';

// ---------------------------------------------------------------------------
// FFT (iterative radix-2, complex, in place) with cached tables
// ---------------------------------------------------------------------------

const fftCache = new Map();

function fftTables(n) {
  let t = fftCache.get(n);
  if (t) return t;
  const rev = new Uint32Array(n);
  const bits = Math.log2(n);
  for (let i = 0; i < n; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r = (r << 1) | ((i >>> b) & 1);
    rev[i] = r;
  }
  const cos = new Float64Array(n / 2);
  const sin = new Float64Array(n / 2);
  for (let i = 0; i < n / 2; i++) {
    cos[i] = Math.cos((2 * Math.PI * i) / n);
    sin[i] = Math.sin((2 * Math.PI * i) / n);
  }
  t = { rev, cos, sin, re: new Float64Array(n), im: new Float64Array(n) };
  fftCache.set(n, t);
  return t;
}

/** In-place FFT of (re, im); inverse = true computes the unscaled inverse. */
function fft(re, im, tables, inverse) {
  const n = re.length;
  const { rev, cos, sin } = tables;
  for (let i = 0; i < n; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  const sgn = inverse ? 1 : -1;
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const step = n / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cos[k * step];
        const wi = sgn * sin[k * step];
        const a = start + k;
        const b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr;
        im[b] = im[a] - xi;
        re[a] += xr;
        im[a] += xi;
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Pitch detection
// ---------------------------------------------------------------------------

/** Key-maximum threshold of MPM (fraction of the highest key maximum). */
const MPM_K = 0.9;
/** Default clarity below which a frame counts as unvoiced. */
const DEFAULT_MIN_CLARITY = 0.8;
/** RMS below which a frame counts as silence. */
const SILENCE_RMS = 1e-4;

const nsdfCache = new Map();

/**
 * Detect the pitch of a mono frame.
 *
 * Accuracy (synthetic tests, tests/pitch.test.js): well under 1 cent on steady
 * tones 65..1100 Hz, including voice-like tones with a weak fundamental;
 * returns freq null for silence, noise and unvoiced frames.
 * The frame should hold at least ~2.5 periods of minFreq (2048 samples at
 * 44.1/48 kHz covers 65 Hz).
 *
 * @param {Float32Array|number[]} samples
 * @param {number} sampleRate
 * @param {{minFreq?: number, maxFreq?: number, minClarity?: number}} [opts]
 * @returns {{freq: number|null, clarity: number}}
 */
export function detectPitch(samples, sampleRate, { minFreq = 65, maxFreq = 1100, minClarity = DEFAULT_MIN_CLARITY } = {}) {
  const N = samples ? samples.length : 0;
  if (!(N >= 64) || !(sampleRate > 0)) return { freq: null, clarity: 0 };

  // Remove DC; check for silence.
  let mean = 0;
  for (let i = 0; i < N; i++) mean += samples[i];
  mean /= N;
  let energy = 0;
  for (let i = 0; i < N; i++) {
    const v = samples[i] - mean;
    energy += v * v;
  }
  if (Math.sqrt(energy / N) < SILENCE_RMS) return { freq: null, clarity: 0 };

  // Lags: up to the longest period of interest, and up to N/2 for refinement.
  const maxLag = Math.min(Math.floor(N / 2), Math.ceil(sampleRate / minFreq) + 2);
  const Lmax = Math.max(maxLag, Math.floor(N / 2));
  const minLag = Math.max(2, Math.floor((sampleRate / maxFreq) * 0.95));
  if (maxLag <= minLag + 2) return { freq: null, clarity: 0 };

  // Autocorrelation r(tau) via FFT (zero-padded to avoid wrap-around).
  let M = 1;
  while (M < N + Lmax) M <<= 1;
  const tables = fftTables(M);
  const { re, im } = tables;
  re.fill(0);
  im.fill(0);
  for (let i = 0; i < N; i++) re[i] = samples[i] - mean;
  fft(re, im, tables, false);
  for (let i = 0; i < M; i++) {
    re[i] = re[i] * re[i] + im[i] * im[i];
    im[i] = 0;
  }
  fft(re, im, tables, true); // r(tau) * M in re[tau]

  // NSDF n(tau) = 2 r(tau) / m(tau), m(tau) = sum x_j^2 + sum x_{j+tau}^2 (via prefix sums).
  let cache = nsdfCache.get(N);
  if (!cache || cache.nsdf.length < Lmax + 1) {
    cache = { prefix: new Float64Array(N + 1), nsdf: new Float64Array(Lmax + 1) };
    nsdfCache.set(N, cache);
  }
  const { prefix, nsdf } = cache;
  prefix[0] = 0;
  for (let i = 0; i < N; i++) {
    const v = samples[i] - mean;
    prefix[i + 1] = prefix[i] + v * v;
  }
  for (let tau = 0; tau <= Lmax; tau++) {
    const m = prefix[N - tau] + (prefix[N] - prefix[tau]);
    nsdf[tau] = m > 0 ? (2 * (re[tau] / M)) / m : 0;
  }

  // MPM peak picking: key maxima = highest point of each positive lobe after
  // the first negative-going zero crossing.
  const keyTau = [];
  const keyVal = [];
  let tau = 1;
  while (tau < maxLag && nsdf[tau] > 0) tau++; // skip the lobe around tau = 0
  let inLobe = false;
  let bestT = -1;
  let bestV = -Infinity;
  for (; tau < maxLag; tau++) {
    const v = nsdf[tau];
    if (v > 0) {
      if (!inLobe) {
        inLobe = true;
        bestT = -1;
        bestV = -Infinity;
      }
      if (v > bestV && nsdf[tau] >= nsdf[tau - 1] && nsdf[tau] >= nsdf[tau + 1]) {
        bestV = v;
        bestT = tau;
      }
    } else if (inLobe) {
      inLobe = false;
      if (bestT >= minLag) {
        keyTau.push(bestT);
        keyVal.push(bestV);
      }
    }
  }
  if (inLobe && bestT >= minLag && bestT < maxLag - 1) {
    keyTau.push(bestT);
    keyVal.push(bestV);
  }
  if (!keyTau.length) return { freq: null, clarity: 0 };

  let highest = 0;
  for (const v of keyVal) if (v > highest) highest = v;
  let pick = 0;
  while (keyVal[pick] < MPM_K * highest) pick++;
  const t0 = keyTau[pick];

  const interp = (t) => {
    const a = nsdf[t - 1];
    const b = nsdf[t];
    const c = nsdf[t + 1];
    const den = a - 2 * b + c;
    const d = den !== 0 ? (0.5 * (a - c)) / den : 0;
    return { tau: t + d, val: b - 0.25 * (a - c) * d };
  };
  const p0 = interp(t0);
  const clarity = Math.max(0, Math.min(1, p0.val));
  if (clarity < minClarity) return { freq: null, clarity };

  // Multi-period refinement: the same self-similarity peak at m periods,
  // interpolated, divided by m (interpolation error shrinks by m).
  let period = p0.tau;
  const mMax = Math.floor((Lmax - 2) / p0.tau);
  for (let m = mMax; m >= 2; m--) {
    const c = Math.round(m * p0.tau);
    let bi = -1;
    let bv = -Infinity;
    for (let i = Math.max(1, c - 2); i <= Math.min(Lmax - 1, c + 2); i++) {
      if (nsdf[i] > bv) {
        bv = nsdf[i];
        bi = i;
      }
    }
    if (bi <= 1 || bi >= Lmax - 1) continue;
    if (!(nsdf[bi] >= nsdf[bi - 1] && nsdf[bi] >= nsdf[bi + 1])) continue;
    if (bv < 0.9 * clarity) continue;
    const pm = interp(bi);
    const est = pm.tau / m;
    if (Math.abs(est - p0.tau) < 0.02 * p0.tau) {
      period = est;
      break;
    }
  }

  const freq = sampleRate / period;
  if (!(freq >= minFreq * 0.97 && freq <= maxFreq * 1.03)) return { freq: null, clarity };
  return { freq, clarity };
}

// ---------------------------------------------------------------------------
// Microphone
// ---------------------------------------------------------------------------

/** Longest recording kept by startRecording (seconds). */
const MAX_RECORD_SECONDS = 120;

/**
 * Whether this browser can use the microphone here (getUserMedia present,
 * secure context such as https or localhost, Web Audio available).
 * @returns {boolean}
 */
export function micSupported() {
  return !!(
    globalThis.navigator &&
    navigator.mediaDevices &&
    typeof navigator.mediaDevices.getUserMedia === 'function' &&
    (globalThis.AudioContext || globalThis.webkitAudioContext)
  );
}

function micError(code, message, cause) {
  const e = { code, message };
  if (cause) e.cause = cause;
  return e;
}

/** Map getUserMedia / Web Audio errors to { code, message } in plain English. */
function mapMicError(err) {
  const name = (err && err.name) || '';
  if (name === 'NotAllowedError' || name === 'PermissionDeniedError' || name === 'SecurityError') {
    return micError(
      'denied',
      'The microphone is blocked. Allow microphone access for this page (usually via the icon in ' +
        "the address bar), then try again.",
      err,
    );
  }
  if (name === 'NotFoundError' || name === 'DevicesNotFoundError' || name === 'OverconstrainedError') {
    return micError('no-device', 'No microphone was found. Plug one in (or check your headset), then try again.', err);
  }
  if (name === 'NotReadableError' || name === 'TrackStartError' || name === 'AbortError') {
    return micError(
      'no-device',
      'The microphone could not be started. It may be in use by another app - close that app and try again.',
      err,
    );
  }
  return micError(
    'unsupported',
    'This browser could not use the microphone here. Try an up-to-date Chrome, Edge, Firefox or Safari.',
    err,
  );
}

/** Cached audioWorklet.addModule promise for the engine's context. */
let workletReady = null;

function loadWorklet(ac) {
  if (!ac.audioWorklet || typeof AudioWorkletNode === 'undefined') return Promise.resolve(false);
  if (!workletReady) {
    const url = new URL('./mic-worklet.js', import.meta.url).href;
    workletReady = ac.audioWorklet.addModule(url).then(
      () => true,
      (e) => {
        console.warn('[pitch] AudioWorklet unavailable, using ScriptProcessor fallback:', e);
        workletReady = Promise.resolve(false);
        return false;
      },
    );
  }
  return workletReady;
}

function nextPow2(n) {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}

/**
 * @typedef {Object} MicFrame
 * @property {number} time        seconds since the start, or since the latest setActive(true)
 *                                (centre of the analysis window; always >= 0)
 * @property {number|null} freq   detected pitch in Hz, or null (silence / unvoiced / unclear)
 * @property {number} clarity     0..1 (how periodic the sound is)
 * @property {number} rms         level of the newest ~20 ms (0..1)
 * @property {number} contextTime (extra) AudioContext time of the window centre (same clock as playback)
 */

/**
 * @typedef {Object} MicHandle
 * @property {() => void} stop                 stop analysing and release the microphone
 * @property {() => number} level              current rms 0..1 (newest ~20 ms; 0 while inactive)
 * @property {(on: boolean) => void} setActive hold-to-sing: analyse only while active. Inactive = no
 *                                             analysis, no onFrame, the worklet only keeps a 0.3 s pre-roll.
 *                                             setActive(true) restarts frame times at 0 and loses nothing
 *                                             after the call (pre-roll); instant, no new permission/stream.
 * @property {() => boolean} isActive          (extra)
 * @property {() => void} startRecording       start (or restart) the take at this moment (AudioContext clock)
 * @property {() => AudioBuffer|null} stopRecording  the take: mono, at the context sample rate
 *                                             (the newest <= 20 ms that has not arrived yet is not included)
 * @property {number|null} recordingStartTime  (extra) AudioContext time of the take's first sample
 * @property {'worklet'|'script'} mode         (extra) how samples are collected
 * @property {number} windowSize               (extra) analysis window in samples
 * @property {number} sampleRate               (extra)
 */

/**
 * Analyse any audio source node with the same pipeline startMic uses
 * (exported for tests and future features, e.g. an oscillator as a fake
 * microphone). The source is never connected to the speakers.
 * @param {AudioNode} sourceNode node in the engine's AudioContext
 * @param {{onFrame?: (f: MicFrame) => void, frameMs?: number, minFreq?: number, maxFreq?: number,
 *          active?: boolean}} [opts]
 * @returns {Promise<MicHandle>}
 */
export async function startAnalysis(sourceNode, { onFrame, frameMs = 20, minFreq = 65, maxFreq = 1100, active: activeOpt = true } = {}) {
  const ac = sourceNode.context;
  const sr = ac.sampleRate;
  const hop = Math.max(128, Math.round((sr * frameMs) / 1000));
  const W = nextPow2(Math.round(sr * 0.042)); // 2048 at 44.1/48 kHz, 4096 at 96 kHz
  const ring = new Float32Array(W);
  let filled = 0;
  let sinceFrame = 0;
  let lastRms = 0;
  let stopped = false;
  let active = !!activeOpt;
  let origin = ac.currentTime; // time origin of frame times (start, or the latest setActive(true))

  // Recent chunks (~0.35 s): lets startRecording() include samples that
  // arrived just before it was called, and the ScriptProcessor fallback
  // replay its pre-roll on activation.
  const history = [];
  let historyLen = 0;
  const HISTORY_MAX = Math.round(sr * 0.35);

  let recording = null; // { startTime, nextTime, chunks: Float32Array[], length }

  function recordChunk(chunk, endTime) {
    const rec = recording;
    if (!rec || rec.length >= MAX_RECORD_SECONDS * sr) return;
    const n = chunk.length;
    const chunkStart = endTime - n / sr;
    const from = Math.max(rec.startTime, rec.nextTime);
    const i0 = Math.max(0, Math.round((from - chunkStart) * sr));
    if (i0 >= n) return;
    const part = i0 > 0 ? chunk.slice(i0) : chunk;
    rec.chunks.push(part);
    rec.length += part.length;
    rec.nextTime = endTime;
  }

  const handle = {
    mode: 'worklet',
    windowSize: W,
    sampleRate: sr,
    recordingStartTime: null,
    stop,
    level: () => (active ? lastRms : 0),
    isActive: () => active,
    setActive,
    startRecording() {
      // Starts at this moment on the AudioContext clock (not at the next chunk),
      // so nothing after the button press is lost.
      recording = { startTime: ac.currentTime, nextTime: -Infinity, chunks: [], length: 0 };
      handle.recordingStartTime = recording.startTime;
      for (const h of history) recordChunk(h.samples, h.endTime);
    },
    stopRecording() {
      if (!recording) return null;
      const rec = recording;
      recording = null;
      if (!rec.length) return null;
      const buf = ac.createBuffer(1, rec.length, sr);
      const out = buf.getChannelData(0);
      let o = 0;
      for (const c of rec.chunks) {
        out.set(c, o);
        o += c.length;
      }
      handle.recordingStartTime = rec.startTime;
      return buf;
    },
  };

  /** Analysis (and recording) of a chunk while active. */
  function processActive(chunk, endTime) {
    const n = chunk.length;
    // level of the newest ~20 ms
    const m = Math.min(n, hop);
    let s = 0;
    for (let i = n - m; i < n; i++) s += chunk[i] * chunk[i];
    lastRms = Math.sqrt(s / m);
    recordChunk(chunk, endTime);
    // ring buffer of the newest W samples
    if (n >= W) {
      ring.set(chunk.subarray(n - W));
    } else {
      ring.copyWithin(0, n);
      ring.set(chunk, W - n);
    }
    filled = Math.min(W, filled + n);
    sinceFrame += n;
    if (sinceFrame >= hop && filled >= W) {
      sinceFrame = 0;
      const centre = endTime - W / 2 / sr; // AudioContext time of the window centre
      if (centre < origin - 1e-4) return; // window still mostly before the press
      const { freq, clarity } = detectPitch(ring, sr, { minFreq, maxFreq });
      if (onFrame) {
        try {
          onFrame({ time: centre - origin, freq, clarity, rms: lastRms, contextTime: centre });
        } catch (e) {
          console.error('[pitch] onFrame threw:', e);
        }
      }
    }
  }

  function handleSamples(chunk, endTime) {
    if (stopped) return;
    history.push({ samples: chunk, endTime });
    historyLen += chunk.length;
    while (history.length > 1 && historyLen - history[0].samples.length >= HISTORY_MAX) {
      historyLen -= history.shift().samples.length;
    }
    if (active) processActive(chunk, endTime);
  }

  function setActive(on) {
    on = !!on;
    if (stopped || on === active) return;
    active = on;
    lastRms = 0;
    if (!on) {
      if (tap && tap.port) tap.port.postMessage({ type: 'active', active: false });
      return;
    }
    origin = ac.currentTime;
    ring.fill(0);
    filled = 0;
    sinceFrame = 0;
    // Pre-roll: one analysis window before the press, so the first frame
    // comes ~20-40 ms after the press instead of after a full window.
    const fromTime = origin - W / sr - 0.01;
    if (tap && tap.port) {
      tap.port.postMessage({ type: 'active', active: true, fromTime });
    } else {
      for (const h of history) if (h.endTime > fromTime) processActive(h.samples, h.endTime);
    }
  }

  // Silent sink so the tap keeps being processed in every browser. The tap's
  // output is silence, and this gain is 0: the microphone never reaches the speakers.
  const sink = ac.createGain();
  sink.gain.value = 0;
  sink.connect(ac.destination);

  let tap;
  if (await loadWorklet(ac)) {
    tap = new AudioWorkletNode(ac, 'mic-tap', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
      processorOptions: { hop, active },
    });
    tap.port.onmessage = (e) => handleSamples(e.data.samples, e.data.endTime);
  } else {
    handle.mode = 'script';
    tap = ac.createScriptProcessor(1024, 1, 1);
    // Sample-counted clock: contiguous chunk times (the callback's currentTime
    // jitters, and late callbacks arrive in bursts). Offset vs the true time is
    // about one buffer (~21 ms); if the main thread stalls long enough for the
    // browser to drop buffers, times and takes become approximate. (Fallback
    // only: every browser that allows the microphone has AudioWorklet.)
    let base = null;
    let count = 0;
    tap.onaudioprocess = (e) => {
      const data = e.inputBuffer.getChannelData(0);
      if (base === null) base = ac.currentTime - data.length / sr;
      count += data.length;
      handleSamples(new Float32Array(data), base + count / sr);
    };
  }
  sourceNode.connect(tap);
  tap.connect(sink);

  function stop() {
    if (stopped) return;
    stopped = true;
    try { sourceNode.disconnect(tap); } catch (e) { /* ignore */ }
    try { tap.disconnect(); } catch (e) { /* ignore */ }
    try { sink.disconnect(); } catch (e) { /* ignore */ }
    if (tap.port) {
      try { tap.port.postMessage('stop'); tap.port.onmessage = null; } catch (e) { /* ignore */ }
    } else {
      tap.onaudioprocess = null;
    }
  }

  return handle;
}

/**
 * Ask for the microphone (call from a click) and start analysing it.
 * Rejects with { code: 'denied' | 'unsupported' | 'no-device', message }.
 *
 * Hold-to-sing: pass { active: false } to open the microphone without
 * analysing, then call handle.setActive(true/false) on press/release
 * (together with startRecording()/stopRecording()).
 * NOTE: while the stream is open (active or not) browsers show their
 * "microphone in use" indicator; only stop() turns it off. Reopening with
 * startMic after permission was granted needs no prompt (Chrome/Edge remember
 * it per site; Firefox/Safari may ask again per visit) but takes ~50-300 ms
 * for the device to start, so the first moment of a take opened on press may
 * be lost: for hold-to-sing either keep the stream open for the screen visit,
 * or open it on the first press and keep it open afterwards.
 * @param {{onFrame?: (f: MicFrame) => void, frameMs?: number, active?: boolean}} [opts]
 * @returns {Promise<MicHandle>}
 */
export async function startMic({ onFrame, frameMs = 20, active = true } = {}) {
  if (!micSupported()) {
    const insecure = globalThis.isSecureContext === false;
    throw micError(
      'unsupported',
      insecure
        ? 'The microphone only works on a secure page (https:// or this computer via localhost).'
        : 'This browser cannot use the microphone. Try an up-to-date Chrome, Edge, Firefox or Safari.',
    );
  }
  let ac;
  try {
    ac = getAudioContext();
    if (ac.state !== 'running') await ac.resume();
  } catch (e) {
    throw mapMicError(e);
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 1,
      },
      video: false,
    });
  } catch (e) {
    throw mapMicError(e);
  }

  const releaseTracks = () => {
    for (const t of stream.getTracks()) {
      try { t.stop(); } catch (e) { /* ignore */ }
    }
  };

  let source;
  let analysis;
  try {
    source = ac.createMediaStreamSource(stream);
    analysis = await startAnalysis(source, { onFrame, frameMs, active });
  } catch (e) {
    releaseTracks();
    throw mapMicError(e);
  }

  const innerStop = analysis.stop;
  analysis.stop = () => {
    innerStop();
    try { source.disconnect(); } catch (e) { /* ignore */ }
    releaseTracks(); // turns the browser's microphone indicator off
  };
  return analysis;
}
