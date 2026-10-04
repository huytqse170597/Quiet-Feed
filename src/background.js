"use strict";

// Absolute (extension-root) path: resolves regardless of where this worker lives,
// so a path/base difference can never abort service worker registration.
importScripts("/src/shared/features.js");

const {
  STORAGE_KEYS,
  SCHEMA_VERSION,
  DEFAULT_SETTINGS,
  DEFAULT_STATS,
  mergeSettings,
  mergeStats,
  isFeatureKey,
  sanitizeFeatureChanges,
  isFacebookUrl,
  createSerialExecutor,
  createLogger,
} = QuietFeed;

const log = createLogger("bg");

const runStorageMutation = createSerialExecutor();

let lastFilterStatus;

const LOG_CATEGORIES = new Set(["reels", "suggested", "sponsored", "custom"]);
const MAX_LOG_ENTRIES = 100;

function sanitizeLogEntries(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(
      (entry) =>
        entry &&
        typeof entry === "object" &&
        LOG_CATEGORIES.has(entry.category) &&
        typeof entry.text === "string",
    )
    .map((entry) => ({
      ts: Number(entry.ts) || Date.now(),
      category: entry.category,
      text: String(entry.text).slice(0, 120),
      url: typeof entry.url === "string" ? entry.url.slice(0, 300) : null,
      author: typeof entry.author === "string" ? entry.author.slice(0, 80) : null,
    }));
}

function ensureStorage() {
  return runStorageMutation(async () => {
    const stored = await chrome.storage.local.get([
      STORAGE_KEYS.settings,
      STORAGE_KEYS.stats,
      STORAGE_KEYS.schema,
    ]);

    const settings = mergeSettings(stored[STORAGE_KEYS.settings]);
    const stats = mergeStats(stored[STORAGE_KEYS.stats]);

    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: settings,
      [STORAGE_KEYS.stats]: stats,
      [STORAGE_KEYS.schema]: SCHEMA_VERSION,
    });

    await updateBadge(stats);
    return { settings, stats };
  });
}

async function getState() {
  const stored = await chrome.storage.local.get([
    STORAGE_KEYS.settings,
    STORAGE_KEYS.stats,
  ]);
  return {
    settings: mergeSettings(stored[STORAGE_KEYS.settings]),
    stats: mergeStats(stored[STORAGE_KEYS.stats]),
  };
}

function setFeature(key, value) {
  if (!isFeatureKey(key) || typeof value !== "boolean") {
    return Promise.reject(new Error("Invalid feature update"));
  }
  return runStorageMutation(async () => {
    const { settings } = await getState();
    settings[key] = value;
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    return settings;
  });
}

function setFeatures(value) {
  const changes = sanitizeFeatureChanges(value);
  if (!changes) return Promise.reject(new Error("Invalid feature updates"));
  return runStorageMutation(async () => {
    const { settings } = await getState();
    Object.assign(settings, changes);
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    return settings;
  });
}

function incrementStats(delta, logEntries) {
  const entries = sanitizeLogEntries(logEntries);
  return runStorageMutation(async () => {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.stats, "quietFeedLog"]);
    const stats = mergeStats(stored[STORAGE_KEYS.stats]);
    for (const key of Object.keys(DEFAULT_STATS)) {
      const increment = Number(delta?.[key]);
      if (Number.isFinite(increment) && increment > 0) {
        stats[key] += Math.min(Math.floor(increment), 1000);
      }
    }
    const writes = { [STORAGE_KEYS.stats]: stats };
    if (entries.length > 0) {
      const existing = Array.isArray(stored.quietFeedLog) ? stored.quietFeedLog : [];
      const nextLog = existing.concat(entries);
      if (nextLog.length > MAX_LOG_ENTRIES) nextLog.splice(0, nextLog.length - MAX_LOG_ENTRIES);
      writes.quietFeedLog = nextLog;
    }
    await chrome.storage.local.set(writes);
    return stats;
  });
}

function resetStats() {
  return runStorageMutation(async () => {
    const stats = { ...DEFAULT_STATS };
    await chrome.storage.local.set({ [STORAGE_KEYS.stats]: stats });
    return stats;
  });
}

function resetSettings() {
  return runStorageMutation(async () => {
    const settings = { ...DEFAULT_SETTINGS };
    await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    return settings;
  });
}

function importState(value) {
  return runStorageMutation(async () => {
    const settings = mergeSettings(value?.settings);
    const stats = mergeStats(value?.stats);
    await chrome.storage.local.set({
      [STORAGE_KEYS.settings]: settings,
      [STORAGE_KEYS.stats]: stats,
    });
    return { settings, stats };
  });
}

async function updateBadge(stats, status) {
  if (status !== undefined) lastFilterStatus = status;
  const effective = status !== undefined ? status : lastFilterStatus;
  const total = Object.values(stats).reduce((sum, value) => sum + value, 0);
  const color = effective === "advanced" ? "#42b72a" : effective === "fallback" ? "#2374e1" : "#0099ff";
  await chrome.action.setBadgeBackgroundColor({ color });
  await chrome.action.setBadgeText({ text: total > 0 ? compactNumber(total) : "" });
}

function compactNumber(value) {
  if (value >= 1_000_000) return `${Math.floor(value / 100_000) / 10}m`;
  if (value >= 1_000) return `${Math.floor(value / 100) / 10}k`;
  return String(value);
}

function getFacebookTabs() {
  return chrome.tabs.query({
    url: ["https://www.facebook.com/*", "https://web.facebook.com/*"],
  });
}

async function reloadFacebookTabs() {
  const tabs = await getFacebookTabs();
  const tabIds = tabs.map((tab) => tab.id).filter(Number.isInteger);
  if (tabIds.length === 0) {
    return { reloaded: false, reason: "Open Facebook in a tab first." };
  }
  await Promise.all(tabIds.map((tabId) => chrome.tabs.reload(tabId)));
  return { reloaded: true, count: tabIds.length };
}

async function getFilterHealth() {
  const tabs = await getFacebookTabs();
  if (tabs.length === 0) {
    return { status: "inactive", label: "No Facebook tabs open", tabCount: 0 };
  }

  const reports = await Promise.all(
    tabs.map(async (tab) => {
      if (!Number.isInteger(tab.id)) return null;
      try {
        return await chrome.tabs.sendMessage(tab.id, { type: "QF_GET_FILTER_STATUS" });
      } catch {
        return null;
      }
    }),
  );
  const statuses = reports.map((report) => report?.status).filter(Boolean);
  if (statuses.includes("fallback")) {
    return { status: "fallback", label: "DOM fallback active", tabCount: tabs.length };
  }
  if (statuses.includes("advanced")) {
    return { status: "advanced", label: "Advanced filters active", tabCount: tabs.length };
  }
  return { status: "waiting", label: "Filters starting…", tabCount: tabs.length };
}

function ensureSessionAccess() {
  // chrome.storage.session is optional; a missing API must never abort worker
  // registration, since it only degrades session-scoped reveal persistence.
  return chrome.storage.session
    ?.setAccessLevel?.({ accessLevel: "TRUSTED_AND_UNTRUSTED_CONTEXTS" })
    ?.catch(() => {});
}

chrome.runtime.onInstalled.addListener(() => {
  ensureSessionAccess();
  ensureStorage().catch(log.error);
});

chrome.runtime.onStartup.addListener(() => {
  ensureSessionAccess();
  ensureStorage().catch(log.error);
});

// chrome.commands only exists when the manifest declares a "commands" key, so
// guard it: a manifest/code mismatch must never abort service worker registration.
chrome.commands?.onCommand?.addListener((command) => {
  if (command === "toggle-clean-mode") {
    runStorageMutation(async () => {
      const { settings } = await getState();
      settings.cleanMode = !settings.cleanMode;
      await chrome.storage.local.set({ [STORAGE_KEYS.settings]: settings });
    }).catch(log.error);
  }
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes[STORAGE_KEYS.stats]) return;
  updateBadge(mergeStats(changes[STORAGE_KEYS.stats].newValue)).catch(log.error);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  const task = handleMessage(message, sender);
  task.then(sendResponse).catch((error) => {
    log.error("Quiet Feed message failed", error);
    sendResponse({ ok: false, error: error.message });
  });
  return true;
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "QF_GET_STATE":
      return { ok: true, ...(await getState()) };
    case "QF_SET_FEATURE":
      return { ok: true, settings: await setFeature(message.key, message.value) };
    case "QF_SET_FEATURES":
      return { ok: true, settings: await setFeatures(message.value) };
    case "QF_INCREMENT_STATS":
      if (!sender.tab || !isFacebookUrl(sender.tab.url || "")) {
        throw new Error("Counter updates are accepted only from Facebook tabs.");
      }
      return { ok: true, stats: await incrementStats(message.delta, message.entries) };
    case "QF_RESET_STATS":
      return { ok: true, stats: await resetStats() };
    case "QF_RESET_SETTINGS":
      return { ok: true, settings: await resetSettings() };
    case "QF_IMPORT_STATE":
      return { ok: true, ...(await importState(message.value)) };
    case "QF_GET_FILTER_HEALTH":
      return { ok: true, ...(await getFilterHealth()) };
    case "QF_RELOAD_FACEBOOK_TABS":
      return { ok: true, ...(await reloadFacebookTabs()) };
    case "QF_OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case "QF_SET_FILTER_STATUS": {
      const stored = await chrome.storage.local.get(STORAGE_KEYS.stats);
      await updateBadge(mergeStats(stored[STORAGE_KEYS.stats]), message.status);
      return { ok: true };
    }
    default:
      throw new Error("Unknown Quiet Feed message");
  }
}

ensureSessionAccess();
ensureStorage().catch(log.error);
