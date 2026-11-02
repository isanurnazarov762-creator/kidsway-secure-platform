// HIRING: people apply to become a KidsWay Guardian (the escort who travels with children),
// and vetting officers run the security checks before anyone gets an escort account.
//
// Security design (docs/threat-model.md, section "Hiring"):
// - Applicants prove their phone number by SMS and get a separate, limited "applicant" session.
// - Eligibility (women aged 20-55) is read from the MyKad number itself: date of birth and gender digit.
// - MyKad numbers are stored encrypted, plus an HMAC to find duplicates without keeping them readable.
// - Documents (MyKad photos, selfie, certificates) are checked by file signature, PDFs with active
//   content are refused, and every file is encrypted at rest. Officers open them through 5-minute signed links.
// - Mandatory checks: identity, e-DKK child sexual offender check (JKM), police record, references,
//   interview, first aid, training. Evidence is required where a document exists for the check.
// - Four-eyes principle: approval needs N different officers with the "vetting" permission.
// - e-DKK and police checks expire after a year; a failed re-check suspends the Guardian at once.
// - PDPA: an applicant can withdraw and erase everything; rejected applications are erased after 180 days.
import type { Config } from "./config.ts";
import type { DB } from "./db.ts";
import { now } from "./db.ts";
import { HttpError, Router } from "./http.ts";
import type { Ctx } from "./http.ts";
import type { RateLimiter, Security } from "./security.ts";
import { PHONE_RE, obj, oneOf, str } from "./validate.ts";
import { hmac, newId, newToken, randomDigits, safeEqual, sha256, signUrl, verifySignedUrl } from "./crypto.ts";
import { createHash, randomBytes } from "node:crypto";
import type { Verifier } from "./verifier.ts";

type Row = Record<string, any>;
const MY_OFFSET = 8 * 3600;
const DAY = 86400;
export const CONSENT_VERSION = "2026-11";

export const CHECKS = {
  identity: { label: "Identity: MyKad matches the selfie and the details", needs: ["ic_front", "ic_back", "selfie"], validDays: 0 },
  edkk: { label: "e-DKK child sexual offender check (JKM)", needs: ["edkk_result"], validDays: 365 },
  police: { label: "Police record / good conduct", needs: ["police_cert"], validDays: 365 },
  references: { label: "Two references contacted", needs: [], validDays: 0 },
  interview: { label: "In-person interview", needs: [], validDays: 0 },
  first_aid: { label: "First aid and CPR certificate", needs: ["first_aid_cert"], validDays: 730 },
  training: { label: "KidsWay training and a shadow trip", needs: [], validDays: 0 }
} as const;
type CheckName = keyof typeof CHECKS;
const CHECK_NAMES = Object.keys(CHECKS) as CheckName[];
const APPLICANT_DOCS = ["ic_front", "ic_back", "selfie", "first_aid_cert", "police_cert"] as const;
const OFFICER_DOCS = ["edkk_result", "police_cert", "first_aid_cert", "reference_notes", "interview_form", "other"] as const;
const REQUIRED_FROM_APPLICANT = ["ic_front", "ic_back", "selfie"];
const LANGS = ["ms", "en", "zh", "ta"] as const;
const WEEKDAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

/** Today in Malaysia as { y, m (1-12), d }. */
function myToday(t = now()) {
  const d = new Date((t + MY_OFFSET) * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, d: d.getUTCDate() };
}

/**
 * Reads a MyKad number: YYMMDD-PB-###G. The date is the date of birth; the last digit
 * is odd for men and even for women. Returns the facts the eligibility rule needs.
 */
export function parseMyKad(raw: string, t = now()): { ok: true; ic: string; birthYear: number; age: number; female: boolean } | { ok: false } {
  const ic = String(raw || "").replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(ic)) return { ok: false };
  const yy = Number(ic.slice(0, 2)), mm = Number(ic.slice(2, 4)), dd = Number(ic.slice(4, 6)), pb = Number(ic.slice(6, 8));
  const today = myToday(t);
  const year = yy <= today.y % 100 ? 2000 + yy : 1900 + yy;
  const date = new Date(Date.UTC(year, mm - 1, dd));
  if (mm < 1 || mm > 12 || date.getUTCMonth() !== mm - 1 || date.getUTCDate() !== dd || pb === 0) return { ok: false };
  const age = today.y - year - (today.m < mm || (today.m === mm && today.d < dd) ? 1 : 0);
  if (age < 0) return { ok: false };
  return { ok: true, ic, birthYear: year, age, female: Number(ic[11]) % 2 === 0 };
}
export const ELIGIBILITY = { minAge: 20, maxAge: 55 };

type Deps = {
  r: Router; db: DB; cfg: Config; sec: Security;
  enc: (v: string | null | undefined, aad: string) => string | null;
  dec: (v: string | null, aad: string) => string | null;
  phoneHash: (p: string) => string;
  requireUser: (ctx: Ctx, ...roles: Array<"parent" | "escort" | "admin">) => { id: string; role: string; sessionId: string };
  sendSms: (to: string, text: string) => Promise<boolean>;
  rl: { otpReqIp: RateLimiter; otpReqPhone: RateLimiter; otpVerifyIp: RateLimiter; apply: RateLimiter; docs: RateLimiter };
  verifier: Verifier | null;
};

export function registerHiring(d: Deps) {
  const { r, db, cfg, sec, enc, dec, phoneHash, requireUser } = d;

  const flagsOf = (a: Row): string[] => (a.flags ? String(a.flags).split(",").filter(Boolean) : []);
  function addFlag(id: string, flag: string) {
    const a = db.prepare("SELECT flags FROM applicants WHERE id = ?").get(id) as Row | undefined;
    if (!a) return;
    const f = new Set(flagsOf(a)); f.add(flag);
    db.prepare("UPDATE applicants SET flags = ?, updated_at = ? WHERE id = ?").run([...f].join(","), now(), id);
  }
  const dataOf = (a: Row) => JSON.parse(dec(a.data_enc, `applicants|data|${a.id}`) || "{}");

  function requireApplicant(ctx: Ctx) {
    if (!ctx.applicant) throw new HttpError(401, "unauthorized");
    return ctx.applicant;
  }
  /** Vetting needs an admin with the "vetting" permission: dispatchers cannot open MyKad documents. */
  function requireOfficer(ctx: Ctx) {
    const u = requireUser(ctx, "admin");
    const row = db.prepare("SELECT perms FROM users WHERE id = ?").get(u.id) as Row;
    if (!String(row.perms || "").split(",").includes("vetting")) {
      sec.audit(ctx, "vetting_access", null, "denied", "no vetting permission");
      throw new HttpError(403, "forbidden");
    }
    return u;
  }
  function applicantFor(ctx: Ctx, id: string): Row {
    const a = db.prepare("SELECT * FROM applicants WHERE id = ?").get(id) as Row | undefined;
    if (!a) throw new HttpError(404, "not_found");
    return a;
  }
  const ownApplication = (phoneHash: string) => db.prepare("SELECT * FROM applicants WHERE phone_hash = ? ORDER BY created_at DESC").get(phoneHash) as Row | undefined;

  // ---------------------------------------------------------------
  // Applicant sign-in: SMS code, then a limited applicant session
  // ---------------------------------------------------------------
  r.add("POST", "/api/careers/otp/request", async (ctx) => {
    const phone = str(obj(ctx.body), "phone", { max: 16, re: PHONE_RE })!;
    const ph = phoneHash(phone);
    sec.limit(d.rl.otpReqIp, ctx.ip, ctx, "otp_request_ip");
    sec.limit(d.rl.otpReqPhone, "apply|" + ph, ctx, "otp_request_phone");
    const id = newId(), code = randomDigits(6);
    db.prepare("INSERT INTO otp_challenges (id, phone_hash, code_hash, expires_at, created_at) VALUES (?,?,?,?,?)")
      .run(id, ph, hmac(cfg.pepper, `aotp|${id}|${code}`), now() + cfg.otpTtlSec, now());
    const sent = await d.sendSms(phone, `KidsWay Guardian application code: ${code}. Valid 5 minutes.`).catch(() => false);
    sec.log("otp_sent", ctx, { purpose: "apply", sms: sent ? "sent" : "none" });
    const res: Row = { status: "sent", challengeId: id, expiresIn: cfg.otpTtlSec };
    if (cfg.devOtpEcho) res.devCode = code;
    return [202, res];
  });

  r.add("POST", "/api/careers/otp/verify", (ctx) => {
    const b = obj(ctx.body);
    const challengeId = str(b, "challengeId", { max: 64, re: /^[A-Za-z0-9_-]+$/ })!;
    const code = str(b, "code", { max: 6, re: /^\d{6}$/ })!;
    const phone = str(b, "phone", { max: 16, re: PHONE_RE })!;
    sec.limit(d.rl.otpVerifyIp, ctx.ip, ctx, "otp_verify_ip");
    const ch = db.prepare("SELECT * FROM otp_challenges WHERE id = ?").get(challengeId) as Row | undefined;
    if (!ch || ch.consumed || ch.expires_at <= now() || ch.phone_hash !== phoneHash(phone)) {
      sec.log("auth_fail", ctx, { reason: "challenge_invalid", purpose: "apply" });
      throw new HttpError(400, "invalid_or_expired");
    }
    if (!safeEqual(hmac(cfg.pepper, `aotp|${challengeId}|${code}`), ch.code_hash)) {
      const attempts = ch.attempts + 1, burn = attempts >= cfg.otpMaxAttempts;
      db.prepare("UPDATE otp_challenges SET attempts = ?, consumed = ? WHERE id = ?").run(attempts, burn ? 1 : 0, challengeId);
      sec.log("auth_fail", ctx, { reason: burn ? "otp_locked" : "otp_wrong", purpose: "apply", attempts });
      throw new HttpError(400, burn ? "too_many_attempts" : "invalid_code");
    }
    db.prepare("UPDATE otp_challenges SET consumed = 1 WHERE id = ?").run(challengeId);
    const token = "ap_" + newToken();
    db.prepare("INSERT INTO applicant_sessions (id, phone_hash, token_hash, created_at, last_seen) VALUES (?,?,?,?,?)").run(newId(), ch.phone_hash, sha256(token), now(), now());
    return { token, expiresIn: cfg.sessionIdleSec };
  });

  // ---------------------------------------------------------------
  // The application
  // ---------------------------------------------------------------
  r.add("POST", "/api/careers/application", (ctx) => {
    const ap = requireApplicant(ctx);
    sec.limit(d.rl.apply, ctx.ip, ctx, "apply_ip");
    const b = obj(ctx.body);
    // Honeypot: a hidden field people never see. Bots fill it; they get a normal-looking answer and nothing is saved.
    if (typeof b.website === "string" && b.website.trim()) {
      sec.log("bot_blocked", ctx, { where: "apply" });
      return [201, { status: "submitted" }];
    }
    const prev = ownApplication(ap.phoneHash);
    if (prev) throw new HttpError(409, prev.status === "rejected" ? "reapply_later" : "already_applied");
    if (b.consent !== true) throw new HttpError(400, "consent_required");

    const name = str(b, "name", { min: 3, max: 80 })!;
    const icRaw = str(b, "ic", { max: 14, re: /^\d{6}-?\d{2}-?\d{4}$/ })!;
    const ic = parseMyKad(icRaw);
    if (!ic.ok) throw new HttpError(400, "invalid_ic");
    if (!ic.female || ic.age < ELIGIBILITY.minAge || ic.age > ELIGIBILITY.maxAge) {
      sec.log("apply_not_eligible", ctx);
      throw new HttpError(422, "not_eligible");
    }
    const email = str(b, "email", { max: 120, re: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/, optional: true }) ?? null;
    const area = str(b, "area", { max: 80 })!;
    const experience = str(b, "experience", { max: 800, optional: true }) ?? "";
    const langs = Array.isArray(b.languages) ? [...new Set(b.languages)].filter((x): x is string => (LANGS as readonly unknown[]).includes(x)) : [];
    const days = Array.isArray(b.days) ? [...new Set(b.days)].filter((x): x is string => (WEEKDAYS as readonly unknown[]).includes(x)) : [];
    if (!langs.length) throw new HttpError(400, "invalid_languages");
    if (!days.length) throw new HttpError(400, "invalid_days");
    const transport = oneOf(b, "transport", ["none", "motorcycle", "car"] as const);
    if (!Array.isArray(b.references) || b.references.length !== 2) throw new HttpError(400, "invalid_references");
    const refs = b.references.map((x: unknown) => {
      const o = obj(x);
      return { name: str(o, "name", { min: 3, max: 80 })!, phone: str(o, "phone", { max: 16, re: PHONE_RE })!, relation: str(o, "relation", { max: 60 })! };
    });
    const refHashes = refs.map((x: Row) => phoneHash(x.phone));
    if (refHashes[0] === refHashes[1] || refHashes.includes(ap.phoneHash)) throw new HttpError(400, "invalid_references");

    const id = newId();
    const icHash = hmac(cfg.pepper, "mykad|" + ic.ic);
    const flags: string[] = [];
    // A second application with the same MyKad from another phone is a fraud signal. The applicant gets the
    // normal answer (so MyKad numbers cannot be probed through this form); the officer sees the flag.
    if (db.prepare("SELECT 1 FROM applicants WHERE ic_hash = ?").get(icHash)) flags.push("duplicate_ic");
    if (db.prepare("SELECT 1 FROM users WHERE phone_hash = ?").get(ap.phoneHash)) flags.push("phone_has_account");
    const phone = String(b.phone || "");
    const phoneOk = PHONE_RE.test(phone) && phoneHash(phone) === ap.phoneHash;
    if (!phoneOk) throw new HttpError(400, "invalid_phone"); // the form repeats the verified number; it must match the session
    // Biometric data is sensitive personal data under the PDPA: a separate, optional consent.
    // Without it the identity check is done by an officer only.
    const biometricConsent = b.biometricConsent === true;
    const data = { name, email, area, experience, languages: langs, days, transport, references: refs, biometricConsent };
    db.prepare("INSERT INTO applicants (id, phone_hash, phone_enc, ic_hash, ic_enc, data_enc, birth_year, status, flags, consent_at, consent_ver, created_at, updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(id, ap.phoneHash, enc(phone, `applicants|phone|${id}`), icHash, enc(ic.ic, `applicants|ic|${id}`), enc(JSON.stringify(data), `applicants|data|${id}`),
        ic.birthYear, "submitted", flags.join(","), now(), CONSENT_VERSION, now(), now());
    sec.log("application_submitted", ctx, { flags: flags.join("+") || "none" });
    return [201, { status: "submitted" }];
  });

  r.add("GET", "/api/careers/application", (ctx) => {
    const ap = requireApplicant(ctx);
    const a = ownApplication(ap.phoneHash);
    if (!a) return { status: "none" };
    const docs = db.prepare("SELECT kind, created_at FROM applicant_docs WHERE applicant_id = ? AND uploaded_by = 'applicant' ORDER BY created_at").all(a.id) as Row[];
    const passed = new Set((db.prepare("SELECT check_name FROM applicant_checks WHERE applicant_id = ? AND result = 'pass'").all(a.id) as Row[]).map((c) => c.check_name));
    const data = dataOf(a);
    return {
      status: a.status, name: data.name, createdAt: a.created_at,
      docs: docs.map((x) => ({ kind: x.kind, uploadedAt: x.created_at })),
      missingDocs: REQUIRED_FROM_APPLICANT.filter((k) => !docs.some((x) => x.kind === k)),
      // The applicant sees what is done, never an officer's notes or a failed result before the decision.
      steps: CHECK_NAMES.map((c) => ({ check: c, label: CHECKS[c].label, done: passed.has(c) })),
      // Only the outcome, never the scores: exact scores would help someone tune a fake.
      ai: aiSummary(a, data)
    };
  });

  /** Checks an uploaded file by its real signature and size. Returns the bytes. */
  function checkFile(mimeIn: unknown, dataIn: unknown, ctx: Ctx, allowed: readonly string[] = ["image/jpeg", "image/png", "application/pdf"]) {
    const mime = oneOf({ mime: mimeIn }, "mime", allowed);
    const buf = typeof dataIn === "string" ? Buffer.from(dataIn, "base64") : Buffer.alloc(0);
    if (buf.length < 8 || buf.length > cfg.maxDocBytes) throw new HttpError(400, "invalid_document");
    const isJpeg = buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
    const isPng = buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
    const isPdf = buf.subarray(0, 5).toString("latin1") === "%PDF-";
    if ((mime === "image/jpeg" && !isJpeg) || (mime === "image/png" && !isPng) || (mime === "application/pdf" && !isPdf)) {
      sec.log("upload_rejected", ctx, { reason: "signature_mismatch", where: "hiring" });
      throw new HttpError(400, "invalid_document");
    }
    // PDFs can carry scripts, launch actions and attached files. An officer's PC must never run them.
    if (isPdf && /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA)\b/.test(buf.toString("latin1"))) {
      sec.log("upload_rejected", ctx, { reason: "pdf_active_content", where: "hiring" });
      throw new HttpError(400, "pdf_active_content");
    }
    return { mime, buf };
  }

  function storeDoc(applicantId: string, kind: string, mimeIn: unknown, dataIn: unknown, by: "applicant" | "officer", ctx: Ctx) {
    const { mime, buf } = checkFile(mimeIn, dataIn, ctx);
    const digest = createHash("sha256").update(buf).digest("hex");
    if (db.prepare("SELECT 1 FROM applicant_docs WHERE sha256 = ? AND applicant_id != ?").get(digest, applicantId)) addFlag(applicantId, "doc_reused");
    const id = newId();
    db.prepare("INSERT INTO applicant_docs (id, applicant_id, kind, mime, sha256, size, data_enc, uploaded_by, created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, applicantId, kind, mime, digest, buf.length, enc(buf.toString("base64"), `applicant_docs|data|${id}`), by, now());
    db.prepare("UPDATE applicants SET updated_at = ? WHERE id = ?").run(now(), applicantId);
    return id;
  }

  r.add("POST", "/api/careers/application/docs", (ctx) => {
    const ap = requireApplicant(ctx);
    const a = ownApplication(ap.phoneHash);
    if (!a) throw new HttpError(404, "not_found");
    if (!["submitted", "in_review"].includes(a.status)) throw new HttpError(409, "application_closed");
    sec.limit(d.rl.docs, a.id, ctx, "doc_upload");
    const b = obj(ctx.body);
    const kind = oneOf(b, "kind", APPLICANT_DOCS);
    if ((db.prepare("SELECT COUNT(*) AS n FROM applicant_docs WHERE applicant_id = ?").get(a.id) as Row).n >= 15) throw new HttpError(409, "too_many_documents");
    storeDoc(a.id, kind, b.mime, b.data, "applicant", ctx);
    return [201, { ok: true }];
  });

  // PDPA: the applicant can withdraw at any time and everything is erased, documents included.
  r.add("POST", "/api/careers/application/withdraw", (ctx) => {
    const ap = requireApplicant(ctx);
    const a = ownApplication(ap.phoneHash);
    if (!a) throw new HttpError(404, "not_found");
    if (a.status === "approved") throw new HttpError(409, "already_approved_contact_us");
    db.prepare("DELETE FROM applicants WHERE id = ?").run(a.id);
    db.prepare("UPDATE applicant_sessions SET revoked = 1 WHERE phone_hash = ?").run(ap.phoneHash);
    sec.log("application_withdrawn", ctx);
    return { ok: true, erased: true };
  });


  // ---------------------------------------------------------------
  // AI identity check (verifier/): live selfie, MyKad text, face match
  // ---------------------------------------------------------------
  const LIVE_STEPS = ["straight", "left", "right"] as const;
  const challenges = new Map<string, { phoneHash: string; steps: string[]; exp: number }>();
  const aiRow = (id: string) => db.prepare("SELECT * FROM applicant_ai WHERE applicant_id = ?").get(id) as Row | undefined;
  function ensureAiRow(id: string) {
    db.prepare("INSERT OR IGNORE INTO applicant_ai (applicant_id, updated_at) VALUES (?, ?)").run(id, now());
    return aiRow(id)!;
  }
  function aiSummary(a: Row, data: Row) {
    const row = aiRow(a.id);
    return {
      available: !!d.verifier && !!data.biometricConsent,
      consent: !!data.biometricConsent,
      liveSelfie: !!row?.live_doc_id,
      verdict: row?.verdict ?? null,
      attemptsLeft: Math.max(0, cfg.aiMaxAttempts - (row?.attempts ?? 0))
    };
  }
  function aiReport(id: string) {
    const row = aiRow(id);
    if (!row) return null;
    return {
      verdict: row.verdict, attempts: row.attempts, liveOk: row.live_ok === null ? null : !!row.live_ok,
      liveness: row.live_enc ? JSON.parse(dec(row.live_enc, `applicant_ai|live|${id}`)!) : null,
      identity: row.result_enc ? JSON.parse(dec(row.result_enc, `applicant_ai|result|${id}`)!) : null,
      at: row.updated_at
    };
  }
  function openOwnApplication(ctx: Ctx) {
    const ap = requireApplicant(ctx);
    const a = ownApplication(ap.phoneHash);
    if (!a) throw new HttpError(404, "not_found");
    if (!["submitted", "in_review"].includes(a.status)) throw new HttpError(409, "application_closed");
    return { ap, a, data: dataOf(a) };
  }

  // A random order of prompts, valid once and for 3 minutes: a pre-recorded video cannot know it.
  r.add("GET", "/api/careers/liveness", (ctx) => {
    const { ap, data } = openOwnApplication(ctx);
    if (!data.biometricConsent) throw new HttpError(403, "biometric_consent_required");
    const turns = randomBytes(1)[0] % 2 ? ["left", "right"] : ["right", "left"];
    const steps = ["straight", ...turns];
    const id = newId();
    for (const [k, v] of challenges) if (v.exp < now()) challenges.delete(k);
    challenges.set(id, { phoneHash: ap.phoneHash, steps, exp: now() + 180 });
    return { challengeId: id, steps, expiresIn: 180 };
  });

  r.add("POST", "/api/careers/application/selfie", async (ctx) => {
    const { ap, a, data } = openOwnApplication(ctx);
    if (!data.biometricConsent) throw new HttpError(403, "biometric_consent_required");
    sec.limit(d.rl.docs, a.id, ctx, "selfie_upload");
    const b = obj(ctx.body);
    const challengeId = str(b, "challengeId", { max: 64, re: /^[A-Za-z0-9_-]+$/ })!;
    const ch = challenges.get(challengeId);
    challenges.delete(challengeId); // one use only, success or not
    if (!ch || ch.exp < now() || ch.phoneHash !== ap.phoneHash) {
      sec.log("liveness_challenge_invalid", ctx);
      throw new HttpError(400, "challenge_invalid");
    }
    if (!Array.isArray(b.frames) || b.frames.length !== 3) throw new HttpError(400, "invalid_frames");
    const frames = b.frames.map((x: unknown, i: number) => {
      const f = obj(x);
      if (f.step !== ch.steps[i]) throw new HttpError(400, "frames_out_of_order");
      checkFile(f.mime, f.data, ctx, ["image/jpeg"]);
      return { step: f.step as (typeof LIVE_STEPS)[number], data: f.data as string };
    });
    // Only the straight-ahead frame is kept (as the selfie). The head-turn frames are never stored.
    const straight = frames.find((f: { step: string }) => f.step === "straight")!;
    const docId = storeDoc(a.id, "selfie", "image/jpeg", straight.data, "applicant", ctx);
    ensureAiRow(a.id);
    let liveOk: boolean | null = null;
    if (d.verifier) {
      try {
        const res = await d.verifier.liveness(frames);
        liveOk = !!res.ok;
        db.prepare("UPDATE applicant_ai SET live_enc = ? WHERE applicant_id = ?").run(enc(JSON.stringify({ score: res.score, reasons: res.reasons }), `applicant_ai|live|${a.id}`), a.id);
      } catch {
        sec.log("verifier_unavailable", ctx, { what: "liveness" });
      }
    }
    db.prepare("UPDATE applicant_ai SET live_doc_id = ?, live_ok = ?, verdict = NULL, updated_at = ? WHERE applicant_id = ?").run(docId, liveOk === null ? null : liveOk ? 1 : 0, now(), a.id);
    sec.log("liveness_checked", ctx, { ok: liveOk === null ? "unknown" : String(liveOk) });
    return { ok: liveOk };
  });

  r.add("POST", "/api/careers/application/ai-check", async (ctx) => {
    const { a, data } = openOwnApplication(ctx);
    if (!data.biometricConsent) throw new HttpError(403, "biometric_consent_required");
    const row = ensureAiRow(a.id);
    if (!row.live_doc_id) throw new HttpError(409, "live_selfie_required");
    if (row.attempts >= cfg.aiMaxAttempts) throw new HttpError(409, "ai_attempts_used");
    const icDoc = db.prepare("SELECT * FROM applicant_docs WHERE applicant_id = ? AND kind = 'ic_front' ORDER BY created_at DESC LIMIT 1").get(a.id) as Row | undefined;
    if (!icDoc) throw new HttpError(409, "ic_front_required");
    const selfie = db.prepare("SELECT * FROM applicant_docs WHERE id = ?").get(row.live_doc_id) as Row;
    if (!["image/jpeg", "image/png"].includes(icDoc.mime)) throw new HttpError(409, "ic_front_must_be_a_photo");
    const attempts = row.attempts + 1;
    let report: Row;
    if (!d.verifier) report = { verdict: "review", faceScore: null, ocr: null, reasons: ["verifier:not_configured"] };
    else {
      try {
        report = await d.verifier.identity(
          dec(icDoc.data_enc, `applicant_docs|data|${icDoc.id}`)!, dec(selfie.data_enc, `applicant_docs|data|${selfie.id}`)!,
          { ic: dec(a.ic_enc, `applicants|ic|${a.id}`)!, name: data.name });
      } catch {
        sec.log("verifier_unavailable", ctx, { what: "identity" });
        report = { verdict: "review", faceScore: null, ocr: null, reasons: ["verifier:unavailable"] };
      }
    }
    let verdict: string = report.verdict;
    if (row.live_ok === 0 && verdict !== "retake_ic") { verdict = "retake_selfie"; report.reasons = [...(report.reasons || []), "liveness:failed"]; }
    // AI never rejects anyone: after the last attempt anything unclear goes to an officer.
    if (verdict.startsWith("retake") && attempts >= cfg.aiMaxAttempts) verdict = "review";
    db.prepare("UPDATE applicant_ai SET attempts = ?, verdict = ?, result_enc = ?, updated_at = ? WHERE applicant_id = ?")
      .run(attempts, verdict, enc(JSON.stringify({ ...report, verdict }), `applicant_ai|result|${a.id}`), now(), a.id);
    if (verdict === "retake_selfie") db.prepare("UPDATE applicant_ai SET live_doc_id = NULL, live_ok = NULL WHERE applicant_id = ?").run(a.id);
    if (verdict !== "pass") addFlag(a.id, verdict === "review" ? "ai_review" : "ai_retake");
    sec.log("ai_check", ctx, { verdict, attempt: attempts });
    return { verdict, attemptsLeft: Math.max(0, cfg.aiMaxAttempts - attempts) };
  });

  // ---------------------------------------------------------------
  // Vetting officers
  // ---------------------------------------------------------------
  function checksOf(id: string) {
    return db.prepare("SELECT * FROM applicant_checks WHERE applicant_id = ?").all(id) as Row[];
  }
  function recheckDue(id: string, t = now()) {
    return checksOf(id).some((c) => c.valid_until && c.valid_until < t + 30 * DAY);
  }
  const age = (birthYear: number) => myToday().y - birthYear;

  r.add("GET", "/api/admin/applicants", (ctx) => {
    requireOfficer(ctx);
    const view = ctx.url.searchParams.get("view") || "open";
    const where = view === "approved" ? "status = 'approved'" : view === "rejected" ? "status = 'rejected'" : view === "due" ? "status = 'approved'" : "status IN ('submitted','in_review')";
    let rows = db.prepare(`SELECT * FROM applicants WHERE ${where} ORDER BY created_at DESC LIMIT 300`).all() as Row[];
    if (view === "due") rows = rows.filter((a) => recheckDue(a.id));
    return {
      applicants: rows.map((a) => {
        const data = dataOf(a);
        const checks = checksOf(a.id);
        return {
          id: a.id, name: data.name, age: age(a.birth_year), area: data.area, status: a.status, flags: flagsOf(a), createdAt: a.created_at,
          checksPassed: checks.filter((c) => c.result === "pass").length, checksFailed: checks.filter((c) => c.result === "fail").length, checksTotal: CHECK_NAMES.length,
          docs: (db.prepare("SELECT COUNT(*) AS n FROM applicant_docs WHERE applicant_id = ?").get(a.id) as Row).n,
          approvals: (db.prepare("SELECT COUNT(*) AS n FROM applicant_approvals WHERE applicant_id = ?").get(a.id) as Row).n,
          recheckDue: a.status === "approved" && recheckDue(a.id)
        };
      }),
      approvalsNeeded: cfg.vettingApprovals
    };
  });

  r.add("GET", "/api/admin/applicants/:id", (ctx) => {
    const u = requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    sec.audit(ctx, "applicant_read", ["applicant", a.id], "ok"); // every look at a file is recorded
    const data = dataOf(a);
    const officerName = (id: string) => {
      const o = db.prepare("SELECT name_enc FROM users WHERE id = ?").get(id) as Row | undefined;
      return o ? dec(o.name_enc, `users|name|${id}`) : "removed";
    };
    const checks = checksOf(a.id);
    const docs = db.prepare("SELECT id, kind, mime, size, uploaded_by, created_at FROM applicant_docs WHERE applicant_id = ? ORDER BY created_at").all(a.id) as Row[];
    const approvals = db.prepare("SELECT officer_id, at FROM applicant_approvals WHERE applicant_id = ?").all(a.id) as Row[];
    return {
      id: a.id, status: a.status, flags: flagsOf(a), createdAt: a.created_at, decidedAt: a.decided_at, consentAt: a.consent_at, consentVersion: a.consent_ver,
      ic: dec(a.ic_enc, `applicants|ic|${a.id}`), age: age(a.birth_year), phone: dec(a.phone_enc, `applicants|phone|${a.id}`), ...data,
      docs: docs.map((x) => ({ id: x.id, kind: x.kind, mime: x.mime, size: x.size, by: x.uploaded_by, at: x.created_at })),
      checks: CHECK_NAMES.map((c) => {
        const row = checks.find((x) => x.check_name === c);
        return {
          check: c, label: CHECKS[c].label, needs: CHECKS[c].needs, result: row ? row.result : null,
          note: row ? dec(row.note_enc, `applicant_checks|note|${a.id}|${c}`) : null,
          by: row ? officerName(row.officer_id) : null, at: row ? row.checked_at : null, validUntil: row ? row.valid_until : null
        };
      }),
      approvals: approvals.map((x) => ({ by: officerName(x.officer_id), me: x.officer_id === u.id, at: x.at })),
      approvalsNeeded: cfg.vettingApprovals,
      ai: aiReport(a.id)
    };
  });

  r.add("POST", "/api/admin/applicants/:id/docs", (ctx) => {
    requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    const b = obj(ctx.body);
    const kind = oneOf(b, "kind", OFFICER_DOCS);
    const id = storeDoc(a.id, kind, b.mime, b.data, "officer", ctx);
    sec.audit(ctx, "applicant_doc_upload", ["applicant", a.id], "ok", kind);
    return [201, { id }];
  });

  r.add("GET", "/api/admin/applicants/:id/docs/:docId/link", (ctx) => {
    requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    const doc = db.prepare("SELECT id, kind FROM applicant_docs WHERE id = ? AND applicant_id = ?").get(ctx.params.docId, a.id) as Row | undefined;
    if (!doc) throw new HttpError(404, "not_found");
    sec.audit(ctx, "applicant_doc_view", ["applicant", a.id], "ok", doc.kind);
    return { url: signUrl(cfg, `/media/docs/${doc.id}`, cfg.photoUrlTtlSec), expiresIn: cfg.photoUrlTtlSec };
  });

  r.add("GET", "/media/docs/:id", (ctx) => {
    const path = `/media/docs/${ctx.params.id}`;
    if (!verifySignedUrl(cfg, path, ctx.url.searchParams.get("exp"), ctx.url.searchParams.get("sig"))) {
      sec.log("signed_url_rejected", ctx, { what: "applicant_doc" });
      throw new HttpError(403, "link_invalid_or_expired");
    }
    const doc = db.prepare("SELECT * FROM applicant_docs WHERE id = ?").get(ctx.params.id) as Row | undefined;
    if (!doc) throw new HttpError(404, "not_found");
    const data = Buffer.from(dec(doc.data_enc, `applicant_docs|data|${doc.id}`)!, "base64");
    // Served in a sandbox: even a crafted file cannot run script on our origin. PDFs download instead of opening.
    return { __raw: true, mime: doc.mime, data, csp: "sandbox; default-src 'none'; img-src 'self'; style-src 'unsafe-inline'", headers: doc.mime === "application/pdf" ? { "Content-Disposition": `attachment; filename="${doc.kind}.pdf"` } : {} };
  });

  r.add("POST", "/api/admin/applicants/:id/checks", (ctx) => {
    const u = requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    if (a.status === "rejected") throw new HttpError(409, "application_closed");
    const b = obj(ctx.body);
    const check = oneOf(b, "check", CHECK_NAMES);
    const result = oneOf(b, "result", ["pass", "fail"] as const);
    const note = str(b, "note", { max: 500, optional: true }) ?? null;
    if (result === "pass") {
      // A pass needs the evidence on file: an officer cannot tick e-DKK without the JKM result.
      const kinds = new Set((db.prepare("SELECT kind FROM applicant_docs WHERE applicant_id = ?").all(a.id) as Row[]).map((x) => x.kind));
      const missing = CHECKS[check].needs.filter((k) => !kinds.has(k));
      if (missing.length) throw new HttpError(409, "evidence_missing:" + missing.join(","));
      // An officer may overrule the AI, but must write down why (accountability, audit).
      const ai = db.prepare("SELECT verdict FROM applicant_ai WHERE applicant_id = ?").get(a.id) as Row | undefined;
      if (check === "identity" && ai && ai.verdict && ai.verdict !== "pass" && !note) throw new HttpError(409, "note_required_ai_disagrees");
    }
    const valid = CHECKS[check].validDays ? now() + CHECKS[check].validDays * DAY : null;
    db.prepare(`INSERT INTO applicant_checks (applicant_id, check_name, result, note_enc, officer_id, checked_at, valid_until) VALUES (?,?,?,?,?,?,?)
      ON CONFLICT(applicant_id, check_name) DO UPDATE SET result = excluded.result, note_enc = excluded.note_enc, officer_id = excluded.officer_id, checked_at = excluded.checked_at, valid_until = excluded.valid_until`)
      .run(a.id, check, result, enc(note, `applicant_checks|note|${a.id}|${check}`), u.id, now(), valid);
    if (a.status === "submitted") db.prepare("UPDATE applicants SET status = 'in_review' WHERE id = ?").run(a.id);
    // Approvals were given on the old evidence: any change before the decision means approving again.
    if (a.status !== "approved") db.prepare("DELETE FROM applicant_approvals WHERE applicant_id = ?").run(a.id);
    db.prepare("UPDATE applicants SET updated_at = ? WHERE id = ?").run(now(), a.id);
    sec.audit(ctx, "vetting_check", ["applicant", a.id], result === "pass" ? "ok" : "failed", check);
    // A Guardian who fails a re-check (e.g. the yearly e-DKK) loses access immediately.
    let suspended = false;
    if (a.status === "approved" && result === "fail" && a.user_id) { suspendGuardian(a.user_id, ctx, check); suspended = true; }
    return { ok: true, suspended };
  });

  function suspendGuardian(userId: string, ctx: Ctx, reason: string) {
    db.prepare("UPDATE users SET perms = 'suspended' WHERE id = ?").run(userId);
    db.prepare("UPDATE sessions SET revoked = 1 WHERE user_id = ?").run(userId);
    const moved = db.prepare("UPDATE trips SET escort_id = NULL, status = 'requested' WHERE escort_id = ? AND status = 'assigned'").run(userId);
    db.prepare("UPDATE plans SET escort_id = NULL WHERE escort_id = ?").run(userId);
    sec.audit(ctx, "guardian_suspended", ["user", userId], "ok", `failed=${reason} trips_unassigned=${moved.changes}`);
    sec.log("guardian_suspended", ctx);
  }

  function allChecksPassed(id: string) {
    const rows = checksOf(id);
    return CHECK_NAMES.every((c) => rows.some((x) => x.check_name === c && x.result === "pass" && (!x.valid_until || x.valid_until > now())));
  }

  r.add("POST", "/api/admin/applicants/:id/approve", (ctx) => {
    const u = requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    if (a.status === "approved" || a.status === "rejected") throw new HttpError(409, "already_decided");
    if (!allChecksPassed(a.id)) throw new HttpError(409, "checks_incomplete");
    if (db.prepare("SELECT 1 FROM applicant_approvals WHERE applicant_id = ? AND officer_id = ?").get(a.id, u.id)) throw new HttpError(409, "already_approved_by_you");
    db.prepare("INSERT INTO applicant_approvals (applicant_id, officer_id, at) VALUES (?,?,?)").run(a.id, u.id, now());
    const n = (db.prepare("SELECT COUNT(*) AS c FROM applicant_approvals WHERE applicant_id = ?").get(a.id) as Row).c as number;
    sec.audit(ctx, "vetting_approve", ["applicant", a.id], "ok", `approval ${n}/${cfg.vettingApprovals}`);
    if (n < cfg.vettingApprovals) return { ok: true, approvals: n, needed: cfg.vettingApprovals, approved: false };

    // Final approval: the Guardian gets an escort account on the phone number she verified.
    const phone = dec(a.phone_enc, `applicants|phone|${a.id}`)!;
    if (db.prepare("SELECT 1 FROM users WHERE phone_hash = ?").get(a.phone_hash)) throw new HttpError(409, "phone_in_use");
    const userId = newId();
    const data = dataOf(a);
    db.prepare("INSERT INTO users (id, phone_hash, phone_enc, name_enc, role, created_at) VALUES (?,?,?,?,?,?)")
      .run(userId, a.phone_hash, enc(phone, `users|phone|${userId}`), enc(data.name, `users|name|${userId}`), "escort", now());
    db.prepare("UPDATE applicants SET status = 'approved', user_id = ?, decided_at = ?, updated_at = ? WHERE id = ?").run(userId, now(), now(), a.id);
    sec.audit(ctx, "guardian_created", ["user", userId], "ok", "applicant=" + a.id);
    return { ok: true, approvals: n, needed: cfg.vettingApprovals, approved: true, escortId: userId };
  });

  r.add("POST", "/api/admin/applicants/:id/reject", (ctx) => {
    requireOfficer(ctx);
    const a = applicantFor(ctx, ctx.params.id);
    if (a.status === "approved" || a.status === "rejected") throw new HttpError(409, "already_decided");
    const reason = str(obj(ctx.body), "reason", { max: 300 })!;
    const data = { ...dataOf(a), rejectReason: reason };
    db.prepare("UPDATE applicants SET status = 'rejected', data_enc = ?, decided_at = ?, retain_until = ?, updated_at = ? WHERE id = ?")
      .run(enc(JSON.stringify(data), `applicants|data|${a.id}`), now(), now() + cfg.rejectedRetentionSec, now(), a.id);
    db.prepare("DELETE FROM applicant_approvals WHERE applicant_id = ?").run(a.id);
    sec.audit(ctx, "vetting_reject", ["applicant", a.id], "ok");
    return { ok: true };
  });

  /** Retention: erase rejected applications after their retention time, and old applicant sessions. */
  function purgeApplicants(t = now()): number {
    const r1 = db.prepare("DELETE FROM applicants WHERE status = 'rejected' AND retain_until < ?").run(t);
    db.prepare("DELETE FROM applicant_sessions WHERE created_at < ?").run(t - cfg.sessionAbsoluteSec);
    return Number(r1.changes);
  }

  // Resolves "Bearer ap_..." tokens to an applicant session (used by the request pipeline).
  const findApplicantSession = db.prepare("SELECT * FROM applicant_sessions WHERE token_hash = ?");
  function resolveApplicant(token: string): { phoneHash: string; sessionId: string } | null {
    const s = findApplicantSession.get(sha256(token)) as Row | undefined;
    const t = now();
    if (!s || s.revoked || t - s.last_seen > cfg.sessionIdleSec || t - s.created_at > cfg.sessionAbsoluteSec) return null;
    db.prepare("UPDATE applicant_sessions SET last_seen = ? WHERE id = ?").run(t, s.id);
    return { phoneHash: s.phone_hash, sessionId: s.id };
  }

  return { purgeApplicants, resolveApplicant };
}
