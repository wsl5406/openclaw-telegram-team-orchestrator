const { optionalEnv, providerForMember, providerReady } = require("./config");
const { postChatCompletion } = require("./providers");
const { needsMcpTools } = require("./routing");
const { spawnAsync } = require("./spawn");
const { compact } = require("./util");

async function callPlainProvider(member, prompt, thinkingLevel) {
  const provider = providerForMember(member);
  if (!providerReady(provider)) throw new Error(`provider ${member.provider} is not configured`);
  const body = {
    temperature: 0.7,
    messages: [
      { role: "system", content: prompt },
      { role: "user", content: "Reply to the owner now." },
    ],
  };
  if (thinkingLevel !== "off") body.reasoning_effort = thinkingLevel;
  const data = await postChatCompletion(provider, body, { label: "plain provider", timeoutMs: 80_000 });
  return sanitizeReply(data.choices?.[0]?.message?.content || data.output_text || "");
}

async function runOpenClawAgent(member, prompt, sessionKey, thinkingLevel) {
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
  const res = await spawnAsync("wsl.exe", args, { timeout: (timeoutSeconds + 30) * 1000 });
  return parseOpenClawResult(res);
}

// Turns raw CLI output into the reply text. A non-zero exit without a structured reply is an error;
// it must never be forwarded to the group as if it were the agent speaking.
function parseOpenClawResult(res) {
  const stdout = String(res.stdout || "");
  const raw = `${stdout}\n${res.stderr || ""}`.trim();
  const extracted = extractOpenClawReply(stdout) || extractOpenClawReply(raw);
  if (extracted) return sanitizeReply(extracted);
  if (res.code !== 0) {
    const err = new Error(`OpenClaw exited with code ${res.code}: ${compact(res.stderr || stdout, 300) || "no output"}`);
    err.code = "OPENCLAW_EXIT";
    throw err;
  }
  return sanitizeReply(stdout.trim() || raw);
}

function extractOpenClawReply(raw) {
  const text = String(raw || "").trim();
  const start = text.indexOf("{");
  if (start < 0) return "";
  try {
    const parsed = JSON.parse(text.slice(start));
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

function shouldUseOpenClaw(task, member) {
  if (optionalEnv("ALWAYS_USE_OPENCLAW", "") === "1") return true;
  if (needsMcpTools(task)) return true;
  return !providerReady(providerForMember(member));
}

module.exports = {
  callPlainProvider,
  runOpenClawAgent,
  parseOpenClawResult,
  sanitizeReply,
  shouldUseOpenClaw,
};
