const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const os = require("os");
const crypto = require("crypto");
const { spawn } = require("child_process");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");
const Busboy = require("busboy");
const AdmZip = require("adm-zip");

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
const PUBLIC_DIR = path.join(__dirname, "web_rtc_app", "public");
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = path.join(CERT_DIR, "dev-cert.pem");
const KEY_PATH = path.join(CERT_DIR, "dev-key.pem");

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "8mb" }));

app.get("/health", (_req, res) => {
  res.json({ ok: true, protocol: "https" });
});

const STREAM_SLOTS = ["cam1", "cam2", "cam3", "cam4"];

const PI_CONTROL_PORT = 8088;
const PI_CONTROL_TIMEOUT_MS = 3000;
const piHostForSlot = (slot) => `pi-${slot}.local`;

app.get("/api/state", async (_req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:9997/v3/paths/list");
    if (!response.ok) {
      return res.status(502).json({ error: `mediamtx api ${response.status}` });
    }
    const body = await response.json();
    const byName = new Map((body.items || []).map((p) => [p.name, p]));
    const slots = STREAM_SLOTS.map((id) => {
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
    res.json({ slots });
  } catch (err) {
    res.status(502).json({ error: String(err) });
  }
});

// Proxy a narrow set of pi-control endpoints per cam id.
// Example: POST /api/pi/cam1/ring/identify  -> http://pi-cam1.local:8088/ring/identify
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

app.get("/api/next-slot", async (_req, res) => {
  try {
    const response = await fetch("http://127.0.0.1:9997/v3/paths/list");
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
    const free = STREAM_SLOTS.find((id) => !busy.has(id));
    if (!free) {
      res.status(503).json({ error: "all slots busy", busy: [...busy] });
      return;
    }
    res.json({ streamId: free, busy: [...busy] });
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
const SCENES_DIR    = path.join(PUBLIC_DIR, "scenes");
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

// MAVLink bridge WS proxy — only cam1 is the airborne unit. Browser connects
// to wss://<host>/api/pi/cam1/mavlink and we forward to ws://pi-cam1.local:8090.
const mavlinkProxy = createProxyMiddleware({
  target: "http://pi-cam1.local:8090",
  changeOrigin: true,
  ws: true,
  pathRewrite: { "^/api/pi/cam1/mavlink": "" },
});
app.use("/api/pi/cam1/mavlink", mavlinkProxy);

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

app.get("/", (_req, res) => {
  res.redirect("/viewer");
});

if (!fs.existsSync(CERT_PATH) || !fs.existsSync(KEY_PATH)) {
  console.error("Missing TLS certificate files.");
  console.error("Run: ./scripts/generate-dev-cert.sh");
  process.exit(1);
}

const credentials = {
  cert: fs.readFileSync(CERT_PATH),
  key: fs.readFileSync(KEY_PATH),
};

const httpsServer = https.createServer(credentials, app);
httpsServer.on("upgrade", (req, socket, head) => {
  if (req.url && req.url.startsWith("/api/pi/cam1/mavlink")) {
    mavlinkProxy.upgrade(req, socket, head);
  }
});
httpsServer.listen(PORT, "0.0.0.0", () => {
  console.log(`Dashboard listening on https://0.0.0.0:${PORT}`);
});

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
