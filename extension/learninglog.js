// learninglog.js — a timestamped study journal.
//
// A hotkey (Ctrl/⌘+Shift+K) pops a small capture bar over the player; whatever
// you type is saved bound to the current video URL + playback timestamp. The
// dashboard (options page) is the searchable browser with one-click jump-back
// and Markdown export.
//
// The pure pieces (formatTimestamp / jumpUrl / search / exportMarkdown) hold the
// logic and are unit-tested; createLearningLog wires capture to storage and the
// (thin, DOM-only) capture bar.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // --- pure helpers (exported, reused by the dashboard) ----------------------

  // seconds → "m:ss" (or "h:mm:ss" past an hour).
  function formatTimestamp(seconds) {
    const s = Math.max(0, Math.floor(seconds || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
  }

  // A watch URL that resumes at the entry's timestamp.
  function jumpUrl(entry) {
    const t = Math.max(0, Math.floor(entry.t || 0));
    if (entry.videoId) {
      return `https://www.youtube.com/watch?v=${entry.videoId}&t=${t}s`;
    }
    if (entry.url) {
      try {
        const u = new URL(entry.url, "https://www.youtube.com");
        u.searchParams.set("t", t + "s");
        return u.toString();
      } catch (e) {
        /* fall through */
      }
    }
    return entry.url || "";
  }

  // Case-insensitive filter over note + title. Empty query → everything.
  function search(entries, query) {
    if (!Array.isArray(entries)) return [];
    const q = (query || "").trim().toLowerCase();
    if (!q) return entries.slice();
    return entries.filter((e) => {
      const hay = `${e.note || ""} ${e.title || ""}`.toLowerCase();
      return hay.indexOf(q) !== -1;
    });
  }

  // Group by video (first-seen order), sort each group by timestamp, render a
  // Markdown study sheet with clickable timestamp links.
  function exportMarkdown(entries) {
    if (!Array.isArray(entries) || !entries.length) {
      return "# WatchFree Learning Log\n\n_No entries yet._\n";
    }
    const groups = [];
    const byVideo = new Map();
    for (const e of entries) {
      const key = e.videoId || e.url || e.title || "unknown";
      if (!byVideo.has(key)) {
        const g = { key, title: e.title || e.videoId || "Untitled", items: [] };
        byVideo.set(key, g);
        groups.push(g);
      }
      byVideo.get(key).items.push(e);
    }
    let out = "# WatchFree Learning Log\n";
    for (const g of groups) {
      g.items.sort((a, b) => (a.t || 0) - (b.t || 0));
      out += `\n## ${g.title}\n\n`;
      for (const e of g.items) {
        const note = (e.note || "").replace(/\s+/g, " ").trim();
        out += `- [${formatTimestamp(e.t)}](${jumpUrl(e)}) — ${note}\n`;
      }
    }
    return out;
  }

  const logUtil = { formatTimestamp, jumpUrl, search, exportMarkdown };
  NS.logUtil = logUtil;

  // --- runtime ---------------------------------------------------------------

  // createLearningLog(config, getVideo, deps)
  //   deps.getMeta()   — () => { videoId, title, url } for the current page
  //                      (injectable for tests). Defaults to reading the DOM.
  //   deps.now()/id()  — injectable timestamp / id factories (for tests).
  NS.createLearningLog = function createLearningLog(config, getVideo, deps) {
    deps = deps || {};
    const nowMs = deps.now || (() => new Date().toISOString());
    const makeId =
      deps.id ||
      (() =>
        typeof crypto !== "undefined" && crypto.randomUUID
          ? crypto.randomUUID()
          : "wf_" + Math.abs(hashStr(nowMs() + ":" + Math.floor(performance.now()))));

    function hashStr(s) {
      let h = 0;
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
      return h;
    }

    function defaultMeta() {
      const url = location.href;
      const videoId =
        (NS.sponsorBlockUtil && NS.sponsorBlockUtil.videoIdFromUrl(url)) || null;
      const title = (document.title || "").replace(/\s*-\s*YouTube\s*$/, "").trim();
      return { videoId, title, url };
    }
    const getMeta = deps.getMeta || defaultMeta;

    function currentTimestamp() {
      const v = getVideo && getVideo();
      return v && isFinite(v.currentTime) ? v.currentTime : 0;
    }

    // Build + persist an entry from the current video + time. Returns it.
    async function capture(note) {
      const text = (note || "").trim();
      if (!text) return null;
      const meta = getMeta() || {};
      const entry = {
        id: makeId(),
        videoId: meta.videoId || null,
        title: meta.title || "",
        url: meta.url || location.href,
        t: currentTimestamp(),
        note: text,
        createdAt: nowMs(),
      };
      await NS.storage.addLogEntry(entry);
      return entry;
    }

    // --- capture bar (Shadow DOM; thin DOM shell over the logic above) -------
    let host = null;

    function closeBar() {
      if (host && host.parentNode) host.parentNode.removeChild(host);
      host = null;
    }

    function promptCapture() {
      if (host) return; // already open
      host = document.createElement("div");
      host.style.position = "fixed";
      host.style.left = "0";
      host.style.right = "0";
      host.style.top = "16px";
      host.style.zIndex = "2147483647";
      host.style.display = "flex";
      host.style.justifyContent = "center";
      host.style.pointerEvents = "none";

      const shadow = host.attachShadow({ mode: "open" });
      const style = document.createElement("style");
      style.textContent = `
        .bar { pointer-events: auto; display: flex; gap: 8px; align-items: center;
          background: #15151c; border: 1px solid #2c2c38; border-radius: 10px;
          padding: 8px 10px; box-shadow: 0 8px 24px rgba(0,0,0,.5);
          font-family: system-ui, -apple-system, "Segoe UI", sans-serif; }
        .ts { color: #7d8cff; font-size: 12px; font-weight: 600; white-space: nowrap; }
        input { width: min(60vw, 520px); background: #0f0f15; border: 1px solid #313140;
          border-radius: 8px; color: #f1f1f1; padding: 8px 10px; font-size: 14px; outline: none; }
        input:focus { border-color: #5b6cff; }
        .hint { color: #6f6f7e; font-size: 11px; white-space: nowrap; }
      `;
      const bar = document.createElement("div");
      bar.className = "bar";
      const ts = document.createElement("span");
      ts.className = "ts";
      ts.textContent = "📝 " + formatTimestamp(currentTimestamp());
      const input = document.createElement("input");
      input.type = "text";
      input.placeholder = "Capture a note at this timestamp…";
      const hint = document.createElement("span");
      hint.className = "hint";
      hint.textContent = "Enter to save · Esc to cancel";

      input.addEventListener("keydown", async (e) => {
        e.stopPropagation();
        if (e.key === "Enter") {
          const val = input.value;
          closeBar();
          const saved = await capture(val);
          if (saved) toast("Saved to learning log ✓");
        } else if (e.key === "Escape") {
          closeBar();
        }
      });

      bar.appendChild(ts);
      bar.appendChild(input);
      bar.appendChild(hint);
      shadow.appendChild(style);
      shadow.appendChild(bar);
      document.documentElement.appendChild(host);
      input.focus();
    }

    function toast(message) {
      const t = document.createElement("div");
      const sh = t.attachShadow({ mode: "open" });
      sh.innerHTML = `<div style="position:fixed;left:50%;top:64px;transform:translateX(-50%);
        z-index:2147483647;background:#1d2a1f;color:#8ef0a8;border:1px solid #2f5a3a;
        border-radius:8px;padding:8px 14px;font:600 13px system-ui;box-shadow:0 8px 24px rgba(0,0,0,.5)">
        ${message}</div>`;
      document.documentElement.appendChild(t);
      setTimeout(() => t.parentNode && t.parentNode.removeChild(t), 1600);
    }

    return { capture, promptCapture, closeBar };
  };
})();
