#!/usr/bin/env python3
import json
import os
import pathlib
import re
import sys

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

DEFAULT_ROOTS = "C:\\;D:\\" if os.name == "nt" else "/mnt/c;/mnt/d"
ROOTS = [
    pathlib.Path(p).resolve()
    for p in os.environ.get("OPENCLAW_FILE_ROOTS", DEFAULT_ROOTS).split(";")
    if p.strip()
]
MAX_READ = int(os.environ.get("OPENCLAW_FILE_MAX_READ", "200000"))
DENY_PARTS = {
    ".git",
    ".ssh",
    "auth_info",
    "chrome_user_data",
    "cookies",
    "node_modules",
    "venv",
    "__pycache__",
}
DENY_NAMES = {
    ".env",
    "cookies",
    "history",
    "login data",
    "secure preferences",
}
DENY_SUFFIXES = {".key", ".pem", ".pfx", ".sqlite", ".db"}
POLICY = (
    "Read-only file access. No write, modify, move, rename, delete, or shell "
    "command tools are exposed by this MCP server."
)


def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def result_text(text):
    return {"content": [{"type": "text", "text": text}]}


def normalize_path(raw):
    text = str(raw or ".").strip()
    if os.name != "nt":
        match = re.match(r"^([A-Za-z]):[\\/]*(.*)$", text)
        if match:
            drive = match.group(1).lower()
            rest = match.group(2).replace("\\", "/")
            return pathlib.Path(f"/mnt/{drive}/{rest}")
    return pathlib.Path(text)


def allowed_root_for(path):
    for root in ROOTS:
        try:
            path.relative_to(root)
            return root
        except ValueError:
            pass
    return None


def is_sensitive(path):
    lower_parts = {part.lower() for part in path.parts}
    name = path.name.lower()
    return bool(lower_parts & DENY_PARTS or name in DENY_NAMES or path.suffix.lower() in DENY_SUFFIXES)


def checked_path(raw):
    candidate = normalize_path(raw)
    path = candidate.resolve() if candidate.is_absolute() else (ROOTS[0] / str(raw).lstrip("/\\")).resolve()
    if not allowed_root_for(path):
        raise ValueError(f"path outside read-only roots: {raw}")
    if is_sensitive(path):
        raise PermissionError(f"sensitive path is blocked: {raw}")
    return path


def display_path(path):
    root = allowed_root_for(path)
    if not root:
        return path.as_posix()
    return f"{root.as_posix()}::{path.relative_to(root).as_posix()}"


def list_dir(args):
    raw = args.get("path", ".")
    if raw in (None, "", "."):
        rows = [f"root {root.as_posix()}" for root in ROOTS if root.exists()]
        return result_text("\n".join(rows) or "(no readable roots)")
    path = checked_path(raw)
    if not path.exists():
        raise FileNotFoundError(str(path))
    if not path.is_dir():
        raise NotADirectoryError(str(path))
    limit = max(1, min(int(args.get("limit", 200)), 1000))
    rows = []
    for child in sorted(path.iterdir(), key=lambda item: (not item.is_dir(), item.name.lower()))[:limit]:
        if is_sensitive(child):
            continue
        rows.append(f"{'dir ' if child.is_dir() else 'file'} {display_path(child)}")
    return result_text("\n".join(rows) or "(empty)")


def read_file(args):
    path = checked_path(args["path"])
    if not path.is_file():
        raise FileNotFoundError(str(path))
    data = path.read_bytes()[:MAX_READ]
    text = data.decode("utf-8", errors="replace")
    if path.stat().st_size > MAX_READ:
        text += f"\n\n[truncated at {MAX_READ} bytes]"
    return result_text(text)


def search_files(args):
    query = str(args["query"]).lower()
    limit = max(1, min(int(args.get("limit", 80)), 300))
    bases = [checked_path(args["path"])] if args.get("path") else [root for root in ROOTS if root.exists()]
    rows = []
    for base in bases:
        for dirpath, dirnames, filenames in os.walk(base, onerror=lambda _err: None):
            dirnames[:] = [name for name in dirnames if not is_sensitive(pathlib.Path(dirpath) / name)]
            for filename in filenames:
                if len(rows) >= limit:
                    return result_text("\n".join(rows) or "(no matches)")
                path = pathlib.Path(dirpath) / filename
                if is_sensitive(path):
                    continue
                shown = display_path(path)
                if query in shown.lower():
                    rows.append(shown)
                    continue
                try:
                    text = path.read_text("utf-8", errors="ignore")
                except Exception:
                    continue
                index = text.lower().find(query)
                if index >= 0:
                    line_no = text[:index].count("\n") + 1
                    line = text.splitlines()[line_no - 1][:240] if text.splitlines() else ""
                    rows.append(f"{shown}:{line_no}: {line}")
    return result_text("\n".join(rows) or "(no matches)")


TOOLS = {
    "list_dir": {
        "description": f"List files under read-only roots. {POLICY}",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}, "limit": {"type": "integer"}},
        },
        "handler": list_dir,
    },
    "read_file": {
        "description": f"Read one UTF-8 text file under read-only roots. Sensitive files are blocked. {POLICY}",
        "inputSchema": {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        },
        "handler": read_file,
    },
    "search_files": {
        "description": f"Search filenames and UTF-8 text under read-only roots. Sensitive files are blocked. {POLICY}",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "path": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["query"],
        },
        "handler": search_files,
    },
}


def handle(req):
    method = req.get("method")
    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "local_files", "version": "0.1.0-readonly"},
        }
    if method == "tools/list":
        return {"tools": [{"name": name, "description": tool["description"], "inputSchema": tool["inputSchema"]} for name, tool in TOOLS.items()]}
    if method == "tools/call":
        params = req.get("params", {}) or {}
        name = params.get("name")
        if name not in TOOLS:
            raise ValueError(f"unknown tool: {name}")
        return TOOLS[name]["handler"](params.get("arguments", {}) or {})
    return {}


for line in sys.stdin:
    line = line.lstrip("\ufeff").strip()
    if not line:
        continue
    try:
        req = json.loads(line)
        if "id" not in req:
            continue
        try:
            send({"jsonrpc": "2.0", "id": req["id"], "result": handle(req)})
        except Exception as exc:
            send({"jsonrpc": "2.0", "id": req["id"], "error": {"code": -32000, "message": str(exc)}})
    except Exception as exc:
        send({"jsonrpc": "2.0", "id": None, "error": {"code": -32700, "message": str(exc)}})
