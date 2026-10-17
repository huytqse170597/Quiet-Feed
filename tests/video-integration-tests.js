"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const QuietFeed = require("../src/shared/features.js");
const QuietFeedVideo = require("../src/shared/video.js");
const source = fs.readFileSync(path.join(__dirname, "../src/video-background.js"), "utf8");
const token = "12345678-1234-4234-8234-123456789abc";
const jobKey = `quietFeedVideoJob:${token}`;
const extensionId = "quiet-feed-test-extension";
const page = `chrome-extension://${extensionId}/src/download/download.html`;
const now = 1_800_000_000_000;
const sender = { id: extensionId, frameId: 0, url: "https://www.facebook.com/watch/", tab: { id: 5 } };
const request = { url: "https://video.fbcdn.net/video.mp4?signature=abc", filename: "Example.mp4" };

function harness({ enabled = true, failTab = false } = {}) {
  const session = {};
  const downloads = [];
  const tabs = [];
  const removed = [];
  let determineFilename;
  const suggestions = [];
  const chrome = {
    runtime: { id: extensionId, getURL: (relative) => `chrome-extension://${extensionId}/${relative}` },
    storage: {
      local: { async get() { return { [QuietFeed.STORAGE_KEYS.settings]: { downloadVideos: enabled } }; } },
      session: {
        async set(values) { Object.assign(session, values); },
        async get(key) { return key === null ? { ...session } : { [key]: session[key] }; },
        async remove(key) { removed.push(key); delete session[key]; },
      },
    },
    downloads: {
      onDeterminingFilename: { addListener(listener) { determineFilename = listener; } },
      async download(value) {
        downloads.push(value);
        await new Promise((resolve) => determineFilename({ id: 17, url: value.url,
          byExtensionId: extensionId, filename: "AQPGkSZflBoKN2QCK0rcYEO1Ce8h.mp4" },
        (suggestion) => { suggestions.push(suggestion); resolve(); }));
        return 17;
      },
    },
    tabs: { async create(value) { tabs.push(value); if (failTab) throw new Error("Could not open tab"); return { id: 23 }; } },
  };
  const context = vm.createContext({ chrome, QuietFeed, QuietFeedVideo,
    crypto: { randomUUID: () => token }, Date: class extends Date { static now() { return now; } },
  });
  vm.runInContext(source, context, { filename: "video-background.js" });
  return { ...context.QuietFeedDownloads, session, downloads, tabs, removed, suggestions, determineFilename };
}

async function main() {
  const direct = harness();
  const response = await direct.download(request, sender);
  assert.equal(response.downloadId, 17);
  assert.equal(response.ok, true);
  assert.deepEqual(direct.downloads.map((download) => ({ ...download })), [{ ...request, saveAs: false, conflictAction: "uniquify" }]);
  assert.equal(direct.tabs.length, 0);
  assert.equal(Object.keys(direct.session).length, 0);
  assert.deepEqual({ ...direct.suggestions[0] }, { filename: "Example.mp4", conflictAction: "uniquify" });
  let unrelated = "not called";
  direct.determineFilename({ byExtensionId: "other-extension", url: request.url }, (value) => { unrelated = value; });
  assert.equal(unrelated, undefined, "Other extensions' downloads must keep their filenames");
  const blob = { url: `blob:chrome-extension://${extensionId}/abc`, filename: "Merged video.mp4" };
  await direct.saveMerged(blob, { id: extensionId, url: page });
  assert.equal(direct.suggestions[1].filename, blob.filename);
  await assert.rejects(direct.saveMerged(blob, sender), /Invalid merged/);
  await assert.rejects(direct.saveMerged({ ...blob, url: "blob:https://attacker.test/abc" },
    { id: extensionId, url: page }), /Invalid merged/);
  const mobile = harness();
  assert.equal((await mobile.download(request, { ...sender, url: "https://m.facebook.com/watch/" })).ok, true);

  const hostileSenders = [
    { ...sender, id: "another-extension" }, { ...sender, tab: undefined },
    { ...sender, frameId: 1 }, { ...sender, frameId: undefined },
    { ...sender, url: "https://attacker.test/" },
    { ...sender, url: "https://www.facebook.com.attacker.test/" },
    { ...sender, url: undefined },
  ];
  for (const invalidSender of hostileSenders) {
    const blocked = harness();
    await assert.rejects(blocked.download(request, invalidSender), /Facebook tabs/);
    assert.equal(blocked.downloads.length + blocked.tabs.length + Object.keys(blocked.session).length, 0);
  }
  for (const invalidRequest of [
    { ...request, url: "http://video.fbcdn.net/video" },
    { ...request, url: "https://video.fbcdn.net.attacker.test/video" },
    { ...request, url: "https://user@video.fbcdn.net/video" },
    { ...request, audioUrl: "https://attacker.test/audio" },
  ]) {
    const blocked = harness();
    await assert.rejects(blocked.download(invalidRequest, sender), /Invalid/);
    assert.equal(blocked.downloads.length + blocked.tabs.length + Object.keys(blocked.session).length, 0);
  }
  const disabled = harness({ enabled: false });
  await assert.rejects(disabled.download(request, sender), /Enable video download/);
  assert.equal(disabled.downloads.length + disabled.tabs.length + Object.keys(disabled.session).length, 0);

  const mergeRequest = { ...request, audioUrl: "https://video.fbcdn.net/audio.m4a" };
  const merge = harness();
  const merged = await merge.download(mergeRequest, sender);
  assert.equal(merged.tabId, 23);
  assert.equal(merge.downloads.length, 0);
  assert.equal(merge.tabs[0].url, `${page}#${token}`);
  assert.deepEqual({ ...merge.session[jobKey] }, { ...mergeRequest, createdAt: now });
  const extensionSender = { id: extensionId, url: `${page}#${token}` };
  for (const invalidSender of [sender, { ...extensionSender, id: "another-extension" },
    { ...extensionSender, url: `${page}.evil#${token}` }]) {
    await assert.rejects(merge.takeJob({ token }, invalidSender), /Invalid download session/);
    assert.ok(merge.session[jobKey], "Rejected sender must not consume a valid job");
  }
  await assert.rejects(merge.takeJob({ token: "../bad" }, extensionSender), /Invalid download session/);
  assert.ok(merge.session[jobKey]);
  const jobResponse = await merge.takeJob({ token }, extensionSender);
  assert.equal(jobResponse.ok, true);
  assert.equal(jobResponse.job.audioUrl, mergeRequest.audioUrl);
  assert.equal(merge.session[jobKey], undefined);
  await assert.rejects(merge.takeJob({ token }, extensionSender), /expired/);

  merge.session[jobKey] = { ...mergeRequest, createdAt: now };
  const concurrent = await Promise.allSettled([
    merge.takeJob({ token }, extensionSender), merge.takeJob({ token }, extensionSender),
  ]);
  assert.equal(concurrent.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(concurrent.filter((result) => result.status === "rejected").length, 1);

  merge.session[jobKey] = { ...mergeRequest, createdAt: now - 600001 };
  await assert.rejects(merge.takeJob({ token }, extensionSender), /expired/);
  assert.equal(merge.session[jobKey], undefined, "Expired job must be discarded");

  const failed = harness({ failTab: true });
  await assert.rejects(failed.download(mergeRequest, sender), /Could not open tab/);
  assert.equal(failed.session[jobKey], undefined);
  assert.ok(failed.removed.includes(jobKey));
  assert.equal(failed.downloads.length, 0);
  console.log("Video background integration tests passed: download, sender checks, merge jobs, expiry, and cleanup.");
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
