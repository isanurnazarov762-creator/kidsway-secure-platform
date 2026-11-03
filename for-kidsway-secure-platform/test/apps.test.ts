// Three apps on one API (like a ride-hailing company): KidsWay for parents, KidsWay Guardian for
// escorts, KidsWay Control for staff. Each role signs in only through its own app.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.ts";
import type { Api } from "./helpers.ts";

let api: Api;
before(async () => { api = await startTestServer(); });
after(async () => { await api.close(); });

let n = 170000000;
const phone = () => `+60${++n}`;
async function verify(p: string, app?: string) {
  const a = await api.call("POST", "/api/auth/otp/request", { phone: p });
  return api.call("POST", "/api/auth/otp/verify", { phone: p, challengeId: a.body.challengeId, code: a.body.devCode, ...(app ? { app } : {}) });
}

describe("Separate apps", () => {
  test("A1 an admin cannot sign in through the parent app, only through KidsWay Control", async () => {
    const p = phone();
    api.app.createStaff(p, "Admin", "admin");
    const asParent = await verify(p, "parent");
    assert.equal(asParent.status, 403);
    assert.deepEqual(asParent.body, { error: "wrong_app", app: "control" });
    assert.equal((await verify(p)).status, 403, "no app given = parent app, the strict default");
    // (3 SMS codes per number per 10 minutes, so the Guardian app is checked in A2.)
    const ok = await verify(p, "control");
    assert.equal(ok.status, 200);
    assert.equal(ok.body.app, "control");
  });

  test("A2 a parent cannot open KidsWay Control or Guardian, even with a valid SMS code", async () => {
    const parent = await api.login();
    const r = await verify(parent.phone, "control");
    assert.deepEqual(r.body, { error: "wrong_app", app: "parent" });
    assert.equal((await verify(parent.phone, "guardian")).body.error, "wrong_app");
  });

  test("A3 no self sign-up in Guardian or Control: unknown numbers are not turned into accounts", async () => {
    const p = phone();
    assert.deepEqual((await verify(p, "guardian")).body, { error: "not_a_guardian" });
    assert.deepEqual((await verify(p, "control")).body, { error: "not_staff" });
    // The number is still free: it can become a parent account through the parent app.
    const asParent = await verify(p, "parent");
    assert.equal(asParent.status, 200);
    assert.equal(asParent.body.user.role, "parent");
  });

  test("A4 the app check happens only after the SMS code: a wrong code reveals nothing about the account", async () => {
    const p = phone();
    api.app.createStaff(p, "Admin", "admin");
    const a = await api.call("POST", "/api/auth/otp/request", { phone: p });
    const wrong = await api.call("POST", "/api/auth/otp/verify", { phone: p, challengeId: a.body.challengeId, code: a.body.devCode === "000000" ? "111111" : "000000", app: "parent" });
    assert.equal(wrong.body.error, "invalid_code", "same answer as for any number");
  });

  test("A5 staff sessions expire faster (15 minutes idle) than parent sessions", async () => {
    const p = phone();
    api.app.createStaff(p, "Admin", "admin");
    const staff = await verify(p, "control");
    const parent = await verify(phone(), "parent");
    assert.equal(staff.body.expiresIn, 15 * 60);
    assert.equal(parent.body.expiresIn, 30 * 60);
    // Simulate 16 minutes without activity.
    api.app.db.prepare("UPDATE sessions SET last_seen = last_seen - 960 WHERE app IN ('control','parent')").run();
    assert.equal((await api.call("GET", "/api/me", undefined, staff.body.token)).status, 401);
    assert.equal((await api.call("GET", "/api/me", undefined, parent.body.token)).status, 200);
  });

  test("A6 a session stops working if the account's role changes after sign-in", async () => {
    const parent = await api.login();
    api.app.db.prepare("UPDATE users SET role = 'admin' WHERE id = ?").run(parent.userId);
    assert.equal((await api.call("GET", "/api/me", undefined, parent.token)).status, 401);
  });

  test("A7 each app is served as its own page; Control gets no camera or GPS permission", async () => {
    const parentPage = await fetch(api.base + "/");
    const guardian = await fetch(api.base + "/guardian/");
    const control = await fetch(api.base + "/control/");
    for (const r of [parentPage, guardian, control]) assert.equal(r.status, 200);
    const [pt, gt, ct] = await Promise.all([parentPage.text(), guardian.text(), control.text()]);
    assert.match(pt, /\/static\/parent\.js/); assert.doesNotMatch(pt, /control\.js|guardian\.js/);
    assert.match(gt, /\/static\/guardian\.js/); assert.doesNotMatch(gt, /control\.js|parent\.js/);
    assert.match(ct, /\/static\/control\.js/); assert.doesNotMatch(ct, /guardian\.js|parent\.js/);
    assert.match(control.headers.get("permissions-policy")!, /camera=\(\)/);
    assert.match(control.headers.get("permissions-policy")!, /geolocation=\(\)/);
    assert.match(guardian.headers.get("permissions-policy")!, /camera=\(self\)/);
    assert.equal((await fetch(api.base + "/favicon.ico")).headers.get("content-type"), "image/x-icon");
    const old = await fetch(api.base + "/careers", { redirect: "manual" });
    assert.equal(old.status, 301);
    assert.equal(old.headers.get("location"), "/guardian/apply");
  });
});
