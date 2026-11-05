// scripts/host-diag.js — run THIS on the HOST (VPS / bot-hosting panel):
//     node scripts/host-diag.js
//
// It checks every link in the audio chain and shows where it breaks:
//   [1] ffmpeg binary            [2] opus encoder          [3] davey (voice e2ee)
//   [4] yt-dlp binary            [5] YouTube search        [6] stream URL resolve
//   [7] ACTUAL audio download via ffmpeg  <-- the money test
//
// If [7] says "NO AUDIO", the host cannot reach YouTube's media servers -> that
// is the "seems playing but no sound" bug. No Discord tokens needed.
"use strict";

require("../yt-dlp-patch"); // applies the hardened patch + cookie flags
const fs = require("fs");
const path = require("path");
const { spawnSync, spawn } = require("child_process");
const https = require("https");

function publicIp() {
  return new Promise((resolve) => {
    https
      .get("https://api.ipify.org", (res) => {
        let d = "";
        res.on("data", (c) => (d += c));
        res.on("end", () => resolve(d.trim() || "unknown"));
      })
      .on("error", () => resolve("unknown"));
  });
}

async function main() {
  const log = (s) => console.log(String(s));

  log("==============================================");
  log("  HOST DIAGNOSTICS");
  log("==============================================");
  log("platform:", String(process.platform), String(process.arch));
  log("node:", String(process.version));
  log("public IP:", String(await publicIp()));
  log("cookies.txt present:", String(fs.existsSync(path.join(__dirname, "..", "cookies.txt"))));
  log("");

  // [1] ffmpeg
  const ffmpegPath = require("ffmpeg-static");
  log("[1] ffmpeg-static ->", String(ffmpegPath));
  log("    exists:", String(fs.existsSync(ffmpegPath)));
  if (fs.existsSync(ffmpegPath)) {
    const r = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8" });
    const firstLine = (r.stdout || r.stderr || "").split("\n")[0];
    log("    version:", String(firstLine || "SPAWN FAILED (permissions?)"));
    if (!firstLine) log("    stderr:", String((r.stderr || "").slice(0, 300)));
  }

  // [2] opus encoder
  try {
    require("@discordjs/opus");
    log("[2] @discordjs/opus: OK");
  } catch (e) {
    log("[2] @discordjs/opus: FAILED ->", String(e.message));
  }

  // [3] davey (voice encryption lib)
  try {
    const d = require("@snazzah/davey");
    log("[3] @snazzah/davey: OK (DAVE protocol v" + String(d.DAVE_PROTOCOL_VERSION) + ")");
  } catch (e) {
    log("[3] @snazzah/davey: FAILED ->", String(e.message));
  }

  // [4] yt-dlp binary
  const yt = require("@distube/yt-dlp");
  const binDir = path.join(path.dirname(require.resolve("@distube/yt-dlp")), "..", "bin");
  const ytBin = path.join(binDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
  log("[4] yt-dlp binary ->", String(ytBin), "| exists:", String(fs.existsSync(ytBin)));
  if (fs.existsSync(ytBin)) {
    const r = spawnSync(ytBin, ["--version"], { encoding: "utf8" });
    log("    version:", String((r.stdout || r.stderr || "").trim().split("\n")[0] || "SPAWN FAILED"));
  }

  // [5] YouTube search
  log("\n[5] YouTube search test...");
  let first;
  try {
    const info = await yt.json("ytsearch1:test music", {
      dumpSingleJson: true, quiet: true, noWarnings: true,
      skipDownload: true, simulate: true
    });
    first = Array.isArray(info) ? info[0] : info.entries[0];
    log("    OK ->", String(first.title));
  } catch (e) {
    log("    FAILED ->", String(e.message).slice(0, 300));
    process.exitCode = 1;
    return;
  }

  // [6] stream URL resolution (same call DisTube makes for playback)
  log("[6] Resolving stream URL (format ba/ba*)...");
  let streamUrl;
  try {
    const si = await yt.json(first.webpage_url, {
      dumpSingleJson: true, quiet: true, noWarnings: true, preferFreeFormats: true,
      skipDownload: true, simulate: true, format: "ba/ba*"
    });
    streamUrl = si.url;
    log("    OK -> host:", String(new URL(streamUrl).host), "| ext:", String(si.ext));
  } catch (e) {
    log("    FAILED ->", String(e.message).slice(0, 300));
    process.exitCode = 1;
    return;
  }

  // [7] THE test: does ffmpeg actually receive audio bytes from this host?
  log("\n[7] ffmpeg downloading first ~5s of audio (the money test)...");
  await new Promise((resolve) => {
    const proc = spawn(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-i", streamUrl, "-t", "5", "-f", "s16le", "pipe:1"],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    let bytes = 0;
    proc.stdout.on("data", (c) => (bytes += c.length));
    proc.stderr.on("data", (c) => log("    ffmpeg stderr:", c.toString().slice(0, 300)));
    const timer = setTimeout(() => proc.kill("SIGKILL"), 30000);
    proc.on("close", () => {
      clearTimeout(timer);
      log("    downloaded bytes:", bytes);
      log(
        bytes > 100000
          ? "    RESULT: AUDIO FLOWS OK -> host can stream YouTube fine"
          : "    RESULT: NO AUDIO -> host is blocked/throttled from YouTube media servers (see README fixes)"
      );
      resolve();
    });
  });
  log("\nDone.");
}

main().catch((e) => {
  console.error("diag crashed:", e);
  process.exitCode = 1;
});
