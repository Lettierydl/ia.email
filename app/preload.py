from __future__ import annotations


def pick_preload(ids_newest_first: list[str]) -> list[str]:
    """2 mais novos + 2 mais antigos, sem duplicar, na ordem da lista."""
    if len(ids_newest_first) <= 4:
        return list(ids_newest_first)
    chosen = ids_newest_first[:2] + ids_newest_first[-2:]
    seen: set[str] = set()
    out: list[str] = []
    for item in chosen:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out
