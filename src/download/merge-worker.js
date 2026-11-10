import createFFmpegCore from "../../vendor/ffmpeg/ffmpeg-core.js";

// A dedicated worker/tab keeps large transfers out of the MV3 service worker.
// Bound buffering because the WASM filesystem keeps both inputs and output in RAM.
const MAX_BYTES = 256 * 1024 * 1024;
let total = 0;

async function fetchTrack(url, label) {
  let response;
  try {
    // Facebook's CDN redirects some signed media requests. A previous strict
    // redirect policy turned those redirects into a misleading
    // "Failed to fetch"; follow them so the merge can start.
    response = await fetch(url, { credentials: "omit", redirect: "follow", signal: AbortSignal.timeout(180000) });
  } catch (error) {
    const host = (() => { try { return new URL(url).host; } catch { return "unknown host"; } })();
    throw new Error(`${label} request failed: ${error.name}: ${error.message} (${host})`);
  }
  if (!response.ok) throw new Error(`${label} request failed (${response.status})`);
  if (!response.body) throw new Error(`Empty ${label} response`);
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      size += value.byteLength;
      if (total > MAX_BYTES) throw new Error("This video is too large for local merging (256 MB input limit). Choose SD/HD with sound instead.");
      chunks.push(value);
    }
  } catch (error) {
    if (error.message.startsWith("This video is too large")) throw error;
    throw new Error(`${label} download failed: ${error.name}: ${error.message}`);
  } finally { await reader.cancel().catch(() => {}); }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}

self.onmessage = async ({ data }) => {
  try {
    // URLs were validated by the background before creating this private job.
    self.postMessage({ status: "Fetching video and audio…" });
    const [video, audio] = await Promise.all([fetchTrack(data.url, "Video"), fetchTrack(data.audioUrl, "Audio")]);
    self.postMessage({ status: "Combining video and audio locally…" });
    const core = await createFFmpegCore({ locateFile: (path) => new URL(`../../vendor/ffmpeg/${path}`, import.meta.url).href });
    core.FS.writeFile("video.mp4", video);
    core.FS.writeFile("audio.m4a", audio);
    core.setTimeout(120000);
    const result = core.exec("-i", "video.mp4", "-i", "audio.m4a", "-map", "0:v:0", "-map", "1:a:0",
      "-c", "copy", "-movflags", "+faststart", "output.mp4");
    if (result !== 0) throw new Error("Could not combine these tracks. Choose SD/HD with sound instead.");
    const output = core.FS.readFile("output.mp4");
    self.postMessage({ buffer: output.buffer }, [output.buffer]);
  } catch (error) { self.postMessage({ error: error.message || String(error) }); }
};
