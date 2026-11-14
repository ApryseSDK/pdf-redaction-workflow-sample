# Apryse Server SDK script (Node.js)

`apryse_redact.js` is a Node.js script that uses the Apryse Server SDK (`@pdftron/pdfnet-node`). It is **not** Python.
(`verify.py` in the kit root is the Python checker, and it is not an Apryse product.)

## Status

Written from Apryse's public documentation. **The `sanitize` command has been run against the real Server SDK**, once, on a Mac with Node
v25.8.1 and `@pdftron/pdfnet-node` ^12.2.1, using a trial key (the SDK logs "PDFNet is running in demo mode" and "PackageV2: base").
Results on the sample:

- Sanitizing the unredacted sample removed the title, author, sticky-note comment and embedded file. The checker's metadata,
  annotation and attachment columns were all clear (7 of 10 planted items remained, as predicted, because the page content was untouched).
- Sanitizing a file downloaded from the WebViewer app (hidden-data box unticked, text marks and scan boxes applied) took the checker from
  5 of 10 to 0 of 10.

**Not yet run for real:** the `detect` and `apply` commands (they use `TextSearch` and `Redactor`), any document with hidden layers, form
fields, occluded text or search indices, and a production license. The comments marked `CONFIRM` in the script mark calls in `detect` and `apply` that still need
a first real run. The saved copy carried a watermark, as expected for a trial key in demo mode.

## Get a key

The script needs an Apryse Server SDK key. Apryse's [Node.js get-started guide](https://docs.apryse.com/core/guides/get-started/nodejs) explains how to get a free trial key. If you are signed in with an Apryse account, the guide shows your key in its code snippets. The guide also says that trials collect some usage data, and that you can ask Apryse for a no-tracking trial key.

Put your key in a local `.env` file. Never commit it. Git ignores this file.

```
cp .env.example .env
```

Then open `.env` and paste your key after `APRYSE_SERVER_KEY=`.

The WebViewer app uses a separate setting (`VITE_APRYSE_WEBVIEWER_KEY` in `webviewer-app/.env.local`). The Server SDK key may be a different key from the WebViewer one.

## What it does

| Command                                                                | What it does                                                                                                                                       | Uses                               |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| `detect <in.pdf> <marks.json> [--term T] [--region p,x1,y1,x2,y2]`     | Finds text with three regexes (SSN, card, email) and your literal terms, and adds any hand-measured regions. Writes `marks.json`. Changes nothing. | `TextSearch`                       |
| `apply <in.pdf> <marks.json> <out.pdf> [--sanitize] [--reviewer NAME]` | Applies the marks that have `"approved": true`, optionally sanitizes, saves a **new** file, and writes an audit file.                              | `Redactor`, optionally `Sanitizer` |
| `sanitize <in.pdf> <out.pdf> [--reviewer NAME]`                        | Sanitizes a file that was already redacted somewhere else, for example in the WebViewer app. Saves a new file and writes an audit file.            | `Sanitizer` only                   |

The sanitizer options it turns on: metadata, embedded content, markups and comments, hidden layers, hidden text, actions, and bookmarks.
It does **not** turn on form data, occluded text, or search indices, and it has not been tested with documents that contain them.

The audit file records time, reviewer, file names, SHA-256 hashes and (for `apply`) rules, pages and rectangles. It never holds matched text.
The original file is never modified.

## Browser plus server demo

This is a sequential sample, not an integrated backend service. WebViewer handles the browser review and redaction. A separate Node script
uses the Server SDK for the next step.

1. In the WebViewer app, review, apply, and download the file with the hidden-data box **unticked**.
2. In this folder: `npm install` (needs internet), and set your key as described in **Get a key** above.
3. `mkdir -p ../output`, then copy the download to `../output/browser_redacted.pdf`.
4. `npm run sanitize`.
5. From the kit root: `python scripts/verify.py output/browser_plus_server.pdf`. The checker reports how many of the 10 planted items it still finds. On the November 2026 run it reported 0 of 10.

## Licensing

The `sanitize` command ran with a trial key. Redaction functions (`detect` and `apply`) may need to be enabled on your key, so check what your license includes. A commercial license key is required for production use, per Apryse's guide.

## Known limits

- No OCR. Text inside the scanned page is not found, so you mark it by hand with `--region`. The two regions in the script's header (name and SSN on page 2)
  were measured from a 144 dpi render of this sample with Tesseract word boxes. They only fit this file.
- The regexes avoid `\b` and lookarounds on purpose, because the engine's regex dialect has not been confirmed.
