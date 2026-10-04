"use strict";

const MODES = new Set(["dim", "hide", "show"]);

const DEFAULT_SETTINGS = {
  mode: "dim",
  dwellMs: 1000,
  dimOpacity: 0.35,
  followingLabel: "Following",
  hideAvatars: true,
  postFirst: true,
  hideMedia: true,
  hideComposer: true,
  hideSidebar: true,
  expandPosts: true,
  hideWhoToFollow: true,
  hideActions: true,
  cards: true,
  firstOfThread: true,
  cameraButton: false,
  debug: false
};

/**
 * Reads the stored shape, migrating the old enabled/revealAll pair to mode.
 * The pair itself is dropped, so the next save leaves it behind.
 */
function normalize(raw) {
  const { enabled, revealAll, ...stored } = raw || {};
  const mode = MODES.has(stored.mode)
    ? stored.mode
    : enabled === false || revealAll === true
      ? "show"
      : "dim";
  return { ...DEFAULT_SETTINGS, ...stored, mode };
}

const els = {
  status: document.getElementById("status"),
  modes: Array.from(document.querySelectorAll('input[name="mode"]')),
  dimRow: document.getElementById("dimRow"),
  dimOpacity: document.getElementById("dimOpacity"),
  dwellMs: document.getElementById("dwellMs"),
  followingLabel: document.getElementById("followingLabel"),
  hideAvatars: document.getElementById("hideAvatars"),
  postFirst: document.getElementById("postFirst"),
  hideMedia: document.getElementById("hideMedia"),
  hideComposer: document.getElementById("hideComposer"),
  hideSidebar: document.getElementById("hideSidebar"),
  expandPosts: document.getElementById("expandPosts"),
  hideWhoToFollow: document.getElementById("hideWhoToFollow"),
  hideActions: document.getElementById("hideActions"),
  cards: document.getElementById("cards"),
  firstOfThread: document.getElementById("firstOfThread"),
  cameraButton: document.getElementById("cameraButton"),
  debug: document.getElementById("debug"),
  remembered: document.getElementById("remembered"),
  markedLabel: document.getElementById("markedLabel"),
  marked: document.getElementById("marked"),
  forget: document.getElementById("forget")
};

let settings = { ...DEFAULT_SETTINGS };

const CAMERA_PERMISSION = { origins: ["<all_urls>"] };

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
}

async function render() {
  const stored = await chrome.storage.local.get(["settings", "readTweets"]);
  settings = normalize(stored.settings);

  for (const radio of els.modes) radio.checked = radio.value === settings.mode;
  // Dim strength is meaningless in show mode, and in hide mode it only affects
  // the brief moment before a read tweet collapses.
  els.dimRow.hidden = settings.mode === "show";
  els.dimOpacity.value = String(settings.dimOpacity);
  els.dwellMs.value = String(settings.dwellMs);
  els.followingLabel.value = settings.followingLabel;
  els.hideAvatars.checked = settings.hideAvatars;
  els.postFirst.checked = settings.postFirst;
  els.hideMedia.checked = settings.hideMedia;
  els.hideComposer.checked = settings.hideComposer;
  els.hideSidebar.checked = settings.hideSidebar;
  els.expandPosts.checked = settings.expandPosts;
  els.hideWhoToFollow.checked = settings.hideWhoToFollow;
  els.hideActions.checked = settings.hideActions;
  els.cards.checked = settings.cards;
  els.firstOfThread.checked = settings.firstOfThread;
  els.cameraButton.checked =
    settings.cameraButton && (await chrome.permissions.contains(CAMERA_PERMISSION));
  els.debug.checked = settings.debug;
  els.remembered.textContent = Object.keys(stored.readTweets || {}).length.toLocaleString();

  const tab = await activeTab();
  let stats = null;
  if (tab?.id !== undefined) {
    stats = await chrome.tabs.sendMessage(tab.id, { type: "stats" }).catch(() => null);
  }

  const hiding = settings.mode === "hide";
  els.markedLabel.textContent = hiding ? "Hidden here" : "Read here";
  const count = stats ? (hiding ? stats.collapsed : stats.marked) : 0;
  els.marked.textContent = count.toLocaleString();

  if (!stats) {
    els.status.textContent = "Open x.com to start filtering.";
    els.status.classList.remove("on");
  } else if (stats.inScope) {
    els.status.textContent = hiding
      ? "Hiding read tweets in the Following feed."
      : "Dimming read tweets in the Following feed.";
    els.status.classList.add("on");
  } else {
    els.status.textContent =
      settings.mode === "show" ? "Showing everything." : "Idle. Switch to the Following tab.";
    els.status.classList.remove("on");
  }
}

for (const radio of els.modes) {
  radio.addEventListener("change", async () => {
    if (!radio.checked) return;
    await save({ mode: radio.value });
    render();
  });
}

els.dimOpacity.addEventListener("change", () =>
  save({ dimOpacity: Number(els.dimOpacity.value) })
);
els.dwellMs.addEventListener("change", () => save({ dwellMs: Number(els.dwellMs.value) }));
els.followingLabel.addEventListener("change", () =>
  save({ followingLabel: els.followingLabel.value.trim() || "Following" })
);
els.hideAvatars.addEventListener("change", () =>
  save({ hideAvatars: els.hideAvatars.checked })
);
els.postFirst.addEventListener("change", () => save({ postFirst: els.postFirst.checked }));
els.hideMedia.addEventListener("change", () => save({ hideMedia: els.hideMedia.checked }));
els.hideComposer.addEventListener("change", () =>
  save({ hideComposer: els.hideComposer.checked })
);
els.hideSidebar.addEventListener("change", () =>
  save({ hideSidebar: els.hideSidebar.checked })
);
els.expandPosts.addEventListener("change", () =>
  save({ expandPosts: els.expandPosts.checked })
);
els.hideWhoToFollow.addEventListener("change", () =>
  save({ hideWhoToFollow: els.hideWhoToFollow.checked })
);
els.hideActions.addEventListener("change", () =>
  save({ hideActions: els.hideActions.checked })
);
els.cards.addEventListener("change", () => save({ cards: els.cards.checked }));
els.firstOfThread.addEventListener("change", () =>
  save({ firstOfThread: els.firstOfThread.checked })
);

// Only the camera button needs access to every site, so that access is asked
// for when the button is turned on, and given back when it is turned off. The
// prompt can close the popup before the answer comes back, so the service
// worker records the outcome as well, from the permission events.
els.cameraButton.addEventListener("change", async () => {
  if (!els.cameraButton.checked) {
    await save({ cameraButton: false });
    await chrome.permissions.remove(CAMERA_PERMISSION);
    return;
  }
  const granted = await chrome.permissions.request(CAMERA_PERMISSION);
  if (granted) await save({ cameraButton: true });
  else els.cameraButton.checked = false;
});
els.debug.addEventListener("change", () => save({ debug: els.debug.checked }));

let armed = false;
els.forget.addEventListener("click", async () => {
  if (!armed) {
    armed = true;
    els.forget.textContent = "Click again to confirm";
    setTimeout(() => {
      armed = false;
      els.forget.textContent = "Forget everything";
    }, 4000);
    return;
  }
  await chrome.runtime.sendMessage({ type: "forgetAll" });
  armed = false;
  els.forget.textContent = "Forget everything";
  render();
});

// Kept current when the service worker changes a setting behind our back.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.settings) render();
});

render();
