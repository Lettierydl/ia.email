from __future__ import annotations

import unicodedata
from pathlib import Path

from . import config

# Navegação de arquivos para o seletor das Configurações. Só enxerga dentro
# da raiz da Learning Base (nada fora dela, nem via ".." ou symlink) e nunca
# mostra credenciais/, pastas ocultas ou as exportações temporárias.

TEXT_EXT = {".md", ".markdown", ".txt"}
_HIDDEN_DIRS = {"credenciais", "radar-contextos", "node_modules"}
MAX_SEARCH = 40


class FsError(ValueError):
    pass


def root() -> Path:
    return config.LEARNING_BASE_GLOBAL_DEFAULT


def _norm(text: str) -> str:
    return "".join(
        c for c in unicodedata.normalize("NFKD", text.lower()) if not unicodedata.combining(c)
    )


def resolve_inside(path: str | None) -> Path:
    base = root().resolve()
    target = Path(path).expanduser().resolve() if path else base
    if target != base and base not in target.parents:
        raise FsError("Esse caminho está fora da Learning Base.")
    if not target.exists():
        raise FsError("Caminho não encontrado.")
    return target


def _visible(path: Path, base: Path) -> bool:
    try:
        parts = path.relative_to(base).parts
    except ValueError:
        return False
    return not any(p.startswith(".") or p in _HIDDEN_DIRS for p in parts)


def _text_files_under(directory: Path, base: Path) -> int:
    n = 0
    for p in directory.rglob("*"):
        if p.suffix.lower() in TEXT_EXT and p.is_file() and _visible(p, base):
            n += 1
    return n


def _entry(path: Path, base: Path, with_count: bool = True) -> dict:
    rel = str(path.relative_to(base)) if path != base else ""
    if path.is_dir():
        return {
            "name": path.name,
            "path": str(path),
            "rel": rel,
            "type": "dir",
            "files": _text_files_under(path, base) if with_count else None,
        }
    return {"name": path.name, "path": str(path), "rel": rel, "type": "file", "size": path.stat().st_size}


def browse(path: str | None = None) -> dict:
    base = root().resolve()
    here = resolve_inside(path)
    if not here.is_dir():
        raise FsError("Isso não é uma pasta.")
    entries = []
    for child in sorted(here.iterdir(), key=lambda p: (p.is_file(), p.name.lower())):
        if not _visible(child.resolve(), base):
            continue
        if child.is_dir() or child.suffix.lower() in TEXT_EXT:
            if child.is_symlink() and base not in child.resolve().parents:
                continue
            entries.append(_entry(child.resolve(), base))
    parent = None if here == base else str(here.parent)
    crumbs = [{"name": "Learning Base", "path": str(base)}]
    if here != base:
        acc = base
        for part in here.relative_to(base).parts:
            acc = acc / part
            crumbs.append({"name": part, "path": str(acc)})
    return {"path": str(here), "parent": parent, "breadcrumb": crumbs, "entries": entries}


def search(query: str) -> list[dict]:
    needle = _norm((query or "").strip())
    if len(needle) < 2:
        return []
    base = root().resolve()
    hits: list[dict] = []
    for p in base.rglob("*"):
        if not _visible(p, base):
            continue
        if not (p.is_dir() or (p.is_file() and p.suffix.lower() in TEXT_EXT)):
            continue
        if needle in _norm(p.name) or needle in _norm(str(p.relative_to(base))):
            if p.is_symlink() and base not in p.resolve().parents:
                continue
            hits.append(_entry(p, base, with_count=False))
            if len(hits) >= MAX_SEARCH:
                break
    hits.sort(key=lambda h: (h["type"] != "dir", len(h["rel"])))
    return hits


def describe(paths: list[str]) -> list[dict]:
    """Para mostrar o que já está selecionado: nome, tipo e quantos arquivos
    de texto cada item cobre. Item que não existe mais aparece como tal."""
    base = root().resolve()
    out = []
    for raw in paths:
        p = Path(raw).expanduser()
        try:
            resolved = p.resolve()
        except OSError:
            resolved = p
        if not resolved.exists():
            out.append({"path": raw, "name": p.name or raw, "rel": raw, "type": "missing"})
            continue
        if resolved != base and base not in resolved.parents:
            out.append({"path": raw, "name": p.name or raw, "rel": raw, "type": "outside"})
            continue
        entry = _entry(resolved, base)
        entry["path"] = raw
        out.append(entry)
    return out
