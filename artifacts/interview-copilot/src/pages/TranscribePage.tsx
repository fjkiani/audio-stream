import { useCallback, useEffect, useState } from "react";
import Sidebar from "../components/Sidebar";
import UploadPanel from "../components/UploadPanel";
import DetailView from "../components/DetailView";
import { api, type TranscriptListItem } from "../lib/api";

type View = { kind: "upload" } | { kind: "detail"; id: string };

export default function TranscribePage() {
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
    [refresh]
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
      <Sidebar
        items={items}
        selectedId={view.kind === "detail" ? view.id : null}
        loading={loading}
        onSelect={onSelect}
        onNew={onNew}
        onRefresh={() => void refresh()}
      />
      <main className="app-main">
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
      </main>
    </div>
  );
}
