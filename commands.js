const { EmbedBuilder, ButtonBuilder, ButtonStyle, PermissionsBitField, ChannelType, MessageFlags } = require("discord.js");
const { sendPanelMessage } = require("./panel");
const {
  getConfig,
  saveConfig,
  isOwner,
  normalizeConfig,
  getBotChannel247,
  setBotChannel247,
  clearBotChannel247
} = require("./config-store");
const { suppressReconnect } = require("./voice-guard");
const { aliasMap, safeSetNickname, setGuildAvatar, setGuildBanner, getChannelForBot, formatDuration, ytSearch, resolveQueryToUrl } = require("./helpers");
const { selfVoiceChannelId, buildRoomRange, collectSpreadStats, formatCensus, buildSpreadComponents, SPREAD_PROMPT_TEXT, executeSpread, formatSpreadResult } = require("./spread");
const { makeT, isBotCheckError } = require("./i18n");

function replyMessage(message, content, config) {
  if (config.embeds) {
    const embed = new EmbedBuilder()
      .setColor("#2b2d31")
      .setDescription(typeof content === "string" ? content : content.description || "");
    if (typeof content === "object") {
      if (content.title) embed.setTitle(content.title);
      if (content.fields) embed.addFields(content.fields);
    }
    return message.reply({ embeds: [embed] }).catch(() => { });
  } else {
    const textContent = typeof content === "string" ? content : `${content.title ? `**${content.title}**\n` : ""}${content.description || ""}`;
    return message.reply(textContent).catch(() => { });
  }
}

// Commands that operate on voice channels / music playback
const musicAndVoiceCommands = [
  "play", "autoplay", "stop", "skip", "volume", "nowplaying",
  "loop", "seek", "filters", "shuffle", "clear", "search",
  "pause", "resume", "queue", "come", "leave"
];

// selfVoiceChannelId & buildRoomRange now live in ./spread.js (shared with
// the panel) and are imported at the top of this file.

// Deterministic executor selection for music/voice commands.
// Priority: 1) explicitly mentioned bot  2) bot already sitting in the
// user's room  3) any free (unconnected) bot. Returns null when no
// candidate qualifies and the caller should fall back to the duty bot.
function selectExecutor(runningBots, guildId, targetedBotIds, userVoiceId) {
  if (Array.isArray(targetedBotIds) && targetedBotIds.length > 0) {
    return runningBots.find((c) => c.user.id === targetedBotIds[0]) || null;
  }
  if (userVoiceId) {
    const inRoom = runningBots.find((c) => selfVoiceChannelId(c, guildId) === userVoiceId);
    if (inRoom) return inRoom;
  }
  const freeBot = runningBots.find((c) => !selfVoiceChannelId(c, guildId));
  if (freeBot) return freeBot;
  return null;
}

/**
 * Resolve the target client for identity/setup owner commands
 * (setname/setavatar/setgame/setserver/setup).
 * NOTE: computed inside each case block - a previous version placed this
 * between case labels which threw ReferenceError (TDZ) at runtime.
 */
function pickIdentityTarget(targetedBotIds, runningBots, fallbackClient) {
  if (Array.isArray(targetedBotIds) && targetedBotIds.length > 0) {
    return runningBots.find((c) => c.user.id === targetedBotIds[0]) || fallbackClient;
  }
  return fallbackClient;
}

async function handleCommand(message, client, distube, clientsMap) {
  const config = getConfig();
  const prefix = config.prefix || "-";
  const t = makeT(config.lang);

  // Ignore bots / DMs
  if (message.author.bot || !message.guild || !message.guildId) return;

  // All bots of this process present in this guild
  // (clientsMap insertion order = login order => deterministic duty rotation)
  const runningBots = [];
  clientsMap.forEach((c) => {
    if (c.user && c.guilds.cache.has(message.guildId)) runningBots.push(c);
  });
  const dutyBot = runningBots[0] || client;

  // ======================================================================
  // MULTI-BOT ROUTING
  // Exactly ONE bot (the duty bot) parses every message, selects the
  // correct EXECUTOR, and delegates playback to that bot's own DisTube
  // instance. Result: one response, always from the bot that shares your
  // room.
  // ======================================================================
  if (client !== dutyBot) return;

  // Mentions of our running bots (@Bot come / -p song @Bot2)
  const mentionIdMatches = [...message.content.matchAll(/<@!?(\d+)>/g)].map((m) => m[1]);
  const targetedBotIds = mentionIdMatches.filter((id) =>
    runningBots.some((c) => c.user.id === id)
  );

  let contentText = message.content.trim();

  // Strip mentions of OUR running bots from the command text
  const ourIds = runningBots.map((c) => c.user.id);
  if (ourIds.length > 0) {
    const botMentionRegex = new RegExp(`<@!?(${ourIds.join("|")})>`, "g");
    contentText = contentText.replace(botMentionRegex, "").trim();
  }

  // Raw "@nickname" targeting fallback. When Discord does NOT resolve the
  // mention into <@id> (typical for bots nicknamed 1,2,3.. by spread), an
  // owner command like "setname @1 henery" must still target the bot whose
  // nickname/username in THIS guild is "1". Applies uniformly to every
  // command (setname/setavatar/setgame/setup/come/leave/music targeting).
  const rawTokenMatches = [...contentText.matchAll(/@([^\s<@]+)/g)];
  const matchedTokens = [];
  for (const m of rawTokenMatches) {
    const token = (m[1] || "").toLowerCase();
    if (!token) continue;
    for (const c of runningBots) {
      if (targetedBotIds.includes(c.user.id)) continue;
      let display = c.guilds?.cache?.get(message.guildId)?.members?.me?.nickname ?? null;
      if (display == null) {
        const g = c.guilds?.cache?.get(message.guildId);
        if (typeof g?.members?.fetch === "function") {
          const mm = await g.members.fetch(c.user.id).catch(() => null);
          display = mm?.nickname ?? null;
        }
      }
      if ((display && display.toLowerCase() === token) || (c.user?.username || "").toLowerCase() === token) {
        targetedBotIds.push(c.user.id);
        matchedTokens.push(m[0]);
        break;
      }
    }
  }
  if (matchedTokens.length > 0) {
    for (const tk of matchedTokens) contentText = contentText.replace(tk, " ");
    contentText = contentText.replace(/\s+/g, " ").trim();
  }

  // Prefix handling (-cmd, @Bot cmd, #mp)
  if (contentText.startsWith(prefix)) {
    contentText = contentText.slice(prefix.length).trim();
  }

  const parts = contentText.split(/\s+/);
  const firstWord = parts.shift()?.toLowerCase() || "";
  const rawCmd = aliasMap[firstWord];

  // Not a command -> stay completely silent.
  if (!rawCmd) return;

  // Text channel binding check (chat) - only applies to real command attempts now
  if (config.chatChannels && config.chatChannels[message.guildId]) {
    const allowedChannel = config.chatChannels[message.guildId];
    if (message.channelId !== allowedChannel && !isOwner(message.author.id, config)) {
      return message.reply(`❌ **الأوامر مسموحة فقط في الروم المحدد: <#${allowedChannel}>**`).catch(() => { });
    }
  }

  // ---------------------------------------------------------------------
  // OWNER-ONLY COMMANDS: come / leave (+ aliases c, تعال, مغادرة)
  // Joining a voice room & pinning 24/7 (-come) and leaving & unpinning
  // (-leave) are restricted to the bot's owners. Checked BEFORE the
  // voice-state requirements below so regular users always get the
  // correct "owners only" answer instead of a misleading voice error.
  // ---------------------------------------------------------------------
  if ((rawCmd === "come" || rawCmd === "leave") && !isOwner(message.author.id, config)) {
    return replyMessage(message, "❌ **هذا الأمر مخصص لمالكي البوت فقط!**", config);
  }

  // ---------------------------------------------------------------------
  // EXECUTOR SELECTION (music/voice commands)
  // ---------------------------------------------------------------------
  const isMusicCmd = musicAndVoiceCommands.includes(rawCmd);
  let executor = client;      // duty bot by default (non-music commands)
  let execDistube = distube;
  let userVoiceId = null;
  let userVoiceChannel = null;
  let freshMember = null;

  if (isMusicCmd) {
    // Cached view of the author's voice room
    userVoiceId = message.member?.voice?.channelId ?? null;

    if (targetedBotIds.length === 0) {
      // Refresh the author's member/voice state from the API so the decision
      // is based on CURRENT data. The API truth always wins over the possibly-
      // stale cache - including when it reports the user just LEFT voice
      // (fresh=null must clear a stale non-null cached room).
      try {
        freshMember = await message.guild.members.fetch(message.author.id);
        userVoiceId = freshMember?.voice?.channelId ?? null;
      } catch (e) { }
    }

    executor = selectExecutor(runningBots, message.guildId, targetedBotIds, userVoiceId) || client;
    execDistube = executor.distube || distube;
  }

  // Check Voice Channel Restrictions & Permissions for Music/Voice Commands
  // (evaluated against the EXECUTOR bot - not the parser)
  if (isMusicCmd) {
    const execGuild = executor.guilds.cache.get(message.guildId);
    const execMe = execGuild?.members?.me;

    // Prefer the executor client's own view of the user's voice channel so
    // permission math stays consistent inside one client; fall back to the
    // parser's view.
    userVoiceChannel =
      execGuild?.channels?.cache?.get(userVoiceId) ||
      message.member?.voice?.channel ||
      null;

    // 1. Must be in voice channel
    if (!userVoiceId || !userVoiceChannel) {
      return replyMessage(message, t("notInVoice"), config);
    }

    // 2. Must NOT be deafened (Deafened check) - prefer the fresh API view
    const memberForVoice = freshMember || message.member;
    if (memberForVoice?.voice?.deaf || memberForVoice?.voice?.selfDeaf) {
      return replyMessage(message, t("deafened"), config);
    }

    // 3. Permission checks (Connect & Speak) - against the EXECUTOR bot
    const permissions = userVoiceChannel.permissionsFor(execMe);
    if (!permissions || !permissions.has(PermissionsBitField.Flags.Connect)) {
      return replyMessage(message, t("noConnect", executor.user.username, userVoiceChannel.id), config);
    }
    if (!permissions.has(PermissionsBitField.Flags.Speak)) {
      return replyMessage(message, t("noSpeak", executor.user.username, userVoiceChannel.id), config);
    }

    // 4. Must be in same voice channel as the EXECUTOR bot if it is already connected.
    // NOTE: with correct selection this can only fire when NO bot shares your room
    // and all bots are pinned elsewhere - the error names the right room.
    const execVoiceId = execMe?.voice?.channelId;
    if (execVoiceId && execVoiceId !== userVoiceId && rawCmd !== "come") {
      return replyMessage(message, t("sameRoom", execVoiceId), config);
    }
  }

  const args = parts;

  // --- MP CONTROL PANEL COMMAND ---
  if (rawCmd === "mp") {
    if (!isOwner(message.author.id, config)) {
      return replyMessage(message, "❌ **هذا الأمر مخصص لمالكي البوت فقط!**", config);
    }
    return sendPanelMessage(message);
  }

  // --- USER MUSIC COMMANDS ---
  switch (rawCmd) {
    case "play": {
      const originalQuery = args.join(" ");
      if (!originalQuery) return replyMessage(message, "❌ **يرجى كتابة اسم الأغنية أو رابط الأغنية/قائمة التشغيل!**", config);

      let searchMsg = null;
      try {
        searchMsg = await replyMessage(message, t("searchingPlay", originalQuery), config);
      } catch (e) { }

      let playQuery = originalQuery;
      try {
        // Platform wiring: plain-text names on the "youtube" platform are
        // resolved to YouTube's top result via yt-dlp (the same binary the
        // YtDlpPlugin manages). SoundCloud names resolve natively through the
        // SoundCloud extractor; spotify affects direct links only (Spotify
        // offers no open name-search API). URL input bypasses this entirely.
        const isUrl = /^https?:\/\//i.test(originalQuery);
        if (!isUrl && (config.platform || "youtube") === "youtube") {
          // Fast resolve with caching & flatPlaylist
          const resolved = await resolveQueryToUrl(originalQuery, executor._soundcloudPlugin);
          if (resolved?.url) playQuery = resolved.url;
        }

        // Resolve the text channel via the EXECUTOR client so playback
        // announcements are sent by the bot that actually plays the song.
        const execTextChannel =
          executor.channels?.cache?.get(message.channelId) || message.channel;
        console.log(
          `[play] cmd="${originalQuery}" -> "${playQuery}" | executor=${executor.user?.tag}` +
          ` | guild=${message.guildId} | voice=${userVoiceChannel?.id}` +
          ` | botsInGuild=${runningBots.length}`
        );
        await execDistube.play(userVoiceChannel, playQuery, {
          message,
          textChannel: execTextChannel,
          member: message.member
        });
        console.log(`[play] distube.play resolved for "${originalQuery}"`);

        // Automatically clean up search and command messages so chat stays clean
        if (searchMsg && typeof searchMsg.delete === "function") {
          searchMsg.delete().catch(() => {});
        }
        message.delete().catch(() => {});
      } catch (err) {
        // If YouTube fails with bot-check, automatically fallback to SoundCloud so playback never stops!
        if (isBotCheckError(err?.message) && executor._soundcloudPlugin && !/soundcloud\.com/i.test(playQuery)) {
          try {
            console.log(`[bot-check fallback] YouTube blocked. Trying SoundCloud for: ${originalQuery}`);
            const scTracks = await executor._soundcloudPlugin.search(originalQuery, "track", 1);
            console.log(`[bot-check fallback] SoundCloud results: ${Array.isArray(scTracks) ? scTracks.length : 0}`);
            if (Array.isArray(scTracks) && scTracks[0]?.url) {
              console.log(`[bot-check fallback] playing SoundCloud URL: ${scTracks[0].url}`);
              const execTextChannel =
                executor.channels?.cache?.get(message.channelId) || message.channel;
              await execDistube.play(userVoiceChannel, scTracks[0].url, {
                message,
                textChannel: execTextChannel,
                member: message.member
              });
              console.log("[bot-check fallback] distube.play(SoundCloud) resolved");
              if (searchMsg && typeof searchMsg.delete === "function") {
                searchMsg.delete().catch(() => {});
              }
              message.delete().catch(() => {});
              replyMessage(message, "🔊 *(تم تشغيل الأغنية عبر ساوندكلاود لتجاوز حجب يوتيوب)*", config);
              break;
            }
          } catch (scErr) {
            console.error("[bot-check fallback] SoundCloud search failed:", scErr.message);
          }
        }

        if (searchMsg && typeof searchMsg.delete === "function") {
          searchMsg.delete().catch(() => {});
        }
        // YouTube bot-check failures get clear setup instructions instead of
        // the raw yt-dlp error text.
        const shown = isBotCheckError(err?.message) ? t("botCheckFix") : err.message;
        // NEW: if a plain-text query already fell back to SoundCloud, say so.
        const srcNote =
          playQuery !== originalQuery && /soundcloud\.com\//i.test(playQuery)
            ? "\n🔊 *(تم التشغيل عبر ساوندكلاود بدلاً من يوتيوب)*"
            : "";
        replyMessage(message, t("playFailed", shown) + srcNote, config);
      }
      break;
    }

    case "autoplay": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      const mode = execDistube.toggleAutoplay(message);
      replyMessage(message, mode ? t("autoplayOn") : t("autoplayOff"), config);
      break;
    }

    case "stop": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      await execDistube.stop(message);
      replyMessage(message, t("stopped"), config);
      break;
    }

    case "skip": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      try {
        await execDistube.skip(message);
        replyMessage(message, t("skipped"), config);
      } catch (e) {
        replyMessage(message, t("skipFailed"), config);
      }
      break;
    }

    case "volume": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      const volume = parseInt(args[0]);
      if (isNaN(volume) || volume < 0 || volume > 200) {
        return replyMessage(message, t("volumeCurrent", queue.volume), config);
      }
      execDistube.setVolume(message, volume);
      replyMessage(message, t("volumeSet", volume), config);
      break;
    }

    case "nowplaying": {
      const queue = execDistube.getQueue(message);
      if (!queue || !queue.songs[0]) return replyMessage(message, t("nothingPlaying"), config);
      const song = queue.songs[0];
      const statusStr = `🎵 **يتم تشغيله الآن:** [${song.name}](${song.url})\n⏱️ **المدة:** \`${queue.formattedCurrentTime} / ${song.formattedDuration}\`\n👤 **بواسطة:** ${song.user}`;
      replyMessage(message, statusStr, config);
      break;
    }

    case "loop": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      const arg = String(args[0] || "").toLowerCase();
      let mode;
      if (arg === "song" || arg === "اغنية") mode = 1;
      else if (arg === "queue" || arg === "قائمة") mode = 2;
      else if (arg === "off" || arg === "اطفاء" || arg === "إيقاف") mode = 0;
      else mode = queue.repeatMode === 0 ? 1 : queue.repeatMode === 1 ? 2 : 0;

      mode = execDistube.setRepeatMode(message, mode);
      const modeText =
        mode === 2 ? t("loopQueue") :
          mode === 1 ? t("loopSong") :
            t("loopOff");
      replyMessage(message, t("loopSet", modeText), config);
      break;
    }

    case "seek": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      const time = parseInt(args[0]);
      if (isNaN(time)) return replyMessage(message, t("seekUsage"), config);
      if (time < 0) return replyMessage(message, t("seekInvalid"), config);
      execDistube.seek(message, time);
      replyMessage(message, t("seekDone", time), config);
      break;
    }

    case "filters": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      const filter = args[0]?.toLowerCase();
      if (!filter) {
        return replyMessage(message, t("filtersList", queue.filters.names.join(", ")), config);
      }
      if (filter === "off") {
        queue.filters.clear();
        return replyMessage(message, t("filterCleared"), config);
      }
      if (queue.filters.names.includes(filter)) {
        queue.filters.remove(filter);
        replyMessage(message, t("filterRemoved", filter), config);
      } else {
        try {
          queue.filters.add(filter);
          replyMessage(message, t("filterSet", filter), config);
        } catch (e) {
          replyMessage(message, t("filterUnknown", filter), config);
        }
      }
      break;
    }

    case "shuffle": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      await execDistube.shuffle(message);
      replyMessage(message, t("shuffled"), config);
      break;
    }

    case "clear": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      queue.songs.splice(1);
      replyMessage(message, t("cleared"), config);
      break;
    }

    case "search": {
      // DisTube v5 removed DisTube#search entirely - the previous call here
      // threw "execDistube.search is not a function" on EVERY invocation.
      // New implementation: real YouTube results via the yt-dlp binary,
      // falling back to the SoundCloud extractor when yt-dlp is unavailable.
      const query = args.join(" ");
      if (!query) return replyMessage(message, "❌ **يرجى كتابة كلمة البحث!**", config);
      replyMessage(message, `🔎 **جاري البحث عن:** \`${query}\` ...`, config);

      let rows = null;
      let engine = null;

      try {
        const ytResults = await ytSearch(query, 5);
        if (ytResults.length > 0) {
          rows = ytResults.map(
            (r, i) => `**${i + 1}.** [${r.name}](${r.url}) \`${formatDuration(r.duration)}\``
          );
          engine = "YouTube";
        }
      } catch (e) { }

      if (!rows) {
        const scPlugin = client._soundcloudPlugin;
        if (scPlugin) {
          try {
            const songs = await scPlugin.search(query, "track", 5);
            if (Array.isArray(songs) && songs.length > 0) {
              rows = songs.map(
                (s, i) => `**${i + 1}.** [${s.name}](${s.url}) \`${s.formattedDuration}\``
              );
              engine = "SoundCloud";
            }
          } catch (e) { }
        }
      }

      if (!rows || rows.length === 0) {
        return replyMessage(message, "❌ لم يتم العثور على نتائج.", config);
      }
      return replyMessage(
        message,
        { title: `🔎 نتائج البحث من ${engine} (شغّل أي نتيجة بـ play):`, description: rows.join("\n") },
        config
      );
    }

    case "pause": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      if (queue.paused) return replyMessage(message, t("pauseAlready"), config);
      execDistube.pause(message);
      replyMessage(message, t("paused"), config);
      break;
    }

    case "resume": {
      const queue = execDistube.getQueue(message);
      if (!queue) return replyMessage(message, t("nothingPlaying"), config);
      if (!queue.paused) return replyMessage(message, t("resumeAlready"), config);
      execDistube.resume(message);
      replyMessage(message, t("resumed"), config);
      break;
    }

    case "queue": {
      const queue = execDistube.getQueue(message);
      if (!queue || queue.songs.length === 0) return replyMessage(message, t("queueEmpty"), config);
      const qList = queue.songs.slice(0, 10).map((song, i) => `**${i === 0 ? "الان:" : `${i}.`}** [${song.name}](${song.url}) - \`${song.formattedDuration}\``).join("\n");
      replyMessage(message, { title: `📜 قائمة التشغيل (${queue.songs.length} أغنية):`, description: qList }, config);
      break;
    }

    case "come": {
      const voiceChannel = userVoiceChannel || message.member?.voice?.channel;
      if (!voiceChannel) return replyMessage(message, t("notInVoice"), config);

      // Anti-hijack: the EXECUTOR bot (mentioned or selected) cannot be
      // yanked out of a room it is pinned in (owners excepted).
      const currentVoice = selfVoiceChannelId(executor, message.guildId);
      if (currentVoice && currentVoice !== voiceChannel.id && !isOwner(message.author.id, config)) {
        return replyMessage(message, `❌ **البوت \`${executor.user.username}\` مثبت حالياً في روم أخرى:** <#${currentVoice}>`, config);
      }

      // Truthful outcome: report failure instead of claiming success when the
      // join itself throws. The executor may differ from the parser - join
      // through the EXECUTOR's own channel view (DisTube client check).
      try {
        const execRoom = (await getChannelForBot(executor, message.guildId, voiceChannel.id)) || voiceChannel;
        await execDistube.voices.join(execRoom);
      } catch (err) {
        return replyMessage(message, t("comeFailed", err?.message || "unknown"), config);
      }

      // Pin ONLY this bot to this room (per-bot 24/7) - other bots keep theirs
      setBotChannel247(config, message.guildId, executor.user.id, voiceChannel.id);
      saveConfig(config);
      replyMessage(message, t("comePinned", executor.user.username, voiceChannel.id), config);
      break;
    }

    case "leave": {
      // Only the EXECUTOR bot leaves - other bots in other rooms are untouched.
      // Suppress the voice guard so the intentional leave is not undone.
      const wasConnected = Boolean(selfVoiceChannelId(executor, message.guildId));
      suppressReconnect(executor, 15000);
      try {
        execDistube.voices.leave(message.guildId);
      } catch (err) { }
      clearBotChannel247(config, message.guildId, executor.user.id);
      saveConfig(config);
      if (wasConnected) {
        replyMessage(message, t("leaveDone", executor.user.username), config);
      } else {
        replyMessage(message, t("leaveNotConnected", executor.user.username), config);
      }
      break;
    }

    case "prefix": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر مخصص لمالكي البوت فقط!**", config);
      const newPrefix = args[0];
      if (!newPrefix) return replyMessage(message, `❌ **الاستخدام:** \`prefix <البادئة الجديدة>\``, config);
      config.prefix = newPrefix;
      saveConfig(config);
      replyMessage(message, `✅ **تم تغيير بادئة الأوامر إلى:** \`${newPrefix}\``, config);
      break;
    }

    case "clean": {
      // Permission check: ManageMessages permission OR bot owner
      const memberHasPerm =
        message.member?.permissions?.has(PermissionsBitField.Flags.ManageMessages) ||
        isOwner(message.author.id, config);
      if (!memberHasPerm) {
        return replyMessage(message, "❌ **هذا الأمر يتطلب صلاحية إدارة الرسائل (Manage Messages) أو أن تكون مالكاً للبوت!**", config);
      }

      // Check bot permission
      const botMember = message.guild?.members?.me;
      if (!botMember || !message.channel.permissionsFor(botMember)?.has(PermissionsBitField.Flags.ManageMessages)) {
        return replyMessage(message, "❌ **البوت لا يملك صلاحية إدارة الرسائل (Manage Messages) في هذا الروم!**", config);
      }

      // Delete the command trigger message
      await message.delete().catch(() => {});

      let totalDeleted = 0;
      const firstArg = args[0] ? args[0].toLowerCase() : "";

      if (firstArg && /^\d+$/.test(firstArg)) {
        // Numeric count requested (e.g. -clean 50)
        const amount = Math.min(100, Math.max(1, parseInt(firstArg, 10)));
        try {
          const deleted = await message.channel.bulkDelete(amount, true);
          totalDeleted = deleted ? deleted.size : 0;
        } catch (e) {
          console.error("Clean error:", e.message);
        }
      } else {
        // "m", "all", or default (e.g. CLEAN M, -clean m, -clean)
        try {
          const fetched = await message.channel.messages.fetch({ limit: 100 }).catch(() => null);
          if (fetched && fetched.size > 0) {
            const deleted = await message.channel.bulkDelete(fetched, true).catch(() => null);
            totalDeleted = deleted ? deleted.size : 0;
          }
        } catch (e) {
          console.error("Clean error:", e.message);
        }
      }

      const confirmMsg = await message.channel.send(`✅ | تم مسح **${totalDeleted}** رسالة من الروم بنجاح.`).catch(() => {});
      if (confirmMsg) {
        setTimeout(() => {
          confirmMsg.delete().catch(() => {});
        }, 5000);
      }
      break;
    }

    case "chat": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر مخصص لمالكي البوت فقط!**", config);
      const targetChannel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
      if (args[0] === "off") {
        delete config.chatChannels[message.guildId];
        saveConfig(config);
        return replyMessage(message, "✅ **تم إلغاء تحديد روم الأوامر الخاص.**", config);
      }
      if (!targetChannel) return replyMessage(message, `❌ **الاستخدام:** \`chat <#الروم | off>\``, config);
      // Only TEXT channels can receive messages - binding anything else would
      // permanently lock every non-owner out of the commands.
      if (targetChannel.type !== ChannelType.GuildText) {
        return replyMessage(message, "❌ **يجب اختيار روم نصي (Text) لتحديد أوامر البوت!**", config);
      }
      config.chatChannels[message.guildId] = targetChannel.id;
      saveConfig(config);
      replyMessage(message, `✅ **تم تحديد روم الأوامر ليصبح:** <#${targetChannel.id}>`, config);
      break;
    }

    case "setting": {
      // Show each bot's pinned 24/7 room (per-bot map)
      const pins = runningBots
        .map((c) => {
          const chId = getBotChannel247(config, message.guildId, c.user.id);
          return `   • \`${c.user.username}\`: ${chId ? `<#${chId}>` : "غير مثبت"}`;
        })
        .join("\n");
      const info = `⚙️ **إعدادات البوت الحالية:**\n` +
        `• **الاداة (Prefix):** \`${config.prefix}\`\n` +
        `• **منصة البحث بالاسم (Platform):** \`${config.platform || "youtube"}\`\n` +
        `• **نظام الإمبيد (Embeds):** \`${config.embeds ? "مفعل" : "معطل"}\`\n` +
        `• **اللغة (Language):** \`${config.lang || "ar"}\`\n` +
        `• **سيرفر الدعم:** ${config.serverInvite || "غير محدد"}\n` +
        `• **روم الأوامر:** ${config.chatChannels[message.guildId] ? `<#${config.chatChannels[message.guildId]}>` : "الكل"}\n` +
        `• **رومات 24/7:**\n${pins || "   غير محدد"}`;
      replyMessage(message, info, config);
      break;
    }

    case "ping": {
      const ping = Math.round(client.ws.ping);
      replyMessage(message, t("ping", ping), config);
      break;
    }

    // --- OWNERS COMMANDS ---
    // Identity/setup commands act on the DUTY bot by default, but owners can
    // target another running bot via mention (resolved <@id> or raw
    // @nickname/@username as shown in the server):
    //   -setname @1 NewName   -setavatar @1 <url>   -setup @1 #room
    // targetedBotIds (built above) is what routes all of these commands.

    case "setname": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const name = args.join(" ");
      if (!name) return replyMessage(message, "❌ **يرجى كتابة الاسم الجديد.**", config);
      // Nickname INSIDE this server only - never the global username. The
      // name shows in the server (and voice room) without touching the bot
      // account's real username.
      const result = await safeSetNickname(identityTarget, message.guildId, name);
      if (result.ok) {
        replyMessage(message, `✅ **تم تغيير اسم البوت \`${identityTarget.user.username}\` داخل السيرفر إلى:** \`${result.applied}\``, config);
      } else {
        replyMessage(message, `❌ **خطأ في تغيير اسم البوت \`${identityTarget.user.username}\`:** ${result.error?.message || "unknown"}`, config);
      }
      break;
    }

    case "setavatar": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const url = args[0] || message.attachments.first()?.url;
      if (!url) return replyMessage(message, "❌ **يرجى وضع رابط الصورة أو إرفاقها.**", config);
      identityTarget.user.setAvatar(url).then(() => {
        replyMessage(message, `✅ **تم تغيير صورة البوت \`${identityTarget.user.username}\` بنجاح!**`, config);
      }).catch(err => replyMessage(message, `❌ **خطأ في تغيير صورة البوت \`${identityTarget.user.username}\`:** ${err.message}`, config));
      break;
    }

    case "setserveravatar": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const firstArg = String(args[0] || "").toLowerCase();
      const isReset = firstArg === "reset" || firstArg === "حذف" || firstArg === "افتراضي";
      const url = isReset ? null : (args[0] || message.attachments.first()?.url);
      if (!url && !isReset) {
        return replyMessage(message, "❌ **يرجى إرفاق صورة أو وضع رابط الصورة المباشر (أو كتابة `حذف` للرجوع للصورة الافتراضية).**\n💡 مثال: `-setserveravatar https://...` أو إرفاق صورة مع الأمر.", config);
      }

      setGuildAvatar(identityTarget, message.guildId, url).then(() => {
        if (isReset) {
          replyMessage(message, `🔄 **تمت إعادة ضبط صورة البوت \`${identityTarget.user.username}\` في هذا السيرفر إلى الصورة الافتراضية.**`, config);
        } else {
          replyMessage(message, `✨ **تم تغيير صورة البوت \`${identityTarget.user.username}\` الخاصة بهذا السيرفر بنجاح! (Custom Bot Branding)**`, config);
        }
      }).catch(err => {
        replyMessage(message, `❌ **خطأ في تغيير صورة البوت في هذا السيرفر:** ${err.message}`, config);
      });
      break;
    }

    case "resetserveravatar": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      setGuildAvatar(identityTarget, message.guildId, null).then(() => {
        replyMessage(message, `🔄 **تمت إعادة ضبط صورة البوت \`${identityTarget.user.username}\` في هذا السيرفر إلى الصورة الافتراضية.**`, config);
      }).catch(err => {
        replyMessage(message, `❌ **خطأ في إعادة ضبط الصورة:** ${err.message}`, config);
      });
      break;
    }

    case "setbanner": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const url = args[0] || message.attachments.first()?.url;
      if (!url) return replyMessage(message, "❌ **يرجى وضع رابط البنر أو إرفاقه مع الرسالة.**", config);
      if (!identityTarget.user.setBanner) return replyMessage(message, "❌ **هذا البوت لا يدعم تعيين البنر العام مباشرة.**", config);
      identityTarget.user.setBanner(url).then(() => {
        replyMessage(message, `✅ **تم تغيير البنر العام للبوت \`${identityTarget.user.username}\` بنجاح!**`, config);
      }).catch(err => replyMessage(message, `❌ **خطأ في تغيير البنر للبوت \`${identityTarget.user.username}\`:** ${err.message}`, config));
      break;
    }

    case "setserverbanner": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const firstArg = String(args[0] || "").toLowerCase();
      const isReset = firstArg === "reset" || firstArg === "حذف" || firstArg === "افتراضي";
      const url = isReset ? null : (args[0] || message.attachments.first()?.url);
      if (!url && !isReset) {
        return replyMessage(message, "❌ **يرجى إرفاق صورة أو وضع رابط البنر المباشر (أو كتابة `حذف` للرجوع للبنر الافتراضي).**\n💡 مثال: `-setserverbanner https://...` أو إرفاق صورة مع الأمر.", config);
      }

      setGuildBanner(identityTarget, message.guildId, url).then(() => {
        if (isReset) {
          replyMessage(message, `🔄 **تمت إعادة ضبط بنر البوت \`${identityTarget.user.username}\` في هذا السيرفر إلى البنر الافتراضي.**`, config);
        } else {
          replyMessage(message, `✨ **تم تغيير بنر البوت \`${identityTarget.user.username}\` الخاص بهذا السيرفر بنجاح! (Custom Bot Branding)**`, config);
        }
      }).catch(err => {
        replyMessage(message, `❌ **خطأ في تغيير بنر البوت في هذا السيرفر:** ${err.message}`, config);
      });
      break;
    }

    case "resetserverbanner": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      setGuildBanner(identityTarget, message.guildId, null).then(() => {
        replyMessage(message, `🔄 **تمت إعادة ضبط بنر البوت \`${identityTarget.user.username}\` في هذا السيرفر إلى البنر الافتراضي.**`, config);
      }).catch(err => {
        replyMessage(message, `❌ **خطأ في إعادة ضبط البنر:** ${err.message}`, config);
      });
      break;
    }

    case "setgame": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const gameText = args.join(" ");
      identityTarget.user.setActivity(gameText || "@ws.");
      replyMessage(message, `🎮 **تم تغيير حالة اللعب للبوت \`${identityTarget.user.username}\` إلى:** \`${gameText || "@ws."}\``, config);
      break;
    }

    case "setserver": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      // With no argument: show the stored support-server link.
      // With an argument: store it (the #mp panel modal writes the same field).
      const link = args.join(" ").trim();
      if (link) {
        config.serverInvite = link.slice(0, 300);
        saveConfig(config);
        return replyMessage(message, `🚪 **تم حفظ رابط سيرفر الدعم:** ${config.serverInvite}`, config);
      }
      replyMessage(
        message,
        config.serverInvite
          ? `🚪 **سيرفر الدعم المحفوظ:** ${config.serverInvite}`
          : `🚪 **لم يتم حفظ رابط سيرفر دعم بعد. الاستخدام:** \`setserver <رابط الدعوة>\``,
        config
      );
      break;
    }

    case "setup": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const identityTarget = pickIdentityTarget(targetedBotIds, runningBots, client);
      const channel = message.mentions.channels.first() || message.guild.channels.cache.get(args[0]);
      if (!channel) return replyMessage(message, "❌ **يرجى منشن الروم الصوتي أولاً.**", config);

      // Rename (truthful): apply the room name as the bot's NICKNAME inside
      // this server only - never the global username.
      const rename = await safeSetNickname(identityTarget, message.guildId, channel.name);

      // Join (truthful): don't claim success if the join throws. The target
      // bot may differ from the parser - join through ITS OWN channel view.
      let joined = true;
      try {
        const chForTarget = (await getChannelForBot(identityTarget, message.guildId, channel.id)) || channel;
        await (identityTarget.distube || distube).voices.join(chForTarget);
      } catch (err) {
        joined = false;
      }

      if (joined) {
        // Pin ONLY the target bot (per-bot 24/7)
        setBotChannel247(config, message.guildId, identityTarget.user.id, channel.id);
        saveConfig(config);
      }

      const parts2 = [
        joined
          ? `✅ **تم تثبيت البوت \`${identityTarget.user.username}\` في الروم:** <#${channel.id}>`
          : `❌ **فشل انضمام البوت \`${identityTarget.user.username}\` إلى الروم <#${channel.id}>**`
      ];
      if (rename.ok) {
        parts2.push(`📝 تم تغيير اسم البوت داخل السيرفر إلى \`${rename.applied}\``);
      } else {
        parts2.push(`⚠️ تعذر تغيير الاسم: ${rename.error?.message || "unknown"}`);
      }
      replyMessage(message, parts2.join("\n"), config);
      break;
    }

    case "lang": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const lang = args[0]?.toLowerCase();
      if (!["ar", "en"].includes(lang)) return replyMessage(message, "❌ **الخيارات المتاحة:** `ar` / `en`", config);
      config.lang = lang;
      saveConfig(config);
      replyMessage(message, lang === "ar"
        ? "🌐 **تم تغيير لغة البوت إلى:** `ar` (ردود أوامر الموسيقى ستظهر بالعربية)"
        : "🌐 **Language switched to:** `en` (music command replies will be in English)", config);
      break;
    }

    case "platform": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const platform = args[0]?.toLowerCase();
      if (!["youtube", "spotify", "soundcloud"].includes(platform)) {
        return replyMessage(message, "❌ **الخيارات المتاحة:** `youtube`, `spotify`, `soundcloud`", config);
      }
      config.platform = platform;
      saveConfig(config);
      const effect = platform === "youtube"
        ? "البحث بالأسماء سيتم عبر يوتيوب (yt-dlp)"
        : platform === "soundcloud"
          ? "البحث بالأسماء سيتم عبر ساوندكلاود"
          : "روابط سبوتيفاي تعمل مباشرة؛ البحث بالأسماء سيستخدم المحرك الافتراضي";
      replyMessage(message, `🔍 **تم تغيير منصة البحث الافتراضية إلى:** \`${platform}\`\n(${effect})`, config);
      break;
    }

    case "embed": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      config.embeds = !config.embeds;
      saveConfig(config);
      replyMessage(message, `🔲 **تم ${config.embeds ? "تفعيل" : "تعطيل"} نظام الإمبيد (Embed).**`, config);
      break;
    }

    case "addowner": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const mentionedIds = Array.from(message.mentions.users.keys());
      const rawText = args.join(" ");
      const argIds = rawText.match(/\d{17,20}/g) || [];
      const allTargetIds = Array.from(new Set([...mentionedIds, ...argIds]));

      if (allTargetIds.length === 0) {
        return replyMessage(message, "❌ **يرجى منشن المستخدمين أو كتابة ID الأشخاص (يمكنك كتابة حتى 3 أونرات معاً).**", config);
      }

      const added = [];
      for (const id of allTargetIds) {
        if (!config.owners.includes(id)) {
          config.owners.push(id);
          added.push(`<@${id}>`);
        }
      }
      saveConfig(config);
      if (added.length > 0) {
        replyMessage(message, `🔑 **تم إضافة الأونرات بنجاح (${added.length}):** ${added.join(" ، ")}\n*(إجمالي الأونرات: ${config.owners.length})*`, config);
      } else {
        replyMessage(message, "ℹ️ **جميع هؤلاء الأشخاص مضافون كأونرات بالفعل!**", config);
      }
      break;
    }

    case "removeowner": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const mentionedIds = Array.from(message.mentions.users.keys());
      const rawText = args.join(" ");
      const argIds = rawText.match(/\d{17,20}/g) || [];
      const allTargetIds = Array.from(new Set([...mentionedIds, ...argIds]));

      if (allTargetIds.length === 0) {
        return replyMessage(message, "❌ **يرجى منشن المستخدمين أو كتابة ID الأشخاص المراد إزالتهم.**", config);
      }

      const removed = [];
      for (const id of allTargetIds) {
        if (config.owners.length <= 1) {
          replyMessage(message, "⚠️ **توقف: يجب أن يبقى مالك واحد على الأقل في البوت!**", config);
          break;
        }
        if (config.owners.includes(id)) {
          config.owners = config.owners.filter((oid) => oid !== id);
          removed.push(`<@${id}>`);
        }
      }
      saveConfig(config);
      if (removed.length > 0) {
        replyMessage(message, `🔑 **تم إزالة الأونر بنجاح (${removed.length}):** ${removed.join(" ، ")}`, config);
      } else {
        replyMessage(message, "❌ **لم يتم العثور على أي من الأشخاص المحددين في قائمة الأونرات!**", config);
      }
      break;
    }

    case "owners": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const list = config.owners.map((id, idx) => `**${idx + 1}.** <@${id}> (\`${id}\`)`).join("\n") || "لا يوجد مالكون مسجلون.";
      replyMessage(message, { title: `📋 قائمة أونرات البوتات (${config.owners.length}):`, description: list }, config);
      break;
    }

    case "restart": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      // Restart ONLY this parser/duty bot: destroy its client and relaunch it
      // with the same token - the rest of the fleet keeps running.
      const token = client._token;
      const idx = typeof client._index === "number" ? client._index : 0;
      await replyMessage(message, `🔄 **جاري إعادة تشغيل البوت \`${client.user.username}\`...**`, config);

      let mapKey = null;
      clientsMap.forEach((c, k) => {
        if (c === client) mapKey = k;
      });
      if (mapKey !== null) clientsMap.delete(mapKey);
      try { await client.destroy(); } catch (e) { }

      if (token) {
        // Lazy require avoids a circular-import problem at module load time.
        const { startBot } = require("./index");
        startBot(token, idx);
      } else {
        // No stored token (legacy session) - fall back to a full process
        // restart so behaviour stays predictable.
        console.warn("[restart] No stored token on client; exiting process instead.");
        process.exit(0);
      }
      break;
    }

    case "restartall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      // All bots live in ONE process - this exits everything. A supervisor
      // (pm2 / nodemon / systemd) is required to bring them back up.
      await replyMessage(
        message,
        `🔄 **جاري إيقاف العملية بالكامل (${clientsMap.size} بوت)...**\n⚠️ يجب تشغيل البوت تحت مشرف عمليات (pm2 مثلاً) حتى يعود تلقائياً.`,
        config
      );
      process.exit(0);
      break;
    }

    case "avatarall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const url = args[0] || message.attachments.first()?.url;
      if (!url) return replyMessage(message, "❌ **يرجى كتابة رابط الصورة المباشر.**", config);
      clientsMap.forEach(c => {
        if (c.user) c.user.setAvatar(url).catch(() => { });
      });
      replyMessage(message, "🖼️ **تم طلب تغيير صورة/افتار جميع البوتات بنجاح.**", config);
      break;
    }

    case "serveravatarall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const firstArg = String(args[0] || "").toLowerCase();
      const isReset = firstArg === "reset" || firstArg === "حذف" || firstArg === "افتراضي";
      const url = isReset ? null : (args[0] || message.attachments.first()?.url);
      if (!url && !isReset) {
        return replyMessage(message, "❌ **يرجى إرفاق صورة أو كتابة رابط الصورة المباشر (أو كتابة `حذف` للرجوع للأصل).**", config);
      }

      let okCount = 0;
      let errCount = 0;
      for (const c of clientsMap.values()) {
        if (!c.user) continue;
        if (!c.guilds?.cache?.has(message.guildId)) continue;
        try {
          await setGuildAvatar(c, message.guildId, url);
          okCount++;
        } catch (e) {
          errCount++;
        }
      }
      const outcome = isReset
        ? `🔄 **تمت إعادة ضبط صورة ${okCount} بوت في هذا السيرفر للصورة الافتراضية.**`
        : `✨ **تم تغيير صورة ${okCount} بوت في هذا السيرفر بنجاح! (Custom Bot Branding)**`;
      replyMessage(message, outcome, config);
      break;
    }

    case "bannerall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const url = args[0] || message.attachments.first()?.url;
      if (!url) return replyMessage(message, "❌ **يرجى كتابة رابط البنر المباشر أو إرفاقه.**", config);
      clientsMap.forEach(c => {
        if (c.user?.setBanner) c.user.setBanner(url).catch(() => { });
      });
      replyMessage(message, "🎨 **تم طلب تغيير بنر جميع البوتات بنجاح.**", config);
      break;
    }

    case "serverbannerall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const firstArg = String(args[0] || "").toLowerCase();
      const isReset = firstArg === "reset" || firstArg === "حذف" || firstArg === "افتراضي";
      const url = isReset ? null : (args[0] || message.attachments.first()?.url);
      if (!url && !isReset) {
        return replyMessage(message, "❌ **يرجى إرفاق صورة أو كتابة رابط البنر المباشر (أو كتابة `حذف` للرجوع للأصل).**", config);
      }

      let okCount = 0;
      let errCount = 0;
      for (const c of clientsMap.values()) {
        if (!c.user) continue;
        if (!c.guilds?.cache?.has(message.guildId)) continue;
        try {
          await setGuildBanner(c, message.guildId, url);
          okCount++;
        } catch (e) {
          errCount++;
        }
      }
      const outcome = isReset
        ? `🔄 **تمت إعادة ضبط بنر ${okCount} بوت في هذا السيرفر للبنر الافتراضي.**`
        : `✨ **تم تغيير بنر ${okCount} بوت في هذا السيرفر بنجاح! (Custom Bot Branding)**`;
      replyMessage(message, outcome, config);
      break;
    }

    case "comeall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);
      const voiceChannel = message.member?.voice?.channel;
      if (!voiceChannel) return replyMessage(message, t("notInVoice"), config);

      let count = 0;
      for (const c of runningBots) {
        try {
          const dInstance = c.distube;
          if (dInstance) {
            // Each bot joins ITS OWN view of the room - DisTube rejects
            // channel objects owned by another client.
            const chForBot = await getChannelForBot(c, message.guildId, voiceChannel.id);
            if (!chForBot) continue;
            await dInstance.voices.join(chForBot);
            // Pin every bot to this room (per-bot 24/7)
            setBotChannel247(config, message.guildId, c.user.id, voiceChannel.id);
            count++;
          }
        } catch (e) { }
      }
      saveConfig(config);
      replyMessage(message, `✅ **تم إدخال ${count} بوت إلى الروم الصوتي: <#${voiceChannel.id}>**`, config);
      break;
    }

    case "leaveall": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);

      // No voice-channel requirement - an owner can clear every bot from any
      // room without joining one. Scope = bots present in THIS guild.
      let leftCount = 0;
      for (const c of runningBots) {
        const wasConnected = Boolean(selfVoiceChannelId(c, message.guildId));
        // Suppress the voice guard so the intentional leaves are not undone.
        if (wasConnected) suppressReconnect(c, 15000);
        try {
          const dInstance = c.distube;
          if (dInstance && wasConnected) dInstance.voices.leave(message.guildId);
        } catch (e) { }
        // Clear EVERY bot's 24/7 pin regardless of connection state so a
        // stale pin can never resurrect a connection after a restart.
        clearBotChannel247(config, message.guildId, c.user.id);
        if (wasConnected) leftCount++;
      }
      saveConfig(config);
      replyMessage(
        message,
        `👋 **تم إخراج ${leftCount} بوت من الرومات الصوتية وإلغاء تثبيت 24/7 لجميع البوتات (${runningBots.length}).**`,
        config
      );
      break;
    }

    // -------------------------------------------------------------------
    // SPREAD (owner): fill a RANGE of voice rooms with free bots.
    // Flow: census -> owner picks TOP & BOTTOM voice rooms via channel
    // select menus -> every room between them (inclusive) receives ONE
    // free bot, renamed to match its room, pinned per-bot 24/7.
    // Gate: free bots (sitting in NO voice room of this guild) must cover
    // the full room count or the whole operation aborts with an error.
    // -------------------------------------------------------------------
    case "spread": {
      if (!isOwner(message.author.id, config)) return replyMessage(message, "❌ **هذا الأمر للأونر فقط!**", config);

      const spreadGuild = message.guild;

      const guildVoiceCount = Array.from(spreadGuild.channels.cache.values()).filter(
        (c) => c.type === ChannelType.GuildVoice
      ).length;
      if (guildVoiceCount === 0) {
        return replyMessage(message, "❌ **لا توجد أي رومات صوتية في هذا السيرفر!**", config);
      }

      // STEP 1 - bot census (shared engine - identical in the #mp panel).
      const stats = collectSpreadStats(spreadGuild, clientsMap);
      const census = formatCensus(stats);

      let promptMsg;
      try {
        promptMsg = await message.reply({
          content: `${census}\n${SPREAD_PROMPT_TEXT}`,
          components: buildSpreadComponents()
        });
      } catch (e) {
        return replyMessage(message, "❌ **فشل إرسال قائمة الاختيار. حاول مرة أخرى.**", config);
      }

      const selections = { top: null, bottom: null, style: null };
      let finished = false;
      let executing = false;

      async function runSpread() {
        const roomsPreview =
          buildRoomRange(spreadGuild.channels.cache.values(), selections.top, selections.bottom) || [];
        const styleLabel = selections.style === "numbers" ? "أرقام متسلسلة" : "أسماء الرومات";
        await promptMsg
          .edit({
            content: `${census}\n⏳ **جاري توزيع ${roomsPreview.length} بوت على الروومات بين <#${selections.top}> و <#${selections.bottom}> (نمط التسمية: ${styleLabel}) ...**`,
            components: []
          })
          .catch(() => { });

        // Single source of truth: the exact same engine powers the #mp
        // panel option, so the two surfaces can never drift apart.
        const result = await executeSpread({
          guild: spreadGuild,
          clientsMap,
          config,
          topId: selections.top,
          bottomId: selections.bottom,
          style: selections.style
        });
        await replyMessage(message, formatSpreadResult(result), config);
      }

      async function markDone() {
        finished = true;
        try {
          await promptMsg.edit({
            content: `${census}\n✅ **تم تنفيذ التوزيع — التفاصيل في الرد أدناه.**`,
            components: []
          });
        } catch (e) { }
      }

      // NOTE: componentType is intentionally omitted - a bitwise OR of two
      // ComponentType values would match NEITHER type in d.js collectors.
      // The customId filter below is the precise gate. (IDs are shared with
      // the #mp panel spread option - "mps_" prefix.)
      const collector = promptMsg.createMessageComponentCollector({
        time: 120000,
        filter: (i) =>
          i.customId === "mps_top_vc" ||
          i.customId === "mps_bottom_vc" ||
          i.customId === "mps_style"
      });

      collector.on("collect", async (interaction) => {
        try {
          if (interaction.user?.id !== message.author.id) {
            return interaction
              .reply({ content: "❌ **هذه القائمة مخصصة لصاحب الأمر فقط!**", flags: MessageFlags.Ephemeral })
              .catch(() => { });
          }

          if (interaction.customId === "mps_top_vc") {
            selections.top = interaction.values?.[0] || null;
          } else if (interaction.customId === "mps_bottom_vc") {
            selections.bottom = interaction.values?.[0] || null;
          } else if (interaction.customId === "mps_style") {
            selections.style = interaction.values?.[0] || null;
          }

          // Acknowledge without touching the message (we edit it ourselves).
          await interaction.deferUpdate().catch(() => { });

          if (!selections.top || !selections.bottom || !selections.style || executing) return;
          executing = true;
          collector.stop("done");

          await runSpread();
          await markDone();
        } catch (err) {
          console.error("❌ Spread interaction error:", err?.message || err);
        }
      });

      collector.on("end", async (_collected, reason) => {
        if (reason !== "time" || finished) return;
        await promptMsg
          .edit({
            content: `${census}\n⏳ **انتهى وقت اختيار الروومات. شغّل الأمر من جديد.**`,
            components: buildSpreadComponents(true)
          })
          .catch(() => { });
      });
      break;
    }
  }
}

module.exports = {
  handleCommand,
  normalizeConfig,
  getBotChannel247,
  setBotChannel247,
  clearBotChannel247,
  selectExecutor,
  selfVoiceChannelId,
  buildRoomRange
};
