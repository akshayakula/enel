const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];

const videoGrid = document.getElementById("videoGrid");
const serverStatus = document.getElementById("serverStatus");
const readers = [];

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

function start() {
  const mediaMtxBaseUrl = getMediaMtxBaseUrl();
  serverStatus.textContent = `MediaMTX ${mediaMtxBaseUrl}`;

  for (const streamId of STREAM_IDS) {
    createCard(streamId, mediaMtxBaseUrl);
  }
}

start();

window.addEventListener("beforeunload", () => {
  for (const reader of readers) {
    reader.close();
  }
});
