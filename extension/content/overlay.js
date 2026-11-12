// Filla in-page overlay.
// A floating launcher chip docked to the right edge, draggable up and down
// like Simplify or Apollo, plus a card that frames the extension's panel
// page. Everything sits inside a closed shadow root, so the host page's
// styles cannot leak in and ours cannot leak out. The framed page is an
// extension page, so it keeps full chrome.* API access.

(() => {
  if (window.top !== window) return; // never inject into nested frames

  const PANEL_URL = chrome.runtime.getURL("sidepanel/panel.html");
  const OPEN_KEY = "filla-overlay-open";
  const POS_KEY = "fillaChipPos"; // fraction of viewport height, synced via chrome.storage

  const host = document.createElement("filla-root");
  const shadow = host.attachShadow({ mode: "closed" });

  // @font-face does not take effect inside a shadow root, so the face is
  // declared at document level and only the family is used in the shadow.
  const fontFace = document.createElement("style");
  fontFace.textContent = `
    @font-face {
      font-family: "Filla Geist Serif";
      src: url("${chrome.runtime.getURL("fonts/GeistSerif-Triangle.woff2")}") format("woff2");
      font-weight: 400;
      font-display: swap;
    }`;
  document.documentElement.appendChild(fontFace);

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .chip {
      position: fixed; right: 18px; z-index: 2147483000;
      width: 46px; height: 46px; border-radius: 50%;
      border: 1px solid #E8E9F0;
      cursor: grab; color: #17181D;
      font: 700 19px/1 "Filla Geist Serif", Georgia, serif;
      background: #FFFFFF;
      box-shadow: 0 2px 6px rgba(23, 24, 29, 0.08), 0 10px 28px rgba(23, 24, 29, 0.14);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.15s ease, box-shadow 0.2s ease;
      touch-action: none; user-select: none;
    }
    .chip::after {
      content: ""; position: absolute; right: 9px; top: 9px;
      width: 6px; height: 6px; border-radius: 50%; background: #99A5F2;
    }
    .chip:hover { transform: scale(1.07); box-shadow: 0 4px 10px rgba(23,24,29,0.1), 0 14px 34px rgba(23,24,29,0.18); }
    .chip.dragging { cursor: grabbing; transform: scale(1.12); transition: none; }
    .chip:focus-visible { outline: 2px solid #99A5F2; outline-offset: 2px; }

    .card {
      position: fixed; right: 76px; z-index: 2147483000;
      width: 396px; height: min(780px, calc(100vh - 40px));
      border-radius: 18px; overflow: hidden; background: #F6F6F9;
      border: 1px solid #E8E9F0;
      box-shadow: 0 4px 12px rgba(23, 24, 29, 0.07), 0 32px 80px rgba(23, 24, 29, 0.18);
      transform-origin: top right;
      transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .card.closed {
      opacity: 0; transform: scale(0.95) translateY(-6px); pointer-events: none;
    }
    .card iframe { width: 100%; height: 100%; border: none; display: block; }

    @media (prefers-reduced-motion: reduce) {
      .chip, .card { transition: none; }
      .chip.dragging { transform: none; }
    }
  `;

  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = "F";
  chip.title = "Filla (drag to move)";

  const card = document.createElement("div");
  card.className = "card closed";

  let frame = null;
  let open = false;
  let chipTop = 92;

  const clampChip = (top) =>
    Math.min(Math.max(top, 8), window.innerHeight - chip.offsetHeight - 8);

  function placeCard() {
    const cardH = Math.min(780, window.innerHeight - 40);
    const top = Math.min(Math.max(chipTop, 14), window.innerHeight - cardH - 14);
    card.style.top = top + "px";
  }

  function setChipTop(top, save = false) {
    chipTop = clampChip(top);
    chip.style.top = chipTop + "px";
    placeCard();
    if (save) {
      try {
        chrome.storage.local.set({ [POS_KEY]: chipTop / window.innerHeight });
      } catch {}
    }
  }

  function setOpen(next) {
    open = next;
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.src = PANEL_URL;
      frame.allow = "clipboard-write";
      card.appendChild(frame);
    }
    if (open) placeCard();
    card.classList.toggle("closed", !open);
    chip.textContent = open ? "×" : "F";
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
  }

  // Drag along the right edge; a press that barely moves counts as a click.
  let dragging = false;
  let moved = false;
  let startY = 0;
  let startTop = 0;

  chip.addEventListener("pointerdown", (e) => {
    dragging = true;
    moved = false;
    startY = e.clientY;
    startTop = chipTop;
    chip.setPointerCapture(e.pointerId);
  });

  chip.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    const dy = e.clientY - startY;
    if (Math.abs(dy) > 4) {
      moved = true;
      chip.classList.add("dragging");
    }
    if (moved) setChipTop(startTop + dy);
  });

  chip.addEventListener("pointerup", (e) => {
    if (!dragging) return;
    dragging = false;
    chip.classList.remove("dragging");
    chip.releasePointerCapture(e.pointerId);
    if (moved) setChipTop(chipTop, true);
    else setOpen(!open);
  });

  chip.addEventListener("pointercancel", () => {
    dragging = false;
    chip.classList.remove("dragging");
  });

  // Keyboard access: Enter or Space toggles, arrows nudge the chip.
  chip.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp") { e.preventDefault(); setChipTop(chipTop - 24, true); }
    if (e.key === "ArrowDown") { e.preventDefault(); setChipTop(chipTop + 24, true); }
  });

  window.addEventListener("resize", () => setChipTop(chipTop));

  shadow.append(style, chip, card);
  document.documentElement.appendChild(host);

  // Restore the saved edge position (shared across all job sites), then the
  // per-tab open state so multi-page application flows keep the card in view.
  try {
    chrome.storage.local.get(POS_KEY, (res) => {
      const frac = res?.[POS_KEY];
      setChipTop(typeof frac === "number" ? frac * window.innerHeight : 92);
      let wasOpen = false;
      try { wasOpen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch {}
      if (wasOpen) setOpen(true);
    });
  } catch {
    setChipTop(92);
  }
})();
