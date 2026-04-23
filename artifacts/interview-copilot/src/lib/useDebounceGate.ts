/**
 * useDebounceGate — accumulates end-of-turn transcripts and fires the copilot
 *
 * Improvements over original:
 * - Echo detection uses significant-word matching to avoid re-firing on
 *   Alpha reading the copilot's own output aloud
 * - Copilot cooldown prevents rapid re-fires after each response
 * - Minimum word gate skips filler ("okay", "yeah", "alright")
 */

import { useRef, useState, useCallback } from "react";

const DEBOUNCE_MS = 7000;
const REQUEUE_MS = 2000;
const MIN_WORDS = 5;
const ECHO_THRESHOLD = 0.70;
const MIN_WORD_LEN = 6;

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
  const accumulatedRef = useRef("");
  const speakerRef = useRef("interviewer");
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [previewText, setPreviewText] = useState("");

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
      for (const w of transcriptWords) {
        if (outputWords.has(w)) matches++;
      }
      return matches / transcriptWords.size >= ECHO_THRESHOLD;
    },
    [lastOutputRef]
  );

  const flush = useCallback(() => {
    const fullQuestion = accumulatedRef.current.trim();
    const speaker = speakerRef.current;

    if (copilotFiringRef.current) {
      timerRef.current = setTimeout(flush, REQUEUE_MS);
      return;
    }

    accumulatedRef.current = "";
    timerRef.current = null;
    setPreviewText("");

    if (!fullQuestion || !isStreamingRef.current) return;

    const wordCount = fullQuestion.split(/\s+/).filter((w) => w.length > 0).length;
    if (wordCount < MIN_WORDS) return;

    if (isEcho(fullQuestion)) return;

    if (autoCopilot) {
      onFire(fullQuestion, speaker);
    }
  }, [onFire, autoCopilot, copilotFiringRef, isStreamingRef, isEcho]);

  const accumulate = useCallback(
    (text: string, speaker = "interviewer") => {
      const prev = accumulatedRef.current;
      accumulatedRef.current = prev ? `${prev} ${text}` : text;
      speakerRef.current = speaker;
      setPreviewText(accumulatedRef.current);

      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(flush, DEBOUNCE_MS);
    },
    [flush]
  );

  const reset = useCallback(() => {
    accumulatedRef.current = "";
    speakerRef.current = "interviewer";
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    setPreviewText("");
  }, []);

  return { accumulate, flush, reset, previewText };
}
