"""Bitsearch 官方 REST API 客户端；保留响应字段与限额信息。"""

from __future__ import annotations

from concurrent.futures import Future
from datetime import datetime, timezone
from hashlib import sha256
import json
from threading import Lock
from time import time

import requests

from . import persistent_cache


BASE = "https://bitsearch.eu/api/v1"
_cache: dict[tuple, tuple[float, dict]] = {}
_inflight: dict[tuple, Future[dict]] = {}
_latest_rate: dict[str, dict] = {}
_lock = Lock()


def _reset_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)
    except ValueError:
        return None


def _remember_rate(api_key: str, observed: dict) -> dict:
    """同一重置周期保留最低剩余额度，避免乱序响应使数字回升。"""
    with _lock:
        previous = _latest_rate.get(api_key, {})
        if not observed:
            return previous.copy()
        previous_reset = _reset_time(previous.get("reset"))
        observed_reset = _reset_time(observed.get("reset"))
        if previous_reset and observed_reset and observed_reset < previous_reset:
            return previous.copy()
        current = {**previous, **observed}
        if previous_reset and observed_reset and observed_reset == previous_reset:
            try:
                current["remaining"] = str(min(int(previous["remaining"]), int(observed["remaining"])))
            except (KeyError, TypeError, ValueError):
                pass
        _latest_rate[api_key] = current
        return current.copy()


def _with_current_rate(result: dict, api_key: str, *, cached: bool) -> dict:
    with _lock:
        rate = _latest_rate.get(api_key, result["rate_limit"]).copy()
    return {**result, "rate_limit": rate, "cached": cached}


class APIError(Exception):
    def __init__(self, status: int, message: str, rate_limit: dict):
        super().__init__(message)
        self.status = status
        self.rate_limit = rate_limit


def request(path: str, params: dict | None = None, *, api_key: str = "") -> dict:
    """缓存成功响应，并合并跨浏览器标签同时发出的同一请求。"""
    key = (path, tuple(sorted((params or {}).items())), api_key)
    disk_key = json.dumps([path, key[1], sha256(api_key.encode()).hexdigest()], ensure_ascii=False)
    with _lock:
        cached = _cache.get(key)
        if cached and cached[0] > time():
            return {**cached[1], "rate_limit": _latest_rate.get(api_key, cached[1]["rate_limit"]).copy(),
                    "cached": True}
        pending = _inflight.get(key)
        owner = pending is None
        if owner:
            pending = Future()
            _inflight[key] = pending
    if not owner:
        return _with_current_rate(pending.result(), api_key, cached=True)
    try:
        stored = persistent_cache.get(disk_key)
        if stored:
            with _lock:
                _cache[key] = stored
            pending.set_result(stored[1])
            return _with_current_rate(stored[1], api_key, cached=True)
        result = _fetch(path, params, api_key)
        expires_at = time() + persistent_cache.TTL_SECONDS
        with _lock:
            _cache[key] = (expires_at, result)
        persistent_cache.put(disk_key, result, expires_at)
        pending.set_result(result)
        return _with_current_rate(result, api_key, cached=False)
    except Exception as exc:
        pending.set_exception(exc)
        raise
    finally:
        with _lock:
            _inflight.pop(key, None)


def _fetch(path: str, params: dict | None, api_key: str) -> dict:
    """执行一次真实上游请求；错误不进入成功缓存。"""
    headers = {"Accept": "application/json", "User-Agent": "Bitsearch-WebUI/1.0"}
    if api_key:
        headers["x-api-key"] = api_key
    try:
        response = requests.get(BASE + path, params=params, headers=headers, timeout=25)
    except requests.RequestException as exc:
        raise APIError(502, f"Bitsearch API 网络错误：{exc}", {}) from exc
    rate = {name: response.headers.get(header) for name, header in {
        "limit": "X-RateLimit-Limit", "remaining": "X-RateLimit-Remaining",
        "reset": "X-RateLimit-Reset", "tier": "X-RateLimit-Tier"}.items()
            if response.headers.get(header) is not None}
    rate = _remember_rate(api_key, rate)
    try:
        data = response.json()
    except ValueError as exc:
        raise APIError(502, "Bitsearch API 返回非 JSON 数据", rate) from exc
    if not response.ok or data.get("success") is False:
        message = data.get("error") or data.get("message") or response.reason
        raise APIError(response.status_code if response.status_code >= 400 else 502,
                       f"Bitsearch API：{message}", rate)
    return {**data, "rate_limit": rate, "cached": False}
