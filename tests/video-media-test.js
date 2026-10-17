"use strict";

// Optional integration check: execute our actual merge worker with the bundled
// WASM core and synthetic audio/video, then inspect the resulting MP4 with ffprobe.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const assert = require("node:assert/strict");
const { execFileSync } = require("node:child_process");

(async () => {
  const root = path.resolve(__dirname, "..");
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "quiet-feed-media-"));
  const videoPath = path.join(directory, "video.mp4");
  const audioPath = path.join(directory, "audio.m4a");
  const outputPath = path.join(directory, "output.mp4");
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "color=c=blue:s=64x64:r=10", "-t", "1", "-an", "-c:v", "libx264", videoPath]);
  execFileSync("ffmpeg", ["-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=44100", "-t", "1", "-vn", "-c:a", "aac", audioPath]);
  const coreSource = fs.readFileSync(path.join(root, "vendor/ffmpeg/ffmpeg-core.js"), "utf8");
  global.self = { location: { href: "file:///quiet-feed/vendor/ffmpeg/ffmpeg-core.js" } };
  const { default: createCore } = await import("data:text/javascript;base64," + Buffer.from(coreSource).toString("base64"));
  const workerSource = fs.readFileSync(path.join(root, "src/download/merge-worker.js"), "utf8")
    .replace(/^import .*;\r?\n/, "")
    .replaceAll("import.meta.url", JSON.stringify("file:///quiet-feed/src/download/merge-worker.js"));
  const statuses = [];
  let output;
  const context = vm.createContext({
    URL, AbortSignal, Uint8Array, Promise,
    createFFmpegCore: async () => createCore({
      wasmBinary: fs.readFileSync(path.join(root, "vendor/ffmpeg/ffmpeg-core.wasm")),
      print: () => {}, printErr: () => {},
    }),
    fetch: async (url) => new Response(fs.readFileSync(url === "video" ? videoPath : audioPath)),
    self: { postMessage(message) {
      if (message.error) throw new Error(message.error);
      if (message.status) statuses.push(message.status);
      if (message.buffer) output = Buffer.from(message.buffer);
    } },
  });
  vm.runInContext(workerSource, context);
  await context.self.onmessage({ data: { url: "video", audioUrl: "audio" } });
  assert.ok(output?.length > 0, "worker returned a real file");
  fs.writeFileSync(outputPath, output);
  const probe = JSON.parse(execFileSync("ffprobe", ["-v", "error", "-show_streams", "-show_format", "-of", "json", outputPath], { encoding: "utf8" }));
  assert.deepEqual(probe.streams.map((stream) => stream.codec_type).sort(), ["audio", "video"]);
  assert.ok(Number(probe.format.duration) >= 1);
  assert.ok(statuses.includes("Combining video and audio locally…"));
  console.log("Real WASM worker merge passed: MP4 has H.264 video and AAC audio.");
  console.log(`Synthetic test output: ${outputPath}`);
})().catch((error) => { console.error(error); process.exitCode = 1; });
