import { useCallback, useRef, useState } from "react";

type Phase = "idle" | "uploading" | "transcribing" | "done" | "error";

interface TranscriptResult {
  id: string;
  text: string;
  audio_duration: number | null;
  language_code: string | null;
  word_count: number;
  original_filename: string;
  original_size: number;
}

const ACCEPTED = ["audio/", "video/"];
const MAX_BYTES = 200 * 1024 * 1024;

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function formatDuration(seconds: number | null): string {
  if (seconds == null) return "—";
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${s}s`;
}

export default function TranscribePage() {
  const [file, setFile] = useState<File | null>(null);
  const [phase, setPhase] = useState<Phase>("idle");
  const [progress, setProgress] = useState(0);
  const [result, setResult] = useState<TranscriptResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const [copied, setCopied] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const xhrRef = useRef<XMLHttpRequest | null>(null);

  const acceptFile = useCallback((f: File | null | undefined) => {
    setError(null);
    if (!f) return;
    const isMedia = ACCEPTED.some((p) => f.type.startsWith(p));
    if (!isMedia && f.type !== "") {
      setError(`Unsupported file type: ${f.type}. Please upload an audio or video file.`);
      return;
    }
    if (f.size > MAX_BYTES) {
      setError(`File too large (${formatBytes(f.size)}). Max is 200 MB.`);
      return;
    }
    setFile(f);
    setResult(null);
    setPhase("idle");
  }, []);

  const onPickClick = () => inputRef.current?.click();
  const onInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    acceptFile(e.target.files?.[0]);
  };
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    acceptFile(e.dataTransfer.files?.[0]);
  };
  const onDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);

  const transcribe = useCallback(() => {
    if (!file) return;
    setPhase("uploading");
    setProgress(0);
    setError(null);
    setResult(null);

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
          const data = JSON.parse(xhr.responseText) as TranscriptResult;
          setResult(data);
          setPhase("done");
        } catch {
          setError("Could not parse response.");
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
  }, [file]);

  const cancel = () => {
    xhrRef.current?.abort();
    xhrRef.current = null;
    setPhase("idle");
    setProgress(0);
  };

  const reset = () => {
    setFile(null);
    setResult(null);
    setError(null);
    setPhase("idle");
    setProgress(0);
    if (inputRef.current) inputRef.current.value = "";
  };

  const copyText = async () => {
    if (!result?.text) return;
    try {
      await navigator.clipboard.writeText(result.text);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      setError("Clipboard not available in this context.");
    }
  };

  const downloadTxt = () => {
    if (!result?.text) return;
    const blob = new Blob([result.text], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const base = result.original_filename.replace(/\.[^.]+$/, "");
    a.download = `${base}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const isWorking = phase === "uploading" || phase === "transcribing";

  return (
    <div className="tx-shell">
      <header className="tx-header">
        <div className="tx-brand">
          <span className="tx-mark">⏵</span>
          <span className="tx-name">SCRIBE</span>
        </div>
        <div className="tx-tag">audio → text · powered by AssemblyAI</div>
      </header>

      <main className="tx-main">
        {phase === "idle" && !file && (
          <div className="tx-drop-wrap">
            <div
              className={`tx-drop ${dragOver ? "tx-drop--over" : ""}`}
              onDrop={onDrop}
              onDragOver={onDragOver}
              onDragLeave={onDragLeave}
              onClick={onPickClick}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => (e.key === "Enter" || e.key === " ") && onPickClick()}
            >
              <div className="tx-drop-icon">⤓</div>
              <p className="tx-drop-title">Drop an audio or video file here</p>
              <p className="tx-drop-sub">or click to browse — up to 200 MB</p>
              <p className="tx-drop-formats">mp3 · wav · m4a · ogg · webm · mp4 · mov</p>
              <input
                ref={inputRef}
                type="file"
                accept="audio/*,video/*"
                hidden
                onChange={onInputChange}
              />
            </div>
            {error && <div className="tx-error tx-error--standalone">⚠ {error}</div>}
          </div>
        )}

        {file && phase !== "done" && (
          <div className="tx-card">
            <div className="tx-file-row">
              <div className="tx-file-icon">♪</div>
              <div className="tx-file-meta">
                <div className="tx-file-name" title={file.name}>{file.name}</div>
                <div className="tx-file-info">
                  {formatBytes(file.size)} · {file.type || "unknown type"}
                </div>
              </div>
              {phase === "idle" && (
                <button className="tx-btn-ghost" onClick={reset} type="button">
                  Change
                </button>
              )}
            </div>

            {isWorking && (
              <div className="tx-progress">
                <div className="tx-progress-label">
                  {phase === "uploading" ? `Uploading… ${progress}%` : "Transcribing — this can take a moment for long files"}
                </div>
                <div className="tx-progress-bar">
                  <div
                    className={`tx-progress-fill ${phase === "transcribing" ? "tx-progress-fill--indeterminate" : ""}`}
                    style={phase === "uploading" ? { width: `${progress}%` } : undefined}
                  />
                </div>
              </div>
            )}

            {error && <div className="tx-error">⚠ {error}</div>}

            <div className="tx-actions">
              {phase === "idle" && (
                <button className="tx-btn-primary" onClick={transcribe} type="button">
                  ⏵ Transcribe
                </button>
              )}
              {isWorking && (
                <button className="tx-btn-ghost" onClick={cancel} type="button">
                  Cancel
                </button>
              )}
              {phase === "error" && (
                <>
                  <button className="tx-btn-primary" onClick={transcribe} type="button">
                    Retry
                  </button>
                  <button className="tx-btn-ghost" onClick={reset} type="button">
                    Start over
                  </button>
                </>
              )}
            </div>
          </div>
        )}

        {phase === "done" && result && (
          <div className="tx-result">
            <div className="tx-result-head">
              <div>
                <div className="tx-result-title">Transcript</div>
                <div className="tx-result-meta">
                  {result.original_filename} ·{" "}
                  {formatDuration(result.audio_duration)} · {result.word_count} words
                  {result.language_code ? ` · ${result.language_code}` : ""}
                </div>
              </div>
              <div className="tx-result-actions">
                <button className="tx-btn-ghost" onClick={copyText} type="button">
                  {copied ? "✓ Copied" : "Copy"}
                </button>
                <button className="tx-btn-ghost" onClick={downloadTxt} type="button">
                  Download .txt
                </button>
                <button className="tx-btn-primary" onClick={reset} type="button">
                  New file
                </button>
              </div>
            </div>
            <div className="tx-transcript">
              {result.text || <span className="tx-transcript-empty">No speech detected.</span>}
            </div>
          </div>
        )}
      </main>
    </div>
  );
}
