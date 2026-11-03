// The AI identity check, with a stand-in for the Python verifier that checks request signatures
// exactly like the real one. Each test is one control from docs/threat-model.md (section Hiring / AI).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { createHmac, randomBytes } from "node:crypto";
import { startTestServer, PNG_1PX } from "./helpers.ts";
import type { Api } from "./helpers.ts";

const KEY = randomBytes(32);
// What the stand-in verifier answers next, and what it received.
const mock = {
  live: { ok: true, score: 1, reasons: [] as string[] },
  identity: { verdict: "pass", faceScore: 0.91, ocr: { icFound: true, icMatch: true, nameScore: 0.97, nameMatch: true }, ocrEngine: "fake", reasons: [] as string[] } as Record<string, unknown>,
  down: false,
  calls: [] as Array<{ path: string; signed: boolean; body: any }>
};
const verifier = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    const body = Buffer.concat(chunks).toString();
    const ts = String(req.headers["x-kw-timestamp"] || "");
    const sig = String(req.headers["x-kw-signature"] || "");
    const signed = sig === createHmac("sha256", KEY).update(ts + "." + body).digest("hex") && Math.abs(Date.now() / 1000 - Number(ts)) < 60;
    mock.calls.push({ path: req.url!, signed, body: JSON.parse(body || "{}") });
    if (mock.down) { res.statusCode = 503; return res.end("{}"); }
    if (!signed) { res.statusCode = 401; return res.end('{"error":"unauthorized"}'); }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(req.url === "/v1/liveness" ? mock.live : mock.identity));
  });
});

let api: Api;
let seq = 400000000;
const phone = () => `+60${++seq}`;
before(async () => {
  await new Promise<void>((r) => verifier.listen(0, "127.0.0.1", () => r()));
  api = await startTestServer({ verifierUrl: `http://127.0.0.1:${(verifier.address() as AddressInfo).port}`, verifierKey: KEY });
});
after(async () => { await api.close(); verifier.close(); });

const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), randomBytes(64)]).toString("base64");
const png = () => Buffer.concat([Buffer.from(PNG_1PX, "base64"), randomBytes(16)]).toString("base64");
let serial = 200;
function ic(age = 30) {
  const d = new Date(Date.now() + 8 * 3600e3);
  d.setUTCFullYear(d.getUTCFullYear() - age); d.setUTCDate(d.getUTCDate() - 3);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-10-${String(++serial).slice(-3)}2`;
}

async function applicant(biometricConsent = true) {
  const p = phone();
  const a = await api.call("POST", "/api/careers/otp/request", { phone: p });
  const v = await api.call("POST", "/api/careers/otp/verify", { phone: p, challengeId: a.body.challengeId, code: a.body.devCode });
  const t = v.body.token as string;
  const r = await api.call("POST", "/api/careers/application", {
    name: "Nurul Aisyah binti Ahmad", ic: ic(), phone: p, area: "PJ", languages: ["ms"], days: ["mon"], transport: "none", consent: true, biometricConsent,
    references: [{ name: "Puan Rohana", phone: "+60123000001", relation: "Employer" }, { name: "Encik Lim", phone: "+60123000002", relation: "Neighbour" }]
  }, t);
  assert.equal(r.status, 201);
  await api.call("POST", "/api/careers/application/docs", { kind: "ic_front", mime: "image/png", data: png() }, t);
  const id = (api.app.db.prepare("SELECT id FROM applicants ORDER BY rowid DESC LIMIT 1").get() as { id: string }).id;
  return { t, id };
}
async function liveSelfie(t: string) {
  const ch = await api.call("GET", "/api/careers/liveness", undefined, t);
  assert.equal(ch.status, 200);
  const frames = ch.body.steps.map((step: string) => ({ step, mime: "image/jpeg", data: jpeg() }));
  return { ch, res: await api.call("POST", "/api/careers/application/selfie", { challengeId: ch.body.challengeId, frames }, t) };
}

describe("AI identity check", () => {
  test("V1 the liveness prompts come in a random order, are single-use and must be followed in order", async () => {
    const { t } = await applicant();
    const ch = await api.call("GET", "/api/careers/liveness", undefined, t);
    assert.equal(ch.body.steps[0], "straight");
    assert.deepEqual([...ch.body.steps].sort(), ["left", "right", "straight"]);
    const wrong = [...ch.body.steps].reverse().map((step: string) => ({ step, mime: "image/jpeg", data: jpeg() }));
    assert.equal((await api.call("POST", "/api/careers/application/selfie", { challengeId: ch.body.challengeId, frames: wrong }, t)).body.error, "frames_out_of_order");
    const right = ch.body.steps.map((step: string) => ({ step, mime: "image/jpeg", data: jpeg() }));
    assert.equal((await api.call("POST", "/api/careers/application/selfie", { challengeId: ch.body.challengeId, frames: right }, t)).body.error, "challenge_invalid"); // already used
    // Someone else's challenge does not work either.
    const other = await applicant();
    const och = await api.call("GET", "/api/careers/liveness", undefined, other.t);
    const of = och.body.steps.map((step: string) => ({ step, mime: "image/jpeg", data: jpeg() }));
    assert.equal((await api.call("POST", "/api/careers/application/selfie", { challengeId: och.body.challengeId, frames: of }, t)).body.error, "challenge_invalid");
  });

  test("V2 requests to the verifier are signed; only the straight-ahead frame is stored", async () => {
    const { t, id } = await applicant();
    mock.calls = [];
    const { res } = await liveSelfie(t);
    assert.equal(res.body.ok, true);
    assert.equal(mock.calls[0].path, "/v1/liveness");
    assert.equal(mock.calls[0].signed, true);
    assert.equal(mock.calls[0].body.frames.length, 3);
    const selfies = api.app.db.prepare("SELECT COUNT(*) AS n FROM applicant_docs WHERE applicant_id = ? AND kind = 'selfie'").get(id) as { n: number };
    assert.equal(selfies.n, 1);
    const fake = { step: "straight", mime: "image/jpeg", data: Buffer.from("<script>").toString("base64") };
    const ch = await api.call("GET", "/api/careers/liveness", undefined, t);
    const bad = await api.call("POST", "/api/careers/application/selfie", { challengeId: ch.body.challengeId, frames: [fake, fake, fake] }, t);
    assert.ok(bad.status === 400);
  });

  test("V3 a match passes; the applicant sees the outcome, never the scores", async () => {
    const { t, id } = await applicant();
    await liveSelfie(t);
    const r = await api.call("POST", "/api/careers/application/ai-check", {}, t);
    assert.deepEqual(r.body, { verdict: "pass", attemptsLeft: 2 });
    const mine = await api.call("GET", "/api/careers/application", undefined, t);
    assert.equal(mine.body.ai.verdict, "pass");
    assert.ok(!JSON.stringify(mine.body).includes("0.91"));
    const raw = api.app.db.prepare("SELECT result_enc FROM applicant_ai WHERE applicant_id = ?").get(id) as { result_enc: string };
    assert.match(raw.result_enc, /^v1\./); // the report is encrypted at rest
  });

  test("V4 AI never rejects: after 3 failed attempts the file goes to an officer", async () => {
    const { t, id } = await applicant();
    mock.identity = { ...mock.identity, verdict: "retake_selfie", faceScore: 0.12, reasons: ["face:no_match"] };
    const verdicts: string[] = [];
    for (let i = 0; i < 3; i++) {
      await liveSelfie(t);
      verdicts.push((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.verdict);
    }
    assert.deepEqual(verdicts, ["retake_selfie", "retake_selfie", "review"]);
    await liveSelfie(t);
    assert.equal((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.error, "ai_attempts_used");
    const status = (api.app.db.prepare("SELECT status, flags FROM applicants WHERE id = ?").get(id) as { status: string; flags: string });
    assert.equal(status.status, "submitted"); // not rejected
    assert.match(status.flags, /ai_review/);
    mock.identity = { ...mock.identity, verdict: "pass", faceScore: 0.91, reasons: [] };
  });

  test("V5 a failed liveness check means a new selfie, whatever the face score", async () => {
    const { t } = await applicant();
    mock.live = { ok: false, score: 0.29, reasons: ["no_motion"] };
    await liveSelfie(t);
    assert.equal((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.verdict, "retake_selfie");
    assert.equal((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.error, "live_selfie_required");
    mock.live = { ok: true, score: 1, reasons: [] };
  });

  test("V6 verifier down: no crash, the officer checks by hand", async () => {
    const { t } = await applicant();
    await liveSelfie(t);
    mock.down = true;
    assert.equal((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.verdict, "review");
    mock.down = false;
  });

  test("V7 no biometric consent: no face processing at all", async () => {
    const { t } = await applicant(false);
    mock.calls = [];
    assert.equal((await api.call("GET", "/api/careers/liveness", undefined, t)).body.error, "biometric_consent_required");
    assert.equal((await api.call("POST", "/api/careers/application/ai-check", {}, t)).body.error, "biometric_consent_required");
    assert.equal(mock.calls.length, 0);
  });

  test("V8 officers see the AI report, and overruling it needs a written reason", async () => {
    const { t, id } = await applicant();
    mock.identity = { ...mock.identity, verdict: "review", reasons: ["card:name_differs"] };
    await liveSelfie(t);
    await api.call("POST", "/api/careers/application/ai-check", {}, t);
    mock.identity = { ...mock.identity, verdict: "pass", reasons: [] };
    await api.call("POST", "/api/careers/application/docs", { kind: "ic_back", mime: "image/png", data: png() }, t);
    const p = phone();
    api.app.createStaff(p, "Officer", "admin", "vetting");
    const off = await api.login(p, "Officer", "control");
    const detail = await api.call("GET", `/api/admin/applicants/${id}`, undefined, off.token);
    assert.equal(detail.body.ai.verdict, "review");
    assert.deepEqual(detail.body.ai.identity.reasons, ["card:name_differs"]);
    assert.equal(detail.body.ai.identity.faceScore, 0.91);
    assert.equal((await api.call("POST", `/api/admin/applicants/${id}/checks`, { check: "identity", result: "pass" }, off.token)).body.error, "note_required_ai_disagrees");
    assert.equal((await api.call("POST", `/api/admin/applicants/${id}/checks`, { check: "identity", result: "pass", note: "Name changed after marriage, checked the marriage certificate" }, off.token)).status, 200);
  });
});
