const { TEAM, MEMBERS, providerConfig, providerReady } = require("./config");
const { postChatCompletion } = require("./providers");
const { escapeRegExp } = require("./util");

const HIGH_THINKING_RE = /推理|深度思考|认真想|仔细想|高推理|high|查询|查一下|搜索|联网|检索|研究|深入分析|reasoning|think deeply|deep analysis|research|investigate|look up|search/iu;
const COMPLEX_TASK_RE = /代码|开发|实现|架构|review|验收|测试|报告|方案|需求|prd|交付|项目|文件|bug|mcp|工具|部署|数据库|接口|重构|修复|code|develop|development|implement|implementation|architecture|design|review|acceptance|test|testing|report|requirements?|spec|delivery|project|file|tool|deploy|database|api|interface|refactor|fix/iu;
const WEB_SEARCH_RE = /联网|上网|搜索|搜一下|查一下|检索|查资料|实际情况|案例|资料|web_search|google|谷歌|百度|知乎|新闻|价格|官网|web search|search online|look up|browse|internet|current info|latest|news|price|official site|case study|market research/iu;
const LOCAL_FILE_RE = /[A-Za-z]:[\\/]|\/mnt\/[a-z]\/|本地文件|电脑文件|读取文件|看文件|local file|read file|open file|project file|workspace file|\.js|\.py|\.json|\.md|\.txt|README/iu;
const ALL_MEMBERS_RE = /@all\b|大家|各位|所有人|全员|都出来|一起讨论|自主讨论|everyone|everybody|all hands|all-hands|all members|all of you|team discussion/iu;

function roleMapText() {
  return MEMBERS.map((member) => `${member.id}=${member.role}, ${member.name}, aliases: ${(member.aliases || []).join(", ")}`).join("\n");
}

function botMentionedAgents(text) {
  const lower = String(text || "").toLowerCase();
  return MEMBERS.filter((member) => member.username && lower.includes(`@${member.username.toLowerCase()}`)).map((member) => member.id);
}

// ASCII aliases must match whole words, otherwise "pm" fires on "development" and "dev" on "device".
// CJK aliases have no word boundaries, so they keep substring matching.
function aliasMatches(lowerText, alias) {
  const needle = String(alias || "").toLowerCase().trim();
  if (!needle) return false;
  if (/^[\x20-\x7e]+$/.test(needle)) {
    return new RegExp(`(^|[^a-z0-9_])${escapeRegExp(needle)}($|[^a-z0-9_])`).test(lowerText);
  }
  return lowerText.includes(needle);
}

function mentionedAgents(text) {
  const lower = String(text || "").toLowerCase();
  const roles = new Set(botMentionedAgents(text));
  for (const member of MEMBERS) {
    if ((member.aliases || []).some((alias) => aliasMatches(lower, alias))) roles.add(member.id);
  }
  return [...roles];
}

function stripMentions(text) {
  let next = String(text || "");
  for (const member of MEMBERS) {
    if (member.username) next = next.replace(new RegExp(`@${escapeRegExp(member.username)}`, "ig"), "");
  }
  return next.replace(/@all\b/ig, "").trim();
}

function isAllMembersCall(text) {
  return ALL_MEMBERS_RE.test(String(text || ""));
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
  const compactText = String(text || "").trim();
  if (compactText.length > 40) return false;
  return !COMPLEX_TASK_RE.test(compactText) && !needsWebSearch(compactText);
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
  if (!roles.size && TEAM.defaultRoleId) roles.add(TEAM.defaultRoleId);
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
  const json = await postChatCompletion(provider, {
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
  }, { label: "router", timeoutMs: 25_000 });
  const content = String(json.choices?.[0]?.message?.content || "{}");
  const start = content.indexOf("{");
  const end = content.lastIndexOf("}");
  if (start < 0 || end < start) throw new Error("router returned non-json");
  return normalizeDecision(JSON.parse(content.slice(start, end + 1)), mentioned, isAll, text);
}

module.exports = {
  botMentionedAgents,
  mentionedAgents,
  stripMentions,
  isAllMembersCall,
  wantsHighThinking,
  needsWebSearch,
  needsMcpTools,
  routerThinkingFor,
  roleThinkingFor,
  isSimpleDirectPing,
  fallbackDecision,
  normalizeDecision,
  callRouter,
};
