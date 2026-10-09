// Must be required before any src/ module: points state, log, and team context files at a temp
// directory so running the tests never overwrites or deletes a live deployment's runtime files.
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const RUNTIME_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "orchestrator-test-"));

process.env.ORCHESTRATOR_STATE_FILE = path.join(RUNTIME_DIR, "state.json");
process.env.ORCHESTRATOR_LOG_FILE = path.join(RUNTIME_DIR, "orchestrator.log");
process.env.ORCHESTRATOR_TEAM_CONTEXT_DIR = path.join(RUNTIME_DIR, "team_context");
// Tests assert against the published example roles, not a developer's private team.json.
process.env.ORCHESTRATOR_TEAM_CONFIG = path.join(__dirname, "..", "..", "config", "team.example.json");

const STATE_FILE = process.env.ORCHESTRATOR_STATE_FILE;

function stateBackups() {
  return fs.readdirSync(RUNTIME_DIR).filter((name) => name.startsWith("state.json.corrupted-"));
}

function resetStateFiles() {
  for (const name of [path.basename(STATE_FILE), ...stateBackups()]) {
    try { fs.unlinkSync(path.join(RUNTIME_DIR, name)); } catch {}
  }
}

module.exports = { RUNTIME_DIR, STATE_FILE, stateBackups, resetStateFiles };
