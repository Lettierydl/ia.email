from __future__ import annotations

from typing import Any

from google.oauth2.credentials import Credentials
from googleapiclient.discovery import build

from .gmail_client import _execute

PEOPLE_SCOPES = {
    "https://www.googleapis.com/auth/contacts.readonly",
    "https://www.googleapis.com/auth/contacts",
    "https://www.googleapis.com/auth/directory.readonly",
}


def has_people_scope(creds: Credentials | None) -> bool:
    if not creds:
        return False
    return bool(set(creds.scopes or []) & PEOPLE_SCOPES)


def _service(creds: Credentials):
    return build("people", "v1", credentials=creds, cache_discovery=False)


def _extract_photo(person: dict[str, Any]) -> str | None:
    photos = person.get("photos") or []
    for photo in photos:
        if not photo.get("default") and photo.get("url"):
            return photo["url"]
    for photo in photos:
        if photo.get("url"):
            return photo["url"]
    return None


def _matches(person: dict[str, Any], email: str) -> bool:
    addrs = [(a.get("value") or "").lower() for a in person.get("emailAddresses") or []]
    return email.lower() in addrs


def resolve_avatar(creds: Credentials, email: str) -> str | None:
    """Busca a foto de perfil de quem mandou o e-mail: primeiro no
    diretorio do Workspace (colegas confrapag.com.br), depois nos
    contatos pessoais do Leo. Retorna None se nao achar em nenhum dos
    dois -- e ai o front usa o avatar de iniciais como fallback."""
    service = _service(creds)

    try:
        result = _execute(
            service.people().searchDirectoryPeople(
                query=email,
                readMask="photos,emailAddresses",
                sources=["DIRECTORY_SOURCE_TYPE_DOMAIN_PROFILE"],
            )
        )
        for person in result.get("people") or []:
            if _matches(person, email):
                url = _extract_photo(person)
                if url:
                    return url
    except Exception:
        pass

    try:
        result = _execute(
            service.people().searchContacts(query=email, readMask="photos,emailAddresses")
        )
        for match in result.get("results") or []:
            person = match.get("person") or {}
            if _matches(person, email):
                url = _extract_photo(person)
                if url:
                    return url
    except Exception:
        pass

    return None
