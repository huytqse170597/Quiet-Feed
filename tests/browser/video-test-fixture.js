"use strict";

const fixtureLayout = new URL(location.href).searchParams.get("layout");
if (["flex", "grid"].includes(fixtureLayout)) {
  const shell = document.querySelector("#fixture-player-shell");
  shell.style.display = fixtureLayout;
  shell.style.flexDirection = "column";
  shell.style.gap = "12px";
}

const fixtureRecords = {
  "playable_url": "https://video.fbcdn.net/sd.mp4",
  "playable_url{$1}": "https://video.fbcdn.net/hd.mp4",
  "^title.text": "Fixture video",
  "^owner.name": "Trang thử nghiệm",
  "playlist{$1}": `<MPD><Period>
    <AdaptationSet mimeType="video/mp4"><Representation height="1080" FBQualityLabel="1080p" codecs="avc1.640028"><BaseURL>https://video.fbcdn.net/1080.mp4?x=1&amp;y=2</BaseURL><SegmentBase indexRange="1-10"/></Representation></AdaptationSet>
    <AdaptationSet mimeType="audio/mp4"><Representation codecs="mp4a.40.2"><BaseURL>https://video.fbcdn.net/audio.m4a</BaseURL></Representation></AdaptationSet>
  </Period></MPD>`,
};
window.___pt = () => {};
window.___km = () => {};
window.___sf = (_id, field) => fixtureRecords[field];
const videoThemeListeners = [];
const videoThemeStore = { quietFeedSettings: { downloadVideos: true }, quietFeedTheme: "system" };
window.chrome = {
  storage: {
    local: {
      get: async () => ({ ...videoThemeStore }),
      set: async (value) => {
        Object.assign(videoThemeStore, value);
        const changes = Object.fromEntries(Object.entries(value).map(([key, newValue]) => [key, { newValue }]));
        videoThemeListeners.forEach((listener) => listener(changes, "local"));
      },
    },
    onChanged: { addListener: (listener) => videoThemeListeners.push(listener) },
  },
  runtime: { sendMessage: async (message) => {
    document.getElementById("result").textContent = `Received ${message.type}: ${message.filename}; audio=${message.audioUrl || "none"}; url=${message.url}`;
    return { ok: true };
  } },
};
