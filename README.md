# WatchFree

A single Manifest V3 Chrome extension that, on `youtube.com`, **detects
client-side-inserted ads and instantly handles them** — clicks *Skip* the moment
it appears, otherwise **mutes + speeds through** the ad — and covers the player
with a **productivity overlay** (todo list + notes + rotating motivational
quotes) for the ad's duration, then **cleanly restores the original playback
state**.

No backend, no external services, no build step. Everything runs in the browser.

---

## Features

- **Instant ad handling.** Clicks *Skip* the instant the button appears (a
  MutationObserver on the player, plus a polling fallback). Unskippable ads are
  muted and run at high speed (default 16×) to burn through them.
- **Exact state restore.** Mute goes through YouTube's own player API so it
  sticks; the user's prior mute + playback speed are captured before any change
  and restored after the ad.
- **Productivity overlay.** Full-size overlay over the video with a todo list,
  a notes panel, and rotating motivational quotes. Persists via
  `chrome.storage.sync` (follows you across devices).
- **On-demand panel.** Open the same panel anytime with **Ctrl/⌘+Shift+Y** or the
  popup button — not just during ads.
- **Stats.** Counts ads handled and estimated time saved (shown in the overlay
  and popup).
- **Settings popup.** Toggle the extension, mute, overlay, nuisance dismissal,
  ad speed, debug logging, and edit your own quotes. Changes apply live to open
  tabs.
- **Nuisance dismissal.** Auto-closes banner/overlay ads and the
  "Video paused. Continue watching?" dialog.

---

## Architecture (cybernetic mapping → modules)

The whole critical loop runs **inside the YouTube tab** in one content script, so
muting, clicking *Skip*, and injecting the overlay happen synchronously in well
under 1 ms. The MV3 service worker holds nothing latency-critical — it only
relays the keyboard command. The module split below organizes the code; it does
**not** imply separate processes.

| Concept (cybernetics)     | File            | Role |
|---------------------------|-----------------|------|
| Input (environment)       | the live player + DOM | not code — YouTube's `<video>` + `#movie_player` |
| **Sensor**                | `sensor.js`     | detects ad start/end from player signals |
| **Controller**            | `controller.js` | state machine (`IDLE → AD_ACTIVE → IDLE`); plant context; stats |
| **Actuators (Output)**    | `actuators.js`  | skip-click, mute, `playbackRate`, overlay, restore, nuisance watch |
| **Overlay**               | `overlay.js`    | Shadow-DOM UI (todos + notes + quotes + stats) |
| Persistence               | `storage.js`    | sync (todos/notes/settings/quotes) + local (stats) |
| Goal config + transport   | `content.js`    | wiring, SPA re-init, settings, panel toggle |
| Settings UI               | `popup.html` / `popup.js` | toolbar popup |
| Command relay             | `background.js` | service worker: keyboard command → content script |
| Shadow-root styles        | `styles.css`    | injected into the shadow root only |

**Transport** between content-script modules is plain function calls via a shared
namespace (`window.WatchFree`) — trivially fast, no message bus.

### Turbulence mitigation (redundancy)

- **Two ad-detection mechanisms** so a single missed signal can't strand the
  state machine: a `MutationObserver` on `#movie_player` (`class` attribute)
  **and** a low-frequency (~300 ms) poll. Transitions are debounced.
- **Instant skip** via a second MutationObserver on the player subtree, with the
  skip-retry poll as fallback.
- **SPA re-acquisition**: `content.js` re-acquires `#movie_player` and re-attaches
  the Sensor on `yt-navigate-finish` **and** via a 1 s URL-change watcher.

### Plant context

The Sensor only reports the `ad-showing` class, so ordinary **user pauses** never
reach the Controller. The Controller distinguishes:

- **Genuine ad start/end** → capture prior playback state *before* changing
  anything, act, then restore exactly. Mute is driven through YouTube's player
  API (`isMuted`/`mute`/`unMute`) because setting `video.muted` directly gets
  latched and re-applied by YouTube at ad end (sound never returns); restore is
  re-asserted on a short delay to win the teardown race.
- **Video switch / SPA navigation** → `reset()` abandons the ad context and
  cleans up *without* restoring a stale rate/mute onto a fresh video.

---

## File tree

```
WatchFree/
├── README.md
├── extension/
│   ├── manifest.json     # MV3; content script + popup action + background + command
│   ├── content.js        # bootstrap: config, wiring, SPA re-init, settings, panel toggle
│   ├── sensor.js         # ad detection (MutationObserver + poll, debounced)
│   ├── controller.js     # state machine + plant-context tracking + stats
│   ├── actuators.js      # skip-click, mute (player API), speed, overlay, restore, nuisance watch
│   ├── overlay.js        # Shadow-DOM overlay: todos + notes + quotes + stats
│   ├── storage.js        # sync (todos/notes/settings/quotes) + local (stats)
│   ├── popup.html        # settings popup markup
│   ├── popup.js          # settings popup logic
│   ├── background.js     # service worker: relays the keyboard command
│   └── styles.css        # injected into the shadow root only
└── test/
    ├── README.md         # how to run both test layers
    ├── harness.js        # Node logic tests (no browser) — `node test/harness.js`
    └── simulator.html    # real-browser test page driving the full pipeline
```

---

## Install (load unpacked)

1. Open `chrome://extensions`.
2. Toggle **Developer mode** on (top-right).
3. Click **Load unpacked**.
4. Select the **`extension/`** folder (the one containing `manifest.json`).
5. Open or reload a `youtube.com` tab.

To pick up code changes: click the **reload** icon on the WatchFree card in
`chrome://extensions`, then reload the YouTube tab. The keyboard shortcut can be
customized at `chrome://extensions/shortcuts`.

---

## Tests

Two layers (details in [`test/README.md`](test/README.md)):

- **Logic (no browser):** `node test/harness.js` — loads the real sensor /
  controller / actuators / storage with mocked `chrome`/DOM and asserts the ad
  lifecycle (state machine, exact restore, plant-context, debounce, poll
  fallback, overlay-disabled, stats). Exits non-zero on failure.
- **Real browser:** serve the repo and open the simulator, which drives the full
  Sensor → Controller → Actuators → Overlay pipeline (real Shadow DOM +
  `styles.css`) against a faked player:
  ```bash
  python3 -m http.server 8731
  # open http://localhost:8731/test/simulator.html
  ```

Neither can prove YouTube's live `ad-showing` class / skip-button selectors still
match — that's the manual checklist below.

---

## Manual end-to-end test checklist

> Ads are not guaranteed on every video (Premium accounts / no-ad rotations). Use
> a logged-out window or a video known to serve pre-rolls.

1. **Pre-roll handling** — open a video with a pre-roll ad. Skip is clicked the
   moment it appears; unskippable ads are muted + sped up.
2. **Overlay** — during an unskippable ad the full-size overlay covers the player
   with a rotating quote, todos, and notes.
3. **Persistence + sync** — add a todo/note; it survives reloads and appears on
   another machine signed into the same Chrome profile.
4. **Exact restore** — set a custom speed (e.g. 1.5×) and/or mute before an ad;
   after the ad, the player returns to exactly that state. **Confirm the sound
   comes back on.**
5. **Stats** — the overlay/popup show "N ads handled · ~M min saved".
6. **On-demand panel** — press **Ctrl/⌘+Shift+Y** (or the popup button) on a
   video; the panel opens with a close (×) button.
7. **Settings** — open the popup, toggle something (e.g. turn off the overlay);
   it applies to the open tab without reload.
8. **SPA navigation** — click to a new video without reloading; ad handling still
   works and the new video is not stuck muted/fast.

Optional: enable **Debug logging** in the popup and filter the console for
`[WatchFree]` to see capture/restore values.

---

## Known limitations (stated plainly — not solved here)

- **Server-side ad insertion (SSAI):** when ads are stitched into the main stream
  there is **no separate ad element and no `ad-showing` class**, so this approach
  won't fire. **This MVP targets client-side-inserted ads only.** Audio/visual
  classification is **future work**, out of scope here.
- **Selectors drift:** YouTube renames its skip-button, banner-ad, and dialog
  markup over time. These live in `CONFIG` in `content.js` (`skipSelectors`,
  `nuisanceSelectors`, `continueDialogSelectors`) and the ad signal lives in
  `sensor.js` — update there when YouTube changes.
- **Terms of Service / personal use:** automating the player this way may
  conflict with YouTube's ToS. This is intended as a **personal, local tool**.

---

## Extension points

- **Settings (live):** the popup, persisted to `chrome.storage.sync` and merged
  over `CONFIG` in `content.js`.
- **Goal config (internal tuning):** `CONFIG` in `content.js` (timings, selectors).
- **New ad signal:** extend `sensor.js`.
- **Ad-handling behavior:** `actuators.js` (`engageAd` / `disengageAd` / `tryDismiss`).
- **Overlay UI:** `overlay.js` (+ `styles.css`).
