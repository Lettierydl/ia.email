from __future__ import annotations

import pytest

from app import assistant, store


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()


def test_several_aliases_for_the_same_person_resolve_to_the_same_email():
    store.save_alias("rodrigo", "Rodrigo Henrique", "rodrigo.henrique@confrapag.com.br")
    store.save_alias("rodrigo henrrique", "Rodrigo Henrique", "rodrigo.henrique@confrapag.com.br")
    res = assistant._resolve_cc_names(["rodrigo", "Rodrigo Henrrique"])
    assert [r["status"] for r in res] == ["resolved", "resolved"]
    assert {r["candidates"][0]["email"] for r in res} == {"rodrigo.henrique@confrapag.com.br"}


def test_glossary_has_one_line_per_person_with_all_their_aliases():
    store.save_alias("rodrigo", "Rodrigo Henrique", "rodrigo.henrique@confrapag.com.br")
    store.save_alias("rodrigo henrrique", "Rodrigo Henrique", "rodrigo.henrique@confrapag.com.br")
    store.save_alias("paulo", "Paulo Lemes", "paulo.lemes@confrapag.com.br")
    glossary = assistant._alias_glossary()
    lines = [l for l in glossary.splitlines() if l.startswith("- ")]
    assert len(lines) == 2
    rodrigo = next(l for l in lines if "rodrigo.henrique" in l)
    assert '"rodrigo"' in rodrigo and '"rodrigo henrrique"' in rodrigo and "Rodrigo Henrique" in rodrigo


def test_alias_without_email_still_appears_and_empty_store_gives_empty_glossary():
    assert assistant._alias_glossary() == ""
    store.save_alias("chefe", "Fulano Chefe", "")
    assert '"chefe" = Fulano Chefe' in assistant._alias_glossary()


def test_reusing_an_alias_for_another_person_moves_it():
    store.save_alias("rodrigo", "Rodrigo A", "a@x.com")
    store.save_alias("rodrigo", "Rodrigo B", "b@x.com")
    assert [a["email"] for a in store.list_aliases()] == ["b@x.com"]
