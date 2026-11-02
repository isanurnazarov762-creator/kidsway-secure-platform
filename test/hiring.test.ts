// Hiring and security vetting of KidsWay Guardians. Each test is one control from docs/threat-model.md.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { startTestServer, PNG_1PX } from "./helpers.ts";
import type { Api } from "./helpers.ts";
import { parseMyKad } from "../src/hiring.ts";

let api: Api;
let seq = 300000000;
const phone = () => `+60${++seq}`;
before(async () => { api = await startTestServer({ vettingApprovals: 2 }); });
after(async () => { await api.close(); });

/** A MyKad number for someone `age` years old (birthday already passed this year). */
let serial = 100;
function ic(age: number, female = true): string {
  const d = new Date(Date.now() + 8 * 3600e3);
  d.setUTCFullYear(d.getUTCFullYear() - age);
  d.setUTCDate(d.getUTCDate() - 3);
  const p = (n: number) => String(n).padStart(2, "0");
  const last = female ? 2 * (serial % 5) : 2 * (serial % 5) + 1;
  return `${p(d.getUTCFullYear() % 100)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-14-${String(++serial).padStart(3, "0").slice(-3)}${last}`;
}
const uniquePng = () => Buffer.concat([Buffer.from(PNG_1PX, "base64"), randomBytes(16)]).toString("base64");
const PDF = (body = "") => Buffer.from(`%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n${body}\ntrailer << /Root 1 0 R >>\n%%EOF`).toString("base64");

async function applicantSession(p = phone()) {
  const a = await api.call("POST", "/api/careers/otp/request", { phone: p });
  const v = await api.call("POST", "/api/careers/otp/verify", { phone: p, challengeId: a.body.challengeId, code: a.body.devCode });
  assert.equal(v.status, 200);
  assert.match(v.body.token, /^ap_/);
  return { token: v.body.token as string, phone: p };
}
function form(p: string, icNo: string, extra: Record<string, unknown> = {}) {
  return {
    name: "Nurul Aisyah", ic: icNo, phone: p, email: "nurul@example.com", area: "Petaling Jaya", experience: "Kindergarten assistant, 3 years",
    languages: ["ms", "en"], days: ["mon", "tue", "wed"], transport: "car", consent: true,
    references: [{ name: "Puan Rohana", phone: "+60123000001", relation: "Former employer" }, { name: "Encik Lim", phone: "+60123000002", relation: "Neighbour" }],
    ...extra
  };
}
async function apply(age = 30) {
  const s = await applicantSession();
  const r = await api.call("POST", "/api/careers/application", form(s.phone, ic(age)), s.token);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  const row = api.app.db.prepare("SELECT id FROM applicants ORDER BY rowid DESC LIMIT 1").get() as { id: string };
  return { ...s, id: row.id };
}
async function uploadAll(token: string) {
  for (const kind of ["ic_front", "ic_back", "selfie"]) {
    const r = await api.call("POST", "/api/careers/application/docs", { kind, mime: "image/png", data: uniquePng() }, token);
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  await api.call("POST", "/api/careers/application/docs", { kind: "first_aid_cert", mime: "application/pdf", data: PDF(randomBytes(4).toString("hex")) }, token);
}
async function officer(name = "Officer") {
  const p = phone();
  api.app.createStaff(p, name, "admin", "vetting");
  return api.login(p);
}
async function passAll(officerToken: string, id: string) {
  await api.call("POST", `/api/admin/applicants/${id}/docs`, { kind: "edkk_result", mime: "application/pdf", data: PDF("edkk " + id) }, officerToken);
  await api.call("POST", `/api/admin/applicants/${id}/docs`, { kind: "police_cert", mime: "application/pdf", data: PDF("police " + id) }, officerToken);
  for (const check of ["identity", "edkk", "police", "references", "interview", "first_aid", "training"]) {
    const r = await api.call("POST", `/api/admin/applicants/${id}/checks`, { check, result: "pass", note: "ok" }, officerToken);
    assert.equal(r.status, 200, check + " " + JSON.stringify(r.body));
  }
}

describe("Applying (KidsWay Guardian)", () => {
  test("G1 eligibility comes from the MyKad number: women aged 20-55 only, real dates only", async () => {
    assert.equal(parseMyKad("960514-10-5678").ok, true);
    assert.equal(parseMyKad("961332-10-5678").ok, false);          // month 13
    assert.equal(parseMyKad("960230-10-5678").ok, false);          // 30 February
    const s = await applicantSession();
    const send = (icNo: string) => api.call("POST", "/api/careers/application", form(s.phone, icNo), s.token);
    assert.equal((await send(ic(30, false))).body.error, "not_eligible"); // odd last digit: male
    assert.equal((await send(ic(19))).body.error, "not_eligible");
    assert.equal((await send(ic(56))).body.error, "not_eligible");
    assert.equal((await send("991332-10-5678")).body.error, "invalid_ic");
    assert.equal((await send(ic(20))).status, 201);
  });

  test("G2 applicant sessions are separate and limited; the form needs SMS proof and consent", async () => {
    const s = await applicantSession();
    const parent = await api.login();
    assert.equal((await api.call("GET", "/api/me", undefined, s.token)).status, 401);        // not a user session
    assert.equal((await api.call("GET", "/api/trips", undefined, s.token)).status, 401);
    assert.equal((await api.call("GET", "/api/careers/application", undefined, parent.token)).status, 401);
    assert.equal((await api.call("POST", "/api/careers/application", form(s.phone, ic(30)))).status, 401);
    assert.equal((await api.call("POST", "/api/careers/application", form(s.phone, ic(30), { consent: false }), s.token)).body.error, "consent_required");
    // The phone in the form must be the one proven by SMS.
    assert.equal((await api.call("POST", "/api/careers/application", form("+60199990000", ic(30)), s.token)).body.error, "invalid_phone");
  });

  test("G3 bots and duplicates: honeypot saves nothing; a reused MyKad is flagged without telling the sender", async () => {
    const before = (api.app.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n;
    const bot = await applicantSession();
    const r = await api.call("POST", "/api/careers/application", form(bot.phone, ic(30), { website: "http://spam" }), bot.token);
    assert.equal(r.status, 201);
    assert.equal((api.app.db.prepare("SELECT COUNT(*) AS n FROM applicants").get() as { n: number }).n, before);

    const shared = ic(33);
    const a = await applicantSession(), b = await applicantSession();
    assert.equal((await api.call("POST", "/api/careers/application", form(a.phone, shared), a.token)).status, 201);
    const second = await api.call("POST", "/api/careers/application", form(b.phone, shared), b.token);
    assert.equal(second.status, 201); // same answer as a fresh MyKad: numbers cannot be probed
    const off = await officer();
    const list = await api.call("GET", "/api/admin/applicants", undefined, off.token);
    assert.ok(list.body.applicants.some((x: any) => x.flags.includes("duplicate_ic")));
    assert.equal((await api.call("POST", "/api/careers/application", form(a.phone, ic(34)), a.token)).body.error, "already_applied");
  });

  test("G4 MyKad numbers and documents are encrypted at rest; fake files and PDFs with scripts are refused", async () => {
    const a = await apply();
    await uploadAll(a.token);
    const row = api.app.db.prepare("SELECT ic_enc, ic_hash, data_enc FROM applicants WHERE id = ?").get(a.id) as Record<string, string>;
    assert.match(row.ic_enc, /^v1\./);
    assert.ok(!row.data_enc.includes("Nurul") && !row.ic_hash.match(/^\d{12}$/));
    const doc = api.app.db.prepare("SELECT data_enc FROM applicant_docs WHERE applicant_id = ? LIMIT 1").get(a.id) as { data_enc: string };
    assert.ok(!doc.data_enc.includes("iVBOR")); // no readable PNG inside
    const fake = Buffer.from("<script>alert(1)</script>").toString("base64");
    assert.equal((await api.call("POST", "/api/careers/application/docs", { kind: "selfie", mime: "image/png", data: fake }, a.token)).body.error, "invalid_document");
    const evil = PDF("2 0 obj << /S /JavaScript /JS (app.alert(1)) >> endobj");
    assert.equal((await api.call("POST", "/api/careers/application/docs", { kind: "police_cert", mime: "application/pdf", data: evil }, a.token)).body.error, "pdf_active_content");
    // The same file used by two different applicants is flagged.
    const b = await apply();
    const same = uniquePng();
    await api.call("POST", "/api/careers/application/docs", { kind: "selfie", mime: "image/png", data: same }, a.token);
    await api.call("POST", "/api/careers/application/docs", { kind: "selfie", mime: "image/png", data: same }, b.token);
    const flags = (api.app.db.prepare("SELECT flags FROM applicants WHERE id = ?").get(b.id) as { flags: string }).flags;
    assert.match(flags, /doc_reused/);
  });
});

describe("Vetting (officers)", () => {
  test("G5 only admins with the vetting permission can open applications (separation of duties)", async () => {
    const a = await apply();
    const parent = await api.login();
    const dispatchPhone = phone();
    api.app.createStaff(dispatchPhone, "Dispatcher", "admin");
    const dispatcher = await api.login(dispatchPhone);
    const off = await officer();
    assert.equal((await api.call("GET", `/api/admin/applicants/${a.id}`, undefined, parent.token)).status, 403);
    assert.equal((await api.call("GET", `/api/admin/applicants/${a.id}`, undefined, dispatcher.token)).status, 403);
    const ok = await api.call("GET", `/api/admin/applicants/${a.id}`, undefined, off.token);
    assert.equal(ok.status, 200);
    assert.equal(ok.body.age, 30);
    const audit = api.app.db.prepare("SELECT action, outcome FROM audit_log WHERE action IN ('vetting_access','applicant_read') ORDER BY id DESC LIMIT 2").all() as Array<{ action: string; outcome: string }>;
    assert.deepEqual(audit.map((x) => x.action + ":" + x.outcome).sort(), ["applicant_read:ok", "vetting_access:denied"]);
  });

  test("G6 a check can only pass with its evidence on file (no e-DKK pass without the JKM result)", async () => {
    const a = await apply();
    const off = await officer();
    const r = await api.call("POST", `/api/admin/applicants/${a.id}/checks`, { check: "edkk", result: "pass" }, off.token);
    assert.equal(r.body.error, "evidence_missing:edkk_result");
    assert.equal((await api.call("POST", `/api/admin/applicants/${a.id}/checks`, { check: "identity", result: "pass" }, off.token)).body.error, "evidence_missing:ic_front,ic_back,selfie");
    await api.call("POST", `/api/admin/applicants/${a.id}/docs`, { kind: "edkk_result", mime: "application/pdf", data: PDF("x") }, off.token);
    assert.equal((await api.call("POST", `/api/admin/applicants/${a.id}/checks`, { check: "edkk", result: "pass" }, off.token)).status, 200);
  });

  test("G7 four-eyes: two different officers must approve after every check passed; then she can log in as an escort", async () => {
    const a = await apply();
    await uploadAll(a.token);
    const offA = await officer("Officer A"), offB = await officer("Officer B");
    assert.equal((await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offA.token)).body.error, "checks_incomplete");
    await passAll(offA.token, a.id);
    const first = await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offA.token);
    assert.deepEqual([first.body.approvals, first.body.approved], [1, false]);
    assert.equal((await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offA.token)).body.error, "already_approved_by_you");
    // New evidence before the decision clears earlier approvals.
    await api.call("POST", `/api/admin/applicants/${a.id}/checks`, { check: "interview", result: "pass", note: "second interview" }, offB.token);
    assert.equal((await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offB.token)).body.approved, false);
    const final = await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offA.token);
    assert.equal(final.body.approved, true);
    const guardian = await api.login(a.phone);
    assert.equal((await api.call("GET", "/api/me", undefined, guardian.token)).body.role, "escort");
    assert.equal((await api.call("GET", "/api/careers/application", undefined, a.token)).body.status, "approved");
  });

  test("G8 signed document links: officer only, 5 minutes, tamper-proof, served in a sandbox", async () => {
    const a = await apply();
    await uploadAll(a.token);
    const off = await officer();
    const detail = await api.call("GET", `/api/admin/applicants/${a.id}`, undefined, off.token);
    const docId = detail.body.docs[0].id;
    const link = await api.call("GET", `/api/admin/applicants/${a.id}/docs/${docId}/link`, undefined, off.token);
    const res = await fetch(api.base + link.body.url);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-security-policy") || "", /sandbox/);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
    const url: string = link.body.url;
    assert.equal((await fetch(api.base + url.slice(0, -1) + (url.endsWith("A") ? "B" : "A"))).status, 403);
    assert.equal((await fetch(api.base + `/media/docs/${docId}`)).status, 403);
    const other = await apply();
    assert.equal((await api.call("GET", `/api/admin/applicants/${other.id}/docs/${docId}/link`, undefined, off.token)).status, 404);
  });

  test("G9 a failed yearly re-check suspends the Guardian at once and frees her trips", async () => {
    const a = await apply();
    await uploadAll(a.token);
    const offA = await officer(), offB = await officer();
    await passAll(offA.token, a.id);
    await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offA.token);
    const fin = await api.call("POST", `/api/admin/applicants/${a.id}/approve`, {}, offB.token);
    const guardian = await api.login(a.phone);
    // Give her a trip.
    const parent = await api.login();
    const child = await api.call("POST", "/api/children", { name: "Mia" }, parent.token);
    const trip = await api.call("POST", "/api/trips", { childIds: [child.body.id], service: "car", scheduledAt: Math.floor(Date.now() / 1000) + 3600, stops: [{ address: "A" }, { address: "B", receiver: { type: "parent" } }] }, parent.token);
    await api.call("POST", `/api/admin/trips/${trip.body.trip.id}/assign`, { escortId: fin.body.escortId }, offA.token);
    const r = await api.call("POST", `/api/admin/applicants/${a.id}/checks`, { check: "edkk", result: "fail", note: "record found on re-check" }, offA.token);
    assert.equal(r.body.suspended, true);
    assert.equal((await api.call("GET", "/api/trips", undefined, guardian.token)).status, 401); // her session was revoked
    const again = await api.login(a.phone);
    assert.equal((await api.call("GET", "/api/me", undefined, again.token)).body.error, "account_suspended");
    assert.equal((await api.call("GET", `/api/trips/${trip.body.trip.id}`, undefined, parent.token)).body.status, "requested");
  });
});

describe("Privacy (PDPA)", () => {
  test("G10 withdrawing erases the application and its documents at once", async () => {
    const a = await apply();
    await uploadAll(a.token);
    assert.equal((await api.call("POST", "/api/careers/application/withdraw", {}, a.token)).body.erased, true);
    assert.equal(api.app.db.prepare("SELECT 1 FROM applicants WHERE id = ?").get(a.id), undefined);
    assert.equal(api.app.db.prepare("SELECT 1 FROM applicant_docs WHERE applicant_id = ?").get(a.id), undefined);
    assert.equal((await api.call("GET", "/api/careers/application", undefined, a.token)).status, 401);
  });

  test("G11 rejected applications are kept 180 days for disputes, then erased automatically", async () => {
    const a = await apply();
    const off = await officer();
    await api.call("POST", `/api/admin/applicants/${a.id}/reject`, { reason: "References could not be confirmed" }, off.token);
    assert.equal((await api.call("GET", "/api/careers/application", undefined, a.token)).body.status, "rejected");
    const nowSec = Math.floor(Date.now() / 1000);
    api.app.purgeApplicants(nowSec);
    assert.ok(api.app.db.prepare("SELECT 1 FROM applicants WHERE id = ?").get(a.id));
    api.app.purgeApplicants(nowSec + 181 * 86400);
    assert.equal(api.app.db.prepare("SELECT 1 FROM applicants WHERE id = ?").get(a.id), undefined);
  });
});
