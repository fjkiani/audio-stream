import { useCallback, useEffect, useRef, useState } from "react";

type Status =
  | "idle"
  | "requesting-mic"
  | "connecting"
  | "live"
  | "stopping"
  | "stopped"
  | "error";

interface FinalSegment {
  id: number;
  text: string;
}

interface ServerMsg {
  type: string;
  text?: string;
  turn_order?: number;
  message?: string;
  audio_duration_seconds?: number | null;
  id?: string;
  title?: string;
  word_count?: number;
}

interface LivePanelProps {
  onSaved: (id: string) => void;
}

const PCM_WORKLET_URL = `${import.meta.env.BASE_URL}audio-processor.js`;

function buildWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/api/live`;
}

export default function LivePanel({ onSaved }: LivePanelProps) {
  const [status, setStatus] = useState<Status>("idle");
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [partial, setPartial] = useState("");
  const [finals, setFinals] = useState<FinalSegment[]>([]);
  const [title, setTitle] = useState("");
  const [savedId, setSavedId] = useState<string | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [audioLevel, setAudioLevel] = useState(0);

  const wsRef = useRef<WebSocket | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const nodeRef = useRef<AudioWorkletNode | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const tickRef = useRef<number | null>(null);

  /** Hard tear-down of every audio + WS resource. Safe to call repeatedly. */
  const cleanup = useCallback(() => {
    if (tickRef.current !== null) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
      nodeRef.current = null;
    }
    if (ctxRef.current) {
      void ctxRef.current.close().catch(() => {});
      ctxRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
      streamRef.current = null;
    }
    if (wsRef.current) {
      try {
        if (
          wsRef.current.readyState === WebSocket.OPEN ||
          wsRef.current.readyState === WebSocket.CONNECTING
        ) {
          wsRef.current.close();
        }
      } catch {
        /* ignore */
      }
      wsRef.current = null;
    }
  }, []);

  useEffect(() => {
    return () => cleanup();
  }, [cleanup]);

  const start = useCallback(async () => {
    setErrorMsg(null);
    setSavedId(null);
    setFinals([]);
    setPartial("");
    setElapsed(0);
    setStatus("requesting-mic");

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      streamRef.current = stream;

      // AudioContext at 16kHz when supported (Chromium honours this; Safari
      // ignores and runs at hardware rate — the worklet handles downsampling).
      let ctx: AudioContext;
      try {
        ctx = new AudioContext({ sampleRate: 16000 });
      } catch {
        ctx = new AudioContext();
      }
      ctxRef.current = ctx;
      await ctx.audioWorklet.addModule(PCM_WORKLET_URL);

      const source = ctx.createMediaStreamSource(stream);
      const node = new AudioWorkletNode(ctx, "pcm-processor");
      nodeRef.current = node;
      source.connect(node);
      // Don't connect to ctx.destination — we don't want loopback playback.

      // Open WS to our backend bridge.
      setStatus("connecting");
      const ws = new WebSocket(buildWsUrl());
      ws.binaryType = "arraybuffer";
      wsRef.current = ws;

      ws.onopen = () => {
        // Wire the worklet → WS pipe only once the socket is open.
        node.port.onmessage = (ev: MessageEvent<ArrayBuffer>) => {
          if (ws.readyState === WebSocket.OPEN) {
            ws.send(ev.data);
          }
        };
        // Cheap volume meter: separate analyser tap.
        try {
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);
          const buf = new Uint8Array(analyser.fftSize);
          const sample = () => {
            analyser.getByteTimeDomainData(buf);
            let peak = 0;
            for (let i = 0; i < buf.length; i++) {
              const v = Math.abs(buf[i] - 128);
              if (v > peak) peak = v;
            }
            setAudioLevel(Math.min(1, peak / 64));
          };
          tickRef.current = window.setInterval(() => {
            sample();
            if (startedAtRef.current !== null) {
              setElapsed(Math.floor((Date.now() - startedAtRef.current) / 1000));
            }
          }, 100);
        } catch {
          /* ignore meter failures */
        }
      };

      ws.onmessage = (ev: MessageEvent<string>) => {
        let msg: ServerMsg;
        try {
          msg = JSON.parse(ev.data) as ServerMsg;
        } catch {
          return;
        }
        switch (msg.type) {
          case "ready":
            // Upstream WS is open and authenticated.
            break;
          case "begin":
            setStatus("live");
            startedAtRef.current = Date.now();
            break;
          case "partial":
            setPartial(msg.text ?? "");
            break;
          case "final":
            if ((msg.text ?? "").trim()) {
              setFinals((prev) => [
                ...prev,
                { id: msg.turn_order ?? prev.length, text: msg.text! },
              ]);
            }
            setPartial("");
            break;
          case "error":
            setErrorMsg(msg.message ?? "Live transcription error.");
            setStatus("error");
            break;
          case "upstream_closed":
            // AssemblyAI closed on us — could be auth, quota, idle.
            if (status !== "stopping" && status !== "stopped") {
              setErrorMsg(
                msg.message ??
                  `AssemblyAI closed the connection${
                    msg.audio_duration_seconds
                      ? ` after ${Math.round(msg.audio_duration_seconds)}s`
                      : ""
                  }.`,
              );
            }
            break;
          case "terminated":
            setStatus("stopped");
            break;
          case "saved":
            if (msg.id) {
              setSavedId(msg.id);
              onSaved(msg.id);
            }
            break;
          case "save_error":
            setErrorMsg(msg.message ?? "Failed to save transcript.");
            break;
        }
      };

      ws.onerror = () => {
        setErrorMsg("WebSocket connection failed.");
        setStatus("error");
      };

      ws.onclose = () => {
        if (status === "live" || status === "connecting") {
          setStatus("stopped");
        }
      };
    } catch (err) {
      const msg =
        err instanceof Error ? err.message : "Could not start microphone.";
      setErrorMsg(msg);
      setStatus("error");
      cleanup();
    }
  }, [cleanup, onSaved, status]);

  const stopFallbackRef = useRef<number | null>(null);

  const stop = useCallback(() => {
    setStatus("stopping");
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: "stop" }));
    }
    // Stop pumping mic audio immediately, but keep WS alive so the
    // upstream Termination message can come back. The existing
    // ws.onmessage handler will set status to "stopped" when it
    // receives {type:"terminated"} or {type:"upstream_closed"}, then
    // we tear everything down. A fallback timer (5s) guarantees
    // cleanup even if AssemblyAI never replies.
    if (nodeRef.current) {
      try {
        nodeRef.current.port.onmessage = null;
        nodeRef.current.disconnect();
      } catch {
        /* ignore */
      }
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((t) => t.stop());
    }
    if (stopFallbackRef.current !== null) {
      window.clearTimeout(stopFallbackRef.current);
    }
    stopFallbackRef.current = window.setTimeout(() => {
      cleanup();
      setStatus((s) => (s === "stopping" ? "stopped" : s));
      stopFallbackRef.current = null;
    }, 5000);
  }, [cleanup]);

  // Cancel the fallback timer if cleanup happens earlier (e.g. on
  // "terminated"/"upstream_closed" we close the WS in onclose, which
  // calls cleanup before the 5s elapse).
  useEffect(() => {
    if (status === "stopped" && stopFallbackRef.current !== null) {
      window.clearTimeout(stopFallbackRef.current);
      stopFallbackRef.current = null;
      cleanup();
    }
  }, [status, cleanup]);

  const save = useCallback(() => {
    if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
      // Re-open a tiny WS just to save. Simpler: tell user to save before stop.
      setErrorMsg(
        "Connection already closed. Please save before stopping next time.",
      );
      return;
    }
    wsRef.current.send(
      JSON.stringify({ type: "save", title: title.trim() || undefined }),
    );
  }, [title]);

  const reset = useCallback(() => {
    cleanup();
    setStatus("idle");
    setFinals([]);
    setPartial("");
    setErrorMsg(null);
    setSavedId(null);
    setTitle("");
    setElapsed(0);
    setAudioLevel(0);
    startedAtRef.current = null;
  }, [cleanup]);

  const fullText = finals.map((f) => f.text).join(" ").trim();
  const isRunning = status === "live" || status === "connecting" || status === "requesting-mic";
  const canSave = status === "live" && fullText.length > 0;

  function statusLabel(): string {
    switch (status) {
      case "idle":
        return "Ready";
      case "requesting-mic":
        return "Requesting microphone…";
      case "connecting":
        return "Connecting to AssemblyAI…";
      case "live":
        return "● Live";
      case "stopping":
        return "Stopping…";
      case "stopped":
        return "Stopped";
      case "error":
        return "Error";
    }
  }

  function fmtTime(sec: number): string {
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }

  return (
    <div className="lv-shell">
      <header className="lv-head">
        <div>
          <h2>Live transcription</h2>
          <p className="lv-subtitle">
            Capture meetings or any audio from your microphone in real time
            with AssemblyAI.
          </p>
        </div>
        <div className={`lv-status lv-status--${status}`}>
          {statusLabel()}
          {(status === "live" || status === "stopped") && (
            <span className="lv-elapsed"> · {fmtTime(elapsed)}</span>
          )}
        </div>
      </header>

      <div className="lv-controls">
        {!isRunning && status !== "stopping" && (
          <button
            type="button"
            className="btn-primary lv-rec"
            onClick={() => void start()}
          >
            <span className="lv-rec-dot" /> Start recording
          </button>
        )}
        {isRunning && (
          <button type="button" className="btn-danger" onClick={stop}>
            ■ Stop
          </button>
        )}
        {status === "stopped" && (
          <button type="button" className="btn-ghost" onClick={reset}>
            ↺ New session
          </button>
        )}

        <div className="lv-meter" aria-label="Microphone level">
          <div
            className="lv-meter-fill"
            style={{ width: `${Math.round(audioLevel * 100)}%` }}
          />
        </div>
      </div>

      {errorMsg && <div className="ux-error">⚠ {errorMsg}</div>}

      <section className="lv-transcript">
        <div className="lv-transcript-head">
          <span>Transcript</span>
          {fullText.length > 0 && (
            <span className="lv-wordcount">
              {fullText.split(/\s+/).filter(Boolean).length} words
            </span>
          )}
        </div>

        {finals.length === 0 && !partial && (
          <div className="lv-empty">
            {status === "live"
              ? "Listening… start speaking and finalised text will appear here."
              : status === "idle"
                ? "Click Start recording to begin a live session."
                : "—"}
          </div>
        )}

        <div className="lv-transcript-body">
          {finals.map((f) => (
            <p key={f.id} className="lv-final">
              {f.text}
            </p>
          ))}
          {partial && <p className="lv-partial">{partial}</p>}
        </div>
      </section>

      {(status === "live" || status === "stopped") && (
        <footer className="lv-save">
          <input
            type="text"
            placeholder="Title (optional)"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            className="lv-title-input"
          />
          <button
            type="button"
            className="btn-primary"
            onClick={save}
            disabled={!canSave}
            title={
              canSave
                ? "Save to library"
                : "Save while still recording — connection closes on stop"
            }
          >
            ⤓ Save to library
          </button>
          {savedId && (
            <span className="lv-saved-ok">✓ Saved · opens in library</span>
          )}
        </footer>
      )}
    </div>
  );
}
