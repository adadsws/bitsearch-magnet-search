"""验证 Torrent 元数据校验、逐文件大小及受限下载跳转。"""

from __future__ import annotations

import hashlib
from unittest.mock import patch

import pytest

from magnet_search.torrent_metadata import MetadataError, download_torrent, file_sizes, parse_file_sizes


def encode(value):
    if isinstance(value, int):
        return b"i" + str(value).encode() + b"e"
    if isinstance(value, bytes):
        return str(len(value)).encode() + b":" + value
    if isinstance(value, list):
        return b"l" + b"".join(map(encode, value)) + b"e"
    return b"d" + b"".join(encode(key) + encode(value[key]) for key in sorted(value)) + b"e"


def sample_torrent():
    info = {b"name": b"Root", b"files": [
        {b"length": 1_500_000_000, b"path": [b"Movies", b"first.mp4"]},
        {b"length": 2_000_000_000, b"path": [b"Movies", b"second.mp4"]},
    ]}
    return encode({b"info": info}), hashlib.sha1(encode(info)).hexdigest()


def test_parses_file_sizes_only_for_matching_infohash():
    data, infohash = sample_torrent()
    assert parse_file_sizes(data, infohash) == {
        "Root/Movies/first.mp4": 1_500_000_000,
        "Root/Movies/second.mp4": 2_000_000_000,
    }
    with pytest.raises(MetadataError, match="infohash"):
        parse_file_sizes(data, "0" * 40)


def test_single_file_torrent_keeps_its_exact_length():
    info = {b"name": b"video.mp4", b"length": 1_234_567_890}
    data = encode({b"info": info})
    infohash = hashlib.sha1(encode(info)).hexdigest()
    assert parse_file_sizes(data, infohash) == {"video.mp4": 1_234_567_890}


def test_truncated_torrent_reports_clear_failure():
    data, infohash = sample_torrent()
    with pytest.raises(MetadataError, match="不完整或损坏"):
        parse_file_sizes(data[:-3], infohash)


class Response:
    def __init__(self, status, *, location="", body=b""):
        self.status_code = status
        self.headers = {"Location": location} if location else {}
        self.body = body

    def __enter__(self):
        return self

    def __exit__(self, *_):
        return False

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError("HTTP error")

    def iter_content(self, _):
        yield self.body


def test_download_follows_only_known_metadata_host():
    data, infohash = sample_torrent()
    with patch("magnet_search.torrent_metadata.requests.get", side_effect=[
        Response(302, location=f"https://itorrents.org/torrent/{infohash}.torrent"),
        Response(301, location=f"http://itorrents.net/torrent/{infohash}.torrent"),
        Response(200, body=data),
    ]) as get:
        assert download_torrent(infohash) == data
    assert get.call_count == 3
    assert get.call_args.args[0].startswith("https://itorrents.net/")
    with patch("magnet_search.torrent_metadata.requests.get", return_value=Response(
            302, location="http://127.0.0.1/private")) as get:
        with pytest.raises(MetadataError, match="跳转到无关页面"):
            download_torrent(infohash)
    assert get.call_count == 1
    with patch("magnet_search.torrent_metadata.requests.get", return_value=Response(
            302, location="https://itorrents.net/torrent/" + "0" * 40 + ".torrent")) as get:
        with pytest.raises(MetadataError, match="跳转到无关页面"):
            download_torrent(infohash)
    assert get.call_count == 1


def test_file_sizes_retries_corrupt_source_and_keeps_infohash_check(tmp_path, monkeypatch):
    from magnet_search import persistent_cache
    monkeypatch.setattr(persistent_cache, "CACHE_PATH", tmp_path / "first.sqlite3")
    data, infohash = sample_torrent()
    with patch("magnet_search.torrent_metadata.download_torrent", side_effect=[b"d4:info", data]) as download:
        assert file_sizes(infohash) == {
            "Root/Movies/first.mp4": 1_500_000_000,
            "Root/Movies/second.mp4": 2_000_000_000,
        }
    assert download.call_count == 2
    assert "bitsearch.eu" in download.call_args_list[0].args[1]
    assert "itorrents.net" in download.call_args_list[1].args[1]
    monkeypatch.setattr(persistent_cache, "CACHE_PATH", tmp_path / "second.sqlite3")
    with patch("magnet_search.torrent_metadata.download_torrent", return_value=data) as download:
        with pytest.raises(MetadataError, match="infohash"):
            file_sizes("0" * 40)
    assert download.call_count == 3
    monkeypatch.setattr(persistent_cache, "CACHE_PATH", tmp_path / "third.sqlite3")
    with patch("magnet_search.torrent_metadata.download_torrent", side_effect=[
            MetadataError("Torrent infohash 与搜索结果不一致"), data]) as download:
        assert file_sizes(infohash)["Root/Movies/first.mp4"] == 1_500_000_000
    assert download.call_count == 2


def test_file_sizes_cache_expires_after_one_hour(tmp_path, monkeypatch):
    from magnet_search import persistent_cache, torrent_metadata
    data, infohash = sample_torrent()
    monkeypatch.setattr(persistent_cache, "CACHE_PATH", tmp_path / "expiry.sqlite3")
    now = 1_800_000_000
    monkeypatch.setattr(persistent_cache, "time", lambda: now)
    monkeypatch.setattr(torrent_metadata, "time", lambda: now)
    with patch("magnet_search.torrent_metadata.download_torrent", return_value=data) as download:
        first = file_sizes(infohash)
        assert file_sizes(infohash) == first
        assert download.call_count == 1
        now += 3601
        assert file_sizes(infohash) == first
    assert download.call_count == 2


def test_file_sizes_survive_process_restart(tmp_path):
    import base64
    import subprocess
    import sys

    data, infohash = sample_torrent()
    script = """import base64
import sys
from pathlib import Path
from unittest.mock import patch
from magnet_search import persistent_cache
from magnet_search.torrent_metadata import file_sizes
persistent_cache.CACHE_PATH = Path(sys.argv[1])
effect = (lambda *args: base64.b64decode(sys.argv[4])) if sys.argv[2] == 'first' else AssertionError('unexpected metadata download')
with patch('magnet_search.torrent_metadata.download_torrent', side_effect=effect):
    print(file_sizes(sys.argv[3])['Root/Movies/first.mp4'])
"""
    args = [infohash, base64.b64encode(data).decode("ascii")]
    path = str(tmp_path / "restart.sqlite3")
    for phase in ("first", "second"):
        result = subprocess.run([sys.executable, "-c", script, path, phase, *args],
                                capture_output=True, text=True, check=True)
        assert result.stdout.strip() == "1500000000"
