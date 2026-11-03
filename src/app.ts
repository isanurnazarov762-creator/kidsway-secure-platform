// The KidsWay API. Read top to bottom: auth, children, trips, handover, photos, location, admin.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";
import { openDb, now, DEFAULT_SETTINGS } from "./db.ts";
import { makeSmsSender } from "./sms.ts";
import { registerHiring } from "./hiring.ts";
import { makeVerifier } from "./verifier.ts";
import type { DB } from "./db.ts";
import { HttpError, Router, clientIp, readBody, securityHeaders, sendJson } from "./http.ts";
import type { Ctx } from "./http.ts";
import { RateLimiter, makeSecurity } from "./security.ts";
import { CODE6_RE, PHONE_RE, int, num, obj, oneOf, str } from "./validate.ts";
import { readFileSync } from "node:fs";
import { decryptField, encryptField, hmac, newId, newToken, randomDigits, safeEqual, sha256, signUrl, verifySignedUrl } from "./crypto.ts";

type Row = Record<string, any>;
const SERVICES = ["walk", "public", "taxi", "car", "vip"] as const;
const ROLES = ["parent", "escort", "admin"] as const;
// Three apps on one API, like a ride-hailing company: each role signs in only through its own app,
// and the session remembers which app it was issued to.
const APPS = ["parent", "guardian", "control"] as const;
type AppId = (typeof APPS)[number];
const APP_FOR_ROLE: Record<string, AppId> = { parent: "parent", escort: "guardian", admin: "control" };
const DAYS = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] as const;
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const MY_OFFSET = 8 * 3600; // Malaysia is UTC+8 all year (no daylight saving)

type StopIn = { address: string; lat: number | null; lng: number | null; rType: "parent" | "trusted" | null; rName: string | null; rPhone: string | null };

export function createApp(cfg: Config) {
  const db: DB = openDb(cfg.dbPath);
  const sec = makeSecurity(cfg, db);
  const sendSms = makeSmsSender(process.env);
  const r = new Router();

  // ---------- rate-limit rules ----------
  const rl = {
    global: new RateLimiter(cfg.limits.globalIpPerMin, 60),                  // any request, per IP
    otpReqIp: new RateLimiter(cfg.limits.otpRequestIpPer10Min, 600),        // SMS requests per IP
    otpReqPhone: new RateLimiter(cfg.limits.otpRequestPhonePer10Min, 600),  // SMS requests per phone (stops SMS bombing)
    otpVerifyIp: new RateLimiter(cfg.limits.otpVerifyIpPer10Min, 600),
    handover: new RateLimiter(10, 60),       // handover code checks per escort per minute
    location: new RateLimiter(60, 60),       // location pings per trip per minute
    media: new RateLimiter(60, 60),
    reissue: new RateLimiter(10, 600),       // new handover codes per trip per 10 minutes
    apply: new RateLimiter(cfg.limits.otpRequestIpPer10Min, 600), // job applications per IP
    docs: new RateLimiter(30, 3600)          // document uploads per application per hour
  };

  // ---------- helpers ----------
  const enc = (v: string | null | undefined, aad: string) => (v == null ? null : encryptField(cfg, v, aad));
  const dec = (v: string | null, aad: string) => decryptField(cfg, v, aad);
  const phoneHash = (p: string) => hmac(cfg.pepper, "phone|" + p);
  const mask = (p: string) => p.slice(0, 5) + "•••" + p.slice(-3);

  function requireUser(ctx: Ctx, ...roles: Array<"parent" | "escort" | "admin">) {
    if (!ctx.user) throw new HttpError(401, "unauthorized");
    if (roles.length && !roles.includes(ctx.user.role)) {
      sec.audit(ctx, "role_check", null, "denied", "needs " + roles.join("|"));
      throw new HttpError(403, "forbidden");
    }
    return ctx.user;
  }

  /**
   * Object-level authorisation (OWASP API #1, BOLA/IDOR).
   * Returns 404, not 403, so an attacker cannot even learn that another family's trip exists.
   */
  function tripFor(ctx: Ctx, tripId: string): Row {
    const u = requireUser(ctx);
    const t = db.prepare("SELECT * FROM trips WHERE id = ?").get(tripId) as Row | undefined;
    const allowed = t && (u.role === "admin" || (u.role === "parent" && t.parent_id === u.id) || (u.role === "escort" && t.escort_id === u.id));
    if (!allowed) {
      if (t) sec.audit(ctx, "trip_access", ["trip", tripId], "denied");
      throw new HttpError(404, "not_found");
    }
    return t as Row;
  }

  function stopFor(trip: Row, seq: string): Row {
    const s = db.prepare("SELECT * FROM stops WHERE trip_id = ? AND seq = ?").get(trip.id, Number(seq)) as Row | undefined;
    if (!s || !/^\d{1,2}$/.test(seq)) throw new HttpError(404, "not_found");
    return s;
  }

  function childView(c: Row, full: boolean) {
    const aad = (col: string) => `children|${col}|${c.id}`;
    const v: Row = { id: c.id, name: dec(c.name_enc, aad("name")), medical: dec(c.medical_enc, aad("medical")), notes: dec(c.notes_enc, aad("notes")) };
    if (full) v.dob = dec(c.dob_enc, aad("dob"));
    return v;
  }

  function tripView(t: Row, forRole: string) {
    const stops = (db.prepare("SELECT * FROM stops WHERE trip_id = ? ORDER BY seq").all(t.id) as Row[]).map((s) => {
      const aad = (col: string) => `stops|${col}|${s.id}`;
      const v: Row = {
        seq: s.seq,
        address: dec(s.address_enc, aad("address")),
        receiverType: s.receiver_type,
        receiverName: dec(s.receiver_name_enc, aad("receiver_name")),
        handedOverAt: s.handed_over_at,
        confirmedAt: s.parent_confirmed_at,
        codeLocked: !!s.code_locked,
        codeIssued: !!s.code_hash || !!s.handed_over_at,
        hasPhoto: !!db.prepare("SELECT 1 FROM photos WHERE stop_id = ?").get(s.id),
        ...geoOut(dec(s.geo_enc, aad("geo")))
      };
      // Receiver phone numbers are visible to the parent and staff, not to the escort.
      if (forRole !== "escort") v.receiverPhone = dec(s.receiver_phone_enc, aad("receiver_phone"));
      return v;
    });
    const kids = db.prepare("SELECT child_id FROM trip_children WHERE trip_id = ?").all(t.id) as Row[];
    return {
      id: t.id, status: t.status, service: t.service, scheduledAt: t.scheduled_at,
      leg: t.leg, groupId: t.group_id, planId: t.plan_id, planDate: t.plan_date, price: t.price,
      escortAssigned: !!t.escort_id, escortName: t.escort_id && forRole !== "escort" ? userName(t.escort_id) : null,
      childIds: kids.map((k) => k.child_id), stops
    };
  }

  function userName(id: string): string | null {
    const u = db.prepare("SELECT name_enc FROM users WHERE id = ?").get(id) as Row | undefined;
    return u ? dec(u.name_enc, `users|name|${id}`) : null;
  }

  // Coordinates are stored encrypted as "lat,lng": where a child lives and studies is sensitive.
  function geoOut(g: string | null): { lat: number | null; lng: number | null } {
    if (!g) return { lat: null, lng: null };
    const [lat, lng] = g.split(",").map(Number);
    return { lat, lng };
  }
  const geoIn = (s: StopIn) => (s.lat == null ? null : `${s.lat.toFixed(6)},${s.lng!.toFixed(6)}`);

  // ---------- prices: set by the admin, always calculated on the server ----------
  function getSettings(): Row {
    const out: Row = { ...DEFAULT_SETTINGS };
    for (const row of db.prepare("SELECT key, value FROM settings").all() as Row[]) {
      out[row.key] = row.key === "currency" ? row.value : Number(row.value);
    }
    return out;
  }
  const round2 = (n: number) => Math.round(n * 100) / 100;
  /** Price of one leg: base + each extra child + each extra drop-off. */
  function legPrice(kids: number, drops: number): number {
    const s = getSettings();
    return round2(s.base + s.extraChild * Math.max(0, kids - 1) + s.extraStop * Math.max(0, drops - 1));
  }
  function weekPrice(perTripGo: number, perTripBack: number, days: number): number {
    const s = getSettings();
    return round2((perTripGo + perTripBack) * days * (1 - s.regDiscount / 100));
  }

  // ---------- shared input parsing ----------
  function parseChildIds(parentId: string, raw: unknown): string[] {
    if (!Array.isArray(raw) || raw.length < 1 || raw.length > 6 || new Set(raw).size !== raw.length) throw new HttpError(400, "invalid_childIds");
    for (const cid of raw) {
      if (typeof cid !== "string" || !ID_RE.test(cid) || !db.prepare("SELECT 1 FROM children WHERE id = ? AND parent_id = ?").get(cid, parentId)) {
        throw new HttpError(400, "invalid_childIds"); // cannot book someone else's child
      }
    }
    return raw as string[];
  }

  function parseStops(raw: unknown): StopIn[] {
    if (!Array.isArray(raw) || raw.length < 2 || raw.length > 6) throw new HttpError(400, "invalid_stops");
    return raw.map((x, seq) => {
      const s = obj(x);
      const address = str(s, "address", { max: 160 })!;
      let lat: number | null = null, lng: number | null = null;
      if (s.lat !== undefined || s.lng !== undefined) { lat = num(s, "lat", 0.5, 7.5); lng = num(s, "lng", 99.5, 119.5); } // Malaysia only
      if (seq === 0) return { address, lat, lng, rType: null, rName: null, rPhone: null };
      const rcv = obj(s.receiver);
      const rType = oneOf(rcv, "type", ["parent", "trusted"] as const);
      return {
        address, lat, lng, rType,
        rName: rType === "trusted" ? str(rcv, "name", { max: 80 })! : null,
        rPhone: rType === "trusted" ? str(rcv, "phone", { max: 16, re: PHONE_RE })! : null
      };
    });
  }

  /** The way back by default: from the last drop-off back to the pick-up point, handed to the parent. */
  function reverseStops(go: StopIn[]): StopIn[] {
    const last = go[go.length - 1], first = go[0];
    return [
      { address: last.address, lat: last.lat, lng: last.lng, rType: null, rName: null, rPhone: null },
      { address: first.address, lat: first.lat, lng: first.lng, rType: "parent", rName: null, rPhone: null }
    ];
  }

  /**
   * Inserts one trip with its stops. With withCodes=false (trips generated from a regular plan)
   * no handover code exists yet: the parent issues it in the app before the trip, so a readable
   * code is never stored anywhere.
   */
  function insertTrip(p: {
    parentId: string; service: string; scheduledAt: number; childIds: string[]; stops: StopIn[];
    groupId?: string | null; leg?: "go" | "back"; planId?: string | null; planDate?: string | null; escortId?: string | null; withCodes: boolean;
  }): { id: string; codes: Array<{ seq: number; code: string }> } {
    const id = newId();
    const codes: Array<{ seq: number; code: string }> = [];
    db.prepare("INSERT INTO trips (id, parent_id, escort_id, status, service, scheduled_at, group_id, leg, plan_id, plan_date, price, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, p.parentId, p.escortId ?? null, p.escortId ? "assigned" : "requested", p.service, p.scheduledAt, p.groupId ?? null, p.leg ?? "go",
        p.planId ?? null, p.planDate ?? null, legPrice(p.childIds.length, p.stops.length - 1), now());
    for (const cid of p.childIds) db.prepare("INSERT INTO trip_children (trip_id, child_id) VALUES (?,?)").run(id, cid);
    p.stops.forEach((s, seq) => {
      const sid = newId();
      const aad = (col: string) => `stops|${col}|${sid}`;
      let hash: string | null = null, exp: number | null = null;
      if (seq > 0 && p.withCodes) {
        const hc = makeHandoverCode(sid);
        hash = hc.hash; exp = p.scheduledAt + cfg.handoverTtlSec;
        codes.push({ seq, code: hc.code });
      }
      db.prepare("INSERT INTO stops (id, trip_id, seq, address_enc, geo_enc, receiver_type, receiver_name_enc, receiver_phone_enc, code_hash, code_expires_at) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(sid, id, seq, enc(s.address, aad("address")), enc(geoIn(s), aad("geo")), s.rType, enc(s.rName, aad("receiver_name")), enc(s.rPhone, aad("receiver_phone")), hash, exp);
    });
    return { id, codes };
  }

  function tx<T>(fn: () => T): T {
    db.exec("BEGIN");
    try { const v = fn(); db.exec("COMMIT"); return v; } catch (e) { db.exec("ROLLBACK"); throw e; }
  }

  // INSECURE_DEMO reproduces "v0" of the design: 4-digit codes and no attempt limit.
  const codeLen = cfg.insecureDemo ? 4 : 6;
  const codeRe = cfg.insecureDemo ? /^\d{4}$/ : CODE6_RE;

  function makeHandoverCode(stopId: string): { code: string; hash: string } {
    const code = randomDigits(codeLen);
    return { code, hash: hmac(cfg.pepper, `handover|${stopId}|${code}`) };
  }

  // =====================================================================
  // AUTH: phone number + one-time SMS code, then an opaque session token
  // =====================================================================
  r.add("POST", "/api/auth/otp/request", async (ctx) => {
    const b = obj(ctx.body);
    const phone = str(b, "phone", { max: 16, re: PHONE_RE })!;
    const ph = phoneHash(phone);
    sec.limit(rl.otpReqIp, ctx.ip, ctx, "otp_request_ip");
    sec.limit(rl.otpReqPhone, ph, ctx, "otp_request_phone");
    const id = newId();
    const code = randomDigits(codeLen);
    db.prepare("INSERT INTO otp_challenges (id, phone_hash, code_hash, expires_at, created_at) VALUES (?,?,?,?,?)")
      .run(id, ph, hmac(cfg.pepper, `otp|${id}|${code}`), now() + cfg.otpTtlSec, now());
    // The code goes out by SMS when a provider is configured (src/sms.ts). It is never logged.
    // The result is not shown to the client, so the answer is the same either way.
    const delivered = await sendSms(phone, `KidsWay code: ${code}. Valid 5 minutes. Never share it.`).catch(() => false);
    sec.log("otp_sent", ctx, { sms: delivered ? "sent" : "none" });
    // Same answer whether or not the number already has an account (no user enumeration).
    const res: Row = { status: "sent", challengeId: id, expiresIn: cfg.otpTtlSec };
    if (cfg.devOtpEcho) res.devCode = code;
    return [202, res];
  });

  r.add("POST", "/api/auth/otp/verify", (ctx) => {
    const b = obj(ctx.body);
    const challengeId = str(b, "challengeId", { max: 64, re: /^[A-Za-z0-9_-]+$/ })!;
    const code = str(b, "code", { max: 6, re: codeRe })!;
    const name = str(b, "name", { max: 80, optional: true });
    const phone = str(b, "phone", { max: 16, re: PHONE_RE })!;
    // Which app is signing in. Older clients that do not say are treated as the parent app (the strict default).
    const app: AppId = b.app === undefined ? "parent" : oneOf(b, "app", APPS);
    sec.limit(rl.otpVerifyIp, ctx.ip, ctx, "otp_verify_ip");

    const ch = db.prepare("SELECT * FROM otp_challenges WHERE id = ?").get(challengeId) as Row | undefined;
    const valid = ch && !ch.consumed && ch.expires_at > now() && ch.phone_hash === phoneHash(phone);
    if (!valid) {
      sec.log("auth_fail", ctx, { reason: "challenge_invalid" });
      throw new HttpError(400, "invalid_or_expired");
    }
    if (!safeEqual(hmac(cfg.pepper, `otp|${challengeId}|${code}`), ch!.code_hash)) {
      const attempts = ch!.attempts + 1;
      const burn = !cfg.insecureDemo && attempts >= cfg.otpMaxAttempts;
      db.prepare("UPDATE otp_challenges SET attempts = ?, consumed = ? WHERE id = ?").run(attempts, burn ? 1 : 0, challengeId);
      sec.log("auth_fail", ctx, { reason: burn ? "otp_locked" : "otp_wrong", attempts });
      throw new HttpError(400, burn ? "too_many_attempts" : "invalid_code");
    }
    db.prepare("UPDATE otp_challenges SET consumed = 1 WHERE id = ?").run(challengeId);

    let user = db.prepare("SELECT * FROM users WHERE phone_hash = ?").get(ch!.phone_hash) as Row | undefined;
    // These checks run only after the SMS code was proven, so they tell nothing to someone who does not own the phone.
    if (!user && app !== "parent") {
      // Guardians are created only through Hiring, staff only by an admin: no self sign-up in those apps.
      sec.audit(ctx, "login", null, "denied", `no_account app=${app}`);
      throw new HttpError(403, app === "guardian" ? "not_a_guardian" : "not_staff");
    }
    if (user && APP_FOR_ROLE[user.role] !== app) {
      // An admin cannot sign in through the parent app, a parent cannot open KidsWay Control, and so on.
      ctx.user = { id: user.id, role: user.role, sessionId: "" };
      sec.audit(ctx, "login", ["user", user.id], "denied", `wrong_app ${app}`);
      return [403, { error: "wrong_app", app: APP_FOR_ROLE[user.role] }];
    }
    if (!user) {
      // Self sign-up always creates a parent. Escorts and admins are created by an admin only.
      const id = newId();
      db.prepare("INSERT INTO users (id, phone_hash, phone_enc, name_enc, role, created_at) VALUES (?,?,?,?,?,?)")
        .run(id, ch!.phone_hash, enc(phone, `users|phone|${id}`), enc(name ?? null, `users|name|${id}`), "parent", now());
      user = db.prepare("SELECT * FROM users WHERE id = ?").get(id) as Row;
    }
    const token = newToken();
    const sid = newId();
    db.prepare("INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen, app) VALUES (?,?,?,?,?,?)").run(sid, user.id, sha256(token), now(), now(), app);
    ctx.user = { id: user.id, role: user.role, sessionId: sid };
    sec.audit(ctx, "login", ["user", user.id], "ok", `app=${app}`);
    return { token, app, expiresIn: app === "control" ? cfg.staffSessionIdleSec : cfg.sessionIdleSec, user: { id: user.id, role: user.role } };
  });

  r.add("POST", "/api/auth/logout", (ctx) => {
    const u = requireUser(ctx);
    db.prepare("UPDATE sessions SET revoked = 1 WHERE id = ?").run(u.sessionId);
    sec.audit(ctx, "logout", ["user", u.id], "ok");
    return { ok: true };
  });

  r.add("GET", "/api/me", (ctx) => {
    const u = requireUser(ctx);
    const row = db.prepare("SELECT * FROM users WHERE id = ?").get(u.id) as Row;
    const home = dec(row.home_enc, `users|home|${row.id}`);
    return { id: row.id, role: row.role, name: dec(row.name_enc, `users|name|${row.id}`), phone: mask(dec(row.phone_enc, `users|phone|${row.id}`)!), home: home ? JSON.parse(home) : null };
  });

  // Profile: name and home address (the home is encrypted like every other address).
  r.add("PATCH", "/api/me", (ctx) => {
    const u = requireUser(ctx);
    const b = obj(ctx.body);
    if (b.name !== undefined) {
      const name = str(b, "name", { max: 80 })!;
      db.prepare("UPDATE users SET name_enc = ? WHERE id = ?").run(enc(name, `users|name|${u.id}`), u.id);
    }
    if (b.home !== undefined) {
      let value: string | null = null;
      if (b.home !== null) {
        const h = obj(b.home);
        const address = str(h, "address", { max: 160 })!;
        const geo = h.lat !== undefined || h.lng !== undefined ? { lat: num(h, "lat", 0.5, 7.5), lng: num(h, "lng", 99.5, 119.5) } : { lat: null, lng: null };
        value = JSON.stringify({ address, ...geo });
      }
      db.prepare("UPDATE users SET home_enc = ? WHERE id = ?").run(enc(value, `users|home|${u.id}`), u.id);
    }
    sec.audit(ctx, "profile_update", ["user", u.id], "ok");
    return { ok: true };
  });

  // =====================================================================
  // PRICES: the admin sets them, the server calculates every quote
  // =====================================================================
  r.add("GET", "/api/settings", (ctx) => {
    requireUser(ctx);
    return { ...getSettings(), dev: cfg.env !== "production", demo: cfg.publicDemo };
  });

  r.add("PUT", "/api/admin/settings", (ctx) => {
    requireUser(ctx, "admin");
    const b = obj(ctx.body);
    const next: Row = {
      currency: str(b, "currency", { max: 5, re: /^[A-Za-z$€£¥]{1,5}$/ }),
      base: num(b, "base", 0, 10000),
      extraChild: num(b, "extraChild", 0, 10000),
      extraStop: num(b, "extraStop", 0, 10000),
      regDiscount: num(b, "regDiscount", 0, 90)
    };
    tx(() => { for (const [k, v] of Object.entries(next)) db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(k, String(v)); });
    sec.audit(ctx, "settings_update", ["settings", "prices"], "ok", Object.entries(next).map(([k, v]) => `${k}=${v}`).join(" "));
    return getSettings();
  });

  r.add("POST", "/api/quote", (ctx) => {
    requireUser(ctx);
    const b = obj(ctx.body);
    const kids = int(b, "kids", 1, 6), drops = int(b, "drops", 1, 5);
    const backDrops = b.backDrops === undefined ? 0 : int(b, "backDrops", 0, 5);
    const go = legPrice(kids, drops), back = backDrops ? legPrice(kids, backDrops) : 0;
    const res: Row = { currency: getSettings().currency, go, back, total: round2(go + back) };
    if (b.days !== undefined) res.week = weekPrice(go, back, int(b, "days", 1, 7));
    return res;
  });

  // =====================================================================
  // CHILDREN: sensitive fields are encrypted at rest with AES-256-GCM
  // =====================================================================
  r.add("POST", "/api/children", (ctx) => {
    const u = requireUser(ctx, "parent");
    const b = obj(ctx.body);
    const name = str(b, "name", { max: 60 })!;
    const dob = str(b, "dob", { max: 10, re: /^\d{4}-\d{2}-\d{2}$/, optional: true });
    const medical = str(b, "medical", { max: 300, optional: true });
    const notes = str(b, "notes", { max: 300, optional: true });
    const id = newId();
    const aad = (col: string) => `children|${col}|${id}`;
    db.prepare("INSERT INTO children (id, parent_id, name_enc, dob_enc, medical_enc, notes_enc, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, u.id, enc(name, aad("name")), enc(dob, aad("dob")), enc(medical, aad("medical")), enc(notes, aad("notes")), now());
    sec.audit(ctx, "child_create", ["child", id], "ok");
    return [201, { id }];
  });

  r.add("GET", "/api/children", (ctx) => {
    const u = requireUser(ctx, "parent");
    const rows = db.prepare("SELECT * FROM children WHERE parent_id = ? ORDER BY created_at").all(u.id) as Row[];
    return { children: rows.map((c) => childView(c, true)) };
  });

  r.add("GET", "/api/children/:id", (ctx) => {
    const u = requireUser(ctx);
    const c = db.prepare("SELECT * FROM children WHERE id = ?").get(ctx.params.id) as Row | undefined;
    if (!c) throw new HttpError(404, "not_found");
    let allowed = u.role === "admin" || c.parent_id === u.id;
    if (u.role === "escort") {
      // An escort sees a child only while assigned to an open trip with that child.
      allowed = !!db.prepare(
        "SELECT 1 FROM trips t JOIN trip_children tc ON tc.trip_id = t.id WHERE tc.child_id = ? AND t.escort_id = ? AND t.status IN ('assigned','in_progress')"
      ).get(c.id, u.id);
    }
    if (cfg.insecureDemo) allowed = true; // DEMO ONLY: the IDOR bug the attack script exploits
    if (!allowed) {
      sec.audit(ctx, "child_read", ["child", c.id], "denied");
      sec.log("access_denied", ctx, { target: "child" });
      throw new HttpError(404, "not_found");
    }
    sec.audit(ctx, "child_read", ["child", c.id], "ok");
    return childView(c, u.role !== "escort");
  });

  r.add("DELETE", "/api/children/:id", (ctx) => {
    // PDPA: parents can erase their child's data.
    const u = requireUser(ctx, "parent");
    const c = db.prepare("SELECT * FROM children WHERE id = ? AND parent_id = ?").get(ctx.params.id, u.id) as Row | undefined;
    if (!c) throw new HttpError(404, "not_found");
    const open = db.prepare("SELECT 1 FROM trip_children tc JOIN trips t ON t.id = tc.trip_id WHERE tc.child_id = ? AND t.status IN ('assigned','in_progress')").get(c.id);
    if (open) throw new HttpError(409, "child_has_open_trip");
    db.prepare("DELETE FROM children WHERE id = ?").run(c.id);
    sec.audit(ctx, "child_delete", ["child", c.id], "ok");
    return { ok: true };
  });

  // =====================================================================
  // TRIPS: A -> B -> C..., one trusted receiver and one handover code per drop-off
  // =====================================================================
  r.add("POST", "/api/trips", (ctx) => {
    const u = requireUser(ctx, "parent");
    const b = obj(ctx.body);
    const service = oneOf(b, "service", SERVICES);
    const scheduledAt = num(b, "scheduledAt", now() - 3600, now() + 366 * 86400);
    const childIds = parseChildIds(u.id, b.childIds);
    const stops = parseStops(b.stops);
    // Optional way back on the same booking ("there and back").
    let back: { scheduledAt: number; stops: StopIn[] } | null = null;
    if (b.back !== undefined && b.back !== null) {
      const bb = obj(b.back);
      const at = num(bb, "scheduledAt", scheduledAt + 60, scheduledAt + 2 * 86400);
      back = { scheduledAt: at, stops: bb.stops === undefined ? reverseStops(stops) : parseStops(bb.stops) };
    }
    const groupId = back ? newId() : null;
    const out = tx(() => {
      const go = insertTrip({ parentId: u.id, service, scheduledAt, childIds, stops, groupId, leg: "go", withCodes: true });
      const bk = back ? insertTrip({ parentId: u.id, service, scheduledAt: back.scheduledAt, childIds, stops: back.stops, groupId, leg: "back", withCodes: true }) : null;
      return { go, bk };
    });
    sec.audit(ctx, "trip_create", ["trip", out.go.id], "ok", `stops=${stops.length}${back ? " round" : ""}`);
    const view = (id: string) => tripView(db.prepare("SELECT * FROM trips WHERE id = ?").get(id) as Row, "parent");
    const goView = view(out.go.id);
    const res: Row = { trip: goView, handoverCodes: out.go.codes, price: goView.price };
    if (out.bk) {
      const backView = view(out.bk.id);
      res.back = { trip: backView, handoverCodes: out.bk.codes };
      res.price = round2(goView.price + backView.price);
    }
    // The codes are shown to the parent once and are never stored in readable form.
    return [201, res];
  });

  // Cancel before the escort starts. Parents cancel their own trips, admins any trip.
  r.add("POST", "/api/trips/:id/cancel", (ctx) => {
    const u = requireUser(ctx, "parent", "admin");
    const t = tripFor(ctx, ctx.params.id);
    if (!["requested", "assigned"].includes(t.status)) throw new HttpError(409, "trip_not_cancellable");
    db.prepare("UPDATE trips SET status = 'cancelled' WHERE id = ?").run(t.id);
    db.prepare("UPDATE stops SET code_hash = NULL WHERE trip_id = ?").run(t.id); // a cancelled trip's codes stop working
    sec.audit(ctx, "trip_cancel", ["trip", t.id], "ok", "by=" + u.role);
    return { ok: true };
  });

  r.add("GET", "/api/trips", (ctx) => {
    const u = requireUser(ctx);
    const rows = (u.role === "admin"
      ? db.prepare("SELECT * FROM trips ORDER BY scheduled_at DESC LIMIT 300").all()
      : db.prepare(`SELECT * FROM trips WHERE ${u.role === "parent" ? "parent_id" : "escort_id"} = ? ORDER BY scheduled_at DESC LIMIT 300`).all(u.id)) as Row[];
    return { trips: rows.map((t) => tripView(t, u.role)) };
  });

  r.add("GET", "/api/trips/:id", (ctx) => tripView(tripFor(ctx, ctx.params.id), ctx.user!.role));

  r.add("POST", "/api/trips/:id/start", (ctx) => {
    requireUser(ctx, "escort");
    const t = tripFor(ctx, ctx.params.id);
    if (t.status !== "assigned") throw new HttpError(409, "trip_not_assigned");
    db.prepare("UPDATE trips SET status = 'in_progress' WHERE id = ?").run(t.id);
    sec.audit(ctx, "trip_start", ["trip", t.id], "ok");
    return { ok: true };
  });

  // ---------- handover: the escort checks the receiver's one-time code ----------
  r.add("POST", "/api/trips/:id/stops/:seq/handover", (ctx) => {
    const u = requireUser(ctx, "escort");
    const t = tripFor(ctx, ctx.params.id);
    if (t.status !== "in_progress") throw new HttpError(409, "trip_not_in_progress");
    const s = stopFor(t, ctx.params.seq);
    if (s.seq === 0) throw new HttpError(400, "pickup_has_no_code");
    sec.limit(rl.handover, u.id, ctx, "handover_escort");
    const code = str(obj(ctx.body), "code", { max: 6, re: codeRe })!;

    if (s.handed_over_at) throw new HttpError(409, "already_handed_over");
    if (!s.code_hash) throw new HttpError(409, "code_not_issued_contact_parent");
    if (s.code_locked) {
      sec.log("handover_fail", ctx, { reason: "locked", trip: t.id, stop: s.seq });
      throw new HttpError(423, "code_locked_contact_parent");
    }
    if (s.code_expires_at < now()) throw new HttpError(410, "code_expired");

    if (!safeEqual(hmac(cfg.pepper, `handover|${s.id}|${code}`), s.code_hash)) {
      const attempts = s.code_attempts + 1;
      const lock = !cfg.insecureDemo && attempts >= cfg.handoverMaxAttempts;
      db.prepare("UPDATE stops SET code_attempts = ?, code_locked = ? WHERE id = ?").run(attempts, lock ? 1 : 0, s.id);
      sec.log("handover_fail", ctx, { reason: lock ? "locked_now" : "wrong_code", trip: t.id, stop: s.seq, attempts });
      sec.audit(ctx, "handover_check", ["stop", s.id], "failed", `attempt=${attempts}${lock ? " locked" : ""}`);
      // Real deployment: push an alert to the parent and the support team when the code locks.
      throw new HttpError(lock ? 423 : 400, lock ? "code_locked_contact_parent" : "wrong_code");
    }
    db.prepare("UPDATE stops SET handed_over_at = ?, code_hash = NULL WHERE id = ?").run(now(), s.id); // single use
    sec.audit(ctx, "handover_ok", ["stop", s.id], "ok");
    return { ok: true, next: "upload_photo" };
  });

  // The parent can issue a fresh code after a lock (for example the receiver mistyped it).
  r.add("POST", "/api/trips/:id/stops/:seq/reissue-code", (ctx) => {
    requireUser(ctx, "parent");
    const t = tripFor(ctx, ctx.params.id);
    const s = stopFor(t, ctx.params.seq);
    if (s.seq === 0 || s.handed_over_at || !["requested", "assigned", "in_progress"].includes(t.status)) throw new HttpError(409, "not_reissuable");
    sec.limit(rl.reissue, t.id, ctx, "reissue_trip");
    const hc = makeHandoverCode(s.id);
    // Also used for the first code of trips generated from a regular plan.
    db.prepare("UPDATE stops SET code_hash = ?, code_attempts = 0, code_locked = 0, code_expires_at = ? WHERE id = ?").run(hc.hash, Math.max(now(), t.scheduled_at) + cfg.handoverTtlSec, s.id);
    sec.audit(ctx, "handover_code_reissued", ["stop", s.id], "ok");
    return { seq: s.seq, code: hc.code };
  });

  // ---------- photo report ----------
  r.add("POST", "/api/trips/:id/stops/:seq/photo", (ctx) => {
    requireUser(ctx, "escort");
    const t = tripFor(ctx, ctx.params.id);
    const s = stopFor(t, ctx.params.seq);
    if (!s.handed_over_at) throw new HttpError(409, "handover_not_done");
    const b = obj(ctx.body);
    const mime = oneOf(b, "mime", ["image/jpeg", "image/png"] as const);
    const data = typeof b.data === "string" ? Buffer.from(b.data, "base64") : Buffer.alloc(0);
    if (data.length < 8 || data.length > cfg.maxPhotoBytes) throw new HttpError(400, "invalid_photo");
    // Check the real file signature, not just the declared type.
    const isJpeg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff;
    const isPng = data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    if ((mime === "image/jpeg" && !isJpeg) || (mime === "image/png" && !isPng)) {
      sec.log("upload_rejected", ctx, { reason: "signature_mismatch" });
      throw new HttpError(400, "invalid_photo");
    }
    const id = newId();
    db.prepare("INSERT INTO photos (id, stop_id, mime, data, created_at) VALUES (?,?,?,?,?)").run(id, s.id, mime, data, now());
    sec.audit(ctx, "photo_upload", ["stop", s.id], "ok");
    return [201, { ok: true }];
  });

  r.add("GET", "/api/trips/:id/stops/:seq/photo-url", (ctx) => {
    requireUser(ctx, "parent", "admin");
    const t = tripFor(ctx, ctx.params.id);
    const s = stopFor(t, ctx.params.seq);
    const p = db.prepare("SELECT id FROM photos WHERE stop_id = ? ORDER BY created_at DESC").get(s.id) as Row | undefined;
    if (!p) throw new HttpError(404, "no_photo");
    sec.audit(ctx, "photo_link", ["stop", s.id], "ok");
    return { url: signUrl(cfg, `/media/photos/${p.id}`, cfg.photoUrlTtlSec), expiresIn: cfg.photoUrlTtlSec };
  });

  r.add("POST", "/api/trips/:id/stops/:seq/confirm", (ctx) => {
    requireUser(ctx, "parent");
    const t = tripFor(ctx, ctx.params.id);
    const s = stopFor(t, ctx.params.seq);
    if (!s.handed_over_at) throw new HttpError(409, "handover_not_done");
    db.prepare("UPDATE stops SET parent_confirmed_at = ? WHERE id = ?").run(now(), s.id);
    sec.audit(ctx, "stop_confirm", ["stop", s.id], "ok");
    const open = db.prepare("SELECT 1 FROM stops WHERE trip_id = ? AND seq > 0 AND parent_confirmed_at IS NULL").get(t.id);
    if (!open) {
      db.prepare("UPDATE trips SET status = 'completed' WHERE id = ?").run(t.id);
      // Data minimisation: the location trail is deleted when the trip is complete.
      db.prepare("DELETE FROM locations WHERE trip_id = ?").run(t.id);
      sec.audit(ctx, "trip_complete", ["trip", t.id], "ok", "locations purged");
    }
    return { ok: true, tripCompleted: !open };
  });

  // ---------- live location: only during an active trip ----------
  r.add("POST", "/api/trips/:id/location", (ctx) => {
    requireUser(ctx, "escort");
    const t = tripFor(ctx, ctx.params.id);
    if (t.status !== "in_progress") throw new HttpError(409, "trip_not_in_progress");
    sec.limit(rl.location, t.id, ctx, "location_trip");
    const b = obj(ctx.body);
    db.prepare("INSERT INTO locations (trip_id, lat, lng, at) VALUES (?,?,?,?)").run(t.id, num(b, "lat", 0.5, 7.5), num(b, "lng", 99.5, 119.5), now()); // Malaysia bounding box
    return { ok: true };
  });

  r.add("GET", "/api/trips/:id/location", (ctx) => {
    requireUser(ctx, "parent", "admin");
    const t = tripFor(ctx, ctx.params.id);
    if (t.status !== "in_progress") throw new HttpError(409, "trip_not_in_progress");
    const l = db.prepare("SELECT lat, lng, at FROM locations WHERE trip_id = ? ORDER BY at DESC, rowid DESC LIMIT 1").get(t.id) as Row | undefined;
    return l ? { lat: l.lat, lng: l.lng, at: l.at } : { lat: null, lng: null, at: null };
  });

  // =====================================================================
  // REGULAR PLANS: chosen weekdays, times there and back, trips generated a week ahead
  // =====================================================================
  function planFor(ctx: Ctx, planId: string): Row {
    const u = requireUser(ctx, "parent", "admin");
    const p = db.prepare("SELECT * FROM plans WHERE id = ?").get(planId) as Row | undefined;
    if (!p || (u.role === "parent" && p.parent_id !== u.id)) {
      if (p) sec.audit(ctx, "plan_access", ["plan", planId], "denied");
      throw new HttpError(404, "not_found"); // same BOLA rule as trips
    }
    return p;
  }

  function planStops(planId: string, leg: "go" | "back"): StopIn[] {
    return (db.prepare("SELECT * FROM plan_stops WHERE plan_id = ? AND leg = ? ORDER BY seq").all(planId, leg) as Row[]).map((s) => {
      const aad = (col: string) => `plan_stops|${col}|${s.id}`;
      const g = geoOut(dec(s.geo_enc, aad("geo")));
      return { address: dec(s.address_enc, aad("address"))!, lat: g.lat, lng: g.lng, rType: s.receiver_type, rName: dec(s.receiver_name_enc, aad("receiver_name")), rPhone: dec(s.receiver_phone_enc, aad("receiver_phone")) };
    });
  }

  function planOverrides(planId: string): Record<string, { goTime?: string; backTime?: string }> {
    const out: Record<string, { goTime?: string; backTime?: string }> = {};
    for (const o of db.prepare("SELECT day, data_enc FROM plan_overrides WHERE plan_id = ?").all(planId) as Row[]) {
      out[o.day] = JSON.parse(dec(o.data_enc, `plan_overrides|data|${planId}|${o.day}`)!);
    }
    return out;
  }

  function planView(p: Row, forRole: string) {
    const kids = db.prepare("SELECT child_id FROM plan_children WHERE plan_id = ?").all(p.id) as Row[];
    const stopOut = (s: StopIn) => ({ address: s.address, lat: s.lat, lng: s.lng, receiverType: s.rType, receiverName: s.rName, receiverPhone: s.rPhone });
    const upcoming = db.prepare("SELECT COUNT(*) AS n FROM trips WHERE plan_id = ? AND status IN ('requested','assigned') AND scheduled_at > ?").get(p.id, now()) as Row;
    return {
      id: p.id, status: p.status, service: p.service, dir: p.dir, days: p.days.split(","), goTime: p.go_time, backTime: p.back_time,
      startDate: p.start_date, endDate: p.end_date, priceWeek: p.price_week,
      escortAssigned: !!p.escort_id, escortName: p.escort_id && forRole !== "escort" ? userName(p.escort_id) : null,
      childIds: kids.map((k) => k.child_id), go: planStops(p.id, "go").map(stopOut),
      back: p.dir === "round" ? planStops(p.id, "back").map(stopOut) : [], overrides: planOverrides(p.id), upcomingTrips: upcoming.n
    };
  }

  /** Malaysia-time calendar day `offset` days from now: { date: "YYYY-MM-DD", day: "mon", y, m, d }. */
  function myDay(offset: number) {
    const t = new Date((now() + MY_OFFSET + offset * 86400) * 1000);
    return { date: t.toISOString().slice(0, 10), day: DAYS[t.getUTCDay()], y: t.getUTCFullYear(), m: t.getUTCMonth(), d: t.getUTCDate() };
  }
  const myEpoch = (y: number, m: number, d: number, hhmm: string) => Date.UTC(y, m, d, Number(hhmm.slice(0, 2)), Number(hhmm.slice(3, 5))) / 1000 - MY_OFFSET;

  /**
   * Creates the trips of every active plan for the next 7 days (Malaysia time).
   * Safe to run any number of times: (plan, date, leg) is unique, so nothing is created twice.
   */
  function materialize(onlyPlanId?: string): number {
    const plans = (onlyPlanId
      ? db.prepare("SELECT * FROM plans WHERE id = ? AND status = 'active'").all(onlyPlanId)
      : db.prepare("SELECT * FROM plans WHERE status = 'active'").all()) as Row[];
    let created = 0;
    for (const p of plans) {
      const days = new Set(p.days.split(","));
      const childIds = (db.prepare("SELECT child_id FROM plan_children WHERE plan_id = ?").all(p.id) as Row[]).map((k) => k.child_id as string);
      if (!childIds.length) continue;
      const legs: Array<["go" | "back", StopIn[]]> = [["go", planStops(p.id, "go")]];
      if (p.dir === "round") legs.push(["back", planStops(p.id, "back")]);
      const ov = planOverrides(p.id);
      for (let i = 0; i < 7; i++) {
        const day = myDay(i);
        if (!days.has(day.day) || day.date < p.start_date || (p.end_date && day.date > p.end_date)) continue;
        for (const [leg, stops] of legs) {
          const time = leg === "go" ? ov[day.day]?.goTime ?? p.go_time : ov[day.day]?.backTime ?? p.back_time;
          if (!time) continue;
          const at = myEpoch(day.y, day.m, day.d, time);
          if (at < now()) continue;
          if (db.prepare("SELECT 1 FROM trips WHERE plan_id = ? AND plan_date = ? AND leg = ?").get(p.id, day.date, leg)) continue;
          tx(() => insertTrip({ parentId: p.parent_id, service: p.service, scheduledAt: at, childIds, stops, groupId: `${p.id}:${day.date}`, leg, planId: p.id, planDate: day.date, escortId: p.escort_id, withCodes: false }));
          created++;
        }
      }
    }
    return created;
  }

  // Generated trips that have not started are removed on pause/end, so resuming can create them again.
  // A single trip the parent cancelled by hand stays cancelled and is not re-created.
  function removeFuturePlanTrips(planId: string): number {
    const r2 = db.prepare("DELETE FROM trips WHERE plan_id = ? AND status IN ('requested','assigned') AND scheduled_at > ?").run(planId, now());
    return Number(r2.changes);
  }

  r.add("POST", "/api/plans", (ctx) => {
    const u = requireUser(ctx, "parent");
    const b = obj(ctx.body);
    const service = oneOf(b, "service", SERVICES);
    const dir = oneOf(b, "dir", ["one", "round"] as const);
    const childIds = parseChildIds(u.id, b.childIds);
    if (!Array.isArray(b.days) || b.days.length < 1 || b.days.length > 7) throw new HttpError(400, "invalid_days");
    const days = [...new Set(b.days as unknown[])].map((d) => { if (typeof d !== "string" || !(DAYS as readonly string[]).includes(d)) throw new HttpError(400, "invalid_days"); return d; });
    const goTime = str(b, "goTime", { max: 5, re: TIME_RE })!;
    const backTime = dir === "round" ? str(b, "backTime", { max: 5, re: TIME_RE })! : null;
    if (backTime && backTime <= goTime) throw new HttpError(400, "invalid_backTime");
    const today = myDay(0).date;
    const startDate = str(b, "startDate", { max: 10, re: DATE_RE, optional: true }) ?? today;
    const endDate = str(b, "endDate", { max: 10, re: DATE_RE, optional: true }) ?? null;
    if (startDate < today || (endDate && endDate < startDate) || startDate > myDay(366).date) throw new HttpError(400, "invalid_dates");
    const go = parseStops(b.go);
    const back = dir === "round" ? (b.back === undefined ? reverseStops(go) : parseStops(b.back)) : [];
    // Per-weekday exceptions, e.g. Friday: pick up at 12:30 instead of 14:00.
    const overrides: Record<string, { goTime?: string; backTime?: string }> = {};
    if (b.overrides !== undefined) {
      for (const [day, raw] of Object.entries(obj(b.overrides))) {
        if (!days.includes(day)) throw new HttpError(400, "invalid_overrides");
        const o = obj(raw);
        const v: { goTime?: string; backTime?: string } = {};
        const g = str(o, "goTime", { max: 5, re: TIME_RE, optional: true }); if (g) v.goTime = g;
        const k = dir === "round" ? str(o, "backTime", { max: 5, re: TIME_RE, optional: true }) : undefined; if (k) v.backTime = k;
        if ((v.backTime ?? backTime ?? "99") <= (v.goTime ?? goTime)) throw new HttpError(400, "invalid_overrides");
        if (Object.keys(v).length) overrides[day] = v;
      }
    }
    const priceWeek = weekPrice(legPrice(childIds.length, go.length - 1), back.length ? legPrice(childIds.length, back.length - 1) : 0, days.length);
    const id = newId();
    tx(() => {
      db.prepare("INSERT INTO plans (id, parent_id, status, service, dir, days, go_time, back_time, start_date, end_date, price_week, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)")
        .run(id, u.id, "active", service, dir, days.join(","), goTime, backTime, startDate, endDate, priceWeek, now());
      for (const cid of childIds) db.prepare("INSERT INTO plan_children (plan_id, child_id) VALUES (?,?)").run(id, cid);
      for (const [leg, stops] of [["go", go], ["back", back]] as Array<["go" | "back", StopIn[]]>) {
        stops.forEach((s, seq) => {
          const sid = newId();
          const aad = (col: string) => `plan_stops|${col}|${sid}`;
          db.prepare("INSERT INTO plan_stops (id, plan_id, leg, seq, address_enc, geo_enc, receiver_type, receiver_name_enc, receiver_phone_enc) VALUES (?,?,?,?,?,?,?,?,?)")
            .run(sid, id, leg, seq, enc(s.address, aad("address")), enc(geoIn(s), aad("geo")), s.rType, enc(s.rName, aad("receiver_name")), enc(s.rPhone, aad("receiver_phone")));
        });
      }
      for (const [day, v] of Object.entries(overrides)) {
        db.prepare("INSERT INTO plan_overrides (plan_id, day, data_enc) VALUES (?,?,?)").run(id, day, enc(JSON.stringify(v), `plan_overrides|data|${id}|${day}`));
      }
    });
    const created = materialize(id);
    sec.audit(ctx, "plan_create", ["plan", id], "ok", `days=${days.join(",")} dir=${dir} trips=${created}`);
    return [201, { plan: planView(db.prepare("SELECT * FROM plans WHERE id = ?").get(id) as Row, "parent"), tripsCreated: created }];
  });

  r.add("GET", "/api/plans", (ctx) => {
    const u = requireUser(ctx, "parent", "admin");
    const rows = (u.role === "admin"
      ? db.prepare("SELECT * FROM plans ORDER BY created_at DESC LIMIT 200").all()
      : db.prepare("SELECT * FROM plans WHERE parent_id = ? ORDER BY created_at DESC").all(u.id)) as Row[];
    return { plans: rows.map((p) => planView(p, u.role)) };
  });

  r.add("GET", "/api/plans/:id", (ctx) => planView(planFor(ctx, ctx.params.id), ctx.user!.role));

  // Pause, resume or end a plan. Pausing or ending cancels the trips not yet started.
  r.add("POST", "/api/plans/:id/status", (ctx) => {
    requireUser(ctx, "parent", "admin");
    const p = planFor(ctx, ctx.params.id);
    const status = oneOf(obj(ctx.body), "status", ["active", "paused", "ended"] as const);
    if (p.status === "ended") throw new HttpError(409, "plan_ended");
    db.prepare("UPDATE plans SET status = ? WHERE id = ?").run(status, p.id);
    const removed = status === "active" ? 0 : removeFuturePlanTrips(p.id);
    const created = status === "active" ? materialize(p.id) : 0;
    sec.audit(ctx, "plan_status", ["plan", p.id], "ok", `status=${status} removed=${removed} created=${created}`);
    return { ok: true, status, removed, created };
  });

  // The admin gives a plan its regular escort; upcoming trips of the plan follow.
  r.add("POST", "/api/admin/plans/:id/assign", (ctx) => {
    requireUser(ctx, "admin");
    const p = planFor(ctx, ctx.params.id);
    const escortId = str(obj(ctx.body), "escortId", { max: 64, re: ID_RE })!;
    const e = db.prepare("SELECT role FROM users WHERE id = ?").get(escortId) as Row | undefined;
    if (!e || e.role !== "escort") throw new HttpError(400, "invalid_escortId");
    db.prepare("UPDATE plans SET escort_id = ? WHERE id = ?").run(escortId, p.id);
    const moved = db.prepare("UPDATE trips SET escort_id = ?, status = 'assigned' WHERE plan_id = ? AND status IN ('requested','assigned') AND scheduled_at > ?").run(escortId, p.id, now());
    sec.audit(ctx, "plan_assign", ["plan", p.id], "ok", `escort=${escortId} trips=${moved.changes}`);
    return { ok: true, trips: Number(moved.changes) };
  });

  // =====================================================================
  // ADMIN
  // =====================================================================
  // Development and test shortcut only. In production every Guardian comes through vetting (src/hiring.ts).
  r.add("POST", "/api/admin/escorts", (ctx) => {
    requireUser(ctx, "admin");
    if (cfg.env === "production") throw new HttpError(403, "use_vetting");
    const b = obj(ctx.body);
    const phone = str(b, "phone", { max: 16, re: PHONE_RE })!;
    const name = str(b, "name", { max: 80 })!;
    const ph = phoneHash(phone);
    if (db.prepare("SELECT 1 FROM users WHERE phone_hash = ?").get(ph)) throw new HttpError(409, "phone_in_use");
    const id = newId();
    db.prepare("INSERT INTO users (id, phone_hash, phone_enc, name_enc, role, created_at) VALUES (?,?,?,?,?,?)")
      .run(id, ph, enc(phone, `users|phone|${id}`), enc(name, `users|name|${id}`), "escort", now());
    sec.audit(ctx, "escort_create", ["user", id], "ok");
    return [201, { id }];
  });

  r.add("POST", "/api/admin/trips/:id/assign", (ctx) => {
    requireUser(ctx, "admin");
    const t = tripFor(ctx, ctx.params.id);
    const escortId = str(obj(ctx.body), "escortId", { max: 64, re: /^[A-Za-z0-9_-]+$/ })!;
    const e = db.prepare("SELECT role FROM users WHERE id = ?").get(escortId) as Row | undefined;
    if (!e || e.role !== "escort") throw new HttpError(400, "invalid_escortId");
    if (!["requested", "assigned"].includes(t.status)) throw new HttpError(409, "trip_not_assignable");
    db.prepare("UPDATE trips SET escort_id = ?, status = 'assigned' WHERE id = ?").run(escortId, t.id);
    sec.audit(ctx, "trip_assign", ["trip", t.id], "ok", "escort=" + escortId);
    return { ok: true };
  });

  r.add("GET", "/api/admin/audit", (ctx) => {
    requireUser(ctx, "admin");
    const n = Math.min(500, Math.max(1, Number(ctx.url.searchParams.get("limit") || 100) || 100));
    return { entries: db.prepare("SELECT * FROM audit_log ORDER BY id DESC LIMIT ?").all(n) };
  });

  r.add("GET", "/api/admin/escorts", (ctx) => {
    requireUser(ctx, "admin");
    const rows = db.prepare("SELECT id, name_enc FROM users WHERE role = 'escort' ORDER BY created_at").all() as Row[];
    return { escorts: rows.map((u) => ({ id: u.id, name: dec(u.name_enc, `users|name|${u.id}`) })) };
  });

  r.add("GET", "/healthz", () => ({ ok: true }));
  // Public, no data: lets the page show the "demo" banner before anyone signs in.
  r.add("GET", "/api/info", () => ({ demo: cfg.publicDemo }));

  // ---------- the web app (static files) ----------
  // A fixed allow-list of files: no user input ever reaches a file path, so no path traversal.
  // The page gets a strict CSP: scripts and styles only from this origin, no inline code.
  // Two third-party hosts are allowed on purpose (see docs/threat-model.md):
  //   map tiles from tile.openstreetmap.org (images only) and address search from nominatim.openstreetmap.org.
  const TILE_HOST = "https://tile.openstreetmap.org";
  const GEO_HOST = "https://nominatim.openstreetmap.org";
  const PAGE_CSP = `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' blob: data: ${TILE_HOST}; connect-src 'self' ${GEO_HOST}; worker-src 'self'; manifest-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'`;
  // Each app asks the browser only for the device permissions it needs (least privilege):
  // parents may use GPS to pin an address, Guardians need GPS and the camera, KidsWay Control needs neither.
  const pageHeaders = (perms: string): Record<string, string> => ({
    // OpenStreetMap's usage policies ask for a Referer; only the origin is sent, never the page path.
    "Referrer-Policy": "strict-origin",
    "Permissions-Policy": perms + ", microphone=(), payment=(), usb=()"
  });
  const P_PARENT = pageHeaders("geolocation=(self), camera=()");
  const P_GUARDIAN = pageHeaders("geolocation=(self), camera=(self)");
  const P_CONTROL = pageHeaders("geolocation=(), camera=()");
  const JS = "text/javascript; charset=utf-8", HTML = "text/html; charset=utf-8", PNG = "image/png", MANIFEST = "application/manifest+json";
  // Three apps, like a ride-hailing company, and each page loads only its own code:
  // a parent's phone never downloads the code of the staff console.
  const STATIC: Record<string, [string, string, Record<string, string>]> = {
    // KidsWay (parents)
    "/": ["index.html", HTML, P_PARENT],
    "/manifest\\.webmanifest": ["manifest.webmanifest", MANIFEST, P_PARENT],
    "/sw\\.js": ["sw.js", JS, P_PARENT],
    "/static/parent\\.js": ["parent.js", JS, P_PARENT],
    // KidsWay Guardian (escorts): applying for the job and the daily work in one app
    "/guardian/": ["guardian.html", HTML, P_GUARDIAN],
    "/guardian/apply": ["careers.html", HTML, P_GUARDIAN],
    "/guardian/manifest\\.webmanifest": ["guardian.webmanifest", MANIFEST, P_GUARDIAN],
    "/guardian/sw\\.js": ["sw.js", JS, P_GUARDIAN],
    "/static/guardian\\.js": ["guardian.js", JS, P_GUARDIAN],
    "/static/careers\\.js": ["careers.js", JS, P_GUARDIAN],
    "/static/icon-guardian-192\\.png": ["icon-guardian-192.png", PNG, P_GUARDIAN],
    "/static/icon-guardian-512\\.png": ["icon-guardian-512.png", PNG, P_GUARDIAN],
    // KidsWay Control (staff)
    "/control/": ["control.html", HTML, P_CONTROL],
    "/control/manifest\\.webmanifest": ["control.webmanifest", MANIFEST, P_CONTROL],
    "/control/sw\\.js": ["sw.js", JS, P_CONTROL],
    "/static/control\\.js": ["control.js", JS, P_CONTROL],
    "/static/icon-control-192\\.png": ["icon-control-192.png", PNG, P_CONTROL],
    "/static/icon-control-512\\.png": ["icon-control-512.png", PNG, P_CONTROL],
    // shared by all three
    "/static/core\\.js": ["core.js", JS, P_PARENT],
    "/static/map\\.js": ["map.js", JS, P_PARENT],
    "/static/app\\.css": ["app.css", "text/css; charset=utf-8", P_PARENT],
    "/static/icon-192\\.png": ["icon-192.png", PNG, P_PARENT],
    "/static/icon-512\\.png": ["icon-512.png", PNG, P_PARENT],
    "/favicon\\.ico": ["favicon.ico", "image/x-icon", P_PARENT] // browsers ask for it by themselves
  };
  const publicDir = new URL("../public/", import.meta.url);
  for (const [route, [file, mime, headers]] of Object.entries(STATIC)) {
    // A service worker at /guardian/sw.js can only ever control /guardian/ pages (browser rule).
    r.add("GET", route, () => ({ __raw: true, mime, csp: PAGE_CSP, headers, data: readFileSync(new URL(file, publicDir)) }));
  }
  // Fixed redirects (no user input in the target, so no open redirect).
  const REDIRECTS: Record<string, string> = { "/guardian": "/guardian/", "/control": "/control/", "/careers": "/guardian/apply" };
  for (const [from, to] of Object.entries(REDIRECTS)) r.add("GET", from, () => ({ __redirect: to }));

  // ---------- signed photo links (no session needed, the signature is the permission) ----------
  r.add("GET", "/media/photos/:id", (ctx) => {
    sec.limit(rl.media, ctx.ip, ctx, "media_ip");
    const path = `/media/photos/${ctx.params.id}`;
    if (!verifySignedUrl(cfg, path, ctx.url.searchParams.get("exp"), ctx.url.searchParams.get("sig"))) {
      sec.log("signed_url_rejected", ctx);
      throw new HttpError(403, "link_invalid_or_expired");
    }
    const p = db.prepare("SELECT mime, data FROM photos WHERE id = ?").get(ctx.params.id) as Row | undefined;
    if (!p) throw new HttpError(404, "not_found");
    return { __raw: true, mime: p.mime, data: Buffer.from(p.data) };
  });

  // =====================================================================
  // HIRING: KidsWay Guardian applications and security vetting (src/hiring.ts)
  // =====================================================================
  const hiring = registerHiring({ r, db, cfg, sec, enc, dec, phoneHash, requireUser, sendSms, rl, verifier: makeVerifier(cfg) });

  // =====================================================================
  // Request pipeline
  // =====================================================================
  const findSession = db.prepare("SELECT s.id, s.user_id, s.created_at, s.last_seen, s.revoked, s.app, u.role, u.perms FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = ?");
  const touchSession = db.prepare("UPDATE sessions SET last_seen = ? WHERE id = ?");

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    securityHeaders(res);
    res.removeHeader("X-Powered-By");
    const url = new URL(req.url || "/", "http://localhost");
    const ctx: Ctx = { req, res, url, ip: clientIp(cfg, req), params: {}, body: null, rawBody: null, user: null, requestId: newId().slice(0, 10) };
    try {
      sec.limit(rl.global, ctx.ip, ctx, "global_ip");
      const m = r.match(req.method || "GET", url.pathname);
      if (m === null) throw new HttpError(404, "not_found");
      if (m === "method") throw new HttpError(405, "method_not_allowed");
      ctx.params = m.params;

      // Authentication: "Authorization: Bearer <token>"
      const auth = req.headers.authorization;
      if (auth) {
        const mt = /^Bearer ([A-Za-z0-9_-]{20,100})$/.exec(auth);
        if (mt && mt[1].startsWith("ap_")) {
          // Job applicants have their own, limited sessions: they can only reach /api/careers.
          ctx.applicant = hiring.resolveApplicant(mt[1]);
          if (!ctx.applicant) { sec.log("auth_fail", ctx, { reason: "bad_applicant_session" }); throw new HttpError(401, "unauthorized"); }
        }
        const s = mt && !ctx.applicant ? (findSession.get(sha256(mt[1])) as Row | undefined) : undefined;
        const t = now();
        const staff = s && s.app === "control";
        const idle = staff ? cfg.staffSessionIdleSec : cfg.sessionIdleSec, absolute = staff ? cfg.staffSessionAbsoluteSec : cfg.sessionAbsoluteSec;
        // A session is valid only for the app it was issued to: if the role changed since (for example a
        // parent account was turned into staff), the old session stops working.
        if (ctx.applicant) { /* applicant session resolved above */ } else if (!s || s.revoked || t - s.last_seen > idle || t - s.created_at > absolute || s.app !== APP_FOR_ROLE[s.role]) {
          sec.log("auth_fail", ctx, { reason: "bad_session" });
          throw new HttpError(401, "unauthorized");
        }
        if (s) {
          if (String(s.perms || "").split(",").includes("suspended")) throw new HttpError(403, "account_suspended");
          touchSession.run(t, s.id);
          ctx.user = { id: s.user_id, role: s.role, sessionId: s.id };
        }
      }

      if (req.method === "POST" || req.method === "PATCH" || req.method === "PUT") {
        const ct = String(req.headers["content-type"] || "");
        if (!ct.startsWith("application/json")) throw new HttpError(415, "json_only");
        const raw = await readBody(req, m.route.maxBody || cfg.maxJsonBytes);
        try { ctx.body = raw.length ? JSON.parse(raw.toString("utf8")) : {}; } catch { throw new HttpError(400, "invalid_json"); }
      }

      const out = await m.route.handler(ctx);
      if (out && typeof out === "object" && (out as Row).__redirect) {
        res.statusCode = 301;
        res.setHeader("Location", (out as Row).__redirect);
        res.end();
        return;
      }
      if (out && typeof out === "object" && (out as Row).__raw) {
        const o = out as Row;
        res.statusCode = 200;
        res.setHeader("Content-Type", o.mime);
        if (o.csp) res.setHeader("Content-Security-Policy", o.csp);
        for (const [k, v] of Object.entries((o.headers || {}) as Record<string, string>)) res.setHeader(k, v);
        res.setHeader("Content-Disposition", "inline");
        res.end(o.data);
        return;
      }
      if (Array.isArray(out)) sendJson(res, out[0], out[1]);
      else sendJson(res, 200, out ?? { ok: true });
    } catch (e) {
      if (e instanceof HttpError) {
        sendJson(res, e.status, { error: e.code });
      } else {
        // Never leak stack traces or SQL errors to the client.
        console.error(`[${ctx.requestId}]`, (e as Error).stack);
        sendJson(res, 500, { error: "internal_error", requestId: ctx.requestId });
      }
    }
  }

  // Photo upload needs a bigger body limit than the default 64 KB.
  for (const route of r.routes) if (route.re.source.includes("photo$")) route.maxBody = Math.ceil(cfg.maxPhotoBytes * 1.4) + 1024;
  // Hiring documents (MyKad photos, certificates) are up to 3 MB.
  for (const route of r.routes) if (route.method === "POST" && route.re.source.endsWith("/docs$")) route.maxBody = Math.ceil(cfg.maxDocBytes * 1.4) + 1024;
  // The live selfie sends three camera frames.
  for (const route of r.routes) if (route.method === "POST" && route.re.source.endsWith("/selfie$")) route.maxBody = Math.ceil(cfg.maxDocBytes * 3 * 1.4) + 4096;

  // Test helper: create a staff account directly (in real life an admin is created by the seed script).
  function createStaff(phone: string, name: string, role: (typeof ROLES)[number], perms: string | null = null): string {
    const id = newId();
    db.prepare("INSERT INTO users (id, phone_hash, phone_enc, name_enc, role, perms, created_at) VALUES (?,?,?,?,?,?,?)")
      .run(id, phoneHash(phone), enc(phone, `users|phone|${id}`), enc(name, `users|name|${id}`), role, perms, now());
    return id;
  }

  /** Creates a staff account, or updates the permissions of an existing one (dev start-up and seed script). */
  function ensureStaff(phone: string, name: string, role: (typeof ROLES)[number], perms: string | null): string {
    const u = db.prepare("SELECT id, role FROM users WHERE phone_hash = ?").get(phoneHash(phone)) as Row | undefined;
    if (!u) return createStaff(phone, name, role, perms);
    if (u.role !== role) throw new Error("this phone already has a different role");
    db.prepare("UPDATE users SET perms = ? WHERE id = ?").run(perms, u.id);
    return u.id;
  }

  return { handle, db, cfg, createStaff, ensureStaff, materialize, purgeApplicants: hiring.purgeApplicants };
}
