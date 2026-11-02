// Strict input validation: allow-lists, lengths and types. Anything unexpected is rejected.
import { HttpError } from "./http.ts";

type Obj = Record<string, unknown>;

export function obj(v: unknown): Obj {
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new HttpError(400, "invalid_body");
  return v as Obj;
}

export function str(o: Obj, k: string, opts: { min?: number; max: number; re?: RegExp; optional?: boolean }): string | undefined {
  const v = o[k];
  if (v === undefined || v === null || v === "") {
    if (opts.optional) return undefined;
    throw new HttpError(400, "invalid_" + k);
  }
  if (typeof v !== "string") throw new HttpError(400, "invalid_" + k);
  const s = v.trim();
  if (s.length < (opts.min ?? 1) || s.length > opts.max) throw new HttpError(400, "invalid_" + k);
  if (opts.re && !opts.re.test(s)) throw new HttpError(400, "invalid_" + k);
  // Reject control characters (log injection, header tricks)
  if (/[\u0000-\u001f\u007f]/.test(s)) throw new HttpError(400, "invalid_" + k);
  return s;
}

export function num(o: Obj, k: string, min: number, max: number): number {
  const v = o[k];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, "invalid_" + k);
  return v;
}

export function oneOf<T extends string>(o: Obj, k: string, allowed: readonly T[]): T {
  const v = o[k];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) throw new HttpError(400, "invalid_" + k);
  return v as T;
}

/** Malaysian mobile numbers in E.164: +60 followed by 9-10 digits. */
export const PHONE_RE = /^\+60\d{9,10}$/;
export const CODE6_RE = /^\d{6}$/;

export function int(o: Obj, k: string, min: number, max: number): number {
  const v = num(o, k, min, max);
  if (!Number.isInteger(v)) throw new HttpError(400, "invalid_" + k);
  return v;
}
