/**
 * StreamingSection — Progressive section renderer
 *
 * KEY FIX: Each section ([MOTIVE], [THE MOVE], etc.) appears and fills in
 * progressively as tokens arrive, rather than the entire response appearing
 * at once. A blinking cursor shows where the LLM is currently writing.
 */

import { memo } from "react";
import type { CopilotSection } from "../lib/useCopilotStream";

interface StreamingSectionProps {
  section: CopilotSection;
  isLast: boolean;
  isStreaming: boolean;
}

const SECTION_COLORS: Record<string, string> = {
  "[MOTIVE]": "#00ff88",
  "[DELIVERY]": "#ffaa00",
  "[THE MOVE]": "#00ccff",
  "[THE BAIT]": "#ff6b6b",
  "[THE DIAGNOSTIC]": "#cc88ff",
  "[ALPHA IS SPEAKING]": "#ffaa00",
  "[STRENGTHEN]": "#00ccff",
  "[WATCH OUT]": "#ff6b6b",
  "[COURSE CORRECT]": "#ff3344",
  "[THE PIVOT MOVE]": "#00ccff",
  "[ALGORITHM]": "#00ff88",
  "[COMPLEXITY]": "#ffaa00",
  "[EDGE CASES]": "#ff6b6b",
  "[THE CODE]": "#00ccff",
  "[RESCUE]": "#ff3344",
  "[THE PIVOT]": "#00ccff",
  "[ERROR]": "#ff3344",
};

function formatContent(content: string): React.ReactNode {
  const lines = content.split("\n");
  return lines.map((line, i) => {
    const trimmed = line.trim();
    const isBullet = trimmed.startsWith("- ") || trimmed.startsWith("• ");
    const isCode = trimmed.startsWith("```") || trimmed.startsWith("    ");

    if (!trimmed && i !== lines.length - 1) {
      return <div key={i} className="section-line-gap" />;
    }

    if (isBullet) {
      const text = trimmed.slice(2);
      return (
        <div key={i} className="section-bullet">
          <span className="bullet-marker">▸</span>
          <span className="bullet-text">{text}</span>
        </div>
      );
    }

    if (isCode) {
      return (
        <div key={i} className="section-code-line">
          {line}
        </div>
      );
    }

    return (
      <div key={i} className="section-text-line">
        {line}
      </div>
    );
  });
}

export const StreamingSection = memo(function StreamingSection({
  section,
  isLast,
  isStreaming,
}: StreamingSectionProps) {
  const color = SECTION_COLORS[section.header] || "#e0e0e0";
  const showCursor = isLast && isStreaming && !section.done;

  return (
    <div className="response-section" style={{ "--section-color": color } as React.CSSProperties}>
      <div className="section-header" style={{ color }}>
        {section.header}
      </div>
      <div className="section-body">
        {formatContent(section.content)}
        {showCursor && <span className="stream-cursor" aria-hidden="true" />}
      </div>
    </div>
  );
});

interface StreamingResponseProps {
  sections: CopilotSection[];
  raw: string;
  isStreaming: boolean;
  question: string;
}

export const StreamingResponse = memo(function StreamingResponse({
  sections,
  raw,
  isStreaming,
  question,
}: StreamingResponseProps) {
  if (!isStreaming && sections.length === 0 && !raw) return null;

  return (
    <div className="streaming-response">
      {question && (
        <div className="response-question">
          <span className="question-label">Q</span>
          <span className="question-text">{question}</span>
        </div>
      )}

      {sections.length > 0 ? (
        <div className="response-sections">
          {sections.map((section, i) => (
            <StreamingSection
              key={section.header + i}
              section={section}
              isLast={i === sections.length - 1}
              isStreaming={isStreaming}
            />
          ))}
        </div>
      ) : isStreaming ? (
        <div className="response-thinking">
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-dot" />
          <span className="thinking-label">Analyzing…</span>
        </div>
      ) : null}
    </div>
  );
});
