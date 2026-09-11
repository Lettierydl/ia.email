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


def parse_ics(text: str) -> dict[str, str | None]:
    # DTSTART/DTEND tambem aparecem dentro de VTIMEZONE (fuso horario, nao o
    # evento em si) -- restringe a busca ao bloco VEVENT pra nao pegar a
    # linha errada.
    event_match = re.search(r"BEGIN:VEVENT(.*?)END:VEVENT", text, re.DOTALL)
    event_text = event_match.group(1) if event_match else text

    def find(pattern: str, source: str = event_text) -> str | None:
        m = re.search(pattern, source)
        return m.group(1).strip() if m else None

    return {
        "uid": find(r"UID:([^\r\n]+)"),
        "dtstart": find(r"DTSTART(?:;[^:\r\n]*)?:([^\r\n]+)"),
        "dtend": find(r"DTEND(?:;[^:\r\n]*)?:([^\r\n]+)"),
        "summary": find(r"SUMMARY:([^\r\n]+)"),
        "method": find(r"METHOD:([^\r\n]+)", text),
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


def respond_to_invite(creds: Credentials, uid: str, response: str, account_email: str) -> dict:
    service = _service(creds)
    result = _execute(service.events().list(calendarId="primary", iCalUID=uid))
    items = result.get("items", [])
    if not items:
        raise RuntimeError("Evento não encontrado na sua agenda (ainda não sincronizou?).")
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
    return {"status": updated.get("status"), "responseStatus": response}
