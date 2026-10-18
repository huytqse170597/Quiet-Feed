(function initializeQuietFeedPrivacy() {
  "use strict";
  if (window.QuietFeedPrivacy) return;

  const keys = ["hideReadReceipts", "hideTypingIndicator", "hideStoryViews"];
  let settings = null;
  const observed = new Set();
  const wrapped = new WeakMap();

  // Hold signals during the storage handshake, so a saved protection cannot leak
  // its first receipt. Never replay held receipts when a setting changes.
  function blocked(key) { return settings === null || settings[key] === true; }
  function report(name) {
    observed.add(name);
    window.postMessage({ source: "quiet-feed-privacy-page", type: "QFP_PRIVACY_STATUS",
      settingsReady: settings !== null, hooks: [...observed] }, location.origin);
  }
  function wrap(original, key, mode) {
    if (typeof original !== "function") return original;
    let variants = wrapped.get(original);
    if (!variants) { variants = new Map(); wrapped.set(original, variants); }
    const id = `${key}:${mode}`;
    if (variants.has(id)) return variants.get(id);
    // Proxy preserves function metadata, custom properties, receiver, and errors.
    const proxy = new Proxy(original, { apply(target, receiver, args) {
      if (mode === "hook") {
        // Always call the hook: skipping it would change React's hook order.
        const callback = Reflect.apply(target, receiver, args);
        return typeof callback === "function" ? wrap(callback, key, "callback") : callback;
      }
      if (!blocked(key)) return Reflect.apply(target, receiver, args);
      if (mode === "procedure") {
        const transaction = args[args.length - 1];
        // Unknown procedure signatures pass through instead of corrupting a chat transaction.
        if (typeof transaction?.resolve !== "function") return Reflect.apply(target, receiver, args);
        return transaction.resolve([]);
      }
      return undefined;
    } });
    variants.set(id, proxy);
    return proxy;
  }
  function patchExports(args, name, key, mode) {
    const candidates = [args[4]?.exports, args[6]];
    for (const exports of new Set(candidates)) {
      try {
        if (typeof exports === "function" && args[4]?.exports === exports) {
          args[4].exports = wrap(exports, key, mode);
          report(name);
        } else if (exports && typeof exports.default === "function") {
          exports.default = wrap(exports.default, key, mode);
          report(name);
        }
      } catch { /* Frozen or changed export layouts must leave Facebook working. */ }
    }
  }
  const api = Object.freeze({
    storyCallback(callback) { return wrap(callback, "hideStoryViews", "callback"); },
    secureTyping(receiver) {
      const original = receiver?.sendChatStateFromComposer;
      return function (...args) {
        if (blocked("hideTypingIndicator")) return undefined;
        return Reflect.apply(original, receiver, args);
      };
    },
  });
  window.QuietFeedPrivacy = api;
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== location.origin ||
        event.data?.source !== "quiet-feed-privacy-extension") return;
    if (event.data.type === "QFP_PRIVACY_SETTINGS" && event.data.settings &&
        keys.every((key) => typeof event.data.settings[key] === "boolean")) {
      settings = Object.fromEntries(keys.map((key) => [key, event.data.settings[key]]));
      report("settings");
    } else if (event.data.type === "QFP_PRIVACY_QUERY") report("settings");
  });

  for (const name of ["LSOptimisticMarkThreadReadV2", "LSOptimisticMarkThreadReadV2StoredProcedure"]) {
    window.___gi(name, (args) => patchExports(args, name, "hideReadReceipts", "procedure"));
  }
  window.___gi("useMAWMarkThreadAsRead", (args) =>
    patchExports(args, "useMAWMarkThreadAsRead", "hideReadReceipts", "hook"));
  // Drop typing signals rather than changing their boolean arguments: disabling
  // the protection must preserve Facebook's original start/stop semantics.
  window.___gi("LSSendTypingIndicator", (args) =>
    patchExports(args, "LSSendTypingIndicator", "hideTypingIndicator", "callback"));
  window.___cr("StoriesSuspenseBucketContainer.react|quiet-feed-privacy", (source) => {
    const next = source.replace(/\bonCardSeen\s*:\s*([A-Za-z_$][\w$]*)\s*(?=[,}])/g,
      "onCardSeen:window.QuietFeedPrivacy.storyCallback($1)");
    if (next !== source) report("StoriesSuspenseBucketContainer.react:matched");
    return next;
  });
  window.___cr("MAWSecureTypingState|quiet-feed-privacy", (source) => {
    // Only recognized member calls are rewritten; no global string renaming.
    const next = source.replace(/(?<![\w$.])([A-Za-z_$][\w$]*(?:\("[^"\n]+"\))?)\.sendChatStateFromComposer\s*\(/g,
      (match, receiver, offset) => {
        // Reject suffix matches inside unsupported member expressions, including
        // `parent . transport`. Preserve those calls until their full shape is known.
        const preceding = source.slice(0, offset).trimEnd().at(-1);
        if (preceding === "." || preceding === "?") return match;
        return `window.QuietFeedPrivacy.secureTyping(${receiver})(`;
      });
    if (next !== source) report("MAWSecureTypingState:matched");
    return next;
  });
  report("registered");
})();
