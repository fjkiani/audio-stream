import { useEffect, useState } from "react";
import {
  api,
  formatDate,
  formatDuration,
  type TranscriptDetail,
  type TranscriptListItem,
} from "../lib/api";
import RelationsPanel from "./RelationsPanel";
import AskPanel from "./AskPanel";

interface Props {
  id: string;
  candidates: TranscriptListItem[];
  onChanged: () => void;
  onDeleted: () => void;
}

export default function DetailView({ id, candidates, onChanged, onDeleted }: Props) {
  const [detail, setDetail] = useState<TranscriptDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [err, setErr] = useState<string | null>(null);
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleInput, setTitleInput] = useState("");
  const [summarizing, setSummarizing] = useState<"summary" | "bullets" | null>(null);
  const [copied, setCopied] = useState<"text" | "summary" | null>(null);

  const load = async () => {
    setLoading(true);
    setErr(null);
    try {
      const d = await api.get(id);
      setDetail(d);
      setTitleInput(d.title);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  };

  // Reset and load when the selected transcript changes. The `cancelled`
  // guard prevents a slow response for a previous id from clobbering state
  // after the user has already switched to a different transcript.
  useEffect(() => {
    let cancelled = false;
    setDetail(null);
    setLoading(true);
    setErr(null);
    setEditingTitle(false);
    setSummarizing(null);
    setCopied(null);
    (async () => {
      try {
        const d = await api.get(id);
        if (cancelled) return;
        setDetail(d);
        setTitleInput(d.title);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [id]);

  const saveTitle = async () => {
    if (!detail) return;
    const t = titleInput.trim();
    if (!t || t === detail.title) {
      setEditingTitle(false);
      setTitleInput(detail.title);
      return;
    }
    try {
      await api.patch(detail.id, { title: t });
      setDetail({ ...detail, title: t });
      setEditingTitle(false);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to save title");
    }
  };

  const summarize = async (mode: "summary" | "bullets") => {
    if (!detail) return;
    setSummarizing(mode);
    setErr(null);
    try {
      const out = await api.summarize(detail.id, mode);
      if (mode === "summary" && out.summary !== undefined) {
        setDetail({ ...detail, summary: out.summary });
      } else if (mode === "bullets" && out.bullets !== undefined) {
        setDetail({ ...detail, bullets: out.bullets });
      }
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "AI generation failed");
    } finally {
      setSummarizing(null);
    }
  };

  const remove = async () => {
    if (!detail) return;
    if (!confirm(`Delete "${detail.title}"? This cannot be undone.`)) return;
    try {
      await api.remove(detail.id);
      onDeleted();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Delete failed");
    }
  };

  const copy = async (kind: "text" | "summary", value: string) => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(kind);
      setTimeout(() => setCopied(null), 1500);
    } catch {
      setErr("Clipboard not available.");
    }
  };

  const downloadTxt = () => {
    if (!detail) return;
    const parts: string[] = [`${detail.title}\n${"=".repeat(detail.title.length)}\n`];
    if (detail.summary) parts.push(`SUMMARY\n${detail.summary}\n`);
    if (detail.bullets && detail.bullets.length)
      parts.push(`KEY POINTS\n${detail.bullets.map((b) => `- ${b}`).join("\n")}\n`);
    parts.push(`TRANSCRIPT\n${detail.text}`);
    const blob = new Blob([parts.join("\n")], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `${detail.title.replace(/[^\w.-]+/g, "_")}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  if (loading && !detail) {
    return <div className="dv-shell"><div className="dv-loading">Loading…</div></div>;
  }
  if (err && !detail) {
    return <div className="dv-shell"><div className="ux-error">{err}</div></div>;
  }
  if (!detail) return null;

  return (
    <div className="dv-shell">
      <header className="dv-head">
        <div className="dv-title-row">
          {editingTitle ? (
            <input
              className="dv-title-input"
              value={titleInput}
              onChange={(e) => setTitleInput(e.target.value)}
              onBlur={saveTitle}
              onKeyDown={(e) => {
                if (e.key === "Enter") saveTitle();
                if (e.key === "Escape") {
                  setTitleInput(detail.title);
                  setEditingTitle(false);
                }
              }}
              autoFocus
              maxLength={280}
            />
          ) : (
            <h1 className="dv-title" onClick={() => setEditingTitle(true)} title="Click to rename">
              {detail.title}
            </h1>
          )}
          <div className="dv-actions">
            <button type="button" className="btn-ghost btn-sm" onClick={downloadTxt}>Export .txt</button>
            <button type="button" className="btn-ghost btn-sm dv-danger" onClick={remove}>Delete</button>
          </div>
        </div>
        <div className="dv-meta">
          {detail.original_filename} · {formatDate(detail.created_at)} ·{" "}
          {formatDuration(detail.audio_duration)} · {detail.word_count} words
          {detail.language_code ? ` · ${detail.language_code}` : ""}
        </div>
        {err && <div className="ux-error">⚠ {err}</div>}
      </header>

      <div className="dv-body">
        <section className="dv-section">
          <div className="dv-section-head">
            <h3>AI Assistant</h3>
          </div>
          <div className="ai-actions">
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => summarize("summary")}
              disabled={summarizing !== null}
            >
              {summarizing === "summary"
                ? "Summarizing…"
                : detail.summary
                ? "↻ Regenerate summary"
                : "✦ Summarize"}
            </button>
            <button
              type="button"
              className="btn-primary btn-sm"
              onClick={() => summarize("bullets")}
              disabled={summarizing !== null}
            >
              {summarizing === "bullets"
                ? "Generating…"
                : detail.bullets && detail.bullets.length
                ? "↻ Regenerate bullets"
                : "✦ Bullet points"}
            </button>
          </div>

          {detail.summary && (
            <div className="ai-block">
              <div className="ai-block-head">
                <span className="ai-block-label">Summary</span>
                <button
                  type="button"
                  className="ai-copy"
                  onClick={() => copy("summary", detail.summary!)}
                >
                  {copied === "summary" ? "✓ copied" : "copy"}
                </button>
              </div>
              <p className="ai-block-text">{detail.summary}</p>
            </div>
          )}

          {detail.bullets && detail.bullets.length > 0 && (
            <div className="ai-block">
              <div className="ai-block-head">
                <span className="ai-block-label">Key points</span>
              </div>
              <ul className="ai-bullets">
                {detail.bullets.map((b, i) => (
                  <li key={i}>{b}</li>
                ))}
              </ul>
            </div>
          )}

          {!detail.summary && (!detail.bullets || detail.bullets.length === 0) && (
            <p className="dv-muted">
              Click <strong>Summarize</strong> for a paragraph summary or <strong>Bullet points</strong> for the key takeaways.
            </p>
          )}
        </section>

        <RelationsPanel detail={detail} candidates={candidates} onChanged={() => { void load(); onChanged(); }} />

        <AskPanel key={detail.id} detail={detail} />

        <section className="dv-section">
          <div className="dv-section-head">
            <h3>Transcript</h3>
            <button
              type="button"
              className="btn-ghost btn-sm"
              onClick={() => copy("text", detail.text)}
            >
              {copied === "text" ? "✓ Copied" : "Copy"}
            </button>
          </div>
          <div className="dv-transcript">
            {detail.text || <span className="dv-muted">(no speech detected)</span>}
          </div>
        </section>
      </div>
    </div>
  );
}
