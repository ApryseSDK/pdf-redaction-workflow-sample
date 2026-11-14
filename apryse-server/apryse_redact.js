/**
 * Apryse Server SDK (Node) redaction demo: detect -> review -> apply -> sanitize -> audit.
 *
 * STATUS: the `sanitize` command has run against the real Server SDK (trial key, demo mode) and removed metadata, comments and
 * embedded files from the sample. `detect` and `apply` were written from the published docs and have NOT been run for real. Items marked CONFIRM below are the spots most likely to need a tweak.
 *
 *   npm install
 *   cp .env.example .env                           # then add your Server SDK key to APRYSE_SERVER_KEY
 *                                                  # (redaction may need to be enabled on your key)
 *
 *   # 1. DETECT: regex rules + literal terms + manual regions -> marks.json (nothing is changed yet)
 *   node apryse_redact.js detect ../originals/sample_claim.pdf ../work/marks.json \
 *        --term "Jordan A. Example" --term "100 Example Street" \
 *        --region 2,125,586,267,609 --region 2,90,555,190,574
 *        (the two regions are the name and the SSN on the scanned page 2, in PDF points, origin bottom-left,
 *         measured from a 144 dpi render with Tesseract word boxes and padded by 3 points)
 *
 *   # 2. REVIEW: open marks.json, set "approved": false on anything that should NOT be redacted
 *
 *   # 3. APPLY (irreversible on the output copy; the original is never touched) + sanitize + audit log
 *   node apryse_redact.js apply ../originals/sample_claim.pdf ../work/marks.json ../output/apryse.pdf \
 *        --sanitize --reviewer "Demo reviewer"
 *
 *   # 4. VERIFY with the independent checker (not Apryse)
 *   python ../scripts/verify.py ../output/apryse.pdf
 *
 * BROWSER + SERVER: sanitize a file that the WebViewer app already redacted (download it with the
 * "Also remove hidden data" box UNticked, copy it to ../output/browser_redacted.pdf):
 *   node apryse_redact.js sanitize ../output/browser_redacted.pdf ../output/browser_plus_server.pdf --reviewer "Demo reviewer"
 *   python ../scripts/verify.py ../output/browser_plus_server.pdf
 *
 * Scanned pages: regex search only sees real text, so text baked into an image is NOT found by the rules.
 * The --region flag marks an area by hand ("page,x1,y1,x2,y2", PDF points, origin bottom-left), which is
 * what a human reviewer does on a scan. This sample does not test whether the SDK can find text in scans
 * on its own.
 */
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { PDFNet } = require("@pdftron/pdfnet-node");

// Regex rules. CONFIRM the engine's regex dialect on these (kept simple on purpose: no \b, no lookarounds).
const RULES = [
  { id: "ssn", pattern: "\\d{3}-\\d{2}-\\d{4}" },
  { id: "card", pattern: "\\d{4}[ -]?\\d{4}[ -]?\\d{4}[ -]?\\d{4}" },
  { id: "email", pattern: "[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}" },
];

const sha256 = (p) =>
  crypto.createHash("sha256").update(fs.readFileSync(p)).digest("hex");

function parseArgs(argv) {
  const pos = [],
    terms = [],
    regions = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--term") terms.push(argv[++i]);
    else if (a === "--region") regions.push(argv[++i]);
    else if (a === "--reviewer") flags.reviewer = argv[++i];
    else if (a === "--sanitize") flags.sanitize = true;
    else pos.push(a);
  }
  return { pos, terms, regions, flags };
}

async function openDoc(file) {
  const doc = await PDFNet.PDFDoc.createFromFilePath(file); // name as in SDK 12.2.1 (used by the sanitize run)
  await doc.initSecurityHandler();
  return doc;
}

/** Run one search (regex or literal) and return the highlighted rectangles it found. */
async function search(doc, pattern, isRegex) {
  const found = [];
  const ts = await PDFNet.TextSearch.create();
  let mode = PDFNet.TextSearch.Mode.e_highlight;
  if (isRegex) mode |= PDFNet.TextSearch.Mode.e_reg_expression;
  await ts.begin(doc, pattern, mode);
  let result = await ts.run();
  while (result.code === PDFNet.TextSearch.ResultCode.e_found) {
    const hl = result.highlights;
    await hl.begin(doc);
    while (await hl.hasNext()) {
      const page = await hl.getCurrentPageNumber();
      const quads = await hl.getCurrentQuads();
      for (const q of quads) {
        // CONFIRM quad field names (p1x..p4y) against the sample
        const xs = [q.p1x, q.p2x, q.p3x, q.p4x],
          ys = [q.p1y, q.p2y, q.p3y, q.p4y];
        found.push({
          page,
          rect: [
            Math.min(...xs),
            Math.min(...ys),
            Math.max(...xs),
            Math.max(...ys),
          ],
        });
      }
      await hl.next();
    }
    result = await ts.run();
  }
  return found;
}

async function detect(input, marksPath, { terms, regions }) {
  const doc = await openDoc(input);
  const marks = [];
  const add = (rule, hits) =>
    hits.forEach((h) =>
      marks.push({ id: marks.length + 1, rule, ...h, approved: true }),
    );
  for (const r of RULES) add(r.id, await search(doc, r.pattern, true));
  for (const t of terms) add("term", await search(doc, t, false));
  for (const r of regions) {
    const [page, x1, y1, x2, y2] = r.split(",").map(Number);
    marks.push({
      id: marks.length + 1,
      rule: "manual-region",
      page,
      rect: [x1, y1, x2, y2],
      approved: true,
    });
  }
  fs.mkdirSync(path.dirname(marksPath), { recursive: true });
  fs.writeFileSync(
    marksPath,
    JSON.stringify(
      { source: path.basename(input), sourceSha256: sha256(input), marks },
      null,
      2,
    ),
  );
  const byRule = marks.reduce(
    (m, x) => ((m[x.rule] = (m[x.rule] || 0) + 1), m),
    {},
  );
  console.log(
    `Found ${marks.length} marks`,
    byRule,
    `-> ${marksPath}\nReview the file, then run "apply".`,
  );
}

/** A separate operation from redaction: clears hidden data. Option names per the SanitizeOptions docs. */
async function sanitizeDoc(doc) {
  const opts = await PDFNet.Sanitizer.createSanitizeOptions();
  await opts.setMetadata(true); // setter names as in SDK 12.2.1 (used by the sanitize run)
  await opts.setEmbeddedContent(true);
  await opts.setMarkups(true); // comments / annotations
  await opts.setHiddenLayers(true);
  await opts.setHiddenText(true);
  await opts.setActions(true);
  await opts.setBookmarks(true);
  await PDFNet.Sanitizer.sanitizeDocument(doc, opts);
}

/** Sanitize-only: for a file that was already redacted somewhere else (for example in the WebViewer app). */
async function sanitizeOnly(input, output, { flags }) {
  const doc = await openDoc(input);
  await sanitizeDoc(doc);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  await doc.save(output, PDFNet.SDFDoc.SaveOptions.e_remove_unused); // full save, not incremental
  const audit = {
    when: new Date().toISOString(),
    reviewer: flags.reviewer || "unknown",
    operation: "sanitize-only",
    input: path.basename(input),
    inputSha256: sha256(input),
    output: path.basename(output),
    outputSha256: sha256(output),
    sanitized: true,
  };
  const auditPath = output.replace(/\.pdf$/i, ".audit.json");
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  console.log(`Sanitized -> ${output}\nAudit log -> ${auditPath}`);
}

async function apply(input, marksPath, output, { flags }) {
  const file = JSON.parse(fs.readFileSync(marksPath, "utf8"));
  const approved = file.marks.filter((m) => m.approved);
  const doc = await openDoc(input);

  const reds = [];
  for (const m of approved) {
    const rect = await PDFNet.Rect.init(...m.rect);
    reds.push(await PDFNet.Redactor.redactionCreate(m.page, rect, false, ""));
  }
  const appearance = {
    redaction_overlay: true,
    positive_overlay_color: await PDFNet.ColorPt.init(0, 0, 0), // black boxes
    border: false,
  };
  await PDFNet.Redactor.redact(doc, reds, appearance); // removes content under each region

  if (flags.sanitize) await sanitizeDoc(doc);

  fs.mkdirSync(path.dirname(output), { recursive: true });
  await doc.save(output, PDFNet.SDFDoc.SaveOptions.e_remove_unused); // full save, not incremental

  // Customer-built audit record. Deliberately holds NO matched text: only rules, pages and locations.
  const audit = {
    when: new Date().toISOString(),
    reviewer: flags.reviewer || "unknown",
    input: path.basename(input),
    inputSha256: sha256(input),
    output: path.basename(output),
    outputSha256: sha256(output),
    sanitized: !!flags.sanitize,
    applied: approved.map(({ id, rule, page, rect }) => ({
      id,
      rule,
      page,
      rect,
    })),
    rejected: file.marks
      .filter((m) => !m.approved)
      .map(({ id, rule, page }) => ({ id, rule, page })),
  };
  const auditPath = output.replace(/\.pdf$/i, ".audit.json");
  fs.writeFileSync(auditPath, JSON.stringify(audit, null, 2));
  console.log(
    `Applied ${approved.length} redactions${flags.sanitize ? " + sanitize" : ""} -> ${output}\nAudit log -> ${auditPath}`,
  );
}

const { pos, terms, regions, flags } = parseArgs(process.argv.slice(2));
const [cmd, input, a, b] = pos;

// Key: APRYSE_SERVER_KEY, read from the .env file next to this script (an environment variable of the same name also works).
try {
  for (const line of fs
    .readFileSync(path.join(__dirname, ".env"), "utf8")
    .split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !line.trim().startsWith("#") && !process.env[m[1]])
      process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, "$2");
  }
} catch (e) {
  /* no .env file, which is fine */
}
const LICENSE_KEY =
  process.env.APRYSE_SERVER_KEY || process.env.APRYSE_LICENSE_KEY || "";
if (["detect", "apply", "sanitize"].includes(cmd) && !LICENSE_KEY) {
  console.error(
    "No Apryse Server SDK key found.\nCopy .env.example to .env and add your key to APRYSE_SERVER_KEY.\nFor a trial key, follow the Node.js get-started guide: https://docs.apryse.com/core/guides/get-started/nodejs",
  );
  process.exit(1);
}

PDFNet.runWithCleanup(async () => {
  if (cmd === "detect") await detect(input, a, { terms, regions });
  else if (cmd === "apply") await apply(input, a, b, { flags });
  else if (cmd === "sanitize") await sanitizeOnly(input, a, { flags });
  else
    console.log(
      "usage: detect <in.pdf> <marks.json> [--term T] [--region p,x1,y1,x2,y2]\n       apply <in.pdf> <marks.json> <out.pdf> [--sanitize] [--reviewer NAME]\n       sanitize <in.pdf> <out.pdf> [--reviewer NAME]",
    );
}, LICENSE_KEY)
  .catch((e) => {
    console.error("Error:", e && e.message ? e.message : JSON.stringify(e));
    process.exitCode = 1;
  })
  .then(() => PDFNet.shutdown());
