"""Face detection (YuNet) and face recognition (SFace), both from the OpenCV model zoo.

Small ONNX models that run on a normal CPU through OpenCV, no GPU and no cloud service needed.
The model files are pinned by SHA-256: a swapped or corrupted model is refused at start-up.
"""
from __future__ import annotations

import hashlib
from dataclasses import dataclass
from pathlib import Path

import numpy as np

MODELS = {
    "detector": {
        "file": "face_detection_yunet_2023mar.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/face_detection_yunet_2023mar.onnx",
        "sha256": "8f2383e4dd3cfbb4553ea8718107fc0423210dc964f9f4280604804ed2552fa4",
        "size": 232589,
    },
    "recognizer": {
        "file": "face_recognition_sface_2021dec.onnx",
        "url": "https://github.com/opencv/opencv_zoo/raw/main/models/face_recognition_sface/face_recognition_sface_2021dec.onnx",
        "sha256": "0ba9fbfa01b5270c96627c4ef784da859931e02f04419c829e83484087c34e79",
        "size": 38696353,
    },
}
SAME_PERSON = 0.363   # SFace cosine threshold recommended by OpenCV
MIN_FACE_SCORE = 0.85
WORK_SIDE = 1280      # images are scaled down to this before detection


@dataclass
class Face:
    box: tuple[float, float, float, float]          # x, y, w, h
    landmarks: list[tuple[float, float]]            # right eye, left eye, nose, right mouth, left mouth (of the person)
    score: float
    row: np.ndarray | None = None                   # raw YuNet row, needed for alignment

    @property
    def area(self) -> float:
        return self.box[2] * self.box[3]

    def yaw(self) -> float:
        """Head turn: how far the nose sits from the middle of the eyes, in eye distances.
        0 looking straight; positive = nose towards the right of the image."""
        (rx, ry), (lx, ly), (nx, _ny) = self.landmarks[0], self.landmarks[1], self.landmarks[2]
        mid = (rx + lx) / 2
        eye = max(1e-6, float(np.hypot(lx - rx, ly - ry)))
        return (nx - mid) / eye


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


class ModelError(RuntimeError):
    pass


def check_models(models_dir: Path) -> dict[str, Path]:
    paths = {}
    for key, m in MODELS.items():
        p = models_dir / m["file"]
        if not p.exists():
            raise ModelError(f"{m['file']} is missing: run python download_models.py")
        if sha256_file(p) != m["sha256"]:
            raise ModelError(f"{m['file']} does not match its pinned SHA-256: refusing to load it")
        paths[key] = p
    return paths


def scale_down(img: np.ndarray) -> np.ndarray:
    import cv2
    h, w = img.shape[:2]
    s = min(1.0, WORK_SIDE / max(h, w))
    return img if s == 1.0 else cv2.resize(img, (int(w * s), int(h * s)), interpolation=cv2.INTER_AREA)


class FaceEngine:
    """Real engine. Tests use a fake with the same three methods."""

    def __init__(self, models_dir: Path) -> None:
        import cv2
        paths = check_models(models_dir)
        self._det = cv2.FaceDetectorYN.create(str(paths["detector"]), "", (320, 320), 0.6, 0.3, 50)
        self._rec = cv2.FaceRecognizerSF.create(str(paths["recognizer"]), "")

    def detect(self, img: np.ndarray) -> list[Face]:
        h, w = img.shape[:2]
        self._det.setInputSize((w, h))
        _, rows = self._det.detect(img)
        faces = []
        for r in (rows if rows is not None else []):
            lm = [(float(r[4 + 2 * i]), float(r[5 + 2 * i])) for i in range(5)]
            faces.append(Face((float(r[0]), float(r[1]), float(r[2]), float(r[3])), lm, float(r[14]), r))
        return faces

    def embed(self, img: np.ndarray, face: Face) -> np.ndarray:
        aligned = self._rec.alignCrop(img, face.row)
        return self._rec.feature(aligned)

    def similarity(self, a: np.ndarray, b: np.ndarray) -> float:
        import cv2
        return float(self._rec.match(a, b, cv2.FaceRecognizerSF_FR_COSINE))
