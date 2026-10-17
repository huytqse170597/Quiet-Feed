(function installNativeFacebookThemeSync() {
  "use strict";
  if (location.hostname && !["www.facebook.com", "web.facebook.com", "m.facebook.com"].includes(location.hostname)) return;
  if (window.__quietFeedNativeThemeInstalled) return;
  window.__quietFeedNativeThemeInstalled = true;
  const settings = { light: "DISABLED", dark: "ENABLED", system: "USE_SYSTEM" };
  const wrapped = new WeakSet();
  let request = null;
  let attemptedRevision = 0;
  let nativeContext = null;
  let pendingApply = null;
  function report(status, reason = "") {
    window.postMessage({ source: "quiet-feed-theme-page", type: "QFT_STATUS", status, reason, version: "provider-observer-v1" }, location.origin);
  }
  function ready() {
    window.postMessage({ source: "quiet-feed-theme-page", type: "QFT_READY", version: "provider-observer-v1" }, location.origin);
  }
  function scheduleApply() {
    if (pendingApply !== null) return;
    pendingApply = setTimeout(() => {
      pendingApply = null;
      if (!request) return;
      if (!nativeContext) { report("waiting"); return; }
      const desired = settings[request.preference];
      if (nativeContext.currentSetting === desired) {
        attemptedRevision = Math.max(attemptedRevision, request.revision);
        report("synced"); return;
      }
      if (attemptedRevision === request.revision) { report("reverted"); return; }
      attemptedRevision = request.revision;
      try { nativeContext.setDarkModeSetting(desired); report("requested"); }
      catch { report("unavailable", "native-save-error"); }
    }, 0);
  }
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin || event.data?.source !== "quiet-feed-theme-extension") return;
    if (event.data.type === "QFT_QUERY") { ready(); return; }
    if (event.data.type !== "QFT_SET_THEME" || !Object.hasOwn(settings, event.data.preference)) return;
    if (request?.preference === event.data.preference) return;
    request = { preference: event.data.preference, revision: (request?.revision || 0) + 1 };
    scheduleApply();
  });
  function captureContext(tree) {
    try {
      const context = window.require("CometDarkModeContext");
      const queue = [{ node: tree, depth: 0 }];
      for (let examined = 0; queue.length && examined < 64; examined++) {
        const { node, depth } = queue.shift();
        if (!node || typeof node !== "object" || depth > 8) continue;
        if ((node.type === context.Provider || node.type === context) &&
            typeof node.props?.value?.setDarkModeSetting === "function") {
          nativeContext = node.props.value;
          scheduleApply(); return;
        }
        const children = Array.isArray(node) ? node : node.props?.children;
        if (Array.isArray(children)) {
          for (const child of children.slice(0, 64)) queue.push({ node: child, depth: depth + 1 });
        } else if (children) queue.push({ node: children, depth: depth + 1 });
      }
      report("unavailable", "context-provider-shape");
    } catch { report("unavailable", "context-module-unavailable"); }
  }
  function wrapFactory(factory) {
    if (typeof factory !== "function" || wrapped.has(factory)) return factory;
    const proxy = new Proxy(factory, { apply(target, receiver, args) {
      const provider = Reflect.apply(target, receiver, args);
      if (typeof provider !== "function") return provider;
      return new Proxy(provider, { apply(component, receiver, args) {
        const tree = Reflect.apply(component, receiver, args);
        // Observe the existing provider value without changing its element tree,
        // adding hooks, or wrapping Facebook's app root. Save after render returns.
        captureContext(tree);
        return tree;
      } });
    } });
    wrapped.add(proxy);
    return proxy;
  }
  if (typeof window.___gi !== "function") { report("unavailable", "runtime-missing"); return; }
  window.___gi("makeCometDarkModeStateProvider.react", (args) => {
    for (const exports of new Set([args[4]?.exports, args[6]])) {
      try {
        if (exports && typeof exports.default === "function") exports.default = wrapFactory(exports.default);
      } catch { report("unavailable", "frozen-exports"); }
    }
  });
  ready();
})();
