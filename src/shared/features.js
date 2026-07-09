(function initializeQuietFeedShared(global) {
  "use strict";

  const STORAGE_KEYS = Object.freeze({
    settings: "quietFeedSettings",
    stats: "quietFeedStats",
    schema: "quietFeedSchemaVersion",
    popupTab: "quietFeedPopupTab",
  });

  const SCHEMA_VERSION = 2;

  const FEATURES = Object.freeze([
    {
      key: "cleanMode",
      label: "Clean mode",
      description: "Hide filtered cards completely instead of leaving placeholders.",
      group: "behavior",
      defaultValue: false,
    },
    {
      key: "showIndicator",
      label: "Show status indicator",
      description: "Show a small badge on Facebook confirming Quiet Feed is active.",
      group: "behavior",
      defaultValue: true,
    },
    {
      key: "removeReels",
      label: "Remove reels",
      description: "Hide reel shelves and reel posts from the feed.",
      group: "feed",
      defaultValue: true,
    },
    {
      key: "allowFriendsReels",
      label: "Allow friends' reels",
      description: "Keep individual reel posts while still hiding reel recommendation shelves.",
      group: "feed",
      defaultValue: false,
      dependsOn: "removeReels",
    },
    {
      key: "removeSponsored",
      label: "Remove sponsored posts",
      description: "Hide sponsored feed cards and advertisements.",
      group: "feed",
      defaultValue: true,
    },
    {
      key: "removeSuggested",
      label: "Remove suggested content",
      description: "Hide Suggested for you and similar recommendation cards.",
      confirmation:
        "Remove suggested content can hide a large amount of content from your News Feed.\n\nDo you want to continue?",
      group: "feed",
      defaultValue: false,
    },
    {
      key: "removeMarketplaceAds",
      label: "Remove Marketplace ads",
      description: "Hide sponsored listings while browsing Marketplace.",
      group: "feed",
      defaultValue: true,
    },
    {
      key: "removeSearchAds",
      label: "Remove search ads",
      description: "Hide sponsored cards in Facebook search results.",
      group: "feed",
      defaultValue: true,
    },
    {
      key: "removeStories",
      label: "Remove stories",
      description: "Hide the stories tray at the top of the feed.",
      group: "distractions",
      defaultValue: false,
    },
    {
      key: "removeGroupSuggestions",
      label: "Remove group suggestions",
      description: "Hide groups Facebook recommends joining.",
      group: "distractions",
      defaultValue: false,
    },
    {
      key: "removePeopleSuggestions",
      label: "Remove people suggestions",
      description: "Hide People you may know cards.",
      group: "distractions",
      defaultValue: false,
    },
    {
      key: "removeBirthdays",
      label: "Remove birthday reminders",
      description: "Hide birthday reminders in the right rail.",
      group: "distractions",
      defaultValue: false,
    },
    {
      key: "removeNotifications",
      label: "Remove popup notifications",
      description: "Hide temporary notification toasts shown over the page.",
      group: "distractions",
      defaultValue: false,
    },
  ]);

  const DEFAULT_SETTINGS = Object.freeze(
    Object.fromEntries(FEATURES.map((feature) => [feature.key, feature.defaultValue])),
  );

  const DEFAULT_STATS = Object.freeze({
    reels: 0,
    suggested: 0,
    sponsored: 0,
    custom: 0,
  });

  function mergeSettings(value) {
    const input = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
      FEATURES.map((feature) => [
        feature.key,
        typeof input[feature.key] === "boolean"
          ? input[feature.key]
          : feature.defaultValue,
      ]),
    );
  }

  function mergeStats(value) {
    const input = value && typeof value === "object" ? value : {};
    return Object.fromEntries(
      Object.keys(DEFAULT_STATS).map((key) => [
        key,
        Number.isFinite(input[key]) && input[key] >= 0 ? Math.floor(input[key]) : 0,
      ]),
    );
  }

  function isFeatureKey(key) {
    return FEATURES.some((feature) => feature.key === key);
  }

  function sanitizeFeatureChanges(value) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const entries = Object.entries(value);
    if (
      entries.length === 0 ||
      entries.some(([key, enabled]) => !isFeatureKey(key) || typeof enabled !== "boolean")
    ) {
      return null;
    }
    return Object.fromEntries(entries);
  }

  function isFacebookUrl(url) {
    try {
      const hostname = new URL(url).hostname;
      return hostname === "www.facebook.com" || hostname === "web.facebook.com";
    } catch {
      return false;
    }
  }

  function createSerialExecutor() {
    let tail = Promise.resolve();

    return function runSerially(operation) {
      const result = tail.then(operation);
      tail = result.catch(() => undefined);
      return result;
    };
  }

  function createLogger(namespace) {
    const prefix = `[QuietFeed${namespace ? `:${namespace}` : ""}]`;
    return {
      debug(...args) { console.debug(prefix, ...args); },
      info(...args) { console.info(prefix, ...args); },
      warn(...args) { console.warn(prefix, ...args); },
      error(...args) { console.error(prefix, ...args); },
    };
  }

  function pruneDisconnectedEntries(entries, onPrune) {
    let pruned = 0;
    entries.forEach((value, element) => {
      if (element?.isConnected) return;
      onPrune?.(value, element);
      entries.delete(element);
      pruned += 1;
    });
    return pruned;
  }

  const api = Object.freeze({
    STORAGE_KEYS,
    SCHEMA_VERSION,
    FEATURES,
    DEFAULT_SETTINGS,
    DEFAULT_STATS,
    mergeSettings,
    mergeStats,
    isFeatureKey,
    sanitizeFeatureChanges,
    isFacebookUrl,
    createSerialExecutor,
    createLogger,
    pruneDisconnectedEntries,
  });

  global.QuietFeed = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
