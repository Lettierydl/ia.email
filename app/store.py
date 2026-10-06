from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from .config import DB_PATH, LEARNING_BASE_DEFAULT, LEARNING_BASE_GLOBAL_DEFAULT


def _connect() -> sqlite3.Connection:
    # timeout: o piloto automatico roda um loop em background que escreve
    # concorrente com requests HTTP; espera ate 5s em vez de falhar com
    # "database is locked". NAO usar journal_mode=WAL aqui: o arquivo fica
    # numa pasta compartilhada entre o Mac e o container Docker, e WAL
    # depende de memoria compartilhada que nao e coerente entre os dois --
    # isso corrompeu o banco uma vez.
    conn = sqlite3.connect(DB_PATH, check_same_thread=False, timeout=5)
    conn.row_factory = sqlite3.Row
    return conn


def _table_exists(conn: sqlite3.Connection, name: str) -> bool:
    return conn.execute(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", (name,)
    ).fetchone() is not None


def _backup_before_migration(reason: str) -> Path | None:
    """Cópia do banco antes de mexer no schema. Usa a API de backup do
    SQLite (consistente mesmo com o container escrevendo ao mesmo tempo),
    nunca um cp do arquivo. Banco novo/vazio não precisa de cópia."""
    db = Path(DB_PATH)
    if not db.is_file() or db.stat().st_size == 0:
        return None
    folder = db.parent / "backups"
    folder.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S")
    target = folder / f"{db.stem}-antes-{reason}-{stamp}.sqlite"
    src = sqlite3.connect(db, timeout=5)
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return target


def init() -> None:
    with _connect() as conn:
        needs_copilot = _table_exists(conn, "threads") and not _table_exists(conn, "copilot_items")
    if needs_copilot:
        _backup_before_migration("copiloto")
    with _connect() as conn:
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS threads (
                id TEXT PRIMARY KEY,
                subject TEXT,
                from_email TEXT,
                from_name TEXT,
                snippet TEXT,
                internal_date INTEGER,
                is_unread INTEGER,
                last_from_me INTEGER,
                is_automatic INTEGER,
                is_marketing INTEGER,
                needs_action_hint INTEGER,
                awaiting_reply INTEGER,
                conferido INTEGER,
                hidden INTEGER,
                hide_as_replied INTEGER,
                last_from_header TEXT,
                labels_json TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS meta (
                key TEXT PRIMARY KEY,
                value TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS blocked_senders (
                email TEXT PRIMARY KEY,
                created_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS avatar_cache (
                email TEXT PRIMARY KEY,
                photo_url TEXT,
                resolved_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS aliases (
                alias TEXT PRIMARY KEY,
                name TEXT,
                email TEXT,
                created_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS autopilot_decisions (
                id TEXT PRIMARY KEY,
                thread_id TEXT,
                action TEXT,
                confidence REAL,
                reasoning TEXT,
                draft_text TEXT,
                cc TEXT,
                sensitivity_level TEXT,
                decided_at TEXT,
                scheduled_send_at TEXT,
                status TEXT,
                sent_at TEXT,
                error TEXT,
                internal_date_snapshot INTEGER
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS usage_events (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                kind TEXT,
                thread_id TEXT,
                at TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_usage_events_at ON usage_events(at)")
        # Copiloto: uma linha por thread com a leitura da IA (papel do Leo, o
        # que aconteceu, o que ele faria) + o histórico do que o Leo fez com
        # ela (assumir, cobrar, delegar...), que vira "decisão anterior".
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS copilot_items (
                thread_id TEXT PRIMARY KEY,
                papel TEXT,
                o_que_aconteceu TEXT,
                opcoes_json TEXT,
                urgencia TEXT,
                bola_json TEXT,
                depende_de_outros INTEGER,
                sem_resposta_desde INTEGER,
                prazo TEXT,
                quem_pediu_json TEXT,
                tarefas_json TEXT,
                needs_context INTEGER,
                o_que_falta TEXT,
                pergunta TEXT,
                status TEXT,
                source TEXT,
                delegado_json TEXT,
                internal_date_snapshot INTEGER,
                analyzed_at TEXT,
                updated_at TEXT
            )
            """
        )
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS copilot_actions (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT,
                action TEXT,
                payload_json TEXT,
                at TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_copilot_actions_at ON copilot_actions(at)")
        # Rascunho da IA x texto que saiu de fato: material de aprendizado do
        # estilo. Gravado pelo próprio envio (/mail e /copilot usam o mesmo).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS reply_edits (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                thread_id TEXT,
                ai_draft TEXT,
                sent_text TEXT,
                edited INTEGER,
                source TEXT,
                created_at TEXT
            )
            """
        )
        conn.execute("CREATE INDEX IF NOT EXISTS idx_reply_edits_thread ON reply_edits(thread_id)")
        # "Aprender" do copiloto: regra/contexto que o Leo registrou para os
        # próximos e-mails -- vale para a conversa/assunto, uma pessoa ou geral.
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS learned_notes (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                scope TEXT,
                thread_id TEXT,
                subject TEXT,
                subject_key TEXT,
                person_email TEXT,
                text TEXT,
                created_at TEXT
            )
            """
        )
        # Colunas acrescentadas depois da tabela já existir em bancos antigos: só o
        # CREATE TABLE não basta (ele não mexe em tabela que já existe).
        for col, typ in (("internal_date_snapshot", "INTEGER"), ("evidence_json", "TEXT")):
            try:
                conn.execute(f"ALTER TABLE autopilot_decisions ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass
        for col, typ in (
            ("summary", "TEXT"),
            ("draft", "TEXT"),
            ("body_text", "TEXT"),
            ("chat_json", "TEXT"),
            ("fyi_only", "INTEGER"),
            ("capture_note", "TEXT"),
            ("capture_status", "TEXT"),
            ("chat_anchor_date", "INTEGER"),
            ("sent_via_app_at", "INTEGER"),
            ("to_header", "TEXT"),
            ("cc_header", "TEXT"),
            # historyId do Gmail: o refresh só re-busca a thread quando muda
            ("history_id", "TEXT"),
        ):
            try:
                conn.execute(f"ALTER TABLE threads ADD COLUMN {col} {typ}")
            except sqlite3.OperationalError:
                pass
        # quantas mensagens a IA leu na última análise: se o corpo (que o
        # /mail também usa) tem outro número, a leitura do copiloto está velha
        try:
            conn.execute("ALTER TABLE copilot_items ADD COLUMN msg_count_snapshot INTEGER")
        except sqlite3.OperationalError:
            pass
        # Fila de envio (app/outbox.py): só envios que o Leo confirmou e que
        # não saíram por falta de conexão. Ver outbox._ensure (mesmo schema).
        conn.execute(
            """
            CREATE TABLE IF NOT EXISTS outbox (
                id TEXT PRIMARY KEY,
                kind TEXT NOT NULL,
                thread_id TEXT,
                to_addr TEXT,
                cc TEXT,
                subject TEXT,
                body TEXT NOT NULL,
                attachments_json TEXT,
                source TEXT,
                ai_draft TEXT,
                status TEXT NOT NULL,
                attempts INTEGER NOT NULL DEFAULT 0,
                last_error TEXT,
                next_attempt_at REAL,
                result_json TEXT,
                created_at TEXT,
                updated_at TEXT,
                sent_at TEXT
            )
            """
        )
        # Threads de antes desse controle existir nao tem uma base de
        # comparacao -- da um ponto de partida agora pra passar a detectar
        # mensagem nova a partir daqui (nao reseta o que ja esta desatualizado
        # hoje, so evita que fique nesse limbo pra sempre).
        conn.execute(
            "UPDATE threads SET chat_anchor_date = internal_date "
            "WHERE chat_anchor_date IS NULL AND (summary IS NOT NULL AND summary != '')"
        )
        # Uma vez só: respostas que ja saíram pelo app antes das métricas
        # existirem entram no histórico (só dá pra reconstruir envios; resumos
        # antigos não têm data confiável, então a contagem deles começa agora).
        if conn.execute("SELECT 1 FROM meta WHERE key='events_backfilled'").fetchone() is None:
            for r in conn.execute(
                "SELECT id, sent_via_app_at FROM threads WHERE sent_via_app_at IS NOT NULL"
            ).fetchall():
                at = datetime.fromtimestamp(int(r["sent_via_app_at"]) / 1000, timezone.utc).isoformat()
                conn.execute(
                    "INSERT INTO usage_events(kind, thread_id, at) VALUES ('sent', ?, ?)", (r["id"], at)
                )
            conn.execute("INSERT INTO meta(key, value) VALUES ('events_backfilled', '1')")


def upsert_thread(row: dict[str, Any]) -> None:
    fields = [
        "id",
        "subject",
        "from_email",
        "from_name",
        "snippet",
        "internal_date",
        "is_unread",
        "last_from_me",
        "is_automatic",
        "is_marketing",
        "needs_action_hint",
        "awaiting_reply",
        "conferido",
        "hidden",
        "hide_as_replied",
        "last_from_header",
        "labels_json",
        "to_header",
        "cc_header",
        "history_id",
        "updated_at",
    ]
    row = dict(row)
    row.setdefault("hidden", 0)
    row["updated_at"] = datetime.now(timezone.utc).isoformat()
    if isinstance(row.get("labels_json"), list):
        row["labels_json"] = json.dumps(row["labels_json"])
    placeholders = ", ".join("?" for _ in fields)
    assignments = ", ".join(
        f"{name}=excluded.{name}"
        for name in fields
        if name not in {"id", "hidden"}
    )
    # Mensagem nova na thread (internal_date subiu): o corpo em cache ficou
    # velho. Sem isto o /copilot (que lê body_text direto) mostrava só as
    # mensagens da primeira leitura, enquanto o /mail re-buscava o corpo.
    assignments += (
        ", body_text = CASE WHEN COALESCE(excluded.internal_date, 0) > COALESCE(threads.internal_date, 0) "
        "THEN NULL ELSE threads.body_text END"
    )
    values = [row.get(name) for name in fields]
    with _connect() as conn:
        conn.execute(
            f"""
            INSERT INTO threads ({", ".join(fields)})
            VALUES ({placeholders})
            ON CONFLICT(id) DO UPDATE SET {assignments}
            """,
            values,
        )


def thread_sync_index() -> dict[str, dict[str, Any]]:
    """{id: {history_id, is_unread, visible}} -- o que o refresh precisa para
    decidir o que re-buscar no Gmail sem abrir thread por thread."""
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, history_id, is_unread, hidden, hide_as_replied FROM threads"
        ).fetchall()
    return {
        r["id"]: {
            "history_id": r["history_id"] or "",
            "is_unread": bool(r["is_unread"]),
            "visible": not (r["hidden"] or r["hide_as_replied"]),
        }
        for r in rows
    }


def set_hidden(thread_id: str, hidden: bool) -> None:
    with _connect() as conn:
        conn.execute(
            "UPDATE threads SET hidden=? WHERE id=?",
            (1 if hidden else 0, thread_id),
        )


def list_visible(*, include_hidden: bool = False) -> list[dict[str, Any]]:
    sql = "SELECT * FROM threads"
    if not include_hidden:
        sql += " WHERE hidden=0 AND hide_as_replied=0"
    sql += " ORDER BY internal_date DESC"
    with _connect() as conn:
        rows = conn.execute(sql).fetchall()
    return [dict(item) for item in rows]


def list_recent_sent(limit: int = 20) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM threads WHERE sent_via_app_at IS NOT NULL "
            "ORDER BY sent_via_app_at DESC LIMIT ?",
            (limit,),
        ).fetchall()
    return [dict(item) for item in rows]


def hidden_count() -> int:
    with _connect() as conn:
        row = conn.execute(
            "SELECT COUNT(*) AS n FROM threads WHERE hidden=1 OR hide_as_replied=1"
        ).fetchone()
    return int(row["n"]) if row else 0


def set_meta(key: str, value: str) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (key, value),
        )


def get_meta(key: str) -> str | None:
    with _connect() as conn:
        row = conn.execute("SELECT value FROM meta WHERE key=?", (key,)).fetchone()
    return row["value"] if row else None


def conferido_ids() -> set[str]:
    with _connect() as conn:
        rows = conn.execute("SELECT id FROM threads WHERE conferido=1").fetchall()
    return {row["id"] for row in rows}


def get_thread(thread_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM threads WHERE id=?", (thread_id,)).fetchone()
    return dict(row) if row else None


def save_ai(thread_id: str, **fields: Any) -> None:
    allowed = {
        "summary",
        "draft",
        "body_text",
        "needs_action_hint",
        "chat_json",
        "fyi_only",
        "capture_note",
        "capture_status",
        "chat_anchor_date",
        "is_marketing",
        "sent_via_app_at",
    }
    sets = []
    values = []
    for key, value in fields.items():
        if key not in allowed or value is None:
            continue
        sets.append(f"{key}=?")
        values.append(value)
    if not sets:
        return
    values.append(thread_id)
    with _connect() as conn:
        conn.execute(f"UPDATE threads SET {', '.join(sets)} WHERE id=?", values)


def unread_automatic_ids() -> list[str]:
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT id FROM threads
            WHERE is_automatic=1 AND is_unread=1 AND hidden=0 AND hide_as_replied=0
            ORDER BY internal_date DESC
            """
        ).fetchall()
    return [row["id"] for row in rows]


def mark_local_read(ids: list[str]) -> None:
    if not ids:
        return
    placeholders = ", ".join("?" for _ in ids)
    with _connect() as conn:
        conn.execute(
            f"UPDATE threads SET is_unread=0 WHERE id IN ({placeholders})",
            ids,
        )


def add_llm_usage(tokens: int) -> None:
    if tokens <= 0:
        return
    key = f"llm_tokens_{datetime.now(timezone.utc).date().isoformat()}"
    current = int(get_meta(key) or 0)
    set_meta(key, str(current + tokens))


def llm_usage_today() -> int:
    key = f"llm_tokens_{datetime.now(timezone.utc).date().isoformat()}"
    return int(get_meta(key) or 0)


def block_sender(email: str) -> None:
    email = (email or "").strip().lower()
    if not email:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO blocked_senders(email, created_at) VALUES(?, ?) "
            "ON CONFLICT(email) DO NOTHING",
            (email, datetime.now(timezone.utc).isoformat()),
        )


def is_blocked_sender(email: str) -> bool:
    email = (email or "").strip().lower()
    if not email:
        return False
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM blocked_senders WHERE email=?", (email,)
        ).fetchone()
    return row is not None


def get_avatar(email: str) -> tuple[bool, str | None]:
    """(ja_resolvido, url). ja_resolvido=False significa que nunca foi
    buscado -- url vazia (mas ja_resolvido=True) significa que foi
    buscado e nao achou foto nenhuma (nao tenta de novo)."""
    email = (email or "").strip().lower()
    if not email:
        return True, None
    with _connect() as conn:
        row = conn.execute(
            "SELECT photo_url FROM avatar_cache WHERE email=?", (email,)
        ).fetchone()
    if row is None:
        return False, None
    return True, (row["photo_url"] or None)


def save_avatar(email: str, photo_url: str | None) -> None:
    email = (email or "").strip().lower()
    if not email:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO avatar_cache(email, photo_url, resolved_at) VALUES(?, ?, ?) "
            "ON CONFLICT(email) DO UPDATE SET photo_url=excluded.photo_url, resolved_at=excluded.resolved_at",
            (email, photo_url or "", datetime.now(timezone.utc).isoformat()),
        )


DEFAULT_SETTINGS = {
    "context_enabled": False,
    "context_paths": [str(LEARNING_BASE_DEFAULT)],
    "context_global_enabled": False,
    "context_global_paths": [str(LEARNING_BASE_GLOBAL_DEFAULT)],
    "style_preset": "neutro",
    "style_custom": "",
    "preload_enabled": True,
    "preload_count": 2,
    # Modelos do OpenRouter em ordem de prioridade (vazio = usa o do .env).
    "llm_models": [],
    # Deixar a IA "pensar" antes de responder (mais lento). Padrão: desligado.
    "llm_reasoning": False,
    # Como o resumo e apresentado (modelo + instrucao livre extra).
    "summary_template": "padrao",
    # Premissas das métricas de tempo economizado (minutos por ação).
    "metric_minutes_summary": 2,
    "metric_minutes_reply": 5,
    "summary_custom": "",
    # Busca local (RAG) no cerebro e no historico de e-mails.
    "rag_enabled": True,
    "rag_top_k": 6,
    "rag_include_personal": False,
    # Piloto automatico: desligado por padrao; quando ligado, comeca no
    # nivel mais conservador (so rascunho, nunca envia sozinho).
    "autopilot_mode": "piloto",  # "piloto" (responde conforme o nível) | "auxiliar" (nunca envia)
    "autopilot_enabled": False,
    "autopilot_level": "conservador",
    "autopilot_buffer_minutes": 10,
    "autopilot_scan_minutes": 5,
    # Copiloto: preferências por usuário (skin, horários do digest), chave = e-mail.
    "copilot_users": {},
}


def get_settings() -> dict[str, Any]:
    raw = get_meta("settings_json")
    if not raw:
        return dict(DEFAULT_SETTINGS)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        return dict(DEFAULT_SETTINGS)
    merged = dict(DEFAULT_SETTINGS)
    merged.update({k: v for k, v in data.items() if k in DEFAULT_SETTINGS})
    return merged


def save_settings(**fields: Any) -> dict[str, Any]:
    current = get_settings()
    current.update({k: v for k, v in fields.items() if k in DEFAULT_SETTINGS})
    set_meta("settings_json", json.dumps(current))
    return current


def list_aliases() -> list[dict[str, str]]:
    with _connect() as conn:
        rows = conn.execute("SELECT alias, name, email FROM aliases ORDER BY alias").fetchall()
    return [dict(row) for row in rows]


def save_alias(alias: str, name: str, email: str) -> None:
    alias = (alias or "").strip().lower()
    if not alias:
        return
    with _connect() as conn:
        conn.execute(
            "INSERT INTO aliases(alias, name, email, created_at) VALUES(?, ?, ?, ?) "
            "ON CONFLICT(alias) DO UPDATE SET name=excluded.name, email=excluded.email",
            (alias, (name or "").strip(), (email or "").strip().lower(), datetime.now(timezone.utc).isoformat()),
        )


def delete_alias(alias: str) -> None:
    with _connect() as conn:
        conn.execute("DELETE FROM aliases WHERE alias=?", ((alias or "").strip().lower(),))


def search_senders(query: str, limit: int = 6) -> list[dict[str, str]]:
    """Procura remetentes ja vistos no historico de e-mails que batem com
    o texto digitado -- usado pra sugerir nome/e-mail ao cadastrar um
    apelido, em vez do Leo ter que digitar o e-mail certinho na mao."""
    needle = f"%{(query or '').strip()}%"
    with _connect() as conn:
        rows = conn.execute(
            """
            SELECT from_name, from_email, MAX(internal_date) AS last_seen, COUNT(*) AS n
            FROM threads
            WHERE (from_name LIKE ? OR from_email LIKE ?) AND from_email != ''
            GROUP BY from_email
            ORDER BY n DESC, last_seen DESC
            LIMIT ?
            """,
            (needle, needle, limit),
        ).fetchall()
    return [{"name": r["from_name"] or "", "email": r["from_email"] or ""} for r in rows]


def thread_count() -> int:
    with _connect() as conn:
        row = conn.execute("SELECT COUNT(*) AS n FROM threads").fetchone()
    return int(row["n"] if row else 0)


def threads_with_body() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT id, subject, from_email, from_name, internal_date, body_text FROM threads "
            "WHERE body_text IS NOT NULL AND body_text != ''"
        ).fetchall()
    return [dict(r) for r in rows]


def log_event(kind: str, thread_id: str = "", at: str | None = None) -> None:
    """Registra algo que a ferramenta fez (resumo, resposta enviada...) pras
    métricas. Nunca pode atrapalhar o fluxo principal, então erro aqui é
    engolido."""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO usage_events(kind, thread_id, at) VALUES (?, ?, ?)",
                (kind, thread_id, at or datetime.now(timezone.utc).isoformat()),
            )
    except sqlite3.Error:
        pass


def list_events(since_iso: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT kind, thread_id, at FROM usage_events WHERE at >= ? ORDER BY at", (since_iso,)
        ).fetchall()
    return [dict(r) for r in rows]


# ── Piloto automatico ──

def sender_seen_before(email: str, exclude_thread_id: str) -> bool:
    """True se ja existe outra thread (diferente da atual) desse remetente
    no historico local -- usado como exclusao rigida: remetente inedito
    nunca e auto-respondido, em nenhum nivel de sensibilidade."""
    email = (email or "").strip().lower()
    if not email:
        return False
    with _connect() as conn:
        row = conn.execute(
            "SELECT 1 FROM threads WHERE from_email=? AND id != ? LIMIT 1",
            (email, exclude_thread_id),
        ).fetchone()
    return row is not None


def create_autopilot_decision(**fields: Any) -> str:
    decision_id = str(uuid.uuid4())
    cols = [
        "id",
        "thread_id",
        "action",
        "confidence",
        "reasoning",
        "draft_text",
        "cc",
        "sensitivity_level",
        "decided_at",
        "scheduled_send_at",
        "status",
        "internal_date_snapshot",
        "evidence_json",
    ]
    values = {**fields, "id": decision_id}
    values.setdefault("decided_at", datetime.now(timezone.utc).isoformat())
    placeholders = ", ".join("?" for _ in cols)
    with _connect() as conn:
        conn.execute(
            f"INSERT INTO autopilot_decisions ({', '.join(cols)}) VALUES ({placeholders})",
            [values.get(c) for c in cols],
        )
    return decision_id


def update_autopilot_decision(decision_id: str, **fields: Any) -> None:
    allowed = {"status", "sent_at", "error", "draft_text", "scheduled_send_at"}
    sets, values = [], []
    for key, value in fields.items():
        if key not in allowed:
            continue
        sets.append(f"{key}=?")
        values.append(value)
    if not sets:
        return
    values.append(decision_id)
    with _connect() as conn:
        conn.execute(f"UPDATE autopilot_decisions SET {', '.join(sets)} WHERE id=?", values)


def get_autopilot_decision(decision_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM autopilot_decisions WHERE id=?", (decision_id,)
        ).fetchone()
    return dict(row) if row else None


def list_autopilot_decisions(status: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    sql = "SELECT * FROM autopilot_decisions"
    params: list[Any] = []
    if status:
        sql += " WHERE status=?"
        params.append(status)
    sql += " ORDER BY decided_at DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(row) for row in rows]


def list_autopilot_decisions_since(since_iso: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT action, status, decided_at, sent_at FROM autopilot_decisions WHERE decided_at >= ? ORDER BY decided_at",
            (since_iso,),
        ).fetchall()
    return [dict(r) for r in rows]


def last_assist_decision(thread_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM autopilot_decisions WHERE thread_id=? AND action IN ('suggest','needs_context','no_reply') "
            "ORDER BY decided_at DESC LIMIT 1",
            (thread_id,),
        ).fetchone()
    return dict(row) if row else None


def list_assist_open() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM autopilot_decisions WHERE status='open' AND action IN ('suggest','needs_context','no_reply') "
            "ORDER BY decided_at DESC LIMIT 300"
        ).fetchall()
    return [dict(r) for r in rows]


def due_autopilot_sends(now_iso: str) -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute(
            "SELECT * FROM autopilot_decisions WHERE status='pending' AND scheduled_send_at<=? "
            "ORDER BY scheduled_send_at ASC",
            (now_iso,),
        ).fetchall()
    return [dict(row) for row in rows]


def recent_decision_for_thread(thread_id: str) -> dict[str, Any] | None:
    """Ultima decisao (qualquer status) para essa thread -- usado pelo
    motor de decisao pra nao reavaliar a mesma thread em todo tick enquanto
    a decisao anterior ainda estiver pendente/recente."""
    with _connect() as conn:
        row = conn.execute(
            "SELECT * FROM autopilot_decisions WHERE thread_id=? AND action NOT IN ('suggest','needs_context','no_reply') "
            "ORDER BY decided_at DESC LIMIT 1",
            (thread_id,),
        ).fetchone()
    return dict(row) if row else None


# ── Copiloto ──

_COPILOT_COLS = (
    "papel", "o_que_aconteceu", "opcoes_json", "urgencia", "bola_json", "depende_de_outros",
    "sem_resposta_desde", "prazo", "quem_pediu_json", "tarefas_json", "needs_context", "o_que_falta",
    "pergunta", "status", "source", "delegado_json", "internal_date_snapshot", "analyzed_at", "msg_count_snapshot",
)


def save_copilot_item(thread_id: str, **fields: Any) -> None:
    """Upsert parcial: só as colunas passadas mudam (status/delegação de uma
    linha que já existe não somem quando a IA relê a thread)."""
    data = {k: v for k, v in fields.items() if k in _COPILOT_COLS}
    data["updated_at"] = datetime.now(timezone.utc).isoformat()
    cols = ["thread_id", *data]
    placeholders = ", ".join("?" for _ in cols)
    assignments = ", ".join(f"{c}=excluded.{c}" for c in data)
    with _connect() as conn:
        conn.execute(
            f"INSERT INTO copilot_items ({', '.join(cols)}) VALUES ({placeholders}) "
            f"ON CONFLICT(thread_id) DO UPDATE SET {assignments}",
            [thread_id, *data.values()],
        )


def get_copilot_item(thread_id: str) -> dict[str, Any] | None:
    with _connect() as conn:
        row = conn.execute("SELECT * FROM copilot_items WHERE thread_id=?", (thread_id,)).fetchone()
    return dict(row) if row else None


def list_copilot_items() -> dict[str, dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM copilot_items").fetchall()
    return {r["thread_id"]: dict(r) for r in rows}


def log_copilot_action(thread_id: str, action: str, payload: dict[str, Any] | None = None) -> None:
    with _connect() as conn:
        conn.execute(
            "INSERT INTO copilot_actions(thread_id, action, payload_json, at) VALUES (?, ?, ?, ?)",
            (thread_id, action, json.dumps(payload or {}, ensure_ascii=False), datetime.now(timezone.utc).isoformat()),
        )


def list_copilot_actions(*, thread_id: str | None = None, since_iso: str | None = None, limit: int = 200) -> list[dict[str, Any]]:
    sql, params = "SELECT * FROM copilot_actions WHERE 1=1", []
    if thread_id:
        sql += " AND thread_id=?"
        params.append(thread_id)
    if since_iso:
        sql += " AND at>=?"
        params.append(since_iso)
    sql += " ORDER BY at DESC, id DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def log_reply_edit(thread_id: str, ai_draft: str, sent_text: str, source: str = "mail") -> None:
    """Guarda o rascunho da IA e o que foi enviado. Como log_event, nunca
    pode atrapalhar o envio (que já saiu), então erro aqui é engolido."""
    try:
        with _connect() as conn:
            conn.execute(
                "INSERT INTO reply_edits(thread_id, ai_draft, sent_text, edited, source, created_at) VALUES (?, ?, ?, ?, ?, ?)",
                (
                    thread_id,
                    ai_draft,
                    sent_text,
                    int(ai_draft.strip() != sent_text.strip()),
                    source,
                    datetime.now(timezone.utc).isoformat(),
                ),
            )
    except sqlite3.Error:
        pass


def list_reply_edits(*, thread_id: str | None = None, limit: int = 50) -> list[dict[str, Any]]:
    sql, params = "SELECT * FROM reply_edits WHERE 1=1", []
    if thread_id:
        sql += " AND thread_id=?"
        params.append(thread_id)
    sql += " ORDER BY id DESC LIMIT ?"
    params.append(limit)
    with _connect() as conn:
        rows = conn.execute(sql, params).fetchall()
    return [dict(r) for r in rows]


def add_learned_note(
    *, scope: str, text: str, thread_id: str = "", subject: str = "", subject_key: str = "", person_email: str = ""
) -> dict[str, Any]:
    with _connect() as conn:
        cur = conn.execute(
            "INSERT INTO learned_notes(scope, thread_id, subject, subject_key, person_email, text, created_at) "
            "VALUES (?, ?, ?, ?, ?, ?, ?)",
            (scope, thread_id, subject, subject_key, person_email, text, datetime.now(timezone.utc).isoformat()),
        )
        row = conn.execute("SELECT * FROM learned_notes WHERE id=?", (cur.lastrowid,)).fetchone()
    return dict(row)


def list_learned_notes() -> list[dict[str, Any]]:
    with _connect() as conn:
        rows = conn.execute("SELECT * FROM learned_notes ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


def delete_learned_note(note_id: int) -> bool:
    with _connect() as conn:
        cur = conn.execute("DELETE FROM learned_notes WHERE id=?", (note_id,))
    return cur.rowcount > 0


def copilot_acted_thread_ids() -> set[str]:
    """Threads em que o Leo já fez alguma ação pelo Copiloto (assumir, arrastar,
    delegar...): a ação dele também classifica o item."""
    with _connect() as conn:
        rows = conn.execute("SELECT DISTINCT thread_id FROM copilot_actions").fetchall()
    return {r["thread_id"] for r in rows}


def copilot_actions_for_sender(email: str, exclude_thread_id: str, limit: int = 5) -> list[dict[str, Any]]:
    """O que o Leo já fez com outros e-mails dessa mesma pessoa -- entra como
    "decisão anterior" quando o copiloto sugere o que fazer agora."""
    email = (email or "").strip().lower()
    if not email:
        return []
    with _connect() as conn:
        rows = conn.execute(
            "SELECT a.*, t.subject FROM copilot_actions a JOIN threads t ON t.id = a.thread_id "
            "WHERE t.from_email=? AND a.thread_id != ? AND a.action IN ('assumir','delegar','cobrar','resolver','aplicar') "
            "ORDER BY a.at DESC LIMIT ?",
            (email, exclude_thread_id, limit),
        ).fetchall()
    return [dict(r) for r in rows]
