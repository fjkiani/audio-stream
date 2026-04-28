import { useRef, useState } from "react";
import { streamChat, type TranscriptDetail } from "../lib/api";

interface Props {
  detail: TranscriptDetail;
}

interface ChatTurn {
  question: string;
  answer: string;
  related_count: number;
  done: boolean;
  error?: string;
}

export default function AskPanel({ detail }: Props) {
  const [question, setQuestion] = useState("");
  const [includeRelated, setIncludeRelated] = useState(true);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [streaming, setStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const ask = async () => {
    const q = question.trim();
    if (!q || streaming) return;
    setQuestion("");

    const turn: ChatTurn = { question: q, answer: "", related_count: 0, done: false };
    setTurns((prev) => [...prev, turn]);
    setStreaming(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const updateLast = (mut: (t: ChatTurn) => ChatTurn) => {
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = mut(next[next.length - 1]);
        return next;
      });
    };

    try {
      await streamChat(
        detail.id,
        { question: q, include_related: includeRelated },
        {
          onMeta: (m) => updateLast((t) => ({ ...t, related_count: m.related_count })),
          onToken: (tok) => updateLast((t) => ({ ...t, answer: t.answer + tok })),
          onDone: () => updateLast((t) => ({ ...t, done: true })),
          onError: (msg) => updateLast((t) => ({ ...t, done: true, error: msg })),
        },
        ctrl.signal
      );
    } catch (e) {
      if ((e as Error).name !== "AbortError") {
        updateLast((t) => ({ ...t, done: true, error: (e as Error).message }));
      } else {
        updateLast((t) => ({ ...t, done: true, answer: t.answer + " [stopped]" }));
      }
    } finally {
      setStreaming(false);
      abortRef.current = null;
    }
  };

  const stop = () => {
    abortRef.current?.abort();
  };

  return (
    <section className="dv-section">
      <div className="dv-section-head">
        <h3>Ask the AI</h3>
        <label className="ask-checkbox" title="Include linked transcripts as context">
          <input
            type="checkbox"
            checked={includeRelated}
            onChange={(e) => setIncludeRelated(e.target.checked)}
          />
          <span>use linked transcripts ({detail.relations.length})</span>
        </label>
      </div>

      {turns.length === 0 && (
        <p className="dv-muted">
          Ask anything about this transcript. Examples: "what were the key decisions?",
          "summarize the discussion about X", "compare this with the linked transcript".
        </p>
      )}

      <div className="ask-thread">
        {turns.map((t, i) => (
          <div key={i} className="ask-turn">
            <div className="ask-q">› {t.question}</div>
            {t.related_count > 0 && (
              <div className="ask-meta">
                using {t.related_count} linked transcript{t.related_count === 1 ? "" : "s"} as context
              </div>
            )}
            <div className={`ask-a ${!t.done ? "ask-a--streaming" : ""}`}>
              {t.answer || (t.done ? <em className="dv-muted">(no answer)</em> : "…")}
              {!t.done && <span className="ask-cursor" />}
            </div>
            {t.error && <div className="ux-error">⚠ {t.error}</div>}
          </div>
        ))}
      </div>

      <form
        className="ask-input"
        onSubmit={(e) => {
          e.preventDefault();
          ask();
        }}
      >
        <input
          type="text"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          placeholder="Ask a question…"
          disabled={streaming}
        />
        {streaming ? (
          <button type="button" className="btn-ghost" onClick={stop}>Stop</button>
        ) : (
          <button type="submit" className="btn-primary" disabled={!question.trim()}>Ask</button>
        )}
      </form>
    </section>
  );
}
