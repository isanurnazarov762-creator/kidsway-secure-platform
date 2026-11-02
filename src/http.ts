// A small, explicit HTTP layer on top of node:http: routing, body limits,
// security headers and safe error handling. No framework, so every behaviour is visible.
import type { IncomingMessage, ServerResponse } from "node:http";
import type { Config } from "./config.ts";

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message?: string) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

export type Ctx = {
  req: IncomingMessage;
  res: ServerResponse;
  url: URL;
  ip: string;
  params: Record<string, string>;
  body: unknown;
  rawBody: Buffer | null;
  user: { id: string; role: "parent" | "escort" | "admin"; sessionId: string } | null;
  requestId: string;
};

export type Handler = (ctx: Ctx) => Promise<unknown> | unknown;
type Route = { method: string; re: RegExp; keys: string[]; handler: Handler; maxBody: number };

export class Router {
  routes: Route[] = [];
  add(method: string, pattern: string, handler: Handler, maxBody = 0): void {
    const keys: string[] = [];
    const re = new RegExp("^" + pattern.replace(/:([a-zA-Z]+)/g, (_, k) => { keys.push(k); return "([A-Za-z0-9_-]{1,64})"; }) + "$");
    this.routes.push({ method, re, keys, handler, maxBody });
  }
  match(method: string, path: string): { route: Route; params: Record<string, string> } | "method" | null {
    let pathMatched = false;
    for (const r of this.routes) {
      const m = r.re.exec(path);
      if (!m) continue;
      pathMatched = true;
      if (r.method !== method) continue;
      const params: Record<string, string> = {};
      r.keys.forEach((k, i) => { params[k] = m[i + 1]; });
      return { route: r, params };
    }
    return pathMatched ? "method" : null;
  }
}

export function securityHeaders(res: ServerResponse): void {
  res.setHeader("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), camera=(), microphone=()");
  res.setHeader("Cache-Control", "no-store");
}

export function clientIp(cfg: Config, req: IncomingMessage): string {
  // Only trust X-Forwarded-For when we sit behind our own reverse proxy (nginx).
  // Otherwise an attacker could fake their IP and dodge rate limits.
  if (cfg.trustProxy) {
    const xff = req.headers["x-forwarded-for"];
    const first = (Array.isArray(xff) ? xff[0] : xff || "").split(",")[0].trim();
    if (first) return first;
  }
  return req.socket.remoteAddress || "unknown";
}

export async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const declared = Number(req.headers["content-length"] || 0);
  if (declared > limit) throw new HttpError(413, "payload_too_large");
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new HttpError(413, "payload_too_large");
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, data: unknown): void {
  const body = JSON.stringify(data);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Content-Length", Buffer.byteLength(body));
  res.end(body);
}
