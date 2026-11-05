// Minimal i18n layer for the most common user-facing music command replies.
// Owner/panel management commands remain Arabic-only (they are used by the
// person configuring the fleet); player event announcements in index.js are
// also Arabic-only for now - this covers the hot interaction paths.
//
// Usage:
//   const t = makeT(config.lang);
//   replyMessage(message, t("volumeSet", 50), config);

const ar = {
  // Voice / permission checks
  notInVoice: () => "❌ **عذراً، يجب أن تكون متواجداً داخل روم صوتي لاستخدام هذا الأمر!**",
  deafened: () => "🚫 **ممنوع استخدام البوت أو تشغيل الأغاني وأنت مدفن (Deafened)! يرجى إلغاء التدفين وإعادة المحاولة.**",
  noConnect: (b, ch) => `❌ **البوت \`${b}\` لا يملك صلاحية الانضمام (Connect) إلى الروم الصوتي:** <#${ch}>`,
  noSpeak: (b, ch) => `❌ **البوت \`${b}\` لا يملك صلاحية التحدث (Speak) داخل الروم الصوتي:** <#${ch}>`,
  sameRoom: (ch) => `❌ **عذراً، يجب أن تكون متواجداً في نفس الروم الصوتي مع البوت (<#${ch}>)!**`,

  // Playback state
  nothingPlaying: () => "❌ **لا يوجد شيء يتم تشغيله حالياً!**",
  searchingPlay: (q) => `🔍 **جاري البحث والتشغيل:** \`${q}\` ...`,
  playFailed: (e) => `❌ **لم يتم العثور على الأغنية أو حدث خطأ:** ${e}`,
  botCheckFix: () =>
    "🤖 **يوتيوب يطلب التحقق من أنك لست روبوتاً وحجب التشغيل! (bot-check)**\n" +
    "**الحل الدائم (مرة واحدة فقط):**\n" +
    "1️⃣ شغّل الأمر `npm run cookies` داخل مجلد البوت (أو صدّر كوكيز youtube.com بإضافة متصفح إلى ملف `cookies.txt` بجانب `index.js`).\n" +
    "2️⃣ أعد تشغيل البوت.\n" +
    "📄 التفاصيل الكاملة في `README.md` قسم **YouTube Cookies**.",
  stopped: () => "⏹️ **تم إيقاف التشغيل ومسح قائمة الأغاني.**",
  skipped: () => "⏭️ **تم تخطي الأغنية الحالية بنجاح.**",
  skipFailed: () => "❌ **تعذر تخطي الأغنية الحالية!**",
  autoplayOn: () => "🔄 **تم تفعيل التشغيل التلقائي (Autoplay).**",
  autoplayOff: () => "🔄 **تم تعطيل التشغيل التلقائي (Autoplay).**",

  // Volume
  volumeCurrent: (v) => `🔊 **الصوت الحالي:** \`${v}%\` | **الاستخدام:** \`volume <0-200>\``,
  volumeSet: (v) => `🔊 **تم تغيير مستوى الصوت إلى:** \`${v}%\``,

  // Loop
  loopQueue: () => "قائمة الانتظار (Queue)",
  loopSong: () => "الأغنية الحالية (Song)",
  loopOff: () => "معطل (Off)",
  loopSet: (m) => `🔁 **تم ضبط تكرار التشغيل على:** \`${m}\``,

  // Seek
  seekUsage: () => "❌ **الاستخدام الصحيح:** `seek <العدد بالثواني>`",
  seekInvalid: () => "❌ **يرجى إدخال عدد ثوانٍ صحيح (0 أو أكثر).**",
  seekDone: (t) => `⏩ **تم تقديم الأغنية إلى:** \`${t}\` ثانية.`,

  // Filters
  filtersList: (names) => `🎛️ **الفلاتر المتاحة:** \`3d, bassboost, echo, karaoke, nightcore, vaporwave, flanger, off\`\nالفلتر المطبق حالياً: \`${names || "لا يوجد"}\``,
  filterCleared: () => "🎛️ **تم إيقاف جميع الفلاتر الصوتية.**",
  filterRemoved: (f) => `🎛️ **تم إزالة الفلتر:** \`${f}\``,
  filterSet: (f) => `🎛️ **تم تفعيل الفلتر:** \`${f}\``,
  filterUnknown: (f) => `❌ **فلتر غير معروف:** \`${f}\``,

  // Queue
  shuffled: () => "🔀 **تم خلط قائمة الأغاني بنجاح!**",
  cleared: () => "🗑️ **تم تفريغ قائمة الأغاني القادمة.**",
  queueEmpty: () => "📜 **قائمة الانتظار فارغة حالياً.**",

  // Pause / resume
  pauseAlready: () => "⏸️ **التشغيل متوقف مؤقتاً بالفعل!**",
  paused: () => "⏸️ **تم إيقاف التشغيل مؤقتاً.**",
  resumeAlready: () => "▶️ **التشغيل يعمل بالفعل!**",
  resumed: () => "▶️ **تم إستئناف التشغيل.**",

  // Come / leave
  comePinned: (b, ch) => `✅ **تم الانضمام وتثبيت البوت \`${b}\` 24/7 في الروم الصوتي:** <#${ch}>`,
  comeFailed: (e) => `❌ **فشل الانضمام إلى الروم الصوتي:** ${e}`,
  leaveDone: (b) => `👋 **تم مغادرة البوت \`${b}\` للروم الصوتي وإلغاء وضع 24/7 الخاص به.**`,
  leaveNotConnected: (b) => `ℹ️ **البوت \`${b}\` لم يكن متصلاً بأي روم؛ تم إلغاء تثبيت 24/7 الخاص به.**`,

  // Misc
  ping: (p) => `🏓 **سرعة استجابة البوت (Ping):** \`${p}ms\``
};

const en = {
  notInVoice: () => "❌ **You must be in a voice channel to use this command!**",
  deafened: () => "🚫 **You cannot use the bot while deafened! Please undeafen and try again.**",
  noConnect: (b, ch) => `❌ **Bot \`${b}\` lacks the Connect permission for:** <#${ch}>`,
  noSpeak: (b, ch) => `❌ **Bot \`${b}\` lacks the Speak permission in:** <#${ch}>`,
  sameRoom: (ch) => `❌ **You must be in the same voice channel as the bot (<#${ch}>)!**`,

  nothingPlaying: () => "❌ **Nothing is currently playing!**",
  searchingPlay: (q) => `🔍 **Searching & playing:** \`${q}\` ...`,
  playFailed: (e) => `❌ **Song not found or an error occurred:** ${e}`,
  botCheckFix: () =>
    "🤖 **YouTube is asking to verify you're not a bot (bot-check) and blocked playback!**\n" +
    "**Permanent fix (one time only):**\n" +
    "1️⃣ Run `npm run cookies` in the bot folder (or export youtube.com cookies with a browser extension into `cookies.txt` next to `index.js`).\n" +
    "2️⃣ Restart the bot.\n" +
    "📄 Full details in `README.md`, section **YouTube Cookies**.",
  stopped: () => "⏹️ **Playback stopped and queue cleared.**",
  skipped: () => "⏭️ **Skipped the current song.**",
  skipFailed: () => "❌ **Could not skip the current song!**",
  autoplayOn: () => "🔄 **Autoplay enabled.**",
  autoplayOff: () => "🔄 **Autoplay disabled.**",

  volumeCurrent: (v) => `🔊 **Current volume:** \`${v}%\` | **Usage:** \`volume <0-200>\``,
  volumeSet: (v) => `🔊 **Volume set to:** \`${v}%\``,

  loopQueue: () => "Queue",
  loopSong: () => "Current song",
  loopOff: () => "Off",
  loopSet: (m) => `🔁 **Repeat mode set to:** \`${m}\``,

  seekUsage: () => "❌ **Correct usage:** `seek <seconds>`",
  seekInvalid: () => "❌ **Please enter a valid number of seconds (0 or more).**",
  seekDone: (t) => `⏩ **Seeked to:** \`${t}\`s.`,

  filtersList: (names) => `🎛️ **Available filters:** \`3d, bassboost, echo, karaoke, nightcore, vaporwave, flanger, off\`\nActive filters: \`${names || "none"}\``,
  filterCleared: () => "🎛️ **All audio filters cleared.**",
  filterRemoved: (f) => `🎛️ **Filter removed:** \`${f}\``,
  filterSet: (f) => `🎛️ **Filter applied:** \`${f}\``,
  filterUnknown: (f) => `❌ **Unknown filter:** \`${f}\``,

  shuffled: () => "🔀 **Queue shuffled successfully!**",
  cleared: () => "🗑️ **Upcoming songs cleared.**",
  queueEmpty: () => "📜 **The queue is currently empty.**",

  pauseAlready: () => "⏸️ **Playback is already paused!**",
  paused: () => "⏸️ **Playback paused.**",
  resumeAlready: () => "▶️ **Playback is already running!**",
  resumed: () => "▶️ **Playback resumed.**",

  comePinned: (b, ch) => `✅ **Joined and pinned bot \`${b}\` 24/7 in:** <#${ch}>`,
  comeFailed: (e) => `❌ **Failed to join the voice channel:** ${e}`,
  leaveDone: (b) => `👋 **Bot \`${b}\` left the voice channel and its 24/7 pin was removed.**`,
  leaveNotConnected: (b) => `ℹ️ **Bot \`${b}\` was not connected; its 24/7 pin was removed.**`,

  ping: (p) => `🏓 **Bot latency (Ping):** \`${p}ms\``
};

const strings = { ar, en };

/**
 * Build a translate function bound to a language.
 * Falls back to Arabic when a key/lang is missing.
 */
function makeT(lang) {
  const pack = strings[lang] || strings.ar;
  return (key, ...args) => {
    const fn = pack[key] || strings.ar[key];
    return typeof fn === "function" ? fn(...args) : "";
  };
}

/** Detect YouTube "Sign in to confirm you're not a bot" style failures. */
function isBotCheckError(msg) {
  return /sign in to confirm|not a bot|please sign in/i.test(String(msg || ""));
}

module.exports = { makeT, isBotCheckError };
