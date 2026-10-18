(function initializeQuietFeedVideo(global) {
  "use strict";

  function isMediaUrl(value) {
    if (typeof value !== "string" || value.length > 16384 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
    try {
      const url = new URL(value);
      const host = url.hostname.toLowerCase();
      return url.protocol === "https:" && !url.username && !url.password &&
        (!url.port || url.port === "443") &&
        (host === "fbcdn.net" || host.endsWith(".fbcdn.net") ||
          host === "facebook.com" || host.endsWith(".facebook.com"));
    } catch {
      return false;
    }
  }

  function sanitizeDownload(value) {
    if (!value || typeof value !== "object" || !isMediaUrl(value.url)) {
      throw new Error("Invalid Facebook media URL");
    }
    let filename = typeof value.filename === "string" ? value.filename : "facebook-video.mp4";
    filename = filename.replace(/[\u0000-\u001f\u007f-\u009f<>:"/\\|?*]/g, "_")
      .replace(/\.{2,}/g, "_").replace(/^[. ]+|[. ]+$/g, "");
    const extension = /\.m4a$/i.test(filename) ? ".m4a" : ".mp4";
    let stem = filename.replace(/\.(mp4|m4a)$/i, "").replace(/[. ]+$/g, "");
    if (!stem) stem = "facebook-video";
    if (/^(con|prn|aux|nul|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(stem)) stem = `_${stem}`;
    stem = stem.slice(0, 170).replace(/[. ]+$/g, "");
    return { url: new URL(value.url).href, filename: `${stem}${extension}` };
  }

  function readSources(videoId, finder) {
    const id = typeof videoId === "string" || typeof videoId === "number" ? String(videoId) : "";
    const result = { id, title: "Facebook video", sources: [], manifest: "" };
    if (!id || typeof finder !== "function") return result;
    const read = (recordId, field, variables) => {
      try { return finder(recordId, field, variables); } catch { return undefined; }
    };
    if (read(id, "is_live_streaming") === true || read(id, "is_live") === true) return result;
    for (const field of ["^owner.name", "^creation_story.^^actors[0].name"]) {
      const author = read(id, field);
      if (typeof author === "string" && author.trim()) {
        result.author = author.trim().slice(0, 150);
        break;
      }
    }
    for (const field of ["^title.text", "name", "^savable_description.text", "^creation_story.^message.text"]) {
      const title = read(id, field);
      if (typeof title === "string" && title.trim()) {
        result.title = title.trim().slice(0, 300);
        break;
      }
    }
    const seen = new Set();
    const add = (url, label) => {
      if (!isMediaUrl(url) || seen.has(url)) return;
      seen.add(url);
      result.sources.push({ url, label, kind: "video", withSound: true });
    };
    const sd = read(id, "playable_url");
    const hd = read(id, "playable_url{$1}", { $1: { quality: "HD" } });
    add(isMediaUrl(sd) ? sd : read(id, "browser_native_sd_url"), "SD");
    add(isMediaUrl(hd) ? hd : read(id, "browser_native_hd_url"), "HD");
    // These Relay fields mirror the player's requested MPEG-DASH and progressive delivery records.
    const deliveryVariables = { $1: { video_delivery_request: {
      dash_manifest_requests: [{}], dash_manifest_url_requests: [{}],
      hls_playlist_url_requests: [{}], progressive_url_requests: [{ quality: "SD" }, { quality: "HD" }],
    } } };
    const playlist = read(id, "playlist{$1}", { $1: { scrubbing_preference: "MPEG_DASH" } });
    const deliveryManifest = typeof playlist === "string" && playlist.trim() ? playlist :
      read(id, "^video_delivery_response{$1}.^^dash_manifests[0].manifest_xml", deliveryVariables);
    if (typeof deliveryManifest === "string") result.manifest = deliveryManifest;
    const progressive = read(id, "^video_delivery_response{$1}.^^progressive_urls.*", deliveryVariables);
    if (Array.isArray(progressive)) {
      progressive.slice(0, 50).forEach((entry) => {
        let recordId;
        try { recordId = typeof entry?.getDataID === "function" ? entry.getDataID() : entry?.__id; } catch { return; }
        const quality = recordId ? read(recordId, "^metadata.quality") : entry?.metadata?.quality;
        const url = recordId ? read(recordId, "progressive_url") : entry?.progressive_url;
        if (quality === "SD" || quality === "HD") add(url, quality);
      });
    }
    return result;
  }

  const api = Object.freeze({ isMediaUrl, sanitizeDownload, readSources });
  global.QuietFeedVideo = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(globalThis);
