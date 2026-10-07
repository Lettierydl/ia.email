from __future__ import annotations

import re
from pathlib import Path

from .config import DATA_DIR

ROOT = DATA_DIR / "draft-attachments"
MAX_BYTES = 12 * 1024 * 1024
# Extensões cujo conteúdo dá pra ler como texto e mandar pro prompt da IA.
_TEXT_EXTS = {
    ".txt", ".md", ".csv", ".tsv", ".json", ".html", ".htm", ".log",
    ".xml", ".yaml", ".yml", ".ini", ".cfg", ".py", ".js", ".ts", ".css",
}
_MAX_FILE_CHARS = 3500
_MAX_TOTAL_CHARS = 7000


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


def _read_text_snippet(path: Path, limit: int = _MAX_FILE_CHARS) -> str:
    """Lê trecho textual se a extensão for amigável; senão string vazia."""
    if path.suffix.lower() not in _TEXT_EXTS:
        return ""
    try:
        raw = path.read_bytes()[: limit * 4]  # margem p/ utf-8
        text = raw.decode("utf-8", errors="replace")
    except Exception:
        return ""
    text = re.sub(r"\s+", " ", text).strip()
    if len(text) > limit:
        text = text[: limit - 1] + "…"
    return text


def _kind_label(name: str, size: int) -> str:
    ext = Path(name).suffix.lower()
    if ext in {".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"}:
        return "imagem"
    if ext == ".pdf":
        return "PDF"
    if ext in {".doc", ".docx"}:
        return "Word"
    if ext in {".xls", ".xlsx"}:
        return "planilha"
    if ext in _TEXT_EXTS:
        return "texto"
    return "arquivo"


def extract_context(thread_id: str, max_chars: int = _MAX_TOTAL_CHARS) -> str:
    """Bloco para o prompt da IA: nomes dos anexos + trechos extraíveis.
    Sem LLM, sem rede. Se não houver anexo, string vazia."""
    files = list_files(thread_id)
    if not files:
        return ""
    lines = [
        "Anexos que o Leo preparou para ESTA resposta (vão juntos no envio). "
        "Se fizer sentido, o rascunho pode mencionar o nome do arquivo "
        '(ex.: "Segue em anexo o proposta.pdf"). Não invente conteúdo que '
        "não apareça abaixo:",
    ]
    used = len(lines[0])
    for f in files:
        name, size = f["name"], int(f["size"] or 0)
        kind = _kind_label(name, size)
        head = f"- {name} ({kind}, {size} bytes)"
        path = folder(thread_id) / name
        snippet = _read_text_snippet(path) if path.is_file() else ""
        block = head + (f"\n  trecho: {snippet}" if snippet else "")
        if used + len(block) + 1 > max_chars:
            rest = len(files) - (len(lines) - 1)
            if rest > 0:
                lines.append(f"- … e mais {rest} arquivo(s) (omitidos por tamanho)")
            break
        lines.append(block)
        used += len(block) + 1
    return "\n".join(lines) + "\n\n"
