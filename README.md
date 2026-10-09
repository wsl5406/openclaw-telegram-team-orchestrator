# OpenClaw Telegram Team Orchestrator

English | [中文](#中文)

A clean template for running multiple Telegram bots as one coordinated OpenClaw-style agent team.

This project focuses on a practical middle layer:

- one Telegram bot per role
- semantic role routing
- shared team context
- role-to-role handoff
- OpenClaw execution for MCP/tool-enabled tasks
- read-only local file MCP
- lightweight web research MCP
- explicit approval rules before file writes, shell commands, installs, or config changes

No private personas, API keys, Telegram tokens, logs, memories, or runtime state are included.

Current template version: `v0.2.0`.

## Language Support

The primary router uses LLM-based semantic routing, so it can handle both English and Chinese when the configured model supports them. Keyword matching is only a fallback path for provider failures or very simple direct mentions, and the fallback vocabulary includes both English and Chinese role/task terms.

## Who Should Use This?

| Scenario | Fit | Why |
| --- | --- | --- |
| Personal development assistant | Best fit | Lead, Architect, Engineer, and QA can split planning, implementation, review, and verification. |
| Project coordination group | Best fit | PM handles requirements, Lead coordinates, Engineer implements, and QA checks acceptance. |
| Technical review room | Good fit | Architect reviews design, Engineer checks feasibility, and QA turns the result into testable criteria. |
| Local-file-aware assistant | Good fit | Agents can read allowed local files through read-only MCP and ask before making changes. |
| Casual entertainment chatbot | Not ideal | The orchestrator, role routing, and MCP safety layer are heavier than a simple chat bot needs. |
| Single-bot FAQ or support bot | Not ideal | If one assistant is enough, a multi-role Telegram team adds unnecessary complexity. |

## Why This Exists

Telegram groups are a natural interface for multi-agent teams, but most bot setups either reply independently or require every message to be handled by one monolithic assistant.

This template adds a small orchestrator between Telegram and OpenClaw:

1. receive a group message
2. deduplicate bot events
3. decide which roles should respond
4. pass shared context to selected roles
5. use OpenClaw only when MCP/tools are needed
6. send replies from the corresponding role bots

## Architecture

```mermaid
flowchart LR
  U["Telegram user"] --> B["Telegram bot accounts"]
  B --> O["Orchestrator"]
  O --> R["LLM Router"]
  O --> C["Shared team context"]
  O --> A["Selected role agents"]
  A --> OC["OpenClaw CLI"]
  OC --> MCP["MCP tools"]
  MCP --> LF["local_files read-only"]
  MCP --> WEB["internet_research"]
```

More details:

- [Architecture](docs/architecture.md)
- [Examples](docs/examples.md)
- [Security](SECURITY.md)

## Default Roles

The publishable template uses generic roles:

- Lead
- Product Manager
- Architect
- Engineer
- QA

You can customize private names, aliases, and personas locally in:

- `config/team.json`
- `personas/*.md`

Do not publish those private files.

## Quick Start

Install dependencies:

```powershell
# Install Node dependencies
npm install
```

Copy example files:

```powershell
# Create local config files from publishable templates
Copy-Item .env.example .env
Copy-Item config\team.example.json config\team.json
New-Item -ItemType Directory -Force personas | Out-Null
Copy-Item personas.example\*.md personas\
```

Fill `.env` with your own values:

- Telegram group id
- Telegram bot tokens
- Telegram bot usernames
- model provider API keys
- OpenClaw WSL distro/bin path

Configure OpenClaw agents matching the ids in `config/team.json`:

- `lead`
- `pm`
- `architect`
- `engineer`
- `qa`

Use `config/openclaw.mcp.example.json` as a reference for MCP setup.

Start:

```powershell
# Disable OpenClaw built-in Telegram polling and start this orchestrator
.\scripts\start_orchestrator.ps1
```

Stop:

```powershell
# Stop only this template's orchestrator process
.\scripts\stop_orchestrator.ps1
```

## Routing Examples

| User message | Expected route | Notes |
| --- | --- | --- |
| `Product Manager, what do you think?` | `PM` | Single-role product judgment. No full PRD unless requested. |
| `Architect and Engineer, discuss the implementation plan first.` | `Architect -> Engineer` | Design review first, implementation feasibility second. |
| `Write requirements first, hand them to Engineering, then let QA verify.` | `PM -> Engineer -> QA` | Natural handoff from requirements to implementation to acceptance. |
| `Everyone, take a quick look at this direction.` | `Lead -> PM -> Architect -> Engineer -> QA` | All-hands review, each role should stay brief and scoped. |

## Tool Safety

The included `local_files` MCP server is read-only. It exposes:

- `list_dir`
- `read_file`
- `search_files`

It does not expose write, delete, move, rename, shell, install, or config-edit tools.

Sensitive paths are blocked by default, including:

- `.env`
- `.git`
- `.ssh`
- cookies/history/login data
- `chrome_user_data`
- `node_modules`
- `venv`
- `.key`, `.pem`, `.pfx`, `.sqlite`, `.db`

## Checks

Run before publishing:

```powershell
# Check JavaScript syntax
npm run check

# Check Python MCP syntax
python -m py_compile mcp_servers\local_files_mcp.py mcp_servers\web_search_mcp.py

# Scan for accidental API keys, Telegram tokens, and private keys
.\scripts\secret_scan.ps1
```

Expected secret scan result:

```text
Secret scan passed: 0 potential secrets found.
```

## Do Not Commit

- `.env`
- `.env.*` except `.env.example`
- `.git/` when uploading manually through the GitHub web UI
- `config/team.json`
- private `personas/*.md`
- `state.json`
- `orchestrator.log`
- live `team_context/*.md`
- `node_modules/`
- `__pycache__/`
- `package-lock.json` if you choose to keep this template lockfile-free
- browser profiles, cookies, or login data
- API keys or Telegram tokens
- Windows reserved-name leftovers such as `nul`

## Design Decisions

The interesting part of this project is not "several bots in a group" but the constraints that shape it.

**1. One process owns every bot, and delivery is centralized.**
Telegram bots never receive messages sent by other bots, so role bots cannot coordinate peer-to-peer. And when several bots can see the same user message, each one gets its own copy. One orchestrator process therefore receives all copies, picks exactly one coordinator, and sends every role's reply through that role's bot account.
*Trade-off:* it is a single point of failure, and the in-memory claim map only works within one process. Running more than one instance would need a shared store such as Redis or SQLite.

**2. Claim before work, persisted for 24 hours.**
Each message is claimed (`chatId:messageId`) before any model call, and the claim is written to `state.json`. Polling redelivers updates that were not yet confirmed when the process crashed, so without a persisted claim a restart could run the same task twice. An explicit `@bot` mention goes through the same claim.

**3. Tasks run serially within a chat, with a global concurrency cap.**
Inside one group, roles must speak in order, because the engineer reads the PM's output. Across groups, a global cap (`MAX_CONCURRENT_TASKS`) bounds cost and API rate. Every task records a status (`queued → running → succeeded / failed / timed_out`) for observability. Finished statuses are capped, so a long-running process does not leak memory.

**4. A semantic router first, keyword rules as the fallback.**
An LLM router resolves pronouns ("you two"), requested sequences ("PM, then engineering, then QA"), and the smallest set of roles a message needs. If the router provider is down, keyword rules keep the team responsive. A simple direct ping to one role skips the router entirely to save latency and cost.
*Trade-off:* keyword rules are brittle. ASCII aliases are matched as whole words, so `pm` does not fire on "development".

**5. Two execution paths: plain chat completion or OpenClaw.**
Starting an OpenClaw agent through WSL takes seconds. It is only used when a task needs tools (local files or web search); otherwise a role answers through a direct `/chat/completions` call. If OpenClaw exits non-zero without a structured reply, that is treated as an error and never posted to the group as if the agent had said it.

**6. Safety is enforced by what the tools can do, not by prompts.**
The file MCP has no write, delete, or shell tools at all, so "read-only" holds even if a model ignores instructions. Prompt-level approval rules are a second layer. File access combines a root allowlist with a denylist for secrets, keys, and browser profiles, and reads are size-bounded. The web MCP accepts only http/https, resolves DNS, rejects private, loopback, and cloud-metadata addresses, and re-checks every redirect.

**7. Shared context is small and bounded.**
Roles share short, capped context files (`current_task`, `handoffs`, `decisions`) and the last few turns, never the full transcript. Token cost stays predictable; the price is that older context is forgotten.

**8. State writes are atomic.**
State is written to a temp file and then renamed. A corrupted `state.json` is backed up and reset rather than crashing startup or being silently overwritten. Tests point all runtime files at a temp directory (`ORCHESTRATOR_STATE_FILE`, `ORCHESTRATOR_LOG_FILE`, `ORCHESTRATOR_TEAM_CONTEXT_DIR`), so running them never touches a live deployment.

### If I built it again today

The agent ecosystem moved fast while this was being built. OpenClaw now has native per-agent mention routing, there is a community multi-bot relay plugin, and Hermes Agent ships subagent delegation across many chat platforms. A 2026 version would:

- let the model decide when it needs tools or deeper reasoning through native tool calling, instead of regex heuristics;
- replace fixed role personas with one lead agent that spawns subagents on demand, and keep multiple bot identities only as the presentation layer;
- ship as a thin OpenClaw or Hermes plugin that adds only multi-identity relay and approval gating, instead of a standalone process;
- move claims and state to SQLite or Redis so more than one instance can run;
- pass prompts to OpenClaw through stdin or a file instead of a command-line argument;
- pin the resolved IP address in the web MCP to close the DNS-rebinding window.

## Known Limits

- Telegram Bot API does not make bots omniscient; the orchestrator still centralizes message handling.
- Search quality depends on public search engine availability.
- OpenClaw agents must be configured separately.
- Prompts reach OpenClaw as a command-line argument, so very large shared contexts can hit the Windows 32K command-line limit.
- The web MCP validates the resolved IP before connecting, but urllib resolves DNS again when it connects, so a DNS-rebinding attacker could in theory slip between the two lookups.
- This is a v0.2.0 template, not a full production framework.

## License

MIT

---

# 中文

一个干净的 OpenClaw + Telegram 多机器人团队模板。

这个项目的目标不是做一个庞大的 Agent 框架，而是提供一个实用的中间层：

- 一个角色一个 Telegram Bot
- Orchestrator 统一调度
- 语义路由判断谁该回复
- 共享上下文
- 角色之间自然交接
- 需要 MCP/工具时调用 OpenClaw
- 本地文件 MCP 默认只读
- 联网搜索 MCP
- 写文件、执行命令、安装依赖、改配置之前必须先得到明确授权

本仓库不包含私人角色、人设、API key、Telegram token、日志、记忆或运行状态。

当前模板版本：`v0.2.0`。

## 语言支持

主路由使用 LLM 语义判断，所以只要你配置的模型支持中英双语，英文和中文都可以使用。关键词匹配只是 Router 失败或极简单点名时的兜底逻辑，并且兜底词表已经覆盖中英双语角色和任务关键词。

## 谁适合用？

| 场景 | 适合程度 | 原因 |
| --- | --- | --- |
| 个人开发助手 | 非常适合 | Lead、架构师、工程师、QA 可以分别处理规划、实现、评审和验证。 |
| 项目管理群 | 非常适合 | PM 负责需求，Lead 负责协调，工程师负责落地，QA 负责验收。 |
| 技术评审室 | 适合 | 架构师评审方案，工程师判断落地成本，QA 转成可验证标准。 |
| 需要读取本地文件的助手 | 适合 | Agent 可以通过只读 MCP 查看允许范围内的本地文件，修改前必须请示。 |
| 纯娱乐/聊天机器人 | 不太适合 | 调度器、角色路由和 MCP 安全层对普通聊天来说偏重。 |
| 单 Bot 就够用的 FAQ/客服 | 不太适合 | 如果一个助手就能解决，多角色 Telegram 团队会增加不必要复杂度。 |

## 为什么做这个

Telegram 群很适合做“AI 团队”的入口，但普通多 Bot 很容易各说各话，或者变成一个大助手假装多人。

这个模板加了一层 Orchestrator：

1. 接收群消息
2. 去重，避免多个 Bot 抢答
3. 判断应该由哪些角色回复
4. 把共享上下文传给被选中的角色
5. 需要 MCP/工具时再走 OpenClaw
6. 用对应角色的 Telegram Bot 发回群里

## 架构

```mermaid
flowchart LR
  U["Telegram 用户"] --> B["多个 Telegram Bot"]
  B --> O["Orchestrator 调度器"]
  O --> R["LLM Router"]
  O --> C["共享上下文"]
  O --> A["被选中的角色 Agent"]
  A --> OC["OpenClaw CLI"]
  OC --> MCP["MCP 工具"]
  MCP --> LF["local_files 只读"]
  MCP --> WEB["internet_research 联网搜索"]
```

更多文档：

- [架构说明](docs/architecture.md)
- [使用示例](docs/examples.md)
- [安全说明](SECURITY.md)

## 默认角色

开源模板只保留通用角色：

- 负责人 Lead
- 产品经理 Product Manager
- 架构师 Architect
- 工程师 Engineer
- 测试验收 QA

你可以在本地自定义名字、别名和人设：

- `config/team.json`
- `personas/*.md`

这些本地私有文件不要上传 GitHub。

## 快速开始

安装依赖：

```powershell
# 安装 Node 依赖
npm install
```

复制示例配置：

```powershell
# 从可发布模板创建本地私有配置
Copy-Item .env.example .env
Copy-Item config\team.example.json config\team.json
New-Item -ItemType Directory -Force personas | Out-Null
Copy-Item personas.example\*.md personas\
```

填写 `.env`：

- Telegram 群 ID
- Telegram Bot token
- Telegram Bot 用户名
- 模型供应商 API key
- OpenClaw WSL distro/bin 路径

在 OpenClaw 里配置和 `config/team.json` 匹配的 Agent：

- `lead`
- `pm`
- `architect`
- `engineer`
- `qa`

MCP 配置可参考：

```text
config/openclaw.mcp.example.json
```

启动：

```powershell
# 关闭 OpenClaw 内置 Telegram polling，并启动本调度器
.\scripts\start_orchestrator.ps1
```

停止：

```powershell
# 只停止这个模板自己的 Orchestrator 进程
.\scripts\stop_orchestrator.ps1
```

## 路由示例

| 用户输入 | 预期路由 | 说明 |
| --- | --- | --- |
| `产品经理，你怎么看？` | `PM` | 单角色产品判断；没有明确要求时不写完整 PRD。 |
| `架构师和工程师先讨论一下实现方案。` | `Architect -> Engineer` | 先做技术评审，再判断工程落地成本。 |
| `先写需求，再交给工程师实现，最后让 QA 验收。` | `PM -> Engineer -> QA` | 从需求到实现再到验收的自然交接。 |
| `大家都出来看一下这个方向。` | `Lead -> PM -> Architect -> Engineer -> QA` | 全员评审，每个角色都应该简短且守住职责边界。 |

## 工具安全

内置的 `local_files` MCP 默认只读，只提供：

- `list_dir`
- `read_file`
- `search_files`

它不提供写入、删除、移动、重命名、执行 shell、安装依赖或修改配置的工具。

默认屏蔽敏感路径：

- `.env`
- `.git`
- `.ssh`
- cookies/history/login data
- `chrome_user_data`
- `node_modules`
- `venv`
- `.key`, `.pem`, `.pfx`, `.sqlite`, `.db`

## 发布前检查

```powershell
# 检查 JavaScript 语法
npm run check

# 检查 Python MCP 语法
python -m py_compile mcp_servers\local_files_mcp.py mcp_servers\web_search_mcp.py

# 扫描误提交的 API key、Telegram token 和私钥
.\scripts\secret_scan.ps1
```

密钥扫描应该输出：

```text
Secret scan passed: 0 potential secrets found.
```

## 不要提交这些文件

- `.env`
- `.env.*`，但 `.env.example` 除外
- 网页手动上传时不要传 `.git/`
- `config/team.json`
- 私有 `personas/*.md`
- `state.json`
- `orchestrator.log`
- 运行中的 `team_context/*.md`
- `node_modules/`
- `__pycache__/`
- 如果你希望模板不带锁文件，就不要提交 `package-lock.json`
- 浏览器用户数据、cookies 或 login data
- API key 或 Telegram token
- Windows 保留名残留文件，例如 `nul`

## 设计取舍

这个项目真正值得看的不是"群里有几个 Bot"，而是背后的几个约束。

**1. 一个进程管理所有 Bot，统一发送回复。**
Telegram 的 Bot 收不到其他 Bot 发的消息，所以角色 Bot 之间没法点对点协作。另外，多个 Bot 都能看到同一条用户消息时，每个 Bot 都会各收到一份。因此由一个 Orchestrator 进程接收所有副本，只选出一个协调者，再用各角色自己的 Bot 账号把回复发出去。
*代价*：这是单点故障；内存里的认领表也只在单进程内有效。要跑多个实例，需要把认领表放到 Redis 或 SQLite 这类共享存储里。

**2. 先认领再干活，认领记录保留 24 小时。**
每条消息在调用模型之前先认领（`chatId:messageId`），并写入 `state.json`。进程崩溃时还没确认的消息，轮询会重新投递；如果不持久化认领记录，重启后同一个任务可能执行两次。显式 `@bot` 的消息也走同一套认领。

**3. 同一个群内串行执行，全局限制并发。**
同一个群里，角色必须按顺序发言，因为工程师要先看到 PM 的输出。跨群用全局上限 `MAX_CONCURRENT_TASKS` 控制成本和 API 调用速率。每个任务都记录状态（`queued → running → succeeded / failed / timed_out`），方便观测；已结束的任务状态有数量上限，长期运行不会泄漏内存。

**4. 先用语义路由，关键词规则兜底。**
LLM 路由负责理解指代（"你们俩"）、用户要求的顺序（"先 PM，再开发，最后 QA"），并选出这条消息最少需要哪些角色。路由模型不可用时，关键词规则保证团队还能回复。只点名一个角色的简单消息直接跳过路由，省时间也省钱。
*代价*：关键词规则比较脆弱。英文别名按整词匹配，避免 `pm` 被 "development" 误触发。

**5. 两条执行路径：普通对话接口或 OpenClaw。**
通过 WSL 启动 OpenClaw Agent 要几秒钟，所以只在任务需要工具（读本地文件、联网搜索）时才用；其他情况直接调用 `/chat/completions`。如果 OpenClaw 以非零退出码结束且没有返回结构化回复，就按错误处理，绝不会当成 Agent 的发言发到群里。

**6. 安全靠工具能力本身保证，不靠提示词。**
文件 MCP 根本没有写入、删除或执行 shell 的工具，所以就算模型不听指令，"只读"也依然成立；提示词里的审批规则只是第二层防线。文件访问同时使用根目录白名单和敏感路径黑名单（密钥、证书、浏览器配置目录），单次读取有大小上限。联网 MCP 只允许 http/https，会先解析 DNS，拒绝内网、回环和云厂商元数据地址，并且每次重定向都重新检查。

**7. 共享上下文小而有界。**
角色之间只共享几份有长度上限的上下文文件（`current_task`、`handoffs`、`decisions`）和最近几轮发言，不传完整聊天记录。这样 token 成本可控，代价是较早的上下文会被遗忘。

**8. 状态原子写入。**
先写临时文件，再用 rename 替换。`state.json` 损坏时会先备份再重置，不会导致启动崩溃，也不会被悄悄覆盖。测试通过 `ORCHESTRATOR_STATE_FILE`、`ORCHESTRATOR_LOG_FILE`、`ORCHESTRATOR_TEAM_CONTEXT_DIR` 把所有运行时文件指向临时目录，跑测试永远不会碰到线上部署的数据。

### 如果今天重新做

做这个项目期间，Agent 生态变化很快：OpenClaw 已经原生支持按 Agent 配置 @ 路由，社区有了多 Bot 中转插件，Hermes Agent 也能在多个聊天平台上分派子 Agent。2026 年重做的话，我会：

- 让模型通过原生工具调用自己决定要不要用工具、要不要深度思考，不再用正则启发式判断；
- 用"一个主 Agent 按需派生子 Agent"取代固定的角色人设，多 Bot 身份只作为展示层保留；
- 做成 OpenClaw 或 Hermes 的轻量插件，只提供多身份接力和审批这两项能力，不再作为独立进程运行；
- 把认领记录和状态迁到 SQLite 或 Redis，支持多实例；
- 通过 stdin 或文件把提示词传给 OpenClaw，而不是命令行参数；
- 在联网 MCP 里固定已解析的 IP，堵上 DNS rebinding 的窗口。

## 已知限制

- Telegram Bot API 不会让每个 Bot 自动拥有完整群聊全知视角，仍然需要 Orchestrator 统一调度。
- 搜索质量依赖公开搜索引擎可用性。
- OpenClaw Agent 需要单独配置。
- 提示词以命令行参数形式传给 OpenClaw，共享上下文特别大时可能超过 Windows 32K 的命令行长度限制。
- 联网 MCP 在连接前会校验解析出的 IP，但 urllib 连接时会再解析一次 DNS，理论上存在 DNS rebinding 的空档。
- 这是 v0.2.0 模板，不是完整生产级框架。

## License

MIT