function compact(text, max = 260) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

module.exports = { compact, escapeRegExp, sleep };
