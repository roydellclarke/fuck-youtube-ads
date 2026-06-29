// focus.js — Pomodoro focus sessions with distraction hiding.
//
// While a session runs we inject a stylesheet that hides YouTube's attention
// sinks (recommendations sidebar, comments, Shorts shelves, end-screen cards,
// merch) and show a small countdown badge. Completed work blocks accrue focus
// minutes into stats (aggregate + today's bucket) for the dashboard.
//
// The timer is a pure, clock-injected state machine (createFocusTimer) and the
// stats math (applyFocusMinutes) + CSS generation (distractionCss) are pure —
// all unit-tested. createFocus is the thin runtime that owns the DOM badge, the
// 1s ticker, and persistence.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // --- pure helpers ----------------------------------------------------------

  function distractionCss(selectors) {
    if (!Array.isArray(selectors) || !selectors.length) return "";
    return selectors.join(",\n") + " { display: none !important; }\n";
  }

  // Fold a completed work block into stats: minutes + one session + today's
  // bucket. Mutates and returns stats.
  function applyFocusMinutes(stats, dateKey, minutes) {
    stats.focusMinutes = (stats.focusMinutes || 0) + minutes;
    stats.focusSessions = (stats.focusSessions || 0) + 1;
    if (NS.statsUtil) NS.statsUtil.bumpDaily(stats, dateKey, { focusMinutes: minutes });
    return stats;
  }

  // mm:ss from milliseconds.
  function clock(ms) {
    const s = Math.max(0, Math.round(ms / 1000));
    return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  }

  NS.focusUtil = { distractionCss, applyFocusMinutes, clock };

  // --- pure timer (clock injected; every method takes `now` in ms) -----------

  NS.createFocusTimer = function createFocusTimer() {
    let running = false;
    let phase = "idle"; // 'idle' | 'work' | 'break'
    let endsAt = 0;
    let workMs = 0;
    let breakMs = 0;
    let sessions = 0; // completed work blocks
    let pausedRemaining = 0;

    function state() {
      return { running, phase, sessions };
    }

    return {
      start(workMin, breakMin, now) {
        workMs = Math.max(1, workMin) * 60000;
        breakMs = Math.max(1, breakMin) * 60000;
        phase = "work";
        endsAt = now + workMs;
        running = true;
        pausedRemaining = 0;
        return state();
      },
      // Returns { transitioned, phase, completedWorkMin } — completedWorkMin>0
      // exactly when a WORK block just finished (caller persists it).
      tick(now) {
        if (!running || now < endsAt) {
          return { transitioned: false, phase, completedWorkMin: 0 };
        }
        let completedWorkMin = 0;
        if (phase === "work") {
          sessions++;
          completedWorkMin = workMs / 60000;
          phase = "break";
          endsAt = now + breakMs;
        } else {
          phase = "work";
          endsAt = now + workMs;
        }
        return { transitioned: true, phase, completedWorkMin };
      },
      remaining(now) {
        return running ? Math.max(0, endsAt - now) : pausedRemaining;
      },
      pause(now) {
        if (running) {
          pausedRemaining = Math.max(0, endsAt - now);
          running = false;
        }
        return state();
      },
      resume(now) {
        if (!running && phase !== "idle") {
          endsAt = now + pausedRemaining;
          running = true;
          pausedRemaining = 0;
        }
        return state();
      },
      stop() {
        running = false;
        phase = "idle";
        endsAt = 0;
        pausedRemaining = 0;
        return state();
      },
      getState: state,
    };
  };

  // --- runtime (DOM badge + ticker + persistence) ----------------------------

  NS.createFocus = function createFocus(config, deps) {
    deps = deps || {};
    const now = deps.now || (() => Date.now());
    const timer = NS.createFocusTimer();

    let tickId = null;
    let styleEl = null;
    let badgeHost = null;
    let badgeLabel = null;

    function log(...args) {
      if (config.debug) console.log("[WatchFree][Focus]", ...args);
    }

    function applyHiding(on) {
      if (on) {
        if (!styleEl) {
          styleEl = document.createElement("style");
          styleEl.id = "watchfree-focus-style";
          document.documentElement.appendChild(styleEl);
        }
        styleEl.textContent = distractionCss(config.focusHideSelectors || []);
      } else if (styleEl) {
        styleEl.remove();
        styleEl = null;
      }
    }

    function showBadge() {
      if (badgeHost) return;
      badgeHost = document.createElement("div");
      badgeHost.style.position = "fixed";
      badgeHost.style.right = "16px";
      badgeHost.style.bottom = "16px";
      badgeHost.style.zIndex = "2147483647";
      const shadow = badgeHost.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .b { display:flex; align-items:center; gap:10px; background:#15151c;
          border:1px solid #2c2c38; border-radius:999px; padding:8px 12px;
          color:#f1f1f1; font:600 13px system-ui,-apple-system,"Segoe UI",sans-serif;
          box-shadow:0 8px 24px rgba(0,0,0,.5); }
        .dot { width:8px; height:8px; border-radius:50%; background:#5b6cff; }
        .dot.break { background:#4ccf7e; }
        .t { font-variant-numeric: tabular-nums; }
        button { background:transparent; border:none; color:#b6b6c4; cursor:pointer;
          font-size:15px; line-height:1; padding:2px 4px; border-radius:6px; }
        button:hover { background:#2a2a36; color:#fff; }
      `;
      const b = document.createElement("div");
      b.className = "b";
      const dot = document.createElement("span");
      dot.className = "dot";
      badgeLabel = document.createElement("span");
      badgeLabel.className = "t";
      badgeLabel.textContent = "Focus";
      const stop = document.createElement("button");
      stop.type = "button";
      stop.textContent = "✕";
      stop.title = "End focus session";
      stop.addEventListener("click", () => stopSession());
      b.appendChild(dot);
      b.appendChild(badgeLabel);
      b.appendChild(stop);
      shadow.appendChild(style);
      shadow.appendChild(b);
      badgeHost._dot = dot;
      document.documentElement.appendChild(badgeHost);
    }

    function hideBadge() {
      if (badgeHost && badgeHost.parentNode) badgeHost.parentNode.removeChild(badgeHost);
      badgeHost = null;
      badgeLabel = null;
    }

    function renderBadge() {
      if (!badgeHost) return;
      const st = timer.getState();
      const rem = clock(timer.remaining(now()));
      const phaseLabel = st.phase === "break" ? "Break" : "Focus";
      badgeLabel.textContent = `${phaseLabel} ${rem}`;
      if (badgeHost._dot) {
        badgeHost._dot.className = "dot" + (st.phase === "break" ? " break" : "");
      }
    }

    async function persistWork(minutes) {
      try {
        const stats = await NS.storage.getStats();
        const key = NS.statsUtil ? NS.statsUtil.dateKey(new Date()) : "";
        applyFocusMinutes(stats, key, minutes);
        await NS.storage.saveStats(stats);
        log("recorded", minutes, "focus minutes");
      } catch (e) {
        /* best-effort */
      }
    }

    function onTick() {
      const r = timer.tick(now());
      if (r.transitioned && r.completedWorkMin > 0) persistWork(r.completedWorkMin);
      renderBadge();
    }

    function startTicker() {
      stopTicker();
      tickId = setInterval(onTick, 1000);
    }
    function stopTicker() {
      if (tickId) clearInterval(tickId);
      tickId = null;
    }

    function startSession(workMin, breakMin) {
      timer.start(
        workMin || config.focusWorkMin || 25,
        breakMin || config.focusBreakMin || 5,
        now()
      );
      applyHiding(true);
      showBadge();
      renderBadge();
      startTicker();
    }

    function stopSession() {
      timer.stop();
      stopTicker();
      applyHiding(false);
      hideBadge();
    }

    return {
      startSession,
      stopSession,
      isRunning: () => timer.getState().running,
      _timer: timer,
    };
  };
})();
