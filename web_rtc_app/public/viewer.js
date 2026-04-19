const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const NODE_LABELS = { cam1: "air-1", cam2: "gnd-1", cam3: "gnd-2", cam4: "gnd-3" };
const NODE_ROLES  = { cam1: "airborne", cam2: "ground", cam3: "ground", cam4: "ground" };
const STATE_POLL_MS = 3000;
const SVG_NS = "http://www.w3.org/2000/svg";

const stage = document.getElementById("flowStage");
const pipesSvg = document.getElementById("flowPipes");
const serverStatus = document.getElementById("serverStatus");
const splatLinkCount = document.getElementById("splatLinkCount");
const opsClock = document.getElementById("opsClock");

const cams = new Map();
const readers = new Map();
const readyState = new Map();

function mediaMtxBaseUrl() {
  const override = (new URLSearchParams(location.search).get("mediamtx") || "").trim();
  return override ? override.replace(/\/$/, "") : `${location.origin}/mediamtx`;
}

function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text;
  return n;
}

function buildCamCard(container, streamId) {
  container.innerHTML = "";
  container.dataset.state = "offline";

  const corners = ["tl", "tr", "bl", "br"].map((pos) => {
    const c = el("div", `cam-corner ${pos}`);
    container.appendChild(c);
    return c;
  });

  const header = el("div", `cam-header role-${NODE_ROLES[streamId]}`);
  const title = el("div", "cam-title mono", NODE_LABELS[streamId]);
  const status = el("div", "cam-status mono", "—");
  header.appendChild(title);
  header.appendChild(status);

  const videoWrap = el("div", "cam-video-wrap");
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  videoWrap.appendChild(video);
  const scanline = el("div", "cam-scanline");
  videoWrap.appendChild(scanline);
  const noSig = el("div", "cam-nosig mono", "NO SIGNAL");
  videoWrap.appendChild(noSig);

  const stats = el("div", "cam-stats mono");
  const bitrateEl = el("span", "stats-bitrate", "—");
  const tempEl = el("span", "telem-temp", "—");
  const ringEl = el("span", "telem-ring", "—");
  stats.appendChild(bitrateEl);
  stats.appendChild(tempEl);
  stats.appendChild(ringEl);
  const uptimeEl = el("span", "stats-uptime", ""); // kept for API compat; not shown

  const controls = el("div", "cam-controls");
  const btnIdentify = el("button", "ctrl-btn", "ident");
  btnIdentify.title = "Pulse the ring cyan for 5s";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "ctrl-color";
  colorInput.value = "#80ed99";
  colorInput.title = "Override ring color";

  const btnClear = el("button", "ctrl-btn ctrl-btn--ghost", "clr");
  btnClear.title = "Clear override";

  const btnAI = el("button", "ctrl-btn", "ai");
  btnAI.title = "Ask AI to describe the current frame";

  const btnOff = el("button", "ctrl-btn ctrl-btn--danger", "off");
  btnOff.title = "Power off this unit (needs physical power cycle to return)";

  btnIdentify.addEventListener("click", () => piPost(streamId, "ring/identify", { ttl: 5 }, btnIdentify));
  colorInput.addEventListener("change", () => {
    const { r, g, b } = hexToRgb(colorInput.value);
    piPost(streamId, "ring/color", { r, g, b, ttl: 60 }, colorInput);
  });
  btnClear.addEventListener("click", () => piPost(streamId, "ring/clear", {}, btnClear));
  btnAI.addEventListener("click", () => aiDescribeCam(streamId, btnAI));
  btnOff.addEventListener("click", () => {
    const label = NODE_LABELS[streamId];
    if (!window.confirm(`Power off ${label} (${streamId})? Will need a physical power cycle to return.`)) return;
    piPost(streamId, "system/poweroff", {}, btnOff);
  });

  controls.appendChild(btnIdentify);
  controls.appendChild(colorInput);
  controls.appendChild(btnAI);
  controls.appendChild(btnClear);
  controls.appendChild(btnOff);

  const aiOverlay = el("div", "cam-ai-overlay mono");
  videoWrap.appendChild(aiOverlay);

  container.appendChild(header);
  container.appendChild(videoWrap);
  container.appendChild(stats);
  container.appendChild(controls);

  return { status, video, bitrateEl, uptimeEl, tempEl, ringEl, noSig, aiOverlay };
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

async function piPost(streamId, sub, body, btn) {
  const prev = btn && btn.textContent;
  if (btn && btn.tagName === "BUTTON") btn.disabled = true;
  try {
    const res = await fetch(`/api/pi/${streamId}/${sub}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (btn && btn.tagName === "BUTTON") {
      btn.textContent = res.ok ? "ACK" : "ERR";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
    }
  } catch (err) {
    if (btn && btn.tagName === "BUTTON") {
      btn.textContent = "ERR";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
    }
    console.error(`pi control ${streamId}/${sub} failed`, err);
  }
}

function attachReader(streamId, baseUrl, ui, container) {
  const reader = new MediaMTXWebRTCReader({
    url: `${baseUrl}/${streamId}/whep`,
    onTrack: (event) => {
      ui.video.srcObject = event.streams[0];
      ui.status.textContent = "live";
      ui.status.className = "cam-status mono live";
      container.dataset.state = "live";
      ui.noSig.style.display = "none";
    },
    onError: (err) => {
      ui.status.textContent = "offline";
      ui.status.className = "cam-status mono offline";
      container.dataset.state = "offline";
      ui.noSig.style.display = "";
      console.warn(`${streamId}:`, err);
    },
  });
  readers.set(streamId, reader);
}

function fmtUptime(seconds) {
  if (seconds == null || !isFinite(seconds)) return "---";
  const s = Math.floor(seconds);
  if (s < 60) return `${String(s).padStart(2, "0")}s`;
  if (s < 3600) return `${String(Math.floor(s / 60)).padStart(2, "0")}m`;
  return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}

const lastBytes = new Map();
const lastPollTs = new Map();

function updateFeedStats(streamId, slot) {
  const cam = cams.get(streamId);
  if (!cam) return;

  if (!slot || !slot.ready) {
    cam.bitrateEl.textContent = "—";
    lastBytes.delete(streamId);
    readyState.set(streamId, false);
    return;
  }

  readyState.set(streamId, true);
  const now = Date.now();
  const prevBytes = lastBytes.get(streamId);
  const prevTs = lastPollTs.get(streamId);
  if (prevBytes != null && prevTs != null && slot.bytesReceived != null) {
    const dBytes = Math.max(0, slot.bytesReceived - prevBytes);
    const dSec = Math.max(0.001, (now - prevTs) / 1000);
    const kbps = Math.round((dBytes * 8) / 1000 / dSec);
    cam.bitrateEl.textContent = `${kbps} kbps`;
  }
  lastBytes.set(streamId, slot.bytesReceived ?? 0);
  lastPollTs.set(streamId, now);
}

async function pollPiTelemetry(streamId) {
  const cam = cams.get(streamId);
  if (!cam) return;
  try {
    const res = await fetch(`/api/pi/${streamId}/status`);
    if (!res.ok) throw new Error(`pi status ${res.status}`);
    const body = await res.json();
    if (body.cpu_temp_c != null) cam.tempEl.textContent = `${body.cpu_temp_c.toFixed(0)}°`;
    const override = body.ring_override;
    cam.ringEl.textContent = override && override.mode ? override.mode : "auto";
  } catch {
    cam.tempEl.textContent = "—";
    cam.ringEl.textContent = "—";
  }
}

async function pollState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`state api ${res.status}`);
    const body = await res.json();
    const live = body.slots.filter((s) => s.ready).length;
    serverStatus.textContent = `${live}/4`;
    serverStatus.className = `pill mono ${live > 0 ? "pill-live" : "pill-idle"}`;
    splatLinkCount.textContent = `${live}/4`;
    for (const slot of body.slots) updateFeedStats(slot.id, slot);
    drawPipes();

    // Telemetry (CPU temp, ring mode) — only poll live cams to avoid 502s.
    for (const slot of body.slots) if (slot.ready) pollPiTelemetry(slot.id);
  } catch (err) {
    serverStatus.textContent = "down";
    serverStatus.className = "pill mono pill-err";
    console.warn("state poll failed", err);
  }
}

function nodeCenter(node, container) {
  const r = node.getBoundingClientRect();
  const p = container.getBoundingClientRect();
  return { x: r.left + r.width / 2 - p.left, y: r.top + r.height / 2 - p.top };
}

function drawPipes() {
  pipesSvg.innerHTML = "";
  const stageRect = stage.getBoundingClientRect();
  pipesSvg.setAttribute("viewBox", `0 0 ${stageRect.width} ${stageRect.height}`);
  pipesSvg.setAttribute("width", stageRect.width);
  pipesSvg.setAttribute("height", stageRect.height);

  const splat = document.getElementById("splatNode");
  const splatRect = splat.getBoundingClientRect();
  const sink = {
    x: splatRect.left + splatRect.width / 2 - stageRect.left,
    y: splatRect.top - stageRect.top + 10,
  };

  for (const streamId of STREAM_IDS) {
    if (!readyState.get(streamId)) continue; // only linked nodes get a flow line

    const cam = cams.get(streamId);
    if (!cam) continue;
    const container = cam.container;
    const containerRect = container.getBoundingClientRect();
    const src = {
      x: containerRect.left + containerRect.width / 2 - stageRect.left,
      y: containerRect.bottom - stageRect.top - 6,
    };
    const midY = (src.y + sink.y) / 2;
    const d = `M ${src.x} ${src.y} C ${src.x} ${midY}, ${sink.x} ${midY}, ${sink.x} ${sink.y}`;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    const role = NODE_ROLES[streamId].toLowerCase();
    path.setAttribute("class", `pipe pipe-${role} pipe-${streamId}`);
    pipesSvg.appendChild(path);

    for (let i = 0; i < 3; i++) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("r", "3");
      dot.setAttribute("class", `pipe-dot pipe-dot-${role}`);
      const motion = document.createElementNS(SVG_NS, "animateMotion");
      motion.setAttribute("dur", "2.4s");
      motion.setAttribute("repeatCount", "indefinite");
      motion.setAttribute("begin", `${i * 0.8}s`);
      motion.setAttribute("path", d);
      dot.appendChild(motion);
      pipesSvg.appendChild(dot);
    }
  }
}

function setupResizeObserver() {
  const ro = new ResizeObserver(() => drawPipes());
  ro.observe(stage);
  window.addEventListener("resize", drawPipes);
}

function tickClock() {
  const now = new Date();
  const hh = String(now.getUTCHours()).padStart(2, "0");
  const mm = String(now.getUTCMinutes()).padStart(2, "0");
  const ss = String(now.getUTCSeconds()).padStart(2, "0");
  opsClock.textContent = `${hh}:${mm}:${ss}`;
}

function start() {
  const baseUrl = mediaMtxBaseUrl();
  serverStatus.textContent = "…";

  for (const streamId of STREAM_IDS) {
    const container = stage.querySelector(`[data-cam="${streamId}"]`);
    const ui = buildCamCard(container, streamId);
    cams.set(streamId, { container, ...ui });
    readyState.set(streamId, false);
    attachReader(streamId, baseUrl, ui, container);
  }

  buildMinimap();

  tickClock();
  setInterval(tickClock, 1000);
  requestAnimationFrame(() => drawPipes());
  setupResizeObserver();
  pollState();
  setInterval(pollState, STATE_POLL_MS);
}

// ---------------------------------------------------------------------------
// Tactical minimap — drag units to reposition, drag their arrow tip to point.
// Bearing on release → POST /ring/compass so the unit's LED ring shows heading.
// ---------------------------------------------------------------------------

const MAP_VB_W = 1000;
const MAP_VB_H = 560;
const MM_STORAGE_KEY = "enel.map.units.v1";
const MM_POI_KEY = "enel.map.poi.v1";
const MM_DEFAULTS = {
  cam1: { x: 0.50, y: 0.30, bearing: 0   },
  cam2: { x: 0.22, y: 0.68, bearing: 45  },
  cam3: { x: 0.50, y: 0.80, bearing: 0   },
  cam4: { x: 0.78, y: 0.68, bearing: 315 },
};
const mmState = {};
let mmPOI = null; // {x, y} in 0..1 or null
const MM_VIEW_KEY = "enel.map.view.v1";
const mmView = { tx: 0, ty: 0, scale: 1 };  // world transform: screen = world*scale + t

function mmLoad() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(MM_STORAGE_KEY)) || {}; } catch {}
  for (const id of STREAM_IDS) {
    const d = MM_DEFAULTS[id];
    const s = saved[id] || {};
    mmState[id] = {
      x: clamp01(s.x ?? d.x),
      y: clamp01(s.y ?? d.y),
      bearing: ((s.bearing ?? d.bearing) % 360 + 360) % 360,
    };
  }
}

function mmSave() {
  try { localStorage.setItem(MM_STORAGE_KEY, JSON.stringify(mmState)); } catch {}
}

function mmLoadPOI() {
  try {
    const raw = localStorage.getItem(MM_POI_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && isFinite(p.x) && isFinite(p.y)) return { x: clamp01(p.x), y: clamp01(p.y) };
  } catch {}
  return null;
}
function mmSavePOI() {
  try {
    if (mmPOI) localStorage.setItem(MM_POI_KEY, JSON.stringify(mmPOI));
    else       localStorage.removeItem(MM_POI_KEY);
  } catch {}
}

function clamp01(v) { return Math.max(0.02, Math.min(0.98, Number(v))); }

function mmLoadView() {
  try {
    const v = JSON.parse(localStorage.getItem(MM_VIEW_KEY));
    if (v && isFinite(v.tx) && isFinite(v.ty) && isFinite(v.scale)) {
      mmView.tx = v.tx; mmView.ty = v.ty;
      mmView.scale = Math.max(0.4, Math.min(3.0, v.scale));
    }
  } catch {}
}
function mmSaveView() {
  try { localStorage.setItem(MM_VIEW_KEY, JSON.stringify(mmView)); } catch {}
}
function applyView() {
  const svg = document.getElementById("miniMap");
  const world = svg && svg.querySelector(".mm-world");
  if (!world) return;
  world.setAttribute("transform",
    `translate(${mmView.tx} ${mmView.ty}) scale(${mmView.scale})`);
  const hud = document.getElementById("mmHud");
  if (hud) hud.textContent = `×${mmView.scale.toFixed(2)}`;
}
function screenToWorld(pt) {
  return {
    x: (pt.x - mmView.tx) / mmView.scale,
    y: (pt.y - mmView.ty) / mmView.scale,
  };
}

function buildMinimap() {
  const svg = document.getElementById("miniMap");
  if (!svg) return;
  mmLoad();
  mmLoadView();

  svg.innerHTML = "";

  // Grid pattern — dot grid, tiles infinitely inside the world group.
  const defs = document.createElementNS(SVG_NS, "defs");
  const pat = document.createElementNS(SVG_NS, "pattern");
  pat.setAttribute("id", "mmGridPattern");
  pat.setAttribute("patternUnits", "userSpaceOnUse");
  pat.setAttribute("width", 40);
  pat.setAttribute("height", 40);
  const gdot = document.createElementNS(SVG_NS, "circle");
  gdot.setAttribute("class", "mm-grid-dot");
  gdot.setAttribute("cx", 20); gdot.setAttribute("cy", 20); gdot.setAttribute("r", 1);
  pat.appendChild(gdot);
  defs.appendChild(pat);
  svg.appendChild(defs);

  // World group — pans and zooms as one unit.
  const world = document.createElementNS(SVG_NS, "g");
  world.setAttribute("class", "mm-world");
  svg.appendChild(world);

  // Giant tiled background so the grid looks infinite even when panned far.
  const bg = document.createElementNS(SVG_NS, "rect");
  bg.setAttribute("class", "mm-bg");
  bg.setAttribute("x", -5000); bg.setAttribute("y", -5000);
  bg.setAttribute("width", 10000); bg.setAttribute("height", 10000);
  bg.setAttribute("fill", "url(#mmGridPattern)");
  world.appendChild(bg);

  // Bounds rect — faint outline of the "home" world area.
  const bounds = document.createElementNS(SVG_NS, "rect");
  bounds.setAttribute("class", "mm-world-bounds");
  bounds.setAttribute("x", 0); bounds.setAttribute("y", 0);
  bounds.setAttribute("width", MAP_VB_W); bounds.setAttribute("height", MAP_VB_H);
  world.appendChild(bounds);

  // POI beams (under units)
  const poiBeams = document.createElementNS(SVG_NS, "g");
  poiBeams.setAttribute("class", "mm-poi-beams");
  world.appendChild(poiBeams);

  // Units
  const units = document.createElementNS(SVG_NS, "g");
  units.setAttribute("class", "mm-units");
  world.appendChild(units);

  for (const id of STREAM_IDS) {
    const g = document.createElementNS(SVG_NS, "g");
    const role = NODE_ROLES[id];
    g.setAttribute("class", `mm-unit role-${role}`);
    g.dataset.cam = id;

    const halo = document.createElementNS(SVG_NS, "circle");
    halo.setAttribute("class", "mm-halo");
    halo.setAttribute("r", 28);
    g.appendChild(halo);

    const arrow = document.createElementNS(SVG_NS, "line");
    arrow.setAttribute("class", "mm-arrow");
    g.appendChild(arrow);

    const tip = document.createElementNS(SVG_NS, "circle");
    tip.setAttribute("class", "mm-tip");
    tip.setAttribute("r", 8);
    g.appendChild(tip);

    const body = document.createElementNS(SVG_NS, "circle");
    body.setAttribute("class", "mm-body");
    body.setAttribute("r", 14);
    g.appendChild(body);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "mm-label");
    label.setAttribute("text-anchor", "middle");
    label.setAttribute("dy", "34");
    label.textContent = NODE_LABELS[id];
    g.appendChild(label);

    units.appendChild(g);
    mmAttachHandlers(svg, g, id, body, tip);
  }

  // POI
  const poiGroup = document.createElementNS(SVG_NS, "g");
  poiGroup.setAttribute("class", "mm-poi");
  poiGroup.setAttribute("id", "mmPOI");
  poiGroup.style.display = "none";
  const poiHalo = document.createElementNS(SVG_NS, "circle");
  poiHalo.setAttribute("class", "mm-poi-halo");
  poiHalo.setAttribute("r", 22);
  poiGroup.appendChild(poiHalo);
  const poiDot = document.createElementNS(SVG_NS, "circle");
  poiDot.setAttribute("class", "mm-poi-dot");
  poiDot.setAttribute("r", 8);
  poiGroup.appendChild(poiDot);
  const poiRing = document.createElementNS(SVG_NS, "circle");
  poiRing.setAttribute("class", "mm-poi-ring");
  poiRing.setAttribute("r", 14);
  poiGroup.appendChild(poiRing);
  world.appendChild(poiGroup);

  mmAttachPOIHandlers(svg, poiGroup);
  mmAttachViewportHandlers(svg);

  mmPOI = mmLoadPOI();
  applyView();
  mmRenderAll();
  mmRenderPOI();

  const ro = new ResizeObserver(() => { mmRenderAll(); mmRenderPOI(); });
  ro.observe(svg);
}

function mmAttachViewportHandlers(svg) {
  // Pan-or-tap: drag the empty canvas to pan, tap (no drag) to drop the POI.
  let panStart = null;
  let tapOrigin = null;
  let pointerId = null;
  let panning = false;
  const TAP_THRESHOLD = 5;

  const isEmpty = (target) =>
    target === svg ||
    (target.classList && (target.classList.contains("mm-bg") ||
                          target.classList.contains("mm-world-bounds")));

  svg.addEventListener("pointerdown", (evt) => {
    if (!isEmpty(evt.target)) return;
    evt.preventDefault();
    const pt = svgPointFromEvent(svg, evt);
    panStart = { sx: pt.x, sy: pt.y, tx: mmView.tx, ty: mmView.ty };
    tapOrigin = pt;
    pointerId = evt.pointerId;
    panning = false;
    try { svg.setPointerCapture(pointerId); } catch {}
  });

  svg.addEventListener("pointermove", (evt) => {
    if (!panStart) return;
    const pt = svgPointFromEvent(svg, evt);
    const dx = pt.x - panStart.sx;
    const dy = pt.y - panStart.sy;
    if (!panning && Math.hypot(dx, dy) < TAP_THRESHOLD) return;
    panning = true;
    svg.classList.add("panning");
    mmView.tx = panStart.tx + dx;
    mmView.ty = panStart.ty + dy;
    applyView();
    mmRenderPOI(); // keep POI beams fresh visually (though world transform already handles layout)
  });

  const endPan = (evt) => {
    if (!panStart) return;
    try { svg.releasePointerCapture(pointerId); } catch {}
    const wasPanning = panning;
    const origin = tapOrigin;
    panStart = null; tapOrigin = null; pointerId = null; panning = false;
    svg.classList.remove("panning");
    if (wasPanning) {
      mmSaveView();
    } else if (origin) {
      const w = screenToWorld(origin);
      mmPOI = { x: clamp01(w.x / MAP_VB_W), y: clamp01(w.y / MAP_VB_H) };
      mmSavePOI();
      mmFocusAllOnPOI();
      mmRenderPOI();
      mmRenderAll();
    }
  };
  svg.addEventListener("pointerup", endPan);
  svg.addEventListener("pointercancel", endPan);

  // Wheel zoom, centered on cursor.
  svg.addEventListener("wheel", (evt) => {
    evt.preventDefault();
    const pt = svgPointFromEvent(svg, evt);
    const worldBefore = screenToWorld(pt);
    const factor = evt.deltaY < 0 ? 1.12 : 1 / 1.12;
    const newScale = Math.max(0.4, Math.min(3.0, mmView.scale * factor));
    if (newScale === mmView.scale) return;
    mmView.scale = newScale;
    mmView.tx = pt.x - worldBefore.x * newScale;
    mmView.ty = pt.y - worldBefore.y * newScale;
    applyView();
    mmSaveView();
  }, { passive: false });

  // Double-click on empty space resets the view.
  svg.addEventListener("dblclick", (evt) => {
    if (!isEmpty(evt.target)) return;
    mmView.tx = 0; mmView.ty = 0; mmView.scale = 1;
    applyView();
    mmSaveView();
  });
}

function mmRenderPOI() {
  const svg = document.getElementById("miniMap");
  const g = svg && svg.querySelector("#mmPOI");
  const beams = svg && svg.querySelector(".mm-poi-beams");
  if (!g || !beams) return;
  beams.innerHTML = "";
  if (!mmPOI) {
    g.style.display = "none";
    return;
  }
  g.style.display = "";
  const px = mmPOI.x * MAP_VB_W;
  const py = mmPOI.y * MAP_VB_H;
  g.setAttribute("transform", `translate(${px}, ${py})`);

  for (const id of STREAM_IDS) {
    const s = mmState[id];
    const ux = s.x * MAP_VB_W, uy = s.y * MAP_VB_H;
    const line = document.createElementNS(SVG_NS, "line");
    line.setAttribute("x1", ux); line.setAttribute("y1", uy);
    line.setAttribute("x2", px); line.setAttribute("y2", py);
    line.setAttribute("class", `mm-beam role-${NODE_ROLES[id]}`);
    beams.appendChild(line);
  }

  if (typeof renderBeOverlay === "function") renderBeOverlay();
}

function mmFocusAllOnPOI() {
  if (!mmPOI) return;
  for (const id of STREAM_IDS) {
    const s = mmState[id];
    const dx = (mmPOI.x - s.x) * MAP_VB_W;
    const dy = (mmPOI.y - s.y) * MAP_VB_H;
    s.bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
    mmRenderUnit(id);
    mmSendBearing(id);
  }
  mmSave();
}

function mmAttachPOIHandlers(svg, g) {
  let dragging = false;
  let pointerId = null;
  g.addEventListener("pointerdown", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    dragging = true;
    pointerId = evt.pointerId;
    g.classList.add("active");
    try { evt.target.setPointerCapture(pointerId); } catch {}
  });
  g.addEventListener("pointermove", (evt) => {
    if (!dragging) return;
    const w = screenToWorld(svgPointFromEvent(svg, evt));
    mmPOI = { x: clamp01(w.x / MAP_VB_W), y: clamp01(w.y / MAP_VB_H) };
    mmRenderPOI();
    mmFocusAllOnPOI();
  });
  const end = (evt) => {
    if (!dragging) return;
    try { evt.target.releasePointerCapture(pointerId); } catch {}
    dragging = false; pointerId = null;
    g.classList.remove("active");
    mmSavePOI();
  };
  g.addEventListener("pointerup", end);
  g.addEventListener("pointercancel", end);

  // double-click / double-tap clears the POI and releases the rings.
  g.addEventListener("dblclick", (evt) => {
    evt.preventDefault();
    evt.stopPropagation();
    mmPOI = null;
    mmSavePOI();
    mmRenderPOI();
    for (const id of STREAM_IDS) piPost(id, "ring/clear", {}, null);
  });
}

function mmRenderAll() {
  for (const id of STREAM_IDS) mmRenderUnit(id);
}

function mmRenderUnit(id) {
  const svg = document.getElementById("miniMap");
  const g = svg && svg.querySelector(`.mm-unit[data-cam="${id}"]`);
  if (!g) return;
  const s = mmState[id];
  const px = s.x * MAP_VB_W;
  const py = s.y * MAP_VB_H;
  g.setAttribute("transform", `translate(${px}, ${py})`);

  const rad = (s.bearing - 90) * Math.PI / 180;
  const armLen = 42;
  const tipX = Math.cos(rad) * armLen;
  const tipY = Math.sin(rad) * armLen;

  const arrow = g.querySelector(".mm-arrow");
  arrow.setAttribute("x1", 0); arrow.setAttribute("y1", 0);
  arrow.setAttribute("x2", tipX); arrow.setAttribute("y2", tipY);

  const tip = g.querySelector(".mm-tip");
  tip.setAttribute("cx", tipX); tip.setAttribute("cy", tipY);

  if (typeof renderBeOverlay === "function") renderBeOverlay();
}

function svgPointFromEvent(svg, evt) {
  const rect = svg.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (MAP_VB_W / rect.width);
  const y = (evt.clientY - rect.top)  * (MAP_VB_H / rect.height);
  return { x, y };
}

// Throttle per cam: first call fires immediately, in-flight window drops
// intermediate calls, and one trailing call fires at window end so the final
// bearing always reaches the Pi even if drag stops mid-window.
const mmThrottle = new Map();
const MM_SEND_GAP_MS = 120;
function mmSendBearing(id) {
  const now = Date.now();
  let s = mmThrottle.get(id);
  if (!s) { s = { lastTs: 0, trailing: null }; mmThrottle.set(id, s); }
  const doSend = () => {
    s.lastTs = Date.now();
    const b = Math.round(mmState[id].bearing);
    piPost(id, "ring/compass", { bearing_deg: b, ttl: 600 }, null);
  };
  if (now - s.lastTs >= MM_SEND_GAP_MS) {
    if (s.trailing) { clearTimeout(s.trailing); s.trailing = null; }
    doSend();
  } else if (!s.trailing) {
    s.trailing = setTimeout(() => { s.trailing = null; doSend(); }, MM_SEND_GAP_MS - (now - s.lastTs));
  }
}

function mmAttachHandlers(svg, g, id, body, tip) {
  let mode = null;
  let pointerId = null;

  const onDown = (evt, m) => {
    evt.preventDefault();
    mode = m;
    pointerId = evt.pointerId;
    g.classList.add("active");
    if (g.parentNode) g.parentNode.appendChild(g); // raise
    try { evt.target.setPointerCapture(pointerId); } catch {}
  };
  const onMove = (evt) => {
    if (mode == null) return;
    const w = screenToWorld(svgPointFromEvent(svg, evt));
    if (mode === "move") {
      mmState[id].x = Math.max(0.02, Math.min(0.98, w.x / MAP_VB_W));
      mmState[id].y = Math.max(0.02, Math.min(0.98, w.y / MAP_VB_H));
      if (mmPOI) {
        const dx = (mmPOI.x - mmState[id].x) * MAP_VB_W;
        const dy = (mmPOI.y - mmState[id].y) * MAP_VB_H;
        mmState[id].bearing = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
        mmRenderPOI();
      }
    } else if (mode === "rotate") {
      const cx = mmState[id].x * MAP_VB_W;
      const cy = mmState[id].y * MAP_VB_H;
      const dx = w.x - cx;
      const dy = w.y - cy;
      const deg = (Math.atan2(dx, -dy) * 180 / Math.PI + 360) % 360;
      mmState[id].bearing = deg;
      mmSendBearing(id);
    }
    mmRenderUnit(id);
  };
  const onUp = (evt) => {
    if (mode == null) return;
    try { evt.target.releasePointerCapture(pointerId); } catch {}
    const finishedMode = mode;
    mode = null;
    pointerId = null;
    g.classList.remove("active");
    mmSave();
    if (finishedMode === "rotate") mmSendBearing(id);
    if (finishedMode === "move" && mmPOI) mmSendBearing(id);
  };

  body.addEventListener("pointerdown", (e) => onDown(e, "move"));
  tip .addEventListener("pointerdown", (e) => onDown(e, "rotate"));
  g.addEventListener("pointermove", onMove);
  g.addEventListener("pointerup", onUp);
  g.addEventListener("pointercancel", onUp);
}

// ---------------------------------------------------------------------------
// AI features — vision describe + fleet SITREP + natural-language intent.
// ---------------------------------------------------------------------------

function captureFrameDataURL(video) {
  if (!video || !video.videoWidth) return null;
  const canvas = document.createElement("canvas");
  const maxW = 640;
  const scale = Math.min(1, maxW / video.videoWidth);
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext("2d");
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  try { return canvas.toDataURL("image/jpeg", 0.7); } catch { return null; }
}

function dataUrlToB64(url) {
  const comma = url.indexOf(",");
  return comma >= 0 ? url.slice(comma + 1) : url;
}

function setOverlay(cam, text, cls = "") {
  const ov = cam && cam.aiOverlay;
  if (!ov) return;
  ov.textContent = text || "";
  ov.className = `cam-ai-overlay mono ${cls}`.trim();
  ov.style.display = text ? "" : "none";
}

async function aiDescribeCam(streamId, btn) {
  const cam = cams.get(streamId);
  if (!cam) return;
  if (!readyState.get(streamId)) {
    setOverlay(cam, "no signal — ai skipped", "err");
    setTimeout(() => setOverlay(cam, ""), 1800);
    return;
  }
  const url = captureFrameDataURL(cam.video);
  if (!url) {
    setOverlay(cam, "frame unavailable", "err");
    setTimeout(() => setOverlay(cam, ""), 1800);
    return;
  }
  const prev = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  setOverlay(cam, "analyzing…", "pending");
  try {
    const res = await fetch("/api/ai/describe", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cam: streamId, image_b64: dataUrlToB64(url) }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) {
      setOverlay(cam, `ai: ${body.error || res.status}`, "err");
    } else {
      setOverlay(cam, body.text || "(no description)", "ok");
    }
  } catch (err) {
    setOverlay(cam, `ai: ${err.message || "failed"}`, "err");
  } finally {
    if (btn) { btn.textContent = prev; btn.disabled = false; }
  }
}

async function aiSitrep(btn) {
  const panel = document.getElementById("sitrepPanel");
  const body  = document.getElementById("sitrepBody");
  if (!panel || !body) return;
  const frames = [];
  for (const id of STREAM_IDS) {
    if (!readyState.get(id)) continue;
    const cam = cams.get(id);
    const url = cam && captureFrameDataURL(cam.video);
    if (!url) continue;
    frames.push({ cam: id, image_b64: dataUrlToB64(url) });
  }
  panel.style.display = "";
  if (frames.length === 0) {
    body.textContent = "no live cams — nothing to fuse.";
    return;
  }
  body.textContent = `fusing ${frames.length} feed${frames.length > 1 ? "s" : ""}…`;
  const prev = btn && btn.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "…"; }
  try {
    const res = await fetch("/api/ai/sitrep", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ frames }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) {
      body.textContent = `sitrep failed: ${out.error || res.status}`;
    } else {
      body.textContent = out.text || "(empty)";
    }
  } catch (err) {
    body.textContent = `sitrep failed: ${err.message}`;
  } finally {
    if (btn) { btn.textContent = prev; btn.disabled = false; }
  }
}

function wireAIChrome() {
  const btn = document.getElementById("btnSitrep");
  if (btn) btn.addEventListener("click", () => aiSitrep(btn));
  const close = document.getElementById("sitrepClose");
  if (close) close.addEventListener("click", () => {
    const panel = document.getElementById("sitrepPanel");
    if (panel) panel.style.display = "none";
  });
}

wireAIChrome();

// ---------------------------------------------------------------------------
// Splat free-look — just a reload button on the existing iframe.
// ---------------------------------------------------------------------------

function wireSplatChrome() {
  const btnRel = document.getElementById("btnSplatReload");
  if (btnRel) {
    btnRel.addEventListener("click", () => {
      const f = document.getElementById("splatFrame");
      if (f) f.src = f.src;
    });
  }
}

wireSplatChrome();

// ---------------------------------------------------------------------------
// Splat bird's-eye view — loads the splat with ?view=topdown, shows a spinner
// until the child frame postMessages "enel-splat-ready", then renders unit
// + POI markers over the rendered scene using minimap world coords.
// ---------------------------------------------------------------------------

const SPLAT_BE_KEY = "enel.splatBe.activated.v1";
const SPLAT_BE_URL = "/splat/?view=topdown&url=/scenes/stump.splat";
let splatBeActivated = false;
let splatBeReady = false;

function setBeState(label, cls = "") {
  const s = document.getElementById("splatBeState");
  if (!s) return;
  s.textContent = label;
  s.className = `splat-be-state mono ${cls}`.trim();
}

function ensureBeOverlaySvg() {
  const ov = document.getElementById("splatBeOverlay");
  if (!ov) return null;
  let svg = ov.querySelector("svg");
  if (svg) return svg;
  svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `0 0 ${MAP_VB_W} ${MAP_VB_H}`);
  svg.setAttribute("preserveAspectRatio", "xMidYMid slice");
  ov.appendChild(svg);
  return svg;
}

function renderBeOverlay() {
  const svg = ensureBeOverlaySvg();
  if (!svg || !splatBeActivated || !splatBeReady) return;
  svg.innerHTML = "";

  // POI beams (under units)
  if (mmPOI) {
    const px = mmPOI.x * MAP_VB_W;
    const py = mmPOI.y * MAP_VB_H;
    for (const id of STREAM_IDS) {
      const s = mmState[id]; if (!s) continue;
      const ux = s.x * MAP_VB_W, uy = s.y * MAP_VB_H;
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", ux); line.setAttribute("y1", uy);
      line.setAttribute("x2", px); line.setAttribute("y2", py);
      line.setAttribute("class", "be-beam");
      svg.appendChild(line);
    }
  }

  // Units
  for (const id of STREAM_IDS) {
    const s = mmState[id]; if (!s) continue;
    const role = NODE_ROLES[id];
    const live = readyState.get(id);
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", `be-unit role-${role}${live ? "" : " offline"}`);
    const cx = s.x * MAP_VB_W, cy = s.y * MAP_VB_H;
    g.setAttribute("transform", `translate(${cx}, ${cy})`);

    const rad = (s.bearing - 90) * Math.PI / 180;
    const armLen = 30;
    const tipX = Math.cos(rad) * armLen;
    const tipY = Math.sin(rad) * armLen;

    const arrow = document.createElementNS(SVG_NS, "line");
    arrow.setAttribute("class", "be-arrow");
    arrow.setAttribute("x1", 0); arrow.setAttribute("y1", 0);
    arrow.setAttribute("x2", tipX); arrow.setAttribute("y2", tipY);
    g.appendChild(arrow);

    const tip = document.createElementNS(SVG_NS, "circle");
    tip.setAttribute("class", "be-tip");
    tip.setAttribute("r", 5);
    tip.setAttribute("cx", tipX); tip.setAttribute("cy", tipY);
    g.appendChild(tip);

    const body = document.createElementNS(SVG_NS, "circle");
    body.setAttribute("class", "be-body");
    body.setAttribute("r", 10);
    g.appendChild(body);

    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "be-label");
    label.setAttribute("dy", "24");
    label.textContent = NODE_LABELS[id];
    g.appendChild(label);

    svg.appendChild(g);
  }

  // POI
  if (mmPOI) {
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("transform", `translate(${mmPOI.x * MAP_VB_W}, ${mmPOI.y * MAP_VB_H})`);
    const ring = document.createElementNS(SVG_NS, "circle");
    ring.setAttribute("class", "be-poi-ring");
    ring.setAttribute("r", 12);
    g.appendChild(ring);
    const dot = document.createElementNS(SVG_NS, "circle");
    dot.setAttribute("class", "be-poi-dot");
    dot.setAttribute("r", 5);
    g.appendChild(dot);
    svg.appendChild(g);
  }
}

function activateSplatBe() {
  if (splatBeActivated) return;
  splatBeActivated = true;
  try { localStorage.setItem(SPLAT_BE_KEY, "1"); } catch {}

  const stage = document.getElementById("splatBeStage");
  const placeholder = document.getElementById("splatBePlaceholder");
  const spinner = document.getElementById("splatBeSpinner");
  const btn = document.getElementById("btnSplatBeToggle");
  if (!stage) return;

  if (placeholder) placeholder.style.display = "none";
  if (spinner) spinner.style.display = "";
  setBeState("loading", "loading");
  if (btn) btn.textContent = "deactivate";

  // Create iframe only on activate — avoids eager 150MB fetch.
  let iframe = stage.querySelector("iframe");
  if (!iframe) {
    iframe = document.createElement("iframe");
    iframe.id = "splatBeFrame";
    iframe.setAttribute("title", "gaussian splat bird's-eye");
    iframe.setAttribute("allow", "xr-spatial-tracking; fullscreen");
    iframe.src = SPLAT_BE_URL;
    stage.insertBefore(iframe, stage.firstChild);
  } else {
    iframe.src = SPLAT_BE_URL;
  }
}

function deactivateSplatBe() {
  splatBeActivated = false;
  splatBeReady = false;
  try { localStorage.setItem(SPLAT_BE_KEY, "0"); } catch {}

  const stage = document.getElementById("splatBeStage");
  const placeholder = document.getElementById("splatBePlaceholder");
  const spinner = document.getElementById("splatBeSpinner");
  const btn = document.getElementById("btnSplatBeToggle");
  const ov = document.getElementById("splatBeOverlay");

  if (stage) {
    const iframe = stage.querySelector("iframe");
    if (iframe) iframe.remove();
  }
  if (ov) ov.innerHTML = "";
  if (placeholder) placeholder.style.display = "";
  if (spinner) spinner.style.display = "none";
  setBeState("dormant", "");
  if (btn) btn.textContent = "activate";
}

function onSplatBeReady() {
  splatBeReady = true;
  const spinner = document.getElementById("splatBeSpinner");
  if (spinner) spinner.style.display = "none";
  setBeState("live", "live");
  renderBeOverlay();
}

function wireSplatBeChrome() {
  const btn = document.getElementById("btnSplatBeToggle");
  if (btn) {
    btn.addEventListener("click", () => {
      if (splatBeActivated) deactivateSplatBe();
      else activateSplatBe();
    });
  }

  window.addEventListener("message", (evt) => {
    const data = evt && evt.data;
    if (data && data.type === "enel-splat-ready") onSplatBeReady();
  });

  setInterval(() => { if (splatBeActivated && splatBeReady) renderBeOverlay(); },
              STATE_POLL_MS);

  // Auto-activate if the user had it on last session.
  try {
    if (localStorage.getItem(SPLAT_BE_KEY) === "1") {
      requestAnimationFrame(() => activateSplatBe());
    }
  } catch {}
}

wireSplatBeChrome();

start();

window.addEventListener("beforeunload", () => {
  for (const r of readers.values()) r.close();
});
