/**
 * useCopilotStream — Progressive LLM streaming
 *
 * KEY FIX: Instead of buffering all tokens and rendering at the end, we now:
 * 1. Yield each token immediately to the UI as it arrives
 * 2. Parse structured sections ([MOTIVE], [THE MOVE], etc.) progressively
 * 3. Strip <THINK>/<PLAN> blocks in real-time so they never flash to the user
 * 4. Animate new text via CSS so the user sees the response "typing" in
 */

import { useRef, useState, useCallback } from "react";

export interface CopilotSection {
  header: string;   // e.g. "[THE MOVE]"
  content: string;  // accumulated text under this header (grows as tokens arrive)
  done: boolean;    // true once the next section header has started
}

export interface CopilotTurn {
  id: number;
  question: string;
  sections: CopilotSection[];
  rawResponse: string;
  latencyMs: number;
  timestamp: number;
}

const SECTION_HEADERS = [
  "[MOTIVE]", "[DELIVERY]", "[THE MOVE]", "[THE BAIT]", "[THE DIAGNOSTIC]",
  "[ALPHA IS SPEAKING]", "[STRENGTHEN]", "[WATCH OUT]",
  "[COURSE CORRECT]", "[THE PIVOT MOVE]",
  "[ALGORITHM]", "[COMPLEXITY]", "[EDGE CASES]", "[THE CODE]",
  "[RESCUE]", "[THE PIVOT]",
];

/** Strip <THINK>…</THINK> and <PLAN>…</PLAN> — including incomplete blocks mid-stream */
function stripHidden(text: string): string {
  return text
    .replace(/<THINK>[\s\S]*?<\/THINK>\s*/g, "")
    .replace(/<PLAN>[\s\S]*?<\/PLAN>\s*/g, "")
    .replace(/<THINK>[\s\S]*$/, "")
    .replace(/<PLAN>[\s\S]*$/, "")
    .trim();
}

/**
 * Parse the current accumulated visible text into structured sections.
 * Called on every token — cheap enough since responses are < 2KB.
 */
function parseSections(text: string): CopilotSection[] {
  const sections: CopilotSection[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    // Find the earliest section header
    let earliestIdx = -1;
    let earliestHeader = "";
    for (const header of SECTION_HEADERS) {
      const idx = remaining.indexOf(header);
      if (idx !== -1 && (earliestIdx === -1 || idx < earliestIdx)) {
        earliestIdx = idx;
        earliestHeader = header;
      }
    }

    if (earliestIdx === -1) {
      // No section header found — treat as preamble or append to last section
      if (sections.length > 0) {
        sections[sections.length - 1].content += remaining;
      }
      break;
    }

    // Text before the first header (skip preamble)
    remaining = remaining.slice(earliestIdx + earliestHeader.length);

    // Find where this section ends (at the next header)
    let endIdx = remaining.length;
    for (const header of SECTION_HEADERS) {
      const idx = remaining.indexOf(header);
      if (idx !== -1 && idx < endIdx) {
        endIdx = idx;
      }
    }

    const content = remaining.slice(0, endIdx).trim();
    sections.push({
      header: earliestHeader,
      content,
      done: endIdx < remaining.length, // More sections follow = this one is done
    });
    remaining = remaining.slice(endIdx);
  }

  return sections;
}

const BOOKEND_ANCHOR = 2;
const ACTIVE_WINDOW = 4;
const COOLDOWN_MS = 3000;

export function useCopilotStream() {
  // Live streaming state
  const [streamingSections, setStreamingSections] = useState<CopilotSection[]>([]);
  const [streamingRaw, setStreamingRaw] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [latency, setLatency] = useState(0);
  const [activeQuestion, setActiveQuestion] = useState("");

  // History of completed turns
  const [history, setHistory] = useState<CopilotTurn[]>([]);
  const historyRef = useRef<CopilotTurn[]>([]);

  const copilotFiringRef = useRef(false);
  const cooldownUntilRef = useRef(0);
  const lastOutputRef = useRef(""); // for echo detection in debounce gate

  const getHistory = useCallback(() => {
    const all = historyRef.current;
    if (all.length <= BOOKEND_ANCHOR + ACTIVE_WINDOW) return all;
    return [...all.slice(0, BOOKEND_ANCHOR), ...all.slice(-ACTIVE_WINDOW)];
  }, []);

  const fire = useCallback(
    async (
      question: string,
      speaker: string,
      opts: {
        profilerState?: Record<string, unknown> | null;
        clipboardCode?: string;
        terminalMode?: boolean;
        isRambling?: boolean;
        isRescue?: boolean;
      } = {}
    ) => {
      if (copilotFiringRef.current) return;
      copilotFiringRef.current = true;
      setIsStreaming(true);
      setActiveQuestion(question);
      setStreamingSections([]);
      setStreamingRaw("");

      const start = Date.now();
      let fullRaw = "";
      let aborted = false;

      try {
        const historyPayload = getHistory().map((h) => ({
          question: h.question,
          rawResponse: h.rawResponse,
        }));

        const res = await fetch("/api/copilot", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            text: question,
            speaker,
            history: historyPayload,
            profilerState: opts.profilerState || null,
            clipboardCode: opts.clipboardCode || "",
            terminalMode: opts.terminalMode || false,
            clientTelemetry: {
              isRambling: opts.isRambling || false,
              isRescue: opts.isRescue || false,
            },
          }),
        });

        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }

        const reader = res.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (!aborted) {
          const { value, done } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed.startsWith("data:")) continue;
            const jsonStr = trimmed.slice(5).trim();
            if (!jsonStr) continue;

            try {
              const event = JSON.parse(jsonStr) as {
                token?: string;
                done?: boolean;
                error?: string;
              };

              if (event.error) throw new Error(event.error);
              if (event.done) { aborted = true; break; }

              if (event.token) {
                fullRaw += event.token;
                const visible = stripHidden(fullRaw);
                const sections = parseSections(visible);

                // Batched state update: sections + raw in one render
                setStreamingRaw(visible || "Analyzing...");
                setStreamingSections(sections.length > 0 ? sections : []);
              }
            } catch (parseErr) {
              if (parseErr instanceof Error && parseErr.message !== "Unexpected end") {
                throw parseErr;
              }
            }
          }
        }

        const ms = Date.now() - start;
        setLatency(ms);

        const visible = stripHidden(fullRaw);
        const finalSections = parseSections(visible);

        if (fullRaw.trim().length > 0) {
          const turn: CopilotTurn = {
            id: Date.now(),
            question,
            sections: finalSections,
            rawResponse: fullRaw,
            latencyMs: ms,
            timestamp: Date.now(),
          };
          historyRef.current.push(turn);
          setHistory([...historyRef.current]);
        }

        lastOutputRef.current = visible;
        cooldownUntilRef.current = Date.now() + COOLDOWN_MS;

        // CRITICAL: clear streaming state once it's safely in history,
        // otherwise <StreamingResponse> + <HistoricalThread> both render the same turn.
        setStreamingSections([]);
        setStreamingRaw("");
        setActiveQuestion("");
      } catch (err) {
        const msg = err instanceof Error ? err.message : "Unknown error";
        setStreamingSections([{ header: "[ERROR]", content: `⚠ ${msg}`, done: true }]);
        setStreamingRaw("");
        setActiveQuestion("");
      } finally {
        setIsStreaming(false);
        copilotFiringRef.current = false;
      }
    },
    [getHistory]
  );

  const flush = useCallback(() => {
    setStreamingSections([]);
    setStreamingRaw("");
    setActiveQuestion("");
    if (historyRef.current.length > 0) {
      historyRef.current.pop();
      setHistory([...historyRef.current]);
    }
  }, []);

  const reset = useCallback(() => {
    setStreamingSections([]);
    setStreamingRaw("");
    setIsStreaming(false);
    setLatency(0);
    setActiveQuestion("");
    setHistory([]);
    historyRef.current = [];
    copilotFiringRef.current = false;
    cooldownUntilRef.current = 0;
    lastOutputRef.current = "";
  }, []);

  return {
    fire,
    flush,
    reset,
    streamingSections,
    streamingRaw,
    isStreaming,
    latency,
    activeQuestion,
    history,
    copilotFiringRef,
    cooldownUntilRef,
    lastOutputRef,
  };
}
