// Shared pieces for the two singing tabs ("Echo", "Join the chord"):
// loading the (optional) pitch / sing modules, the microphone session (with a dev-only fake),
// the one-time microphone setup, plain-language mic errors, and the live pitch trace.
//
// The singing modules are loaded with dynamic import() so the rest of the app keeps
// working while they are not there yet.

import * as engine from '../audio/engine.js';
import { getPref, setPref } from '../storage.js';
import { el, setChildren } from './dom.js';
import { icon } from './icons.js';

const SETUP_PREF = 'mic.setupDone';

let modulesPromise = null;
/** -> { pitch, sing } (each null when that module is missing). Cached. */
export function loadSingModules() {
  if (!modulesPromise) {
    const tryImport = (path) => import(path).catch(() => null);
    modulesPromise = Promise.all([tryImport('../audio/pitch.js'), tryImport('../exercise/sing.js')])
      .then(([pitch, sing]) => ({ pitch, sing }));
  }
  return modulesPromise;
}

/** Dev-only: `?fakeMic=1` in the page address feeds synthetic voice frames (for testing). */
export function fakeMicEnabled() {
  try {
    return new URLSearchParams(window.location.search).get('fakeMic') === '1';
  } catch {
    return false;
  }
}

export function micSetupDone() { return getPref(SETUP_PREF, false) === true; }
export function markMicSetupDone() { setPref(SETUP_PREF, true); }

/** Switch analysis on/off on a mic handle (no-op for handles without setActive). */
export function setMicActive(mic, on) {
  if (mic && typeof mic.setActive === 'function') {
    try { mic.setActive(!!on); } catch (err) { console.error(err); }
  }
}

/** Plain help for startMic's error codes. */
export function micErrorHelp(err) {
  const code = err && err.code;
  if (code === 'denied') {
    return 'The browser blocked the microphone. Click the lock or microphone icon next to the address bar, '
      + 'choose "Allow" for the microphone, then press "Try again". (If you blocked it earlier, it stays blocked until you allow it there.)';
  }
  if (code === 'no-device') {
    return 'No microphone was found. Plug in a headset or microphone (or check that it is switched on), then press "Try again".';
  }
  if (code === 'unsupported') {
    return 'This browser cannot use the microphone here. Please use an up-to-date Chrome, Edge, Firefox or Safari, and open the app through start.bat (http://localhost).';
  }
  return (err && err.message) || 'The microphone could not be started. Please try again.';
}

// ---------------------------------------------------------------------------
// Fake microphone (dev only): a scoop into the note, then steady at target + 8 cents.
// ---------------------------------------------------------------------------

const fakeState = { targetFreq: 220, offsetCents: 8, voiced: true };
/** Tell the fake mic which note to "sing" (no effect with a real microphone). */
export function setFakeTarget(freq, { offsetCents = 8 } = {}) {
  fakeState.targetFreq = freq;
  fakeState.offsetCents = offsetCents;
}

function startFakeMic({ onFrame, frameMs = 20 }) {
  const t0 = performance.now();
  let voiceStart = null; // the fake singer starts 0.3 s after the mic opens
  let rec = null;
  let level = 0;
  const id = setInterval(() => {
    const time = (performance.now() - t0) / 1000;
    if (voiceStart === null) voiceStart = time + 0.3;
    const into = time - voiceStart;
    if (into < 0) {
      level = 0.002;
      onFrame({ time, freq: null, clarity: 0.1, rms: level });
      return;
    }
    const scoop = into < 0.35 ? -120 * (1 - into / 0.35) : 0;
    const noise = (Math.random() - 0.5) * 6;
    const cents = fakeState.offsetCents + scoop + noise;
    const freq = fakeState.targetFreq * 2 ** (cents / 1200);
    level = 0.18 + Math.random() * 0.04;
    if (rec) rec.push(freq);
    onFrame({ time, freq, clarity: 0.95, rms: level });
  }, frameMs);
  return Promise.resolve({
    stop() { clearInterval(id); },
    setActive() { /* the fake always produces frames; callers ignore them when not held */ },
    level() { return level; },
    startRecording() { rec = []; },
    stopRecording() {
      // A synthetic "recording": a soft sine following the fake pitch, so playback works.
      const ctx = typeof engine.getAudioContext === 'function' ? engine.getAudioContext() : null;
      const freqs = rec || [];
      rec = null;
      if (!ctx || !freqs.length) return null;
      const sr = ctx.sampleRate;
      const per = Math.round((sr * frameMs) / 1000);
      const buf = ctx.createBuffer(1, per * freqs.length, sr);
      const data = buf.getChannelData(0);
      let phase = 0;
      for (let i = 0; i < data.length; i += 1) {
        const f = freqs[Math.min(freqs.length - 1, Math.floor(i / per))];
        phase += (2 * Math.PI * f) / sr;
        const env = Math.min(1, i / (sr * 0.05), (data.length - i) / (sr * 0.05));
        data[i] = 0.25 * env * (Math.sin(phase) + 0.3 * Math.sin(2 * phase));
      }
      return buf;
    },
    fake: true,
  });
}

/**
 * Open the microphone (call from a click). Uses the real pitch.startMic, or the fake one
 * with ?fakeMic=1. Resolves to { stop, level, startRecording, stopRecording, fake? }.
 * Rejects with { code, message }.
 */
export async function openMic({ onFrame, frameMs = 20, active = false } = {}) {
  if (fakeMicEnabled()) return startFakeMic({ onFrame, frameMs });
  const { pitch } = await loadSingModules();
  if (!pitch || typeof pitch.startMic !== 'function') {
    const e = new Error('The microphone part of the app is still being finished.');
    e.code = 'not-ready';
    throw e;
  }
  // Hold-to-sing: opened inactive; setMicActive(handle, true/false) on press / release.
  return pitch.startMic({ onFrame, frameMs, active });
}

// ---------------------------------------------------------------------------
// One-time microphone setup (mockup state a): allow, headphones, "say aah" check
// ---------------------------------------------------------------------------

/**
 * Builds the setup panel. onDone() is called when the user continues.
 * Returns { element, destroy() } — destroy() releases the microphone.
 */
export function micSetupPanel({ onDone, title = 'Before you sing' } = {}) {
  let mic = null;
  let timer = 0;
  let voicedMs = 0;
  let heard = false;
  const bars = Array.from({ length: 10 }, () => el('span'));
  const meter = el('div', { class: 'meter', 'aria-hidden': 'true' }, bars);
  const meterNote = el('p', { class: 'small muted', role: 'status' }, 'Hold the button and sing for a second.');
  let holding = false;
  const holdBtn = el('button', { type: 'button', class: 'btn btn-small btn-hold', disabled: true },
    icon('mic', { size: 16 }), 'Hold to say "aah"');
  holdBtn.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    try { holdBtn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    holding = true;
    setMicActive(mic, true);
    holdBtn.classList.add('is-held');
  });
  const letGo = () => { holding = false; setMicActive(mic, false); holdBtn.classList.remove('is-held'); paint(0); };
  holdBtn.addEventListener('pointerup', letGo);
  holdBtn.addEventListener('pointercancel', letGo);
  holdBtn.addEventListener('lostpointercapture', letGo);
  holdBtn.addEventListener('contextmenu', (e) => e.preventDefault());
  holdBtn.addEventListener('keydown', (e) => { if (e.key === ' ' && !e.repeat) { e.preventDefault(); holding = true; setMicActive(mic, true); holdBtn.classList.add('is-held'); } });
  holdBtn.addEventListener('keyup', (e) => { if (e.key === ' ') { e.preventDefault(); letGo(); } });
  holdBtn.addEventListener('blur', letGo);
  const errorBox = el('p', { class: 'mic-error', role: 'alert' });
  errorBox.hidden = true;

  const step1Num = el('span', { class: 'num' }, '1');
  const allowBtn = el('button', { type: 'button', class: 'btn btn-primary btn-small', onclick: () => allow() },
    icon('mic', { size: 18 }), 'Allow the microphone');
  const continueBtn = el('button', { type: 'button', class: 'btn btn-primary', onclick: () => finish() },
    'Continue', icon('chevron-right', { size: 20 }));
  continueBtn.disabled = true;
  const step3 = el('div', { class: 'setup-step' },
    el('span', { class: 'num' }, '3'),
    el('div', {},
      el('strong', {}, 'Quick check: hold to say "aah"'),
      el('p', { class: 'muted small' }, 'Hold the button and sing a comfortable "aah". The bars should reach the green part. Nothing is recorded.'),
      holdBtn,
      meter,
      meterNote,
    ),
  );
  step3.classList.add('is-waiting');

  function paint(rms) {
    const lvl = Math.min(1, Math.sqrt(Math.max(0, rms)) * 2.4);
    const on = Math.round(lvl * bars.length);
    bars.forEach((b, i) => {
      b.style.height = `${30 + i * 7}%`;
      b.className = i < on ? (i >= 8 ? 'hot' : 'on') : '';
    });
  }
  paint(0);

  async function allow() {
    errorBox.hidden = true;
    allowBtn.disabled = true;
    try { await engine.initAudio(); } catch { /* playback is not needed for the check */ }
    try {
      mic = await openMic({
        onFrame: (f) => {
          if (!holding) return; // only while the button is held
          if (f.freq && f.clarity >= 0.8 && f.rms >= 0.02) voicedMs += 20; else voicedMs = Math.max(0, voicedMs - 10);
          if (!heard && voicedMs >= 500) {
            heard = true;
            meterNote.textContent = 'Great — we can hear you clearly.';
            meterNote.className = 'small mic-ok';
          }
        },
      });
    } catch (err) {
      allowBtn.disabled = false;
      errorBox.textContent = micErrorHelp(err);
      errorBox.hidden = false;
      return;
    }
    step1Num.replaceChildren(icon('check', { size: 16 }));
    step1Num.parentElement.classList.add('is-done');
    setChildren(allowBtn, icon('mic', { size: 18 }), 'Microphone allowed');
    step3.classList.remove('is-waiting');
    continueBtn.disabled = false;
    holdBtn.disabled = false;
    timer = setInterval(() => { if (holding) { try { paint(mic.level()); } catch { /* ignore */ } } }, 60);
  }

  function release() {
    clearInterval(timer);
    timer = 0;
    if (mic) { try { mic.stop(); } catch { /* ignore */ } mic = null; }
  }

  function finish() {
    release();
    markMicSetupDone();
    if (typeof onDone === 'function') onDone();
  }

  const element = el('div', { class: 'mic-setup' },
    el('h2', { class: 'mic-setup-title' }, title),
    el('div', { class: 'card setup-steps' },
      el('div', { class: 'setup-step' },
        step1Num,
        el('div', {},
          el('strong', {}, 'Allow the microphone'),
          el('p', { class: 'muted small' }, 'Your browser will ask once. The sound is analysed on this device only — nothing is uploaded or stored except the numbers.'),
          allowBtn,
          errorBox,
        ),
      ),
      el('div', { class: 'setup-step' },
        el('span', { class: 'num' }, '2'),
        el('div', {},
          el('strong', {}, 'Put on headphones'),
          el('p', { class: 'muted small' }, 'Strongly recommended: through speakers the microphone also hears the app\'s own notes and gets confused about which voice is yours.'),
        ),
      ),
      step3,
    ),
    continueBtn,
  );

  return { element, destroy: release };
}

// ---------------------------------------------------------------------------
// Live pitch trace (SVG): your pitch in cents around the target, scrolling left to right
// ---------------------------------------------------------------------------

/**
 * createTrace({ seconds, rangeCents }) -> { element, reset(), add(time, cents), setGuide(bands|null),
 *   showResult({ points, steadyStart, steadyEnd, bands }) }
 * cents: relative to the target (0 = in tune in the chosen tuning). bands: [{ cents, label, kind }].
 * No target line unless a guide / result band is set.
 */
export function createTrace({ seconds: baseSeconds = 3.6, rangeCents = 100 } = {}) {
  let seconds = baseSeconds; // widens by itself for longer takes
  const NS = 'http://www.w3.org/2000/svg';
  const W = 400;
  const H = 96;
  const s = (tag, attrs = {}) => {
    const n = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) n.setAttribute(k, String(v));
    return n;
  };
  const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, preserveAspectRatio: 'none', class: 'trace-svg', role: 'img', 'aria-label': 'Your pitch' });
  const bandLayer = s('g');
  const steadyRect = s('rect', { class: 'trace-steady', y: 0, height: H, x: 0, width: 0, visibility: 'hidden' });
  const scoopLine = s('polyline', { class: 'trace-line is-faded', points: '' });
  const line = s('polyline', { class: 'trace-line', points: '' });
  const labels = s('g');
  svg.append(steadyRect, bandLayer, scoopLine, line, labels);
  let pts = [];

  const x = (t) => Math.max(0, Math.min(W, (t / seconds) * W));
  const y = (c) => H / 2 - (Math.max(-rangeCents, Math.min(rangeCents, c)) / rangeCents) * (H / 2 - 6);
  const fmt = (list) => list.map((p) => `${x(p.time).toFixed(1)},${y(p.cents).toFixed(1)}`).join(' ');

  function drawBands(bands, withLabels) {
    bandLayer.replaceChildren();
    labels.replaceChildren();
    for (const b of bands || []) {
      bandLayer.append(
        s('rect', { class: `trace-band is-${b.kind || 'target'}`, x: 0, width: W, y: y(b.cents + 5), height: Math.max(2, y(b.cents - 5) - y(b.cents + 5)) }),
        s('line', { class: `trace-band-line is-${b.kind || 'target'}`, x1: 0, x2: W, y1: y(b.cents), y2: y(b.cents) }),
      );
      if (withLabels && b.label) {
        const t = s('text', { class: 'trace-label', x: W - 4, y: y(b.cents) - 4, 'text-anchor': 'end' });
        t.textContent = b.label;
        labels.append(t);
      }
    }
  }

  return {
    element: el('div', { class: 'trace-wrap' }, svg),
    reset() {
      seconds = baseSeconds;
      pts = [];
      line.setAttribute('points', '');
      scoopLine.setAttribute('points', '');
      steadyRect.setAttribute('visibility', 'hidden');
      drawBands([], false);
    },
    add(time, cents) {
      if (!Number.isFinite(cents)) return;
      pts.push({ time, cents });
      if (time > seconds * 0.95) seconds = time * 1.3;
      line.setAttribute('points', fmt(pts));
    },
    setGuide(bands) { drawBands(bands, false); },
    showResult({ points, steadyStart, steadyEnd, bands }) {
      const list = Array.isArray(points) ? points.filter((p) => Number.isFinite(p.cents)) : pts;
      const last = list.length ? list[list.length - 1].time : 0;
      seconds = Math.max(baseSeconds, last * 1.05);
      const hasSteady = Number.isFinite(steadyStart) && Number.isFinite(steadyEnd) && steadyEnd > steadyStart;
      if (hasSteady) {
        steadyRect.setAttribute('x', x(steadyStart));
        steadyRect.setAttribute('width', Math.max(2, x(steadyEnd) - x(steadyStart)));
        steadyRect.setAttribute('visibility', 'visible');
        scoopLine.setAttribute('points', fmt(list.filter((p) => p.time <= steadyStart)));
        line.setAttribute('points', fmt(list.filter((p) => p.time >= steadyStart)));
      } else {
        line.setAttribute('points', fmt(list));
      }
      drawBands(bands, true);
    },
  };
}

/** Fold a frequency to the octave nearest `ref` and return cents from ref (any octave counts). */
export function foldedCents(freq, ref) {
  if (!(freq > 0) || !(ref > 0)) return NaN;
  let c = 1200 * Math.log2(freq / ref);
  c -= 1200 * Math.round(c / 1200);
  return c;
}
