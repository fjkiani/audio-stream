/**
 * AudioWorkletProcessor — runs on the dedicated audio thread.
 * Converts Float32 PCM samples to Int16 PCM and posts ArrayBuffers back
 * to the main thread where they get sent to AssemblyAI via WebSocket.
 *
 * Why AudioWorklet over ScriptProcessorNode?
 * - ScriptProcessorNode runs on the main thread → audio glitches under load
 * - AudioWorklet runs on a dedicated audio thread → consistent capture
 * - ScriptProcessorNode is deprecated in all major browsers
 */
class PcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._bufferSize = 4096; // Send chunks every 4096 samples (~256ms at 16kHz)
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0]) return true;

    const channelData = input[0]; // mono channel
    for (let i = 0; i < channelData.length; i++) {
      this._buffer.push(channelData[i]);
    }

    while (this._buffer.length >= this._bufferSize) {
      const chunk = this._buffer.splice(0, this._bufferSize);
      const pcm16 = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        // Clamp and convert Float32 [-1, 1] to Int16 [-32768, 32767]
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm16[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }
      // Transfer the buffer (zero-copy) to the main thread
      this.port.postMessage(pcm16.buffer, [pcm16.buffer]);
    }

    return true; // Keep processor alive
  }
}

registerProcessor("pcm-processor", PcmProcessor);
