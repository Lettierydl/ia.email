from __future__ import annotations

from datetime import datetime, timedelta, timezone

from . import assist, store

# Dados do painel visual (/board): todos os e-mails que a IA analisou, já
# agrupados em zonas e normalizados num formato único, pra tela desenhar
# cartões e o painel lateral sem precisar saber de onde cada coisa veio
# (Auxiliar ou piloto automático).

ZONES = [
    {"key": "can", "title": "Posso responder", "tone": "green", "hint": "Tenho base no que você já decidiu pra sugerir uma resposta."},
    {"key": "gap", "title": "Preciso de contexto", "tone": "amber", "hint": "Falta uma decisão ou informação pra eu responder."},
    {"key": "none", "title": "Não pedem resposta", "tone": "gray", "hint": "Informativos: ata, aviso, status."},
    {"key": "queue", "title": "Saem sozinhos", "tone": "blue", "hint": "Piloto automático: esperando o tempo de segurança. Cancele se não concordar."},
    {"key": "alert", "title": "Alertas", "tone": "red", "hint": "O piloto não respondeu e pede a sua atenção."},
    {"key": "draft", "title": "Rascunhos do piloto", "tone": "violet", "hint": "O piloto escreveu, mas não enviou sozinho."},
    {"key": "sent", "title": "Tratados pelo piloto", "tone": "slate", "hint": "Enviados, cancelados ou com falha nos últimos 7 dias."},
]
ALWAYS_SHOWN = {"can", "gap", "none"}
_SECURITY_PREFIX = "Exclusão de segurança:"
_PREVIEW = 190


def _clip(text: str, n: int = _PREVIEW) -> str:
    text = " ".join((text or "").split())
    return text if len(text) <= n else text[: n - 1].rstrip() + "…"


def _friendly(reasoning: str) -> tuple[str, str]:
    """(motivo legível, tipo). Exclusão por regra vira uma frase de gente
    ("Assunto jurídico ou de RH...") em vez de jargão ("Exclusão de segurança")."""
    reasoning = (reasoning or "").strip()
    if reasoning.startswith(_SECURITY_PREFIX):
        rest = reasoning[len(_SECURITY_PREFIX):].strip().rstrip(".")
        rest = rest[:1].upper() + rest[1:]
        return f"{rest}. Por regra, não respondo esse tipo de e-mail sozinho.", "security"
    if not reasoning:
        return "A IA marcou como algo que precisa da sua atenção, sem detalhar o motivo.", "model"
    return reasoning, "model"


def _base(zone: str, d: dict, row: dict) -> dict:
    return {
        "id": d["id"],
        "zone": zone,
        "thread_id": d["thread_id"],
        "subject": row.get("subject") or "(sem assunto)",
        "from": row.get("from_name") or row.get("from_email") or "",
        "from_email": row.get("from_email") or "",
        "when": d.get("decided_at"),
        "confidence": None,
        "chip": "",
        "preview": "",
        "body": "",
        "body_label": "",
        "reason": "",
        "question": "",
        "evidence": [],
        "sensitive": False,
        "state": "",
        "scheduled_send_at": d.get("scheduled_send_at"),
        "error": d.get("error") or "",
        "actions": [],
    }


def _assist_item(zone: str, it: dict) -> dict:
    row = store.get_thread(it["thread_id"]) or {}
    out = _base(zone, {**it, "decided_at": it.get("decided_at")}, row)
    out["sensitive"] = it["sensitive"]
    out["evidence"] = it["evidence"]
    out["question"] = it["question"]
    if zone == "can":
        out.update(
            confidence=it["confidence"], body=it["draft_text"], body_label="Resposta sugerida",
            preview=_clip(it["draft_text"]), reason=it["reasoning"], actions=["use", "open", "dismiss"],
        )
    elif zone == "gap":
        out.update(
            body=it["reasoning"], body_label="O que falta", reason=it["reasoning"],
            preview=_clip(it["question"] or it["reasoning"]), actions=["open", "dismiss"],
        )
    else:
        out.update(body=it["reasoning"], body_label="Por que não precisa", reason=it["reasoning"],
                   preview=_clip(it["reasoning"]), actions=["open", "dismiss"])
    return out


def _pilot_item(zone: str, d: dict) -> dict:
    row = store.get_thread(d["thread_id"]) or {}
    out = _base(zone, d, row)
    reason, kind = _friendly(d.get("reasoning") or "")
    show_conf = kind != "security" and (d.get("confidence") or 0) > 0
    out["confidence"] = d.get("confidence") if show_conf else None
    out["reason"] = reason
    out["chip"] = "Regra de segurança" if kind == "security" else ""
    draft = d.get("draft_text") or ""
    if zone == "queue":
        out.update(body=draft, body_label="Vai enviar este texto", preview=_clip(draft), actions=["cancel", "open"])
    elif zone == "alert":
        out.update(body=reason, body_label="Por que não respondi", preview=_clip(reason), actions=["open", "dismiss_pilot"])
    elif zone == "draft":
        out.update(body=draft, body_label="Rascunho do piloto", preview=_clip(draft or reason), actions=["open", "dismiss_pilot"])
    else:
        status = d.get("status") or ""
        out["state"] = status
        out.update(
            body=draft, body_label={"sent": "Texto enviado", "cancelled": "Texto que seria enviado", "failed": "Texto que falhou"}.get(status, "Texto"),
            reason={"sent": "Enviado automaticamente.", "cancelled": "Você cancelou antes de sair."}.get(status, d.get("error") or "Falhou ao enviar."),
            preview=_clip(draft or d.get("error") or ""), actions=["open"],
        )
    return out


def build() -> dict:
    rep = assist.report()
    buckets: dict[str, list[dict]] = {z["key"]: [] for z in ZONES}
    for it in rep["suggestions"]:
        buckets["can"].append(_assist_item("can", it))
    for it in rep["gaps"]:
        buckets["gap"].append(_assist_item("gap", it))
    for it in rep["no_reply"]:
        buckets["none"].append(_assist_item("none", it))

    for d in store.list_autopilot_decisions(status="pending", limit=60):
        buckets["queue"].append(_pilot_item("queue", d))
    for d in store.list_autopilot_decisions(status="resolved", limit=100):
        if d["action"] == "alert":
            buckets["alert"].append(_pilot_item("alert", d))
        elif d["action"] == "draft_only":
            buckets["draft"].append(_pilot_item("draft", d))
    cutoff = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()
    for status in ("sent", "cancelled", "failed"):
        for d in store.list_autopilot_decisions(status=status, limit=15):
            if (d.get("decided_at") or "") >= cutoff:
                buckets["sent"].append(_pilot_item("sent", d))
    buckets["sent"].sort(key=lambda i: i.get("when") or "", reverse=True)

    zones = [
        {**z, "items": buckets[z["key"]]}
        for z in ZONES
        if buckets[z["key"]] or z["key"] in ALWAYS_SHOWN
    ]
    return {
        "zones": zones,
        "total": sum(len(z["items"]) for z in zones),
        "mode": store.get_settings().get("autopilot_mode") or "piloto",
    }
