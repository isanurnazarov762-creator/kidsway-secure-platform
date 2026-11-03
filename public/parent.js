// KidsWay (the parent app). Shared code (API, login, map picker, layout) is in core.js.
"use strict";

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

start(parentRoute);
