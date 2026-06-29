# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A single Manifest V3 Chrome extension (no build step, no dependencies) that detects **client-side-inserted** YouTube ads, skips them (or mutes + speeds through unskippable ones), shows a Shadow-DOM productivity overlay (a centered motivational quote + notes + stats) during the ad, then restores the exact prior playback state. It also has a settings popup, a stats counter, an on-demand panel (keyboard shortcut), and nuisance-ad dismissal. The whole ad-handling loop runs in the content script; the service worker only relays the keyboard command.

## Commands

There is no build step — the extension loads as-is.

- **Load / reload:** `chrome://extensions` → Developer mode → **Load unpacked** → select `extension/`. After edits, reload the WatchFree card, then reload the YouTube tab. Shortcut config: `chrome://extensions/shortcuts`.
- **Logic tests:** `node test/harness.js` — loads the real sensor/controller/actuators/storage with mocked `chrome`/DOM and asserts the ad lifecycle. Exits non-zero on failure. Run after touching those four files.
- **Real-browser test:** `python3 -m http.server 8731` from the repo root, then open `http://localhost:8731/test/simulator.html`. Drives the full pipeline incl. Shadow DOM + `styles.css` against a faked player. Use after touching `overlay.js`, `styles.css`, or `content.js`.
- **Syntax check:** `cd extension && python3 -m json.tool manifest.json >/dev/null && for f in storage.js overlay.js sensor.js actuators.js controller.js content.js background.js popup.js; do node --check "$f"; done`
- **Live YouTube** is the only thing tests can't cover (real `ad-showing` class / skip selectors) — manual checklist in `README.md`. See `test/README.md`.

## Architecture

One content script, whole critical loop in-tab. The content-script files (`storage.js`, `overlay.js`, `sensor.js`, `actuators.js`, `controller.js`, `content.js`) load in the order declared in `manifest.json`, into the same isolated world, each hanging its factory off `window.WatchFree`. **Load order matters** — dependencies before dependents (storage → overlay → sensor → actuators → controller → content). `popup.js` and `background.js` run in separate extension contexts (not content scripts) and talk to the page via `chrome.storage` and `chrome.runtime.sendMessage`.

Data flow: **Sensor** (`ad-showing` class) → **Controller** (`IDLE → AD_ACTIVE → IDLE` + stats) → **Actuators** (skip / mute / speed / overlay / nuisance). `content.js` builds the singletons, holds `CONFIG` (the "Goal"), merges user settings over it, and owns SPA re-init + the panel toggle.

Invariants to preserve when editing:

- **Mute via the player API, not `video.muted`.** Use `#movie_player`'s `isMuted()` / `mute()` / `unMute()` (with element fallback). Setting `video.muted` directly gets latched by YouTube and re-applied at ad end, so sound never returns. Restore is re-asserted at 250ms/800ms to beat the teardown race. Playback rate stays on the `<video>` element. (This was a real bug — don't regress it.)
- **Capture before change, restore exact.** Controller captures `{muted, playbackRate}` before Actuators touch anything; never hard-code restore to 1×/unmuted.
- **Detection redundancy:** `sensor.js` watches `ad-showing` via a MutationObserver AND a ~300ms poll, debounced. `actuators.js` watches the player subtree to click Skip instantly, with the skip-retry poll as fallback. Don't drop the redundant paths.
- **Plant context:** SPA nav / video switch goes through `controller.reset()`, which cleans up without restoring stale state onto a fresh video.
- **Storage areas:** todos/notes/settings/quotes are in `chrome.storage.sync`; stats are in `chrome.storage.local` (written per-ad, kept off sync's write quota). Always go through `storage.js`, never `localStorage`.
- **Settings live-apply:** the popup writes `settings` to `chrome.storage.sync`; `content.js` listens via `chrome.storage.onChanged` and mutates `CONFIG` in place (all modules read `config.*` dynamically, so in-place mutation propagates). The user-overridable keys are `SETTING_KEYS` in `content.js` — keep popup defaults (`popup.js` `DEFAULT_SETTINGS`) in sync with `CONFIG` defaults.
- **Overlay isolation:** Shadow DOM host over `#movie_player`; `styles.css` is fetched via `chrome.runtime.getURL` and injected into the shadow root only (must stay in `web_accessible_resources`). Use `textContent` for user data.

## Extension points

- User settings: the popup → `chrome.storage.sync` → merged over `CONFIG`.
- Internal tuning + selectors: `CONFIG` in `content.js`. YouTube renames markup over time; the things that break and where to fix them: skip button → `CONFIG.skipSelectors`; banner ads → `CONFIG.nuisanceSelectors`; continue-watching dialog → `CONFIG.continueDialogSelectors` (marked with a TODO — verify on live YouTube); ad signal → `sensor.js`.

## Known scope limits (don't "fix" without discussion)

Server-side ad insertion (SSAI) is intentionally unsupported — stitched-in ads have no separate element or `ad-showing` class, so this approach can't fire. Audio/visual classification is noted as future work, not a bug.
