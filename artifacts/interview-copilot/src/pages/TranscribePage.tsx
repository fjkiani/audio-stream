import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import UploadPanel from "../components/UploadPanel";
import DetailView from "../components/DetailView";
import DocToPdfPanel from "../components/DocToPdfPanel";
import { api, type TranscriptListItem } from "../lib/api";

type Mode = "audio" | "doc";
type View = { kind: "upload" } | { kind: "detail"; id: string };

export default function TranscribePage() {
  const [mode, setMode] = useState<Mode>("audio");
  const [items, setItems] = useState<TranscriptListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ kind: "upload" });
  const [listError, setListError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setListError(null);
    try {
      const data = await api.list();
      setItems(data.transcripts);
    } catch (e) {
      setListError(e instanceof Error ? e.message : "Failed to load library");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onSaved = useCallback(
    (id: string) => {
      void refresh();
      setView({ kind: "detail", id });
    },
    [refresh],
  );

  const onSelect = useCallback((id: string) => {
    setView({ kind: "detail", id });
  }, []);

  const onNew = useCallback(() => {
    setView({ kind: "upload" });
  }, []);

  const onDeleted = useCallback(() => {
    setView({ kind: "upload" });
    void refresh();
  }, [refresh]);

  return (
    <div className="app-shell">
      <div className="app-side">
        <nav className="app-tabs" role="tablist" aria-label="App mode">
          <button
            type="button"
            role="tab"
            aria-selected={mode === "audio"}
            className={`app-tab ${mode === "audio" ? "app-tab--active" : ""}`}
            onClick={() => setMode("audio")}
          >
            <span className="app-tab-icon">♪</span> Transcripts
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={mode === "doc"}
            className={`app-tab ${mode === "doc" ? "app-tab--active" : ""}`}
            onClick={() => setMode("doc")}
          >
            <span className="app-tab-icon">🧬</span> Doc → PDF
          </button>
        </nav>
        {mode === "audio" && (
          <Sidebar
            items={items}
            selectedId={view.kind === "detail" ? view.id : null}
            loading={loading}
            onSelect={onSelect}
            onNew={onNew}
            onRefresh={() => void refresh()}
          />
        )}
        {mode === "doc" && (
          <div className="sb sb--info">
            <div className="sb-head">
              <div className="sb-brand">
                <span className="sb-mark">🧬</span>
                <span className="sb-name">CRISPRO.AI</span>
              </div>
            </div>
            <div className="sb-info-body">
              <p>
                Convert any markdown or plain-text document into a branded PDF.
              </p>
              <p>
                The CrisPRO.ai header and contact line are added automatically.
                Edit the markdown in the editor on the right, preview the
                result, then click <strong>Download PDF</strong>.
              </p>
              <p className="dv-muted">
                Supports headings, lists, bold/italic, links, code, and
                blockquotes (CommonMark + GFM).
              </p>
            </div>
          </div>
        )}
      </div>

      <main className="app-main">
        {mode === "audio" ? (
          <>
            {listError && view.kind === "upload" && (
              <div className="ux-error">⚠ {listError}</div>
            )}
            {view.kind === "upload" ? (
              <UploadPanel onSaved={onSaved} />
            ) : (
              <DetailView
                id={view.id}
                candidates={items}
                onChanged={() => void refresh()}
                onDeleted={onDeleted}
              />
            )}
          </>
        ) : (
          <DocToPdfPanel />
        )}
      </main>
    </div>
  );
}
