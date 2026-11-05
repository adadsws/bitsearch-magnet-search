"""读取 Torrent 的 bencode 元数据；提取自项目内的 audit_yyy_torrents 解析器。"""

from __future__ import annotations


class BencodeReader:
    """解析 .torrent，并记录原始 info 字节范围供 infohash 校验。"""

    def __init__(self, data: bytes) -> None:
        self.data = data
        self.offset = 0
        self.info_span: tuple[int, int] | None = None

    def read(self, capture_info: bool = False):
        data = self.data
        start = self.offset
        marker = data[start : start + 1]
        if marker == b"i":
            end = data.index(b"e", start + 1)
            self.offset = end + 1
            value = int(data[start + 1 : end])
        elif marker == b"l":
            self.offset += 1
            value = []
            while data[self.offset : self.offset + 1] != b"e":
                value.append(self.read())
            self.offset += 1
        elif marker == b"d":
            self.offset += 1
            value = {}
            while data[self.offset : self.offset + 1] != b"e":
                key = self.read()
                if not isinstance(key, bytes):
                    raise ValueError("non-byte bencode dictionary key")
                value[key] = self.read(capture_info=key == b"info")
            self.offset += 1
        elif marker in b"0123456789":
            colon = data.index(b":", start)
            length = int(data[start:colon])
            self.offset = colon + 1 + length
            value = data[colon + 1 : self.offset]
        else:
            raise ValueError(f"invalid bencode marker at {start}: {marker!r}")
        if capture_info:
            self.info_span = (start, self.offset)
        return value


def decode_name(raw: bytes) -> str:
    for encoding in ("utf-8", "gb18030", "shift_jis"):
        try:
            return raw.decode(encoding)
        except UnicodeDecodeError:
            pass
    return raw.decode("utf-8", errors="replace")
