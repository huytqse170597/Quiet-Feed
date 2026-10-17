"use strict";

const assert = require("node:assert/strict");
const { isMediaUrl, sanitizeDownload, readSources } = require("../src/shared/video.js");
const { isMediaUrl: isUiMediaUrl, videoFilename } = require("../src/shared/features.js");

assert.equal(videoFilename({ author: "Dương Bi Bô", title: "Một ngày ở Đà Lạt", id: "12345", label: "1080p" }),
  "Dương Bi Bô - Một ngày ở Đà Lạt - 12345 - 1080p.mp4");
assert.equal(videoFilename({ title: "Nhạc hay", label: "Audio", kind: "audio" }), "Nhạc hay.m4a");
assert.equal(videoFilename({ title: "Facebook video", id: "https://video.fbcdn.net/file?secret=token",
  label: "Current file", date: new Date("2026-10-17T00:00:00Z") }), "quietfeed-2026-10-17_00-00-00-000Z.mp4");
assert.equal(videoFilename({ author: "Page", title: "page", id: "client:video:123" }), "Page.mp4");
assert.equal(videoFilename({ title: "  Hello:\nworld / good?  " }), "Hello world good.mp4");
assert.equal(videoFilename({ title: "CON" }), "_CON.mp4");
assert.equal(videoFilename({ title: "Cafe\u0301" }), "Café.mp4");
assert.equal(videoFilename({ title: "a\u202eb" }), "a b.mp4");
assert.equal(videoFilename({ title: "AQPGkSZflBoKN2QCK0rcYEO1Ce8hZcPyq-suvv5yEt4qE6VL2vPkRcQIz8F5QQFcv_mI6ZygR",
  date: new Date("2026-10-17T00:00:00Z") }), "quietfeed-2026-10-17_00-00-00-000Z.mp4");

for (const url of ["https://video.xx.fbcdn.net/v.mp4?token=abc", "https://fbcdn.net/a", "https://www.facebook.com:443/video"]) {
  assert.equal(isMediaUrl(url), true, url);
  assert.equal(isUiMediaUrl(url), true, url);
}
for (const url of [null, "http://video.fbcdn.net/a", "https://fbcdn.net.evil.test/a", "https://evilfacebook.com/a",
  "https://facebook.com@evil.test/a", "https://user:secret@fbcdn.net/a", "https://fbcdn.net:444/a",
  "javascript:alert(1)", "data:video/mp4;base64,x", "https://fbcdn.net\\@evil.test/a", "https://fbcdn.net/a\n", "https://facebook.com./a"]) {
  assert.equal(isMediaUrl(url), false, String(url));
  assert.equal(isUiMediaUrl(url), false, String(url));
}
assert.throws(() => sanitizeDownload({ url: "https://attacker.test/video", filename: "a.mp4" }));
const url = "https://video.xx.fbcdn.net/video?signature=abc";
assert.deepEqual(sanitizeDownload({ url }), { url, filename: "facebook-video.mp4" });
assert.equal(sanitizeDownload({ url, filename: "CON.mp4" }).filename, "_CON.mp4");
assert.equal(sanitizeDownload({ url, filename: "sound.M4A" }).filename, "sound.m4a");
for (const filename of ["../../evil.mp4", "C:\\temp\\bad\u0000.mp4", "NUL.txt", "...", "evil.exe", "COM¹.mp4"]) {
  const sanitized = sanitizeDownload({ url, filename }).filename;
  assert.match(sanitized, /\.(mp4|m4a)$/);
  assert.equal(/[\u0000-\u001f<>:"/\\|?*]/.test(sanitized), false);
  assert.equal(sanitized.includes(".."), false);
  assert.equal(/^(con|nul|prn|aux|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/i.test(sanitized), false);
}
assert.ok(sanitizeDownload({ url, filename: `${"a".repeat(1000)}.mp4` }).filename.length < 200);

const sd = "https://video.fbcdn.net/sd.mp4";
const hd = "https://video.fbcdn.net/hd.mp4";
const reads = [];
const direct = readSources("42", (id, field, variables) => {
  reads.push({ id, field, variables });
  if (field === "^title.text") return "Example title";
  if (field === "playable_url") return sd;
  if (field === "playable_url{$1}") return hd;
  if (field === "playlist{$1}") return "<MPD/>";
  return undefined;
});
assert.equal(direct.title, "Example title");
assert.deepEqual(direct.sources, [
  { url: sd, label: "SD", kind: "video", withSound: true },
  { url: hd, label: "HD", kind: "video", withSound: true },
]);
assert.equal(direct.manifest, "<MPD/>");
assert.deepEqual(reads.find((read) => read.field === "playable_url{$1}").variables, { $1: { quality: "HD" } });
assert.deepEqual(reads.find((read) => read.field === "playlist{$1}").variables, { $1: { scrubbing_preference: "MPEG_DASH" } });

const delivery = readSources(42, (id, field, variables) => {
  if (field === "browser_native_sd_url") return sd;
  if (field.includes("dash_manifests")) {
    assert.deepEqual(variables.$1.video_delivery_request.progressive_url_requests, [{ quality: "SD" }, { quality: "HD" }]);
    return "<MPD>delivery</MPD>";
  }
  if (field.includes("progressive_urls")) return [
    { getDataID: () => "hd-record" }, { metadata: { quality: "SD" }, progressive_url: sd },
    { metadata: { quality: "HD" }, progressive_url: "https://evil.test/video" },
    { getDataID() { throw new Error("stale record"); } },
  ];
  if (id === "hd-record" && field === "^metadata.quality") return "HD";
  if (id === "hd-record" && field === "progressive_url") return hd;
  return undefined;
});
assert.equal(delivery.id, "42");
assert.equal(delivery.sources.length, 2);
assert.equal(delivery.manifest, "<MPD>delivery</MPD>");
assert.equal(readSources("live", (_id, field) => field === "is_live_streaming").sources.length, 0);
assert.equal(readSources("42", () => { throw new Error("missing Relay data"); }).sources.length, 0);
assert.equal(readSources(null, () => sd).sources.length, 0);
console.log("Video utility URL, filename, Relay source, delivery, and live-stream tests passed.");
