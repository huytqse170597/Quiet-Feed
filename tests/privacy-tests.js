"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const shared = require("../src/shared/features.js");
const read = (file) => fs.readFileSync(path.join(__dirname, "..", file), "utf8");

function harness({ csp = false } = {}) {
  const definitions = new Map();
  const listeners = [];
  const messages = [];
  let context;
  context = vm.createContext({ console, location: { origin: "https://www.facebook.com" },
    document: {
      createTextNode: (text) => text,
      createElement: () => ({ text: "", appendChild(text) { this.text += text; } }),
      querySelector: () => null,
      getElementsByTagName: () => [{ appendChild(script) {
        if (!csp) vm.runInContext(script.text, context);
      }, removeChild() {} }],
    },
    __d: (name, deps, factory) => definitions.set(name, factory),
    addEventListener: (type, handler) => { if (type === "message") listeners.push(handler); },
    postMessage: (data) => messages.push(data),
  });
  context.window = context;
  vm.runInContext(read("src/legacy/facebook-react-hook-runtime.js"), context);
  vm.runInContext(read("src/privacy-page.js"), context);
  function configure(value) {
    context.incoming = value;
    for (const listener of listeners) {
      // The VM's window wrapper is not reference-equal outside its realm.
      context.listener = listener;
      vm.runInContext(`listener({ source: window, origin: location.origin, data: {
        source: 'quiet-feed-privacy-extension', type: 'QFP_PRIVACY_SETTINGS', settings: incoming } })`, context);
    }
  }
  function define(name, body) {
    context.__d(name, [], vm.runInContext(`(function(a,b,c,d,e,f,g){${body}})`, context));
    const exports = {};
    const module = { exports };
    definitions.get(name)(context, null, null, null, module, exports, exports);
    return module.exports;
  }
  return { context, configure, define, messages };
}

const off = { hideReadReceipts: false, hideTypingIndicator: false, hideStoryViews: false };
const on = Object.fromEntries(Object.keys(off).map((key) => [key, true]));
const manifest = JSON.parse(read("manifest.json"));
const pageEntry = manifest.content_scripts.find((entry) => entry.js.includes("src/privacy-page.js"));
const bridgeEntry = manifest.content_scripts.find((entry) => entry.js.includes("src/privacy-content.js"));
assert.equal(pageEntry.world, "MAIN");
assert.equal(pageEntry.run_at, "document_start");
assert.ok(pageEntry.js.indexOf("src/legacy/facebook-react-hook-runtime.js") < pageEntry.js.indexOf("src/privacy-page.js"));
assert.equal(bridgeEntry.run_at, "document_start");
for (const host of ["www.facebook.com", "web.facebook.com", "m.facebook.com", "messenger.com", "www.messenger.com"]) {
  assert.ok(pageEntry.matches.includes(`https://${host}/*`));
  assert.ok(bridgeEntry.matches.includes(`https://${host}/*`));
  assert.equal(shared.isPrivacyUrl(`https://${host}/`), true);
}
for (const url of ["http://www.messenger.com/", "https://www.messenger.com.evil.test/", "https://evil.test/", "invalid"]) {
  assert.equal(shared.isPrivacyUrl(url), false);
}
for (const key of Object.keys(off)) assert.equal(shared.mergeSettings({})[key], false);
const h = harness();
const readReceipt = h.define("LSOptimisticMarkThreadReadV2", `
  g.default=function(value, transaction){return this.tag + value};
  g.default.__annotated='metadata';
`);
const transaction = { resolve: (value) => ({ resolved: Array.from(value) }) };
assert.deepEqual(readReceipt.default.call({ tag: "original" }, "-read", transaction), { resolved: [] },
  "Saved protection cannot leak during the startup handshake");
h.configure(off);
assert.equal(readReceipt.default.call({ tag: "original" }, "-read", transaction), "original-read");
assert.equal(readReceipt.default.__annotated, "metadata");
h.configure(on);
assert.deepEqual(readReceipt.default(7, transaction), { resolved: [] });
assert.equal(readReceipt.default.call({ tag: "safe" }, "-fallback", {}), "safe-fallback",
  "Unknown transaction signatures retain Facebook's original behavior");
h.configure({ ...on, hideReadReceipts: "false" });
assert.deepEqual(readReceipt.default(7, transaction), { resolved: [] }, "Invalid updates are ignored");
const direct = h.define("LSOptimisticMarkThreadReadV2StoredProcedure", "e.exports=function(t){return 'sent'}");
assert.deepEqual(direct(transaction), { resolved: [] });
const typing = h.define("LSSendTypingIndicator", "g.default=function(...args){return [this.tag,...args]}");
assert.equal(typing.default(1, 2, true), undefined);
h.configure(off);
assert.deepEqual(Array.from(typing.default.call({ tag: "receiver" }, 1, 2, false)), ["receiver", 1, 2, false],
  "Disabled protection preserves stop-typing signals and the original receiver");
h.configure(on);
const hook = h.define("useMAWMarkThreadAsRead", `
  g.count=0;g.default=function(){g.count++;return function(){return this.value}};
`);
const markRead = hook.default();
assert.equal(hook.count, 1, "Encrypted chat hooks run even when protected");
assert.equal(markRead(), undefined);
h.configure(off);
assert.equal(markRead.call({ value: 42 }), 42, "Already-created callbacks follow live settings");
assert.equal(hook.default().call({ value: 7 }), 7);
assert.equal(hook.count, 2);

const story = h.define("StoriesSuspenseBucketContainer.react", `
  var seen=function(value){return this.tag+value};g.create=function(){return {onCardSeen:seen,other:42}};
`);
const callback = story.create().onCardSeen;
assert.equal(callback.call({ tag: "story" }, "-seen"), "story-seen");
h.configure(on);
assert.equal(callback(), undefined, "Existing story callbacks follow changes without a remount");
assert.equal(story.create().other, 42);
const secure = h.define("MAWSecureTypingState", `
  var transport={tag:42,sendChatStateFromComposer:function(value){return this.tag+value}};
  g.send=function(value){return transport.sendChatStateFromComposer(value)};
`);
assert.equal(secure.send(1), undefined);
h.configure(off);
assert.equal(secure.send(1), 43, "Encrypted typing preserves receiver and arguments when disabled");
for (const expression of ["parent.transport", "parent . transport", "$transport"]) {
  const variant = harness();
  variant.configure(off);
  const module = variant.define("MAWSecureTypingState", `
    var transport={tag:40,sendChatStateFromComposer:function(value){return this.tag+value}};
    var parent={transport:transport},$transport=transport;
    g.send=function(value){return ${expression}.sendChatStateFromComposer(value)};
  `);
  assert.equal(module.send(2), 42, `Unsupported or dollar receivers remain usable when disabled: ${expression}`);
  variant.configure(on);
  assert.equal(module.send(2), expression === "$transport" ? undefined : 42,
    "Only the complete recognized receiver is gated; unsupported calls pass through");
}
assert.doesNotThrow(() => h.define("LSSendTypingIndicator", "Object.freeze(g)"));
vm.runInContext(read("src/privacy-page.js"), h.context);
assert.equal(h.messages.filter((item) => item.hooks?.length === 1 && item.hooks[0] === "registered").length, 1,
  "Duplicate injection does not stack registrations");

const denied = harness({ csp: true });
denied.configure(on);
const unchanged = denied.define("StoriesSuspenseBucketContainer.react",
  "var seen=function(){return 42};g.card={onCardSeen:seen,other:true}");
assert.equal(unchanged.card.onCardSeen(), 42, "CSP denial leaves the original story module usable");

async function testBridge() {
  let completeRead;
  let change;
  let messageListener;
  let runtimeListener;
  const sent = [];
  const context = vm.createContext({ console, QuietFeed: shared, location: { origin: "https://www.messenger.com" },
    chrome: { storage: { local: { get: () => new Promise((resolve) => { completeRead = resolve; }) },
      onChanged: { addListener: (fn) => { change = fn; } } },
      runtime: { onMessage: { addListener: (fn) => { runtimeListener = fn; } } } },
    postMessage: (data) => sent.push(data),
    addEventListener: (_name, fn) => { messageListener = fn; },
  });
  context.window = context;
  vm.runInContext(read("src/privacy-content.js"), context);
  const key = shared.STORAGE_KEYS.settings;
  change({ [key]: { newValue: on } }, "local");
  completeRead({ [key]: off });
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(sent.at(-1).settings.hideReadReceipts, true, "Late reads cannot overwrite a newer toggle");
  const count = sent.length;
  change({ [key]: { newValue: off } }, "sync");
  assert.equal(sent.length, count);
  change({ [key]: { newValue: undefined } }, "local");
  assert.equal(sent.at(-1).settings.hideReadReceipts, false, "Storage removal resets to optional defaults");
  context.receive = messageListener;
  vm.runInContext(`receive({source:window,origin:location.origin,data:{source:'quiet-feed-privacy-page',
    type:'QFP_PRIVACY_STATUS',settingsReady:true,hooks:['LSSendTypingIndicator']}})`, context);
  let status;
  runtimeListener({ type: "QF_GET_PRIVACY_STATUS" }, {}, (value) => { status = value; });
  assert.equal(status.settingsReady, true);
  assert.equal(status.settingsLoaded, true);
}
async function testReloads() {
  const background = read("src/background.js");
  const reloadSource = background.slice(background.indexOf("async function reloadPrivacyTabs()"),
    background.indexOf("async function getFilterHealth()"));
  const reloaded = [];
  let tabs = [{ id: 1 }, { id: 2 }, {}];
  const context = vm.createContext({ chrome: { tabs: {
    query: async (query) => {
      assert.ok(query.url.includes("https://www.messenger.com/*"));
      assert.ok(!query.url.includes("<all_urls>"));
      return tabs;
    },
    reload: async (id) => { if (id === 2) throw new Error("Closed tab"); reloaded.push(id); },
  } } });
  vm.runInContext(reloadSource, context);
  const partial = await context.reloadPrivacyTabs();
  assert.equal(partial.reloaded, true);
  assert.equal(partial.count, 1);
  assert.equal(partial.failed, 1);
  assert.deepEqual(reloaded, [1]);
  tabs = [];
  assert.equal((await context.reloadPrivacyTabs()).reloaded, false);
}
Promise.all([testBridge(), testReloads()]).then(() => console.log("Privacy hooks, live toggles, CSP fallback, storage race, and tab reload tests passed."))
  .catch((error) => { console.error(error); process.exitCode = 1; });
