const { getConfig, getBotChannel247 } = require("./config-store");

const DEFAULT_DELAY_MS = 5000;

function suppressReconnect(client, ms = 15000) {
  client._suppressAutoReconnectUntil = Date.now() + ms;
}

/**
 * Auto-reconnect guard (24/7 pins).
 *
 * Policy: a bot reconnects after a manual disconnect ONLY while it has an
 * active 24/7 pin for that guild. Config is re-read from disk on every event
 * so runtime changes (`12come` / `12leave` / panel joins) take effect
 * immediately instead of being shadowed by a stale startup snapshot.
 */
function attachVoiceGuard(client, distube) {
  client.on("voiceStateUpdate", async (oldState, newState) => {
    try {
      if (!oldState?.guild || oldState.member?.id !== client.user?.id) return;

      const leftChannelId = oldState.channelId;
      // A real manual disconnect: was in a room, now in none.
      // Joins and moves have newState.channelId set - ignore those.
      if (!leftChannelId || newState.channelId) return;

      if (
        client._suppressAutoReconnectUntil &&
        Date.now() < client._suppressAutoReconnectUntil
      ) {
        return;
      }

      const guild = oldState.guild;
      const delayRaw = parseInt(process.env.VOICE_RECONNECT_DELAY_MS, 10);
      const delayMs = Number.isFinite(delayRaw) ? delayRaw : DEFAULT_DELAY_MS;
      await new Promise((resolve) => setTimeout(resolve, delayMs));

      // Re-check after the delay: someone may have reconnected/moved us,
      // or an intentional leave may have started meanwhile.
      let me = guild.members?.me;
      if (!me && typeof guild.members?.fetch === "function") {
        me = await guild.members.fetch(client.user.id).catch(() => null);
      }
      if (!me || me.voice?.channelId) return;

      if (
        client._suppressAutoReconnectUntil &&
        Date.now() < client._suppressAutoReconnectUntil
      ) {
        return;
      }

      // FRESH read every time - never a cached snapshot. Without an active
      // pin the bot stays disconnected: that is what makes `12leave`
      // ("إلغاء 24/7") actually stick when admins kick the bot afterwards.
      const pinnedId = getBotChannel247(getConfig(), guild.id, client.user.id);
      if (!pinnedId) return;

      let target = guild.channels?.cache?.get(pinnedId);
      if (!target && typeof guild.channels?.fetch === "function") {
        target = await guild.channels.fetch(pinnedId).catch(() => null);
      }
      if (!target) return; // pinned room was deleted - nothing to rejoin

      await distube.voices.join(target);
      console.log(
        `🔁 [${client.user.username}] Reconnected to "${target.name || target.id}" after manual disconnect.`
      );
    } catch (err) {
      console.error("❌ Voice guard error:", err?.message || err);
    }
  });
}

module.exports = { attachVoiceGuard, suppressReconnect };
