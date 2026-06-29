# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Manifest V3 Chrome extension (no build step, no dependencies) that detects **client-side-inserted** YouTube ads, skips them (or mutes + speeds through unskippable ones), shows a Shadow-DOM productivity overlay (a centered motivational quote + notes + stats) during the ad, then restores the exact prior playback state. It also has a settings popup, a stats counter, an on-demand panel (keyboard shortcut), and nuisance-ad dismissal. The whole ad-handling loop runs in the content script; the service worker only relays the keyboard commands.

It additionally bundles four "productivity" features that share the same content-script world and storage:

- **SponsorBlock** (`sponsorblock.js`) — auto-skips in-video sponsor/intro/outro/etc. segments using the community API, queried by privacy-preserving SHA-256 **hash prefix** (only the first 4 hex chars of the video ID leave the machine). Orthogonal to YouTube's own ads.
- **Learning log** (`learninglog.js`) — Ctrl/⌘+Shift+K captures a note bound to the current video + timestamp; viewed/searched/exported on the dashboard.
- **Focus sessions** (`focus.js`) — a Pomodoro timer that injects a stylesheet hiding distractions (recommendations/comments/Shorts/end-cards) and accrues focus minutes.
- **Dashboard** (`dashboard.html`/`dashboard.js`) — the options page: summary cards, inline-SVG charts over the last 30 days, daily streak, and the learning-log browser (search / jump / delete / Markdown+JSON+CSV export). Reuses the pure utils from `statsutil.js` + `learninglog.js`.

Pure logic across these lives in `statsutil.js` (daily buckets / series / streak / chart geometry) and the `*Util` namespaces, kept dependency- and DOM-free so the Node harness can unit-test them.

## Commands

There is no build step — the extension loads as-is.

- **Load / reload:** `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`. After edits, reload the WatchFree card, then reload the YouTube tab. Shortcut config: `chrome://extensions/shortcuts`.
- **Logic tests:** `node test/harness.js` — loads the real storage/statsutil/sensor/actuators/controller/sponsorblock/learninglog/focus modules with mocked `chrome`/DOM/`crypto`/`fetch` and asserts the ad lifecycle plus all four productivity features (blocks A–O). Exits non-zero on failure. Run after touching any of those files.
- **Real-browser test:** `python3 -m http.server 8731` from the repo root, then open `http://localhost:8731/test/simulator.html`. Drives the full pipeline incl. Shadow DOM + `styles.css` against a faked player. Use after touching `overlay.js`, `styles.css`, or `content.js`. (The dashboard options page isn't covered by the simulator — load the extension and open it.)
- **Syntax check:** `cd extension && python3 -m json.tool manifest.json >/dev/null && for f in storage.js statsutil.js overlay.js sensor.js actuators.js controller.js sponsorblock.js learninglog.js focus.js content.js background.js popup.js dashboard.js; do node --check "$f"; done`
- **Live YouTube** is the only thing tests can't cover (real `ad-showing` class / skip selectors) — manual checklist in `README.md`. See `test/README.md`.

## Architecture

One content script, whole critical loop in-tab. The content-script files (`storage.js`, `statsutil.js`, `overlay.js`, `sensor.js`, `actuators.js`, `controller.js`, `sponsorblock.js`, `learninglog.js`, `focus.js`, `content.js`) load in the order declared in `manifest.json`, into the same isolated world, each hanging its factory/util off `window.WatchFree`. **Load order matters** — dependencies before dependents (storage + statsutil first; sponsorblock/learninglog/focus before content; content last). `popup.js`, `background.js`, and `dashboard.js` run in separate extension contexts (not content scripts) and talk to the page via `chrome.storage` and `chrome.runtime.sendMessage`. The dashboard page re-includes the pure modules (`storage.js`, `statsutil.js`, `sponsorblock.js` for its util, `learninglog.js`) — these are safe to load anywhere because nothing runs at import time beyond defining factories/utils.

Data flow: **Sensor** (`ad-showing` class) → **Controller** (`IDLE → AD_ACTIVE → IDLE` + stats) → **Actuators** (skip / mute / speed / seek-to-end / overlay / nuisance). `content.js` builds the singletons (incl. SponsorBlock / LearningLog / Focus), holds `CONFIG` (the "Goal"), merges user settings over it, and owns SPA re-init + the panel/capture/focus message handlers. SponsorBlock runs its own `timeupdate`-driven skip loop per video; Focus runs its own clock-ticked timer; both are independent of the ad state machine.

Invariants to preserve when editing:

- **Mute via the player API, not `video.muted`.** Use `#movie_player`'s `isMuted()` / `mute()` / `unMute()` (with element fallback). Setting `video.muted` directly gets latched by YouTube and re-applied at ad end, so sound never returns. Restore is re-asserted at 250ms/800ms to beat the teardown race. Playback rate stays on the `<video>` element. (This was a real bug — don't regress it.)
- **Capture before change, restore exact.** Controller captures `{muted, playbackRate}` before Actuators touch anything; never hard-code restore to 1×/unmuted.
- **Detection redundancy:** `sensor.js` watches `ad-showing` via a MutationObserver AND a ~300ms poll, debounced. `actuators.js` watches the player subtree to click Skip instantly, with the skip-retry poll as fallback. Don't drop the redundant paths.
- **Plant context:** SPA nav / video switch goes through `controller.reset()`, which cleans up without restoring stale state onto a fresh video.
- **Storage areas:** todos/notes/settings/quotes are in `chrome.storage.sync`; stats **and the learning log** are in `chrome.storage.local` (written frequently / grow unbounded, kept off sync's write + size quotas). `getStats()` always merges stored data over `defaultStats()`, so adding a new counter is backward-compatible. Per-day buckets (`stats.daily['YYYY-MM-DD']`) are written by the controller (ads), sponsorblock (sponsor seconds), and focus (minutes) via `statsUtil.bumpDaily`. Always go through `storage.js`, never `localStorage`.
- **SponsorBlock privacy:** never send the full video ID. Query `/api/skipSegments/<first-4-hex-of-sha256(id)>` and filter the response locally for the matching `videoID`. Don't regress this to the plain `?videoID=` endpoint. The API host must stay in `host_permissions`.
- **Settings live-apply:** the popup writes `settings` to `chrome.storage.sync`; `content.js` listens via `chrome.storage.onChanged` and mutates `CONFIG` in place (all modules read `config.*` dynamically, so in-place mutation propagates). The user-overridable keys are `SETTING_KEYS` in `content.js` — keep popup defaults (`popup.js` `DEFAULT_SETTINGS`) in sync with `CONFIG` defaults.
- **Overlay isolation:** Shadow DOM host over `#movie_player`; `styles.css` is fetched via `chrome.runtime.getURL` and injected into the shadow root only (must stay in `web_accessible_resources`). Use `textContent` for user data.

## Extension points

- User settings: the popup → `chrome.storage.sync` → merged over `CONFIG`.
- Internal tuning + selectors: `CONFIG` in `content.js`. YouTube renames markup over time; the things that break and where to fix them: skip button → `CONFIG.skipSelectors`; banner ads → `CONFIG.nuisanceSelectors`; continue-watching dialog → `CONFIG.continueDialogSelectors` (marked with a TODO — verify on live YouTube); ad signal → `sensor.js`; focus-mode hidden elements → `CONFIG.focusHideSelectors`; SponsorBlock categories → `CONFIG.sponsorBlockCategories` (and the popup checkboxes); SponsorBlock API base → `CONFIG.sponsorBlockApiBase`.

## Working with Claude on this repo (workflow conventions)

These are the working defaults for this codebase. They're phrased as the prompts that trigger them so they're easy to invoke.

- **"Write me an implementation spec" / "Interview me" — plan before building.** For anything bigger than a one-file edit, write the change list first (files touched, new `CONFIG` keys, new `SETTING_KEYS`, storage shape, test blocks to add) and confirm it before coding. If the request is underspecified (which selectors? sync vs local? user-facing setting or internal tuning?), ask the questions first rather than guessing — wrong assumptions here are expensive because load order, the mute-via-API rule, and the storage quotas all have non-obvious constraints. The recent four-feature build followed this: spec → unit tests → wire UI → verify, one feature per commit.

- **"Verify before you build" — the standing verification plan.** Every change runs this ladder, cheapest first; don't claim done until the relevant rungs pass:
  1. **Syntax:** the syntax-check one-liner in *Commands* (`json.tool` + `node --check` over every JS file).
  2. **Logic:** `node test/harness.js` — and *add a test block* for new pure logic (the harness is the TDD vehicle; keep core logic in DOM-free `*Util` factories so it's unit-testable). Touching sensor/controller/actuators/storage/statsutil/sponsorblock/learninglog/focus → this is mandatory.
  3. **In-browser wiring:** the simulator (`test/simulator.html`) after touching `overlay.js`, `styles.css`, `content.js`, or the content-script load order — and tools are available to drive it (the `browse` skill loads it headless and reports console errors; use it as Layer-2 "Claude checks its own work").
  4. **Human-validation zone:** live YouTube is the one surface tests can't prove (real `ad-showing` class, skip selectors, SponsorBlock fetch against YT's origin, focus-hide selectors). Flag these for a manual pass against the README checklist instead of asserting they work.

- **"Launch sub agents" — parallelize independent work.** Good fits here: sweeping for current YouTube selector names across the markup, getting multiple independent reviews of a tricky change (the mute/restore race is a classic), or exploring options before committing to one. Keep the critical edit sequential; fan out the research.

- **"Based on this conversation, build me a skill" — codify repeated flows.** If a multi-step task recurs (e.g. "serve the repo, load the simulator headless, drive the ad lifecycle, report console errors"), turn the concrete steps from the actual conversation into a skill, with a *gotchas* section (e.g. the status panel polls on its own cadence, so read live state via `js`, not the status div).

- **"Automate this" — use with caution.** Run a taste test first: anything touching what the *user* sees (overlay copy, quote curation, dashboard layout) needs human judgment — augment, don't fully automate. Mechanical, fully-quantifiable steps (the test ladder, syntax checks, selector sweeps) are safe to automate. Rule of thumb: if an 80%-as-good-as-human output wouldn't satisfy you, keep a human in the loop.

## Known scope limits (don't "fix" without discussion)

Server-side ad insertion (SSAI) is intentionally unsupported — stitched-in ads have no separate element or `ad-showing` class, so this approach can't fire. Audio/visual classification is noted as future work, not a bug.
