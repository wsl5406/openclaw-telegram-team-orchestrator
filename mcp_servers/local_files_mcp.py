import json
import os
import pathlib
import re
import sys
import time

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
MAX_SEARCH_FILES = int(os.environ.get("OPENCLAW_SEARCH_MAX_FILES", "2000"))
MAX_SEARCH_BYTES = int(os.environ.get("OPENCLAW_SEARCH_MAX_BYTES", "20000000"))  # 20MB
SEARCH_TIMEOUT_SECONDS = float(os.environ.get("OPENCLAW_SEARCH_TIMEOUT", "10.0"))
DENY_PARTS = {
    ".git",
    ".svn",
    ".hg",
    ".ssh",
    ".gnupg",
    ".aws",
    ".azure",
    ".gcp",
    ".kube",
    ".docker",
    ".config",
    "auth_info",
    "chrome_user_data",
    "cookies",
    "node_modules",
    "venv",
    ".venv",
    "__pycache__",
    "1password",
    "bitwarden",
    "keepass",
    "keepassxc",
    "lastpass",
    "dashlane",
    "backup",
    "backups",
    ".backup",
    ".bak",
    "credentials",
    "google/chrome",
    "mozilla/firefox",
    "microsoft/edge",
    "brave-browser",
    "session storage",
    "indexeddb",
    "local storage",
}
DENY_NAMES = {
    ".env",
    ".env.local",
    ".env.production",
    ".env.development",
    ".env.staging",
    ".env.test",
    ".bash_history",
    ".zsh_history",
    ".node_repl_history",
    ".python_history",
    "id_rsa",
    "id_ecdsa",
    "id_ed25519",
    "id_dsa",
    "known_hosts",
    "authorized_keys",
    "cookies",
    "history",
    "login data",
    "web data",
    "secure preferences",
    "credentials",
    "credentials.json",
    "service_account.json",
    "shadow",
    "passwd",
    "sudoers",
    "master.key",
}
DENY_SUFFIXES = {
    ".token",
    ".secret",
    ".credentials",
    ".config",
    ".bak",
    ".backup",
    ".key",
    ".pem",
    ".pfx",
    ".p12",
    ".pkcs12",
    ".sqlite",
    ".sqlite3",
    ".db",
    ".kdbx",
    ".kdb",
    ".rdp",
    ".ovpn",
    ".asc",
    ".cer",
    ".crt",
    ".jks",
    ".keystore",
}
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
    suffix = path.suffix.lower()
    if bool(lower_parts & DENY_PARTS):
        return True
    if name in DENY_NAMES:
        return True
    if suffix in DENY_SUFFIXES:
        return True
    # Check hidden sensitive files
    if name.startswith(".") and any(k in name for k in ("env", "secret", "token", "cred", "pass", "key", "history", "ssh", "conf")):
        return True
    return False


def checked_path(raw):
    candidate = normalize_path(raw)
    path = candidate.resolve() if candidate.is_absolute() else (ROOTS[0] / str(raw).lstrip("/\\")).resolve()
    if not allowed_root_for(path):
        raise ValueError(f"path outside read-only roots: {raw}")
    if is_sensitive(path):
        raise PermissionError(f"sensitive path is blocked: {raw}")
    # Symlink target resolution check
    try:
        real_path = path.resolve(strict=False)
        if not allowed_root_for(real_path):
            raise ValueError(f"symlink target outside read-only roots: {raw}")
        if is_sensitive(real_path):
            raise PermissionError(f"symlink target is sensitive: {raw}")
    except (OSError, RuntimeError) as exc:
        raise PermissionError(f"failed to resolve path safety: {exc}")
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
        try:
            if child.is_symlink():
                target = child.resolve(strict=False)
                if not allowed_root_for(target) or is_sensitive(target):
                    continue
        except (OSError, RuntimeError):
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
    files_scanned = 0
    bytes_scanned = 0
    start_time = time.monotonic()
    timed_out = False
    limit_reached = False

    for base in bases:
        if timed_out or limit_reached or len(rows) >= limit:
            break
        for dirpath, dirnames, filenames in os.walk(base, onerror=lambda _err: None):
            if time.monotonic() - start_time > SEARCH_TIMEOUT_SECONDS:
                timed_out = True
                break
            dirnames[:] = [name for name in dirnames if not is_sensitive(pathlib.Path(dirpath) / name)]
            for filename in filenames:
                if time.monotonic() - start_time > SEARCH_TIMEOUT_SECONDS:
                    timed_out = True
                    break
                if files_scanned >= MAX_SEARCH_FILES or bytes_scanned >= MAX_SEARCH_BYTES:
                    limit_reached = True
                    break
                if len(rows) >= limit:
                    break
                path = pathlib.Path(dirpath) / filename
                files_scanned += 1
                if is_sensitive(path):
                    continue
                try:
                    if path.is_symlink():
                        real_target = path.resolve(strict=False)
                        if not allowed_root_for(real_target) or is_sensitive(real_target):
                            continue
                except (OSError, RuntimeError):
                    continue
                shown = display_path(path)
                if query in shown.lower():
                    rows.append(shown)
                    continue
                try:
                    stat = path.stat()
                    if stat.st_size > MAX_READ:
                        continue
                    bytes_scanned += stat.st_size
                    text = path.read_text("utf-8", errors="ignore")
                except Exception:
                    continue
                index = text.lower().find(query)
                if index >= 0:
                    line_no = text[:index].count("\n") + 1
                    line = text.splitlines()[line_no - 1][:240] if text.splitlines() else ""
                    rows.append(f"{shown}:{line_no}: {line}")
            if len(rows) >= limit:
                break

    notes = []
    if timed_out:
        notes.append(f"[search timed out after {SEARCH_TIMEOUT_SECONDS}s]")
    if limit_reached:
        notes.append(f"[search limits reached: {files_scanned} files / {bytes_scanned} bytes scanned]")
    if notes:
        rows.append(" ".join(notes))
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


def main():
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


if __name__ == "__main__":
    main()
