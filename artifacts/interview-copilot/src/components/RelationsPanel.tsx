import { useState } from "react";
import {
  api,
  RELATION_KINDS,
  RELATION_LABELS,
  type RelationKind,
  type TranscriptDetail,
  type TranscriptListItem,
} from "../lib/api";

interface Props {
  detail: TranscriptDetail;
  candidates: TranscriptListItem[]; // all transcripts except this one
  onChanged: () => void;
}

export default function RelationsPanel({ detail, candidates, onChanged }: Props) {
  const [adding, setAdding] = useState(false);
  const [toId, setToId] = useState("");
  const [kind, setKind] = useState<RelationKind>("related");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const usableCandidates = candidates.filter(
    (c) =>
      c.id !== detail.id &&
      !detail.relations.some((r) => r.other_id === c.id)
  );

  const submit = async () => {
    if (!toId) {
      setErr("Pick a transcript to link.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      await api.createRelation(detail.id, {
        to_id: toId,
        kind,
        note: note.trim() || null,
      });
      setAdding(false);
      setToId("");
      setKind("related");
      setNote("");
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to link");
    } finally {
      setBusy(false);
    }
  };

  const removeRel = async (relId: string) => {
    setBusy(true);
    try {
      await api.deleteRelation(relId);
      onChanged();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Failed to remove");
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="dv-section">
      <div className="dv-section-head">
        <h3>Relationships</h3>
        {!adding && usableCandidates.length > 0 && (
          <button type="button" className="btn-ghost btn-sm" onClick={() => setAdding(true)}>
            + Link
          </button>
        )}
      </div>

      {detail.relations.length === 0 && !adding && (
        <p className="dv-muted">
          No links yet. {usableCandidates.length === 0
            ? "Upload more transcripts to start connecting them."
            : "Click + Link to connect this to another saved transcript."}
        </p>
      )}

      {detail.relations.length > 0 && (
        <ul className="rel-list">
          {detail.relations.map((r) => (
            <li key={r.id} className="rel-item">
              <div className="rel-line">
                <span className={`rel-arrow rel-arrow--${r.direction}`}>
                  {r.direction === "outgoing" ? "→" : "←"}
                </span>
                <span className="rel-kind">{RELATION_LABELS[r.kind]}</span>
                <span className="rel-target">{r.other_title}</span>
                <button
                  type="button"
                  className="rel-remove"
                  onClick={() => removeRel(r.id)}
                  disabled={busy}
                  title="Remove link"
                >
                  ×
                </button>
              </div>
              {r.note && <div className="rel-note">{r.note}</div>}
            </li>
          ))}
        </ul>
      )}

      {adding && (
        <div className="rel-form">
          <div className="rel-form-row">
            <label>Link to</label>
            <select value={toId} onChange={(e) => setToId(e.target.value)}>
              <option value="">— pick a transcript —</option>
              {usableCandidates.map((c) => (
                <option key={c.id} value={c.id}>{c.title}</option>
              ))}
            </select>
          </div>
          <div className="rel-form-row">
            <label>Relation</label>
            <select value={kind} onChange={(e) => setKind(e.target.value as RelationKind)}>
              {RELATION_KINDS.map((k) => (
                <option key={k} value={k}>{RELATION_LABELS[k]}</option>
              ))}
            </select>
          </div>
          <div className="rel-form-row">
            <label>Note (optional)</label>
            <input
              type="text"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="why are these related?"
              maxLength={200}
            />
          </div>
          {err && <div className="ux-error">⚠ {err}</div>}
          <div className="rel-form-actions">
            <button type="button" className="btn-primary btn-sm" onClick={submit} disabled={busy}>
              {busy ? "Linking…" : "Link"}
            </button>
            <button type="button" className="btn-ghost btn-sm" onClick={() => { setAdding(false); setErr(null); }} disabled={busy}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </section>
  );
}
