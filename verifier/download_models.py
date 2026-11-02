"""Downloads the two face models from the OpenCV model zoo and checks their SHA-256.

    python download_models.py

A file that does not match its pinned checksum is deleted and the script fails: we never run a
model we did not expect (supply-chain protection).
"""
from __future__ import annotations

import hashlib
import sys
import urllib.request
from pathlib import Path

from kwverify.vision import MODELS

DEST = Path(__file__).resolve().parent / "models"


def main() -> int:
    DEST.mkdir(exist_ok=True)
    for m in MODELS.values():
        path = DEST / m["file"]
        if path.exists() and hashlib.sha256(path.read_bytes()).hexdigest() == m["sha256"]:
            print(f"ok      {m['file']}")
            continue
        print(f"get     {m['file']} ({m['size'] // 1024} KB)")
        tmp = path.with_suffix(".part")
        with urllib.request.urlopen(m["url"], timeout=120) as r, open(tmp, "wb") as f:
            while chunk := r.read(1 << 20):
                f.write(chunk)
        digest = hashlib.sha256(tmp.read_bytes()).hexdigest()
        if digest != m["sha256"]:
            tmp.unlink()
            print(f"FAILED  {m['file']}: checksum {digest} does not match the pinned value", file=sys.stderr)
            return 1
        tmp.replace(path)
        print(f"ok      {m['file']} (SHA-256 verified)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
