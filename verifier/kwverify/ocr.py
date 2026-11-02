"""Text recognition (OCR) engines.

1. RapidOCR (PaddleOCR models in ONNX, installed by pip, works on Windows and Linux): preferred.
2. Tesseract, if installed on the machine: fallback.
3. None: the OCR part is reported as unavailable and an officer reads the card by hand.
"""
from __future__ import annotations

import numpy as np


class OcrEngine:
    name = "none"

    def lines(self, img: np.ndarray) -> list[str]:
        return []


class RapidEngine(OcrEngine):
    name = "rapidocr"

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR  # type: ignore
        self._ocr = RapidOCR()

    def lines(self, img: np.ndarray) -> list[str]:
        result, _ = self._ocr(img)
        return [r[1] for r in (result or [])]


class TesseractEngine(OcrEngine):
    name = "tesseract"

    def __init__(self) -> None:
        import pytesseract  # type: ignore
        pytesseract.get_tesseract_version()   # raises if the program is missing
        self._t = pytesseract

    def lines(self, img: np.ndarray) -> list[str]:
        import cv2
        grey = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
        text = self._t.image_to_string(grey, config="--psm 6")
        return [l for l in text.splitlines() if l.strip()]


def load_engine() -> OcrEngine:
    for cls in (RapidEngine, TesseractEngine):
        try:
            return cls()
        except Exception:
            continue
    return OcrEngine()
