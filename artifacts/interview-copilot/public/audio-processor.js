/**
 * AudioWorkletProcessor — runs on the dedicated audio thread.
 * Captures mic audio, downsamples to 16 kHz mono, converts Float32 → Int16,
 * and posts ArrayBuffer chunks back to the main thread for streaming to
 * AssemblyAI's real-time API.
 *
 * The browser's default AudioContext sample rate is typically 48 kHz, but
 * AssemblyAI expects 16 kHz. We do a simple decimating low-pass (mean of
 * `step` samples) to avoid aliasing without pulling in a heavy resampler.
 *
 * FIX: replaced the original O(n²) Array + splice() accumulator with a
 * pre-allocated Float32Array and explicit read/write index pointers.
 * The old approach called splice(0, n) inside a tight loop — each call is
 * O(n) because it shifts the entire array — so after a few minutes of 48 kHz
 * audio the worklet thread would stall, causing AssemblyAI to see silence
 * and close the session.  The new approach is amortised O(1) per sample.
 */
const TARGET_RATE = 16000;
const CHUNK_MS = 200; // ~3200 samples per chunk @ 16 kHz

// Pre-allocate input and output ring buffers large enough to hold several
// seconds of audio without compaction.  Power-of-two sizes keep modulo cheap.
const IN_BUF_SIZE  = 65536;  // ~1.4 s @ 48 kHz
const OUT_BUF_SIZE = 32768;  // ~2.0 s @ 16 kHz

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global available inside AudioWorkletGlobalScope.
    this._inputRate = sampleRate;
    this._step = this._inputRate / TARGET_RATE;
    this._chunkSamples = Math.floor((TARGET_RATE * CHUNK_MS) / 1000);

    // Input accumulator — Float32Array with read/write pointers.
    this._inBuf  = new Float32Array(IN_BUF_SIZE);
    this._inWp   = 0;  // write pointer (absolute)
    this._inRp   = 0;  // read pointer  (absolute)

    // Output queue — Float32Array with read/write pointers.
    this._outBuf = new Float32Array(OUT_BUF_SIZE);
    this._outWp  = 0;
    this._outRp  = 0;
  }

  /** Compact the input buffer when the read pointer passes the halfway mark.
   *  Copies the unread tail to the front — amortised O(1) per sample because
   *  this runs at most once every IN_BUF_SIZE/2 samples. */
  _compactIn() {
    if (this._inRp < IN_BUF_SIZE / 2) return;
    const remaining = this._inWp - this._inRp;
    this._inBuf.copyWithin(0, this._inRp, this._inWp);
    this._inWp = remaining;
    this._inRp = 0;
  }

  /** Same compaction for the output buffer. */
  _compactOut() {
    if (this._outRp < OUT_BUF_SIZE / 2) return;
    const remaining = this._outWp - this._outRp;
    this._outBuf.copyWithin(0, this._outRp, this._outWp);
    this._outWp = remaining;
    this._outRp = 0;
  }

  _drainInput() {
    const step = this._step;
    const n    = Math.floor(step);
    // Each iteration advances the read pointer by n — O(1) per output sample.
    while (this._inWp - this._inRp >= step) {
      let sum = 0;
      for (let i = 0; i < n; i++) sum += this._inBuf[this._inRp + i];
      this._outBuf[this._outWp++] = sum / n;
      this._inRp += n;
      this._compactIn();
      this._compactOut();
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];

    // Write incoming samples into the input buffer.
    for (let i = 0; i < channel.length; i++) {
      this._inBuf[this._inWp++] = channel[i];
    }

    this._drainInput();

    // Emit complete 200 ms chunks to the main thread.
    while (this._outWp - this._outRp >= this._chunkSamples) {
      const pcm16 = new Int16Array(this._chunkSamples);
      for (let i = 0; i < this._chunkSamples; i++) {
        const s = Math.max(-1, Math.min(1, this._outBuf[this._outRp + i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      this._outRp += this._chunkSamples;
      this._compactOut();
      // Zero-copy transfer to the main thread.
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
