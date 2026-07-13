# Tool Policy

- Allowed without extra approval: read-only local file listing/search/reading through the `local_files` MCP server.
- Allowed without extra approval: web search/fetch through the `internet_research` MCP server.
- Forbidden without explicit owner approval: writing, editing, deleting, moving, renaming files, running shell commands, installing packages, changing config, or sending Telegram messages outside the orchestrator.
- If the owner names exact files and explicitly asks for changes, approval is scoped to those files only.
- If the target is vague, ask for exact target and approval before doing anything.
