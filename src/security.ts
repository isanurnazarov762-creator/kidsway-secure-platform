// Rate limiting, the audit log and security-event logging.
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { HttpError } from "./http.ts";
import type { Ctx } from "./http.ts";

/** Fixed-window counter in memory. One instance per rule. */
export class RateLimiter {
  limit: number;
  windowSec: number;
  hits = new Map<string, { n: number; reset: number }>();
  constructor(limit: number, windowSec: number) {
    this.limit = limit;
    this.windowSec = windowSec;
  }
  /** Returns true if the request is allowed. */
  take(key: string): boolean {
    const t = Date.now() / 1000;
    const e = this.hits.get(key);
    if (!e || e.reset <= t) {
      this.hits.set(key, { n: 1, reset: t + this.windowSec });
      if (this.hits.size > 50000) this.sweep(t);
      return true;
    }
    e.n++;
    return e.n <= this.limit;
  }
  sweep(t: number): void {
    for (const [k, v] of this.hits) if (v.reset <= t) this.hits.delete(k);
  }
}

export type Security = {
  log: (event: string, ctx: Ctx | null, fields?: Record<string, string | number>) => void;
  audit: (ctx: Ctx, action: string, target: [string, string] | null, outcome: "ok" | "denied" | "failed", detail?: string) => void;
  limit: (rl: RateLimiter, key: string, ctx: Ctx, what: string) => void;
};

export function makeSecurity(cfg: Config, db: DB): Security {
  if (cfg.securityLogFile) mkdirSync(dirname(cfg.securityLogFile), { recursive: true });
  const insertAudit = db.prepare(
    "INSERT INTO audit_log (at, actor_id, actor_role, action, target_type, target_id, ip, outcome, detail) VALUES (?,?,?,?,?,?,?,?,?)"
  );

  // One line per security event, in a fixed key=value format that fail2ban can parse.
  // Phone numbers, codes and tokens are never written to logs.
  function log(event: string, ctx: Ctx | null, fields: Record<string, string | number> = {}): void {
    const parts = [`kidsway_security`, `event=${event}`, `ip=${ctx ? ctx.ip : "-"}`];
    for (const [k, v] of Object.entries(fields)) parts.push(`${k}=${String(v).replace(/\s+/g, "_")}`);
    const line = new Date().toISOString() + " " + parts.join(" ");
    if (cfg.logToConsole) console.log(line);
    if (cfg.securityLogFile) appendFileSync(cfg.securityLogFile, line + "\n");
  }

  function audit(ctx: Ctx, action: string, target: [string, string] | null, outcome: "ok" | "denied" | "failed", detail = ""): void {
    insertAudit.run(now(), ctx.user?.id ?? null, ctx.user?.role ?? null, action, target?.[0] ?? null, target?.[1] ?? null, ctx.ip, outcome, detail.slice(0, 200));
  }

  function limit(rl: RateLimiter, key: string, ctx: Ctx, what: string): void {
    if (cfg.insecureDemo) return;
    if (!rl.take(key)) {
      log("rate_limited", ctx, { rule: what });
      throw new HttpError(429, "too_many_requests");
    }
  }

  return { log, audit, limit };
}
