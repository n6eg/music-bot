// scripts/export-cookies.js — one-time YouTube cookies.txt generator.
//
// Usage:
//   npm run cookies              -> auto-detects & tries installed browsers
//   npm run cookies edge         -> tries a specific browser
//   node scripts/export-cookies.js chrome
//
// What it does:
//   Runs the project's bundled yt-dlp with BOTH --cookies-from-browser X and
//   --cookies cookies.txt, which makes yt-dlp copy that browser's YouTube
//   cookies into ./cookies.txt (next to index.js). The bot then automatically
//   uses this file for every playback (see yt-dlp-patch.js).
//
// IMPORTANT:
//   - Close the chosen browser COMPLETELY first (all windows), otherwise its
//     cookie database is locked.
//   - Modern Chrome/Edge/Brave may refuse (DPAPI app-bound encryption,
//     https://github.com/yt-dlp/yt-dlp/issues/10927). In that case use the
//     extension method printed below - it always works.
//   - cookies.txt contains your YouTube session. KEEP IT PRIVATE.
"use strict";

const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT = path.join(__dirname, "..");
const COOKIES = path.join(ROOT, "cookies.txt");
const YTDLP = path.join(
  ROOT, "node_modules", "@distube", "yt-dlp", "bin",
  process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp"
);

const BROWSER_DIRS = {
  edge: path.join(process.env.LOCALAPPDATA || "", "Microsoft", "Edge", "User Data"),
  chrome: path.join(process.env.LOCALAPPDATA || "", "Google", "Chrome", "User Data"),
  brave: path.join(process.env.LOCALAPPDATA || "", "BraveSoftware", "Brave-Browser", "User Data"),
  firefox: path.join(process.env.APPDATA || "", "Mozilla", "Firefox")
};

const EXTENSION_HELP =
  "\n" +
  "❌ تعذر التصدير التلقائي من المتصفح.\n" +
  "استخدم طريقة الإضافة (تعمل دائماً):\n" +
  "  1️⃣  ثبّت إضافة \"Get cookies.txt LOCALLY\" في متصفحك:\n" +
  "      Chrome/Edge: https://chromewebstore.google.com/detail/get-cookiestxt-locally/cclelndahbckbenkjhflpdbgdldlbecc\n" +
  "  2️⃣  افتح youtube.com وتأكد أنك مسجل دخول بحسابك.\n" +
  "  3️⃣  من أيقونة الإضافة -> Export -> احفظ الملف باسم cookies.txt\n" +
  "      داخل مجلد البوت بجانب index.js هنا:\n" +
  "      " + ROOT + "\n" +
  "  4️⃣  أعد تشغيل البوت.\n";

function tryBrowser(browser) {
  console.log("\n[yt-dlp] trying browser: " + browser + " ...");
  const res = spawnSync(
    YTDLP,
    [
      "--cookies-from-browser", browser,
      "--cookies", COOKIES,
      "--skip-download", "--simulate", "--no-warnings", "--quiet",
      "https://www.youtube.com/"
    ],
    { cwd: ROOT, encoding: "utf8", timeout: 120000 }
  );
  if (res.error) {
    console.log("  error: " + res.error.message);
    return false;
  }
  if (res.status === 0 && fs.existsSync(COOKIES)) {
    return true;
  }
  const errText = String(res.stderr || "").split("\n").filter(Boolean)[0] || ("exit code " + res.status);
  console.log("  failed: " + errText.slice(0, 200));
  return false;
}

function main() {
  if (!fs.existsSync(YTDLP)) {
    console.error("❌ yt-dlp binary not found at: " + YTDLP);
    console.error("   Run: npm install   (then retry)");
    process.exit(1);
  }

  if (fs.existsSync(COOKIES)) {
    console.log("✅ يوجد ملف cookies.txt بالفعل: " + COOKIES);
    console.log("   لإعادة إنشائه (عند انتهاء صلاحية الجلسة): احذف الملف ثم أعد تشغيل هذا الأمر.");
    process.exit(0);
  }

  let browsers;
  const arg = (process.argv[2] || "").toLowerCase();
  if (arg && BROWSER_DIRS[arg]) {
    browsers = [arg];
  } else {
    // Try every INSTALLED browser, most likely first.
    browsers = Object.keys(BROWSER_DIRS).filter((b) => {
      try { return !!BROWSER_DIRS[b] && fs.existsSync(BROWSER_DIRS[b]); } catch { return false; }
    });
    if (!browsers.length) {
      console.log("ℹ️  لم أجد متصفحات مثبتة - استخدم طريقة الإضافة أدناه.");
    }
  }

  for (const b of browsers) {
    if (tryBrowser(b)) {
      console.log("\n✅ تم إنشاء ملف الكوكيز بنجاح: " + COOKIES);
      console.log("   🔒 احتفظ بالملف سرياً ولا تشاركه مع أحد!");
      console.log("   ▶️  شغّل البوت الآن وسيعتمد الكوكيز تلقائياً في كل تشغيل.");
      process.exit(0);
    }
  }

  console.log(EXTENSION_HELP);
  process.exit(1);
}

main();
