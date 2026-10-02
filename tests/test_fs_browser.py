from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app import config, fs_browser
from app.main import app


@pytest.fixture
def base(tmp_path, monkeypatch):
    root = tmp_path / "Learning Base"
    (root / "lb-company" / "products").mkdir(parents=True)
    (root / "lb-company" / "products" / "Pulse.md").write_text("pulse")
    (root / "lb-company" / "decisões.md").write_text("decisoes")
    (root / "credenciais").mkdir()
    (root / "credenciais" / "chaves.md").write_text("segredo")
    (root / "lb-company" / "radar-contextos").mkdir()
    (root / "lb-company" / "radar-contextos" / "export.md").write_text("tmp")
    (root / ".git").mkdir()
    (root / "foto.png").write_bytes(b"x")
    (root / "README.md").write_text("oi")
    monkeypatch.setattr(config, "LEARNING_BASE_GLOBAL_DEFAULT", root)
    return root


def test_browse_root_lists_dirs_first_and_hides_sensitive_and_non_text(base):
    data = fs_browser.browse()
    names = [e["name"] for e in data["entries"]]
    assert names == ["lb-company", "README.md"]
    assert "credenciais" not in names and ".git" not in names and "foto.png" not in names
    company = data["entries"][0]
    assert company["type"] == "dir" and company["files"] == 2  # exclui credenciais e radar-contextos
    assert data["parent"] is None


def test_browse_subfolder_has_breadcrumb_and_parent(base):
    data = fs_browser.browse(str(base / "lb-company"))
    assert [c["name"] for c in data["breadcrumb"]] == ["Learning Base", "lb-company"]
    assert data["parent"] == str(base)
    assert "radar-contextos" not in [e["name"] for e in data["entries"]]


def test_cannot_escape_the_learning_base(base, tmp_path):
    outside = tmp_path / "fora"
    outside.mkdir()
    with pytest.raises(fs_browser.FsError):
        fs_browser.browse(str(outside))
    with pytest.raises(fs_browser.FsError):
        fs_browser.browse(str(base / ".." / "fora"))
    (base / "atalho").symlink_to(outside)
    with pytest.raises(fs_browser.FsError):
        fs_browser.browse(str(base / "atalho"))


def test_search_is_accent_insensitive_and_skips_hidden_areas(base):
    names = [h["name"] for h in fs_browser.search("decisoes")]
    assert names == ["decisões.md"]
    assert fs_browser.search("chaves") == []
    assert fs_browser.search("export") == []
    assert fs_browser.search("a") == []  # termo curto demais


def test_describe_flags_missing_and_outside_paths(base, tmp_path):
    items = fs_browser.describe([str(base / "lb-company"), str(base / "sumiu"), str(tmp_path)])
    assert [i["type"] for i in items] == ["dir", "missing", "outside"]
    assert items[0]["files"] == 2


def test_api_rejects_paths_outside(base, tmp_path):
    client = TestClient(app)
    assert client.get("/api/fs/browse").status_code == 200
    assert client.get("/api/fs/browse", params={"path": str(tmp_path)}).status_code == 400
    assert client.get("/api/fs/search", params={"q": "pulse"}).json()["items"][0]["name"] == "Pulse.md"
