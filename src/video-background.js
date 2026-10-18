(function initializeVideoDownloads(global) {
  "use strict";
  const jobPrefix = "quietFeedVideoJob:";
  const consumeJob = QuietFeed.createSerialExecutor();
  const filenamePrefix = "quietFeedVideoFilename:";
  const filenameTasks = QuietFeed.createSerialExecutor();

  // Persist before starting: filename determination can precede download() resolving
  // and can wake a fresh service worker after the original worker is suspended.
  async function saveFile(request) {
    const key = filenamePrefix + crypto.randomUUID();
    await chrome.storage.session.set({ [key]: { ...request, createdAt: Date.now() } });
    try {
      return await chrome.downloads.download({ ...request, saveAs: false, conflictAction: "uniquify" });
    } catch (error) {
      await chrome.storage.session.remove(key);
      throw error;
    }
  }
  chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
    if (item.byExtensionId !== chrome.runtime.id) { suggest(); return; }
    filenameTasks(async () => {
      const stored = await chrome.storage.session.get(null);
      const candidates = Object.entries(stored).filter(([key, value]) => key.startsWith(filenamePrefix) &&
        value && value.url === item.url && Date.now() - value.createdAt < 10 * 60 * 1000)
        .sort((a, b) => a[1].createdAt - b[1].createdAt);
      const match = candidates[0];
      if (!match) { suggest(); return; }
      await chrome.storage.session.remove(match[0]);
      suggest({ filename: match[1].filename, conflictAction: "uniquify" });
    }).catch(() => suggest());
    return true;
  });

  async function saveMerged(message, sender) {
    const expected = chrome.runtime.getURL("src/download/download.html");
    if (sender.id !== chrome.runtime.id || sender.url?.split("#")[0] !== expected ||
        typeof message.url !== "string" || !message.url.startsWith(`blob:${chrome.runtime.getURL("")}`)) {
      throw new Error("Invalid merged download");
    }
    const { filename } = QuietFeedVideo.sanitizeDownload({ url: "https://www.facebook.com/", filename: message.filename });
    return { ok: true, downloadId: await saveFile({ url: message.url, filename }) };
  }

  async function download(message, sender) {
    if (sender.id !== chrome.runtime.id || !sender.tab || sender.frameId !== 0 ||
        !QuietFeed.isFacebookUrl(sender.url || "")) {
      throw new Error("Downloads are accepted only from Facebook tabs.");
    }
    const stored = await chrome.storage.local.get(QuietFeed.STORAGE_KEYS.settings);
    if (!QuietFeed.mergeSettings(stored[QuietFeed.STORAGE_KEYS.settings]).downloadVideos) {
      throw new Error("Enable video download buttons in Quiet Feed settings first.");
    }
    const request = QuietFeedVideo.sanitizeDownload(message);
    if (!message.audioUrl) {
      const downloadId = await saveFile(request);
      return { ok: true, downloadId };
    }
    if (!QuietFeedVideo.isMediaUrl(message.audioUrl)) throw new Error("Invalid audio URL");
    const token = crypto.randomUUID();
    const key = jobPrefix + token;
    await chrome.storage.session.set({ [key]: { ...request, audioUrl: message.audioUrl, createdAt: Date.now() } });
    try {
      const tab = await chrome.tabs.create({ url: chrome.runtime.getURL("src/download/download.html") + "#" + token });
      return { ok: true, tabId: tab.id };
    } catch (error) {
      await chrome.storage.session.remove(key);
      throw error;
    }
  }

  async function takeJob(message, sender) {
    const expected = chrome.runtime.getURL("src/download/download.html");
    if (sender.id !== chrome.runtime.id || sender.url?.split("#")[0] !== expected ||
        typeof message.token !== "string" || !/^[a-f0-9-]{36}$/.test(message.token)) {
      throw new Error("Invalid download session");
    }
    return consumeJob(async () => {
      const key = jobPrefix + message.token;
      const stored = await chrome.storage.session.get(key);
      await chrome.storage.session.remove(key);
      const job = stored[key];
      if (!job || Date.now() - job.createdAt > 10 * 60 * 1000) throw new Error("Download session expired. Try again from the video.");
      return { ok: true, job };
    });
  }

  global.QuietFeedDownloads = { download, takeJob, saveMerged };
})(globalThis);
