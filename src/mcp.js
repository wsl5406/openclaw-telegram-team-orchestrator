const path = require("path");
const { ROOT, optionalEnv } = require("./config");
const { needsWebSearch } = require("./routing");
const { spawnAsync } = require("./spawn");

async function callMcpServer(serverFile, toolName, args) {
  const python = optionalEnv("PYTHON_BIN", "python");
  const input = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: toolName, arguments: args } }) + "\n";
  const res = await spawnAsync(python, [serverFile], {
    input,
    timeout: 25_000,
    env: process.env,
  });
  const raw = `${res.stdout || ""}\n${res.stderr || ""}`.trim();
  const line = raw.split(/\r?\n/).find((item) => item.trim().startsWith("{"));
  if (!line) throw new Error(`MCP returned no JSON: ${raw.slice(0, 200)}`);
  const parsed = JSON.parse(line);
  if (parsed.error) throw new Error(parsed.error.message || "MCP error");
  return parsed.result?.content?.map((item) => item.text || "").join("\n") || "";
}

async function searchContextForTask(task) {
  if (!needsWebSearch(task)) return "";
  try {
    const server = path.join(ROOT, "mcp_servers", "web_search_mcp.py");
    const result = await callMcpServer(server, "internet_search", { query: task, limit: 5 });
    return `Internet research evidence from MCP internet_research:\n${result.slice(0, 4000)}`;
  } catch (err) {
    return `Internet research evidence from MCP internet_research:\nSEARCH_FAILED: ${err.message}`;
  }
}

module.exports = { callMcpServer, searchContextForTask };
