"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const path = require("node:path");

function harness({ missingBoundary = false } = {}) {
  const definitions = new Map();
  const cleanups = [];
  let updates = 0;
  const React = {
    useState: () => [0, () => { updates++; }],
    useEffect: (effect) => { cleanups.push(effect()); },
    jsx: (type, props) => ({ type, props }), Fragment: "fragment",
  };
  const context = vm.createContext({ console, Date, Math, Map, Symbol, Proxy,
    document: {
      createTextNode: (text) => text,
      createElement: () => ({ text: "", appendChild(text) { this.text += text; } }),
      querySelector: () => null,
      getElementsByTagName: () => [{ appendChild(script) { vm.runInContext(script.text, context); }, removeChild() {} }],
    },
    require: (name) => { assert.equal(name, "react"); return React; },
    __d: (name, dependencies, factory) => definitions.set(name, factory),
  });
  context.window = context;
  vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/legacy/facebook-react-hook-runtime.js"), "utf8"), context);
  function define(name, source) {
    const factory = vm.runInContext(`(${source})`, context);
    context.__d(name, [], factory);
    const exports = {};
    const module = { exports };
    definitions.get(name)(context, null, () => {
      if (missingBoundary) throw new Error("Desktop error boundary is unavailable");
      return "error-boundary";
    }, () => React, module, exports, exports);
    return exports;
  }
  return { context, define, cleanups, updates: () => updates };
}

const runtime = harness();
runtime.context.___pt("ResponsivePlayer.react|test");
runtime.context.___km("ResponsivePlayer.react|test", (payload) => payload.lastCmp);
const player = runtime.define("ResponsivePlayer.react", "function(a,b,c,d,e,f,g){g.default=function(){return 'video'}}");
for (let cycle = 0; cycle < 25; cycle++) {
  player.default();
  const cleanup = runtime.cleanups.pop();
  cleanup();
  cleanup(); // Cleanup must be harmless even if the lifecycle calls it twice.
}
assert.equal(runtime.updates(), 0, "Unmounting must not invoke stale state setters");
player.default();
runtime.context.___km("ResponsivePlayer.react|test", (payload) => payload.lastCmp);
assert.equal(runtime.updates(), 1, "Only the mounted player should receive updates");
runtime.cleanups.pop()();
runtime.context.___km("ResponsivePlayer.react|test", (payload) => payload.lastCmp);
assert.equal(runtime.updates(), 1, "Unmounted listeners must be released");
runtime.context.___pt("MobileThis.react|test");
runtime.context.___km("MobileThis.react|test", (payload) => payload.lastCmp);
const receiver = runtime.define("MobileThis.react", "function(a,b,c,d,e,f,g){g.default=function(){return this.value}}");
assert.equal(receiver.default.call({ value: 42 }).props.children.props.children.props.lastCmp, 42,
  "Wrapped responsive components preserve their original receiver");

const variant = harness();
variant.context.___pt("MobileLayout.react|test", { definerPath: "[6].default.render" });
assert.doesNotThrow(() => variant.define("MobileLayout.react", "function(a,b,c,d,e,f,g){g.default=null}"),
  "Unsupported mobile exports must pass through instead of breaking Facebook's module loader");

const relay = harness();
const queue = relay.define("relay-runtime/store/RelayPublishQueue", `function(a,b,c,d,e,f,g){
  var q={};q.commitPayload=function(payload){return payload.value};g.default=q;
}`);
assert.equal(queue.default.commitPayload({ request: { variables: {
  __relay_internal__pv__CometUFIReactionEnableShortNamerelayprovider: true,
} }, value: 42 }), 42, "Facebook Relay payloads must not be silently discarded");

const mobileRuntime = harness({ missingBoundary: true });
mobileRuntime.context.___pt("MobileVariant.react|test");
const mobileVariant = mobileRuntime.define("MobileVariant.react", "function(a,b,c,d,e,f,g){g.default=function(){return 'mobile content'}}");
assert.equal(mobileVariant.default(), "mobile content", "Missing desktop dependencies leave the mobile module functional");
mobileRuntime.context.___cr("NoChange|test", (source) => source);
const unchanged = mobileRuntime.define("NoChange", "function(a,b,c,d,e,f,g){g.value=42}");
assert.equal(unchanged.value, 42, "Unchanged factories do not require recompilation");
const reactDom = mobileRuntime.define("ReactDOM-prod.classic", "function(a,b,c,d,e,f,g){function x(n){return String(n)}g.error=function(){return Error(x(418))}}");
assert.equal(reactDom.error().message, "418", "React hydration errors and their recovery path are preserved");
const nativeThemeRuntime = harness();
const nativeThemeTimers = [];
const nativeThemeSaves = [];
let nativeThemeMessage;
Object.assign(nativeThemeRuntime.context, {
  location: { origin: "https://www.facebook.com", hostname: "www.facebook.com" },
  addEventListener: (_type, callback) => { nativeThemeMessage = callback; },
  postMessage: () => {},
  setTimeout: (callback) => { nativeThemeTimers.push(callback); return nativeThemeTimers.length; },
  themeContext: { Provider: {} },
});
nativeThemeRuntime.context.require = () => nativeThemeRuntime.context.themeContext;
nativeThemeRuntime.context.nativeTree = {
  type: nativeThemeRuntime.context.themeContext.Provider,
  props: { value: { currentSetting: "USE_SYSTEM", setDarkModeSetting(value) {
    nativeThemeSaves.push(value); this.currentSetting = value;
  } }, children: "Facebook application" },
};
vm.runInContext(fs.readFileSync(path.join(__dirname, "../src/facebook-theme-page.js"), "utf8"), nativeThemeRuntime.context);
const nativeFactory = nativeThemeRuntime.define("makeCometDarkModeStateProvider.react",
  "function(a,b,c,d,e,f,g){g.default=function(){return function(){return a.nativeTree}}}");
const nativeProvider = nativeFactory.default();
assert.equal(nativeProvider(), nativeThemeRuntime.context.nativeTree,
  "The actual module hook runtime must return Facebook's original provider tree unchanged");
nativeThemeRuntime.context.receiveTheme = nativeThemeMessage;
vm.runInContext("receiveTheme({source:window,origin:location.origin,data:{source:'quiet-feed-theme-extension',type:'QFT_SET_THEME',preference:'dark'}})", nativeThemeRuntime.context);
assert.equal(nativeThemeSaves.length, 0, "Native preference saves are deferred outside provider rendering");
while (nativeThemeTimers.length) nativeThemeTimers.shift()();
assert.deepEqual(nativeThemeSaves, ["ENABLED"]);
nativeProvider();
while (nativeThemeTimers.length) nativeThemeTimers.shift()();
assert.equal(nativeThemeSaves.length, 1, "Native provider renders must not loop or repeat preference saves");

console.log("Runtime lifecycle, mobile export variants, Relay payload, and native theme integration tests passed.");
