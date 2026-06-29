// statsutil.js — PURE stats math (no chrome, no DOM). Shared by the content
// scripts (controller/sponsorblock/focus write daily buckets) and the dashboard
// options page (reads them to draw charts + streaks). Kept dependency-free so it
// loads safely in both contexts and is trivially unit-testable.
(function () {
  "use strict";

  const NS = (window.WatchFree = window.WatchFree || {});

  // A day bucket. All counters default to 0 so callers can blindly += .
  function emptyDay() {
    return {
      adCount: 0,
      adSeconds: 0, // estimated ad-seconds skipped/burned
      sponsorCount: 0,
      sponsorSeconds: 0, // in-video sponsor seconds auto-skipped
      focusMinutes: 0,
    };
  }

  // 'YYYY-MM-DD' in LOCAL time (so a user's "today" matches their clock).
  function dateKey(d) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${y}-${m}-${day}`;
  }

  // Add `delta` (a partial day bucket) into stats.daily[key], creating it if
  // needed. Mutates and returns stats. Unknown numeric keys are summed too.
  function bumpDaily(stats, key, delta) {
    if (!stats.daily) stats.daily = {};
    const day = stats.daily[key] || emptyDay();
    for (const k in delta) {
      const v = Number(delta[k]) || 0;
      day[k] = (Number(day[k]) || 0) + v;
    }
    stats.daily[key] = day;
    return stats;
  }

  // The keys for the n days ending at `baseDate` (inclusive), oldest first.
  function lastNDays(baseDate, n) {
    const keys = [];
    for (let i = n - 1; i >= 0; i--) {
      const d = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());
      d.setDate(d.getDate() - i);
      keys.push(dateKey(d));
    }
    return keys;
  }

  // A dense series for charting: one filled day bucket per key (zeros where the
  // user had no activity), each tagged with its date key.
  function buildDailySeries(stats, keys) {
    const daily = stats.daily || {};
    return keys.map((k) => Object.assign({ key: k }, emptyDay(), daily[k] || {}));
  }

  // Whether a day bucket recorded any activity at all.
  function dayHasActivity(day) {
    if (!day) return false;
    return (
      (day.adCount || 0) > 0 ||
      (day.sponsorCount || 0) > 0 ||
      (day.focusMinutes || 0) > 0
    );
  }

  // Current daily streak: consecutive active days counting back from today. If
  // today has no activity yet we still count a streak ending yesterday, so the
  // number doesn't drop to 0 first thing in the morning.
  function computeStreak(stats, baseDate) {
    const daily = stats.daily || {};
    const start = new Date(baseDate.getFullYear(), baseDate.getMonth(), baseDate.getDate());

    // Anchor: today if active, else yesterday (grace), else streak is 0.
    let cursor = new Date(start);
    if (!dayHasActivity(daily[dateKey(cursor)])) {
      cursor.setDate(cursor.getDate() - 1);
      if (!dayHasActivity(daily[dateKey(cursor)])) return 0;
    }

    let streak = 0;
    while (dayHasActivity(daily[dateKey(cursor)])) {
      streak++;
      cursor.setDate(cursor.getDate() - 1);
    }
    return streak;
  }

  // Headline totals for the dashboard summary cards.
  function summarize(stats) {
    const round = (n) => Math.round(n || 0);
    return {
      ads: round(stats.count),
      adMinutes: round((stats.secondsSaved || 0) / 60),
      sponsorCount: round(stats.sponsorCount),
      sponsorMinutes: round((stats.sponsorSecondsSaved || 0) / 60),
      focusMinutes: round(stats.focusMinutes),
      focusSessions: round(stats.focusSessions),
    };
  }

  // CSV of a daily series (one row per day). Header + rows, no trailing newline.
  function seriesToCsv(series) {
    const cols = ["key", "adCount", "adSeconds", "sponsorCount", "sponsorSeconds", "focusMinutes"];
    const header = ["date", "adCount", "adSeconds", "sponsorCount", "sponsorSeconds", "focusMinutes"].join(",");
    const rows = (series || []).map((d) => cols.map((c) => d[c] != null ? d[c] : 0).join(","));
    return [header].concat(rows).join("\n");
  }

  // Bar-chart geometry for inline SVG: maps values → {x,y,w,h} rects inside a
  // width×height box. Heights scale to `max` (defaults to the largest value, or
  // 1 so an all-zero series draws nothing rather than dividing by zero).
  function barLayout(values, opts) {
    opts = opts || {};
    const width = opts.width || 100;
    const height = opts.height || 100;
    const gap = opts.gap != null ? opts.gap : 2;
    const n = values.length;
    if (!n) return [];
    const max = opts.max != null ? opts.max : Math.max(1, ...values.map((v) => v || 0));
    const barW = (width - gap * (n - 1)) / n;
    return values.map((v, i) => {
      const h = max > 0 ? ((v || 0) / max) * height : 0;
      return { x: i * (barW + gap), y: height - h, w: barW, h: h };
    });
  }

  NS.statsUtil = {
    emptyDay,
    dateKey,
    bumpDaily,
    lastNDays,
    buildDailySeries,
    dayHasActivity,
    computeStreak,
    summarize,
    seriesToCsv,
    barLayout,
  };
})();
