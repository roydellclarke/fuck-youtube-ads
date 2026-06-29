// controller.js — the state machine that decides actions and tracks plant context.
//
// States: IDLE → AD_ACTIVE → IDLE.
//
// Plant context: the Sensor only reports the ad-showing class specifically, so
// ordinary user pauses do NOT toggle it and never reach here. The two contexts
// the Controller must still keep straight:
//   - genuine ad start/end  → handleAdStart / handleAdEnd (act, capture/restore).
//   - video switch / SPA nav → reset (abandon ad context WITHOUT restoring a
//     stale rate/mute onto a fresh video). content.js calls reset() on nav.
//
// Also records lightweight stats (ads handled + estimated seconds saved).
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  const STATE = { IDLE: "IDLE", AD_ACTIVE: "AD_ACTIVE" };

  // createController(config, actuators)
  NS.createController = function createController(config, actuators) {
    let state = STATE.IDLE;
    let capturedState = null; // user's playback state captured at ad start
    let adStartWall = 0; // performance.now() at ad start (for stats)

    // Estimate seconds of ad content burned through: wall time the ad was active
    // multiplied by the speed-up factor. Capped so a stuck timer can't inflate
    // the number. This is an estimate, not exact ad metadata.
    async function recordAd(wallSeconds) {
      try {
        const rate = config.adPlaybackRate || 1;
        const saved = Math.max(0, Math.min(wallSeconds * rate, 180));
        const stats = await NS.storage.getStats();
        stats.count = (stats.count || 0) + 1;
        stats.secondsSaved = (stats.secondsSaved || 0) + saved;
        // Per-day bucket powers the dashboard charts + streaks.
        if (NS.statsUtil) {
          NS.statsUtil.bumpDaily(stats, NS.statsUtil.dateKey(new Date()), {
            adCount: 1,
            adSeconds: saved,
          });
        }
        await NS.storage.saveStats(stats);
      } catch (e) {
        /* stats are best-effort */
      }
    }

    function handleAdStart() {
      if (state === STATE.AD_ACTIVE) return; // already handling this ad
      // Capture BEFORE changing anything so we never clobber a user who was
      // already muted or at a custom speed.
      capturedState = actuators.captureState();
      adStartWall = performance.now();
      state = STATE.AD_ACTIVE;
      actuators.engageAd();
    }

    function handleAdEnd() {
      if (state !== STATE.AD_ACTIVE) return; // nothing to restore
      actuators.disengageAd(capturedState);
      recordAd((performance.now() - adStartWall) / 1000);
      capturedState = null;
      state = STATE.IDLE;
    }

    // Called on SPA navigation / video switch. If an ad was active we still
    // clean up (stop retries, unmount overlay). We restore the captured state
    // when we have it; if not, we fall back to sane defaults (unmuted, 1x) so a
    // new video can't get stranded muted-and-fast. The abandoned ad is NOT
    // counted in stats. If we were IDLE, this is a harmless idempotent cleanup.
    function reset() {
      const restore =
        state === STATE.AD_ACTIVE
          ? capturedState || { muted: false, playbackRate: 1 }
          : null;
      actuators.disengageAd(restore);
      capturedState = null;
      state = STATE.IDLE;
    }

    return {
      handleAdStart,
      handleAdEnd,
      reset,
      getState: () => state,
    };
  };
})();
