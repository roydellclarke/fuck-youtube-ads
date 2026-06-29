// sensor.js — ad detection from the live player state.
//
// Primary signal: #movie_player carries the class `ad-showing` while a
// client-side-inserted ad is playing. We watch that class with TWO redundant
// mechanisms (turbulence mitigation) so a single missed signal can't strand the
// state machine:
//   1) a MutationObserver on #movie_player (attributeFilter ['class']), and
//   2) a low-frequency setInterval poll that re-checks the class.
// Transitions are debounced so rapid class flips don't thrash the Controller.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // createSensor(config, handlers)
  //   handlers.onAdStart() — fired once when ad-showing becomes true (stable).
  //   handlers.onAdEnd()   — fired once when ad-showing becomes false (stable).
  NS.createSensor = function createSensor(config, handlers) {
    let player = null;
    let observer = null;
    let pollId = null;
    let debounceTimer = null;
    let lastState = false; // last *confirmed* ad-showing state

    function isAdShowing() {
      return !!player && player.classList.contains("ad-showing");
    }

    // Re-checks the signal; on a stable change from lastState, fires once.
    function evaluate() {
      const now = isAdShowing();
      if (now === lastState) return;
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        const confirmed = isAdShowing();
        if (confirmed === lastState) return; // flipped back during debounce
        lastState = confirmed;
        try {
          if (confirmed) handlers.onAdStart();
          else handlers.onAdEnd();
        } catch (e) {
          console.error("[WatchFree] sensor handler error:", e);
        }
      }, config.debounceMs || 50);
    }

    function attach(playerEl) {
      detach();
      player = playerEl;
      // Seed lastState to the current reality. If an ad is *already* showing at
      // attach time (e.g. pre-roll already running), fire onAdStart immediately.
      lastState = isAdShowing();
      if (lastState) {
        try {
          handlers.onAdStart();
        } catch (e) {
          console.error("[WatchFree] sensor onAdStart error:", e);
        }
      }

      observer = new MutationObserver(evaluate);
      observer.observe(player, {
        attributes: true,
        attributeFilter: ["class"],
      });

      pollId = setInterval(evaluate, config.pollIntervalMs || 300);
    }

    function detach() {
      if (observer) {
        observer.disconnect();
        observer = null;
      }
      if (pollId) {
        clearInterval(pollId);
        pollId = null;
      }
      clearTimeout(debounceTimer);
      debounceTimer = null;
      player = null;
      lastState = false;
    }

    return { attach, detach, isAdShowing };
  };
})();
