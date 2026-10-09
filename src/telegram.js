const { logEvent } = require("./logger");
const { sleep } = require("./util");

const MAX_CHUNK_LENGTH = 3800;

// Splits text into Telegram-sized chunks without cutting a UTF-16 surrogate pair (emoji etc.) in half.
function splitMessage(text, maxLength = MAX_CHUNK_LENGTH) {
  const chunks = [];
  let start = 0;
  while (start < text.length) {
    let end = Math.min(start + maxLength, text.length);
    const last = text.charCodeAt(end - 1);
    if (end < text.length && last >= 0xd800 && last <= 0xdbff) end -= 1;
    chunks.push(text.slice(start, end));
    start = end;
  }
  return chunks;
}

async function sendLong(bot, chatId, text, options = {}) {
  const body = String(text || "").trim() || "No effective result.";
  const maxRetries = options.maxRetries ?? 3;
  const baseBackoffMs = options.baseBackoffMs ?? 1000;
  const chunks = splitMessage(body);

  for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
    const chunk = chunks[chunkIndex];
    let sent = false;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await bot.sendMessage(chatId, chunk);
        sent = true;
        break;
      } catch (err) {
        const statusCode = err.response?.statusCode;
        const retryAfter = err.response?.body?.parameters?.retry_after;
        const isRateLimit = statusCode === 429 || Boolean(retryAfter);

        if (isRateLimit) {
          const waitTimeMs = options.fastRetry ? 50 : (Number(retryAfter || 2) + 1) * 1000;
          logEvent("telegram_rate_limited", {
            chat_id: chatId,
            chunk_index: chunkIndex,
            attempt,
            wait_time_ms: waitTimeMs,
            status: "waiting",
          });
          await sleep(waitTimeMs);
        } else {
          const backoffMs = options.fastRetry ? 10 : Math.min(baseBackoffMs * Math.pow(2, attempt - 1), 10000);
          logEvent("telegram_send_retry", {
            chat_id: chatId,
            chunk_index: chunkIndex,
            attempt,
            error: err.message,
            backoff_ms: backoffMs,
          });
          await sleep(backoffMs);
        }
      }
    }

    if (!sent) {
      logEvent("telegram_send_chunk_failed", {
        chat_id: chatId,
        chunk_index: chunkIndex,
        error_code: "SEND_CHUNK_FAILED",
        status: "failed",
      });
    }
  }
}

module.exports = { splitMessage, sendLong };
