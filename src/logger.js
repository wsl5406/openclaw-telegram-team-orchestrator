const fs = require("fs");
const { PATHS } = require("./config");

function logEvent(type, payload = {}) {
  const entry = {
    ts: new Date().toISOString(),
    event_type: type,
    ...payload,
  };
  try {
    fs.appendFileSync(PATHS.logFile, JSON.stringify(entry) + "\n", "utf8");
  } catch (err) {
    console.error("[logEvent error]", err.message);
  }
}

module.exports = { logEvent };
