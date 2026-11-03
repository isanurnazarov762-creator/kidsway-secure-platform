// KidsWay Control (the staff console): dispatch, regular plans, hiring and vetting, team, prices, audit log.
// Made for a computer screen; served only at /control/, so parents and Guardians never download it.
"use strict";

// =====================================================================
// ADMIN
// =====================================================================
async function adminRoute(r) {
  switch (r[0]) {
    case "trip": return adminTrip(r[1]);
    case "plans": return adminPlans();
    case "hiring": return r[1] ? adminApplicant(r[1]) : adminHiring();
    case "escorts": return adminEscorts();
    case "prices": return adminPrices();
    case "audit": return adminAudit();
    case "profile": return profileScreen();
    default: return adminTrips();
  }
}

function escortSelect(escorts, current) {
  return h("select", { "aria-label": "Escort" }, h("option", { value: "" }, "Choose escort…"), escorts.map((e) => h("option", { value: e.id, selected: e.id === current ? true : null }, e.name)));
}

async function adminTrips() {
  const [{ trips }, { escorts }] = await Promise.all([api("GET", "/api/trips"), api("GET", "/api/admin/escorts")]);
  const filters = { open: (t) => t.status === "requested", active: (t) => ["assigned", "in_progress"].includes(t.status), all: () => true };
  const list = trips.filter(filters[S.adminTripFilter]).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const count = trips.filter(filters.open).length;
  return screen({ title: "Dispatch", actions: h("a", { class: "icon-btn", href: "#/profile", "aria-label": "Profile" }, "☺"), body: h("div", { class: "stack" },
    seg([["open", `Open (${count})`], ["active", "Active"], ["all", "All"]], S.adminTripFilter, (v) => { S.adminTripFilter = v; render(); }, "Filter"),
    list.length ? list.map((t) => {
      const sel = escortSelect(escorts);
      const b = h("button", { class: "btn small" }, t.escortAssigned ? "Change" : "Assign");
      b.addEventListener("click", () => run(async () => {
        if (!sel.value) throw new Error("Choose an escort first.");
        await api("POST", `/api/admin/trips/${t.id}/assign`, { escortId: sel.value }); toast("Assigned"); render();
      }, b));
      return h("section", { class: "card" },
        h("a", { class: "row", href: "#/trip/" + t.id }, h("div", { class: "grow" }, h("b", null, fmtWhen(t.scheduledAt)), h("small", { class: "muted ell" }, routeText(t.stops))), statusPill(t.status)),
        h("div", { class: "row tight" }, h("span", { class: "tag" }, SERVICES[t.service][0]), t.leg === "back" ? h("span", { class: "tag" }, "Way back") : null, t.planId ? h("span", { class: "tag reg" }, "Regular") : null, t.price != null ? h("span", { class: "tag" }, money(t.price)) : null, t.escortName ? h("span", { class: "tag" }, "Escort: " + t.escortName) : null),
        ["requested", "assigned"].includes(t.status) ? (escorts.length ? h("div", { class: "row" }, h("div", { class: "grow" }, sel), b) : h("a", { class: "link", href: "#/escorts" }, "Add an escort first")) : null);
    }) : empty("Nothing here.")) });
}

async function adminTrip(id) {
  const t = await api("GET", "/api/trips/" + id);
  const mp = tripMap(t.stops);
  const cancel = ["requested", "assigned"].includes(t.status) ? h("button", { class: "btn ghost danger block" }, "Cancel trip") : null;
  if (cancel) cancel.addEventListener("click", () => run(async () => {
    if (cancel.dataset.sure !== "1") { cancel.dataset.sure = "1"; cancel.textContent = "Tap again to cancel"; return; }
    await api("POST", `/api/trips/${t.id}/cancel`, {}); toast("Cancelled"); render();
  }, cancel));
  return screen({ title: "Trip", back: "/", body: h("div", { class: "stack" }, mp.box,
    section(null, h("div", { class: "row" }, h("b", { class: "grow big-when" }, fmtWhen(t.scheduledAt)), statusPill(t.status)),
      h("div", { class: "kv" }, h("span", null, "Escort"), h("b", null, t.escortName || "None")),
      h("div", { class: "kv" }, h("span", null, "Price"), h("b", null, money(t.price)))),
    section("Stops", t.stops.map((s, i) => h("div", { class: "row" }, h("span", { class: "letter" + (i === 0 ? " k" : "") }, LETTERS[i]),
      h("div", { class: "grow" }, h("b", null, s.address), i > 0 ? h("small", { class: "muted" }, (s.receiverType === "trusted" ? s.receiverName + " · " + s.receiverPhone : "Parent") + (s.handedOverAt ? " · handed over" : s.codeLocked ? " · LOCKED" : "")) : null)))),
    cancel) });
}

async function adminPlans() {
  const [{ plans }, { escorts }] = await Promise.all([api("GET", "/api/plans"), api("GET", "/api/admin/escorts")]);
  return screen({ title: "Regular plans", body: h("div", { class: "stack" },
    plans.length ? plans.map((p) => {
      const sel = escortSelect(escorts);
      const b = h("button", { class: "btn small" }, p.escortAssigned ? "Change" : "Assign");
      b.addEventListener("click", () => run(async () => {
        if (!sel.value) throw new Error("Choose an escort first.");
        const r = await api("POST", `/api/admin/plans/${p.id}/assign`, { escortId: sel.value }); toast(`Regular escort set, ${r.trips} trips assigned`); render();
      }, b));
      return h("section", { class: "card" },
        h("div", { class: "row" }, h("div", { class: "grow" }, h("b", null, daysText(p.days) + " · " + p.goTime + (p.dir === "round" ? " / " + p.backTime : "")), h("small", { class: "muted ell" }, routeText(p.go))),
          h("span", { class: "pill " + (p.status === "active" ? "ok" : p.status === "paused" ? "warn" : "bad") }, p.status)),
        h("div", { class: "row tight" }, h("span", { class: "tag" }, SERVICES[p.service][0]), h("span", { class: "tag" }, money(p.priceWeek) + "/week"), h("span", { class: "tag" }, p.upcomingTrips + " coming trips"), p.escortName ? h("span", { class: "tag" }, "Escort: " + p.escortName) : null),
        p.status === "active" && escorts.length ? h("div", { class: "row" }, h("div", { class: "grow" }, sel), b) : null);
    }) : empty("No regular plans yet.")) });
}

async function adminEscorts() {
  const { escorts } = await api("GET", "/api/admin/escorts");
  const f = { name: "", phone: "+60" };
  const b = h("button", { class: "btn ghost block", type: "submit" }, "Quick add (development only)");
  return screen({ title: "Team", body: h("div", { class: "stack" },
    section("Guardians", escorts.length ? escorts.map((e) => h("div", { class: "item" }, h("span", { class: "av" }, e.name.charAt(0)), h("b", { class: "grow" }, e.name))) : empty("No Guardians yet.")),
    section(null, h("p", null, "New Guardians join through ", h("a", { class: "link", href: "#/hiring" }, "Hiring"), ": they apply in the KidsWay Guardian app, pass every security check and are approved by two officers.")),
    S.settings.dev ? h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => { await api("POST", "/api/admin/escorts", f); toast("Added (development shortcut)."); render(); }, b); } },
      h("h2", null, "Quick add for testing"),
      h("label", null, "Name", h("input", { type: "text", maxlength: "80", oninput: (e) => { f.name = e.target.value; } })),
      h("label", null, "Mobile number", h("input", { type: "tel", value: "+60", oninput: (e) => { f.phone = e.target.value.trim(); } })),
      h("p", { class: "muted" }, "Skips vetting, so the server allows it only outside production."), b) : null) });
}

async function adminPrices() {
  const s = await api("GET", "/api/settings");
  const f = { ...s };
  const num = (label, key, hint) => h("label", null, label, h("input", { type: "number", min: "0", step: "0.5", value: String(f[key]), oninput: (e) => { f[key] = Number(e.target.value); } }), hint ? h("small", { class: "muted" }, hint) : null);
  const b = h("button", { class: "btn block", type: "submit" }, "Save prices");
  return screen({ title: "Prices", body: h("form", { class: "stack", onsubmit: (e) => { e.preventDefault(); run(async () => {
    S.settings = await api("PUT", "/api/admin/settings", { currency: f.currency, base: f.base, extraChild: f.extraChild, extraStop: f.extraStop, regDiscount: f.regDiscount });
    toast("Prices saved. New quotes use them now."); render();
  }, b); } },
    section("Per trip",
      h("label", null, "Currency", h("input", { type: "text", maxlength: "5", value: f.currency, oninput: (e) => { f.currency = e.target.value.trim(); } })),
      num("Base price (1 child, 1 stop)", "base"),
      num("Each extra child", "extraChild", "Price depends on the number of children in the family"),
      num("Each extra drop-off", "extraStop")),
    section("Regular plans", num("Weekly discount, %", "regDiscount", "Applied to plans; 0 to 90")),
    section("Example", h("p", { class: "muted" }, `2 children, A → B → C, there and back: ${s.currency} ${(s.base + s.extraChild + s.extraStop) + (s.base + s.extraChild)} (with the saved prices).`)),
    b) });
}

async function adminAudit() {
  const { entries } = await api("GET", "/api/admin/audit?limit=200");
  return screen({ title: "Audit log", body: h("div", { class: "stack" },
    h("p", { class: "muted" }, "Append-only: the database refuses edits and deletes. Denied and failed actions are highlighted."),
    h("div", { class: "card tablewrap" }, h("table", null,
      h("thead", null, h("tr", null, ["Time", "Who", "Action", "Target", "Result"].map((x) => h("th", null, x)))),
      h("tbody", null, entries.map((e) => h("tr", null,
        h("td", null, new Date(e.at * 1000).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" })),
        h("td", null, e.actor_role || "-"), h("td", null, e.action, e.detail ? h("small", { class: "muted block" }, e.detail) : null),
        h("td", null, e.target_type ? e.target_type + ":" + String(e.target_id || "").slice(0, 6) : "-"),
        h("td", { class: "outcome-" + e.outcome }, e.outcome))))))) });
}

// =====================================================================
// ADMIN: HIRING (vetting KidsWay Guardians)
// =====================================================================
const FLAG_TEXT = { duplicate_ic: "Same MyKad used in another application", doc_reused: "A document file is also used by another applicant", phone_has_account: "This phone already has a KidsWay account" };
const DOC_NAMES = { ic_front: "MyKad front", ic_back: "MyKad back", selfie: "Selfie with MyKad", first_aid_cert: "First aid certificate", police_cert: "Police record", edkk_result: "e-DKK result (JKM)", reference_notes: "Reference notes", interview_form: "Interview form", other: "Other" };
const APP_STATUS = { submitted: ["New", "warn"], in_review: ["Checking", ""], approved: ["Guardian", "ok"], rejected: ["Rejected", "bad"] };
const fmtDate = (t) => new Date(t * 1000).toLocaleDateString([], { day: "numeric", month: "short", year: "numeric" });

async function adminHiring() {
  let data;
  try { data = await api("GET", "/api/admin/applicants?view=" + S.hiringView); }
  catch (e) {
    if (e.status === 403) return screen({ title: "Hiring", body: empty("You need the vetting permission to open applications. Ask the security lead.") });
    throw e;
  }
  const list = data.applicants;
  return screen({ title: "Hiring", body: h("div", { class: "stack" },
    seg([["open", "To check"], ["due", "Re-check due"], ["approved", "Guardians"], ["rejected", "Rejected"]], S.hiringView, (v) => { S.hiringView = v; render(); }, "Applications"),
    S.hiringView === "open" ? h("p", { class: "muted" }, `Every check must pass, then ${data.approvalsNeeded} different officer${data.approvalsNeeded > 1 ? "s" : ""} approve. Public page: `, h("a", { class: "link", href: "/careers", target: "_blank" }, "/careers")) : null,
    list.length ? list.map((a) => h("a", { class: "card", href: "#/hiring/" + a.id },
      h("div", { class: "row" }, h("span", { class: "av" }, (a.name || "?").charAt(0)),
        h("div", { class: "grow" }, h("b", null, a.name), h("small", { class: "muted" }, `${a.age} y · ${a.area} · applied ${fmtDate(a.createdAt)}`)),
        h("span", { class: "pill " + APP_STATUS[a.status][1] }, APP_STATUS[a.status][0])),
      h("div", { class: "row tight" },
        h("span", { class: "tag" }, `Checks ${a.checksPassed}/${a.checksTotal}`), a.checksFailed ? h("span", { class: "flag" }, `${a.checksFailed} failed`) : null,
        h("span", { class: "tag" }, `${a.docs} files`), a.approvals ? h("span", { class: "tag" }, `Approvals ${a.approvals}/${data.approvalsNeeded}`) : null,
        a.recheckDue ? h("span", { class: "flag" }, "Re-check due") : null,
        a.flags.map((f) => h("span", { class: "flag", title: FLAG_TEXT[f] || f }, f.replace(/_/g, " ")))))) : empty("Nothing here.")) });
}

async function adminApplicant(id) {
  const a = await api("GET", "/api/admin/applicants/" + id);
  const open = a.status === "submitted" || a.status === "in_review";
  const allPass = a.checks.every((c) => c.result === "pass");
  const kindsOnFile = new Set(a.docs.map((d) => d.kind));

  const docRow = (d) => {
    const b = h("button", { class: "btn ghost small" }, "Open");
    b.addEventListener("click", () => run(async () => {
      const r = await api("GET", `/api/admin/applicants/${a.id}/docs/${d.id}/link`);
      window.open(r.url, "_blank", "noopener"); // a 5-minute signed link; opening it is logged
    }, b));
    return h("div", { class: "item" }, h("div", { class: "grow" }, h("b", null, DOC_NAMES[d.kind] || d.kind), h("small", { class: "muted" }, `${d.mime.split("/")[1].toUpperCase()} · ${Math.round(d.size / 1024)} KB · ${d.by === "officer" ? "officer" : "applicant"} · ${fmtDate(d.at)}`)), b);
  };

  // Officer upload, e.g. the e-DKK result received from JKM. (MyKad photos and the selfie come only from the applicant.)
  const OFFICER_KINDS = ["edkk_result", "police_cert", "first_aid_cert", "reference_notes", "interview_form", "other"];
  let upKind = "edkk_result";
  const upFile = h("input", { type: "file", accept: "image/jpeg,image/png,application/pdf", class: "visually-hidden", id: "officer-up" });
  upFile.addEventListener("change", () => run(async () => {
    const f = upFile.files && upFile.files[0]; if (!f) return;
    const data = await readForUpload(f);
    await api("POST", `/api/admin/applicants/${a.id}/docs`, { kind: upKind, ...data });
    toast("Document added"); render();
  }));

  const checkCard = (c) => {
    let note = "";
    const missing = c.needs.filter((k) => !kindsOnFile.has(k));
    const act = (result, label, cls) => {
      const b = h("button", { class: "btn small " + (cls || "") }, label);
      b.addEventListener("click", () => run(async () => {
        const r = await api("POST", `/api/admin/applicants/${a.id}/checks`, { check: c.check, result, note: note || undefined });
        toast(r.suspended ? "Re-check failed: the Guardian is suspended and her trips were freed." : "Saved"); render();
      }, b));
      return b;
    };
    const canEdit = a.status !== "rejected";
    return h("div", { class: "check-card " + (c.result || "") },
      h("div", { class: "row" }, h("b", { class: "grow" }, c.label), c.result ? h("span", { class: "pill " + (c.result === "pass" ? "ok" : "bad") }, c.result) : h("span", { class: "pill warn" }, "to do")),
      c.result ? h("small", { class: "muted" }, `${c.by}, ${fmtDate(c.at)}${c.validUntil ? " · valid until " + fmtDate(c.validUntil) : ""}${c.note ? " · “" + c.note + "”" : ""}`) : null,
      missing.length ? h("div", { class: "row tight" }, h("small", { class: "bad-text grow" }, "Evidence needed: " + missing.map((k) => DOC_NAMES[k]).join(", ")),
        // Add the missing file right here (e.g. the e-DKK result JKM sent to KidsWay), no need to scroll to Documents.
        canEdit ? missing.filter((k) => OFFICER_KINDS.includes(k)).map((k) => h("button", { type: "button", class: "btn ghost small", onclick: () => { upKind = k; upFile.click(); } }, "Add " + DOC_NAMES[k])) : null) : null,
      canEdit ? h("div", { class: "row" }, h("input", { type: "text", maxlength: "500", placeholder: "Note (optional)", class: "grow", oninput: (e) => { note = e.target.value; } }), act("pass", "Pass", missing.length ? "ghost" : ""), act("fail", "Fail", "ghost danger")) : null);
  };

  const approve = h("button", { class: "btn block", disabled: !allPass || a.approvals.some((x) => x.me) }, a.approvals.some((x) => x.me) ? "You approved" : `Approve (${a.approvals.length}/${a.approvalsNeeded})`);
  approve.addEventListener("click", () => run(async () => {
    const r = await api("POST", `/api/admin/applicants/${a.id}/approve`, {});
    toast(r.approved ? "Approved. Her escort account is ready: she logs in with her phone." : `Approval ${r.approvals}/${r.needed} saved. Another officer must approve.`); render();
  }, approve));
  let reason = "";
  const reject = h("button", { class: "btn ghost danger" }, "Reject");
  reject.addEventListener("click", () => run(async () => {
    if (!reason.trim()) throw new Error("Write the reason first (kept 180 days, then erased).");
    if (reject.dataset.sure !== "1") { reject.dataset.sure = "1"; reject.textContent = "Tap again to reject"; return; }
    await api("POST", `/api/admin/applicants/${a.id}/reject`, { reason }); toast("Rejected"); render();
  }, reject));

  return screen({ title: a.name, back: "/hiring", body: h("div", { class: "stack" },
    section(null,
      h("div", { class: "row" }, h("span", { class: "av big" }, a.name.charAt(0)), h("div", { class: "grow" }, h("b", { class: "big-when" }, a.name), h("small", { class: "muted" }, `${a.age} years · ${a.area}`)),
        h("span", { class: "pill " + APP_STATUS[a.status][1] }, APP_STATUS[a.status][0])),
      a.flags.length ? h("div", { class: "stack-s" }, a.flags.map((f) => h("p", { class: "alert soft" }, "⚠ " + (FLAG_TEXT[f] || f)))) : null,
      h("dl", { class: "facts" },
        h("dt", null, "MyKad"), h("dd", null, a.ic.replace(/^(\d{6})(\d{2})(\d{4})$/, "$1-$2-$3")),
        h("dt", null, "Phone"), h("dd", null, h("a", { class: "link", href: "tel:" + a.phone }, a.phone)),
        a.email ? [h("dt", null, "Email"), h("dd", null, a.email)] : null,
        h("dt", null, "Languages"), h("dd", null, a.languages.join(", ")),
        h("dt", null, "Days"), h("dd", null, a.days.join(", ")),
        h("dt", null, "Transport"), h("dd", null, a.transport),
        h("dt", null, "Experience"), h("dd", null, a.experience || "-"),
        h("dt", null, "Consent"), h("dd", null, `${fmtDate(a.consentAt)} (v${a.consentVersion})`),
        a.rejectReason ? [h("dt", null, "Rejected"), h("dd", null, a.rejectReason)] : null)),
    section("References", a.references.map((r) => h("div", { class: "item" }, h("div", { class: "grow" }, h("b", null, r.name), h("small", { class: "muted" }, r.relation)), h("a", { class: "btn ghost small", href: "tel:" + r.phone }, r.phone)))),
    section("Documents", a.docs.length ? a.docs.map(docRow) : empty("No documents yet."),
      a.status !== "rejected" ? h("div", { class: "row" },
        h("select", { "aria-label": "Document type", class: "grow", onchange: (e) => { upKind = e.target.value; } }, OFFICER_KINDS.map((k) => h("option", { value: k }, DOC_NAMES[k]))),
        h("label", { class: "btn ghost small", for: "officer-up" }, "Add file"), upFile) : null,
      h("p", { class: "muted lock" }, "Files are encrypted at rest. Links last 5 minutes and every opening is in the audit log.")),
    aiSection(a.ai),
    section("Checks", a.checks.map(checkCard)),
    open ? section("Decision",
      h("p", { class: "muted" }, `Four-eyes rule: ${a.approvalsNeeded} different officers must approve after every check passed. Any new check result clears earlier approvals.`),
      a.approvals.length ? a.approvals.map((x) => h("p", { class: "ok-line" }, `✓ Approved by ${x.by}${x.me ? " (you)" : ""}`)) : null,
      approve,
      h("label", null, "Reason for rejection", h("input", { type: "text", maxlength: "300", oninput: (e) => { reason = e.target.value; } })), reject) : null,
    a.status === "approved" ? section(null, h("p", { class: "ok-line" }, "Guardian since " + fmtDate(a.decidedAt)), h("p", { class: "muted" }, "Repeat e-DKK and police checks before they expire. A failed re-check suspends her account immediately.")) : null) });
}

// The AI identity report: a suggestion for the officer, never a decision.
function aiSection(ai) {
  if (!ai || !ai.verdict) return section("Automatic identity check", h("p", { class: "muted" }, ai && ai.liveOk !== null ? "Live selfie taken; the check has not run yet." : "Not run: the applicant did not consent to face comparison, or has not done the selfie check. Check identity by hand."));
  const V = { pass: ["ok", "AI suggests: identity matches"], review: ["warn", "AI could not confirm: check by hand"], retake_selfie: ["warn", "Waiting for a new selfie"], retake_ic: ["warn", "Waiting for a new MyKad photo"] };
  const [cls, text] = V[ai.verdict] || ["", ai.verdict];
  const id = ai.identity || {};
  const row = (k, v, good) => h("div", { class: "kv" }, h("span", null, k), h("b", { class: good === false ? "bad-text" : "" }, v));
  return section("Automatic identity check",
    h("div", { class: "row" }, h("span", { class: "pill " + cls }, text), h("small", { class: "muted" }, `attempt ${ai.attempts} of 3`)),
    row("Live person", ai.liveOk === null ? "not checked" : ai.liveOk ? `yes (${ai.liveness ? ai.liveness.score : "-"})` : "no", ai.liveOk !== false),
    row("Face: selfie vs MyKad", id.faceScore == null ? "-" : `${id.faceScore} (same person from 0.363)`, id.faceScore == null || id.faceScore >= 0.363),
    id.ocr ? row("MyKad number read", id.ocr.icFound ? (id.ocr.icMatch ? "matches the form" : "DIFFERS from the form") : "not readable", id.ocr.icMatch) : null,
    id.ocr ? row("Name on MyKad", `${id.ocr.nameMatch ? "matches" : "differs"} (${id.ocr.nameScore})`, id.ocr.nameMatch) : null,
    (id.reasons || []).length ? h("small", { class: "muted" }, "Reasons: " + id.reasons.join(", ")) : null,
    h("p", { class: "muted" }, "You decide the identity check. To pass it against the AI, write the reason in the note."));
}

async function readForUpload(file) {
  if (file.size > 3 * 1024 * 1024) throw new Error("The file is larger than 3 MB.");
  const b = new Uint8Array(await file.arrayBuffer());
  let s = ""; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode.apply(null, b.subarray(i, i + 0x8000));
  const mime = file.type === "application/pdf" ? "application/pdf" : file.type === "image/png" ? "image/png" : "image/jpeg";
  return { mime, data: btoa(s) };
}

start(adminRoute);
