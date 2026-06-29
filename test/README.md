# Tests

Two layers, because the extension has two kinds of logic — pure control flow,
and real browser/DOM behavior.

## 1. `harness.js` — Node logic tests (no browser)

Loads the **real** `storage.js`, `statsutil.js`, `sensor.js`, `actuators.js`,
`controller.js`, `sponsorblock.js`, `learninglog.js`, and `focus.js` with mocked
`chrome` (`storage.sync` + `storage.local`), `document`, `MutationObserver`,
`crypto` (WebCrypto), and an injectable `fetch`, then drives the ad lifecycle and
asserts behavior. Covers (blocks A–O): the state machine, capture-before-change +
exact restore, plant-context (`reset()`), skip-click path, debounce, poll-only
fallback, `overlayEnabled=false`, stats counting + daily buckets, storage
round-trips, **statsutil** (daily series / streak / chart geometry / CSV),
**SponsorBlock** (URL parse, segment normalize/filter, auto-skip, stats),
**learning log** (format / jump URL / search / Markdown export / capture), and
**focus sessions** (timer state machine, pause/resume, distraction CSS, accrual).

```bash
node test/harness.js
```

Exit code is non-zero if any assertion fails (CI-friendly).

What it does **not** cover: Shadow-DOM rendering, `styles.css`, the popup, and the
`content.js` SPA/settings wiring — those need a real DOM (see below).

## 2. `simulator.html` — real-browser test page

A standalone page that fakes a `#movie_player` + `<video>` and loads the real
content scripts (with an in-memory `chrome.storage` + `onChanged` + `runtime`
message shim). Toggling the `ad-showing` class drives the full
Sensor → Controller → Actuators → Overlay pipeline, including the real Shadow DOM
and `styles.css`.

Serve from the repo root (the page references `/extension/*`):

```bash
python3 -m http.server 8731
# then open http://localhost:8731/test/simulator.html
```

Controls on the page:

- **start muted / prior speed → apply to video** — set the user's pre-ad state to
  prove restore is exact.
- **Start ad (unskippable)** — expect mute + high `playbackRate` + overlay.
- **Start ad (skippable)** — injects a real skip button; the actuator auto-clicks
  it, ending the ad.
- **End ad** — expect exact restore + overlay unmount.
- **Toggle panel (on demand)** — fires the same message the keyboard shortcut /
  popup send; opens the closable productivity panel.

The live status panel shows `ad-showing`, `video.muted`, `video.playbackRate`,
overlay-mounted, and skip-button state.

To preview the popup chrome (layout only), open
`http://localhost:8731/extension/popup.html` — note `chrome` isn't shimmed there,
so it shows defaults without live values.

### What neither test can prove

The simulator fakes the `ad-showing` class and skip button, so it can't confirm
they match YouTube's **current** markup. That last mile is the manual checklist in
the root `README.md` — load the unpacked extension and play a real video.
(Shortcut: on a live video, run
`document.querySelector('#movie_player').classList.add('ad-showing')` in the
console to force the pipeline, then remove it.)
