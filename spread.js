// Shared spread engine used by BOTH the `-spread` command (commands.js) and
// the "#mp -> توزيع البوتات" panel option (panel.js). Single source of truth
// for room-range math, availability gating, joining, pinning and renaming so
// the two surfaces can never drift apart.
//
// NOTE: no side effects at require-time (safe for circular-import scenarios).
const { ChannelType, ActionRowBuilder, ChannelSelectMenuBuilder, StringSelectMenuBuilder } = require("discord.js");
const { saveConfig, setBotChannel247 } = require("./config-store");
const { safeSetNickname, getChannelForBot } = require("./helpers");

/**
 * A bot's OWN voice connection as reported by its own client cache.
 * Self-reports are authoritative - each client always knows where IT is.
 */
function selfVoiceChannelId(c, guildId) {
  try {
    return c?.guilds?.cache?.get(guildId)?.members?.me?.voice?.channelId ?? null;
  } catch (e) {
    return null;
  }
}

/**
 * Order every voice channel of the guild by its position in Discord's UI and
 * return the INCLUSIVE slice between topId & bottomId. Selection order never
 * matters - whichever of the two sits higher becomes the start. Index-based
 * slicing keeps the range deterministic even when two channels share the same
 * rawPosition. Exported for offline regression tests.
 */
function buildRoomRange(channelsCacheValues, topId, bottomId) {
  const list = Array.from(channelsCacheValues || [])
    .filter((c) => c && c.type === ChannelType.GuildVoice)
    .sort((a, b) => a.rawPosition - b.rawPosition || (a.id < b.id ? -1 : 1));
  const iTop = list.findIndex((c) => c.id === topId);
  const iBottom = list.findIndex((c) => c.id === bottomId);
  if (iTop === -1 || iBottom === -1) return null;
  return list.slice(Math.min(iTop, iBottom), Math.max(iTop, iBottom) + 1);
}

/**
 * The joining bot's own Member object in THIS guild (nickname target).
 * Prefers the cached members.me; falls back to an API fetch.
 */
async function getOwnMember(bot, guildId) {
  try {
    const guild = bot?.guilds?.cache?.get(guildId);
    if (!guild) return null;
    if (guild.members?.me) return guild.members.me;
    const cached = guild.members?.cache?.get(bot.user.id);
    if (cached) return cached;
    if (typeof guild.members?.fetch !== "function") return null;
    return await guild.members.fetch(bot.user.id).catch(() => null);
  } catch (e) {
    return null;
  }
}

/** Census: fleet total / bots present in this guild / free (room-less) bots. */function collectSpreadStats(guild, clientsMap) {
  const inGuildBots = [];
  clientsMap.forEach((c) => {
    if (c.user && c.guilds?.cache?.has(guild.id)) inGuildBots.push(c);
  });
  const freeBots = inGuildBots.filter((c) => c.distube && !selfVoiceChannelId(c, guild.id));
  return {
    totalFleet: clientsMap.size,
    inGuildCount: inGuildBots.length,
    freeCount: freeBots.length,
    freeBots,
    runningBots: inGuildBots
  };
}

/** Census reply block shown as STEP 1 before the owner picks anything. */
function formatCensus(stats) {
  return (
    `🤖 **إجمالي بوتات الموسيقى (العملية):** \`${stats.totalFleet}\`\n` +
    `🏠 **البوتات داخل هذا السيرفر:** \`${stats.inGuildCount}\`\n` +
    `🎙️ **البوتات الفارغة (غير مثبتة برومات):** \`${stats.freeCount}\``
  );
}

/** The three selection rows: top VC / bottom VC / naming style. */
function buildSpreadComponents(disabled = false) {
  const vcRow = (customId, placeholder) =>
    new ActionRowBuilder().addComponents(
      new ChannelSelectMenuBuilder()
        .setCustomId(customId)
        .setChannelTypes(ChannelType.GuildVoice)
        .setPlaceholder(placeholder)
        .setDisabled(disabled)
    );
  const styleRow = new ActionRowBuilder().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId("mps_style")
      .setPlaceholder("🔤 اختر نمط تسمية البوتات..")
      .addOptions([
        {
          label: "أسماء الرومات",
          description: "يأخذ كل بوت اسم الروم التي دخلها",
          value: "names",
          emoji: "🏠"
        },
        {
          label: "أرقام متسلسلة",
          description: "ترقيم البوتات 1، 2، 3... حسب ترتيب الروومات من الأعلى للأسفل",
          value: "numbers",
          emoji: "🔢"
        }
      ])
      .setDisabled(disabled)
  );
  return [
    vcRow("mps_top_vc", "⬆️ اختر الروم الصوتي العلوي.."),
    vcRow("mps_bottom_vc", "⬇️ اختر الروم الصوتي السفلي.."),
    styleRow
  ];
}

/** Prompt text shown above the three selects. */
const SPREAD_PROMPT_TEXT =
  `📋 **حدد الآن الروم الصوتي العلوي والسفلي من القائمتين، ثم اختر نمط التسمية، وسيتم إدخال البوتات الفارغة في جميع الروومات بينهما (شاملة الرومتين):**\n` +
  `🏠 **أسماء الرومات:** كل بوت يأخذ اسم رومته.\n` +
  `🔢 **أرقام متسلسلة:** ترقيم مرتب \`(1، 2، 3...)\` من الروم الأعلى إلى الأسفل.`;

/**
 * Run the actual distribution. Pure-ish orchestration: joins, pins and
 * renames - NO messaging. Both surfaces format their own replies from the
 * returned result.
 * @returns {Promise<object>} result descriptor (see fields below)
 */
async function executeSpread({ guild, clientsMap, config, topId, bottomId, style }) {
  const topCh = guild.channels.cache.get(topId);
  const bottomCh = guild.channels.cache.get(bottomId);
  if (!topCh || !bottomCh || topCh.type !== ChannelType.GuildVoice || bottomCh.type !== ChannelType.GuildVoice) {
    return { error: "missing_channels" };
  }

  const rooms = buildRoomRange(guild.channels.cache.values(), topId, bottomId);
  if (!rooms || rooms.length === 0) return { error: "no_rooms" };

  // Fresh availability check at EXECUTION time - states may have changed
  // while the owner was picking the two rooms.
  const stats = collectSpreadStats(guild, clientsMap);
  const freeBots = stats.freeBots;
  if (freeBots.length < rooms.length) {
    return {
      error: "not_enough_bots",
      roomsCount: rooms.length,
      freeCount: freeBots.length,
      missing: rooms.length - freeBots.length
    };
  }

  const lines = [];
  let joinedOk = 0;
  let failedJoins = 0;
  let renamedOk = 0;
  let renamedFailed = 0;
  let renamedTruncated = 0;

  for (let i = 0; i < rooms.length; i++) {
    const room = rooms[i];
    const bot = freeBots[i];
    // DisTube rejects channel objects owned by ANOTHER client
    // ("VOICE_DIFFERENT_CLIENT") - resolve the room through THIS bot's own
    // client before joining.
    const roomForBot = await getChannelForBot(bot, guild.id, room.id);
    if (!roomForBot) {
      failedJoins++;
      lines.push(`⚠️ ${bot.user} ← لا يستطيع الوصول إلى <#${room.id}>`);
      continue;
    }
    try {
      await bot.distube.voices.join(roomForBot);
    } catch (err) {
      failedJoins++;
      lines.push(`⚠️ ${bot.user} ← فشل دخول <#${room.id}> (${err?.message || "unknown"})`);
      continue;
    }
    joinedOk++;
    setBotChannel247(config, guild.id, bot.user.id, room.id);

    // Naming mode chosen by the owner - applied as the bot's NICKNAME inside
    // THIS server (per-guild display name), never the global username:
    //  - "names"   : the bot's nickname becomes its room's name (as-is).
    //  - "numbers" : sequential 1,2,3... following the rooms' sorted order
    //                (top -> bottom). Nicknames allow single digits, so no
    //                zero-padding is needed.
    const member = await getOwnMember(bot, guild.id);
    const desiredName = style === "numbers" ? String(i + 1) : room.name;
    let applied = null;
    let truncated = false;
    if (member && typeof member.setNickname === "function") {
      const desired = String(desiredName ?? "").trim();
      const finalName = desired.slice(0, 32); // Discord nickname hard limit
      try {
        await member.setNickname(finalName);
        applied = finalName;
        truncated = finalName !== desired;
      } catch (e) { }
    }

    if (applied) {
      renamedOk++;
      if (truncated) renamedTruncated++;
      lines.push(`✅ ${bot.user} → <#${room.id}> ( النيك نيم: \`${applied}\`)`);
    } else {
      renamedFailed++;
      lines.push(`✅ ${bot.user} → <#${room.id}> ⚠️ تعذر تغيير النيك نيم`);
    }
  }
  saveConfig(config);

  return {
    ok: true,
    topId,
    bottomId,
    style,
    roomsCount: rooms.length,
    lines,
    joinedOk,
    failedJoins,
    renamedOk,
    renamedFailed,
    renamedTruncated,
    spare: freeBots.length - rooms.length
  };
}

/** Human-readable result of executeSpread (identical across command & panel). */
function formatSpreadResult(result) {
  if (result.error === "missing_channels") {
    return "❌ **أحد الرومين لم يعد موجوداً (قد يكون حُذف). شغّل الأمر من جديد.**";
  }
  if (result.error === "no_rooms") {
    return "❌ **تعذر تحديد نطاق الروومات! تأكد أن الرومتين صوتيتان.**";
  }
  if (result.error === "not_enough_bots") {
    return (
      `❌ **عدد البوتات المتاحة غير كافٍ! (Number of available bots is not enough)**\n` +
      `🏠 **الروومات المطلوب تعبئتها:** \`${result.roomsCount}\`\n` +
      `🎙️ **البوتات المتاحة (خارج الرومات):** \`${result.freeCount}\`\n` +
      `➕ **تحتاج:** \`${result.missing}\` بوت إضافي.`
    );
  }
  let summary =
    `🎯 **نتيجة التوزيع بين <#${result.topId}> و <#${result.bottomId}>:**\n${result.lines.join("\n")}\n\n` +
    `📊 **دخل بنجاح:** \`${result.joinedOk}/${result.roomsCount}\` | **تغيير الألقاب:** \`${result.renamedOk}\` | **النمط:** \`${result.style === "numbers" ? "أرقام متسلسلة 🔢" : "أسماء الرومات 🏠"}\``;
  if (result.renamedTruncated > 0) {
    summary += `\n⚠️ تم اختصار \`${result.renamedTruncated}\` اسم ليطابق حد ديسكورد للنيك (32 حرفاً).`;
  }
  if (result.renamedFailed > 0) {
    summary += `\n⚠️ تعذر تغيير نيك \`${result.renamedFailed}\` بوت (تأكد من صلاحية تغيير اللقب).`;
  }
  if (result.failedJoins > 0) {
    summary += `\n❌ فشل دخول \`${result.failedJoins}\` بوت (راجع الأسباب أعلاه).`;
  }
  if (result.spare > 0) {
    summary += `\nℹ️ بقى \`${result.spare}\` بوت فارغ بدون استخدام.`;
  }
  return summary;
}

module.exports = {
  selfVoiceChannelId,
  buildRoomRange,
  collectSpreadStats,
  formatCensus,
  buildSpreadComponents,
  SPREAD_PROMPT_TEXT,
  executeSpread,
  formatSpreadResult
};

