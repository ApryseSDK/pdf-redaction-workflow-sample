// WebViewer runs entirely in the browser, so its engine and worker files must be served from /public.
// This copies them (once) and puts the fictional sample PDF next to them. Runs after npm install and before npm run dev.
import { copyFileSync, cpSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const assetsSrc = resolve(root, "node_modules/@pdftron/webviewer/public");
const assetsDst = resolve(root, "public/lib/webviewer");
mkdirSync(resolve(root, "public"), { recursive: true });

if (!existsSync(assetsSrc)) {
  console.warn("WebViewer package not installed yet. Run: npm install");
} else if (existsSync(assetsDst)) {
  console.log("WebViewer assets already in public/lib/webviewer");
} else {
  cpSync(assetsSrc, assetsDst, { recursive: true });
  console.log("Copied WebViewer assets to public/lib/webviewer");
}

const sample = resolve(root, "../originals/sample_claim.pdf");
if (existsSync(sample)) {
  copyFileSync(sample, resolve(root, "public/sample_claim.pdf"));
  console.log("Copied sample PDF to public/sample_claim.pdf");
} else {
  console.warn(
    "No ../originals/sample_claim.pdf. Run python scripts/make_sample.py first, or open your own PDF in the app.",
  );
}
