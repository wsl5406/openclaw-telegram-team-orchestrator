#!/usr/bin/env python3
import html
import ipaddress
import json
import re
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")
if hasattr(sys.stderr, "reconfigure"):
    sys.stderr.reconfigure(encoding="utf-8")

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
MAX_RESPONSE_BYTES = 2 * 1024 * 1024  # 2MB
MAX_REDIRECTS = 3
FORBIDDEN_HOSTS = {
    "localhost",
    "metadata.google.internal",
    "metadata",
    "instance-data",
    "kubernetes.default",
    "kubernetes.default.svc",
}
FORBIDDEN_NETWORKS = [
    ipaddress.ip_network("0.0.0.0/8"),
    ipaddress.ip_network("10.0.0.0/8"),
    ipaddress.ip_network("100.64.0.0/10"),
    ipaddress.ip_network("127.0.0.0/8"),
    ipaddress.ip_network("169.254.0.0/16"),
    ipaddress.ip_network("172.16.0.0/12"),
    ipaddress.ip_network("192.0.0.0/24"),
    ipaddress.ip_network("192.0.2.0/24"),
    ipaddress.ip_network("192.88.99.0/24"),
    ipaddress.ip_network("192.168.0.0/16"),
    ipaddress.ip_network("198.18.0.0/15"),
    ipaddress.ip_network("198.51.100.0/24"),
    ipaddress.ip_network("203.0.113.0/24"),
    ipaddress.ip_network("224.0.0.0/4"),
    ipaddress.ip_network("240.0.0.0/4"),
    ipaddress.ip_network("255.255.255.255/32"),
    ipaddress.ip_network("::/128"),
    ipaddress.ip_network("::1/128"),
    ipaddress.ip_network("100::/64"),
    ipaddress.ip_network("fc00::/7"),
    ipaddress.ip_network("fe80::/10"),
    ipaddress.ip_network("ff00::/8"),
]
EXTRA_FORBIDDEN_IPS = {
    "169.254.169.254",  # AWS/GCP/OpenStack/Azure metadata
    "100.100.100.200",  # Alibaba Cloud metadata
}


def send(msg):
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def result_text(text):
    return {"content": [{"type": "text", "text": text}]}


def is_forbidden_ip(ip_obj):
    if isinstance(ip_obj, ipaddress.IPv6Address) and ip_obj.ipv4_mapped:
        ip_obj = ip_obj.ipv4_mapped
    if str(ip_obj) in EXTRA_FORBIDDEN_IPS:
        return True
    if ip_obj.is_loopback or ip_obj.is_private or ip_obj.is_link_local or ip_obj.is_multicast or ip_obj.is_reserved or ip_obj.is_unspecified:
        return True
    for net in FORBIDDEN_NETWORKS:
        if ip_obj in net:
            return True
    return False


def validate_url_target(url):
    parsed = urllib.parse.urlparse(url)
    scheme = parsed.scheme.lower()
    if scheme not in ("http", "https"):
        raise ValueError(f"Invalid URL scheme '{scheme}': only http and https are allowed")
    hostname = parsed.hostname
    if not hostname:
        raise ValueError("Invalid URL: missing hostname")
    hostname_lower = hostname.lower()
    if hostname_lower in FORBIDDEN_HOSTS or hostname_lower.endswith(".local") or hostname_lower.endswith(".internal") or hostname_lower.endswith(".localhost"):
        raise PermissionError(f"Access to hostname '{hostname}' is blocked")

    # Check direct IP representation
    try:
        ip = ipaddress.ip_address(hostname_lower)
        if is_forbidden_ip(ip):
            raise PermissionError(f"Access to private/local/metadata IP '{ip}' is blocked")
    except ValueError:
        pass

    # Resolve DNS and check all resolved IP addresses
    port = parsed.port or (443 if scheme == "https" else 80)
    try:
        addrinfo = socket.getaddrinfo(hostname, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror as exc:
        raise ValueError(f"DNS resolution failed for '{hostname}': {exc}")

    for item in addrinfo:
        sockaddr = item[4]
        ip_str = sockaddr[0]
        try:
            ip = ipaddress.ip_address(ip_str)
            if is_forbidden_ip(ip):
                raise PermissionError(f"Access to destination IP '{ip_str}' for host '{hostname}' is blocked")
        except ValueError:
            continue
    return parsed


class SafeRedirectHandler(urllib.request.HTTPRedirectHandler):
    def __init__(self, max_redirects=MAX_REDIRECTS):
        super().__init__()
        self.max_redirects = max_redirects
        self.redirect_count = 0

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        self.redirect_count += 1
        if self.redirect_count > self.max_redirects:
            raise urllib.error.HTTPError(req.full_url, code, f"Too many redirects (max {self.max_redirects})", headers, fp)
        validate_url_target(newurl)
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def fetch_url(url, timeout=12):
    validate_url_target(url)
    opener = urllib.request.build_opener(SafeRedirectHandler())
    req = urllib.request.Request(
        url,
        headers={
            "User-Agent": UA,
            "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
        },
    )
    with opener.open(req, timeout=timeout) as resp:
        data = resp.read(MAX_RESPONSE_BYTES)
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
