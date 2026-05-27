// Publish-mode selector for each cam tile. Lets the operator pick whether the
// Pi publishes to both servers, LAN only, or the remote server only. Writes the
// choice to this dashboard's /api/control/<cam>; the Pi polls every reachable
// dashboard and applies the newest-written mode. Standalone (decoupled from
// viewer.js).
(function () {
  const POLL_MS = 4000;
  const MODES = [
    ["both", "both"],
    ["lan", "lan"],
    ["server", "srv"],
  ];

  function setActive(bar, mode) {
    bar.querySelectorAll(".pub-mode-btn").forEach((b) => {
      b.classList.toggle("active", b.dataset.mode === mode);
    });
  }

  function ensureBar(node) {
    let bar = node.querySelector(".pub-mode");
    if (bar) return bar;
    const cam = node.dataset.cam;
    bar = document.createElement("div");
    bar.className = "pub-mode mono";

    const lbl = document.createElement("span");
    lbl.className = "pub-mode-label";
    lbl.textContent = "pub";
    bar.appendChild(lbl);

    MODES.forEach(([mode, label]) => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "pub-mode-btn";
      b.dataset.mode = mode;
      b.textContent = label;
      b.title = `publish to: ${mode}`;
      b.addEventListener("click", async () => {
        setActive(bar, mode); // optimistic
        try {
          await fetch(`/api/control/${cam}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ mode }),
          });
        } catch (_) { /* will resync on next poll */ }
      });
      bar.appendChild(b);
    });

    node.appendChild(bar);
    return bar;
  }

  async function poll(node, cam) {
    const bar = ensureBar(node);
    try {
      const r = await fetch(`/api/control/${cam}`, { cache: "no-store" });
      if (!r.ok) return;
      const d = await r.json();
      setActive(bar, d.mode || "both");
    } catch (_) { /* ignore */ }
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
