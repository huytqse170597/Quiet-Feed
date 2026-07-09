"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const rules = require(path.join(root, "src", "filter-rules.js"));
const shared = require(path.join(root, "src", "shared", "features.js"));

let passed = 0;
const asynchronousTests = [];

function test(name, callback) {
  try {
    callback();
    passed += 1;
    console.log(`✓ ${name}`);
  } catch (error) {
    console.error(`✗ ${name}`);
    throw error;
  }
}

function asyncTest(name, callback) {
  asynchronousTests.push({ name, callback });
}

const defaults = {
  removeReels: true,
  allowFriendsReels: false,
  removeSponsored: true,
  removeSuggested: true,
  removeMarketplaceAds: true,
  removeSearchAds: true,
  removeGroupSuggestions: true,
  removePeopleSuggestions: true,
};

test("default configuration enables only requested core filters", () => {
  assert.deepEqual(shared.DEFAULT_SETTINGS, {
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
  });
});

test("normalizes Vietnamese accents", () => {
  assert.equal(rules.normalizeText("Được tài trợ"), "đuoc tai tro");
});

test("classifies English sponsored posts", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "Brand name · Sponsored", pathname: "/", hasReelLink: false, reelLinkCount: 0 },
      defaults,
    ),
    "sponsored",
  );
});

test("classifies Vietnamese sponsored posts", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "Nhãn hàng · Được tài trợ", pathname: "/", hasReelLink: false, reelLinkCount: 0 },
      defaults,
    ),
    "sponsored",
  );
});

test("classifies suggested content", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "Suggested for you", pathname: "/", hasReelLink: false, reelLinkCount: 0 },
      defaults,
    ),
    "suggested",
  );
});

test("classifies people suggestions", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "People you may know", pathname: "/", hasReelLink: false, reelLinkCount: 0 },
      defaults,
    ),
    "suggested",
  );
});

test("classifies reel posts when friend reels are not allowed", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "A new video", pathname: "/", hasReelLink: true, reelLinkCount: 1 },
      defaults,
    ),
    "reels",
  );
});

test("keeps individual friend reels when allowed", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "A new video", pathname: "/", hasReelLink: true, reelLinkCount: 1 },
      { ...defaults, allowFriendsReels: true },
    ),
    null,
  );
});

test("keeps ordinary posts", () => {
  assert.equal(
    rules.classifyFeedUnit(
      { text: "A normal post from a friend", pathname: "/", hasReelLink: false, reelLinkCount: 0 },
      defaults,
    ),
    null,
  );
});

test("custom rules match keywords and regex patterns", () => {
  assert.equal(rules.matchesCustomRules("Buy this product now!", [{ type: "keyword", pattern: "buy this" }]), true);
  assert.equal(rules.matchesCustomRules("Nothing here", [{ type: "keyword", pattern: "buy this" }]), false);
  assert.equal(rules.matchesCustomRules("Order #12345 shipped", [{ type: "regex", pattern: "order.*\\d+" }]), true);
  assert.equal(rules.matchesCustomRules("Normal post", [{ type: "regex", pattern: "order.*\\d+" }]), false);
  assert.equal(rules.matchesCustomRules("anything", []), false);
  assert.equal(rules.matchesCustomRules("anything", null), false);
});

test("manifest references existing local resources", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const resources = [
    manifest.background.service_worker,
    manifest.options_page,
    manifest.action.default_popup,
    ...manifest.content_scripts.flatMap((entry) => entry.js),
    ...Object.values(manifest.icons),
    ...Object.values(manifest.action.default_icon),
  ];
  for (const resource of resources) {
    assert.equal(fs.existsSync(path.join(root, resource)), true, `Missing ${resource}`);
  }
  assert.equal("update_url" in manifest, false);
  assert.equal("externally_connectable" in manifest, false);
});

test("all client message types have background handlers", () => {
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  const clients = [
    "src/content.js",
    "src/popup/popup.js",
    "src/options/options.js",
  ].map((file) => fs.readFileSync(path.join(root, file), "utf8"));
  const sent = new Set(
    clients.flatMap((source) => [...source.matchAll(/type:\s*["'](QF_[A-Z_]+)["']/g)].map((match) => match[1])),
  );
  const handled = new Set(
    [...background.matchAll(/case\s+["'](QF_[A-Z_]+)["']/g)].map((match) => match[1]),
  );
  for (const type of sent) assert.equal(handled.has(type), true, `No handler for ${type}`);
});

test("custom rules apply in the React hook engine, not only the DOM fallback", () => {
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  // Rules ride the QFP_SETTINGS relay into MAIN world and are matched there.
  assert.equal(content.includes("QFP_SETTINGS\", settings, pausedUntil, customRules"), true);
  assert.equal(pageHook.includes("customRules"), true);
  assert.equal(pageHook.includes("matchesCustomRules"), true);
  assert.equal(pageHook.includes('removed(content, "custom"'), true);
  // filter-rules.js (single source of matchesCustomRules) must load in the MAIN
  // page-hook content-script entry, before page-hook.js.
  const mainHook = manifest.content_scripts.find(
    (entry) => entry.world === "MAIN" && entry.js.includes("src/page-hook.js"),
  );
  assert.equal(mainHook.js.includes("src/filter-rules.js"), true);
  assert.equal(
    mainHook.js.indexOf("src/filter-rules.js") < mainHook.js.indexOf("src/page-hook.js"),
    true,
  );
});

test("page hook and isolated bridge use matching contracts", () => {
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  for (const type of ["QFP_SETTINGS", "QFP_HOOK_READY", "QFP_HOOK_ACTIVE", "QFP_COUNTS"]) {
    assert.equal(pageHook.includes(type), true, `Page hook missing ${type}`);
    assert.equal(content.includes(type), true, `Content bridge missing ${type}`);
  }
});

test("DOM cleanup releases disconnected entries and their placeholders", () => {
  const connected = { isConnected: true };
  const disconnected = { isConnected: false };
  const removed = [];
  const entries = new Map([
    [connected, "keep"],
    [disconnected, "remove"],
  ]);

  assert.equal(shared.pruneDisconnectedEntries(entries, (value) => removed.push(value)), 1);
  assert.deepEqual([...entries.values()], ["keep"]);
  assert.deepEqual(removed, ["remove"]);
});

test("batch feature updates reject unknown or non-boolean values", () => {
  assert.deepEqual(shared.sanitizeFeatureChanges({ removeReels: false, removeStories: true }), {
    removeReels: false,
    removeStories: true,
  });
  assert.equal(shared.sanitizeFeatureChanges({ unknownFeature: true }), null);
  assert.equal(shared.sanitizeFeatureChanges({ removeReels: "yes" }), null);
  assert.equal(shared.sanitizeFeatureChanges({}), null);
});

asyncTest("serialized mutations cannot overlap and recover after failures", async () => {
  const runSerially = shared.createSerialExecutor();
  const order = [];
  let active = 0;
  let maximumActive = 0;

  const first = runSerially(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push("first:start");
    await new Promise((resolve) => setTimeout(resolve, 10));
    order.push("first:end");
    active -= 1;
  });
  const second = runSerially(async () => {
    active += 1;
    maximumActive = Math.max(maximumActive, active);
    order.push("second");
    active -= 1;
  });

  await Promise.all([first, second]);
  assert.equal(maximumActive, 1);
  assert.deepEqual(order, ["first:start", "first:end", "second"]);
  await assert.rejects(runSerially(async () => Promise.reject(new Error("expected"))));
  assert.equal(await runSerially(async () => "recovered"), "recovered");
});

test("hook polling is bounded and fallback waits for real activity", () => {
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.equal(pageHook.includes("RUNTIME_WAIT_TIMEOUT"), true);
  assert.equal(pageHook.includes("setTimeout(waitForFacebookRuntime"), true);
  assert.equal(pageHook.includes("requestAnimationFrame(waitForFacebookRuntime"), false);
  assert.equal(content.includes('event.data.type === "QFP_HOOK_ACTIVE"'), true);
  assert.equal(content.includes('event.data.type === "QFP_HOOK_READY"'), true);
});

test("setting changes use accessible confirmation and optional counted reload", () => {
  const popup = fs.readFileSync(path.join(root, "src", "popup", "popup.js"), "utf8");
  const popupHtml = fs.readFileSync(path.join(root, "src", "popup", "popup.html"), "utf8");
  const options = fs.readFileSync(path.join(root, "src", "options", "options.js"), "utf8");
  const suggested = shared.FEATURES.find((feature) => feature.key === "removeSuggested");
  assert.equal(suggested.confirmation.includes("large amount of content"), true);
  assert.equal(popup.includes("dialog.showModal()"), true);
  assert.equal(options.includes("dialog.showModal()"), true);
  assert.equal(popupHtml.includes('class="confirmation-dialog"'), true);
  assert.equal(options.includes("confirmSuggestedRemoval(importedSettings)"), true);
  assert.equal(popup.includes('type: "QF_RELOAD_FACEBOOK_TABS"'), true);
  assert.equal(options.includes('type: "QF_RELOAD_FACEBOOK_TABS"'), true);
  assert.equal(popupHtml.includes("Not now"), true);
  assert.equal(options.includes('type: "QF_IMPORT_STATE"'), true);
});

test("filtered items support undo and clients expose filter health", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  const popup = fs.readFileSync(path.join(root, "src", "popup", "popup.js"), "utf8");
  const options = fs.readFileSync(path.join(root, "src", "options", "options.js"), "utf8");
  assert.equal(content.includes('showButton.textContent = "Show this item"'), true);
  assert.equal(content.includes('element.dataset.qfAllowed = "true"'), true);
  assert.equal(pageHook.includes('"Show this item"'), true);
  assert.equal(content.includes("revealedItemKeys.has(itemKey)"), true);
  assert.equal(pageHook.includes("revealedItemKeys.has(itemKey)"), true);
  assert.equal(popup.includes('type: "QF_GET_FILTER_HEALTH"'), true);
  assert.equal(options.includes('type: "QF_GET_FILTER_HEALTH"'), true);
});

test("backup parsing errors stay distinct from import operation errors", () => {
  const options = fs.readFileSync(path.join(root, "src", "options", "options.js"), "utf8");
  assert.equal(options.includes("That file is not a valid Quiet Feed backup."), true);
  assert.equal(options.includes("payload.version !== 1"), true);
  assert.equal(options.includes('error?.message || "Could not import settings."'), true);
});

test("UI scripts reference existing HTML controls", () => {
  for (const surface of ["popup", "options"]) {
    const html = fs.readFileSync(path.join(root, "src", surface, `${surface}.html`), "utf8");
    const script = fs.readFileSync(path.join(root, "src", surface, `${surface}.js`), "utf8");
    const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
    const references = [
      ...script.matchAll(/querySelector\(["']#([^"']+)["']\)/g),
    ].map((match) => match[1]);
    for (const id of references) {
      assert.equal(ids.has(id), true, `${surface}.js references missing #${id}`);
    }
  }
});

test("popup exposes every setting through accessible category tabs", () => {
  const popup = fs.readFileSync(path.join(root, "src", "popup", "popup.js"), "utf8");
  const html = fs.readFileSync(path.join(root, "src", "popup", "popup.html"), "utf8");
  const uiComponents = fs.readFileSync(path.join(root, "src", "shared", "ui-components.js"), "utf8");
  assert.equal(html.includes('role="tablist"'), true);
  assert.equal(html.includes('data-tab="feed"'), true);
  assert.equal(html.includes('data-tab="distractions"'), true);
  assert.equal(popup.includes('["feed", "behavior"]'), true);
  assert.equal(popup.includes('["distractions"]'), true);
  assert.equal(popup.includes('feature.group !== "distractions" || feature.defaultValue'), false);
  assert.equal(popup.includes('event.key === "ArrowRight"'), true);
  assert.equal(popup.includes('type: "QF_SET_FEATURES"'), true);
  assert.equal(popup.includes("unknown quiet feed message"), true);
  assert.equal(popup.includes("STORAGE_KEYS.popupTab"), true);
  assert.equal(popup.includes("pendingKeys.add(key)"), true);
  assert.equal(uiComponents.includes('event.target.closest("label, input, button")'), true);
});

test("DOM fallback scans added subtrees instead of rescanning the document", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.equal(content.includes("new MutationObserver(handleMutations)"), true);
  assert.equal(content.includes("pendingScanRoots.add(node)"), true);
  assert.equal(content.includes("roots.filter((root) => root.isConnected).forEach(scanRoot)"), true);
  assert.equal(content.includes("new MutationObserver(scheduleScan)"), false);
});

test("real-browser popup harness exercises interactive flows", () => {
  for (const file of [
    "tests/browser/chrome-mock.js",
    "tests/browser/popup-test-runner.js",
    "tests/browser/popup-test-server.js",
  ]) {
    assert.equal(fs.existsSync(path.join(root, file)), true, `Missing ${file}`);
  }
  const runner = fs.readFileSync(path.join(root, "tests", "browser", "popup-test-runner.js"), "utf8");
  assert.equal(runner.includes('dataset.testStatus = "passed"'), true);
  assert.equal(runner.includes("Suggested-content dialog opens"), true);
  assert.equal(runner.includes("Toggle locks while saving"), true);
  assert.equal(runner.includes("Description tooltip opens on focus"), true);
});

test("manifest loads primary hooks in MAIN world and fallback in isolation", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "manifest.json"), "utf8"));
  const proxy = manifest.content_scripts.find((entry) =>
    entry.js.includes("src/legacy/facebook-react-hook-runtime.js"),
  );
  const pageHook = manifest.content_scripts.find((entry) => entry.js.includes("src/page-hook.js"));
  const fallback = manifest.content_scripts.find((entry) => entry.js.includes("src/content.js"));
  assert.equal(proxy.world, "MAIN");
  assert.equal(proxy.run_at, "document_start");
  assert.equal(pageHook.world, "MAIN");
  assert.equal(pageHook.run_at, "document_end");
  assert.equal("world" in fallback, false);
});

test("legacy runtime and readable page hook share module targets", () => {
  const runtime = fs.readFileSync(
    path.join(root, "src", "legacy", "facebook-react-hook-runtime.js"),
    "utf8",
  );
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  for (const [readableTarget, runtimeFragment] of [
    ["CometFeedUnitErrorBoundary", "FeedUnitErrorBoundary"],
    ["CometAdsSideFeedUnitItem", "AdsSideFeedUnitItem"],
    ["FBReelsRootWrapper", "FBReelsRootWrapper"],
    ["StoriesTrayRectangularRoot", "StoriesTrayRectangularRoot"],
    ["CometMarketplaceAdCard", "MarketplaceAdCard"],
    ["SearchCometResultsAd", "ResultsAd"],
  ]) {
    assert.equal(runtime.includes(runtimeFragment), true, `Runtime missing ${runtimeFragment}`);
    assert.equal(pageHook.includes(readableTarget), true, `Readable hook missing ${readableTarget}`);
  }
  assert.equal(runtime.includes(".react|quiet-feed"), true);
});

test("createLogger returns structured logger with correct methods", () => {
  const logger = shared.createLogger("test");
  assert.equal(typeof logger.debug, "function");
  assert.equal(typeof logger.info, "function");
  assert.equal(typeof logger.warn, "function");
  assert.equal(typeof logger.error, "function");
  const anonLogger = shared.createLogger();
  assert.equal(typeof anonLogger.info, "function");
});

test("pause is honored by both filter engines", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const pageHook = fs.readFileSync(path.join(root, "src", "page-hook.js"), "utf8");
  // Pause must reach the primary React hook engine, not only the DOM fallback.
  assert.equal(content.includes("pausedUntil"), true);
  assert.equal(content.match(/QFP_SETTINGS", settings, pausedUntil/) !== null, true);
  assert.equal(pageHook.includes("pausedUntil"), true);
  assert.equal(pageHook.includes("Date.now() < pausedUntil"), true);
});

test("schema version is 2", () => {
  assert.equal(shared.SCHEMA_VERSION, 2);
});

test("QF_SET_FILTER_STATUS handler exists in background", () => {
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  assert.equal(background.includes('"QF_SET_FILTER_STATUS"'), true);
});

test("content.js sends QF_SET_FILTER_STATUS for both modes", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.equal(content.includes('status: "advanced"'), true);
  assert.equal(content.includes('status: "fallback"'), true);
});

test("DOM fallback uses IntersectionObserver", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.equal(content.includes("new IntersectionObserver"), true);
  assert.equal(content.includes("intersectionObserver.unobserve"), true);
});

test("DOM fallback starts periodic prune and stops on disconnect", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  assert.equal(content.includes("setInterval"), true);
  assert.equal(content.includes("clearInterval(pruneTimer)"), true);
});

test("filter log entries are serialized through the background worker", () => {
  const content = fs.readFileSync(path.join(root, "src", "content.js"), "utf8");
  const background = fs.readFileSync(path.join(root, "src", "background.js"), "utf8");
  const options = fs.readFileSync(path.join(root, "src", "options", "options.js"), "utf8");
  const optionsHtml = fs.readFileSync(path.join(root, "src", "options", "options.html"), "utf8");
  // Content buffers entries and hands them to the serialized QF_INCREMENT_STATS path;
  // only the background worker writes quietFeedLog, avoiding cross-tab lost writes.
  assert.equal(content.includes("appendFilterLog"), true);
  assert.equal(content.includes("chrome.storage.local.set({ quietFeedLog"), false);
  assert.equal(background.includes("quietFeedLog"), true);
  assert.equal(background.includes("runStorageMutation"), true);
  assert.equal(options.includes("renderFilterLog"), true);
  assert.equal(options.includes("clearFilterLog"), true);
  assert.equal(optionsHtml.includes('id="filter-log"'), true);
  assert.equal(optionsHtml.includes('id="clear-log"'), true);
});

test("feature rows support keyboard activation (Enter/Space)", () => {
  const uiComponents = fs.readFileSync(path.join(root, "src", "shared", "ui-components.js"), "utf8");
  assert.equal(uiComponents.includes('event.key === "Enter"'), true);
  assert.equal(uiComponents.includes('event.key === " "'), true);
  assert.equal(uiComponents.includes('tabindex'), true);
});

test("high-contrast forced-colors support exists in theme.css", () => {
  const theme = fs.readFileSync(path.join(root, "src", "shared", "theme.css"), "utf8");
  assert.equal(theme.includes("forced-colors: active"), true);
  assert.equal(theme.includes("forced-color-adjust"), true);
});

test("source contains no inherited product or store integration", () => {
  const files = walk(root).filter(
    (file) => file !== __filename && /\.(js|json|html|css|md)$/.test(file),
  );
  const source = files.map((file) => fs.readFileSync(file, "utf8")).join("\n").toLowerCase();
  assert.equal(source.includes("esuit.dev"), false);
  assert.equal(source.includes("clients2.google.com/service/update2/crx"), false);
  assert.equal(source.includes("remove-reels-for-facebook"), false);
});

function walk(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    return entry.isDirectory() ? walk(target) : target;
  });
}

async function runAsynchronousTests() {
  for (const { name, callback } of asynchronousTests) {
    try {
      await callback();
      passed += 1;
      console.log(`✓ ${name}`);
    } catch (error) {
      console.error(`✗ ${name}`);
      throw error;
    }
  }
  console.log(`\n${passed} tests passed.`);
}

runAsynchronousTests().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
