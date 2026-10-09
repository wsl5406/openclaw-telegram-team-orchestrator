const TelegramBot = require("node-telegram-bot-api");
const { TEAM, MEMBERS, validateStartupConfig } = require("./config");
const { logEvent } = require("./logger");
const { loadState } = require("./state");
const { ensureTeamContextDir, ensureStaticTeamContextFiles } = require("./team_context");
const { handleMessage } = require("./pipeline");

function printStartupSecurityCheck() {
  const roots = (process.env.OPENCLAW_FILE_ROOTS || (process.platform === "win32" ? "C:\\;D:\\" : "/mnt/c;/mnt/d"))
    .split(";")
    .map((r) => r.trim())
    .filter(Boolean);
  console.log("==================================================");
  console.log("🛡️  OpenClaw Telegram Team Orchestrator Startup Check");
  console.log("==================================================");
  console.log(`[Config] Master User ID      : ${TEAM.masterUserId}`);
  console.log(`[Config] Telegram Group ID   : ${TEAM.groupId}`);
  console.log(`[Config] Owner Display Name  : ${TEAM.ownerName}`);
  console.log(`[Config] Router Provider     : ${TEAM.routerProvider}`);
  console.log(`[Config] Active Roles        : ${MEMBERS.map((m) => `${m.id}(${m.name})`).join(", ")}`);
  console.log(`[Security] Allowed File Roots: ${roots.join(", ")}`);
  console.log("[Security] Blocked Dirs      : .git, .ssh, .aws, .azure, .gcp, .kube, .docker, cookies, backups, 1password, etc.");
  console.log("[Security] Blocked Suffixes  : .env*, .token, .secret, .credentials, .config, .bak, .key, .pem, .sqlite, .kdbx, etc.");
  console.log("[Security] Network Boundary  : Public HTTP/HTTPS only, blocked private/internal/cloud metadata addresses");
  console.log("==================================================");
}

async function main() {
  validateStartupConfig();
  loadState();
  ensureTeamContextDir();
  ensureStaticTeamContextFiles();
  printStartupSecurityCheck();
  const bots = {};
  for (const member of MEMBERS) {
    bots[member.id] = new TelegramBot(member.token, { polling: true });
    bots[member.id].on("message", (msg) => handleMessage(member.id, msg, bots).catch((err) => {
      logEvent("message_failed", { role_id: member.id, error: err.message });
      console.error(err);
    }));
    bots[member.id].on("polling_error", (err) => {
      logEvent("polling_error", { role_id: member.id, error: err.message });
      console.error(`[polling_error] ${member.name} (${member.id}):`, err.message);
    });
    console.log(`started ${member.name} (${member.id})`);
  }
  console.log("Telegram team orchestrator is running.");
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { main };
