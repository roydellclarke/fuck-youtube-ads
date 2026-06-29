// storage.js — persistence layer.
//
// Cross-device data (todos, notes, settings, custom quotes) lives in
// chrome.storage.sync so it follows the user between machines. Stats live in
// chrome.storage.local: they're written once per ad and are device-local by
// nature, which also keeps them clear of sync's write-rate quota.
//
// All content-script files share one isolated-world global scope and load in
// manifest order. Each file hangs its public surface off a single `WatchFree`
// namespace object.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  const sync = chrome.storage.sync;
  const local = chrome.storage.local;

  const KEYS = {
    todos: "watchfree_todos",
    notes: "watchfree_notes",
    settings: "watchfree_settings",
    quotes: "watchfree_quotes",
    stats: "watchfree_stats",
    log: "watchfree_log",
  };

  // The shape getStats() fills missing fields up to. New counters were added
  // over time (sponsor skips, focus minutes, per-day buckets); older stored
  // blobs won't have them, so we always merge over this default.
  function defaultStats() {
    return {
      count: 0, // ads handled
      secondsSaved: 0, // estimated ad-seconds saved
      sponsorCount: 0, // in-video sponsor segments auto-skipped
      sponsorSecondsSaved: 0, // their total duration
      focusMinutes: 0, // focus-session minutes completed
      focusSessions: 0, // completed work sessions
      daily: {}, // 'YYYY-MM-DD' -> day bucket (see statsutil.emptyDay)
    };
  }

  async function get(area, key, fallback) {
    try {
      const result = await area.get({ [key]: fallback });
      return result[key];
    } catch (e) {
      // Extension context can be invalidated on reload; fail soft.
      console.warn("[WatchFree] storage.get failed:", e);
      return fallback;
    }
  }

  async function set(area, key, value) {
    try {
      await area.set({ [key]: value });
    } catch (e) {
      console.warn("[WatchFree] storage.set failed:", e);
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

    // Stats (device-local): see defaultStats() for the shape. Always returned
    // with every field present (old blobs are merged over the default).
    async getStats() {
      const raw = await get(local, KEYS.stats, {});
      return Object.assign(defaultStats(), raw || {});
    },
    saveStats(stats) {
      return set(local, KEYS.stats, stats || defaultStats());
    },

    // Learning log: array of { id, videoId, title, url, t, note, createdAt },
    // newest first. Device-local — a study journal grows unbounded and would
    // blow chrome.storage.sync's per-item / total quotas.
    getLog() {
      return get(local, KEYS.log, []);
    },
    saveLog(entries) {
      return set(local, KEYS.log, Array.isArray(entries) ? entries : []);
    },
    async addLogEntry(entry) {
      const log = await this.getLog();
      log.unshift(entry);
      await this.saveLog(log);
      return entry;
    },
    async deleteLogEntry(id) {
      const log = await this.getLog();
      await this.saveLog(log.filter((e) => e && e.id !== id));
    },
  };
})();
