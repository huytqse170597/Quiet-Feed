(function initializeQuietFeedPageHooks() {
  "use strict";

  const HOOK_SUFFIX = ".react|quiet-feed";
  const COUNTER_FLUSH_DELAY = 800;
  const RUNTIME_RETRY_DELAY = 250;
  const RUNTIME_WAIT_TIMEOUT = 12000;
  const EMPTY_SETTINGS = Object.freeze({});
  const GROUP_SUGGESTION_TYPES = new Set(["GroupsYouShouldJoinFeedUnit"]);

  let settings = EMPTY_SETTINGS;
  let pausedUntil = 0;
  let customRules = [];
  let React = null;
  let InsideRemovedBoundary = null;
  let counterTimer = null;
  let installed = false;
  const runtimeWaitDeadline = Date.now() + RUNTIME_WAIT_TIMEOUT;
  const activeTargets = new Set();
  const revealedItemKeys = new Set();
  const pendingCounts = { reels: 0, suggested: 0, sponsored: 0, custom: 0 };
  const pendingLogEntries = [];
  const settingsListeners = new Set();

  window.addEventListener("message", receiveExtensionMessage);
  waitForFacebookRuntime();

  function receiveExtensionMessage(event) {
    if (event.source !== window || event.data?.source !== "quiet-feed-extension") return;
    if (event.data.type === "QFP_SETTINGS" && event.data.settings) {
      settings = { ...event.data.settings };
      pausedUntil = Number(event.data.pausedUntil) || 0;
      customRules = Array.isArray(event.data.customRules) ? event.data.customRules : [];
      settingsListeners.forEach((listener) => listener());
    }
  }

  function waitForFacebookRuntime() {
    if (installed) return;
    if (!window.requireLazy || !window.require || !window.___km || !window.___sf) {
      retryRuntimeWait();
      return;
    }

    try {
      window.requireLazy(["react", "__debug"], () => {
        const reactDomModule = findReactDomModule();
        if (!reactDomModule) {
          retryRuntimeWait();
          return;
        }
        window.require(reactDomModule);
        React = window.require("react");
        installHooks();
      });
    } catch {
      retryRuntimeWait();
    }
  }

  function retryRuntimeWait() {
    if (Date.now() >= runtimeWaitDeadline) return;
    setTimeout(waitForFacebookRuntime, RUNTIME_RETRY_DELAY);
  }

  function findReactDomModule() {
    try {
      const modules = window.require("__debug").modulesMap;
      return Object.keys(modules)
        .filter((name) => name.startsWith("ReactDOM"))
        .find((name) => {
          const module = modules[name];
          return Boolean(
            module.exports &&
              module.exports.version &&
              module.depPosition > 3 &&
              name.includes("classic"),
          );
        });
    } catch {
      return null;
    }
  }

  function installHooks() {
    if (installed || !React) return;
    installed = true;

    InsideRemovedBoundary = React.createContext(false);
    installPageStyle();

    installTarget("CometFeedUnitErrorBoundary", filterFeedUnit);
    installTarget("CometHomeRightRailUnit", (payload) =>
      React.createElement("div", { className: "qf-home-right-rail" }, payload.lastCmp),
    );
    installTarget("CometAdsSideFeedUnitItem", (payload) =>
      React.createElement(SettingsGate, {
        settingsKey: "removeSponsored",
        content: payload.lastCmp,
        whenHidden: () => React.createElement(HiddenSideAd),
      }),
    );
    installTarget("CometToasterRoot", (payload) =>
      React.createElement(SettingsGate, { settingsKey: "removeNotifications", content: payload.lastCmp }),
    );
    installTarget("CometHomeRightSideBirthdayReminders", (payload) =>
      React.createElement(SettingsGate, { settingsKey: "removeBirthdays", content: payload.lastCmp }),
    );
    installTarget("FBReelsRootWrapper", (payload) =>
      React.createElement(FeedUnitGate, {
        candidates: [{ test: () => enabled("removeReels"), category: "reels", label: "Removed reels" }],
        content: payload.lastCmp,
      }),
    );
    installTarget("FBReelsTopOfFeedTrayTile", (payload) =>
      React.createElement(FeedUnitGate, {
        candidates: [{ test: () => enabled("removeReels"), category: "reels", label: "Removed reels" }],
        content: payload.lastCmp,
      }),
    );
    installTarget("CometFeedStoryFBReelsAttachmentStyle", (payload) =>
      React.createElement(FeedUnitGate, {
        candidates: [{
          test: () => enabled("removeReels") && !enabled("allowFriendsReels"),
          category: "reels",
          label: "Removed reels",
        }],
        content: payload.lastCmp,
      }),
    );
    installTarget("FriendingCometPYMKGrid", filterPeopleSuggestion);
    installTarget("FriendingCometFeedPYMKHScroll", filterPeopleSuggestion);
    installTarget("FriendingCometPYMKPanel", filterPeopleSuggestion);
    installTarget("StoriesTrayRectangularRoot", (payload) =>
      React.createElement(SettingsGate, { settingsKey: "removeStories", content: payload.lastCmp }),
    );
    installTarget("CometMarketplaceAdCard", (payload) =>
      React.createElement(FeedUnitGate, {
        candidates: [{ test: () => enabled("removeMarketplaceAds"), category: "sponsored", label: "Removed Marketplace ad" }],
        content: payload.lastCmp,
      }),
    );
    installTarget("SearchCometResultsAd", (payload) =>
      React.createElement(FeedUnitGate, {
        candidates: [{ test: () => enabled("removeSearchAds"), category: "sponsored", label: "Removed search ad" }],
        content: payload.lastCmp,
      }),
    );

    window.postMessage({ source: "quiet-feed-page", type: "QFP_HOOK_READY" }, location.origin);
  }

  function installTarget(moduleName, transform) {
    window.___km(
      `${moduleName}${HOOK_SUFFIX}`,
      (payload) => {
        reportHookActivity(moduleName);
        return transform(payload);
      },
      { fallback: empty },
    );
  }

  function reportHookActivity(moduleName) {
    if (activeTargets.has(moduleName)) return;
    activeTargets.add(moduleName);
    window.postMessage(
      { source: "quiet-feed-page", type: "QFP_HOOK_ACTIVE", moduleName },
      location.origin,
    );
  }

  function filterPeopleSuggestion(payload) {
    return React.createElement(FeedUnitGate, {
      candidates: [{ test: () => enabled("removePeopleSuggestions"), category: "suggested", label: "Removed people suggestion" }],
      content: payload.lastCmp,
    });
  }

  function filterFeedUnit(payload) {
    if (location.pathname !== "/") return payload.lastCmp;

    const feedUnitId =
      get(payload.payload, "feedUnit.id") || get(payload.payload, "feedUnit.__id");
    const unitType = get(payload.payload, "unitTypename", "none");
    const isSponsored = Boolean(
      feedUnitId && relayField(feedUnitId, "^sponsored_data.ad_id"),
    );
    const canJoin = Boolean(
      feedUnitId && relayField(feedUnitId, "^to.viewer_forum_join_state") === "CAN_JOIN",
    );
    const canSubscribe = Boolean(
      feedUnitId && relayField(feedUnitId, "^^actors[0].subscribe_status") === "CAN_SUBSCRIBE",
    );
    const storyId =
      get(payload.payload, "feedUnit.__id") ||
      get(payload.payload, "children[0].props.children.props.feedUnit.__id");
    const storyType = storyId ? relayField(storyId, "showcase_story_type") : null;
    const homepageSuggestion = storyId
      ? relayField(storyId, "^story_header{$1}.^title.text", { $1: { location: "homepage_stream" } })
      : null;
    const groupSuggestion = storyId
      ? relayField(storyId, "^story_header{$1}.^title.text", { $1: { location: "groups_tab" } })
      : null;

    // Data-derived facts (relay lookups above) don't change when a setting is
    // toggled live, only which candidate is "enabled" does — so the candidate
    // list is computed once per render and FeedUnitGate re-picks from it
    // whenever settings change, instead of baking one decision in forever.
    const candidates = [
      isSponsored && {
        test: () => enabled("removeSponsored"),
        category: "sponsored",
        label: "Removed sponsored post",
        itemKey: feedUnitId,
      },
      (GROUP_SUGGESTION_TYPES.has(unitType) || canJoin) && {
        test: () => enabled("removeGroupSuggestions"),
        category: "suggested",
        label: "Removed group suggestion",
        itemKey: feedUnitId,
      },
      canSubscribe && {
        test: () => enabled("removeSuggested"),
        category: "suggested",
        label: "Removed suggested content",
        itemKey: feedUnitId,
      },
      storyType === "SHOWCASE_SHORT_VIDEO" && {
        test: () => enabled("removeReels"),
        category: "reels",
        label: "Removed reels",
        itemKey: storyId,
      },
      (homepageSuggestion || groupSuggestion) && {
        test: () => enabled("removeSuggested"),
        category: "suggested",
        label: "Removed suggested content",
        itemKey: storyId,
      },
    ].filter(Boolean);

    const content =
      customRules.length > 0 && !isPaused()
        ? React.createElement(CustomRuleGate, {
            content: payload.lastCmp,
            itemKey: feedUnitId || storyId || null,
          })
        : React.createElement("div", { className: "CometFeedUnit" }, payload.lastCmp);

    return React.createElement(FeedUnitGate, { candidates, content });
  }

  // Custom keyword/regex rules match on rendered text, which is not in the relay
  // payload. Render the post once, read its text on mount, then remove it if a
  // rule matches — reusing the same placeholder/undo/counter path as built-in
  // filters via removed().
  function CustomRuleGate({ content, itemKey }) {
    const ref = React.useRef(null);
    const [matched, setMatched] = React.useState(false);
    React.useEffect(() => {
      if (!customRules.length) return;
      const node = ref.current;
      const text = node ? node.innerText || node.textContent || "" : "";
      const rulesApi = globalThis.QuietFeedRules;
      if (rulesApi && rulesApi.matchesCustomRules(text, customRules)) {
        setMatched(true);
      }
    }, []);

    if (matched) return removed(content, "custom", "Removed by your rule", itemKey);
    return React.createElement("div", { className: "CometFeedUnit", ref }, content);
  }

  function isPaused() {
    return pausedUntil > 0 && Date.now() < pausedUntil;
  }

  function removed(originalContent, category, label, itemKey) {
    return React.createElement(RemovedContent, { originalContent, category, label, itemKey });
  }

  const HIDDEN_CONTENT_STYLE = {
    position: "absolute",
    top: 0,
    left: 0,
    zIndex: -1,
    width: 1,
    height: 1,
    maxWidth: 1,
    maxHeight: 1,
    overflow: "hidden",
    opacity: 0,
    pointerEvents: "none",
    userSelect: "none",
  };

  // originalContent must keep the exact same wrapper shape whether revealed
  // or not; branching the element tree here would make React unmount and
  // remount it on toggle, resetting any RemovedContent nested inside it.
  //
  // A single post can trip more than one target (e.g. the whole post is
  // reel-classified AND its inline attachment is separately caught by the
  // reel-attachment hook). Without InsideRemovedBoundary, that nests two
  // independent "Show this item" prompts for what looks like one post. Once
  // an outer RemovedContent is showing a prompt, nested ones just pass their
  // content through — the outer prompt is the single control point.
  function RemovedContent({ originalContent, category, label, itemKey }) {
    const alreadyInsideBoundary = React.useContext(InsideRemovedBoundary);
    const [revealed, setRevealed] = React.useState(() => Boolean(itemKey && revealedItemKeys.has(itemKey)));
    React.useEffect(() => {
      if (!alreadyInsideBoundary) incrementCounter(category, label);
    }, []);

    if (alreadyInsideBoundary) return originalContent;

    return React.createElement(
      React.Fragment,
      null,
      enabled("cleanMode")
        ? null
        : React.createElement(
            "div",
            { className: "qf-removed-placeholder" },
            React.createElement("span", null, revealed ? "Quiet Feed is showing this item." : label),
            React.createElement(
              "button",
              {
                type: "button",
                className: "qf-removed-btn",
                onClick: () => {
                  if (revealed) {
                    forgetRevealedItem(itemKey);
                    setRevealed(false);
                  } else {
                    rememberRevealedItem(itemKey);
                    setRevealed(true);
                  }
                },
              },
              revealed ? "Hide again" : "Show this item",
            ),
          ),
      React.createElement(
        "div",
        { style: { position: "relative" } },
        React.createElement(
          "div",
          { style: revealed ? undefined : HIDDEN_CONTENT_STYLE },
          React.createElement(InsideRemovedBoundary.Provider, { value: true }, originalContent),
        ),
      ),
    );
  }

  function rememberRevealedItem(itemKey) {
    if (!itemKey) return;
    revealedItemKeys.add(itemKey);
    if (revealedItemKeys.size > 500) {
      revealedItemKeys.delete(revealedItemKeys.values().next().value);
    }
  }

  function forgetRevealedItem(itemKey) {
    if (!itemKey) return;
    revealedItemKeys.delete(itemKey);
  }

  function HiddenSideAd() {
    React.useEffect(() => {
      incrementCounter("sponsored");
    }, []);
    return React.createElement("div", { className: "qf-hidden-side-ad" });
  }

  // Widgets that render once near the top of the page (e.g. the stories tray)
  // don't re-render on their own, so a plain enabled()-ternary can get stuck
  // showing content if settings arrive after the first render. This gate
  // re-checks once settings load, forcing its own update independent of
  // whatever Facebook's render tree does.
  function SettingsGate({ settingsKey, content, whenHidden }) {
    const [hidden, setHidden] = React.useState(() => enabled(settingsKey));
    React.useEffect(() => {
      const recheck = () => setHidden(enabled(settingsKey));
      settingsListeners.add(recheck);
      return () => settingsListeners.delete(recheck);
    }, [settingsKey]);
    if (!hidden) return content;
    return whenHidden ? whenHidden() : empty();
  }

  // Per-post targets (sponsored/suggested/reels) can match on more than one
  // signal at once, so unlike SettingsGate this picks the first matching
  // candidate from an ordered list, re-testing all of them whenever settings
  // change instead of gating on a single flag.
  function FeedUnitGate({ candidates, content }) {
    const pickMatch = () => candidates.find((candidate) => candidate.test()) || null;
    const [match, setMatch] = React.useState(pickMatch);
    React.useEffect(() => {
      const recheck = () => setMatch(pickMatch());
      settingsListeners.add(recheck);
      return () => settingsListeners.delete(recheck);
    }, [candidates]);

    if (!match) return content;
    return removed(content, match.category, match.label, match.itemKey);
  }

  function installPageStyle() {
    if (document.querySelector("#quiet-feed-page-hook-style")) return;
    const style = document.createElement("style");
    style.id = "quiet-feed-page-hook-style";
    style.textContent = [
      ".qf-home-right-rail:has(.qf-hidden-side-ad){display:none!important}",
      ".qf-removed-placeholder{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:10px 14px;border-radius:8px;margin:8px 0;color:#65676b;background:#fff;border:1px solid rgba(0,0,0,0.08);font:14px/1.34 'Segoe UI',system-ui,sans-serif}",
      "@media(prefers-color-scheme:dark){.qf-removed-placeholder{color:#b0b3b8;background:#242526;border-color:rgba(255,255,255,0.06)}}",
      ".qf-removed-btn{padding:6px 12px;border:1px solid rgba(0,0,0,0.15);border-radius:20px;background:#f0f2f5;color:#050505;cursor:pointer;font:600 13px/1 'Segoe UI',system-ui,sans-serif;white-space:nowrap}",
      ".qf-removed-btn:hover{background:#e4e6eb}",
      "@media(prefers-color-scheme:dark){.qf-removed-btn{border-color:rgba(255,255,255,0.1);background:#3a3b3c;color:#e4e6eb}.qf-removed-btn:hover{background:#4e4f50}}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }

  function incrementCounter(category, label) {
    if (!(category in pendingCounts)) return;
    pendingCounts[category] += 1;
    if (label) {
      pendingLogEntries.push({ ts: Date.now(), category, text: String(label).slice(0, 120) });
      if (pendingLogEntries.length > 50) pendingLogEntries.splice(0, pendingLogEntries.length - 50);
    }
    clearTimeout(counterTimer);
    counterTimer = setTimeout(flushCounters, COUNTER_FLUSH_DELAY);
  }

  function flushCounters() {
    const delta = { ...pendingCounts };
    const entries = pendingLogEntries.splice(0);
    pendingCounts.reels = 0;
    pendingCounts.suggested = 0;
    pendingCounts.sponsored = 0;
    pendingCounts.custom = 0;
    window.postMessage(
      { source: "quiet-feed-page", type: "QFP_COUNTS", delta, entries },
      location.origin,
    );
  }

  function enabled(key) {
    if (pausedUntil > 0 && Date.now() < pausedUntil) return false;
    return settings[key] === true;
  }

  function relayField(id, path, variables) {
    try {
      return window.___sf(id, path, variables);
    } catch {
      return undefined;
    }
  }

  function get(object, path, fallback) {
    const parts = path.replace(/\[(\d+)]/g, ".$1").split(".");
    let value = object;
    for (const part of parts) {
      if (value == null || !(part in Object(value))) return fallback;
      value = value[part];
    }
    return value === undefined ? fallback : value;
  }

  function empty() {
    return React ? React.createElement(React.Fragment, null) : null;
  }
})();
