// Scenario: a stranger at the school gate (or a rogue escort) tries to get a child handed
// over by guessing the handover code instead of knowing it.
import { header, row, startTarget } from "./lib.ts";

header("Handover code brute force", "Guess the receiver's code by trying every value until the API accepts one.");

for (const insecure of [true, false]) {
  const t = await startTarget(insecure);
  const s = await t.tripInProgress();
  const digits = insecure ? 4 : 6;
  const space = 10 ** digits;
  const started = Date.now();
  let tries = 0, cracked: string | null = null, stoppedBy = "";
  const errors: Record<string, number> = {};
  const BATCH = 50;
  outer: for (let start = 0; start < space; start += BATCH) {
    const guesses = Array.from({ length: Math.min(BATCH, space - start) }, (_, i) => String(start + i).padStart(digits, "0"));
    const results = await Promise.all(guesses.map((g) => t.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: g }, s.escort.token).then((r) => ({ g, r }))));
    for (const { g, r } of results) {
      tries++;
      if (r.status === 200) { cracked = g; break outer; }
      errors[r.body?.error] = (errors[r.body?.error] || 0) + 1;
      if (r.status === 423 || r.status === 429) { stoppedBy = r.body?.error; }
    }
    if (stoppedBy && tries >= 100) break;
  }
  const ms = Date.now() - started;
  console.log(`\n  ${insecure ? "v0 (insecure): 4-digit code, unlimited tries" : "v1 (secure): 6-digit code, locks after 5 tries, 10 checks/min"}`);
  row("Guesses sent", String(tries));
  row("Time", `${(ms / 1000).toFixed(1)} s`);
  row("Result", cracked ? `CRACKED, code ${cracked} accepted -> child handed to attacker` : "BLOCKED");
  if (!cracked) row("API answers", Object.entries(errors).map(([k, v]) => `${k} x${v}`).join(", "));
  if (!insecure) {
    const audit = t.app.db.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'handover_check' AND outcome = 'failed'").get() as any;
    row("Audit log entries", `${audit.n} failed handover checks recorded`);
    row("Chance to guess in 5 tries", `${(5 / space * 100).toFixed(4)} %`);
    const st = t.app.db.prepare("SELECT code_locked, handed_over_at FROM stops WHERE trip_id = ? AND seq = 1").get(s.tripId) as any;
    row("Stop B after the attack", st.code_locked ? "LOCKED, child not handed over; parent alerted, can re-issue a new code" : "not locked");
  }
  await t.close();
}
