const fs = require("fs");
const { PATHS, roleLabel } = require("./config");
const { logEvent } = require("./logger");
const { compact } = require("./util");

const HANDLED_MESSAGES = new Map();
const CHAT_STATE = new Map();
const MESSAGE_DEDUP_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

let saveInFlight = null;
let saveQueued = null;

function loadState() {
  const stateFile = PATHS.stateFile;
  if (!fs.existsSync(stateFile)) return;
  try {
    const data = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    if (data.chatState && typeof data.chatState === "object") {
      for (const [chatId, state] of Object.entries(data.chatState)) {
        CHAT_STATE.set(chatId, state);
      }
    }
    if (data.processedMessages && typeof data.processedMessages === "object") {
      const now = Date.now();
      for (const [key, ts] of Object.entries(data.processedMessages)) {
        if (now - ts < MESSAGE_DEDUP_TTL_MS) {
          HANDLED_MESSAGES.set(key, ts);
        }
      }
    }
  } catch (err) {
    console.error("[state] Corrupted state.json detected. Backing up and resetting:", err.message);
    try {
      const backupPath = `${stateFile}.corrupted-${Date.now()}.bak`;
      fs.renameSync(stateFile, backupPath);
      logEvent("state_corrupted_backup", { backupPath, error: err.message });
    } catch {}
    CHAT_STATE.clear();
    HANDLED_MESSAGES.clear();
  }
}

async function writeStateFile() {
  try {
    const now = Date.now();
    const processedMessages = {};
    for (const [key, ts] of HANDLED_MESSAGES.entries()) {
      if (now - ts < MESSAGE_DEDUP_TTL_MS) {
        processedMessages[key] = ts;
      }
    }
    const data = {
      savedAt: new Date().toISOString(),
      chatState: Object.fromEntries(CHAT_STATE.entries()),
      processedMessages,
    };
    const tmpFile = `${PATHS.stateFile}.tmp`;
    await fs.promises.writeFile(tmpFile, JSON.stringify(data, null, 2), "utf8");
    await fs.promises.rename(tmpFile, PATHS.stateFile);
  } catch (err) {
    console.error("[state] Atomic save failed:", err.message);
    logEvent("state_save_failed", { error: err.message });
  }
}

// Saves requested during an in-flight write all share one follow-up write, so every caller resolves
// and the last snapshot always reaches disk.
function saveState() {
  if (saveInFlight) {
    if (!saveQueued) {
      saveQueued = saveInFlight.then(() => {
        saveQueued = null;
        return saveState();
      });
    }
    return saveQueued;
  }
  saveInFlight = writeStateFile().finally(() => {
    saveInFlight = null;
  });
  return saveInFlight;
}

function chatState(chatId) {
  const key = String(chatId);
  if (!CHAT_STATE.has(key)) CHAT_STATE.set(key, { recentTurns: [], board: null });
  return CHAT_STATE.get(key);
}

function claimMessage(msg) {
  const key = `${msg.chat.id}:${msg.message_id}`;
  const now = Date.now();
  for (const [item, timestamp] of HANDLED_MESSAGES.entries()) {
    if (now - timestamp > MESSAGE_DEDUP_TTL_MS) HANDLED_MESSAGES.delete(item);
  }
  if (HANDLED_MESSAGES.has(key)) return false;
  HANDLED_MESSAGES.set(key, now);
  saveState();
  return true;
}

function rememberTurn(chatId, roleId, task, reply) {
  const state = chatState(chatId);
  state.lastSpeaker = roleId;
  state.recentTurns = [
    ...(state.recentTurns || []),
    {
      roleId,
      name: roleLabel(roleId),
      task: compact(task, 300),
      reply: compact(reply, 1200),
      ts: new Date().toISOString(),
    },
  ].slice(-8);
  saveState();
}

function updateBoard(chatId, task, decision, transcript) {
  const state = chatState(chatId);
  state.board = {
    topic: compact(task, 200),
    participants: decision.roles,
    lastOutputs: Object.fromEntries(transcript.map((item) => [item.roleId, compact(item.reply, 360)])),
    updatedAt: new Date().toISOString(),
  };
  return saveState();
}

module.exports = {
  HANDLED_MESSAGES,
  CHAT_STATE,
  MESSAGE_DEDUP_TTL_MS,
  loadState,
  saveState,
  chatState,
  claimMessage,
  rememberTurn,
  updateBoard,
};
