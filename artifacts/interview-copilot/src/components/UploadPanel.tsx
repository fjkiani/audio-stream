import { useCallback, useRef, useState } from "react";

const MAX_BYTES = 200 * 1024 * 1024;

interface Props {
  onSaved: (id: string) => void;
}

type Phase = "idle" | "uploading" | "transcribing" | "error";

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

export default function UploadPanel({ onSaved }: Props) {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const acceptFile = useCallback((f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    const ok = f.type.startsWith("audio/") || f.type.startsWith("video/") || f.type === "";
    if (!ok) {
      setError(`Unsupported file type: ${f.type}.`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`File too large (${formatBytes(f.size)}). Max 200 MB.`);
      return;
    }
    setFile(f);
    setPhase("idle");
  }, []);

  const reset = () => {
    setFile(null);
    setError(null);
    setPhase("idle");
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  };

  const upload = useCallback(() => {
    if (!file) return;
    setPhase("uploading");
    setProgress(0);
    setError(null);

    const fd = new FormData();
    fd.append("audio", file);

    const xhr = new XMLHttpRequest();
    xhrRef.current = xhr;
    xhr.open("POST", "/api/transcribe");

    xhr.upload.onprogress = (evt) => {
      if (evt.lengthComputable) {
        setProgress(Math.round((evt.loaded / evt.total) * 100));
      }
    };
    xhr.upload.onload = () => {
      setProgress(100);
      setPhase("transcribing");
    };
    xhr.onerror = () => {
      setError("Network error during upload.");
      setPhase("error");
    };
    xhr.onload = () => {
      xhrRef.current = null;
      if (xhr.status >= 200 && xhr.status < 300) {
        try {
          const data = JSON.parse(xhr.responseText) as { id: string };
          reset();
          onSaved(data.id);
        } catch {
          setError("Bad response from server.");
          setPhase("error");
        }
      } else {
        try {
          const data = JSON.parse(xhr.responseText) as { error?: string };
          setError(data.error ?? `Server error (${xhr.status}).`);
        } catch {
          setError(`Server error (${xhr.status}).`);
        }
        setPhase("error");
      }
    };
    xhr.send(fd);
  }, [file, onSaved]);

  const cancel = () => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setPhase("idle");
    setProgress(0);
  };

  const isWorking = phase === "uploading" || phase === "transcribing";

  return (
    <div className="up-shell">
      <div className="up-head">
        <h2>New transcription</h2>
        <p className="up-subtitle">Upload an audio or video file — it'll be saved to your library.</p>
      </div>

      {!file && (
        <div
          className={`up-drop ${dragOver ? "up-drop--over" : ""}`}
          onClick={() => inputRef.current?.click()}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            acceptFile(e.dataTransfer.files?.[0]);
          }}
          role="button"
          tabIndex={0}
        >
          <div className="up-drop-icon">⤓</div>
          <div className="up-drop-title">Drop a file here or click to browse</div>
          <div className="up-drop-sub">up to 200 MB · mp3 · wav · m4a · ogg · mp4 · mov · webm</div>
          <input
            ref={inputRef}
            type="file"
            hidden
            accept="audio/*,video/*"
            onChange={(e) => acceptFile(e.target.files?.[0])}
          />
        </div>
      )}

      {file && (
        <div className="up-card">
          <div className="up-file-row">
            <div className="up-file-icon">♪</div>
            <div className="up-file-meta">
              <div className="up-file-name" title={file.name}>{file.name}</div>
              <div className="up-file-info">{formatBytes(file.size)} · {file.type || "unknown"}</div>
            </div>
            {phase === "idle" && (
              <button type="button" className="btn-ghost" onClick={reset}>Change</button>
            )}
          </div>

          {isWorking && (
            <div className="up-progress">
              <div className="up-progress-label">
                {phase === "uploading"
                  ? `Uploading… ${progress}%`
                  : "Transcribing — this can take a moment for long files"}
              </div>
              <div className="up-progress-bar">
                <div
                  className={`up-progress-fill ${phase === "transcribing" ? "up-progress-fill--indet" : ""}`}
                  style={phase === "uploading" ? { width: `${progress}%` } : undefined}
                />
              </div>
            </div>
          )}

          <div className="up-actions">
            {phase === "idle" && (
              <button type="button" className="btn-primary" onClick={upload}>
                ⏵ Transcribe & Save
              </button>
            )}
            {isWorking && (
              <button type="button" className="btn-ghost" onClick={cancel}>Cancel</button>
            )}
            {phase === "error" && (
              <>
                <button type="button" className="btn-primary" onClick={upload}>Retry</button>
                <button type="button" className="btn-ghost" onClick={reset}>Start over</button>
              </>
            )}
          </div>
        </div>
      )}

      {error && <div className="ux-error">⚠ {error}</div>}
    </div>
  );
}
