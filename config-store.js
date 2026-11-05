// Shared config store - single source of truth for reading/writing config.json
// and managing per-bot 24/7 voice-channel pins.
const fs = require("fs");
const path = require("path");

// config.json is runtime state and is intentionally not committed. Hosting
// platforms commonly deploy only tracked files, so bootstrap it from the
// safe example file when it is missing. CONFIG_PATH can be used when the
// platform mounts writable persistent storage elsewhere.
const configPath = process.env.CONFIG_PATH
  ? path.resolve(process.env.CONFIG_PATH)
  : path.join(__dirname, "config.json");
const exampleConfigPath = path.join(__dirname, "config.example.json");

function parseOwnerIds() {
  return String(process.env.OWNER_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter((id) => /^\d{17,20}$/.test(id));
}

function createDefaultConfig() {
  let config = {};
  try {
    config = JSON.parse(fs.readFileSync(exampleConfigPath, "utf-8"));
  } catch (err) {
    console.error("❌ Could not read config.example.json:", err.message);
  }

  const ownerIds = parseOwnerIds();
  if (ownerIds.length > 0) config.owners = ownerIds;
  normalizeConfig(config);
  return config;
}

function ensureConfig() {
  if (fs.existsSync(configPath)) return;
  const config = createDefaultConfig();
  try {
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), "utf-8");
    console.warn(`⚠️ ${path.basename(configPath)} was missing; created it from config.example.json.`);
  } catch (err) {
    // A read-only mount should not prevent startup. The in-memory config can
    // still run, but settings changed from Discord cannot be persisted.
    console.warn(`⚠️ Could not create ${path.basename(configPath)}: ${err.message}`);
  }
}

// Defensive normalization - prevents crashes from malformed/missing keys.
// Also migrates legacy guild-wide 24/7 entries ("guildId": "channelId")
// to the per-bot format ("guildId": { "__all__": "channelId" }) so that
// multiple bots can be pinned to DIFFERENT rooms in the same guild.
function normalizeConfig(config) {
  if (!Array.isArray(config.owners)) config.owners = [];
  if (!config.chatChannels || typeof config.chatChannels !== "object") config.chatChannels = {};
  if (!config.twentyFourSeven || typeof config.twentyFourSeven !== "object") config.twentyFourSeven = {};
  if (!config.autoClean || typeof config.autoClean !== "object") config.autoClean = {};
  if (typeof config.serverInvite !== "string") config.serverInvite = "";
  for (const gid of Object.keys(config.twentyFourSeven)) {
    const v = config.twentyFourSeven[gid];
    if (typeof v === "string") {
      // Legacy format: one channel for all bots in this guild
      config.twentyFourSeven[gid] = { __all__: v };
    } else if (!v || typeof v !== "object" || Array.isArray(v)) {
      delete config.twentyFourSeven[gid];
    }
  }
}

function getConfig() {
  ensureConfig();
  let config;
  try {
    config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
  } catch (err) {
    console.error(`❌ Invalid ${path.basename(configPath)}; using defaults:`, err.message);
    config = createDefaultConfig();
  }
  normalizeConfig(config);
  return config;
}

function saveConfig(config) {
  const tempPath = `${configPath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(config, null, 2), "utf-8");
  fs.renameSync(tempPath, configPath);
}

function isOwner(userId, config) {
  return Array.isArray(config.owners) && config.owners.includes(userId);
}

// --- Per-bot 24/7 helpers ---------------------------------------------
// Resolves a bot's pinned room: its own entry first, then the legacy
// guild-wide entry ("__all__"), otherwise null.
function getBotChannel247(config, guildId, botId) {
  const entry = config.twentyFourSeven[guildId];
  if (!entry) return null;
  return entry[botId] || entry.__all__ || null;
}

function setBotChannel247(config, guildId, botId, channelId) {
  const entry = config.twentyFourSeven[guildId];
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
    config.twentyFourSeven[guildId] = {};
  }
  config.twentyFourSeven[guildId][botId] = channelId;
}

function clearBotChannel247(config, guildId, botId) {
  const entry = config.twentyFourSeven[guildId];
  if (!entry) return;
  delete entry[botId];
  if (Object.keys(entry).length === 0) delete config.twentyFourSeven[guildId];
}

module.exports = {
  normalizeConfig,
  configPath,
  getConfig,
  saveConfig,
  isOwner,
  getBotChannel247,
  setBotChannel247,
  clearBotChannel247
};
