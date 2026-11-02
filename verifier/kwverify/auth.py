"""Request signing between the KidsWay API and the verifier.

The verifier sits on an internal network with no published ports, and on top of that every request
must carry X-KW-Timestamp and X-KW-Signature = HMAC-SHA256(key, timestamp + "." + body).
- A request from anything that does not hold the key is refused.
- A captured request cannot be replayed: the timestamp must be within 60 s and a signature is
  accepted only once.
"""
from __future__ import annotations

import hashlib
import hmac
import threading
import time

WINDOW = 60


class Signer:
    def __init__(self, key: bytes) -> None:
        if len(key) < 32:
            raise ValueError("VERIFIER_KEY must be at least 32 bytes")
        self._key = key
        self._seen: dict[str, float] = {}
        self._lock = threading.Lock()

    def sign(self, ts: str, body: bytes) -> str:
        return hmac.new(self._key, ts.encode() + b"." + body, hashlib.sha256).hexdigest()

    def check(self, ts: str | None, sig: str | None, body: bytes, now: float | None = None) -> bool:
        now = time.time() if now is None else now
        if not ts or not sig or not ts.isdigit() or len(sig) != 64:
            return False
        if abs(now - int(ts)) > WINDOW:
            return False
        if not hmac.compare_digest(self.sign(ts, body), sig):
            return False
        with self._lock:
            for k, exp in list(self._seen.items()):
                if exp < now:
                    del self._seen[k]
            if sig in self._seen:
                return False          # replay
            self._seen[sig] = now + WINDOW * 2
        return True
