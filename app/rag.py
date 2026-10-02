from __future__ import annotations

import re
import sqlite3
import threading
import time
from contextlib import closing
from datetime import datetime
from pathlib import Path

from . import config, secrets_guard, store

# Busca local por palavras (SQLite FTS5) sobre o cérebro (Learning Base) e
# sobre o histórico de e-mails -- tudo em data/rag.sqlite, um arquivo à parte
# do banco principal (se o índice der problema, e-mails e configurações não
# são tocados, e ele sempre pode ser apagado e reconstruído).

_LOCK = threading.RLock()
_last_sync = 0.0
_last_sync_iso: str | None = None

_SKIP_DIRS = {"radar-contextos", "credenciais", ".git", "node_modules"}
_SENSITIVE_NAME = re.compile(r"secret|token|senha|password|\.env", re.IGNORECASE)
_TEXT_EXT = {".md", ".markdown", ".txt"}
_MAX_FILE_BYTES = 400_000
_STOPWORDS = set(
    "de da do das dos em no na nos nas um uma uns umas para por com que se ao aos como mais mas ou "
    "ja não nao sim isso esse essa este esta são sao foi ser ter tem favor olá ola bom dia tarde noite "
    "att atenciosamente obrigado obrigada segue abaixo anexo fwd enc the and for you your".split()
)
_QUOTE_RE = re.compile(r"\n(?=>? ?(?:Em [\s\S]{0,160}?escreveu:|On [\s\S]{0,160}?wrote:))")


def _connect() -> sqlite3.Connection:
    conn = sqlite3.connect(config.RAG_DB_PATH, timeout=5, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init() -> None:
    config.RAG_DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    with closing(_connect()) as conn, conn:
        conn.execute(
            "CREATE VIRTUAL TABLE IF NOT EXISTS chunks USING fts5("
            "source UNINDEXED, ref UNINDEXED, title, body, "
            "tokenize='unicode61 remove_diacritics 2')"
        )
        conn.execute("CREATE TABLE IF NOT EXISTS docs (key TEXT PRIMARY KEY, stamp TEXT)")


def _pack(paragraphs: list[str], max_chars: int) -> list[str]:
    chunks, current = [], ""
    for para in paragraphs:
        para = para.strip()
        if not para:
            continue
        while len(para) > max_chars:
            cut = para.rfind(" ", 0, max_chars)
            cut = cut if cut > max_chars // 2 else max_chars
            if current:
                chunks.append(current)
                current = ""
            chunks.append(para[:cut].strip())
            para = para[cut:].strip()
        if current and len(current) + len(para) + 2 > max_chars:
            chunks.append(current)
            current = ""
        current = f"{current}\n\n{para}" if current else para
    if current:
        chunks.append(current)
    return [c for c in chunks if c.strip()]


def chunk_markdown(text: str, max_chars: int = 1200) -> list[tuple[str, str]]:
    """Divide por títulos (#..####) e empacota parágrafos em pedaços de até
    max_chars. Devolve (título_da_seção, texto)."""
    sections: list[tuple[str, list[str]]] = []
    heading, buf = "", []
    for line in text.splitlines():
        m = re.match(r"^#{1,4}\s+(.*)", line)
        if m:
            sections.append((heading, buf))
            heading, buf = m.group(1).strip(), []
        else:
            buf.append(line)
    sections.append((heading, buf))
    out: list[tuple[str, str]] = []
    for head, lines in sections:
        paragraphs = re.split(r"\n\s*\n", "\n".join(lines))
        for chunk in _pack(paragraphs, max_chars):
            out.append((head, chunk))
    return out


def _mail_chunks(subject: str, body: str) -> list[tuple[str, str, str]]:
    """(fonte, título, texto) por mensagem da thread. Resposta do próprio
    Leo vira fonte 'mail_sent'. O histórico citado dentro de cada mensagem é
    cortado, senão a mesma frase entra no índice dezenas de vezes."""
    out = []
    for block in body.split("\n\n----\n\n"):
        m = re.match(r"^De:\s*(.*)\nData:\s*(.*)\n\n([\s\S]*)$", block.strip())
        sender, text = (m.group(1).strip(), m.group(3)) if m else ("", block)
        cut = _QUOTE_RE.search(text)
        if cut:
            text = text[: cut.start()]
        text = "\n".join(l for l in text.splitlines() if not l.lstrip().startswith(">")).strip()
        if len(text) < 20:
            continue
        mine = config.ACCOUNT in sender.lower()
        source = "mail_sent" if mine else "mail"
        title = f"{subject} — {sender}" if sender else subject
        for chunk in _pack(re.split(r"\n\s*\n", text), 1500):
            out.append((source, title, chunk))
    return out


def _kb_roots() -> list[Path]:
    paths = store.get_settings().get("context_global_paths") or [str(config.LEARNING_BASE_GLOBAL_DEFAULT)]
    return [Path(p).expanduser() for p in paths]


def _kb_files() -> dict[str, Path]:
    # lb-personal (finanças, saúde...) fica de fora por padrão: os trechos
    # achados vão pro prompt do provedor de IA, e conteúdo pessoal não deve
    # acompanhar um rascunho de trabalho sem o Leo ter escolhido isso.
    include_personal = bool(store.get_settings().get("rag_include_personal", False))
    found: dict[str, Path] = {}
    for root in _kb_roots():
        if root.is_file():
            # arquivo escolhido direto no seletor: vale como pedido explícito
            if root.suffix.lower() in _TEXT_EXT and not _SENSITIVE_NAME.search(root.name):
                found[f"kb:{root}"] = root
            continue
        if not root.is_dir():
            continue
        for path in root.rglob("*"):
            if path.suffix.lower() not in _TEXT_EXT or not path.is_file():
                continue
            parts = path.relative_to(root).parts
            if any(p in _SKIP_DIRS or p.startswith(".") for p in parts[:-1]):
                continue
            if not include_personal and parts[0] == "lb-personal":
                continue
            if _SENSITIVE_NAME.search(path.name):
                continue
            try:
                if path.stat().st_size > _MAX_FILE_BYTES:
                    continue
            except OSError:
                continue
            found[f"kb:{path}"] = path
    return found


def sync(force: bool = False) -> dict:
    """Reindexa só o que mudou desde a última vez (arquivo novo/alterado,
    thread com corpo novo) e remove o que sumiu."""
    global _last_sync, _last_sync_iso
    with _LOCK:
        init()
        stats = {"added": 0, "updated": 0, "removed": 0}
        wanted: dict[str, tuple[str, callable]] = {}

        for key, path in _kb_files().items():
            try:
                st = path.stat()
            except OSError:
                continue
            wanted[key] = (f"{st.st_mtime_ns}:{st.st_size}", lambda p=path, k=key: _index_file(p, k))

        for row in store.threads_with_body():
            key = f"mail:{row['id']}"
            stamp = f"{row.get('internal_date')}:{len(row['body_text'])}"
            wanted[key] = (stamp, lambda r=row, k=key: _index_thread(r, k))

        with closing(_connect()) as conn, conn:
            if force:
                conn.execute("DELETE FROM chunks")
                conn.execute("DELETE FROM docs")
            existing = {r["key"]: r["stamp"] for r in conn.execute("SELECT key, stamp FROM docs")}
            for key in set(existing) - set(wanted):
                conn.execute("DELETE FROM chunks WHERE ref=?", (key,))
                conn.execute("DELETE FROM docs WHERE key=?", (key,))
                stats["removed"] += 1
            for key, (stamp, loader) in wanted.items():
                if existing.get(key) == stamp:
                    continue
                rows = [r for r in loader() if not secrets_guard.looks_like_secret(r[2])]
                conn.execute("DELETE FROM chunks WHERE ref=?", (key,))
                conn.executemany(
                    "INSERT INTO chunks(source, ref, title, body) VALUES (?, ?, ?, ?)",
                    [(src, key, title, body) for src, title, body in rows],
                )
                conn.execute(
                    "INSERT INTO docs(key, stamp) VALUES (?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET stamp=excluded.stamp",
                    (key, stamp),
                )
                stats["updated" if key in existing else "added"] += 1
        _last_sync = time.time()
        _last_sync_iso = datetime.now().isoformat()
        return stats


def _label_path(path: Path) -> str:
    try:
        return str(path.relative_to(config.LEARNING_BASE_GLOBAL_DEFAULT))
    except ValueError:
        return path.name


def _index_file(path: Path, key: str) -> list[tuple[str, str, str]]:
    try:
        text = path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return []
    label = _label_path(path)
    return [
        ("kb", f"{label} › {head}" if head else label, chunk)
        for head, chunk in chunk_markdown(text)
    ]


def _index_thread(row: dict, key: str) -> list[tuple[str, str, str]]:
    return _mail_chunks(row.get("subject") or "(sem assunto)", row["body_text"])


def ensure_fresh(max_age_s: float = 600) -> None:
    if time.time() - _last_sync > max_age_s:
        try:
            sync()
        except sqlite3.Error:
            pass


def build_query(text: str, max_terms: int = 25) -> str:
    freq: dict[str, int] = {}
    for word in re.findall(r"[0-9A-Za-zÀ-ÿ]+", (text or "").lower()):
        if len(word) < 3 or word in _STOPWORDS:
            continue
        freq[word] = freq.get(word, 0) + 1
    terms = sorted(freq, key=lambda w: (-freq[w], -len(w)))[:max_terms]
    return " OR ".join(f'"{t}"' for t in terms)


def search(query: str, k: int = 6, exclude_ref: str | None = None) -> list[dict]:
    """Os k trechos mais relevantes (no máx. 2 por documento). Qualquer erro
    do índice vira lista vazia -- a busca nunca pode derrubar um rascunho."""
    match = build_query(query)
    if not match:
        return []
    try:
        ensure_fresh()
        with closing(_connect()) as conn:
            rows = conn.execute(
                "SELECT source, ref, title, body, bm25(chunks, 0.0, 0.0, 2.0, 1.0) AS score "
                "FROM chunks WHERE chunks MATCH ? ORDER BY score LIMIT ?",
                (match, max(k, 1) * 6),
            ).fetchall()
    except sqlite3.Error:
        return []
    hits, per_ref = [], {}
    for r in rows:
        if exclude_ref and r["ref"] == exclude_ref:
            continue
        if per_ref.get(r["ref"], 0) >= 2:
            continue
        per_ref[r["ref"]] = per_ref.get(r["ref"], 0) + 1
        hits.append({"source": r["source"], "ref": r["ref"], "title": r["title"], "body": r["body"]})
        if len(hits) >= k:
            break
    return hits


_SOURCE_LABEL = {"kb": "cérebro", "mail": "e-mail recebido", "mail_sent": "resposta sua"}


def format_context(hits: list[dict], max_chars: int = 6000) -> str:
    parts, used = [], 0
    for h in hits:
        block = f"[{_SOURCE_LABEL.get(h['source'], h['source'])}: {h['title']}]\n{h['body']}"
        if used + len(block) > max_chars:
            break
        parts.append(block)
        used += len(block)
    return "\n\n".join(parts)


def status() -> dict:
    try:
        init()
        with closing(_connect()) as conn:
            by_source = {
                r["source"]: r["n"]
                for r in conn.execute("SELECT source, COUNT(*) AS n FROM chunks GROUP BY source")
            }
            docs = conn.execute("SELECT COUNT(*) AS n FROM docs").fetchone()["n"]
    except sqlite3.Error:
        by_source, docs = {}, 0
    return {"chunks": by_source, "documents": docs, "last_sync": _last_sync_iso}
