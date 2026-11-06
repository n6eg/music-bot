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
if (process.env.PORT) {
  const healthServer = http.createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Bot is alive and running!");
  });
  healthServer.listen(process.env.PORT, () => {
    console.log(`🌐 HTTP health-check listening on port ${process.env.PORT} (Render Web Service ready)`);
  });

  // Keep-alive self-ping: Prevents Render free tier from sleeping (spins down after 15m)
  const pingUrl = process.env.RENDER_EXTERNAL_URL || "https://music-rm9g.onrender.com";
  setInterval(() => {
    try {
      const clientReq = (pingUrl.startsWith("https") ? https : http).get(pingUrl, () => {});
      clientReq.on("error", () => {});
    } catch (e) { }
  }, 5 * 60 * 1000);
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
  console.error("❌ Unhandled rejection:", redact(err?.message || err));
});
process.on("uncaughtException", (err) => {
  // Log with stack for diagnosability. The process intentionally stays alive
  // so one bad event doesn't kill the whole multi-bot fleet.
  console.error("❌ Uncaught exception:", redact(err?.stack || err?.message || err));
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
    plugins.push(new YtDlpPlugin());
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
      const carrier = args.find((a) => a && typeof a === "object" && !Array.isArray(a));
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

  try {
    await client.login(token);
    // Key by bot user ID (not the raw token) and stash the token/index on the
    // client so `12restart` can relaunch exactly this bot later.
    client._token = token;
    client._index = index;
    clientsMap.set(client.user.id, client);
  } catch (err) {
    console.error(`❌ Failed to login Bot #${index + 1}: ${redact(err.message)}`);
  }
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
