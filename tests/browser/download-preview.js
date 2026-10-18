"use strict";

// Visual preview only; never fetch media or start a real browser download.
chrome.downloads = { onChanged: { addListener: () => {} }, cancel: async () => {} };
chrome.runtime.sendMessage = async () => ({ ok: true, job: { filename: "A quiet afternoon-1080p.mp4" } });
window.Worker = class PreviewWorker {
  postMessage() { this.onmessage({ data: { status: "Combining video and audio locally…" } }); }
  terminate() {}
};
