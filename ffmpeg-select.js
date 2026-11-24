"use strict";

// Pick an ffmpeg binary that can ACTUALLY decode audio on this host.
// On Render, the bundled ffmpeg-static binary passes `-version` but dies with
// SIGSEGV as soon as it decodes MP3/HLS. A functional test is therefore
// required; a version string alone is not enough.

const { execFileSync } = require("child_process");

function candidatePaths() {
  const list = [];

  if (process.env.FFMPEG_BIN && process.env.FFMPEG_BIN.trim()) list.push(process.env.FFMPEG_BIN.trim());
  if (process.env.FFMPEG_PATH && process.env.FFMPEG_PATH.trim()) list.push(process.env.FFMPEG_PATH.trim());

  // Linux: @ffmpeg-installer ships an older, very conservative static build
  // that works on Render. Try it before ffmpeg-static.
  if (process.platform === "linux") {
    try { list.push(require("@ffmpeg-installer/ffmpeg").path); } catch (e) { }
    try { list.push(require("ffmpeg-static")); } catch (e) { }
  } else {
    try { list.push(require("ffmpeg-static")); } catch (e) { }
    try { list.push(require("@ffmpeg-installer/ffmpeg").path); } catch (e) { }
  }

  // Last resort: system binaries.
  list.push("/usr/bin/ffmpeg", "/usr/local/bin/ffmpeg");

  return [...new Set(list.filter(Boolean))];
}

let selected = null;

function selectFfmpeg() {
  if (selected) return selected;

  const failures = [];
  for (const bin of candidatePaths()) {
    try {
      execFileSync(bin, ["-version"], {
        encoding: "utf8",
        timeout: 10000,
        stdio: ["ignore", "pipe", "pipe"]
      });

      // Functional decode test: generate a tiny PCM stream locally. This
      // catches SIGSEGV / illegal-instruction binaries before playback.
      execFileSync(bin, [
        "-v", "error", "-nostdin",
        "-f", "lavfi", "-i", "anullsrc=r=48000:cl=stereo",
        "-t", "0.1", "-f", "s16le", "pipe:1"
      ], {
        encoding: "buffer",
        timeout: 15000,
        maxBuffer: 1024 * 1024,
        stdio: ["ignore", "pipe", "pipe"]
      });

      selected = bin;
      return bin;
    } catch (e) {
      failures.push(bin + ": " + String(e.message || e).slice(0, 200));
    }
  }

  throw new Error("No usable ffmpeg binary. Tried: " + failures.join(" | "));
}

module.exports = { candidatePaths, selectFfmpeg };
