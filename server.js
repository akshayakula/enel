const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const { pipeline: streamPipeline } = require("stream/promises");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const Busboy = require("busboy");
const AdmZip = require("adm-zip");
const { WebSocketServer } = require("ws");

// Load .env at startup (no dotenv dep needed — tiny parser).
(() => {
  try {
    const envPath = path.join(__dirname, ".env");
    if (!fs.existsSync(envPath)) return;
    for (const line of fs.readFileSync(envPath, "utf8").split("\n")) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let val = m[2];
      if (/^".*"$/.test(val) || /^'.*'$/.test(val)) val = val.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = val;
    }
  } catch (err) { console.warn(".env parse skipped:", err.message); }
})();

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 3001);
const USE_HTTPS = process.env.ENEL_HTTPS !== "0";
const PUBLIC_DIR = path.join(__dirname, "web_rtc_app", "public");
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = path.join(CERT_DIR, "dev-cert.pem");
const KEY_PATH = path.join(CERT_DIR, "dev-key.pem");
const DATA_DIR = path.resolve(process.env.DATA_DIR || __dirname);
const GAUSSIAN_SPLATS_BUILD_DIR = path.join(
  __dirname,
  "node_modules",
  "@mkkellogg",
  "gaussian-splats-3d",
  "build",
);
const THREE_BUILD_DIR = path.join(__dirname, "node_modules", "three", "build");
const SPLAT_PKG_DIR = path.join(__dirname, "video_to_gaussian_splat");
const SPLAT_WORKSPACES_DIR = path.resolve(
  process.env.SPLAT_WORKSPACES_DIR || path.join(SPLAT_PKG_DIR, "workspaces"),
);
const SPLAT_PYTHON = process.env.SPLAT_PYTHON
  || path.join(SPLAT_PKG_DIR, ".venv", "bin", "python");
const RECORDINGS_DIR = path.resolve(process.env.RECORDINGS_DIR || path.join(__dirname, "recordings"));
const EXPORTS_DIR = path.resolve(process.env.EXPORTS_DIR || path.join(__dirname, "exports", "compiled"));
const SCENES_DIR = path.resolve(process.env.SCENES_DIR || path.join(DATA_DIR, "scenes"));
const SESSIONS_DIR = path.resolve(process.env.SESSIONS_DIR || path.join(DATA_DIR, "sessions"));
const SESSION_INDEX_PATH = path.join(SESSIONS_DIR, "index.json");
const MEDIAMTX_API_BASE = (process.env.MEDIAMTX_API_BASE || "http://127.0.0.1:9997").replace(/\/$/, "");
const MEDIAMTX_RTSP_BASE = process.env.MEDIAMTX_RTSP_BASE || "rtsp://127.0.0.1:8554";
const DEFAULT_CAPTURE_SECONDS = Number(process.env.LAMBDA_CAPTURE_SECONDS || 90);
const DEFAULT_SPLAT_KEEP_WARM = process.env.SPLAT_KEEP_WARM === "1";
const splatJobs = new Map(); // jobId -> { proc, startedAt, workspace, inputPaths }

for (const dir of [DATA_DIR, SCENES_DIR, SESSIONS_DIR, SPLAT_WORKSPACES_DIR]) {
  fs.mkdirSync(dir, { recursive: true });
}

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "8mb" }));
app.use("/vendor/gaussian-splats-3d", express.static(GAUSSIAN_SPLATS_BUILD_DIR));
app.use("/vendor/three", express.static(THREE_BUILD_DIR));
app.use(
  "/scenes",
  express.static(SCENES_DIR, {
    setHeaders(res, filePath) {
      if ([".splat", ".ksplat", ".ply", ".spz"].includes(path.extname(filePath).toLowerCase())) {
        res.setHeader("Content-Type", "application/octet-stream");
      }
    },
  }),
);

app.get("/health", (_req, res) => {
  res.json({ ok: true, protocol: USE_HTTPS ? "https" : "http" });
});

// Battery telemetry is pushed by each Pi and rendered as a badge on cam tiles.
const batteryStore = new Map(); // cam -> { voltage, pct, charging, ts }
const BATTERY_STALE_MS = 30000;
const BATTERY_ALIASES = {
  gnd1: "cam1",
  "gnd-1": "cam1",
  air1: "cam1",
  "air-1": "cam1",
};
const normalizeBatteryCam = (cam) => BATTERY_ALIASES[String(cam || "").toLowerCase()] || cam;

app.post("/api/battery/:cam", (req, res) => {
  const cam = normalizeBatteryCam(req.params.cam);
  const { voltage, pct, charging } = req.body || {};
  if (typeof pct !== "number") return res.status(400).json({ error: "pct (number) required" });
  batteryStore.set(cam, {
    voltage: typeof voltage === "number" ? voltage : null,
    pct: Math.max(0, Math.min(100, pct)),
    charging: !!charging,
    ts: Date.now(),
  });
  res.json({ ok: true });
});

app.get("/api/battery/:cam", (req, res) => {
  const d = batteryStore.get(normalizeBatteryCam(req.params.cam));
  if (!d) return res.json({ pct: null, stale: true });
  const ageMs = Date.now() - d.ts;
  res.json({ voltage: d.voltage, pct: d.pct, charging: d.charging, ageMs, stale: ageMs > BATTERY_STALE_MS });
});

// Publish mode is also pulled by Pis, so the dashboard works across LAN/Fly.
const PUBLISH_MODES = new Set(["both", "lan", "server"]);
const controlStore = new Map(); // cam -> { mode, ts }

app.get("/api/control/:cam", (req, res) => {
  const d = controlStore.get(req.params.cam);
  if (!d) return res.json({ mode: "both", ts: 0 });
  res.json({ mode: d.mode, ts: d.ts });
});

app.post("/api/control/:cam", (req, res) => {
  const mode = String((req.body && req.body.mode) || "").toLowerCase();
  if (!PUBLISH_MODES.has(mode)) return res.status(400).json({ error: "mode must be both|lan|server" });
  controlStore.set(req.params.cam, { mode, ts: Date.now() });
  res.json({ ok: true, mode });
});

const STREAM_SLOTS = ["cam1", "cam2", "cam3", "cam4"];
const STREAM_LABELS = { cam1: "air-1", cam2: "gnd-1", cam3: "gnd-2", cam4: "gnd-3" };
const PHONE_STREAM_SLOTS = ["cam3", "cam4"];

const PI_CONTROL_PORT = 8088;
const PI_CONTROL_TIMEOUT_MS = 3000;
const piHostForSlot = (slot) => slot.replace(/^cam(\d+)$/, "pi-cam-$1.local");

async function currentStreamSlots() {
  const response = await fetch(`${MEDIAMTX_API_BASE}/v3/paths/list`);
  if (!response.ok) {
    throw makeHttpError(502, `mediamtx api ${response.status}`);
  }
  const body = await response.json();
  const byName = new Map((body.items || []).map((p) => [p.name, p]));
  return STREAM_SLOTS.map((id) => {
    const p = byName.get(id);
    if (!p) return { id, ready: false };
    return {
      id,
      ready: Boolean(p.ready),
      readers: Array.isArray(p.readers) ? p.readers.length : 0,
      tracks: p.tracks || [],
      bytesReceived: p.bytesReceived ?? null,
      bytesSent: p.bytesSent ?? null,
      readyTime: p.readyTime ?? null,
    };
  });
}

app.get("/api/state", async (_req, res) => {
  try {
    res.json({ slots: await currentStreamSlots() });
  } catch (err) {
    res.status(err.statusCode || 502).json({ error: String(err.message || err) });
  }
});

// One-shot commands use a pull model so Fly.io never has to reach into a Pi's
// LAN. The browser writes here; pi-control polls this endpoint and executes the
// newest command it has not seen.
const commandStore = new Map(); // cam -> { cmd, args, ts }

app.post("/api/command/:cam", (req, res) => {
  const cam = req.params.cam;
  if (!STREAM_SLOTS.includes(cam)) return res.status(404).json({ error: "unknown cam" });
  const cmd = String((req.body && req.body.cmd) || "");
  if (!cmd) return res.status(400).json({ error: "cmd required" });
  commandStore.set(cam, { cmd, args: (req.body && req.body.args) || {}, ts: Date.now() });
  res.json({ ok: true });
});

app.get("/api/command/:cam", (req, res) => {
  const cam = req.params.cam;
  if (!STREAM_SLOTS.includes(cam)) return res.status(404).json({ error: "unknown cam" });
  const d = commandStore.get(cam);
  if (!d) return res.json({ cmd: null, ts: 0 });
  res.json(d);
});

// Proxy a narrow set of pi-control endpoints per cam id.
// Example: POST /api/pi/cam1/ring/identify  -> http://pi-cam-1.local:8088/ring/identify
app.all("/api/pi/:id/:path(*)", async (req, res) => {
  const { id, path: subPath } = req.params;
  if (!STREAM_SLOTS.includes(id)) {
    return res.status(404).json({ error: "unknown cam" });
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), PI_CONTROL_TIMEOUT_MS);
  try {
    const target = `http://${piHostForSlot(id)}:${PI_CONTROL_PORT}/${subPath}`;
    const init = {
      method: req.method,
      signal: controller.signal,
      headers: { "content-type": "application/json" },
    };
    if (req.method !== "GET" && req.method !== "HEAD") {
      init.body = JSON.stringify(req.body || {});
    }
    const upstream = await fetch(target, init);
    const text = await upstream.text();
    res.status(upstream.status);
    const ct = upstream.headers.get("content-type");
    if (ct) res.setHeader("content-type", ct);
    res.send(text);
  } catch (err) {
    res.status(502).json({ error: String(err && err.message ? err.message : err) });
  } finally {
    clearTimeout(timer);
  }
});

// -----------------------------------------------------------------------
// AI endpoints. Key stays server-side; browser posts frames + short prompts.
// -----------------------------------------------------------------------
const OPENAI_API_KEY    = process.env.OPENAI_API_KEY || "";
const AI_VISION_MODEL   = process.env.AI_VISION_MODEL || "gpt-4o-mini";
const AI_TEXT_MODEL     = process.env.AI_TEXT_MODEL   || "gpt-4o-mini";
const AI_TIMEOUT_MS     = 20000;

async function callOpenAI(body) {
  if (!OPENAI_API_KEY) throw new Error("OPENAI_API_KEY not set");
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), AI_TIMEOUT_MS);
  try {
    const r = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      signal: ctl.signal,
      headers: {
        "content-type": "application/json",
        "authorization": `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify(body),
    });
    const text = await r.text();
    if (!r.ok) throw new Error(`openai ${r.status}: ${text.slice(0, 300)}`);
    return JSON.parse(text);
  } finally { clearTimeout(t); }
}

app.get("/api/ai/status", (_req, res) => {
  res.json({ configured: Boolean(OPENAI_API_KEY), vision: AI_VISION_MODEL, text: AI_TEXT_MODEL });
});

// Per-frame scene description. POST { cam, image_b64, prompt? } -> { text }
app.post("/api/ai/describe", async (req, res) => {
  try {
    const { cam, image_b64, prompt } = req.body || {};
    if (!image_b64) return res.status(400).json({ error: "image_b64 required" });
    const sys = "You are an aerial/ground ops analyst. Given one video frame, " +
      "reply in ONE short sentence (≤ 18 words): describe the dominant subject, " +
      "motion, and anything notable. No hedging, no preamble.";
    const userPrompt = prompt || "What is in this frame right now?";
    const data = await callOpenAI({
      model: AI_VISION_MODEL,
      max_tokens: 80,
      messages: [
        { role: "system", content: sys },
        { role: "user", content: [
          { type: "text", text: `${userPrompt} (cam: ${cam || "?"})` },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${image_b64}`, detail: "low" } },
        ] },
      ],
    });
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    res.json({ cam, text });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Swarm sitrep — caller sends one or more frames, gets unified report + per-cam lines.
app.post("/api/ai/sitrep", async (req, res) => {
  try {
    const frames = Array.isArray(req.body?.frames) ? req.body.frames.slice(0, 4) : [];
    if (!frames.length) return res.status(400).json({ error: "frames required" });
    const content = [
      { type: "text", text:
        "You are coordinating a 4-unit sensor swarm (1 airborne drone + ground units). " +
        "Produce: (1) a one-line headline of the overall situation, " +
        "(2) per-cam one-line observation labeled by cam id. " +
        "Keep it terse, mission-style. No markdown." },
    ];
    for (const f of frames) {
      if (!f?.image_b64) continue;
      content.push({ type: "text", text: `— ${f.cam || "?"}:` });
      content.push({ type: "image_url", image_url: {
        url: `data:image/jpeg;base64,${f.image_b64}`, detail: "low",
      }});
    }
    const data = await callOpenAI({
      model: AI_VISION_MODEL,
      max_tokens: 240,
      messages: [{ role: "user", content }],
    });
    const text = data.choices?.[0]?.message?.content?.trim() || "";
    res.json({ text, cams: frames.map(f => f.cam) });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Swarm commander — natural-language order → structured plan JSON.
// Browser executes the plan client-side (ground ring-compass + drone yaw pulse).
// Drone throttle is intentionally NOT reachable from the AI — yaw only.
app.post("/api/ai/swarm", async (req, res) => {
  try {
    const { text, context } = req.body || {};
    if (!text || typeof text !== "string") return res.status(400).json({ error: "text required" });
    const sys = [
      "You are the commander of a 4-unit sensor swarm.",
      "Unit roster:",
      "  cam1 = airborne drone. You may command YAW ONLY.",
      "          yaw PWM range: 1000..2000 where 1500=hold, 1000=hard left, 2000=hard right.",
      "          Typical short turn: 1700 (gentle right) or 1300 (gentle left) for 600-1500 ms.",
      "          You MAY NOT command throttle, roll, pitch, arm, disarm, or altitude.",
      "  cam2, cam3, cam4 = ground units with 16-LED compass rings.",
      "          bearing_deg: 0..359 (0=north). count: 1..15 LEDs lit centered on bearing (more = stronger \"go this way\").",
      "          on_target: true lights the whole ring green (unit is on the objective).",
      "Return STRICT JSON with the exact schema:",
      "  {",
      '    "rationale": "<one short sentence of intent>",',
      '    "drone": { "yaw_pwm": <int 1000..2000>, "duration_ms": <int 0..3000> } | null,',
      '    "ground": [ { "cam": "cam2"|"cam3"|"cam4", "bearing_deg": <int 0..359>, "count": <int 1..15>, "on_target": <bool> }, ... ]',
      "  }",
      "Rules: omit drone (null) if no yaw needed. Omit ground ([]) if none. Never invent cams. Never exceed ranges. No prose outside JSON.",
    ].join("\n");
    const data = await callOpenAI({
      model: AI_TEXT_MODEL,
      max_tokens: 400,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: sys },
        { role: "user", content: `State: ${JSON.stringify(context || {})}\nOrder: ${text}` },
      ],
    });
    let plan;
    try { plan = JSON.parse(data.choices?.[0]?.message?.content || "{}"); }
    catch { return res.status(502).json({ error: "ai returned non-json" }); }

    // --- clamp + sanitize ----------------------------------------------------
    const out = { rationale: "", drone: null, ground: [] };
    if (typeof plan.rationale === "string") out.rationale = plan.rationale.slice(0, 200);
    if (plan.drone && typeof plan.drone === "object") {
      const pwm = Math.round(Number(plan.drone.yaw_pwm));
      const dur = Math.round(Number(plan.drone.duration_ms));
      if (Number.isFinite(pwm) && Number.isFinite(dur) && dur > 0) {
        out.drone = {
          yaw_pwm: Math.max(1000, Math.min(2000, pwm)),
          duration_ms: Math.max(50, Math.min(3000, dur)),
        };
      }
    }
    if (Array.isArray(plan.ground)) {
      for (const g of plan.ground.slice(0, 3)) {
        if (!g || !["cam2", "cam3", "cam4"].includes(g.cam)) continue;
        const bearing = Math.round(Number(g.bearing_deg));
        const count   = Math.round(Number(g.count));
        if (!Number.isFinite(bearing) || !Number.isFinite(count)) continue;
        out.ground.push({
          cam: g.cam,
          bearing_deg: ((bearing % 360) + 360) % 360,
          count: Math.max(1, Math.min(15, count)),
          on_target: Boolean(g.on_target),
        });
      }
    }
    res.json({ plan: out });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Natural-language intent → actions. POST { text, cams:[{id,ready}] } -> { target_bearing_per_cam, poi?, reply }
// Useful later for "everyone face the truck" style commands. MVP returns a text reply only.
app.post("/api/ai/intent", async (req, res) => {
  try {
    const { text, context } = req.body || {};
    if (!text) return res.status(400).json({ error: "text required" });
    const data = await callOpenAI({
      model: AI_TEXT_MODEL,
      max_tokens: 160,
      messages: [
        { role: "system", content:
          "You are an ops assistant. Interpret short operator commands about a 4-cam sensor swarm. " +
          "Reply in one terse line (≤ 20 words)." },
        { role: "user", content: `State: ${JSON.stringify(context || {})}\nCommand: ${text}` },
      ],
    });
    res.json({ text: data.choices?.[0]?.message?.content?.trim() || "" });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

app.get("/api/next-slot", async (req, res) => {
  try {
    const role = String(req.query.role || req.query.kind || "phone");
    const candidates = role === "all" ? STREAM_SLOTS : PHONE_STREAM_SLOTS;
    const response = await fetch(`${MEDIAMTX_API_BASE}/v3/paths/list`);
    if (!response.ok) {
      res.status(502).json({ error: `mediamtx api ${response.status}` });
      return;
    }
    const body = await response.json();
    const busy = new Set(
      (body.items || [])
        .filter((p) => p.ready === true)
        .map((p) => p.name),
    );
    const free = candidates.find((id) => !busy.has(id));
    if (!free) {
      res.status(503).json({
        error: role === "all" ? "all slots busy" : "phone slots gnd-2/gnd-3 busy",
        candidates,
        busy: [...busy],
      });
      return;
    }
    res.json({ streamId: free, label: STREAM_LABELS[free] || free, candidates, busy: [...busy] });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// ---------------------------------------------------------------------------
// Kiri Engine — "gather mapping data" pipeline.
//
// Flow: browser records ~15 s of each live cam via MediaRecorder (webm), POSTs
// all clips as multipart. Server concatenates with ffmpeg into one mp4, uploads
// to Kiri's 3DGS video endpoint (1 job / 1 unified scan). Browser polls status;
// once Kiri returns status=2 we fetch the signed zip, extract the PLY, and the
// viewer's splat iframe loads it directly (main.js handles .ply natively).
// ---------------------------------------------------------------------------
const KIRI_API_KEY  = process.env.KIRI_API_KEY  || "";
const KIRI_API_BASE = process.env.KIRI_API_BASE || "https://api.kiriengine.app/api/v1/open";
const KIRI_SESSIONS = new Map();   // sid → { serialize, status, plyUrl, error, createdAt }

function kiriFetch(pathTail, init = {}) {
  if (!KIRI_API_KEY) throw new Error("KIRI_API_KEY not set");
  init.headers = Object.assign({}, init.headers || {}, {
    "Authorization": `Bearer ${KIRI_API_KEY}`,
  });
  return fetch(`${KIRI_API_BASE}${pathTail}`, init);
}

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    p.stderr.on("data", (d) => { stderr += d.toString(); if (stderr.length > 4000) stderr = stderr.slice(-4000); });
    p.on("close", (code) => code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}: ${stderr.slice(-500)}`)));
    p.on("error", reject);
  });
}

async function captureLiveCam(camId, outPath, durationSeconds) {
  const inputUrl = `${MEDIAMTX_RTSP_BASE.replace(/\/$/, "")}/${camId}`;
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const baseArgs = [
    "-hide_banner",
    "-loglevel", "warning",
    "-y",
    "-rtsp_transport", "tcp",
    "-i", inputUrl,
    "-t", String(durationSeconds),
    "-an",
  ];
  try {
    await runFfmpeg([
      ...baseArgs,
      "-c:v", "copy",
      "-movflags", "+faststart",
      outPath,
    ]);
  } catch (copyErr) {
    await runFfmpeg([
      ...baseArgs,
      "-c:v", "libx264",
      "-preset", "veryfast",
      "-tune", "zerolatency",
      "-pix_fmt", "yuv420p",
      "-movflags", "+faststart",
      outPath,
    ]).catch((transcodeErr) => {
      throw new Error(`capture ${camId} failed: ${copyErr.message}; fallback failed: ${transcodeErr.message}`);
    });
  }
  return outPath;
}

function makeHttpError(statusCode, message) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function nowCompact() {
  return new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
}

function newSessionId() {
  return `sess-${nowCompact()}-${crypto.randomBytes(2).toString("hex")}`;
}

function readSessionIndex() {
  try {
    const parsed = JSON.parse(fs.readFileSync(SESSION_INDEX_PATH, "utf8"));
    return Array.isArray(parsed.sessions) ? parsed.sessions : [];
  } catch {
    return [];
  }
}

function writeSessionIndex(sessions) {
  fs.mkdirSync(SESSIONS_DIR, { recursive: true });
  const tmp = `${SESSION_INDEX_PATH}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ sessions }, null, 2));
  fs.renameSync(tmp, SESSION_INDEX_PATH);
}

function sessionDir(sessionId) {
  return path.join(SESSIONS_DIR, sessionId);
}

function sessionRecordPath(sessionId) {
  return path.join(sessionDir(sessionId), "session.json");
}

function readSession(sessionId) {
  const record = readJsonSafe(sessionRecordPath(sessionId));
  if (record) return record;
  return readSessionIndex().find((session) => session.id === sessionId) || null;
}

function saveSession(session) {
  const now = new Date().toISOString();
  const record = { ...session, updatedAt: now };
  if (!record.createdAt) record.createdAt = now;
  fs.mkdirSync(sessionDir(record.id), { recursive: true });
  fs.writeFileSync(sessionRecordPath(record.id), JSON.stringify(record, null, 2));

  const sessions = readSessionIndex();
  const idx = sessions.findIndex((item) => item.id === record.id);
  if (idx >= 0) sessions[idx] = record;
  else sessions.push(record);
  sessions.sort((a, b) => String(b.createdAt || b.id).localeCompare(String(a.createdAt || a.id)));
  writeSessionIndex(sessions);
  return record;
}

function patchSession(sessionId, patch) {
  const existing = readSession(sessionId);
  if (!existing) return null;
  return saveSession({ ...existing, ...patch });
}

function simplifyEvent(event) {
  if (!event || !event.msg) return null;
  let msg = String(event.msg).replace(/^\[remote\]\s*/, "").trim();
  if (!msg || /^[-=]+$/.test(msg)) return null;
  if (msg.length > 180) msg = `${msg.slice(0, 177)}...`;
  return {
    ts: event.ts || null,
    level: event.level || "INFO",
    msg,
  };
}

function summarizeProgress(session, events = []) {
  const lastEvent = [...events].reverse().find((event) => event?.msg);
  const phase = lastEvent?.msg || session.status || "queued";
  const label = {
    "recording": `recording ${session.capture?.durationSeconds || DEFAULT_CAPTURE_SECONDS}s from live feeds`,
    "uploaded": "capture complete, starting Lambda",
    "lambda-running": "Lambda reconstruction running",
    "completed": "splat ready",
    "cancelled": session.error || "reset by operator",
    "failed": session.error || "failed",
  }[session.status] || phase;
  const tail = events
    .map(simplifyEvent)
    .filter(Boolean)
    .slice(-8);
  return {
    phase,
    label,
    updatedAt: session.updatedAt || session.createdAt || null,
    tail,
  };
}

function secondsBetween(start, end) {
  const startMs = Date.parse(start || "");
  const endMs = Date.parse(end || "");
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) return null;
  return (endMs - startMs) / 1000;
}

function summarizeCompute(session, job) {
  const result = session?.result || job?.result || null;
  const resultSeconds = Number(result?.elapsed_s ?? result?.elapsedSeconds ?? result?.elapsed);
  const startedAt = session?.lambdaStartedAt || job?.startedAt || session?.capture?.completedAt || null;
  const completedAt = session?.lambdaCompletedAt || session?.completedAt || null;
  const measuredSeconds = Number.isFinite(resultSeconds)
    ? resultSeconds
    : secondsBetween(startedAt, completedAt);
  const runningSeconds = session?.status === "lambda-running" && startedAt
    ? secondsBetween(startedAt, new Date().toISOString())
    : null;
  const seconds = Number.isFinite(measuredSeconds) ? measuredSeconds : runningSeconds;
  return {
    startedAt,
    completedAt,
    running: session?.status === "lambda-running",
    inferenceSeconds: Number.isFinite(seconds) ? seconds : null,
    computeSeconds: Number.isFinite(seconds) ? seconds : null,
  };
}

function isCancelledSession(session) {
  return session?.status === "cancelled";
}

function publicSession(session) {
  if (!session) return null;
  const job = session.jobId ? jobStatus(session.jobId) : null;
  const splatUrl = session.splatUrl || job?.splatUrl || null;
  const events = job?.workspace ? readEvents(job.workspace, 200) : [];
  return {
    ...session,
    splatUrl,
    viewerUrl: splatUrl ? `/splat/?url=${encodeURIComponent(splatUrl)}` : null,
    job,
    compute: summarizeCompute(session, job),
    progress: summarizeProgress(session, events),
  };
}

app.get("/api/kiri/status", (_req, res) => {
  res.json({ configured: Boolean(KIRI_API_KEY), base: KIRI_API_BASE });
});

// Accept 1..4 per-cam clips, concat to one mp4, forward to Kiri /3dgs/video.
app.post("/api/kiri/scan/start", (req, res) => {
  if (!KIRI_API_KEY) return res.status(500).json({ error: "KIRI_API_KEY not set" });

  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), "kiri-"));
  const clips = []; // { cam, ext, path }
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 200 * 1024 * 1024, files: 8 } });
  let aborted = false;
  const fail = (code, msg) => { if (!aborted) { aborted = true; try { res.status(code).json({ error: msg }); } catch {} } };

  bb.on("file", (field, stream, info) => {
    // Expect fields cam1..cam4. Pick extension from mimeType.
    const m = /^cam[1-4]$/.exec(field);
    if (!m) { stream.resume(); return; }
    const mime = (info.mimeType || "").toLowerCase();
    const ext  = mime.includes("mp4") ? "mp4" : mime.includes("matroska") ? "mkv" : "webm";
    const p = path.join(workdir, `${field}.${ext}`);
    clips.push({ cam: field, ext, path: p });
    stream.pipe(fs.createWriteStream(p));
  });

  bb.on("close", async () => {
    if (aborted) return;
    if (!clips.length) return fail(400, "no clips uploaded");
    clips.sort((a, b) => a.cam.localeCompare(b.cam));
    const mergedPath = path.join(workdir, "scan.mp4");
    try {
      // Normalize resolution/fps across heterogenous browser recordings so the
      // concat filter is happy. 1280x720 @ 30 matches the streamer profile.
      const inputs = [];
      const filters = [];
      clips.forEach((c, i) => {
        inputs.push("-i", c.path);
        filters.push(`[${i}:v]scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2:color=black,fps=30,setsar=1[v${i}]`);
      });
      const concatInputs = clips.map((_, i) => `[v${i}]`).join("");
      const filter = `${filters.join(";")};${concatInputs}concat=n=${clips.length}:v=1:a=0[out]`;
      await runFfmpeg([
        "-y", "-hide_banner", "-loglevel", "error",
        ...inputs,
        "-filter_complex", filter,
        "-map", "[out]",
        "-c:v", "libx264", "-preset", "veryfast", "-pix_fmt", "yuv420p",
        "-movflags", "+faststart", "-an",
        mergedPath,
      ]);

      // Upload to Kiri.
      const fd = new FormData();
      const buf = fs.readFileSync(mergedPath);
      fd.append("videoFile", new Blob([buf], { type: "video/mp4" }), "scan.mp4");
      fd.append("modelQuality", "0");
      fd.append("textureQuality", "0");
      fd.append("isMask", "0");
      fd.append("fileFormat", "ply");
      const up = await kiriFetch("/3dgs/video", { method: "POST", body: fd });
      const upBody = await up.text();
      if (!up.ok) { fail(502, `kiri upload ${up.status}: ${upBody.slice(0, 200)}`); return; }
      let parsed;
      try { parsed = JSON.parse(upBody); } catch { fail(502, "kiri non-json response"); return; }
      const serialize = parsed?.data?.serialize;
      if (!serialize) { fail(502, `kiri missing serialize: ${upBody.slice(0, 200)}`); return; }

      const sid = crypto.randomBytes(6).toString("hex");
      KIRI_SESSIONS.set(sid, {
        serialize,
        status: 0,
        plyUrl: null,
        error: null,
        createdAt: Date.now(),
        cams: clips.map((c) => c.cam),
        workdir,
      });
      res.json({ sid, serialize, cams: clips.map((c) => c.cam) });
      // Leave the workdir until fetch or 1 hour, then clean.
      setTimeout(() => { try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {} }, 60 * 60 * 1000);
    } catch (err) {
      fail(502, String(err.message || err));
      try { fs.rmSync(workdir, { recursive: true, force: true }); } catch {}
    }
  });

  bb.on("error", (e) => fail(400, `multipart error: ${e.message}`));
  req.pipe(bb);
});

// Poll Kiri status for a session.
app.get("/api/kiri/scan/:sid/status", async (req, res) => {
  const s = KIRI_SESSIONS.get(req.params.sid);
  if (!s) return res.status(404).json({ error: "unknown session" });
  try {
    const r = await kiriFetch(`/model/getStatus?serialize=${encodeURIComponent(s.serialize)}`);
    const body = await r.json().catch(() => ({}));
    // Kiri status codes: -1 uploading, 0 processing, 1 failed, 2 success, 3 queuing, 4 expired
    const status = body?.data?.status;
    if (typeof status === "number") s.status = status;
    res.json({
      sid: req.params.sid,
      serialize: s.serialize,
      status: s.status,
      plyUrl: s.plyUrl,
      cams: s.cams,
      error: s.error,
      raw: body,
    });
  } catch (err) {
    res.status(502).json({ error: String(err.message || err) });
  }
});

// Once status=2, fetch the zip, extract the PLY, expose under /scenes/.
app.post("/api/kiri/scan/:sid/fetch", async (req, res) => {
  const sid = req.params.sid;
  const s = KIRI_SESSIONS.get(sid);
  if (!s) return res.status(404).json({ error: "unknown session" });
  if (s.plyUrl) return res.json({ sid, plyUrl: s.plyUrl, cached: true });
  try {
    const r = await kiriFetch(`/model/getModelZip?serialize=${encodeURIComponent(s.serialize)}`);
    const body = await r.json().catch(() => ({}));
    const zipUrl = body?.data?.modelUrl;
    if (!zipUrl) return res.status(502).json({ error: "no modelUrl", raw: body });
    const zipRes = await fetch(zipUrl);
    if (!zipRes.ok) return res.status(502).json({ error: `zip fetch ${zipRes.status}` });
    const buf = Buffer.from(await zipRes.arrayBuffer());
    const zip = new AdmZip(buf);
    const entries = zip.getEntries();
    const plyEntry = entries.find((e) => !e.isDirectory && e.entryName.toLowerCase().endsWith(".ply"));
    if (!plyEntry) return res.status(502).json({ error: "no .ply in zip", files: entries.map((e) => e.entryName) });
    fs.mkdirSync(SCENES_DIR, { recursive: true });
    const outName = `kiri-${sid}.ply`;
    const outPath = path.join(SCENES_DIR, outName);
    fs.writeFileSync(outPath, plyEntry.getData());
    s.plyUrl = `/scenes/${outName}`;
    res.json({ sid, plyUrl: s.plyUrl });
    try { fs.rmSync(s.workdir, { recursive: true, force: true }); } catch {}
  } catch (err) {
    s.error = String(err.message || err);
    res.status(502).json({ error: s.error });
  }
});

app.get("/viewer", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "viewer.html"));
});

app.get("/splat-viewer", (req, res) => {
  const url = typeof req.query.url === "string" ? req.query.url : "";
  const suffix = url ? `?url=${encodeURIComponent(url)}` : "";
  res.redirect(302, `/splat/${suffix}`);
});

function listSplatFiles(rootDir, urlRoot, sourceLabel, options = {}) {
  if (!fs.existsSync(rootDir)) return [];

  const extensions = new Set([".splat", ".ksplat", ".ply", ".spz"]);
  const include = options.include || (() => true);
  const rootResolved = path.resolve(rootDir);
  const items = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      if (!extensions.has(path.extname(entry.name).toLowerCase())) continue;
      const rel = path.relative(rootResolved, abs);
      if (!include(rel, abs)) continue;
      const stat = fs.statSync(abs);
      const relUrl = rel.split(path.sep).map(encodeURIComponent).join("/");
      const parts = rel.split(path.sep);
      const jobId = parts.find((part) => part.startsWith("job-")) || null;
      items.push({
        name: path.basename(abs),
        label: jobId ? `${jobId} / ${path.basename(abs)}` : rel.split(path.sep).join(" / "),
        source: sourceLabel,
        url: `${urlRoot}/${relUrl}`,
        relativePath: rel,
        extension: path.extname(entry.name).slice(1).toLowerCase(),
        sizeBytes: stat.size,
        mtimeMs: stat.mtimeMs,
        mtime: stat.mtime.toISOString(),
        jobId,
      });
    }
  }

  walk(rootResolved);
  return items;
}

app.get("/api/splats", (_req, res) => {
  const pipelineFiles = listSplatFiles(
    SPLAT_WORKSPACES_DIR,
    "/splat-workspaces",
    "Pipeline",
    { include: (rel) => rel.split(path.sep).includes("result") },
  );
  const sceneFiles = listSplatFiles(SCENES_DIR, "/scenes", "Scenes");
  const files = [...pipelineFiles, ...sceneFiles].sort((a, b) => b.mtimeMs - a.mtimeMs);
  res.json({ ok: true, files, defaultUrl: files[0]?.url || null });
});

function newSplatJobId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = crypto.randomBytes(2).toString("hex");
  return `job-${ts}-${rand}`;
}

function splatWorkspaceFor(jobId) {
  return path.join(SPLAT_WORKSPACES_DIR, jobId);
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

function tailFile(filePath, bytes) {
  try {
    const stat = fs.statSync(filePath);
    const start = Math.max(0, stat.size - bytes);
    const fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(stat.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8");
  } catch {
    return "";
  }
}

function readEvents(workspace, limit = 200) {
  const eventsPath = path.join(workspace, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  return lines.slice(-limit).map((line) => {
    try { return JSON.parse(line); } catch { return null; }
  }).filter(Boolean);
}

function defaultSplatInputs() {
  if (fs.existsSync(EXPORTS_DIR)) {
    const batches = fs.readdirSync(EXPORTS_DIR)
      .map((name) => path.join(EXPORTS_DIR, name))
      .filter((p) => fs.statSync(p).isDirectory())
      .sort();
    if (batches.length > 0) return [batches[batches.length - 1]];
  }
  if (fs.existsSync(RECORDINGS_DIR)) return [RECORDINGS_DIR];
  return [];
}

function jobStatus(jobId) {
  const workspace = splatWorkspaceFor(jobId);
  if (!fs.existsSync(workspace)) return null;
  const result = readJsonSafe(path.join(workspace, "result.json"));
  const error = readJsonSafe(path.join(workspace, "error.json"));
  const tracked = splatJobs.get(jobId);
  let state = "running";
  if (result) state = "completed";
  else if (error) state = "failed";
  else if (!tracked) state = "unknown";

  const splatRel = `/splat-workspaces/${jobId}/result/scene.splat`;
  const splatAbs = path.join(workspace, "result", "scene.splat");
  return {
    jobId,
    state,
    workspace,
    startedAt: tracked?.startedAt || null,
    inputPaths: tracked?.inputPaths || null,
    sessionId: tracked?.sessionId || null,
    splatUrl: fs.existsSync(splatAbs) ? splatRel : null,
    viewerUrl: fs.existsSync(splatAbs)
      ? `/splat/?url=${encodeURIComponent(splatRel)}`
      : null,
    result,
    error,
  };
}

function addNumberArg(args, flag, value) {
  if (value === undefined || value === null || value === "") return;
  const number = Number(value);
  if (Number.isFinite(number)) args.push(flag, String(number));
}

function startSplatJob(body = {}, options = {}) {
  const jobId = String(body.jobId || newSplatJobId()).replace(/[^A-Za-z0-9_.-]/g, "-");
  const workspace = splatWorkspaceFor(jobId);
  if (fs.existsSync(workspace)) {
    throw makeHttpError(409, `job ${jobId} already exists`);
  }

  const inputPaths = Array.isArray(body.inputPaths)
    ? body.inputPaths.map(String).filter(Boolean)
    : body.inputPath ? [String(body.inputPath)] : defaultSplatInputs();
  if (!inputPaths.length || inputPaths.some((inputPath) => !fs.existsSync(inputPath))) {
    throw makeHttpError(400, "inputPath/inputPaths missing or not found");
  }
  if (!fs.existsSync(SPLAT_PYTHON)) {
    throw makeHttpError(500, `Python interpreter not found at ${SPLAT_PYTHON}`);
  }

  const args = [
    "-m", "splat", "mast3r-instantsplat",
    ...inputPaths,
    "--workspace", workspace,
    "--job-id", jobId,
  ];
  addNumberArg(args, "--iterations", body.iterations);
  addNumberArg(args, "--timestamps-per-feed", body.timestampsPerFeed);
  addNumberArg(args, "--max-images", body.maxImages);
  addNumberArg(args, "--long-edge", body.longEdge);
  addNumberArg(args, "--image-size", body.imageSize);
  addNumberArg(args, "--temporal-neighbors", body.temporalNeighbors);
  addNumberArg(args, "--cross-view-drift", body.crossViewDrift);
  const instanceType = body.instanceType || process.env.SPLAT_INSTANCE_TYPE;
  const region = body.region || process.env.SPLAT_REGION;
  const sshKeyName = body.sshKeyName || process.env.LAMBDA_SSH_KEY_NAME;
  const sshPrivateKey = body.sshPrivateKey || process.env.SPLAT_SSH_PRIVATE_KEY;
  if (instanceType) args.push("--instance-type", String(instanceType));
  if (region) args.push("--region", String(region));
  if (sshKeyName) args.push("--ssh-key-name", String(sshKeyName));
  if (sshPrivateKey) args.push("--ssh-private-key", String(sshPrivateKey));
  if (body.keepWarm) args.push("--keep-warm");
  if (body.noReuse) args.push("--no-reuse");

  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, "request.json"), JSON.stringify({
    jobId,
    inputPaths,
    sessionId: options.sessionId || null,
    requestedAt: new Date().toISOString(),
    args,
  }, null, 2));
  const stdoutLog = fs.openSync(path.join(workspace, "stdout.log"), "a");
  const stderrLog = fs.openSync(path.join(workspace, "stderr.log"), "a");
  const proc = spawn(SPLAT_PYTHON, args, {
    cwd: SPLAT_PKG_DIR,
    env: { ...process.env, PYTHONUNBUFFERED: "1" },
    stdio: ["ignore", stdoutLog, stderrLog],
    detached: false,
  });
  const startedAt = new Date().toISOString();

  splatJobs.set(jobId, {
    proc,
    startedAt,
    workspace,
    inputPaths,
    sessionId: options.sessionId || null,
  });

  if (options.sessionId) {
    patchSession(options.sessionId, {
      status: "lambda-running",
      jobId,
      jobStatusUrl: `/api/splat/jobs/${jobId}`,
      lambdaStartedAt: startedAt,
    });
  }

  proc.on("exit", (code, signal) => {
    splatJobs.delete(jobId);
    const splatRel = `/splat-workspaces/${jobId}/result/scene.splat`;
    const splatAbs = path.join(workspace, "result", "scene.splat");
    const resultPath = path.join(workspace, "result.json");
    if (code !== 0 && !fs.existsSync(path.join(workspace, "result.json"))) {
      fs.writeFileSync(
        path.join(workspace, "error.json"),
        JSON.stringify({
          ok: false,
          code,
          signal,
          finishedAt: new Date().toISOString(),
          stderrTail: tailFile(path.join(workspace, "stderr.log"), 4096),
        }, null, 2),
      );
    }
    if (options.sessionId) {
      const existingSession = readSession(options.sessionId);
      if (isCancelledSession(existingSession)) return;
      const result = readJsonSafe(resultPath);
      const error = readJsonSafe(path.join(workspace, "error.json"));
      const missingSplat = code === 0 && !fs.existsSync(splatAbs);
      const finishedAt = new Date().toISOString();
      patchSession(options.sessionId, {
        status: code === 0 && fs.existsSync(splatAbs) ? "completed" : "failed",
        completedAt: finishedAt,
        lambdaCompletedAt: finishedAt,
        splatUrl: fs.existsSync(splatAbs) ? splatRel : null,
        error: error?.error || error?.stderrTail || (missingSplat ? "splat job completed without scene.splat" : `splat job exited ${code ?? signal}`),
        result,
      });
    }
  });

  return { ok: true, jobId, workspace, inputPaths, pid: proc.pid, statusUrl: `/api/splat/jobs/${jobId}` };
}

app.post("/api/splat/jobs", (req, res) => {
  try {
    res.json(startSplatJob(req.body || {}));
  } catch (err) {
    res.status(err.statusCode || 500).json({ ok: false, error: String(err.message || err) });
  }
});

function startLambdaSessionJob(sessionId, inputPaths, options = {}) {
  return startSplatJob({
    jobId: `job-${sessionId}`,
    inputPaths,
    iterations: options.iterations ?? 1000,
    timestampsPerFeed: options.timestampsPerFeed ?? 2,
    maxImages: options.maxImages ?? 12,
    longEdge: options.longEdge ?? 960,
    imageSize: options.imageSize ?? 512,
    temporalNeighbors: options.temporalNeighbors ?? 1,
    crossViewDrift: options.crossViewDrift ?? 0,
    instanceType: options.instanceType,
    region: options.region,
    sshKeyName: options.sshKeyName,
    keepWarm: options.keepWarm ?? DEFAULT_SPLAT_KEEP_WARM,
    noReuse: options.noReuse,
  }, { sessionId });
}

async function captureLiveSession(sessionId, cams, durationSeconds, options = {}) {
  if (isCancelledSession(readSession(sessionId))) return;
  const inputDir = path.join(sessionDir(sessionId), "inputs");
  const startedAt = new Date().toISOString();
  patchSession(sessionId, {
    status: "recording",
    capture: { durationSeconds, startedAt, source: "mediamtx-rtsp" },
  });

  try {
    const clips = await Promise.all(cams.map(async (cam) => {
      const filePath = path.join(inputDir, `${cam}.mp4`);
      await captureLiveCam(cam, filePath, durationSeconds);
      return { cam, path: filePath, mimeType: "video/mp4" };
    }));
    if (isCancelledSession(readSession(sessionId))) return;
    clips.sort((a, b) => a.cam.localeCompare(b.cam));
    const inputPaths = clips.map((clip) => clip.path);
    patchSession(sessionId, {
      status: "uploaded",
      capture: {
        durationSeconds,
        startedAt,
        completedAt: new Date().toISOString(),
        source: "mediamtx-rtsp",
      },
      cams: clips.map((clip) => clip.cam),
      inputPaths,
    });
    startLambdaSessionJob(sessionId, inputPaths, options);
  } catch (err) {
    if (isCancelledSession(readSession(sessionId))) return;
    patchSession(sessionId, {
      status: "failed",
      error: String(err.message || err),
      completedAt: new Date().toISOString(),
    });
  }
}

app.get("/api/sessions", (_req, res) => {
  const sessions = readSessionIndex().map(publicSession);
  res.json({ ok: true, sessions });
});

app.get("/api/sessions/:id", (req, res) => {
  const session = publicSession(readSession(req.params.id));
  if (!session) {
    res.status(404).json({ ok: false, error: "no such session" });
    return;
  }
  const events = session.job?.workspace ? readEvents(session.job.workspace, 500) : [];
  res.json({ ok: true, session, events });
});

function terminateTrackedJob(jobId, signal = "SIGTERM") {
  const tracked = splatJobs.get(jobId);
  if (!tracked || tracked.proc.exitCode !== null) return false;
  try {
    tracked.proc.kill(signal);
    return true;
  } catch {
    return false;
  }
}

app.post("/api/sessions/:id/cancel", (req, res) => {
  const existing = readSession(req.params.id);
  if (!existing) {
    res.status(404).json({ ok: false, error: "no such session" });
    return;
  }
  const session = patchSession(req.params.id, {
    status: "cancelled",
    cancelledAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
    error: String(req.body?.reason || "reset by operator").slice(0, 200),
  });
  const killed = existing.jobId ? terminateTrackedJob(existing.jobId) : false;
  res.json({ ok: true, killed, session: publicSession(session) });
});

app.post("/api/sessions/lambda/record-start", async (req, res) => {
  try {
    const body = req.body || {};
    const requestedCams = Array.isArray(body.cams)
      ? body.cams.map(String).filter((id) => STREAM_SLOTS.includes(id))
      : [];
    const slots = await currentStreamSlots();
    const ready = slots.filter((slot) => slot.ready).map((slot) => slot.id);
    const cams = requestedCams.length ? requestedCams.filter((id) => ready.includes(id)) : ready;
    if (cams.length < 2) {
      res.status(400).json({
        ok: false,
        error: "at least two live streams are required before mapping",
        ready,
      });
      return;
    }

    const durationSeconds = Math.max(5, Math.min(120, Number(body.durationSeconds || DEFAULT_CAPTURE_SECONDS)));
    const sessionId = newSessionId();
    const session = saveSession({
      id: sessionId,
      title: String(body.title || `Mapping ${new Date().toLocaleString()}`).slice(0, 160),
      status: "recording",
      createdAt: new Date().toISOString(),
      cams,
      inputPaths: [],
      capture: {
        durationSeconds,
        startedAt: new Date().toISOString(),
        source: "mediamtx-rtsp",
      },
      splatUrl: null,
      viewerUrl: null,
      error: null,
    });

    res.json({ ok: true, session: publicSession(session) });
    setImmediate(() => {
      captureLiveSession(sessionId, cams, durationSeconds, body.options || {});
    });
  } catch (err) {
    res.status(err.statusCode || 502).json({ ok: false, error: String(err.message || err) });
  }
});

app.post("/api/sessions/lambda/start", (req, res) => {
  const sessionId = newSessionId();
  const dir = sessionDir(sessionId);
  const inputDir = path.join(dir, "inputs");
  fs.mkdirSync(inputDir, { recursive: true });

  const clips = [];
  const writes = [];
  let options = {};
  let title = "";
  let aborted = false;
  const bb = Busboy({ headers: req.headers, limits: { fileSize: 500 * 1024 * 1024, files: 8 } });
  const fail = (code, message) => {
    if (aborted) return;
    aborted = true;
    patchSession(sessionId, { status: "failed", error: message });
    try { res.status(code).json({ ok: false, error: message, sessionId }); } catch {}
  };

  bb.on("field", (field, value) => {
    if (field === "title") title = String(value || "").slice(0, 160);
    if (field === "options") {
      try { options = JSON.parse(value); } catch {}
    }
  });

  bb.on("file", (field, stream, info) => {
    if (!/^cam[1-4]$/.test(field)) {
      stream.resume();
      return;
    }
    const mime = (info.mimeType || "").toLowerCase();
    const ext = mime.includes("mp4") ? "mp4" : mime.includes("matroska") ? "mkv" : "webm";
    const filePath = path.join(inputDir, `${field}.${ext}`);
    clips.push({ cam: field, path: filePath, mimeType: info.mimeType || "" });
    writes.push(streamPipeline(stream, fs.createWriteStream(filePath)));
  });

  bb.on("close", async () => {
    if (aborted) return;
    try {
      await Promise.all(writes);
      clips.sort((a, b) => a.cam.localeCompare(b.cam));
      if (clips.length < 2) {
        fail(400, "at least two live camera clips are required for Lambda reconstruction");
        return;
      }

      const session = saveSession({
        id: sessionId,
        title: title || `Mapping ${sessionId}`,
        status: "uploaded",
        createdAt: new Date().toISOString(),
        cams: clips.map((clip) => clip.cam),
        inputPaths: clips.map((clip) => clip.path),
        splatUrl: null,
        viewerUrl: null,
        error: null,
      });

      const job = startLambdaSessionJob(sessionId, clips.map((clip) => clip.path), options);

      res.json({ ok: true, session: publicSession(readSession(sessionId)), job });
    } catch (err) {
      fail(err.statusCode || 502, String(err.message || err));
    }
  });

  bb.on("error", (err) => fail(400, `multipart error: ${err.message}`));
  req.pipe(bb);
});

app.get("/api/splat/jobs", (_req, res) => {
  if (!fs.existsSync(SPLAT_WORKSPACES_DIR)) {
    res.json({ ok: true, jobs: [] });
    return;
  }
  const jobs = fs.readdirSync(SPLAT_WORKSPACES_DIR)
    .filter((name) => name.startsWith("job-"))
    .map((name) => jobStatus(name))
    .filter(Boolean)
    .sort((a, b) => (b.jobId > a.jobId ? 1 : -1));
  res.json({ ok: true, jobs });
});

app.get("/api/splat/jobs/:id", (req, res) => {
  const status = jobStatus(req.params.id);
  if (!status) {
    res.status(404).json({ ok: false, error: "no such job" });
    return;
  }
  res.json({ ok: true, ...status, events: readEvents(status.workspace, 500) });
});

app.delete("/api/splat/jobs/:id", (req, res) => {
  const tracked = splatJobs.get(req.params.id);
  if (tracked && tracked.proc.exitCode === null) {
    try { tracked.proc.kill("SIGTERM"); } catch {}
  }
  splatJobs.delete(req.params.id);
  res.json({ ok: true });
});

app.get("/iphone-safari", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "iphone-safari.html"));
});

app.get("/raspi", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "raspi.html"));
});

app.get("/publisher", (_req, res) => {
  res.redirect(302, "/raspi");
});

app.get("/dev-cert.pem", (_req, res) => {
  res.download(CERT_PATH);
});

app.get("/phone-publish", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/iphone-safari${query}`);
});

app.get("/phone", (req, res) => {
  const query = req.url.includes("?") ? req.url.slice(req.url.indexOf("?")) : "";
  res.redirect(302, `/iphone-safari${query}`);
});

// MAVLink relay — the air-unit Pi is behind NAT, so it CONNECTS OUT to us at
// /api/pi/<cam>/mavlink/uplink and pushes telemetry; browsers connect to
// /api/pi/<cam>/mavlink to read telemetry + send arm/yaw. We relay between the
// two. Works identically on LAN and Fly (no inbound reach to the Pi needed).
const mavUplinks = new Map(); // cam -> ws (the Pi)
const mavClients = new Map(); // cam -> Set<ws> (browsers)
const mavWss = new WebSocketServer({ noServer: true });

function mavRegisterUplink(cam, ws) {
  const prev = mavUplinks.get(cam);
  if (prev && prev !== ws) { try { prev.close(); } catch {} }
  mavUplinks.set(cam, ws);
  console.log(`[mav] uplink connected: ${cam}`);
  ws.on("message", (data) => {
    const set = mavClients.get(cam);
    if (!set) return;
    const text = data.toString();
    for (const c of set) { if (c.readyState === 1) { try { c.send(text); } catch {} } }
  });
  const drop = () => {
    if (mavUplinks.get(cam) === ws) mavUplinks.delete(cam);
    console.log(`[mav] uplink closed: ${cam}`);
  };
  ws.on("close", drop);
  ws.on("error", drop);
}

function mavRegisterClient(cam, ws) {
  let set = mavClients.get(cam);
  if (!set) { set = new Set(); mavClients.set(cam, set); }
  set.add(ws);
  if (!mavUplinks.has(cam)) {
    try { ws.send(JSON.stringify({ type: "status", link: "down", msg: "air unit offline" })); } catch {}
  }
  ws.on("message", (data) => {
    const up = mavUplinks.get(cam);
    if (up && up.readyState === 1) { try { up.send(data.toString()); } catch {} }
  });
  const drop = () => { set.delete(ws); };
  ws.on("close", drop);
  ws.on("error", drop);
}

app.use(
  "/mediamtx",
  createProxyMiddleware({
    target: "http://127.0.0.1:8889",
    changeOrigin: true,
    ws: true,
    pathRewrite: { "^/mediamtx": "" },
    on: {
      proxyRes(proxyRes) {
        const location = proxyRes.headers.location;
        if (location) {
          const rewritten = location.startsWith("/")
            ? `/mediamtx${location}`
            : location.replace("http://127.0.0.1:8889", "/mediamtx");
          proxyRes.headers.location = rewritten;
        }
      },
    },
  }),
);

app.use(
  "/whip",
  createProxyMiddleware({
    target: "http://127.0.0.1:8889",
    changeOrigin: true,
    ws: false,
    pathRewrite: (pathToRewrite) => pathToRewrite.replace(/^\/([^/]+)$/, "/$1/whip"),
    on: {
      proxyRes(proxyRes) {
        const location = proxyRes.headers.location;
        if (location) {
          const rewritten = location.startsWith("/")
            ? `/whip-session${location}`
            : location.replace("http://127.0.0.1:8889", "/whip-session");
          proxyRes.headers.location = rewritten;
        }
      },
    },
  }),
);

app.use(
  "/whip-session",
  createProxyMiddleware({
    target: "http://127.0.0.1:8889",
    changeOrigin: true,
    ws: false,
    pathRewrite: { "^/whip-session": "" },
  }),
);

app.use(
  "/splat-workspaces",
  express.static(SPLAT_WORKSPACES_DIR, {
    setHeaders(res, filePath) {
      if ([".splat", ".ksplat", ".ply", ".spz"].includes(path.extname(filePath).toLowerCase())) {
        res.setHeader("Content-Type", "application/octet-stream");
      }
    },
  }),
);

app.get("/", (_req, res) => {
  res.redirect("/viewer");
});

if (USE_HTTPS && (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH))) {
  console.error("Missing TLS certificate files.");
  console.error("Run: ./scripts/generate-dev-cert.sh");
  process.exit(1);
}

const dashboardServer = USE_HTTPS
  ? https.createServer({
      cert: fs.readFileSync(CERT_PATH),
      key: fs.readFileSync(KEY_PATH),
    }, app)
  : http.createServer(app);

const MAV_RE = /^\/api\/pi\/([a-z0-9-]+)\/mavlink(\/uplink)?(?:\?.*)?$/i;
dashboardServer.on("upgrade", (req, socket, head) => {
  const m = req.url && req.url.match(MAV_RE);
  if (!m) { socket.destroy(); return; }
  const cam = m[1].toLowerCase();
  const isUplink = Boolean(m[2]);
  mavWss.handleUpgrade(req, socket, head, (ws) => {
    if (isUplink) mavRegisterUplink(cam, ws);
    else mavRegisterClient(cam, ws);
  });
});

dashboardServer.listen(PORT, "0.0.0.0", () => {
  const protocol = USE_HTTPS ? "https" : "http";
  console.log(`Dashboard listening on ${protocol}://0.0.0.0:${PORT}`);
});

if (USE_HTTPS) {
  http
    .createServer((req, res) => {
      const host = (req.headers.host || "").replace(/:\d+$/, "");
      const location = `https://${host}:${PORT}${req.url || "/"}`;
      res.writeHead(308, { Location: location });
      res.end();
    })
    .listen(HTTP_REDIRECT_PORT, "0.0.0.0", () => {
      console.log(`HTTP redirect listening on http://0.0.0.0:${HTTP_REDIRECT_PORT}`);
    });
}
