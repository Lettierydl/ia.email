from __future__ import annotations


def pick_preload(ids_newest_first: list[str], count: int = 2) -> list[str]:
    """N mais novos + N mais antigos, sem duplicar, na ordem da lista."""
    count = max(1, count)
    if len(ids_newest_first) <= count * 2:
        return list(ids_newest_first)
    chosen = ids_newest_first[:count] + ids_newest_first[-count:]
    seen: set[str] = set()
    out: list[str] = []
    for item in chosen:
        if item in seen:
            continue
        seen.add(item)
        out.append(item)
    return out
