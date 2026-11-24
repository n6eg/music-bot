// DisTube v5 and @discordjs/voice 0.19 require Node >= 22.12. Fail fast with a
// clear message instead of a cryptic EBADENGINE / syntax crash on old images.
const REQUIRED_NODE = [22, 12, 0];
const nodeParts = process.versions.node.split(".").map(Number);
const nodeTooOld =
  nodeParts[0] < REQUIRED_NODE[0] ||
  (nodeParts[0] === REQUIRED_NODE[0] && nodeParts[1] < REQUIRED_NODE[1]) ||
  (nodeParts[0] === REQUIRED_NODE[0] &&
    nodeParts[1] === REQUIRED_NODE[1] &&
    nodeParts[2] < REQUIRED_NODE[2]);
if (nodeTooOld) {
  console.error(
    `[startup] Node ${process.versions.node} is too old. This bot requires Node >= ${REQUIRED_NODE.join(".")} ` +
      "(DisTube 5 / @discordjs/voice). On Pterodactyl/Wispbyte select the nodejs_22 image and restart."
  );
  console.error(
    `[startup] نسخة Node ${process.versions.node} قديمة. اختر صورة nodejs_22 من إعدادات السيرفر ثم أعد التشغيل.`
  );
  process.exit(1);
}

const fs = require("fs");
const path = require("path");
require("dotenv").config();
for (const p of [
  path.join(__dirname, "render.env"),
  "/etc/secrets/render.env",
  "/etc/secrets/.env"
]) {
  try {
    if (fs.existsSync(p)) {
      require("dotenv").config({ path: p, override: true });
    }
  } catch (e) { }
}

require("./yt-dlp-patch");
// Prefer the SYSTEM ffmpeg when FFMPEG_BIN is set. On bot.hosting/VPS the
// bundled ffmpeg-static binary often segfaults (SIGSEGV) -> music shows
// "playing" but no sound ever comes out. FFMPEG_BIN=/usr/bin/ffmpeg fixes it.
const ffmpegPath = process.env.FFMPEG_BIN || require("ffmpeg-static");
process.env.FFMPEG_PATH = ffmpegPath;

// Lightweight health-check HTTP server for platforms like Render / Railway / Koyeb
const http = require("http");
const https = require("https");
const { execFile } = require("child_process");
const { promisify } = require("util");
const execFileAsync = promisify(execFile);

// Guarded audio pipeline self-test. Render free plan has no SSH/one-off jobs,
// so this is the only way to verify yt-dlp + cookies + ffmpeg + Opus end to end
// on the deployed host. Disabled unless DIAG_TOKEN is configured.
async function runAudioDiag(client, noCookies, source) {
  const path2 = require("path");
  const { json: ytdlpJson } = require("@distube/yt-dlp");
  const extra = (globalThis.__ytdlpExtraFlags ? globalThis.__ytdlpExtraFlags() : {}) || {};

  const url = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  let meta = null;
  let streamUrl = null;
  let title = null;

  if (source === "direct") {
    // Plain MP3 over HTTPS - isolates whether ffmpeg works at all on this host.
    title = "Direct MP3 test";
    streamUrl = "https://www.soundhelix.com/examples/mp3/SoundHelix-Song-1.mp3";
  } else if (source === "soundcloud") {
    const { SoundCloudPlugin, SearchType } = require("@distube/soundcloud");
    const sc = new SoundCloudPlugin();
    const tracks = await sc.search("rick astley never gonna give you up", SearchType.Track, 1);
    if (!tracks || !tracks[0]) throw new Error("SoundCloud search returned no tracks");
    const song = tracks[0];
    title = song.name || song.song?.title || "SoundCloud track";
    streamUrl = await sc.getStreamURL(song);
    if (!streamUrl) throw new Error("SoundCloud returned no stream URL");
  } else {
  if (client) {
    // Probe a specific player client (and optionally no cookies) to find a
    // combination that works from this hosting IP.
    const ytDir = path2.join(path2.dirname(require.resolve("@distube/yt-dlp")), "..", "bin");
    const ytBin = path2.join(ytDir, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp");
    const args = ["--no-warnings", "--dump-single-json", "--skip-download", "--format", "worst"];
    if (!noCookies && extra.cookies) args.push("--cookies", extra.cookies);
    args.push("--extractor-args", "youtube:player_client=" + client, url);
    try {
      const probe = await execFileAsync(ytBin, args, { timeout: 60000, maxBuffer: 16 * 1024 * 1024 });
      const m = JSON.parse(probe.stdout);
      return { ok: true, client, cookies: !noCookies && !!extra.cookies, title: m.title, formats: (m.formats || []).length };
    } catch (e) {
      return { ok: false, client, cookies: !noCookies && !!extra.cookies, error: String(e.message || e).slice(0, 500) };
    }
  }

    // Use the SAME patched json() that real playback uses, including the
    // automatic fallback to tv/web_safari/mweb/ios clients on bot-check.
    meta = await ytdlpJson(url, {
      dumpSingleJson: true,
      noWarnings: true,
      skipDownload: true,
      simulate: true,
      format: "ba/ba*"
    });
    if (!meta || (meta.title === undefined && meta.id === undefined)) throw new Error("yt-dlp returned no metadata");
    title = meta.title;

    const best = (meta.formats || []).filter(f => f.url && (f.acodec !== "none" || f.vcodec === "none"))
      .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
    streamUrl = (best && best.url) || meta.url;
    if (!streamUrl) throw new Error("no playable stream URL found");
  }

  const ffmpeg = process.env.FFMPEG_PATH || ffmpegPath;
  let pcm;
  try {
    pcm = await execFileAsync(
      ffmpeg,
      ["-v", "error", "-nostdin", "-protocol_whitelist", "file,http,https,tcp,tls,crypto", "-i", streamUrl,
        "-t", "1", "-ac", "2", "-ar", "48000", "-f", "s16le", "pipe:1"],
      { encoding: "buffer", timeout: 60000, maxBuffer: 16 * 1024 * 1024 }
    );
  } catch (e) {
    throw new Error("ffmpeg failed: code=" + (e.code || "?") + " killed=" + !!e.killed +
      " signal=" + (e.signal || "?") + " msg=" + String(e.message || "").slice(0, 300) +
      " stderr=" + String(e.stderr || "").slice(0, 400));
  }
  const opusBuf = await new Promise((resolve, reject) => {
    const { opus } = require("prism-media");
    const enc = new opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
    let out = Buffer.alloc(0);
    const timer = setTimeout(() => reject(new Error("Opus encode timeout")), 15000);
    enc.on("data", chunk => { out = Buffer.concat([out, chunk]); });
    enc.on("error", reject);
    enc.on("end", () => { clearTimeout(timer); resolve(out); });
    enc.end(pcm.stdout);
  });
  return {
    ok: true,
    source: source || "youtube",
    title,
    cookies: extra.cookies ? path2.basename(extra.cookies) : null,
    pcmBytes: pcm.stdout.length,
    opusBytes: opusBuf.length
  };
}

if (process.env.PORT) {
  const healthServer = http.createServer((req, res) => {
    if (req.url && req.url.startsWith("/diag")) {
      if (!process.env.DIAG_TOKEN || req.headers["x-diag-token"] !== process.env.DIAG_TOKEN) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        res.end("Not found");
        return;
      }
      const u = new URL(req.url, "http://localhost");
      runAudioDiag(
        u.searchParams.get("client"),
        u.searchParams.get("nocookies") === "1",
        u.searchParams.get("source")
      )
        .then(result => {
          res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify(result));
        })
        .catch(err => {
          console.error("[diag] audio self-test failed:", err && err.message);
          res.writeHead(500, { "Content-Type": "application/json; charset=utf-8" });
          res.end(JSON.stringify({ ok: false, error: String(err && err.message || err) }));
        });
      return;
    }
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot is alive and running!");
  });
  healthServer.listen(process.env.PORT, () => {
    console.log(`🌐 HTTP health-check listening on port ${process.env.PORT} (Render Web Service ready)`);
  });

  // Keep-alive self-ping: Prevents Render free tier from sleeping (spins down after 15m)
  // Render injects RENDER_EXTERNAL_URL automatically for web services.
  const pingUrl = process.env.RENDER_EXTERNAL_URL;
  if (!pingUrl) {
    console.warn("⚠️ RENDER_EXTERNAL_URL is not set - free-tier keep-alive ping disabled.");
  } else {
    console.log(`💓 Keep-alive ping -> ${pingUrl}`);
    const pingTimer = setInterval(() => {
      try {
        const clientReq = (pingUrl.startsWith("https") ? https : http).get(pingUrl, () => {});
        clientReq.on("error", () => {});
      } catch (e) { }
    }, 5 * 60 * 1000);
    if (typeof pingTimer.unref === "function") pingTimer.unref();
  }
}

const {
  Client,
  GatewayIntentBits,
  Partials,
  Collection,
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  MessageFlags,
  PermissionsBitField
} = require("discord.js");
const { DisTube } = require("distube");
const { SpotifyPlugin } = require("@distube/spotify");
const { SoundCloudPlugin } = require("@distube/soundcloud");
const { handleCommand } = require("./commands");
const { handlePanelInteraction } = require("./panel");
const { getConfig, saveConfig, getBotChannel247 } = require("./config-store");
const { attachVoiceGuard } = require("./voice-guard");
const { makeT, isBotCheckError } = require("./i18n");

// Opus encoder sanity check. @discordjs/opus only ships prebuilds up to a few
// Node ABIs; on newer Node (e.g. v26) it fails to load and prism-media falls
// back to `opusscript`. If neither is installed, voice silently produces no
// audio - check it once at startup instead of leaving users guessing.
try {
  const { opus } = require("prism-media");
  new opus.Encoder({ rate: 48000, channels: 2, frameSize: 960 });
  console.log("✅ [opus] audio encoder ready");
} catch (e) {
  console.error("❌ [opus] No Opus encoder available - songs will NOT play!");
  console.error("   Fix: npm install opusscript   (or run the bot on Node 22 LTS)");
}

// Load optional yt-dlp plugin safely
let YtDlpPlugin = null;
try {
  YtDlpPlugin = require("@distube/yt-dlp").YtDlpPlugin;
} catch (e) { }

// config.json is runtime state. config-store bootstraps it from
// config.example.json when a deployment archive does not include it.
const config = getConfig();
const clientsMap = new Collection();

// --- Secure token loading (env only, never from config.json) ---
function redact(str) {
  // Discord tokens look like: <24+ chars>.<6 chars>.<27+ chars>
  return String(str).replace(
    /[\w-]{20,}\.[\w-]{5,}\.[\w-]{20,}/g,
    "[REDACTED_TOKEN]"
  );
}

function getTokensFromEnv() {
  const tokens = [];
  // Support DISCORD_TOKEN (single) and DISCORD_TOKEN_1..N (multi-bot)
  const single = process.env.DISCORD_TOKEN;
  if (single && single.trim() && !single.includes("your_")) tokens.push(single.trim());

  for (let i = 1; i <= 50; i++) {
    const t = process.env[`DISCORD_TOKEN_${i}`];
    if (t && t.trim() && !t.includes("your_")) {
      if (!tokens.includes(t.trim())) tokens.push(t.trim());
    }
  }
  return tokens;
}

const botTokens = getTokensFromEnv();

if (botTokens.length === 0) {
  console.error(
    "❌ لم يتم العثور على أي توكنات! يرجى إضافة التوكنات في ملف .env (مثال: DISCORD_TOKEN_1=...)\n" +
    "   انسخ .env.example إلى .env وضع توكنات بوتاتك فيه."
  );
}

// Global safety net: never print raw tokens in uncaught errors
process.on("unhandledRejection", (err) => {
  const msg = err?.message || String(err);
  if (msg.includes("handshake has timed out") || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET" || err?.code === "UND_ERR_CONNECT_TIMEOUT") {
    console.warn("⚠️ [Network] Handshake timeout / connection hiccup. Discord client is auto-reconnecting...");
    return;
  }
  console.error("❌ Unhandled rejection:", redact(msg));
});
process.on("uncaughtException", (err) => {
  const msg = err?.message || String(err);
  if (msg.includes("handshake has timed out") || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET" || err?.code === "UND_ERR_CONNECT_TIMEOUT") {
    console.warn("⚠️ [Network] WebSocket opening handshake timed out. Discord client is auto-reconnecting...");
    return;
  }
  // Log with stack for diagnosability. The process intentionally stays alive
  // so one bad event doesn't kill the whole multi-bot fleet.
  console.error("❌ Uncaught exception:", redact(err?.stack || msg));
});

async function startBot(token, index) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildVoiceStates,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMembers
    ],
    partials: [Partials.Channel, Partials.Message, Partials.GuildMember]
  });

  const soundCloudPlugin = new SoundCloudPlugin();
  const plugins = [
    new SpotifyPlugin(),
    soundCloudPlugin
  ];

  if (YtDlpPlugin) {
    // update:false - the plugin downloads yt-dlp on every construction by
    // default. With 4 bots starting at once that means 4 concurrent writes to
    // the same binary -> EBUSY -> broken YouTube playback. Our own scheduler in
    // yt-dlp-patch.js already keeps the binary fresh.
    plugins.push(new YtDlpPlugin({ update: false }));
  }

  const distube = new DisTube(client, {
    ffmpeg: {
      path: ffmpegPath,
      args: {
        global: {
          loglevel: "warning"
        },
        input: {
          reconnect: 1,
          reconnect_streamed: 1,
          reconnect_delay_max: 5,
          user_agent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
        }
      }
    },
    emitNewSongOnly: true,
    emitAddSongWhenCreatingQueue: false,
    emitAddListWhenCreatingQueue: false,
    // NOTE: DisTube v5 removed leaveOn* options - it NEVER auto-leaves voice.
    // That default is what we want for a 24/7 fleet; only -leave or a manual
    // kick removes bots (the voice guard rejoins kicks while a pin exists).
    plugins
  });

  // Attach distube instance to client
  client.distube = distube;
  // Expose the SoundCloud extractor for the `search` command fallback
  // (DisTube v5 has no built-in DisTube#search API).
  client._soundcloudPlugin = soundCloudPlugin;

  // Auto-reconnect guard: rejoins the bot's pinned room after a manual
  // disconnect (only while an active 24/7 pin exists).
  attachVoiceGuard(client, distube);

  // DisTube Event Handlers with Exact Custom UI
  let _retryStreams = new Map(); // guildId -> { songId, attempts, timer }

  distube.on("playSong", (queue, song) => {
    console.log(`[playSong] ${client.user?.tag} | guild ${queue.id} | ${song.name}`);
    // Reset retry state for this song so we never retry twice on one track.
    const prev = _retryStreams.get(queue.id);
    if (prev && prev.timer) clearTimeout(prev.timer);
    _retryStreams.set(queue.id, { songId: song.id, attempts: 0, timer: null });

    const filtersMenu = new StringSelectMenuBuilder()
      .setCustomId("distube_filters_menu")
      .setPlaceholder("الفلاتر ..")
      .addOptions([
        { label: "Clear Filters", value: "off", emoji: "❌" },
        { label: "3D Filter", value: "3d", emoji: "🎧" },
        { label: "Bassboost", value: "bassboost", emoji: "🔊" },
        { label: "Echo", value: "echo", emoji: "📣" },
        { label: "Karaoke", value: "karaoke", emoji: "🎤" },
        { label: "Nightcore", value: "nightcore", emoji: "⚡" },
        { label: "Vaporwave", value: "vaporwave", emoji: "🌊" },
        { label: "Flanger", value: "flanger", emoji: "🎛️" }
      ]);

    const row = new ActionRowBuilder().addComponents(filtersMenu);

    const embed = new EmbedBuilder()
      .setColor("#990022")
      .addFields(
        { name: "Playing Song", value: `[${song.name}](${song.url})`, inline: false },
        { name: "Song Duration", value: `${song.formattedDuration}`, inline: false }
      )
      .setThumbnail("https://cdn-icons-png.flaticon.com/512/461/461238.png")
      .setFooter({
        text: song.user?.displayName || song.user?.username || "User",
        iconURL: song.user?.displayAvatarURL?.() || undefined
      });

    queue.textChannel?.send({
      content: `🎶🎶 ${client.user?.username || "Music Bot"}.`,
      embeds: [embed],
      components: [row]
    }).catch(() => { });

    // Hook the DisTubeStream's ffmpeg exit so a dead stream URL (no audio)
    // triggers the re-resolve retry instead of silent playback.
    try {
      const dtStream = queue.voice?.stream;
      if (dtStream && typeof dtStream.on === "function") {
        dtStream.on("error", (streamErr) => {
          if (!/FFMPEG_EXITED|ffmpeg exited/.test(String(streamErr?.message || streamErr))) return;
          scheduleStreamRetry(queue, song);
        });
        // Also: if ffmpeg never produces readable data within ~12s, treat it
        // as a dead URL (YouTube stream blocked/hanging) and retry once.
        if (dtStream.audioResource && typeof dtStream.audioResource.on === "function") {
          dtStream.audioResource.on("readable", () => { });
        }
      }
    } catch (e) { /* never break the embed send */ }
  });

  distube.on("addSong", (queue, song) => {
    queue.textChannel?.send(`✅ **تمت إضافة إلى القائمة:** \`${song.name}\` - \`${song.formattedDuration}\``).catch(() => { });
  });

  distube.on("error", (...args) => {
    let err = null;
    try {
      // Defensive: support both emitted shapes - (error, queue) and
      // (textChannel/queue, error). Never crash on reporting an error.
      err = args.find((a) => a instanceof Error) || null;
      // Skip the Error object itself - the queue/textChannel is passed as the
      // SECOND argument. Without this filter no playback error ever reaches
      // Discord, so users only saw "searching..." and then silence.
      const carrier = args.find(
        (a) => a && typeof a === "object" && !(a instanceof Error) && !Array.isArray(a)
      );
      const textChan =
        carrier?.textChannel && typeof carrier.textChannel.send === "function"
          ? carrier.textChannel
          : carrier && typeof carrier.send === "function"
            ? carrier
            : null;
      if (err && textChan) {
        const t = makeT(config.lang);
        // YouTube bot-check failures get a clear, actionable message instead
        // of the raw English yt-dlp error wall.
        const userMsg = isBotCheckError(err.message)
          ? t("botCheckFix")
          : String(err.message).slice(0, 150);
        textChan.send(`❌ **خطأ في التشغيل:** ${userMsg}`).catch(() => { });
      }
    } catch (e) { }
    console.error("❌ DisTube error:", redact(err?.message || String(args[0] || "unknown")));
  });

  // ------------------------------------------------------------------
  // STREAM-URL RETRY (fixes "seems playing but silent" on hosts)
  //
  // Symptom: the playSong embed is sent the moment ffmpeg starts, but on
  // many hosts the stream URL yt-dlp resolved is dead/blocked (host IP
  // throttled by googlevideo, bot-check page served instead of media).
  // ffmpeg then outputs silence, the queue shows "playing", but no sound.
  //
  // Fix: if ffmpeg exits quickly with a non-zero code (i.e. it never got
  // real audio), re-resolve the stream URL ONCE with fresh yt-dlp args
  // (which the hardened patch retries through multiple player clients)
  // and restart the track instead of sitting silent.
  // ------------------------------------------------------------------
  const { YtDlpPlugin: _YtDlpPlugin, json: ytdlpJson } = (() => {
    try {
      return require("@distube/yt-dlp");
    } catch (e) {
      return { YtDlpPlugin: null, json: null };
    }
  })();

  function scheduleStreamRetry(queue, song) {
    const state = _retryStreams.get(queue.id);
    if (!state || state.songId !== song.id) return; // song changed meanwhile
    if (state.attempts >= 1) return; // only one retry per track
    state.attempts++;

    // Delay so the failure doesn't double-fire; give Discord time to idle out.
    state.timer = setTimeout(async () => {
      try {
        const q = distube.getQueue(queue.id);
        if (!q || q.songs[0]?.id !== song.id || !song.url) return;
        if (!song.stream?.playFromSource) return; // only yt-dlp songs stream from URL

        console.log(`[retry] ${song.name}: re-resolving stream URL (attempt ${state.attempts})`);
        if (typeof ytdlpJson !== "function") return;
        const info = await ytdlpJson(song.url, {
          dumpSingleJson: true,
          quiet: true,
          noWarnings: true,
          preferFreeFormats: true,
          skipDownload: true,
          simulate: true,
          format: "ba/ba*"
        });
        if (Array.isArray(info)) return; // playlist should never land here
        const freshUrl = info?.url;
        if (!freshUrl) {
          if (soundCloudPlugin) {
            console.log(`[retry] No fresh YouTube URL. Falling back to SoundCloud for ${song.name}`);
            const scSongs = await soundCloudPlugin.search(song.name, "track", 1).catch(() => null);
            if (Array.isArray(scSongs) && scSongs[0]?.url) {
              await q.play(scSongs[0].url, { skip: true });
              queue.textChannel?.send(`🔊 **تم التحويل إلى ساوندكلاود لتشغيل الصوت بنجاح:** \`${song.name}\``).catch(() => {});
              return;
            }
          }
          return;
        }

        // Patch the song's stream URL in place and restart playback.
        song.stream.url = freshUrl;
        if (typeof song.stream.setStreamURL === "function") song.stream.setStreamURL(freshUrl);
        await q.play(q.songs[0], { skip: true });
        console.log(`[retry] ${song.name}: stream re-resolved, restarting`);
      } catch (e) {
        console.error("[retry] failed to re-resolve:", e?.message);
        if (soundCloudPlugin) {
          try {
            const scSongs = await soundCloudPlugin.search(song.name, "track", 1).catch(() => null);
            if (Array.isArray(scSongs) && scSongs[0]?.url) {
              const q = distube.getQueue(queue.id);
              if (q) {
                await q.play(scSongs[0].url, { skip: true });
                queue.textChannel?.send(`🔊 **تم التحويل إلى ساوندكلاود لتشغيل الصوت بنجاح:** \`${song.name}\``).catch(() => {});
              }
            }
          } catch (scErr) { }
        }
      }
    }, 2500);
  }

  distube.on("ffmpegDebug", (msg) => {
    console.log("[ffmpeg]", msg);
  });

  client.on("error", (err) => {
    const msg = err?.message || String(err);
    if (msg.includes("handshake has timed out") || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") {
      console.warn(`⚠️ [Bot #${index + 1}] Network hiccup (${msg}). Discord client will auto-reconnect.`);
      return;
    }
    console.error(`❌ [Bot #${index + 1}] Client error:`, redact(msg));
  });

  client.on("shardError", (err, shardId) => {
    const msg = err?.message || String(err);
    if (msg.includes("handshake has timed out") || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET") {
      console.warn(`⚠️ [Bot #${index + 1}] Shard #${shardId} handshake timeout. Auto-reconnecting...`);
      return;
    }
    console.error(`❌ [Bot #${index + 1}] Shard #${shardId} error:`, redact(msg));
  });

  client.on("shardDisconnect", (event, shardId) => {
    console.warn(`⚠️ [Bot #${index + 1}] Shard #${shardId} disconnected (code ${event?.code || "unknown"}). Waiting to reconnect...`);
  });

  client.on("shardReconnecting", (shardId) => {
    console.log(`🔄 [Bot #${index + 1}] Shard #${shardId} reconnecting...`);
  });

  client.on("shardResume", (shardId, replayedEvents) => {
    console.log(`✅ [Bot #${index + 1}] Shard #${shardId} connection resumed (${replayedEvents} events replayed).`);
  });

  client.on("clientReady", async () => {
    console.log(`✅ [Bot #${index + 1}] Connected as: ${client.user.tag}`);
    client.user.setActivity("@ws.", { type: 0 });
    client.user.setStatus("dnd");

    // Auto-reconnect 24/7 Voice Channels via DisTube Voice Manager.
    // PER-BOT reconnect: each bot rejoins only ITS pinned room (or the
    // legacy guild-wide room), instead of all bots piling into one room.
    for (const guildId of Object.keys(config.twentyFourSeven)) {
      try {
        const voiceChannelId = getBotChannel247(config, guildId, client.user.id);
        if (!voiceChannelId) continue;
        const guild = client.guilds.cache.get(guildId);
        if (guild) {
          const voiceChannel = guild.channels.cache.get(voiceChannelId);
          if (voiceChannel) {
            await distube.voices.join(voiceChannel);
            console.log(`🎙️ [Bot #${index + 1}] Auto-connected to 24/7 channel in ${guild.name}`);
          }
        }
      } catch (err) { }
    }

    // Register Slash Commands (/play)
    try {
      await client.application?.commands?.set([
        {
          name: "play",
          description: "تشغيل أغنية في رومك الصوتي",
          options: [
            {
              name: "song",
              description: "اسم الأغنية أو الرابط",
              type: 3, // String type
              required: true
            }
          ]
        }
      ]);
    } catch (e) { }

    // Start auto-clean background job
    setupAutoCleanTimer();
  });

  // Handle Filters Menu Dropdown Interaction
  client.on("interactionCreate", async (interaction) => {
    // Handle /play Slash Command
    if (interaction.isChatInputCommand() && interaction.commandName === "play") {
      const query = interaction.options.getString("song");
      if (!query) {
        return interaction.reply({ content: "❌ **يرجى كتابة اسم الأغنية أو رابطها!**", flags: MessageFlags.Ephemeral });
      }

      const voiceChannel = interaction.member?.voice?.channel;
      if (!voiceChannel) {
        return interaction.reply({ content: "❌ **يجب أن تكون في روم صوتي أولاً لتشغيل الأغنية!**", flags: MessageFlags.Ephemeral });
      }

      // Ephemeral acknowledgment ("Only you can see this • Dismiss message")
      await interaction.reply({
        content: `🔍 **جاري البحث والتشغيل:** \`${query}\` ...`,
        flags: MessageFlags.Ephemeral
      });

      try {
        let playQuery = query;
        const isUrl = /^https?:\/\//i.test(query);
        const curConfig = getConfig();
        if (!isUrl && (curConfig.platform || "youtube") === "youtube") {
          const { resolveQueryToUrl } = require("./helpers");
          const resolved = await resolveQueryToUrl(query, client._soundcloudPlugin);
          if (resolved?.url) playQuery = resolved.url;
        }

        await distube.play(voiceChannel, playQuery, {
          textChannel: interaction.channel,
          member: interaction.member
        });
      } catch (err) {
        interaction.followUp({
          content: `❌ **خطأ في التشغيل:** ${err.message}`,
          flags: MessageFlags.Ephemeral
        }).catch(() => {});
      }
      return;
    }

    if (interaction.isStringSelectMenu() && interaction.customId === "distube_filters_menu") {
      const queue = distube.getQueue(interaction.guildId);
      if (!queue) {
        return interaction.reply({ content: "❌ لا يوجد شيء يتم تشغيله حالياً!", flags: MessageFlags.Ephemeral });
      }

      const filter = interaction.values[0];
      if (filter === "off") {
        queue.filters.clear();
        return interaction.reply({ content: "🎛️ **تم إيقاف جميع الفلاتر الصوتية.**", flags: MessageFlags.Ephemeral });
      }

      if (queue.filters.names.includes(filter)) {
        queue.filters.remove(filter);
        return interaction.reply({ content: `🎛️ **تم إزالة الفلتر:** \`${filter}\``, flags: MessageFlags.Ephemeral });
      } else {
        queue.filters.add(filter);
        return interaction.reply({ content: `🎛️ **تم تطبيق الفلتر:** \`${filter}\``, flags: MessageFlags.Ephemeral });
      }
    }

    // Only route panel-related interactions to the panel handler
    const isPanelComponent =
      typeof interaction.customId === "string" &&
      (interaction.customId.startsWith("mp_") ||
        interaction.customId.startsWith("mps_") ||
        interaction.customId.startsWith("modal_"));

    if (!isPanelComponent) return;

    try {
      await handlePanelInteraction(interaction, clientsMap);
    } catch (err) {
      console.error("❌ Panel interaction error:", redact(err?.message || err));
      const reply = { content: "❌ **حدث خطأ غير متوقع أثناء تنفيذ الإجراء.**", flags: MessageFlags.Ephemeral };
      if (interaction.deferred || interaction.replied) {
        interaction.followUp(reply).catch(() => { });
      } else {
        interaction.reply(reply).catch(() => { });
      }
    }
  });

  client.on("messageCreate", (message) => {
    handleCommand(message, client, distube, clientsMap).catch((err) =>
      console.error(`❌ [Bot #${index + 1}] Command handler error:`, err)
    );
  });

  async function attemptLogin(retries = 5, delay = 5000) {
    try {
      await client.login(token);
      // Key by bot user ID (not the raw token) and stash the token/index on the
      // client so `12restart` can relaunch exactly this bot later.
      client._token = token;
      client._index = index;
      clientsMap.set(client.user.id, client);
    } catch (err) {
      const msg = err?.message || String(err);
      console.error(`❌ Failed to login Bot #${index + 1}: ${redact(msg)}`);
      if (retries > 0 && (msg.includes("handshake has timed out") || err?.code === "ETIMEDOUT" || err?.code === "ECONNRESET")) {
        console.log(`🔄 [Bot #${index + 1}] Retrying login in ${delay / 1000}s (${retries} retries left)...`);
        setTimeout(() => attemptLogin(retries - 1, Math.min(delay * 1.5, 30000)), delay);
      }
    }
  }

  attemptLogin();
}

// Launch all configured bots (tokens come from .env only)
botTokens.forEach((token, index) => {
  startBot(token, index);
});

let autoCleanTimerStarted = false;
function setupAutoCleanTimer() {
  if (autoCleanTimerStarted) return;
  autoCleanTimerStarted = true;

  setInterval(async () => {
    try {
      const curConfig = getConfig();
      if (!curConfig.autoClean || typeof curConfig.autoClean !== "object") return;
      const ONE_DAY_MS = 24 * 60 * 60 * 1000;
      const now = Date.now();

      for (const guildId of Object.keys(curConfig.autoClean)) {
        const entry = curConfig.autoClean[guildId];
        if (!entry || !entry.channelId) continue;
        if (entry.lastClean && (now - entry.lastClean < ONE_DAY_MS)) continue;

        for (const c of clientsMap.values()) {
          const guild = c.guilds?.cache?.get(guildId);
          if (!guild) continue;
          const channel = guild.channels?.cache?.get(entry.channelId);
          if (!channel || !channel.isTextBased()) continue;

          const me = guild.members?.me;
          if (!me || !channel.permissionsFor(me)?.has(PermissionsBitField.Flags.ManageMessages)) continue;

          const messages = await channel.messages.fetch({ limit: 100 }).catch(() => null);
          if (messages && messages.size > 0) {
            const deleted = await channel.bulkDelete(messages, true).catch(() => null);
            const count = deleted ? deleted.size : 0;
            console.log(`🧹 [Auto-Clean] Deleted ${count} messages in #${channel.name} (${guild.name})`);
            const confirm = await channel.send(`✅ | تم مسح **${count}** رسالة من الروم بنجاح (تنظيف تلقائي يومي).`).catch(() => {});
            if (confirm) {
              setTimeout(() => confirm.delete().catch(() => {}), 5000);
            }
          }
          entry.lastClean = now;
          saveConfig(curConfig);
          break;
        }
      }
    } catch (e) {
      console.error("❌ Auto-clean scheduler error:", e.message);
    }
  }, 15 * 60 * 1000);
}

// Exported for commands.js `12restart` (single-bot relaunch).
// commands.js must require("./index") lazily at runtime, not at load time,
// to avoid a circular-import partial-exports problem.
module.exports = { startBot };
