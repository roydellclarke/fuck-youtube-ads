// content.js — bootstrap. Wires Sensor → Controller → Actuators (plain in-page
// function calls; no message bus) and owns SPA-navigation re-initialization,
// settings, and the on-demand panel toggle.
//
// The entire critical loop (detect → skip/mute/speed → overlay) lives here in
// the tab. The MV3 service worker only relays the keyboard command.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // --- Goal config -----------------------------------------------------------
  // Target state: zero ad exposure, overlay shown during ads. The subset of
  // keys in SETTING_KEYS is user-overridable from the popup; the rest are
  // internal tuning knobs.
  const CONFIG = {
    // user-facing settings (overridable via popup → chrome.storage.sync):
    enabled: true, // master on/off
    muteDuringAd: true,
    adPlaybackRate: 16, // speed to burn through unskippable ads
    overlayEnabled: true, // show the overlay during ads
    dismissNuisances: true, // close banner ads + "continue watching" dialog
    sponsorBlockEnabled: true, // skip in-video sponsor segments (SponsorBlock)
    sponsorBlockCategories: [
      "sponsor",
      "selfpromo",
      "interaction",
      "intro",
      "outro",
      "music_offtopic",
    ],
    debug: false, // log capture/restore to the console

    // internal tuning:
    sponsorBlockApiBase: "https://sponsor.ajay.app/api/",
    sponsorBlockMinSeconds: 1, // ignore sub-second segments (not worth a seek)
    pollIntervalMs: 300, // sensor poll (redundant with MutationObserver)
    debounceMs: 50, // ad-showing flip debounce
    skipRetryMs: 250, // how often to retry Skip + seek-to-end during an ad
    adEndEpsilon: 0.15, // seconds short of duration to seek unskippable ads to
    nuisancePollMs: 1000, // how often to scan for banner ads / dialogs
    overlayFadeMs: 200,
    quoteRotateMs: 5000, // how often the motivational quote rotates
    // Skip-button selectors, tried in order. (YouTube renames these over time.)
    skipSelectors: [
      ".ytp-skip-ad-button",
      ".ytp-ad-skip-button-modern",
      ".ytp-ad-skip-button",
    ],
    // Banner/overlay ad close buttons.
    nuisanceSelectors: [
      ".ytp-ad-overlay-close-button",
      ".ytp-ad-overlay-close-container button",
    ],
    // "Video paused. Continue watching?" confirm button.
    // TODO: YouTube changes this dialog's markup periodically; verify on live
    // YouTube and add new variants here if auto-continue stops working.
    continueDialogSelectors: [
      "yt-confirm-dialog-renderer #confirm-button",
      "tp-yt-paper-dialog #confirm-button",
    ],
  };
  NS.CONFIG = CONFIG;

  // Keys the popup is allowed to override.
  const SETTING_KEYS = [
    "enabled",
    "muteDuringAd",
    "adPlaybackRate",
    "overlayEnabled",
    "dismissNuisances",
    "sponsorBlockEnabled",
    "sponsorBlockCategories",
    "debug",
  ];

  // --- live element accessors (re-queried; YouTube reuses nodes across nav) ---
  function getPlayer() {
    return document.querySelector("#movie_player");
  }
  function getVideo() {
    const p = getPlayer();
    return (p && p.querySelector("video")) || document.querySelector("video");
  }

  // --- singletons ------------------------------------------------------------
  let overlay = null;
  let actuators = null;
  let controller = null;
  let sensor = null;
  let sponsorBlock = null;
  let learningLog = null;
  let attached = false;

  function ensureWiring() {
    if (!overlay) overlay = NS.createOverlay(CONFIG, getPlayer);
    if (!actuators)
      actuators = NS.createActuators(CONFIG, getVideo, getPlayer, overlay);
    if (!controller) controller = NS.createController(CONFIG, actuators);
    if (!sensor) {
      sensor = NS.createSensor(CONFIG, {
        onAdStart: () => controller.handleAdStart(),
        onAdEnd: () => controller.handleAdEnd(),
      });
    }
    if (!sponsorBlock) sponsorBlock = NS.createSponsorBlock(CONFIG, getVideo);
    if (!learningLog) learningLog = NS.createLearningLog(CONFIG, getVideo);
  }

  // SponsorBlock follows the master toggle AND its own toggle. Re-load segments
  // for the current video, or tear down if disabled.
  function applySponsorBlock() {
    if (!sponsorBlock) return;
    if (CONFIG.enabled && CONFIG.sponsorBlockEnabled) sponsorBlock.load(location.href);
    else sponsorBlock.clear();
  }

  // Wait for #movie_player to exist. Resolves with the element, or null after
  // timeout.
  function waitForPlayer(timeoutMs = 15000) {
    return new Promise((resolve) => {
      const existing = getPlayer();
      if (existing) return resolve(existing);
      const start = performance.now();
      const id = setInterval(() => {
        const p = getPlayer();
        if (p) {
          clearInterval(id);
          resolve(p);
        } else if (performance.now() - start > timeoutMs) {
          clearInterval(id);
          resolve(null);
        }
      }, 200);
    });
  }

  async function attachToCurrentPlayer() {
    ensureWiring();
    if (!CONFIG.enabled) return; // disabled → stay detached
    const player = await waitForPlayer();
    if (!player) {
      console.warn("[WatchFree] no #movie_player found; sensor not attached");
      return;
    }
    sensor.attach(player); // attach() detaches any prior binding first
    attached = true;
    applyNuisanceWatch();
    applySponsorBlock();
  }

  function applyNuisanceWatch() {
    if (!actuators) return;
    if (CONFIG.enabled && CONFIG.dismissNuisances) actuators.startNuisanceWatch();
    else actuators.stopNuisanceWatch();
  }

  // Re-initialize on navigation: abandon any in-flight ad context cleanly, then
  // re-acquire the player and re-attach the sensor.
  async function reInit() {
    if (controller) controller.reset();
    if (sensor) sensor.detach();
    if (sponsorBlock) sponsorBlock.clear(); // segments are per-video
    attached = false;
    await attachToCurrentPlayer();
  }

  // Apply the master enable toggle: attach when enabled, tear down when off.
  function applyEnabled() {
    if (CONFIG.enabled) {
      if (!attached) attachToCurrentPlayer();
      else applyNuisanceWatch();
    } else {
      if (controller) controller.reset();
      if (sensor) sensor.detach();
      if (actuators) actuators.stopNuisanceWatch();
      if (sponsorBlock) sponsorBlock.clear();
      attached = false;
    }
  }

  // --- settings --------------------------------------------------------------
  async function loadSettings() {
    const stored = await NS.storage.getSettings();
    for (const k of SETTING_KEYS) {
      if (stored && Object.prototype.hasOwnProperty.call(stored, k)) {
        CONFIG[k] = stored[k];
      }
    }
  }

  // Live-apply when the popup changes settings (no tab reload needed).
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "sync") return;
    const change = changes[NS.storage.KEYS.settings];
    if (!change) return;
    const next = change.newValue || {};
    for (const k of SETTING_KEYS) {
      if (Object.prototype.hasOwnProperty.call(next, k)) CONFIG[k] = next[k];
    }
    applyEnabled();
    applySponsorBlock(); // pick up SponsorBlock enable/category changes live
  });

  // --- on-demand panel (keyboard command via background, or popup button) ----
  function togglePanel() {
    if (!overlay) return;
    if (overlay.isMounted()) overlay.unmount();
    else overlay.mount({ closable: true });
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (!msg) return;
    if (msg.type === "watchfree-toggle-panel") togglePanel();
    else if (msg.type === "watchfree-capture-note" && learningLog) {
      learningLog.promptCapture();
    }
  });

  // --- SPA navigation handling ----------------------------------------------
  // Primary: YouTube fires 'yt-navigate-finish' after client-side navigations.
  window.addEventListener("yt-navigate-finish", () => {
    reInit();
  });

  // Redundancy (turbulence): a lightweight URL watcher in case the event is
  // missed or the page was loaded in a state where it doesn't fire.
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      reInit();
    }
  }, 1000);

  // --- initial boot ----------------------------------------------------------
  (async () => {
    ensureWiring();
    await loadSettings();
    await attachToCurrentPlayer();
  })();
})();
