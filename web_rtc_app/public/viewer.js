const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const STATE_POLL_MS = 3000;

const stage = document.getElementById("flowStage");
const pipesSvg = document.getElementById("flowPipes");
const serverStatus = document.getElementById("serverStatus");

const cams = new Map();
const readers = new Map();

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

  const header = el("div", "cam-header");
  const title = el("div", "cam-title mono", streamId);
  const status = el("div", "cam-status", "offline");
  header.appendChild(title);
  header.appendChild(status);

  const videoWrap = el("div", "cam-video-wrap");
  const video = document.createElement("video");
  video.autoplay = true;
  video.playsInline = true;
  video.muted = true;
  videoWrap.appendChild(video);

  const stats = el("div", "cam-stats mono");
  stats.appendChild(el("span", "stats-bitrate", "— kbps"));
  stats.appendChild(el("span", "stats-uptime", "—"));

  const controls = el("div", "cam-controls");
  const btnIdentify = el("button", "ctrl-btn", "Identify");
  btnIdentify.title = "Pulse the ring bright cyan for 5s";

  const colorInput = document.createElement("input");
  colorInput.type = "color";
  colorInput.className = "ctrl-color";
  colorInput.value = "#80ed99";
  colorInput.title = "Override ring color (60s)";

  const btnClear = el("button", "ctrl-btn ctrl-btn--ghost", "Clear");
  btnClear.title = "Remove override, resume auto mode";

  btnIdentify.addEventListener("click", () => piPost(streamId, "ring/identify", { ttl: 5 }, btnIdentify));
  colorInput.addEventListener("change", () => {
    const { r, g, b } = hexToRgb(colorInput.value);
    piPost(streamId, "ring/color", { r, g, b, ttl: 60 }, colorInput);
  });
  btnClear.addEventListener("click", () => piPost(streamId, "ring/clear", {}, btnClear));

  controls.appendChild(btnIdentify);
  controls.appendChild(colorInput);
  controls.appendChild(btnClear);

  container.appendChild(header);
  container.appendChild(videoWrap);
  container.appendChild(stats);
  container.appendChild(controls);

  return { status, video, stats, controls };
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
      btn.textContent = res.ok ? "✓" : "err";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 900);
    }
  } catch (err) {
    if (btn && btn.tagName === "BUTTON") {
      btn.textContent = "err";
      setTimeout(() => { btn.textContent = prev; btn.disabled = false; }, 1200);
    }
    console.error(`pi control ${streamId}/${sub} failed`, err);
  }
}

function attachReader(streamId, baseUrl, ui) {
  const reader = new MediaMTXWebRTCReader({
    url: `${baseUrl}/${streamId}/whep`,
    onTrack: (event) => {
      ui.video.srcObject = event.streams[0];
      ui.status.textContent = "live";
      ui.status.className = "cam-status live";
    },
    onError: (err) => {
      ui.status.textContent = "offline";
      ui.status.className = "cam-status offline";
      console.warn(`${streamId}:`, err);
    },
  });
  readers.set(streamId, reader);
}

function fmtUptime(seconds) {
  if (seconds == null || !isFinite(seconds)) return "—";
  const s = Math.floor(seconds);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3600)}h${Math.floor((s % 3600) / 60)}m`;
}

const lastBytes = new Map();
const lastPollTs = new Map();

function updateStats(streamId, slot) {
  const cam = cams.get(streamId);
  if (!cam) return;
  const bitrateEl = cam.stats.querySelector(".stats-bitrate");
  const uptimeEl = cam.stats.querySelector(".stats-uptime");

  if (!slot || !slot.ready) {
    bitrateEl.textContent = "— kbps";
    uptimeEl.textContent = "—";
    lastBytes.delete(streamId);
    return;
  }

  const now = Date.now();
  const prevBytes = lastBytes.get(streamId);
  const prevTs = lastPollTs.get(streamId);
  if (prevBytes != null && prevTs != null && slot.bytesReceived != null) {
    const dBytes = Math.max(0, slot.bytesReceived - prevBytes);
    const dSec = Math.max(0.001, (now - prevTs) / 1000);
    const kbps = Math.round((dBytes * 8) / 1000 / dSec);
    bitrateEl.textContent = `${kbps.toLocaleString()} kbps`;
  }
  lastBytes.set(streamId, slot.bytesReceived ?? 0);
  lastPollTs.set(streamId, now);

  if (slot.readyTime) {
    const up = (Date.now() - new Date(slot.readyTime).getTime()) / 1000;
    uptimeEl.textContent = `up ${fmtUptime(up)}`;
  }
}

async function pollState() {
  try {
    const res = await fetch("/api/state");
    if (!res.ok) throw new Error(`state api ${res.status}`);
    const body = await res.json();
    serverStatus.textContent = `MediaMTX · ${body.slots.filter((s) => s.ready).length}/4 live`;
    for (const slot of body.slots) updateStats(slot.id, slot);
  } catch (err) {
    serverStatus.textContent = "MediaMTX · error";
    console.warn("state poll failed", err);
  }
}

function nodeCenter(node, container) {
  const r = node.getBoundingClientRect();
  const p = container.getBoundingClientRect();
  return { x: r.left + r.width / 2 - p.left, y: r.top + r.height / 2 - p.top };
}

const SVG_NS = "http://www.w3.org/2000/svg";

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
    const cam = cams.get(streamId);
    if (!cam) continue;
    const src = nodeCenter(cam.container, stage);
    src.y = cam.container.getBoundingClientRect().bottom - stageRect.top - 6;
    const midY = (src.y + sink.y) / 2;
    const d = `M ${src.x} ${src.y} C ${src.x} ${midY}, ${sink.x} ${midY}, ${sink.x} ${sink.y}`;

    const path = document.createElementNS(SVG_NS, "path");
    path.setAttribute("d", d);
    path.setAttribute("class", `pipe pipe-${streamId}`);
    pipesSvg.appendChild(path);

    // Three staggered pulses per path for a continuous flow feel.
    for (let i = 0; i < 3; i++) {
      const dot = document.createElementNS(SVG_NS, "circle");
      dot.setAttribute("r", "3");
      dot.setAttribute("class", "pipe-dot");
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

function start() {
  const baseUrl = mediaMtxBaseUrl();
  serverStatus.textContent = "MediaMTX · connecting";

  for (const streamId of STREAM_IDS) {
    const container = stage.querySelector(`[data-cam="${streamId}"]`);
    const ui = buildCamCard(container, streamId);
    cams.set(streamId, { container, ...ui });
    attachReader(streamId, baseUrl, ui);
  }

  requestAnimationFrame(() => drawPipes());
  setupResizeObserver();
  pollState();
  setInterval(pollState, STATE_POLL_MS);
}

start();

window.addEventListener("beforeunload", () => {
  for (const r of readers.values()) r.close();
});
