// Battery badge overlay for each cam tile. Polls /api/battery/<cam> and shows a
// small badge on the video when fresh battery telemetry is present (the Pi
// pushes it). Standalone so it stays decoupled from viewer.js's render cycle.
(function () {
  const POLL_MS = 4000;

  function ensureBadge(node) {
    const wrap = node.querySelector(".cam-video-wrap");
    if (!wrap) return null; // tile not built yet — try again next poll
    let b = wrap.querySelector(".batt-badge");
    if (!b) {
      b = document.createElement("div");
      b.className = "batt-badge mono";
      b.style.display = "none";
      wrap.appendChild(b);
    }
    return b;
  }

  async function poll(node, cam) {
    const b = ensureBadge(node);
    if (!b) return;
    try {
      const r = await fetch(`/api/battery/${cam}`, { cache: "no-store" });
      if (!r.ok) throw new Error("http " + r.status);
      const d = await r.json();
      if (d && typeof d.pct === "number" && d.stale !== true) {
        const pct = Math.round(d.pct);
        const lvl = pct > 50 ? "ok" : pct >= 20 ? "warn" : "low";
        b.className = `batt-badge mono batt-${lvl}`;
        b.textContent = `${d.charging ? "CHG" : "BAT"} ${pct}%`;
        b.title = `${(d.voltage || 0).toFixed(2)}V · ${d.charging ? "charging" : "discharging"}`;
        b.style.display = "";
        node.classList.remove("battery-fresh");
        void node.offsetWidth;
        node.classList.add("battery-fresh");
        setTimeout(() => node.classList.remove("battery-fresh"), 950);
      } else {
        b.style.display = "none"; // absent or stale → hide
      }
    } catch (_) {
      b.style.display = "none";
    }
  }

  function start() {
    const nodes = Array.from(document.querySelectorAll(".cam-node[data-cam]"));
    if (!nodes.length) { setTimeout(start, 1000); return; }
    nodes.forEach((node) => {
      const cam = node.dataset.cam;
      poll(node, cam);
      setInterval(() => poll(node, cam), POLL_MS);
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
