/**
 * useTranscription — Top-level orchestrator
 *
 * Wires together:
 *   - useWebSocket      (AssemblyAI WS connection)
 *   - useAudioCapture   (AudioWorklet-based mic + system audio)
 *   - useDebounceGate   (accumulate turns, fire copilot)
 *   - useCopilotStream  (SSE streaming LLM with progressive render)
 */

import { useState, useRef, useCallback, useEffect } from "react";
import { useWebSocket, type WsMessage } from "./useWebSocket";
import { useAudioCapture } from "./useAudioCapture";
import { useDebounceGate } from "./useDebounceGate";
import { useCopilotStream } from "./useCopilotStream";

export type Status =
  | "idle"
  | "mic"
  | "auth"
  | "connecting"
  | "listening"
  | "thinking"
  | "streaming"
  | "disconnected"
  | "error"
  | "ended";

export interface Transcript {
  id: number;
  text: string;
  speaker: "interviewer" | "candidate" | "unknown";
  speakerLabel: string;
  latencyMs: number;
}

interface Capabilities {
  autoCopilot: boolean;
  terminalMode: boolean;
  clipboardCapture: boolean;
  keyterms: boolean;
}

export function useTranscription(capabilities: Capabilities) {
  const [isActive, setIsActive] = useState(false);
  const [status, setStatus] = useState<Status>("idle");
  const [error, setError] = useState<string | null>(null);
  const [transcripts, setTranscripts] = useState<Transcript[]>([]);
  const [partialText, setPartialText] = useState("");
  const [systemAudioOn, setSystemAudioOn] = useState(false);

  const isActiveRef = useRef(false);
  const micStreamRef = useRef<MediaStream | null>(null);
  const displayStreamRef = useRef<MediaStream | null>(null);

  // Speaker tracking
  const speakerMapRef = useRef<Record<string, "interviewer" | "candidate">>({});
  const interviewerLabelRef = useRef<string | null>(null);
  const candidateLabelRef = useRef<string | null>(null);
  const lastSpeakerRoleRef = useRef<"interviewer" | "candidate" | null>(null);

  const copilot = useCopilotStream();

  const getSpeakerRole = useCallback(
    (label: string | null): "interviewer" | "candidate" | "unknown" => {
      if (!label) return "unknown";
      if (speakerMapRef.current[label]) return speakerMapRef.current[label];

      if (!interviewerLabelRef.current) {
        interviewerLabelRef.current = label;
        speakerMapRef.current[label] = "interviewer";
        lastSpeakerRoleRef.current = "interviewer";
        return "interviewer";
      }
      if (!candidateLabelRef.current) {
        candidateLabelRef.current = label;
        speakerMapRef.current[label] = "candidate";
        lastSpeakerRoleRef.current = "candidate";
        return "candidate";
      }
      // Label drift — map to opposite of last speaker
      const driftRole =
        lastSpeakerRoleRef.current === "interviewer" ? "candidate" : "interviewer";
      speakerMapRef.current[label] = driftRole;
      lastSpeakerRoleRef.current = driftRole;
      return driftRole;
    },
    []
  );

  const handleCopilotFire = useCallback(
    (text: string, speaker: string) => {
      copilot.fire(text, speaker, {
        terminalMode: capabilities.terminalMode,
      });
    },
    [copilot, capabilities.terminalMode]
  );

  const gate = useDebounceGate({
    onFire: handleCopilotFire,
    autoCopilot: capabilities.autoCopilot,
    copilotFiringRef: copilot.copilotFiringRef,
    isStreamingRef: isActiveRef,
    lastOutputRef: copilot.lastOutputRef,
  });

  const handleMessage = useCallback(
    (msg: WsMessage) => {
      if (msg.type === "Begin") {
        setStatus("listening");
        return;
      }

      if (msg.type === "Turn") {
        const text = msg.transcript || msg.text || "";
        const endOfTurn = msg.end_of_turn ?? msg.is_final ?? false;
        const rawLabel = msg.speaker_label || msg.speaker || null;
        const speaker = getSpeakerRole(rawLabel);

        if (endOfTurn && text.trim()) {
          setTranscripts((prev) => [
            ...prev,
            {
              id: Date.now(),
              text,
              speaker,
              speakerLabel: rawLabel || "?",
              latencyMs: 0,
            },
          ]);
          setPartialText("");
          gate.accumulate(text, speaker);
        } else if (!endOfTurn && text.trim()) {
          setPartialText(text);
        }
        return;
      }

      if (msg.type === "Termination") {
        setStatus("ended");
        return;
      }

      if (msg.type === "Error") {
        setError(msg.error || "Streaming error");
      }
    },
    [getSpeakerRole, gate]
  );

  const ws = useWebSocket({
    onMessage: handleMessage,
    onStatusChange: (s) => {
      if (s === "listening") {
        setStatus("listening");
        setError(null);
      } else if (s === "disconnected") {
        setStatus("disconnected");
      } else if (s === "error") {
        setError("WebSocket error");
        setStatus("error");
      }
    },
    enableKeyterms: capabilities.keyterms,
  });

  const audio = useAudioCapture();

  // Replay coalesced context once the LLM finishes — if the interviewer kept
  // talking while the previous response was streaming, we now have a chance
  // to consolidate that into the next fire.
  const wasStreamingRef = useRef(false);
  useEffect(() => {
    if (wasStreamingRef.current && !copilot.isStreaming) {
      gate.onLlmComplete();
    }
    wasStreamingRef.current = copilot.isStreaming;
  }, [copilot.isStreaming, gate]);

  // Clipboard capture
  const [clipboardCode, setClipboardCode] = useState("");
  useEffect(() => {
    if (!capabilities.clipboardCapture) return;
    const handle = async () => {
      try {
        if (!document.hasFocus()) return;
        const text = await navigator.clipboard.readText();
        const looksLikeCode =
          text &&
          ((text.includes("\n") && /[{}();=]/.test(text)) ||
            /^(class|def|function|const|let|var|import|export|if|for|while|return)\b/m.test(
              text
            ));
        if (looksLikeCode) setClipboardCode(text);
      } catch {}
    };
    document.addEventListener("copy", handle);
    return () => document.removeEventListener("copy", handle);
  }, [capabilities.clipboardCapture]);

  const start = useCallback(async () => {
    setError(null);
    isActiveRef.current = true;

    try {
      setStatus("mic");
      const micStream = await audio.captureMic();
      micStreamRef.current = micStream;

      const { displayStream, audioStream: systemAudio } =
        await audio.captureSystemAudio();
      displayStreamRef.current = displayStream;
      setSystemAudioOn(!!systemAudio);
      if (displayStream && !systemAudio) {
        setError(
          'System audio not captured — please tick "Share tab audio" when sharing.'
        );
      }

      setStatus("auth");
      const tokenRes = await fetch("/api/token", { method: "POST" });
      const tokenData = (await tokenRes.json()) as { token?: string; error?: string };
      if (!tokenRes.ok || !tokenData.token) {
        throw new Error(tokenData.error || "Failed to get auth token");
      }

      setStatus("connecting");
      const wsInstance = await ws.connect(tokenData.token);

      await audio.createPipeline(micStream, systemAudio, (data) => {
        wsInstance.send(data);
      });

      setIsActive(true);
      copilot.reset();
      gate.reset();
      setTranscripts([]);
      setPartialText("");
      speakerMapRef.current = {};
      interviewerLabelRef.current = null;
      candidateLabelRef.current = null;
      lastSpeakerRoleRef.current = null;
    } catch (err) {
      const msg = err instanceof Error ? err.message : "Unknown error";
      setError(msg);
      setStatus("error");
      isActiveRef.current = false;
      setIsActive(false);
    }
  }, [ws, audio, copilot, gate]);

  const stop = useCallback(() => {
    isActiveRef.current = false;
    setIsActive(false);
    setStatus("idle");

    ws.disconnect();

    if (audio.pipelineRef.current) {
      audio.pipelineRef.current.cleanup();
      audio.pipelineRef.current = null;
    }
    audio.stopStream(micStreamRef.current);
    audio.stopStream(displayStreamRef.current);
    micStreamRef.current = null;
    displayStreamRef.current = null;

    gate.reset();
    setPartialText("");
  }, [ws, audio, gate]);

  const triggerRescue = useCallback(() => {
    if (!isActiveRef.current) return;
    if (copilot.copilotFiringRef.current) return;
    const context =
      gate.previewText || partialText || "Alpha is frozen mid-sentence.";
    gate.reset();
    copilot.fire(context, "candidate", { isRescue: true });
  }, [copilot, gate, partialText]);

  const flushContext = useCallback(() => {
    copilot.flush();
    gate.reset();
    setPartialText("");
  }, [copilot, gate]);

  // Merged status: copilot streaming takes visual priority
  const mergedStatus: Status = copilot.isStreaming
    ? "streaming"
    : status;

  return {
    isActive,
    status: mergedStatus,
    error,
    transcripts,
    partialText: gate.previewText || partialText,
    pendingDuringFire: gate.pendingDuringFire,
    systemAudioOn,
    copilot,
    clipboardCode,
    start,
    stop,
    triggerRescue,
    flushContext,
  };
}
