import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import type { Config } from "../src/config.ts";
import { createApp } from "../src/app.ts";

export type Api = Awaited<ReturnType<typeof startTestServer>>;

export async function startTestServer(overrides: Partial<Config> = {}) {
  const cfg = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv, { devOtpEcho: true, limits: { globalIpPerMin: 100000, otpRequestIpPer10Min: 100000, otpRequestPhonePer10Min: 3, otpVerifyIpPer10Min: 100000 }, ...overrides });
  const app = createApp(cfg);
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  async function call(method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const text = await res.text();
    let json: any = null;
    try { json = JSON.parse(text); } catch { json = text; }
    return { status: res.status, body: json, headers: res.headers };
  }

  let phoneSeq = 100000000;
  /** Sign up (or log in) with a phone number through the real OTP flow. */
  async function login(phone = `+60${++phoneSeq}`, name = "Parent") {
    const a = await call("POST", "/api/auth/otp/request", { phone });
    const b = await call("POST", "/api/auth/otp/verify", { phone, challengeId: a.body.challengeId, code: a.body.devCode, name });
    if (b.status !== 200) throw new Error("login failed " + JSON.stringify(b.body));
    return { token: b.body.token as string, userId: b.body.user.id as string, phone };
  }

  /** A parent with one child and one trip A -> B, assigned to an escort and started. */
  async function tripInProgress() {
    const parent = await login();
    const child = await call("POST", "/api/children", { name: "Child One", medical: "Peanut allergy", dob: "2018-03-12" }, parent.token);
    const trip = await call("POST", "/api/trips", {
      childIds: [child.body.id], service: "car", scheduledAt: Math.floor(Date.now() / 1000),
      stops: [{ address: "School, Bangsar" }, { address: "Swimming centre, Mont Kiara", receiver: { type: "trusted", name: "Grandma", phone: "+60131234567" } }]
    }, parent.token);
    const adminPhone = `+60${++phoneSeq}`;
    app.createStaff(adminPhone, "Admin", "admin");
    const admin = await login(adminPhone);
    const escortPhone = `+60${++phoneSeq}`;
    const esc = await call("POST", "/api/admin/escorts", { phone: escortPhone, name: "Escort" }, admin.token);
    const escort = await login(escortPhone);
    await call("POST", `/api/admin/trips/${trip.body.trip.id}/assign`, { escortId: esc.body.id }, admin.token);
    await call("POST", `/api/trips/${trip.body.trip.id}/start`, {}, escort.token);
    return { parent, admin, escort, childId: child.body.id as string, tripId: trip.body.trip.id as string, code: trip.body.handoverCodes[0].code as string };
  }

  async function close() {
    await new Promise<void>((r) => server.close(() => r()));
    app.db.close();
  }

  return { call, login, tripInProgress, close, app, base };
}

/** A tiny valid PNG (1x1 pixel). */
export const PNG_1PX = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
