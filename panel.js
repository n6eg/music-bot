const {
  EmbedBuilder,
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ChannelSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  MessageFlags
} = require("discord.js");
const {
  getConfig,
  saveConfig,
  isOwner,
  setBotChannel247,
  clearBotChannel247
} = require("./config-store");
const { looksLikeCommand, safeRename, getChannelForBot, setGuildAvatar, setGuildBanner } = require("./helpers");
const {
  selfVoiceChannelId,
  buildRoomRange,
  collectSpreadStats,
  formatCensus,
  buildSpreadComponents,
  SPREAD_PROMPT_TEXT,
  executeSpread,
  formatSpreadResult
} = require("./spread");
const { suppressReconnect } = require("./voice-guard");

/**
 * Acknowledge an interaction ephemerally. Returns false when ANOTHER panel
 * client already handled this interaction - with the multi-bot fleet every
 * client receives the same event, so state-changing actions must run in the
 * winning handler ONLY (prevents double execution / config races).
 */
async function ackEphemeral(interaction) {
  try {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * Safely answer an interaction whether it was deferred, already replied, or untouched.
 * Prevents "Unknown interaction" (10062) / "Already acknowledged" (40060) errors.
 */
async function respond(interaction, payload) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (err) {
    // Interaction token expired or network hiccup - nothing else we can do
  }
}

function createPanelComponents() {
  const selectMenu = new StringSelectMenuBuilder()
    .setCustomId("mp_select_action")
    .setPlaceholder("..يرجى تحديد نوع التعديل")
    .addOptions([
      {
        label: "روابط البوتات",
        description: ".طلب روابط جميع البوتات الخاصه بك.",
        value: "mp_links",
        emoji: "🔗"
      },
      {
        label: "خارج السيرفر",
        description: ".لعرض روابط البوتات التي خارج السيرفر.",
        value: "mp_outside",
        emoji: "🚪"
      },
      {
        label: "البوتات الغير مثبته بالرومات",
        description: ".لعرض قائمة البوتات الغير مثبته بالرومات الصوتيه.",
        value: "mp_unfixed_bots",
        emoji: "🎙️"
      },
      {
        label: "ادخال البوتات الغير مثبته بالرومات",
        description: ".لادخال البوتات غير مثبته بالرومات الصوتيه.",
        value: "mp_join_unfixed",
        emoji: "⤵️"
      },
      {
        label: "توزيع البوتات على نطاق رومات",
        description: ".اختر الروم العلوي والسفلي وسيتم توزيع البوتات الفارغة بينهما شاملتيهما.",
        value: "mp_spread",
        emoji: "🎯"
      },
      {
        label: "ادخال جميع البوتات لرومك",
        description: ".لادخال جميع البوتات المتواجدة بالسيرفر الى رومك الصوتي.",
        value: "mp_comeall",
        emoji: "➡️"
      },
      {
        label: "إخراج جميع البوتات من الرومات",
        description: ".لاخراج جميع البوتات من الرومات وإلغاء تثبيت 24/7.",
        value: "mp_leaveall",
        emoji: "👋"
      },
      {
        label: "اعطاء رول لكل البوتات",
        description: ".لاضافة رول الى كل البوتات.",
        value: "mp_give_role",
        emoji: "➕"
      },
      {
        label: "ترقيم البوتات",
        description: ".لتغير اسامي البوتات الى ارقام.",
        value: "mp_number",
        emoji: "🔢"
      },
      {
        label: "اسم البوتات",
        description: ".تعديل اسم البوتات.",
        value: "mp_name",
        emoji: "👤"
      },
      {
        label: "افتار البوتات (Custom Branding)",
        description: ".تخصيص صورة للبوتات في هذا السيرفر فقط أو استعادتها.",
        value: "mp_avatar",
        emoji: "🖼️"
      },
      {
        label: "بنر البوتات (Custom Branding)",
        description: ".تخصيص بنر للبوتات في هذا السيرفر فقط أو استعادته.",
        value: "mp_banner",
        emoji: "🎨"
      },
      {
        label: "لعب البوتات",
        description: ".لتغير لعب البوتات (Playing @ws.).",
        value: "mp_game",
        emoji: "🎮"
      },
      {
        label: "حالة البوتات",
        description: ".لتغير حالة البوتات (Dnd , Online).",
        value: "mp_status",
        emoji: "🔄"
      },
      {
        label: "سيرفر البوتات",
        description: ".لتغير سيرفر البوتات ونقله الى سيرفر اخر.",
        value: "mp_server",
        emoji: "🌐"
      },
      {
        label: "اضافة/ازالة اونر الى جميع البوتات",
        description: ".لتعديل قائمة المتحكمين بالبوتات.",
        value: "mp_edit_owner",
        emoji: "🔑"
      },
      {
        label: "عرض قائمة الاونرات",
        description: ".عرض قائمة المتحكمين بالبوتات.",
        value: "mp_owners_list",
        emoji: "📋"
      },
      {
        label: "تفعيل/تعطيل الامبيد",
        description: ".لتفعيل او تعطيل الامبيد في البوتات.",
        value: "mp_toggle_embed",
        emoji: "🔲"
      },
      {
        label: "لغة ردود الموسيقى",
        description: ".لتغيير لغة ردود أوامر الموسيقى (ar/en).",
        value: "mp_lang",
        emoji: "🌐"
      },
      {
        label: "منصة البحث بالأسماء",
        description: ".لتحديد منصة البحث (youtube / spotify / soundcloud).",
        value: "mp_platform",
        emoji: "🔍"
      },
      {
        label: "بادئة الأوامر",
        description: ".لتغيير بادئة أوامر البوتات.",
        value: "mp_prefix",
        emoji: "⚙️"
      },
      {
        label: "روم الأوامر المخصص",
        description: ".لتخصيص روم محدد للأوامر أو إلغاء التخصيص.",
        value: "mp_chat",
        emoji: "💬"
      },
      {
        label: "تنظيف الشات التلقائي",
        description: ".تفعيل أو تعطيل الحذف التلقائي اليومي لرسائل روم محدد.",
        value: "mp_autoclean",
        emoji: "🧹"
      },
      {
        label: "إعادة تشغيل هذا البوت",
        description: ".إعادة تشغيل البوت المسؤول عن هذه اللوحة فقط.",
        value: "mp_restart",
        emoji: "🔄"
      },
      {
        label: "إيقاف العملية بالكامل",
        description: ".إيقاف جميع البوتات (يتطلب مشرف عمليات للعودة).",
        value: "mp_restartall",
        emoji: "⏹️"
      }
    ]);

  const cancelButton = new ButtonBuilder()
    .setCustomId("mp_cancel")
    .setLabel("إلغاء")
    .setEmoji("❌")
    .setStyle(ButtonStyle.Danger);

  const row1 = new ActionRowBuilder().addComponents(selectMenu);
  const row2 = new ActionRowBuilder().addComponents(cancelButton);

  return [row1, row2];
}

async function sendPanelMessage(message) {
  const embed = new EmbedBuilder()
    .setColor("#2b2d31")
    .setTitle("🛠️ لوحة تحكم البوتات المتقدمة")
    .setDescription("اختر من القائمة أدناه الإجراء الذي ترغب بتطبيقه على البوتات.")
    .setTimestamp();

  return message.channel.send({
    embeds: [embed],
    components: createPanelComponents()
  });
}

async function handlePanelInteraction(interaction, clientsMap) {
  const config = getConfig();

  if (!isOwner(interaction.user.id, config)) {
    return interaction.reply({
      content: "❌ **عذراً، هذا الأمر مخصص لمالكي البوت فقط!**",
      flags: MessageFlags.Ephemeral
    });
  }

  // Handle Cancel Button
  if (interaction.isButton() && interaction.customId === "mp_cancel") {
    await interaction.message.delete().catch(() => { });
    return interaction.reply({
      content: "✅ **تم إغلاق لوحة التحكم بنجاح.**",
      flags: MessageFlags.Ephemeral
    });
  }

  // Handle Avatar Selection Buttons
  if (interaction.isButton() && interaction.customId.startsWith("mp_btn_avatar_")) {
    const action = interaction.customId.replace("mp_btn_avatar_", "");
    if (action === "cancel") {
      return interaction.update({
        content: "❌ **تم إلغاء عملية تغيير الافتار.**",
        components: []
      }).catch(() => { });
    }

    if (action === "reset") {
      let okCount = 0;
      for (const c of clientsMap.values()) {
        if (!c.user || !c.guilds?.cache?.has(interaction.guildId)) continue;
        try {
          await setGuildAvatar(c, interaction.guildId, null);
          okCount++;
        } catch (_) { }
      }
      return interaction.update({
        content: `🔄 **تمت إعادة ضبط صورة ${okCount} بوت في هذا السيرفر إلى الصورة الافتراضية بنجاح.**`,
        components: []
      }).catch(() => { });
    }

    const isServer = action === "server";
    await interaction.update({
      content: isServer
        ? "✨ **Custom Bot Branding - صورة خاصة بهذا السيرفر:**\nأرسل رابط صورة البوتات الخاصة بهذا السيرفر (أو أرفق صورة) في الشات الآن (خلال 60 ثانية)..."
        : "🌐 **تغيير الصورة العامة لجميع البوتات (Global Avatar):**\nأرسل رابط صورة/افتار البوتات الجديد (أو أرفق صورة) في الشات الآن (خلال 60 ثانية)...",
      components: []
    }).catch(() => { });

    const collector = interaction.channel.createMessageCollector({
      filter: (m) =>
        m.author.id === interaction.user.id &&
        !looksLikeCommand(m.content, config.prefix),
      max: 1,
      time: 60000
    });

    collector.on("collect", async (msg) => {
      const input = msg.attachments.first()?.url || msg.content.trim();
      let okCount = 0;
      let errCount = 0;

      if (isServer) {
        for (const c of clientsMap.values()) {
          if (!c.user || !c.guilds?.cache?.has(interaction.guildId)) continue;
          try {
            await setGuildAvatar(c, interaction.guildId, input);
            okCount++;
          } catch (err) {
            errCount++;
          }
        }
        msg.reply(
          okCount > 0
            ? `✨ **تم تغيير صورة ${okCount} بوت في هذا السيرفر بنجاح! (Custom Branding)**`
            : "❌ **فشل تغيير صورة السيرفر - تأكد من صحة رابط الصورة.**"
        ).catch(() => { });
      } else {
        for (const c of clientsMap.values()) {
          if (!c.user) continue;
          try {
            await c.user.setAvatar(input);
            okCount++;
          } catch (err) {
            errCount++;
          }
        }
        msg.reply(
          okCount > 0
            ? `🌐 **تم تغيير الصورة العامة لـ ${okCount} بوت بنجاح.**`
            : "❌ **فشل تغيير الصورة العامة - تأكد من أن الرابط صورة مباشرة صالحة.**"
        ).catch(() => { });
      }
    });

    collector.on("end", (collected, reason) => {
      if (reason === "time" && collected.size === 0) {
        interaction.followUp({ content: "⏳ **انتهى الوقت المحدد لإرسال الصورة.**", flags: MessageFlags.Ephemeral }).catch(() => { });
      }
    });
    return;
  }

  // Handle Banner Selection Buttons
  if (interaction.isButton() && interaction.customId.startsWith("mp_btn_banner_")) {
    const action = interaction.customId.replace("mp_btn_banner_", "");
    if (action === "cancel") {
      return interaction.update({
        content: "❌ **تم إلغاء عملية تغيير البنر.**",
        components: []
      }).catch(() => { });
    }

    if (action === "reset") {
      let okCount = 0;
      for (const c of clientsMap.values()) {
        if (!c.user || !c.guilds?.cache?.has(interaction.guildId)) continue;
        try {
          await setGuildBanner(c, interaction.guildId, null);
          okCount++;
        } catch (_) { }
      }
      return interaction.update({
        content: `🔄 **تمت إعادة ضبط بنر ${okCount} بوت في هذا السيرفر إلى البنر الافتراضي بنجاح.**`,
        components: []
      }).catch(() => { });
    }

    const isServer = action === "server";
    await interaction.update({
      content: isServer
        ? "✨ **Custom Bot Branding - بنر خاص بهذا السيرفر:**\nأرسل رابط صورة البنر الخاصة بهذا السيرفر (أو أرفق صورة) في الشات الآن (خلال 60 ثانية)..."
        : "🌐 **تغيير البنر العام لجميع البوتات (Global Banner):**\nأرسل رابط صورة/بنر البوتات الجديد (أو أرفق صورة) في الشات الآن (خلال 60 ثانية)...",
      components: []
    }).catch(() => { });

    const collector = interaction.channel.createMessageCollector({
      filter: (m) =>
        m.author.id === interaction.user.id &&
        !looksLikeCommand(m.content, config.prefix),
      max: 1,
      time: 60000
    });

    collector.on("collect", async (msg) => {
      const input = msg.attachments.first()?.url || msg.content.trim();
      let okCount = 0;
      let errCount = 0;

      if (isServer) {
        for (const c of clientsMap.values()) {
          if (!c.user || !c.guilds?.cache?.has(interaction.guildId)) continue;
          try {
            await setGuildBanner(c, interaction.guildId, input);
            okCount++;
          } catch (err) {
            errCount++;
          }
        }
        msg.reply(
          okCount > 0
            ? `✨ **تم تغيير بنر ${okCount} بوت في هذا السيرفر بنجاح! (Custom Branding)**`
            : "❌ **فشل تغيير بنر السيرفر - تأكد من صحة رابط الصورة وصلاحيات البوت.**"
        ).catch(() => { });
      } else {
        for (const c of clientsMap.values()) {
          if (!c.user?.setBanner) continue;
          try {
            await c.user.setBanner(input);
            okCount++;
          } catch (err) {
            errCount++;
          }
        }
        msg.reply(
          okCount > 0
            ? `🌐 **تم تغيير البنر العام لـ ${okCount} بوت بنجاح.**`
            : "❌ **فشل تغيير البنر العام - تأكد من أن الرابط صورة مباشرة صالحة.**"
        ).catch(() => { });
      }
    });

    collector.on("end", (collected, reason) => {
      if (reason === "time" && collected.size === 0) {
        interaction.followUp({ content: "⏳ **انتهى الوقت المحدد لإرسال البنر.**", flags: MessageFlags.Ephemeral }).catch(() => { });
      }
    });
    return;
  }

  // Handle Category Selection for Joining Bots
  if (interaction.isStringSelectMenu() && interaction.customId === "mp_select_category") {
    if (!(await ackEphemeral(interaction))) return;
    const categoryId = interaction.values[0];
    const category = interaction.guild.channels.cache.get(categoryId);
    if (!category) {
      return respond(interaction, { content: "❌ الكاتاقوري غير موجود!", flags: MessageFlags.Ephemeral });
    }

    const voiceChannels = interaction.guild.channels.cache.filter(
      (c) => c.parentId === categoryId && c.type === ChannelType.GuildVoice
    );

    if (voiceChannels.size === 0) {
      return respond(interaction, {
        content: `❌ **لا توجد رومات صوتية داخل الكاتاقوري:** \`${category.name}\``,
        flags: MessageFlags.Ephemeral
      });
    }

    const vChannelsArray = Array.from(voiceChannels.values());
    let joinedCount = 0;
    let failedCount = 0;
    let channelIdx = 0;

    // Sequential awaited joins so failures are counted truthfully instead of
    // optimistically (voices.join is async - a sync try/catch never sees its
    // rejections).
    for (const client of clientsMap.values()) {
      if (!client.distube) continue;
      const targetVoiceChannel = vChannelsArray[channelIdx % vChannelsArray.length];
      channelIdx++;
      try {
        const chForBot = (await getChannelForBot(client, interaction.guildId, targetVoiceChannel.id)) || targetVoiceChannel;
        await client.distube.voices.join(chForBot);
        // Pin each bot to the room it was placed in (per-bot 24/7),
        // so it reconnects there after a restart instead of piling
        // into one shared room.
        setBotChannel247(config, interaction.guildId, client.user.id, targetVoiceChannel.id);
        joinedCount++;
      } catch (err) {
        failedCount++;
      }
    }
    saveConfig(config);

    return respond(interaction, {
      content: `✅ **تم إدخال ${joinedCount} بوت وتوزيعهم في رومات الكاتاقوري: \`${category.name}\`**` +
        (failedCount > 0 ? `\n⚠️ فشل إدخال ${failedCount} بوت.` : ""),
      flags: MessageFlags.Ephemeral
    });
  }

  // Handle Main Select Menu
  if (interaction.isStringSelectMenu() && interaction.customId === "mp_select_action") {
    const selected = interaction.values[0];

    // Modal cases MUST call showModal immediately (cannot defer first),
    // and collector cases reply instantly - everything else is deferred right away
    // so slow handlers never hit Discord's 3-second interaction window.
    const modalCases = ["mp_number", "mp_game", "mp_status", "mp_server", "mp_edit_owner", "mp_give_role", "mp_lang", "mp_platform", "mp_prefix"];
    const collectorCases = ["mp_name", "mp_avatar", "mp_banner"];
    if (!modalCases.includes(selected) && !collectorCases.includes(selected)) {
      if (!(await ackEphemeral(interaction))) return;
    }

    switch (selected) {
      case "mp_links": {
        let links = [];
        clientsMap.forEach((client) => {
          if (client.user) {
            links.push(`• **${client.user.username}**: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot`);
          }
        });
        return respond(interaction, {
          content: `🔗 **روابط جميع البوتات:**\n${links.join("\n") || "لا يوجد بوتات متصلة حالياً."}`,
          flags: MessageFlags.Ephemeral
        });
      }

      case "mp_outside": {
        let outside = [];
        clientsMap.forEach((client) => {
          if (client.user && !client.guilds.cache.has(interaction.guildId)) {
            outside.push(`• **${client.user.username}**: https://discord.com/oauth2/authorize?client_id=${client.user.id}&permissions=8&scope=bot`);
          }
        });
        // respond() not .reply(): this interaction was already deferred above,
        // calling .reply() again throws "already acknowledged".
        return respond(interaction, {
          content: `🚪 **روابط البوتات خارج هذا السيرفر:**\n${outside.join("\n") || "جميع البوتات متواجدة بالسيرفر الحالي!"}`,
          flags: MessageFlags.Ephemeral
        });
      }

      case "mp_unfixed_bots": {
        let unfixed = [];
        clientsMap.forEach((client) => {
          if (client.user) {
            const isVoice = client.distube?.voices?.get(interaction.guildId);
            if (!isVoice) {
              unfixed.push(`• **${client.user.username}** (غير متصل بروم صوتي)`);
            }
          }
        });
        return respond(interaction, {
          content: `🎙️ **قائمة البوتات غير المثبتة بالرومات الصوتية:**\n${unfixed.join("\n") || "جميع البوتات متصلة برومات صوتية حالياً!"}`,
          flags: MessageFlags.Ephemeral
        });
      }

      case "mp_join_unfixed": {
        // Category Selection for Joining Bots
        const categories = interaction.guild.channels.cache.filter(
          (c) => c.type === ChannelType.GuildCategory
        );

        if (categories.size === 0) {
          // If no categories, fall back to user's current voice channel
          const memberVoiceChannel = interaction.member.voice?.channel;
          if (!memberVoiceChannel) {
            return respond(interaction, {
              content: "❌ **لا توجد كاتجريات في السيرفر ويجب أن تكون متواجد داخل روم صوتي!**",
              flags: MessageFlags.Ephemeral
            });
          }
          let joinedCount = 0;
          for (const client of clientsMap.values()) {
            if (!client.distube) continue;
            try {
              const chForBot2 = (await getChannelForBot(client, interaction.guildId, memberVoiceChannel.id)) || memberVoiceChannel;
              await client.distube.voices.join(chForBot2);
              setBotChannel247(config, interaction.guildId, client.user.id, memberVoiceChannel.id);
              joinedCount++;
            } catch (err) { }
          }
          saveConfig(config);
          return respond(interaction, {
            content: `✅ **تم إدخال ${joinedCount} بوت إلى الروم الصوتي: <#${memberVoiceChannel.id}>**`,
            flags: MessageFlags.Ephemeral
          });
        }

        const categoryOptions = categories.first(25).map((cat) => ({
          label: cat.name.slice(0, 50),
          value: cat.id,
          description: `ادخال وتوزيع البوتات في رومات ${cat.name}`.slice(0, 100),
          emoji: "📁"
        }));

        const categorySelectMenu = new StringSelectMenuBuilder()
          .setCustomId("mp_select_category")
          .setPlaceholder("اختر الكاتاقوري لإدخال البوتات فيه..")
          .addOptions(categoryOptions);

        const row = new ActionRowBuilder().addComponents(categorySelectMenu);

        // respond() not .reply(): already deferred above.
        return respond(interaction, {
          content: "📁 **اختر الكاتاقوري المراد توزيع وإدخال البوتات فيه:**",
          components: [row],
          flags: MessageFlags.Ephemeral
        });
      }

      // Direct Chat Collector for Name
      case "mp_name": {
        await interaction.reply({
          content: "👤 **أرسل الاسم الجديد للبوتات في الشات الآن (خلال 60 ثانية)...**",
        });

        const collector = interaction.channel.createMessageCollector({
          filter: (m) =>
            m.author.id === interaction.user.id &&
            !looksLikeCommand(m.content, config.prefix),
          max: 1,
          time: 60000
        });

        collector.on("collect", async (msg) => {
          const newName = msg.content.trim();
          let okCount = 0;
          let sanitizedNote = false;
          for (const client of clientsMap.values()) {
            if (!client.user) continue;
            const r = await safeRename(client.user, newName);
            if (r.ok) {
              okCount++;
              if (r.sanitized) sanitizedNote = true;
            }
          }
          const note = sanitizedNote ? `\n⚠️ *تمت تسوية الاسم تلقائياً ليطابق قوانين يوزرات ديسكورد (بدون مسافات/رموز).*` : "";
          msg.reply(`👤 **تم تغيير اسم ${okCount} بوت إلى:** \`${newName}\`${note}`).catch(() => { });
        });

        collector.on("end", (collected, reason) => {
          if (reason === "time" && collected.size === 0) {
            interaction.followUp({ content: "⏳ **انتهى الوقت المحدد لكتابة الاسم.**", flags: MessageFlags.Ephemeral }).catch(() => { });
          }
        });
        return;
      }

      // Direct Chat Collector / Selection for Avatar
      case "mp_avatar": {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("mp_btn_avatar_server")
            .setLabel("صورة مخصصة لهذا السيرفر (Custom Branding)")
            .setEmoji("✨")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("mp_btn_avatar_reset")
            .setLabel("استعادة الصورة الأصلية للسيرفر")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("mp_btn_avatar_cancel")
            .setLabel("إلغاء")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: "🖼️ **تغيير افتار البوتات بهذا السيرفر (Custom Branding):**\nاضغط على **صورة مخصصة** لتعيين صورة للبوتات في هذا السيرفر فقط، أو **استعادة** للرجوع للصورة الافتراضية.",
          components: [row]
        });
        return;
      }

      // Direct Selection for Banner (Custom Branding per server)
      case "mp_banner": {
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder()
            .setCustomId("mp_btn_banner_server")
            .setLabel("بنر مخصص لهذا السيرفر (Custom Branding)")
            .setEmoji("✨")
            .setStyle(ButtonStyle.Primary),
          new ButtonBuilder()
            .setCustomId("mp_btn_banner_reset")
            .setLabel("استعادة البنر الأصلي للسيرفر")
            .setEmoji("🔄")
            .setStyle(ButtonStyle.Secondary),
          new ButtonBuilder()
            .setCustomId("mp_btn_banner_cancel")
            .setLabel("إلغاء")
            .setEmoji("❌")
            .setStyle(ButtonStyle.Danger)
        );

        await interaction.reply({
          content: "🎨 **تغيير بنر البوتات بهذا السيرفر (Custom Branding):**\nاضغط على **بنر مخصص** لتعيين بنر للبوتات في هذا السيرفر فقط، أو **استعادة** للرجوع للبنر الافتراضي.",
          components: [row]
        });
        return;
      }

      case "mp_owners_list": {
        const ownersList = config.owners.map((id) => `<@${id}> (\`${id}\`)`).join("\n") || "لا يوجد مالكون مسجلون.";
        // respond() not .reply(): already deferred above.
        return respond(interaction, {
          content: `📋 **قائمة أونرات البوتات:**\n${ownersList}`,
          flags: MessageFlags.Ephemeral
        });
      }

      case "mp_toggle_embed": {
        config.embeds = !config.embeds;
        saveConfig(config);
        // respond() not .reply(): already deferred above. Using .reply() here
        // used to throw AFTER the config was already mutated - the owner saw
        // an error while the embed mode had actually flipped.
        return respond(interaction, {
          content: `🔲 **تم ${config.embeds ? "تفعيل" : "تعطيل"} نظام الإمبيد (Embed) بنجاح.**`,
          flags: MessageFlags.Ephemeral
        });
      }

      case "mp_number": {
        const modal = new ModalBuilder()
          .setCustomId("modal_number")
          .setTitle("ترقيم البوتات")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("prefix_name")
                .setLabel("الاسم الأساسي قبل الرقم (مثال: Bot)")
                .setStyle(TextInputStyle.Short)
                .setValue("Bot")
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      case "mp_game": {
        const modal = new ModalBuilder()
          .setCustomId("modal_game")
          .setTitle("تغيير نشاط/لعب البوتات")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("game_text")
                .setLabel("اسم اللعبة أو النشاط (مثال: @ws.)")
                .setStyle(TextInputStyle.Short)
                .setValue("@ws.")
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      case "mp_status": {
        const modal = new ModalBuilder()
          .setCustomId("modal_status")
          .setTitle("تغيير حالة البوتات")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("status_type")
                .setLabel("الحالة: (online / dnd / idle / invisible)")
                .setStyle(TextInputStyle.Short)
                .setValue("dnd")
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      case "mp_server": {
        const modal = new ModalBuilder()
          .setCustomId("modal_server")
          .setTitle("تغيير سيرفر البوتات")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("server_invite")
                .setLabel("رابط دعوة السيرفر أو ID السيرفر")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      case "mp_edit_owner": {
        const modal = new ModalBuilder()
          .setCustomId("modal_owner")
          .setTitle("إضافة / إزالة أونر")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("action_type")
                .setLabel("الإجراء (add / remove)")
                .setStyle(TextInputStyle.Short)
                .setValue("add")
                .setRequired(true)
            ),
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("owner_id")
                .setLabel("آيدي الأونرات (يمكنك وضع حتى 3 آيديات)")
                .setPlaceholder("مثال: 123456789012345678 987654321098765432 112233445566778899")
                .setStyle(TextInputStyle.Paragraph)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }

      case "mp_spread": {
        const guild = interaction.guild;
        const guildVoiceCount = Array.from(guild.channels.cache.values()).filter((c) => c.type === ChannelType.GuildVoice).length;
        if (guildVoiceCount === 0) {
          return respond(interaction, { content: "❌ **لا توجد أي رومات صوتية في هذا السيرفر!**", flags: MessageFlags.Ephemeral });
        }
        const stats = collectSpreadStats(guild, clientsMap);
        const census = formatCensus(stats);
        let promptMsg;
        try {
          promptMsg = await interaction.channel.send({ content: `${census}\n${SPREAD_PROMPT_TEXT}`, components: buildSpreadComponents() });
        } catch (e) {
          return respond(interaction, { content: "❌ **فشل إرسال قائمة الاختيار في هذه القناة!**", flags: MessageFlags.Ephemeral });
        }
        respond(interaction, { content: "📋 **تم فتح قائمة التوزيع أعلاه — أكمل الاختيارات هناك.**", flags: MessageFlags.Ephemeral }).catch(() => {});
        const selections = { top: null, bottom: null, style: null };
        let executing = false;
        const ownerId = interaction.user.id;
        const collector = promptMsg.createMessageComponentCollector({ time: 120000, filter: (i) => ["mps_top_vc", "mps_bottom_vc", "mps_style"].includes(i.customId) });
        collector.on("collect", async (i) => {
          try {
            if (i.user?.id !== ownerId) return i.reply({ content: "❌ **هذه القائمة مخصصة لصاحب اللوحة فقط!**", flags: MessageFlags.Ephemeral }).catch(() => {});
            if (i.customId === "mps_top_vc") selections.top = i.values?.[0] || null;
            else if (i.customId === "mps_bottom_vc") selections.bottom = i.values?.[0] || null;
            else selections.style = i.values?.[0] || null;
            await i.deferUpdate().catch(() => {});
            if (!selections.top || !selections.bottom || !selections.style || executing) return;
            executing = true;
            collector.stop("done");
            const preview = buildRoomRange(guild.channels.cache.values(), selections.top, selections.bottom) || [];
            await promptMsg.edit({ content: `${census}\n⏳ **جاري توزيع ${preview.length} بوت على الروومات بين <#${selections.top}> و <#${selections.bottom}> (نمط التسمية: ${selections.style === "numbers" ? "أرقام متسلسلة" : "أسماء الرومات"}) ...**`, components: [] }).catch(() => {});
            const result = await executeSpread({ guild, clientsMap, config, topId: selections.top, bottomId: selections.bottom, style: selections.style });
            await promptMsg.reply(formatSpreadResult(result)).catch(() => {});
            await promptMsg.edit({ content: `${census}\n✅ **تم تنفيذ التوزيع — النتيجة في الرد أدناه.**`, components: [] }).catch(() => {});
          } catch (err) { console.error(err); }
        });
        collector.on("end", async (_c, r) => { if (r !== "time") return; await promptMsg.edit({ content: `${census}\n⏳ **انتهى وقت اختيار الروومات. أعد فتح الخيار من اللوحة.**`, components: buildSpreadComponents(true) }).catch(() => {}); });
        return;
      }

      case "mp_comeall": {
        const voiceChannel = interaction.member?.voice?.channel;
        if (!voiceChannel) return respond(interaction, { content: "❌ **عذراً، يجب أن تكون متواجداً داخل روم صوتي لاستخدام هذا الإجراء!**", flags: MessageFlags.Ephemeral });
        let count = 0;
        const inGuild = [];
        clientsMap.forEach((c) => { if (c.user && c.guilds?.cache?.has(interaction.guildId)) inGuild.push(c); });
        for (const c of inGuild) {
          try {
            const d = c.distube; if (!d) continue;
            const ch = (await getChannelForBot(c, interaction.guildId, voiceChannel.id)) || voiceChannel;
            await d.voices.join(ch);
            setBotChannel247(config, interaction.guildId, c.user.id, voiceChannel.id);
            count++;
          } catch (e) {}
        }
        saveConfig(config);
        return respond(interaction, { content: `✅ **تم إدخال ${count} بوت إلى الروم الصوتي: <#${voiceChannel.id}>**`, flags: MessageFlags.Ephemeral });
      }

      case "mp_leaveall": {
        const inGuild = [];
        clientsMap.forEach((c) => { if (c.user && c.guilds?.cache?.has(interaction.guildId)) inGuild.push(c); });
        let leftCount = 0;
        for (const c of inGuild) {
          const wasConnected = Boolean(selfVoiceChannelId(c, interaction.guildId));
          if (wasConnected) suppressReconnect(c, 15000);
          try { if (c.distube && wasConnected) c.distube.voices.leave(interaction.guildId); } catch (e) {}
          clearBotChannel247(config, interaction.guildId, c.user.id);
          if (wasConnected) leftCount++;
        }
        saveConfig(config);
        return respond(interaction, { content: `👋 **تم إخراج ${leftCount} بوت من الرومات الصوتية وإلغاء تثبيت 24/7 لجميع البوتات (${inGuild.length}).**`, flags: MessageFlags.Ephemeral });
      }

      case "mp_restart": {
        const me = interaction.client;
        await respond(interaction, { content: `🔄 **جاري إعادة تشغيل البوت \`${me.user?.username}\`...**`, flags: MessageFlags.Ephemeral });
        const token = me._token; const idx = typeof me._index === "number" ? me._index : 0;
        let key = null; clientsMap.forEach((c, k) => { if (c === me) key = k; }); if (key !== null) clientsMap.delete(key);
        try { await me.destroy(); } catch (e) {}
        if (token) { const { startBot } = require("./index"); startBot(token, idx); } else process.exit(0);
        return;
      }

      case "mp_restartall": {
        await respond(interaction, { content: "🔄 **جاري إيقاف العملية بالكامل (كل البوتات)...**\n⚠️ يجب تشغيل البوت تحت مشرف عمليات (pm2) حتى يعود تلقائياً.", flags: MessageFlags.Ephemeral });
        setTimeout(() => process.exit(0), 1500);
        return;
      }

      case "mp_lang": {
        const modal = new ModalBuilder().setCustomId("modal_lang").setTitle("لغة ردود الموسيقى").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("lang_value").setLabel("اللغة (ar / en)").setStyle(TextInputStyle.Short).setValue(config.lang || "ar").setRequired(true)));
        return interaction.showModal(modal);
      }

      case "mp_platform": {
        const modal = new ModalBuilder().setCustomId("modal_platform").setTitle("منصة البحث").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("platform_value").setLabel("المنصة (youtube / spotify / soundcloud)").setStyle(TextInputStyle.Short).setValue(config.platform || "youtube").setRequired(true)));
        return interaction.showModal(modal);
      }

      case "mp_prefix": {
        const modal = new ModalBuilder().setCustomId("modal_prefix").setTitle("بادئة الأوامر").addComponents(new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("prefix_value").setLabel("البادئة الجديدة (مثال: -)").setStyle(TextInputStyle.Short).setValue(config.prefix || "-").setRequired(true)));
        return interaction.showModal(modal);
      }

      case "mp_chat": {
        const rows = [
          new ActionRowBuilder().addComponents(new ChannelSelectMenuBuilder().setCustomId("mps_chat_bind").setChannelTypes(ChannelType.GuildText).setPlaceholder("💬 اختر روم الأوامر المخصص..")),
          new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("mps_chat_off").setLabel("إلغاء التحديد (off)").setStyle(ButtonStyle.Secondary))
        ];
        let msg;
        try { msg = await interaction.channel.send({ content: "💬 **اختر روم الأوامر المخصص، أو ألغِ التحديد الحالي:**", components: rows }); } catch (e) { return respond(interaction, { content: "❌ **فشل إرسال قائمة الاختيار في هذه القناة!**", flags: MessageFlags.Ephemeral }); }
        respond(interaction, { content: "📋 **تم فتح قائمة روم الأوامر أعلاه.**", flags: MessageFlags.Ephemeral }).catch(() => {});
        const col = msg.createMessageComponentCollector({ time: 120000, filter: (i) => i.customId === "mps_chat_bind" || i.customId === "mps_chat_off" });
        col.on("collect", async (i) => {
          try {
            if (i.user.id !== interaction.user.id) return i.reply({ content: "❌ **هذه القائمة مخصصة لصاحب اللوحة فقط!**", flags: MessageFlags.Ephemeral }).catch(() => {});
            if (i.customId === "mps_chat_bind") {
              const ch = i.values?.[0]; if (!ch) return;
              config.chatChannels[interaction.guildId] = ch; saveConfig(config);
              await i.update({ content: `✅ **تم تحديد روم الأوامر ليصبح:** <#${ch}>`, components: [] });
            } else {
              delete config.chatChannels[interaction.guildId]; saveConfig(config);
              await i.update({ content: "✅ **تم إلغاء تحديد روم الأوامر الخاص.**", components: [] });
            }
            col.stop("done"); setTimeout(() => msg.delete().catch(() => {}), 10000);
          } catch (e) {}
        });
        col.on("end", (_c, r) => { if (r === "time") msg.edit({ content: "⏳ **انتهى الوقت. أعد فتح الخيار من اللوحة.**", components: [] }).catch(() => {}); });
        return;
      }

      case "mp_autoclean": {
        const rows = [
          new ActionRowBuilder().addComponents(
            new ChannelSelectMenuBuilder()
              .setCustomId("mps_autoclean_bind")
              .setChannelTypes(ChannelType.GuildText)
              .setPlaceholder("🧹 اختر روم التنظيف التلقائي اليومي..")
          ),
          new ActionRowBuilder().addComponents(
            new ButtonBuilder()
              .setCustomId("mps_autoclean_off")
              .setLabel("إلغاء التحديد (تعطيل)")
              .setStyle(ButtonStyle.Secondary)
          )
        ];
        let msg;
        try {
          msg = await interaction.channel.send({
            content: "🧹 **اختر روم التنظيف التلقائي اليومي (سيتم مسح رسائله تلقائياً كل 24 ساعة):**",
            components: rows
          });
        } catch (e) {
          return respond(interaction, {
            content: "❌ **فشل إرسال قائمة الاختيار في هذه القناة!**",
            flags: MessageFlags.Ephemeral
          });
        }
        respond(interaction, {
          content: "📋 **تم فتح قائمة روم التنظيف التلقائي أعلاه.**",
          flags: MessageFlags.Ephemeral
        }).catch(() => {});

        const col = msg.createMessageComponentCollector({
          time: 120000,
          filter: (i) => i.customId === "mps_autoclean_bind" || i.customId === "mps_autoclean_off"
        });

        col.on("collect", async (i) => {
          try {
            if (i.user.id !== interaction.user.id) {
              return i.reply({ content: "❌ **هذه القائمة مخصصة لصاحب اللوحة فقط!**", flags: MessageFlags.Ephemeral }).catch(() => {});
            }
            if (i.customId === "mps_autoclean_bind") {
              const ch = i.values?.[0];
              if (!ch) return;
              config.autoClean = config.autoClean || {};
              config.autoClean[interaction.guildId] = {
                channelId: ch,
                lastClean: Date.now()
              };
              saveConfig(config);
              await i.update({
                content: `✅ **تم تفعيل التنظيف التلقائي اليومي للروم:** <#${ch}>\nسيقوم البوت بحذف جميع الرسائل تلقائياً كل 24 ساعة.`,
                components: []
              });
            } else {
              if (config.autoClean && config.autoClean[interaction.guildId]) {
                delete config.autoClean[interaction.guildId];
                saveConfig(config);
              }
              await i.update({
                content: "✅ **تم إلغاء وتعطيل التنظيف التلقائي للروم بنجاح.**",
                components: []
              });
            }
            col.stop("done");
            setTimeout(() => msg.delete().catch(() => {}), 10000);
          } catch (e) { }
        });

        col.on("end", (_c, r) => {
          if (r === "time") msg.edit({ content: "⏳ **انتهى الوقت. أعد فتح الخيار من اللوحة.**", components: [] }).catch(() => {});
        });
        return;
      }

      case "mp_give_role": {
        const modal = new ModalBuilder()
          .setCustomId("modal_role")
          .setTitle("إعطاء رول لجميع البوتات")
          .addComponents(
            new ActionRowBuilder().addComponents(
              new TextInputBuilder()
                .setCustomId("role_id")
                .setLabel("آيدي الرول (Role ID)")
                .setStyle(TextInputStyle.Short)
                .setRequired(true)
            )
          );
        return interaction.showModal(modal);
      }
    }
  }

  // Handle Modal Submit
  if (interaction.isModalSubmit()) {
    const modalId = interaction.customId;

    if (modalId === "modal_number") {
      const prefixName = interaction.fields.getTextInputValue("prefix_name");
      let count = 1;
      let okCount = 0;
      // Discord usernames reject spaces and '#' - safeRename tries the raw
      // "Bot #1" style first and falls back to a sanitized variant, reporting
      // how many bots were actually renamed.
      for (const client of clientsMap.values()) {
        if (!client.user) continue;
        const desired = `${prefixName} #${count++}`;
        const r = await safeRename(client.user, desired);
        if (r.ok) okCount++;
      }
      return interaction.reply({
        content: okCount > 0
          ? `🔢 **تم تغيير أسماء ${okCount} بوت بالتسلسل:** \`${prefixName} #1 ...\` *(قد تُسوّى الأسماء تلقائياً بدون مسافات/رموز)*`
          : "❌ **فشل تغيير الأسماء - قد تكون محدود معدل التغيير (مرتان/ساعة). حاول لاحقاً.**",
        flags: MessageFlags.Ephemeral
      });
    }

    if (modalId === "modal_server") {
      // Previously this modal had NO submit handler - submitting it always
      // ended in "interaction failed". Now it stores the support-server
      // invite (shown by 12setting / 12setserver).
      const serverInput = interaction.fields.getTextInputValue("server_invite").trim();
      if (!serverInput || serverInput.length > 300) {
        return interaction.reply({
          content: "❌ **رابط/آيدي السيرفر غير صالح!**",
          flags: MessageFlags.Ephemeral
        });
      }
      config.serverInvite = serverInput;
      saveConfig(config);
      return interaction.reply({
        content: `🌐 **تم حفظ سيرفر البوتات (يظهر في \`12setting\` و \`12setserver\`):** ${config.serverInvite}`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (modalId === "modal_game") {
      const gameText = interaction.fields.getTextInputValue("game_text");
      clientsMap.forEach((client) => {
        if (client.user) {
          client.user.setActivity(gameText, { type: 0 });
        }
      });
      return interaction.reply({
        content: `🎮 **تم تغيير حالة اللعب لجميع البوتات إلى: ${gameText}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (modalId === "modal_status") {
      const statusType = interaction.fields.getTextInputValue("status_type").toLowerCase();
      const validStatuses = ["online", "dnd", "idle", "invisible"];
      const targetStatus = validStatuses.includes(statusType) ? statusType : "online";

      clientsMap.forEach((client) => {
        if (client.user) client.user.setStatus(targetStatus);
      });
      return interaction.reply({
        content: `🔄 **تم تغيير حالة جميع البوتات إلى: ${targetStatus.toUpperCase()}**`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (modalId === "modal_owner") {
      const action = interaction.fields.getTextInputValue("action_type").toLowerCase().trim();
      const rawText = interaction.fields.getTextInputValue("owner_id").trim();
      const targetIds = Array.from(new Set(rawText.match(/\d{17,20}/g) || []));

      if (targetIds.length === 0) {
        return interaction.reply({
          content: "❌ **آيدي غير صالح! يجب كتابة آيدي ديسكورد صحيح يتكون من 17 إلى 20 رقماً (يمكنك إدخال حتى 3 آيديات مفصولة بمسافة أو سطر).**",
          flags: MessageFlags.Ephemeral
        });
      }

      if (action === "add") {
        for (const id of targetIds) {
          if (!config.owners.includes(id)) config.owners.push(id);
        }
      } else if (action === "remove") {
        for (const id of targetIds) {
          if (config.owners.length <= 1) {
            return interaction.reply({
              content: "❌ **لا يمكن إزالة الأونر الأخير! يجب أن يبقى مالك واحد على الأقل في البوت.**",
              flags: MessageFlags.Ephemeral
            });
          }
          config.owners = config.owners.filter((oid) => oid !== id);
        }
      } else {
        return interaction.reply({
          content: "❌ **الإجراء غير صالح! الخيارات المتاحة:** `add` / `remove`",
          flags: MessageFlags.Ephemeral
        });
      }
      saveConfig(config);

      const mentions = targetIds.map((id) => `<@${id}>`).join(" ، ");
      return interaction.reply({
        content: `🔑 **تم ${action === "add" ? "إضافة" : "إزالة"} الأونر (${targetIds.length}): ${mentions} بنجاح.**\n*(إجمالي الأونرات الحالي: ${config.owners.length})*`,
        flags: MessageFlags.Ephemeral
      });
    }

    if (modalId === "modal_lang") {
      const v = interaction.fields.getTextInputValue("lang_value").trim().toLowerCase();
      if (!["ar", "en"].includes(v)) {
        return interaction.reply({ content: "❌ **الخيارات المتاحة:** `ar` / `en`", flags: MessageFlags.Ephemeral });
      }
      config.lang = v;
      saveConfig(config);
      return interaction.reply({ content: v === "ar" ? "🌐 **تم تغيير لغة البوت إلى:** `ar` (ردود أوامر الموسيقى ستظهر بالعربية)" : "🌐 **Language switched to:** `en` (music command replies will be in English)", flags: MessageFlags.Ephemeral });
    }

    if (modalId === "modal_platform") {
      const v = interaction.fields.getTextInputValue("platform_value").trim().toLowerCase();
      if (!["youtube", "spotify", "soundcloud"].includes(v)) {
        return interaction.reply({ content: "❌ **الخيارات المتاحة:** `youtube`, `spotify`, `soundcloud`", flags: MessageFlags.Ephemeral });
      }
      config.platform = v;
      saveConfig(config);
      const effect = v === "youtube" ? "البحث بالأسماء سيتم عبر يوتيوب (yt-dlp)" : v === "soundcloud" ? "البحث بالأسماء سيتم عبر ساوندكلاود" : "روابط سبوتيفاي تعمل مباشرة؛ البحث بالأسماء سيستخدم المحرك الافتراضي";
      return interaction.reply({ content: `🔍 **تم تغيير منصة البحث الافتراضية إلى:** \`${v}\`\n(${effect})`, flags: MessageFlags.Ephemeral });
    }

    if (modalId === "modal_prefix") {
      const v = interaction.fields.getTextInputValue("prefix_value").trim();
      if (!v || v.length > 10 || /\s/.test(v)) {
        return interaction.reply({ content: "❌ **البادئة غير صالحة! يجب أن تكون 1-10 أحرف بدون مسافات.**", flags: MessageFlags.Ephemeral });
      }
      config.prefix = v;
      saveConfig(config);
      return interaction.reply({ content: `✅ **تم تغيير بادئة الأوامر إلى:** \`${v}\``, flags: MessageFlags.Ephemeral });
    }

    if (modalId === "modal_role") {
      const roleId = interaction.fields.getTextInputValue("role_id").trim();
      if (!/^\d{17,20}$/.test(roleId)) {
        return interaction.reply({
          content: "❌ **آيدي الرول غير صالح! يجب أن يكون رقماً من 17 إلى 20 خانة.**",
          flags: MessageFlags.Ephemeral
        });
      }
      const guild = interaction.guild;
      if (!guild) {
        return interaction.reply({ content: "❌ هذا الأمر يُنفذ داخل السيرفر فقط.", flags: MessageFlags.Ephemeral });
      }

      let successCount = 0;
      for (const client of clientsMap.values()) {
        try {
          const member = await guild.members.fetch(client.user.id).catch(() => null);
          if (member) {
            await member.roles.add(roleId);
            successCount++;
          }
        } catch (e) { }
      }

      return interaction.reply({
        content: `➕ **تم إعطاء الرول <@&${roleId}> إلى ${successCount} بوت في السيرفر.**`,
        flags: MessageFlags.Ephemeral
      });
    }
  }
}

module.exports = {
  sendPanelMessage,
  handlePanelInteraction
};
