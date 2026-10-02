from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import store
from .config import TZ

_ANSWERED = {"sent", "compose_sent", "auto_sent"}


def _local_date(iso: str) -> str:
    dt = datetime.fromisoformat(iso)
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    return dt.astimezone(TZ).date().isoformat()


def compute(days: int, now: datetime | None = None) -> dict:
    """Números de uso dos últimos `days` dias. Tempo economizado é uma
    ESTIMATIVA: minutos por resumo gerado e por resposta enviada (as duas
    premissas ficam nas Configurações) -- não é cronômetro de verdade."""
    now = now or datetime.now(timezone.utc)
    settings = store.get_settings()
    per_summary = float(settings.get("metric_minutes_summary") or 0)
    per_reply = float(settings.get("metric_minutes_reply") or 0)

    today = now.astimezone(TZ).date()
    first_day = today - timedelta(days=days - 1)
    since = datetime.combine(first_day, datetime.min.time(), TZ).astimezone(timezone.utc)
    events = store.list_events(since.isoformat())

    daily = {(first_day + timedelta(days=i)).isoformat(): {"analyzed": 0, "answered": 0} for i in range(days)}
    summaries = answered = auto = 0
    analyzed_threads: set[str] = set()
    for ev in events:
        day = _local_date(ev["at"])
        if day not in daily:
            continue
        if ev["kind"] == "summary":
            summaries += 1
            analyzed_threads.add(ev["thread_id"])
            daily[day]["analyzed"] += 1
        elif ev["kind"] in _ANSWERED:
            answered += 1
            daily[day]["answered"] += 1
            if ev["kind"] == "auto_sent":
                auto += 1

    autopilot = _autopilot_block(since, days, first_day, per_reply, settings)

    saved = summaries * per_summary + answered * per_reply
    handled = summaries + answered
    return {
        "days": days,
        "analyzed": len(analyzed_threads),
        "summaries": summaries,
        "answered": answered,
        "answered_by_autopilot": auto,
        "saved_minutes": round(saved, 1),
        "saved_per_day_minutes": round(saved / days, 1),
        "saved_per_item_minutes": round(saved / handled, 1) if handled else 0,
        "assumptions": {"minutes_per_summary": per_summary, "minutes_per_reply": per_reply},
        "daily": [{"date": d, **v} for d, v in daily.items()],
        "autopilot": autopilot,
    }


def _autopilot_block(since: datetime, days: int, first_day, per_reply: float, settings: dict) -> dict:
    """O que o piloto automático fez no período: quantas decisões tomou e
    como terminaram. 'Taxa de automação' = decisões que viraram envio de
    verdade / total de decisões. O tempo economizado conta só os envios
    automáticos (cada um poupa o mesmo que uma resposta escrita à mão)."""
    daily = {
        (first_day + timedelta(days=i)).isoformat(): {"auto_sent": 0, "drafts": 0, "alerts": 0} for i in range(days)
    }
    total = sent = cancelled = failed = pending = drafts = alerts = 0
    assist_suggested = assist_used = assist_gaps = 0
    for d in store.list_autopilot_decisions_since(since.isoformat()):
        day = _local_date(d["decided_at"])
        if day not in daily:
            continue
        if d["action"] == "suggest":
            assist_suggested += 1
            assist_used += d["status"] == "used"
            continue
        if d["action"] == "needs_context":
            assist_gaps += 1
            continue
        if d["action"] == "no_reply":
            continue
        total += 1
        if d["action"] == "auto_send":
            if d["status"] == "sent":
                sent += 1
                daily[day]["auto_sent"] += 1
            elif d["status"] == "cancelled":
                cancelled += 1
            elif d["status"] == "failed":
                failed += 1
            else:
                pending += 1
        elif d["action"] == "draft_only":
            drafts += 1
            daily[day]["drafts"] += 1
        else:
            alerts += 1
            daily[day]["alerts"] += 1
    return {
        "enabled": bool(settings.get("autopilot_enabled")),
        "level": settings.get("autopilot_level") or "conservador",
        "decisions": total,
        "auto_sent": sent,
        "auto_cancelled": cancelled,
        "auto_failed": failed,
        "auto_pending": pending,
        "drafts": drafts,
        "alerts": alerts,
        "automation_rate": round(sent / total * 100) if total else 0,
        "saved_minutes": round(sent * per_reply, 1),
        "assist": {"suggested": assist_suggested, "used": assist_used, "gaps": assist_gaps},
        "daily": [{"date": d, **v} for d, v in daily.items()],
    }
