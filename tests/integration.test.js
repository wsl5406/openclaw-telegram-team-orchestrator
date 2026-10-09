const { STATE_FILE, stateBackups, resetStateFiles } = require("./helpers/runtime");
const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");

const { spawnAsync } = require("../src/spawn");
const { TaskQueue } = require("../src/task_queue");
const { sendLong, splitMessage } = require("../src/telegram");
const {
  claimMessage,
  loadState,
  saveState,
  chatState,
  CHAT_STATE,
  HANDLED_MESSAGES,
} = require("../src/state");

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

  test("spawnAsync survives a child that exits without reading stdin", async () => {
    // Writing a large payload to a process that exits immediately raises EPIPE on stdin.
    const res = await spawnAsync(process.execPath, ["-e", "process.exit(0)"], { input: "x".repeat(4 * 1024 * 1024) });
    assert.strictEqual(res.code, 0);
  });

  test("marks an OpenClaw timeout as timed_out", async () => {
    const q = new TaskQueue(2);
    let caught = null;
    const taskId = "task-openclaw-timeout";

    try {
      await q.enqueue("chat-openclaw-test", {
        taskId,
        messageId: 101,
        execute: async () => {
          // Simulate OpenClaw command execution timeout
          const err = new Error("Command timed out after 300ms: wsl.exe openclaw agent");
          err.code = "ETIMEDOUT";
          throw err;
        },
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught !== null, "Task must reject on timeout");
    const status = q.getTaskStatus(taskId);
    assert.ok(status !== null, "Task status must be tracked");
    assert.strictEqual(status.status, "timed_out", "Status must be timed_out");
    assert.strictEqual(status.error_code, "ETIMEDOUT");
    assert.ok(status.durationMs >= 0);
  });

  test("marks an MCP error as failed", async () => {
    const q = new TaskQueue(2);
    let caught = null;
    const taskId = "task-mcp-error";

    try {
      await q.enqueue("chat-mcp-test", {
        taskId,
        messageId: 102,
        execute: async () => {
          // Simulate MCP server error
          const err = new Error("MCP server returned error code -32603: Tool failure");
          err.code = "MCP_ERROR";
          throw err;
        },
      });
    } catch (err) {
      caught = err;
    }

    assert.ok(caught !== null, "Task must reject on MCP error");
    const status = q.getTaskStatus(taskId);
    assert.ok(status !== null, "Task status must be tracked");
    assert.strictEqual(status.status, "failed", "Status must be failed");
    assert.strictEqual(status.error_code, "MCP_ERROR");
    assert.ok(status.error.includes("Tool failure"));
  });

  test("bounds the number of finished task statuses it keeps", async () => {
    const q = new TaskQueue(1, { maxTrackedTasks: 3 });
    for (let i = 0; i < 10; i += 1) {
      await q.enqueue("chat-prune", { taskId: `t${i}`, messageId: i, execute: async () => i });
    }
    // Let the final finally() handler run its prune.
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok(q.taskStatuses.size <= 3, `kept ${q.taskStatuses.size} statuses`);
    assert.ok(q.getTaskStatus("t9"), "most recent task is still tracked");
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

    await sendLong(fakeBot, 12345, "Test rate limit retry message", { fastRetry: true });
    assert.strictEqual(callCount, 2, "Should retry after 429");
  });

  test("retries transient Telegram send failures", async () => {
    let attempts = 0;
    const fakeTransientBot = {
      sendMessage: async () => {
        attempts++;
        if (attempts < 3) {
          const err = new Error("ECONNRESET: socket hang up");
          err.code = "ECONNRESET";
          throw err;
        }
        return { message_id: 456 };
      },
    };

    await sendLong(fakeTransientBot, 12345, "Transient network test", { fastRetry: true });
    assert.strictEqual(attempts, 3, "Must retry failed chunks up to 3 times before succeeding");
  });

  test("sendLong continues smoothly when chunk sending fails permanently", async () => {
    const fakeFailingBot = {
      sendMessage: async () => {
        throw new Error("Permanent network drop");
      },
    };

    // Should not throw unhandled exception
    await sendLong(fakeFailingBot, 12345, "A".repeat(5000), { fastRetry: true });
    assert.ok(true, "sendLong caught errors and finished gracefully");
  });

  test("long messages are split without breaking emoji surrogate pairs", async () => {
    const body = "a".repeat(3799) + "😀" + "b".repeat(10);
    const chunks = splitMessage(body);
    assert.strictEqual(chunks.join(""), body);
    for (const chunk of chunks) {
      const last = chunk.charCodeAt(chunk.length - 1);
      assert.ok(!(last >= 0xd800 && last <= 0xdbff), "chunk must not end with a lone high surrogate");
    }

    const sent = [];
    await sendLong({ sendMessage: async (_id, text) => sent.push(text) }, 1, body, { fastRetry: true });
    assert.strictEqual(sent.join(""), body);
  });
});

describe("Integration Tests: Multi-Bot & Deduplication", () => {
  beforeEach(() => {
    HANDLED_MESSAGES.clear();
  });

  afterEach(() => {
    resetStateFiles();
  });

  test("only one bot successfully claims a broadcast message", async () => {
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

  test("does not execute a duplicate message twice", async () => {
    const testMsg = {
      chat: { id: -100222333444 },
      message_id: 55555,
      from: { id: 12345, is_bot: false },
      text: "测试重复消息",
    };

    const firstClaim = claimMessage(testMsg);
    assert.strictEqual(firstClaim, true, "First message must be accepted");

    const secondClaim = claimMessage(testMsg);
    assert.strictEqual(secondClaim, false, "Duplicate message must be rejected");

    const thirdClaim = claimMessage(testMsg);
    assert.strictEqual(thirdClaim, false, "Repeated message must still be rejected");
  });
});

describe("Integration Tests: Corrupted State Recovery", () => {
  beforeEach(() => {
    resetStateFiles();
  });

  afterEach(() => {
    resetStateFiles();
  });

  test("recovers from a corrupted state file", async () => {
    // 1. Write corrupted content into state.json
    fs.writeFileSync(STATE_FILE, "{ bad json structure: incomplete [", "utf8");

    // 2. Load state, should auto-backup and reset to empty state
    loadState();
    assert.strictEqual(CHAT_STATE.size, 0, "CHAT_STATE must be reset to empty");
    assert.strictEqual(HANDLED_MESSAGES.size, 0, "HANDLED_MESSAGES must be reset to empty");

    // 3. Verify backup file was created
    assert.ok(stateBackups().length >= 1, "Backup file of corrupted state must exist");

    // 4. Save state should now cleanly succeed and create valid JSON
    chatState("recovered-chat-1").recentTurns = [{ name: "lead", reply: "all good" }];
    await saveState();

    assert.ok(fs.existsSync(STATE_FILE), "New state file must exist");
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    assert.ok(parsed.chatState["recovered-chat-1"], "State content must be saved properly");
  });
});
