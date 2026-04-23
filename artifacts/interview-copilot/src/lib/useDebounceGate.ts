/**
 * useDebounceGate — Smart context accumulator
 *
 * Architecture:
 *   - Continuously accumulate interviewer utterances into a `pendingChunk`
 *   - Never lose context: while the LLM is firing, new transcripts keep
 *     flowing into a `coalesceBuffer` instead of being dropped
 *   - Fire the LLM only on REAL triggers, not every micro-pause:
 *       (1) Speaker switches from interviewer → candidate
 *           (interviewer "finished asking", candidate is now responding)
 *       (2) Question signal detected (?, "what/why/how/can you/walk me/tell me")
 *       (3) Long uninterrupted silence after a substantial chunk
 *   - When the LLM completes, replay the coalesced buffer as a single
 *     consolidated fire (only if it carries net-new substantial content)
 *
 * Result: one coherent LLM response per actual interviewer question, not
 * five mini-responses to five sentence fragments.
 */

import { useRef, useState, useCallback } from "react";

// Tuning constants
const MIN_WORDS_TO_FIRE       = 8;     // ignore one-liners ("Okay so")
const SILENCE_FIRE_MS         = 4500;  // long silence trigger
const SHORT_SILENCE_FIRE_MS   = 1500;  // shorter silence if speaker switch happens
const MIN_PENDING_CHARS_REFIRE = 60;   // require ≥60 net-new chars after LLM done
const ECHO_THRESHOLD          = 0.70;
const MIN_WORD_LEN            = 6;

const QUESTION_REGEX =
  /(\?|^|\s)(what|why|how|when|where|which|can you|could you|would you|tell me|walk me|describe|explain|do you|did you|have you|are you|let's|let me see)\b/i;

function isLikelyQuestion(text: string): boolean {
  return QUESTION_REGEX.test(text);
}

function wordCount(text: string): number {
  return text.split(/\s+/).filter((w) => w.length > 0).length;
}

interface UseDebounceGateOptions {
  onFire: (text: string, speaker: string) => void;
  autoCopilot: boolean;
  copilotFiringRef: React.MutableRefObject<boolean>;
  isStreamingRef: React.MutableRefObject<boolean>;
  lastOutputRef: React.MutableRefObject<string>;
}

export function useDebounceGate({
  onFire,
  autoCopilot,
  copilotFiringRef,
  isStreamingRef,
  lastOutputRef,
}: UseDebounceGateOptions) {
  // Live pending buffer — interviewer text awaiting a fire trigger
  const pendingRef = useRef("");
  // Coalesce buffer — interviewer text that arrived WHILE LLM was running
  const coalesceRef = useRef("");
  // Track most recent speaker so we can detect transitions
  const lastSpeakerRef = useRef<string>("");
  const lastFiredTextRef = useRef("");

  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewText, setPreviewText] = useState("");
  const [pendingDuringFire, setPendingDuringFire] = useState(0);

  const isEcho = useCallback(
    (transcript: string): boolean => {
      const lastOutput = lastOutputRef.current || "";
      if (!lastOutput || lastOutput.length < 30) return false;

      const sig = (text: string) =>
        new Set(text.toLowerCase().split(/\s+/).filter((w) => w.length >= MIN_WORD_LEN));

      const transcriptWords = sig(transcript);
      const outputWords = sig(lastOutput);
      if (transcriptWords.size < 3) return false;

      let matches = 0;
      for (const w of transcriptWords) if (outputWords.has(w)) matches++;
      return matches / transcriptWords.size >= ECHO_THRESHOLD;
    },
    [lastOutputRef]
  );

  const clearTimer = () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  };

  /** Attempt to fire the LLM with the current pending buffer. */
  const tryFire = useCallback(
    (reason: "silence" | "question" | "speakerSwitch") => {
      const text = pendingRef.current.trim();
      if (!text) return;

      // If LLM is busy, don't drop — keep accumulating into coalesceRef.
      // The post-LLM hook will replay it.
      if (copilotFiringRef.current) return;

      if (!isStreamingRef.current) return;

      const wc = wordCount(text);
      // Speaker-switch is the strongest signal — relax word floor a bit
      const minWords = reason === "speakerSwitch" ? 4 : MIN_WORDS_TO_FIRE;
      if (wc < minWords) return;

      if (isEcho(text)) {
        pendingRef.current = "";
        setPreviewText("");
        return;
      }

      lastFiredTextRef.current = text;
      pendingRef.current = "";
      coalesceRef.current = "";
      setPreviewText("");
      setPendingDuringFire(0);
      clearTimer();

      if (autoCopilot) {
        onFire(text, "interviewer");
      }
    },
    [autoCopilot, onFire, copilotFiringRef, isStreamingRef, isEcho]
  );

  /**
   * Called when the LLM finishes — if substantial new context piled up while
   * we were waiting, fire ONE consolidated request rather than dropping it.
   */
  const onLlmComplete = useCallback(() => {
    setPendingDuringFire(0);
    const queued = coalesceRef.current.trim();
    if (!queued) return;

    // Net-new content threshold so we don't echo back the same question
    if (queued.length < MIN_PENDING_CHARS_REFIRE) return;
    if (isEcho(queued)) {
      coalesceRef.current = "";
      return;
    }

    // Promote the coalesced buffer into the pending buffer
    pendingRef.current = queued;
    coalesceRef.current = "";
    setPreviewText(queued);

    // Schedule a near-term fire — gives the interviewer a brief moment in case
    // they're still mid-thought
    clearTimer();
    timerRef.current = setTimeout(() => tryFire("silence"), SHORT_SILENCE_FIRE_MS);
  }, [isEcho, tryFire]);

  const accumulate = useCallback(
    (text: string, speaker = "interviewer") => {
      const prevSpeaker = lastSpeakerRef.current;
      lastSpeakerRef.current = speaker;

      // Candidate utterances are NEVER sent to the LLM as questions, but they
      // act as a strong fire trigger for any pending interviewer chunk.
      if (speaker === "candidate") {
        if (prevSpeaker === "interviewer" && pendingRef.current.trim()) {
          clearTimer();
          tryFire("speakerSwitch");
        }
        return;
      }

      // Interviewer text: append to pending buffer (or coalesce buffer if
      // LLM is still streaming)
      const target = copilotFiringRef.current ? coalesceRef : pendingRef;
      target.current = target.current ? `${target.current} ${text}` : text;

      if (copilotFiringRef.current) {
        setPendingDuringFire(wordCount(coalesceRef.current));
        return;
      }

      setPreviewText(pendingRef.current);

      // Fire immediately if a question signal appears AND we have enough words
      if (
        isLikelyQuestion(text) &&
        wordCount(pendingRef.current) >= MIN_WORDS_TO_FIRE
      ) {
        clearTimer();
        // Tiny delay so partial trailing fragment can land
        timerRef.current = setTimeout(() => tryFire("question"), 600);
        return;
      }

      // Otherwise, schedule a long-silence fire
      clearTimer();
      timerRef.current = setTimeout(() => tryFire("silence"), SILENCE_FIRE_MS);
    },
    [tryFire, copilotFiringRef]
  );

  const reset = useCallback(() => {
    pendingRef.current = "";
    coalesceRef.current = "";
    lastSpeakerRef.current = "";
    lastFiredTextRef.current = "";
    clearTimer();
    setPreviewText("");
    setPendingDuringFire(0);
  }, []);

  // Manual flush — called by RESCUE / "burn context"
  const flush = useCallback(() => {
    pendingRef.current = "";
    coalesceRef.current = "";
    clearTimer();
    setPreviewText("");
    setPendingDuringFire(0);
  }, []);

  return {
    accumulate,
    flush,
    reset,
    onLlmComplete,
    previewText,
    pendingDuringFire,
  };
}
