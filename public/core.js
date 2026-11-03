// Shared core of the three KidsWay apps: KidsWay (parents), KidsWay Guardian (escorts), KidsWay Control (staff).
// Each page loads core.js plus its own file (parent.js, guardian.js or control.js), so no app ships another app's code.
// Talks only to this server's API, plus OpenStreetMap for the map.
// Security notes:
// - All text from the server is inserted with textContent (the h() helper), never innerHTML: no XSS.
// - The session token lives in sessionStorage (one tab = one user) and is sent as a Bearer header.
// - The page's Content-Security-Policy blocks inline scripts and every origin except the map hosts.
"use strict";

// Which app this page is: set on <body data-app="..."> by the HTML file.
const APPS = {
  parent: { id: "parent", role: "parent", name: "KidsWay", home: "/", sw: "/sw.js", tagline: "A trusted escort takes your child from A to B and hands them only to the person you choose." },
  guardian: { id: "guardian", role: "escort", name: "KidsWay Guardian", home: "/guardian/", sw: "/guardian/sw.js", tagline: "Your trips, handover codes and photo reports. For approved KidsWay Guardians." },
  control: { id: "control", role: "admin", name: "KidsWay Control", home: "/control/", sw: "/control/sw.js", tagline: "Staff console: dispatch, hiring and vetting, team, prices and the audit log." }
};
const APP = APPS[document.body.dataset.app] || APPS.parent;
const TOKEN_KEY = "kw_token_" + APP.id; // each app keeps its own session

const $app = document.getElementById("app");
const $toast = document.getElementById("toast");

const S = {
  token: read(TOKEN_KEY),
  me: null,
  settings: null,
  login: { step: 1, phone: "+60", name: "", challengeId: null, devCode: null, code: "" },
  book: null,          // one-time booking being filled in
  plan: null,          // regular plan being filled in
  lastBooking: null,   // codes shown once after booking
  codes: {},           // codes received in this tab: { tripId: { seq: code } }
  timers: [],
  maps: [],
  gps: null,           // escort location sharing { tripId, watchId, sim, last }
  tripsTab: "upcoming",
  adminTripFilter: "open",
  hiringView: "open",
  installPrompt: null
};

function read(k) { try { return sessionStorage.getItem(k); } catch { return null; } }
function write(k, v) { try { v == null ? sessionStorage.removeItem(k) : sessionStorage.setItem(k, v); } catch { /* storage blocked */ } }

// ---------- DOM helper: builds elements, inserts text safely ----------
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
  for (const kid of kids.flat(Infinity)) {
    if (kid == null || kid === false) continue;
    el.append(kid instanceof Node ? kid : document.createTextNode(String(kid)));
  }
  return el;
}

// ---------- API ----------
class ApiError extends Error { constructor(status, code) { super(code); this.status = status; this.code = code; } }

async function api(method, path, body) {
  const res = await fetch(path, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(S.token ? { authorization: "Bearer " + S.token } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  let data = null;
  try { data = await res.json(); } catch { /* empty */ }
  if (res.status === 401 && S.token) { endSession(); go("/"); throw new ApiError(401, "session_expired"); }
  if (!res.ok) { const err = new ApiError(res.status, (data && data.error) || "error"); err.data = data; throw err; }
  return data;
}

const MESSAGES = {
  invalid_phone: "Enter a Malaysian mobile number like +60123456789.",
  invalid_code: "Wrong code. Check the SMS and try again.",
  too_many_attempts: "Too many wrong codes. Request a new SMS code.",
  invalid_or_expired: "This code has expired. Request a new one.",
  too_many_requests: "Too many attempts. Wait a few minutes and try again.",
  session_expired: "Your session ended. Please log in again.",
  wrong_code: "Wrong handover code. After 5 wrong codes this stop locks.",
  code_locked_contact_parent: "This stop is locked after 5 wrong codes. Call the parent: they can issue a new code.",
  code_not_issued_contact_parent: "The parent has not issued a code for this stop yet. Ask them to tap “Get handover code”.",
  code_expired: "This handover code has expired. The parent can issue a new one.",
  already_handed_over: "This child was already handed over at this stop.",
  trip_not_in_progress: "Start the trip first.",
  trip_not_assigned: "This trip is not assigned to you yet.",
  trip_not_cancellable: "This trip has already started and cannot be cancelled.",
  invalid_photo: "Only real JPEG or PNG photos up to 2 MB.",
  phone_in_use: "This phone number already has an account.",
  child_has_open_trip: "This child has an open trip and cannot be deleted now.",
  invalid_childIds: "Choose at least one child.",
  invalid_stops: "Add a pick-up point and at least one drop-off.",
  invalid_address: "Choose every address on the map or type it.",
  invalid_lat: "Choose a point in Malaysia.",
  invalid_lng: "Choose a point in Malaysia.",
  invalid_name: "Fill in the name.",
  invalid_scheduledAt: "Choose a time from now on.",
  invalid_days: "Choose at least one day.",
  invalid_goTime: "Choose the time there.",
  invalid_backTime: "The way back must be after the way there.",
  invalid_overrides: "Check the special times: the way back must be after the way there.",
  invalid_dates: "Check the dates: the plan cannot start in the past.",
  plan_ended: "This plan has ended. Create a new one.",
  not_reissuable: "A new code cannot be issued for this stop.",
  not_found: "Not found.",
  wrong_app: "This number belongs to another KidsWay app.",
  not_a_guardian: "This number is not a KidsWay Guardian yet. Apply first: after the security checks you can sign in here.",
  not_staff: "This number has no staff account. Staff accounts are created by a KidsWay admin.",
  forbidden: "You do not have access to this."
};
Object.assign(MESSAGES, {
  checks_incomplete: "Every check must pass (and still be valid) before approval.",
  already_approved_by_you: "You already approved. A different officer must give the next approval.",
  already_decided: "This application has already been decided.",
  account_suspended: "This account is suspended. Contact KidsWay.",
  use_vetting: "New Guardians are added through Hiring, after the security checks.",
  invalid_document: "Only real JPG, PNG or PDF files up to 3 MB.",
  pdf_active_content: "This PDF contains scripts or attachments and was refused.",
  note_required_ai_disagrees: "The AI could not confirm this identity. Write in the note why you pass it."
});
function msg(e) { if (e.code && e.code.startsWith("evidence_missing:")) return "Upload the evidence first: " + e.code.slice(17).split(",").join(", ") + "."; return MESSAGES[e.code] || (e.code && e.code.startsWith("invalid_") ? "Check the field: " + e.code.slice(8) : "Something went wrong (" + e.code + ")."); }

function toast(text, isErr) {
  $toast.textContent = text;
  $toast.className = "toast" + (isErr ? " err" : "");
  $toast.hidden = false;
  clearTimeout(toast.t);
  toast.t = setTimeout(() => { $toast.hidden = true; }, 3500);
}
async function run(fn, btn) {
  if (btn) btn.disabled = true;
  try { await fn(); } catch (e) { toast(e instanceof ApiError ? msg(e) : String(e.message || e), true); }
  finally { if (btn && btn.isConnected) btn.disabled = false; }
}
function endSession() { if (typeof stopGps === "function") stopGps(); S.token = null; S.me = null; S.settings = null; S.codes = {}; S.book = null; S.plan = null; write(TOKEN_KEY, null); }
function every(ms, fn) { S.timers.push(setInterval(fn, ms)); }
function cleanup() { S.timers.forEach(clearInterval); S.timers = []; S.maps.forEach((m) => m.destroy()); S.maps = []; }

// ---------- formatting ----------
const LETTERS = ["A", "B", "C", "D", "E", "F"];
const SERVICES = { walk: ["Walking escort", "Short distances on foot"], public: ["Public transport", "LRT, MRT or bus with the escort"], taxi: ["Taxi / e-hailing", "Escort rides with your child"], car: ["Escort's car", "Car with child seat"], vip: ["VIP escort", "Senior escort, door to door"] };
const STATUS = { requested: ["Finding an escort", "warn"], assigned: ["Escort assigned", ""], in_progress: ["On the way", "live"], completed: ["Completed", "ok"], cancelled: ["Cancelled", "bad"] };
const DAY_NAMES = { mon: "Mon", tue: "Tue", wed: "Wed", thu: "Thu", fri: "Fri", sat: "Sat", sun: "Sun" };
const DAY_ORDER = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const pad = (n) => String(n).padStart(2, "0");
const nowSec = () => Math.floor(Date.now() / 1000);
function money(n) { const c = (S.settings && S.settings.currency) || "RM"; return n == null ? "" : c + " " + (Math.round(n * 100) / 100).toFixed(2).replace(/\.00$/, ""); }
function fmtDay(t) {
  const d = new Date(t * 1000), today = new Date();
  const tomorrow = new Date(); tomorrow.setDate(today.getDate() + 1);
  if (d.toDateString() === today.toDateString()) return "Today";
  if (d.toDateString() === tomorrow.toDateString()) return "Tomorrow";
  return d.toLocaleDateString([], { weekday: "short", day: "numeric", month: "short" });
}
const fmtTime = (t) => new Date(t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
const fmtWhen = (t) => fmtDay(t) + ", " + fmtTime(t);
function localInput(d) { return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function todayStr() { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; }
function daysText(days) {
  const set = DAY_ORDER.filter((d) => days.includes(d));
  if (set.join() === "mon,tue,wed,thu,fri") return "Mon–Fri";
  if (set.length === 7) return "Every day";
  return set.map((d) => DAY_NAMES[d]).join(", ");
}
function statusPill(s) { const v = STATUS[s] || [s, ""]; return h("span", { class: "pill " + v[1] }, v[0]); }
function short(addr) { return String(addr || "").split(",")[0]; }
function routeText(stops) { return stops.map((s) => short(s.address)).join(" → "); }

// ---------- routing (hash based, so the phone's back button works) ----------
function route() { return (location.hash.slice(1) || "/").split("/").filter(Boolean); }
function go(path) { if (location.hash.slice(1) === path) render(); else location.hash = path; }
window.addEventListener("hashchange", () => { if (!$toast.classList.contains("err")) $toast.hidden = true; render(); });

// ---------- layout ----------
function navItems() {
  if (APP.id === "parent") return [["", "Home", "home"], ["trips", "Trips", "trips"], ["plans", "Plans", "plans"], ["children", "Children", "kids"], ["profile", "Profile", "me"]];
  if (APP.id === "guardian") return [["", "My trips", "trips"], ["profile", "Profile", "me"]];
  return [["", "Dispatch", "trips"], ["plans", "Plans", "plans"], ["hiring", "Hiring", "hire"], ["escorts", "Team", "kids"], ["prices", "Prices", "price"], ["audit", "Audit", "audit"], ["profile", "Account", "me"]];
}
function screen({ title, back, actions, body, nav = true }) {
  const r = route();
  const top = h("header", { class: "bar" },
    back ? h("button", { class: "icon-btn", "aria-label": "Back", onclick: () => (history.length > 1 ? history.back() : go(back)) }, "‹") : h("span", { class: "logo", "aria-hidden": "true" }),
    h("h1", { class: "bar-title" }, title),
    actions || h("span", { class: "bar-sp" }));
  const items = nav && S.me ? navItems() : [];
  const navEl = items.length ? h("nav", { class: "tabbar" + (items.length > 5 ? " six" : ""), "aria-label": "Main" },
    APP.id === "control" ? h("div", { class: "side-brand" }, h("span", { class: "logo", "aria-hidden": "true" }), h("b", null, "KidsWay ", h("span", null, "Control"))) : null,
    items.map(([p, label, ic]) => {
    const on = (r[0] || "") === p;
    return h("a", { href: "#/" + p, class: on ? "on" : "", "aria-current": on ? "page" : null }, h("span", { class: "ic ic-" + ic, "aria-hidden": "true" }), h("span", null, label));
  })) : null;
  return h("div", { class: "screen" + (navEl ? " has-nav" : "") }, top, h("main", { class: "content" }, body), navEl);
}
function section(title, ...kids) { return h("section", { class: "card" }, title ? h("h2", null, title) : null, ...kids); }
function seg(options, value, onPick, label) {
  return h("div", { class: "seg", role: "radiogroup", "aria-label": label || "" }, options.map(([v, text]) =>
    h("button", { type: "button", role: "radio", "aria-checked": String(v === value), class: v === value ? "on" : "", onclick: () => onPick(v) }, text)));
}
function sw(label, checked, onChange, hint) {
  return h("label", { class: "switch" }, h("span", { class: "grow" }, h("b", null, label), hint ? h("small", null, hint) : null),
    h("input", { type: "checkbox", role: "switch", checked, onchange: (e) => onChange(e.target.checked) }), h("span", { class: "track", "aria-hidden": "true" }));
}
function empty(text, btn) { return h("div", { class: "empty" }, h("p", null, text), btn || null); }

// ---------- render ----------
let renderSeq = 0;
let appRoute = null;
let DEMO = false; // the public demo (test data only): a banner on every screen
/** Called once by parent.js, guardian.js or control.js with that app's router. */
async function start(routeFn) {
  appRoute = routeFn;
  try { DEMO = !!(await (await fetch("/api/info")).json()).demo; } catch { /* older server: no banner */ }
  if (DEMO) {
    document.body.classList.add("is-demo");
    document.body.prepend(h("div", { class: "demo-banner", role: "note" }, h("b", null, "DEMO"), " Test data only · SMS codes are shown on screen · data is reset regularly. Do not enter real information."));
  }
  render();
}
async function render() {
  const seq = ++renderSeq;
  cleanup();
  if (!S.token) { $app.replaceChildren(loginScreen()); return; }
  try {
    if (!S.me) S.me = await api("GET", "/api/me");
    if (!S.settings) S.settings = await api("GET", "/api/settings");
  } catch { endSession(); return render(); }
  if (S.me.role !== APP.role) { endSession(); return render(); } // a session from another app is never used here
  const r = route();
  if (S.gps && !(r[0] === "trip" && r[1] === S.gps.tripId)) stopGps();
  let el;
  try {
    el = await appRoute(r);
  } catch (e) {
    el = screen({ title: "KidsWay", body: empty(e instanceof ApiError ? msg(e) : "Could not load this page.", h("button", { class: "btn", onclick: () => go("/") }, "Go home")) });
  }
  if (seq !== renderSeq) return; // a newer render started meanwhile
  $app.replaceChildren(el);
  window.scrollTo(0, 0);
}

// =====================================================================
// LOGIN
// =====================================================================
function loginScreen() {
  const L = S.login;
  const local = ["localhost", "127.0.0.1"].includes(location.hostname) || DEMO;
  const hero = h("div", { class: "hero" }, h("span", { class: "logo big", "aria-hidden": "true" }),
    h("p", { class: "wm" }, "Kids", h("b", null, "Way"), APP.id !== "parent" ? h("span", { class: "wm-app" }, APP.id === "guardian" ? "Guardian" : "Control") : null),
    h("p", { class: "hero-sub" }, APP.tagline));
  const parentApp = APP.id === "parent";
  if (L.step === 1) {
    const notice = L.notice ? noticeCard(L.notice) : null; L.notice = null;
    const phone = h("input", { type: "tel", value: L.phone, autocomplete: "tel", placeholder: "+60123456789", oninput: (e) => { L.phone = e.target.value.trim(); } });
    const name = parentApp ? h("input", { type: "text", value: L.name, autocomplete: "name", placeholder: "For new parents", oninput: (e) => { L.name = e.target.value; } }) : null;
    const btn = h("button", { class: "btn block", type: "submit" }, "Send SMS code");
    const form = h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
      const r = await api("POST", "/api/auth/otp/request", { phone: L.phone });
      L.challengeId = r.challengeId; L.devCode = r.devCode || null; L.code = ""; L.step = 2; render();
    }, btn); } }, h("label", null, "Mobile number", phone), name ? h("label", null, "Your name", name) : null, btn,
      h("p", { class: "muted center" }, "No passwords. We send a one-time code by SMS."));
    const demo = { parent: ["Parent: any number, e.g. +60123456789"], guardian: [DEMO ? "Guardian: +60111222333 (demo Guardian), or a number approved in Hiring" : "Guardian: a number approved in Hiring, or added under Team in KidsWay Control"], control: ["Admin: +60100000000", "Second vetting officer: +60100000001"] }[APP.id];
    return h("div", { class: "login" }, hero, notice, form,
      APP.id === "guardian" ? h("a", { class: "card apply-cta", href: "/guardian/apply" }, h("b", null, "Become a KidsWay Guardian"), h("small", { class: "muted" }, "Women aged 20 to 55 · apply in this app, security-checked before the first trip"), h("span", { class: "chev", "aria-hidden": "true" }, "›")) : null,
      local ? h("details", { class: "card sun" }, h("summary", null, DEMO ? "Demo accounts" : "Demo accounts on this computer"),
        h("p", { class: "muted" }, "Each app keeps its own sign-in. Use another tab for another app."), demo.map((t) => h("p", null, t))) : null,
      h("p", { class: "other-apps muted center" }, otherApps()));
  }
  const code = h("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", value: L.code, placeholder: "••••••", class: "code-input", oninput: (e) => { L.code = e.target.value.trim(); } });
  const btn = h("button", { class: "btn block", type: "submit" }, "Verify");
  return h("div", { class: "login" }, hero,
    L.devCode ? h("div", { class: "sms", role: "note" }, h("small", null, DEMO ? "SMS simulator · public demo" : "SMS simulator · development only"), h("p", null, "Your KidsWay code is ", h("b", null, L.devCode))) : null,
    h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
      try {
        const r = await api("POST", "/api/auth/otp/verify", { phone: L.phone, challengeId: L.challengeId, code: L.code, name: (parentApp && L.name) || undefined, app: APP.id });
        S.token = r.token; write(TOKEN_KEY, r.token); S.me = null; L.step = 1; L.devCode = null;
        go("/");
      } catch (e) {
        if (!(e instanceof ApiError) || !["wrong_app", "not_a_guardian", "not_staff"].includes(e.code)) throw e;
        L.step = 1; L.devCode = null; L.notice = e; render();
      }
    }, btn); } },
    h("p", null, "Code sent to ", h("b", null, L.phone), ". Valid 5 minutes, 5 tries."),
    h("label", null, "SMS code", code), btn,
    h("button", { type: "button", class: "link", onclick: () => { L.step = 1; render(); } }, "Change number")));
}

// After a correct SMS code for a number that belongs to another app: say which app to use.
function noticeCard(e) {
  if (e.code === "wrong_app" && e.data && APPS[e.data.app]) {
    const target = APPS[e.data.app];
    return h("div", { class: "card notice", role: "alert" }, h("b", null, "Use " + target.name), h("p", null, "This number is registered in " + target.name + ". For security, each account signs in only in its own app."), h("a", { class: "btn block", href: target.home }, "Open " + target.name));
  }
  return h("div", { class: "card notice", role: "alert" }, h("p", null, msg(e)), e.code === "not_a_guardian" ? h("a", { class: "btn block", href: "/guardian/apply" }, "Apply to become a Guardian") : null);
}
function otherApps() {
  const links = Object.values(APPS).filter((a) => a.id !== APP.id).map((a) => h("a", { href: a.home }, a.name));
  return ["Other apps: ", links[0], " · ", links[1]];
}

// =====================================================================
// SHARED: map picker (Grab-style: move the map under the pin, or search)
// =====================================================================
function openPicker(initial, title, onPick) {
  const start = initial && initial.lat != null ? initial : null;
  let cur = { address: (initial && initial.address) || "", lat: start ? start.lat : KWMap.KL[0], lng: start ? start.lng : KWMap.KL[1] };
  let pinned = !!start, reqId = 0;
  const box = h("div", { class: "picker-map" });
  const addrOut = h("p", { class: "pick-addr" }, cur.address || "Move the map so the pin is on the place, or search.");
  const detail = h("input", { type: "text", maxlength: "160", value: cur.address, placeholder: "Address (you can add block, unit, gate)", "aria-label": "Address text" });
  const results = h("div", { class: "results", role: "listbox", "aria-label": "Search results" });
  const q = h("input", { type: "search", placeholder: "Search a school, building or street", "aria-label": "Search address", enterkeyhint: "search" });
  let t = 0;
  const doSearch = async () => {
    const text = q.value.trim();
    if (text.length < 3) { results.replaceChildren(); return; }
    const id = ++reqId;
    results.replaceChildren(h("p", { class: "muted pad" }, "Searching…"));
    try {
      const rows = await KWGeo.search(text);
      if (id !== reqId) return;
      results.replaceChildren(...(rows.length ? rows.map((r) => h("button", { type: "button", role: "option", class: "result", onclick: () => {
        cur = { address: r.label, lat: r.lat, lng: r.lng }; pinned = true;
        map.setCenter(r.lat, r.lng, 17); addrOut.textContent = r.label; detail.value = r.label; results.replaceChildren(); q.value = "";
      } }, h("b", null, r.label.split(",")[0]), h("small", null, r.full))) : [h("p", { class: "muted pad" }, "Nothing found in Malaysia. Move the pin instead.")]));
    } catch {
      if (id === reqId) results.replaceChildren(h("p", { class: "muted pad" }, "Address search is not available right now. Move the pin and type the address."));
    }
  };
  q.addEventListener("input", () => { clearTimeout(t); t = setTimeout(doSearch, 900); });
  q.addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); clearTimeout(t); doSearch(); } });

  const onMoved = async (c) => {
    cur.lat = c.lat; cur.lng = c.lng; pinned = true;
    if (!KWMap.inMalaysia(c.lat, c.lng)) { addrOut.textContent = "This point is outside Malaysia."; return; }
    const id = ++reqId;
    addrOut.textContent = "Finding the address…";
    let label = null;
    try { label = await KWGeo.reverse(c.lat, c.lng); } catch { /* offline: keep the pin, the user types */ }
    if (id !== reqId) return;
    const text = label || `Pinned point ${c.lat.toFixed(5)}, ${c.lng.toFixed(5)}`;
    cur.address = text; addrOut.textContent = text; detail.value = text;
  };
  const map = KWMap.create(box, { center: [cur.lat, cur.lng], zoom: start ? 17 : 12, pin: true, onMoveEnd: onMoved });

  const close = () => { map.destroy(); ov.remove(); document.removeEventListener("keydown", esc); if (opener && opener.isConnected) opener.focus(); };
  const esc = (e) => { if (e.key === "Escape") close(); };
  const opener = document.activeElement;
  const ov = h("div", { class: "picker", role: "dialog", "aria-modal": "true", "aria-label": title },
    h("header", { class: "bar" }, h("button", { class: "icon-btn", "aria-label": "Close", onclick: close }, "×"), h("h1", { class: "bar-title" }, title), h("span", { class: "bar-sp" })),
    h("div", { class: "picker-search" }, q, results),
    box,
    h("div", { class: "picker-sheet" },
      addrOut,
      h("label", null, "Address shown to the escort", detail),
      h("div", { class: "row" },
        h("button", { type: "button", class: "btn ghost", onclick: () => {
          if (!navigator.geolocation) return toast("Location is not available on this device.", true);
          navigator.geolocation.getCurrentPosition((p) => { map.setCenter(p.coords.latitude, p.coords.longitude, 17); onMoved({ lat: p.coords.latitude, lng: p.coords.longitude }); },
            () => toast("Allow location access to use your position.", true), { enableHighAccuracy: true, timeout: 10000 });
        } }, "My location"),
        h("button", { type: "button", class: "btn grow", onclick: () => {
          const address = detail.value.trim();
          if (!address) return toast("Type the address or move the pin.", true);
          if (pinned && !KWMap.inMalaysia(cur.lat, cur.lng)) return toast("Choose a point in Malaysia.", true);
          close();
          onPick({ address, lat: pinned ? +cur.lat.toFixed(6) : null, lng: pinned ? +cur.lng.toFixed(6) : null });
        } }, "Confirm this place"))));
  document.body.append(ov);
  document.addEventListener("keydown", esc);
  q.focus();
}

// Route editor used by one-time trips and regular plans.
function stopsEditor(state, rerender) {
  const list = state.stops;
  const card = (s, i) => {
    const pick = h("button", { type: "button", class: "addr" + (s.address ? "" : " empty"), onclick: () => openPicker(s, i === 0 ? "Pick-up point" : "Drop-off " + LETTERS[i], (p) => { Object.assign(s, p); rerender(); }) },
      h("span", { class: "letter" + (i === 0 ? " k" : "") }, LETTERS[i]),
      h("span", { class: "grow" }, h("small", null, i === 0 ? "Pick up from" : "Take to"), h("b", null, s.address || "Choose on the map")),
      h("span", { class: "chev", "aria-hidden": "true" }, "›"));
    if (i === 0) return h("div", { class: "stop" }, pick);
    const r = s.receiver;
    return h("div", { class: "stop" }, pick,
      h("div", { class: "receiver" },
        h("small", null, "Hand over to"),
        seg([["parent", "Me"], ["trusted", "Trusted person"]], r.type, (v) => { r.type = v; rerender(); }, "Hand over to"),
        r.type === "trusted" ? h("div", { class: "grid2" },
          h("label", null, "Name", h("input", { type: "text", maxlength: "80", value: r.name || "", placeholder: "e.g. Grandma Siti", oninput: (e) => { r.name = e.target.value; } })),
          h("label", null, "Phone", h("input", { type: "tel", value: r.phone || "+60", oninput: (e) => { r.phone = e.target.value.trim(); } }))) : null,
        list.length > 2 ? h("button", { type: "button", class: "link danger", onclick: () => { list.splice(i, 1); rerender(); } }, "Remove this stop") : null));
  };
  return h("div", { class: "stops" }, list.map(card),
    list.length < 6 ? h("button", { type: "button", class: "btn ghost small", onclick: () => { list.push({ address: "", lat: null, lng: null, receiver: { type: "parent", name: "", phone: "+60" } }); rerender(); } }, "+ Add another stop") : null);
}
function stopsPayload(stops) {
  return stops.map((s, i) => {
    const o = { address: (s.address || "").trim() };
    if (s.lat != null && s.lng != null) { o.lat = s.lat; o.lng = s.lng; }
    if (i > 0) o.receiver = s.receiver.type === "trusted" ? { type: "trusted", name: (s.receiver.name || "").trim(), phone: s.receiver.phone } : { type: "parent" };
    return o;
  });
}
function freshStops() {
  const home = S.me && S.me.home;
  return [{ address: home ? home.address : "", lat: home ? home.lat : null, lng: home ? home.lng : null },
    { address: "", lat: null, lng: null, receiver: { type: "parent", name: "", phone: "+60" } }];
}
// Keep only children that still exist (a child may have been deleted or added in another tab).
function syncChildren(state, children) {
  const ids = new Set(children.map((c) => c.id));
  state.childIds = state.childIds.filter((id, i, a) => ids.has(id) && a.indexOf(id) === i);
  if (!state.childIds.length && children.length === 1) state.childIds = [children[0].id];
}
function childChips(children, state, rerender) {
  return h("div", { class: "chips" }, children.map((c) => {
    const on = state.childIds.includes(c.id);
    return h("button", { type: "button", class: "chip" + (on ? " on" : ""), "aria-pressed": String(on), onclick: () => {
      state.childIds = on ? state.childIds.filter((x) => x !== c.id) : [...state.childIds, c.id]; rerender();
    } }, h("span", { class: "av small" }, (c.name || "?").charAt(0)), c.name);
  }));
}
function serviceSelect(state, rerender) {
  return h("div", { class: "services" }, Object.entries(SERVICES).map(([k, [name, sub]]) =>
    h("button", { type: "button", class: "svc" + (state.service === k ? " on" : ""), "aria-pressed": String(state.service === k), onclick: () => { state.service = k; rerender(); } },
      h("span", { class: "svc-ic svc-" + k, "aria-hidden": "true" }), h("b", null, name), h("small", null, sub))));
}
// Prices are calculated on the server from the admin's settings.
function quoteBox(body) {
  const out = h("div", { class: "quote", "aria-live": "polite" }, h("span", { class: "muted" }, "Calculating price…"));
  api("POST", "/api/quote", body).then((q) => {
    out.replaceChildren(...[
      body.days ? h("div", { class: "kv big" }, h("span", null, "Per week"), h("b", null, money(q.week))) : h("div", { class: "kv big" }, h("span", null, "Total"), h("b", null, money(q.total))),
      h("div", { class: "kv" }, h("span", null, "Way there"), h("span", null, money(q.go))),
      q.back ? h("div", { class: "kv" }, h("span", null, "Way back"), h("span", null, money(q.back))) : null,
      body.days ? h("p", { class: "muted" }, `${money(q.total)} per day × ${body.days} day${body.days > 1 ? "s" : ""}, regular discount ${S.settings.regDiscount}% included.`) : null].filter(Boolean));
  }).catch(() => out.replaceChildren(h("span", { class: "muted" }, "Price shown after booking.")));
  return out;
}
function tripMap(stops, extra) {
  const box = h("div", { class: "map-card" });
  const m = KWMap.create(box, { zoom: 13 });
  S.maps.push(m);
  const pts = stops.map((s, i) => ({ lat: s.lat, lng: s.lng, label: LETTERS[i], kind: s.handedOverAt ? "done" : i === 0 ? "pickup" : "stop", title: s.address }));
  const all = extra ? [...pts, extra] : pts;
  m.setMarkers(all);
  const withGeo = all.filter((p) => p.lat != null);
  if (withGeo.length) requestAnimationFrame(() => m.fit(withGeo, 16));
  if (!withGeo.length) box.append(h("p", { class: "map-note" }, "No map points for this trip"));
  return { box, map: m, pts };
}


function tripRow(t) {
  return h("a", { class: "item", href: "#/trip/" + t.id },
    h("div", { class: "when" }, h("b", null, fmtTime(t.scheduledAt)), h("small", null, fmtDay(t.scheduledAt))),
    h("div", { class: "grow" },
      h("b", { class: "ell" }, routeText(t.stops)),
      h("div", { class: "row tight" }, statusPill(t.status), t.leg === "back" ? h("span", { class: "tag" }, "Way back") : t.groupId ? h("span", { class: "tag" }, "Way there") : null, t.planId ? h("span", { class: "tag reg" }, "Regular") : null)),
    h("span", { class: "chev", "aria-hidden": "true" }, "›"));
}

function profileScreen() {
  const me = S.me;
  const f = { name: me.name || "" };
  const save = h("button", { class: "btn", type: "submit" }, "Save");
  const install = S.installPrompt ? h("button", { class: "btn ghost block", onclick: async () => { S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; render(); } }, "Install " + APP.name + " on this device") : null;
  const logout = h("button", { class: "btn ghost block danger" }, "Log out");
  logout.addEventListener("click", () => run(async () => { await api("POST", "/api/auth/logout", {}); endSession(); go("/"); }, logout));
  return screen({ title: APP.id === "control" ? "Account" : "Profile", body: h("div", { class: "stack" },
    h("div", { class: "profile-head" }, h("span", { class: "av big" }, (me.name || "?").charAt(0)), h("div", null, h("b", null, me.name || "No name"), h("small", { class: "muted" }, me.phone + " · " + APP.name))),
    h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => { await api("PATCH", "/api/me", { name: f.name }); S.me = null; toast("Saved"); render(); }, save); } },
      h("label", null, "Name", h("input", { type: "text", maxlength: "80", value: f.name, oninput: (e) => { f.name = e.target.value; } })), save),
    me.role === "parent" ? section("Home address",
      h("p", null, me.home ? me.home.address : h("span", { class: "muted" }, "Not set. Used as the default pick-up point.")),
      h("div", { class: "row" },
        h("button", { class: "btn ghost", onclick: () => openPicker(me.home, "Home address", (p) => run(async () => { await api("PATCH", "/api/me", { home: p }); S.me = null; toast("Home saved"); render(); })) }, me.home ? "Change" : "Set on the map"),
        me.home ? h("button", { class: "link danger", onclick: () => run(async () => { await api("PATCH", "/api/me", { home: null }); S.me = null; render(); }) }, "Remove") : null)) : null,
    install || (window.matchMedia("(display-mode: standalone)").matches ? null : section(null, h("p", { class: "muted" }, "Install the app: open the browser menu and choose “Add to Home screen” or “Install app”."))),
    section("Your data",
      h("p", { class: "muted" }, "Names, health notes, addresses and phone numbers are encrypted. Live location is kept only during a trip and deleted when it ends. Every access is recorded in an audit log.")),
    logout) });
}


// =====================================================================
// PWA: install prompt and service worker
// =====================================================================
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installPrompt = e; });
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register(APP.sw).catch(() => { /* not available, e.g. self-signed certificate */ });
}

