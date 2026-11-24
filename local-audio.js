"use strict";

// Render's sandbox kills static ffmpeg builds with SIGSEGV whenever ffmpeg
// opens a remote URL itself. ffmpeg works perfectly on local files, and Node's
// HTTPS stack works too. So: download the stream with Node first, then hand
// ffmpeg a local file path. This module performs that download and patches the
// SoundCloud plugin to return local files instead of remote HLS URLs.

const fs = require("fs");
const http = require("http");
const https = require("https");
const os = require("os");
const path = require("path");

const MAX_BYTES = 80 * 1024 * 1024;
const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "dule-audio-"));
let counter = 0;

function fetchBuffer(url, redirects = 0) {
  return new Promise((resolve, reject) => {
    let target;
    try { target = new URL(url); } catch (e) { reject(e); return; }
    const lib = target.protocol === "https:" ? https : http;
    const req = lib.get(target, {
      headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" }
    }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, target).href;
        if (redirects >= 5) { reject(new Error("too many redirects")); return; }
        fetchBuffer(next, redirects + 1).then(resolve, reject);
        return;
      }
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error("HTTP " + res.statusCode));
        return;
      }
      const chunks = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          req.destroy(new Error("download too large"));
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(45000, () => req.destroy(new Error("download timeout")));
  });
}

function cleanLines(text) {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
}

async function downloadHls(playlistUrl, depth = 0) {
  if (depth > 3) throw new Error("HLS playlist too deep");
  console.log("[local-audio] downloading HLS:", new URL(playlistUrl).host);
  const text = (await fetchBuffer(playlistUrl)).toString("utf8");
  const lines = cleanLines(text);

  // Master playlist: pick the first variant.
  if (lines.some((l) => l.startsWith("#EXT-X-STREAM-INF"))) {
    const i = lines.findIndex((l) => l.startsWith("#EXT-X-STREAM-INF"));
    const variant = lines.slice(i + 1).find((l) => !l.startsWith("#"));
    if (!variant) throw new Error("master playlist has no variant");
    return downloadHls(new URL(variant, playlistUrl).href, depth + 1);
  }

  if (lines.some((l) => /^#EXT-X-KEY:METHOD=(?!NONE)/i.test(l))) {
    throw new Error("encrypted HLS is not supported");
  }

  const segments = lines.filter((l) => !l.startsWith("#"));
  if (!segments.length) throw new Error("empty HLS playlist");
  console.log("[local-audio] HLS segments:", segments.length);

  const file = path.join(TEMP_DIR, "hls-" + process.pid + "-" + (++counter) + ".ts");
  const fd = fs.openSync(file, "w");
  let bytes = 0;
  try {
    for (let i = 0; i < segments.length; i++) {
      const segUrl = new URL(segments[i], playlistUrl).href;
      const chunk = await fetchBuffer(segUrl);
      bytes += chunk.length;
      fs.writeSync(fd, chunk);
      if ((i + 1) % 10 === 0) console.log(`[local-audio] ${i + 1}/${segments.length} segments`);
    }
  } finally {
    fs.closeSync(fd);
  }
  console.log("[local-audio] HLS done:", bytes, "bytes");
  return file;
}

function extensionFor(url, buffer) {
  const fromUrl = (url.split("?")[0].match(/\.[a-z0-9]{2,5}$/i) || [])[0];
  if (fromUrl && !/\.m3u8$/i.test(fromUrl)) return fromUrl.toLowerCase();
  if (buffer.length > 4 && buffer[0] === 0x49 && buffer[1] === 0x44 && buffer[2] === 0x33) return ".mp3";
  if (buffer.length > 4 && buffer[0] === 0x66 && buffer[1] === 0x74 && buffer[2] === 0x79 && buffer[3] === 0x70) return ".m4a";
  return ".bin";
}

async function downloadRemoteAudio(remoteUrl) {
  if (typeof remoteUrl !== "string" || !/^https?:\/\//i.test(remoteUrl)) return remoteUrl;
  if (/\.m3u8(?:\?|$)/i.test(remoteUrl)) return downloadHls(remoteUrl);

  const buf = await fetchBuffer(remoteUrl);
  const file = path.join(TEMP_DIR, "audio-" + process.pid + "-" + (++counter) + extensionFor(remoteUrl, buf));
  fs.writeFileSync(file, buf);
  return file;
}

function cleanupOldFiles(maxAgeMs = 6 * 60 * 60 * 1000) {
  const now = Date.now();
  try {
    for (const name of fs.readdirSync(TEMP_DIR)) {
      const full = path.join(TEMP_DIR, name);
      try { if (now - fs.statSync(full).mtimeMs > maxAgeMs) fs.unlinkSync(full); } catch (e) { }
    }
  } catch (e) { }
}

function patchSoundCloudPlugin(plugin) {
  if (!plugin || plugin.__localAudioPatched) return plugin;
  const original = plugin.getStreamURL.bind(plugin);
  plugin.getStreamURL = async function (song) {
    const remote = await original(song);
    try {
      cleanupOldFiles();
      const local = await downloadRemoteAudio(remote);
      if (local !== remote) {
        console.log("[local-audio] SoundCloud stream cached to disk:", path.basename(local));
      }
      return local;
    } catch (e) {
      console.warn("[local-audio] download failed, using remote URL:", e.message);
      return remote;
    }
  };
  plugin.__localAudioPatched = true;
  return plugin;
}

module.exports = { downloadRemoteAudio, patchSoundCloudPlugin, TEMP_DIR };
