const fs = require("fs");
const path = require("path");
const http = require("http");
const https = require("https");
const { execFile, spawn } = require("child_process");
const { URL } = require("url");
const express = require("express");
const { createProxyMiddleware } = require("http-proxy-middleware");

const app = express();

const PORT = Number(process.env.PORT || 3000);
const HTTP_REDIRECT_PORT = Number(process.env.HTTP_REDIRECT_PORT || 3001);
const PUBLIC_DIR = path.join(__dirname, "web_rtc_app", "public");
const CERT_DIR = path.join(__dirname, "certs");
const CERT_PATH = path.join(CERT_DIR, "dev-cert.pem");
const KEY_PATH = path.join(CERT_DIR, "dev-key.pem");
const EXPORT_SCRIPT_PATH = path.join(__dirname, "scripts", "export-latest-mp4s.sh");
const EXPORTS_DIR = path.join(__dirname, "exports", "compiled");
const KIRI_3DGS_VIDEO_URL = "https://api.kiriengine.app/api/v1/open/3dgs/video";
const KIRI_STATUS_URL = "https://api.kiriengine.app/api/v1/open/model/getStatus";
const KIRI_MODEL_ZIP_URL = "https://api.kiriengine.app/api/v1/open/model/getModelZip";
const KIRI_MODELS_DIR = path.join(__dirname, "exports", "kiri-models");
const GAUSSIAN_SPLATS_BUILD_DIR = path.join(
  __dirname,
  "node_modules",
  "@mkkellogg",
  "gaussian-splats-3d",
  "build",
);
const THREE_BUILD_DIR = path.join(__dirname, "node_modules", "three", "build");

const SPLAT_PKG_DIR = path.join(__dirname, "video_to_gaussian_splat");
const SPLAT_WORKSPACES_DIR = path.join(SPLAT_PKG_DIR, "workspaces");
const SPLAT_PYTHON = process.env.SPLAT_PYTHON
  || path.join(SPLAT_PKG_DIR, ".venv", "bin", "python");
const RECORDINGS_DIR = path.join(__dirname, "recordings");
const splatJobs = new Map(); // jobId -> { proc, startedAt, workspace, inputPath }

app.use(express.json({ limit: "1mb" }));
app.use(express.static(PUBLIC_DIR));
app.use("/vendor/gaussian-splats-3d", express.static(GAUSSIAN_SPLATS_BUILD_DIR));
app.use("/vendor/three", express.static(THREE_BUILD_DIR));

function runExecFile(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile(file, args, options, (error, stdout = "", stderr = "") => {
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

async function buildCombinedVideo(targetDir, files) {
  const combinedName = "all_cams_combined.mp4";
  const combinedPath = path.join(targetDir, combinedName);

  if (files.length === 0) {
    return null;
  }

  const normalizedFiles = [];
  for (const file of files) {
    const normalizedPath = path.join(
      targetDir,
      `${path.parse(file.name).name}_normalized.mp4`,
    );
    await runExecFile(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        file.path,
        "-an",
        "-vf",
        "scale=640:360:force_original_aspect_ratio=decrease,pad=640:360:(ow-iw)/2:(oh-ih)/2:black,format=yuv420p,fps=30",
        "-c:v",
        "libx264",
        "-preset",
        "veryfast",
        "-crf",
        "20",
        "-movflags",
        "+faststart",
        normalizedPath,
      ],
      { cwd: __dirname },
    );
    normalizedFiles.push(normalizedPath);
  }

  const concatListPath = path.join(targetDir, "combined_concat.txt");
  fs.writeFileSync(
    concatListPath,
    normalizedFiles.map((filePath) => `file '${filePath.replace(/'/g, "'\\''")}'`).join("\n") + "\n",
  );

  await runExecFile(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      concatListPath,
      "-c",
      "copy",
      combinedPath,
    ],
    { cwd: __dirname },
  );

  return {
    name: combinedName,
    path: combinedPath,
    url: `/exports/compiled/${path.basename(targetDir)}/${combinedName}`,
  };
}

function requestKiriJson(urlString, apiKey) {
  return new Promise((resolve, reject) => {
    const requestOptions = new URL(urlString);
    requestOptions.method = "GET";
    requestOptions.headers = {
      Authorization: `Bearer ${apiKey}`,
    };

    const request = https.request(requestOptions, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk) => {
        body += chunk;
      });
      response.on("end", () => {
        try {
          resolve({
            statusCode: response.statusCode || 200,
            json: JSON.parse(body),
          });
        } catch (error) {
          reject(new Error(`Failed to parse KIRI response: ${body}`));
        }
      });
    });

    request.on("error", reject);
    request.end();
  });
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, protocol: "https" });
});

app.get("/favicon.ico", (_req, res) => {
  res.status(204).end();
});

app.get("/viewer", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "viewer.html"));
});

app.get("/splat-viewer", (_req, res) => {
  res.sendFile(path.join(PUBLIC_DIR, "splat-viewer.html"));
});

function listSplatFiles(rootDir, urlRoot, sourceLabel, options = {}) {
  if (!fs.existsSync(rootDir)) return [];

  const extensions = new Set([".splat", ".ksplat", ".ply", ".spz"]);
  const items = [];
  const skipDirs = new Set(options.skipDirs || []);
  const include = options.include || (() => true);
  const rootResolved = path.resolve(rootDir);

  function walk(dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name.startsWith(".")) continue;
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!skipDirs.has(entry.name)) walk(abs);
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
      const label = jobId
        ? `${jobId} / ${path.basename(abs)}`
        : rel.split(path.sep).join(" / ");
      items.push({
        name: path.basename(abs),
        label,
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
    {
      include: (rel) => rel.split(path.sep).includes("result"),
    },
  );
  const kiriFiles = listSplatFiles(KIRI_MODELS_DIR, "/kiri-models", "KIRI");
  const files = [...pipelineFiles, ...kiriFiles].sort((a, b) => {
    const sceneBiasA = a.name === "scene.splat" ? 1 : 0;
    const sceneBiasB = b.name === "scene.splat" ? 1 : 0;
    if (sceneBiasA !== sceneBiasB) return sceneBiasB - sceneBiasA;
    return b.mtimeMs - a.mtimeMs;
  });

  res.json({
    ok: true,
    files,
    defaultUrl: files[0]?.url || null,
  });
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

app.post("/api/recordings/compile", async (_req, res) => {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const targetDir = path.join(EXPORTS_DIR, timestamp);

  fs.mkdirSync(targetDir, { recursive: true });

  try {
    const { stdout = "", stderr = "" } = await runExecFile(EXPORT_SCRIPT_PATH, [targetDir], {
      cwd: __dirname,
    });

    const lines = `${stdout}\n${stderr}`
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    const files = fs.existsSync(targetDir)
      ? fs.readdirSync(targetDir)
          .filter((name) => name.endsWith(".mp4"))
          .sort()
          .map((name) => ({
            name,
            path: path.join(targetDir, name),
            url: `/exports/compiled/${timestamp}/${name}`,
          }))
      : [];

    const combinedFile = await buildCombinedVideo(targetDir, files);
    const warnings = lines.filter((line) => line.startsWith("[warn]"));

    res.json({
      ok: true,
      outputDir: targetDir,
      files,
      combinedFile,
      warnings,
      log: lines,
    });
  } catch (error) {
    res.status(500).json({
      ok: false,
      outputDir: targetDir,
      files: [],
      combinedFile: null,
      warnings: [],
      log: [error.stdout, error.stderr].filter(Boolean),
      error: error.message,
    });
  }
});

app.post("/api/kiri/upload", (req, res) => {
  const apiKey = String(req.body?.apiKey || "").trim();
  const fileUrl = String(req.body?.fileUrl || "").trim();

  if (!apiKey) {
    res.status(400).json({ ok: false, error: "Missing KIRI API key." });
    return;
  }

  if (!fileUrl) {
    res.status(400).json({ ok: false, error: "Missing compiled file URL." });
    return;
  }

  const relativePath = fileUrl.replace(/^\/+/, "");
  const absolutePath = path.resolve(__dirname, relativePath);
  const exportsRoot = path.resolve(__dirname, "exports");

  if (!absolutePath.startsWith(exportsRoot + path.sep)) {
    res.status(400).json({ ok: false, error: "File must be inside exports/." });
    return;
  }

  if (!fs.existsSync(absolutePath)) {
    res.status(404).json({ ok: false, error: "Compiled file not found." });
    return;
  }

  execFile(
    "curl",
    [
      "--silent",
      "--show-error",
      "--location",
      "--request",
      "POST",
      KIRI_3DGS_VIDEO_URL,
      "--header",
      `Authorization: Bearer ${apiKey}`,
      "--form",
      'isMesh="0"',
      "--form",
      'isMask="0"',
      "--form",
      `videoFile=@${absolutePath}`,
    ],
    { cwd: __dirname },
    (error, stdout = "", stderr = "") => {
      if (error) {
        res.status(502).json({
          ok: false,
          error: stderr || error.message,
        });
        return;
      }

      try {
        res.json(JSON.parse(stdout));
      } catch (_parseError) {
        res.status(502).json({
          ok: false,
          error: "Failed to parse KIRI response.",
          raw: stdout || stderr,
        });
      }
    },
  );
});

app.get("/api/kiri/status", async (req, res) => {
  const apiKey = String(req.query.apiKey || "").trim();
  const serialize = String(req.query.serialize || "").trim();

  if (!apiKey || !serialize) {
    res.status(400).json({ ok: false, error: "Missing apiKey or serialize." });
    return;
  }

  try {
    const statusResult = await requestKiriJson(
      `${KIRI_STATUS_URL}?serialize=${encodeURIComponent(serialize)}`,
      apiKey,
    );

    let download = null;
    if (statusResult.json?.data?.status === 2) {
      const modelResult = await requestKiriJson(
        `${KIRI_MODEL_ZIP_URL}?serialize=${encodeURIComponent(serialize)}`,
        apiKey,
      );
      download = modelResult.json?.data || null;
    }

    res.status(statusResult.statusCode).json({
      ok: true,
      status: statusResult.json,
      download,
    });
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: error.message,
    });
  }
});

app.post("/api/kiri/import", async (req, res) => {
  const serialize = String(req.body?.serialize || "").trim();
  const modelUrl = String(req.body?.modelUrl || "").trim();

  if (!serialize || !modelUrl) {
    res.status(400).json({ ok: false, error: "Missing serialize or modelUrl." });
    return;
  }

  let parsedUrl;
  try {
    parsedUrl = new URL(modelUrl);
  } catch {
    res.status(400).json({ ok: false, error: "Invalid modelUrl." });
    return;
  }

  if (parsedUrl.protocol !== "https:") {
    res.status(400).json({ ok: false, error: "modelUrl must use https." });
    return;
  }

  const targetDir = path.join(KIRI_MODELS_DIR, serialize);
  const zipPath = path.join(targetDir, `${serialize}.zip`);
  const plyPath = path.join(targetDir, "3DGS.ply");
  const camerasPath = path.join(targetDir, "cameras.json");

  fs.mkdirSync(targetDir, { recursive: true });

  if (!fs.existsSync(plyPath)) {
    try {
      await runExecFile(
        "curl",
        ["--silent", "--show-error", "--location", "--output", zipPath, modelUrl],
        { cwd: __dirname },
      );
      await runExecFile("unzip", ["-o", zipPath, "-d", targetDir], { cwd: __dirname });
    } catch (error) {
      res.status(502).json({
        ok: false,
        error: error.stderr || error.stdout || error.message,
      });
      return;
    }
  }

  if (!fs.existsSync(plyPath)) {
    res.status(500).json({
      ok: false,
      error: "3DGS.ply was not found after extracting the KIRI ZIP.",
    });
    return;
  }

  res.json({
    ok: true,
    serialize,
    plyUrl: `/kiri-models/${serialize}/3DGS.ply`,
    camerasUrl: fs.existsSync(camerasPath) ? `/kiri-models/${serialize}/cameras.json` : null,
    viewerUrl: `/splat-viewer?url=${encodeURIComponent(
      `${req.protocol}://${req.get("host")}/kiri-models/${serialize}/3DGS.ply`,
    )}`,
  });
});

// ---------- 3D Gaussian Splat pipeline (Lambda Cloud) ----------------------

function newSplatJobId() {
  const ts = new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 14);
  const rand = Math.random().toString(36).slice(2, 6);
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

function readEvents(workspace, limit = 200) {
  const eventsPath = path.join(workspace, "events.jsonl");
  if (!fs.existsSync(eventsPath)) return [];
  const lines = fs.readFileSync(eventsPath, "utf8").trim().split("\n").filter(Boolean);
  const tail = lines.slice(-limit);
  return tail
    .map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    })
    .filter(Boolean);
}

function jobStatus(jobId) {
  const workspace = splatWorkspaceFor(jobId);
  if (!fs.existsSync(workspace)) return null;
  const result = readJsonSafe(path.join(workspace, "result.json"));
  const errorPath = path.join(workspace, "error.json");
  const error = readJsonSafe(errorPath);
  const tracked = splatJobs.get(jobId);
  let state = "running";
  if (result) state = "completed";
  else if (error) state = "failed";
  else if (!tracked) state = "unknown"; // process gone but no result

  const splatRel = `/splat-workspaces/${jobId}/result/scene.splat`;
  const splatAbs = path.join(workspace, "result", "scene.splat");
  return {
    jobId,
    state,
    workspace,
    startedAt: tracked?.startedAt || null,
    inputPath: tracked?.inputPath || null,
    splatUrl: fs.existsSync(splatAbs) ? splatRel : null,
    viewerUrl: fs.existsSync(splatAbs)
      ? `/splat-viewer?url=${encodeURIComponent(splatRel)}`
      : null,
    result,
    error,
  };
}

function defaultSplatInput() {
  // Prefer the freshest compiled MP4 batch; fall back to raw recordings dir.
  if (fs.existsSync(EXPORTS_DIR)) {
    const batches = fs.readdirSync(EXPORTS_DIR)
      .map((name) => path.join(EXPORTS_DIR, name))
      .filter((p) => fs.statSync(p).isDirectory())
      .sort();
    if (batches.length > 0) return batches[batches.length - 1];
  }
  if (fs.existsSync(RECORDINGS_DIR)) return RECORDINGS_DIR;
  return null;
}

app.post("/api/splat/jobs", (req, res) => {
  const body = req.body || {};
  const jobId = String(body.jobId || newSplatJobId());
  const workspace = splatWorkspaceFor(jobId);
  if (fs.existsSync(workspace)) {
    res.status(409).json({ ok: false, error: `job ${jobId} already exists` });
    return;
  }

  const inputPath = String(body.inputPath || defaultSplatInput() || "");
  if (!inputPath || !fs.existsSync(inputPath)) {
    res.status(400).json({
      ok: false,
      error: `inputPath missing or not found: ${inputPath || "(none)"}`,
    });
    return;
  }

  if (!fs.existsSync(SPLAT_PYTHON)) {
    res.status(500).json({
      ok: false,
      error: `Python interpreter not found at ${SPLAT_PYTHON}. ` +
        `Create venv: python3 -m venv ${path.join(SPLAT_PKG_DIR, ".venv")} && ` +
        `${path.join(SPLAT_PKG_DIR, ".venv/bin/pip")} install -e ${SPLAT_PKG_DIR}`,
    });
    return;
  }

  const args = [
    "-m", "splat", "run", inputPath,
    "--workspace", workspace,
    "--job-id", jobId,
  ];
  if (body.maxSteps) args.push("--max-steps", String(Number(body.maxSteps)));
  if (body.framesPerCam) args.push("--frames-per-cam", String(Number(body.framesPerCam)));
  if (body.sampleFps) args.push("--sample-fps", String(Number(body.sampleFps)));
  if (body.instanceType) args.push("--instance-type", String(body.instanceType));
  if (body.region) args.push("--region", String(body.region));
  if (body.sshKeyName) args.push("--ssh-key-name", String(body.sshKeyName));
  if (body.sshPrivateKey) args.push("--ssh-private-key", String(body.sshPrivateKey));
  if (body.keepWarm) args.push("--keep-warm");
  if (body.noReuse) args.push("--no-reuse");

  fs.mkdirSync(workspace, { recursive: true });
  const stdoutLog = fs.openSync(path.join(workspace, "stdout.log"), "a");
  const stderrLog = fs.openSync(path.join(workspace, "stderr.log"), "a");

  const env = { ...process.env, PYTHONUNBUFFERED: "1" };
  const proc = spawn(SPLAT_PYTHON, args, {
    cwd: SPLAT_PKG_DIR,
    env,
    stdio: ["ignore", stdoutLog, stderrLog],
    detached: false,
  });

  splatJobs.set(jobId, {
    proc,
    startedAt: new Date().toISOString(),
    workspace,
    inputPath,
  });

  proc.on("exit", (code, signal) => {
    if (code !== 0 && !fs.existsSync(path.join(workspace, "result.json"))) {
      const errorPayload = {
        ok: false,
        code,
        signal,
        finishedAt: new Date().toISOString(),
        stderrTail: tailFile(path.join(workspace, "stderr.log"), 4096),
      };
      fs.writeFileSync(
        path.join(workspace, "error.json"),
        JSON.stringify(errorPayload, null, 2),
      );
    }
  });

  res.json({
    ok: true,
    jobId,
    workspace,
    inputPath,
    pid: proc.pid,
    statusUrl: `/api/splat/jobs/${jobId}`,
  });
});

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
    try { tracked.proc.kill("SIGTERM"); } catch (_) { /* ignore */ }
  }
  splatJobs.delete(req.params.id);
  res.json({ ok: true });
});

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

app.use("/exports", express.static(path.join(__dirname, "exports")));
app.use(
  "/kiri-models",
  express.static(KIRI_MODELS_DIR, {
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
