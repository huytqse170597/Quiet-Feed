(function initializeQuietFeedUI(global) {
  "use strict";

  /**
   * Creates a feature toggle row.
   * @param {object} feature - Feature definition from FEATURES array.
   * @param {object} options
   * @param {object} options.settings - Current settings object.
   * @param {Set} options.pendingKeys - Keys currently being saved.
   * @param {function} options.onChange - Called with (key, newValue) on toggle.
   * @param {"compact"|"full"} [options.variant] - "compact" shows tooltip, "full" shows description paragraph.
   * @returns {HTMLElement}
   */
  function createFeatureRow(feature, options) {
    const { settings, pendingKeys, onChange, variant = "compact" } = options;
    const dependencyDisabled = feature.dependsOn && !settings[feature.dependsOn];
    const pending = pendingKeys.has(feature.key);
    const disabled = dependencyDisabled || pending;

    const row = document.createElement("div");
    row.className = "feature-row";
    row.setAttribute("aria-disabled", String(Boolean(disabled)));
    row.setAttribute("aria-busy", String(pending));
    if (!disabled) {
      row.setAttribute("tabindex", "0");
      row.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          if (!disabled) input.click();
        }
      });
    }

    const copy = document.createElement("div");
    copy.className = "feature-copy";

    if (variant === "compact") {
      const heading = document.createElement("div");
      heading.className = "feature-heading";
      const label = document.createElement("label");
      label.className = "feature-label";
      label.htmlFor = `feature-${feature.key}`;
      label.textContent = feature.label;
      const info = document.createElement("button");
      info.type = "button";
      info.className = "feature-info";
      info.setAttribute("aria-label", `About ${feature.label}`);
      const tooltip = document.createElement("span");
      tooltip.className = "feature-tooltip";
      tooltip.id = `tooltip-${feature.key}`;
      tooltip.setAttribute("role", "tooltip");
      tooltip.textContent = feature.description;
      info.setAttribute("aria-describedby", tooltip.id);
      info.append("i", tooltip);
      heading.append(label, info);
      copy.append(heading);
    } else {
      const label = document.createElement("label");
      label.className = "feature-label";
      label.htmlFor = `feature-${feature.key}`;
      label.textContent = feature.label;
      const description = document.createElement("p");
      description.className = "feature-description";
      description.textContent = feature.description;
      copy.append(label, description);
    }

    const switchLabel = document.createElement("label");
    switchLabel.className = "switch";
    if (variant === "compact") switchLabel.title = feature.description;
    const input = document.createElement("input");
    input.id = `feature-${feature.key}`;
    input.type = "checkbox";
    input.checked = settings[feature.key];
    input.disabled = Boolean(disabled);
    input.setAttribute("aria-label", feature.label);
    input.addEventListener("change", () => onChange(feature.key, input.checked));
    const track = document.createElement("span");
    track.className = "switch__track";
    track.setAttribute("aria-hidden", "true");
    switchLabel.append(input, track);
    row.append(copy, switchLabel);
    row.addEventListener("click", (event) => {
      if (disabled || event.target.closest("label, input, button")) return;
      input.click();
    });
    return row;
  }

  const THEME_KEY = "quietFeedTheme";
  const THEME_VALUES = ["system", "light", "dark"];

  function applyTheme(value) {
    const theme = THEME_VALUES.includes(value) ? value : "system";
    if (theme === "system") {
      document.documentElement.removeAttribute("data-theme");
    } else {
      document.documentElement.setAttribute("data-theme", theme);
    }
  }

  function loadAndApplyTheme() {
    chrome.storage.local.get(THEME_KEY).then((stored) => {
      applyTheme(stored[THEME_KEY]);
    }).catch(() => {});
  }

  /**
   * Creates a three-button theme toggle (light / system / dark).
   * Reads & writes `quietFeedTheme` in chrome.storage.local.
   * @returns {HTMLElement}
   */
  function createThemeToggle() {
    const current = document.documentElement.getAttribute("data-theme") || "system";

    const icons = {
      light: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`,
      system: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg>`,
      dark: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`,
    };
    const labels = { light: "Light", system: "System", dark: "Dark" };

    const wrapper = document.createElement("div");
    wrapper.className = "theme-toggle";
    wrapper.setAttribute("role", "group");
    wrapper.setAttribute("aria-label", "Theme");

    const buttons = {};
    function syncPressed(value) {
      const active = THEME_VALUES.includes(value) ? value : "system";
      for (const [k, b] of Object.entries(buttons)) {
        b.setAttribute("aria-pressed", String(k === active));
      }
    }

    for (const key of ["light", "system", "dark"]) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "theme-toggle__btn";
      btn.setAttribute("aria-label", labels[key]);
      btn.setAttribute("aria-pressed", String(current === key));
      btn.innerHTML = icons[key];
      btn.addEventListener("click", () => {
        chrome.storage.local.set({ [THEME_KEY]: key }).catch(() => {});
        applyTheme(key);
        syncPressed(key);
      });
      buttons[key] = btn;
      wrapper.append(btn);
    }

    // The stored theme loads asynchronously, so reconcile the pressed state
    // once it resolves rather than trusting the synchronous data-theme read.
    chrome.storage.local.get(THEME_KEY).then((stored) => {
      syncPressed(stored[THEME_KEY]);
    }).catch(() => {});

    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !changes[THEME_KEY]) return;
      const next = changes[THEME_KEY].newValue || "system";
      applyTheme(next);
      syncPressed(next);
    });

    return wrapper;
  }

  const api = Object.freeze({ createFeatureRow, createThemeToggle, loadAndApplyTheme });
  global.QuietFeedUI = api;
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
})(globalThis);
