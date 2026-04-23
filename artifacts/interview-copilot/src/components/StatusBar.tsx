import { memo } from "react";
import type { Status } from "../lib/useTranscription";

const STATUS_CONFIG: Record<Status, { label: string; color: string; pulse: boolean }> = {
  idle:         { label: "READY",        color: "#555555", pulse: false },
  mic:          { label: "MIC…",         color: "#ffaa00", pulse: true  },
  auth:         { label: "AUTH…",        color: "#ffaa00", pulse: true  },
  connecting:   { label: "CONNECTING…",  color: "#ffaa00", pulse: true  },
  listening:    { label: "LISTENING",    color: "#00ff88", pulse: true  },
  thinking:     { label: "THINKING…",   color: "#00ccff", pulse: true  },
  streaming:    { label: "STREAMING",   color: "#00ccff", pulse: true  },
  disconnected: { label: "DISCONNECTED", color: "#ffaa00", pulse: false },
  error:        { label: "ERROR",        color: "#ff3344", pulse: false },
  ended:        { label: "ENDED",        color: "#555555", pulse: false },
};

interface StatusBarProps {
  status: Status;
  isActive: boolean;
  partialText: string;
  latency: number;
  turnCount: number;
  error: string | null;
}

export const StatusBar = memo(function StatusBar({
  status,
  isActive,
  partialText,
  latency,
  turnCount,
  error,
}: StatusBarProps) {
  const cfg = STATUS_CONFIG[status] || STATUS_CONFIG.idle;

  return (
    <div className="status-bar">
      <div className="status-left">
        <div
          className={`status-dot ${cfg.pulse ? "status-dot--pulse" : ""}`}
          style={{ background: cfg.color }}
        />
        <span className="status-label" style={{ color: cfg.color }}>
          {cfg.label}
        </span>
        {error && (
          <span className="status-error">⚠ {error}</span>
        )}
      </div>

      <div className="status-center">
        {isActive && partialText && (
          <span className="status-partial">
            &#x22EF; {partialText.slice(0, 80)}{partialText.length > 80 ? "…" : ""}
          </span>
        )}
      </div>

      <div className="status-right">
        {turnCount > 0 && (
          <span className="status-meta">turns: {turnCount}</span>
        )}
        {latency > 0 && (
          <span className="status-meta">last: {(latency / 1000).toFixed(1)}s</span>
        )}
      </div>
    </div>
  );
});
