"use strict";
const responsiveSettings = { ...QuietFeed.DEFAULT_SETTINGS, removeStories: true, removeNotifications: true };
const responsiveListeners = [];
const responsiveMessages = [];
window.chrome = {
  storage: {
    local: { get: async () => ({ quietFeedSettings: responsiveSettings }) },
    session: { get: async () => ({}), set: async () => {} },
    onChanged: { addListener: (listener) => responsiveListeners.push(listener) },
  },
  runtime: {
    onMessage: { addListener: () => {} },
    sendMessage: async (message) => { responsiveMessages.push(message); return { ok: true }; },
  },
};
