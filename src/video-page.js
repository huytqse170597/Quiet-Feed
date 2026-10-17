(function initializeVideoHooks() {
  "use strict";

  // Register before Facebook defines these modules, using Quiet Feed's runtime.
  const suffix = ".react|quiet-feed-video";
  const targets = {
    VideoPlayerRelay: (props) => props?.video?.__id,
    FBReelsMediaHeaderOwnerInfo: (props) => find(props?.storyData?.__id, "^video.id"),
    CometVideoUnificationUFIReactActionRenderer: (props) =>
      find(props?.renderer?.__id, "^video.id") ||
      find(props?.renderer?.__id, "^short_form_video_context{$1}.^video.id", {
        $1: { location: "fb_shorts_video_deep_dive" },
      }) || find(props?.renderer?.__id, "^story.^video.id"),
  };

  function find(id, path, args) {
    try { return id ? window.___sf(id, path, args) : undefined; } catch { return undefined; }
  }

  for (const [name, getId] of Object.entries(targets)) {
    if (!window.___pt || !window.___km) break;
    window.___pt(name + suffix);
    window.___km(name + suffix, (payload) => {
      try {
        const id = getId(payload.payload);
        if (!id || find(id, "is_live_streaming")) return payload.lastCmp;
        const React = window.require("react");
        return React.createElement(React.Fragment, null,
          React.createElement("span", { "data-qf-video-id": String(id), style: {
            display: "block", position: "absolute", width: 0, height: 0,
            minHeight: 0, padding: 0, margin: 0, border: 0, flex: "0 0 0px",
            overflow: "visible", zIndex: 20,
          } }), payload.lastCmp);
      } catch { return payload.lastCmp; }
    });
  }

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (event.source !== window || message?.source !== "quiet-feed-video-ui" ||
        message.type !== "QFV_SOURCES" || typeof message.requestId !== "string" ||
        typeof message.id !== "string" || message.id.length > 200) return;
    const result = QuietFeedVideo.readSources(message.id, find);
    if (result.manifest) {
      result.sources.push(...parseManifest(result.manifest));
    }
    delete result.manifest;
    window.postMessage({ source: "quiet-feed-video-page", requestId: message.requestId, result }, location.origin);
  });

  function parseManifest(xml) {
    if (typeof xml !== "string" || xml.length > 2000000) return [];
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) return [];
    const sources = [];
    for (const set of doc.querySelectorAll("AdaptationSet")) {
      for (const representation of set.querySelectorAll("Representation")) {
        // Only whole-file representations; segmented/live playlists need another pipeline.
        if (representation.querySelector("SegmentTemplate, SegmentList") ||
            set.querySelector(":scope > SegmentTemplate, :scope > SegmentList")) continue;
        const url = representation.querySelector("BaseURL")?.textContent?.trim();
        if (!QuietFeedVideo.isMediaUrl(url)) continue;
        const type = representation.getAttribute("mimeType") || set.getAttribute("mimeType") ||
          set.getAttribute("contentType") || "";
        const kind = type.includes("audio") ? "audio" : "video";
        sources.push({ url, kind, withSound: false,
          label: kind === "audio" ? "Audio" : representation.getAttribute("FBQualityLabel") ||
            `${representation.getAttribute("height") || "HD"}p`,
          codec: representation.getAttribute("codecs") || set.getAttribute("codecs") || "",
        });
      }
    }
    return sources;
  }
})();
