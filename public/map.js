// A small slippy map on OpenStreetMap tiles, plus address search (Nominatim). No map library needed.
// Privacy and policy notes (docs/threat-model.md):
// - Tiles are plain images: the tile server sees which area is viewed, not who the child is.
// - Address search text goes to nominatim.openstreetmap.org. Requests are limited to 1 per second
//   and only made when the user types or moves the pin, as the Nominatim usage policy requires.
// - Positions are moved with CSSOM (element.style), which the page's CSP allows; no inline styles.
"use strict";

(function () {
  const TILE = 256;
  const TILE_URL = (z, x, y) => `https://tile.openstreetmap.org/${z}/${x}/${y}.png`;
  const MIN_Z = 5, MAX_Z = 18;
  const KL = [3.139, 101.6869];
  // Malaysia bounding box, same as the server's check.
  const inMalaysia = (lat, lng) => lat >= 0.5 && lat <= 7.5 && lng >= 99.5 && lng <= 119.5;

  function project(lat, lng, z) {
    const s = TILE * Math.pow(2, z);
    const r = (Math.max(-85, Math.min(85, lat)) * Math.PI) / 180;
    return { x: ((lng + 180) / 360) * s, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * s };
  }
  function unproject(x, y, z) {
    const s = TILE * Math.pow(2, z);
    const n = Math.PI - (2 * Math.PI * y) / s;
    return { lat: (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n))), lng: (x / s) * 360 - 180 };
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  /**
   * create(container, { center:[lat,lng], zoom, pin, onMoveEnd(center) })
   * pin: true shows a fixed pin in the middle (Grab-style picking: move the map under the pin).
   */
  function create(container, opts) {
    opts = opts || {};
    let z = opts.zoom || 12;
    const c0 = opts.center || KL;
    let { x: cx, y: cy } = project(c0[0], c0[1], z);
    let W = 0, H = 0, raf = 0, markers = [];
    const tiles = new Map();

    container.classList.add("kwmap");
    container.tabIndex = 0;
    container.setAttribute("role", "application");
    container.setAttribute("aria-label", opts.pin ? "Map. Drag to move the pin, plus and minus to zoom." : "Map");
    const tileLayer = el("div", "kwmap-tiles");
    const markerLayer = el("div", "kwmap-markers");
    container.append(tileLayer, markerLayer);
    if (opts.pin) container.append(el("div", "kwmap-pin"));

    const zoomBox = el("div", "kwmap-zoom");
    const zin = el("button", null, "+"), zout = el("button", null, "−");
    zin.type = zout.type = "button";
    zin.setAttribute("aria-label", "Zoom in"); zout.setAttribute("aria-label", "Zoom out");
    zin.addEventListener("click", () => zoomTo(z + 1, true));
    zout.addEventListener("click", () => zoomTo(z - 1, true));
    zoomBox.append(zin, zout);
    const attr = el("div", "kwmap-attr");
    const a = el("a", null, "© OpenStreetMap contributors");
    a.href = "https://www.openstreetmap.org/copyright"; a.target = "_blank"; a.rel = "noopener noreferrer";
    attr.append(a);
    container.append(zoomBox, attr);

    function draw() {
      raf = 0;
      W = container.clientWidth; H = container.clientHeight;
      if (!W || !H) return;
      const left = cx - W / 2, top = cy - H / 2, n = Math.pow(2, z);
      const need = new Set();
      for (let tx = Math.floor(left / TILE); tx <= Math.floor((left + W) / TILE); tx++) {
        for (let ty = Math.floor(top / TILE); ty <= Math.floor((top + H) / TILE); ty++) {
          if (ty < 0 || ty >= n) continue;
          const key = `${z}/${tx}/${ty}`;
          need.add(key);
          let img = tiles.get(key);
          if (!img) {
            img = el("img", "kwmap-tile");
            img.alt = ""; img.draggable = false; img.decoding = "async";
            img.addEventListener("error", () => img.classList.add("miss"));
            img.src = TILE_URL(z, ((tx % n) + n) % n, ty);
            tiles.set(key, img);
            tileLayer.append(img);
          }
          img.style.transform = `translate(${Math.round(tx * TILE - left)}px, ${Math.round(ty * TILE - top)}px)`;
        }
      }
      for (const [key, img] of tiles) if (!need.has(key)) { img.remove(); tiles.delete(key); }
      for (const m of markers) {
        const p = project(m.lat, m.lng, z);
        m.node.style.transform = `translate(${Math.round(p.x - left)}px, ${Math.round(p.y - top)}px)`;
      }
    }
    const schedule = () => { if (!raf) raf = requestAnimationFrame(draw); };
    const center = () => unproject(cx, cy, z);
    const moved = () => { if (opts.onMoveEnd) opts.onMoveEnd(center()); };

    function zoomTo(nz, notify) {
      nz = Math.max(MIN_Z, Math.min(MAX_Z, nz));
      if (nz === z) return;
      const f = Math.pow(2, nz - z);
      cx *= f; cy *= f; z = nz;
      schedule();
      if (notify) moved();
    }

    // ---- dragging and pinch zoom with pointer events (mouse, touch, pen) ----
    const pts = new Map();
    let dragged = false, pinchBase = 0;
    container.addEventListener("pointerdown", (e) => {
      if (e.target.closest(".kwmap-zoom, .kwmap-attr")) return;
      container.setPointerCapture(e.pointerId);
      pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
      dragged = false;
      if (pts.size === 2) { const [p1, p2] = [...pts.values()]; pinchBase = Math.hypot(p1.x - p2.x, p1.y - p2.y); }
    });
    container.addEventListener("pointermove", (e) => {
      const prev = pts.get(e.pointerId);
      if (!prev) return;
      const cur = { x: e.clientX, y: e.clientY };
      pts.set(e.pointerId, cur);
      if (pts.size === 1) {
        cx -= cur.x - prev.x; cy -= cur.y - prev.y;
        if (Math.abs(cur.x - prev.x) + Math.abs(cur.y - prev.y) > 0) dragged = true;
        schedule();
      } else if (pts.size === 2 && pinchBase) {
        const [p1, p2] = [...pts.values()];
        const d = Math.hypot(p1.x - p2.x, p1.y - p2.y);
        if (d / pinchBase > 1.5) { zoomTo(z + 1); pinchBase = d; dragged = true; }
        else if (d / pinchBase < 0.67) { zoomTo(z - 1); pinchBase = d; dragged = true; }
      }
    });
    const up = (e) => {
      if (!pts.delete(e.pointerId)) return;
      if (pts.size < 2) pinchBase = 0;
      if (pts.size === 0 && dragged) moved();
    };
    container.addEventListener("pointerup", up);
    container.addEventListener("pointercancel", up);
    let wheelT = 0;
    container.addEventListener("wheel", (e) => {
      e.preventDefault();
      const t = Date.now();
      if (t - wheelT < 250) return; // one zoom step per gesture
      wheelT = t;
      zoomTo(z + (e.deltaY < 0 ? 1 : -1), true);
    }, { passive: false });
    container.addEventListener("dblclick", () => zoomTo(z + 1, true));
    container.addEventListener("keydown", (e) => {
      const step = 80, k = e.key;
      if (k === "+" || k === "=") zoomTo(z + 1, true);
      else if (k === "-") zoomTo(z - 1, true);
      else if (k.startsWith("Arrow")) {
        e.preventDefault();
        if (k === "ArrowLeft") cx -= step; if (k === "ArrowRight") cx += step;
        if (k === "ArrowUp") cy -= step; if (k === "ArrowDown") cy += step;
        schedule(); moved();
      }
    });

    const ro = new ResizeObserver(schedule);
    ro.observe(container);
    schedule();

    return {
      center,
      zoom: () => z,
      setCenter(lat, lng, nz) {
        if (nz) z = Math.max(MIN_Z, Math.min(MAX_Z, nz));
        ({ x: cx, y: cy } = project(lat, lng, z));
        schedule();
      },
      /** markers: [{ lat, lng, label, kind: "stop" | "pickup" | "done" | "escort" | "me" }] */
      setMarkers(list) {
        markerLayer.replaceChildren();
        markers = (list || []).filter((m) => m && m.lat != null && m.lng != null).map((m) => {
          const node = el("div", "kwmap-marker " + (m.kind || "stop"));
          const pinEl = el("span"); pinEl.append(el("i", null, m.label || "")); node.append(pinEl);
          if (m.title) node.title = m.title;
          markerLayer.append(node);
          return { ...m, node };
        });
        schedule();
      },
      /** Centre and zoom so that all points are visible. */
      fit(points, maxZoom) {
        const p = (points || []).filter((q) => q && q.lat != null && q.lng != null);
        if (!p.length) return;
        W = container.clientWidth || 320; H = container.clientHeight || 220;
        let best = MIN_Z;
        for (let tz = maxZoom || 16; tz >= MIN_Z; tz--) {
          const xs = p.map((q) => project(q.lat, q.lng, tz));
          const w = Math.max(...xs.map((q) => q.x)) - Math.min(...xs.map((q) => q.x));
          const hgt = Math.max(...xs.map((q) => q.y)) - Math.min(...xs.map((q) => q.y));
          if (w < W - 70 && hgt < H - 70) { best = tz; break; }
        }
        z = best;
        const xs = p.map((q) => project(q.lat, q.lng, z));
        cx = (Math.min(...xs.map((q) => q.x)) + Math.max(...xs.map((q) => q.x))) / 2;
        cy = (Math.min(...xs.map((q) => q.y)) + Math.max(...xs.map((q) => q.y))) / 2;
        schedule();
      },
      destroy() { ro.disconnect(); if (raf) cancelAnimationFrame(raf); container.replaceChildren(); }
    };
  }

  // ---------------- address search (Nominatim) ----------------
  const GEO = "https://nominatim.openstreetmap.org";
  let last = 0, chain = Promise.resolve();
  const cache = new Map();
  /** Runs requests one at a time, at most one per second (Nominatim usage policy). */
  function throttled(url) {
    if (cache.has(url)) return Promise.resolve(cache.get(url));
    const job = chain.then(async () => {
      const wait = Math.max(0, last + 1100 - Date.now());
      if (wait) await new Promise((r) => setTimeout(r, wait));
      last = Date.now();
      const res = await fetch(url, { headers: { "Accept-Language": "en" }, credentials: "omit", referrerPolicy: "strict-origin" });
      if (!res.ok) throw new Error("geocoder " + res.status);
      const data = await res.json();
      cache.set(url, data);
      return data;
    });
    chain = job.catch(() => undefined);
    return job;
  }
  const shortName = (d) => {
    const parts = String(d || "").split(",").map((s) => s.trim()).filter(Boolean);
    return parts.slice(0, 3).join(", ");
  };
  const Geo = {
    async search(q) {
      const u = `${GEO}/search?format=jsonv2&countrycodes=my&limit=6&q=${encodeURIComponent(q)}`;
      const rows = await throttled(u);
      return (Array.isArray(rows) ? rows : []).map((r) => ({ label: shortName(r.display_name), full: String(r.display_name || ""), lat: Number(r.lat), lng: Number(r.lon) }))
        .filter((r) => Number.isFinite(r.lat) && Number.isFinite(r.lng) && inMalaysia(r.lat, r.lng));
    },
    async reverse(lat, lng) {
      const u = `${GEO}/reverse?format=jsonv2&zoom=18&lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}`;
      const r = await throttled(u);
      return r && r.display_name ? shortName(r.display_name) : null;
    }
  };

  window.KWMap = { create, project, inMalaysia, KL };
  window.KWGeo = Geo;
})();
