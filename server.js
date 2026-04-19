const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

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

https.createServer(credentials, app).listen(PORT, "0.0.0.0", () => {
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
