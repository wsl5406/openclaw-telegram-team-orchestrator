const { TEAM, memberById, optionalEnv } = require("./config");
const { logEvent } = require("./logger");
const { chatState, claimMessage, rememberTurn, updateBoard } = require("./state");
const { readTeamContext, updateTeamContextFiles } = require("./team_context");
const {
  botMentionedAgents,
  mentionedAgents,
  stripMentions,
  isAllMembersCall,
  isSimpleDirectPing,
  roleThinkingFor,
  fallbackDecision,
  normalizeDecision,
  callRouter,
} = require("./routing");
const { recentContextForTask, buildRolePrompt, limitReply } = require("./prompts");
const { callPlainProvider, runOpenClawAgent, sanitizeReply, shouldUseOpenClaw } = require("./agents");
const { searchContextForTask } = require("./mcp");
const { sendLong } = require("./telegram");
const { TaskQueue } = require("./task_queue");

const taskQueue = new TaskQueue(Number(optionalEnv("MAX_CONCURRENT_TASKS", "3")));

async function decideRoute(taskId, msg, task, mentioned, isAll) {
  if (!isAll && mentioned.length === 1 && isSimpleDirectPing(task)) {
    return { mode: "single", complexity: "small", roles: mentioned, reason: "simple direct mention", stop: "named role replies" };
  }
  try {
    logEvent("router_start", { task_id: taskId, chat_id: msg.chat.id, message_id: msg.message_id, task });
    const decision = await callRouter(task, mentioned, isAll, chatState(msg.chat.id));
    logEvent("router_done", { task_id: taskId, chat_id: msg.chat.id, message_id: msg.message_id, roles: decision.roles });
    return decision;
  } catch (err) {
    logEvent("router_failed", { task_id: taskId, chat_id: msg.chat.id, message_id: msg.message_id, error: err.message });
    return fallbackDecision(task, mentioned, isAll);
  }
}

async function runRole(taskId, msg, member, task, prompt, sessionKey, thinkingLevel) {
  const useOpenClaw = shouldUseOpenClaw(task, member);
  const base = { task_id: taskId, chat_id: msg.chat.id, message_id: msg.message_id, role_id: member.id };
  const agentStart = Date.now();
  logEvent("agent_start", { ...base, thinking_level: thinkingLevel, openclaw: useOpenClaw, status: "running" });
  try {
    const reply = useOpenClaw
      ? await runOpenClawAgent(member, prompt, sessionKey, thinkingLevel)
      : await callPlainProvider(member, prompt, thinkingLevel);
    logEvent("agent_done", { ...base, duration_ms: Date.now() - agentStart, chars: String(reply || "").length, status: "succeeded" });
    return reply;
  } catch (err) {
    logEvent("agent_failed", {
      ...base,
      duration_ms: Date.now() - agentStart,
      error_code: err.code || "AGENT_FAILED",
      error: err.message,
      status: "failed",
    });
    return `${member.name} call failed: ${err.message}`;
  }
}

async function executeTaskPipeline(taskId, msg, bots) {
  const text = msg.text || "";
  const task = stripMentions(text);
  const isAll = isAllMembersCall(text);
  const mentioned = mentionedAgents(text);

  const decision = normalizeDecision(await decideRoute(taskId, msg, task, mentioned, isAll), mentioned, isAll, task);
  logEvent("decision", { task_id: taskId, chat_id: msg.chat.id, message_id: msg.message_id, roles: decision.roles, reason: decision.reason });

  const sessionBase = `telegram-team-${msg.chat.id}-${msg.message_id}-${Date.now()}`;
  const transcript = [];
  updateTeamContextFiles(msg.chat.id, task, decision, transcript);
  const sharedContext = [readTeamContext(), recentContextForTask(msg.chat.id), await searchContextForTask(task)].filter(Boolean).join("\n\n");

  for (const roleId of decision.roles) {
    const member = memberById(roleId);
    if (!member) continue;
    const thinkingLevel = roleThinkingFor(task, decision, member);
    const prompt = buildRolePrompt(task, decision, transcript, member, thinkingLevel, sharedContext);
    if (bots[roleId]) {
      bots[roleId].sendChatAction(msg.chat.id, "typing").catch(() => {});
    }
    const raw = await runRole(taskId, msg, member, task, prompt, `${sessionBase}-${roleId}`, thinkingLevel);
    const reply = limitReply(task, sanitizeReply(raw));
    transcript.push({ roleId, name: member.name, reply });
    if (bots[roleId]) {
      await sendLong(bots[roleId], msg.chat.id, reply, { roleId });
    }
    rememberTurn(msg.chat.id, roleId, task, reply);
    if (decision.mode === "single") break;
  }
  await updateBoard(msg.chat.id, task, decision, transcript);
  updateTeamContextFiles(msg.chat.id, task, decision, transcript);
}

// Every bot receives the same group message. Decide which single bot coordinates it.
function shouldCoordinate(receiverId, msg) {
  const text = msg.text || "";
  if (!text || msg.from?.is_bot) return false;
  if (!msg.from?.id || Number(TEAM.masterUserId) !== msg.from.id) return false;
  if (String(msg.chat.id) !== String(TEAM.groupId)) return false;

  // An explicit @bot mention is handled by the first mentioned bot; everyone else stays quiet.
  const botMentions = botMentionedAgents(text);
  if (botMentions.length && receiverId !== botMentions[0]) return false;
  // Claim in both paths so a message redelivered after a restart is not executed twice.
  return claimMessage(msg);
}

async function handleMessage(receiverId, msg, bots, queue = taskQueue) {
  if (!shouldCoordinate(receiverId, msg)) return;

  const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  logEvent("task_status", {
    task_id: taskId,
    chat_id: msg.chat.id,
    message_id: msg.message_id,
    status: "queued",
  });

  return queue.enqueue(msg.chat.id, {
    taskId,
    messageId: msg.message_id,
    execute: () => executeTaskPipeline(taskId, msg, bots),
  });
}

module.exports = {
  taskQueue,
  shouldCoordinate,
  handleMessage,
  executeTaskPipeline,
};
