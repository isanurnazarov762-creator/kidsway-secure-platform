// Minimal TCP connect scanner, for checking the firewall from outside.
// Usage: TARGET=192.168.56.10 npm run scan:ports
// Expected on the hardened server: only 443 (and 80, which only redirects) are open.
// For the real report also run nmap from your Windows host:  nmap -sS -sV -p- 192.168.56.10
import { Socket } from "node:net";

const host = process.env.TARGET || "127.0.0.1";
const ports = [21, 22, 23, 25, 53, 80, 110, 143, 443, 445, 3000, 3306, 3389, 5432, 6379, 8080, 8443, 9200, 27017];

function probe(port: number): Promise<"open" | "closed" | "filtered"> {
  return new Promise((resolve) => {
    const s = new Socket();
    const done = (r: "open" | "closed" | "filtered") => { s.destroy(); resolve(r); };
    s.setTimeout(1500);
    s.once("connect", () => done("open"));
    s.once("timeout", () => done("filtered"));
    s.once("error", (e: NodeJS.ErrnoException) => done(e.code === "ECONNREFUSED" ? "closed" : "filtered"));
    s.connect(port, host);
  });
}

console.log(`Scanning ${host} (${ports.length} common ports)...`);
const results = await Promise.all(ports.map(async (p) => [p, await probe(p)] as const));
for (const [p, r] of results) if (r === "open") console.log(`  ${String(p).padEnd(6)} OPEN`);
const open = results.filter(([, r]) => r === "open").map(([p]) => p);
console.log(`Open: ${open.join(", ") || "none"} | closed: ${results.filter(([, r]) => r === "closed").length} | filtered (dropped by firewall): ${results.filter(([, r]) => r === "filtered").length}`);
