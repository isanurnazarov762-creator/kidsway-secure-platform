"""The two checks the API asks for: liveness of the selfie, and identity (MyKad vs selfie vs application).

Both return results and reasons, never images or face data. Face embeddings live only in memory
during one request.
"""
from __future__ import annotations

import numpy as np

from . import mykad
from .vision import MIN_FACE_SCORE, SAME_PERSON, scale_down

STEPS = ("straight", "left", "right")
STRAIGHT_MAX = 0.15     # |yaw| when looking straight
TURN_MIN = 0.18         # |yaw| for a clear head turn
SAME_DURING_TURN = 0.30 # turned faces score lower than frontal ones, so the bar is lower here
MIN_MOTION = 3.0        # mean pixel change between frames; a still photo stays near 0


def _one_face(engine, img):
    faces = [f for f in engine.detect(img) if f.score >= MIN_FACE_SCORE]
    return faces[0] if len(faces) == 1 else None, len(faces)


def _grey_small(img: np.ndarray) -> np.ndarray:
    import cv2
    return cv2.resize(cv2.cvtColor(img, cv2.COLOR_BGR2GRAY), (64, 64)).astype(np.float32)


def liveness(engine, frames: list[tuple[str, np.ndarray]]) -> dict:
    """Active liveness: the person follows prompts in a random order chosen by the API
    (look straight, turn left, turn right). Frames come straight from the camera, not mirrored,
    so turning to the person's left moves the nose towards the right of the image.
    A printed photo or a phone screen cannot turn its head; a different person mid-way fails the
    same-person test; identical frames fail the motion test."""
    reasons: list[str] = []
    steps = [s for s, _ in frames]
    if sorted(steps) != sorted(STEPS) or len(steps) != 3:
        return {"ok": False, "score": 0.0, "reasons": ["bad_steps"]}
    imgs = {s: scale_down(img) for s, img in frames}
    faces, emb = {}, {}
    for s in STEPS:
        f, n = _one_face(engine, imgs[s])
        if f is None:
            reasons.append(f"{s}:faces={n}")
            continue
        faces[s] = f
    if len(faces) == 3:
        y = {s: faces[s].yaw() for s in STEPS}
        if abs(y["straight"]) > STRAIGHT_MAX:
            reasons.append("straight:not_frontal")
        if y["left"] < TURN_MIN:
            reasons.append("left:no_turn")
        if y["right"] > -TURN_MIN:
            reasons.append("right:no_turn")
        for s in STEPS:
            emb[s] = engine.embed(imgs[s], faces[s])
        for s in ("left", "right"):
            if engine.similarity(emb["straight"], emb[s]) < SAME_DURING_TURN:
                reasons.append(f"{s}:different_person")
        g = {s: _grey_small(imgs[s]) for s in STEPS}
        motion = min(float(np.mean(np.abs(g["straight"] - g[s]))) for s in ("left", "right"))
        if motion < MIN_MOTION:
            reasons.append("no_motion")
    total = 7
    score = round(max(0.0, (total - len(reasons)) / total), 2)
    return {"ok": not reasons, "score": score, "reasons": reasons}


def identity(engine, ocr, ic_img: np.ndarray, selfie_img: np.ndarray, expected_ic: str, expected_name: str) -> dict:
    """MyKad front + live selfie + what the applicant typed. Suggests a verdict; an officer decides."""
    reasons: list[str] = []
    ic_small, selfie_small = scale_down(ic_img), scale_down(selfie_img)

    card_faces = [f for f in engine.detect(ic_small) if f.score >= 0.7]
    card_face = max(card_faces, key=lambda f: f.area) if card_faces else None
    if card_face is None:
        reasons.append("card:no_photo_found")
    selfie_face, n = _one_face(engine, selfie_small)
    if selfie_face is None:
        reasons.append(f"selfie:faces={n}")

    face_score = None
    if card_face is not None and selfie_face is not None:
        face_score = round(engine.similarity(engine.embed(ic_small, card_face), engine.embed(selfie_small, selfie_face)), 3)
        if face_score < SAME_PERSON:
            reasons.append("face:no_match")

    ocr_ok = ocr.name != "none"
    text = mykad.compare(expected_ic, expected_name, ocr.lines(ic_img)) if ocr_ok else None
    if text is not None:
        if not text["icFound"]:
            reasons.append("card:number_unreadable")
        elif not text["icMatch"]:
            reasons.append("card:number_differs")
        if not text["nameMatch"]:
            reasons.append("card:name_differs")
    else:
        reasons.append("ocr:unavailable")

    if card_face is None or (text is not None and not text["icFound"]):
        verdict = "retake_ic"
    elif selfie_face is None or (face_score is not None and face_score < SAME_PERSON):
        verdict = "retake_selfie"
    elif reasons:
        verdict = "review"
    else:
        verdict = "pass"
    return {"verdict": verdict, "faceScore": face_score, "ocr": text, "ocrEngine": ocr.name, "reasons": reasons}
