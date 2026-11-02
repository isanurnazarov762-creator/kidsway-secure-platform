"""KidsWay verifier: an internal service that checks Guardian applicants' identity documents.

POST /v1/liveness   {"frames": [{"step": "straight"|"left"|"right", "data": base64}, ...]}
POST /v1/verify     {"icFront": base64, "selfie": base64, "expected": {"ic": "...", "name": "..."}}
GET  /healthz

Every POST must be signed by the API (see kwverify/auth.py). Images are processed in memory
and forgotten when the request ends. Logs contain event codes only: never names, numbers or images.

Run (development):  python server.py            -> http://127.0.0.1:8090
Settings: VERIFIER_KEY (base64, same as the API), VERIFIER_HOST, VERIFIER_PORT, VERIFIER_MODELS
"""
from __future__ import annotations

import base64
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

from kwverify import checks
from kwverify.auth import Signer
from kwverify.imageio import ImageError, decode
from kwverify.ocr import load_engine
from kwverify.vision import FaceEngine, ModelError

MAX_BODY = 14 * 1024 * 1024
HERE = Path(__file__).resolve().parent


def load_key() -> bytes:
    """VERIFIER_KEY from the environment, or (development) from ../.env.local written by npm run setup."""
    value = os.environ.get("VERIFIER_KEY")
    if not value:
        env_file = HERE.parent / ".env.local"
        if env_file.exists():
            for line in env_file.read_text().splitlines():
                if line.startswith("VERIFIER_KEY="):
                    value = line.split("=", 1)[1].strip()
    if not value:
        sys.exit("VERIFIER_KEY is not set (run `npm run setup` in the project folder first)")
    return base64.b64decode(value)


def log(event: str, **fields) -> None:
    parts = [time.strftime("%Y-%m-%dT%H:%M:%S"), "kidsway_verifier", f"event={event}"]
    parts += [f"{k}={v}" for k, v in fields.items()]
    print(" ".join(parts), flush=True)


class App:
    def __init__(self, signer: Signer, faces, ocr) -> None:
        self.signer, self.faces, self.ocr = signer, faces, ocr

    def handle(self, method: str, path: str, headers, body: bytes) -> tuple[int, dict]:
        if method == "GET" and path == "/healthz":
            return 200, {"ok": True, "faces": self.faces is not None, "ocr": self.ocr.name}
        if method != "POST" or path not in ("/v1/liveness", "/v1/verify"):
            return 404, {"error": "not_found"}
        if not self.signer.check(headers.get("X-KW-Timestamp"), headers.get("X-KW-Signature"), body):
            log("auth_fail", path=path)
            return 401, {"error": "unauthorized"}
        if self.faces is None:
            return 503, {"error": "models_not_loaded"}
        try:
            req = json.loads(body)
            if not isinstance(req, dict):
                raise ValueError
        except ValueError:
            return 400, {"error": "invalid_json"}
        try:
            if path == "/v1/liveness":
                frames = req.get("frames")
                if not isinstance(frames, list) or len(frames) != 3:
                    return 400, {"error": "invalid_frames"}
                decoded = [(str(f.get("step")), decode(f.get("data"))) for f in frames if isinstance(f, dict)]
                res = checks.liveness(self.faces, decoded)
                log("liveness", ok=res["ok"], reasons=len(res["reasons"]))
                return 200, res
            exp = req.get("expected") if isinstance(req.get("expected"), dict) else {}
            res = checks.identity(self.faces, self.ocr, decode(req.get("icFront")), decode(req.get("selfie")),
                                  str(exp.get("ic", ""))[:20], str(exp.get("name", ""))[:120])
            log("identity", verdict=res["verdict"], reasons=len(res["reasons"]))
            return 200, res
        except ImageError as e:
            log("image_refused", code=str(e))
            return 400, {"error": str(e)}


def make_handler(app: App):
    class Handler(BaseHTTPRequestHandler):
        server_version = "kidsway"          # no version banner
        sys_version = ""

        def _send(self, status: int, payload: dict) -> None:
            data = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)

        def _run(self, method: str) -> None:
            try:
                length = int(self.headers.get("Content-Length") or 0)
            except ValueError:
                return self._send(400, {"error": "bad_length"})
            if length > MAX_BODY:
                return self._send(413, {"error": "too_large"})
            body = self.rfile.read(length) if length else b""
            try:
                status, payload = app.handle(method, self.path, self.headers, body)
            except Exception as e:  # never leak internals
                log("internal_error", kind=type(e).__name__)
                status, payload = 500, {"error": "internal_error"}
            self._send(status, payload)

        def do_GET(self): self._run("GET")
        def do_POST(self): self._run("POST")
        def log_message(self, *args): pass  # the default log prints client details; we log events only

    return Handler


def main() -> None:
    signer = Signer(load_key())
    models = Path(os.environ.get("VERIFIER_MODELS", HERE / "models"))
    try:
        faces = FaceEngine(models)
    except ModelError as e:
        log("models_missing", detail=str(e).replace(" ", "_"))
        faces = None
    ocr = load_engine()
    host = os.environ.get("VERIFIER_HOST", "127.0.0.1")
    port = int(os.environ.get("VERIFIER_PORT", "8090"))
    srv = ThreadingHTTPServer((host, port), make_handler(App(signer, faces, ocr)))
    srv.timeout = 30
    log("start", host=host, port=port, faces=faces is not None, ocr=ocr.name)
    srv.serve_forever()


if __name__ == "__main__":
    main()
