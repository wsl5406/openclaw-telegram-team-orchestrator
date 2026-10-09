const fs = require("fs");
const path = require("path");
const { PATHS, roleLabel } = require("./config");
const { compact } = require("./util");

const CONTEXT_FILES = ["tool_policy.md", "current_task.md", "handoffs.md", "decisions.md", "open_questions.md"];

function ensureTeamContextDir() {
  fs.mkdirSync(PATHS.teamContextDir, { recursive: true });
}

function teamContextFile(name) {
  ensureTeamContextDir();
  return path.join(PATHS.teamContextDir, name);
}

function writeTeamContext(name, body) {
  fs.writeFileSync(teamContextFile(name), String(body || "").trim() + "\n", "utf8");
}

function appendTeamContext(name, body, maxChars = 16000) {
  const file = teamContextFile(name);
  const previous = fs.existsSync(file) ? fs.readFileSync(file, "utf8").trim() : "";
  fs.writeFileSync(file, `${previous ? previous + "\n\n" : ""}${String(body || "").trim()}\n`.slice(-maxChars), "utf8");
}

function ensureStaticTeamContextFiles() {
  writeTeamContext("tool_policy.md", [
    "# Tool Policy",
    "- Allowed without extra approval: local_files MCP read/list/search only.",
    "- Allowed without extra approval: internet_research MCP search/fetch only.",
    "- Forbidden without explicit owner approval: write/edit/delete/move/rename files, run shell/system commands, install packages, change config, or send Telegram messages outside Orchestrator.",
    "- If the owner names exact files/code and explicitly asks for a change, approval is scoped to those named targets only.",
    "- If the target is vague, ask for exact target and approval before modifying anything.",
  ].join("\n"));
}

function readTeamContext() {
  const parts = [];
  for (const name of CONTEXT_FILES) {
    const file = teamContextFile(name);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, "utf8").trim();
    if (body) parts.push(`### ${name}\n${body.slice(-1500)}`);
  }
  return parts.length ? `Shared team context files:\n${parts.join("\n\n")}` : "";
}

function standardHandoffBlock(fromRole, toRole, task, reply) {
  return [
    `handoff_at: ${new Date().toISOString()}`,
    `to: ${roleLabel(toRole)}`,
    `from: ${roleLabel(fromRole)}`,
    `task: ${compact(task, 260)}`,
    `current_conclusion: ${compact(reply, 360) || "pending"}`,
    "inputs: Telegram context, shared task board, previous teammate output",
    "boundary: stay inside your role; ask approval before writes/commands/config changes",
    "acceptance: output is usable by the next selected role",
    `next: ${roleLabel(toRole)} continues their own responsibility`,
  ].join("\n");
}

function updateTeamContextFiles(chatId, task, decision, transcript) {
  writeTeamContext("current_task.md", [
    "# Current Task",
    `updated_at: ${new Date().toISOString()}`,
    `chat_id: ${chatId}`,
    `request: ${task}`,
    `mode: ${decision.mode}`,
    `complexity: ${decision.complexity}`,
    `roles: ${decision.roles.map(roleLabel).join(" -> ")}`,
    `stop: ${decision.stop || ""}`,
  ].join("\n"));
  if (transcript.length) {
    appendTeamContext("decisions.md", [
      `## ${new Date().toISOString()}`,
      `task: ${compact(task, 240)}`,
      ...transcript.map((item) => `- ${item.name}: ${compact(item.reply, 320)}`),
    ].join("\n"));
    for (let i = 0; i < decision.roles.length - 1; i += 1) {
      const fromRole = decision.roles[i];
      const toRole = decision.roles[i + 1];
      const source = transcript.find((item) => item.roleId === fromRole);
      if (source) appendTeamContext("handoffs.md", standardHandoffBlock(fromRole, toRole, task, source.reply));
    }
  }
}

module.exports = {
  ensureTeamContextDir,
  ensureStaticTeamContextFiles,
  readTeamContext,
  updateTeamContextFiles,
};
