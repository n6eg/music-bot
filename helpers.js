// Shared pure helpers used by commands.js / panel.js / index.js.
// No side effects at require-time (safe for circular-import scenarios).
const fs = require("fs");

// ---------------------------------------------------------------------
// Aliases mapping (works with and without prefix, and via mention)
// ---------------------------------------------------------------------
const aliasMap = {
  // Play aliases
  "play": "play", "p": "play", "شغل": "play", "ش": "play",
  // Loop aliases
  "loop": "loop", "تكرار": "loop",
  // Volume aliases
  "volume": "volume", "v": "volume", "الصوت": "volume",
  // Skip aliases
  "skip": "skip", "س": "skip",
  // Stop aliases
  "stop": "stop", "st": "stop", "توقف": "stop",
  // Come aliases (c, come, تعال)
  "come": "come", "c": "come", "تعال": "come",
  // Leave aliases
  "leave": "leave", "مغادرة": "leave",
  // Music & Bot control
  "autoplay": "autoplay", "nowplaying": "nowplaying", "np": "nowplaying",
  "seek": "seek", "filters": "filters", "shuffle": "shuffle", "clear": "clear",
  "search": "search", "pause": "pause", "resume": "resume", "queue": "queue",
  "q": "queue", "prefix": "prefix", "chat": "chat", "setting": "setting", "ping": "ping",
  // Panel & Owner commands
  "mp": "mp", "#mp": "mp", "setname": "setname", "setavatar": "setavatar",
  "setgame": "setgame", "setserver": "setserver", "setup": "setup",
  "lang": "lang", "platform": "platform", "embed": "embed", "addowner": "addowner",
  "removeowner": "removeowner", "owners": "owners", "restart": "restart",
  "restartall": "restartall", "avatarall": "avatarall", "comeall": "comeall",
  "leaveall": "leaveall",
  // Spread aliases (owner): fill a range of voice rooms with free bots
  "spread": "spread", "توزيع": "spread", "fillrooms": "spread",
  // Chat clean commands
  "clean": "clean", "مسح": "clean", "clear-chat": "clean", "cleanchat": "clean", "purge": "clean",
  // Custom Bot Branding (Per-Server Avatar / الافتار المخصص لكل سيرفر)
  "setserveravatar": "setserveravatar", "serveravatar": "setserveravatar",
  "صورة-السيرفر": "setserveravatar", "افتار-السيرفر": "setserveravatar",
  "براند": "setserveravatar", "branding": "setserveravatar",
  "setserveravatarall": "serveravatarall", "serveravatarall": "serveravatarall",
  "افتار-السيرفر-الكل": "serveravatarall", "صورة-السيرفر-الكل": "serveravatarall",
  "resetserveravatar": "resetserveravatar", "حذف-صورة-السيرفر": "resetserveravatar",
  // Custom Bot Branding (Per-Server Banner / البنر المخصص لكل سيرفر)
  "setbanner": "setbanner", "banner": "setbanner", "بنر": "setbanner",
  "setserverbanner": "setserverbanner", "serverbanner": "setserverbanner",
  "بنر-السيرفر": "setserverbanner",
  "setserverbannerall": "serverbannerall", "serverbannerall": "serverbannerall",
  "بنر-السيرفر-الكل": "serverbannerall",
  "bannerall": "bannerall", "بنر-الكل": "bannerall",
  "resetserverbanner": "resetserverbanner", "حذف-بنر-السيرفر": "resetserverbanner"
};

/**
 * True when a raw message looks like a bot command (used to keep the panel's
 * chat collectors from swallowing real commands as "the new bot name").
 */
function looksLikeCommand(text, prefix) {
  const t = String(text || "").trim();
  if (!t) return false;
  if (prefix && t.startsWith(prefix)) return true;
  const firstWord = t.split(/\s+/)[0].toLowerCase();
  return Boolean(aliasMap[firstWord]);
}

// ---------------------------------------------------------------------
// Truthful username renaming.
// Discord usernames (post-migration) reject spaces, '#' and most special
// characters. We try the desired name first; if the API rejects it we
// retry with a sanitized variant and report what ACTUALLY happened.
// ---------------------------------------------------------------------
const USERNAME_MAX_LEN = 32;

function sanitizeUsername(name) {
  let s = String(name || "").trim().toLowerCase();
  s = s.replace(/\s+/g, "_").replace(/[^a-z0-9._]/g, "");
  s = s.replace(/^[._]+/, "").replace(/[._]+$/, "").slice(0, USERNAME_MAX_LEN);
  if (s.length < 2) s = `bot_${Date.now().toString(36).slice(-5)}`;
  return s;
}

// ---------------------------------------------------------------------
// Per-server NICKNAME setter (the name shown inside ONE Discord server -
// NOT the global account username). Nicknames allow 1..32 chars including
// spaces and single digits, so "1", "2", "3"... apply as-is.
// Falls back to fetching the member when the guild cache has no .me yet.
// ---------------------------------------------------------------------
async function safeSetNickname(client, guildId, desiredName) {
  const name = String(desiredName ?? "").trim().slice(0, 32);
  if (!client || !guildId || !name) {
    return { ok: false, applied: null, error: new Error("missing client/guild/name") };
  }
  try {
    const guild = client.guilds?.cache?.get(guildId);
    let me = guild?.members?.me;
    if (!me && typeof guild?.members?.fetch === "function") {
      me = await guild.members.fetch(client.user.id).catch(() => null);
    }
    if (!me || typeof me.setNickname !== "function") {
      return { ok: false, applied: null, error: new Error("member not available") };
    }
    await me.setNickname(name);
    return { ok: true, applied: name, error: null };
  } catch (err) {
    return { ok: false, applied: null, error: err };
  }
}

// ---------------------------------------------------------------------
// Custom Bot Branding (Per-Server Avatar / الافتار المخصص لكل سيرفر)
// Allows each Discord server to display a unique avatar for the bots
// via Discord API PATCH /guilds/{guild.id}/members/@me without altering
// the bot's global avatar or affecting other servers.
// ---------------------------------------------------------------------

/**
 * Convert an image URL, Buffer, or file path to a base64 Data URI string.
 * @param {string|Buffer} input - Image URL, local file path, or Buffer
 * @returns {Promise<string|null>}
 */
async function imageToDataUri(input) {
  if (!input) return null;
  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.startsWith("data:image/")) return trimmed;

    if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) {
      const res = await fetch(trimmed);
      if (!res.ok) {
        throw new Error(`فشل تحميل الصورة من الرابط (HTTP ${res.status})`);
      }
      let mimeType = "image/png";
      const contentType = res.headers.get("content-type");
      if (contentType && contentType.toLowerCase().includes("image/")) {
        mimeType = contentType.split(";")[0].trim().toLowerCase();
      } else if (trimmed.match(/\.(jpe?g|png|gif|webp)(\?.*)?$/i)) {
        const ext = trimmed.match(/\.(jpe?g|png|gif|webp)(\?.*)?$/i)[1].toLowerCase();
        mimeType = ext === "jpg" ? "image/jpeg" : `image/${ext}`;
      }
      const arrayBuf = await res.arrayBuffer();
      const base64 = Buffer.from(arrayBuf).toString("base64");
      return `data:${mimeType};base64,${base64}`;
    }

    if (fs.existsSync(trimmed)) {
      const buf = fs.readFileSync(trimmed);
      let mimeType = "image/png";
      if (trimmed.endsWith(".jpg") || trimmed.endsWith(".jpeg")) mimeType = "image/jpeg";
      else if (trimmed.endsWith(".gif")) mimeType = "image/gif";
      else if (trimmed.endsWith(".webp")) mimeType = "image/webp";
      return `data:${mimeType};base64,${buf.toString("base64")}`;
    }
    throw new Error("رابط الصورة غير صالح أو الملف غير موجود");
  }

  if (Buffer.isBuffer(input)) {
    return `data:image/png;base64,${input.toString("base64")}`;
  }

  throw new Error("صيغة الصورة غير مدعومة");
}

/**
 * Set or reset a bot's per-server avatar (Guild Member Avatar).
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {string|Buffer|null} imageInput - image URL, local path, Buffer, or null/'reset' to remove
 * @returns {Promise<any>}
 */
async function setGuildAvatar(client, guildId, imageInput) {
  if (!client?.rest || !guildId) {
    throw new Error("بيانات البوت أو معرف السيرفر غير متوفر");
  }
  const isReset = !imageInput || imageInput === "reset" || imageInput === "حذف" || imageInput === "افتراضي";
  const dataUri = isReset ? null : await imageToDataUri(imageInput);

  try {
    return await client.rest.patch(`/guilds/${guildId}/members/@me`, {
      body: { avatar: dataUri }
    });
  } catch (err) {
    try {
      const { Routes } = require("discord.js");
      if (Routes.userGuildMember) {
        return await client.rest.patch(Routes.userGuildMember(guildId), {
          body: { avatar: dataUri }
        });
      }
    } catch (_) { }
    throw err;
  }
}

/**
 * Set or reset a bot's per-server banner (Guild Member Banner).
 * @param {import("discord.js").Client} client
 * @param {string} guildId
 * @param {string|Buffer|null} imageInput
 * @returns {Promise<any>}
 */
async function setGuildBanner(client, guildId, imageInput) {
  if (!client?.rest || !guildId) {
    throw new Error("بيانات البوت أو معرف السيرفر غير متوفر");
  }
  const isReset = !imageInput || imageInput === "reset" || imageInput === "حذف" || imageInput === "افتراضي";
  const dataUri = isReset ? null : await imageToDataUri(imageInput);

  try {
    return await client.rest.patch(`/guilds/${guildId}/members/@me`, {
      body: { banner: dataUri }
    });
  } catch (err) {
    try {
      const { Routes } = require("discord.js");
      if (Routes.userGuildMember) {
        return await client.rest.patch(Routes.userGuildMember(guildId), {
          body: { banner: dataUri }
        });
      }
    } catch (_) { }
    throw err;
  }
}

/**
 * Attempt to set a username; falls back to a sanitized name on failure.
 * @returns {Promise<{ok: boolean, applied: string|null, sanitized: boolean, error: Error|null}>}
 */
async function getChannelForBot(client, guildId, channelId) {
  if (!client || !guildId || !channelId) return null;
  const guild = client.guilds?.cache?.get(guildId);
  if (!guild) return null;
  const cached = guild.channels?.cache?.get(channelId);
  if (cached) return cached;
  try {
    if (typeof guild.channels?.fetch !== "function") return null;
    return (await guild.channels.fetch(channelId)) || null;
  } catch (e) {
    return null;
  }
}

/**
 * Attempt to set a username; falls back to a sanitized name on failure.
 * @returns {Promise<{ok: boolean, applied: string|null, sanitized: boolean, error: Error|null}>}
 */
async function safeRename(user, desiredName) {
  const desired = String(desiredName || "").trim();
  if (!user) return { ok: false, applied: null, sanitized: false, error: new Error("no user") };
  if (!desired) return { ok: false, applied: null, sanitized: false, error: new Error("empty name") };

  try {
    await user.setUsername(desired);
    return { ok: true, applied: desired, sanitized: false, error: null };
  } catch (rawErr) {
    const fallback = sanitizeUsername(desired);
    if (fallback === desired) {
      return { ok: false, applied: null, sanitized: false, error: rawErr };
    }
    try {
      await user.setUsername(fallback);
      return { ok: true, applied: fallback, sanitized: true, error: null };
    } catch (err) {
      return { ok: false, applied: null, sanitized: true, error: err };
    }
  }
}

// ---------------------------------------------------------------------
// Duration formatting (seconds -> m:ss / h:mm:ss)
// ---------------------------------------------------------------------
function formatDuration(totalSeconds) {
  const sec = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h > 0 ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

// ---------------------------------------------------------------------
// YouTube search via the yt-dlp binary managed by @distube/yt-dlp.
// Returns [] when yt-dlp is unavailable or fails - callers fall back
// to the SoundCloud extractor in that case.
// ---------------------------------------------------------------------
// ---------------------------------------------------------------------
// In-memory query cache for fast repeated lookups (TTL: 2 hours)
// ---------------------------------------------------------------------
const _queryCache = new Map();
const MAX_CACHE_SIZE = 300;

function getCachedResult(key) {
  const item = _queryCache.get(key);
  if (!item) return null;
  if (Date.now() - item.ts > 2 * 60 * 60 * 1000) {
    _queryCache.delete(key);
    return null;
  }
  return item.data;
}

function setCachedResult(key, data) {
  if (_queryCache.size >= MAX_CACHE_SIZE) {
    const oldestKey = _queryCache.keys().next().value;
    _queryCache.delete(oldestKey);
  }
  _queryCache.set(key, { data, ts: Date.now() });
}

let _ytdlpJson = null;
function getYtDlpJson() {
  if (_ytdlpJson !== null) return _ytdlpJson;
  try {
    _ytdlpJson = require("@distube/yt-dlp").json;
  } catch (e) {
    _ytdlpJson = undefined;
  }
  return _ytdlpJson;
}

/**
 * Search YouTube for tracks/playlists top results.
 * @param {string} query - plain text query (NOT prefixed with ytsearch:)
 * @param {number} limit - number of results (1..20)
 * @returns {Promise<Array<{name:string,url:string,duration:number,id:string}>>}
 */
async function ytSearch(query, limit = 5) {
  const cleanQ = String(query || "").trim().toLowerCase();
  const cacheKey = `yt:${limit}:${cleanQ}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  const jsonFn = getYtDlpJson();
  if (typeof jsonFn !== "function") return [];
  const n = Math.min(20, Math.max(1, Math.floor(limit) || 1));
  let data;
  try {
    // NOTE: noCallHome was removed - "--no-call-home" is deprecated by newer
    // yt-dlp binaries and its deprecation notice gets CONCATENATED into the
    // JSON buffer by @distube/yt-dlp (it appends stderr), crashing
    // JSON.parse inside the lib's close-handler and killing the process.
    // quiet + noWarnings keep the output stream clean for the same reason.
    // flatPlaylist: true avoids scraping individual video manifests, making search 3-5x faster!
    data = await jsonFn(`ytsearch${n}:${query}`, {
      dumpSingleJson: true,
      flatPlaylist: true,
      quiet: true,
      noWarnings: true,
      skipDownload: true,
      simulate: true
    });
  } catch (e) {
    return []; // binary missing, offline, YouTube blocked... graceful fallback
  }
  const entries = Array.isArray(data) ? data : (data && Array.isArray(data.entries) ? data.entries : []);
  const results = entries
    .filter((e) => e && (e.id || e.url))
    .map((e) => ({
      id: e.id,
      name: e.title || e.id,
      url: e.webpage_url || e.url || `https://www.youtube.com/watch?v=${e.id}`,
      duration: Number(e.duration) || 0
    }));

  if (results.length > 0) {
    setCachedResult(cacheKey, results);
  }
  return results;
}

/**
 * Resolve a plain-text query to a playable URL with a fast, resilient strategy:
 *   1. Try YouTube search via yt-dlp (single result).
 *   2. On failure, fall back to a SoundCloud search (the bot already ships a
 *      SoundCloud plugin) so "seems playing but silent" never happens just
 *      because YouTube's bot-check answered instead of a real result.
 * Returns null when both engines fail.
 * @param {string} query
 * @param {object} soundcloudPlugin - the SoundCloudPlugin instance (optional)
 * @returns {Promise<{url:string, engine:string, name?:string, duration?:number}|null>}
 */
async function resolveQueryToUrl(query, soundcloudPlugin) {
  const cleanQ = String(query || "").trim().toLowerCase();
  const cacheKey = `res:${cleanQ}`;
  const cached = getCachedResult(cacheKey);
  if (cached) return cached;

  try {
    const [top] = await ytSearch(query, 1);
    if (top?.url) {
      const result = { url: top.url, engine: "youtube", name: top.name, duration: top.duration };
      setCachedResult(cacheKey, result);
      return result;
    }
  } catch (e) { /* fall through */ }

  if (soundcloudPlugin && typeof soundcloudPlugin.search === "function") {
    try {
      const songs = await soundcloudPlugin.search(query, "track", 1);
      if (Array.isArray(songs) && songs[0]?.url) {
        const result = { url: songs[0].url, engine: "soundcloud", name: songs[0].name, duration: songs[0].duration };
        setCachedResult(cacheKey, result);
        return result;
      }
    } catch (e) { /* fall through */ }
  }
  return null;
}

module.exports = {
  aliasMap,
  looksLikeCommand,
  sanitizeUsername,
  safeRename,
  safeSetNickname,
  imageToDataUri,
  setGuildAvatar,
  setGuildBanner,
  getChannelForBot,
  formatDuration,
  ytSearch,
  resolveQueryToUrl
};
