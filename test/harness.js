// Node test harness for WatchFree core logic (sensor + controller + actuators).
// Mocks chrome, document, MutationObserver; loads the REAL IIFE files.
const fs = require("fs");
const path = require("path");

const EXT = path.join(__dirname, "..", "extension");

// ---- globals the content scripts expect -----------------------------------
global.window = {};
global.crypto = require("crypto").webcrypto;
global.performance = { now: () => Date.now() };

// chrome.storage mock: separate sync + local areas.
function makeArea() {
  const store = {};
  return {
    _store: store,
    async get(def) {
      const out = {};
      for (const k in def) out[k] = k in store ? store[k] : def[k];
      return out;
    },
    async set(obj) {
      Object.assign(store, obj);
    },
  };
}
global.chrome = {
  storage: { sync: makeArea(), local: makeArea() },
  runtime: { getURL: (p) => p },
};

// MutationObserver mock: fireMutations() invokes every live observer's callback.
const observers = new Set();
global.MutationObserver = class {
  constructor(cb) {
    this.cb = cb;
  }
  observe() {
    observers.add(this);
  }
  disconnect() {
    observers.delete(this);
  }
};
function fireMutations() {
  for (const o of observers) o.cb();
}

// ---- mutable scenario refs (document.querySelector reads these) -----------
let player = null;
let skipPresent = false;
let skipClicks = 0;
const skipBtn = {
  click() {
    skipClicks++;
    skipPresent = false;
    // Simulate YouTube ending the ad once Skip is clicked.
    if (player) player.classList.remove("ad-showing");
  },
};

global.document = {
  querySelector(sel) {
    if (sel === "#movie_player") return player;
    if (sel.includes("skip")) return skipPresent ? skipBtn : null;
    return null;
  },
};

// ---- load the real modules -------------------------------------------------
for (const f of [
  "storage.js",
  "statsutil.js",
  "sensor.js",
  "actuators.js",
  "controller.js",
  "sponsorblock.js",
]) {
  const code = fs.readFileSync(path.join(EXT, f), "utf8");
  eval(code); // IIFEs attach to global.window.WatchFree
}
const NS = window.WatchFree;

// ---- helpers ---------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0,
  fail = 0;
function ok(name, cond) {
  if (cond) {
    pass++;
    console.log("  \x1b[32m✓\x1b[0m " + name);
  } else {
    fail++;
    console.log("  \x1b[31m✗ " + name + "\x1b[0m");
  }
}

function makeClassList() {
  const set = new Set();
  return {
    _set: set,
    add(c) {
      set.add(c);
      fireMutations();
    },
    remove(c) {
      set.delete(c);
      fireMutations();
    },
    contains(c) {
      return set.has(c);
    },
  };
}

const CONFIG = {
  adPlaybackRate: 16,
  muteDuringAd: true,
  overlayEnabled: true,
  pollIntervalMs: 40,
  debounceMs: 5,
  skipRetryMs: 15,
  overlayFadeMs: 0,
  skipSelectors: [
    ".ytp-skip-ad-button",
    ".ytp-ad-skip-button-modern",
    ".ytp-ad-skip-button",
  ],
};

let current = null;
function setup(video) {
  if (current) current.sensor.detach();
  observers.clear();
  skipClicks = 0;
  skipPresent = false;
  player = {
    classList: makeClassList(),
    querySelector: (s) => (s === "video" ? video : null),
    // YouTube player API surface used by actuators for mute.
    isMuted: () => video.muted,
    mute: () => {
      video.muted = true;
    },
    unMute: () => {
      video.muted = false;
    },
  };
  const overlay = {
    _m: false,
    mount() {
      this._m = true;
    },
    unmount() {
      this._m = false;
    },
    isMounted() {
      return this._m;
    },
  };
  const actuators = NS.createActuators(CONFIG, () => video, () => player, overlay);
  const controller = NS.createController(CONFIG, actuators);
  const sensor = NS.createSensor(CONFIG, {
    onAdStart: () => controller.handleAdStart(),
    onAdEnd: () => controller.handleAdEnd(),
  });
  sensor.attach(player);
  current = { video, overlay, actuators, controller, sensor };
  return current;
}

// ---------------------------------------------------------------------------
(async () => {
  // A. Unskippable ad: capture custom prior state, suppress, restore EXACTLY.
  console.log("\nA. Unskippable ad — suppress + exact restore");
  {
    const video = { muted: false, playbackRate: 1.5 }; // user was at 1.5x
    const { controller, video: v, overlay } = setup(video);
    player.classList.add("ad-showing");
    await sleep(60);
    ok("state AD_ACTIVE", controller.getState() === "AD_ACTIVE");
    ok("muted during ad", v.muted === true);
    ok("playbackRate cranked to 16", v.playbackRate === 16);
    ok("overlay mounted", overlay.isMounted());
    player.classList.remove("ad-showing");
    await sleep(60);
    ok("state back to IDLE", controller.getState() === "IDLE");
    ok("muted restored to false", v.muted === false);
    ok("playbackRate restored to exact 1.5", v.playbackRate === 1.5);
    ok("overlay unmounted", !overlay.isMounted());
  }

  // B. Skippable ad: Skip button clicked, which ends the ad.
  console.log("\nB. Skippable ad — Skip clicked");
  {
    const video = { muted: false, playbackRate: 1 };
    const { controller, overlay } = setup(video);
    skipPresent = true;
    player.classList.add("ad-showing");
    await sleep(60);
    ok("skip clicked at least once", skipClicks >= 1);
    ok("ad ended after skip → IDLE", controller.getState() === "IDLE");
    ok("overlay unmounted after skip", !overlay.isMounted());
  }

  // C. Plant context: user already muted → must stay muted after ad.
  console.log("\nC. Already-muted user — restore preserves mute");
  {
    const video = { muted: true, playbackRate: 1 };
    const { controller, video: v } = setup(video);
    player.classList.add("ad-showing");
    await sleep(60);
    ok("still muted during ad", v.muted === true);
    player.classList.remove("ad-showing");
    await sleep(60);
    ok("restored mute=true (not clobbered)", v.muted === true);
    ok("rate restored to 1", v.playbackRate === 1);
  }

  // D. SPA reset mid-ad: cleanup without stranding the video sped/muted.
  console.log("\nD. reset() mid-ad — no stale state stranded");
  {
    const video = { muted: false, playbackRate: 1 };
    const { controller, video: v, overlay } = setup(video);
    player.classList.add("ad-showing");
    await sleep(60);
    ok("engaged (rate 16)", v.playbackRate === 16 && overlay.isMounted());
    controller.reset();
    await sleep(10);
    ok("overlay unmounted on reset", !overlay.isMounted());
    ok("rate restored (not stuck at 16)", v.playbackRate === 1);
    ok("unmuted after reset", v.muted === false);
    ok("state IDLE after reset", controller.getState() === "IDLE");
  }

  // E. Debounce: flip on then off within debounce window → no spurious engage.
  console.log("\nE. Debounce — rapid flip does not engage");
  {
    const video = { muted: false, playbackRate: 1 };
    const { controller, overlay } = setup(video);
    player.classList.add("ad-showing");
    player.classList.remove("ad-showing"); // within debounceMs
    await sleep(60);
    ok("stayed IDLE", controller.getState() === "IDLE");
    ok("overlay never mounted", !overlay.isMounted());
    ok("rate untouched", video.playbackRate === 1);
  }

  // F. Poll-only fallback: simulate a MISSED mutation (bypass fireMutations).
  console.log("\nF. Poll fallback — engages even if MutationObserver misses");
  {
    const video = { muted: false, playbackRate: 1 };
    const { controller } = setup(video);
    player.classList._set.add("ad-showing"); // no fireMutations -> observer blind
    await sleep(80); // > pollIntervalMs + debounce
    ok("poll detected ad → AD_ACTIVE", controller.getState() === "AD_ACTIVE");
    player.classList._set.delete("ad-showing");
    await sleep(80);
    ok("poll detected ad end → IDLE", controller.getState() === "IDLE");
  }

  // G. overlayEnabled=false: still mutes/skips, but no overlay.
  console.log("\nG. overlayEnabled=false — suppress without overlay");
  {
    const prev = CONFIG.overlayEnabled;
    CONFIG.overlayEnabled = false;
    const video = { muted: false, playbackRate: 1 };
    const { video: v, overlay } = setup(video);
    player.classList.add("ad-showing");
    await sleep(60);
    ok("muted during ad", v.muted === true);
    ok("overlay NOT mounted", !overlay.isMounted());
    player.classList.remove("ad-showing");
    await sleep(60);
    ok("unmuted after ad", v.muted === false);
    CONFIG.overlayEnabled = prev;
  }

  // H. Stats: each completed ad increments the count.
  console.log("\nH. Stats — ads handled counted");
  {
    const before = (await NS.storage.getStats()).count || 0;
    const video = { muted: false, playbackRate: 1 };
    setup(video);
    player.classList.add("ad-showing");
    await sleep(60);
    player.classList.remove("ad-showing");
    await sleep(60);
    const after = await NS.storage.getStats();
    ok("count incremented", (after.count || 0) === before + 1);
    ok("secondsSaved is a number ≥ 0", typeof after.secondsSaved === "number" && after.secondsSaved >= 0);
  }

  // I. storage.js roundtrip (sync for todos/notes/quotes, local for stats).
  console.log("\nI. storage.js roundtrip");
  {
    await NS.storage.saveTodos([{ id: "1", text: "x", done: false }]);
    const t = await NS.storage.getTodos();
    ok("todos persist + read back (sync)", t.length === 1 && t[0].text === "x");
    await NS.storage.saveNotes("hello");
    ok("notes persist + read back (sync)", (await NS.storage.getNotes()) === "hello");
    await NS.storage.saveQuotes(["a", "b"]);
    ok("quotes persist + read back (sync)", (await NS.storage.getQuotes()).length === 2);
    ok("defaults when empty", Array.isArray(await NS.storage.getTodos()));
  }

  // J. statsutil — daily buckets, series, streaks (pure date math).
  console.log("\nJ. statsutil — daily buckets / series / streak");
  {
    const U = NS.statsUtil;
    ok("dateKey is local YYYY-MM-DD", U.dateKey(new Date(2026, 5, 29)) === "2026-06-29");

    const st = {};
    U.bumpDaily(st, "2026-06-29", { adCount: 1, adSeconds: 30 });
    U.bumpDaily(st, "2026-06-29", { adCount: 2, sponsorSeconds: 10 });
    ok("bumpDaily accumulates same key", st.daily["2026-06-29"].adCount === 3);
    ok("bumpDaily keeps independent counters", st.daily["2026-06-29"].adSeconds === 30 && st.daily["2026-06-29"].sponsorSeconds === 10);

    const keys = U.lastNDays(new Date(2026, 5, 29), 3);
    ok("lastNDays length + ordering", keys.length === 3 && keys[2] === "2026-06-29" && keys[0] === "2026-06-27");
    const series = U.buildDailySeries(st, keys);
    ok("buildDailySeries fills zeros", series[0].adCount === 0 && series[2].adCount === 3);

    // streak: today + yesterday active, gap before → streak 2.
    const sk = { daily: {} };
    U.bumpDaily(sk, "2026-06-29", { adCount: 1 });
    U.bumpDaily(sk, "2026-06-28", { focusMinutes: 25 });
    ok("streak counts consecutive active days", U.computeStreak(sk, new Date(2026, 5, 29)) === 2);
    // grace: today inactive but yesterday active → still counts.
    ok("streak grace when today idle", U.computeStreak(sk, new Date(2026, 5, 30)) === 2);
    // broken: two idle days → 0.
    ok("streak breaks after a gap", U.computeStreak(sk, new Date(2026, 6, 2)) === 0);
  }

  // K. SponsorBlock — pure helpers + runtime auto-skip.
  console.log("\nK. SponsorBlock — parse + auto-skip in-video segments");
  {
    const SB = NS.sponsorBlockUtil;
    ok("videoIdFromUrl: watch?v=", SB.videoIdFromUrl("https://www.youtube.com/watch?v=abc123&t=5s") === "abc123");
    ok("videoIdFromUrl: youtu.be", SB.videoIdFromUrl("https://youtu.be/xyz789") === "xyz789");
    ok("videoIdFromUrl: shorts", SB.videoIdFromUrl("https://www.youtube.com/shorts/short01") === "short01");
    ok("videoIdFromUrl: none", SB.videoIdFromUrl("https://www.youtube.com/feed/subscriptions") === null);

    const api = [
      { videoID: "abc123", segments: [
        { segment: [60, 90], category: "sponsor", actionType: "skip", UUID: "u1" },
        { segment: [4, 10], category: "intro", actionType: "skip", UUID: "u2" },
        { segment: [12, 12.4], category: "sponsor", actionType: "skip", UUID: "u3" }, // too short
        { segment: [20, 25], category: "music_offtopic", actionType: "skip", UUID: "u4" }, // wrong cat
        { segment: [30, 40], category: "sponsor", actionType: "full", UUID: "u5" }, // not a skip
      ] },
      { videoID: "other", segments: [{ segment: [0, 5], category: "sponsor", actionType: "skip", UUID: "x" }] },
    ];
    const segs = SB.normalizeSegments(api, "abc123", { categories: ["sponsor", "intro"], minSeconds: 1 });
    ok("normalize filters cat/len/actionType/videoID", segs.length === 2);
    ok("normalize sorts by start", segs[0].start === 4 && segs[1].start === 60);

    const skipped = new Set();
    ok("pickSkip outside → null", SB.pickSkip(segs, 50, skipped) === null);
    const hit = SB.pickSkip(segs, 5, skipped);
    ok("pickSkip inside → segment", hit && hit.end === 10);
    skipped.add(hit.uuid);
    ok("pickSkip respects skipped set", SB.pickSkip(segs, 5, skipped) === null);

    // Runtime: fake <video> with timeupdate listeners + injected fetch/hash.
    const v = {
      currentTime: 0,
      _l: {},
      addEventListener(ev, fn) { this._l[ev] = fn; },
      removeEventListener(ev, fn) { if (this._l[ev] === fn) delete this._l[ev]; },
      fire() { if (this._l.timeupdate) this._l.timeupdate(); },
    };
    const sbConfig = {
      sponsorBlockEnabled: true,
      sponsorBlockCategories: ["sponsor", "intro"],
      sponsorBlockMinSeconds: 1,
    };
    const sb = NS.createSponsorBlock(sbConfig, () => v, {
      fetchJson: async () => api,
      sha256Hex: async () => "abcd0000",
    });
    const beforeSponsor = (await NS.storage.getStats()).sponsorCount || 0;
    await sb.load("https://www.youtube.com/watch?v=abc123");
    ok("runtime loaded our 2 segments", sb._getSegments().length === 2);
    v.currentTime = 5;
    v.fire();
    ok("auto-skipped to segment end", v.currentTime === 10);
    v.currentTime = 10;
    v.fire();
    ok("does not re-skip same segment", v.currentTime === 10);
    await sleep(5);
    const afterSponsor = (await NS.storage.getStats()).sponsorCount || 0;
    ok("sponsor skip recorded in stats", afterSponsor === beforeSponsor + 1);

    sb.clear();
    ok("clear removes timeupdate listener", !v._l.timeupdate);

    // Disabled → no load.
    const sb2 = NS.createSponsorBlock({ sponsorBlockEnabled: false }, () => v, {
      fetchJson: async () => api,
      sha256Hex: async () => "abcd0000",
    });
    await sb2.load("https://www.youtube.com/watch?v=abc123");
    ok("disabled SponsorBlock loads nothing", sb2._getSegments().length === 0);
  }

  // L. getStats merges the full default shape over old/empty blobs.
  console.log("\nL. getStats — full shape with defaults");
  {
    const s = await NS.storage.getStats();
    ok("has sponsor + focus + daily fields", "sponsorCount" in s && "focusMinutes" in s && typeof s.daily === "object");
  }

  if (current) current.sensor.detach();
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
