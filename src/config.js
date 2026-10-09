const fs = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

function optionalEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function teamConfigFile() {
  const override = optionalEnv("ORCHESTRATOR_TEAM_CONFIG");
  if (override) return path.resolve(ROOT, override);
  const configFile = path.join(CONFIG_DIR, "team.json");
  return fs.existsSync(configFile) ? configFile : path.join(CONFIG_DIR, "team.example.json");
}

function loadTeamConfig() {
  const config = loadJson(teamConfigFile());
  const ownerName = optionalEnv(config.ownerNameEnv || "OWNER_DISPLAY_NAME", "Owner");
  const members = (config.members || []).map((member) => ({
    ...member,
    name: member.displayName || member.name || member.id,
    token: optionalEnv(member.tokenEnv, ""),
    username: optionalEnv(member.usernameEnv, member.username || ""),
    aliases: member.aliases || [],
  }));
  const masterUserIdRaw = optionalEnv("MASTER_USER_ID", "");
  const masterUserId = masterUserIdRaw ? Number(masterUserIdRaw.trim()) : 0;
  return {
    ...config,
    ownerName,
    masterUserId,
    groupId: optionalEnv(config.telegramGroupIdEnv || "TELEGRAM_GROUP_ID", ""),
    routerProvider: optionalEnv(config.routerProviderEnv || "ROUTER_PROVIDER", "api2"),
    defaultRoleId: config.defaultRoleId || members[0]?.id,
    members,
  };
}

loadEnvFile();
const TEAM = loadTeamConfig();
const MEMBERS = TEAM.members;

// Runtime files default to the repo root; overridable so tests never touch a live deployment's state.
const PATHS = {
  root: ROOT,
  teamContextDir: path.resolve(ROOT, optionalEnv("ORCHESTRATOR_TEAM_CONTEXT_DIR", "team_context")),
  stateFile: path.resolve(ROOT, optionalEnv("ORCHESTRATOR_STATE_FILE", "state.json")),
  logFile: path.resolve(ROOT, optionalEnv("ORCHESTRATOR_LOG_FILE", "orchestrator.log")),
};

function validateStartupConfig() {
  const masterUserIdRaw = requiredEnv("MASTER_USER_ID");
  if (!/^\d+$/.test(masterUserIdRaw.trim())) {
    throw new Error(`MASTER_USER_ID must be a numeric Telegram user ID, got: ${masterUserIdRaw}`);
  }
  TEAM.masterUserId = Number(masterUserIdRaw.trim());
  TEAM.groupId = requiredEnv(TEAM.telegramGroupIdEnv || "TELEGRAM_GROUP_ID");
  for (const member of MEMBERS) {
    if (!member.token) {
      member.token = requiredEnv(member.tokenEnv);
    }
  }
}

function providerConfig(name) {
  const prefix = String(name || "").toUpperCase();
  return {
    name,
    baseUrl: optionalEnv(`${prefix}_BASE_URL`),
    apiKey: optionalEnv(`${prefix}_KEY`),
    model: optionalEnv(`${prefix}_MODEL`),
  };
}

function providerReady(provider) {
  return Boolean(provider.baseUrl && provider.apiKey && provider.model);
}

function providerForMember(member) {
  return providerConfig(member.provider || "api2");
}

function memberById(id) {
  return MEMBERS.find((member) => member.id === id);
}

function roleLabel(id) {
  return memberById(id)?.name || id;
}

module.exports = {
  ROOT,
  PATHS,
  TEAM,
  MEMBERS,
  optionalEnv,
  requiredEnv,
  loadTeamConfig,
  validateStartupConfig,
  providerConfig,
  providerReady,
  providerForMember,
  memberById,
  roleLabel,
};
