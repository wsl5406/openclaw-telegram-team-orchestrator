# Security Policy

This project is designed for local agent teams that may have access to private files and paid API keys. Treat the orchestrator as infrastructure, not as a public chat toy.

## Secret Handling

Never commit real values for:

- Telegram bot tokens
- model provider API keys
- `.env`
- `config/team.json` if it contains private role names or private routing setup
- `personas/*.md` if it contains private or proprietary prompts
- runtime state, logs, memories, browser profiles, or cookies

Use `.env.example`, `config/team.example.json`, and `personas.example/*.md` as publishable templates.

## Tool Permission Model

The included `local_files` MCP server is read-only. It exposes only:

- `list_dir`
- `read_file`
- `search_files`

It intentionally does not expose:

- write/edit/delete/move/rename
- shell execution
- package installation
- config modification
- Telegram delivery tools

The orchestrator prompt also instructs agents to ask for explicit owner approval before any write, command, install, or config change.

## Sensitive Path Blocks

The local file MCP blocks common sensitive paths and files, including:

- `.env`
- `.git`
- `.ssh`
- `auth_info`
- `chrome_user_data`
- cookies/history/login data
- `node_modules`
- `venv`
- `.key`, `.pem`, `.pfx`, `.sqlite`, `.db`

You should still review `OPENCLAW_FILE_ROOTS` before enabling broad local file access.

## Pre-Publish Checklist

Run this before pushing to GitHub:

```powershell
.\scripts\secret_scan.ps1
npm run check
python -m py_compile mcp_servers\local_files_mcp.py mcp_servers\web_search_mcp.py
```

Expected result: zero secret-pattern hits.

## Reporting

If you find a security issue in your own deployment, rotate exposed keys first, then inspect logs and runtime state. This template does not ship with any public service endpoint.
