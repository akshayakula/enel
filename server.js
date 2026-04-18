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

app.get("/health", (_req, res) => {
  res.json({ ok: true, protocol: "https" });
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
