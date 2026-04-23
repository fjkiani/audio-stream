import { memo } from "react";
import type { CopilotTurn } from "../lib/useCopilotStream";
import { StreamingSection } from "./StreamingSection";

interface HistoricalThreadProps {
  turns: CopilotTurn[];
}

export const HistoricalThread = memo(function HistoricalThread({
  turns,
}: HistoricalThreadProps) {
  if (turns.length === 0) return null;

  return (
    <div className="historical-thread">
      {turns.map((turn, idx) => (
        <div key={turn.id} className="historical-turn">
          <div className="turn-meta">
            <span className="turn-number">#{idx + 1}</span>
            <span className="turn-question">{turn.question.slice(0, 120)}{turn.question.length > 120 ? "…" : ""}</span>
            <span className="turn-latency">{(turn.latencyMs / 1000).toFixed(1)}s</span>
          </div>
          <div className="turn-sections">
            {turn.sections.map((section, i) => (
              <StreamingSection
                key={section.header + i}
                section={{ ...section, done: true }}
                isLast={false}
                isStreaming={false}
              />
            ))}
          </div>
          <div className="turn-divider" />
        </div>
      ))}
    </div>
  );
});
