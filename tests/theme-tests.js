"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const source = (file) => fs.readFileSync(path.join(__dirname, "../src", file), "utf8");
function nativeHarness({ unavailable = false, throwSetter = false } = {}) {
  const messages = [], saves = [], timers = [];
  const ThemeContext = { Provider: {} };
  let receive, afterModule, provider, lastTree, dirty = false, rendering = false;
  const native = { currentSetting: "USE_SYSTEM", setDarkModeSetting(value) {
    assert.equal(rendering, false, "Never save or set React state during provider render");
    saves.push(value);
    if (throwSetter) throw new Error("Native setter unavailable");
    native.currentSetting = value; dirty = true;
  } };
  const originalFactory = function () {
    return function () {
      assert.equal(this.receiver, 42, "Provider receiver is preserved");
      lastTree = { type: "base-theme", props: { children: { type: ThemeContext.Provider,
        props: { value: { currentSetting: native.currentSetting, setDarkModeSetting: native.setDarkModeSetting }, children: "original-app" } } } };
      return lastTree;
    };
  };
  originalFactory.annotation = "native metadata";
  const context = vm.createContext({ location: { origin: "https://www.facebook.com" },
    postMessage: (data) => messages.push(data),
    addEventListener: (_type, callback) => { receive = callback; },
    setTimeout: (callback) => { timers.push(callback); return timers.length; },
    ___gi: (_name, callback) => { afterModule = callback; },
    require: () => { if (unavailable) throw new Error("Unknown module layout"); return ThemeContext; },
  });
  context.window = context;
  vm.runInContext(source("facebook-theme-page.js"), context);
  const exports = { default: originalFactory };
  afterModule([null, null, null, null, { exports }, null, exports]);
  assert.equal(exports.default.annotation, "native metadata");
  function render() {
    rendering = true;
    try {
      const result = provider.call({ receiver: 42 });
      assert.equal(result, lastTree, "The exact original element tree must pass through unchanged");
    } finally { rendering = false; }
  }
  function flush() {
    let runs = 0;
    while (timers.length || dirty) {
      assert.ok(++runs < 20, "Theme synchronization must settle without a save or render loop");
      if (dirty && provider) { dirty = false; render(); }
      const next = timers.shift(); if (next) next();
    }
  }
  function send(preference) {
    context.receive = receive; context.preference = preference;
    vm.runInContext(`receive({source:window,origin:location.origin,data:{source:'quiet-feed-theme-extension',type:'QFT_SET_THEME',preference}})`, context);
    flush();
  }
  return { native, saves, messages, send,
    mount() { provider = exports.default(); render(); flush(); },
    revert(value) { native.currentSetting = value; dirty = true; flush(); },
    status: () => messages.at(-1)?.status,
  };
}
async function bridgeTest() {
  let change, complete, osChange, receive;
  const sent = [];
  const root = { dataset: {}, className: "facebook-native-theme", style: { colorScheme: "native" } };
  const media = { matches: false, addEventListener: (_name, callback) => { osChange = callback; } };
  const context = vm.createContext({ document: { documentElement: root },
    location: { origin: "https://www.facebook.com" }, matchMedia: () => media,
    postMessage: (message) => sent.push(message),
    addEventListener: (_name, callback) => { receive = callback; },
    chrome: { storage: { local: { get: () => new Promise((resolve) => { complete = resolve; }) },
      onChanged: { addListener: (callback) => { change = callback; } } } },
  });
  context.window = context;
  vm.runInContext(source("facebook-theme.js"), context);
  change({ quietFeedTheme: { newValue: "dark" } }, "local");
  complete({ quietFeedTheme: "light" });
  await Promise.resolve();
  assert.equal(sent.at(-1).preference, "dark", "Late reads cannot undo newer choices");
  assert.equal(root.dataset.qfTheme, "dark");
  change({ quietFeedTheme: { newValue: "light" } }, "sync");
  assert.equal(sent.at(-1).preference, "dark");
  change({ quietFeedTheme: { newValue: "system" } }, "local");
  media.matches = true; osChange();
  assert.equal(sent.at(-1).preference, "system", "Send Facebook's system setting, not forced dark");
  assert.equal(root.dataset.qfTheme, "dark");
  media.matches = false; osChange();
  assert.equal(root.dataset.qfTheme, "light");
  assert.equal(root.className, "facebook-native-theme", "Never override Facebook classes");
  assert.equal(root.style.colorScheme, "native", "Facebook owns the page color scheme");
  context.receive = receive;
  vm.runInContext(`receive({source:window,origin:location.origin,data:{source:'quiet-feed-theme-page',type:'QFT_STATUS',status:'synced'}})`, context);
  assert.equal(root.dataset.qfNativeThemeStatus, "synced");
}
async function main() {
  const native = nativeHarness();
  native.send("dark");
  assert.equal(native.status(), "waiting");
  native.mount();
  assert.deepEqual(native.saves, ["ENABLED"]);
  assert.equal(native.status(), "synced");
  native.send("dark");
  assert.equal(native.saves.length, 1, "Duplicate messages cannot repeat native writes");
  native.send("light"); native.send("system");
  assert.deepEqual(native.saves, ["ENABLED", "DISABLED", "USE_SYSTEM"]);
  native.send("invalid"); assert.equal(native.saves.length, 3);
  native.send("dark"); native.revert("USE_SYSTEM");
  assert.equal(native.status(), "reverted");
  assert.equal(native.saves.length, 4, "Network reverts must not cause retries");
  native.send("dark"); assert.equal(native.saves.length, 4);
  const missing = nativeHarness({ unavailable: true });
  missing.mount(); assert.equal(missing.status(), "unavailable");
  const error = nativeHarness({ throwSetter: true });
  error.mount(); error.send("light");
  assert.equal(error.status(), "unavailable"); assert.equal(error.saves.length, 1);
  const already = nativeHarness(); already.send("system"); already.mount();
  assert.equal(already.saves.length, 0, "Matching native preferences never save again");
  already.revert("ENABLED"); assert.equal(already.saves.length, 0, "Later native UI choices are not fought");
  await bridgeTest();
  console.log("Native theme: unchanged provider tree, deferred saves, no render/save loops, system mode, and bridge races passed.");
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
