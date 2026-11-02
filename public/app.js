// KidsWay app (parent, escort and admin). Talks only to this server's API, plus OpenStreetMap for the map.
// Security notes:
// - All text from the server is inserted with textContent (the h() helper), never innerHTML: no XSS.
// - The session token lives in sessionStorage (one tab = one user) and is sent as a Bearer header.
// - The page's Content-Security-Policy blocks inline scripts and every origin except the map hosts.
"use strict";

const $app = document.getElementById("app");
const $toast = document.getElementById("toast");

const S = {
  token: read("kw_token"),
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
  if (!res.ok) throw new ApiError(res.status, (data && data.error) || "error");
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
function endSession() { stopGps(); S.token = null; S.me = null; S.settings = null; S.codes = {}; S.book = null; S.plan = null; write("kw_token", null); }
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
function navItems(role) {
  if (role === "parent") return [["", "Home", "home"], ["trips", "Trips", "trips"], ["plans", "Plans", "plans"], ["children", "Children", "kids"], ["profile", "Profile", "me"]];
  if (role === "escort") return [["", "My trips", "trips"], ["profile", "Profile", "me"]];
  return [["", "Trips", "trips"], ["plans", "Plans", "plans"], ["hiring", "Hiring", "hire"], ["escorts", "Team", "kids"], ["prices", "Prices", "price"], ["audit", "Audit", "audit"]];
}
function screen({ title, back, actions, body, nav = true }) {
  const r = route();
  const top = h("header", { class: "bar" },
    back ? h("button", { class: "icon-btn", "aria-label": "Back", onclick: () => (history.length > 1 ? history.back() : go(back)) }, "‹") : h("span", { class: "logo", "aria-hidden": "true" }),
    h("h1", { class: "bar-title" }, title),
    actions || h("span", { class: "bar-sp" }));
  const items = nav && S.me ? navItems(S.me.role) : [];
  const navEl = items.length ? h("nav", { class: "tabbar" + (items.length > 5 ? " six" : ""), "aria-label": "Main" }, items.map(([p, label, ic]) => {
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
async function render() {
  const seq = ++renderSeq;
  cleanup();
  if (!S.token) { $app.replaceChildren(loginScreen()); return; }
  try {
    if (!S.me) S.me = await api("GET", "/api/me");
    if (!S.settings) S.settings = await api("GET", "/api/settings");
  } catch { endSession(); return render(); }
  const r = route();
  if (S.gps && !(r[0] === "trip" && r[1] === S.gps.tripId)) stopGps();
  let el;
  try {
    el = S.me.role === "parent" ? await parentRoute(r) : S.me.role === "escort" ? await escortRoute(r) : await adminRoute(r);
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
  const local = ["localhost", "127.0.0.1"].includes(location.hostname);
  const hero = h("div", { class: "hero" }, h("span", { class: "logo big", "aria-hidden": "true" }), h("p", { class: "wm" }, "Kids", h("b", null, "Way")),
    h("p", { class: "hero-sub" }, "A trusted escort takes your child from A to B and hands them only to the person you choose."));
  if (L.step === 1) {
    const phone = h("input", { type: "tel", value: L.phone, autocomplete: "tel", placeholder: "+60123456789", oninput: (e) => { L.phone = e.target.value.trim(); } });
    const name = h("input", { type: "text", value: L.name, autocomplete: "name", placeholder: "For new parents", oninput: (e) => { L.name = e.target.value; } });
    const btn = h("button", { class: "btn block", type: "submit" }, "Send SMS code");
    const form = h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
      const r = await api("POST", "/api/auth/otp/request", { phone: L.phone });
      L.challengeId = r.challengeId; L.devCode = r.devCode || null; L.code = ""; L.step = 2; render();
    }, btn); } }, h("label", null, "Mobile number", phone), h("label", null, "Your name", name), btn,
      h("p", { class: "muted center" }, "No passwords. We send a one-time code by SMS."));
    return h("div", { class: "login" }, hero, form, local ? h("details", { class: "card sun" }, h("summary", null, "Demo accounts on this computer"),
      h("p", { class: "muted" }, "Each browser tab is a separate user."),
      h("p", null, "Admin: ", h("b", null, "+60100000000")), h("p", null, "Parent: any number, e.g. +60123456789"), h("p", null, "Escort: a number the admin adds under Escorts")) : null);
  }
  const code = h("input", { type: "text", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", value: L.code, placeholder: "••••••", class: "code-input", oninput: (e) => { L.code = e.target.value.trim(); } });
  const btn = h("button", { class: "btn block", type: "submit" }, "Verify");
  return h("div", { class: "login" }, hero,
    L.devCode ? h("div", { class: "sms", role: "note" }, h("small", null, "SMS simulator · development only"), h("p", null, "Your KidsWay code is ", h("b", null, L.devCode))) : null,
    h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
      const r = await api("POST", "/api/auth/otp/verify", { phone: L.phone, challengeId: L.challengeId, code: L.code, name: L.name || undefined });
      S.token = r.token; write("kw_token", r.token); S.me = null; L.step = 1; L.devCode = null;
      go("/");
    }, btn); } },
    h("p", null, "Code sent to ", h("b", null, L.phone), ". Valid 5 minutes, 5 tries."),
    h("label", null, "SMS code", code), btn,
    h("button", { type: "button", class: "link", onclick: () => { L.step = 1; render(); } }, "Change number")));
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

// =====================================================================
// PARENT
// =====================================================================
async function parentRoute(r) {
  switch (r[0]) {
    case "trips": return parentTrips();
    case "trip": return parentTrip(r[1]);
    case "book": return bookScreen();
    case "booked": return bookedScreen();
    case "plans": return plansScreen();
    case "plan-new": return planNewScreen();
    case "plan": return planScreen(r[1]);
    case "children": return childrenScreen();
    case "profile": return profileScreen();
    default: return parentHome();
  }
}

async function parentHome() {
  const [{ children }, { trips }, { plans }] = await Promise.all([api("GET", "/api/children"), api("GET", "/api/trips"), api("GET", "/api/plans")]);
  const upcoming = trips.filter((t) => ["requested", "assigned", "in_progress"].includes(t.status)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const live = upcoming.find((t) => t.status === "in_progress");
  const first = (S.me.name || "").split(" ")[0];
  return screen({ title: "KidsWay", body: h("div", { class: "stack" },
    h("p", { class: "hello" }, first ? `Hi, ${first}` : "Hi there"),
    live ? h("a", { class: "card live-card", href: "#/trip/" + live.id }, h("span", { class: "pulse", "aria-hidden": "true" }), h("div", { class: "grow" }, h("b", null, "On the way now"), h("small", null, routeText(live.stops))), h("span", { class: "chev" }, "›")) : null,
    h("section", { class: "card where" },
      h("h2", null, "Where should your child go?"),
      h("button", { class: "search-like", onclick: () => go(children.length ? "/book" : "/children") }, h("span", { class: "dot", "aria-hidden": "true" }), children.length ? "Choose a destination" : "Add your child first"),
      h("div", { class: "grid2" },
        h("button", { class: "tile", onclick: () => go(children.length ? "/book" : "/children") }, h("span", { class: "tile-ic one", "aria-hidden": "true" }), h("b", null, "One-time trip"), h("small", null, "Once, or there and back")),
        h("button", { class: "tile", onclick: () => go(children.length ? "/plan-new" : "/children") }, h("span", { class: "tile-ic reg", "aria-hidden": "true" }), h("b", null, "Regular plan"), h("small", null, "Every week on your days")))),
    !children.length ? section(null, h("p", null, h("b", null, "Start by adding your child."), " Their health notes are encrypted and shown to the escort only during a trip."), h("button", { class: "btn", onclick: () => go("/children") }, "Add a child")) : null,
    section("Next trips", upcoming.length ? upcoming.slice(0, 3).map(tripRow) : empty("No trips planned."),
      upcoming.length > 3 ? h("a", { class: "link", href: "#/trips" }, "All trips") : null),
    plans.filter((p) => p.status === "active").length ? section("Regular plans", plans.filter((p) => p.status === "active").map(planRow)) : null) });
}

function tripRow(t) {
  return h("a", { class: "item", href: "#/trip/" + t.id },
    h("div", { class: "when" }, h("b", null, fmtTime(t.scheduledAt)), h("small", null, fmtDay(t.scheduledAt))),
    h("div", { class: "grow" },
      h("b", { class: "ell" }, routeText(t.stops)),
      h("div", { class: "row tight" }, statusPill(t.status), t.leg === "back" ? h("span", { class: "tag" }, "Way back") : t.groupId ? h("span", { class: "tag" }, "Way there") : null, t.planId ? h("span", { class: "tag reg" }, "Regular") : null)),
    h("span", { class: "chev", "aria-hidden": "true" }, "›"));
}
function planRow(p) {
  return h("a", { class: "item", href: "#/plan/" + p.id },
    h("span", { class: "tile-ic reg sm", "aria-hidden": "true" }),
    h("div", { class: "grow" }, h("b", null, daysText(p.days) + " · " + p.goTime + (p.dir === "round" ? " / " + p.backTime : "")), h("small", { class: "ell" }, routeText(p.go))),
    h("span", { class: "pill " + (p.status === "active" ? "ok" : p.status === "paused" ? "warn" : "bad") }, p.status));
}

async function parentTrips() {
  const { trips } = await api("GET", "/api/trips");
  const up = trips.filter((t) => ["requested", "assigned", "in_progress"].includes(t.status)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const past = trips.filter((t) => !up.includes(t));
  const list = S.tripsTab === "upcoming" ? up : past;
  const groups = [];
  for (const t of list) { const d = fmtDay(t.scheduledAt); const g = groups[groups.length - 1]; if (g && g[0] === d) g[1].push(t); else groups.push([d, [t]]); }
  return screen({ title: "Trips", actions: h("button", { class: "icon-btn plus", "aria-label": "Book a trip", onclick: () => go("/book") }, "+"), body: h("div", { class: "stack" },
    seg([["upcoming", `Upcoming (${up.length})`], ["past", "Past"]], S.tripsTab, (v) => { S.tripsTab = v; render(); }, "Which trips"),
    groups.length ? groups.map(([d, ts]) => h("section", { class: "card" }, h("h2", { class: "day" }, d), ts.map(tripRow))) : empty(S.tripsTab === "upcoming" ? "No upcoming trips." : "No past trips yet.", S.tripsTab === "upcoming" ? h("button", { class: "btn", onclick: () => go("/book") }, "Book a trip") : null)) });
}

// ---------- one-time booking ----------
async function bookScreen() {
  const { children } = await api("GET", "/api/children");
  if (!children.length) { go("/children"); return screen({ title: "Book", body: empty("Add a child first.") }); }
  if (!S.book) {
    const d = new Date(Date.now() + 60 * 60 * 1000); d.setMinutes(Math.ceil(d.getMinutes() / 15) * 15, 0, 0);
    const b = new Date(d.getTime() + 6 * 3600 * 1000);
    S.book = { childIds: children.length === 1 ? [children[0].id] : [], service: "car", when: localInput(d), round: false, backWhen: localInput(b), stops: freshStops() };
  }
  const B = S.book;
  syncChildren(B, children);
  const rerender = () => render();
  const drops = B.stops.length - 1;
  const ready = B.childIds.length && B.stops.every((s) => s.address);
  const btn = h("button", { class: "btn block big", disabled: !ready }, B.round ? "Book there and back" : "Book trip");
  btn.addEventListener("click", () => run(async () => {
    syncChildren(B, (await api("GET", "/api/children")).children);
    if (!B.childIds.length) throw new Error("Choose at least one child.");
    const at = Math.floor(new Date(B.when).getTime() / 1000);
    const body = { childIds: B.childIds, service: B.service, scheduledAt: at, stops: stopsPayload(B.stops) };
    if (B.round) body.back = { scheduledAt: Math.floor(new Date(B.backWhen).getTime() / 1000) };
    if (B.round && body.back.scheduledAt <= at) throw new Error("The way back must be after the way there.");
    const r = await api("POST", "/api/trips", body);
    remember(r.trip.id, r.handoverCodes);
    if (r.back) remember(r.back.trip.id, r.back.handoverCodes);
    S.lastBooking = r; S.book = null;
    go("/booked");
  }, btn));
  return screen({ title: "One-time trip", back: "/", body: h("div", { class: "stack" },
    section("Who is going?", childChips(children, B, rerender)),
    section("Route", stopsEditor(B, rerender)),
    section("When",
      h("label", null, "Pick-up time", h("input", { type: "datetime-local", value: B.when, min: localInput(new Date()), onchange: (e) => { B.when = e.target.value; rerender(); } })),
      sw("There and back", B.round, (v) => { B.round = v; rerender(); }, "Bring the child back on the same booking"),
      B.round ? h("div", { class: "stack-s" },
        h("label", null, "Way back pick-up time", h("input", { type: "datetime-local", value: B.backWhen, onchange: (e) => { B.backWhen = e.target.value; rerender(); } })),
        h("p", { class: "muted" }, `Way back: from ${short(B.stops[B.stops.length - 1].address) || "the last stop"} to ${short(B.stops[0].address) || "the pick-up point"}, handed over to you. It gets its own handover code.`)) : null),
    section("How", serviceSelect(B, rerender)),
    section("Price", quoteBox({ kids: Math.max(1, B.childIds.length), drops, ...(B.round ? { backDrops: 1 } : {}) })),
    btn,
    !ready ? h("p", { class: "muted center" }, "Choose a child and every address to continue.") : null) });
}
function remember(tripId, codes) { S.codes[tripId] = Object.assign(S.codes[tripId] || {}, Object.fromEntries(codes.map((c) => [c.seq, c.code]))); }

function codeCard(trip, codes, label) {
  return h("div", { class: "codebox" },
    h("div", { class: "row" }, h("b", { class: "grow" }, label), h("span", { class: "muted" }, fmtWhen(trip.scheduledAt))),
    codes.map((c) => {
      const s = trip.stops[c.seq];
      return h("div", { class: "code-row" }, h("span", { class: "letter" }, LETTERS[c.seq]),
        h("div", { class: "grow" }, h("small", null, s.receiverType === "trusted" ? "Give to " + s.receiverName : "Your own code (you receive)"), h("small", { class: "ell" }, short(s.address))),
        h("span", { class: "code" }, c.code));
    }));
}
function bookedScreen() {
  const r = S.lastBooking;
  if (!r) { go("/trips"); return screen({ title: "Booked", body: empty("") }); }
  return screen({ title: "Booked", body: h("div", { class: "stack" },
    h("div", { class: "done-hero" }, h("span", { class: "check-big", "aria-hidden": "true" }), h("h2", null, "Your trip is booked"), h("p", { class: "muted" }, "We are finding an escort. You will see their name in the trip.")),
    section("Handover codes",
      h("p", null, "The escort hands your child over only after the receiver says this code. ", h("b", null, "Send each code only to that person.")),
      codeCard(r.trip, r.handoverCodes, r.back ? "Way there" : "Trip"),
      r.back ? codeCard(r.back.trip, r.back.handoverCodes, "Way back") : null,
      h("p", { class: "muted" }, "Codes are stored only as a fingerprint on our server. If one is lost, open the trip and get a new code.")),
    h("div", { class: "kv big card" }, h("span", null, "Total"), h("b", null, money(r.price))),
    h("button", { class: "btn block", onclick: () => go("/trip/" + r.trip.id) }, "Open trip"),
    h("button", { class: "btn ghost block", onclick: () => go("/") }, "Home")) });
}

// ---------- trip detail (parent) ----------
async function parentTrip(id) {
  const [t, { children }, { trips }] = await Promise.all([api("GET", "/api/trips/" + id), api("GET", "/api/children"), api("GET", "/api/trips")]);
  const names = t.childIds.map((cid) => (children.find((c) => c.id === cid) || {}).name).filter(Boolean).join(", ");
  const sibling = t.groupId ? trips.find((x) => x.groupId === t.groupId && x.id !== t.id) : null;
  const escortMarker = { lat: null, lng: null, label: "", kind: "escort", title: "Escort" };
  const mp = tripMap(t.stops, t.status === "in_progress" ? escortMarker : null);
  const liveLine = h("p", { class: "muted" });
  if (t.status === "in_progress") {
    const poll = async () => {
      try {
        const l = await api("GET", `/api/trips/${t.id}/location`);
        if (l.lat != null) {
          escortMarker.lat = l.lat; escortMarker.lng = l.lng;
          mp.map.setMarkers([...mp.pts, escortMarker]);
          if (!poll.fitted) { mp.map.fit([...mp.pts, escortMarker].filter((p) => p.lat != null), 16); poll.fitted = true; }
          liveLine.textContent = "Escort location updated " + fmtTime(l.at);
        } else liveLine.textContent = "Waiting for the escort's location…";
      } catch { /* the trip may have just finished */ }
    };
    poll(); every(5000, poll);
    every(15000, async () => { try { const n = await api("GET", "/api/trips/" + t.id); if (n.status !== t.status || JSON.stringify(n.stops) !== JSON.stringify(t.stops)) render(); } catch { /* ignore */ } });
  }
  const cancelBtn = ["requested", "assigned"].includes(t.status) ? h("button", { class: "btn ghost block danger" }, "Cancel trip") : null;
  if (cancelBtn) cancelBtn.addEventListener("click", () => run(async () => {
    if (cancelBtn.dataset.sure !== "1") { cancelBtn.dataset.sure = "1"; cancelBtn.textContent = "Tap again to cancel"; return; }
    await api("POST", `/api/trips/${t.id}/cancel`, {}); toast("Trip cancelled"); render();
  }, cancelBtn));

  return screen({ title: t.leg === "back" ? "Way back" : t.groupId ? "Way there" : "Trip", back: "/trips", body: h("div", { class: "stack" },
    mp.box,
    section(null,
      h("div", { class: "row" }, h("div", { class: "grow" }, h("b", { class: "big-when" }, fmtWhen(t.scheduledAt)), h("small", { class: "muted" }, names + " · " + SERVICES[t.service][0])), statusPill(t.status)),
      t.status === "in_progress" ? liveLine : null,
      h("div", { class: "kv" }, h("span", null, "Escort"), h("b", null, t.escortName || "Finding an escort…")),
      t.price != null ? h("div", { class: "kv" }, h("span", null, "Price"), h("b", null, money(t.price))) : null,
      t.planId ? h("a", { class: "link", href: "#/plan/" + t.planId }, "Part of a regular plan ›") : null,
      sibling ? h("a", { class: "link", href: "#/trip/" + sibling.id }, (sibling.leg === "back" ? "Way back: " : "Way there: ") + fmtWhen(sibling.scheduledAt) + " ›") : null),
    section("Stops", t.stops.map((s, i) => parentStop(t, s, i))),
    cancelBtn) });
}

function parentStop(t, s, i) {
  const head = h("div", { class: "row" }, h("span", { class: "letter" + (i === 0 ? " k" : "") }, LETTERS[i]),
    h("div", { class: "grow" }, h("b", null, s.address), i > 0 ? h("small", { class: "muted" }, s.receiverType === "trusted" ? `Hand to ${s.receiverName} · ${s.receiverPhone}` : "Hand to you") : h("small", { class: "muted" }, "Pick-up")));
  if (i === 0) return h("div", { class: "stop" }, head);
  const box = h("div", { class: "stop" }, head);
  const known = S.codes[t.id] && S.codes[t.id][s.seq];
  const open = ["requested", "assigned", "in_progress"].includes(t.status);
  if (!s.handedOverAt && open) {
    if (known && !s.codeLocked) box.append(h("div", { class: "code-row" }, h("small", { class: "grow" }, "Handover code"), h("span", { class: "code" }, known)));
    if (s.codeLocked) box.append(h("p", { class: "alert" }, "Locked after 5 wrong codes. Check who is at the door, then issue a new code."));
    if (!known || s.codeLocked) {
      const b = h("button", { class: "btn small" + (s.codeIssued && !s.codeLocked ? " ghost" : "") }, !s.codeIssued ? "Get handover code" : s.codeLocked ? "Issue a new code" : "Lost the code? Get a new one");
      b.addEventListener("click", () => run(async () => {
        if (s.codeIssued && !s.codeLocked && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "The old code will stop working. Tap again"; return; }
        const r = await api("POST", `/api/trips/${t.id}/stops/${s.seq}/reissue-code`, {});
        remember(t.id, [r]); toast("New code ready. Send it only to the receiver."); render();
      }, b));
      box.append(b);
      if (!s.codeIssued) box.append(h("small", { class: "muted" }, "Regular trips get their code here, so it is never stored in readable form."));
    }
  }
  if (s.handedOverAt) {
    box.append(h("p", { class: "ok-line" }, "Handed over at " + fmtTime(s.handedOverAt)));
    const img = h("img", { class: "photo", alt: "Handover photo" });
    img.hidden = true;
    if (s.hasPhoto) {
      const pb = h("button", { class: "btn ghost small" }, "View photo report");
      pb.addEventListener("click", () => run(async () => {
        const r = await api("GET", `/api/trips/${t.id}/stops/${s.seq}/photo-url`);
        img.src = r.url; img.hidden = false; pb.textContent = "Link valid " + Math.round(r.expiresIn / 60) + " min";
      }, pb));
      box.append(pb, img);
    } else box.append(h("small", { class: "muted" }, "Waiting for the escort's photo…"));
    if (!s.confirmedAt) {
      const cb = h("button", { class: "btn small" }, "Confirm handover");
      cb.addEventListener("click", () => run(async () => {
        const r = await api("POST", `/api/trips/${t.id}/stops/${s.seq}/confirm`, {});
        toast(r.tripCompleted ? "Trip complete. Location history deleted." : "Confirmed"); render();
      }, cb));
      box.append(cb);
    } else box.append(h("small", { class: "muted" }, "Confirmed by you"));
  }
  return box;
}

// ---------- regular plans ----------
async function plansScreen() {
  const { plans } = await api("GET", "/api/plans");
  return screen({ title: "Regular plans", actions: h("button", { class: "icon-btn plus", "aria-label": "New plan", onclick: () => go("/plan-new") }, "+"), body: h("div", { class: "stack" },
    section(null, h("p", null, "School runs and classes every week: choose the days and times once, and the trips are created a week ahead with the same escort."),
      h("button", { class: "btn", onclick: () => go("/plan-new") }, "New regular plan")),
    plans.length ? section("My plans", plans.map(planRow)) : empty("No regular plans yet.")) });
}

async function planNewScreen() {
  const { children } = await api("GET", "/api/children");
  if (!children.length) { go("/children"); return screen({ title: "Plan", body: empty("") }); }
  if (!S.plan) S.plan = { childIds: children.length === 1 ? [children[0].id] : [], service: "car", dir: "round", days: ["mon", "tue", "wed", "thu", "fri"], goTime: "07:00", backTime: "14:00", custom: false, overrides: {}, startDate: todayStr(), endDate: "", stops: freshStops() };
  const P = S.plan;
  syncChildren(P, children);
  const rerender = () => render();
  const toggleDay = (d) => { P.days = P.days.includes(d) ? P.days.filter((x) => x !== d) : [...P.days, d]; rerender(); };
  const ready = P.childIds.length && P.days.length && P.stops.every((s) => s.address);
  const btn = h("button", { class: "btn block big", disabled: !ready }, "Create plan");
  btn.addEventListener("click", () => run(async () => {
    const overrides = {};
    if (P.custom) for (const d of P.days) {
      const o = P.overrides[d] || {}, v = {};
      if (o.goTime && o.goTime !== P.goTime) v.goTime = o.goTime;
      if (P.dir === "round" && o.backTime && o.backTime !== P.backTime) v.backTime = o.backTime;
      if (Object.keys(v).length) overrides[d] = v;
    }
    const body = { childIds: P.childIds, service: P.service, dir: P.dir, days: P.days, goTime: P.goTime, startDate: P.startDate, go: stopsPayload(P.stops), overrides };
    if (P.dir === "round") body.backTime = P.backTime;
    if (P.endDate) body.endDate = P.endDate;
    const r = await api("POST", "/api/plans", body);
    S.plan = null; toast(`Plan created: ${r.tripsCreated} trips scheduled for the coming week`); go("/plan/" + r.plan.id);
  }, btn));
  const drops = P.stops.length - 1;
  return screen({ title: "Regular plan", back: "/plans", body: h("div", { class: "stack" },
    section("Who is going?", childChips(children, P, rerender)),
    section("Days",
      h("div", { class: "days" }, DAY_ORDER.map((d) => h("button", { type: "button", class: "day-btn" + (P.days.includes(d) ? " on" : ""), "aria-pressed": String(P.days.includes(d)), onclick: () => toggleDay(d) }, DAY_NAMES[d]))),
      h("div", { class: "row tight" },
        h("button", { type: "button", class: "link", onclick: () => { P.days = ["mon", "tue", "wed", "thu", "fri"]; rerender(); } }, "School days"),
        h("button", { type: "button", class: "link", onclick: () => { P.days = [...DAY_ORDER]; rerender(); } }, "Every day"))),
    section("Direction and time",
      seg([["one", "One way"], ["round", "There and back"]], P.dir, (v) => { P.dir = v; rerender(); }, "Direction"),
      h("div", { class: "grid2" },
        h("label", null, "Pick-up there", h("input", { type: "time", value: P.goTime, onchange: (e) => { P.goTime = e.target.value; rerender(); } })),
        P.dir === "round" ? h("label", null, "Pick-up back", h("input", { type: "time", value: P.backTime, onchange: (e) => { P.backTime = e.target.value; rerender(); } })) : h("span")),
      sw("Different times on some days", P.custom, (v) => { P.custom = v; rerender(); }, "e.g. Friday ends earlier"),
      P.custom ? h("div", { class: "override-list" }, DAY_ORDER.filter((d) => P.days.includes(d)).map((d) => {
        const o = P.overrides[d] || (P.overrides[d] = { goTime: P.goTime, backTime: P.backTime });
        return h("div", { class: "override" }, h("b", null, DAY_NAMES[d]),
          h("input", { type: "time", value: o.goTime, "aria-label": DAY_NAMES[d] + " there", onchange: (e) => { o.goTime = e.target.value; } }),
          P.dir === "round" ? h("input", { type: "time", value: o.backTime, "aria-label": DAY_NAMES[d] + " back", onchange: (e) => { o.backTime = e.target.value; } }) : null);
      })) : null),
    section("Route", stopsEditor(P, rerender), P.dir === "round" ? h("p", { class: "muted" }, "The way back goes from the last stop to the pick-up point and is handed to you.") : null),
    section("Dates",
      h("div", { class: "grid2" },
        h("label", null, "Starts", h("input", { type: "date", value: P.startDate, min: todayStr(), onchange: (e) => { P.startDate = e.target.value; } })),
        h("label", null, "Ends (optional)", h("input", { type: "date", value: P.endDate, min: P.startDate, onchange: (e) => { P.endDate = e.target.value; } })))),
    section("How", serviceSelect(P, rerender)),
    section("Price", quoteBox({ kids: Math.max(1, P.childIds.length), drops, ...(P.dir === "round" ? { backDrops: 1 } : {}), days: Math.max(1, P.days.length) })),
    btn,
    h("p", { class: "muted center" }, "Trips are created one week ahead. You get each trip's handover code in the app.")) });
}

async function planScreen(id) {
  const [p, { trips }, { children }] = await Promise.all([api("GET", "/api/plans/" + id), api("GET", "/api/trips"), api("GET", "/api/children")]);
  const next = trips.filter((t) => t.planId === p.id && ["requested", "assigned", "in_progress"].includes(t.status)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const names = p.childIds.map((cid) => (children.find((c) => c.id === cid) || {}).name).filter(Boolean).join(", ");
  const mp = tripMap(p.go);
  const act = (status, label, cls) => {
    const b = h("button", { class: "btn " + (cls || "ghost") }, label);
    b.addEventListener("click", () => run(async () => {
      if (status === "ended" && b.dataset.sure !== "1") { b.dataset.sure = "1"; b.textContent = "Tap again to end the plan"; return; }
      await api("POST", `/api/plans/${p.id}/status`, { status }); toast("Plan " + status); render();
    }, b));
    return b;
  };
  const ov = Object.entries(p.overrides || {});
  return screen({ title: "Regular plan", back: "/plans", body: h("div", { class: "stack" },
    mp.box,
    section(null,
      h("div", { class: "row" }, h("div", { class: "grow" }, h("b", { class: "big-when" }, daysText(p.days)), h("small", { class: "muted" }, names + " · " + SERVICES[p.service][0])),
        h("span", { class: "pill " + (p.status === "active" ? "ok" : p.status === "paused" ? "warn" : "bad") }, p.status)),
      h("div", { class: "kv" }, h("span", null, "There"), h("b", null, p.goTime)),
      p.dir === "round" ? h("div", { class: "kv" }, h("span", null, "Back"), h("b", null, p.backTime)) : null,
      ov.length ? h("div", { class: "kv" }, h("span", null, "Special days"), h("b", null, ov.map(([d, v]) => `${DAY_NAMES[d]} ${v.goTime || p.goTime}${p.dir === "round" ? "/" + (v.backTime || p.backTime) : ""}`).join(", "))) : null,
      h("div", { class: "kv" }, h("span", null, "Dates"), h("b", null, p.startDate + (p.endDate ? " – " + p.endDate : " onwards"))),
      h("div", { class: "kv" }, h("span", null, "Regular escort"), h("b", null, p.escortName || "Being assigned")),
      h("div", { class: "kv" }, h("span", null, "Per week"), h("b", null, money(p.priceWeek)))),
    section("Route", p.go.map((s, i) => h("div", { class: "row" }, h("span", { class: "letter" + (i === 0 ? " k" : "") }, LETTERS[i]), h("div", { class: "grow" }, h("b", null, s.address), i > 0 ? h("small", { class: "muted" }, s.receiverType === "trusted" ? "Hand to " + s.receiverName : "Hand to you") : null)))),
    section("Coming trips", next.length ? next.slice(0, 6).map(tripRow) : empty(p.status === "active" ? "New trips appear here a week ahead." : "Paused: no trips are scheduled.")),
    p.status !== "ended" ? h("div", { class: "row" }, p.status === "active" ? act("paused", "Pause") : act("active", "Resume", ""), act("ended", "End plan", "ghost danger")) : null) });
}

// ---------- children ----------
async function childrenScreen() {
  const { children } = await api("GET", "/api/children");
  const f = { name: "", dob: "", medical: "", notes: "" };
  const field = (label, key, attrs, tag) => h("label", null, label, h(tag || "input", { ...attrs, oninput: (e) => { f[key] = e.target.value; } }));
  const save = h("button", { class: "btn block", type: "submit" }, "Save child");
  return screen({ title: "Children", body: h("div", { class: "stack" },
    children.length ? section("My children", children.map((c) => {
      const del = h("button", { class: "btn ghost small" }, "Delete");
      del.addEventListener("click", () => run(async () => {
        if (del.dataset.sure !== "1") { del.dataset.sure = "1"; del.textContent = "Tap again"; return; }
        await api("DELETE", "/api/children/" + c.id); toast("Deleted. The data is erased."); render();
      }, del));
      return h("div", { class: "item" }, h("span", { class: "av" }, (c.name || "?").charAt(0)),
        h("div", { class: "grow" }, h("b", null, c.name), h("small", { class: "muted" }, [c.dob ? "Born " + c.dob : null, c.medical ? "Health: " + c.medical : null].filter(Boolean).join(" · ") || "No details")), del);
    })) : null,
    h("form", { class: "card", onsubmit: (e) => { e.preventDefault(); run(async () => {
      await api("POST", "/api/children", { name: f.name, dob: f.dob || undefined, medical: f.medical || undefined, notes: f.notes || undefined });
      toast("Child added"); render();
    }, save); } },
      h("h2", null, children.length ? "Add another child" : "Add your child"),
      field("Name", "name", { type: "text", maxlength: "60", required: true }),
      field("Date of birth", "dob", { type: "date", max: todayStr() }),
      field("Allergies and health", "medical", { type: "text", maxlength: "300", placeholder: "e.g. peanut allergy, asthma inhaler in bag" }),
      field("Notes for the escort", "notes", { rows: "2", maxlength: "300", placeholder: "e.g. shy with strangers, likes dinosaurs" }, "textarea"),
      h("p", { class: "muted lock" }, "Encrypted on our server. The escort sees health notes only during your child's trip, never the date of birth."),
      save)) });
}

// ---------- profile ----------
function profileScreen() {
  const me = S.me;
  const f = { name: me.name || "" };
  const save = h("button", { class: "btn", type: "submit" }, "Save");
  const install = S.installPrompt ? h("button", { class: "btn ghost block", onclick: async () => { S.installPrompt.prompt(); await S.installPrompt.userChoice; S.installPrompt = null; render(); } }, "Install KidsWay on this device") : null;
  const logout = h("button", { class: "btn ghost block danger" }, "Log out");
  logout.addEventListener("click", () => run(async () => { await api("POST", "/api/auth/logout", {}); endSession(); go("/"); }, logout));
  return screen({ title: "Profile", body: h("div", { class: "stack" },
    h("div", { class: "profile-head" }, h("span", { class: "av big" }, (me.name || "?").charAt(0)), h("div", null, h("b", null, me.name || "No name"), h("small", { class: "muted" }, me.phone + " · " + me.role))),
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
// ESCORT
// =====================================================================
async function escortRoute(r) {
  if (r[0] === "trip") return escortTrip(r[1]);
  if (r[0] === "profile") return profileScreen();
  return escortTrips();
}

async function escortTrips() {
  const { trips } = await api("GET", "/api/trips");
  const open = trips.filter((t) => ["assigned", "in_progress"].includes(t.status)).sort((a, b) => a.scheduledAt - b.scheduledAt);
  const done = trips.filter((t) => !open.includes(t)).slice(0, 10);
  every(20000, () => render());
  return screen({ title: "My trips", body: h("div", { class: "stack" },
    section("To do", open.length ? open.map(tripRow) : empty("No trips assigned yet.")),
    done.length ? section("Done", done.map(tripRow)) : null) });
}

async function escortTrip(id) {
  const t = await api("GET", "/api/trips/" + id);
  const kids = await Promise.all(t.childIds.map((cid) => api("GET", "/api/children/" + cid).catch(() => null)));
  const me = { lat: S.gps && S.gps.last ? S.gps.last.lat : null, lng: S.gps && S.gps.last ? S.gps.last.lng : null, label: "", kind: "me", title: "You" };
  const mp = tripMap(t.stops, me);
  const live = t.status === "in_progress";
  const gpsLine = h("p", { class: "muted" }, S.gps ? "Sharing your location with the parent" : "Location not shared yet");
  const updateMe = (lat, lng) => { me.lat = lat; me.lng = lng; mp.map.setMarkers([...mp.pts, me]); gpsLine.textContent = "Location sent " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };

  const startBtn = t.status === "assigned" ? h("button", { class: "btn block big" }, "Start trip") : null;
  if (startBtn) startBtn.addEventListener("click", () => run(async () => { await api("POST", `/api/trips/${t.id}/start`, {}); toast("Trip started. Share your location."); render(); }, startBtn));

  const gpsBtn = live ? h("button", { class: "btn" + (S.gps && !S.gps.sim ? " ghost" : "") }, S.gps && !S.gps.sim ? "Stop sharing" : "Share my GPS location") : null;
  if (gpsBtn) gpsBtn.addEventListener("click", () => {
    if (S.gps && !S.gps.sim) { stopGps(); render(); return; }
    startGps(t.id, updateMe, false);
    gpsBtn.textContent = "Stop sharing"; gpsBtn.classList.add("ghost");
  });
  const simBtn = live ? h("button", { class: "btn ghost small" }, S.gps && S.gps.sim ? "Stop simulation" : "Simulate driving (demo)") : null;
  if (simBtn) simBtn.addEventListener("click", () => {
    if (S.gps && S.gps.sim) { stopGps(); render(); return; }
    startGps(t.id, updateMe, t.stops);
    simBtn.textContent = "Stop simulation";
  });

  return screen({ title: "Trip", back: "/", body: h("div", { class: "stack" },
    mp.box,
    section(null,
      h("div", { class: "row" }, h("div", { class: "grow" }, h("b", { class: "big-when" }, fmtWhen(t.scheduledAt)), h("small", { class: "muted" }, SERVICES[t.service][0])), statusPill(t.status)),
      live ? h("div", { class: "stack-s" }, gpsLine, h("div", { class: "row" }, gpsBtn, simBtn)) : null),
    startBtn,
    section("Children", kids.filter(Boolean).map((c) => h("div", { class: "item" }, h("span", { class: "av" }, c.name.charAt(0)),
      h("div", { class: "grow" }, h("b", null, c.name), c.medical ? h("p", { class: "alert soft" }, "Health: " + c.medical) : null, c.notes ? h("small", { class: "muted" }, c.notes) : null)))),
    section("Stops", t.stops.map((s, i) => escortStop(t, s, i)))) });
}

function escortStop(t, s, i) {
  const box = h("div", { class: "stop" }, h("div", { class: "row" }, h("span", { class: "letter" + (i === 0 ? " k" : "") }, LETTERS[i]),
    h("div", { class: "grow" }, h("b", null, s.address), i > 0 ? h("small", { class: "muted" }, s.receiverType === "trusted" ? "Hand only to " + s.receiverName : "Hand only to the parent") : h("small", { class: "muted" }, "Pick-up")),
    s.lat != null ? h("a", { class: "btn ghost small", href: `https://www.google.com/maps/dir/?api=1&destination=${s.lat},${s.lng}`, target: "_blank", rel: "noopener noreferrer" }, "Navigate") : null));
  if (i === 0 || t.status !== "in_progress") return box;
  if (!s.handedOverAt) {
    let code = "";
    const input = h("input", { type: "text", inputmode: "numeric", maxlength: "6", placeholder: "Code from the receiver", class: "code-input", oninput: (e) => { code = e.target.value.trim(); } });
    const b = h("button", { class: "btn" }, "Check code");
    b.addEventListener("click", () => run(async () => { await api("POST", `/api/trips/${t.id}/stops/${s.seq}/handover`, { code }); toast("Code correct. Hand over the child and take a photo."); render(); }, b));
    box.append(s.codeLocked ? h("p", { class: "alert" }, "Locked after 5 wrong codes. Do not hand over. Call the parent.") : h("div", { class: "row" }, h("div", { class: "grow" }, input), b));
  } else if (!s.hasPhoto) {
    const file = h("input", { type: "file", accept: "image/jpeg,image/png", capture: "environment", class: "visually-hidden", id: `ph-${s.seq}` });
    file.addEventListener("change", () => run(async () => {
      const f = file.files && file.files[0];
      if (!f) return;
      const data = await compressPhoto(f);
      await api("POST", `/api/trips/${t.id}/stops/${s.seq}/photo`, { mime: "image/jpeg", data });
      toast("Photo sent to the parent"); render();
    }));
    box.append(h("p", { class: "ok-line" }, "Handed over at " + fmtTime(s.handedOverAt)), h("label", { class: "btn", for: `ph-${s.seq}` }, "Take handover photo"), file);
  } else {
    box.append(h("p", { class: "ok-line" }, s.confirmedAt ? "Done. The parent confirmed." : "Photo sent. Waiting for the parent to confirm."));
  }
  return box;
}

// Photos are resized on the phone to a JPEG under the 2 MB limit (also strips camera metadata such as GPS).
async function compressPhoto(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  for (const q of [0.82, 0.7, 0.55]) {
    const url = c.toDataURL("image/jpeg", q);
    const b64 = url.slice(url.indexOf(",") + 1);
    if (b64.length * 0.75 < 1.9 * 1024 * 1024) return b64;
  }
  throw new Error("The photo is too large.");
}

// Location sharing: real GPS (watchPosition) or a simulation along the route for demos.
function startGps(tripId, onSent, simStops) {
  stopGps();
  const g = { tripId, watchId: null, sim: !!simStops, timer: 0, last: null, sentAt: 0 };
  S.gps = g;
  const send = async (lat, lng, force) => {
    if (!force && Date.now() - g.sentAt < 8000) return; // at most one point every 8 s
    g.sentAt = Date.now(); g.last = { lat, lng };
    try { await api("POST", `/api/trips/${tripId}/location`, { lat, lng }); onSent(lat, lng); }
    catch (e) { if (e.code === "trip_not_in_progress") stopGps(); else toast(msg(e), true); }
  };
  if (simStops) {
    const pts = simStops.filter((s) => s.lat != null);
    const path = pts.length >= 2 ? pts : [{ lat: 3.1319, lng: 101.6713 }, { lat: 3.1478, lng: 101.6596 }];
    let k = 0; const steps = 20;
    const tick = () => {
      const seg = Math.min(path.length - 2, Math.floor(k / steps)), f = (k % steps) / steps;
      const a = path[seg], b = path[seg + 1];
      send(a.lat + (b.lat - a.lat) * f, a.lng + (b.lng - a.lng) * f, true);
      if (k < (path.length - 1) * steps) k++;
    };
    tick(); g.timer = setInterval(tick, 3000);
  } else {
    if (!navigator.geolocation) { toast("GPS is not available on this device.", true); S.gps = null; return; }
    g.watchId = navigator.geolocation.watchPosition((p) => send(p.coords.latitude, p.coords.longitude, !g.last),
      (err) => { toast(err.code === 1 ? "Allow location access for KidsWay to share your position." : "Could not get GPS position.", true); }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 20000 });
  }
}
function stopGps() {
  if (!S.gps) return;
  if (S.gps.watchId != null) navigator.geolocation.clearWatch(S.gps.watchId);
  clearInterval(S.gps.timer);
  S.gps = null;
}

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
    section(null, h("p", null, "New Guardians join through ", h("a", { class: "link", href: "#/hiring" }, "Hiring"), ": they apply on the careers page, pass every security check and are approved by two officers.")),
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

  // Officer upload, e.g. the e-DKK result received from JKM.
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
      missing.length ? h("small", { class: "bad-text" }, "Evidence needed: " + missing.map((k) => DOC_NAMES[k]).join(", ")) : null,
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
        h("select", { "aria-label": "Document type", class: "grow", onchange: (e) => { upKind = e.target.value; } }, ["edkk_result", "police_cert", "first_aid_cert", "reference_notes", "interview_form", "other"].map((k) => h("option", { value: k }, DOC_NAMES[k]))),
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

// =====================================================================
// PWA: install prompt and service worker
// =====================================================================
window.addEventListener("beforeinstallprompt", (e) => { e.preventDefault(); S.installPrompt = e; });
if ("serviceWorker" in navigator && (location.protocol === "https:" || location.hostname === "localhost" || location.hostname === "127.0.0.1")) {
  navigator.serviceWorker.register("/sw.js").catch(() => { /* not available, e.g. self-signed certificate */ });
}

render();
