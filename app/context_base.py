from __future__ import annotations

from pathlib import Path
from typing import Any

from .config import CONTEXT_MAX_CHARS, CONTEXT_MAX_FILES_LISTED, EMAIL_EXPORT_DIR

TEXT_EXTENSIONS = {".md", ".markdown", ".txt"}
_EXPORT_DIR_RESOLVED = EMAIL_EXPORT_DIR.resolve()


def _iter_files(root: Path):
    if root.is_file():
        # arquivo escolhido direto no seletor das Configurações
        if root.suffix.lower() in TEXT_EXTENSIONS:
            yield root
        return
    if not root.is_dir():
        return
    for path in root.rglob("*"):
        if not path.is_file() or path.suffix.lower() not in TEXT_EXTENSIONS:
            continue
        # exports por thread sao ephemeros/redundantes -- nao contam como
        # "base de conhecimento pessoal", so poluiriam o contexto com
        # transcricoes antigas de threads. Eles ficam em pastas
        # radar-contextos/ espalhadas pela base (ver assistant.export_context).
        # credenciais/ nunca entra: o texto daqui vai pra prompt de LLM externo.
        rel_dirs = path.relative_to(root).parts[:-1]
        if any(p in ("radar-contextos", "credenciais") for p in rel_dirs):
            continue
        if _EXPORT_DIR_RESOLVED in path.resolve().parents:
            continue
        yield path


def list_context_files(paths: list[str]) -> list[dict[str, Any]]:
    """Lista os arquivos que a base de contexto enxerga hoje (mais
    recentes primeiro) -- pra mostrar na tela de configuracoes o que
    realmente vai ser lido, nao um numero abstrato."""
    found: list[Path] = []
    for raw in paths or []:
        root = Path(raw).expanduser()
        found.extend(_iter_files(root))
        if len(found) > CONTEXT_MAX_FILES_LISTED * 3:
            break
    found.sort(key=lambda p: p.stat().st_mtime if p.exists() else 0, reverse=True)
    out = []
    for path in found[:CONTEXT_MAX_FILES_LISTED]:
        try:
            stat = path.stat()
        except OSError:
            continue
        out.append(
            {
                "path": str(path),
                "size": stat.st_size,
                "modified_at": stat.st_mtime,
            }
        )
    return out


def build_context_snippet(paths: list[str], max_chars: int = CONTEXT_MAX_CHARS) -> tuple[str, list[str]]:
    """Concatena os arquivos mais recentes da base de contexto ate o
    orcamento de caracteres. Retorna o texto pronto pro prompt e a lista
    dos arquivos realmente usados nessa chamada."""
    files = list_context_files(paths)
    parts: list[str] = []
    used: list[str] = []
    budget = max_chars
    for entry in files:
        if budget <= 0:
            break
        path = Path(entry["path"])
        try:
            text = path.read_text(encoding="utf-8", errors="replace").strip()
        except OSError:
            continue
        if not text:
            continue
        chunk = text[:budget]
        parts.append(f"### {path.name}\n{chunk}")
        used.append(str(path))
        budget -= len(chunk)
    return "\n\n".join(parts), used
