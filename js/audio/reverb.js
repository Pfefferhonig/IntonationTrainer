/**
 * Generated impulse responses for the sound engine. Plain ES module, no DOM.
 *
 * Everything here is deterministic (seeded pseudo-random numbers), so the
 * "room" and the noise sound identical in every session and on every device
 * with the same sample rate.
 *
 * A convolution reverb is a linear, time-invariant filter: it never changes
 * the frequency of anything that passes through it, so pitches and beat
 * rates are unaffected. It only adds a fixed coloration and a decaying tail.
 */

/**
 * Small xorshift32 PRNG returning floats in [-1, 1).
 * @param {number} seed
 * @returns {() => number}
 */
export function makeNoiseGenerator(seed = 0x2f6b9a1d) {
  let s = seed >>> 0 || 1;
  return function next() {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 2147483648 - 1;
  };
}

/**
 * Build a stereo room impulse response: diffuse, exponentially decaying noise
 * whose high frequencies die away faster than the lows (like a real room),
 * with a short pre-delay. Normalized so that the energy of each channel is 1,
 * i.e. the reverberant signal of a steady tone has about the same RMS as the
 * tone itself; the engine's send gain then sets the wet level directly.
 *
 * @param {BaseAudioContext} ac
 * @param {{duration?: number, rt60?: number, predelay?: number, seed?: number}} [opts]
 *   duration: buffer length in s; rt60: time to decay by 60 dB, in s;
 *   predelay: gap before the tail starts, in s.
 * @returns {AudioBuffer}
 */
export function createRoomImpulse(ac, { duration = 1.4, rt60 = 1.2, predelay = 0.012, seed = 0x51ed2701 } = {}) {
  const sr = ac.sampleRate;
  const len = Math.max(2, Math.round(sr * duration));
  const buf = ac.createBuffer(2, len, sr);
  const rand = makeNoiseGenerator(seed);
  const pre = Math.min(len - 1, Math.round(predelay * sr));
  const fadeIn = Math.max(1, Math.round(0.003 * sr));
  const fadeOut = Math.max(1, Math.round(0.08 * sr));
  const decayPerSample = Math.pow(10, -3 / (rt60 * sr)); // amplitude reaches -60 dB at rt60

  let energy = 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    let env = 1;
    let y = 0;
    for (let i = pre; i < len; i++) {
      const t = (i - pre) / sr;
      // One-pole low-pass whose cutoff falls over time: bright early, dark late.
      const c = 0.85 - 0.6 * Math.min(1, t / rt60);
      y += c * (rand() - y);
      let v = y * env;
      const k = i - pre;
      if (k < fadeIn) v *= k / fadeIn;
      const fromEnd = len - 1 - i;
      if (fromEnd < fadeOut) v *= fromEnd / fadeOut;
      d[i] = v;
      energy += v * v;
      env *= decayPerSample;
    }
  }
  const scale = energy > 0 ? 1 / Math.sqrt(energy / 2) : 0;
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] *= scale;
  }
  return buf;
}

/**
 * Mono white-noise buffer (uniform in [-1, 1), RMS = 1/sqrt(3)) used for
 * onset transients and breath. Played looped from varying offsets.
 * @param {BaseAudioContext} ac
 * @param {number} [seconds]
 * @returns {AudioBuffer}
 */
export function createNoiseBuffer(ac, seconds = 2) {
  const len = Math.max(1, Math.round(ac.sampleRate * seconds));
  const buf = ac.createBuffer(1, len, ac.sampleRate);
  const d = buf.getChannelData(0);
  const rand = makeNoiseGenerator(0x7a3c19e5);
  for (let i = 0; i < len; i++) d[i] = rand();
  return buf;
}
