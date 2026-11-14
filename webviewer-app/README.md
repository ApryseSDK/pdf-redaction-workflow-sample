# Redaction review app (WebViewer)

A small React and WebViewer app for the accompanying video. It finds sensitive text in code, shows each find as a mark
in the viewer, makes a person approve or reject each one, applies only what was approved, can optionally try hidden-data removal (experimental, off by default),
re-scans, and keeps an audit log.

All sample data is fake. Nothing is uploaded: with `fullAPI: true` the file is processed in the browser.

## Run it

```bash
npm install
cp .env.example .env.local
npm run dev
```

Put your WebViewer key in `.env.local` (keep it out of version control). Open http://localhost:5173. `npm install` copies the WebViewer files into `public/lib`.

Optional, for names and places: start the Presidio service, then tick the checkbox in the app.

```bash
python scripts/presidio_service.py
```

It listens on 127.0.0.1:5055 and receives page text only, never the PDF. The app checks for it on load, so a
"connection refused" for `/health` in the terminal running Vite is normal when it is not running.

## The flow

1. **Find suggestions.** Rules (SSN, card with Luhn check, email, phone) plus your extra terms. Each match becomes a pending mark.
2. **Review.** Approve or reject each item or a whole group. You can also draw a mark with the viewer's redaction tool
   (needed for text inside a scanned image); it counts as approved.
3. **Apply.** Disabled until nothing is pending. A confirmation appears first. Only approved marks are applied.
4. **Remove hidden data** (optional checkbox, **off by default**). If ticked, after applying, the app calls `PDFNet.Sanitizer` in the browser to remove
   document metadata, embedded files, comments and markups, hidden layers, hidden text, actions and bookmarks. Apryse documents
   sanitization as a **Server SDK** capability. Whether it is supported and licensed in the Web SDK is unconfirmed, so treat this checkbox
   as experimental. The server version is in `../apryse-server/`. If you do use the checkbox, run it after applying: sanitizing first was never tested.
5. **Verify.** An in-app re-scan, plus the download. The re-scan is the app checking itself. For independent proof run
   `python scripts/verify.py` on the file (see the root README for batch use).
6. **Record.** The audit log: who, what, rule, page, time, and a hash of each download. Matched text is never written to the log. Export as JSON or CSV.

The viewer's own redaction panel is hidden on purpose, because its Redact All button would skip the approval step.

## Where it plugs into a document system

This is a pattern, not a connector. Nothing here knows about any real product. The three touch points are in `src/integration.ts`:

| Direction | How                                                                                                                                                                                                       |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| File in   | Add `?file=<url>` to the page address. Only http(s) URLs and same-site paths are accepted. The default is the sample.                                                                                     |
| File out  | Set `VITE_SAVE_ENDPOINT` in `.env.local`. A "Send to document system" button then POSTs the redacted PDF to `{endpoint}/documents` with headers `X-File-Name`, `X-Original-Sha256` and `X-Output-Sha256`. |
| Audit out | The same button then POSTs the audit log as JSON to `{endpoint}/audit`. If the document upload fails, the audit log is not sent.                                                                          |

Your endpoint must allow cross-origin requests from the app and those custom headers. Replace `sendToDocumentSystem` with your own storage call.
Each export produces slightly different bytes, so the hash in the audit log belongs to that specific download or send.

## What was checked

- `npm run typecheck`, `npm test` (25 tests: rules, Presidio offset mapping, audit, integration) and `npm run build` pass.
- Headless Chromium with WebViewer 12.2.1 in demo mode, full flow: 6 suggestions found on page 1, apply blocked while any are pending,
  two reviewer marks added on the scanned page, 8 approved and applied, hidden data removed, in-app re-scan shows 0,
  download works, and the send step posted the PDF and audit log to a local stand-in endpoint. The posted file's hash matched
  its header, and the audit log contained none of the planted values.
- `verify.py` on the download from that run, with the hidden-data box ticked: **0 of 10** planted items recoverable.
  With the box unticked and no marks on the scan: 6 of 10. With the box ticked but only the SSN marked on the scan: 2 of 10 (the name in the scanned image).
  With the box unticked and both scan marks made: 5 of 10 (title, author, comment, embedded file, and the name via the author field), observed in a hand-run session in November 2026.

## What was not checked

- The headless run created the scan marks in code. Drawing them with the mouse was checked separately, by hand.
- The Presidio checkbox against a running service, in the browser.
- Licensed (non-demo) behavior. Confirm redaction is enabled on your key.
- Form field data, occluded text and search indexes are not removed by the hidden-data step.
- Rule-based detection misses things and matches things that are not sensitive, which is why a person reviews.
- The 10 planted items are a demonstration, not a benchmark of any product.

## Files

`src/rules.ts` patterns and overlap handling · `src/presidio.ts` offset mapping and service client · `src/detect.ts`
all WebViewer calls · `src/integration.ts` file in and out · `src/audit.ts` log and hashing · `src/App.tsx` the review UI.
