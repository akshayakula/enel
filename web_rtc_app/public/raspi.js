const STREAM_IDS = ["cam1", "cam2", "cam3", "cam4"];
const params = new URLSearchParams(window.location.search);
const overrideHost = (params.get("host") || "").trim();

const raspiCards = document.getElementById("raspiCards");
const raspiHostLabel = document.getElementById("raspiHostLabel");

function buildCard(streamId, whipUrl) {
  const card = document.createElement("article");
  card.className = "card";
  card.innerHTML = `
    <div class="card-header">
      <div class="card-title mono">${streamId}</div>
      <div class="status live">Video only</div>
    </div>
    <div class="panel stack">
      <p><strong>Assigned device:</strong> Raspberry Pi for ${streamId}</p>
      <p><strong>WHIP URL:</strong><br /><span class="mono">${whipUrl}</span></p>
      <ul class="meta-list">
        <li>Disable or omit audio in the Pi publisher config.</li>
        <li>Use this exact stream slot so the viewer wall stays stable.</li>
        <li>Open the viewer wall separately at `/viewer` on the laptop.</li>
      </ul>
    </div>
  `;
  raspiCards.appendChild(card);
}

function start() {
  const host = overrideHost || window.location.hostname;
  raspiHostLabel.textContent = `WHIP host http://${host}:8889`;

  for (const streamId of STREAM_IDS) {
    buildCard(streamId, `http://${host}:8889/${streamId}/whip`);
  }
}

start();
