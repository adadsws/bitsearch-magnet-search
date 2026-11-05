"""按 infohash 下载受限的 .torrent 元数据，复用项目 bencode 读取器提取逐文件大小。"""

from __future__ import annotations

import hashlib
from time import time
from urllib.parse import parse_qs, urljoin, urlparse

import requests

from .bencode import BencodeReader, decode_name
from . import persistent_cache


MAX_TORRENT_BYTES = 8 * 1024 * 1024
ALLOWED_HOSTS = {"bitsearch.eu", "itorrents.org", "itorrents.net", "torrage.info"}


class MetadataError(Exception):
    """外部元数据缺失、不可用或校验失败。"""


def _matching_source(url: str, infohash: str) -> bool:
    """跳转后仍须是已知缓存站的同一 infohash 下载地址。"""
    parsed = urlparse(url)
    if (parsed.scheme != "https" or parsed.hostname not in ALLOWED_HOSTS
            or parsed.port not in {None, 443} or parsed.username or parsed.password):
        return False
    hash_upper = infohash.upper()
    if parsed.hostname == "bitsearch.eu":
        return parsed.path.upper() == f"/DOWNLOAD/TORRENT/{hash_upper}"
    if parsed.hostname in {"itorrents.org", "itorrents.net"}:
        return parsed.path.upper() == f"/TORRENT/{hash_upper}.TORRENT"
    return parsed.path == "/torrent.php" and parse_qs(parsed.query).get("h", [""])[0].upper() == hash_upper


def parse_file_sizes(data: bytes, expected_hash: str) -> dict[str, int]:
    """仅接受 infohash 完全一致的元数据，返回完整路径到字节数的映射。"""
    try:
        reader = BencodeReader(data)
        torrent = reader.read()
        if reader.offset != len(data) or reader.info_span is None:
            raise ValueError("元数据结构不完整")
        start, end = reader.info_span
        if hashlib.sha1(data[start:end]).hexdigest().lower() != expected_hash.lower():
            raise MetadataError("Torrent infohash 与搜索结果不一致")
        info = torrent[b"info"]
        name = decode_name(info.get(b"name.utf-8") or info[b"name"])
        files: dict[str, int] = {}
        if b"files" in info:
            for entry in info[b"files"]:
                path = entry.get(b"path.utf-8") or entry[b"path"]
                parts = [decode_name(part) for part in path]
                size = entry[b"length"]
                if not parts or not isinstance(size, int) or size < 0:
                    raise ValueError("文件条目无效")
                full_path = "/".join([name, *parts])
                if full_path in files and files[full_path] != size:
                    raise ValueError("相同文件路径的大小冲突")
                files[full_path] = size
        else:
            size = info[b"length"]
            if not isinstance(size, int) or size < 0:
                raise ValueError("文件大小无效")
            files[name] = size
        return files
    except MetadataError:
        raise
    except (AttributeError, IndexError, KeyError, RecursionError, TypeError, ValueError) as exc:
        raise MetadataError("Torrent 元数据不完整或损坏") from exc


def download_torrent(infohash: str, url: str | None = None) -> bytes:
    """仅访问可信元数据缓存；限制跳转、体积及协议。"""
    url = url or f"https://bitsearch.eu/download/torrent/{infohash.upper()}"
    try:
        for hop in range(4):
            parsed = urlparse(url)
            if (parsed.scheme == "http" and parsed.hostname in {"itorrents.org", "itorrents.net"}
                    and parsed.port is None):
                url = parsed._replace(scheme="https").geturl()
                parsed = urlparse(url)
            if not _matching_source(url, infohash):
                reason = "下载地址不受信任" if hop == 0 else "来源未收录 Torrent（跳转到无关页面）"
                raise MetadataError(reason)
            with requests.get(url, headers={"User-Agent": "Bitsearch-WebUI/1.0"},
                              timeout=(5, 12), stream=True, allow_redirects=False) as response:
                if response.status_code in {301, 302, 303, 307, 308}:
                    location = response.headers.get("Location")
                    if not location:
                        raise MetadataError("Torrent 下载跳转缺少地址")
                    url = urljoin(url, location)
                    continue
                if response.status_code == 404:
                    raise MetadataError("Torrent 元数据未收录")
                response.raise_for_status()
                if "text/html" in response.headers.get("Content-Type", "").lower():
                    raise MetadataError("来源返回网页，没有 Torrent 元数据")
                length = response.headers.get("Content-Length")
                if length and int(length) > MAX_TORRENT_BYTES:
                    raise MetadataError("Torrent 元数据超过大小上限")
                chunks: list[bytes] = []
                size = 0
                for chunk in response.iter_content(65536):
                    size += len(chunk)
                    if size > MAX_TORRENT_BYTES:
                        raise MetadataError("Torrent 元数据超过大小上限")
                    chunks.append(chunk)
                data = b"".join(chunks)
                if not data.startswith(b"d"):
                    raise MetadataError("来源未返回 Torrent 元数据")
                return data
        raise MetadataError("Torrent 下载跳转次数过多")
    except (requests.RequestException, ValueError) as exc:
        raise MetadataError(f"Torrent 下载失败：{exc}") from exc


def file_sizes(infohash: str) -> dict[str, int]:
    """依次核验固定来源；成功结果跨进程缓存一小时，失败可重试。"""
    normalized = infohash.upper()
    cache_key = f"torrent-files:{normalized}"
    cached = persistent_cache.get(cache_key)
    if cached:
        return cached[1]
    sources = (
        ("Bitsearch", f"https://bitsearch.eu/download/torrent/{normalized}"),
        ("iTorrents", f"https://itorrents.net/torrent/{normalized}.torrent"),
        ("Torrage", f"https://torrage.info/torrent.php?h={normalized}"),
    )
    failures = []
    for name, url in sources:
        try:
            sizes = parse_file_sizes(download_torrent(normalized, url), normalized)
            persistent_cache.put(cache_key, sizes, time() + persistent_cache.TTL_SECONDS)
            return sizes
        except MetadataError as exc:
            failures.append(f"{name}：{exc}")
    raise MetadataError("已知 Torrent 元数据来源均不可用；" + "；".join(failures))
