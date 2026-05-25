import {
  SceneFormat,
  Viewer,
} from "@mkkellogg/gaussian-splats-3d";
import { Vector3 } from "three";

const viewerRoot = document.getElementById("viewerRoot");
const dropTarget = document.getElementById("dropTarget");
const activeSceneName = document.getElementById("activeSceneName");
const statusDot = document.getElementById("statusDot");
const statusText = document.getElementById("statusText");
const progressBar = document.getElementById("progressBar");
const sceneUrlInput = document.getElementById("sceneUrlInput");
const loadUrlButton = document.getElementById("loadUrlButton");
const fileInput = document.getElementById("fileInput");
const resetButton = document.getElementById("resetButton");
const reloadButton = document.getElementById("reloadButton");
const downloadLink = document.getElementById("downloadLink");
const qualitySelect = document.getElementById("qualitySelect");
const splatCount = document.getElementById("splatCount");
const fileSize = document.getElementById("fileSize");
const fpsValue = document.getElementById("fpsValue");
const refreshLibraryButton = document.getElementById("refreshLibraryButton");
const libraryList = document.getElementById("libraryList");

const initialCameraPosition = [0, -3.5, 1.8];
const initialCameraLookAt = [0, 0, 0];
const initialCameraUp = [0, 0, 1];

let libraryItems = [];
let activeScene = null;
let activeObjectUrl = null;
let loadToken = 0;
let viewerStarted = false;
let fittedCamera = null;

const viewer = new Viewer({
  rootElement: viewerRoot,
  cameraUp: initialCameraUp,
  initialCameraPosition,
  initialCameraLookAt,
  sharedMemoryForWorkers: false,
  gpuAcceleratedSort: false,
  ignoreDevicePixelRatio: window.devicePixelRatio > 1.5,
  freeIntermediateSplatData: true,
  optimizeSplatData: true,
});

function wrapThenable(thenable) {
  return new Promise((resolve, reject) => {
    thenable.then(resolve).catch(reject);
  });
}

function formatFromName(name) {
  const lower = String(name || "").toLowerCase();
  if (lower.endsWith(".splat")) return SceneFormat.Splat;
  if (lower.endsWith(".ksplat")) return SceneFormat.KSplat;
  if (lower.endsWith(".ply")) return SceneFormat.Ply;
  if (lower.endsWith(".spz")) return SceneFormat.Spz;
  return null;
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes)) return "-";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const digits = value >= 10 || unit === 0 ? 0 : 1;
  return `${value.toFixed(digits)} ${units[unit]}`;
}

function setStatus(kind, message) {
  statusDot.className = `status-dot ${kind || ""}`.trim();
  statusText.textContent = message;
}

function setProgress(value) {
  const percent = Math.max(0, Math.min(100, Number(value) || 0));
  progressBar.style.width = `${percent}%`;
}

function normalizeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.origin === window.location.origin
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : parsed.href;
  } catch {
    return url;
  }
}

function sceneMatchesActive(item) {
  if (!activeScene) return false;
  return normalizeUrl(item.url) === normalizeUrl(activeScene.url);
}

function renderLibrary() {
  if (!libraryItems.length) {
    libraryList.innerHTML = '<p class="empty-state">No local splat files found.</p>';
    return;
  }

  libraryList.innerHTML = libraryItems.map((item, index) => {
    const isActive = sceneMatchesActive(item) ? " active" : "";
    const size = formatBytes(item.sizeBytes);
    const mtime = item.mtime ? new Date(item.mtime).toLocaleString() : "";
    return `
      <button class="library-item${isActive}" type="button" data-index="${index}">
        <strong>${escapeHtml(item.label)}</strong>
        <span>${escapeHtml(item.source)} · ${escapeHtml(item.extension)} · ${escapeHtml(size)}</span>
        <span>${escapeHtml(mtime)}</span>
      </button>
    `;
  }).join("");

  for (const button of libraryList.querySelectorAll(".library-item")) {
    button.addEventListener("click", () => {
      const item = libraryItems[Number(button.dataset.index)];
      if (item) loadScene(item);
    });
  }
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

async function loadLibrary() {
  refreshLibraryButton.disabled = true;
  try {
    const response = await fetch("/api/splats");
    const body = await response.json();
    if (!response.ok || !body.ok) {
      throw new Error(body.error || "Unable to list splats");
    }
    libraryItems = body.files || [];
    renderLibrary();
    return body;
  } catch (error) {
    libraryList.innerHTML = `<p class="empty-state">${escapeHtml(error.message)}</p>`;
    return { files: [], defaultUrl: null };
  } finally {
    refreshLibraryButton.disabled = false;
  }
}

async function removeCurrentScene() {
  const sceneCount = viewer.getSceneCount();
  for (let index = sceneCount - 1; index >= 0; index -= 1) {
    await wrapThenable(viewer.removeSplatScene(index, false));
  }
}

function sceneOptionsFor(scene) {
  const quality = qualitySelect.value;
  const threshold = quality === "sharp" ? 1 : quality === "fast" ? 12 : 5;
  return {
    format: scene.format ?? formatFromName(scene.url || scene.name),
    progressiveLoad: false,
    showLoadingUI: false,
    splatAlphaRemovalThreshold: threshold,
    onProgress(percent, label) {
      setProgress(percent);
      if (label) setStatus("loading", `Loading ${label}`);
    },
  };
}

async function loadScene(scene) {
  const token = ++loadToken;
  const format = scene.format ?? formatFromName(scene.url || scene.name);
  if (format === null) {
    setStatus("error", "Unsupported file type");
    return;
  }

  setStatus("loading", "Loading scene");
  setProgress(0);
  loadUrlButton.disabled = true;
  reloadButton.disabled = true;
  activeSceneName.textContent = scene.label || scene.name || scene.url;

  try {
    await removeCurrentScene();
    if (token !== loadToken) return;

    await wrapThenable(viewer.addSplatScene(scene.url, sceneOptionsFor({ ...scene, format })));
    if (token !== loadToken) return;

    if (!viewerStarted) {
      viewer.start();
      viewerStarted = true;
    }

    activeScene = { ...scene, format };
    fitSceneToView();
    sceneUrlInput.value = scene.url.startsWith("blob:") ? "" : normalizeUrl(scene.url);
    downloadLink.href = scene.url;
    downloadLink.download = scene.name || "scene.splat";
    fileSize.textContent = formatBytes(scene.sizeBytes);
    setProgress(100);
    setStatus("ready", "Ready");
    updateStats();
    renderLibrary();

    if (!scene.url.startsWith("blob:")) {
      const params = new URLSearchParams(window.location.search);
      params.set("url", normalizeUrl(scene.url));
      window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
    }
  } catch (error) {
    console.error("Failed to load splat scene", error);
    setStatus("error", error.message || "Load failed");
    setProgress(0);
  } finally {
    loadUrlButton.disabled = false;
    reloadButton.disabled = false;
  }
}

function loadUrlFromInput() {
  const url = sceneUrlInput.value.trim();
  if (!url) return;
  const item = libraryItems.find((entry) => normalizeUrl(entry.url) === normalizeUrl(url));
  loadScene(item || {
    name: url.split("/").pop() || "Remote splat",
    label: url,
    source: "URL",
    url,
    sizeBytes: NaN,
  });
}

function loadFile(file) {
  const format = formatFromName(file.name);
  if (format === null) {
    setStatus("error", "Unsupported file type");
    return;
  }
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  activeObjectUrl = URL.createObjectURL(file);
  loadScene({
    name: file.name,
    label: file.name,
    source: "Local",
    url: activeObjectUrl,
    format,
    sizeBytes: file.size,
  });
}

function resetCamera() {
  const position = fittedCamera?.position || initialCameraPosition;
  const target = fittedCamera?.target || initialCameraLookAt;
  const up = fittedCamera?.up || initialCameraUp;
  viewer.camera.position.fromArray(position);
  viewer.camera.up.fromArray(up).normalize();
  viewer.camera.lookAt(...target);
  if (viewer.controls) {
    viewer.controls.target.fromArray(target);
    viewer.controls.update();
  }
  viewer.forceRenderNextFrame();
}

function fitSceneToView() {
  const mesh = viewer.splatMesh;
  const count = mesh?.getSplatCount?.() || 0;
  if (!count) {
    fittedCamera = null;
    resetCamera();
    return;
  }

  const center = new Vector3();
  const temp = new Vector3();
  const step = Math.max(1, Math.floor(count / 8000));
  const xs = [];
  const ys = [];
  const zs = [];

  for (let index = 0; index < count; index += step) {
    mesh.getSplatCenter(index, temp, true);
    xs.push(temp.x);
    ys.push(temp.y);
    zs.push(temp.z);
  }

  if (!xs.length) {
    fittedCamera = null;
    resetCamera();
    return;
  }

  xs.sort((a, b) => a - b);
  ys.sort((a, b) => a - b);
  zs.sort((a, b) => a - b);
  const low = Math.floor(xs.length * 0.04);
  const high = Math.max(low, Math.ceil(xs.length * 0.96) - 1);
  const min = new Vector3(xs[low], ys[low], zs[low]);
  const max = new Vector3(xs[high], ys[high], zs[high]);

  if (!Number.isFinite(min.x) || !Number.isFinite(max.x)) {
    fittedCamera = null;
    resetCamera();
    return;
  }

  center.copy(min).add(max).multiplyScalar(0.5);
  const radius = Math.max(0.35, center.distanceTo(max));
  const direction = new Vector3(0, -1, 0.32).normalize();
  const distance = Math.max(0.8, radius / Math.sin((viewer.camera.fov * Math.PI / 180) / 2) * 1.05);
  const cameraPosition = center.clone().addScaledVector(direction, distance);

  fittedCamera = {
    position: cameraPosition.toArray(),
    target: center.toArray(),
    up: initialCameraUp,
  };

  viewer.camera.near = Math.max(0.01, distance / 500);
  viewer.camera.far = Math.max(1000, distance * 500);
  viewer.camera.updateProjectionMatrix();
  resetCamera();
}

function updateStats() {
  const count = viewer.splatMesh?.getSplatCount?.() || 0;
  splatCount.textContent = count ? count.toLocaleString() : "-";
  fpsValue.textContent = viewer.currentFPS ? String(Math.round(viewer.currentFPS)) : "-";
}

function setupDropTarget() {
  let dragDepth = 0;

  window.addEventListener("dragenter", (event) => {
    event.preventDefault();
    dragDepth += 1;
    dropTarget.hidden = false;
  });

  window.addEventListener("dragover", (event) => {
    event.preventDefault();
  });

  window.addEventListener("dragleave", (event) => {
    event.preventDefault();
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) dropTarget.hidden = true;
  });

  window.addEventListener("drop", (event) => {
    event.preventDefault();
    dragDepth = 0;
    dropTarget.hidden = true;
    const file = event.dataTransfer?.files?.[0];
    if (file) loadFile(file);
  });
}

async function boot() {
  setStatus("loading", "Scanning local splats");
  const library = await loadLibrary();
  const params = new URLSearchParams(window.location.search);
  const queryUrl = params.get("url");
  const firstScene = queryUrl
    ? libraryItems.find((item) => normalizeUrl(item.url) === normalizeUrl(queryUrl)) || { url: queryUrl, label: queryUrl, name: queryUrl.split("/").pop() }
    : libraryItems.find((item) => item.name === "scene.splat") || libraryItems[0];

  if (firstScene) {
    await loadScene(firstScene);
  } else if (library.defaultUrl) {
    await loadScene({ url: library.defaultUrl, label: library.defaultUrl, name: library.defaultUrl.split("/").pop() });
  } else {
    setStatus("", "Idle");
  }
}

loadUrlButton.addEventListener("click", loadUrlFromInput);
sceneUrlInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") loadUrlFromInput();
});
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) loadFile(file);
  fileInput.value = "";
});
resetButton.addEventListener("click", resetCamera);
reloadButton.addEventListener("click", () => {
  if (activeScene) loadScene(activeScene);
});
qualitySelect.addEventListener("change", () => {
  if (activeScene) loadScene(activeScene);
});
refreshLibraryButton.addEventListener("click", loadLibrary);
window.addEventListener("beforeunload", () => {
  if (activeObjectUrl) URL.revokeObjectURL(activeObjectUrl);
  if (viewerStarted) viewer.stop();
});

setupDropTarget();
setInterval(updateStats, 1000);
boot();
