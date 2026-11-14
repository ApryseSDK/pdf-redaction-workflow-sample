import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import WebViewer, { type WebViewerInstance } from "@pdftron/webviewer";
import { RULES, parseTerms } from "./rules";
import { presidioAvailable } from "./presidio";
import {
  SANITIZE_CATEGORIES,
  applyApproved,
  currentFileData,
  paint,
  removeAnnotations,
  rescan,
  sanitizeHidden,
  scanDocument,
} from "./detect";
import { sendToDocumentSystem, sourceFromQuery } from "./integration";
import {
  auditEntry,
  auditForSuggestion,
  downloadBlob,
  sha256Hex,
  toCsv,
  toJson,
} from "./audit";
import type { AuditEntry, Status, Suggestion } from "./types";

const SAMPLE = "/sample_claim.pdf";
const SOURCE = sourceFromQuery(window.location.search, {
  url: SAMPLE,
  name: "sample_claim.pdf",
});
const SAVE_ENDPOINT =
  (import.meta.env.VITE_SAVE_ENDPOINT as string | undefined) || "";
const DEFAULT_TERMS = "Jordan A. Example, 100 Example Street";
const STEPS = ["Detect", "Review", "Apply", "Verify", "Record"];

type Phase = "ready" | "detected" | "applied";

export default function App() {
  const viewerEl = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const started = useRef(false);
  const instance = useRef<WebViewerInstance | null>(null);
  const core = useRef<any>(null); // WebViewer's Core namespace, kept untyped at the SDK boundary
  const annots = useRef(new Map<string, any>()); // suggestion id -> redaction annotation
  const knownIds = useRef(new Set<string>()); // annotation ids this app created itself
  const quiet = useRef(false); // true while the app itself adds, removes or applies marks
  const manualCount = useRef(0);
  const originalHash = useRef<string | undefined>(undefined);
  const fileName = useRef(SOURCE.name);

  const [ready, setReady] = useState(false);
  const [reviewer, setReviewer] = useState("Demo reviewer");
  const reviewerRef = useRef(reviewer);
  reviewerRef.current = reviewer;
  const [enabled, setEnabled] = useState<Record<string, boolean>>(
    Object.fromEntries(RULES.map((r) => [r.id, true])),
  );
  const [termsText, setTermsText] = useState(DEFAULT_TERMS);
  const [usePresidio, setUsePresidio] = useState(false);
  const [presidioUp, setPresidioUp] = useState(false);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [phase, setPhase] = useState<Phase>("ready");
  const [busy, setBusy] = useState<string | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [verify, setVerify] = useState<{
    remaining: number;
    byRule: Record<string, number>;
  } | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [outputHash, setOutputHash] = useState<string | null>(null);
  const [sanitize, setSanitize] = useState(false); // off by default: Apryse documents sanitization as a Server SDK feature; browser support is unconfirmed
  const [sent, setSent] = useState<string | null>(null);

  const log = useCallback((e: AuditEntry) => setAudit((a) => [...a, e]), []);

  // Start WebViewer once. fullAPI keeps processing in the browser and is required to apply redactions in code.
  useEffect(() => {
    if (started.current || !viewerEl.current) return;
    started.current = true;
    WebViewer(
      {
        path: "/lib/webviewer",
        licenseKey: import.meta.env.VITE_APRYSE_WEBVIEWER_KEY,
        initialDoc: SOURCE.url,
        fullAPI: true,
        enableRedaction: true,
      },
      viewerEl.current,
    ).then(async (inst) => {
      instance.current = inst;
      if (import.meta.env.DEV) (window as any).__wv = inst; // dev only: lets test scripts reach the viewer
      const Core: any = inst.Core;
      core.current = Core;
      await Core.PDFNet.initialize(); // starts the full-API workers
      // The viewer's own redaction panel has a "Redact All" button that would skip this app's approval step.
      inst.UI.disableElements(["redactionPanel", "redactionPanelToggle"]);
      const { documentViewer, annotationManager, Annotations } = Core;

      // Nothing can read page text or positions until the document has loaded.
      documentViewer.addEventListener("documentLoaded", () => setReady(true));
      if (documentViewer.getDocument()) setReady(true);

      annotationManager.setCurrentUser(reviewerRef.current);
      annotationManager.addEventListener(
        "annotationChanged",
        (changed: any[], action: string, info: any) => {
          if (info?.imported || quiet.current) return;
          for (const a of changed) {
            if (!(a instanceof Annotations.RedactionAnnotation)) continue;
            if (action === "add" && !knownIds.current.has(a.Id)) {
              // A reviewer drew this mark with the viewer's redaction tool. It counts as approved.
              const id = `m${++manualCount.current}`;
              knownIds.current.add(a.Id);
              annots.current.set(id, a);
              const s: Suggestion = {
                id,
                source: "manual",
                rule: "manual-mark",
                label: "Manual mark",
                page: a.PageNumber,
                text: "(marked by reviewer)",
                status: "approved",
                annotationId: a.Id,
              };
              setSuggestions((prev) => [...prev, s]);
              log(auditForSuggestion(reviewerRef.current, "manual-mark", s));
            } else if (action === "delete") {
              setSuggestions((prev) =>
                prev
                  .filter(
                    (s) => !(s.source === "manual" && s.annotationId === a.Id),
                  )
                  .map((s) =>
                    s.annotationId === a.Id && s.status !== "rejected"
                      ? { ...s, status: "rejected" as const }
                      : s,
                  ),
              );
            }
          }
        },
      );

      fetch(SOURCE.url)
        .then((r) => r.arrayBuffer())
        .then(sha256Hex)
        .then((h) => (originalHash.current = h))
        .catch(() => {});
    });
  }, [log]);

  useEffect(() => {
    core.current?.annotationManager.setCurrentUser(reviewer);
  }, [reviewer]);

  useEffect(() => {
    const check = () => presidioAvailable().then(setPresidioUp);
    check();
    window.addEventListener("focus", check);
    return () => window.removeEventListener("focus", check);
  }, []);

  const clearState = () => {
    annots.current.clear();
    knownIds.current.clear();
    setSuggestions([]);
    setPhase("ready");
    setVerify(null);
    setAudit([]);
    setNote(null);
    setOutputHash(null);
    setSent(null);
    setSanitize(false);
    setReady(false);
  };

  const reset = () => {
    clearState();
    fileName.current = SOURCE.name;
    instance.current?.UI.loadDocument(SOURCE.url, { filename: SOURCE.name });
    fetch(SOURCE.url)
      .then((r) => r.arrayBuffer())
      .then(sha256Hex)
      .then((h) => (originalHash.current = h))
      .catch(() => {});
  };

  const openFile = async (file: File) => {
    clearState();
    fileName.current = file.name;
    originalHash.current = await sha256Hex(await file.arrayBuffer());
    instance.current?.UI.loadDocument(file, { filename: file.name });
  };

  const detect = async () => {
    if (!core.current) return;
    setBusy("Scanning page 1…");
    setNote(null);
    setVerify(null);
    try {
      // Replace earlier automatic marks; keep any the reviewer drew by hand.
      const old = suggestions.filter((s) => s.source !== "manual");
      quiet.current = true;
      removeAnnotations(
        core.current,
        old.map((s) => annots.current.get(s.id)).filter(Boolean),
      );
      old.forEach((s) => annots.current.delete(s.id));
      const result = await scanDocument(core.current, {
        rules: RULES.filter((r) => enabled[r.id]),
        terms: parseTerms(termsText),
        usePresidio: usePresidio && presidioUp,
        knownIds: knownIds.current,
        onProgress: (p, t) => setBusy(`Scanning page ${p} of ${t}…`),
      });
      result.annotations.forEach((a, id) => annots.current.set(id, a));
      setSuggestions((prev) => [
        ...prev.filter((s) => s.source === "manual"),
        ...result.suggestions,
      ]);

      const counts = new Map<string, number>();
      result.suggestions.forEach((s) =>
        counts.set(s.rule, (counts.get(s.rule) ?? 0) + 1),
      );
      if (counts.size === 0)
        log(auditEntry(reviewer, "detected", { count: 0 }));
      counts.forEach((count, rule) =>
        log(auditEntry(reviewer, "detected", { rule, count })),
      );
      setPhase("detected");
      if (result.presidioError)
        setNote(
          `Presidio service problem (${result.presidioError}). Rule results are shown.`,
        );
    } catch (err) {
      setNote(
        `Detection failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      quiet.current = false;
      setBusy(null);
    }
  };

  const decide = (ids: string[], status: Exclude<Status, "pending">) => {
    for (const id of ids) {
      const s = suggestions.find((x) => x.id === id);
      const a = annots.current.get(id);
      if (a) paint(core.current, a, status);
      if (s && s.status !== status)
        log(auditForSuggestion(reviewer, status, s));
    }
    setSuggestions((prev) =>
      prev.map((s) => (ids.includes(s.id) ? { ...s, status } : s)),
    );
  };

  const counts = useMemo(
    () => ({
      pending: suggestions.filter((s) => s.status === "pending").length,
      approved: suggestions.filter((s) => s.status === "approved").length,
      rejected: suggestions.filter((s) => s.status === "rejected").length,
    }),
    [suggestions],
  );

  const groups = useMemo(() => {
    const m = new Map<string, { label: string; items: Suggestion[] }>();
    for (const s of suggestions) {
      const g = m.get(s.rule) ?? { label: s.label, items: [] };
      g.items.push(s);
      m.set(s.rule, g);
    }
    return [...m.entries()];
  }, [suggestions]);

  const doApply = async () => {
    setConfirming(false);
    setBusy("Applying redactions…");
    quiet.current = true;
    try {
      const rejected = suggestions
        .filter((s) => s.status === "rejected")
        .map((s) => annots.current.get(s.id))
        .filter(Boolean);
      const toApply = suggestions
        .filter((s) => s.status === "approved")
        .map((s) => annots.current.get(s.id))
        .filter(Boolean);
      removeAnnotations(core.current, rejected);
      await applyApproved(core.current, toApply);
      log(
        auditEntry(reviewer, "applied", {
          count: toApply.length,
          detail: `${rejected.length} rejected marks discarded`,
        }),
      );
      setPhase("applied");
      if (sanitize) {
        setBusy("Removing hidden data…");
        try {
          await sanitizeHidden(core.current);
          log(
            auditEntry(reviewer, "sanitized", {
              detail: SANITIZE_CATEGORIES.join(", "),
            }),
          );
        } catch (err) {
          setNote(
            `Redactions were applied, but removing hidden data failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    } catch (err) {
      setNote(
        `Apply failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      quiet.current = false;
      setBusy(null);
    }
  };

  const runVerify = async () => {
    setBusy("Re-scanning…");
    try {
      const r = await rescan(
        core.current,
        RULES.filter((x) => enabled[x.id]),
        parseTerms(termsText),
      );
      setVerify(r);
      log(
        auditEntry(reviewer, "verified", {
          count: r.remaining,
          detail: "in-app re-scan",
        }),
      );
    } catch (err) {
      setNote(
        `Re-scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const download = async () => {
    try {
      const data = await currentFileData(core.current);
      const hash = await sha256Hex(data);
      setOutputHash(hash);
      downloadBlob(
        `redacted_${fileName.current}`,
        new Blob([data], { type: "application/pdf" }),
      );
      log(auditEntry(reviewer, "downloaded", { detail: `sha256:${hash}` }));
    } catch (err) {
      setNote(
        `Download failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const exportAudit = (kind: "json" | "csv") => {
    const meta = {
      file: fileName.current,
      originalSha256: originalHash.current,
    };
    if (kind === "json")
      downloadBlob(
        "audit-log.json",
        new Blob([toJson(meta, audit)], { type: "application/json" }),
      );
    else
      downloadBlob(
        "audit-log.csv",
        new Blob([toCsv(audit)], { type: "text/csv" }),
      );
  };

  const sendOut = async () => {
    try {
      setBusy("Sending…");
      const data = await currentFileData(core.current);
      const hash = await sha256Hex(data);
      const entry = auditEntry(reviewer, "sent", {
        detail: `to ${SAVE_ENDPOINT} · sha256:${hash}`,
      });
      const meta = {
        file: fileName.current,
        originalSha256: originalHash.current,
      };
      const result = await sendToDocumentSystem(SAVE_ENDPOINT, {
        pdf: data,
        fileName: `redacted_${fileName.current}`,
        originalSha256: originalHash.current,
        outputSha256: hash,
        auditJson: toJson(meta, [...audit, entry]),
      });
      setOutputHash(hash);
      log(entry);
      setSent(
        `Sent (document ${result.documentStatus}, audit ${result.auditStatus}).`,
      );
    } catch (err) {
      setSent(null);
      setNote(
        `Send failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(null);
    }
  };

  const stepIndex =
    phase === "ready"
      ? 0
      : phase === "detected"
        ? counts.pending > 0
          ? 1
          : 2
        : verify
          ? 4
          : 3;
  const canApply =
    phase === "detected" &&
    counts.pending === 0 &&
    counts.approved > 0 &&
    !busy;

  return (
    <div className="app">
      <div className="viewer" ref={viewerEl} />

      <aside className="panel">
        <header>
          <h1>Redaction review</h1>
          <p className="muted">
            Detect, review, apply, verify. Nothing is removed until a person
            approves it and confirms.
          </p>
          <ol className="steps">
            {STEPS.map((s, i) => (
              <li
                key={s}
                className={
                  i < stepIndex ? "done" : i === stepIndex ? "active" : ""
                }
              >
                {s}
              </li>
            ))}
          </ol>
        </header>

        <section className="row">
          <label className="grow">
            Reviewer
            <input
              value={reviewer}
              onChange={(e) => setReviewer(e.target.value)}
            />
          </label>
          <button className="ghost" onClick={() => fileInput.current?.click()}>
            Open PDF
          </button>
          <button className="ghost" onClick={reset}>
            Reset
          </button>
          <input
            ref={fileInput}
            type="file"
            accept="application/pdf"
            hidden
            onChange={(e) => e.target.files?.[0] && openFile(e.target.files[0])}
          />
        </section>

        {note && <div className="note">{note}</div>}

        <section>
          <h2>1. Detect</h2>
          <div className="checks">
            {RULES.map((r) => (
              <label key={r.id}>
                <input
                  type="checkbox"
                  checked={enabled[r.id]}
                  onChange={(e) =>
                    setEnabled({ ...enabled, [r.id]: e.target.checked })
                  }
                />
                {r.label}
              </label>
            ))}
          </div>
          <label>
            Extra terms (comma or line separated)
            <textarea
              rows={2}
              value={termsText}
              onChange={(e) => setTermsText(e.target.value)}
            />
          </label>
          <label className={presidioUp ? "" : "muted"}>
            <input
              type="checkbox"
              checked={usePresidio && presidioUp}
              disabled={!presidioUp}
              onChange={(e) => setUsePresidio(e.target.checked)}
            />
            Also suggest names and places with Presidio{" "}
            {presidioUp ? "(local service running)" : "(service not running)"}
          </label>
          {usePresidio && presidioUp && (
            <p className="muted small">
              Sends each page's text, not the file, to the service on this
              computer.
            </p>
          )}
          <button
            className="primary"
            disabled={!ready || !!busy}
            onClick={detect}
          >
            {busy ?? (ready ? "Find suggestions" : "Loading document…")}
          </button>
          <p className="muted small">
            Text inside scanned images isn't found by rules. Use the redaction
            tool in the viewer toolbar to mark it by hand; marks you draw show
            up below as approved.
          </p>
        </section>

        {suggestions.length > 0 && (
          <section>
            <h2>2. Review</h2>
            <p className="summary">
              <b>{counts.pending}</b> pending · <b>{counts.approved}</b>{" "}
              approved · <b>{counts.rejected}</b> rejected
            </p>
            {groups.map(([rule, g]) => (
              <details key={rule} open>
                <summary>
                  {g.label} <span className="muted">({g.items.length})</span>
                </summary>
                <div className="row small">
                  <button
                    className="ghost"
                    disabled={phase === "applied"}
                    onClick={() =>
                      decide(
                        g.items.map((i) => i.id),
                        "approved",
                      )
                    }
                  >
                    Approve all
                  </button>
                  <button
                    className="ghost"
                    disabled={phase === "applied"}
                    onClick={() =>
                      decide(
                        g.items.map((i) => i.id),
                        "rejected",
                      )
                    }
                  >
                    Reject all
                  </button>
                </div>
                <ul className="items">
                  {g.items.map((s) => (
                    <li key={s.id} className={s.status}>
                      <button
                        className="link"
                        onClick={() => {
                          const a = annots.current.get(s.id);
                          if (a) {
                            core.current.annotationManager.selectAnnotation(a);
                            core.current.annotationManager.jumpToAnnotation(a);
                          }
                        }}
                      >
                        p.{s.page} · {s.text}
                      </button>
                      <span className="actions">
                        <button
                          disabled={phase === "applied"}
                          className={s.status === "approved" ? "on" : ""}
                          onClick={() => decide([s.id], "approved")}
                        >
                          ✓
                        </button>
                        <button
                          disabled={phase === "applied"}
                          className={s.status === "rejected" ? "off" : ""}
                          onClick={() => decide([s.id], "rejected")}
                        >
                          ✕
                        </button>
                      </span>
                    </li>
                  ))}
                </ul>
              </details>
            ))}
          </section>
        )}

        {phase !== "ready" && (
          <section>
            <h2>3. Apply</h2>
            {phase === "detected" ? (
              <>
                <label>
                  <input
                    type="checkbox"
                    checked={sanitize}
                    onChange={(e) => setSanitize(e.target.checked)}
                  />
                  Also remove hidden data afterwards (
                  {SANITIZE_CATEGORIES.join(", ")})
                </label>
                <button
                  className="danger"
                  disabled={!canApply}
                  onClick={() => setConfirming(true)}
                >
                  Apply {counts.approved} approved redaction
                  {counts.approved === 1 ? "" : "s"}
                </button>
                {counts.pending > 0 && (
                  <p className="muted small">
                    Decide on {counts.pending} pending item(s) first.
                  </p>
                )}
              </>
            ) : (
              <p className="ok">
                Applied.
                {audit.some((e) => e.action === "sanitized")
                  ? " The hidden-data step ran without an error. Check the file with verify.py."
                  : ""}{" "}
                The marked content is removed from the open document.
              </p>
            )}
          </section>
        )}

        {phase === "applied" && (
          <section>
            <h2>4. Verify</h2>
            <div className="row">
              <button className="ghost" disabled={!!busy} onClick={runVerify}>
                Re-scan in app
              </button>
              <button className="primary" onClick={download}>
                Download redacted PDF
              </button>
              {SAVE_ENDPOINT && (
                <button className="ghost" disabled={!!busy} onClick={sendOut}>
                  Send to document system
                </button>
              )}
            </div>
            {sent && <p className="ok">{sent}</p>}
            {verify && (
              <p className={verify.remaining === 0 ? "ok" : "bad"}>
                {verify.remaining === 0
                  ? "In-app re-scan: 0 matches remain for the enabled rules."
                  : `In-app re-scan: ${verify.remaining} match(es) remain.`}
              </p>
            )}
            <p className="muted small">
              The re-scan is the app checking itself. For independent proof, run{" "}
              <code>python scripts/verify.py redacted_{fileName.current}</code>{" "}
              on the downloaded file.
            </p>
            {outputHash && (
              <p className="muted small">
                Output sha256: <code>{outputHash.slice(0, 16)}…</code>
              </p>
            )}
          </section>
        )}

        <section>
          <h2>5. Audit log</h2>
          <p className="muted small">
            Kept by this app. It records who did what, to which rule and page,
            but never the matched text.
          </p>
          <div className="row">
            <button
              className="ghost"
              disabled={audit.length === 0}
              onClick={() => exportAudit("json")}
            >
              Export JSON
            </button>
            <button
              className="ghost"
              disabled={audit.length === 0}
              onClick={() => exportAudit("csv")}
            >
              Export CSV
            </button>
          </div>
          {audit.length > 0 && (
            <table className="log">
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Who</th>
                  <th>Action</th>
                  <th>Detail</th>
                </tr>
              </thead>
              <tbody>
                {[...audit]
                  .reverse()
                  .slice(0, 40)
                  .map((e, i) => (
                    <tr key={i}>
                      <td>{new Date(e.at).toLocaleTimeString()}</td>
                      <td>{e.reviewer}</td>
                      <td>{e.action}</td>
                      <td>
                        {[
                          e.rule,
                          e.page ? `p.${e.page}` : "",
                          e.count !== undefined ? `×${e.count}` : "",
                          e.detail,
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                      </td>
                    </tr>
                  ))}
              </tbody>
            </table>
          )}
        </section>
      </aside>

      {confirming && (
        <div className="overlay">
          <div className="modal">
            <h3>Apply redactions permanently?</h3>
            <p>
              {counts.approved} approved redaction
              {counts.approved === 1 ? "" : "s"} will be removed from the open
              document. This can't be undone.{" "}
              {counts.rejected > 0 &&
                `${counts.rejected} rejected mark(s) are discarded.`}
            </p>
            <div className="row">
              <button className="ghost" onClick={() => setConfirming(false)}>
                Cancel
              </button>
              <button className="danger" onClick={doApply}>
                Apply permanently
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
