// The public demo (NODE_ENV=demo, see docs/demo.md): codes on screen are allowed there and only there.
import { test } from "node:test";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config.ts";

test("D1 demo mode shows codes on screen but refuses real SMS and the insecure attack mode; production never shows codes", () => {
  const demo = loadConfig({ NODE_ENV: "demo" } as NodeJS.ProcessEnv);
  assert.equal(demo.publicDemo, true);
  assert.equal(demo.devOtpEcho, true);
  assert.throws(() => loadConfig({ NODE_ENV: "demo", SMS_PROVIDER: "twilio" } as NodeJS.ProcessEnv), /test data only/);
  assert.throws(() => loadConfig({ NODE_ENV: "demo", INSECURE_DEMO: "1" } as NodeJS.ProcessEnv), /test data only/);
  const k = Buffer.alloc(32, 1).toString("base64");
  // In production DEV_OTP_ECHO is ignored: the code is never put in a response.
  assert.equal(loadConfig({ NODE_ENV: "production", DATA_KEY: k, PEPPER: k, URL_SIGNING_KEY: k, DEV_OTP_ECHO: "1" } as NodeJS.ProcessEnv).devOtpEcho, false);
  assert.equal(loadConfig({ NODE_ENV: "production", DATA_KEY: k, PEPPER: k, URL_SIGNING_KEY: k } as NodeJS.ProcessEnv).publicDemo, false);
});
