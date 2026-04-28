import { useState } from "react";
import type { TranscriptListItem } from "../lib/api";
import { formatDate, formatDuration } from "../lib/api";

interface Props {
  items: TranscriptListItem[];
  selectedId: string | null;
  loading: boolean;
  onSelect: (id: string) => void;
  onNew: () => void;
  onRefresh: () => void;
}

export default function Sidebar({
  items,
  selectedId,
  loading,
  onSelect,
  onNew,
  onRefresh,
}: Props) {
  const [query, setQuery] = useState("");

  const filtered = query.trim()
    ? items.filter((i) =>
        (i.title + " " + i.text_excerpt + " " + (i.summary_excerpt ?? ""))
          .toLowerCase()
          .includes(query.toLowerCase())
      )
    : items;

  return (
    <aside className="sb">
      <div className="sb-head">
        <div className="sb-brand">
          <span className="sb-mark">⏵</span>
          <span className="sb-name">SCRIBE</span>
        </div>
        <button className="sb-new" type="button" onClick={onNew} title="New transcription">
          + New
        </button>
      </div>

      <div className="sb-search">
        <input
          type="text"
          placeholder="Search…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          spellCheck={false}
        />
        <button
          type="button"
          className="sb-refresh"
          onClick={onRefresh}
          title="Refresh"
          disabled={loading}
        >
          ↻
        </button>
      </div>

      <div className="sb-list">
        {loading && items.length === 0 && (
          <div className="sb-empty">Loading…</div>
        )}
        {!loading && items.length === 0 && (
          <div className="sb-empty">
            No saved transcripts yet.
            <br />
            Click <strong>+ New</strong> to upload one.
          </div>
        )}
        {filtered.length === 0 && items.length > 0 && (
          <div className="sb-empty">No matches.</div>
        )}
        {filtered.map((it) => (
          <button
            key={it.id}
            type="button"
            className={`sb-item ${selectedId === it.id ? "sb-item--active" : ""}`}
            onClick={() => onSelect(it.id)}
          >
            <div className="sb-item-title">{it.title}</div>
            <div className="sb-item-meta">
              {formatDate(it.created_at)} · {formatDuration(it.audio_duration)} ·{" "}
              {it.word_count}w
            </div>
            <div className="sb-item-excerpt">
              {it.summary_excerpt || it.text_excerpt}
            </div>
          </button>
        ))}
      </div>

      <div className="sb-foot">{items.length} saved</div>
    </aside>
  );
}
