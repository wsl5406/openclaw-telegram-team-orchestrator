#!/usr/bin/env python3
import html
import json
import re
import sys
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"


def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def result_text(text):
    return {"content": [{"type": "text", "text": text}]}


def fetch_url(url, timeout=12):
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        data = resp.read()
        charset = resp.headers.get_content_charset()
        return decode_bytes(data, charset), resp.geturl()


def decode_bytes(data, declared_charset=None):
    candidates = [declared_charset, "utf-8", "gb18030", "gbk"]
    best = ""
    best_score = -1
    for charset in [item for item in candidates if item]:
        try:
            text = data.decode(charset, errors="replace")
        except LookupError:
            continue
        score = len(text) - text.count("\ufffd") * 20
        if score > best_score:
            best = text
            best_score = score
    return best or data.decode("utf-8", errors="replace")


def clean_html(text):
    text = re.sub(r"(?is)<(script|style|noscript).*?</\1>", " ", text)
    text = re.sub(r"(?is)<br\s*/?>", "\n", text)
    text = re.sub(r"(?is)</p>|</div>|</li>|</h[1-6]>", "\n", text)
    text = re.sub(r"(?is)<.*?>", " ", text)
    text = html.unescape(text)
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text)
    return text.strip()


def absolutize_url(href, base_url):
    if href.startswith("//"):
        return "https:" + href
    if href.startswith("/"):
        return base_url.rstrip("/") + href
    return href


def parse_generic_search(page, base_url, limit):
    rows = []
    blocks = re.findall(r'(?is)<li[^>]*>.*?</li>|<div[^>]+class="[^"]*(?:result|res-list|b_algo|vrwrap)[^"]*"[^>]*>.*?</div>', page)
    if not blocks:
        blocks = re.findall(r'(?is)<a[^>]+href="[^"]+"[^>]*>.*?</a>', page)
    for block in blocks:
        match = re.search(r'(?is)<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>', block)
        if not match:
            continue
        href = absolutize_url(html.unescape(match.group(1)).strip(), base_url)
        title = clean_html(match.group(2))
        if not href.startswith("http") or not title or len(title) < 2:
            continue
        if re.search(r"/help/|settings|src=sidenav|src=pc_so_top|javascript:", href, re.I):
            continue
        snippet = clean_html(block).replace(title, "", 1).strip()
        item = f"{len(rows) + 1}. {title}\n{href}"
        if snippet:
            item += f"\n{snippet[:260]}"
        rows.append(item)
        if len(rows) >= limit:
            break
    return rows


def bing_search(query, limit):
    page, _ = fetch_url("https://www.bing.com/search?" + urllib.parse.urlencode({"q": query, "mkt": "zh-CN"}))
    rows = []
    for block in re.findall(r'(?is)<li class="b_algo".*?</li>', page):
        title_match = re.search(r'(?is)<h2.*?<a[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?</h2>', block)
        if not title_match:
            continue
        href = html.unescape(title_match.group(1)).strip()
        title = clean_html(title_match.group(2))
        snippet_match = re.search(r'(?is)<p[^>]*>(.*?)</p>', block)
        snippet = clean_html(snippet_match.group(1)) if snippet_match else ""
        item = f"{len(rows) + 1}. {title}\n{href}"
        if snippet:
            item += f"\n{snippet[:260]}"
        rows.append(item)
        if len(rows) >= limit:
            break
    return rows


def duckduckgo_search(query, limit):
    page, _ = fetch_url("https://html.duckduckgo.com/html/?" + urllib.parse.urlencode({"q": query}))
    rows = []
    for match in re.finditer(r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>', page, re.S):
        href = html.unescape(match.group(1))
        title = clean_html(match.group(2))
        href = urllib.parse.parse_qs(urllib.parse.urlparse(href).query).get("uddg", [href])[0]
        rows.append(f"{len(rows) + 1}. {title}\n{href}")
        if len(rows) >= limit:
            break
    return rows


def so360_search(query, limit):
    page, _ = fetch_url("https://www.so.com/s?" + urllib.parse.urlencode({"q": query}))
    return parse_generic_search(page, "https://www.so.com", limit)


def sogou_search(query, limit):
    page, _ = fetch_url("https://www.sogou.com/web?" + urllib.parse.urlencode({"query": query}))
    return parse_generic_search(page, "https://www.sogou.com", limit)


def internet_search(args):
    query = str(args["query"]).strip()
    limit = max(1, min(int(args.get("limit", 5)), 10))
    errors = []
    for name, fn in [("bing", bing_search), ("duckduckgo", duckduckgo_search), ("360", so360_search), ("sogou", sogou_search)]:
        try:
            rows = fn(query, limit)
            if rows:
                return result_text("\n\n".join(f"[{name}] {row}" for row in rows[:limit]))
            errors.append(f"{name}: no results")
        except Exception as exc:
            errors.append(f"{name}: {type(exc).__name__}: {exc}")
    return result_text("SEARCH_FAILED: " + " | ".join(errors))


def internet_fetch(args):
    url = str(args["url"]).strip()
    max_chars = max(1000, min(int(args.get("max_chars", 8000)), 20000))
    page, final_url = fetch_url(url)
    title_match = re.search(r"(?is)<title[^>]*>(.*?)</title>", page)
    title = clean_html(title_match.group(1)) if title_match else final_url
    text = clean_html(page)[:max_chars]
    return result_text(f"URL: {final_url}\nTITLE: {title}\n\n{text}")


TOOLS = {
    "internet_search": {
        "description": "Search the web and return titles, URLs, and short snippets.",
        "inputSchema": {
            "type": "object",
            "properties": {"query": {"type": "string"}, "limit": {"type": "integer"}},
            "required": ["query"],
        },
        "handler": internet_search,
    },
    "internet_fetch": {
        "description": "Fetch one URL and return readable text.",
        "inputSchema": {
            "type": "object",
            "properties": {"url": {"type": "string"}, "max_chars": {"type": "integer"}},
            "required": ["url"],
        },
        "handler": internet_fetch,
    },
}


def handle(req):
    method = req.get("method")
    if method == "initialize":
        return {
            "protocolVersion": "2024-11-05",
            "capabilities": {"tools": {}},
            "serverInfo": {"name": "internet_research", "version": "0.1.0"},
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
