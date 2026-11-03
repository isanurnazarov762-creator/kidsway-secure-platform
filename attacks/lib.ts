// Shared helpers for the attack scripts.
// Each script starts two local copies of the API in this process:
//   "v0 (insecure)" = INSECURE_DEMO mode, the naive first design
//   "v1 (secure)"   = the real code
// and runs the same attack against both, so the effect of each defence is measurable.
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";

export type Target = Awaited<ReturnType<typeof startTarget>>;

export async function startTarget(insecure: boolean) {
  const cfg = loadConfig({ NODE_ENV: "development", DEV_OTP_ECHO: "1", INSECURE_DEMO: insecure ? "1" : "0", DB_PATH: ":memory:" } as NodeJS.ProcessEnv,
    { logToConsole: false, limits: { globalIpPerMin: 1_000_000, otpRequestIpPer10Min: 1000, otpRequestPhonePer10Min: 3, otpVerifyIpPer10Min: 1_000_000 } });
  const origLog = console.log;
  console.log = () => {}; // keep attack output readable
  const app = createApp(cfg);
  console.log = origLog;
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  let n = 200000000;

  async function call(method: string, path: string, body?: unknown, token?: string) {
    const res = await fetch(base + path, {
      method,
      headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    let json: any = null;
    try { json = await res.json(); } catch { /* not json */ }
    return { status: res.status, body: json };
  }
  async function login(phone = `+60${++n}`, app = "parent") {
    const a = await call("POST", "/api/auth/otp/request", { phone });
    const b = await call("POST", "/api/auth/otp/verify", { phone, challengeId: a.body.challengeId, code: a.body.devCode, app });
    return { token: b.body.token as string, phone };
  }
  async function tripInProgress() {
    const parent = await login();
    const child = await call("POST", "/api/children", { name: "Victim Child", medical: "Severe peanut allergy, EpiPen in bag", dob: "2018-03-12" }, parent.token);
    const trip = await call("POST", "/api/trips", {
      childIds: [child.body.id], service: "car", scheduledAt: Math.floor(Date.now() / 1000),
      stops: [{ address: "School, Bangsar" }, { address: "Swimming centre, Mont Kiara", receiver: { type: "trusted", name: "Grandma", phone: "+60131234567" } }]
    }, parent.token);
    const adminPhone = `+60${++n}`;
    app.createStaff(adminPhone, "Admin", "admin");
    const admin = await login(adminPhone, "control");
    const escortPhone = `+60${++n}`;
    const esc = await call("POST", "/api/admin/escorts", { phone: escortPhone, name: "Escort" }, admin.token);
    const escort = await login(escortPhone, "guardian");
    await call("POST", `/api/admin/trips/${trip.body.trip.id}/assign`, { escortId: esc.body.id }, admin.token);
    await call("POST", `/api/trips/${trip.body.trip.id}/start`, {}, escort.token);
    return { parent, escort, admin, childId: child.body.id as string, tripId: trip.body.trip.id as string, realCode: trip.body.handoverCodes[0].code as string };
  }
  async function close() { await new Promise<void>((r) => server.close(() => r())); app.db.close(); }
  return { call, login, tripInProgress, close, app, cfg, base, insecure };
}

export function header(title: string, what: string) {
  console.log("\n" + "=".repeat(78));
  console.log(" ATTACK: " + title);
  console.log(" " + what);
  console.log("=".repeat(78));
}

export function row(label: string, value: string) {
  console.log("  " + label.padEnd(28) + value);
}
