from __future__ import annotations

import re
from datetime import datetime, timedelta, timezone
from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from .config import TZ
from .gmail_client import _execute

CALENDAR_SCOPES = {
    "https://www.googleapis.com/auth/calendar.events",
    "https://www.googleapis.com/auth/calendar",
    "https://www.googleapis.com/auth/calendar.readonly",
}


def has_calendar_scope(creds: Credentials | None) -> bool:
    if not creds:
        return False
    return bool(set(creds.scopes or []) & CALENDAR_SCOPES)


def _service(creds: Credentials):
    return build("calendar", "v3", credentials=creds, cache_discovery=False)


def day_label(start: datetime) -> str:
    # Convites sem fuso na ICS chegam "naive" -- assume o fuso local do app
    # pra comparar com hoje em vez de comparar contra UTC.
    ref = start if start.tzinfo else start.replace(tzinfo=TZ)
    today = datetime.now(TZ).date()
    ref_date = ref.astimezone(TZ).date()
    diff = (ref_date - today).days
    if diff == 0:
        return "Hoje"
    if diff == 1:
        return "Amanhã"
    if diff == -1:
        return "Ontem"
    weekday = ["segunda", "terça", "quarta", "quinta", "sexta", "sábado", "domingo"][ref_date.weekday()]
    return f"{ref_date.strftime('%d/%m')} ({weekday})"


def _unfold_ics(text: str) -> str:
    # Linhas longas no ICS vem "dobradas": continuam na linha seguinte com
    # um espaço/tab na frente. Sem desdobrar, ATTENDEE/ORGANIZER longos
    # (nome + e-mail) quebram no meio e o regex de e-mail nunca bate.
    return re.sub(r"\r?\n[ \t]", "", text)


def _parse_ics_person(line: str) -> dict[str, str] | None:
    email_m = re.search(r"mailto:([^\r\n;]+)", line, re.IGNORECASE)
    if not email_m:
        return None
    cn_m = re.search(r"CN=([^;:]+)", line)
    return {"email": email_m.group(1).strip(), "name": (cn_m.group(1).strip() if cn_m else "")}


def parse_ics(text: str) -> dict[str, Any]:
    unfolded = _unfold_ics(text)
    # DTSTART/DTEND tambem aparecem dentro de VTIMEZONE (fuso horario, nao o
    # evento em si) -- restringe a busca ao bloco VEVENT pra nao pegar a
    # linha errada.
    event_match = re.search(r"BEGIN:VEVENT(.*?)END:VEVENT", unfolded, re.DOTALL)
    event_text = event_match.group(1) if event_match else unfolded

    def find(pattern: str, source: str = event_text) -> str | None:
        m = re.search(pattern, source)
        return m.group(1).strip() if m else None

    attendees = []
    organizer = None
    for line in event_text.splitlines():
        upper = line.upper()
        if upper.startswith("ATTENDEE"):
            person = _parse_ics_person(line)
            if person:
                attendees.append(person)
        elif upper.startswith("ORGANIZER"):
            organizer = _parse_ics_person(line)

    return {
        "uid": find(r"UID:([^\r\n]+)"),
        "dtstart": find(r"DTSTART(?:;[^:\r\n]*)?:([^\r\n]+)"),
        "dtend": find(r"DTEND(?:;[^:\r\n]*)?:([^\r\n]+)"),
        # SUMMARY quase sempre vem com parâmetro (;LANGUAGE=pt-BR:, etc) em
        # convites do Outlook/Exchange -- sem o (?:;...)? opcional, o título
        # nunca batia e o convite ficava "(sem título)".
        "summary": find(r"SUMMARY(?:;[^:\r\n]*)?:([^\r\n]+)"),
        "method": find(r"METHOD:([^\r\n]+)", unfolded),
        "attendees": attendees,
        "organizer": organizer,
    }


def parse_ics_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    value = value.strip()
    try:
        if value.endswith("Z"):
            return datetime.strptime(value, "%Y%m%dT%H%M%SZ").replace(tzinfo=timezone.utc)
        if "T" in value:
            return datetime.strptime(value, "%Y%m%dT%H%M%S")
        return datetime.strptime(value, "%Y%m%d")
    except ValueError:
        return None


def _parse_gcal_dt(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        if len(value) == 10:
            return datetime.fromisoformat(value + "T00:00:00+00:00")
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def day_context(
    creds: Credentials, event_start: datetime, event_end: datetime, exclude_uid: str | None
) -> dict[str, Any]:
    service = _service(creds)
    tz = event_start.tzinfo or TZ
    if event_start.tzinfo is None:
        event_start = event_start.replace(tzinfo=tz)
    if event_end.tzinfo is None:
        event_end = event_end.replace(tzinfo=tz)
    day_start = event_start.astimezone(tz).replace(hour=0, minute=0, second=0, microsecond=0)
    day_end = day_start + timedelta(days=1)
    result = _execute(
        service.events().list(
            calendarId="primary",
            timeMin=day_start.isoformat(),
            timeMax=day_end.isoformat(),
            singleEvents=True,
            orderBy="startTime",
        )
    )
    events: list[dict] = []
    conflicts: list[dict] = []
    for ev in result.get("items", []):
        if exclude_uid and ev.get("iCalUID") == exclude_uid:
            continue
        start_raw = ev.get("start", {})
        end_raw = ev.get("end", {})
        all_day = "dateTime" not in start_raw
        s = _parse_gcal_dt(start_raw.get("dateTime") or start_raw.get("date"))
        e = _parse_gcal_dt(end_raw.get("dateTime") or end_raw.get("date"))
        if s is None:
            continue
        is_conflict = (not all_day) and bool(e) and s < event_end and e > event_start
        entry = {
            "summary": ev.get("summary") or "(sem título)",
            "start": s.strftime("%H:%M") if not all_day else "",
            "end": e.strftime("%H:%M") if e and not all_day else "",
            "start_iso": s.isoformat(),
            "end_iso": e.isoformat() if e else None,
            "all_day": all_day,
            "is_conflict": is_conflict,
        }
        events.append(entry)
        if is_conflict:
            conflicts.append(entry)
    return {
        "events": events,
        "conflicts": conflicts,
    }


def _event_body_from_ics(info: dict, account_email: str, response: str) -> dict | None:
    """Monta o corpo pra importar o evento quando ele não existe ainda na
    agenda -- convite chegou por e-mail (ex.: Exchange/Outlook de terceiro)
    mas o Gmail nunca auto-adicionou. Sem isso, "Sim" simplesmente falhava
    e nada aparecia na agenda do Leo."""
    start = parse_ics_datetime(info.get("dtstart"))
    end = parse_ics_datetime(info.get("dtend")) or start
    if not start:
        return None
    # ICS sem "Z" e sem UTC vem "naive" -- mesma convenção usada no resto
    # do app: assume o fuso local em vez de UTC.
    if start.tzinfo is None:
        start = start.replace(tzinfo=TZ)
    if end and end.tzinfo is None:
        end = end.replace(tzinfo=TZ)
    end = end or start
    attendees = list(info.get("attendees") or [])
    out_attendees = []
    matched = False
    for a in attendees:
        entry = {"email": a["email"]}
        if a.get("name") and "@" not in a["name"]:
            entry["displayName"] = a["name"]
        if a["email"].lower() == account_email.lower():
            entry["responseStatus"] = response
            matched = True
        out_attendees.append(entry)
    if not matched:
        out_attendees.append({"email": account_email, "responseStatus": response})
    body: dict[str, Any] = {
        "iCalUID": info.get("uid"),
        "summary": info.get("summary") or "(sem título)",
        "start": {"dateTime": start.isoformat()},
        "end": {"dateTime": end.isoformat()},
        "attendees": out_attendees,
    }
    organizer = info.get("organizer")
    if organizer and organizer.get("email"):
        body["organizer"] = {"email": organizer["email"]}
        if organizer.get("name") and "@" not in organizer["name"]:
            body["organizer"]["displayName"] = organizer["name"]
    return body


def respond_to_invite(
    creds: Credentials, uid: str, response: str, account_email: str, ics_info: dict | None = None
) -> dict:
    service = _service(creds)
    result = _execute(service.events().list(calendarId="primary", iCalUID=uid))
    items = result.get("items", [])
    if items:
        event = items[0]
        attendees = event.get("attendees") or []
        found = False
        for attendee in attendees:
            if (attendee.get("email") or "").lower() == account_email.lower():
                attendee["responseStatus"] = response
                found = True
        if not found:
            attendees.append({"email": account_email, "responseStatus": response})
        updated = _execute(
            service.events().patch(
                calendarId="primary",
                eventId=event["id"],
                body={"attendees": attendees},
                sendUpdates="all",
            )
        )
        return {"status": updated.get("status"), "responseStatus": response, "created": False}

    # Não achou por UID -- o convite nunca foi parar na agenda sozinho
    # (comum em .ics de Exchange/Outlook anexado, que o Gmail não
    # auto-detecta como os convites nativos do Google Calendar). Importa
    # o evento agora, com a resposta do Leo já preenchida, em vez de só
    # falhar e deixar a agenda desatualizada.
    body = _event_body_from_ics(ics_info or {}, account_email, response)
    if not body:
        raise RuntimeError("Evento não encontrado na sua agenda (ainda não sincronizou?).")
    created = _execute(service.events().import_(calendarId="primary", body=body))
    return {"status": created.get("status"), "responseStatus": response, "created": True}
