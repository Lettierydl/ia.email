"""Imagens inline no corpo ("[image: image.png]" -> miniatura).

Gmail falso: nada sai daqui. Confere o mapa placeholder -> anexo que vai no
/gmail-attachments e a rota /image (só imagem de verdade, com limite)."""
import base64

import pytest
from fastapi.testclient import TestClient

from app import auth, gmail_client, main
from app.main import app

PNG = b"\x89PNG\r\n\x1a\n" + b"\x00" * 32
JPG = b"\xff\xd8\xff\xe0" + b"\x00" * 32


def _b64(s: str) -> str:
    return base64.urlsafe_b64encode(s.encode()).decode()


def _img_part(att_id, filename, cid="", disposition="inline", mime="image/png"):
    headers = [{"name": "Content-Type", "value": f'{mime}; name="{filename}"'}]
    if cid:
        headers.append({"name": "Content-ID", "value": f"<{cid}>"})
    if disposition:
        headers.append({"name": "Content-Disposition", "value": f'{disposition}; filename="{filename}"'})
    return {"mimeType": mime, "filename": filename, "headers": headers, "body": {"attachmentId": att_id, "size": 1234}}


def _message(gid, text, html, parts):
    alt = {
        "mimeType": "multipart/alternative",
        "parts": [
            {"mimeType": "text/plain", "body": {"data": _b64(text)}},
            {"mimeType": "text/html", "body": {"data": _b64(html)}},
        ],
    }
    return {
        "id": gid,
        "payload": {
            "mimeType": "multipart/related",
            "headers": [{"name": "From", "value": "Marcelo <m@x.com>"}, {"name": "Date", "value": "Thu, 22 Oct 2026 10:44:00 -0300"}],
            "parts": [alt, *parts],
        },
    }


class _Req:
    def __init__(self, fn):
        self.fn = fn

    def execute(self):
        return self.fn()


class FakeGmail:
    def __init__(self, msgs, blobs=None):
        self._msgs = msgs
        self.blobs = blobs or {}

    def users(self):
        return self

    def threads(self):
        return self

    def messages(self):
        return self

    def attachments(self):
        return self

    def get(self, **kw):
        if "messageId" in kw:
            data = self.blobs[kw["id"]]
            return _Req(lambda: {"data": base64.urlsafe_b64encode(data).decode()})
        return _Req(lambda: {"messages": self._msgs})


@pytest.fixture
def fake(monkeypatch):
    holder = {}

    def install(msgs, blobs=None):
        holder["g"] = FakeGmail(msgs, blobs)
        return holder["g"]

    monkeypatch.setattr(gmail_client, "load_credentials", lambda: object())
    monkeypatch.setattr(gmail_client, "_service", lambda creds: holder["g"])
    monkeypatch.setattr(gmail_client, "_execute", lambda req, attempts=6: req.execute())
    return install


def test_placeholder_maps_by_cid_from_html(fake):
    # alt do HTML difere do nome do arquivo: casa pelo cid da <img>
    fake([
        _message(
            "m1",
            "Segue o print:\n[image: image.png]\nAbs",
            '<p>Segue o print:</p><img src="cid:ii_abc123" alt="image.png"><p>Abs</p>',
            [_img_part("A1", "outro.pdf", disposition="attachment", mime="application/pdf"), _img_part("A2", "image.png", cid="ii_abc123")],
        )
    ])
    out = TestClient(app).get("/api/threads/t1/gmail-attachments").json()
    assert out["message_ids"] == ["m1"]
    ph = out["inline"]["m1"]
    assert len(ph) == 1
    assert ph[0]["token"] == "[image: image.png]"
    assert ph[0]["attachment_id"] == "A2" and ph[0]["rule"] == "cid"
    by_id = {f["attachment_id"]: f for f in out["files"]}
    assert by_id["A2"]["content_id"] == "ii_abc123"
    assert by_id["A2"]["inline"] is True and by_id["A2"]["in_body"] is True and by_id["A2"]["is_image"] is True
    assert by_id["A1"]["in_body"] is False and by_id["A1"]["is_image"] is False


def test_same_filename_many_images_follow_html_order(fake):
    # Gmail cola tudo como "image.png": o cid da ordem do HTML decide
    html = '<img src="cid:c2" alt="image.png"> texto <img src="cid:c1" alt="image.png"> <img src="cid:c3" alt="image.png">'
    fake([
        _message(
            "m1",
            "a [image: image.png] b [image: image.png] c [image: image.png]",
            html,
            [_img_part("A1", "image.png", cid="c1"), _img_part("A2", "image.png", cid="c2"), _img_part("A3", "image.png", cid="c3")],
        )
    ])
    ph = TestClient(app).get("/api/threads/t1/gmail-attachments").json()["inline"]["m1"]
    assert [p["attachment_id"] for p in ph] == ["A2", "A1", "A3"]


def test_without_html_cid_falls_back_to_filename_then_order():
    files = [
        {"attachment_id": "A1", "filename": "foto.jpg", "mime_type": "image/jpeg", "content_id": "", "inline": False},
        {"attachment_id": "A2", "filename": "grafico.png", "mime_type": "image/png", "content_id": "", "inline": True},
        {"attachment_id": "A3", "filename": "relatorio.pdf", "mime_type": "application/pdf", "content_id": "", "inline": False},
    ]
    text = "[imagem: foto.jpg] e [image: sem-nome.png] e [image: outro.png]"
    ph = gmail_client.map_inline_placeholders(text, files, [])
    assert [(p["attachment_id"], p["rule"]) for p in ph] == [("A1", "filename"), ("A2", "ordem"), (None, None)]


def test_cid_placeholder_and_no_match_stays_text(fake):
    fake([
        _message(
            "m1",
            "veja [cid:logo@x] e [image: sumiu.png]",
            "<p>sem img</p>",
            [_img_part("A1", "logo.png", cid="logo@x")],
        )
    ])
    ph = TestClient(app).get("/api/threads/t1/gmail-attachments").json()["inline"]["m1"]
    assert ph[0]["attachment_id"] == "A1" and ph[0]["rule"] == "cid"
    assert ph[1]["attachment_id"] is None


def test_message_without_images_has_no_placeholders(fake):
    fake([_message("m1", "[image: image.png] sem anexo", "<p>x</p>", [])])
    out = TestClient(app).get("/api/threads/t1/gmail-attachments").json()
    assert out["inline"]["m1"][0]["attachment_id"] is None
    assert out["files"] == []


def test_svg_and_pdf_are_not_inline_candidates():
    files = [
        {"attachment_id": "S", "filename": "x.svg", "mime_type": "image/svg+xml", "content_id": "s", "inline": True},
        {"attachment_id": "P", "filename": "x.pdf", "mime_type": "application/pdf", "content_id": "p", "inline": True},
    ]
    ph = gmail_client.map_inline_placeholders("[image: x.svg] [cid:p]", files, [{"cid": "s", "alt": "x.svg"}])
    assert [p["attachment_id"] for p in ph] == [None, None]


def test_image_route_serves_png_with_private_cache(fake):
    fake([], {"A1": PNG, "A2": JPG})
    c = TestClient(app)
    r = c.get("/api/threads/t1/gmail-attachments/m1/image", params={"attachment_id": "A1"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "image/png"
    assert r.headers["cache-control"] == "private, max-age=86400"
    assert r.headers["x-content-type-options"] == "nosniff"
    assert r.content == PNG
    r = c.get("/api/threads/t1/gmail-attachments/m1/image", params={"attachment_id": "A2"})
    assert r.headers["content-type"] == "image/jpeg"


def test_image_route_rejects_non_image_and_svg(fake):
    fake([], {"P": b"%PDF-1.4 fake", "S": b'<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'})
    c = TestClient(app)
    for att in ("P", "S"):
        r = c.get("/api/threads/t1/gmail-attachments/m1/image", params={"attachment_id": att})
        assert r.status_code == 415


def test_image_route_size_limit(fake, monkeypatch):
    monkeypatch.setattr(main, "INLINE_IMAGE_MAX_BYTES", 16)
    fake([], {"A1": PNG})
    r = TestClient(app).get("/api/threads/t1/gmail-attachments/m1/image", params={"attachment_id": "A1"})
    assert r.status_code == 413


def test_image_route_requires_token(fake, monkeypatch):
    from conftest import RawTestClient

    monkeypatch.setattr(auth, "_default_gateways", lambda *a, **k: set())
    fake([], {"A1": PNG})

    async def from_lan(scope, receive, send):  # IP de fora, sem token
        await app(dict(scope, client=("203.0.113.7", 50000)), receive, send)

    r = RawTestClient(from_lan, base_url="http://127.0.0.1:8765").get(
        "/api/threads/t1/gmail-attachments/m1/image", params={"attachment_id": "A1"}
    )
    assert r.status_code == 401
