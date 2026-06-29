// popup.js — toolbar popup. Reads/writes the synced settings + custom quotes,
// shows stats, and can open the productivity panel in the active tab.
//
// Settings are persisted to chrome.storage.sync under the same key the content
// script watches, so changes apply live without reloading the tab.
"use strict";

const KEYS = {
  settings: "watchfree_settings",
  quotes: "watchfree_quotes",
  stats: "watchfree_stats",
};

// SponsorBlock categories the popup lets the user toggle (value → label).
const SB_CATEGORIES = [
  ["sponsor", "Sponsor"],
  ["selfpromo", "Self-promo / merch"],
  ["interaction", "Interaction reminder (like/sub)"],
  ["intro", "Intro / intermission"],
  ["outro", "Outro / endcards"],
  ["music_offtopic", "Non-music (in music videos)"],
  ["preview", "Preview / recap"],
  ["filler", "Filler / tangent"],
];

// Defaults mirror the user-facing subset of CONFIG in content.js.
const DEFAULT_SETTINGS = {
  enabled: true,
  muteDuringAd: true,
  adPlaybackRate: 16,
  overlayEnabled: true,
  dismissNuisances: true,
  sponsorBlockEnabled: true,
  sponsorBlockCategories: [
    "sponsor",
    "selfpromo",
    "interaction",
    "intro",
    "outro",
    "music_offtopic",
  ],
  focusWorkMin: 25,
  focusBreakMin: 5,
  debug: false,
};

const BOOL_FIELDS = [
  "enabled",
  "muteDuringAd",
  "overlayEnabled",
  "dismissNuisances",
  "sponsorBlockEnabled",
  "debug",
];

const $ = (id) => document.getElementById(id);

let settings = { ...DEFAULT_SETTINGS };
let savedTimer = null;

function flashSaved() {
  const el = $("saved");
  el.textContent = "Saved ✓";
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (el.textContent = ""), 1200);
}

function formatSaved(seconds) {
  const m = Math.round((seconds || 0) / 60);
  if (m >= 60) return `${Math.floor(m / 60)}h ${m % 60}m`;
  return `${m} min`;
}

async function load() {
  const got = await chrome.storage.sync.get({
    [KEYS.settings]: {},
    [KEYS.quotes]: [],
  });
  settings = { ...DEFAULT_SETTINGS, ...(got[KEYS.settings] || {}) };

  for (const f of BOOL_FIELDS) $(f).checked = !!settings[f];
  $("adPlaybackRate").value = settings.adPlaybackRate;
  $("quotes").value = (got[KEYS.quotes] || []).join("\n");

  // SponsorBlock category checkboxes reflect the saved set.
  const active = new Set(settings.sponsorBlockCategories || []);
  for (const [cat] of SB_CATEGORIES) {
    const el = $("sb_" + cat);
    if (el) el.checked = active.has(cat);
  }

  $("focusWorkMin").value = settings.focusWorkMin;
  $("focusBreakMin").value = settings.focusBreakMin;

  const localGot = await chrome.storage.local.get({
    [KEYS.stats]: { count: 0, secondsSaved: 0 },
  });
  const s = localGot[KEYS.stats];
  $("stats").textContent =
    s && (s.count || s.secondsSaved)
      ? `${s.count || 0} ads handled · ~${formatSaved(s.secondsSaved)} saved`
      : "No ads handled yet.";
}

async function saveSettings() {
  await chrome.storage.sync.set({ [KEYS.settings]: settings });
  flashSaved();
}

function bind() {
  for (const f of BOOL_FIELDS) {
    $(f).addEventListener("change", (e) => {
      settings[f] = e.target.checked;
      saveSettings();
    });
  }

  // SponsorBlock categories: any change rebuilds the array from the checkboxes.
  for (const [cat] of SB_CATEGORIES) {
    const el = $("sb_" + cat);
    if (!el) continue;
    el.addEventListener("change", () => {
      settings.sponsorBlockCategories = SB_CATEGORIES.map(([c]) => c).filter(
        (c) => $("sb_" + c) && $("sb_" + c).checked
      );
      saveSettings();
    });
  }

  $("adPlaybackRate").addEventListener("change", (e) => {
    let n = parseInt(e.target.value, 10);
    if (isNaN(n)) n = DEFAULT_SETTINGS.adPlaybackRate;
    n = Math.max(1, Math.min(16, n));
    e.target.value = n;
    settings.adPlaybackRate = n;
    saveSettings();
  });

  // Debounce quote saves while typing.
  let quoteTimer = null;
  $("quotes").addEventListener("input", (e) => {
    clearTimeout(quoteTimer);
    quoteTimer = setTimeout(async () => {
      const quotes = e.target.value
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      await chrome.storage.sync.set({ [KEYS.quotes]: quotes });
      flashSaved();
    }, 400);
  });

  // Focus durations: clamp + persist (content.js reads them as defaults).
  const clampMin = (v, def) => {
    let n = parseInt(v, 10);
    if (isNaN(n)) n = def;
    return Math.max(1, Math.min(180, n));
  };
  $("focusWorkMin").addEventListener("change", (e) => {
    e.target.value = settings.focusWorkMin = clampMin(e.target.value, 25);
    saveSettings();
  });
  $("focusBreakMin").addEventListener("change", (e) => {
    e.target.value = settings.focusBreakMin = clampMin(e.target.value, 5);
    saveSettings();
  });

  const sendToTab = (msg, close) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs && tabs[0];
      if (tab && tab.id != null) {
        chrome.tabs.sendMessage(tab.id, msg).catch(() => {});
      }
      if (close) window.close();
    });
  };

  $("focusStart").addEventListener("click", () => {
    sendToTab(
      {
        type: "watchfree-focus",
        action: "start",
        workMin: settings.focusWorkMin,
        breakMin: settings.focusBreakMin,
      },
      true
    );
  });
  $("focusStop").addEventListener("click", () => {
    sendToTab({ type: "watchfree-focus", action: "stop" }, true);
  });

  $("openPanel").addEventListener("click", () => {
    sendToTab({ type: "watchfree-toggle-panel" }, true);
  });

  $("openDashboard").addEventListener("click", () => {
    chrome.runtime.openOptionsPage();
    window.close();
  });
}

load();
bind();
