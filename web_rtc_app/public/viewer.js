const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];

const videoGrid = document.getElementById("videoGrid");
const serverStatus = document.getElementById("serverStatus");
const compileButton = document.getElementById("compileRecordingsButton");
const compileStatus = document.getElementById("compileStatus");
const compileResults = document.getElementById("compileResults");
const kiriApiKeyInput = document.getElementById("kiriApiKey");
const kiriResultsStatus = document.getElementById("kiriResultsStatus");
const kiriJobsList = document.getElementById("kiriJobsList");
const readers = [];
const KIRI_KEY_STORAGE_KEY = "enel.kiriApiKey";
const KIRI_JOBS_STORAGE_KEY = "enel.kiriJobs";
let activeKiriPoller = null;

function getMediaMtxBaseUrl() {
  const params = new URLSearchParams(window.location.search);
  const override = (params.get("mediamtx") || "").trim();
  if (override) {
    return override.replace(/\/$/, "");
  }

  return `${window.location.origin}/mediamtx`;
}

function createCard(streamId, mediaMtxBaseUrl) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title mono">${streamId}</div>
      <div class="status" id="status-${streamId}">Connecting...</div>
    </div>
    <video id="video-${streamId}" autoplay playsinline muted></video>
  `;

  videoGrid.appendChild(card);

  const video = card.querySelector("video");
  const status = card.querySelector(".status");

  const reader = new MediaMTXWebRTCReader({
    url: `${mediaMtxBaseUrl}/${streamId}/whep`,
    onTrack: (event) => {
      video.srcObject = event.streams[0];
      status.textContent = "Live";
      status.className = "status live";
    },
    onError: (err) => {
      status.textContent = String(err);
      status.className = "status error";
      console.error(`Viewer error for ${streamId}`, err);
    },
  });

  readers.push(reader);
}

function renderCompileResults(result) {
  const fileItems = result.files.length
    ? result.files
        .map(
          (file) => `<li><a href="${file.url}" target="_blank" rel="noreferrer">${file.name}</a></li>`,
        )
        .join("")
    : "<li>No MP4 files were created.</li>";

  const warningItems = result.warnings.length
    ? `<ul class="meta-list">${result.warnings.map((warning) => `<li>${warning}</li>`).join("")}</ul>`
    : "<p class=\"result-copy\">No warnings.</p>";

  compileResults.hidden = false;
  compileResults.innerHTML = `
    <div>
      <strong>Output folder</strong>
      <p class="result-copy mono">${result.outputDir}</p>
    </div>
    <div>
      <strong>Combined all-camera MP4</strong>
      ${
        result.combinedFile
          ? `<div class="result-row">
              <a href="${result.combinedFile.url}" target="_blank" rel="noreferrer">${result.combinedFile.name}</a>
              <button class="button button-secondary" id="sendCombinedToKiriButton" type="button" data-file-url="${result.combinedFile.url}" data-file-name="${result.combinedFile.name}">
                Send Combined File to KIRI
              </button>
            </div>
            <p class="result-copy mono" id="combinedKiriStatus">Not sent</p>`
          : `<p class="result-copy">No combined file could be created.</p>`
      }
    </div>
    <div>
      <strong>Compiled files</strong>
      <ul class="meta-list">${fileItems}</ul>
    </div>
    <div>
      <strong>Warnings</strong>
      ${warningItems}
    </div>
  `;

  const combinedButton = document.getElementById("sendCombinedToKiriButton");
  if (combinedButton) {
    combinedButton.addEventListener("click", () => sendCombinedToKiri(combinedButton));
  }
}

async function compileLatestRecordings() {
  compileButton.disabled = true;
  compileStatus.textContent = "Compiling...";
  compileResults.hidden = true;

  try {
    const response = await fetch("/api/recordings/compile", {
      method: "POST",
    });
    const result = await response.json();

    renderCompileResults(result);

    if (!response.ok) {
      throw new Error(result.error || "Compilation failed.");
    }

    compileStatus.textContent = `Ready (${result.files.length} file${result.files.length === 1 ? "" : "s"})`;
  } catch (error) {
    compileStatus.textContent = "Failed";
    compileResults.hidden = false;
    compileResults.innerHTML = `<p class="result-copy">${String(error)}</p>`;
    console.error("Failed to compile recordings", error);
  } finally {
    compileButton.disabled = false;
  }
}

function loadStoredKiriKey() {
  try {
    return window.localStorage.getItem(KIRI_KEY_STORAGE_KEY) || "";
  } catch {
    return "";
  }
}

function storeKiriKey(value) {
  try {
    window.localStorage.setItem(KIRI_KEY_STORAGE_KEY, value);
  } catch {
    // Ignore storage failures.
  }
}

function loadStoredKiriJobs() {
  try {
    const raw = window.localStorage.getItem(KIRI_JOBS_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function storeKiriJobs(jobs) {
  try {
    window.localStorage.setItem(KIRI_JOBS_STORAGE_KEY, JSON.stringify(jobs));
  } catch {
    // Ignore storage failures.
  }
}

function upsertKiriJob(job) {
  const jobs = loadStoredKiriJobs();
  const existingIndex = jobs.findIndex((entry) => entry.serialize === job.serialize);
  if (existingIndex >= 0) {
    jobs[existingIndex] = { ...jobs[existingIndex], ...job };
  } else {
    jobs.unshift(job);
  }
  storeKiriJobs(jobs);
  renderKiriJobs();
}

function updateKiriJob(serialize, patch) {
  const jobs = loadStoredKiriJobs().map((job) =>
    job.serialize === serialize ? { ...job, ...patch } : job,
  );
  storeKiriJobs(jobs);
  renderKiriJobs();
}

function renderKiriJobs() {
  const jobs = loadStoredKiriJobs();
  if (!jobs.length) {
    kiriResultsStatus.textContent = "No tracked jobs";
    kiriJobsList.innerHTML = '<p class="result-copy">Uploads you send to KIRI from this dashboard will appear here.</p>';
    return;
  }

  const readyCount = jobs.filter((job) => job.state === 2).length;
  kiriResultsStatus.textContent = `${jobs.length} tracked job${jobs.length === 1 ? "" : "s"} · ${readyCount} ready`;

  kiriJobsList.innerHTML = jobs
    .map((job) => {
      const created = job.createdAt ? new Date(job.createdAt).toLocaleString() : "Unknown time";
      const stateLabel =
        job.state === 2
          ? "Ready"
          : job.state === 1
            ? "Failed"
            : job.state === 3
              ? "Queued"
              : "Processing";
      const downloadMarkup = job.modelUrl
        ? `<a href="${job.modelUrl}" target="_blank" rel="noreferrer">Open result ZIP</a>`
        : '<span class="result-copy">Result not ready yet</span>';
      const viewerMarkup = job.modelUrl
        ? job.viewerUrl
          ? `<a href="${job.viewerUrl}" target="_blank" rel="noreferrer">Open local viewer</a>`
          : `<button class="button button-secondary import-kiri-button" type="button" data-serialize="${job.serialize}">Import & View</button>`
        : "";

      return `
        <article class="job-card">
          <div class="result-row">
            <strong>${job.fileName || "Combined upload"}</strong>
            <span class="pill mono">${stateLabel}</span>
          </div>
          <p class="result-copy mono">${job.serialize}</p>
          <p class="result-copy">${created}</p>
          <div class="result-row">
            ${downloadMarkup}
            ${viewerMarkup}
          </div>
        </article>
      `;
    })
    .join("");

  for (const button of kiriJobsList.querySelectorAll(".import-kiri-button")) {
    button.addEventListener("click", () => importKiriJob(button.dataset.serialize, button));
  }
}

async function sendFileToKiri(button) {
  const apiKey = kiriApiKeyInput.value.trim();
  const fileUrl = button.dataset.fileUrl;
  const fileName = button.dataset.fileName || "Combined upload";
  const status = document.getElementById("combinedKiriStatus");

  if (!apiKey) {
    status.textContent = "Paste a KIRI API key first.";
    return;
  }

  storeKiriKey(apiKey);
  button.disabled = true;
  status.textContent = "Uploading to KIRI...";

  try {
    const response = await fetch("/api/kiri/upload", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        apiKey,
        fileUrl,
      }),
    });

    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.msg || result.error || "KIRI upload failed.");
    }

    status.textContent = `KIRI job ${result.data.serialize} queued`;
    upsertKiriJob({
      serialize: result.data.serialize,
      fileName,
      fileUrl,
      createdAt: new Date().toISOString(),
      state: 3,
      modelUrl: null,
    });
    startKiriPolling(apiKey, result.data.serialize, status);
  } catch (error) {
    status.textContent = String(error);
    console.error("Failed to send combined file to KIRI", error);
  } finally {
    button.disabled = false;
  }
}

function stopKiriPolling() {
  if (activeKiriPoller) {
    window.clearInterval(activeKiriPoller);
    activeKiriPoller = null;
  }
}

async function checkKiriStatus(apiKey, serialize, statusNode) {
  const params = new URLSearchParams({
    apiKey,
    serialize,
  });
  const response = await fetch(`/api/kiri/status?${params.toString()}`);
  const result = await response.json();

  if (!response.ok || !result.ok) {
    throw new Error(result.error || "Failed to check KIRI status.");
  }

  const state = result.status?.data?.status;
  updateKiriJob(serialize, {
    state,
    modelUrl: result.download?.modelUrl || null,
  });
  if (state === 2) {
    stopKiriPolling();
    const modelUrl = result.download?.modelUrl;
    statusNode.innerHTML = modelUrl
      ? `Ready: <a href="${modelUrl}" target="_blank" rel="noreferrer">Open result ZIP</a>`
      : "Ready";
    return;
  }

  if (state === 1) {
    stopKiriPolling();
    statusNode.textContent = "KIRI processing failed.";
    return;
  }

  if (state === 3) {
    statusNode.textContent = `KIRI job ${serialize} queued`;
    return;
  }

  statusNode.textContent = `KIRI job ${serialize} processing`;
}

function startKiriPolling(apiKey, serialize, statusNode) {
  stopKiriPolling();
  checkKiriStatus(apiKey, serialize, statusNode).catch((error) => {
    statusNode.textContent = String(error);
  });
  activeKiriPoller = window.setInterval(() => {
    checkKiriStatus(apiKey, serialize, statusNode).catch((error) => {
      statusNode.textContent = String(error);
    });
  }, 15000);
}

function sendCombinedToKiri(button) {
  sendFileToKiri(button);
}

async function importKiriJob(serialize, button) {
  const jobs = loadStoredKiriJobs();
  const job = jobs.find((entry) => entry.serialize === serialize);
  if (!job?.modelUrl) {
    return;
  }

  button.disabled = true;
  button.textContent = "Importing...";
  try {
    const response = await fetch("/api/kiri/import", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        serialize,
        modelUrl: job.modelUrl,
      }),
    });
    const result = await response.json();

    if (!response.ok || !result.ok) {
      throw new Error(result.error || "Failed to import KIRI result.");
    }

    updateKiriJob(serialize, {
      viewerUrl: result.viewerUrl,
      plyUrl: result.plyUrl,
      camerasUrl: result.camerasUrl,
    });
    window.open(result.viewerUrl, "_blank", "noopener,noreferrer");
  } catch (error) {
    button.disabled = false;
    button.textContent = String(error);
    console.error(`Failed to import KIRI job ${serialize}`, error);
  }
}

function start() {
  const mediaMtxBaseUrl = getMediaMtxBaseUrl();
  serverStatus.textContent = `MediaMTX ${mediaMtxBaseUrl}`;
  kiriApiKeyInput.value = loadStoredKiriKey();
  renderKiriJobs();

  for (const streamId of STREAM_IDS) {
    createCard(streamId, mediaMtxBaseUrl);
  }
}

start();
compileButton.addEventListener("click", compileLatestRecordings);

// ---------- Lambda splat pipeline ----------
const splatStatusEl = document.getElementById("splatStatus");
const splatJobsListEl = document.getElementById("splatJobsList");
const startSplatButton = document.getElementById("startSplatButton");
const splatMaxStepsInput = document.getElementById("splatMaxSteps");
const splatFramesPerCamInput = document.getElementById("splatFramesPerCam");
const splatKeepWarmInput = document.getElementById("splatKeepWarm");

const splatPollHandles = new Map();

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[ch]);
}

function renderSplatJob(job) {
  let card = splatJobsListEl.querySelector(`[data-job-id="${job.jobId}"]`);
  if (!card) {
    card = document.createElement("div");
    card.dataset.jobId = job.jobId;
    card.className = "stack";
    card.style.padding = "8px";
    card.style.border = "1px solid #333";
    card.style.borderRadius = "6px";
    splatJobsListEl.prepend(card);
  }
  const lastEvent = job.events && job.events.length
    ? job.events[job.events.length - 1]
    : null;
  const lastEventStr = lastEvent
    ? `${lastEvent.msg}${Object.keys(lastEvent).filter((k) => !["ts","level","logger","msg"].includes(k)).length ? " " + JSON.stringify(Object.fromEntries(Object.entries(lastEvent).filter(([k]) => !["ts","level","logger","msg"].includes(k)))) : ""}`
    : "";
  card.innerHTML = `
    <div class="controls" style="justify-content:space-between">
      <strong class="mono">${escapeHtml(job.jobId)}</strong>
      <span class="pill mono">${escapeHtml(job.state)}</span>
    </div>
    <div class="mono" style="font-size:12px;opacity:0.8">
      input: ${escapeHtml(job.inputPath || "?")}<br/>
      ${lastEventStr ? `last: ${escapeHtml(lastEventStr)}` : ""}
      ${job.error ? `<br/><span style="color:#ff7b72">error: ${escapeHtml(job.error.stderrTail || JSON.stringify(job.error)).slice(0, 800)}</span>` : ""}
    </div>
    ${job.viewerUrl
      ? `<div class="controls"><a class="button" target="_blank" rel="noopener" href="${escapeHtml(job.viewerUrl)}">Open splat viewer</a>
         <a class="button" download href="${escapeHtml(job.splatUrl)}">Download .splat</a></div>`
      : ""}
  `;
}

async function pollSplatJob(jobId) {
  try {
    const resp = await fetch(`/api/splat/jobs/${jobId}`);
    const body = await resp.json();
    if (!resp.ok || !body.ok) throw new Error(body.error || "status fetch failed");
    renderSplatJob(body);
    if (body.state === "running") return;
    const handle = splatPollHandles.get(jobId);
    if (handle) {
      clearInterval(handle);
      splatPollHandles.delete(jobId);
    }
    splatStatusEl.textContent = body.state === "completed"
      ? `Done: ${jobId}` : `Failed: ${jobId}`;
  } catch (e) {
    console.error("splat poll failed", e);
  }
}

async function startSplatJob() {
  startSplatButton.disabled = true;
  splatStatusEl.textContent = "Starting...";
  try {
    const resp = await fetch("/api/splat/jobs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        maxSteps: Number(splatMaxStepsInput.value) || undefined,
        framesPerCam: Number(splatFramesPerCamInput.value) || undefined,
        keepWarm: !!splatKeepWarmInput.checked,
      }),
    });
    const body = await resp.json();
    if (!resp.ok || !body.ok) throw new Error(body.error || "start failed");
    splatStatusEl.textContent = `Running: ${body.jobId}`;
    renderSplatJob({ jobId: body.jobId, state: "running", inputPath: body.inputPath });
    const handle = setInterval(() => pollSplatJob(body.jobId), 4000);
    splatPollHandles.set(body.jobId, handle);
  } catch (e) {
    splatStatusEl.textContent = `Error: ${e.message}`;
    console.error(e);
  } finally {
    startSplatButton.disabled = false;
  }
}

async function loadExistingSplatJobs() {
  try {
    const resp = await fetch("/api/splat/jobs");
    const body = await resp.json();
    if (!body.ok) return;
    for (const job of body.jobs) {
      const detailResp = await fetch(`/api/splat/jobs/${job.jobId}`);
      const detail = await detailResp.json();
      if (detail.ok) renderSplatJob(detail);
      if (job.state === "running") {
        const handle = setInterval(() => pollSplatJob(job.jobId), 4000);
        splatPollHandles.set(job.jobId, handle);
      }
    }
  } catch (e) {
    console.warn("failed to load existing splat jobs", e);
  }
}

startSplatButton.addEventListener("click", startSplatJob);
loadExistingSplatJobs();

window.addEventListener("beforeunload", () => {
  stopKiriPolling();
  for (const handle of splatPollHandles.values()) clearInterval(handle);
  for (const reader of readers) {
    reader.close();
  }
});
