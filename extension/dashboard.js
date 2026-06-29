// dashboard.js — the options-page stats dashboard + learning-log browser.
//
// Pure data prep (summaries, daily series, streak, bar geometry, search,
// Markdown export) lives in statsutil.js / learninglog.js and is unit-tested;
// this file is the view layer: it reads storage, draws inline SVG charts, lists
// the log, and wires search / delete / export. No external chart library (the
// extension ships no dependencies and an options page has no relaxed CSP need).
"use strict";

const NS = window.WatchFree;
const SVG_NS = "http://www.w3.org/2000/svg";
const $ = (id) => document.getElementById(id);

const CHART_W = 600;
const CHART_H = 120;

let logCache = []; // last-loaded log, so search filters without refetching

function download(filename, text, mime) {
  const blob = new Blob([text], { type: mime || "text/plain" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the download a tick to start before revoking.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function card(value, label, cls) {
  const c = document.createElement("div");
  c.className = "card" + (cls ? " " + cls : "");
  const n = document.createElement("div");
  n.className = "n";
  n.textContent = String(value);
  const l = document.createElement("div");
  l.className = "l";
  l.textContent = label;
  c.appendChild(n);
  c.appendChild(l);
  return c;
}

function renderCards(stats) {
  const s = NS.statsUtil.summarize(stats);
  const streak = NS.statsUtil.computeStreak(stats, new Date());
  const cards = $("cards");
  cards.textContent = "";
  cards.appendChild(card(s.ads, "Ads handled", "accent"));
  cards.appendChild(card(s.adMinutes + " min", "Ad time saved", "accent"));
  cards.appendChild(card(s.sponsorCount, "Sponsor segments skipped"));
  cards.appendChild(card(s.sponsorMinutes + " min", "Sponsor time saved"));
  cards.appendChild(card(s.focusMinutes + " min", `Focus (${s.focusSessions} sessions)`));
  cards.appendChild(card(streak + (streak === 1 ? " day" : " days"), "Current streak", "streak"));
}

function renderBars(svg, values, color) {
  while (svg.firstChild) svg.removeChild(svg.firstChild);
  const layout = NS.statsUtil.barLayout(values, {
    width: CHART_W,
    height: CHART_H,
    gap: 2,
  });
  layout.forEach((b) => {
    if (b.h <= 0) return;
    const rect = document.createElementNS(SVG_NS, "rect");
    rect.setAttribute("x", b.x.toFixed(2));
    rect.setAttribute("y", b.y.toFixed(2));
    rect.setAttribute("width", Math.max(0.5, b.w).toFixed(2));
    rect.setAttribute("height", b.h.toFixed(2));
    rect.setAttribute("rx", "1");
    rect.setAttribute("fill", color);
    svg.appendChild(rect);
  });
}

function shortDate(key) {
  return key ? key.slice(5).replace("-", "/") : "";
}

function renderCharts(stats) {
  const keys = NS.statsUtil.lastNDays(new Date(), 30);
  const series = NS.statsUtil.buildDailySeries(stats, keys);

  const saved = series.map((d) => (d.adSeconds || 0) + (d.sponsorSeconds || 0));
  const focus = series.map((d) => d.focusMinutes || 0);

  renderBars($("chartSaved"), saved, "#6f7dff");
  renderBars($("chartFocus"), focus, "#4ccf7e");

  $("maxSaved").textContent = "peak " + Math.round(Math.max(0, ...saved)) + "s";
  $("maxFocus").textContent = "peak " + Math.round(Math.max(0, ...focus)) + "m";
  $("savedStart").textContent = $("focusStart").textContent = shortDate(keys[0]);
  $("savedEnd").textContent = $("focusEnd").textContent = shortDate(keys[keys.length - 1]);
}

function renderLog(entries) {
  const box = $("log");
  box.textContent = "";
  if (!entries.length) {
    const e = document.createElement("div");
    e.className = "empty";
    e.textContent = logCache.length
      ? "No entries match your search."
      : "No notes yet — press Ctrl/⌘+Shift+K while watching to capture one.";
    box.appendChild(e);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement("div");
    row.className = "entry";

    const a = document.createElement("a");
    a.className = "ts";
    a.href = NS.logUtil.jumpUrl(entry);
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = NS.logUtil.formatTimestamp(entry.t);

    const body = document.createElement("div");
    body.className = "body";
    const note = document.createElement("div");
    note.className = "note";
    note.textContent = entry.note || ""; // user data → textContent
    const meta = document.createElement("div");
    meta.className = "meta";
    const when = entry.createdAt ? new Date(entry.createdAt) : null;
    const whenStr = when && !isNaN(when.getTime()) ? " · " + when.toLocaleDateString() : "";
    meta.textContent = (entry.title || "Untitled") + whenStr;
    body.appendChild(note);
    body.appendChild(meta);

    const del = document.createElement("button");
    del.className = "del";
    del.type = "button";
    del.title = "Delete";
    del.textContent = "×";
    del.addEventListener("click", async () => {
      await NS.storage.deleteLogEntry(entry.id);
      logCache = logCache.filter((e) => e.id !== entry.id);
      renderLog(NS.logUtil.search(logCache, $("search").value));
    });

    row.appendChild(a);
    row.appendChild(body);
    row.appendChild(del);
    box.appendChild(row);
  }
}

async function refresh() {
  const [stats, log] = await Promise.all([NS.storage.getStats(), NS.storage.getLog()]);
  logCache = Array.isArray(log) ? log : [];
  renderCards(stats);
  renderCharts(stats);
  renderLog(NS.logUtil.search(logCache, $("search").value));
}

function wire() {
  $("search").addEventListener("input", () => {
    renderLog(NS.logUtil.search(logCache, $("search").value));
  });

  $("exportLogMd").addEventListener("click", () => {
    download("watchfree-learning-log.md", NS.logUtil.exportMarkdown(logCache), "text/markdown");
  });
  $("exportLogJson").addEventListener("click", () => {
    download("watchfree-learning-log.json", JSON.stringify(logCache, null, 2), "application/json");
  });
  $("clearLog").addEventListener("click", async () => {
    if (!logCache.length) return;
    if (!confirm("Delete all " + logCache.length + " learning-log entries?")) return;
    await NS.storage.saveLog([]);
    logCache = [];
    renderLog([]);
  });

  $("exportStatsJson").addEventListener("click", async () => {
    const stats = await NS.storage.getStats();
    download("watchfree-stats.json", JSON.stringify(stats, null, 2), "application/json");
  });
  $("exportStatsCsv").addEventListener("click", async () => {
    const stats = await NS.storage.getStats();
    const keys = Object.keys(stats.daily || {}).sort();
    const series = NS.statsUtil.buildDailySeries(stats, keys);
    download("watchfree-stats.csv", NS.statsUtil.seriesToCsv(series), "text/csv");
  });

  // Live-update if a YouTube tab writes new stats/log while this page is open.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes[NS.storage.KEYS.stats] || changes[NS.storage.KEYS.log])) {
      refresh();
    }
  });
}

wire();
refresh();
