const PHONE_STREAM_IDS = ["cam3", "cam4"];
const STREAM_LABELS = { cam3: "gnd-2", cam4: "gnd-3" };
const streamButtons = document.getElementById("streamButtons");
const activeStream = document.getElementById("activeStream");
const publishStatus = document.getElementById("publishStatus");
const cameraStatus = document.getElementById("cameraStatus");
const localVideo = document.getElementById("localVideo");
const stopButton = document.getElementById("stopButton");
const compassButton = document.getElementById("compassButton");
const phoneNeedle = document.getElementById("phoneNeedle");
const phoneTargetNeedle = document.getElementById("phoneTargetNeedle");
const phoneHeading = document.getElementById("phoneHeading");
const phoneTarget = document.getElementById("phoneTarget");
const phoneLocation = document.getElementById("phoneLocation");
const phonePointing = document.getElementById("phonePointing");

const params = new URLSearchParams(window.location.search);
const requestedStreamId = (params.get("streamId") || "").trim();
const targetBearingDeg = normalizeDeg(Number(params.get("bearing_deg") || params.get("bearing") || 0));

let localStream = null;
let publisher = null;
let currentStreamId = null;
let lastHeadingDeg = null;
let headingSpoofed = false;
let lastLocation = null;
let poseTimer = null;

function normalizeDeg(value) {
  return ((Number(value) % 360) + 360) % 360;
}

function shortestDeltaDeg(target, current) {
  return ((normalizeDeg(target) - normalizeDeg(current) + 540) % 360) - 180;
}

function formatDeg(value) {
  if (!Number.isFinite(value)) return "--";
  return `${Math.round(normalizeDeg(value)).toString().padStart(3, "0")}°`;
}

function isExpectedCameraError(error) {
  return ["NotFoundError", "NotAllowedError", "SecurityError"].includes(error?.name);
}

function publishClass(text) {
  const value = String(text || "").toLowerCase();
  if (value.includes("live")) return "live";
  if (value.includes("fail") || value.includes("error") || value.includes("no free")) return "error";
  if (value.includes("prepar") || value.includes("finding") || value.includes("retry")) return "pending";
  return "idle";
}

function setPublishStatus(text) {
  publishStatus.textContent = text;
  publishStatus.className = `phone-status mono ${publishClass(text)}`;
}

function setCameraStatus(text, className = "") {
  cameraStatus.textContent = text;
  cameraStatus.className = `phone-camera-status mono ${className}`.trim();
}

function setActiveStream(streamId) {
  activeStream.textContent = streamId ? `${STREAM_LABELS[streamId] || streamId} (${streamId})` : "none";
  for (const button of streamButtons.querySelectorAll("[data-stream-id]")) {
    button.classList.toggle("active", button.dataset.streamId === streamId);
  }
}

function updateCompass() {
  if (!phoneHeading || !phoneTarget || !phonePointing) return;
  const heading = Number.isFinite(lastHeadingDeg) ? normalizeDeg(lastHeadingDeg) : targetBearingDeg;
  const delta = shortestDeltaDeg(targetBearingDeg, heading);
  phoneHeading.textContent = `${formatDeg(heading)}${headingSpoofed ? " sim" : ""}`;
  phoneTarget.textContent = formatDeg(targetBearingDeg);
  if (phoneNeedle) phoneNeedle.style.transform = `rotate(${-heading}deg)`;
  if (phoneTargetNeedle) phoneTargetNeedle.style.transform = `rotate(${targetBearingDeg - heading}deg)`;
  if (Math.abs(delta) <= 8) {
    phonePointing.textContent = "camera aligned";
    phonePointing.classList.add("aligned");
  } else {
    const dir = delta > 0 ? "right" : "left";
    phonePointing.textContent = `turn ${dir} ${Math.round(Math.abs(delta))}°`;
    phonePointing.classList.remove("aligned");
  }
}

function onOrientation(event) {
  let heading = null;
  if (Number.isFinite(event.webkitCompassHeading)) {
    heading = event.webkitCompassHeading;
  } else if (Number.isFinite(event.alpha)) {
    heading = 360 - event.alpha;
  }
  if (!Number.isFinite(heading)) return;
  headingSpoofed = false;
  lastHeadingDeg = normalizeDeg(heading);
  updateCompass();
}

function startSpoofCompass() {
  if (Number.isFinite(lastHeadingDeg) && !headingSpoofed) return;
  headingSpoofed = true;
  lastHeadingDeg = targetBearingDeg;
  updateCompass();
}

async function enableCompass() {
  try {
    if (window.DeviceOrientationEvent?.requestPermission) {
      const result = await window.DeviceOrientationEvent.requestPermission();
      if (result !== "granted") {
        startSpoofCompass();
        return;
      }
    }
    window.addEventListener("deviceorientationabsolute", onOrientation, true);
    window.addEventListener("deviceorientation", onOrientation, true);
    setTimeout(() => {
      if (!Number.isFinite(lastHeadingDeg)) startSpoofCompass();
    }, 1200);
  } catch {
    startSpoofCompass();
  }
}

function requestLocation() {
  if (!phoneLocation) return;
  if (!("geolocation" in navigator)) {
    phoneLocation.textContent = "unavailable";
    return;
  }
  phoneLocation.textContent = "requesting";
  navigator.geolocation.watchPosition((pos) => {
    lastLocation = {
      lat: pos.coords.latitude,
      lon: pos.coords.longitude,
      accuracy: pos.coords.accuracy,
    };
    phoneLocation.textContent = `±${Math.round(lastLocation.accuracy)}m`;
  }, (err) => {
    phoneLocation.textContent = err?.code === 1 ? "denied" : "unfixed";
  }, {
    enableHighAccuracy: true,
    maximumAge: 2000,
    timeout: 15000,
  });
}

function startPoseUploads() {
  if (poseTimer) return;
  poseTimer = setInterval(() => {
    if (!currentStreamId) return;
    const heading = Number.isFinite(lastHeadingDeg) ? normalizeDeg(lastHeadingDeg) : null;
    const body = {
      heading_deg: heading,
      target_bearing_deg: targetBearingDeg,
      delta_deg: heading == null ? null : shortestDeltaDeg(targetBearingDeg, heading),
      spoofed: headingSpoofed,
      lat: lastLocation?.lat ?? null,
      lon: lastLocation?.lon ?? null,
      accuracy: lastLocation?.accuracy ?? null,
    };
    fetch(`/api/phone-pose/${currentStreamId}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }).catch(() => {});
  }, 1000);
}

async function ensureCamera() {
  if (localStream) {
    return localStream;
  }

  localStream = await navigator.mediaDevices.getUserMedia({
    audio: false,
    video: {
      facingMode: { ideal: "environment" },
      width: { ideal: 1920 },
      height: { ideal: 1080 },
      frameRate: { ideal: 30, max: 30 },
    },
  });

  localVideo.srcObject = localStream;
  localVideo.classList.add("has-video");
  setCameraStatus("Camera ready", "live");
  return localStream;
}

async function cleanupSession() {
  if (publisher) {
    publisher.close();
    publisher = null;
  }

  if (localStream) {
    localStream.getTracks().forEach((track) => track.stop());
    localStream = null;
    localVideo.srcObject = null;
    localVideo.classList.remove("has-video");
  }

  currentStreamId = null;
  setActiveStream("");
  stopButton.disabled = true;
  setPublishStatus("Idle");
  setCameraStatus("Waiting for camera");
}

async function publishToStream(streamId) {
  if (!PHONE_STREAM_IDS.includes(streamId)) {
    return;
  }

  await cleanupSession();

  currentStreamId = streamId;
  const label = STREAM_LABELS[streamId] || streamId;
  setActiveStream(streamId);
  setPublishStatus(`Preparing ${label}`);
  stopButton.disabled = false;

  try {
    const stream = await ensureCamera();
    setPublishStatus(`Publishing ${label}`);

    publisher = new MediaMTXWebRTCPublisher({
      url: `${window.location.origin}/whip/${streamId}`,
      stream,
      videoCodec: "h264",
      videoBitrate: 3000,
      audioCodec: "opus",
      audioBitrate: 32,
      audioVoice: false,
      onConnected: () => {
        setPublishStatus(`Live on ${label}`);
        setCameraStatus("Publishing video only", "live");
      },
      onError: (err) => {
        console.error(err);
        setPublishStatus("Publish retrying");
        setCameraStatus(String(err), "error");
      },
    });
  } catch (error) {
    if (!isExpectedCameraError(error)) console.error(error);
    setPublishStatus("Publish failed");
    setCameraStatus("Camera or publisher error", "error");
    stopButton.disabled = true;
  }
}

function renderButtons() {
  for (const streamId of PHONE_STREAM_IDS) {
    const button = document.createElement("button");
    button.className = "phone-slot-button mono";
    button.dataset.streamId = streamId;
    button.innerHTML = `<span>${STREAM_LABELS[streamId] || streamId}</span><small>${streamId}</small>`;
    button.title = streamId;
    button.addEventListener("click", () => {
      publishToStream(streamId).catch((error) => {
        console.error(error);
      });
    });
    streamButtons.appendChild(button);
  }
}

stopButton.addEventListener("click", () => {
  cleanupSession().catch((error) => {
    console.error(error);
  });
});

if (compassButton) {
  compassButton.addEventListener("click", enableCompass);
}

window.addEventListener("pagehide", () => {
  cleanupSession().catch(() => {});
});

async function claimNextSlot() {
  setPublishStatus("Finding free ground phone slot");
  const response = await fetch("/api/next-slot?role=phone", { cache: "no-store" });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error || `next-slot ${response.status}`);
  }
  const { streamId } = await response.json();
  return streamId;
}

async function publishAuto({ retry = true } = {}) {
  try {
    const streamId = await claimNextSlot();
    await publishToStream(streamId);
  } catch (error) {
    console.error(error);
    if (retry) {
      await new Promise((r) => setTimeout(r, 750));
      await publishAuto({ retry: false });
      return;
    }
    setPublishStatus("No free slot");
    setCameraStatus(String(error.message || error), "error");
  }
}

const autoButton = document.createElement("button");
autoButton.className = "phone-slot-button phone-slot-button--auto mono";
autoButton.innerHTML = "<span>auto assign</span><small>free ground slot</small>";
autoButton.addEventListener("click", () => {
  publishAuto().catch((error) => {
    console.error(error);
  });
});
streamButtons.appendChild(autoButton);

renderButtons();
updateCompass();
requestLocation();
startPoseUploads();
enableCompass();

if (PHONE_STREAM_IDS.includes(requestedStreamId)) {
  publishToStream(requestedStreamId).catch((error) => {
    console.error(error);
  });
} else {
  publishAuto().catch((error) => {
    console.error(error);
  });
}
