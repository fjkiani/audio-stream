import { useState, useCallback, useRef, useEffect } from "react";
import { useTranscription } from "../lib/useTranscription";
import { StatusBar } from "../components/StatusBar";
import { ControlBar } from "../components/ControlBar";
import { HistoricalThread } from "../components/HistoricalThread";
import { StreamingResponse } from "../components/StreamingSection";

type Capabilities = {
  autoCopilot: boolean;
  terminalMode: boolean;
  clipboardCapture: boolean;
  keyterms: boolean;
};

export default function CopilotPage() {
  const [capabilities, setCapabilities] = useState<Capabilities>({
    autoCopilot: true,
    terminalMode: false,
    clipboardCapture: true,
    keyterms: true,
  });

  const toggle = useCallback((key: string) => {
    setCapabilities((prev) => ({ ...prev, [key]: !prev[key as keyof Capabilities] }));
  }, []);

  const {
    isActive,
    status,
    error,
    transcripts,
    partialText,
    pendingDuringFire,
    systemAudioOn,
    copilot,
    start,
    stop,
    triggerRescue,
    flushContext,
  } = useTranscription(capabilities);

  // Follow-up generator
  const [followUp, setFollowUp] = useState("");
  const [followUpLoading, setFollowUpLoading] = useState(false);

  const generateFollowUp = useCallback(async () => {
    setFollowUpLoading(true);
    setFollowUp("");
    try {
      const history = copilot.history.map((h) => ({
        question: h.question,
        bullets: h.sections.map((s) => s.content),
        rawResponse: h.rawResponse,
      }));

      const res = await fetch("/api/followup", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ history, profilerState: null }),
      });

      if (!res.ok) throw new Error(`HTTP ${res.status}`);

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let fullText = "";

      while (true) {
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
            const event = JSON.parse(jsonStr) as { token?: string; done?: boolean; error?: string };
            if (event.done) break;
            if (event.error) throw new Error(event.error);
            if (event.token) {
              fullText += event.token;
              setFollowUp(fullText);
            }
          } catch {}
        }
      }
    } catch (e) {
      setFollowUp(`⚠ ${e instanceof Error ? e.message : "Error generating follow-up"}`);
    } finally {
      setFollowUpLoading(false);
    }
  }, [copilot.history]);

  // Scroll thread to bottom when history or streaming updates
  const threadRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  }, [copilot.history, copilot.streamingSections, copilot.streamingRaw]);

  // Auto-scroll the live transcript feed
  useEffect(() => {
    const el = document.querySelector(".transcript-feed");
    if (el) el.scrollTop = el.scrollHeight;
  }, [transcripts.length, partialText]);

  // Keyboard shortcuts
  useEffect(() => {
    const handle = (e: KeyboardEvent) => {
      // SPACE = rescue (bypass debounce)
      if (e.code === "Space" && e.target === document.body && isActive) {
        e.preventDefault();
        triggerRescue();
      }
      // BACKSPACE = burn it
      if (e.code === "Backspace" && e.target === document.body) {
        e.preventDefault();
        flushContext();
      }
    };
    window.addEventListener("keydown", handle);
    return () => window.removeEventListener("keydown", handle);
  }, [isActive, triggerRescue, flushContext]);

  const isStreaming = copilot.isStreaming;
  const hasSections = copilot.streamingSections.length > 0;
  const hasHistory = copilot.history.length > 0;

  return (
    <div className="copilot-root">
      <header className="copilot-header">
        <div className="header-brand">
          <span className="brand-mark">⬡</span>
          <span className="brand-name">ZETA-CORE</span>
        </div>
        <StatusBar
          status={status}
          isActive={isActive}
          partialText={partialText}
          latency={copilot.latency}
          turnCount={copilot.history.length}
          error={error}
          pendingDuringFire={pendingDuringFire}
          systemAudioOn={systemAudioOn}
        />
      </header>

      <ControlBar
        isActive={isActive}
        hasHistory={hasHistory}
        onStart={start}
        onStop={stop}
        onRescue={triggerRescue}
        onFlush={flushContext}
        onFollowUp={generateFollowUp}
        followUpLoading={followUpLoading}
        capabilities={capabilities}
        onToggle={toggle}
      />

      {/* Live transcript — always visible, sticky between controls and thread */}
      {(isActive || transcripts.length > 0) && (
        <div className="transcript-panel">
          <div className="transcript-panel-header">
            <span className="transcript-panel-title">⏵ LIVE TRANSCRIPT</span>
            <span className="transcript-panel-count">{transcripts.length} turns captured</span>
          </div>
          <div className="transcript-feed">
            {transcripts.length === 0 && !partialText && (
              <div className="transcript-empty">Waiting for audio…</div>
            )}
            {transcripts.slice(-8).map((t) => (
              <div
                key={t.id}
                className={`transcript-line transcript-line--${t.speaker}`}
              >
                <span className="transcript-speaker">
                  {t.speaker === "interviewer" ? "I" : t.speaker === "candidate" ? "C" : "?"}
                </span>
                <span className="transcript-text">{t.text}</span>
              </div>
            ))}
            {partialText && (
              <div className="transcript-line transcript-line--partial">
                <span className="transcript-speaker">●</span>
                <span className="transcript-text">
                  {partialText}
                  <span className="stream-cursor" />
                </span>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="copilot-thread" ref={threadRef}>
        {/* Empty state */}
        {!isActive && !hasHistory && !isStreaming && (
          <div className="empty-state">
            <div className="empty-icon">⬡</div>
            <p className="empty-title">Interview Copilot Ready</p>
            <p className="empty-sub">Click START, then speak or play audio.</p>
            <div className="empty-shortcuts">
              <div className="shortcut"><kbd>SPACE</kbd> SOS rescue</div>
              <div className="shortcut"><kbd>⌫</kbd> Burn context</div>
            </div>
          </div>
        )}

        {/* Historical turns (frozen, memo'd) */}
        <HistoricalThread turns={copilot.history} />

        {/* Live streaming response — hot path, updates every token */}
        {(isStreaming || hasSections) && (
          <StreamingResponse
            sections={copilot.streamingSections}
            raw={copilot.streamingRaw}
            isStreaming={isStreaming}
            question={copilot.activeQuestion}
          />
        )}

        {/* Follow-up panel */}
        {followUp && (
          <div className="followup-panel">
            <div className="followup-header">
              <span className="followup-label">✉ FOLLOW-UP QUESTIONS</span>
              <button
                className="btn btn--small"
                onClick={() => navigator.clipboard.writeText(followUp).catch(() => {})}
              >
                Copy
              </button>
            </div>
            <pre className="followup-content">{followUp}</pre>
          </div>
        )}
      </div>

      {/* Listening pulse when active but silent */}
      {isActive && !isStreaming && !hasSections && (
        <div className="listen-bar">
          {[...Array(12)].map((_, i) => (
            <div
              key={i}
              className="listen-bar__segment"
              style={{ animationDelay: `${i * 0.08}s` }}
            />
          ))}
        </div>
      )}
    </div>
  );
}
