// Security tests. Each test is one control from docs/threat-model.md.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer, PNG_1PX } from "./helpers.ts";
import type { Api } from "./helpers.ts";

let api: Api;
before(async () => { api = await startTestServer(); });
after(async () => { await api.close(); });

describe("Authentication (SMS one-time code + session)", () => {
  test("T1 same response for new and existing numbers (no account enumeration)", async () => {
    const existing = await api.login();
    const a = await api.call("POST", "/api/auth/otp/request", { phone: existing.phone });
    const b = await api.call("POST", "/api/auth/otp/request", { phone: "+60199999999" });
    assert.equal(a.status, 202);
    assert.equal(b.status, 202);
    assert.deepEqual(Object.keys(a.body).sort(), Object.keys(b.body).sort());
  });

  test("T2 the SMS code locks after 5 wrong guesses, even if the 6th guess is right", async () => {
    const phone = "+60111111111";
    const a = await api.call("POST", "/api/auth/otp/request", { phone });
    let last: any;
    for (let i = 0; i < 5; i++) last = await api.call("POST", "/api/auth/otp/verify", { phone, challengeId: a.body.challengeId, code: "000000" === a.body.devCode ? "111111" : "000000" });
    assert.equal(last.body.error, "too_many_attempts");
    const right = await api.call("POST", "/api/auth/otp/verify", { phone, challengeId: a.body.challengeId, code: a.body.devCode });
    assert.equal(right.status, 400);
  });

  test("T3 a code issued for one phone cannot log in another phone", async () => {
    const a = await api.call("POST", "/api/auth/otp/request", { phone: "+60122222222" });
    const b = await api.call("POST", "/api/auth/otp/verify", { phone: "+60133333333", challengeId: a.body.challengeId, code: a.body.devCode });
    assert.equal(b.status, 400);
  });

  test("T4 SMS requests per phone are rate limited (anti SMS-bombing)", async () => {
    const phone = "+60144444444";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await api.call("POST", "/api/auth/otp/request", { phone })).status);
    assert.deepEqual(codes, [202, 202, 202, 429, 429]);
  });

  test("T5 forged, malformed and revoked tokens are rejected", async () => {
    const u = await api.login();
    assert.equal((await api.call("GET", "/api/me", undefined, u.token)).status, 200);
    assert.equal((await api.call("GET", "/api/me", undefined, u.token.slice(0, -2) + "xx")).status, 401);
    assert.equal((await api.call("GET", "/api/me", undefined, undefined, { authorization: "Bearer ' OR 1=1 --" })).status, 401);
    await api.call("POST", "/api/auth/logout", {}, u.token);
    assert.equal((await api.call("GET", "/api/me", undefined, u.token)).status, 401);
  });

  test("T6 phone number is masked in API responses", async () => {
    const u = await api.login("+60123456789");
    const me = await api.call("GET", "/api/me", undefined, u.token);
    assert.equal(me.body.phone, "+6012•••789");
  });
});

describe("Authorisation (roles and object ownership)", () => {
  test("T7 parent B cannot read parent A's child (IDOR / BOLA) and gets 404, not 403", async () => {
    const a = await api.login();
    const b = await api.login();
    const child = await api.call("POST", "/api/children", { name: "Secret Child", medical: "Asthma" }, a.token);
    const peek = await api.call("GET", `/api/children/${child.body.id}`, undefined, b.token);
    assert.equal(peek.status, 404);
    assert.equal(JSON.stringify(peek.body).includes("Asthma"), false);
  });

  test("T8 parent cannot book a trip for someone else's child", async () => {
    const a = await api.login();
    const b = await api.login();
    const child = await api.call("POST", "/api/children", { name: "Kid" }, a.token);
    const t = await api.call("POST", "/api/trips", { childIds: [child.body.id], service: "car", scheduledAt: Math.floor(Date.now() / 1000), stops: [{ address: "A" }, { address: "B", receiver: { type: "parent" } }] }, b.token);
    assert.equal(t.status, 400);
  });

  test("T9 an escort who is not assigned cannot see the trip, the child or post location", async () => {
    const s = await api.tripInProgress();
    const otherPhone = "+60155555555";
    await api.call("POST", "/api/admin/escorts", { phone: otherPhone, name: "Other escort" }, s.admin.token);
    const other = await api.login(otherPhone, "Other escort", "guardian");
    assert.equal((await api.call("GET", `/api/trips/${s.tripId}`, undefined, other.token)).status, 404);
    assert.equal((await api.call("GET", `/api/children/${s.childId}`, undefined, other.token)).status, 404);
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/location`, { lat: 3.1, lng: 101.7 }, other.token)).status, 404);
  });

  test("T10 parents cannot call admin endpoints, and self sign-up can never become admin", async () => {
    const p = await api.login();
    assert.equal((await api.call("GET", "/api/admin/audit", undefined, p.token)).status, 403);
    assert.equal((await api.call("POST", "/api/admin/escorts", { phone: "+60166666666", name: "x" }, p.token)).status, 403);
    const me = await api.call("GET", "/api/me", undefined, p.token);
    assert.equal(me.body.role, "parent");
  });

  test("T11 the assigned escort sees the child's medical note but not the date of birth", async () => {
    const s = await api.tripInProgress();
    const c = await api.call("GET", `/api/children/${s.childId}`, undefined, s.escort.token);
    assert.equal(c.status, 200);
    assert.equal(c.body.medical, "Peanut allergy");
    assert.equal(c.body.dob, undefined);
  });
});

describe("Handover codes", () => {
  test("T12 wrong codes lock the stop after 5 tries; the right code no longer works", async () => {
    const s = await api.tripInProgress();
    const wrong = s.code === "123456" ? "654321" : "123456";
    const statuses: number[] = [];
    for (let i = 0; i < 5; i++) statuses.push((await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: wrong }, s.escort.token)).status);
    assert.deepEqual(statuses, [400, 400, 400, 400, 423]);
    const right = await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token);
    assert.equal(right.status, 423);
  });

  test("T13 the right code works once and cannot be reused", async () => {
    const s = await api.tripInProgress();
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token)).status, 200);
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token)).status, 409);
  });

  test("T25 after a lock, only the parent can issue a new code, and the new code works", async () => {
    const s = await api.tripInProgress();
    for (let i = 0; i < 5; i++) await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: "000001" }, s.escort.token);
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/stops/1/reissue-code`, {}, s.escort.token)).status, 403);
    const fresh = await api.call("POST", `/api/trips/${s.tripId}/stops/1/reissue-code`, {}, s.parent.token);
    assert.equal(fresh.status, 200);
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: fresh.body.code }, s.escort.token)).status, 200);
  });

  test("T14 handover codes are not stored in readable form", async () => {
    const s = await api.tripInProgress();
    const rows = api.app.db.prepare("SELECT * FROM stops WHERE trip_id = ?").all(s.tripId);
    assert.equal(JSON.stringify(rows).includes(s.code), false);
  });
});

describe("Data protection", () => {
  test("T15 medical notes, names and addresses are encrypted in the database", async () => {
    const s = await api.tripInProgress();
    const dump = JSON.stringify(api.app.db.prepare("SELECT * FROM children").all()) + JSON.stringify(api.app.db.prepare("SELECT * FROM stops").all()) + JSON.stringify(api.app.db.prepare("SELECT * FROM users").all());
    for (const secret of ["Peanut allergy", "Child One", "Mont Kiara", "Grandma", "+60131234567", s.parent.phone]) {
      assert.equal(dump.includes(secret), false, `"${secret}" found in plaintext`);
    }
  });

  test("T16 encrypted data copied to another row cannot be decrypted (AAD binding)", async () => {
    const a = await api.login();
    const c1 = await api.call("POST", "/api/children", { name: "One", medical: "Epilepsy" }, a.token);
    const c2 = await api.call("POST", "/api/children", { name: "Two", medical: "None" }, a.token);
    const blob = (api.app.db.prepare("SELECT medical_enc FROM children WHERE id = ?").get(c1.body.id) as any).medical_enc;
    api.app.db.prepare("UPDATE children SET medical_enc = ? WHERE id = ?").run(blob, c2.body.id);
    const r = await api.call("GET", `/api/children/${c2.body.id}`, undefined, a.token);
    assert.equal(r.status, 500); // GCM authentication fails instead of showing the wrong child's data
    assert.equal(JSON.stringify(r.body).includes("Epilepsy"), false);
  });

  test("T17 location history is deleted when the trip is completed", async () => {
    const s = await api.tripInProgress();
    await api.call("POST", `/api/trips/${s.tripId}/location`, { lat: 3.13, lng: 101.68 }, s.escort.token);
    const live = await api.call("GET", `/api/trips/${s.tripId}/location`, undefined, s.parent.token);
    assert.equal(live.body.lat, 3.13);
    await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token);
    await api.call("POST", `/api/trips/${s.tripId}/stops/1/photo`, { mime: "image/png", data: PNG_1PX }, s.escort.token);
    const done = await api.call("POST", `/api/trips/${s.tripId}/stops/1/confirm`, {}, s.parent.token);
    assert.equal(done.body.tripCompleted, true);
    const n = (api.app.db.prepare("SELECT COUNT(*) AS n FROM locations WHERE trip_id = ?").get(s.tripId) as any).n;
    assert.equal(n, 0);
  });

  test("T18 the audit log cannot be edited or deleted", async () => {
    await api.login();
    assert.throws(() => api.app.db.prepare("DELETE FROM audit_log").run());
    assert.throws(() => api.app.db.prepare("UPDATE audit_log SET outcome = 'ok'").run());
  });
});

describe("Photos and signed links", () => {
  test("T19 a file that is not really an image is rejected", async () => {
    const s = await api.tripInProgress();
    await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token);
    const fake = Buffer.from("<script>alert(1)</script>").toString("base64");
    assert.equal((await api.call("POST", `/api/trips/${s.tripId}/stops/1/photo`, { mime: "image/png", data: fake }, s.escort.token)).status, 400);
  });

  test("T20 photo links work, but a changed signature or expiry is refused", async () => {
    const s = await api.tripInProgress();
    await api.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.code }, s.escort.token);
    await api.call("POST", `/api/trips/${s.tripId}/stops/1/photo`, { mime: "image/png", data: PNG_1PX }, s.escort.token);
    const link = await api.call("GET", `/api/trips/${s.tripId}/stops/1/photo-url`, undefined, s.parent.token);
    const ok = await fetch(api.base + link.body.url);
    assert.equal(ok.status, 200);
    assert.equal(ok.headers.get("content-type"), "image/png");
    const u = new URL(api.base + link.body.url);
    u.searchParams.set("exp", String(Number(u.searchParams.get("exp")) + 3600));
    assert.equal((await fetch(u)).status, 403);
    assert.equal((await fetch(api.base + link.body.url.replace(/sig=./, "sig=X"))).status, 403);
  });
});

describe("HTTP hardening", () => {
  test("T21 security headers are set and the server does not advertise itself", async () => {
    const r = await api.call("GET", "/healthz");
    assert.equal(r.headers.get("x-content-type-options"), "nosniff");
    assert.equal(r.headers.get("x-frame-options"), "DENY");
    assert.match(r.headers.get("content-security-policy") || "", /default-src 'none'/);
    assert.equal(r.headers.get("cache-control"), "no-store");
    assert.equal(r.headers.get("x-powered-by"), null);
  });

  test("T22 oversized bodies, wrong content types and bad JSON are rejected cleanly", async () => {
    const p = await api.login();
    const big = await fetch(api.base + "/api/children", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.token}` }, body: JSON.stringify({ name: "x".repeat(70000) }) });
    assert.equal(big.status, 413);
    const form = await fetch(api.base + "/api/children", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded", authorization: `Bearer ${p.token}` }, body: "name=x" });
    assert.equal(form.status, 415);
    const bad = await fetch(api.base + "/api/children", { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${p.token}` }, body: "{bad" });
    assert.equal(bad.status, 400);
  });

  test("T23 SQL injection attempts are treated as plain text", async () => {
    const p = await api.login();
    const c = await api.call("POST", "/api/children", { name: "Robert'); DROP TABLE children;--" }, p.token);
    assert.equal(c.status, 201);
    const list = await api.call("GET", "/api/children", undefined, p.token);
    assert.equal(list.body.children[0].name, "Robert'); DROP TABLE children;--");
  });

  test("T24 errors never leak internals", async () => {
    const r = await api.call("GET", "/api/does-not-exist");
    assert.deepEqual(r.body, { error: "not_found" });
  });
});
