"""Local text-analysis service for the review app: text in, entity offsets out.

Why it exists: the app can suggest redactions from Presidio (names, places, checksum-validated numbers) in
addition to its own regex rules. The browser sends one page's TEXT (never the file) and gets back offsets.
The service never echoes or logs the text. It binds to 127.0.0.1 only.

Offsets are returned in UTF-16 code units, which is how JavaScript indexes strings. Python indexes by code point,
so the two differ when a page contains characters outside the Basic Multilingual Plane (emoji, some symbols).

  python scripts/presidio_service.py            # listens on 127.0.0.1:5055
  python scripts/presidio_service.py --port 5056

  GET  /health   -> {"ok": true, "engine": "presidio"}
  POST /analyze  {"text": "...", "min_score": 0.4}  -> {"results": [{"entity_type", "start", "end", "score"}]}
"""

import argparse
import json
import logging
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

# Presidio's email recognizer tries to download a public-suffix list and falls back to a bundled one. Harmless.
logging.getLogger("tldextract").setLevel(logging.CRITICAL)

from presidio_analyzer import AnalyzerEngine  # noqa: E402

ENTITIES = [
    "US_SSN",
    "CREDIT_CARD",
    "EMAIL_ADDRESS",
    "PHONE_NUMBER",
    "IBAN_CODE",
    "PERSON",
    "LOCATION",
]
MAX_BODY = 1_000_000  # bytes; one page of text is far smaller
ALLOWED_ORIGINS = {"http://localhost:5173", "http://127.0.0.1:5173"}

analyzer: AnalyzerEngine | None = None


def to_utf16_offsets(text: str, indices: list[int]) -> list[int]:
    """Convert Python code-point indices into JavaScript UTF-16 indices."""
    if all(ord(c) <= 0xFFFF for c in text):
        return indices
    table, total = [], 0
    for c in text:
        table.append(total)
        total += 2 if ord(c) > 0xFFFF else 1
    table.append(total)
    return [table[i] for i in indices]


def analyze(text: str, min_score: float) -> list[dict]:
    assert analyzer is not None
    found = analyzer.analyze(
        text=text, language="en", entities=ENTITIES, score_threshold=min_score
    )
    starts = to_utf16_offsets(text, [r.start for r in found])
    ends = to_utf16_offsets(text, [r.end for r in found])
    return [
        {
            "entity_type": r.entity_type,
            "start": s,
            "end": e,
            "score": round(float(r.score), 3),
        }
        for r, s, e in zip(found, starts, ends)
    ]


class Handler(BaseHTTPRequestHandler):
    def _cors(self) -> None:
        origin = self.headers.get("Origin", "")
        if origin in ALLOWED_ORIGINS:
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
            self.send_header("Access-Control-Allow-Headers", "Content-Type")
            self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")

    def _json(self, status: int, payload: dict) -> None:
        body = json.dumps(payload).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self) -> None:  # CORS preflight
        self.send_response(204)
        self._cors()
        self.end_headers()

    def do_GET(self) -> None:
        if self.path == "/health":
            self._json(200, {"ok": True, "engine": "presidio"})
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self) -> None:
        if self.path != "/analyze":
            return self._json(404, {"error": "not found"})
        length = int(self.headers.get("Content-Length", "0"))
        if length <= 0 or length > MAX_BODY:
            return self._json(413, {"error": "body missing or too large"})
        try:
            data = json.loads(self.rfile.read(length))
            text = data["text"]
            min_score = float(data.get("min_score", 0.4))
            if not isinstance(text, str):
                raise ValueError("text must be a string")
        except (ValueError, KeyError, json.JSONDecodeError):
            return self._json(400, {"error": 'expected JSON like {"text": "..."}'})
        self._json(200, {"results": analyze(text, min_score)})

    def log_message(
        self, fmt: str, *args
    ) -> None:  # request lines only; bodies are never logged
        print(f"{self.command} {self.path} -> {args[1] if len(args) > 1 else ''}")


def main() -> None:
    global analyzer
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=5055)
    args = ap.parse_args()
    print("Loading Presidio (first start takes a few seconds)...")
    analyzer = AnalyzerEngine()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(
        f"Listening on http://127.0.0.1:{args.port}  (text in, offsets out; nothing is stored)"
    )
    server.serve_forever()


if __name__ == "__main__":
    main()
