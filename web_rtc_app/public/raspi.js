const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const STREAM_LABELS = { cam1: "gnd-1", cam2: "air-2", cam3: "gnd-3", cam4: "gnd-4" };
const params = new URLSearchParams(window.location.search);
const overrideHost = (params.get("host") || "").trim();

const raspiCards = document.getElementById("raspiCards");
const raspiHostLabel = document.getElementById("raspiHostLabel");

function buildCard(streamId, rtspUrl) {
  const label = STREAM_LABELS[streamId] || streamId;
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title mono">${label} · ${streamId}</div>
      <div class="status live">Video only</div>
    </div>
    <div class="panel stack">
      <p><strong>Assigned device:</strong> Raspberry Pi for ${label}</p>
      <p><strong>RTSP URL:</strong><br /><span class="mono">${rtspUrl}</span></p>
      <ul class="meta-list">
        <li>Disable or omit audio in the Pi publisher config.</li>
        <li>Use this exact stream slot so the viewer wall stays stable.</li>
        <li>Open the viewer wall separately at `/viewer`.</li>
      </ul>
    </div>
  `;
  raspiCards.appendChild(card);
}

function start() {
  const host = overrideHost || window.location.hostname;
  raspiHostLabel.textContent = `RTSP host ${host}:8554`;

  for (const streamId of STREAM_IDS) {
    buildCard(streamId, `rtsp://${host}:8554/${streamId}`);
  }
}

start();
