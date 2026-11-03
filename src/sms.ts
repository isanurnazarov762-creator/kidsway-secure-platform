// Sending SMS. With no provider configured, nothing is sent (development: the code is shown on screen instead).
// Twilio is supported through its REST API with plain fetch, so no SDK package is needed.
// Set SMS_PROVIDER=twilio, TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN and TWILIO_FROM.
// Note: not tested against a live Twilio account in this repository.
//
// Lab outbox (SMS_PROVIDER=outbox, SMS_OUTBOX_FILE=/outbox/sms.log): a stand-in for a real SMS gateway on the
// lab server. Messages are appended to a file that only the server's administrator can read (mode 0600, a
// folder outside the web root), never to the HTTP response, the app logs or the security log. So the code
// still travels "out of band", like a real SMS: whoever controls the browser cannot see it.

import { appendFileSync, chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";

/** +60123456789 -> +6012***6789: enough to tell messages apart, not a full phone number in the file. */
export function maskPhone(p: string): string {
  return p.length <= 8 ? "****" : p.slice(0, 5) + "*".repeat(p.length - 9) + p.slice(-4);
}

export type SmsSender = (to: string, text: string) => Promise<boolean>;

export function makeSmsSender(env: NodeJS.ProcessEnv = process.env): SmsSender {
  if (env.SMS_PROVIDER === "twilio") {
    const sid = env.TWILIO_ACCOUNT_SID || "", token = env.TWILIO_AUTH_TOKEN || "", from = env.TWILIO_FROM || "";
    if (!/^AC[0-9a-f]{32}$/.test(sid) || !token || !from) throw new Error("Twilio is selected but TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN or TWILIO_FROM is missing");
    return async (to, text) => {
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`, {
        method: "POST",
        headers: { authorization: "Basic " + Buffer.from(`${sid}:${token}`).toString("base64"), "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ To: to, From: from, Body: text }),
        signal: AbortSignal.timeout(8000)
      });
      return res.ok;
    };
  }
  if (env.SMS_PROVIDER === "outbox") {
    const file = env.SMS_OUTBOX_FILE || "";
    if (!file.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(file) && !file.startsWith("./")) throw new Error("SMS_PROVIDER=outbox needs SMS_OUTBOX_FILE (a path outside the web root)");
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    appendFileSync(file, "", { mode: 0o600 });
    try { chmodSync(file, 0o600); } catch { /* not the owner: keep the existing mode */ }
    console.warn("SMS outbox mode: login codes are written to SMS_OUTBOX_FILE. Lab use only, not for real users.");
    return async (to, text) => {
      const line = `${new Date().toISOString()} to=${maskPhone(to)} ${text.replace(/[\r\n]+/g, " ")}\n`;
      appendFileSync(file, line, { mode: 0o600 });
      return true;
    };
  }
  return async () => false; // no provider: the caller decides what to do (dev shows the code on screen)
}
