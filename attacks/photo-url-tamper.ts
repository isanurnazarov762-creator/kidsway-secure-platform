// Scenario: a handover photo link is forwarded or leaked. The attacker tries to keep it
// alive longer, or to reuse its signature for another child's photo.
import { header, row, startTarget } from "./lib.ts";
import { PNG_1PX } from "../test/helpers.ts";

header("Signed photo link tampering", "Extend, forge or reuse the short-lived link to a child's handover photo.");

const t = await startTarget(false);
const s = await t.tripInProgress();
await t.call("POST", `/api/trips/${s.tripId}/stops/1/handover`, { code: s.realCode }, s.escort.token);
await t.call("POST", `/api/trips/${s.tripId}/stops/1/photo`, { mime: "image/png", data: PNG_1PX }, s.escort.token);
const link = await t.call("GET", `/api/trips/${s.tripId}/stops/1/photo-url`, undefined, s.parent.token);
const url = new URL(t.base + link.body.url);

const tries: Array<[string, URL]> = [];
tries.push(["Original link", new URL(url)]);
const longer = new URL(url); longer.searchParams.set("exp", String(Number(url.searchParams.get("exp")) + 86400 * 365)); tries.push(["Expiry +1 year", longer]);
const forged = new URL(url); forged.searchParams.set("sig", "A".repeat(43)); tries.push(["Forged signature", forged]);
const other = new URL(url); other.pathname = "/media/photos/AAAAAAAAAAAAAAAAAAAAAA"; tries.push(["Same sig, other photo", other]);
const nosig = new URL(url); nosig.search = ""; tries.push(["No signature at all", nosig]);

console.log("\n  v1 (secure): HMAC-SHA256 signature over path + expiry, 5-minute lifetime");
for (const [label, u] of tries) {
  const r = await fetch(u);
  row(label, `HTTP ${r.status}${r.status === 200 ? " (photo served)" : " (refused)"}`);
}
await t.close();
