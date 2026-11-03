// KidsWay Guardian application portal.
// Security notes: text is inserted with textContent only (no innerHTML), the applicant token lives in
// sessionStorage for this tab, and the page's CSP allows scripts and styles from this server only.
"use strict";

const $portal = document.getElementById("portal");
const $toast = document.getElementById("toast");
const A = {
  token: read("kw_ap_token"),
  phone: read("kw_ap_phone") || "+60",
  step: "phone", challengeId: null, devCode: null, code: "",
  form: { name: "", ic: "", email: "", area: "", experience: "", languages: ["ms"], days: ["mon", "tue", "wed", "thu", "fri"], transport: "none", consent: false, biometricConsent: false, website: "",
    references: [{ name: "", phone: "+60", relation: "" }, { name: "", phone: "+60", relation: "" }] }
};
function read(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function write(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* blocked */ } }

function h(tag, attrs, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith("on") && typeof v === "function") el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === "class") el.className = v;
    else if (k === "value") el.value = v;
    else if (k === "checked") el.checked = !!v;
    else el.setAttribute(k, v === true ? "" : String(v));
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  return el;
}
class ApiError extends Error { constructor(s, c) { super(c); this.status = s; this.code = c; } }
async function api(method, path, body) {
  const res = await fetch(path, { method, headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(A.token ? { authorization: "Bearer " + A.token } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && A.token) { A.token = null; write("kw_ap_token", null); A.step = "phone"; render(); throw new ApiError(401, "session_expired"); }
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "error");
  return data;
}
const MESSAGES = {
  invalid_phone: "Enter your Malaysian mobile number like +60123456789.",
  invalid_code: "Wrong code. Check the SMS and try again.",
  too_many_attempts: "Too many wrong codes. Request a new SMS code.",
  invalid_or_expired: "This code has expired. Request a new one.",
  too_many_requests: "Too many attempts. Please wait a few minutes.",
  session_expired: "Your session ended. Confirm your phone again.",
  invalid_ic: "Check your MyKad number (12 digits, e.g. 960514-10-5678).",
  not_eligible: "Sorry, this role is open to women aged 20 to 55. Your MyKad number does not match these requirements.",
  consent_required: "Please tick the consent box to continue.",
  invalid_references: "Add two different references, not your own number.",
  invalid_languages: "Choose at least one language.",
  invalid_days: "Choose at least one day.",
  invalid_area: "Fill in the area where you live.",
  invalid_name: "Fill in your full name as on your MyKad.",
  invalid_email: "Check your email address, or leave it empty.",
  already_applied: "You have already applied with this phone number.",
  reapply_later: "Your previous application was not successful. You can apply again later.",
  invalid_document: "Only real JPG, PNG or PDF files up to 3 MB.",
  pdf_active_content: "This PDF contains scripts or attachments. Please save it again as a plain PDF or send a photo.",
  too_many_documents: "Too many files. Contact us if you need to replace a document.",
  application_closed: "This application is closed.",
  biometric_consent_required: "The automatic check needs your consent to compare your face. Without it, an officer checks your MyKad by hand.",
  live_selfie_required: "Do the selfie check first.",
  ic_front_required: "Upload the front of your MyKad first.",
  ic_front_must_be_a_photo: "Upload the front of your MyKad as a photo (JPG or PNG), not a PDF.",
  ai_attempts_used: "You have used all 3 automatic checks. An officer will check your identity by hand.",
  challenge_invalid: "The selfie check expired. Please start it again.",
  frames_out_of_order: "The selfie check went wrong. Please start it again."
};
const msg = (e) => MESSAGES[e.code] || "Something went wrong (" + e.code + ").";
function toast(text, err) { $toast.textContent = text; $toast.className = "toast" + (err ? " err" : ""); $toast.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => { $toast.hidden = true; }, 4500); }
async function run(fn, btn) { if (btn) btn.disabled = true; try { await fn(); } catch (e) { toast(e instanceof ApiError ? msg(e) : String(e.message || e), true); } finally { if (btn && btn.isConnected) btn.disabled = false; } }

// MyKad: YYMMDD-PB-###G. Shown as a hint only; the server makes the real decision.
function mykadHint(raw) {
  const ic = raw.replace(/[\s-]/g, "");
  if (!/^\d{12}$/.test(ic)) return null;
  const now = new Date(), yy = +ic.slice(0, 2), mm = +ic.slice(2, 4), dd = +ic.slice(4, 6);
  const year = yy <= now.getFullYear() % 100 ? 2000 + yy : 1900 + yy;
  const d = new Date(year, mm - 1, dd);
  if (d.getMonth() !== mm - 1 || d.getDate() !== dd) return { bad: "This date of birth is not valid." };
  const age = now.getFullYear() - year - (now < new Date(now.getFullYear(), mm - 1, dd) ? 1 : 0);
  const female = +ic[11] % 2 === 0;
  if (!female || age < 20 || age > 55) return { bad: "This role is open to women aged 20 to 55." };
  return { ok: `Age ${age}` };
}

async function render() {
  let el;
  try {
    if (A.token) {
      const app = await api("GET", "/api/careers/application");
      el = app.status === "none" ? formView() : statusView(app);
    } else el = A.step === "code" ? codeView() : phoneView();
  } catch (e) { el = h("p", { class: "muted" }, e instanceof ApiError ? msg(e) : "Could not load. Refresh the page."); }
  $portal.replaceChildren(el);
}

function phoneView() {
  const btn = h("button", { class: "btn block", type: "submit" }, "Send SMS code");
  return h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
    const r = await api("POST", "/api/careers/otp/request", { phone: A.phone });
    A.challengeId = r.challengeId; A.devCode = r.devCode || null; A.step = "code"; write("kw_ap_phone", A.phone); render();
  }, btn); } },
    h("p", null, "First, confirm your mobile number. You can come back to this page any time to follow your application."),
    h("label", null, "Mobile number", h("input", { type: "tel", value: A.phone, autocomplete: "tel", oninput: (e) => { A.phone = e.target.value.trim(); } })), btn);
}
function codeView() {
  const btn = h("button", { class: "btn block", type: "submit" }, "Confirm");
  return h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
    const r = await api("POST", "/api/careers/otp/verify", { phone: A.phone, challengeId: A.challengeId, code: A.code });
    A.token = r.token; write("kw_ap_token", r.token); render();
  }, btn); } },
    A.devCode ? h("div", { class: "sms" }, h("small", null, "SMS simulator · development only"), h("p", null, "Your code is ", h("b", null, A.devCode))) : null,
    h("p", null, "Code sent to ", h("b", null, A.phone), "."),
    h("label", null, "SMS code", h("input", { class: "code-input", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", oninput: (e) => { A.code = e.target.value.trim(); } })), btn,
    h("button", { type: "button", class: "link", onclick: () => { A.step = "phone"; render(); } }, "Change number"));
}

function chips(list, selected, onToggle) {
  return h("div", { class: "chips" }, list.map(([v, label]) => {
    const on = selected.includes(v);
    return h("button", { type: "button", class: "chip plain" + (on ? " on" : ""), "aria-pressed": String(on), onclick: () => onToggle(v) }, label);
  }));
}
function formView() {
  const F = A.form;
  const re = () => $portal.replaceChildren(formView());
  const field = (label, key, attrs, tag) => h("label", null, label, h(tag || "input", { ...attrs, value: F[key], oninput: (e) => { F[key] = e.target.value; if (key === "ic") hint(); } }));
  const icHint = h("small", { class: "muted", "aria-live": "polite" });
  const hint = () => { const r = mykadHint(F.ic); icHint.textContent = r ? (r.bad || r.ok) : "12 digits. Your age and eligibility are read from it."; icHint.className = r && r.bad ? "bad-text" : "muted"; };
  hint();
  const btn = h("button", { class: "btn block big", type: "submit" }, "Send application");
  const toggle = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v]);
  return h("form", { class: "stack", onsubmit: (e) => { e.preventDefault(); run(async () => {
    await api("POST", "/api/careers/application", { ...F, phone: A.phone, email: F.email || undefined, experience: F.experience || undefined });
    toast("Application sent. Now add your documents."); render();
  }, btn); } },
    h("section", { class: "card" }, h("h2", null, "About you"),
      field("Full name (as on MyKad)", "name", { type: "text", maxlength: "80", autocomplete: "name", required: true }),
      h("label", null, "MyKad number", h("input", { type: "text", inputmode: "numeric", maxlength: "14", placeholder: "960514-10-5678", value: F.ic, autocomplete: "off", oninput: (e) => { F.ic = e.target.value.trim(); hint(); } }), icHint),
      h("label", null, "Mobile (confirmed)", h("input", { type: "tel", value: A.phone, readonly: true })),
      field("Email (optional)", "email", { type: "email", maxlength: "120", autocomplete: "email" }),
      field("Area where you live", "area", { type: "text", maxlength: "80", placeholder: "e.g. Petaling Jaya" })),
    h("section", { class: "card" }, h("h2", null, "Work"),
      h("label", null, "Languages"), chips([["ms", "Bahasa Malaysia"], ["en", "English"], ["zh", "中文"], ["ta", "தமிழ்"]], F.languages, (v) => { F.languages = toggle(F.languages, v); re(); }),
      h("label", null, "Days you can work"), chips([["mon", "Mon"], ["tue", "Tue"], ["wed", "Wed"], ["thu", "Thu"], ["fri", "Fri"], ["sat", "Sat"], ["sun", "Sun"]], F.days, (v) => { F.days = toggle(F.days, v); re(); }),
      h("label", null, "Your own transport"),
      h("div", { class: "seg" }, [["none", "None"], ["motorcycle", "Motorcycle"], ["car", "Car"]].map(([v, t]) => h("button", { type: "button", class: F.transport === v ? "on" : "", onclick: () => { F.transport = v; re(); } }, t))),
      field("Experience with children", "experience", { rows: "3", maxlength: "800", placeholder: "Where, how long, ages of the children" }, "textarea")),
    h("section", { class: "card" }, h("h2", null, "Two references"), h("p", { class: "muted" }, "Not family members. We will call them."),
      F.references.map((ref, i) => h("div", { class: "ref" }, h("b", null, "Reference " + (i + 1)),
        h("label", null, "Name", h("input", { type: "text", maxlength: "80", value: ref.name, oninput: (e) => { ref.name = e.target.value; } })),
        h("div", { class: "grid2" },
          h("label", null, "Phone", h("input", { type: "tel", value: ref.phone, oninput: (e) => { ref.phone = e.target.value.trim(); } })),
          h("label", null, "Relation", h("input", { type: "text", maxlength: "60", value: ref.relation, placeholder: "e.g. former employer", oninput: (e) => { ref.relation = e.target.value; } })))))),
    // Honeypot: invisible to people, tempting to bots. If it is filled in, nothing is saved.
    h("label", { class: "visually-hidden", "aria-hidden": "true" }, "Website", h("input", { type: "text", tabindex: "-1", autocomplete: "off", value: "", oninput: (e) => { F.website = e.target.value; } })),
    h("section", { class: "card" },
      h("label", { class: "check-line" }, h("input", { type: "checkbox", checked: F.consent, onchange: (e) => { F.consent = e.target.checked; } }),
        h("span", null, "I agree that KidsWay uses my details and documents to check my suitability to work with children, including an e-DKK check through JKM, a police record check and calls to my references. I can withdraw at any time and my data will be erased.")),
      h("label", { class: "check-line" }, h("input", { type: "checkbox", checked: F.biometricConsent, onchange: (e) => { F.biometricConsent = e.target.checked; } }),
        h("span", null, h("b", null, "Optional, faster: "), "I agree that my selfie is compared with my MyKad photo by an automatic check. The face data is used only for this comparison and deleted right after; only the result is kept. If you do not agree, an officer checks your MyKad by hand.")),
      btn));
}

const DOCS = [["ic_front", "MyKad: front", true], ["ic_back", "MyKad: back", true], ["selfie", "Selfie holding your MyKad", true], ["first_aid_cert", "First aid certificate", false], ["police_cert", "Police / good conduct letter", false]];
// Photos are resized on the phone (also removes camera metadata such as GPS). PDFs are sent as they are.
async function fileData(file) {
  if (file.type === "application/pdf") {
    if (file.size > 3 * 1024 * 1024) throw new Error("The PDF is larger than 3 MB.");
    const b = new Uint8Array(await file.arrayBuffer());
    let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
    return { mime: "application/pdf", data: btoa(s) };
  }
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 2000 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  const url = c.toDataURL("image/jpeg", 0.86);
  return { mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) };
}

// ---------- live selfie check: follow 3 prompts in a random order chosen by the server ----------
const PROMPTS = { straight: "Look straight at the camera", left: "Slowly turn your head to your left", right: "Slowly turn your head to your right" };
async function selfieCheck() {
  const ch = await api("GET", "/api/careers/liveness");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 1280 }, height: { ideal: 720 } }, audio: false });
  } catch {
    throw new Error("We could not open the camera. Allow camera access for this page, or upload a selfie instead (an officer will check it).");
  }
  const video = h("video", { autoplay: true, muted: true, playsinline: true, class: "cam-video" });
  video.srcObject = stream;
  const prompt = h("p", { class: "cam-prompt", "aria-live": "assertive" }, "Get ready…");
  const count = h("p", { class: "cam-count", "aria-hidden": "true" });
  const dots = h("div", { class: "cam-dots" }, ch.steps.map(() => h("i")));
  let cancelled = false;
  const ov = h("div", { class: "cam-ov", role: "dialog", "aria-modal": "true", "aria-label": "Selfie check" },
    h("div", { class: "cam-frame" }, video, h("div", { class: "cam-oval", "aria-hidden": "true" }), count),
    prompt, dots, h("p", { class: "cam-note" }, "Hold your MyKad next to your face. Good light, no mask, no sunglasses."),
    h("button", { class: "btn ghost small", onclick: () => { cancelled = true; } }, "Cancel"));
  document.body.append(ov);
  const stop = () => { stream.getTracks().forEach((t) => t.stop()); ov.remove(); };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  try {
    await new Promise((r) => { if (video.readyState >= 2) r(); else video.onloadeddata = r; });
    const frames = [];
    for (let i = 0; i < ch.steps.length; i++) {
      const step = ch.steps[i];
      prompt.textContent = PROMPTS[step];
      for (const n of [3, 2, 1]) { if (cancelled) throw new Error("Selfie check cancelled."); count.textContent = String(n); await wait(900); }
      count.textContent = "";
      // The frame is taken from the camera as it is (not mirrored like the preview).
      const scale = Math.min(1, 1280 / Math.max(video.videoWidth, video.videoHeight));
      const c = document.createElement("canvas");
      c.width = Math.round(video.videoWidth * scale); c.height = Math.round(video.videoHeight * scale);
      c.getContext("2d").drawImage(video, 0, 0, c.width, c.height);
      const url = c.toDataURL("image/jpeg", 0.85);
      frames.push({ step, mime: "image/jpeg", data: url.slice(url.indexOf(",") + 1) });
      dots.children[i].className = "on";
    }
    prompt.textContent = "Checking…";
    const res = await api("POST", "/api/careers/application/selfie", { challengeId: ch.challengeId, frames });
    stop();
    if (res.ok === false) toast("We could not confirm a live selfie. Try again in good light and turn your head clearly.", true);
    else toast("Selfie saved.");
  } catch (e) { stop(); throw e; }
  render();
}

function aiCard(app) {
  const ai = app.ai;
  if (!ai || !ai.available) return null;
  const haveIc = app.docs.some((d) => d.kind === "ic_front");
  const canRun = haveIc && ai.liveSelfie && ai.attemptsLeft > 0 && (ai.verdict === null || ai.verdict === "retake_ic");
  const runBtn = h("button", { class: "btn block", disabled: canRun ? null : true }, ai.verdict === "retake_ic" ? "Check again" : "Check my documents");
  runBtn.addEventListener("click", () => run(async () => {
    runBtn.textContent = "Checking… this takes a few seconds";
    const r = await api("POST", "/api/careers/application/ai-check", {});
    toast(r.verdict === "pass" ? "Your MyKad and selfie match." : "Check finished."); render();
  }, runBtn));
  const MSG = {
    pass: ["ok-line", "Your MyKad and selfie match. A vetting officer confirms the result."],
    review: ["muted", "An officer will check your identity by hand within 1 to 2 working days."],
    retake_selfie: ["alert soft", "Your selfie did not match your MyKad photo, or it did not look live. Do the selfie check again in good light."],
    retake_ic: ["alert soft", "We could not read your MyKad. Upload a sharper photo of the front (on a dark surface, no glare), then check again."]
  };
  const m = ai.verdict ? MSG[ai.verdict] : null;
  return h("section", { class: "card" }, h("h2", null, "Automatic identity check"),
    m ? h("p", { class: m[0] }, m[1]) : h("p", { class: "muted" }, "Takes a few seconds: we read your MyKad and compare it with a live selfie."),
    ai.verdict !== "pass" && ai.verdict !== "review" ? [
      h("div", { class: "item" }, h("span", { class: "doc-dot" + (haveIc ? " ok" : ""), "aria-hidden": "true" }), h("b", { class: "grow" }, "MyKad front uploaded")),
      h("div", { class: "item" }, h("span", { class: "doc-dot" + (ai.liveSelfie ? " ok" : ""), "aria-hidden": "true" }), h("b", { class: "grow" }, "Live selfie"),
        h("button", { class: "btn ghost small", onclick: (e) => run(selfieCheck, e.currentTarget) }, ai.liveSelfie ? "Take again" : "Start selfie check")),
      runBtn,
      h("small", { class: "muted" }, `${ai.attemptsLeft} of 3 automatic checks left. After that an officer checks by hand.`)
    ] : null,
    h("p", { class: "muted lock" }, "Face data is used only for this comparison and deleted right after."));
}

function statusView(app) {
  const LABEL = { submitted: ["Received", "warn"], in_review: ["Being checked", ""], approved: ["Approved", "ok"], rejected: ["Not successful", "bad"] };
  const [label, cls] = LABEL[app.status] || [app.status, ""];
  const open = ["submitted", "in_review"].includes(app.status);
  const docs = DOCS.filter(([kind]) => !(kind === "selfie" && app.ai && app.ai.available)).map(([kind, name, required]) => {
    const have = app.docs.filter((d) => d.kind === kind).length;
    const input = h("input", { type: "file", accept: "image/jpeg,image/png,application/pdf", class: "visually-hidden", id: "f-" + kind });
    input.addEventListener("change", () => run(async () => {
      const f = input.files && input.files[0]; if (!f) return;
      await api("POST", "/api/careers/application/docs", { kind, ...(await fileData(f)) });
      toast("Uploaded"); render();
    }));
    return h("div", { class: "item" }, h("span", { class: "doc-dot" + (have ? " ok" : "") , "aria-hidden": "true" }),
      h("div", { class: "grow" }, h("b", null, name), h("small", { class: "muted" }, have ? "Uploaded" : required ? "Required" : "Optional")),
      open ? h("label", { class: "btn ghost small", for: "f-" + kind }, have ? "Replace" : "Upload") : null, open ? input : null);
  });
  const withdraw = h("button", { class: "btn ghost danger block" }, "Withdraw and erase my application");
  withdraw.addEventListener("click", () => run(async () => {
    if (withdraw.dataset.sure !== "1") { withdraw.dataset.sure = "1"; withdraw.textContent = "Tap again: everything will be erased"; return; }
    await api("POST", "/api/careers/application/withdraw", {});
    A.token = null; write("kw_ap_token", null); A.step = "phone"; toast("Your application and documents were erased."); render();
  }, withdraw));
  return h("div", { class: "stack" },
    h("section", { class: "card" }, h("div", { class: "row" }, h("div", { class: "grow" }, h("b", { class: "big-when" }, app.name), h("small", { class: "muted" }, "Applied " + new Date(app.createdAt * 1000).toLocaleDateString())), h("span", { class: "pill " + cls }, label)),
      app.status === "approved" ? h("p", { class: "ok-line" }, "Welcome to KidsWay! Sign in to KidsWay Guardian with this phone number.") : null,
      app.status === "approved" ? h("a", { class: "btn", href: "/guardian/" }, "Sign in to KidsWay Guardian") : null,
      app.status === "rejected" ? h("p", null, "Thank you for applying. We cannot offer you the role at this time. Your data will be erased after 180 days, or now if you withdraw.") : null),
    open ? h("section", { class: "card" }, h("h2", null, "Your documents"), app.missingDocs.length ? h("p", { class: "alert soft" }, "Please upload the required documents so we can start the checks.") : h("p", { class: "muted" }, "Thank you. We have what we need to start."), docs,
      h("p", { class: "muted lock" }, "Files are encrypted on our server and only vetting officers can open them.")) : null,
    open ? aiCard(app) : null,
    h("section", { class: "card" }, h("h2", null, "Progress"),
      h("ol", { class: "progress" }, app.steps.map((s) => h("li", { class: s.done ? "done" : "" }, h("span", { class: "pdot", "aria-hidden": "true" }), h("span", null, s.label), h("small", { class: "muted" }, s.done ? "Done" : "Waiting"))))),
    app.status !== "approved" ? withdraw : null,
    h("button", { class: "link", onclick: () => { A.token = null; write("kw_ap_token", null); A.step = "phone"; render(); } }, "Sign out"));
}

// Public demo (test data only): the same banner as in the apps.
fetch("/api/info").then((r) => r.json()).then((i) => {
  if (!i.demo) return;
  document.body.prepend(h("div", { class: "demo-banner", role: "note" }, h("b", null, "DEMO"), " Test data only · SMS codes are shown on screen · data is reset regularly. Do not upload real documents."));
}).catch(() => { /* no banner */ });

render();
