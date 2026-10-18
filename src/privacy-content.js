(function bridgeQuietFeedPrivacy() {
  "use strict";
  const key = QuietFeed.STORAGE_KEYS.settings;
  let settings = null;
  let revision = 0;
  let status = { settingsReady: false, hooks: [] };
  function publish() {
    if (!settings) return;
    window.postMessage({ source: "quiet-feed-privacy-extension", type: "QFP_PRIVACY_SETTINGS",
      settings: { hideReadReceipts: settings.hideReadReceipts,
        hideTypingIndicator: settings.hideTypingIndicator, hideStoryViews: settings.hideStoryViews } }, location.origin);
  }
  // Register before reading storage: a slow initial read must not overwrite a
  // newer toggle, reset, or import from another extension surface.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[key]) return;
    revision++;
    settings = QuietFeed.mergeSettings(changes[key].newValue);
    publish();
  });
  const initialRevision = revision;
  chrome.storage.local.get(key).then((stored) => {
    if (revision !== initialRevision) return;
    settings = QuietFeed.mergeSettings(stored[key]);
    publish();
  }).catch(() => {
    // Keep held signals held if local settings cannot be read.
    console.warn("Quiet Feed privacy settings unavailable. Reload this tab to retry.");
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== "quiet-feed-privacy-page" || event.data.type !== "QFP_PRIVACY_STATUS") return;
    status = { settingsReady: event.data.settingsReady === true,
      hooks: Array.isArray(event.data.hooks) ? event.data.hooks.filter((name) => typeof name === "string").slice(0, 20) : [] };
    if (!status.settingsReady) publish();
  });
  chrome.runtime.onMessage.addListener((message, _sender, respond) => {
    if (message?.type !== "QF_GET_PRIVACY_STATUS") return false;
    respond({ ...status, settingsLoaded: settings !== null });
    return false;
  });
  window.postMessage({ source: "quiet-feed-privacy-extension", type: "QFP_PRIVACY_QUERY" }, location.origin);
})();
