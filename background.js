"use strict";

/**
 * unread4me service worker.
 *
 * Sole writer for the read-tweet history, so concurrent x.com tabs cannot clash
 * on a read-modify-write. Every mutation goes through one promise chain.
 */

const TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MAX_ENTRIES = 20000;

let writes = Promise.resolve();

function enqueue(work) {
  const next = writes.then(work, work);
  writes = next.catch(() => {});
  return next;
}

/**
 * The camera button is on exactly while the extension holds access to every
 * site, which it needs for the screenshot. The popup asks for that access, but
 * the browser's prompt can close the popup before the answer reaches it, and
 * the access can also be taken back on the extensions page, so the setting
 * follows the permission from here. Defaults for every other setting live
 * with the content script and the popup, which fill in whatever is missing.
 */
const ALL_SITES = "<all_urls>";

async function setCameraButton(on) {
  const { settings } = await chrome.storage.local.get("settings");
  if ((settings || {}).cameraButton === on) return;
  await chrome.storage.local.set({ settings: { ...(settings || {}), cameraButton: on } });
}

chrome.permissions.onAdded.addListener((permissions) => {
  if (permissions.origins?.includes(ALL_SITES)) setCameraButton(true);
});

chrome.permissions.onRemoved.addListener((permissions) => {
  if (permissions.origins?.includes(ALL_SITES)) setCameraButton(false);
});

async function markRead(ids) {
  const { readTweets } = await chrome.storage.local.get("readTweets");
  const history = readTweets || {};
  const now = Date.now();

  for (const id of ids) {
    if (typeof id === "string" && /^\d+$/.test(id)) history[id] = now;
  }

  const cutoff = now - TTL_MS;
  for (const [id, seen] of Object.entries(history)) {
    if (seen < cutoff) delete history[id];
  }

  const size = Object.keys(history).length;
  if (size > MAX_ENTRIES) {
    const oldestFirst = Object.entries(history).sort((a, b) => a[1] - b[1]);
    for (const [id] of oldestFirst.slice(0, size - MAX_ENTRIES)) delete history[id];
  }

  await chrome.storage.local.set({ readTweets: history });
}

function setBadge(tabId, count) {
  if (tabId === undefined) return;
  chrome.action.setBadgeBackgroundColor({ tabId, color: "#1d9bf0" }).catch(() => {});
  chrome.action
    .setBadgeText({ tabId, text: count > 0 ? String(count) : "" })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  switch (message?.type) {
    case "mark":
      enqueue(() => markRead(message.ids || [])).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: String(error) })
      );
      return true;

    case "forgetAll":
      enqueue(() => chrome.storage.local.set({ readTweets: {} })).then(
        () => sendResponse({ ok: true }),
        (error) => sendResponse({ ok: false, error: String(error) })
      );
      return true;

    case "badge":
      setBadge(sender.tab?.id, message.count || 0);
      return false;

    // Only the service worker can take a screenshot, and only of the whole
    // visible tab. The content script crops it down to the post.
    case "capture":
      chrome.tabs.captureVisibleTab(sender.tab?.windowId, { format: "png" }).then(
        (dataUrl) => sendResponse({ dataUrl }),
        (error) => sendResponse({ error: String(error) })
      );
      return true;

    default:
      return false;
  }
});
