const fs = require("fs");
const path = require("path");
const { ROOT, TEAM } = require("./config");
const { chatState } = require("./state");

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

function limitReply(task, reply) {
  const body = String(reply || "").trim();
  if (/写|文档|报告|PRD|prd|完整|详细|方案|write|document|report|complete|detailed|full plan|spec|requirements/iu.test(task)) return body;
  const sentences = body.split(/(?<=[。！？?!])\s*/u).filter(Boolean);
  const picked = (sentences.length ? sentences.slice(0, 4).join("") : body).trim();
  return picked.length > 900 ? picked.slice(0, 900).replace(/[，,。.\s]+$/u, "") + "..." : picked;
}

module.exports = {
  readPersona,
  recentContextForTask,
  buildRolePrompt,
  limitReply,
};
