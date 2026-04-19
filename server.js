const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 3001);
const PUBLIC_DIR = path.join(__dirname, "web_rtc_app", "public");
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = path.join(CERT_DIR, "dev-cert.pem");
const KEY_PATH = path.join(CERT_DIR, "dev-key.pem");

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: "32kb" }));

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
