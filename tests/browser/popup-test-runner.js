(async function runPopupBrowserTests() {
  "use strict";

  const results = [];
  const wait = (milliseconds = 0) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const waitFor = async (predicate, message, timeout = 1500) => {
    const deadline = Date.now() + timeout;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error(message);
      await wait(20);
    }
  };
  const check = (condition, message) => {
    if (!condition) throw new Error(message);
    results.push(message);
  };

  try {
    const feedFeatureCount = QuietFeed.FEATURES.filter((feature) => ["feed", "behavior"].includes(feature.group)).length;
    await waitFor(() => document.querySelectorAll("#feature-list .feature-row").length === feedFeatureCount, "Feed tab did not render");
    check(document.querySelectorAll("#feature-list .feature-row").length === feedFeatureCount, "Feed tab shows all feed settings");
    const infoButton = document.querySelector(".feature-info");
    const tooltip = infoButton.querySelector(".feature-tooltip");
    check(getComputedStyle(tooltip).visibility === "hidden", "Descriptions stay hidden by default");
    infoButton.focus();
    await waitFor(() => getComputedStyle(tooltip).visibility === "visible", "Tooltip did not open on focus");
    check(getComputedStyle(tooltip).visibility === "visible", "Description tooltip opens on focus");
    const initialChecked = document.querySelector('#feature-list input').checked;
    infoButton.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await wait(60);
    check(document.querySelector('#feature-list input').checked === initialChecked,
      "Using an info button does not toggle its feature");
    await waitFor(
      () => document.querySelector("#filter-health-label").textContent === "Advanced filters active",
      "Filter health did not render",
    );
    check(document.querySelector("#filter-health-label").textContent === "Advanced filters active", "Filter health renders");

    document.querySelector("#tab-distractions").click();
    await waitFor(() => document.querySelectorAll("#feature-list .feature-row").length === 5, "Distractions tab did not render");
    check(document.querySelectorAll("#feature-list .feature-row").length === 5, "Distractions tab shows all settings");
    check(window.__quietFeedTest.store.quietFeedPopupTab === "distractions", "Selected tab is remembered");

    document.querySelector("#tab-privacy").click();
    check(document.querySelectorAll("#feature-list .feature-row").length === 3, "Privacy tab shows all three controls");
    check([...document.querySelectorAll("#feature-list input")].every((input) => !input.checked), "Privacy controls default to disabled");
    check(!document.querySelector("#privacy-note").hidden, "Privacy limitations are visible");
    check(document.querySelector("#pause-filters").hidden, "Feed pause is separate from privacy");
    check(document.querySelector("#filter-panel").getAttribute("aria-labelledby") === "tab-privacy", "Privacy panel has the selected tab label");
    document.querySelector("#feature-hideReadReceipts").click();
    await waitFor(() => window.__quietFeedTest.settings.hideReadReceipts === true, "Privacy toggle did not save");
    await waitFor(() => !document.querySelector("#feature-hideReadReceipts").disabled, "Privacy save did not finish");
    check(window.__quietFeedTest.settings.removeReels, "Privacy toggle preserves feed settings");
    check(document.querySelector("#reload-alert").hidden, "Privacy save does not offer a feed-only reload");
    document.querySelector('[data-category-action="defaults"]').click();
    await waitFor(() => window.__quietFeedTest.settings.hideReadReceipts === false, "Privacy defaults did not reset");
    await waitFor(() => !document.querySelector("#feature-hideReadReceipts").disabled, "Privacy defaults save did not finish");
    check(window.__quietFeedTest.settings.removeReels, "Privacy defaults preserve feed settings");

    document.querySelector("#tab-feed").click();
    const suggested = document.querySelector("#feature-removeSuggested");
    suggested.click();
    await waitFor(() => document.querySelector("#suggested-confirm").open, "Confirmation dialog did not open");
    check(document.querySelector("#suggested-confirm").open, "Suggested-content dialog opens");
    document.querySelector('#suggested-confirm [value="cancel"]').click();
    await waitFor(() => !document.querySelector("#suggested-confirm").open, "Confirmation dialog did not close");
    await waitFor(() => !document.querySelector("#feature-removeSuggested").checked, "Canceled setting did not reset");
    check(!document.querySelector("#feature-removeSuggested").checked, "Cancel preserves disabled setting");

    document.querySelector("#feature-removeSuggested").click();
    await waitFor(() => document.querySelector("#suggested-confirm").open, "Confirmation dialog did not reopen");
    document.querySelector('#suggested-confirm [value="confirm"]').click();
    await waitFor(() => document.querySelector("#feature-removeSuggested").checked, "Confirmed setting did not save");
    await waitFor(() => !document.querySelector("#reload-alert").hidden, "Reload prompt did not appear");
    check(!document.querySelector("#reload-alert").hidden, "Setting change shows reload prompt");

    const singleUpdatesBeforeFallback = window.__quietFeedTest.messages.filter(
      (message) => message.type === "QF_SET_FEATURE",
    ).length;
    window.__quietFeedTest.rejectBatchUpdates = true;
    document.querySelector('[data-category-action="disable"]').click();
    await waitFor(
      () => [...document.querySelectorAll("#feature-list input")].every((input) => !input.checked),
      "Batch disable did not finish",
    );
    check(
      window.__quietFeedTest.messages.some((message) => message.type === "QF_SET_FEATURES"),
      "Category action uses batch update",
    );
    check(
      window.__quietFeedTest.messages.filter((message) => message.type === "QF_SET_FEATURE").length >
        singleUpdatesBeforeFallback,
      "Category action falls back for an older service worker",
    );
    window.__quietFeedTest.rejectBatchUpdates = false;

    const firstRow = document.querySelector("#feature-list .feature-row");
    firstRow.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => document.querySelector("#feature-list input").disabled, "Saving state did not disable toggle");
    check(document.querySelector("#feature-list input").disabled, "Toggle locks while saving");
    await waitFor(() => !document.querySelector("#feature-list input").disabled, "Saving state did not clear");

    document.documentElement.dataset.testStatus = "passed";
  } catch (error) {
    results.push(error?.stack || String(error));
    document.documentElement.dataset.testStatus = "failed";
  }

  const output = document.createElement("pre");
  output.id = "browser-test-results";
  output.textContent = `${document.documentElement.dataset.testStatus.toUpperCase()}\n${results.join("\n")}`;
  Object.assign(output.style, {
    position: "fixed",
    inset: "8px",
    zIndex: 10000,
    overflow: "auto",
    padding: "16px",
    border: "2px solid",
    borderColor: document.documentElement.dataset.testStatus === "passed" ? "#55c982" : "#ff5c5c",
    borderRadius: "12px",
    background: "#080808",
    color: "#fff",
    font: "13px/1.5 monospace",
  });
  document.body.append(output);
})();
