const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const streamButtons = document.getElementById("streamButtons");
const activeStream = document.getElementById("activeStream");
const publishStatus = document.getElementById("publishStatus");
const cameraStatus = document.getElementById("cameraStatus");
const localVideo = document.getElementById("localVideo");
const stopButton = document.getElementById("stopButton");

const params = new URLSearchParams(window.location.search);
const requestedStreamId = (params.get("streamId") || "").trim();

let localStream = null;
let publisher = null;
let currentStreamId = null;

function setPublishStatus(text) {
  publishStatus.textContent = text;
}

function setCameraStatus(text, className = "") {
  cameraStatus.textContent = text;
  cameraStatus.className = `status ${className}`.trim();
}

function setActiveStream(streamId) {
  activeStream.textContent = streamId || "none";
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
  }

  currentStreamId = null;
  setActiveStream("");
  stopButton.disabled = true;
  setPublishStatus("Idle");
  setCameraStatus("Waiting for camera");
}

async function publishToStream(streamId) {
  if (!STREAM_IDS.includes(streamId)) {
    return;
  }

  await cleanupSession();

  currentStreamId = streamId;
  setActiveStream(streamId);
  setPublishStatus(`Preparing ${streamId}`);
  stopButton.disabled = false;

  try {
    const stream = await ensureCamera();
    setPublishStatus(`Publishing ${streamId}`);

    publisher = new MediaMTXWebRTCPublisher({
      url: `${window.location.origin}/whip/${streamId}`,
      stream,
      videoCodec: "h264",
      videoBitrate: 3000,
      audioCodec: "opus",
      audioBitrate: 32,
      audioVoice: false,
      onConnected: () => {
        setPublishStatus(`Live on ${streamId}`);
        setCameraStatus("Publishing video only", "live");
      },
      onError: (err) => {
        console.error(err);
        setPublishStatus("Publish retrying");
        setCameraStatus(String(err), "error");
      },
    });
  } catch (error) {
    console.error(error);
    setPublishStatus("Publish failed");
    setCameraStatus("Camera or publisher error", "error");
    stopButton.disabled = true;
  }
}

function renderButtons() {
  for (const streamId of STREAM_IDS) {
    const button = document.createElement("button");
    button.className = "button mono";
    button.textContent = streamId;
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

window.addEventListener("pagehide", () => {
  cleanupSession().catch(() => {});
});

async function claimNextSlot() {
  setPublishStatus("Finding free slot");
  const response = await fetch("/api/next-slot", { cache: "no-store" });
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
autoButton.className = "button mono";
autoButton.textContent = "auto";
autoButton.addEventListener("click", () => {
  publishAuto().catch((error) => {
    console.error(error);
  });
});
streamButtons.appendChild(autoButton);

renderButtons();

if (STREAM_IDS.includes(requestedStreamId)) {
  publishToStream(requestedStreamId).catch((error) => {
    console.error(error);
  });
} else {
  publishAuto().catch((error) => {
    console.error(error);
  });
}
