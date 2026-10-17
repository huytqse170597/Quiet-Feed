(function startQuietFeedContentScript() {
  "use strict";

  const { STORAGE_KEYS, mergeSettings, pruneDisconnectedEntries } = QuietFeed;
  const { PHRASES, includesPhrase, classifyFeedUnit, matchesCustomRules } = QuietFeedRules;

  const FEED_UNIT_SELECTOR = [
    '[role="article"]',
    'article',
    '[data-pagelet^="FeedUnit"]',
    '[data-pagelet*="FeedUnit"]',
  ].join(",");
  const STORIES_SELECTOR = '[aria-label="Stories"], [aria-label="Tin"], [data-pagelet*="Stories"]';
  const RIGHT_RAIL_SELECTOR = '[data-pagelet*="RightRail"], [role="complementary"]';
  const NOTIFICATION_SELECTOR =
    '[role="status"], [data-pagelet*="Toast"], [data-visualcompletion="ignore-dynamic"] [role="alert"]';
  const POST_LINK_SELECTOR =
    'a[href*="/posts/"], a[href*="story_fbid="], a[href*="/reel/"], a[href*="/videos/"]';
  const POST_AUTHOR_SELECTOR = 'h2 a[role="link"], h3 a[role="link"], strong a[role="link"]';

  const hiddenElements = new Map();
  const countedElements = new WeakSet();
  const revealedItemKeys = new Set();
  const pendingScanRoots = new Set();
  const pendingCounts = { reels: 0, suggested: 0, sponsored: 0, custom: 0 };
  const pendingLogEntries = [];
  let settings = null;
  let customRules = [];
  let scanTimer = null;
  let countTimer = null;
  let fallbackTimer = null;
  let pruneTimer = null;
  let intersectionObserver = null;
  let observer = null;
  let storiesObserver = null;
  let storiesCheckTimer = null;
  let hookActive = false;
  let fallbackActive = false;
  let debugMode = false;
  let pausedUntil = 0;
  let indicatorEl = null;

  injectStyle();
  window.addEventListener("message", receivePageMessage);
  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type !== "QF_GET_FILTER_STATUS") return false;
    sendResponse({ status: getFilterStatus() });
    return false;
  });
  initialize().catch((error) => console.error("Quiet Feed failed to start", error));

  function getFilterStatus() {
    return hookActive ? "advanced" : fallbackActive ? "fallback" : "waiting";
  }

  async function initialize() {
    const stored = await chrome.storage.local.get([STORAGE_KEYS.settings, "quietFeedDebug", "quietFeedCustomRules", "quietFeedPausedUntil"]);
    settings = mergeSettings(stored[STORAGE_KEYS.settings]);
    debugMode = stored.quietFeedDebug === true;
    customRules = Array.isArray(stored.quietFeedCustomRules) ? stored.quietFeedCustomRules : [];
    pausedUntil = Number(stored.quietFeedPausedUntil) || 0;
    loadRevealedKeys();
    postSettingsToPage();
    updateIndicator();
    fallbackTimer = setTimeout(startDomFallback, 4000);

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      if (changes[STORAGE_KEYS.settings]) {
        settings = mergeSettings(changes[STORAGE_KEYS.settings].newValue);
        postSettingsToPage();
        updateIndicator();
      }
      if (changes.quietFeedCustomRules) {
        customRules = Array.isArray(changes.quietFeedCustomRules.newValue) ? changes.quietFeedCustomRules.newValue : [];
        postSettingsToPage();
      }
      if (changes.quietFeedPausedUntil) {
        pausedUntil = Number(changes.quietFeedPausedUntil.newValue) || 0;
        postSettingsToPage();
      }
      if ((changes[STORAGE_KEYS.settings] || changes.quietFeedCustomRules || changes.quietFeedPausedUntil) && fallbackActive) {
        restoreAll();
        scheduleFullScan();
      }
    });
  }

  function receivePageMessage(event) {
    if (event.source !== window || event.data?.source !== "quiet-feed-page") return;

    if (event.data.type === "QFP_HOOK_READY") {
      postSettingsToPage();
      return;
    }

    if (event.data.type === "QFP_HOOK_ACTIVE") {
      hookActive = true;
      clearTimeout(fallbackTimer);
      stopDomFallback();
      startStoriesSafetyNet();
      updateIndicator();
      try { chrome.runtime.sendMessage({ type: "QF_SET_FILTER_STATUS", status: "advanced" }).catch(() => {}); } catch (_) {}
      return;
    }

    if (event.data.type === "QFP_COUNTS") {
      const delta = sanitizeDelta(event.data.delta);
      const entries = sanitizeLogEntries(event.data.entries);
      if (Object.values(delta).some(Boolean) || entries.length > 0) {
        try {
          chrome.runtime
            .sendMessage({ type: "QF_INCREMENT_STATS", delta, entries })
            .catch((error) => console.debug("Quiet Feed counter bridge failed", error));
        } catch (_) {}
      }
    }
  }

  function postSettingsToPage() {
    if (!settings) return;
    window.postMessage(
      { source: "quiet-feed-extension", type: "QFP_SETTINGS", settings, pausedUntil, customRules },
      location.origin,
    );
  }

  function sanitizeDelta(value) {
    return Object.fromEntries(
      Object.keys(pendingCounts).map((key) => {
        const count = Number(value?.[key]);
        return [key, Number.isFinite(count) && count > 0 ? Math.floor(count) : 0];
      }),
    );
  }

  function startDomFallback() {
    if (hookActive || fallbackActive) return;
    fallbackActive = true;
    updateIndicator();
    intersectionObserver = new IntersectionObserver((entries) => {
      if (isPaused()) return;
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return;
        intersectionObserver.unobserve(entry.target);
        processFeedUnit(entry.target);
      });
    }, { rootMargin: "200px" });
    scanDocument();
    observer = new MutationObserver(handleMutations);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["role", "aria-label", "data-pagelet"],
      characterData: true,
    });
    pruneTimer = setInterval(() => {
      pruneDisconnectedEntries(hiddenElements, (placeholder) => placeholder?.remove());
    }, 30000);
    showFallbackToast();
    try { chrome.runtime.sendMessage({ type: "QF_SET_FILTER_STATUS", status: "fallback" }).catch(() => {}); } catch (_) {}
    console.info("Quiet Feed: Facebook hooks unavailable; using DOM fallback filters.");
  }

  // The React hook engine only intercepts a component on its render calls; a
  // widget that renders once near the top of the page (the stories tray) can
  // render before the hook is wired up and never get a second chance. This
  // small always-on watcher backstops that race with a plain DOM hide, same
  // as the fallback engine would do, but running alongside the hook engine
  // instead of only when the hook engine is absent.
  function startStoriesSafetyNet() {
    if (storiesObserver) return;
    ensureStoriesHidden();
    storiesObserver = new MutationObserver(() => {
      if (storiesCheckTimer) return;
      storiesCheckTimer = setTimeout(() => {
        storiesCheckTimer = null;
        ensureStoriesHidden();
      }, 220);
    });
    storiesObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  function ensureStoriesHidden() {
    if (!settings?.removeStories || isPaused()) return;
    processStories(document);
  }

  function stopDomFallback() {
    if (!fallbackActive) return;
    fallbackActive = false;
    observer?.disconnect();
    observer = null;
    intersectionObserver?.disconnect();
    intersectionObserver = null;
    clearTimeout(scanTimer);
    scanTimer = null;
    clearInterval(pruneTimer);
    pruneTimer = null;
    pendingScanRoots.clear();
    restoreAll();
  }

  function handleMutations(records) {
    if (settings?.showIndicator && !indicatorEl?.isConnected) updateIndicator();
    records.forEach((record) => {
      record.addedNodes.forEach((node) => {
        if (node instanceof HTMLElement && !node.closest("[data-qf-placeholder], [data-qf-video-control], #qf-indicator, #qf-fallback-toast")) pendingScanRoots.add(node);
      });
      if (record.type === "attributes" && record.target instanceof HTMLElement) {
        pendingScanRoots.add(record.target);
      }
      if (record.type === "characterData" && record.target.parentElement) {
        pendingScanRoots.add(record.target.parentElement);
      }
    });
    if (pendingScanRoots.size === 0) return;
    if (scanTimer) return;
    scanTimer = setTimeout(scanPendingNodes, 220);
  }

  function scheduleFullScan() {
    pendingScanRoots.clear();
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scanDocument, 220);
  }

  function scanDocument() {
    scanTimer = null;
    if (!fallbackActive || !settings || !document.body) return;
    pruneDisconnectedEntries(hiddenElements, (placeholder) => placeholder?.remove());
    scanRoot(document);
  }

  function scanPendingNodes() {
    scanTimer = null;
    if (!fallbackActive || !settings || !document.body) return;
    const roots = [...pendingScanRoots];
    pendingScanRoots.clear();
    pruneDisconnectedEntries(hiddenElements, (placeholder) => placeholder?.remove());
    // Collapse nested mutation roots after a responsive layout rebuild.
    const rootSet = new Set(roots);
    roots.filter((root) => {
      if (!root.isConnected) return false;
      for (let ancestor = root.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (rootSet.has(ancestor)) return false;
      }
      return true;
    }).forEach(scanRoot);
  }

  function scanRoot(root) {
    if (isPaused()) return;
    selectWithin(root, FEED_UNIT_SELECTOR).forEach(processFeedUnit);
    processStories(root);
    processRightRail(root);
    processNotifications(root);
  }

  function isPaused() {
    return pausedUntil > 0 && Date.now() < pausedUntil;
  }

  function selectWithin(root, selector) {
    const matches = root instanceof Element && root.matches(selector) ? [root] : [];
    return matches.concat(Array.from(root.querySelectorAll?.(selector) || []));
  }

  function processFeedUnit(element) {
    if (
      !(element instanceof HTMLElement) ||
      element.dataset.qfAllowed === "true" ||
      element.closest("[data-qf-placeholder]") ||
      element.closest(".qf-hidden") ||
      element.querySelector(":scope .qf-hidden")
    ) {
      return;
    }

    const itemKey = getItemKey(element);
    if (itemKey && revealedItemKeys.has(itemKey)) {
      element.dataset.qfAllowed = "true";
      return;
    }

    const rect = element.getBoundingClientRect();
    const offScreen = rect.bottom < -200 || rect.top > window.innerHeight + 200;
    if (offScreen && intersectionObserver && !hiddenElements.has(element)) {
      intersectionObserver.observe(element);
      return;
    }

    const links = Array.from(element.querySelectorAll('a[href*="/reel/"]'));
    const text = element.innerText || element.textContent || "";
    const category = classifyFeedUnit(
      {
        text,
        pathname: location.pathname,
        hasReelLink: links.length > 0,
        reelLinkCount: links.length,
      },
      settings,
    );

    if (category) { hideElement(element, category); return; }
    if (matchesCustomRules(text, customRules)) { hideElement(element, "custom"); }
  }

  function processStories(root) {
    if (!settings.removeStories) return;
    selectWithin(root, STORIES_SELECTOR).forEach((element) => {
      hideElement(findStableContainer(element), null);
    });
  }

  function processRightRail(root) {
    if (!settings.removeBirthdays) return;
    const rails = new Set(selectWithin(root, RIGHT_RAIL_SELECTOR));
    const ancestorRail = root instanceof Element ? root.closest(RIGHT_RAIL_SELECTOR) : null;
    if (ancestorRail) rails.add(ancestorRail);
    rails.forEach((rail) => {
      rail.querySelectorAll('div[role="article"], div[aria-label]').forEach((card) => {
        const text = card.innerText || card.textContent || "";
        if (includesPhrase(text, PHRASES.birthdays)) {
          hideElement(findStableContainer(card), null);
        }
      });
    });
  }

  function processNotifications(root) {
    if (!settings.removeNotifications) return;
    selectWithin(root, NOTIFICATION_SELECTOR).forEach((element) => {
      if (element.closest("[data-qf-placeholder], [data-qf-video-control], #qf-fallback-toast")) return;
      // Status regions also announce loading and navigation on mobile layouts.
      // A generic live region is not enough evidence that this is a toast.
      if (!element.closest('[data-pagelet*="Toast"], [data-visualcompletion="ignore-dynamic"]')) return;
      hideElement(element, null);
    });
  }

  function findStableContainer(element) {
    const article = element.closest('[role="article"], article');
    if (article) return article;
    const pagelet = element.closest('[data-pagelet]');
    // Mobile often gives only the application shell a pagelet identifier.
    // Keep the hide local when that ancestor owns the main feed.
    if (pagelet && !pagelet.matches('main, [role="main"], [role="feed"]') &&
        !pagelet.querySelector('main, [role="main"], [role="feed"]')) return pagelet;
    return element;
  }

  function hideElement(element, category) {
    if (
      !(element instanceof HTMLElement) ||
      element.matches('html, body, main, [role="main"], [role="feed"], #mount_0_0') ||
      element.querySelector('main, [role="main"], [role="feed"]') ||
      element.matches('[aria-busy="true"], [role="progressbar"]') ||
      element.dataset.qfAllowed === "true" ||
      hiddenElements.has(element)
    ) {
      return;
    }
    const placeholder = settings.cleanMode ? null : createPlaceholder(category, element);
    hiddenElements.set(element, placeholder);
    if (placeholder) element.insertAdjacentElement("afterend", placeholder);
    element.classList.add("qf-hidden");
    element.setAttribute("data-qf-filtered", category || "other");
    if (debugMode) {
      console.debug("[QuietFeed]", category || "other", element.innerText?.slice(0, 80), element);
    }

    if (category && !countedElements.has(element)) {
      countedElements.add(element);
      if (category in pendingCounts) {
        pendingCounts[category] += 1;
      }
      appendFilterLog(
        category,
        (element.innerText || element.textContent || "").slice(0, 120),
        extractPostMeta(element),
      );
      scheduleCountFlush();
    }
  }

  function extractPostMeta(element) {
    let url = null;
    const link = element.querySelector(POST_LINK_SELECTOR);
    if (link?.href) {
      try {
        url = new URL(link.href, location.href).href;
      } catch {
        // Ignore malformed hrefs; log entry just won't have a link.
      }
    }
    const authorLink = element.querySelector(POST_AUTHOR_SELECTOR);
    const author = authorLink ? (authorLink.textContent || "").trim().slice(0, 80) : null;
    return { url, author: author || null };
  }

  function restoreAll() {
    hiddenElements.forEach((placeholder, element) => {
      placeholder?.remove();
      if (!element.isConnected) return;
      element.classList.remove("qf-hidden");
      element.removeAttribute("data-qf-filtered");
    });
    hiddenElements.clear();
  }

  function createPlaceholder(category, element) {
    const placeholder = document.createElement("div");
    placeholder.className = "qf-placeholder";
    placeholder.setAttribute("data-qf-placeholder", "true");
    renderShowPrompt(placeholder, category, element);
    return placeholder;
  }

  function renderShowPrompt(placeholder, category, element) {
    placeholder.replaceChildren();
    const message = document.createElement("span");
    message.textContent = `Quiet Feed removed a ${category || "distracting"} item.`;
    const showButton = document.createElement("button");
    showButton.type = "button";
    showButton.className = "qf-show-button";
    showButton.textContent = "Show this item";
    showButton.addEventListener("click", () => {
      const itemKey = getItemKey(element);
      rememberRevealedItem(itemKey);
      element.dataset.qfAllowed = "true";
      element.classList.remove("qf-hidden");
      element.removeAttribute("data-qf-filtered");
      hiddenElements.delete(element);
      renderHideAgainPrompt(placeholder, category, element, itemKey);
    });
    placeholder.append(message, showButton);
  }

  function renderHideAgainPrompt(placeholder, category, element, itemKey) {
    placeholder.replaceChildren();
    const message = document.createElement("span");
    message.textContent = "Quiet Feed is showing this item.";
    const hideButton = document.createElement("button");
    hideButton.type = "button";
    hideButton.className = "qf-show-button";
    hideButton.textContent = "Hide again";
    hideButton.addEventListener("click", () => {
      forgetRevealedItem(itemKey);
      delete element.dataset.qfAllowed;
      placeholder.remove();
      hideElement(element, category);
    });
    placeholder.append(message, hideButton);
  }

  function getItemKey(element) {
    const link = element.querySelector(POST_LINK_SELECTOR);
    if (link?.href) {
      try {
        const url = new URL(link.href, location.href);
        const storyId = url.searchParams.get("story_fbid");
        return storyId ? `story:${storyId}` : `${url.hostname}${url.pathname}`;
      } catch {
        // Fall through to a stable pagelet when Facebook provides one.
      }
    }
    const pagelet = element.getAttribute("data-pagelet");
    return /^FeedUnit_\d{5,}$/.test(pagelet || "") ? `pagelet:${pagelet}` : null;
  }

  function rememberRevealedItem(itemKey) {
    if (!itemKey) return;
    revealedItemKeys.add(itemKey);
    if (revealedItemKeys.size > 500) {
      revealedItemKeys.delete(revealedItemKeys.values().next().value);
    }
    persistRevealedKeys();
  }

  function forgetRevealedItem(itemKey) {
    if (!itemKey) return;
    revealedItemKeys.delete(itemKey);
    persistRevealedKeys();
  }

  function persistRevealedKeys() {
    chrome.storage.session
      .set({ quietFeedRevealed: [...revealedItemKeys] })
      .catch(() => {});
  }

  function loadRevealedKeys() {
    chrome.storage.session.get("quietFeedRevealed").then((stored) => {
      const keys = stored?.quietFeedRevealed;
      if (Array.isArray(keys)) {
        keys.slice(-500).forEach((k) => revealedItemKeys.add(k));
      }
    }).catch(() => {});
  }

  function scheduleCountFlush() {
    clearTimeout(countTimer);
    countTimer = setTimeout(flushCounts, 800);
  }

  async function flushCounts() {
    const delta = { ...pendingCounts };
    const entries = pendingLogEntries.splice(0);
    for (const key of Object.keys(pendingCounts)) pendingCounts[key] = 0;
    if (!Object.values(delta).some(Boolean) && entries.length === 0) return;
    try {
      await chrome.runtime.sendMessage({ type: "QF_INCREMENT_STATS", delta, entries });
    } catch (error) {
      console.debug("Quiet Feed counter update was deferred", error);
      for (const key of Object.keys(pendingCounts)) pendingCounts[key] += delta[key];
      pendingLogEntries.unshift(...entries);
      scheduleCountFlush();
    }
  }

  function sanitizeLogEntries(value) {
    if (!Array.isArray(value)) return [];
    const validCategories = new Set(["reels", "suggested", "sponsored", "custom"]);
    return value.filter(
      (e) => e && typeof e === "object" && validCategories.has(e.category) && typeof e.text === "string"
    ).map((e) => ({
      ts: Number(e.ts) || Date.now(),
      category: e.category,
      text: String(e.text).slice(0, 120),
      url: typeof e.url === "string" ? e.url.slice(0, 300) : null,
      author: typeof e.author === "string" ? e.author.slice(0, 80) : null,
    }));
  }

  function appendFilterLog(category, text, meta) {
    appendFilterLogEntries([{
      ts: Date.now(),
      category,
      text: text.trim().slice(0, 120),
      url: meta?.url || null,
      author: meta?.author || null,
    }]);
  }

  function appendFilterLogEntries(newEntries) {
    pendingLogEntries.push(...newEntries);
    if (pendingLogEntries.length > 100) {
      pendingLogEntries.splice(0, pendingLogEntries.length - 100);
    }
  }

  const INDICATOR_STATUS_TITLE = {
    advanced: "Quiet Feed: advanced filters active",
    fallback: "Quiet Feed: basic filters active",
    waiting: "Quiet Feed: starting…",
  };

  function ensureIndicator() {
    if (indicatorEl?.isConnected) return indicatorEl;
    indicatorEl = document.createElement("div");
    indicatorEl.id = "qf-indicator";
    indicatorEl.className = "qf-indicator";
    indicatorEl.setAttribute("aria-hidden", "true");
    const dot = document.createElement("span");
    dot.className = "qf-indicator__dot";
    const label = document.createElement("span");
    label.className = "qf-indicator__label";
    label.textContent = "Quiet Feed";
    indicatorEl.append(dot, label);
    (document.body || document.documentElement).appendChild(indicatorEl);
    return indicatorEl;
  }

  function updateIndicator() {
    if (!settings?.showIndicator) {
      indicatorEl?.remove();
      indicatorEl = null;
      return;
    }
    const el = ensureIndicator();
    const status = getFilterStatus();
    el.dataset.status = status;
    el.title = INDICATOR_STATUS_TITLE[status];
  }

  function showFallbackToast() {    const toast = document.createElement("div");
    toast.id = "qf-fallback-toast";
    toast.setAttribute("role", "status");
    toast.setAttribute("aria-live", "polite");
    toast.textContent = "Quiet Feed: using basic filters (advanced hooks unavailable).";
    Object.assign(toast.style, {
      position: "fixed",
      bottom: "20px",
      right: "20px",
      zIndex: "999999",
      padding: "10px 14px",
      borderRadius: "8px",
      background: "var(--qf-filter-surface, #242526)",
      color: "var(--qf-filter-secondary, #b0b3b8)",
      font: "13px/1.4 'Segoe UI',system-ui,sans-serif",
      boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
      maxWidth: "min(320px, calc(100vw - 40px))",
      boxSizing: "border-box",
      opacity: "1",
      transition: "opacity 600ms ease",
    });
    (document.body || document.documentElement).appendChild(toast);
    setTimeout(() => { toast.style.opacity = "0"; }, 4000);
    setTimeout(() => { toast.remove(); }, 4700);
  }

  function injectStyle() {
    const style = document.createElement("style");
    style.id = "quiet-feed-style";
    style.textContent = [
      ".qf-hidden{display:none!important}",
      ".qf-placeholder{display:flex;align-items:center;justify-content:space-between;gap:12px;margin:8px 0;padding:10px 14px;border-radius:8px;color:#65676b;background:#fff;border:1px solid rgba(0,0,0,0.08);font:14px/1.34 'Segoe UI',system-ui,sans-serif}",
      "@media(prefers-color-scheme:dark){.qf-placeholder{color:#b0b3b8;background:#242526;border-color:rgba(255,255,255,0.06)}}",
      ".qf-show-button{padding:6px 12px;border:1px solid rgba(0,0,0,0.15);border-radius:20px;background:#f0f2f5;color:#050505;cursor:pointer;font:600 13px/1 'Segoe UI',system-ui,sans-serif;white-space:nowrap;transition:background 100ms ease}",
      ".qf-show-button:hover{background:#e4e6eb}",
      "@media(prefers-color-scheme:dark){.qf-show-button{border-color:rgba(255,255,255,0.1);background:#3a3b3c;color:#e4e6eb}.qf-show-button:hover{background:#4e4f50}}",
      ".qf-show-button:focus-visible{outline:2px solid #1877f2;outline-offset:2px}",
      "@media(prefers-color-scheme:dark){.qf-show-button:focus-visible{outline-color:#2374e1}}",
      "@media(max-width:480px){.qf-placeholder{flex-wrap:wrap;gap:8px;min-width:0;padding:10px}.qf-placeholder>span{min-width:0;overflow-wrap:anywhere}}",
      "@media(max-width:480px){.qf-indicator{left:8px;bottom:8px;padding:6px}.qf-indicator__label{display:none}}",
      ".qf-indicator{position:fixed;left:20px;bottom:20px;z-index:999998;display:flex;align-items:center;gap:6px;padding:6px 10px;border-radius:20px;background:#fff;border:1px solid rgba(0,0,0,0.08);box-shadow:0 2px 8px rgba(0,0,0,0.15);font:600 12px/1 'Segoe UI',system-ui,sans-serif;color:#65676b;user-select:none;pointer-events:none}",
      "@media(prefers-color-scheme:dark){.qf-indicator{background:#242526;border-color:rgba(255,255,255,0.06);color:#b0b3b8}}",
      ".qf-indicator__dot{width:8px;height:8px;border-radius:50%;background:#8a8d91;flex-shrink:0}",
      ".qf-indicator[data-status=\"advanced\"] .qf-indicator__dot{background:#42b72a}",
      ".qf-indicator[data-status=\"fallback\"] .qf-indicator__dot{background:#f7b928}",
    ].join("");
    (document.head || document.documentElement).appendChild(style);
  }
})();
