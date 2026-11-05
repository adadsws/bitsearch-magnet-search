"""Bitsearch 官方 API 的本地只读 WebUI 代理。"""

from __future__ import annotations

import json
import os
import re
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

from .bitsearch_api import APIError, request
from .torrent_metadata import MetadataError, file_sizes

STATIC = Path(__file__).resolve().parent.parent / "static"


class Handler(BaseHTTPRequestHandler):
    def send_json(self, payload: dict, status: int = 200) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self) -> None:
        parsed = urlparse(self.path)
        query = parse_qs(parsed.query)
        api_key = os.environ.get("BITSEARCH_API_KEY", "")
        if parsed.path == "/api/categories":
            try:
                return self.send_json(request("/categories", api_key=api_key))
            except APIError as exc:
                return self.send_json({"error": str(exc), "rate_limit": exc.rate_limit}, exc.status)
        if parsed.path == "/api/search":
            term = query.get("q", [""])[0].strip()
            if not term or len(term) > 120:
                return self.send_json({"error": "请输入 1–120 个字符的搜索词"}, 400)
            try:
                page = int(query.get("page", ["1"])[0])
                if not 1 <= page <= 1000:
                    raise ValueError("page out of range")
            except ValueError:
                return self.send_json({"error": "页码必须是 1–1000 的整数"}, 400)
            category = query.get("category", [""])[0]
            subcategory = query.get("subCategory", [""])[0]
            sort = query.get("sort", ["relevance"])[0]
            order = query.get("order", ["desc"])[0]
            try:
                limit = int(query.get("limit", ["20"])[0])
                if not 1 <= limit <= 100:
                    raise ValueError("limit out of range")
            except ValueError:
                return self.send_json({"error": "每页条数必须是 1–100 的整数"}, 400)
            if (not re.fullmatch(r"(?:[1-9]|10)?", category)
                    or not re.fullmatch(r"\d{0,2}", subcategory)
                    or (subcategory and not category)
                    or sort not in {"relevance", "seeders", "date", "size", "leechers"}
                    or order not in {"asc", "desc"}):
                return self.send_json({"error": "无效的分类或排序条件"}, 400)
            params = {"q": term, "page": page, "limit": limit, "sort": sort, "order": order}
            if category:
                params["category"] = category
            if subcategory:
                params["subCategory"] = subcategory
            try:
                return self.send_json(request("/search", params, api_key=api_key))
            except APIError as exc:
                return self.send_json({"error": str(exc), "rate_limit": exc.rate_limit}, exc.status)
        if parsed.path == "/api/detail":
            torrent_id = query.get("id", [""])[0]
            if not re.fullmatch(r"[0-9a-f]{24}|[0-9a-f]{40}", torrent_id, re.I):
                return self.send_json({"error": "无效的 Bitsearch ID 或 infohash"}, 400)
            try:
                return self.send_json(request(f"/torrent/{torrent_id}", api_key=api_key))
            except APIError as exc:
                return self.send_json({"error": str(exc), "rate_limit": exc.rate_limit}, exc.status)
        if parsed.path == "/api/torrent-file-sizes":
            infohash = query.get("infohash", [""])[0]
            if not re.fullmatch(r"[0-9a-f]{40}", infohash, re.I):
                return self.send_json({"error": "无效的 Torrent infohash"}, 400)
            try:
                sizes = file_sizes(infohash.upper())
                return self.send_json({"files": [{"path": path, "size": size}
                                                 for path, size in sizes.items()]})
            except MetadataError as exc:
                return self.send_json({"error": str(exc)}, 502)
        name = "index.html" if parsed.path == "/" else parsed.path.lstrip("/")
        if name not in {"index.html", "search.js", "local_pages.js", "file_paths.js", "style.css"}:
            return self.send_error(404)
        data = (STATIC / name).read_bytes()
        mime = {"index.html": "text/html", "search.js": "text/javascript",
                "local_pages.js": "text/javascript", "file_paths.js": "text/javascript",
                "style.css": "text/css"}[name]
        self.send_response(200)
        self.send_header("Content-Type", mime + "; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(description="Bitsearch 搜索 WebUI")
    parser.add_argument("--port", type=int, default=8766)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    print(f"Bitsearch WebUI: http://127.0.0.1:{args.port}/", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
