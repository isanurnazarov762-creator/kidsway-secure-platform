// Client for the internal AI verifier (verifier/server.py).
// Every request is signed: X-KW-Signature = HMAC-SHA256(VERIFIER_KEY, timestamp + "." + body).
// The verifier refuses unsigned, old (more than 60 s) and replayed requests.
import { createHmac } from "node:crypto";
import type { Config } from "./config.ts";

export type Frame = { step: "straight" | "left" | "right"; data: string };
export type LivenessResult = { ok: boolean; score: number; reasons: string[] };
export type IdentityResult = {
  verdict: "pass" | "retake_ic" | "retake_selfie" | "review";
  faceScore: number | null;
  ocr: { icFound: boolean; icMatch: boolean; nameScore: number; nameMatch: boolean } | null;
  ocrEngine: string;
  reasons: string[];
};
export type Verifier = {
  liveness: (frames: Frame[]) => Promise<LivenessResult>;
  identity: (icFront: string, selfie: string, expected: { ic: string; name: string }) => Promise<IdentityResult>;
};

export function makeVerifier(cfg: Config): Verifier | null {
  if (!cfg.verifierUrl || !cfg.verifierKey) return null;
  const base = cfg.verifierUrl.replace(/\/$/, "");
  const key = cfg.verifierKey;
  async function post<T>(path: string, payload: unknown): Promise<T> {
    const body = JSON.stringify(payload);
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = createHmac("sha256", key).update(ts + "." + body).digest("hex");
    const res = await fetch(base + path, {
      method: "POST",
      headers: { "content-type": "application/json", "x-kw-timestamp": ts, "x-kw-signature": sig },
      body,
      signal: AbortSignal.timeout(25000),
      redirect: "error"
    });
    if (!res.ok) throw new Error(`verifier ${res.status}`);
    return (await res.json()) as T;
  }
  return {
    liveness: (frames) => post<LivenessResult>("/v1/liveness", { frames }),
    identity: (icFront, selfie, expected) => post<IdentityResult>("/v1/verify", { icFront, selfie, expected })
  };
}
