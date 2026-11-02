// All cryptography lives here so it can be reviewed in one place.
// Only Node's built-in, OpenSSL-backed primitives are used. No home-made algorithms.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import type { Config } from "./config.ts";

export function newId(): string {
  return randomBytes(16).toString("base64url");
}

/** 256-bit random token, URL safe. Used for sessions. */
export function newToken(): string {
  return randomBytes(32).toString("base64url");
}

export function sha256(s: string): string {
  return createHash("sha256").update(s).digest("base64url");
}

export function hmac(key: Buffer, s: string): string {
  return createHmac("sha256", key).update(s).digest("base64url");
}

/** Constant-time comparison, so response timing does not leak how many characters matched. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a), bb = Buffer.from(b);
  if (ab.length !== bb.length) {
    timingSafeEqual(ab, ab); // keep timing similar
    return false;
  }
  return timingSafeEqual(ab, bb);
}

/** n random decimal digits from a CSPRNG (crypto.randomInt, never Math.random). */
export function randomDigits(n: number): string {
  let s = "";
  for (let i = 0; i < n; i++) s += String(randomInt(0, 10));
  return s;
}

/**
 * AES-256-GCM field encryption.
 * Format: v1.<keyId>.<iv>.<tag>.<ciphertext> (base64url parts).
 * AAD binds the ciphertext to its table, column and row, so an attacker with
 * database write access cannot copy one child's encrypted allergies onto another row.
 */
export function encryptField(cfg: Config, plaintext: string, aad: string): string {
  const iv = randomBytes(12);
  const kid = cfg.dataKeyId;
  const c = createCipheriv("aes-256-gcm", cfg.dataKeys[kid], iv);
  c.setAAD(Buffer.from(aad));
  const ct = Buffer.concat([c.update(plaintext, "utf8"), c.final()]);
  const tag = c.getAuthTag();
  return ["v1", kid, iv.toString("base64url"), tag.toString("base64url"), ct.toString("base64url")].join(".");
}

export function decryptField(cfg: Config, blob: string | null, aad: string): string | null {
  if (blob == null) return null;
  const [v, kid, ivB, tagB, ctB] = blob.split(".");
  if (v !== "v1" || !cfg.dataKeys[kid]) throw new Error("Unknown ciphertext format or key");
  const d = createDecipheriv("aes-256-gcm", cfg.dataKeys[kid], Buffer.from(ivB, "base64url"));
  d.setAAD(Buffer.from(aad));
  d.setAuthTag(Buffer.from(tagB, "base64url"));
  return Buffer.concat([d.update(Buffer.from(ctB, "base64url")), d.final()]).toString("utf8");
}

/** Signed, expiring link: /media/photos/<id>?exp=<unix>&sig=<hmac>. */
export function signUrl(cfg: Config, path: string, ttlSec: number, now = Date.now()): string {
  const exp = Math.floor(now / 1000) + ttlSec;
  const sig = hmac(cfg.urlSigningKey, `${path}|${exp}`);
  return `${path}?exp=${exp}&sig=${sig}`;
}

export function verifySignedUrl(cfg: Config, path: string, exp: string | null, sig: string | null, now = Date.now()): boolean {
  if (!exp || !sig || !/^\d+$/.test(exp)) return false;
  if (Number(exp) < Math.floor(now / 1000)) return false;
  return safeEqual(hmac(cfg.urlSigningKey, `${path}|${exp}`), sig);
}
