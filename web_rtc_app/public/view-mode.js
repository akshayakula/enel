// Live/Demo segmented toggle in the top bar. Default = LIVE (real feeds; offline
// cams show a "no signal" placeholder). DEMO replays the bundled fallback videos
// in each tile. Choice persists in localStorage. Pure CSS gating via a
// `demo-mode` class on <body>; no coupling to viewer.js.
(function () {
  const KEY = "enel.viewMode.v1"; // "live" | "demo"

  function apply(mode) {
    const demo = mode === "demo";
    document.body.classList.toggle("demo-mode", demo);
    const toggle = document.getElementById("btnViewMode");
    if (toggle) {
      toggle.setAttribute("aria-checked", demo ? "true" : "false");
      toggle.classList.toggle("is-demo", demo);
      toggle.classList.toggle("is-live", !demo);
      toggle.querySelectorAll(".vt-seg").forEach((seg) => {
        seg.classList.toggle("active", seg.dataset.mode === mode);
      });
    }
  }

  function read() {
    try { return localStorage.getItem(KEY) === "demo" ? "demo" : "live"; }
    catch (_) { return "live"; }
  }

  function set(mode) {
    try { localStorage.setItem(KEY, mode); } catch (_) {}
    apply(mode);
  }

  function start() {
    let mode = read();
    apply(mode);
    const toggle = document.getElementById("btnViewMode");
    if (!toggle) { setTimeout(start, 500); return; }

    // Click a segment to select that mode; click elsewhere on the track to flip.
    toggle.addEventListener("click", (e) => {
      const seg = e.target.closest(".vt-seg");
      mode = seg ? seg.dataset.mode : (mode === "demo" ? "live" : "demo");
      set(mode);
    });
    toggle.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        mode = mode === "demo" ? "live" : "demo";
        set(mode);
      }
    });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start);
  } else {
    start();
  }
})();
