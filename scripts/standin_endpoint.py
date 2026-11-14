"""Stand-in "document system" for the redaction demo's Send button. Standard library only.

Run it (from the kit root, any terminal):
    python scripts/standin_endpoint.py

Then, in webviewer-app/.env.local, set:
    VITE_SAVE_ENDPOINT=http://127.0.0.1:5056
and restart `npm run dev` (Vite reads .env.local at startup, so the Send button only appears after a restart).

What it does, matching src/integration.ts:
    POST /documents   body = the redacted PDF; headers X-File-Name, X-Original-Sha256, X-Output-Sha256
    POST /audit       body = the audit log as JSON
It allows cross-origin requests with those custom headers (the browser sends a preflight first).
It saves what it receives into ./received/ and prints one short line per request.
It never prints file contents or audit entries. It checks that the PDF's hash matches the header.

This is a demo helper, not a connector. It listens on 127.0.0.1 only.
"""

import hashlib
import json
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from urllib.parse import unquote

HOST, PORT = "127.0.0.1", 5056
OUT = Path(__file__).resolve().parent.parent / "received"
OUT.mkdir(exist_ok=True)

ALLOWED_HEADERS = "Content-Type, X-File-Name, X-Original-Sha256, X-Output-Sha256"


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", ALLOWED_HEADERS)

    def _reply(self, code, text=""):
        body = text.encode()
        self.send_response(code)
        self._cors()
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):  # the browser's preflight for the custom headers
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_POST(self):
        length = int(self.headers.get("Content-Length", 0))
        data = self.rfile.read(length)

        if self.path == "/documents":
            name = unquote(self.headers.get("X-File-Name", "document.pdf"))
            name = Path(name).name or "document.pdf"  # never trust a path from a header
            (OUT / name).write_bytes(data)
            actual = hashlib.sha256(data).hexdigest()
            claimed = self.headers.get("X-Output-Sha256", "")
            match = "MATCH" if actual == claimed else "MISMATCH"
            print(
                f"POST /documents  {name}  {len(data):,} bytes  sha256 {actual[:12]}...  header hash: {match}"
            )
            print(
                f"                 original sha256 header: {(self.headers.get('X-Original-Sha256') or '-')[:12]}..."
            )
            self._reply(201, "saved")
        elif self.path == "/audit":
            try:
                log = json.loads(data)
                entries = log.get("entries", [])
                print(
                    f"POST /audit      {len(entries)} entries for {log.get('file', '?')}"
                )
                (OUT / "audit-log.json").write_bytes(data)
                self._reply(201, "saved")
            except json.JSONDecodeError:
                print("POST /audit      not valid JSON")
                self._reply(400, "bad json")
        else:
            self._reply(404, "not found")

    def log_message(
        self, *args
    ):  # silence the default access log; we print our own lines
        pass


if __name__ == "__main__":
    print(
        f"Stand-in document system listening on http://{HOST}:{PORT}  (saving to {OUT})"
    )
    HTTPServer((HOST, PORT), Handler).serve_forever()
