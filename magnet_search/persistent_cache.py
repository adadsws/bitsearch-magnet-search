"""将可重建的成功响应保存一小时，供 WebUI 进程重启后复用。"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path
from time import time


TTL_SECONDS = 60 * 60
CACHE_PATH = Path(__file__).resolve().parent.parent / "~temp" / "cache" / "responses.sqlite3"


def _connect() -> sqlite3.Connection:
    CACHE_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(CACHE_PATH, timeout=10)
    connection.execute("CREATE TABLE IF NOT EXISTS responses (key TEXT PRIMARY KEY, expires_at REAL NOT NULL, value TEXT NOT NULL)")
    return connection


def get(key: str) -> tuple[float, dict] | None:
    """过期或不可读取的数据视为未命中，不将缓存故障伪装成空结果。"""
    try:
        with _connect() as connection:
            row = connection.execute("SELECT expires_at, value FROM responses WHERE key = ?", (key,)).fetchone()
        if row and row[0] > time():
            return row[0], json.loads(row[1])
    except (OSError, sqlite3.Error, ValueError, TypeError):
        pass
    return None


def put(key: str, value: dict, expires_at: float) -> None:
    """使用主键覆盖同条件旧响应；存储故障不影响已取得的上游结果。"""
    try:
        with _connect() as connection:
            connection.execute(
                "INSERT OR REPLACE INTO responses (key, expires_at, value) VALUES (?, ?, ?)",
                (key, expires_at, json.dumps(value, ensure_ascii=False)),
            )
    except (OSError, sqlite3.Error, ValueError, TypeError):
        pass
