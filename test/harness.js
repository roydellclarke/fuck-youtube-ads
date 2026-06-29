// Node test harness for blockYT core logic (sensor + controller + actuators).
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
for (const f of ["storage.js", "sensor.js", "actuators.js", "controller.js"]) {
  const code = fs.readFileSync(path.join(EXT, f), "utf8");
  eval(code); // IIFEs attach to global.window.BlockYT
}
const NS = window.BlockYT;

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

  if (current) current.sensor.detach();
  console.log(`\n\x1b[1m${pass} passed, ${fail} failed\x1b[0m`);
  process.exit(fail ? 1 : 0);
})();
