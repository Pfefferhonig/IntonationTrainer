// AudioWorklet processor for js/audio/pitch.js: collects microphone samples
// into fixed-size chunks ("hops") and posts them to the main thread, where
// the pitch analysis runs. Loaded with audioWorklet.addModule(<this file's URL>).
//
// Hold-to-sing: while inactive it posts nothing; it only keeps the newest
// ~0.3 s in a small ring buffer (a cheap copy of 128 samples per block), so
// that on activation it can first post the samples from the requested
// `fromTime` onward: nothing after the button press is lost to message latency.
//
// It never produces sound: its output is silent and is only connected (through
// a zero gain) so that every browser keeps processing it.

class MicTapProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const po = (options && options.processorOptions) || {};
    const hop = po.hop | 0;
    this.hop = hop > 0 ? hop : 960;
    this.buf = new Float32Array(this.hop);
    this.n = 0;
    this.active = po.active !== false;
    this.ring = new Float32Array(Math.ceil(sampleRate * 0.3));
    this.ringPos = 0; // next write index
    this.ringFilled = 0;
    this.alive = true;
    this.port.onmessage = (e) => this.onMessage(e.data);
  }

  onMessage(msg) {
    if (msg === 'stop') {
      this.alive = false;
      return;
    }
    if (!msg || msg.type !== 'active') return;
    this.n = 0;
    this.buf = new Float32Array(this.hop);
    if (!msg.active) {
      this.active = false;
      return;
    }
    this.active = true;
    // Here, currentTime = end of the newest sample in the ring.
    let back = Math.round((currentTime - (msg.fromTime || currentTime)) * sampleRate);
    back = Math.max(0, Math.min(this.ringFilled, back));
    if (back > 0) {
      const out = new Float32Array(back);
      const len = this.ring.length;
      let start = this.ringPos - back;
      if (start < 0) start += len;
      for (let i = 0; i < back; i++) out[i] = this.ring[(start + i) % len];
      this.port.postMessage({ samples: out, endTime: currentTime }, [out.buffer]);
    }
  }

  process(inputs) {
    const input = inputs[0];
    const ch = input && input[0];
    if (!ch) return this.alive;

    // Pre-roll ring (always).
    const len = this.ring.length;
    for (let i = 0; i < ch.length; i++) {
      this.ring[this.ringPos] = ch[i];
      this.ringPos = this.ringPos + 1 === len ? 0 : this.ringPos + 1;
    }
    this.ringFilled = Math.min(len, this.ringFilled + ch.length);

    if (this.active) {
      let i = 0;
      while (i < ch.length) {
        const k = Math.min(ch.length - i, this.hop - this.n);
        this.buf.set(ch.subarray(i, i + k), this.n);
        this.n += k;
        i += k;
        if (this.n === this.hop) {
          // endTime = AudioContext time just after the chunk's last sample.
          this.port.postMessage(
            { samples: this.buf, endTime: currentTime + i / sampleRate },
            [this.buf.buffer],
          );
          this.buf = new Float32Array(this.hop);
          this.n = 0;
        }
      }
    }
    return this.alive;
  }
}

registerProcessor('mic-tap', MicTapProcessor);
