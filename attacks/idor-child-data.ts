// Scenario: Insecure Direct Object Reference (OWASP API Top 10 #1, BOLA).
// The attacker has their own normal parent account. They obtain another child's ID
// (from a shared screenshot, a log, a referral link) and ask the API for that record.
import { header, row, startTarget } from "./lib.ts";

header("IDOR on child records", "Read another family's child profile (medical notes) with your own valid account.");

for (const insecure of [true, false]) {
  const t = await startTarget(insecure);
  const victim = await t.tripInProgress();
  const attacker = await t.login();
  const r = await t.call("GET", `/api/children/${victim.childId}`, undefined, attacker.token);
  console.log(`\n  ${insecure ? "v0 (insecure): no ownership check" : "v1 (secure): ownership check, 404 for other families"}`);
  row("HTTP status", String(r.status));
  row("Data returned", r.status === 200 ? JSON.stringify({ name: r.body.name, medical: r.body.medical, dob: r.body.dob }) : JSON.stringify(r.body));
  row("Result", r.status === 200 ? "LEAKED another family's child data" : "BLOCKED");
  if (!insecure) {
    const a = t.app.db.prepare("SELECT action, outcome FROM audit_log WHERE action = 'child_read' AND outcome = 'denied'").all();
    row("Audit log", `${a.length} denied access attempt recorded`);
    row("Guessing IDs instead?", "IDs are 128-bit random values: 2^128 possibilities, enumeration is not practical");
  }
  await t.close();
}
