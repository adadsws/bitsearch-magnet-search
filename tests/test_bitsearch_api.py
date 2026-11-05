"""核对官方 API 代理的响应、限额与失败语义。"""

from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
import subprocess
import sys
from threading import Event
from unittest.mock import patch

import pytest

from magnet_search import persistent_cache
from magnet_search.bitsearch_api import APIError, _cache, _latest_rate, request


@pytest.fixture(autouse=True)
def isolated_cache(tmp_path, monkeypatch):
    monkeypatch.setattr(persistent_cache, "CACHE_PATH", tmp_path / "responses.sqlite3")
    _cache.clear()
    _latest_rate.clear()


class Response:
    def __init__(self, status: int, data: dict):
        self.status_code = status
        self.data = data
        self.ok = status < 400
        self.reason = "Too Many Requests" if status == 429 else "OK"
        self.headers = {"X-RateLimit-Limit": "200", "X-RateLimit-Remaining": "199"}

    def json(self):
        return self.data


def test_search_preserves_api_fields_and_caches_success():
    _cache.clear()
    payload = {"success": True, "results": [{"id": "abc", "updatedAt": "2026-11-02"}],
               "pagination": {"total": 1}, "took": 2}
    with patch("magnet_search.bitsearch_api.requests.get", return_value=Response(200, payload)) as get:
        first = request("/search", {"q": "sample", "limit": 2})
        second = request("/search", {"q": "sample", "limit": 2})
    assert first["results"] == payload["results"]
    assert first["pagination"] == payload["pagination"]
    assert first["rate_limit"]["remaining"] == "199"
    assert first["cached"] is False and second["cached"] is True
    assert get.call_count == 1


@pytest.mark.parametrize("path, params", [
    ("/search", {"q": "Mushoku Tensei"}),
    ("/torrent/0123456789abcdef01234567", None),
])
def test_disk_cache_survives_memory_reset_and_expires(tmp_path, monkeypatch, path, params):
    payload = {"success": True, "results": [{"id": "reopened"}]}
    with patch("magnet_search.bitsearch_api.requests.get", return_value=Response(200, payload)) as get:
        first = request(path, params)
        _cache.clear()  # 模拟进程重启后的内存状态。
        second = request(path, params)
        assert second["cached"] is True
        assert get.call_count == 1
        monkeypatch.setattr(persistent_cache, "time", lambda: 10**12)
        _cache.clear()
        expired = request(path, params)
    assert expired["cached"] is False
    assert get.call_count == 2


@pytest.mark.parametrize("path, params", [
    ("/search", {"q": "Mushoku Tensei"}),
    ("/torrent/0123456789abcdef01234567", None),
])
def test_identical_api_request_survives_process_restart(tmp_path, path, params):
    cache_path = tmp_path / "restart.sqlite3"
    script = """from pathlib import Path
from unittest.mock import patch
from magnet_search import persistent_cache
from magnet_search.bitsearch_api import request
persistent_cache.CACHE_PATH = Path(__import__('sys').argv[1])
phase = __import__('sys').argv[2]
with patch('magnet_search.bitsearch_api._fetch', side_effect=(lambda *args: {'success': True, 'rate_limit': {}, 'results': [1]}) if phase == 'first' else AssertionError('unexpected upstream request')):
    print(request(__import__('sys').argv[3], __import__('json').loads(__import__('sys').argv[4]))['cached'])
"""
    import json
    args = [path, json.dumps(params)]
    first = subprocess.run([sys.executable, "-c", script, str(cache_path), "first", *args],
                           capture_output=True, text=True, check=True)
    second = subprocess.run([sys.executable, "-c", script, str(cache_path), "second", *args],
                            capture_output=True, text=True, check=True)
    assert first.stdout.strip() == "False"
    assert second.stdout.strip() == "True"


def test_limit_error_is_not_cached_and_keeps_rate_headers():
    _cache.clear()
    _latest_rate.clear()
    with patch("magnet_search.bitsearch_api.requests.get",
               return_value=Response(429, {"success": False, "error": "rate limit exceeded"})):
        with pytest.raises(APIError) as caught:
            request("/torrent/abc")
    assert caught.value.status == 429
    assert caught.value.rate_limit["remaining"] == "199"
    assert _latest_rate[""]["remaining"] == "199"
    assert "rate limit exceeded" in str(caught.value)
    assert not _cache


def test_api_key_stays_in_request_header():
    _cache.clear()
    with patch("magnet_search.bitsearch_api.requests.get", return_value=Response(200, {"success": True})) as get:
        request("/categories", api_key="example-key")
    assert get.call_args.kwargs["headers"]["x-api-key"] == "example-key"
    assert "example-key" not in get.call_args.args[0]


def test_concurrent_identical_requests_share_one_upstream_call():
    _cache.clear()
    entered, release, follower_started = Event(), Event(), Event()

    def slow_get(*args, **kwargs):
        entered.set()
        assert release.wait(2)
        return Response(200, {"success": True, "results": []})

    def follower():
        follower_started.set()
        return request("/search", {"q": "parallel"})

    with patch("magnet_search.bitsearch_api.requests.get", side_effect=slow_get) as get:
        with ThreadPoolExecutor(max_workers=2) as pool:
            first = pool.submit(request, "/search", {"q": "parallel"})
            assert entered.wait(1)
            second = pool.submit(follower)
            assert follower_started.wait(1)
            release.set()
            assert first.result()["cached"] is False
            assert second.result()["cached"] is True
    assert get.call_count == 1


def test_cached_page_uses_latest_known_quota():
    _cache.clear()
    _latest_rate.clear()
    first = Response(200, {"success": True, "results": []})
    second = Response(200, {"success": True, "results": []})
    second.headers["X-RateLimit-Remaining"] = "198"
    with patch("magnet_search.bitsearch_api.requests.get", side_effect=[first, second]) as get:
        request("/search", {"q": "first"})
        request("/search", {"q": "second"})
        cached = request("/search", {"q": "first"})
    assert cached["cached"] is True
    assert cached["rate_limit"]["remaining"] == "198"
    assert get.call_count == 2


def test_quota_ignores_out_of_order_responses_and_accepts_reset():
    _cache.clear()
    _latest_rate.clear()
    replies = [Response(200, {"success": True}) for _ in range(5)]
    values = [("2026-11-03T00:00:00Z", "190"),
              ("2026-11-03T00:00:00Z", "188"),
              ("2026-11-03T00:00:00.000Z", "189"),
              ("2026-11-04T00:00:00Z", "200"),
              ("2026-11-03T00:00:00Z", "187")]
    for reply, (reset, remaining) in zip(replies, values):
        reply.headers.update({"X-RateLimit-Reset": reset,
                              "X-RateLimit-Remaining": remaining})
    with patch("magnet_search.bitsearch_api.requests.get", side_effect=replies):
        observed = [request("/search", {"q": f"quota-{index}"})["rate_limit"]
                    for index in range(len(replies))]
    assert [item["remaining"] for item in observed] == ["190", "188", "188", "200", "200"]
    assert _latest_rate[""]["reset"] == "2026-11-04T00:00:00Z"


def test_late_completion_cannot_replace_newer_quota():
    _cache.clear()
    _latest_rate.clear()
    first_entered, release_first = Event(), Event()

    def get(*args, **kwargs):
        response = Response(200, {"success": True})
        response.headers["X-RateLimit-Reset"] = "2026-11-03T00:00:00Z"
        if kwargs["params"]["q"] == "older":
            first_entered.set()
            assert release_first.wait(2)
            response.headers["X-RateLimit-Remaining"] = "190"
        else:
            response.headers["X-RateLimit-Remaining"] = "189"
        return response

    with patch("magnet_search.bitsearch_api.requests.get", side_effect=get):
        with ThreadPoolExecutor(max_workers=2) as pool:
            older = pool.submit(request, "/search", {"q": "older"})
            assert first_entered.wait(1)
            newer = pool.submit(request, "/search", {"q": "newer"})
            assert newer.result()["rate_limit"]["remaining"] == "189"
            release_first.set()
            assert older.result()["rate_limit"]["remaining"] == "189"
    assert _latest_rate[""]["remaining"] == "189"
