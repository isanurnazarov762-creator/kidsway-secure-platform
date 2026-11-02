"""Verifier tests. Run from the verifier folder:  python -m unittest -v

The logic and security tests use a fake face engine, so they run anywhere.
The tests in RealModelTests run only when the models were downloaded (python download_models.py).
"""
from __future__ import annotations

import base64
import json
import struct
import time
import unittest
import zlib
from pathlib import Path

import cv2
import numpy as np

from kwverify import checks, mykad
from kwverify.auth import Signer
from kwverify.imageio import ImageError, decode, header_size
from kwverify.ocr import OcrEngine, load_engine
from kwverify.vision import Face, ModelError, check_models

HERE = Path(__file__).resolve().parent
MODELS = HERE.parent / "models"
KEY = b"k" * 32


def b64img(img: np.ndarray, ext: str = ".jpg") -> str:
    ok, buf = cv2.imencode(ext, img)
    assert ok
    return base64.b64encode(buf.tobytes()).decode()


def noisy(seed: int, size=(240, 200)) -> np.ndarray:
    rng = np.random.default_rng(seed)
    return rng.integers(0, 255, (size[0], size[1], 3), dtype=np.uint8)


def face_at(yaw: float, score: float = 0.95, area: float = 100 * 100) -> Face:
    # eyes 40 px apart around x=100; the nose moves with the yaw
    return Face((50, 50, area ** 0.5, area ** 0.5), [(80, 100), (120, 100), (100 + yaw * 40, 120), (85, 140), (115, 140)], score)


class FakeEngine:
    """Returns prepared faces per image and a prepared 'person' per image for similarity."""

    def __init__(self) -> None:
        self.faces: dict[int, list[Face]] = {}
        self.person: dict[int, str] = {}

    def add(self, img, faces, person="A"):
        self.faces[id(img)] = faces
        self.person[id(img)] = person
        return img

    def detect(self, img):
        return self.faces.get(id(img), [])

    def embed(self, img, face):
        return self.person[id(img)]

    def similarity(self, a, b):
        return 0.8 if a == b else 0.1


class FakeOcr(OcrEngine):
    name = "fake"

    def __init__(self, lines):
        self._lines = lines

    def lines(self, img):
        return self._lines


class ImageIntakeTests(unittest.TestCase):
    def test_accepts_real_jpeg_and_png(self):
        self.assertEqual(decode(b64img(noisy(1))).shape, (240, 200, 3))
        self.assertEqual(decode(b64img(noisy(2), ".png")).shape, (240, 200, 3))

    def test_refuses_other_types_and_garbage(self):
        gif = base64.b64encode(b"GIF89a" + b"\0" * 64).decode()
        with self.assertRaises(ImageError):
            decode(gif)
        with self.assertRaises(ImageError):
            decode("not base64 !!!")
        html = base64.b64encode(b"<html><script>alert(1)</script>" + b" " * 40).decode()
        with self.assertRaises(ImageError):
            decode(html)

    def test_refuses_decompression_bomb_before_decoding(self):
        # A valid PNG header that claims 50000 x 50000 pixels: refused from the header alone.
        def chunk(t, d):
            return struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d))
        png = b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", 50000, 50000, 8, 2, 0, 0, 0)) + chunk(b"IEND", b"")
        self.assertEqual(header_size(png), ("png", 50000, 50000))
        with self.assertRaises(ImageError) as e:
            decode(base64.b64encode(png).decode())
        self.assertEqual(str(e.exception), "image_dimensions")

    def test_reads_jpeg_size_from_header(self):
        raw = base64.b64decode(b64img(noisy(3, (123, 77))))
        self.assertEqual(header_size(raw), ("jpeg", 77, 123))


class MyKadTextTests(unittest.TestCase):
    def test_finds_the_number_despite_ocr_noise(self):
        self.assertEqual(mykad.find_ic("KAD PENGENALAN\n961028 - 1O - 5684\nMALAYSIA"), "961028105684")
        self.assertEqual(mykad.find_ic("no number here 12345"), None)

    def test_name_matching_ignores_binti_and_case(self):
        lines = ["NURUL AISYAH BT AHMAD", "NO 12 JALAN SS2/24"]
        self.assertGreaterEqual(mykad.name_score("Nurul Aisyah binti Ahmad", lines), 0.95)
        self.assertLess(mykad.name_score("Siti Nurhaliza binti Tarudin", lines), 0.7)

    def test_long_names_on_two_lines(self):
        lines = ["PUTERI NUR ALIA ZULAIKHA", "BINTI MOHD HAFIZUDDIN"]
        self.assertGreaterEqual(mykad.name_score("Puteri Nur Alia Zulaikha binti Mohd Hafizuddin", lines), 0.9)

    def test_compare(self):
        r = mykad.compare("961028-10-5684", "Nurul Aisyah binti Ahmad", ["961028-10-5684", "NURUL AISYAH BINTI AHMAD"])
        self.assertEqual((r["icMatch"], r["nameMatch"]), (True, True))
        r = mykad.compare("961028-10-5686", "Nurul Aisyah", ["961028-10-5684", "NURUL AISYAH"])
        self.assertFalse(r["icMatch"])


class SigningTests(unittest.TestCase):
    def test_valid_signature_once_only(self):
        s = Signer(KEY)
        ts = str(int(time.time()))
        sig = s.sign(ts, b"{}")
        self.assertTrue(s.check(ts, sig, b"{}"))
        self.assertFalse(s.check(ts, sig, b"{}"), "a replayed request must be refused")

    def test_wrong_key_body_or_time(self):
        s, other = Signer(KEY), Signer(b"x" * 32)
        ts = str(int(time.time()))
        self.assertFalse(s.check(ts, other.sign(ts, b"{}"), b"{}"))
        self.assertFalse(s.check(ts, s.sign(ts, b"{}"), b'{"a":1}'))
        old = str(int(time.time()) - 120)
        self.assertFalse(s.check(old, s.sign(old, b"{}"), b"{}"))
        self.assertFalse(s.check(None, None, b"{}"))

    def test_short_keys_are_refused(self):
        with self.assertRaises(ValueError):
            Signer(b"short")


class LivenessTests(unittest.TestCase):
    def frames(self, eng, yaws=(0.0, 0.4, -0.4), persons=("A", "A", "A"), same_image=False):
        base = noisy(10)
        out = []
        for i, (step, yaw, p) in enumerate(zip(("straight", "left", "right"), yaws, persons)):
            img = base.copy() if same_image else noisy(10 + i)
            out.append((step, eng.add(img, [face_at(yaw)], p)))
        return out

    def test_a_real_person_following_prompts_passes(self):
        eng = FakeEngine()
        r = checks.liveness(eng, self.frames(eng))
        self.assertTrue(r["ok"], r)
        self.assertEqual(r["score"], 1.0)

    def test_a_photo_cannot_turn_its_head(self):
        eng = FakeEngine()
        r = checks.liveness(eng, self.frames(eng, yaws=(0.0, 0.02, -0.01), same_image=True))
        self.assertFalse(r["ok"])
        self.assertIn("left:no_turn", r["reasons"])
        self.assertIn("no_motion", r["reasons"])

    def test_a_different_person_mid_way_fails(self):
        eng = FakeEngine()
        r = checks.liveness(eng, self.frames(eng, persons=("A", "B", "A")))
        self.assertIn("left:different_person", r["reasons"])

    def test_two_faces_or_none_fails(self):
        eng = FakeEngine()
        fr = self.frames(eng)
        eng.faces[id(fr[1][1])] = [face_at(0.4), face_at(0.4)]
        eng.faces[id(fr[2][1])] = []
        r = checks.liveness(eng, fr)
        self.assertIn("left:faces=2", r["reasons"])
        self.assertIn("right:faces=0", r["reasons"])

    def test_steps_must_be_the_three_prompts(self):
        eng = FakeEngine()
        fr = self.frames(eng)
        fr[2] = ("left", fr[2][1])
        self.assertEqual(checks.liveness(eng, fr)["reasons"], ["bad_steps"])


class IdentityTests(unittest.TestCase):
    def setup(self, card_person="A", selfie_person="A", card_face=True):
        eng = FakeEngine()
        card = eng.add(noisy(1), [face_at(0, 0.9, 40 * 40)] if card_face else [], card_person)
        selfie = eng.add(noisy(2), [face_at(0)], selfie_person)
        return eng, card, selfie

    LINES = ["KAD PENGENALAN", "961028-10-5684", "NURUL AISYAH BINTI AHMAD", "JALAN SS2/24 PETALING JAYA"]

    def test_everything_matches(self):
        eng, card, selfie = self.setup()
        r = checks.identity(eng, FakeOcr(self.LINES), card, selfie, "961028-10-5684", "Nurul Aisyah binti Ahmad")
        self.assertEqual(r["verdict"], "pass", r)

    def test_other_face_asks_for_a_new_selfie(self):
        eng, card, selfie = self.setup(selfie_person="B")
        r = checks.identity(eng, FakeOcr(self.LINES), card, selfie, "961028-10-5684", "Nurul Aisyah binti Ahmad")
        self.assertEqual(r["verdict"], "retake_selfie")
        self.assertIn("face:no_match", r["reasons"])

    def test_unreadable_card_asks_for_a_new_photo(self):
        eng, card, selfie = self.setup(card_face=False)
        r = checks.identity(eng, FakeOcr(["blurry"]), card, selfie, "961028-10-5684", "Nurul")
        self.assertEqual(r["verdict"], "retake_ic")

    def test_different_name_or_number_goes_to_an_officer(self):
        eng, card, selfie = self.setup()
        r = checks.identity(eng, FakeOcr(["961028-10-5684", "SITI AISYAH BINTI OMAR"]), card, selfie, "961028-10-5684", "Nurul Aisyah binti Ahmad")
        self.assertEqual(r["verdict"], "review")
        r = checks.identity(eng, FakeOcr(["961028-10-5686", "NURUL AISYAH BINTI AHMAD"]), card, selfie, "961028-10-5684", "Nurul Aisyah binti Ahmad")
        self.assertIn("card:number_differs", r["reasons"])

    def test_without_ocr_an_officer_reads_the_card(self):
        eng, card, selfie = self.setup()
        r = checks.identity(eng, OcrEngine(), card, selfie, "961028-10-5684", "Nurul")
        self.assertEqual(r["verdict"], "review")
        self.assertIn("ocr:unavailable", r["reasons"])


class ServerTests(unittest.TestCase):
    def app(self):
        from server import App
        return App(Signer(KEY), FakeEngine(), OcrEngine())

    def signed(self, body: dict):
        raw = json.dumps(body).encode()
        ts = str(int(time.time()))
        return {"X-KW-Timestamp": ts, "X-KW-Signature": Signer(KEY).sign(ts, raw)}, raw

    def test_unsigned_requests_are_refused(self):
        status, body = self.app().handle("POST", "/v1/verify", {}, b"{}")
        self.assertEqual((status, body["error"]), (401, "unauthorized"))

    def test_signed_request_with_a_bad_image(self):
        headers, raw = self.signed({"icFront": "AAAA", "selfie": "AAAA", "expected": {}})
        status, body = self.app().handle("POST", "/v1/verify", headers, raw)
        self.assertEqual(status, 400)
        self.assertTrue(body["error"].startswith("image_"))

    def test_unknown_paths_and_health(self):
        a = self.app()
        self.assertEqual(a.handle("GET", "/admin", {}, b"")[0], 404)
        self.assertEqual(a.handle("GET", "/healthz", {}, b"")[0], 200)


class ModelIntegrityTests(unittest.TestCase):
    def test_a_tampered_model_is_refused(self):
        import tempfile
        from kwverify.vision import MODELS as M
        with tempfile.TemporaryDirectory() as d:
            for m in M.values():
                Path(d, m["file"]).write_bytes(b"not the real model")
            with self.assertRaises(ModelError):
                check_models(Path(d))


@unittest.skipUnless((MODELS / "face_recognition_sface_2021dec.onnx").exists(), "models not downloaded: run python download_models.py")
class RealModelTests(unittest.TestCase):
    """Real YuNet + SFace on public-domain portraits (Grace Hopper, Eileen Collins)."""

    @classmethod
    def setUpClass(cls):
        from kwverify.vision import FaceEngine
        cls.eng = FaceEngine(MODELS)
        cls.a = cv2.imread(str(HERE / "data" / "person_a.jpg"))
        cls.b = cv2.imread(str(HERE / "data" / "person_b.jpg"))

    def emb(self, img):
        faces = self.eng.detect(img)
        self.assertEqual(len(faces), 1)
        return self.eng.embed(img, faces[0])

    def test_finds_one_face_in_each_portrait(self):
        self.assertEqual(len(self.eng.detect(self.a)), 1)
        self.assertEqual(len(self.eng.detect(self.b)), 1)

    def test_same_person_matches_and_different_people_do_not(self):
        from kwverify.vision import SAME_PERSON
        smaller = cv2.resize(self.a, None, fx=0.6, fy=0.6)
        brighter = cv2.convertScaleAbs(self.a, alpha=1.15, beta=20)
        same = self.eng.similarity(self.emb(smaller), self.emb(brighter))
        other = self.eng.similarity(self.emb(self.a), self.emb(self.b))
        print(f"\n    same person {same:.3f}, different people {other:.3f}, threshold {SAME_PERSON}")
        self.assertGreaterEqual(same, SAME_PERSON)
        self.assertLess(other, SAME_PERSON)

    def test_mykad_photo_against_selfie(self):
        card = np.full((640, 1010, 3), 235, np.uint8)               # a card-sized canvas
        card[180:500, 680:940] = cv2.resize(self.a, (260, 320))       # the photo area on the right
        r = checks.identity(self.eng, OcrEngine(), card, self.a, "961028-10-5684", "Grace")
        self.assertIsNotNone(r["faceScore"])
        self.assertNotIn("face:no_match", r["reasons"], r)
        r = checks.identity(self.eng, OcrEngine(), card, self.b, "961028-10-5684", "Grace")
        self.assertIn("face:no_match", r["reasons"])

    def test_a_still_photo_fails_liveness(self):
        r = checks.liveness(self.eng, [("straight", self.a.copy()), ("left", self.a.copy()), ("right", self.a.copy())])
        self.assertFalse(r["ok"])
        self.assertIn("no_motion", r["reasons"])


class OcrEngineTests(unittest.TestCase):
    def test_engine_loads_or_reports_none(self):
        self.assertIn(load_engine().name, ("rapidocr", "tesseract", "none"))

    def test_reads_a_printed_mykad_number(self):
        eng = load_engine()
        if eng.name == "none":
            self.skipTest("no OCR engine installed")
        card = np.full((360, 900, 3), 250, np.uint8)
        cv2.putText(card, "961028-10-5684", (40, 120), cv2.FONT_HERSHEY_SIMPLEX, 2.0, (20, 20, 20), 4, cv2.LINE_AA)
        cv2.putText(card, "NURUL AISYAH BINTI AHMAD", (40, 230), cv2.FONT_HERSHEY_SIMPLEX, 1.4, (20, 20, 20), 3, cv2.LINE_AA)
        r = mykad.compare("961028-10-5684", "Nurul Aisyah binti Ahmad", eng.lines(card))
        self.assertTrue(r["icMatch"], r)
        self.assertTrue(r["nameMatch"], r)


if __name__ == "__main__":
    unittest.main()
