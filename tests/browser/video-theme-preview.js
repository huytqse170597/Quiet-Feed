"use strict";
QuietFeedUI.loadAndApplyTheme();
document.getElementById("theme-toggle-mount").append(QuietFeedUI.createThemeToggle());
// Capture native layout after the theme toolbar, before video controls attach.
window.fixtureVideoLayout = Object.fromEntries(["fixture-player", "fixture-caption"].map((id) => {
  const rect = document.getElementById(id).getBoundingClientRect();
  return [id, { top: rect.top, height: rect.height }];
}));
