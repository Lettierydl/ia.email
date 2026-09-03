from app.assistant import _looks_verbatim


def test_detects_gmail_url_dump():
    assert _looks_verbatim(
        "Leo, bom dia. https://www.google.com/url?q=x",
        "corpo",
        "Leo, bom dia",
    )


def test_accepts_structured():
    text = (
        "Pedido: validar path_percent zerado.\n"
        "Fatos:\n- R$ 9.813,07 no Pague Assim\n"
        "Decisão/ação de Leo:\n- confirmar se foi combinado\n"
        "Ruído: nenhum"
    )
    assert not _looks_verbatim(text, "email longo " * 40, "Leo, bom dia")
