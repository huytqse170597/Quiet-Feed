(function initializePopup() {
  "use strict";

  const { FEATURES, STORAGE_KEYS, mergeSettings, mergeStats } = QuietFeed;
  const { createFeatureRow, createThemeToggle, loadAndApplyTheme } = QuietFeedUI;
  const featureList = document.querySelector("#feature-list");
  const reloadAlert = document.querySelector("#reload-alert");
  const reloadButton = document.querySelector("#reload-facebook");
  const saveStatus = document.querySelector("#save-status");
  const tabButtons = Array.from(document.querySelectorAll("[data-tab]"));
  const pendingKeys = new Set();
  let settings = null;
  let activeTab = "feed";

  document.querySelector("#version").textContent = `v${chrome.runtime.getManifest().version}`;
  document.querySelector("#open-options").addEventListener("click", openOptions);
  document.querySelector("#theme-toggle-mount").append(createThemeToggle());
  loadAndApplyTheme();
  reloadButton.addEventListener("click", reloadFacebook);
  document.querySelector("#health-reload").addEventListener("click", reloadFacebook);
  document.querySelector("#dismiss-reload").addEventListener("click", () => {
    reloadAlert.hidden = true;
  });
  tabButtons.forEach((button) => {
    button.addEventListener("click", () => selectTab(button.dataset.tab));
    button.addEventListener("keydown", handleTabKeydown);
  });
  document.querySelectorAll("[data-category-action]").forEach((button) => {
    button.addEventListener("click", () => applyCategoryAction(button.dataset.categoryAction));
  });
  document.querySelector("#pause-filters").addEventListener("click", pauseFilters);

  loadState().catch(showError);

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName !== "local") return;
    if (changes[STORAGE_KEYS.stats]) renderStats(changes[STORAGE_KEYS.stats].newValue);
    if (changes[STORAGE_KEYS.settings]) {
      settings = mergeSettings(changes[STORAGE_KEYS.settings].newValue);
      renderFeatures();
    }
    if (changes.quietFeedPausedUntil) {
      syncPauseButton(changes.quietFeedPausedUntil.newValue);
    }
  });

  async function loadState() {
    const [response, stored] = await Promise.all([
      chrome.runtime.sendMessage({ type: "QF_GET_STATE" }),
      chrome.storage.local.get([STORAGE_KEYS.popupTab, "quietFeedPausedUntil"]),
    ]);
    if (!response?.ok) throw new Error(response?.error || "Could not load settings");
    if (["feed", "distractions"].includes(stored[STORAGE_KEYS.popupTab])) {
      activeTab = stored[STORAGE_KEYS.popupTab];
    }
    settings = mergeSettings(response.settings);
    renderStats(response.stats);
    selectTab(activeTab, false);
    syncPauseButton(stored.quietFeedPausedUntil);
    refreshFilterHealth();
  }

  function renderStats(value) {
    const stats = mergeStats(value);
    for (const key of Object.keys(stats)) {
      document.querySelector(`#stat-${key}`).textContent = stats[key].toLocaleString();
    }
  }

  function renderFeatures() {
    if (!settings) return;
    const groups = activeTab === "feed" ? ["feed", "behavior"] : ["distractions"];
    const features = FEATURES.filter((feature) => groups.includes(feature.group));
    featureList.replaceChildren(
      ...features.map(buildFeatureRow),
    );
    const categoryPending = features.some((feature) => pendingKeys.has(feature.key));
    document.querySelectorAll("[data-category-action]").forEach((button) => {
      button.disabled = categoryPending;
    });
  }

  function selectTab(tab, persist = true) {
    if (!tabButtons.some((button) => button.dataset.tab === tab)) return;
    activeTab = tab;
    tabButtons.forEach((button) => {
      const selected = button.dataset.tab === activeTab;
      button.setAttribute("aria-selected", String(selected));
      button.tabIndex = selected ? 0 : -1;
    });
    document
      .querySelector("#filter-panel")
      .setAttribute("aria-labelledby", activeTab === "feed" ? "tab-feed" : "tab-distractions");
    renderFeatures();
    if (persist) {
      chrome.storage.local
        .set({ [STORAGE_KEYS.popupTab]: activeTab })
        .catch((error) => console.debug("Could not remember popup tab", error));
    }
  }

  function handleTabKeydown(event) {
    if (!["ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    const direction = event.key === "ArrowRight" ? 1 : -1;
    const currentIndex = tabButtons.indexOf(event.currentTarget);
    const nextButton = tabButtons[(currentIndex + direction + tabButtons.length) % tabButtons.length];
    selectTab(nextButton.dataset.tab);
    nextButton.focus();
  }

  function buildFeatureRow(feature) {
    return createFeatureRow(feature, {
      settings,
      pendingKeys,
      onChange: updateFeature,
      variant: "compact",
    });
  }

  async function updateFeature(key, value) {
    if (pendingKeys.has(key)) return;
    const feature = FEATURES.find((item) => item.key === key);
    if (!(await confirmFeatureChange(feature, value))) {
      renderFeatures();
      return;
    }
    if (pendingKeys.has(key)) return;

    pendingKeys.add(key);
    renderFeatures();
    try {
      const response = await chrome.runtime.sendMessage({ type: "QF_SET_FEATURE", key, value });
      if (!response?.ok) throw new Error(response?.error || "Could not save setting");
      settings = mergeSettings(response.settings);
    } catch (error) {
      showError(error);
      return;
    } finally {
      pendingKeys.delete(key);
      renderFeatures();
    }
    saveStatus.hidden = true;
    await showReloadPrompt();
  }

  async function applyCategoryAction(action) {
    if (!settings) return;
    const features = getActiveFeatures();
    if (features.some((feature) => pendingKeys.has(feature.key))) return;
    const changes = Object.fromEntries(
      features.map((feature) => [
        feature.key,
        action === "enable" ? true : action === "disable" ? false : feature.defaultValue,
      ]),
    );
    if (Object.entries(changes).every(([key, enabled]) => settings[key] === enabled)) return;
    const suggested = features.find((feature) => feature.key === "removeSuggested");
    if (
      changes.removeSuggested &&
      !settings.removeSuggested &&
      !(await confirmFeatureChange(suggested, true))
    ) {
      return;
    }

    features.forEach((feature) => pendingKeys.add(feature.key));
    renderFeatures();
    try {
      settings = mergeSettings(await saveFeatureChanges(changes));
    } catch (error) {
      showError(error);
      return;
    } finally {
      features.forEach((feature) => pendingKeys.delete(feature.key));
      renderFeatures();
    }
    saveStatus.hidden = true;
    await showReloadPrompt();
  }

  function getActiveFeatures() {
    const groups = activeTab === "feed" ? ["feed", "behavior"] : ["distractions"];
    return FEATURES.filter((feature) => groups.includes(feature.group));
  }

  async function saveFeatureChanges(changes) {
    const response = await chrome.runtime.sendMessage({ type: "QF_SET_FEATURES", value: changes });
    if (response?.ok) return response.settings;
    if (!/unknown quiet feed message/i.test(response?.error || "")) {
      throw new Error(response?.error || "Could not save settings");
    }

    // A freshly loaded popup can briefly outlive an older extension service worker.
    // Fall back to the single-feature contract that earlier workers understand.
    let latestSettings = settings;
    for (const [key, value] of Object.entries(changes)) {
      const fallback = await chrome.runtime.sendMessage({ type: "QF_SET_FEATURE", key, value });
      if (!fallback?.ok) throw new Error(fallback?.error || "Could not save settings");
      latestSettings = fallback.settings;
    }
    return latestSettings;
  }

  function confirmFeatureChange(feature, value) {
    if (!value || !feature?.confirmation) return Promise.resolve(true);
    const dialog = document.querySelector("#suggested-confirm");
    document.querySelector("#suggested-confirm-copy").textContent = feature.confirmation;
    dialog.returnValue = "cancel";
    dialog.showModal();
    return new Promise((resolve) => {
      dialog.addEventListener("close", () => resolve(dialog.returnValue === "confirm"), {
        once: true,
      });
    });
  }

  async function showReloadPrompt() {
    reloadAlert.hidden = false;
    const response = await chrome.runtime.sendMessage({ type: "QF_GET_FILTER_HEALTH" });
    if (!response?.ok) return;
    renderFilterHealth(response);
    const count = response.tabCount;
    document.querySelector("#reload-copy").textContent = count
      ? `Optional: Reload ${count} Facebook ${count === 1 ? "tab" : "tabs"} to ensure this setting is fully applied.`
      : "Setting saved. Open Facebook to apply it.";
    reloadButton.hidden = count === 0;
    reloadButton.textContent = count === 1 ? "Reload tab" : `Reload ${count} tabs`;
  }

  async function reloadFacebook() {
    const response = await chrome.runtime.sendMessage({ type: "QF_RELOAD_FACEBOOK_TABS" });
    if (!response?.ok || !response.reloaded) {
      return showError(new Error(response?.reason || response?.error || "Could not reload Facebook"));
    }
    window.close();
  }

  async function refreshFilterHealth() {
    try {
      const response = await chrome.runtime.sendMessage({ type: "QF_GET_FILTER_HEALTH" });
      if (response?.ok) renderFilterHealth(response);
    } catch {
      renderFilterHealth({ status: "inactive", label: "Filter status unavailable" });
    }
  }

  function renderFilterHealth(value) {
    const health = document.querySelector("#filter-health");
    health.dataset.status = value.status;
    document.querySelector("#filter-health-label").textContent = value.label;
    const action = document.querySelector("#health-reload");
    action.hidden = !value.tabCount || !["fallback", "waiting"].includes(value.status);
  }

  async function openOptions() {
    await chrome.runtime.sendMessage({ type: "QF_OPEN_OPTIONS" });
    window.close();
  }

  function showError(error) {
    saveStatus.hidden = false;
    saveStatus.textContent = error.message;
  }

  async function pauseFilters() {
    const pausedUntil = Date.now() + 5 * 60 * 1000;
    await chrome.storage.local.set({ quietFeedPausedUntil: pausedUntil });
    syncPauseButton(pausedUntil);
  }

  let pauseSyncTimer = null;
  function syncPauseButton(pausedUntil) {
    const btn = document.querySelector("#pause-filters");
    clearTimeout(pauseSyncTimer);
    const remaining = Number(pausedUntil) - Date.now();
    if (remaining > 0) {
      btn.textContent = "Paused";
      btn.disabled = true;
      pauseSyncTimer = setTimeout(() => syncPauseButton(pausedUntil), Math.min(remaining, 60000));
    } else {
      btn.textContent = "Pause 5 min";
      btn.disabled = false;
    }
  }
})();
