(async function runResponsiveTests() {
  "use strict";
  const results = [];
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const check = (condition, message) => { if (!condition) throw new Error(message); results.push(message); };
  async function until(predicate) {
    const deadline = Date.now() + 7000;
    while (!predicate()) { if (Date.now() > deadline) throw new Error("Timed out waiting for responsive fallback"); await wait(40); }
  }
  const originalBody = document.body;
  try {
    await until(() => document.getElementById("sponsored").classList.contains("qf-hidden"));
    check(!document.querySelector("main").classList.contains("qf-hidden"), "Main application and feed remain visible");
    check(!document.getElementById("loading").classList.contains("qf-hidden"), "Loading live region remains visible");
    check(!document.getElementById("ordinary").classList.contains("qf-hidden"), "Ordinary post remains visible");
    check(document.querySelector('[aria-label="Stories"]').classList.contains("qf-hidden"), "Stories are hidden without hiding the root shell");
    // Responsive layouts recycle the same marker with another video ID.
    const marker = document.querySelector("[data-qf-video-id]");
    const firstControl = marker.firstElementChild;
    marker.dataset.qfVideoId = "456";
    await until(() => marker.firstElementChild && marker.firstElementChild !== firstControl);
    check(marker.children.length === 1, "Recycled video markers have one fresh control");
    const nextPost = document.createElement("article");
    nextPost.textContent = "Sponsored post added during loading";
    document.querySelector('[role="feed"]').append(nextPost);
    const churn = setInterval(() => {
      document.getElementById("loading").firstChild.data = `Loading ${Date.now()}`;
    }, 40);
    try { await until(() => nextPost.classList.contains("qf-hidden")); }
    finally { clearInterval(churn); }
    check(true, "Continuous loading mutations do not starve filter scans");
    // Unrelated layout churn must not trigger repeated full-document video scans.
    const queryAll = document.querySelectorAll.bind(document);
    let fullScans = 0;
    document.querySelectorAll = (...args) => { fullScans++; return queryAll(...args); };
    const noise = document.createElement("div");
    document.body.append(noise);
    for (let i = 0; i < 100; i++) noise.append(document.createElement("i"));
    await wait(600);
    document.querySelectorAll = queryAll;
    check(fullScans === 0, "Unrelated mutations do not rescan the whole page for videos");
    // Mobile navigation can replace the body while extension listeners remain.
    const nextBody = document.createElement("body");
    nextBody.innerHTML = '<main><article id="next-sponsored">Sponsored replacement</article><span data-qf-video-id="789"></span></main>';
    originalBody.replaceWith(nextBody);
    await until(() => nextBody.querySelector(".qf-hidden") && nextBody.querySelector("[data-qf-video-control]") && nextBody.querySelector("#qf-indicator"));
    check(true, "Filters, indicator, and video controls recover after body replacement");
    responsiveSettings.downloadVideos = false;
    responsiveListeners.forEach((listener) => listener({ quietFeedSettings: { newValue: responsiveSettings } }, "local"));
    await until(() => !document.querySelector("[data-qf-video-control]"));
    check(true, "Disabling downloads removes controls and observers");
    nextBody.replaceWith(originalBody);
    document.documentElement.dataset.responsiveStatus = "passed";
  } catch (error) {
    if (document.body !== originalBody) document.body.replaceWith(originalBody);
    document.documentElement.dataset.responsiveStatus = "failed";
    results.push(error.stack || error.message);
  }
  document.getElementById("results").textContent = `${document.documentElement.dataset.responsiveStatus.toUpperCase()}\n${results.join("\n")}`;
  document.getElementById("results").style.whiteSpace = "pre-wrap";
})();
