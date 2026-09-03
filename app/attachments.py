from __future__ import annotations

import re
from pathlib import Path

from .config import DATA_DIR

ROOT = DATA_DIR / "draft-attachments"
MAX_BYTES = 12 * 1024 * 1024


def _safe_name(name: str) -> str:
    base = Path(name or "anexo").name
    cleaned = re.sub(r"[^A-Za-z0-9._-]+", "_", base).strip("._") or "anexo"
    return cleaned[:120]


def folder(thread_id: str) -> Path:
    safe = re.sub(r"[^A-Za-z0-9_-]+", "_", thread_id)[:80]
    path = ROOT / safe
    path.mkdir(parents=True, exist_ok=True)
    return path


def list_files(thread_id: str) -> list[dict]:
    items = []
    for path in sorted(folder(thread_id).iterdir()):
        if path.is_file():
            items.append({"name": path.name, "size": path.stat().st_size})
    return items


def save_file(thread_id: str, filename: str, data: bytes) -> dict:
    if len(data) > MAX_BYTES:
        raise ValueError("Anexo passa de 12 MB.")
    dest = folder(thread_id) / _safe_name(filename)
    dest.write_bytes(data)
    return {"name": dest.name, "size": dest.stat().st_size}


def delete_file(thread_id: str, filename: str) -> None:
    path = folder(thread_id) / Path(filename).name
    if path.is_file():
        path.unlink()
