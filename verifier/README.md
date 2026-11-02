# KidsWay verifier (AI identity check)

An internal Python service that helps vetting officers check a Guardian applicant's identity:

| Check | How | Model |
|---|---|---|
| Live person | The applicant follows 3 prompts in a random order chosen by the API (straight, left, right). A printed photo or a screen cannot turn its head; a swap of person mid-way and still frames are detected. | YuNet face detector, SFace |
| Face match | Selfie compared with the photo on the MyKad. Cosine similarity, same person from 0.363. | SFace (OpenCV model zoo) |
| MyKad text | MyKad number and name read and compared with the application (OCR noise tolerated, BINTI/BIN ignored). | RapidOCR (PaddleOCR in ONNX), or Tesseract |

The result is a **suggestion**: `pass`, `retake_ic`, `retake_selfie` or `review`. The AI never rejects anyone; after 3 attempts anything unclear goes to an officer, and an officer always makes the identity decision.

## Security

- Runs on an internal Docker network shared only with the API: no published ports, no internet.
- Every request is signed with HMAC-SHA256 over a timestamp and the body; old (> 60 s) or replayed requests are refused.
- Images are checked by file signature and their size is read from the header before decoding (decompression bombs), processed in memory and never written to disk.
- Face embeddings exist only during one request. The API stores scores and booleans, encrypted.
- Model files are pinned by SHA-256 and checked at download and at every start.
- Logs contain event codes only, never names, MyKad numbers or images.
- Container: non-root, read-only file system, all capabilities dropped, only `VERIFIER_KEY` in its environment.

## Run on Windows (development)

Needs Python 3.12 (`py --list` should show 3.12).

```powershell
cd verifier
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python download_models.py          # 2 files, about 37 MB, SHA-256 checked
python -m unittest -v              # 31 tests; the 4 real-model tests now run too
python server.py                   # http://127.0.0.1:8090
```

`server.py` reads `VERIFIER_KEY` from `../.env.local`, which `npm run dev` creates. Then start the API in a second terminal (`npm run dev`) and apply on http://localhost:3000/careers with the optional face-check consent ticked.

If the verifier is not running, nothing breaks: applications go to an officer for a manual identity check.

## Run with Docker

`docker compose -f deploy/docker-compose.yml up -d --build` builds it with the rest (see `docs/lab-guide.md`).

## Limits (honest)

- Active liveness stops photos, screens and simple video replays; it is weaker than commercial passive liveness against masks and deepfakes.
- SFace and the OCR models were trained on public datasets; error rates can differ between groups of people. That is one reason the AI only suggests and a person decides.
- A production system would also check the MyKad chip or use a certified eKYC provider.
