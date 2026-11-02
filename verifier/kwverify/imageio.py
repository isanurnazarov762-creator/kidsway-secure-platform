"""Safe image intake.

Uploaded images are attacker-controlled. Before any decoder touches the pixels we:
- accept only JPEG and PNG, recognised by their real file signature (not a declared type),
- read the width and height from the file header and refuse huge images, so a tiny file that
  expands to gigabytes of pixels ("decompression bomb") is rejected before decoding,
- decode in memory only; nothing is ever written to disk.
"""
from __future__ import annotations

import base64
import binascii
import struct

import numpy as np

MAX_BYTES = 4 * 1024 * 1024        # per image, after base64 decoding
MAX_SIDE = 4096                    # pixels
MAX_PIXELS = 16_000_000


class ImageError(ValueError):
    """Raised for any image we refuse. The message is a short code, safe to return to the caller."""


def b64_to_bytes(data: str) -> bytes:
    if not isinstance(data, str) or len(data) > MAX_BYTES * 4 // 3 + 8:
        raise ImageError("image_too_large")
    try:
        raw = base64.b64decode(data, validate=True)
    except (binascii.Error, ValueError):
        raise ImageError("image_not_base64") from None
    if len(raw) < 32 or len(raw) > MAX_BYTES:
        raise ImageError("image_size")
    return raw


def header_size(raw: bytes) -> tuple[str, int, int]:
    """Returns (kind, width, height) from the file header, without decoding the image."""
    if raw[:8] == b"\x89PNG\r\n\x1a\n":
        if raw[12:16] != b"IHDR":
            raise ImageError("image_corrupt")
        w, h = struct.unpack(">II", raw[16:24])
        return "png", w, h
    if raw[:3] == b"\xff\xd8\xff":
        i = 2
        while i + 9 < len(raw):
            if raw[i] != 0xFF:
                raise ImageError("image_corrupt")
            marker = raw[i + 1]
            if marker in (0xD8, 0x01) or 0xD0 <= marker <= 0xD7:   # markers without a length
                i += 2
                continue
            seg_len = struct.unpack(">H", raw[i + 2:i + 4])[0]
            # SOF0..SOF15 except DHT (C4), JPG (C8) and DAC (CC) carry the frame size
            if 0xC0 <= marker <= 0xCF and marker not in (0xC4, 0xC8, 0xCC):
                h, w = struct.unpack(">HH", raw[i + 5:i + 9])
                return "jpeg", w, h
            i += 2 + seg_len
        raise ImageError("image_corrupt")
    raise ImageError("image_type")  # not JPEG or PNG


def decode(data_b64: str) -> np.ndarray:
    """base64 JPEG/PNG -> BGR array, with every check above."""
    import cv2  # imported here so the pure checks can be tested without OpenCV

    raw = b64_to_bytes(data_b64)
    _, w, h = header_size(raw)
    if w == 0 or h == 0 or w > MAX_SIDE or h > MAX_SIDE or w * h > MAX_PIXELS:
        raise ImageError("image_dimensions")
    img = cv2.imdecode(np.frombuffer(raw, dtype=np.uint8), cv2.IMREAD_COLOR)
    if img is None:
        raise ImageError("image_corrupt")
    if img.shape[0] != h or img.shape[1] != w:
        raise ImageError("image_corrupt")  # header lied about the size
    return img
