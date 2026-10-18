(function installChromeMock() {
  "use strict";

  const settings = {
    cleanMode: false,
    showIndicator: true,
    removeReels: true,
    allowFriendsReels: false,
    removeSponsored: true,
    removeSuggested: false,
    removeMarketplaceAds: true,
    removeSearchAds: true,
    removeStories: false,
    removeGroupSuggestions: false,
    removePeopleSuggestions: false,
    removeBirthdays: false,
    removeNotifications: false,
  };
  const stats = { reels: 12, suggested: 3, sponsored: 8, custom: 2 };
  const store = { quietFeedSettings: settings, quietFeedStats: stats };
  const messages = [];
  const storageListeners = [];

  function notifyStorage(key, oldValue, newValue) {
    const changes = { [key]: { oldValue, newValue } };
    storageListeners.forEach((listener) => listener(changes, "local"));
  }

  async function sendMessage(message) {
    messages.push(structuredClone(message));
    await new Promise((resolve) => setTimeout(resolve, 35));
    switch (message.type) {
      case "QF_GET_STATE":
        return { ok: true, settings: { ...settings }, stats: { ...stats } };
      case "QF_SET_FEATURE": {
        const oldValue = { ...settings };
        settings[message.key] = message.value;
        notifyStorage("quietFeedSettings", oldValue, { ...settings });
        return { ok: true, settings: { ...settings } };
      }
      case "QF_SET_FEATURES": {
        if (window.__quietFeedTest.rejectBatchUpdates) {
          return { ok: false, error: "Unknown Quiet Feed message" };
        }
        const oldValue = { ...settings };
        Object.assign(settings, message.value);
        notifyStorage("quietFeedSettings", oldValue, { ...settings });
        return { ok: true, settings: { ...settings } };
      }
      case "QF_GET_FILTER_HEALTH":
        return { ok: true, status: "advanced", label: "Advanced filters active", tabCount: 2 };
      case "QF_RELOAD_FACEBOOK_TABS":
      case "QF_RELOAD_PRIVACY_TABS":
        return { ok: true, reloaded: true, count: 2 };
      case "QF_OPEN_OPTIONS":
        return { ok: true };
      default:
        return { ok: false, error: `Unhandled mock message: ${message.type}` };
    }
  }

  window.chrome = {
    runtime: {
      getManifest: () => ({ version: "2.1.0" }),
      sendMessage,
    },
    storage: {
      local: {
        async get(key) {
          if (typeof key === "string") return { [key]: store[key] };
          return { ...store };
        },
        async set(values) {
          Object.entries(values).forEach(([key, value]) => {
            const oldValue = store[key];
            store[key] = value;
            notifyStorage(key, oldValue, value);
          });
        },
      },
      onChanged: {
        addListener(listener) {
          storageListeners.push(listener);
        },
      },
    },
  };
  window.__quietFeedTest = { messages, settings, store, rejectBatchUpdates: false };
})();
