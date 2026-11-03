// KidsWay Guardian (the escort app): today's trips, handover codes, photos and live location.
// Applying for the job is part of this app too: /guardian/apply (careers.js).
"use strict";

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

start(escortRoute);
