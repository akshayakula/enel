const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const NODE_LABELS = { cam1: "gnd-1", cam2: "gnd-2", cam3: "gnd-3", cam4: "gnd-4" };
const NODE_ROLES  = { cam1: "ground", cam2: "ground", cam3: "ground", cam4: "ground" };
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

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
    "'": "&#39;",
  })[ch]);
}

// Press-and-hold confirm. Holding the button for `durationMs` fires `onCommit`.
// Release before that cancels. Used for destructive actions so we can skip
// browser confirm() popups.
function attachHoldToConfirm(btn, fillEl, labelEl, durationMs, onCommit) {
  let raf = 0;
  let startTs = 0;
  let committed = false;
  let pointerId = null;
  const idleLabel = labelEl.textContent;

  const reset = () => {
    if (raf) cancelAnimationFrame(raf), raf = 0;
    fillEl.style.width = "0%";
    btn.classList.remove("holding");
    if (!committed) labelEl.textContent = idleLabel;
    startTs = 0;
    if (pointerId != null) {
      try { btn.releasePointerCapture(pointerId); } catch {}
      pointerId = null;
    }
  };

  const tick = () => {
    const elapsed = performance.now() - startTs;
    const p = Math.min(1, elapsed / durationMs);
    fillEl.style.width = (p * 100) + "%";
    if (p >= 1) {
      committed = true;
      labelEl.textContent = "powering off…";
      btn.classList.add("committed");
      btn.classList.remove("holding");
      fillEl.style.width = "100%";
      try { onCommit(); } catch {}
      return;
    }
    raf = requestAnimationFrame(tick);
  };

  btn.addEventListener("pointerdown", (evt) => {
    if (committed) return;
    evt.preventDefault();
    pointerId = evt.pointerId;
    try { btn.setPointerCapture(pointerId); } catch {}
    startTs = performance.now();
    btn.classList.add("holding");
    labelEl.textContent = "keep holding…";
    raf = requestAnimationFrame(tick);
  });
  const cancel = () => { if (!committed) reset(); };
  btn.addEventListener("pointerup", cancel);
  btn.addEventListener("pointerleave", cancel);
  btn.addEventListener("pointercancel", cancel);

  // Allow the caller to re-enable the button after a commit (e.g. arm button
  // that should remain usable). Power-off callers don't call this.
  return () => {
    committed = false;
    btn.classList.remove("committed");
    reset();
  };
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
  const fallback = document.createElement("video");
  fallback.className = "cam-fallback";
  fallback.src = `/fallbacks/${streamId}.mp4`;
  fallback.autoplay = true;
  fallback.loop = true;
  fallback.playsInline = true;
  fallback.muted = true;
  videoWrap.appendChild(fallback);
  const scanline = el("div", "cam-scanline");
  videoWrap.appendChild(scanline);
  const noSig = el("div", "cam-nosig mono", "no signal");
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

  // Power-off: press and hold for 1.2s — no browser popup. The button fills
  // with red while held; release early cancels. Committing locks it out.
  const btnOff = el("button", "ctrl-btn ctrl-btn--danger ctrl-btn--hold", "");
  btnOff.title = "Hold to power off this unit";
  btnOff.type = "button";
  const offFill = el("span", "ctrl-btn-hold-fill");
  const offLabel = el("span", "ctrl-btn-hold-label", "off");
  btnOff.appendChild(offFill);
  btnOff.appendChild(offLabel);

  btnIdentify.addEventListener("click", () => sendCommand(streamId, "identify", { ttl: 5 }, btnIdentify));
  colorInput.addEventListener("change", () => {
    const { r, g, b } = hexToRgb(colorInput.value);
    piPost(streamId, "ring/color", { r, g, b, ttl: 60 }, colorInput);
  });
  btnClear.addEventListener("click", () => piPost(streamId, "ring/clear", {}, btnClear));
  btnAI.addEventListener("click", () => aiDescribeCam(streamId, btnAI));
  attachHoldToConfirm(btnOff, offFill, offLabel, 1200, () => {
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

  // Drone panel — airborne unit only (cam1). MAVLink yaw stick + telemetry
  // + arm/disarm. Hidden by default, shown once WS connects.
  let drone = null;
  if (NODE_ROLES[streamId] === "airborne") {
    drone = buildDronePanel(streamId);
    container.appendChild(drone.root);
    wireDroneSocket(streamId, drone);
  }

  return { status, video, fallback, bitrateEl, uptimeEl, tempEl, ringEl, noSig, aiOverlay, drone };
}

// -----------------------------------------------------------------------------
// Drone panel (cam1 / airborne only). Rendered under the cam controls.
// -----------------------------------------------------------------------------
function buildDronePanel(streamId) {
  const root = el("div", "drone-panel mono");

  // --- link / mode / armed pills + expand chevron --------------------------
  const headRow = el("div", "drone-row drone-head");
  const titleWrap = el("div", "drone-head-title");
  const titleTxt  = el("span", "drone-head-titleTxt", "drone");
  const scanDot   = el("span", "drone-head-scan");
  titleWrap.append(scanDot, titleTxt);
  const linkPill = el("span", "drone-pill link", "link —");
  const modePill = el("span", "drone-pill mode", "mode —");
  const armPill  = el("span", "drone-pill arm", "disarmed");
  const expandBtn = el("button", "drone-expand-btn", "");
  expandBtn.type = "button";
  expandBtn.title = "expand / collapse";
  expandBtn.innerHTML = `<span class="chev">▾</span>`;
  headRow.append(titleWrap, linkPill, modePill, armPill, expandBtn);

  // --- telemetry grid ------------------------------------------------------
  const teleGrid = el("div", "drone-grid");
  const mkCell = (label) => {
    const c = el("div", "drone-cell");
    const lbl = el("span", "drone-cell-label", label);
    const val = el("span", "drone-cell-val", "—");
    c.append(lbl, val);
    return { root: c, val };
  };
  const cellBat  = mkCell("batt");
  const cellGps  = mkCell("gps");
  const cellAlt  = mkCell("alt");
  const cellYaw  = mkCell("yaw");
  teleGrid.append(cellBat.root, cellGps.root, cellAlt.root, cellYaw.root);

  // --- yaw stick -----------------------------------------------------------
  // Horizontal 1D slider, self-centers on release. Maps x → PWM 1000..2000.
  const stickWrap = el("div", "drone-stick");
  const stickLabel = el("span", "drone-stick-label", "yaw");
  const stickTrack = el("div", "drone-stick-track");
  const stickFill  = el("div", "drone-stick-fill");   // center-outward fill
  const stickKnob  = el("div", "drone-stick-knob");
  const stickPwm   = el("span", "drone-stick-pwm", "1500");
  stickTrack.append(stickFill, stickKnob);
  stickWrap.append(stickLabel, stickTrack, stickPwm);

  // --- arm/disarm row ------------------------------------------------------
  const armRow = el("div", "drone-row drone-arm-row");
  const btnArm    = el("button", "ctrl-btn ctrl-btn--arm ctrl-btn--hold", "");
  btnArm.type = "button";
  const armFill   = el("span", "ctrl-btn-hold-fill");
  const armLabel  = el("span", "ctrl-btn-hold-label", "hold to arm");
  btnArm.append(armFill, armLabel);
  const btnDisarm = el("button", "ctrl-btn ctrl-btn--disarm", "disarm");
  btnDisarm.type = "button";
  armRow.append(btnArm, btnDisarm);

  // --- expanded dashboard (hidden by default) ------------------------------
  const expanded = el("section", "drone-expanded");
  expanded.setAttribute("aria-hidden", "true");

  // artificial horizon + heading tape
  const horiz = buildAttitudeIndicator();
  const heading = buildHeadingTape();
  const topRow = el("div", "drone-exp-row drone-exp-top");
  topRow.append(horiz.root, heading.root);

  // detailed telem grid
  const detail = el("div", "drone-exp-detail");
  const mkDetail = (label) => {
    const c = el("div", "drone-detail-cell");
    c.append(el("span", "drone-detail-label", label));
    const v = el("span", "drone-detail-val", "—");
    c.append(v);
    return { root: c, val: v };
  };
  const detLat = mkDetail("lat");
  const detLon = mkDetail("lon");
  const detAlt = mkDetail("alt");
  const detFix = mkDetail("fix");
  const detSats = mkDetail("sats");
  const detRoll = mkDetail("roll");
  const detPitch = mkDetail("pitch");
  const detYaw = mkDetail("yaw");
  detail.append(
    detLat.root, detLon.root, detAlt.root, detFix.root,
    detSats.root, detRoll.root, detPitch.root, detYaw.root,
  );

  // battery bar
  const battWrap = el("div", "drone-batt");
  const battHead = el("div", "drone-batt-head");
  battHead.append(
    el("span", "drone-batt-label", "battery"),
    el("span", "drone-batt-value", "— v"),
  );
  const battBar = el("div", "drone-batt-bar");
  const battFill = el("div", "drone-batt-fill");
  battBar.append(battFill);
  battWrap.append(battHead, battBar);

  // RC channel strip — shows all 8 channels as pwm bars
  const rcStrip = el("div", "drone-rc-strip");
  const rcCells = [];
  for (let i = 1; i <= 8; i++) {
    const ch = el("div", "drone-rc-cell");
    ch.append(el("span", "drone-rc-lab", `ch${i}`));
    const bar = el("div", "drone-rc-bar");
    const fill = el("div", "drone-rc-fill");
    bar.append(fill);
    const val = el("span", "drone-rc-val", "—");
    ch.append(bar, val);
    rcStrip.append(ch);
    rcCells.push({ root: ch, fill, val });
  }

  expanded.append(topRow, detail, battWrap, rcStrip);

  root.append(headRow, teleGrid, stickWrap, armRow, expanded);

  // chevron toggle
  expandBtn.addEventListener("click", () => {
    const open = !root.classList.contains("expanded");
    root.classList.toggle("expanded", open);
    expanded.setAttribute("aria-hidden", open ? "false" : "true");
  });

  return {
    root, linkPill, modePill, armPill, expandBtn, expanded,
    cellBat: cellBat.val, cellGps: cellGps.val, cellAlt: cellAlt.val, cellYaw: cellYaw.val,
    stickTrack, stickFill, stickKnob, stickPwm,
    btnArm, armFill, armLabel, btnDisarm,
    // expanded refs
    horiz, heading,
    detLat: detLat.val, detLon: detLon.val, detAlt: detAlt.val, detFix: detFix.val,
    detSats: detSats.val, detRoll: detRoll.val, detPitch: detPitch.val, detYaw: detYaw.val,
    battHeadVal: battHead.querySelector(".drone-batt-value"),
    battFill, rcCells,
  };
}

// Artificial horizon — ball rolls/pitches under a fixed chevron.
function buildAttitudeIndicator() {
  const SVG_NS_ = "http://www.w3.org/2000/svg";
  const root = document.createElementNS(SVG_NS_, "svg");
  root.setAttribute("class", "drone-horiz");
  root.setAttribute("viewBox", "0 0 160 160");
  root.setAttribute("preserveAspectRatio", "xMidYMid meet");

  // clip to circle
  const defs = document.createElementNS(SVG_NS_, "defs");
  const clip = document.createElementNS(SVG_NS_, "clipPath");
  clip.setAttribute("id", "horizClip");
  const clipC = document.createElementNS(SVG_NS_, "circle");
  clipC.setAttribute("cx", 80); clipC.setAttribute("cy", 80); clipC.setAttribute("r", 70);
  clip.appendChild(clipC);
  defs.appendChild(clip);
  root.appendChild(defs);

  // rolling/pitching content
  const ball = document.createElementNS(SVG_NS_, "g");
  ball.setAttribute("clip-path", "url(#horizClip)");
  const roll = document.createElementNS(SVG_NS_, "g");
  roll.setAttribute("class", "horiz-roll");
  const pitch = document.createElementNS(SVG_NS_, "g");
  pitch.setAttribute("class", "horiz-pitch");

  // sky + ground big enough that translations don't expose edges
  const sky = document.createElementNS(SVG_NS_, "rect");
  sky.setAttribute("x", -200); sky.setAttribute("y", -200);
  sky.setAttribute("width", 560); sky.setAttribute("height", 280);
  sky.setAttribute("fill", "#2a3d52");
  const ground = document.createElementNS(SVG_NS_, "rect");
  ground.setAttribute("x", -200); ground.setAttribute("y", 80);
  ground.setAttribute("width", 560); ground.setAttribute("height", 280);
  ground.setAttribute("fill", "#5c3a1f");
  const horizon = document.createElementNS(SVG_NS_, "line");
  horizon.setAttribute("x1", -200); horizon.setAttribute("y1", 80);
  horizon.setAttribute("x2", 360); horizon.setAttribute("y2", 80);
  horizon.setAttribute("stroke", "#eae4cc"); horizon.setAttribute("stroke-width", 1.5);
  pitch.append(sky, ground, horizon);

  // pitch ladder
  for (let p = -60; p <= 60; p += 10) {
    if (p === 0) continue;
    const y = 80 - p * 2.2;
    const w = p % 20 === 0 ? 44 : 22;
    const ln = document.createElementNS(SVG_NS_, "line");
    ln.setAttribute("x1", 80 - w/2); ln.setAttribute("x2", 80 + w/2);
    ln.setAttribute("y1", y); ln.setAttribute("y2", y);
    ln.setAttribute("stroke", "#eae4cc"); ln.setAttribute("stroke-width", 1);
    ln.setAttribute("opacity", 0.7);
    pitch.append(ln);
  }
  roll.appendChild(pitch);
  ball.appendChild(roll);
  root.appendChild(ball);

  // fixed bezel: roll tick arc + cardinal marks
  const bezel = document.createElementNS(SVG_NS_, "g");
  bezel.setAttribute("class", "horiz-bezel");
  for (let a = -60; a <= 60; a += 10) {
    const rad = (a - 90) * Math.PI / 180;
    const len = a % 30 === 0 ? 10 : 6;
    const x1 = 80 + Math.cos(rad) * 68;
    const y1 = 80 + Math.sin(rad) * 68;
    const x2 = 80 + Math.cos(rad) * (68 - len);
    const y2 = 80 + Math.sin(rad) * (68 - len);
    const ln = document.createElementNS(SVG_NS_, "line");
    ln.setAttribute("x1", x1); ln.setAttribute("y1", y1);
    ln.setAttribute("x2", x2); ln.setAttribute("y2", y2);
    ln.setAttribute("stroke", "rgba(214, 161, 74, 0.75)");
    ln.setAttribute("stroke-width", 1);
    bezel.appendChild(ln);
  }
  const outer = document.createElementNS(SVG_NS_, "circle");
  outer.setAttribute("cx", 80); outer.setAttribute("cy", 80); outer.setAttribute("r", 70);
  outer.setAttribute("fill", "none");
  outer.setAttribute("stroke", "rgba(46, 51, 42, 1)");
  outer.setAttribute("stroke-width", 2);
  bezel.appendChild(outer);

  // center aircraft symbol
  const craft = document.createElementNS(SVG_NS_, "g");
  craft.setAttribute("class", "horiz-craft");
  const c1 = document.createElementNS(SVG_NS_, "line");
  c1.setAttribute("x1", 60); c1.setAttribute("y1", 80);
  c1.setAttribute("x2", 74); c1.setAttribute("y2", 80);
  const c2 = document.createElementNS(SVG_NS_, "line");
  c2.setAttribute("x1", 86); c2.setAttribute("y1", 80);
  c2.setAttribute("x2", 100); c2.setAttribute("y2", 80);
  const c3 = document.createElementNS(SVG_NS_, "circle");
  c3.setAttribute("cx", 80); c3.setAttribute("cy", 80); c3.setAttribute("r", 2.5);
  [c1, c2].forEach((ln) => { ln.setAttribute("stroke", "#ffcf5a"); ln.setAttribute("stroke-width", 2.5); });
  c3.setAttribute("fill", "#ffcf5a");
  craft.append(c1, c2, c3);
  root.appendChild(bezel);
  root.appendChild(craft);

  return {
    root,
    setAttitude(rollDeg, pitchDeg) {
      const r = Math.max(-60, Math.min(60, rollDeg || 0));
      const p = Math.max(-40, Math.min(40, pitchDeg || 0));
      roll.setAttribute("transform", `rotate(${-r} 80 80)`);
      pitch.setAttribute("transform", `translate(0 ${p * 2.2})`);
    },
  };
}

// Heading tape — moving strip of degrees with fixed top pointer.
function buildHeadingTape() {
  const root = el("div", "drone-heading");
  const pointer = el("div", "drone-heading-pointer");
  const track = el("div", "drone-heading-track");
  const strip = el("div", "drone-heading-strip");

  // Generate tick marks every 10° across two 360° spans (so we can wrap).
  const markers = [];
  for (let d = -180; d <= 540; d += 10) {
    const m = el("div", "drone-heading-mark");
    m.style.left = ((d + 180) / 720 * 100) + "%";
    const bigTick = d % 30 === 0;
    m.classList.toggle("major", bigTick);
    if (bigTick) {
      let label;
      const n = ((d % 360) + 360) % 360;
      if (n === 0)   label = "N";
      else if (n === 90)  label = "E";
      else if (n === 180) label = "S";
      else if (n === 270) label = "W";
      else label = String(n / 10).padStart(2, "0");
      m.textContent = label;
    }
    strip.append(m);
    markers.push(m);
  }
  track.append(strip);
  root.append(pointer, track);

  const stripEl = strip;
  return {
    root,
    setHeading(deg) {
      const d = ((deg % 360) + 360) % 360;
      // center the current heading under the pointer (at 50% of track)
      const pct = (d + 180) / 720 * 100;
      stripEl.style.transform = `translateX(${50 - pct}%)`;
    },
  };
}

function wireDroneSocket(streamId, d) {
  const YAW_SEND_HZ = 25;
  const YAW_CENTER_PWM = 1500;
  const YAW_MIN = 1000, YAW_MAX = 2000;

  let ws = null;
  let wsOpen = false;
  let yawPwm = YAW_CENTER_PWM;
  let yawDragging = false;
  let yawSendTimer = null;
  let reconnectTimer = null;
  let lastTeleTs = 0;

  // ---- WebSocket plumbing -------------------------------------------------
  const wsUrl = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    return `${proto}//${location.host}/api/pi/${streamId}/mavlink`;
  };

  const setLink = (state) => {
    d.linkPill.classList.remove("ok", "err", "stale");
    if (state === "ok")    { d.linkPill.textContent = "link up";      d.linkPill.classList.add("ok"); }
    else if (state === "stale") { d.linkPill.textContent = "link stale"; d.linkPill.classList.add("stale"); }
    else                   { d.linkPill.textContent = "link down";    d.linkPill.classList.add("err"); }
  };

  const connect = () => {
    if (ws) try { ws.close(); } catch {}
    setLink("err");
    ws = new WebSocket(wsUrl());
    ws.onopen = () => { wsOpen = true; setLink("ok"); };
    ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.type === "tele") applyTele(msg);
    };
    ws.onclose = () => {
      wsOpen = false;
      setLink("err");
      if (reconnectTimer) clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connect, 1500);
    };
    ws.onerror = () => { try { ws.close(); } catch {} };
  };

  const applyTele = (t) => {
    lastTeleTs = Date.now();
    const hbFresh = t.hb && t.hb.fresh;
    setLink(hbFresh ? "ok" : "stale");
    d.modePill.textContent = `mode ${(t.hb && t.hb.mode) || "?"}`;
    d.armPill.textContent  = t.armed ? "ARMED" : "disarmed";
    d.armPill.classList.toggle("live", !!t.armed);

    if (t.batt) {
      const v = t.batt.v != null ? t.batt.v.toFixed(2) + "v" : "—";
      const p = t.batt.pct != null ? ` · ${t.batt.pct}%` : "";
      d.cellBat.textContent = v + p;
    } else {
      d.cellBat.textContent = "—";
    }
    if (t.gps) {
      const fix  = t.gps.fix != null ? `${t.gps.fix}D` : "?";
      const sats = t.gps.sats != null ? `/${t.gps.sats}sv` : "";
      d.cellGps.textContent = fix + sats;
      d.cellAlt.textContent = t.gps.alt_m != null ? t.gps.alt_m.toFixed(1) + "m" : "—";
      // Plot cam1 on the minimap in real-world coords.
      if (t.gps.lat != null && t.gps.lon != null) geoOnCam1Gps(t.gps);
    } else {
      d.cellGps.textContent = "—";
      d.cellAlt.textContent = "—";
    }
    d.cellYaw.textContent = t.att && t.att.yaw_deg != null ? t.att.yaw_deg.toFixed(0) + "°" : "—";
    // Arm button disabled until link is fresh.
    d.btnArm.disabled = !hbFresh;

    // Expanded view — horizon, heading, detail cells, battery bar.
    if (t.att) {
      d.horiz.setAttitude(t.att.roll_deg, t.att.pitch_deg);
      d.heading.setHeading(t.att.yaw_deg || 0);
      d.detRoll.textContent  = t.att.roll_deg != null  ? t.att.roll_deg.toFixed(1) + "°" : "—";
      d.detPitch.textContent = t.att.pitch_deg != null ? t.att.pitch_deg.toFixed(1) + "°" : "—";
      d.detYaw.textContent   = t.att.yaw_deg != null   ? t.att.yaw_deg.toFixed(1) + "°" : "—";
    }
    if (t.gps) {
      d.detLat.textContent  = t.gps.lat != null ? t.gps.lat.toFixed(6) : "—";
      d.detLon.textContent  = t.gps.lon != null ? t.gps.lon.toFixed(6) : "—";
      d.detAlt.textContent  = t.gps.alt_m != null ? t.gps.alt_m.toFixed(1) + " m" : "—";
      d.detFix.textContent  = t.gps.fix != null  ? `${t.gps.fix}D` : "—";
      d.detSats.textContent = t.gps.sats != null ? String(t.gps.sats) : "—";
    }
    if (t.batt) {
      const v = t.batt.v != null ? t.batt.v.toFixed(2) + " v" : "— v";
      const pct = t.batt.pct != null ? t.batt.pct : null;
      d.battHeadVal.textContent = v + (pct != null ? ` · ${pct}%` : "");
      d.battFill.style.width = (pct != null ? pct : 0) + "%";
      d.battFill.classList.toggle("warn", pct != null && pct < 30);
      d.battFill.classList.toggle("crit", pct != null && pct < 15);
    }
    // RC channels — we only command CH4 from this UI; others show released.
    const ourYaw = Number(d.stickPwm.textContent) || 1500;
    const chVals = [0, 0, 0, ourYaw, 0, 0, 0, 0];
    d.rcCells.forEach((c, i) => {
      const pwm = chVals[i];
      const active = pwm >= 1000 && pwm <= 2000;
      c.val.textContent = active ? String(pwm) : "—";
      c.root.classList.toggle("active", active);
      // 1000..2000 → 0..100%
      const pct = active ? ((pwm - 1000) / 1000) * 100 : 0;
      c.fill.style.width = pct + "%";
    });
  };

  const sendFrame = (obj) => {
    if (!wsOpen || !ws || ws.readyState !== WebSocket.OPEN) return;
    try { ws.send(JSON.stringify(obj)); } catch {}
  };

  // ---- yaw stick interaction ---------------------------------------------
  const updateKnob = () => {
    // pwm 1000..2000 → -1..1 → knob offset %
    const norm = (yawPwm - YAW_CENTER_PWM) / (YAW_MAX - YAW_CENTER_PWM);
    d.stickKnob.style.left = (50 + norm * 50) + "%";
    // fill grows from center outward.
    const widthPct = Math.abs(norm) * 50;
    if (norm >= 0) {
      d.stickFill.style.left  = "50%";
      d.stickFill.style.right = "auto";
      d.stickFill.style.width = widthPct + "%";
    } else {
      d.stickFill.style.right = "50%";
      d.stickFill.style.left  = "auto";
      d.stickFill.style.width = widthPct + "%";
    }
    d.stickPwm.textContent = String(yawPwm);
  };

  const setFromClientX = (clientX) => {
    const rect = d.stickTrack.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const norm = (x / rect.width) * 2 - 1; // -1..1
    yawPwm = Math.round(YAW_CENTER_PWM + norm * (YAW_MAX - YAW_CENTER_PWM));
    yawPwm = Math.max(YAW_MIN, Math.min(YAW_MAX, yawPwm));
    updateKnob();
  };

  const startSending = () => {
    if (yawSendTimer) return;
    yawSendTimer = setInterval(() => sendFrame({ type: "yaw", pwm: yawPwm }),
                               Math.round(1000 / YAW_SEND_HZ));
  };
  const stopSending = () => {
    if (!yawSendTimer) return;
    clearInterval(yawSendTimer);
    yawSendTimer = null;
  };

  d.stickTrack.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    yawDragging = true;
    d.stickTrack.setPointerCapture(e.pointerId);
    d.stickTrack.classList.add("active");
    setFromClientX(e.clientX);
    startSending();
  });
  d.stickTrack.addEventListener("pointermove", (e) => {
    if (!yawDragging) return;
    setFromClientX(e.clientX);
  });
  const endStick = (e) => {
    if (!yawDragging) return;
    yawDragging = false;
    try { d.stickTrack.releasePointerCapture(e.pointerId); } catch {}
    d.stickTrack.classList.remove("active");
    // Spring back to center and let deadman take over.
    yawPwm = YAW_CENTER_PWM;
    updateKnob();
    sendFrame({ type: "yaw", pwm: yawPwm });
    stopSending();
  };
  d.stickTrack.addEventListener("pointerup", endStick);
  d.stickTrack.addEventListener("pointercancel", endStick);
  d.stickTrack.addEventListener("pointerleave", (e) => { if (yawDragging) endStick(e); });

  updateKnob();

  // ---- arm / disarm -------------------------------------------------------
  const resetArm = attachHoldToConfirm(d.btnArm, d.armFill, d.armLabel, 1500, () => {
    sendFrame({ type: "arm", on: true });
    setTimeout(() => resetArm && resetArm(), 2000);
  });
  d.btnDisarm.addEventListener("click", () => {
    sendFrame({ type: "arm", on: false });
  });

  // Stale-link detection (no tele for 3s → orange).
  setInterval(() => {
    if (!wsOpen) return;
    if (Date.now() - lastTeleTs > 3000) setLink("stale");
  }, 1000);

  // Exposed yaw-pulse for the AI swarm commander. Applies a PWM for duration_ms,
  // sending at 25 Hz (matches the bridge's deadman), then springs back to center.
  // Refuses while the human is actively dragging the stick.
  let aiPulseTimer = null;
  let aiPulseStop = 0;
  d.yawPulse = (pwm, durationMs) => {
    if (yawDragging) return false;
    pwm = Math.max(YAW_MIN, Math.min(YAW_MAX, Math.round(pwm)));
    durationMs = Math.max(50, Math.min(3000, Math.round(durationMs)));
    if (aiPulseTimer) { clearInterval(aiPulseTimer); aiPulseTimer = null; }
    aiPulseStop = Date.now() + durationMs;
    yawPwm = pwm;
    updateKnob();
    d.stickTrack.classList.add("ai-drive");
    aiPulseTimer = setInterval(() => {
      if (yawDragging || Date.now() >= aiPulseStop) {
        clearInterval(aiPulseTimer); aiPulseTimer = null;
        if (!yawDragging) {
          yawPwm = YAW_CENTER_PWM;
          updateKnob();
          sendFrame({ type: "yaw", pwm: YAW_CENTER_PWM });
        }
        d.stickTrack.classList.remove("ai-drive");
        return;
      }
      sendFrame({ type: "yaw", pwm });
    }, Math.round(1000 / YAW_SEND_HZ));
    sendFrame({ type: "yaw", pwm });
    return true;
  };

  connect();
}

function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  const n = parseInt(m[1], 16);
  return { r: (n >> 16) & 0xff, g: (n >> 8) & 0xff, b: n & 0xff };
}

// One-shot command via the pull model: write to this dashboard's
// /api/command/<cam>; the Pi polls every reachable dashboard and executes it.
// Works on both LAN and remote (Fly) dashboards.
async function sendCommand(streamId, cmd, args, btn) {
  const prev = btn && btn.textContent;
  if (btn && btn.tagName === "BUTTON") btn.disabled = true;
  try {
    const res = await fetch(`/api/command/${streamId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cmd, args: args || {} }),
    });
    if (btn && btn.tagName === "BUTTON") {
      btn.textContent = res.ok ? "sent" : "ERR";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
    }
  } catch (err) {
    if (btn && btn.tagName === "BUTTON") {
      btn.textContent = "ERR";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
    }
    console.error(`command ${streamId}/${cmd} failed`, err);
  }
}

async function piPost(streamId, sub, body, btn) {
  const ringCommand = {
    "ring/identify": "identify",
    "ring/color": "color",
    "ring/compass": "compass",
    "ring/clear": "clear",
  }[sub];
  if (ringCommand) {
    return sendCommand(streamId, ringCommand, body, btn);
  }

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
      ui.video.srcObject = null;
      ui.status.textContent = "sim";
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

    const dist = document.createElementNS(SVG_NS, "text");
    dist.setAttribute("class", "mm-dist");
    dist.setAttribute("text-anchor", "middle");
    dist.setAttribute("dy", "48");
    dist.textContent = "";
    g.appendChild(dist);

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

  // Compass rose — fixed in screen space (NOT inside .mm-world), top-right.
  const compass = document.createElementNS(SVG_NS, "g");
  compass.setAttribute("class", "mm-compass");
  compass.setAttribute("transform", "translate(935 60)");
  compass.setAttribute("pointer-events", "none");

  const cOuter = document.createElementNS(SVG_NS, "circle");
  cOuter.setAttribute("class", "mm-compass-outer");
  cOuter.setAttribute("r", 38);
  compass.appendChild(cOuter);

  const cInner = document.createElementNS(SVG_NS, "circle");
  cInner.setAttribute("class", "mm-compass-inner");
  cInner.setAttribute("r", 28);
  compass.appendChild(cInner);

  // Tick marks every 30°
  for (let deg = 0; deg < 360; deg += 30) {
    const tick = document.createElementNS(SVG_NS, "line");
    const major = deg % 90 === 0;
    tick.setAttribute("class", major ? "mm-compass-tick major" : "mm-compass-tick");
    const rad = (deg - 90) * Math.PI / 180;
    const r1 = major ? 22 : 25;
    const r2 = 32;
    tick.setAttribute("x1", Math.cos(rad) * r1);
    tick.setAttribute("y1", Math.sin(rad) * r1);
    tick.setAttribute("x2", Math.cos(rad) * r2);
    tick.setAttribute("y2", Math.sin(rad) * r2);
    compass.appendChild(tick);
  }

  // North needle (red)
  const nNeedle = document.createElementNS(SVG_NS, "polygon");
  nNeedle.setAttribute("class", "mm-compass-n");
  nNeedle.setAttribute("points", "0,-26 5,0 -5,0");
  compass.appendChild(nNeedle);

  // South needle (muted)
  const sNeedle = document.createElementNS(SVG_NS, "polygon");
  sNeedle.setAttribute("class", "mm-compass-s");
  sNeedle.setAttribute("points", "0,26 5,0 -5,0");
  compass.appendChild(sNeedle);

  // Center pivot
  const pivot = document.createElementNS(SVG_NS, "circle");
  pivot.setAttribute("class", "mm-compass-pivot");
  pivot.setAttribute("r", 2.5);
  compass.appendChild(pivot);

  // Cardinal labels
  const cardinals = [
    { t: "N", x: 0, y: -14, cls: "mm-compass-label n" },
    { t: "E", x: 14, y: 0, cls: "mm-compass-label" },
    { t: "S", x: 0, y: 14, cls: "mm-compass-label" },
    { t: "W", x: -14, y: 0, cls: "mm-compass-label" },
  ];
  for (const c of cardinals) {
    const t = document.createElementNS(SVG_NS, "text");
    t.setAttribute("class", c.cls);
    t.setAttribute("x", c.x);
    t.setAttribute("y", c.y);
    t.setAttribute("text-anchor", "middle");
    t.setAttribute("dominant-baseline", "middle");
    t.textContent = c.t;
    compass.appendChild(t);
  }

  svg.appendChild(compass);

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
    mmRenderAll();
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

  const dist = g.querySelector(".mm-dist");
  if (dist) {
    const info = mmRangeInfo(id);
    if (info.hasPoi) {
      dist.textContent = info.onTarget
        ? `on target · ${info.count}/16`
        : `${info.distM.toFixed(1)}m · ${info.count}/16`;
      g.classList.toggle("on-target", info.onTarget);
    } else {
      dist.textContent = "";
      g.classList.remove("on-target");
    }
  }

  if (typeof renderBeOverlay === "function") renderBeOverlay();
}

function svgPointFromEvent(svg, evt) {
  const rect = svg.getBoundingClientRect();
  const x = (evt.clientX - rect.left) * (MAP_VB_W / rect.width);
  const y = (evt.clientY - rect.top)  * (MAP_VB_H / rect.height);
  return { x, y };
}

// Range / LED-count mapping.
//   d in viewBox px; diag = hypot(1000, 560) ≈ 1148 px.
//   map "meters" = px / 10 → map diagonal ≈ 115 m.
//   on-target if d < ON_TARGET_PX (whole ring green).
//   else count = round(1 + (1 - d/diag) * 14), clamped to 1..15.
const MAP_DIAG_PX = Math.hypot(MAP_VB_W, MAP_VB_H);
const ON_TARGET_PX = 40;
const PX_PER_M = 10;

function mmRangeInfo(id) {
  const s = mmState[id];
  if (!mmPOI) return { hasPoi: false, distPx: 0, distM: 0, count: 0, onTarget: false };
  const dx = (mmPOI.x - s.x) * MAP_VB_W;
  const dy = (mmPOI.y - s.y) * MAP_VB_H;
  const distPx = Math.hypot(dx, dy);
  const onTarget = distPx < ON_TARGET_PX;
  let count;
  if (onTarget) count = 16;
  else {
    const nDist = Math.min(1, distPx / MAP_DIAG_PX);
    count = Math.max(1, Math.min(15, Math.round(1 + (1 - nDist) * 14)));
  }
  return { hasPoi: true, distPx, distM: distPx / PX_PER_M, count, onTarget };
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
    const info = mmRangeInfo(id);
    const payload = { bearing_deg: b, ttl: 600 };
    if (info.hasPoi) {
      payload.count = info.count;
      if (info.onTarget) payload.on_target = true;
    } else {
      payload.count = 3;
    }
    piPost(id, "ring/compass", payload, null);
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
// Swarm commander — natural-language orders get parsed server-side into a
// structured plan (drone yaw + ground ring-compass), then executed here.
// ---------------------------------------------------------------------------
function wireSwarmChrome() {
  const open  = document.getElementById("btnSwarm");
  const panel = document.getElementById("swarmPanel");
  const close = document.getElementById("swarmClose");
  const form  = document.getElementById("swarmForm");
  const input = document.getElementById("swarmInput");
  const btn   = document.getElementById("swarmIssue");
  const log   = document.getElementById("swarmLog");
  if (!open || !panel || !form || !input || !btn || !log) return;

  open.addEventListener("click", () => {
    const showing = panel.style.display !== "none";
    panel.style.display = showing ? "none" : "";
    if (!showing) setTimeout(() => input.focus(), 50);
  });
  if (close) close.addEventListener("click", () => { panel.style.display = "none"; });

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    issueSwarmOrder(text, btn, log);
  });
}

async function issueSwarmOrder(text, btn, log) {
  const entry = document.createElement("div");
  entry.className = "swarm-entry";
  entry.innerHTML = `
    <div class="swarm-entry-head">
      <span class="swarm-entry-tag">ORDER</span>
      <span class="swarm-entry-text"></span>
    </div>
    <div class="swarm-entry-rationale">parsing…</div>
    <ul class="swarm-entry-actions"></ul>`;
  entry.querySelector(".swarm-entry-text").textContent = text;
  log.prepend(entry);
  // Cap log length.
  while (log.children.length > 8) log.removeChild(log.lastChild);

  const rationaleEl = entry.querySelector(".swarm-entry-rationale");
  const actionsEl   = entry.querySelector(".swarm-entry-actions");
  const prev = btn.textContent;
  btn.disabled = true; btn.textContent = "…";

  try {
    const context = collectSwarmContext();
    const res = await fetch("/api/ai/swarm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text, context }),
    });
    const out = await res.json().catch(() => ({}));
    if (!res.ok || out.error) {
      rationaleEl.textContent = `failed: ${out.error || res.status}`;
      rationaleEl.classList.add("err");
      return;
    }
    const plan = out.plan || {};
    rationaleEl.textContent = plan.rationale || "(no rationale)";
    executeSwarmPlan(plan, actionsEl);
  } catch (err) {
    rationaleEl.textContent = `failed: ${err.message}`;
    rationaleEl.classList.add("err");
  } finally {
    btn.textContent = prev; btn.disabled = false;
  }
}

function collectSwarmContext() {
  const ctx = { cams: [], drone: null };
  for (const id of STREAM_IDS) {
    ctx.cams.push({
      id,
      role:  NODE_ROLES[id],
      ready: !!readyState.get(id),
      bearing_deg: mmState && mmState[id] ? Math.round(mmState[id].bearing) : null,
    });
  }
  const d = cams.get("cam1") && cams.get("cam1").drone;
  if (d) {
    ctx.drone = {
      armed: d.armPill.classList.contains("live"),
      mode: (d.modePill.textContent || "").replace(/^mode\s+/, "") || null,
    };
  }
  return ctx;
}

function executeSwarmPlan(plan, actionsEl) {
  const addAction = (label, state) => {
    const li = document.createElement("li");
    li.className = `swarm-act ${state || ""}`.trim();
    li.textContent = label;
    actionsEl.appendChild(li);
    return li;
  };
  // Ground actions first (visible, safe) then drone pulse.
  if (Array.isArray(plan.ground)) {
    for (const g of plan.ground) {
      const dirLabel = g.on_target ? "on-target (green)" : `${g.bearing_deg}° · ${g.count} LED`;
      const li = addAction(`${g.cam} → ${dirLabel}`, "pending");
      const payload = { bearing_deg: g.bearing_deg, ttl: 2000, count: g.count };
      if (g.on_target) payload.on_target = true;
      piPost(g.cam, "ring/compass", payload, null)
        .then(() => { li.classList.remove("pending"); li.classList.add("ok"); })
        .catch(() => { li.classList.remove("pending"); li.classList.add("err"); });
      // Mirror onto minimap so the operator sees where the AI aimed each unit.
      if (mmState && mmState[g.cam]) {
        mmState[g.cam].bearing = g.bearing_deg;
        if (mmRenderUnit) mmRenderUnit(g.cam);
      }
    }
  }
  if (plan.drone && plan.drone.yaw_pwm != null) {
    const dir = plan.drone.yaw_pwm > 1500 ? "right"
              : plan.drone.yaw_pwm < 1500 ? "left" : "hold";
    const mag = Math.abs(plan.drone.yaw_pwm - 1500);
    const li = addAction(`cam1 → yaw ${dir} (±${mag} pwm · ${plan.drone.duration_ms}ms)`, "pending");
    const d = cams.get("cam1") && cams.get("cam1").drone;
    if (!d || typeof d.yawPulse !== "function") {
      li.classList.remove("pending"); li.classList.add("err");
      li.textContent += " · no drone link";
    } else {
      const ok = d.yawPulse(plan.drone.yaw_pwm, plan.drone.duration_ms);
      li.classList.remove("pending");
      li.classList.add(ok ? "ok" : "err");
      if (!ok) li.textContent += " · stick in use";
    }
  }
  if (!actionsEl.children.length) addAction("no actions in plan", "err");
}

wireSwarmChrome();

// ---------------------------------------------------------------------------
// Lambda "gather mapping data" — record live cams via MediaRecorder, upload
// the per-cam clips to a durable session, then poll the Lambda splat job.
// ---------------------------------------------------------------------------
const LAMBDA_SCAN_SECONDS = 90;
const LAMBDA_POLL_MS = 5000;
let fusionBusy = false;
let activeFusionSessionId = null;
let fusionRunToken = 0;

function wireFusionScan() {
  const btn = document.getElementById("btnFusionScan");
  const reset = document.getElementById("btnFusionReset");
  const statusEl = document.getElementById("fusionScanStatus");
  if (!btn || !statusEl) return;
  btn.addEventListener("click", () => {
    if (fusionBusy) return;
    startFusionScan(btn, statusEl).catch((err) => {
      setFusionStatus(statusEl, `failed: ${err.message || err}`, "err");
      btn.disabled = false; btn.textContent = "begin mapping";
      fusionBusy = false;
      loadSessions();
    });
  });
  if (reset) {
    reset.addEventListener("click", () => resetFusionSession(btn, statusEl));
  }
}

function setFusionStatus(el, text, state) {
  el.style.display = "";
  el.textContent = text;
  el.classList.remove("ok", "err", "working");
  if (state) el.classList.add(state);
}

async function startFusionScan(btn, statusEl) {
  const ready = STREAM_IDS.filter((id) => readyState.get(id) && cams.get(id));
  if (ready.length < 2) throw new Error("at least two live cams required");

  fusionBusy = true;
  const runToken = ++fusionRunToken;
  btn.disabled = true;

  // Server-side capture reads the MediaMTX paths directly; phone WHIP
  // publishers are constrained to gnd-2/gnd-3 while air-1 stays reserved.
  btn.textContent = "recording…";
  setFusionStatus(statusEl, `recording ${LAMBDA_SCAN_SECONDS}s from MediaMTX · ${ready.length} cams`, "working");
  const startRes = await fetch("/api/sessions/lambda/record-start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      title: `Mapping ${new Date().toLocaleString()}`,
      durationSeconds: LAMBDA_SCAN_SECONDS,
      cams: ready,
      options: {
        iterations: 1000,
        timestampsPerFeed: 2,
        maxImages: 12,
        keepWarm: true,
      },
    }),
  });
  const startBody = await startRes.json().catch(() => ({}));
  if (!startRes.ok || startBody.error) throw new Error(startBody.error || `http ${startRes.status}`);
  const sessionId = startBody.session?.id;
  if (!sessionId) throw new Error("session id missing");
  activeFusionSessionId = sessionId;
  renderSessions([startBody.session], true);

  // Poll durable session status until the Lambda job lands a viewer splat.
  btn.textContent = "processing…";
  while (true) {
    await new Promise((r) => setTimeout(r, LAMBDA_POLL_MS));
    if (runToken !== fusionRunToken || activeFusionSessionId !== sessionId) return;
    const r = await fetch(`/api/sessions/${sessionId}`);
    const body = await r.json().catch(() => ({}));
    const session = body.session;
    if (!r.ok || body.error || !session) throw new Error(body.error || `http ${r.status}`);
    const label = session.status || "processing";
    const progress = session.progress?.label || label;
    setFusionStatus(statusEl, `lambda · ${progress}`, "working");
    renderSessions([session], true);
    if (session.status === "completed" && session.splatUrl) {
      activeFusionSessionId = null;
      loadSplatUrl(session.splatUrl, session.title || session.id);
      setFusionStatus(statusEl, `scan ready · ${session.id}`, "ok");
      break;
    }
    if (session.status === "failed") {
      activeFusionSessionId = null;
      throw new Error(session.error || "lambda reconstruction failed");
    }
    if (session.status === "cancelled") {
      activeFusionSessionId = null;
      setFusionStatus(statusEl, "room reset · ready", "ok");
      break;
    }
  }

  btn.disabled = false;
  btn.textContent = "begin mapping";
  fusionBusy = false;
  loadSessions();
}

async function resetFusionSession(btn, statusEl) {
  const sessionId = activeFusionSessionId;
  fusionRunToken++;
  activeFusionSessionId = null;
  fusionBusy = false;
  if (btn) {
    btn.disabled = false;
    btn.textContent = "begin mapping";
  }
  setFusionStatus(statusEl, "room reset · ready", "ok");
  if (sessionId) {
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ reason: "reset by operator" }),
      });
      const body = await res.json().catch(() => ({}));
      if (body.session) renderSessions([body.session], true);
    } catch (err) {
      console.warn("session reset failed", err);
    }
  }
  loadSessions();
}

function recordCamClip(camId, durationMs) {
  return new Promise((resolve, reject) => {
    const cam = cams.get(camId);
    const video = cam && cam.video;
    const src = video && video.srcObject;
    if (!src || typeof MediaRecorder === "undefined") {
      reject(new Error(`cam ${camId} not recordable`));
      return;
    }
    const candidates = [
      "video/mp4;codecs=avc1",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    const mimeType = candidates.find((m) => MediaRecorder.isTypeSupported(m)) || "";
    let rec;
    try { rec = new MediaRecorder(src, mimeType ? { mimeType, videoBitsPerSecond: 2_000_000 } : undefined); }
    catch (err) { reject(err); return; }
    const chunks = [];
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => reject(new Error(`recorder error: ${e.error && e.error.name || "unknown"}`));
    rec.onstop = () => {
      const blob = new Blob(chunks, { type: rec.mimeType || mimeType || "video/webm" });
      resolve({ id: camId, blob });
    };
    rec.start();
    setTimeout(() => { try { rec.stop(); } catch {} }, durationMs);
  });
}

function loadSplatUrl(url, sceneName) {
  const frame = document.getElementById("splatFrame");
  const nameEl = document.getElementById("splatSceneName");
  if (frame) frame.src = `/splat/?url=${encodeURIComponent(url)}`;
  if (nameEl && sceneName) nameEl.textContent = sceneName;
}

function formatDuration(seconds) {
  const value = Number(seconds);
  if (!Number.isFinite(value) || value < 0) return "";
  const total = Math.round(value);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

function sessionComputeText(session) {
  const seconds = Number(
    session.compute?.inferenceSeconds
    ?? session.compute?.computeSeconds
    ?? session.result?.elapsed_s
    ?? session.job?.result?.elapsed_s,
  );
  if (!Number.isFinite(seconds)) return "";
  const prefix = session.compute?.running ? "compute running" : "compute/inference";
  return `${prefix} ${formatDuration(seconds)}`;
}

function streamLabel(streamId) {
  return NODE_LABELS[streamId] || streamId;
}

function renderSessions(seedSessions, merge = false) {
  const list = document.getElementById("sessionList");
  const count = document.getElementById("sessionCount");
  if (!list) return;

  let sessions = Array.isArray(seedSessions) ? seedSessions : [];
  if (merge && list._sessions) {
    const byId = new Map(list._sessions.map((session) => [session.id, session]));
    sessions.forEach((session) => byId.set(session.id, session));
    sessions = [...byId.values()].sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  }
  list._sessions = sessions;
  if (count) count.textContent = `${sessions.length}`;

  if (!sessions.length) {
    list.innerHTML = '<div class="session-empty mono">no mapping sessions yet</div>';
    return;
  }

  list.innerHTML = sessions.map((session) => {
    const cams = Array.isArray(session.cams) ? session.cams.map(streamLabel).join(", ") : "";
    const when = session.createdAt ? new Date(session.createdAt).toLocaleString() : "";
    const status = session.status || "unknown";
    const progress = session.progress?.label || session.error || "";
    const compute = sessionComputeText(session);
    const meta = [when, cams, compute].filter(Boolean).join(" · ");
    const tail = Array.isArray(session.progress?.tail) ? session.progress.tail.slice(-4) : [];
    const open = session.splatUrl
      ? `<button class="ctrl-btn mono session-open" data-url="${escapeHtml(session.splatUrl)}" data-name="${escapeHtml(session.title || session.id)}">open</button>`
      : "";
    const log = tail.length
      ? `<div class="session-log mono">${tail.map((event) => `<span>${escapeHtml(event.msg)}</span>`).join("")}</div>`
      : "";
    return `
      <article class="session-row ${escapeHtml(status)}">
        <div class="session-main">
          <strong>${escapeHtml(session.title || session.id)}</strong>
          <span>${escapeHtml(meta)}</span>
          ${progress ? `<em>${escapeHtml(progress)}</em>` : ""}
          ${log}
        </div>
        <span class="session-status mono">${escapeHtml(status)}</span>
        ${open}
      </article>`;
  }).join("");

  for (const button of list.querySelectorAll(".session-open")) {
    button.addEventListener("click", () => loadSplatUrl(button.dataset.url, button.dataset.name));
  }
}

async function loadSessions() {
  const list = document.getElementById("sessionList");
  if (!list) return;
  try {
    const res = await fetch("/api/sessions");
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(body.error || `http ${res.status}`);
    renderSessions(body.sessions || []);
  } catch (err) {
    list.innerHTML = `<div class="session-empty mono">${escapeHtml(err.message || err)}</div>`;
  }
}

function wireSessionHistory() {
  const refresh = document.getElementById("btnSessionsRefresh");
  if (refresh) refresh.addEventListener("click", loadSessions);
  loadSessions();
}

wireFusionScan();
wireSessionHistory();

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
// Browser geolocation — the operator (you) is the anchor. Once we have a fix,
// the minimap switches from "drag to position" to "relative to you, north up".
// cam1 (drone) autoplaces on the map when its GPS telemetry arrives.
// ---------------------------------------------------------------------------
const GEO_ORIGIN_KEY = "enel.geo.origin.v1";
const METERS_PER_MAP_PX = 0.2;  // 5 px = 1 m → map spans 200m × 112m
const geo = {
  user: null,      // { lat, lon, acc, ts } — latest browser fix
  origin: null,    // { lat, lon } — map center anchor; first fix or stored
  watchId: null,
  cam1Gps: null,   // last GPS telemetry from drone
};

function wireGeo() {
  const pill = document.getElementById("gpsStatus");
  const btn  = document.getElementById("btnGps");
  if (!pill || !btn) return;

  try {
    const raw = localStorage.getItem(GEO_ORIGIN_KEY);
    if (raw) geo.origin = JSON.parse(raw);
  } catch {}

  const setPill = (state, text, title) => {
    pill.classList.remove("ok", "err", "stale", "pending");
    pill.classList.add(state);
    pill.textContent = text;
    if (title) pill.title = title;
  };
  if (!("geolocation" in navigator)) {
    setPill("err", "gps n/a", "navigator.geolocation unavailable");
    btn.disabled = true;
    return;
  }

  const onFix = (pos) => {
    geo.user = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      acc: pos.coords.accuracy,
      ts:  Date.now(),
    };
    if (!geo.origin) {
      geo.origin = { lat: geo.user.lat, lon: geo.user.lon };
      try { localStorage.setItem(GEO_ORIGIN_KEY, JSON.stringify(geo.origin)); } catch {}
    }
    setPill("ok",
      `gps ±${Math.round(geo.user.acc)}m`,
      `${geo.user.lat.toFixed(6)}, ${geo.user.lon.toFixed(6)}`);
    geoRenderMarkers();
  };
  const onErr = (err) => {
    const msg = err && err.message ? err.message : "denied";
    setPill("err", "gps denied", msg);
  };
  const startWatch = () => {
    setPill("pending", "gps …");
    if (geo.watchId != null) navigator.geolocation.clearWatch(geo.watchId);
    geo.watchId = navigator.geolocation.watchPosition(onFix, onErr, {
      enableHighAccuracy: true,
      maximumAge: 2000,
      timeout: 15000,
    });
  };
  btn.addEventListener("click", startWatch);

  // Auto-start if permissions already granted.
  if (navigator.permissions && navigator.permissions.query) {
    navigator.permissions.query({ name: "geolocation" }).then((p) => {
      if (p.state === "granted") startWatch();
    }).catch(() => {});
  }
}

// Convert a {lat,lon} to map-viewbox pixels using equirectangular projection
// around geo.origin. Returns null when no origin.
function latLonToMap(lat, lon) {
  if (!geo.origin) return null;
  const latRef = geo.origin.lat * Math.PI / 180;
  const dLat = (lat - geo.origin.lat) * (Math.PI / 180);
  const dLon = (lon - geo.origin.lon) * (Math.PI / 180);
  // Meters offsets. Y axis inverts (north = -y in screen space).
  const eastM  = dLon * 6378137 * Math.cos(latRef);
  const northM = dLat * 6378137;
  const cx = MAP_VB_W / 2;
  const cy = MAP_VB_H / 2;
  return {
    x: cx + eastM  / METERS_PER_MAP_PX,
    y: cy - northM / METERS_PER_MAP_PX,
  };
}

// Called when either the user's GPS or cam1's GPS changes. Renders the two
// special markers (you, drone-gps) on top of the minimap's world group.
function geoRenderMarkers() {
  const svg = document.getElementById("miniMap");
  if (!svg) return;
  const world = svg.querySelector(".mm-world");
  if (!world) return;

  let g = world.querySelector(".mm-geo-layer");
  if (!g) {
    g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "mm-geo-layer");
    g.setAttribute("pointer-events", "none");
    world.appendChild(g);
  }
  g.innerHTML = "";

  if (geo.user) {
    const p = latLonToMap(geo.user.lat, geo.user.lon);
    if (p) {
      const ring = document.createElementNS(SVG_NS, "circle");
      ring.setAttribute("class", "mm-geo-me-accuracy");
      ring.setAttribute("cx", p.x); ring.setAttribute("cy", p.y);
      ring.setAttribute("r", Math.max(8, geo.user.acc / METERS_PER_MAP_PX));
      g.appendChild(ring);
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "mm-geo-me");
      dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
      dot.setAttribute("r", 6);
      g.appendChild(dot);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "mm-geo-label");
      label.setAttribute("x", p.x); label.setAttribute("y", p.y - 12);
      label.setAttribute("text-anchor", "middle");
      label.textContent = "you";
      g.appendChild(label);
    }
  }
  if (geo.cam1Gps) {
    const p = latLonToMap(geo.cam1Gps.lat, geo.cam1Gps.lon);
    if (p) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("class", "mm-geo-drone");
      dot.setAttribute("cx", p.x); dot.setAttribute("cy", p.y);
      dot.setAttribute("r", 7);
      g.appendChild(dot);
      const label = document.createElementNS(SVG_NS, "text");
      label.setAttribute("class", "mm-geo-label drone");
      label.setAttribute("x", p.x); label.setAttribute("y", p.y - 13);
      label.setAttribute("text-anchor", "middle");
      label.textContent = `air-1 · ${geo.cam1Gps.alt_m != null ? geo.cam1Gps.alt_m.toFixed(0)+"m" : ""}`;
      g.appendChild(label);
      // Update the stored cam1 position so the minimap unit arrow agrees.
      if (mmState && mmState.cam1) {
        mmState.cam1.x = clamp01(p.x / MAP_VB_W);
        mmState.cam1.y = clamp01(p.y / MAP_VB_H);
        mmRenderUnit && mmRenderUnit("cam1");
      }
    }
  }
}

// Called by the drone WS pipeline when cam1 telemetry lands.
function geoOnCam1Gps(gps) {
  if (!gps || gps.lat == null || gps.lon == null) return;
  geo.cam1Gps = gps;
  geoRenderMarkers();
}

wireGeo();

// Run the cold-boot intro, then reveal the dashboard. Skippable.
runBootIntro().then(() => start());

// ---------------------------------------------------------------------------
// Cold-boot intro: hex lattice draws itself in, ENEL glitches in, systems-log
// types out, then the overlay fades and the main UI rolls in.
// ---------------------------------------------------------------------------
function runBootIntro() {
  const overlay = document.getElementById("enelBoot");
  if (!overlay) return Promise.resolve();

  const canvas  = document.getElementById("enelBootLattice");
  const logEl   = document.getElementById("bootLog");
  const subEl   = document.getElementById("bootTitleSub");

  let skipped = false;
  const dismiss = () => new Promise((resolve) => {
    overlay.classList.add("dismissing");
    document.body.classList.remove("booting");
    document.body.classList.add("booted");
    setTimeout(() => {
      overlay.remove();
      resolve();
    }, 480);
  });

  const skipAll = (evt) => {
    if (skipped) return;
    skipped = true;
    if (evt) evt.preventDefault();
    dismiss();
  };
  window.addEventListener("keydown", skipAll, { once: true });
  overlay.addEventListener("click", skipAll, { once: true });

  // --- 1. hex lattice draw-in on canvas ---
  const latticeCtrl = drawBootLattice(canvas);

  // --- 2. subtitle typewriter ---
  const subFull = subEl.textContent;
  subEl.textContent = "";
  const typeSub = async () => {
    for (let i = 0; i <= subFull.length; i++) {
      if (skipped) return;
      subEl.textContent = subFull.slice(0, i);
      await sleep(32 + Math.random() * 24);
    }
  };

  // --- 3. systems-online log ---
  const logLines = [
    { tag: "[mesh]",   msg: "spanning tree converged",          state: "ok" },
    { tag: "[cam1]",   msg: "air-1 handshake",                   state: "ok" },
    { tag: "[cam2]",   msg: "gnd-1 handshake",                   state: "ok" },
    { tag: "[cam3]",   msg: "gnd-2 handshake",                   state: "ok" },
    { tag: "[cam4]",   msg: "gnd-3 handshake",                   state: "warn", stateText: "stale" },
    { tag: "[splat]",  msg: "gaussian cache primed",             state: "ok" },
    { tag: "[ai]",     msg: "vision + sitrep models online",     state: "ok" },
    { tag: "[uart]",   msg: "mavlink bridge · cam1",             state: "ok" },
    { tag: "[gps]",    msg: "geo lock acquiring",                state: "warn", stateText: "pending" },
    { tag: "[ring]",   msg: "sk6812 lattice armed",              state: "ok" },
    { tag: "[enel]",   msg: "operator console ready",            state: "ok", stateText: "go" },
  ];
  const runLog = async () => {
    await sleep(550);
    for (const line of logLines) {
      if (skipped) return;
      const li = document.createElement("li");
      li.className = line.state || "";
      li.innerHTML =
        `<span class="tag">${line.tag}</span>` +
        `<span class="msg">${line.msg}</span>` +
        `<span class="state">${line.stateText || line.state || ""}</span>`;
      logEl.appendChild(li);
      await sleep(130 + Math.random() * 120);
    }
  };

  return new Promise(async (resolve) => {
    const tasks = [typeSub(), runLog()];
    await Promise.all(tasks);
    // Hold for a beat so the user can read the last "go".
    if (!skipped) await sleep(550);
    latticeCtrl.stop();
    if (!skipped) await dismiss();
    resolve();
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function drawBootLattice(canvas) {
  const ctx = canvas.getContext("2d");
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  let W = 0, H = 0;

  const resize = () => {
    W = canvas.clientWidth; H = canvas.clientHeight;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  };
  resize();
  window.addEventListener("resize", resize);

  // Triangular lattice vertices with travelling pulse rings.
  const SPACING = 62;
  const start = performance.now();
  let raf;

  const tick = () => {
    const t = (performance.now() - start) / 1000;
    ctx.clearRect(0, 0, W, H);

    // Build points each frame for simplicity; pts count is low.
    const rows = Math.ceil(H / (SPACING * 0.866)) + 2;
    const cols = Math.ceil(W / SPACING) + 2;

    // Lines
    ctx.lineWidth = 1;
    for (let r = -1; r < rows; r++) {
      const y = r * SPACING * 0.866;
      const xOff = (r & 1) ? SPACING / 2 : 0;
      for (let c = -1; c < cols; c++) {
        const x = c * SPACING + xOff;
        // Draw edges down-left, down-right, right (no dupes).
        const neighbors = [
          [x + SPACING, y],
          [x + SPACING / 2 - (r & 1 ? 0 : SPACING / 2), y + SPACING * 0.866],
          [x + SPACING / 2 + (r & 1 ? SPACING / 2 : 0), y + SPACING * 0.866],
        ];
        for (const [nx, ny] of neighbors) {
          // Distance from a moving pulse origin gives the brightness.
          const cx = (Math.sin(t * 0.25) * 0.5 + 0.5) * W;
          const cy = (Math.cos(t * 0.18) * 0.5 + 0.5) * H;
          const d1 = Math.hypot((x + nx) / 2 - cx, (y + ny) / 2 - cy);
          const pulse = ((t * 160) - d1) % 420;
          const near = Math.max(0, 1 - Math.abs(pulse - 40) / 140);
          const baseAlpha = 0.05 + near * 0.55;
          ctx.strokeStyle = `rgba(182, 210, 109, ${baseAlpha.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(x, y);
          ctx.lineTo(nx, ny);
          ctx.stroke();
        }
      }
    }

    // Vertex dots on top.
    for (let r = -1; r < rows; r++) {
      const y = r * SPACING * 0.866;
      const xOff = (r & 1) ? SPACING / 2 : 0;
      for (let c = -1; c < cols; c++) {
        const x = c * SPACING + xOff;
        const flicker = 0.15 + 0.25 * Math.sin(t * 4 + x * 0.13 + y * 0.07);
        ctx.fillStyle = `rgba(182, 210, 109, ${flicker.toFixed(3)})`;
        ctx.beginPath(); ctx.arc(x, y, 1.4, 0, Math.PI * 2); ctx.fill();
      }
    }

    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);

  return {
    stop: () => {
      if (raf) cancelAnimationFrame(raf);
      window.removeEventListener("resize", resize);
    },
  };
}

window.addEventListener("beforeunload", () => {
  for (const r of readers.values()) r.close();
});
