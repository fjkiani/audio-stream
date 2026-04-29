import { useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";

// html2pdf.js is a browser-only lib (uses window). Lazy-load it to keep
// it out of the initial bundle and avoid SSR-style issues.
interface Html2PdfChain {
  from: (e: HTMLElement) => Html2PdfChain;
  save: () => Promise<void>;
}
type Html2PdfFn = (el: HTMLElement, opts: Record<string, unknown>) => Html2PdfChain;

const HEADER_TITLE = "CrisPRO.ai";
const HEADER_DNA = "🧬";
const HEADER_CONTACT = "Contact@CrisPRO.ai";

const SAMPLE = `# Document Title

Your markdown content goes here. **Bold**, *italic*, \`code\`, lists, headings, and links all work.

## A subsection
- Bullet one
- Bullet two
- Bullet three

> Block quotes are supported as well.
`;

marked.setOptions({ gfm: true, breaks: false });

interface ToastState {
  kind: "ok" | "err";
  msg: string;
}

export default function DocToPdfPanel() {
  const [text, setText] = useState<string>("");
  const [filename, setFilename] = useState<string>("crispro-document");
  const [busy, setBusy] = useState(false);
  const [toast, setToast] = useState<ToastState | null>(null);
  const [dragOver, setDragOver] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);

  const html = useMemo(() => {
    try {
      return marked.parse(text || SAMPLE, { async: false }) as string;
    } catch {
      return "<p>Could not render markdown.</p>";
    }
  }, [text]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 3500);
    return () => clearTimeout(t);
  }, [toast]);

  const acceptFile = async (f: File | null | undefined) => {
    if (!f) return;
    if (f.size > 5 * 1024 * 1024) {
      setToast({ kind: "err", msg: "File is larger than 5 MB." });
      return;
    }
    const name = f.name.toLowerCase();
    const ok =
      name.endsWith(".md") ||
      name.endsWith(".markdown") ||
      name.endsWith(".txt") ||
      f.type.startsWith("text/");
    if (!ok) {
      setToast({ kind: "err", msg: "Upload a .md, .markdown, or .txt file." });
      return;
    }
    try {
      const content = await f.text();
      setText(content);
      const base = f.name.replace(/\.(md|markdown|txt)$/i, "");
      setFilename(base || "crispro-document");
      setToast({ kind: "ok", msg: `Loaded ${f.name}.` });
    } catch {
      setToast({ kind: "err", msg: "Could not read the file." });
    }
  };

  const downloadPdf = async () => {
    if (!previewRef.current) return;
    const trimmed = (text || "").trim();
    if (!trimmed) {
      setToast({ kind: "err", msg: "Nothing to export — paste or upload some markdown first." });
      return;
    }
    setBusy(true);
    setToast(null);
    try {
      const mod: unknown = await import("html2pdf.js");
      const html2pdf: Html2PdfFn =
        typeof mod === "function"
          ? (mod as Html2PdfFn)
          : ((mod as { default: Html2PdfFn }).default);

      const safeName = (filename || "crispro-document")
        .replace(/[^\w.-]+/g, "_")
        .slice(0, 80);

      const opts = {
        margin: [12, 12, 14, 12], // mm: top, left, bottom, right
        filename: `${safeName}.pdf`,
        image: { type: "jpeg", quality: 0.98 },
        html2canvas: {
          scale: 2,
          useCORS: true,
          backgroundColor: "#ffffff",
        },
        jsPDF: {
          unit: "mm",
          format: "a4",
          orientation: "portrait",
        },
        pagebreak: { mode: ["css", "legacy", "avoid-all"] },
      };

      await html2pdf(previewRef.current, opts).from(previewRef.current).save();
      setToast({ kind: "ok", msg: "PDF downloaded." });
    } catch (e) {
      setToast({
        kind: "err",
        msg: e instanceof Error ? `PDF export failed: ${e.message}` : "PDF export failed.",
      });
    } finally {
      setBusy(false);
    }
  };

  const loadSample = () => {
    setText(SAMPLE);
    setFilename("crispro-sample");
  };

  return (
    <div className="dp-shell">
      <header className="dp-head">
        <h2>Markdown → PDF</h2>
        <p className="dp-subtitle">
          Upload or paste markdown. We add the CrisPRO.ai header automatically and you download the result as a PDF.
        </p>
      </header>

      <div className="dp-grid">
        {/* ── Editor column ─────────────────────────────────── */}
        <div className="dp-col">
          <div
            className={`dp-drop ${dragOver ? "dp-drop--over" : ""}`}
            onClick={() => fileRef.current?.click()}
            onDragOver={(e) => {
              e.preventDefault();
              setDragOver(true);
            }}
            onDragLeave={() => setDragOver(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragOver(false);
              void acceptFile(e.dataTransfer.files?.[0]);
            }}
            role="button"
            tabIndex={0}
          >
            <span className="dp-drop-icon">⤓</span>
            <span className="dp-drop-text">
              Drop a <code>.md</code> / <code>.txt</code> file or click to browse
            </span>
            <input
              ref={fileRef}
              type="file"
              accept=".md,.markdown,.txt,text/plain,text/markdown"
              hidden
              onChange={(e) => void acceptFile(e.target.files?.[0])}
            />
          </div>

          <div className="dp-field">
            <label htmlFor="dp-filename">File name</label>
            <div className="dp-filename">
              <input
                id="dp-filename"
                type="text"
                value={filename}
                onChange={(e) => setFilename(e.target.value)}
                placeholder="crispro-document"
                maxLength={80}
              />
              <span className="dp-filename-ext">.pdf</span>
            </div>
          </div>

          <div className="dp-field">
            <div className="dp-field-head">
              <label htmlFor="dp-text">Markdown</label>
              <button type="button" className="dp-link" onClick={loadSample}>
                load sample
              </button>
            </div>
            <textarea
              id="dp-text"
              className="dp-textarea"
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder="# Heading&#10;&#10;Your markdown here. **Bold**, *italic*, lists, links, code blocks, blockquotes…"
              spellCheck={false}
            />
          </div>

          <div className="dp-actions">
            <button
              type="button"
              className="btn-primary"
              onClick={downloadPdf}
              disabled={busy}
            >
              {busy ? "Generating PDF…" : "↓ Download PDF"}
            </button>
            <button
              type="button"
              className="btn-ghost"
              onClick={() => {
                setText("");
                setFilename("crispro-document");
                setToast(null);
              }}
              disabled={busy}
            >
              Clear
            </button>
          </div>

          {toast && (
            <div className={toast.kind === "ok" ? "dp-toast dp-toast--ok" : "ux-error"}>
              {toast.kind === "ok" ? "✓" : "⚠"} {toast.msg}
            </div>
          )}
        </div>

        {/* ── Preview column ─────────────────────────────────── */}
        <div className="dp-col">
          <div className="dp-preview-label">PREVIEW · A4</div>
          <div className="dp-preview-frame">
            <div ref={previewRef} className="dp-doc">
              <header className="dp-doc-header">
                <div className="dp-doc-brand">
                  <span className="dp-doc-brand-name">{HEADER_TITLE}</span>
                  <span className="dp-doc-brand-mark">{HEADER_DNA}</span>
                </div>
                <div className="dp-doc-contact">{HEADER_CONTACT}</div>
              </header>
              <article
                className="dp-doc-body"
                dangerouslySetInnerHTML={{ __html: html }}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
