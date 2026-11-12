// Filla in-page overlay.
// Injects a floating launcher chip and a card that frames the extension's
// panel page, so Filla lives on the job page itself like a native widget.
// Everything sits inside a closed shadow root, so the host page's styles
// cannot leak in and ours cannot leak out. The framed page is an extension
// page, so it keeps full chrome.* API access.

(() => {
  if (window.top !== window) return; // never inject into nested frames

  const PANEL_URL = chrome.runtime.getURL("sidepanel/panel.html");
  const OPEN_KEY = "filla-overlay-open";

  const host = document.createElement("filla-root");
  const shadow = host.attachShadow({ mode: "closed" });

  const style = document.createElement("style");
  style.textContent = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .chip {
      position: fixed; top: 92px; right: 18px; z-index: 2147483000;
      width: 46px; height: 46px; border-radius: 50%; border: none;
      cursor: pointer; color: white; font: 800 19px/1 system-ui, sans-serif;
      background: linear-gradient(135deg, #7c5cff, #38bdf8);
      box-shadow: 0 6px 22px rgba(124, 92, 255, 0.45), 0 2px 8px rgba(0, 0, 0, 0.3);
      display: flex; align-items: center; justify-content: center;
      transition: transform 0.15s ease, box-shadow 0.2s ease;
    }
    .chip:hover { transform: scale(1.07); box-shadow: 0 8px 28px rgba(124, 92, 255, 0.6); }
    .chip:focus-visible { outline: 2px solid #38bdf8; outline-offset: 2px; }

    .card {
      position: fixed; top: 92px; right: 76px; z-index: 2147483000;
      width: 396px; height: min(780px, calc(100vh - 120px));
      border-radius: 18px; overflow: hidden; background: #10121d;
      border: 1px solid rgba(124, 92, 255, 0.25);
      box-shadow: 0 24px 70px rgba(0, 0, 0, 0.55), 0 0 0 1px rgba(0, 0, 0, 0.2);
      transform-origin: top right;
      transition: opacity 0.22s ease, transform 0.22s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .card.closed {
      opacity: 0; transform: scale(0.95) translateY(-6px); pointer-events: none;
    }
    .card iframe { width: 100%; height: 100%; border: none; display: block; }

    @media (prefers-reduced-motion: reduce) {
      .chip, .card { transition: none; }
    }
  `;

  const chip = document.createElement("button");
  chip.className = "chip";
  chip.textContent = "F";
  chip.title = "Open Filla";

  const card = document.createElement("div");
  card.className = "card closed";

  let frame = null;
  let open = false;

  function setOpen(next) {
    open = next;
    if (open && !frame) {
      frame = document.createElement("iframe");
      frame.src = PANEL_URL;
      frame.allow = "clipboard-write";
      card.appendChild(frame);
    }
    card.classList.toggle("closed", !open);
    chip.textContent = open ? "×" : "F";
    chip.title = open ? "Close Filla" : "Open Filla";
    try { sessionStorage.setItem(OPEN_KEY, open ? "1" : "0"); } catch {}
  }

  chip.addEventListener("click", () => setOpen(!open));

  shadow.append(style, chip, card);
  document.documentElement.appendChild(host);

  // Reopen automatically if it was open on this tab before a navigation,
  // so multi-page application flows keep the card in view.
  let wasOpen = false;
  try { wasOpen = sessionStorage.getItem(OPEN_KEY) === "1"; } catch {}
  if (wasOpen) setOpen(true);
})();
