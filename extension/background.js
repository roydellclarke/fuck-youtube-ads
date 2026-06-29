// background.js — minimal MV3 service worker.
//
// Holds nothing latency-critical (the whole ad-handling loop is in the content
// script). Its only job is to relay the keyboard command to the content script,
// since chrome.commands is only available in the service worker, not in content
// scripts.
"use strict";

function sendToActiveTab(message) {
  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    const tab = tabs && tabs[0];
    if (tab && tab.id != null) {
      // The content script may not be present (non-YouTube tab); ignore errors.
      chrome.tabs.sendMessage(tab.id, message).catch(() => {});
    }
  });
}

chrome.commands.onCommand.addListener((command) => {
  if (command === "toggle-panel") {
    sendToActiveTab({ type: "watchfree-toggle-panel" });
  }
});
