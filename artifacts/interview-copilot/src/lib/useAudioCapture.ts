/**
 * useAudioCapture — AudioWorklet-based audio pipeline
 *
 * KEY FIX: Replaces the deprecated ScriptProcessorNode with AudioWorkletNode.
 *
 * ScriptProcessorNode runs on the main JS thread → audio glitches when the
 * page is busy (React renders, SSE parsing, etc.) causing gaps in the PCM
 * stream that AssemblyAI interprets as silence.
 *
 * AudioWorkletNode runs on a dedicated audio rendering thread → consistent
 * low-latency capture regardless of main thread load.
 */

import { useRef, useCallback } from "react";

interface AudioPipeline {
  cleanup: () => void;
  updateSendFn: (fn: (data: ArrayBuffer) => void) => void;
}

export function useAudioCapture() {
  const pipelineRef = useRef<AudioPipeline | null>(null);

  const captureMic = async (): Promise<MediaStream> => {
    return navigator.mediaDevices.getUserMedia({
      audio: {
        sampleRate: 16000,
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
  };

  const captureSystemAudio = async (): Promise<{
    displayStream: MediaStream | null;
    audioStream: MediaStream | null;
  }> => {
    try {
      const displayStream = await navigator.mediaDevices.getDisplayMedia({
        video: true,
        audio: {
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        },
      });

      // Kill video immediately — we only need audio
      displayStream.getVideoTracks().forEach((t) => t.stop());

      const audioTracks = displayStream.getAudioTracks();
      if (audioTracks.length > 0) {
        return { displayStream, audioStream: new MediaStream(audioTracks) };
      }

      return { displayStream, audioStream: null };
    } catch {
      return { displayStream: null, audioStream: null };
    }
  };

  const createPipeline = useCallback(
    async (
      micStream: MediaStream,
      systemAudioStream: MediaStream | null,
      sendFn: (data: ArrayBuffer) => void
    ): Promise<AudioPipeline> => {
      // AudioContext at 16kHz to match AssemblyAI's expected sample rate
      const audioContext = new AudioContext({ sampleRate: 16000 });

      // Load the AudioWorklet processor from public/
      await audioContext.audioWorklet.addModule("/audio-processor.js");

      const micSource = audioContext.createMediaStreamSource(micStream);

      // Single GainNode acts as a summing bus — connecting two mono sources to
      // the same destination causes the WebAudio engine to add their samples,
      // producing a properly mixed mono signal that the AudioWorklet (which
      // reads inputs[0][0]) will actually receive.
      const mixBus = audioContext.createGain();
      mixBus.gain.value = 1.0;

      const micGain = audioContext.createGain();
      micGain.gain.value = 1.0;
      micSource.connect(micGain).connect(mixBus);

      if (systemAudioStream) {
        const systemSource =
          audioContext.createMediaStreamSource(systemAudioStream);
        const systemGain = audioContext.createGain();
        // Boost system audio slightly — tab/screen capture tends to be quieter
        systemGain.gain.value = 1.4;
        systemSource.connect(systemGain).connect(mixBus);
      }

      // Mutable ref so we can hot-swap the send function on reconnect
      let activeSendFn = sendFn;

      const workletNode = new AudioWorkletNode(audioContext, "pcm-processor", {
        channelCount: 1,
        channelCountMode: "explicit",
        channelInterpretation: "speakers",
      });
      workletNode.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        activeSendFn(event.data);
      };

      mixBus.connect(workletNode);
      // Connect to destination through a muted gain to keep the graph alive
      // without echoing audio back to the user
      const silentSink = audioContext.createGain();
      silentSink.gain.value = 0;
      workletNode.connect(silentSink).connect(audioContext.destination);

      const pipeline: AudioPipeline = {
        cleanup: () => {
          try {
            workletNode.disconnect();
            workletNode.port.close();
          } catch {}
          try {
            audioContext.close();
          } catch {}
        },
        updateSendFn: (fn) => {
          activeSendFn = fn;
        },
      };

      pipelineRef.current = pipeline;
      return pipeline;
    },
    []
  );

  const stopStream = (stream: MediaStream | null) => {
    if (!stream) return;
    try {
      stream.getTracks().forEach((t) => t.stop());
    } catch {}
  };

  return { captureMic, captureSystemAudio, createPipeline, stopStream, pipelineRef };
}
