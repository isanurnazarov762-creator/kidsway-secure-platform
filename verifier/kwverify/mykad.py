"""Reading a MyKad from OCR text and comparing it with the application.

MyKad numbers look like YYMMDD-PB-###G. OCR often adds spaces, drops the dashes or reads
the letter O for a zero, so the text is normalised before matching.
"""
from __future__ import annotations

import re
import unicodedata
from difflib import SequenceMatcher

IC_RE = re.compile(r"(?<!\d)(\d{6})\s*-?\s*(\d{2})\s*-?\s*(\d{4})(?!\d)")
NAME_MATCH = 0.85   # similarity from 0 to 1


def _fix_digits(text: str) -> str:
    # Common OCR confusions, only between digits: O->0, I/l->1, S->5, B->8
    table = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1", "S": "5", "B": "8"})
    return re.sub(r"(?<=\d)[OoIlSB]|[OoIlSB](?=\d)", lambda m: m.group(0).translate(table), text)


def find_ic(text: str) -> str | None:
    m = IC_RE.search(_fix_digits(text))
    return "".join(m.groups()) if m else None


def normalise_name(name: str) -> str:
    s = unicodedata.normalize("NFKD", name).encode("ascii", "ignore").decode().upper()
    s = re.sub(r"\bA\s*/\s*[PL]\b", " ", s)                       # "anak perempuan / anak lelaki"
    s = re.sub(r"[^A-Z@' ]+", " ", s)
    s = re.sub(r"\b(BINTI|BINTE|BT|BIN|BN)\b", " ", s)              # patronymic words vary in spelling
    return re.sub(r"\s+", " ", s).strip()


def name_score(expected: str, lines: list[str]) -> float:
    """Best similarity between the expected name and any line, or two lines joined
    (long names wrap onto a second line on the card)."""
    want = normalise_name(expected)
    if not want:
        return 0.0
    candidates = [l for l in (normalise_name(x) for x in lines) if l]
    joined = [candidates[i] + " " + candidates[i + 1] for i in range(len(candidates) - 1)]
    best = 0.0
    for c in candidates + joined:
        best = max(best, SequenceMatcher(None, want, c).ratio())
    return round(best, 3)


def compare(expected_ic: str, expected_name: str, lines: list[str]) -> dict:
    text = "\n".join(lines)
    found = find_ic(text)
    ic_clean = re.sub(r"\D", "", expected_ic or "")
    score = name_score(expected_name, lines)
    return {
        "icFound": found is not None,
        "icMatch": found is not None and found == ic_clean,
        "nameScore": score,
        "nameMatch": score >= NAME_MATCH,
    }
