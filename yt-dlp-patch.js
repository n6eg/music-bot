// yt-dlp-patch.js — startup hardening layer for YouTube playback.
//
// MUST be required FIRST (index.js already does this, before anything else).
// Responsibilities:
//   1. File-patch @distube/yt-dlp with the hardened json() implementation
//      (idempotent - see scripts/patch-ytdlp.js). Survives reinstalls because
//      postinstall runs the same patcher.
//   2. Publish globalThis.__ytdlpExtraFlags(): computes authentication /
//      anti-bot flags merged into EVERY yt-dlp invocation:
//         --cookies <file>         (cookies.txt next to index.js, or
//                                   YTDLP_COOKIES_FILE)   <- BEST FIX
//         --cookies-from-browser X (YTDLP_COOKIES_FROM_BROWSER)
//         --proxy ...              (YTDLP_PROXY)
//         --extractor-args ...     (YTDLP_EXTRACTOR_ARGS)
//   3. Warn ONCE at startup when no YouTube auth is configured.
//   4. Keep the bundled yt-dlp binary fresh: refresh the latest release
//      periodically so long-running 24/7 processes never run stale
//      extractors (stale extractors are a common cause of bot-checks).
"use strict";

const fs = require("fs");
const path = require("path");

const PROJECT_ROOT = __dirname;
const COOKIES_PATH = path.join(PROJECT_ROOT, "cookies.txt");

// --- 1. Apply the file patch synchronously (cheap + idempotent) -------------
try {
  require("./scripts/patch-ytdlp").applyPatch();
} catch (e) {
  console.warn("[yt-dlp] warning: file patch failed:", e && e.message);
}

// --- 2. Global extra-flags provider -----------------------------------------
function detectCookiesFile() {
  // If cookies are passed via BASE64 environment variable, decode and write automatically
  if (process.env.YTDLP_COOKIES_BASE64 && !fs.existsSync(COOKIES_PATH)) {
    try {
      const decoded = Buffer.from(process.env.YTDLP_COOKIES_BASE64.trim(), "base64").toString("utf-8");
      fs.writeFileSync(COOKIES_PATH, decoded, "utf-8");
      console.log("✅ [yt-dlp] Created cookies.txt from YTDLP_COOKIES_BASE64");
      return COOKIES_PATH;
    } catch (e) { }
  }

  // If cookies text is passed via environment variable, write it to file automatically
  if (process.env.YTDLP_COOKIES_TEXT && !fs.existsSync(COOKIES_PATH)) {
    try {
      fs.writeFileSync(COOKIES_PATH, process.env.YTDLP_COOKIES_TEXT.trim(), "utf-8");
      console.log("✅ [yt-dlp] Created cookies.txt from YTDLP_COOKIES_TEXT environment variable");
      return COOKIES_PATH;
    } catch (e) { }
  }

  // Explicit env wins; otherwise auto-detect project-root cookies.txt or Render secrets
  const explicit = process.env.YTDLP_COOKIES_FILE;
  if (explicit && explicit.trim()) return explicit.trim();

  const candidates = [
    COOKIES_PATH,
    path.join(process.cwd(), "cookies.txt"),
    "/etc/secrets/cookies.txt"
  ];

  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) return c;
    } catch (e) { /* fs errors -> treat as missing */ }
  }
  return null;
}

if (typeof globalThis.__ytdlpExtraFlags !== "function") {
  globalThis.__ytdlpExtraFlags = function () {
    const flags = {};
    try {
      const cookiesFile = detectCookiesFile();
      if (cookiesFile) {
        flags.cookies = cookiesFile;
      } else if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
        flags.cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;
      }
      if (process.env.YTDLP_PROXY) flags.proxy = process.env.YTDLP_PROXY;

      const extractorArgs = [];
      if (process.env.YTDLP_EXTRACTOR_ARGS) {
        extractorArgs.push(process.env.YTDLP_EXTRACTOR_ARGS);
      }
      // Only force player clients when there is NO auth available; with
      // cookies present yt-dlp's own client selection is the best choice.
      if (
        !flags.cookies &&
        !flags.cookiesFromBrowser &&
        process.env.YTDLP_PLAYER_CLIENTS
      ) {
        extractorArgs.push("youtube:player_client=" + process.env.YTDLP_PLAYER_CLIENTS);
      }
      if (extractorArgs.length) flags.extractorArgs = extractorArgs;
    } catch (e) { /* never break playback because of flag computation */ }
    return flags;
  };
}

// --- 3. One-time startup warning when unauthenticated -----------------------
function warnIfUnauthenticated() {
  if (!detectCookiesFile() && !process.env.YTDLP_COOKIES_FROM_BROWSER) {
    console.warn(
      "\n" +
      "⚠️  [yt-dlp] لا يوجد مصادقة يوتيوب (cookies)! قد يرفض يوتيوب التشغيل برسالة\n" +
      "   \"Sign in to confirm you're not a bot\" في أي وقت.\n" +
      "   الحل الدائم: ضع ملف cookies.txt بجانب index.js أو شغّل:\n" +
      "       npm run cookies\n" +
      "   التفاصيل الكاملة في README.md قسم [YouTube Cookies].\n"
    );
  }
}

// --- 4. Periodic yt-dlp self-update (default: every 12h) --------------------
function scheduleYtDlpUpdates() {
  if (process.env.YTDLP_AUTO_UPDATE === "0") return;
  const HOURS = Number(process.env.YTDLP_AUTO_UPDATE_HOURS) || 12;
  const MS = Math.max(1, HOURS) * 60 * 60 * 1000;
  const timer = setInterval(() => {
    try {
      const ytm = require("@distube/yt-dlp");
      if (typeof ytm.download === "function") {
        ytm.download()
          .then((v) => console.log("[yt-dlp] auto-updated binary to:", v))
          .catch(() => { });
      }
    } catch (e) { /* ignore */ }
  }, MS);
  // Never keep the process alive just for updates.
  if (typeof timer.unref === "function") timer.unref();
}

// --- 5. Startup binary sanity check ------------------------------------------
// Detects the two silent killers on hosts (bot.hosting/VPS):
//   A) ffmpeg segfaults (SIGSEGV) or is missing  -> music shows "playing" but
//      no sound ever comes out.
//   B) yt-dlp binary is missing or is a Windows .exe dropped on Linux (the
//      .env YTDLP_URL=...yt-dlp.exe trap) -> YouTube search/play silently fail
//      and the bot falls back to SoundCloud.
// Prints loud, actionable warnings BEFORE the bots connect.
function checkBinaries() {
  const { spawnSync } = require("child_process");
  const fs2 = require("fs");
  const path2 = require("path");

  // --- ffmpeg ---
  // Use the functional selector: ffmpeg-static can pass `-version` yet die
  // with SIGSEGV on first decode (Render). The selector rejects such binaries.
  let ffmpegPath = null;
  try {
    ffmpegPath = require("./ffmpeg-select").selectFfmpeg();
  } catch (e) {
    console.warn("\n⚠️  [ffmpeg] no binary passed the decode test:", e.message);
    try { ffmpegPath = process.env.FFMPEG_BIN || require("ffmpeg-static"); } catch (e2) { /* handled below */ }
  }
  if (!ffmpegPath) {
    console.warn("\n⚠️  [ffmpeg] no ffmpeg binary found. On the host run:\n" +
      "   apt-get update && apt-get install -y ffmpeg\n" +
      "   ثم ضع في .env:  FFMPEG_BIN=/usr/bin/ffmpeg\n");
  } else {
    try {
      const r = spawnSync(ffmpegPath, ["-version"], { encoding: "utf8", timeout: 10000 });
      const v = (r.stdout || r.stderr || "").split("\n")[0];
      if (!v || r.error) {
        console.warn("\n⚠️  [ffmpeg] cannot spawn at", ffmpegPath, "(" + (r.error?.message || "no version output") + ")");
        console.warn("   On bot.hosting run: apt-get update && apt-get install -y ffmpeg");
        console.warn("   ثم ضع في .env:  FFMPEG_BIN=/usr/bin/ffmpeg\n");
      } else if (/ffmpeg version/i.test(v)) {
        console.log("✅ [ffmpeg]", v);
      } else {
        console.warn("⚠️  [ffmpeg] unexpected output from", ffmpegPath, ":", v);
      }
    } catch (e) {
      console.warn("⚠️  [ffmpeg] check threw:", e.message);
    }
  }

  // --- yt-dlp ---
  try {
    const ytDir = path2.join(path2.dirname(require.resolve("@distube/yt-dlp")), "..", "bin");
    const ytBin = path2.join(ytDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    if (!fs2.existsSync(ytBin)) {
      console.warn("\n⚠️  [yt-dlp] binary missing at", ytBin, "- run on the host:\n" +
        "   node -e \"require('@distube/yt-dlp').download().then(v=>console.log(v))\"\n");
    } else {
      // Test the binary by RUNNING it, not by demanding an ELF header.
      // On CI hosts (Render sets CI=true) @distube/yt-dlp installs a Python
      // script with a shebang - it is perfectly executable but has no ELF magic.
      let ytWorks = false;
      try {
        const probe = spawnSync(ytBin, ["--version"], { encoding: "utf8", timeout: 15000 });
        const v = (probe.stdout || "").trim();
        if (!probe.error && v && /^(yt-dlp\s|\d{4}\.)/i.test(v)) {
          console.log("✅ [yt-dlp]", v.split("\n")[0]);
          ytWorks = true;
        }
      } catch (e) { /* handled below */ }

      if (!ytWorks) {
        console.warn("\n⚠️  [yt-dlp] binary at", ytBin, "cannot run. Trying auto-repair...");
        repairYtDlp(ytBin).catch(() => { });
      }
    }
  } catch (e) {
    console.warn("⚠️  [yt-dlp] check unavailable:", e.message);
  }
}

// --- 5b. Auto-repair a broken yt-dlp binary (Windows .exe on Linux, or a
// Python stub that can't execute). Downloads the correct standalone Linux
// ELF and atomically replaces the bad file, then re-checks.
async function repairYtDlp(ytBin) {
  if (process.platform === "win32") return false; // nothing to repair on Windows
  const url =
    "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux";
  const tmp = ytBin + ".repair";
  console.log("[yt-dlp] auto-repair: downloading Linux binary from", url);
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString("hex") !== "7f454c46") {
      throw new Error("downloaded file is not a Linux ELF");
    }
    fs.writeFileSync(tmp, buf);
    return finishRepair(fs, tmp, ytBin, () => { });
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch (e2) { }
    console.warn("[yt-dlp] auto-repair failed:", e.message);
    return false;
  }
}

function finishRepair(fs2, tmp, ytBin, resolve) {
  try {
    const head = fs2.readFileSync(tmp).subarray(0, 4);
    if (head.toString("hex") !== "7f454c46") {
      try { fs2.unlinkSync(tmp); } catch (e) { }
      console.warn("[yt-dlp] auto-repair: downloaded file is not a Linux ELF, aborted.");
      return resolve(false);
    }
    fs2.renameSync(tmp, ytBin);
    fs2.chmodSync(ytBin, 0o755);
    console.log("✅ [yt-dlp] auto-repair: replaced with Linux ELF binary");
    resolve(true);
  } catch (e) {
    try { fs2.unlinkSync(tmp); } catch (e2) { }
    console.warn("[yt-dlp] auto-repair failed:", e.message);
    resolve(false);
  }
}

module.exports = { warnIfUnauthenticated, scheduleYtDlpUpdates, detectCookiesFile, checkBinaries };

// Auto-run the cheap checks immediately on require.
warnIfUnauthenticated();
checkBinaries();
scheduleYtDlpUpdates();
