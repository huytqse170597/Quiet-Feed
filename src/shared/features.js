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
      key: "hideReadReceipts",
      label: "Hide read receipts",
      description: "Try to stop Facebook and Messenger from sending Seen receipts. Encrypted chats and new message formats may not be covered.",
      group: "privacy",
      defaultValue: false,
    },
    {
      key: "hideTypingIndicator",
      label: "Hide typing indicator",
      description: "Try to stop Facebook and Messenger from sharing when you type. Encrypted chats and new message formats may not be covered.",
      group: "privacy",
      defaultValue: false,
    },
    {
      key: "hideStoryViews",
      label: "Hide story views",
      description: "Try to stop Facebook from recording story views. Applies to recognized view requests; it cannot undo views already sent.",
      group: "privacy",
      defaultValue: false,
    },
    {
      key: "downloadVideos",
      label: "Video download buttons",
      description: "Choose SD, HD, or available higher qualities on Facebook videos and reels. Merge video and audio locally.",
      group: "behavior",
      defaultValue: true,
    },
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
      return hostname === "www.facebook.com" || hostname === "web.facebook.com" || hostname === "m.facebook.com";
    } catch {
      return false;
    }
  }

  function isPrivacyUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === "https:" && (
        isFacebookUrl(value) ||
        url.hostname === "messenger.com" ||
        url.hostname === "www.messenger.com"
      );
    } catch {
      return false;
    }
  }

  // The isolated video UI only needs URL validation, not the MAIN-world video
  // extraction helper. Keep this in the mandatory shared settings bootstrap.
  function isMediaUrl(value) {
    if (typeof value !== "string" || value.length > 16384 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && !url.username && !url.password &&
        (!url.port || url.port === "443") &&
        (host === "fbcdn.net" || host.endsWith(".fbcdn.net") ||
          host === "facebook.com" || host.endsWith(".facebook.com"));
    } catch { return false; }
  }

  function videoFilename({ title, author, id, label, kind, date = new Date() } = {}) {
    const clean = (value, limit) => typeof value === "string" ? Array.from(value.normalize("NFC")
      .replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*\u202a-\u202e\u2066-\u2069]/g, " ")
      .replace(/\s+/g, " ").replace(/\.{2,}/g, " ").trim().replace(/^[. ]+|[. ]+$/g, ""))
      .reduce((text, character) => text.length + character.length <= limit ? text + character : text, "").trim() : "";
    const name = clean(title, 70);
    const owner = clean(author, 30);
    const meaningful = name && !/^(facebook video|video|reel|\d+)$/i.test(name) &&
      !/^[A-Za-z0-9_-]{60,}(?:\.mp4)?$/i.test(name);
    const parts = [];
    if (owner) parts.push(owner);
    if (meaningful && name.toLocaleLowerCase() !== owner.toLocaleLowerCase()) parts.push(name);
    if (!parts.length) parts.push(`quietfeed-${date.toISOString().replace("T", "_").replace(/[:.]/g, "-")}`);
    // Never include signed media URLs or Relay's internal record identifiers.
    if (typeof id === "string" && /^\d{1,30}$/.test(id)) parts.push(id);
    const quality = clean(label, 16);
    if (quality && !/^(current file|video|audio)$/i.test(quality)) parts.push(quality);
    let stem = parts.join(" - ").replace(/[. ]+$/g, "");
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    return `${stem}.${kind === "audio" ? "m4a" : "mp4"}`;
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
    isPrivacyUrl,
    isMediaUrl,
    videoFilename,
    createSerialExecutor,
    createLogger,
    pruneDisconnectedEntries,
  });

  global.QuietFeed = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
