const fs = require("fs");
const path = require("path");
const { spawnSync } = require("child_process");
const TelegramBot = require("node-telegram-bot-api");

const ROOT = path.resolve(__dirname, "..");
const CONFIG_DIR = path.join(ROOT, "config");
const TEAM_CONTEXT_DIR = path.join(ROOT, "team_context");
const STATE_FILE = path.join(ROOT, "state.json");
const LOG_FILE = path.join(ROOT, "orchestrator.log");

const HIGH_THINKING_RE = /推理|深度思考|认真想|仔细想|高推理|high|查询|查一下|搜索|联网|检索|研究|深入分析|reasoning|think deeply|deep analysis|research|investigate|look up|search/iu;
const COMPLEX_TASK_RE = /代码|开发|实现|架构|review|验收|测试|报告|方案|需求|prd|交付|项目|文件|bug|mcp|工具|部署|数据库|接口|重构|修复|code|develop|development|implement|implementation|architecture|design|review|acceptance|test|testing|report|requirements?|spec|delivery|project|file|tool|deploy|database|api|interface|refactor|fix/iu;
const WEB_SEARCH_RE = /联网|上网|搜索|搜一下|查一下|检索|查资料|实际情况|案例|资料|web_search|google|谷歌|百度|知乎|新闻|价格|官网|web search|search online|look up|browse|internet|current info|latest|news|price|official site|case study|market research/iu;
const LOCAL_FILE_RE = /[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|本地文件|电脑文件|读取文件|看文件|local file|read file|open file|project file|workspace file|\.js|\.py|\.json|\.md|\.txt|README/iu;

const HANDLED_MESSAGES = new Map();
const CHAT_STATE = new Map();

function loadEnvFile() {
  const envPath = path.join(ROOT, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const raw of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const idx = line.indexOf("=");
    const key = line.slice(0, idx).trim();
    const value = line.slice(idx + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!process.env[key]) process.env[key] = value;
  }
}

function requiredEnv(name) {
  if (!process.env[name]) throw new Error(`Missing required environment variable: ${name}`);
  return process.env[name];
}

function optionalEnv(name, fallback = "") {
  return process.env[name] || fallback;
}

function loadJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function loadTeamConfig() {
  const configFile = path.join(CONFIG_DIR, "team.json");
  const exampleFile = path.join(CONFIG_DIR, "team.example.json");
  const config = loadJson(fs.existsSync(configFile) ? configFile : exampleFile);
  const ownerName = optionalEnv(config.ownerNameEnv || "OWNER_DISPLAY_NAME", "Owner");
  const members = config.members.map((member) => ({
    ...member,
    name: member.displayName,
    token: requiredEnv(member.tokenEnv),
    username: optionalEnv(member.usernameEnv, member.username || ""),
    aliases: member.aliases || [],
  }));
  const masterUserIdRaw = requiredEnv("MASTER_USER_ID");
  if (!/^\d+$/.test(masterUserIdRaw.trim())) {
    throw new Error(`MASTER_USER_ID must be a numeric Telegram user ID, got: ${masterUserIdRaw}`);
  }
  const masterUserId = Number(masterUserIdRaw.trim());
  return {
    ...config,
    ownerName,
    masterUserId,
    groupId: requiredEnv(config.telegramGroupIdEnv || "TELEGRAM_GROUP_ID"),
    routerProvider: optionalEnv(config.routerProviderEnv || "ROUTER_PROVIDER", "api2"),
    defaultRoleId: config.defaultRoleId || members[0]?.id,
    members,
  };
}

loadEnvFile();
const TEAM = loadTeamConfig();
const MEMBERS = TEAM.members;

function providerConfig(name) {
  const prefix = String(name || "").toUpperCase();
  return {
    name,
    baseUrl: optionalEnv(`${prefix}_BASE_URL`),
    apiKey: optionalEnv(`${prefix}_KEY`),
    model: optionalEnv(`${prefix}_MODEL`),
  };
}

function providerReady(provider) {
  return Boolean(provider.baseUrl && provider.apiKey && provider.model);
}

function providerForMember(member) {
  return providerConfig(member.provider || "api2");
}

function logEvent(type, payload = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), type, ...payload }, null, 0);
  fs.appendFile(LOG_FILE, line + "\n", () => {});
}

function loadState() {
  if (!fs.existsSync(STATE_FILE)) return;
  try {
    const data = loadJson(STATE_FILE);
    for (const [chatId, state] of Object.entries(data.chatState || {})) CHAT_STATE.set(chatId, state);
  } catch (err) {
    console.error("[state] load failed:", err.message);
  }
}

function saveState() {
  const data = {
    savedAt: new Date().toISOString(),
    chatState: Object.fromEntries(CHAT_STATE.entries()),
  };
  fs.writeFile(STATE_FILE, JSON.stringify(data, null, 2), () => {});
}

function chatState(chatId) {
  const key = String(chatId);
  if (!CHAT_STATE.has(key)) CHAT_STATE.set(key, { recentTurns: [], board: null });
  return CHAT_STATE.get(key);
}

function claimMessage(msg) {
  const key = `${msg.chat.id}:${msg.message_id}`;
  const now = Date.now();
  for (const [item, expires] of HANDLED_MESSAGES.entries()) {
    if (expires <= now) HANDLED_MESSAGES.delete(item);
  }
  if (HANDLED_MESSAGES.has(key)) return false;
  HANDLED_MESSAGES.set(key, now + 60_000);
  return true;
}

function ensureTeamContextDir() {
  fs.mkdirSync(TEAM_CONTEXT_DIR, { recursive: true });
}

function teamContextFile(name) {
  ensureTeamContextDir();
  return path.join(TEAM_CONTEXT_DIR, name);
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
  ensureTeamContextDir();
  const files = ["tool_policy.md", "current_task.md", "handoffs.md", "decisions.md", "open_questions.md"];
  const parts = [];
  for (const name of files) {
    const file = teamContextFile(name);
    if (!fs.existsSync(file)) continue;
    const body = fs.readFileSync(file, "utf8").trim();
    if (body) parts.push(`### ${name}\n${body.slice(-1500)}`);
  }
  return parts.length ? `Shared team context files:\n${parts.join("\n\n")}` : "";
}

function memberById(id) {
  return MEMBERS.find((member) => member.id === id);
}

function roleLabel(id) {
  return memberById(id)?.name || id;
}

function roleMapText() {
  return MEMBERS.map((member) => `${member.id}=${member.role}, ${member.name}, aliases: ${(member.aliases || []).join(", ")}`).join("\n");
}

function botMentionedAgents(text) {
  const lower = String(text || "").toLowerCase();
  return MEMBERS.filter((member) => member.username && lower.includes(`@${member.username.toLowerCase()}`)).map((member) => member.id);
}

function mentionedAgents(text) {
  const lower = String(text || "").toLowerCase();
  const roles = new Set(botMentionedAgents(text));
  for (const member of MEMBERS) {
    for (const alias of member.aliases || []) {
      if (alias && lower.includes(String(alias).toLowerCase())) roles.add(member.id);
    }
  }
  return [...roles];
}

function stripMentions(text) {
  let next = String(text || "");
  for (const member of MEMBERS) {
    if (member.username) next = next.replace(new RegExp(`@${escapeRegExp(member.username)}`, "ig"), "");
  }
  return next.replace(/@all/ig, "").trim();
}

function escapeRegExp(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isAllMembersCall(text) {
  return /@all|大家|各位|所有人|全员|都出来|一起讨论|自主讨论|everyone|everybody|all hands|all-hands|all members|all of you|team discussion/iu.test(String(text || ""));
}

function wantsHighThinking(text) {
  return HIGH_THINKING_RE.test(String(text || ""));
}

function needsWebSearch(text) {
  return WEB_SEARCH_RE.test(String(text || ""));
}

function needsMcpTools(text) {
  return needsWebSearch(text) || LOCAL_FILE_RE.test(String(text || ""));
}

function routerThinkingFor(text, isAll) {
  return isAll || wantsHighThinking(text) || COMPLEX_TASK_RE.test(String(text || "")) ? "high" : "medium";
}

function roleThinkingFor(task, decision, member) {
  if (wantsHighThinking(task) || needsWebSearch(task)) return "high";
  if (decision.mode === "single" && decision.complexity === "small") return "off";
  if (["architect", "qa"].includes(member.role)) return "high";
  if (member.role === "engineer") return decision.complexity === "large" ? "high" : "medium";
  if (member.role === "pm") return decision.complexity === "large" ? "high" : "medium";
  return decision.mode === "team" ? "medium" : "off";
}

function isSimpleDirectPing(text) {
  const compact = String(text || "").trim();
  if (compact.length > 40) return false;
  return !COMPLEX_TASK_RE.test(compact) && !needsWebSearch(compact);
}

function fallbackDecision(text, mentioned, isAll) {
  if (isAll) {
    return { mode: "team", complexity: "medium", roles: MEMBERS.map((m) => m.id), reason: "all-hands fallback", stop: "each selected role replies briefly" };
  }
  if (mentioned.length === 1 && isSimpleDirectPing(text)) {
    return { mode: "single", complexity: "small", roles: mentioned, reason: "single explicit addressee", stop: "named role replies" };
  }
  const roles = new Set(mentioned);
  const t = String(text || "");
  for (const member of MEMBERS) {
    if (member.role === "pm" && /产品|需求|PRD|prd|用户|文档|功能|边界|product|requirements?|spec|user story|feature|scope|acceptance criteria|document|docs/iu.test(t)) roles.add(member.id);
    if (member.role === "architect" && /架构|方案|技术|风险|review|评审|选型|系统|architecture|architect|design|technical|risk|tradeoff|system|review|proposal|solution/iu.test(t)) roles.add(member.id);
    if (member.role === "engineer" && /代码|开发|实现|修|bug|接口|落地|部署|code|develop|developer|engineer|implement|implementation|fix|api|interface|deploy|build/iu.test(t)) roles.add(member.id);
    if (member.role === "qa" && /测试|验收|检查|报告|数据|验证|回归|QA|qa|test|testing|acceptance|verify|verification|check|report|data|regression/iu.test(t)) roles.add(member.id);
  }
  if (!roles.size) roles.add(TEAM.defaultRoleId);
  const picked = [...roles].filter(Boolean).slice(0, 5);
  return {
    mode: picked.length > 1 ? "team" : "single",
    complexity: picked.length > 1 || COMPLEX_TASK_RE.test(t) ? "medium" : "small",
    roles: picked,
    reason: "fallback semantic routing",
    stop: picked.length > 1 ? "selected roles collaborate in order" : "single role replies",
  };
}

function normalizeDecision(decision, mentioned, isAll, text) {
  const valid = new Set(MEMBERS.map((member) => member.id));
  let roles = Array.isArray(decision.roles) ? decision.roles.filter((id) => valid.has(id)) : [];
  if (isAll) roles = MEMBERS.map((member) => member.id);
  if (!roles.length && mentioned.length) roles = mentioned.filter((id) => valid.has(id));
  if (!roles.length) roles = fallbackDecision(text, mentioned, isAll).roles;
  roles = [...new Set(roles)].slice(0, MEMBERS.length);
  return {
    mode: roles.length > 1 ? "team" : "single",
    complexity: ["small", "medium", "large"].includes(decision.complexity) ? decision.complexity : (roles.length > 1 ? "medium" : "small"),
    roles,
    reason: decision.reason || "semantic routing",
    stop: decision.stop || "reply",
  };
}

async function callRouter(text, mentioned, isAll, context = {}) {
  const provider = providerConfig(TEAM.routerProvider);
  if (!providerReady(provider)) throw new Error(`router provider ${TEAM.routerProvider} is not configured`);
  const body = {
    model: provider.model,
    temperature: 0,
    max_tokens: 500,
    reasoning_effort: routerThinkingFor(text, isAll),
    messages: [
      {
        role: "system",
        content: [
          "You are a Telegram team Orchestrator. Route only; do not answer the user's task.",
          "Use semantic routing, not rigid keyword matching.",
          "Pick only the roles needed. Do not summon everyone unless the user asks for all-hands.",
          "If the user asks for a sequence, order roles naturally: PM -> architect -> engineer -> QA when applicable.",
          "If the user only wants discussion, choose the fewest relevant roles and keep complexity small.",
          "Resolve pronouns like this/that/you two from recent turns when possible. If ambiguous, select one role to ask a short clarification.",
          "Return JSON only.",
          "Allowed roles:",
          roleMapText(),
          'JSON shape: {"mode":"single|team","complexity":"small|medium|large","roles":["..."],"reason":"short","stop":"short"}',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          text,
          mentioned,
          isAll,
          recentTurns: (context.recentTurns || []).slice(-6),
          board: context.board || null,
        }, null, 2),
      },
    ],
  };
  const res = await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(25_000),
  });
  if (!res.ok) throw new Error(`router http ${res.status}`);
  const json = await res.json();
  const content = String(json.choices?.[0]?.message?.content || "{}");
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("router returned non-json");
  return normalizeDecision(JSON.parse(content.slice(start, end + 1)), mentioned, isAll, text);
}

function readPersona(member) {
  const local = path.join(ROOT, "personas", `${member.id}.md`);
  const example = path.join(ROOT, "personas.example", `${member.id}.md`);
  if (fs.existsSync(local)) return fs.readFileSync(local, "utf8").trim();
  if (fs.existsSync(example)) return fs.readFileSync(example, "utf8").trim();
  return `You are ${member.name}. Stay inside your role: ${member.role}.`;
}

function recentContextForTask(chatId) {
  const state = chatState(chatId);
  const turns = state.recentTurns || [];
  if (!turns.length && !state.board) return "";
  return [
    state.board ? `Shared discussion board:\n${JSON.stringify(state.board, null, 2)}` : "",
    turns.length ? "Recent group turns:\n" + turns.slice(-6).map((turn) => `${turn.name}: ${turn.reply}`).join("\n\n") : "",
    "Use this context to resolve pronouns. If it is not enough, ask one short clarification question.",
  ].filter(Boolean).join("\n\n");
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

function roleInstruction(member, decision, transcript, task) {
  const previous = transcript.length ? "Read previous teammate messages first, then continue only your own role." : "You are the first selected role this round.";
  if (/讨论|聊聊|看法|怎么看|想法|discuss|discussion|opinion|what do you think|thoughts|brainstorm/iu.test(task) && !/写|实现|开发|交付|验收|文档|PRD|prd|write|implement|develop|deliver|acceptance|document|spec/iu.test(task)) {
    return `${previous}\nDiscussion mode: short opinion only. Do not write a full document unless explicitly asked.`;
  }
  if (member.role === "pm") {
    return `${previous}\nPM mode: clarify needs, summarize requirements, boundaries, and acceptance criteria. Do not write code.`;
  }
  if (member.role === "architect") {
    return `${previous}\nArchitect mode: review design, risks, dependencies, and technical tradeoffs. Do not implement.`;
  }
  if (member.role === "engineer") {
    return `${previous}\nEngineer mode: explain implementation or ask for approval before code/file changes.`;
  }
  if (member.role === "qa") {
    return `${previous}\nQA mode: verify, test, list acceptance checks, and report risks.`;
  }
  return `${previous}\nLead mode: coordinate roles, priority, and final decision.`;
}

function buildRolePrompt(task, decision, transcript, member, thinkingLevel, extraContext) {
  const ownerName = TEAM.ownerName;
  const previous = transcript.length
    ? `Previous teammate messages:\n${transcript.map((item) => `${item.name}: ${item.reply}`).join("\n\n")}`
    : "Previous teammate messages: none.";
  return [
    readPersona(member),
    "",
    `The current sender is ${ownerName}, the owner/user. Address them respectfully as ${ownerName}.`,
    "Never say you are an AI, model, bot, program, or system.",
    "Stay inside your role boundary.",
    "Reply briefly unless the task explicitly asks for a document/report.",
    "",
    "Permission rules:",
    "- You may use read-only local_files MCP and internet_research MCP without extra approval.",
    "- Before any write/edit/delete/move/rename, shell command, install, config change, or code change, ask for explicit owner approval.",
    "- If local paths are provided, read them through local_files MCP. Do not ask the owner to paste files first.",
    "- For web/current-info tasks, use provided evidence first, then internet_research MCP if needed.",
    "",
    `Original request: ${task}`,
    `Orchestrator decision: ${decision.mode}/${decision.complexity}. Reason: ${decision.reason || "semantic routing"}.`,
    `Thinking level: ${thinkingLevel}.`,
    `Your role: ${member.name} (${member.role}).`,
    roleInstruction(member, decision, transcript, task),
    extraContext,
    previous,
    "",
    "Output rules:",
    "- At most one direct address to the owner.",
    "- If evidence is insufficient, say so briefly instead of inventing facts.",
    "- If a later selected role exists, include a compact handoff block only when the task is delivery-oriented.",
  ].filter(Boolean).join("\n");
}

function compact(text, max = 260) {
  return String(text || "").replace(/\s+/g, " ").trim().slice(0, max);
}

async function callPlainProvider(member, prompt, thinkingLevel) {
  const provider = providerForMember(member);
  if (!providerReady(provider)) throw new Error(`provider ${member.provider} is not configured`);
  const body = {
    model: provider.model,
    temperature: 0.7,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Reply to the owner now." },
    ],
  };
  if (thinkingLevel !== "off") body.reasoning_effort = thinkingLevel;
  const res = await fetch(provider.baseUrl.replace(/\/$/, "") + "/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${provider.apiKey}`,
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(80_000),
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`plain provider http ${res.status}: ${text.slice(0, 300)}`);
  const data = JSON.parse(text);
  return sanitizeReply(data.choices?.[0]?.message?.content || data.output_text || "");
}

function runOpenClawAgent(member, prompt, sessionKey, thinkingLevel) {
  const distro = optionalEnv("OPENCLAW_WSL_DISTRO", "OpenClawGateway");
  const openclaw = optionalEnv("OPENCLAW_BIN", "/home/openclaw/.openclaw/bin/openclaw");
  const timeoutSeconds = Number(optionalEnv("OPENCLAW_TIMEOUT_SECONDS", "180"));
  const args = [
    "-d", distro, "--", openclaw,
    "--no-color", "agent",
    "--agent", member.id,
    "--session-key", sessionKey,
    "--message", prompt,
    "--timeout", String(timeoutSeconds),
    "--json",
    "--thinking", thinkingLevel,
  ];
  if (member.openClawModel) args.push("--model", member.openClawModel);
  const res = spawnSync("wsl.exe", args, { encoding: "utf8", timeout: (timeoutSeconds + 30) * 1000 });
  const raw = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  if (res.error) throw res.error;
  return sanitizeReply(extractOpenClawReply(raw) || raw);
}

function extractOpenClawReply(raw) {
  const start = String(raw || "").trim().indexOf("{");
  if (start < 0) return "";
  try {
    const parsed = JSON.parse(String(raw).trim().slice(start));
    return parsed?.result?.finalAssistantVisibleText
      || parsed?.result?.finalAssistantRawText
      || parsed?.result?.payloads?.find((item) => item.text)?.text
      || "";
  } catch {
    return "";
  }
}

function sanitizeReply(text) {
  let body = String(text || "").trim();
  if (!body) return "";
  body = body.replace(/```json[\s\S]*?```/gi, "").trim();
  if (/"finalAssistantRawText"\s*:|"executionTrace"\s*:|"replyInvalid"\s*:/u.test(body)) {
    const extracted = extractJsonStringField(body, "finalAssistantVisibleText") || extractJsonStringField(body, "finalAssistantRawText");
    if (extracted) body = extracted;
  }
  return body.trim();
}

function extractJsonStringField(text, field) {
  const hit = String(text || "").match(new RegExp(`"${field}"\\s*:\\s*"((?:\\\\.|[^"\\\\])*)"`));
  if (!hit) return "";
  try {
    return JSON.parse(`"${hit[1]}"`);
  } catch {
    return hit[1].replace(/\\n/g, "\n").replace(/\\"/g, '"');
  }
}

function callMcpServer(serverFile, toolName, args) {
  const python = optionalEnv("PYTHON_BIN", "python");
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }) + "\n";
  const res = spawnSync(python, [serverFile], {
    input,
    encoding: "utf8",
    timeout: 25_000,
    env: process.env,
  });
  if (res.error) throw res.error;
  const raw = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  const line = raw.split(/\r?\n/).find((item) => item.trim().startsWith("{"));
  if (!line) throw new Error(`MCP returned no JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(line);
  if (parsed.error) throw new Error(parsed.error.message || "MCP error");
  return parsed.result?.content?.map((item) => item.text || "").join("\n") || "";
}

function searchContextForTask(task) {
  if (!needsWebSearch(task)) return "";
  try {
    const server = path.join(ROOT, "mcp_servers", "web_search_mcp.py");
    const result = callMcpServer(server, "internet_search", { query: task, limit: 5 });
    return `Internet research evidence from MCP internet_research:\n${result.slice(0, 4000)}`;
  } catch (err) {
    return `Internet research evidence from MCP internet_research:\nSEARCH_FAILED: ${err.message}`;
  }
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

async function updateBoard(chatId, task, decision, transcript) {
  const state = chatState(chatId);
  state.board = {
    topic: compact(task, 200),
    participants: decision.roles,
    lastOutputs: Object.fromEntries(transcript.map((item) => [item.roleId, compact(item.reply, 360)])),
    updatedAt: new Date().toISOString(),
  };
  saveState();
}

function shouldUseOpenClaw(task, member) {
  if (optionalEnv("ALWAYS_USE_OPENCLAW", "") === "1") return true;
  if (needsMcpTools(task)) return true;
  return !providerReady(providerForMember(member));
}

function limitReply(task, reply) {
  const body = String(reply || "").trim();
  if (/写|文档|报告|PRD|prd|完整|详细|方案|write|document|report|complete|detailed|full plan|spec|requirements/iu.test(task)) return body;
  const sentences = body.split(/(?<=[。！？?!])\s*/u).filter(Boolean);
  const picked = (sentences.length ? sentences.slice(0, 4).join("") : body).trim();
  return picked.length > 900 ? picked.slice(0, 900).replace(/[，,。.\s]+$/u, "") + "..." : picked;
}

async function sendLong(bot, chatId, text) {
  const body = String(text || "").trim() || "No effective result.";
  for (let i = 0; i < body.length; i += 3800) {
    await bot.sendMessage(chatId, body.slice(i, i + 3800));
  }
}

async function handleMessage(receiverId, msg, bots) {
  const text = msg.text || "";
  if (!text || msg.from?.is_bot) return;
  if (!msg.from?.id || Number(TEAM.masterUserId) !== msg.from.id) return;
  if (String(msg.chat.id) !== String(TEAM.groupId)) return;

  const isGroup = msg.chat.type === "group" || msg.chat.type === "supergroup";
  const botMentions = botMentionedAgents(text);
  if (isGroup) {
    if (botMentions.length && !botMentions.includes(receiverId)) return;
    if (!botMentions.length && !claimMessage(msg)) return;
  }
  const coordinator = botMentions[0] || receiverId;
  if (botMentions.length && receiverId !== coordinator) return;

  const task = stripMentions(text);
  const isAll = isAllMembersCall(text);
  const mentioned = mentionedAgents(text);
  let decision;
  if (!isAll && mentioned.length === 1 && isSimpleDirectPing(task)) {
    decision = { mode: "single", complexity: "small", roles: mentioned, reason: "simple direct mention", stop: "named role replies" };
  } else {
    try {
      logEvent("router_start", { chatId: msg.chat.id, messageId: msg.message_id, task });
      decision = await callRouter(task, mentioned, isAll, chatState(msg.chat.id));
      logEvent("router_done", { chatId: msg.chat.id, messageId: msg.message_id, roles: decision.roles });
    } catch (err) {
      logEvent("router_failed", { chatId: msg.chat.id, messageId: msg.message_id, error: err.message });
      decision = fallbackDecision(task, mentioned, isAll);
    }
  }
  decision = normalizeDecision(decision, mentioned, isAll, task);
  logEvent("decision", { chatId: msg.chat.id, messageId: msg.message_id, roles: decision.roles, reason: decision.reason });

  const sessionBase = `telegram-team-${msg.chat.id}-${msg.message_id}-${Date.now()}`;
  const transcript = [];
  updateTeamContextFiles(msg.chat.id, task, decision, transcript);
  const sharedContext = [readTeamContext(), recentContextForTask(msg.chat.id), searchContextForTask(task)].filter(Boolean).join("\n\n");

  for (const roleId of decision.roles) {
    const member = memberById(roleId);
    if (!member) continue;
    const thinkingLevel = roleThinkingFor(task, decision, member);
    const prompt = buildRolePrompt(task, decision, transcript, member, thinkingLevel, sharedContext);
    bots[roleId].sendChatAction(msg.chat.id, "typing").catch(() => {});
    let reply;
    try {
      logEvent("agent_start", { chatId: msg.chat.id, messageId: msg.message_id, roleId, thinkingLevel, openclaw: shouldUseOpenClaw(task, member) });
      reply = shouldUseOpenClaw(task, member)
        ? runOpenClawAgent(member, prompt, `${sessionBase}-${roleId}`, thinkingLevel)
        : await callPlainProvider(member, prompt, thinkingLevel);
      logEvent("agent_done", { chatId: msg.chat.id, messageId: msg.message_id, roleId, chars: String(reply || "").length });
    } catch (err) {
      logEvent("agent_failed", { chatId: msg.chat.id, messageId: msg.message_id, roleId, error: err.message });
      reply = `${member.name} call failed: ${err.message}`;
    }
    reply = limitReply(task, sanitizeReply(reply));
    transcript.push({ roleId, name: member.name, reply });
    await sendLong(bots[roleId], msg.chat.id, reply);
    rememberTurn(msg.chat.id, roleId, task, reply);
    if (decision.mode === "single") break;
  }
  await updateBoard(msg.chat.id, task, decision, transcript);
  updateTeamContextFiles(msg.chat.id, task, decision, transcript);
}

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
  loadState();
  ensureTeamContextDir();
  ensureStaticTeamContextFiles();
  printStartupSecurityCheck();
  const bots = {};
  for (const member of MEMBERS) {
    bots[member.id] = new TelegramBot(member.token, { polling: true });
    bots[member.id].on("message", (msg) => handleMessage(member.id, msg, bots).catch((err) => {
      logEvent("message_failed", { roleId: member.id, error: err.message });
      console.error(err);
    }));
    console.log(`started ${member.name} (${member.id})`);
  }
  console.log("Telegram team orchestrator is running.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
