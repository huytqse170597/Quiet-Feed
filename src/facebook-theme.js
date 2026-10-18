(function bridgeFacebookTheme() {
  "use strict";
  const key = "quietFeedTheme";
  const system = matchMedia("(prefers-color-scheme: dark)");
  let preference;
  let revision = 0;
  function publish() {
    if (!preference) return;
    document.documentElement.dataset.qfTheme = preference === "system"
      ? system.matches ? "dark" : "light" : preference;
    window.postMessage({ source: "quiet-feed-theme-extension", type: "QFT_SET_THEME", preference }, location.origin);
  }
  function setPreference(value) {
    preference = value === "light" || value === "dark" ? value : "system";
    publish();
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "quiet-feed-theme-page") return;
    if (typeof event.data.version === "string") document.documentElement.dataset.qfNativeThemeVersion = event.data.version.slice(0, 80);
    if (event.data.type === "QFT_READY") publish();
    if (event.data.type === "QFT_STATUS" && ["waiting", "requested", "synced", "unavailable", "reverted"].includes(event.data.status)) {
      document.documentElement.dataset.qfNativeThemeStatus = event.data.status;
      document.documentElement.dataset.qfNativeThemeReason = typeof event.data.reason === "string" ? event.data.reason.slice(0, 80) : "";
    }
  });
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes[key]) return;
    revision++;
    setPreference(changes[key].newValue);
  });
  const initialRevision = revision;
  chrome.storage.local.get(key).then((stored) => {
    if (revision === initialRevision) setPreference(stored[key]);
  }).catch(() => {});
  system.addEventListener("change", () => { if (preference === "system") publish(); });
  window.postMessage({ source: "quiet-feed-theme-extension", type: "QFT_QUERY" }, location.origin);
})();
