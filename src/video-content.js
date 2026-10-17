(function initializeVideoControls() {
  "use strict";
  const { isMediaUrl } = QuietFeed;
  const pending = new Map();
  const controls = new Map();
  const pendingRoots = new Set();
  const selector = "[data-qf-video-id], video";
  let enabled = false;
  let scanTimer;
  let observer;
  let ready = false;
  let activeControl = null;
  let theme = "system";

  chrome.storage.local.get([QuietFeed.STORAGE_KEYS.settings, "quietFeedTheme"]).then((stored) => {
    theme = stored.quietFeedTheme;
    enabled = QuietFeed.mergeSettings(stored[QuietFeed.STORAGE_KEYS.settings]).downloadVideos;
    start();
  }).catch(console.error);
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (changes.quietFeedTheme) {
      theme = changes.quietFeedTheme.newValue;
      for (const control of controls.values()) {
        applyTheme(control.host); applyTheme(control.overlay);
      }
      activeControl?.position();
    }
    if (!changes[QuietFeed.STORAGE_KEYS.settings]) return;
    enabled = QuietFeed.mergeSettings(changes[QuietFeed.STORAGE_KEYS.settings].newValue).downloadVideos;
    if (ready) updateObservation();
  });
  window.addEventListener("message", (event) => {
    if (event.source !== window || event.data?.source !== "quiet-feed-video-page") return;
    const resolve = pending.get(event.data.requestId);
    if (!resolve) return;
    pending.delete(event.data.requestId);
    resolve(event.data.result);
  });

  function start() {
    if (!document.body) { document.addEventListener("DOMContentLoaded", start, { once: true }); return; }
    ready = true;
    observer = new MutationObserver((records) => {
      let removed = false;
      for (const record of records) {
        if (record.type === "attributes") queueRoot(record.target);
        for (const node of record.addedNodes) queueRoot(node);
        if (record.removedNodes.length) removed = true;
      }
      if (removed && controls.size) schedule();
    });
    document.addEventListener("loadedmetadata", (event) => queueRoot(event.target), true);
    document.addEventListener("pointerdown", (event) => {
      if (activeControl && !event.composedPath().includes(activeControl.host) &&
          !event.composedPath().includes(activeControl.overlay)) activeControl.close();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape" && activeControl) {
        const button = activeControl.button;
        activeControl.close(); button.focus();
      }
    });
    const reposition = () => {
      for (const control of controls.values()) control.positionButton();
      activeControl?.position();
    };
    window.addEventListener("resize", reposition);
    window.addEventListener("scroll", () => activeControl?.position(), true);
    window.visualViewport?.addEventListener("resize", reposition);
    window.visualViewport?.addEventListener("scroll", () => activeControl?.position());
    updateObservation();
  }

  function updateObservation() {
    observer.disconnect();
    clearTimeout(scanTimer); scanTimer = null;
    pendingRoots.clear();
    if (!enabled) {
      for (const control of controls.values()) control.dispose();
      controls.clear();
      for (const resolve of pending.values()) resolve(null);
      pending.clear();
      return;
    }
    // Observe the stable document root: mobile navigation can replace <body>.
    observer.observe(document.documentElement, { childList: true, subtree: true,
      attributes: true, attributeFilter: ["src", "data-qf-video-id"] });
    pendingRoots.add(document);
    schedule();
  }

  function queueRoot(node) {
    if (!enabled || !(node instanceof Element) || node.closest("[data-qf-video-control]")) return;
    if (!node.matches(selector) && !node.querySelector(selector)) return;
    if (pendingRoots.has(document)) return;
    if (pendingRoots.size >= 50) { pendingRoots.clear(); pendingRoots.add(document); }
    else pendingRoots.add(node);
    schedule();
  }

  function schedule() {
    if (scanTimer) return;
    scanTimer = setTimeout(() => { scanTimer = null; scan(); }, 200);
  }

  function scan() {
    for (const [element, control] of controls) {
      if (!enabled || !element.isConnected || !control.host.isConnected ||
          control.identity !== identity(element)) {
        control.dispose(); controls.delete(element);
        if (element.isConnected) pendingRoots.add(element);
      } else control.positionButton();
    }
    if (!enabled) return;
    const roots = [...pendingRoots];
    pendingRoots.clear();
    const candidates = new Set();
    for (const root of roots) {
      if (root !== document && !root.isConnected) continue;
      if (root instanceof Element && root.matches(selector)) candidates.add(root);
      root.querySelectorAll(selector).forEach((element) => candidates.add(element));
    }
    for (const element of candidates) {
      if (controls.has(element)) continue;
      if (element.tagName !== "VIDEO") {
        if (element.dataset.qfVideoId) attach(element, () => requestSources(element.dataset.qfVideoId));
      } else if (isMediaUrl(identity(element)) &&
          !element.parentElement?.querySelector("[data-qf-video-id]")) {
        attach(element, async () => ({ id: "video", title: "Facebook video", sources: [{
          url: identity(element), label: "Current file", kind: "video", withSound: null,
        }] }));
      }
    }
  }

  function identity(element) {
    return element.tagName === "VIDEO" ? element.currentSrc || element.src : element.dataset.qfVideoId;
  }

  function postMetadata(element) {
    const post = element.closest('article,[role="article"],[data-pagelet^="FeedUnit"]');
    // Avoid naming a clip after an adjacent post, or another clip in a carousel.
    if (!post || post.querySelectorAll("video").length > 1) return {};
    const text = (selector) => post.querySelector(selector)?.textContent?.trim();
    return {
      title: text('[data-ad-rendering-role="story_message"], [data-ad-preview="message"]'),
      author: text('h2 a, h3 a, [role="heading"] a'),
    };
  }

  function playerFor(element) {
    if (element.tagName === "VIDEO") return element;
    const sibling = element.nextElementSibling;
    if (sibling) {
      if (sibling.tagName === "VIDEO") return sibling;
      const videos = sibling.querySelectorAll("video");
      if (videos.length === 1) return videos[0];
      const rect = sibling.getBoundingClientRect();
      if (!videos.length && rect.width >= 80 && rect.height >= 80) return sibling;
    }
    let parent = element.parentElement;
    for (let depth = 0; parent && depth < 5; depth++, parent = parent.parentElement) {
      const videos = parent.querySelectorAll("video");
      if (videos.length === 1) return videos[0];
      if (videos.length > 1 || parent.matches('article,[role="article"],body')) break;
    }
    return null;
  }

  function requestSources(id) {
    return new Promise((resolve) => {
      const requestId = crypto.randomUUID();
      const timer = setTimeout(() => { pending.delete(requestId); resolve({ error: "timeout" }); }, 2500);
      pending.set(requestId, (result) => { clearTimeout(timer); resolve(result); });
      window.postMessage({ source: "quiet-feed-video-ui", type: "QFV_SOURCES", requestId, id }, location.origin);
    });
  }

  function attach(element, getSources) {
    // The hook marker must not create an inline line box above the player.
    // Use a zero-height anchor with an absolutely positioned button; never
    // change the dimensions or positioning of Facebook's player container.
    const anchor = element.tagName === "VIDEO" ? document.createElement("span") : element;
    anchor.style.cssText = "display:block;position:absolute;width:0;height:0;min-height:0;padding:0;margin:0;border:0;overflow:visible;z-index:20";
    if (anchor !== element) {
      anchor.dataset.qfVideoControl = "anchor";
      element.insertAdjacentElement("beforebegin", anchor);
    }
    const host = document.createElement("span");
    host.dataset.qfVideoControl = "button";
    host.style.cssText = "display:block;position:absolute;width:max-content;z-index:20;visibility:hidden";
    const shadow = host.attachShadow({ mode: "open" });
    const style = document.createElement("style");
    // Shadow tokens mirror shared/theme.css without resetting Facebook styles.
    style.textContent = `
      :host {
        --qf-surface:#242526; --qf-hover:#3a3b3c; --qf-ink:#e4e6eb;
        --qf-secondary:#b0b3b8; --qf-line:rgba(255,255,255,.1);
        --qf-accent:#2374e1; --qf-accent-hover:#1a6dd1;
        color-scheme:dark; color:var(--qf-ink);
        font:13px/1.34 "Segoe UI",system-ui,-apple-system,BlinkMacSystemFont,sans-serif;
      }
      @media(prefers-color-scheme:light) {
        :host(:not([data-theme])) {
          --qf-surface:#fff; --qf-hover:#f0f2f5; --qf-ink:#050505;
          --qf-secondary:#65676b; --qf-line:rgba(0,0,0,.1);
          --qf-accent:#1877f2; --qf-accent-hover:#166fe5; color-scheme:light;
        }
      }
      :host([data-theme="light"]) {
        --qf-surface:#fff; --qf-hover:#f0f2f5; --qf-ink:#050505;
        --qf-secondary:#65676b; --qf-line:rgba(0,0,0,.1);
        --qf-accent:#1877f2; --qf-accent-hover:#166fe5; color-scheme:light;
      }
      *{box-sizing:border-box}
      button{font:inherit;cursor:pointer;border:0;min-height:36px;max-width:100%;overflow-wrap:anywhere;transition:background 100ms ease}
      button:focus-visible{outline:2px solid var(--qf-accent);outline-offset:2px}
      button:disabled{opacity:.6;cursor:wait}
      .trigger{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;min-height:36px;padding:0;border:1px solid var(--qf-line);border-radius:50%;background:var(--qf-surface);color:var(--qf-ink);box-shadow:0 2px 8px rgba(0,0,0,.18);user-select:none}
      .trigger:hover,.trigger[aria-expanded="true"]{background:var(--qf-hover);color:var(--qf-ink)}
      .trigger svg{width:16px;height:16px;fill:none;stroke:currentColor;stroke-width:1.8;stroke-linecap:round;stroke-linejoin:round}
      .menu{position:fixed;width:min(290px,calc(100vw - 16px));max-height:min(360px,calc(100dvh - 16px));overflow:auto;scrollbar-width:thin;scrollbar-color:var(--qf-hover) transparent;overscroll-behavior:contain;pointer-events:auto;background:var(--qf-surface);color:var(--qf-ink);border:1px solid var(--qf-line);border-radius:12px;padding:6px;box-shadow:0 8px 28px rgba(0,0,0,.24)}
      .menu-header{display:flex;align-items:center;justify-content:space-between;padding:8px 8px 4px;gap:12px}
      .menu-heading{display:block;font-size:13px;font-weight:600}
      .menu-caption{display:block;color:var(--qf-secondary);font-size:10px;letter-spacing:.03em;margin-bottom:3px}
      .dismiss{display:grid;place-items:center;min-height:26px;width:26px;flex-shrink:0;padding:0;border-radius:6px;background:transparent;color:var(--qf-secondary);font-size:20px;line-height:1}
      .dismiss:hover{background:var(--qf-hover);color:var(--qf-ink)}
      .status{display:block;white-space:normal;overflow-wrap:anywhere;padding:4px 8px 10px;color:var(--qf-secondary);font-size:12px;line-height:1.5}
      .retry{margin:0 8px 8px;padding:0 12px;min-height:30px;border:1px solid var(--qf-line);border-radius:6px;background:transparent;color:var(--qf-ink);font-size:12px;font-weight:600}
      .retry:hover{background:var(--qf-hover)}
      .choice{display:flex;align-items:center;justify-content:space-between;gap:12px;width:100%;text-align:left;padding:10px 8px;border-radius:6px;background:transparent;color:var(--qf-ink);font-weight:600}
      .choice:hover{background:var(--qf-hover)}
      .choice-copy{display:grid;gap:3px}
      .choice-detail{color:var(--qf-secondary);font-size:11px;font-weight:400}
      .choice-arrow{flex-shrink:0;color:var(--qf-secondary);font-size:16px;font-weight:400}
      [hidden]{display:none!important}
      @media(pointer:coarse){button{min-height:44px}.trigger{width:44px;height:44px}}
      @media(prefers-reduced-motion:reduce){button{transition:none}}
      @media(forced-colors:active){.trigger,.menu{border:1px solid ButtonText}.choice:focus-visible{outline-color:Highlight}}
    `;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "trigger";
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m-4-4 4 4 4-4M5 16v4h14v-4"/></svg>';
    button.setAttribute("aria-label", "Download video");
    button.title = "Download video";
    button.setAttribute("aria-expanded", "false");
    const menu = document.createElement("div");
    menu.className = "menu";
    menu.setAttribute("role", "region");
    menu.setAttribute("aria-label", "Video downloads");
    menu.hidden = true;
    const status = document.createElement("span");
    status.className = "status";
    status.setAttribute("role", "status");
    const header = document.createElement("div");
    header.className = "menu-header";
    const heading = document.createElement("div");
    const caption = document.createElement("span");
    caption.className = "menu-caption";
    caption.textContent = "QUIET FEED";
    const title = document.createElement("span");
    title.className = "menu-heading";
    title.textContent = "Save video";
    heading.append(caption, title);
    const dismiss = document.createElement("button");
    dismiss.className = "dismiss";
    dismiss.type = "button";
    dismiss.setAttribute("aria-label", "Close downloads");
    dismiss.textContent = "×";
    dismiss.addEventListener("click", (event) => { event.stopPropagation(); close(); button.focus(); });
    header.append(heading, dismiss);
    const retry = document.createElement("button");
    retry.className = "retry";
    retry.type = "button";
    retry.textContent = "Try again";
    retry.addEventListener("click", (event) => { event.stopPropagation(); loadSources(); });
    const overlay = document.createElement("span");
    overlay.dataset.qfVideoControl = "menu";
    overlay.style.cssText = "position:fixed;inset:0;z-index:2147483647;pointer-events:none";
    overlay.attachShadow({ mode: "open" }).append(style.cloneNode(true), menu);
    applyTheme(host); applyTheme(overlay);
    let version = 0;
    let observedPlayer;
    const resizeObserver = new ResizeObserver(() => {
      positionButton();
      if (activeControl === control) position();
    });
    const control = { host, overlay, button, identity: identity(element), close, position, positionButton,
      dispose() { resizeObserver.disconnect(); close(); host.remove(); if (anchor !== element) anchor.remove(); } };

    function positionButton() {
      const player = playerFor(element);
      if (observedPlayer !== player) {
        resizeObserver.disconnect();
        observedPlayer = player;
        if (player) resizeObserver.observe(player);
        if (anchor.parentElement) resizeObserver.observe(anchor.parentElement);
      }
      const rect = player?.getBoundingClientRect();
      if (!rect || rect.width < 60 || rect.height < 60) {
        host.style.visibility = "hidden";
        if (activeControl === control) close();
        return;
      }
      const origin = anchor.getBoundingClientRect();
      const container = anchor.offsetParent;
      const bounds = container?.getBoundingClientRect();
      const scaleX = container?.offsetWidth ? bounds.width / container.offsetWidth : 1;
      const scaleY = container?.offsetHeight ? bounds.height / container.offsetHeight : 1;
      if (!scaleX || !scaleY) return;
      host.style.left = `${(rect.right - origin.left) / scaleX - button.offsetWidth - 8}px`;
      host.style.top = `${(rect.top - origin.top) / scaleY + 8}px`;
      host.style.visibility = "visible";
    }
    function close() {
      version++;
      menu.hidden = true;
      overlay.remove();
      button.setAttribute("aria-expanded", "false");
      if (activeControl === control) activeControl = null;
    }
    function position() {
      if (menu.hidden) return;
      positionButton();
      if (menu.hidden) return;
      const rect = button.getBoundingClientRect();
      const viewport = window.visualViewport;
      const width = viewport?.width || window.innerWidth;
      const height = viewport?.height || window.innerHeight;
      const left = viewport?.offsetLeft || 0;
      const top = viewport?.offsetTop || 0;
      if (!host.isConnected || !rect.width || !rect.height || rect.bottom < top ||
          rect.top > top + height || rect.right < left || rect.left > left + width) { close(); return; }
      const menuWidth = Math.max(0, Math.min(290, width - 16));
      const below = Math.max(0, top + height - rect.bottom - 16);
      const above = Math.max(0, rect.top - top - 16);
      const upwards = below < 200 && above > below;
      menu.style.width = `${menuWidth}px`;
      menu.style.maxHeight = `${Math.max(0, Math.min(360, upwards ? above : below))}px`;
      menu.style.left = `${Math.max(left + 8, Math.min(rect.right - menuWidth, left + width - menuWidth - 8))}px`;
      menu.style.top = `${upwards ? Math.max(top + 8, rect.top - menu.getBoundingClientRect().height - 8) : rect.bottom + 8}px`;
    }
    menu.addEventListener("keydown", (event) => {
      if (event.key === "Escape") { close(); button.focus(); }
    });
    button.addEventListener("click", (event) => {
      if (!event.isTrusted) return;
      event.preventDefault(); event.stopPropagation();
      if (!menu.hidden) { close(); return; }
      activeControl?.close();
      activeControl = control;
      menu.hidden = false;
      button.setAttribute("aria-expanded", "true");
      document.documentElement.append(overlay);
      loadSources();
    });
    async function loadSources() {
      const currentVersion = ++version;
      const currentIdentity = identity(element);
      menu.replaceChildren(header, status);
      menu.setAttribute("aria-busy", "true");
      status.textContent = "Checking available files…";
      position();
      let result;
      let deadline;
      try { result = await Promise.race([getSources(), new Promise((resolve) => {
        deadline = setTimeout(() => resolve({ error: "timeout" }), 3000);
      })]); } catch { result = null; }
      finally { clearTimeout(deadline); }
      if (!enabled || !host.isConnected || currentVersion !== version) return;
      if (currentIdentity !== identity(element)) { close(); return; }
      menu.setAttribute("aria-busy", "false");
      const sources = Array.isArray(result?.sources) ? result.sources.slice(0, 80).filter((s) =>
        s && isMediaUrl(s.url) && ["video", "audio"].includes(s.kind)) : [];
      // A directly playing progressive file remains useful when Relay is missing.
      // Only use a uniquely associated player, never a different video in the feed.
      if (!sources.length) {
        const players = element.tagName === "VIDEO" ? [element] : element.parentElement?.querySelectorAll("video");
        if (players?.length === 1 && isMediaUrl(identity(players[0]))) {
          sources.push({ url: identity(players[0]), label: "Current file", kind: "video", withSound: null });
        }
      }
      const audio = sources.find((s) => s.kind === "audio");
      status.textContent = sources.length ? "Choose a file to download." : result?.error === "timeout"
        ? "Video details didn’t respond. Play the video, then try again."
        : "No downloadable file yet. Play the video, then try again. Live and protected videos aren’t supported.";
      if (!sources.length) menu.append(retry);
      const seen = new Set();
      for (const source of sources) {
        if (seen.has(source.url)) continue;
        seen.add(source.url);
        const choice = document.createElement("button");
        choice.type = "button";
        choice.className = "choice";
        const merge = source.kind === "video" && source.withSound === false && audio;
        const label = String(source.label || "Video").slice(0, 40);
        const copy = document.createElement("span");
        copy.className = "choice-copy";
        const quality = document.createElement("span");
        quality.textContent = label;
        const detail = document.createElement("span");
        detail.className = "choice-detail";
        detail.textContent = merge ? "Video + audio · combined locally" : source.kind === "audio" ? "Audio only" : source.withSound === false ? "Video only · no sound" : source.withSound === true ? "Video with sound" : "Original file · sound unverified";
        copy.append(quality, detail);
        choice.append(copy);
        const arrow = document.createElement("span");
        arrow.className = "choice-arrow";
        arrow.setAttribute("aria-hidden", "true");
        arrow.textContent = "↓";
        choice.append(arrow);
        choice.addEventListener("click", async (click) => {
          if (!click.isTrusted) return;
          click.preventDefault(); click.stopPropagation();
          choice.disabled = true;
          status.textContent = "Starting download…";
          try {
            if (currentIdentity !== identity(element)) { close(); return; }
            const post = postMetadata(element);
            const title = result?.title && !/^(Facebook video|video|reel)$/i.test(result.title.trim())
              ? result.title : post.title;
            const filename = QuietFeed.videoFilename({ title, author: result?.author || post.author,
              id: result?.id || currentIdentity, label, kind: source.kind });
            const response = await chrome.runtime.sendMessage({ type: "QFV_DOWNLOAD", url: source.url,
              filename, audioUrl: merge ? audio.url : undefined });
            if (!response?.ok) throw new Error(response?.error || "Download failed");
            status.textContent = merge ? "Opened local video/audio merger. Keep that tab open until it finishes." : "Download started. Check your browser downloads.";
          } catch (error) { status.textContent = error.message; }
          finally { choice.disabled = false; }
        });
        menu.append(choice);
      }
      position();
    }
    shadow.append(style, button);
    anchor.append(host);
    controls.set(element, control);
    positionButton();
  }

  function applyTheme(host) {
    if (theme === "light" || theme === "dark") host.dataset.theme = theme;
    else host.removeAttribute("data-theme");
  }
})();
