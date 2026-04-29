/**
 * AudioWorkletProcessor — runs on the dedicated audio thread.
 * Captures mic audio, downsamples to 16 kHz mono, converts Float32 → Int16,
 * and posts ArrayBuffer chunks back to the main thread for streaming to
 * AssemblyAI's real-time API.
 *
 * The browser's default AudioContext sample rate is typically 48 kHz, but
 * AssemblyAI expects 16 kHz. We do a simple decimating low-pass (mean of
 * `step` samples) to avoid aliasing without pulling in a heavy resampler.
 */
const TARGET_RATE = 16000;
const CHUNK_MS = 200; // ~3200 samples per chunk @ 16 kHz

class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // `sampleRate` is a global available inside AudioWorkletGlobalScope.
    this._inputRate = sampleRate;
    this._step = this._inputRate / TARGET_RATE;
    this._chunkSamples = Math.floor((TARGET_RATE * CHUNK_MS) / 1000);
    // Accumulator (in input-rate Float32 samples).
    this._inBuf = [];
    // Output queue (in 16 kHz Float32 samples).
    this._outBuf = [];
  }

  _drainInput() {
    // Decimate by averaging `step` consecutive input samples to one output.
    const step = this._step;
    while (this._inBuf.length >= step) {
      let sum = 0;
      const n = Math.floor(step);
      for (let i = 0; i < n; i++) sum += this._inBuf[i];
      this._outBuf.push(sum / n);
      this._inBuf.splice(0, n);
    }
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channel = input[0];
    for (let i = 0; i < channel.length; i++) this._inBuf.push(channel[i]);
    this._drainInput();

    while (this._outBuf.length >= this._chunkSamples) {
      const chunk = this._outBuf.splice(0, this._chunkSamples);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Zero-copy transfer to the main thread.
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true;
  }
}

registerProcessor("pcm-processor", PcmProcessor);
