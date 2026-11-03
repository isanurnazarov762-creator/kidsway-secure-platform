// App features added for the working app: prices, round trips, map coordinates, cancel, regular plans.
// Each test also checks the security rule that comes with the feature.
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { startTestServer } from "./helpers.ts";
import type { Api } from "./helpers.ts";

let api: Api;
let phoneN = 170000000;
const nextPhone = () => `+60${++phoneN}`;
before(async () => { api = await startTestServer(); });
after(async () => { await api.close(); });

async function parentWithChild(name = "Aina") {
  const p = await api.login();
  const c = await api.call("POST", "/api/children", { name }, p.token);
  return { ...p, childId: c.body.id as string };
}
async function adminAndEscort() {
  const adminPhone = nextPhone();
  api.app.createStaff(adminPhone, "Admin", "admin");
  const admin = await api.login(adminPhone, "Admin", "control");
  const escortPhone = nextPhone();
  const e = await api.call("POST", "/api/admin/escorts", { phone: escortPhone, name: "Siti" }, admin.token);
  const escort = await api.login(escortPhone, "Escort", "guardian");
  return { admin, escort, escortId: e.body.id as string };
}
const HOME = { address: "Jalan Telawi, Bangsar", lat: 3.1319, lng: 101.6713 };
const SCHOOL = { address: "Sekolah Kebangsaan Bukit Damansara", lat: 3.1478, lng: 101.6596 };
const nowSec = () => Math.floor(Date.now() / 1000);

describe("Prices (admin-set, server-calculated)", () => {
  test("F1 quotes follow the admin's prices; parents cannot change prices", async () => {
    const p = await api.login();
    const { admin } = await adminAndEscort();
    assert.equal((await api.call("PUT", "/api/admin/settings", { currency: "RM", base: 1, extraChild: 0, extraStop: 0, regDiscount: 0 }, p.token)).status, 403);
    const set = await api.call("PUT", "/api/admin/settings", { currency: "RM", base: 30, extraChild: 10, extraStop: 5, regDiscount: 20 }, admin.token);
    assert.equal(set.status, 200);
    const q = await api.call("POST", "/api/quote", { kids: 2, drops: 2, backDrops: 1, days: 5 }, p.token);
    assert.equal(q.body.go, 45);            // 30 + 10 (2nd child) + 5 (2nd stop)
    assert.equal(q.body.back, 40);          // 30 + 10
    assert.equal(q.body.total, 85);
    assert.equal(q.body.week, 340);         // 85 x 5 days x 0.8
    assert.equal((await api.call("POST", "/api/quote", { kids: 1.5, drops: 1 }, p.token)).status, 400);
    assert.equal((await api.call("PUT", "/api/admin/settings", { currency: "RM", base: -1, extraChild: 0, extraStop: 0, regDiscount: 0 }, admin.token)).status, 400);
  });
});

describe("One-time trips: map points, there and back, cancel", () => {
  test("F2 a round trip creates two linked trips with their own codes; coordinates are stored encrypted", async () => {
    const p = await parentWithChild();
    const at = nowSec() + 3600;
    const r = await api.call("POST", "/api/trips", {
      childIds: [p.childId], service: "car", scheduledAt: at,
      stops: [HOME, { ...SCHOOL, receiver: { type: "trusted", name: "Teacher Lim", phone: "+60125550000" } }],
      back: { scheduledAt: at + 6 * 3600 }
    }, p.token);
    assert.equal(r.status, 201);
    assert.equal(r.body.trip.leg, "go");
    assert.equal(r.body.back.trip.leg, "back");
    assert.equal(r.body.trip.groupId, r.body.back.trip.groupId);
    assert.equal(r.body.handoverCodes.length, 1);
    assert.equal(r.body.back.handoverCodes.length, 1);
    assert.notEqual(r.body.handoverCodes[0].code, r.body.back.handoverCodes[0].code);
    // The way back defaults to school -> home, handed to the parent.
    assert.equal(r.body.back.trip.stops[0].address, SCHOOL.address);
    assert.equal(r.body.back.trip.stops[1].address, HOME.address);
    assert.equal(r.body.back.trip.stops[1].receiverType, "parent");
    assert.equal(r.body.price, r.body.trip.price + r.body.back.trip.price);
    assert.equal(r.body.trip.stops[0].lat, HOME.lat);
    const raw = api.app.db.prepare("SELECT geo_enc FROM stops WHERE trip_id = ? AND seq = 0").get(r.body.trip.id) as { geo_enc: string };
    assert.match(raw.geo_enc, /^v1\./);
    assert.ok(!raw.geo_enc.includes("3.13"));
  });

  test("F3 map points outside Malaysia and half-given coordinates are rejected", async () => {
    const p = await parentWithChild();
    const base = { childIds: [p.childId], service: "car", scheduledAt: nowSec() + 600 };
    const drop = { address: "X", receiver: { type: "parent" } };
    assert.equal((await api.call("POST", "/api/trips", { ...base, stops: [{ address: "London", lat: 51.5, lng: -0.12 }, drop] }, p.token)).status, 400);
    assert.equal((await api.call("POST", "/api/trips", { ...base, stops: [{ address: "Half", lat: 3.1 }, drop] }, p.token)).status, 400);
  });

  test("F4 parents cancel their own trips only, and not once the trip has started", async () => {
    const p = await parentWithChild();
    const other = await api.login();
    const t = await api.call("POST", "/api/trips", { childIds: [p.childId], service: "walk", scheduledAt: nowSec() + 600, stops: [HOME, { ...SCHOOL, receiver: { type: "parent" } }] }, p.token);
    assert.equal((await api.call("POST", `/api/trips/${t.body.trip.id}/cancel`, {}, other.token)).status, 404);
    assert.equal((await api.call("POST", `/api/trips/${t.body.trip.id}/cancel`, {}, p.token)).status, 200);
    const g = await api.call("GET", `/api/trips/${t.body.trip.id}`, undefined, p.token);
    assert.equal(g.body.status, "cancelled");
    const running = await api.tripInProgress();
    assert.equal((await api.call("POST", `/api/trips/${running.tripId}/cancel`, {}, running.parent.token)).status, 409);
  });
});

describe("Regular plans", () => {
  async function makePlan(p: { token: string; childId: string }, extra: Record<string, unknown> = {}) {
    return api.call("POST", "/api/plans", {
      childIds: [p.childId], service: "car", dir: "round",
      days: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"], goTime: "23:50", backTime: "23:55",
      go: [HOME, { ...SCHOOL, receiver: { type: "trusted", name: "Teacher Lim", phone: "+60125550000" } }],
      ...extra
    }, p.token);
  }

  test("F5 a plan creates the coming week's trips, once, there and back", async () => {
    const p = await parentWithChild();
    const r = await makePlan(p);
    assert.equal(r.status, 201);
    assert.ok(r.body.tripsCreated >= 12 && r.body.tripsCreated <= 14, `created ${r.body.tripsCreated}`);
    assert.equal(r.body.plan.back.length, 2);
    assert.equal(api.app.materialize(), 0); // running the scheduler again creates nothing new
    const trips = (await api.call("GET", "/api/trips", undefined, p.token)).body.trips.filter((t: any) => t.planId === r.body.plan.id);
    assert.equal(trips.length, r.body.tripsCreated);
    assert.ok(trips.every((t: any) => t.stops.slice(1).every((s: any) => s.codeIssued === false)));
  });

  test("F6 generated trips have no code until the parent issues one; then the handover works", async () => {
    const p = await parentWithChild();
    const plan = await makePlan(p, { dir: "one", backTime: undefined });
    const { admin, escort, escortId } = await adminAndEscort();
    const a = await api.call("POST", `/api/admin/plans/${plan.body.plan.id}/assign`, { escortId }, admin.token);
    assert.ok(a.body.trips >= 6);
    const trip = (await api.call("GET", "/api/trips", undefined, escort.token)).body.trips.find((t: any) => t.planId === plan.body.plan.id);
    assert.equal(trip.status, "assigned");
    await api.call("POST", `/api/trips/${trip.id}/start`, {}, escort.token);
    const before = await api.call("POST", `/api/trips/${trip.id}/stops/1/handover`, { code: "123456" }, escort.token);
    assert.equal(before.body.error, "code_not_issued_contact_parent");
    const issued = await api.call("POST", `/api/trips/${trip.id}/stops/1/reissue-code`, {}, p.token);
    assert.equal(issued.status, 200);
    const ok = await api.call("POST", `/api/trips/${trip.id}/stops/1/handover`, { code: issued.body.code }, escort.token);
    assert.equal(ok.status, 200);
  });

  test("F7 plans follow the same ownership rule as trips (BOLA): other parents and escorts get nothing", async () => {
    const p = await parentWithChild();
    const plan = await makePlan(p);
    const other = await api.login();
    const { escort } = await adminAndEscort();
    assert.equal((await api.call("GET", `/api/plans/${plan.body.plan.id}`, undefined, other.token)).status, 404);
    assert.equal((await api.call("POST", `/api/plans/${plan.body.plan.id}/status`, { status: "ended" }, other.token)).status, 404);
    assert.equal((await api.call("GET", "/api/plans", undefined, escort.token)).status, 403);
    assert.equal((await api.call("GET", "/api/plans", undefined, other.token)).body.plans.length, 0);
    // Booking another family's child into a plan is refused.
    assert.equal((await makePlan({ token: other.token, childId: p.childId })).status, 400);
  });

  test("F8 pause removes upcoming generated trips, resume brings them back, end is final", async () => {
    const p = await parentWithChild();
    const plan = await makePlan(p);
    const id = plan.body.plan.id;
    const paused = await api.call("POST", `/api/plans/${id}/status`, { status: "paused" }, p.token);
    assert.equal(paused.body.removed, plan.body.tripsCreated);
    const resumed = await api.call("POST", `/api/plans/${id}/status`, { status: "active" }, p.token);
    assert.equal(resumed.body.created, plan.body.tripsCreated);
    await api.call("POST", `/api/plans/${id}/status`, { status: "ended" }, p.token);
    assert.equal((await api.call("POST", `/api/plans/${id}/status`, { status: "active" }, p.token)).status, 409);
  });

  test("F9 per-day times and invalid plans", async () => {
    const p = await parentWithChild();
    const r = await makePlan(p, { goTime: "07:00", backTime: "14:00", overrides: { fri: { backTime: "12:30" } } });
    assert.equal(r.status, 201);
    assert.deepEqual(r.body.plan.overrides, { fri: { backTime: "12:30" } });
    const fri = (await api.call("GET", "/api/trips", undefined, p.token)).body.trips.find((t: any) => t.planId === r.body.plan.id && t.leg === "back" && new Date((t.scheduledAt + 8 * 3600) * 1000).getUTCDay() === 5);
    if (fri) assert.equal(new Date((fri.scheduledAt + 8 * 3600) * 1000).toISOString().slice(11, 16), "12:30");
    assert.equal((await makePlan(p, { goTime: "15:00", backTime: "14:00" })).status, 400);
    assert.equal((await makePlan(p, { days: ["funday"] })).status, 400);
    assert.equal((await makePlan(p, { startDate: "2020-01-01" })).status, 400);
    assert.equal((await makePlan(p, { overrides: { xyz: { goTime: "08:00" } } })).status, 400);
  });
});

describe("Profile", () => {
  test("F10 the home address is saved encrypted and only returned to its owner", async () => {
    const p = await api.login();
    assert.equal((await api.call("PATCH", "/api/me", { name: "Isa", home: HOME }, p.token)).status, 200);
    const me = await api.call("GET", "/api/me", undefined, p.token);
    assert.equal(me.body.name, "Isa");
    assert.deepEqual(me.body.home, HOME);
    const raw = api.app.db.prepare("SELECT home_enc FROM users WHERE id = ?").get(p.userId) as { home_enc: string };
    assert.ok(!raw.home_enc.includes("Telawi"));
    assert.equal((await api.call("PATCH", "/api/me", { home: { address: "Paris", lat: 48.8, lng: 2.3 } }, p.token)).status, 400);
  });
});
