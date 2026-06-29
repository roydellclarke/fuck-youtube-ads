// overlay.js — Shadow-DOM productivity UI (centered motivational quote + notes).
//
// The overlay lives in a Shadow DOM host mounted over #movie_player so that
// YouTube's page CSS cannot leak in, and our CSS cannot leak out. styles.css is
// fetched once and injected into the shadow root only.
//
// Mounted automatically during ads, or on demand (closable:true) via the
// keyboard command / popup button.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // Cache the stylesheet text so we only fetch the packaged file once.
  let cssTextPromise = null;
  function loadCss() {
    if (cssTextPromise) return cssTextPromise;
    cssTextPromise = (async () => {
      try {
        const url = chrome.runtime.getURL("styles.css");
        const res = await fetch(url);
        return await res.text();
      } catch (e) {
        console.warn("[WatchFree] could not load styles.css:", e);
        return "";
      }
    })();
    return cssTextPromise;
  }

  // Built-in motivational quotes (used when the user hasn't set custom ones).
  const DEFAULT_QUOTES = [
    "The secret of getting ahead is getting started.",
    "Small steps every day add up to big results.",
    "Focus on progress, not perfection.",
    "Discipline is choosing what you want most over what you want now.",
    "You don't have to be great to start, but you have to start to be great.",
    "A minute of patience can save an hour of distraction.",
    "Done is better than perfect.",
    "Energy flows where attention goes.",
    "The best time to plant a tree was 20 years ago. The second best is now.",
    "Your future is created by what you do today, not tomorrow.",
    "Slow is smooth, and smooth is fast.",
    "What you do every day matters more than what you do once in a while.",
    "Make each minute count — this one too.",
    "Success is the sum of small efforts repeated day in and day out.",
    "Don't watch the clock; do what it does — keep going.",
  ];

  // createOverlay(config, getPlayer)
  //   config    — the Goal config (fade/quote timing).
  //   getPlayer — () => the live #movie_player element (re-queried each mount,
  //               because YouTube reuses/replaces it across SPA navigations).
  NS.createOverlay = function createOverlay(config, getPlayer) {
    let host = null; // the shadow host element currently in the page (or null)
    let shadow = null;
    let notesSaveTimer = null;
    let quoteTimer = null;
    let quoteIndex = 0;
    let activeQuotes = DEFAULT_QUOTES;

    function buildUI(opts) {
      const wrap = document.createElement("div");
      wrap.className = "watchfree-overlay";

      const card = document.createElement("div");
      card.className = "card";

      const header = document.createElement("div");
      header.className = "card-header";
      const title = document.createElement("span");
      title.className = "title";
      title.textContent = "WatchFree";
      const subtitle = document.createElement("span");
      subtitle.className = "subtitle";
      subtitle.textContent = opts.closable
        ? "productivity panel"
        : "handling ad — make this minute count";
      header.appendChild(title);
      header.appendChild(subtitle);

      // Stats line (rehydrated from storage).
      const stats = document.createElement("span");
      stats.className = "stats";
      header.appendChild(stats);

      // Close button (only for the on-demand panel; during ads it stays locked).
      if (opts.closable) {
        const closeBtn = document.createElement("button");
        closeBtn.className = "close-btn";
        closeBtn.type = "button";
        closeBtn.setAttribute("aria-label", "Close panel");
        closeBtn.textContent = "×";
        closeBtn.addEventListener("click", () => unmount());
        header.appendChild(closeBtn);
      }

      // Centerpiece: the motivational quote, vertically + horizontally centered
      // in the space between the header and the notes.
      const quoteZone = document.createElement("div");
      quoteZone.className = "quote-zone";
      const quote = document.createElement("blockquote");
      quote.className = "quote";
      quote.textContent = activeQuotes[quoteIndex % activeQuotes.length];
      quoteZone.appendChild(quote);

      // --- Notes section ---
      const noteSection = document.createElement("section");
      noteSection.className = "section";
      const noteHeading = document.createElement("h2");
      noteHeading.textContent = "Notes / learning";
      noteSection.appendChild(noteHeading);

      const textarea = document.createElement("textarea");
      textarea.className = "note-area";
      textarea.placeholder = "Jot a note or something you're learning…";
      textarea.addEventListener("input", () => {
        clearTimeout(notesSaveTimer);
        notesSaveTimer = setTimeout(() => {
          NS.storage.saveNotes(textarea.value);
        }, 250); // debounce writes while typing
      });
      noteSection.appendChild(textarea);

      card.appendChild(header);
      card.appendChild(quoteZone);
      card.appendChild(noteSection);
      wrap.appendChild(card);

      return { wrap, textarea, quote, stats };
    }

    function formatSaved(seconds) {
      const m = Math.round((seconds || 0) / 60);
      if (m >= 60) {
        const h = Math.floor(m / 60);
        return `${h}h ${m % 60}m`;
      }
      return `${m} min`;
    }

    async function hydrate(parts) {
      // Custom quotes override the built-ins when present.
      const custom = await NS.storage.getQuotes();
      if (Array.isArray(custom) && custom.length) {
        activeQuotes = custom;
        parts.quote.textContent = activeQuotes[quoteIndex % activeQuotes.length];
      }

      const notes = await NS.storage.getNotes();
      parts.textarea.value = notes;

      const s = await NS.storage.getStats();
      if (s && (s.count || s.secondsSaved)) {
        parts.stats.textContent = `${s.count || 0} ads handled · ~${formatSaved(
          s.secondsSaved
        )} saved`;
      }
    }

    function startQuotes(quoteEl) {
      stopQuotes();
      const ms = config.quoteRotateMs || 5000;
      quoteTimer = setInterval(() => {
        quoteIndex = (quoteIndex + 1) % activeQuotes.length;
        quoteEl.textContent = activeQuotes[quoteIndex];
      }, ms);
    }

    function stopQuotes() {
      if (quoteTimer) {
        clearInterval(quoteTimer);
        quoteTimer = null;
      }
    }

    // --- mount / unmount -----------------------------------------------------

    function mount(opts) {
      opts = opts || {};
      if (host) return; // idempotent — already mounted
      const player = getPlayer && getPlayer();
      if (!player) {
        console.warn("[WatchFree] overlay.mount: no player to mount over");
        return;
      }

      host = document.createElement("div");
      host.id = "watchfree-overlay-host";
      // Cover the player; sit above YouTube's own UI.
      host.style.position = "absolute";
      host.style.inset = "0";
      host.style.zIndex = "2147483646";
      host.style.opacity = "0";
      host.style.transition = "opacity " + (config.overlayFadeMs || 200) + "ms ease";

      // The player needs a positioning context for inset:0 to cover it.
      const cs = getComputedStyle(player);
      if (cs.position === "static") {
        player.style.position = "relative";
      }

      shadow = host.attachShadow({ mode: "open" });

      const style = document.createElement("style");
      style.textContent = ""; // filled async once styles.css resolves
      shadow.appendChild(style);

      const parts = buildUI(opts);
      shadow.appendChild(parts.wrap);

      player.appendChild(host);

      loadCss().then((css) => {
        style.textContent = css;
      });

      hydrate(parts);
      startQuotes(parts.quote);

      // Fade in on next frame so the transition actually runs.
      requestAnimationFrame(() => {
        if (host) host.style.opacity = "1";
      });
    }

    function unmount() {
      if (!host) return; // idempotent
      const node = host;
      const fade = config.overlayFadeMs || 200;
      node.style.opacity = "0";
      host = null;
      shadow = null;
      clearTimeout(notesSaveTimer);
      stopQuotes();
      // Remove after the fade completes.
      setTimeout(() => {
        if (node && node.parentNode) node.parentNode.removeChild(node);
      }, fade);
    }

    return { mount, unmount, isMounted: () => !!host };
  };
})();
