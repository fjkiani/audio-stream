import { memo } from "react";

interface ControlBarProps {
  isActive: boolean;
  hasHistory: boolean;
  onStart: () => void;
  onStop: () => void;
  onRescue: () => void;
  onFlush: () => void;
  onFollowUp: () => void;
  followUpLoading: boolean;
  capabilities: {
    autoCopilot: boolean;
    terminalMode: boolean;
    clipboardCapture: boolean;
    keyterms: boolean;
  };
  onToggle: (key: string) => void;
}

export const ControlBar = memo(function ControlBar({
  isActive,
  hasHistory,
  onStart,
  onStop,
  onRescue,
  onFlush,
  onFollowUp,
  followUpLoading,
  capabilities,
  onToggle,
}: ControlBarProps) {
  return (
    <div className="control-bar">
      <div className="control-primary">
        {!isActive ? (
          <button className="btn btn--start" onClick={onStart}>
            ▶ START
          </button>
        ) : (
          <>
            <button className="btn btn--stop" onClick={onStop}>
              ■ STOP
            </button>
            <button className="btn btn--rescue" onClick={onRescue} title="Spacebar">
              🆘 RESCUE
            </button>
            <button className="btn btn--burn" onClick={onFlush} title="Backspace">
              🔥 BURN
            </button>
          </>
        )}

        {hasHistory && !isActive && (
          <button
            className="btn btn--followup"
            onClick={onFollowUp}
            disabled={followUpLoading}
          >
            {followUpLoading ? "⏳ Generating…" : "✉ Follow-Up"}
          </button>
        )}
      </div>

      <div className="control-toggles">
        <ToggleChip
          label="Auto"
          active={capabilities.autoCopilot}
          onClick={() => onToggle("autoCopilot")}
          title="Auto-fire copilot on silence"
        />
        <ToggleChip
          label="Terminal"
          active={capabilities.terminalMode}
          onClick={() => onToggle("terminalMode")}
          title="Code-focused HUD mode"
        />
        <ToggleChip
          label="Clipboard"
          active={capabilities.clipboardCapture}
          onClick={() => onToggle("clipboardCapture")}
          title="Capture code from Cmd+C"
        />
        <ToggleChip
          label="Keyterms"
          active={capabilities.keyterms}
          onClick={() => onToggle("keyterms")}
          title="Domain vocabulary for STT"
        />
      </div>
    </div>
  );
});

function ToggleChip({
  label,
  active,
  onClick,
  title,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  title: string;
}) {
  return (
    <button
      className={`toggle-chip ${active ? "toggle-chip--on" : ""}`}
      onClick={onClick}
      title={title}
    >
      <span className="chip-dot" />
      {label}
    </button>
  );
}
