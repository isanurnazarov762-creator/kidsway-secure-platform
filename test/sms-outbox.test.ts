import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, statSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { loadConfig } from "../src/config.ts";
import { createApp } from "../src/app.ts";
import { maskPhone } from "../src/sms.ts";

test("S1 lab SMS outbox: the code reaches the server-side file only, never the browser", async () => {
  const dir = mkdtempSync(join(tmpdir(), "kw-outbox-"));
  const file = join(dir, "sms.log");
  const old = { p: process.env.SMS_PROVIDER, f: process.env.SMS_OUTBOX_FILE };
  process.env.SMS_PROVIDER = "outbox"; process.env.SMS_OUTBOX_FILE = file;
  // Production-like: DEV_OTP_ECHO is off, so the response must not carry the code.
  const cfg = loadConfig({ NODE_ENV: "test" } as NodeJS.ProcessEnv, { devOtpEcho: false });
  const app = createApp(cfg);
  const server = createServer((req, res) => { void app.handle(req, res); });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const post = (path: string, body: unknown) => fetch(base + path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    const a = await post("/api/auth/otp/request", { phone: "+60123456789" });
    const ab = await a.json();
    assert.equal(a.status, 202);
    assert.equal(ab.devCode, undefined, "code must not be in the HTTP response");

    const text = readFileSync(file, "utf8");
    assert.match(text, /to=\+6012\*+6789 KidsWay code: \d{6}\./);
    assert.ok(!text.includes("+60123456789"), "full phone number must not be stored");
    if (process.platform !== "win32") assert.equal(statSync(file).mode & 0o777, 0o600, "only the owner may read the outbox");

    const code = /KidsWay code: (\d{6})/.exec(text)![1];
    const b = await post("/api/auth/otp/verify", { phone: "+60123456789", challengeId: ab.challengeId, code, name: "Lab Parent" });
    assert.equal(b.status, 200, "the code from the outbox logs in");
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    app.db.close();
    if (old.p === undefined) delete process.env.SMS_PROVIDER; else process.env.SMS_PROVIDER = old.p;
    if (old.f === undefined) delete process.env.SMS_OUTBOX_FILE; else process.env.SMS_OUTBOX_FILE = old.f;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("S2 phone numbers are masked in the outbox", () => {
  assert.equal(maskPhone("+60123456789"), "+6012***6789");
  assert.equal(maskPhone("+601"), "****");
});
