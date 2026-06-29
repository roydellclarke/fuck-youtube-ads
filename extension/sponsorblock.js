// sponsorblock.js — skip in-video sponsor segments using the community
// SponsorBlock database. This is orthogonal to YouTube's own ads (handled by
// sensor/actuators): it removes creator-read sponsorships, intros, outros,
// self-promo, etc., which ad-blocking can't touch.
//
// Privacy: we never send the exact video ID. We SHA-256 the ID and send only a
// 4-char hash prefix to /api/skipSegments/<prefix>; the server returns segments
// for every video sharing that prefix and we filter locally for ours. (Same
// scheme the official client and FreeTube use.)
//
// The pure pieces (videoIdFromUrl / normalizeSegments / pickSkip) carry the
// logic and are unit-tested; the runtime attaches a throttled `timeupdate`
// listener that seeks past a segment the instant playback enters it.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // --- pure helpers (exported for tests + reuse) -----------------------------

  // Extract a YouTube video ID from any of the URL shapes YouTube uses.
  function videoIdFromUrl(url) {
    if (!url) return null;
    try {
      const u = new URL(url, "https://www.youtube.com");
      if (u.searchParams.get("v")) return u.searchParams.get("v");
      if (u.hostname === "youtu.be") {
        return u.pathname.slice(1).split("/")[0] || null;
      }
      const m = u.pathname.match(/^\/(?:shorts|embed|live)\/([^/]+)/);
      if (m) return m[1];
      return null;
    } catch (e) {
      return null;
    }
  }

  // Turn the hash-prefix API response into clean, sorted segments for OUR video.
  // Response: [{ videoID, hash, segments:[{ segment:[start,end], category,
  // actionType, UUID }] }]. We keep only skip-type segments in enabled
  // categories that are long enough to be worth a seek.
  function normalizeSegments(apiResults, videoId, opts) {
    opts = opts || {};
    const cats = opts.categories || null; // null = accept all
    const minSeconds = opts.minSeconds || 0;
    if (!Array.isArray(apiResults)) return [];
    const out = [];
    for (const result of apiResults) {
      if (!result || result.videoID !== videoId || !Array.isArray(result.segments)) {
        continue;
      }
      for (const s of result.segments) {
        const seg = s && s.segment;
        if (!Array.isArray(seg) || seg.length < 2) continue;
        const start = Number(seg[0]);
        const end = Number(seg[1]);
        if (!isFinite(start) || !isFinite(end) || end - start < minSeconds) continue;
        if (s.actionType && s.actionType !== "skip") continue;
        if (cats && cats.indexOf(s.category) === -1) continue;
        out.push({ start, end, category: s.category, uuid: s.UUID });
      }
    }
    out.sort((a, b) => a.start - b.start);
    return out;
  }

  // Decide whether playback at `currentTime` is inside a not-yet-skipped
  // segment. Returns that segment (caller seeks to .end), or null. `skipped` is
  // a Set of UUIDs already auto-skipped this load, so re-watching a segment the
  // user deliberately scrubbed back into is NOT fought.
  function pickSkip(segments, currentTime, skipped) {
    if (!Array.isArray(segments)) return null;
    for (const seg of segments) {
      if (skipped && skipped.has(seg.uuid)) continue;
      // A small lead-in tolerance avoids missing a segment we land just inside.
      if (currentTime >= seg.start - 0.3 && currentTime < seg.end - 0.2) {
        return seg;
      }
    }
    return null;
  }

  // SHA-256 hex of a string via WebCrypto (available in content scripts and in
  // the Node test harness via webcrypto).
  async function sha256Hex(str) {
    const data = new TextEncoder().encode(str);
    const buf = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(buf))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
  }

  // --- runtime ---------------------------------------------------------------

  // createSponsorBlock(config, getVideo, deps)
  //   deps.fetchJson(url) — injectable for tests; defaults to fetch→json.
  //   deps.sha256Hex(str) — injectable for tests; defaults to WebCrypto.
  NS.createSponsorBlock = function createSponsorBlock(config, getVideo, deps) {
    deps = deps || {};
    const fetchJson =
      deps.fetchJson ||
      (async (url) => {
        const res = await fetch(url);
        if (!res.ok) throw new Error("SponsorBlock HTTP " + res.status);
        return res.json();
      });
    const hash = deps.sha256Hex || sha256Hex;

    let segments = [];
    let skipped = new Set();
    let currentVideoId = null;
    let video = null;
    let onTimeUpdate = null;
    let loadToken = 0; // guards against a stale fetch resolving after nav

    function log(...args) {
      if (config.debug) console.log("[WatchFree][SB]", ...args);
    }

    async function fetchSegments(videoId) {
      const prefix = (await hash(videoId)).slice(0, 4);
      const base = config.sponsorBlockApiBase || "https://sponsor.ajay.app/api/";
      const cats = config.sponsorBlockCategories || [];
      const url =
        base +
        "skipSegments/" +
        prefix +
        "?categories=" +
        encodeURIComponent(JSON.stringify(cats));
      const data = await fetchJson(url);
      return normalizeSegments(data, videoId, {
        categories: cats.length ? cats : null,
        minSeconds: config.sponsorBlockMinSeconds || 1,
      });
    }

    // Record a skip in stats (aggregate + today's bucket).
    async function recordSkip(seg) {
      try {
        const seconds = Math.max(0, seg.end - seg.start);
        const stats = await NS.storage.getStats();
        stats.sponsorCount = (stats.sponsorCount || 0) + 1;
        stats.sponsorSecondsSaved = (stats.sponsorSecondsSaved || 0) + seconds;
        if (NS.statsUtil) {
          NS.statsUtil.bumpDaily(stats, NS.statsUtil.dateKey(new Date()), {
            sponsorCount: 1,
            sponsorSeconds: seconds,
          });
        }
        await NS.storage.saveStats(stats);
      } catch (e) {
        /* best-effort */
      }
    }

    function detachListener() {
      if (video && onTimeUpdate) {
        video.removeEventListener("timeupdate", onTimeUpdate);
      }
      onTimeUpdate = null;
    }

    function attachListener() {
      detachListener();
      video = getVideo();
      if (!video) return;
      onTimeUpdate = () => {
        if (!segments.length) return;
        const seg = pickSkip(segments, video.currentTime, skipped);
        if (seg) {
          skipped.add(seg.uuid);
          try {
            video.currentTime = seg.end;
          } catch (e) {
            /* ignore */
          }
          log("skipped", seg.category, seg.start, "→", seg.end);
          recordSkip(seg);
        }
      };
      video.addEventListener("timeupdate", onTimeUpdate);
    }

    // Load segments for the video at `url`. Idempotent per video id.
    async function load(url) {
      if (!config.sponsorBlockEnabled) return;
      const videoId = videoIdFromUrl(url);
      if (!videoId) {
        clear();
        return;
      }
      if (videoId === currentVideoId && segments.length) {
        attachListener(); // re-bind in case the <video> was replaced
        return;
      }
      currentVideoId = videoId;
      segments = [];
      skipped = new Set();
      const token = ++loadToken;
      try {
        const segs = await fetchSegments(videoId);
        if (token !== loadToken) return; // navigated away mid-fetch
        segments = segs;
        log("loaded", segments.length, "segments for", videoId);
        attachListener();
      } catch (e) {
        if (token === loadToken) log("fetch failed:", e && e.message);
      }
    }

    function clear() {
      loadToken++; // invalidate any in-flight fetch
      detachListener();
      segments = [];
      skipped = new Set();
      currentVideoId = null;
      video = null;
    }

    return {
      load,
      clear,
      // exposed for tests / introspection:
      _getSegments: () => segments,
    };
  };

  // Pure helpers on the namespace for reuse + tests.
  NS.sponsorBlockUtil = { videoIdFromUrl, normalizeSegments, pickSkip, sha256Hex };
})();
