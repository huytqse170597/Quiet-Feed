(function initializeDownloadPage() {
  "use strict";
  QuietFeedUI.loadAndApplyTheme();
  document.getElementById("theme-toggle-mount").append(QuietFeedUI.createThemeToggle());
  const status = document.getElementById("status");
  const progress = document.getElementById("progress");
  const cancel = document.getElementById("cancel");
  const retry = document.getElementById("retry");
  const save = document.getElementById("save");
  let worker;
  let objectUrl;
  let job;
  let downloadId;
  let finished = false;

  function stop() { worker?.terminate(); worker = null; }
  function release() { if (objectUrl) URL.revokeObjectURL(objectUrl); objectUrl = null; }
  window.addEventListener("pagehide", () => { stop(); release(); });
  cancel.addEventListener("click", () => {
    stop();
    if (downloadId !== undefined && !finished) chrome.downloads.cancel(downloadId).catch(() => {});
    status.textContent = "Cancelled. You can retry or close this tab.";
    document.body.dataset.state = "cancelled";
    cancel.hidden = true;
    retry.hidden = !job;
    progress.hidden = true;
  });
  retry.addEventListener("click", run);
  chrome.downloads.onChanged.addListener((delta) => {
    if (delta.id !== downloadId) return;
    if (delta.state?.current === "complete") {
      finished = true;
      document.body.dataset.state = "complete";
      status.textContent = "Video saved. You can close this tab.";
      cancel.hidden = true;
    } else if (delta.state?.current === "interrupted") {
      document.body.dataset.state = "error";
      status.textContent = "Saving was interrupted. Use Save video again to retry.";
      cancel.hidden = true;
    }
  });

  chrome.runtime.sendMessage({ type: "QFV_TAKE_JOB", token: location.hash.slice(1) }).then((response) => {
    if (!response?.ok) throw new Error(response?.error || "Missing download session");
    job = response.job;
    document.getElementById("filename").textContent = job.filename;
    history.replaceState(null, "", location.pathname);
    run();
  }).catch(fail);

  function fail(error) {
    document.body.dataset.state = "error";
    stop();
    status.textContent = `${error.message || error} Play the video again if its media link has expired.`;
    progress.hidden = true;
    cancel.hidden = true;
    retry.hidden = !job;
  }

  function run() {
    document.body.dataset.state = "working";
    stop(); release();
    finished = false; downloadId = undefined;
    cancel.hidden = false; retry.hidden = true; save.hidden = true; progress.hidden = false;
    progress.removeAttribute("value");
    status.textContent = "Fetching video and audio…";
    worker = new Worker("merge-worker.js", { type: "module" });
    worker.onerror = (event) => fail(new Error(event.message || "Video worker failed"));
    worker.onmessage = async ({ data }) => {
      if (data.error) { fail(new Error(data.error)); return; }
      if (data.status) status.textContent = data.status;
      if (!data.buffer) return;
      stop();
      objectUrl = URL.createObjectURL(new Blob([data.buffer], { type: "video/mp4" }));
      save.href = objectUrl; save.download = job.filename; save.hidden = false;
      progress.value = 1; progress.max = 1;
      status.textContent = "Video ready. Starting download…";
      try {
        const response = await chrome.runtime.sendMessage({ type: "QFV_SAVE_MERGED", url: objectUrl, filename: job.filename });
        if (!response?.ok) throw new Error(response?.error || "Download failed");
        downloadId = response.downloadId;
        status.textContent = "Saving video…";
      } catch (error) { fail(error); }
    };
    worker.postMessage(job);
  }
})();
