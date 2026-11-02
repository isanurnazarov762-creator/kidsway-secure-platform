// Runtime configuration. Every secret comes from the environment, never from source code.
import { randomBytes } from "node:crypto";

export type Config = {
  env: "development" | "test" | "production";
  port: number;
  host: string;
  dbPath: string;
  trustProxy: boolean;
  // 32-byte keys, base64. dataKeys maps key id -> key so old data stays readable after rotation.
  dataKeys: Record<string, Buffer>;
  dataKeyId: string;
  pepper: Buffer; // HMAC key for phone lookups, OTPs and handover codes
  urlSigningKey: Buffer; // HMAC key for short-lived photo links
  otpTtlSec: number;
  otpMaxAttempts: number;
  sessionIdleSec: number;
  sessionAbsoluteSec: number;
  handoverTtlSec: number;
  handoverMaxAttempts: number;
  photoUrlTtlSec: number;
  maxJsonBytes: number;
  maxPhotoBytes: number;
  maxDocBytes: number;
  vettingApprovals: number; // distinct officers who must approve a new Guardian (four-eyes principle)
  rejectedRetentionSec: number;
  verifierUrl: string | null; // internal AI verifier (verifier/), e.g. http://verifier:8000
  verifierKey: Buffer | null; // shared HMAC key for signing requests to it
  aiMaxAttempts: number;
  devOtpEcho: boolean; // returns OTP in the response, for local tests only
  insecureDemo: boolean; // turns OFF some defences so the attack scripts can show the difference
  securityLogFile: string | null;
  logToConsole: boolean;
  // Requests allowed per window. IP-based limits are set high in tests, where every request comes from 127.0.0.1.
  limits: { globalIpPerMin: number; otpRequestIpPer10Min: number; otpRequestPhonePer10Min: number; otpVerifyIpPer10Min: number };
};

function key(name: string, env: NodeJS.ProcessEnv, allowGenerate: boolean): Buffer {
  const v = env[name];
  if (v) {
    const b = Buffer.from(v, "base64");
    if (b.length !== 32) throw new Error(`${name} must be 32 bytes, base64 encoded`);
    return b;
  }
  if (!allowGenerate) throw new Error(`${name} is required in production`);
  return randomBytes(32); // dev/test only: a random key per run
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env, overrides: Partial<Config> = {}): Config {
  const mode = (env.NODE_ENV === "production" ? "production" : env.NODE_ENV === "test" ? "test" : "development") as Config["env"];
  const prod = mode === "production";

  const dataKeys: Record<string, Buffer> = {};
  if (env.DATA_KEYS) {
    // DATA_KEYS='{"k1":"base64...","k2":"base64..."}'
    const parsed = JSON.parse(env.DATA_KEYS) as Record<string, string>;
    for (const [id, b64] of Object.entries(parsed)) {
      const b = Buffer.from(b64, "base64");
      if (b.length !== 32) throw new Error(`DATA_KEYS.${id} must be 32 bytes`);
      dataKeys[id] = b;
    }
  } else {
    dataKeys.k1 = key("DATA_KEY", env, !prod);
  }
  const dataKeyId = env.DATA_KEY_ID || Object.keys(dataKeys)[0];
  if (!dataKeys[dataKeyId]) throw new Error("DATA_KEY_ID does not match any key");

  const cfg: Config = {
    env: mode,
    port: Number(env.PORT || 3000),
    host: env.HOST || "127.0.0.1",
    dbPath: env.DB_PATH || (mode === "test" ? ":memory:" : "./data/kidsway.db"),
    trustProxy: env.TRUST_PROXY === "1",
    dataKeys,
    dataKeyId,
    pepper: key("PEPPER", env, !prod),
    urlSigningKey: key("URL_SIGNING_KEY", env, !prod),
    otpTtlSec: 300,
    otpMaxAttempts: 5,
    sessionIdleSec: 30 * 60,
    sessionAbsoluteSec: 12 * 60 * 60,
    handoverTtlSec: Number(env.HANDOVER_TTL_SEC || 12 * 60 * 60),
    handoverMaxAttempts: 5,
    photoUrlTtlSec: 300,
    maxJsonBytes: 64 * 1024,
    maxPhotoBytes: 2 * 1024 * 1024,
    maxDocBytes: 3 * 1024 * 1024,
    vettingApprovals: Math.max(prod ? 2 : 1, Number(env.VETTING_APPROVALS || 2)),
    rejectedRetentionSec: 180 * 86400,
    verifierUrl: env.VERIFIER_URL || null,
    verifierKey: env.VERIFIER_KEY ? Buffer.from(env.VERIFIER_KEY, "base64") : null,
    aiMaxAttempts: 3,
    devOtpEcho: !prod && env.DEV_OTP_ECHO === "1",
    insecureDemo: env.INSECURE_DEMO === "1",
    securityLogFile: env.SECURITY_LOG_FILE || null,
    logToConsole: mode !== "test",
    // On one dev laptop every user (parent, escort, admin) comes from 127.0.0.1, so IP limits are relaxed there.
    limits: !prod && env.DEV_RELAX_IP_LIMITS === "1"
      ? { globalIpPerMin: 3000, otpRequestIpPer10Min: 200, otpRequestPhonePer10Min: 5, otpVerifyIpPer10Min: 400 }
      : { globalIpPerMin: 300, otpRequestIpPer10Min: 10, otpRequestPhonePer10Min: 3, otpVerifyIpPer10Min: 20 },
    ...overrides
  };
  if (cfg.verifierUrl && (!cfg.verifierKey || cfg.verifierKey.length < 32)) {
    throw new Error("VERIFIER_URL is set but VERIFIER_KEY is missing or shorter than 32 bytes");
  }
  if (prod && cfg.verifierUrl && !/^http:\/\/[a-z0-9.-]+:\d+$/.test(cfg.verifierUrl) && !cfg.verifierUrl.startsWith("https://")) {
    throw new Error("VERIFIER_URL must be an internal service address (http://name:port) or https://");
  }
  if (prod && (cfg.insecureDemo || cfg.devOtpEcho)) {
    throw new Error("INSECURE_DEMO and DEV_OTP_ECHO are not allowed in production");
  }
  return cfg;
}
