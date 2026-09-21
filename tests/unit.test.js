const { test, describe, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { execFileSync } = require("node:child_process");

const ROOT = path.resolve(__dirname, "..");
const {
  TEAM,
  MEMBERS,
  normalizeDecision,
  fallbackDecision,
  mentionedAgents,
  isAllMembersCall,
  claimMessage,
  loadState,
  saveState,
  chatState,
  CHAT_STATE,
  HANDLED_MESSAGES,
} = require("../src/openclaw_orchestrator.js");

describe("Unit Tests: Routing & Role Matching", () => {
  test("matches Chinese and English role aliases", () => {
    assert.ok(mentionedAgents("请产品经理看一下").includes("pm"));
    assert.ok(mentionedAgents("Please check the PRD").includes("pm"));
    assert.ok(mentionedAgents("架构师怎么看").includes("architect"));
    assert.ok(mentionedAgents("system design review").includes("architect"));
    assert.ok(mentionedAgents("开发工程师写一下代码").includes("engineer"));
    assert.ok(mentionedAgents("developer please fix this bug").includes("engineer"));
    assert.ok(mentionedAgents("QA测试验收一下").includes("qa"));
    assert.ok(mentionedAgents("tester verify the release").includes("qa"));
    assert.ok(mentionedAgents("队长协调一下").includes("lead"));
    assert.ok(mentionedAgents("team lead please coordinate").includes("lead"));
  });

  test("detects all members call in Chinese and English", () => {
    assert.strictEqual(isAllMembersCall("@all 大家出来讨论一下"), true);
    assert.strictEqual(isAllMembersCall("所有人一起看一下"), true);
    assert.strictEqual(isAllMembersCall("everyone please join the discussion"), true);
    assert.strictEqual(isAllMembersCall("all hands meeting"), true);
    assert.strictEqual(isAllMembersCall("单聊一下"), false);
  });

  test("fallback routing correctly assigns mode, complexity and roles", () => {
    // Single explicit mention with simple ping
    const singlePing = fallbackDecision("你好", ["pm"], false);
    assert.strictEqual(singlePing.mode, "single");
    assert.strictEqual(singlePing.complexity, "small");
    assert.deepStrictEqual(singlePing.roles, ["pm"]);

    // All hands call
    const allHands = fallbackDecision("大家讨论一下技术方案", [], true);
    assert.strictEqual(allHands.mode, "team");
    assert.ok(allHands.roles.length >= 2);

    // Multi-role keywords: product + code
    const multi = fallbackDecision("设计产品需求并写代码实现", [], false);
    assert.strictEqual(multi.mode, "team");
    assert.ok(multi.roles.includes("pm"));
    assert.ok(multi.roles.includes("engineer"));
  });

  test("normalizeDecision guarantees valid roles and bounds", () => {
    const raw = { roles: ["unknown_role", "pm"], complexity: "invalid" };
    const norm = normalizeDecision(raw, ["pm"], false, "需求");
    assert.ok(norm.roles.includes("pm"));
    assert.ok(!norm.roles.includes("unknown_role"));
    assert.ok(["small", "medium", "large"].includes(norm.complexity));
  });
});

describe("Unit Tests: Message Deduplication & State Recovery", () => {
  const testStateFile = path.join(ROOT, "state.json");

  beforeEach(() => {
    HANDLED_MESSAGES.clear();
    CHAT_STATE.clear();
  });

  afterEach(() => {
    if (fs.existsSync(testStateFile)) {
      try { fs.unlinkSync(testStateFile); } catch {}
    }
    const backups = fs.readdirSync(ROOT).filter((f) => f.startsWith("state.json.corrupted-"));
    for (const b of backups) {
      try { fs.unlinkSync(path.join(ROOT, b)); } catch {}
    }
  });

  test("claimMessage deduplicates repeated messages", () => {
    const msg = { chat: { id: 1001 }, message_id: 2001 };
    assert.strictEqual(claimMessage(msg), true);
    // Second attempt should be rejected
    assert.strictEqual(claimMessage(msg), false);
  });

  test("recovers gracefully from corrupted state.json", async () => {
    fs.writeFileSync(testStateFile, "{ invalid json content missing brace", "utf8");
    loadState();
    assert.strictEqual(CHAT_STATE.size, 0);
    assert.strictEqual(HANDLED_MESSAGES.size, 0);

    const backups = fs.readdirSync(ROOT).filter((f) => f.startsWith("state.json.corrupted-"));
    assert.ok(backups.length >= 1, "Corrupted state was backed up");
  });

  test("state saves atomically and reloads correctly", async () => {
    chatState("9999").recentTurns = [{ name: "tester", reply: "passed", ts: new Date().toISOString() }];
    await saveState();

    assert.ok(fs.existsSync(testStateFile));
    const loaded = JSON.parse(fs.readFileSync(testStateFile, "utf8"));
    assert.ok(loaded.chatState["9999"]);
    assert.strictEqual(loaded.chatState["9999"].recentTurns[0].reply, "passed");
  });
});

describe("Unit Tests: Local File MCP Security Rules", () => {
  const pythonBin = process.env.PYTHON_BIN || "python";

  test("blocks sensitive files, directories, and extensions", () => {
    const script = `
import pathlib, sys
from mcp_servers import local_files_mcp as m

blocked_cases = [
    ".env",
    ".env.production",
    "project/.git/config",
    "home/.ssh/id_rsa",
    "AppData/Roaming/1Password/vault",
    "C:/backup/db.bak",
    "C:/secret/auth.token",
    "C:/data/key.pem",
    "C:/data/store.sqlite",
    "C:/data/wallet.kdbx"
]

for p in blocked_cases:
    if not m.is_sensitive(pathlib.Path(p)):
        print(f"FAILED to block {p}")
        sys.exit(1)

allowed_cases = [
    "src/index.js",
    "README.md",
    "docs/architecture.md",
    "package.json"
]

for p in allowed_cases:
    if m.is_sensitive(pathlib.Path(p)):
        print(f"FAILED: False positive on {p}")
        sys.exit(2)

print("ALL_PASS")
`;
    const result = execFileSync(pythonBin, ["-c", script], { cwd: ROOT, encoding: "utf8" });
    assert.ok(result.includes("ALL_PASS"));
  });

  test("blocks paths outside read-only roots", () => {
    const script = `
import sys
from mcp_servers import local_files_mcp as m

try:
    m.checked_path("Z:/completely/nonexistent/drive/file.txt")
    print("FAILED")
    sys.exit(1)
except ValueError:
    print("PASS_OUTSIDE_ROOT")
`;
    const result = execFileSync(pythonBin, ["-c", script], { cwd: ROOT, encoding: "utf8" });
    assert.ok(result.includes("PASS_OUTSIDE_ROOT"));
  });
});

describe("Unit Tests: Web Search MCP SSRF Protection", () => {
  const pythonBin = process.env.PYTHON_BIN || "python";

  test("blocks SSRF targets: localhost, private IP ranges, cloud metadata", () => {
    const script = `
import sys
from mcp_servers import web_search_mcp as w

bad_urls = [
    "ftp://example.com/file",
    "file:///etc/passwd",
    "http://localhost:8080/admin",
    "http://127.0.0.1:3000",
    "http://10.0.0.1/internal",
    "http://192.168.1.1/router",
    "http://172.16.0.1/secret",
    "http://169.254.169.254/latest/meta-data/",
    "http://metadata.google.internal/computeMetadata/v1/",
    "http://100.100.100.200/latest/meta-data/"
]

for url in bad_urls:
    try:
        w.validate_url_target(url)
        print(f"FAILED to block {url}")
        sys.exit(1)
    except (ValueError, PermissionError):
        pass

print("SSRF_TESTS_PASS")
`;
    const result = execFileSync(pythonBin, ["-c", script], { cwd: ROOT, encoding: "utf8" });
    assert.ok(result.includes("SSRF_TESTS_PASS"));
  });
});
