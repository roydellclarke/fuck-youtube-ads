// storage.js — persistence layer.
//
// Cross-device data (todos, notes, settings, custom quotes) lives in
// chrome.storage.sync so it follows the user between machines. Stats live in
// chrome.storage.local: they're written once per ad and are device-local by
// nature, which also keeps them clear of sync's write-rate quota.
//
// All content-script files share one isolated-world global scope and load in
// manifest order. Each file hangs its public surface off a single `BlockYT`
// namespace object.
(function () {
  "use strict";

  const NS = (window.BlockYT = window.BlockYT || {});

  const sync = chrome.storage.sync;
  const local = chrome.storage.local;

  const KEYS = {
    todos: "blockyt_todos",
    notes: "blockyt_notes",
    settings: "blockyt_settings",
    quotes: "blockyt_quotes",
    stats: "blockyt_stats",
  };

  async function get(area, key, fallback) {
    try {
      const result = await area.get({ [key]: fallback });
      return result[key];
    } catch (e) {
      // Extension context can be invalidated on reload; fail soft.
      console.warn("[blockYT] storage.get failed:", e);
      return fallback;
    }
  }

  async function set(area, key, value) {
    try {
      await area.set({ [key]: value });
    } catch (e) {
      console.warn("[blockYT] storage.set failed:", e);
    }
  }

  NS.storage = {
    KEYS,

    // Todos: array of { id, text, done }.  (synced)
    getTodos() {
      return get(sync, KEYS.todos, []);
    },
    saveTodos(todos) {
      return set(sync, KEYS.todos, Array.isArray(todos) ? todos : []);
    },

    // Notes: a single free-text string.  (synced)
    getNotes() {
      return get(sync, KEYS.notes, "");
    },
    saveNotes(notes) {
      return set(sync, KEYS.notes, typeof notes === "string" ? notes : "");
    },

    // Settings: user overrides merged over CONFIG defaults.  (synced)
    getSettings() {
      return get(sync, KEYS.settings, {});
    },
    saveSettings(settings) {
      return set(sync, KEYS.settings, settings || {});
    },

    // Custom motivational quotes: array of strings; empty = use built-ins. (synced)
    getQuotes() {
      return get(sync, KEYS.quotes, []);
    },
    saveQuotes(quotes) {
      return set(sync, KEYS.quotes, Array.isArray(quotes) ? quotes : []);
    },

    // Stats: { count, secondsSaved }.  (device-local)
    getStats() {
      return get(local, KEYS.stats, { count: 0, secondsSaved: 0 });
    },
    saveStats(stats) {
      return set(local, KEYS.stats, stats || { count: 0, secondsSaved: 0 });
    },
  };
})();
