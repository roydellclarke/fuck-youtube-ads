// actuators.js — the outputs that drive the player toward the Goal state.
//
// Responsibilities:
//   - try to click the "Skip" button (several selector variants, in order),
//   - if unskippable: mute + crank playbackRate to burn through the ad,
//   - mount/unmount the overlay,
//   - capture and restore exact prior playback state,
//   - dismiss banner ads and the "continue watching" dialog (nuisance watch).
//
// MUTE goes through YouTube's player API (#movie_player.isMuted/mute/unMute),
// NOT video.muted directly. Setting video.muted directly works *during* the ad,
// but YouTube latches that into its own internal mute state and re-applies it at
// ad end, clobbering an element-level unmute (sound never comes back). Driving
// mute through the player API keeps YouTube's state consistent so restore sticks.
// playbackRate is not latched the same way, so it stays on the <video> element.
// Both paths fall back to the raw element if the API methods aren't present.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // createActuators(config, getVideo, getPlayer, overlay)
  //   getVideo  — () => the live <video> element inside the player.
  //   getPlayer — () => the #movie_player element (exposes YouTube's player API).
  //   overlay   — object returned by createOverlay (mount/unmount).
  NS.createActuators = function createActuators(config, getVideo, getPlayer, overlay) {
    let skipTimer = null;
    let skipObserver = null;
    let nuisanceTimer = null;
    let restoreTimers = [];

    function log(...args) {
      if (config.debug) console.log("[WatchFree]", ...args);
    }

    // --- mute via YouTube's player API, falling back to the element ----------
    function readMuted() {
      const p = getPlayer && getPlayer();
      if (p && typeof p.isMuted === "function") {
        try {
          return p.isMuted();
        } catch (e) {
          /* fall through */
        }
      }
      const v = getVideo();
      return v ? v.muted : false;
    }

    function applyMuted(muted) {
      const p = getPlayer && getPlayer();
      if (p && typeof p.mute === "function" && typeof p.unMute === "function") {
        try {
          if (muted) p.mute();
          else p.unMute();
          // Mirror onto the element too; harmless and covers edge cases.
          const v = getVideo();
          if (v) v.muted = muted;
          return;
        } catch (e) {
          /* fall through */
        }
      }
      const v = getVideo();
      if (v) v.muted = muted;
    }

    function setRate(rate) {
      const v = getVideo();
      if (v) v.playbackRate = rate;
    }

    // Attempt to click a skip button if one is present. Returns true on click.
    function trySkip() {
      for (const sel of config.skipSelectors) {
        const btn = document.querySelector(sel);
        if (btn) {
          btn.click();
          return true;
        }
      }
      return false;
    }

    // Watch the player subtree so we click Skip the instant the button is
    // inserted/becomes visible, rather than waiting up to one poll interval.
    function startSkipWatch() {
      stopSkipWatch();
      const p = getPlayer && getPlayer();
      if (p && typeof MutationObserver === "function") {
        skipObserver = new MutationObserver(() => {
          trySkip();
        });
        try {
          skipObserver.observe(p, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ["class", "style"],
          });
        } catch (e) {
          /* ignore */
        }
      }
    }

    function stopSkipWatch() {
      if (skipObserver) {
        skipObserver.disconnect();
        skipObserver = null;
      }
    }

    // --- nuisance dismissal (banner ads + "continue watching" dialog) -------
    // Runs independently of ad-showing, because these surfaces appear outside of
    // client-side ad playback. Gated by config.dismissNuisances via content.js.
    function tryDismiss() {
      for (const sel of config.nuisanceSelectors || []) {
        const el = document.querySelector(sel);
        if (el) el.click();
      }
      for (const sel of config.continueDialogSelectors || []) {
        const el = document.querySelector(sel);
        if (el) {
          el.click();
          break;
        }
      }
    }

    function startNuisanceWatch() {
      stopNuisanceWatch();
      nuisanceTimer = setInterval(tryDismiss, config.nuisancePollMs || 1000);
    }

    function stopNuisanceWatch() {
      if (nuisanceTimer) {
        clearInterval(nuisanceTimer);
        nuisanceTimer = null;
      }
    }

    // Read current playback state BEFORE we touch anything, so restore is exact.
    function captureState() {
      const v = getVideo();
      const state = {
        muted: readMuted(),
        playbackRate: v ? v.playbackRate : 1,
      };
      log("captured pre-ad state", state);
      return state;
    }

    function clearRestoreTimers() {
      for (const t of restoreTimers) clearTimeout(t);
      restoreTimers = [];
    }

    // Engage ad-handling: suppress audio/visual, speed through, show overlay,
    // and keep trying to skip (the Skip button typically appears a few seconds
    // into the ad, so a single attempt at ad-start isn't enough).
    function engageAd() {
      clearRestoreTimers();
      if (config.muteDuringAd) applyMuted(true);
      setRate(config.adPlaybackRate);
      if (config.overlayEnabled) overlay.mount();

      // Click Skip the instant it appears (observer), with an immediate attempt
      // plus a polling fallback in case a mutation is missed.
      trySkip();
      startSkipWatch();
      clearInterval(skipTimer);
      skipTimer = setInterval(() => {
        // Re-assert suppression in case YouTube reset rate/mute mid-ad.
        if (config.muteDuringAd) applyMuted(true);
        const vid = getVideo();
        if (vid && vid.playbackRate !== config.adPlaybackRate) {
          setRate(config.adPlaybackRate);
        }
        trySkip();
      }, config.skipRetryMs || 500);
    }

    // Disengage: stop skip retries, restore captured state (if provided), and
    // unmount the overlay. Passing state=null restores nothing (used when the
    // ad context is abandoned, e.g. SPA navigation to a different video).
    //
    // The restore is re-asserted a couple of times on a short delay: YouTube
    // runs its own audio/state logic as the ad tears down, and a single restore
    // can lose the race. Re-applying after the transition settles makes it stick.
    function disengageAd(state) {
      clearInterval(skipTimer);
      skipTimer = null;
      stopSkipWatch();
      clearRestoreTimers();

      if (state) {
        const apply = () => {
          applyMuted(state.muted);
          setRate(state.playbackRate);
        };
        apply();
        log("restored state", state);
        restoreTimers.push(setTimeout(apply, 250));
        restoreTimers.push(setTimeout(apply, 800));
      }
      overlay.unmount();
    }

    return {
      trySkip,
      captureState,
      engageAd,
      disengageAd,
      startNuisanceWatch,
      stopNuisanceWatch,
    };
  };
})();
