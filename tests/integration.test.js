const { test, describe } = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const fs = require("node:fs");

const {
  spawnAsync,
  TaskQueue,
  sendLong,
  claimMessage,
  loadState,
  HANDLED_MESSAGES,
} = require("../src/openclaw_orchestrator.js");

const ROOT = path.resolve(__dirname, "..");

describe("Integration Tests: Async Queue & Timeout Handling", () => {
  test("spawnAsync terminates process when timeout is reached", async () => {
    const startTime = Date.now();
    let caughtErr = null;
    try {
      await spawnAsync(
        process.platform === "win32" ? "powershell.exe" : "sleep",
        process.platform === "win32" ? ["-Command", "Start-Sleep -Seconds 5"] : ["5"],
        { timeout: 500 }
      );
    } catch (err) {
      caughtErr = err;
    }
    const elapsed = Date.now() - startTime;
    assert.ok(caughtErr !== null, "Timeout error must be thrown");
    assert.strictEqual(caughtErr.code, "ETIMEDOUT");
    assert.ok(elapsed < 3000, `Process should be killed quickly, took ${elapsed}ms`);
  });

  test("TaskQueue handles timeouts and marks task as timed_out", async () => {
    const q = new TaskQueue(2);
    let caught = null;
    try {
      await q.enqueue("chat-timeout-test", {
        taskId: "task-timeout-1",
        messageId: 999,
        execute: async () => {
          await spawnAsync(
            process.platform === "win32" ? "powershell.exe" : "sleep",
            process.platform === "win32" ? ["-Command", "Start-Sleep -Seconds 4"] : ["4"],
            { timeout: 400 }
          );
        },
      });
    } catch (err) {
      caught = err;
    }
    assert.ok(caught !== null);
    const status = q.getTaskStatus("task-timeout-1");
    assert.ok(status !== null);
    assert.strictEqual(status.status, "timed_out");
  });
});

describe("Integration Tests: Telegram Rate Limiting & Retry Backoff", () => {
  test("sendLong retries with backoff on 429 rate limit", async () => {
    let callCount = 0;
    const fakeBot = {
      sendMessage: async (_chatId, _text) => {
        callCount++;
        if (callCount === 1) {
          const err = new Error("Too Many Requests");
          err.response = {
            statusCode: 429,
            body: { parameters: { retry_after: 1 } },
          };
          throw err;
        }
        return { message_id: 123 };
      },
    };

    const start = Date.now();
    await sendLong(fakeBot, 12345, "Test rate limit retry message", { fastRetry: true });
    const duration = Date.now() - start;

    assert.strictEqual(callCount, 2, "Should retry after 429");
  });

  test("sendLong continues smoothly when chunk sending fails", async () => {
    const fakeFailingBot = {
      sendMessage: async () => {
        throw new Error("Permanent network drop");
      },
    };

    // Should not throw unhandled exception
    await sendLong(fakeFailingBot, 12345, "A".repeat(5000), { fastRetry: true });
    assert.ok(true, "sendLong caught errors and finished gracefully");
  });
});

describe("Integration Tests: Multi-Bot Concurrent Message Deduplication", () => {
  test("only one bot successfully claims a broadcast message", async () => {
    HANDLED_MESSAGES.clear();
    const broadcastMsg = {
      chat: { id: -1001928374 },
      message_id: 8888,
    };

    // Simulate 5 bots simultaneously receiving the exact same message event
    const results = await Promise.all([
      Promise.resolve(claimMessage(broadcastMsg)),
      Promise.resolve(claimMessage(broadcastMsg)),
      Promise.resolve(claimMessage(broadcastMsg)),
      Promise.resolve(claimMessage(broadcastMsg)),
      Promise.resolve(claimMessage(broadcastMsg)),
    ]);

    const claimedCount = results.filter(Boolean).length;
    assert.strictEqual(claimedCount, 1, "Exactly one bot should successfully claim the message");
  });
});
