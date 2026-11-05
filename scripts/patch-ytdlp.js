// scripts/patch-ytdlp.js — hardens @distube/yt-dlp against YouTube bot-checks.
//
// Replaces the module's entire `json()` implementation in BOTH dist/index.js
// (CJS) and dist/index.mjs (ESM) with a hardened version that:
//   1. Separates stdout/stderr (fixes JSON.parse crashes from stderr noise).
//   2. Strips the deprecated --no-call-home flag.
//   3. Merges authentication/anti-bot flags into EVERY invocation:
//        - cookies file      (--cookies)            <- RECOMMENDED FIX
//        - browser cookies   (--cookies-from-browser)
//        - proxy             (--proxy)
//        - extractor args    (--extractor-args)
//      Sources: globalThis.__ytdlpExtraFlags() (set by yt-dlp-patch.js at
//      startup) with a process.env-only fallback.
//   4. Auto-RETRIES once with fallback YouTube player clients when YouTube
//      answers "Sign in to confirm you're not a bot", then fails with a short,
//      actionable bilingual message instead of the raw English wall of text.
//
// Idempotent: skips files already carrying the __YTDLP_HARDENED_JSON__ marker.
// Runs on every `npm install` (postinstall) AND again at every bot startup,
// so the fix always survives package reinstalls/updates.
"use strict";

const fs = require("fs");
const path = require("path");

const PKG_DIST = path.join(__dirname, "..", "node_modules", "@distube", "yt-dlp", "dist");
const MARKER = "__YTDLP_HARDENED_JSON__";

// ---------------------------------------------------------------------------
// Hardened json() implementation injected into the bundle.
// NOTE: written WITHOUT backticks/template literals so it can live inside a
// JS template string safely. Identifiers used (present in both CJS & ESM
// bundles): args() helper, YTDLP_PATH, spawnExpr (captured per-file).
// ---------------------------------------------------------------------------
function buildHardenedJson(spawnExpr) {
  return [
    "var json = /* @__PURE__ */ __name((url, flags, options) => {",
    "  // " + MARKER,
    "  if (flags && typeof flags === 'object') { delete flags.noCallHome; delete flags['no-call-home']; }",
    "  var __getExtra = (typeof globalThis !== 'undefined' && typeof globalThis.__ytdlpExtraFlags === 'function')",
    "    ? globalThis.__ytdlpExtraFlags",
    "    : function () {",
    "        var f = {};",
    "        try {",
    "          if (process.env.YTDLP_COOKIES_FILE) f.cookies = process.env.YTDLP_COOKIES_FILE;",
    "          else if (process.env.YTDLP_COOKIES_FROM_BROWSER) f.cookiesFromBrowser = process.env.YTDLP_COOKIES_FROM_BROWSER;",
    "          if (process.env.YTDLP_PROXY) f.proxy = process.env.YTDLP_PROXY;",
    "          var eas = [];",
    "          if (process.env.YTDLP_EXTRACTOR_ARGS) eas.push(process.env.YTDLP_EXTRACTOR_ARGS);",
    "          if (!f.cookies && !f.cookiesFromBrowser && process.env.YTDLP_PLAYER_CLIENTS)",
    "            eas.push('youtube:player_client=' + process.env.YTDLP_PLAYER_CLIENTS);",
    "          if (eas.length) f.extractorArgs = eas;",
    "        } catch (err) {}",
    "        return f;",
    "      };",
    "  var __argv = (fl) => args(url, fl);",
    "  var __runOnce = (fl) => new Promise((res2, rej2) => {",
    "    const proc = " + spawnExpr + "(YTDLP_PATH, __argv(fl), options);",
    "    let stdout = '';",
    "    let stderr = '';",
    "    proc.stdout?.on('data', (c) => { stdout += c; });",
    "    proc.stderr?.on('data', (c) => { stderr += c; });",
    "    proc.on('close', (code) => {",
    "      if (code === 0) {",
    "        try { res2(JSON.parse(stdout)); return; } catch (e) {}",
    "        const s0 = stdout.indexOf('{');",
    "        const e0 = stdout.lastIndexOf('}');",
    "        if (s0 !== -1 && e0 > s0) { try { res2(JSON.parse(stdout.slice(s0, e0 + 1))); return; } catch (e) {} }",
    "        const a0 = stdout.indexOf('[');",
    "        const z0 = stdout.lastIndexOf(']');",
    "        if (a0 !== -1 && z0 > a0) { try { res2(JSON.parse(stdout.slice(a0, z0 + 1))); return; } catch (e) {} }",
    "        rej2(new Error(stderr.trim().slice(0, 500) || stdout.slice(0, 500)));",
    "      } else rej2(new Error(stderr.trim().slice(0, 1500) || stdout.slice(0, 500)));",
    "    });",
    "    proc.on('error', rej2);",
    "  });",
    "  var __isBotCheck = (m) => /sign in to confirm|not a bot|please sign in/i.test(String(m));",
    "  var __friendly = 'YouTube bot-check: ضع ملف cookies.txt بجانب index.js (شاهد README - قسم YouTube Cookies) أو اضبط YTDLP_COOKIES_FROM_BROWSER في .env ثم أعد تشغيل البوت | YouTube requires sign-in verification - add cookies.txt next to index.js (see README) or set YTDLP_COOKIES_FROM_BROWSER in .env and restart';",
    "  var __base = Object.assign({}, flags || {}, __getExtra());",
    "  return __runOnce(__base).then(null, (err1) => {",
    "    const msg1 = String((err1 && err1.message) || err1);",
    "    const bot1 = __isBotCheck(msg1);",
    "    if (!bot1 && !/requested format is not available|no video formats|no formats available/i.test(msg1)) throw err1;",
    "    console.error('[yt-dlp] YouTube blocked the request (' + (bot1 ? 'bot-check' : 'no formats') + ') - trying fallback player clients...');",
    "    const clients = String(process.env.YTDLP_FALLBACK_CLIENTS || 'tv,web_safari,mweb,ios').split(',').map((s) => s.trim()).filter(Boolean);",
    "    let lastErr = err1;",
    "    let sawBotCheck = bot1;",
    "    const chain = clients.reduce((p, clientName) => p.catch(() => {",
    "      const fb = Object.assign({}, flags || {});",
    "      delete fb.extractorArgs;",
    "      fb.extractorArgs = ['youtube:player_client=' + clientName];",
    "      if (__base.cookies) fb.cookies = __base.cookies;",
    "      if (__base.cookiesFromBrowser) fb.cookiesFromBrowser = __base.cookiesFromBrowser;",
    "      if (__base.proxy) fb.proxy = __base.proxy;",
    "      return __runOnce(fb).catch((errN) => {",
    "        lastErr = errN;",
    "        if (__isBotCheck(String((errN && errN.message) || errN))) sawBotCheck = true;",
    "        throw errN;",
    "      });",
    "    }), Promise.reject(lastErr));",
    "    return chain.catch(() => {",
    "      const msgL = String((lastErr && lastErr.message) || lastErr);",
    "      console.error('[yt-dlp] All fallback clients failed:', msgL.slice(0, 300));",
    "      throw new Error(sawBotCheck ? __friendly : (__friendly + ' [' + msgL.slice(0, 100) + ']'));",
    "    });",
    "  });",
    "}, \"json\");"
  ].join("\n");
}

function patchFile(file) {
  if (!fs.existsSync(file)) {
    return `skip missing ${file}`;
  }
  let src = fs.readFileSync(file, "utf8");

  if (src.includes(MARKER)) {
    return `already ok  ${path.basename(file)}`;
  }

  // Match:  var json = /* @__PURE__ */ __name((url, flags, options) => { ... }, "json");
  const re = /var json = \/\* @__PURE__ \*\/ __name\(\(url, flags, options\) => \{\r?\n([\s\S]*?)\r?\n\}, "json"\);/;
  const m = src.match(re);
  if (!m) {
    return `PATTERN NOT FOUND in ${path.basename(file)} (upstream changed?)`;
  }

  // Capture the exact spawn expression used by THIS bundle variant
  // (CJS: "(0, import_node_child_process.spawn)"  |  ESM: "spawn").
  const sm = m[1].match(/=\s*(.+?)\(YTDLP_PATH\s*,/);
  const spawnExpr = sm ? sm[1].trim() : "spawn";

  src = src.replace(re, () => buildHardenedJson(spawnExpr));
  fs.writeFileSync(file, src, "utf8");
  return `patched     ${path.basename(file)} (spawn: ${spawnExpr})`;
}

function applyPatch() {
  const results = [];
  results.push(patchFile(path.join(PKG_DIST, "index.js")));
  results.push(patchFile(path.join(PKG_DIST, "index.mjs")));
  return results;
}

module.exports = { applyPatch };

// CLI usage: node scripts/patch-ytdlp.js
if (require.main === module) {
  console.log("[patch-ytdlp] hardening @distube/yt-dlp ...");
  for (const line of applyPatch()) console.log("[patch-ytdlp] " + line);
  console.log("[patch-ytdlp] done.");
}
