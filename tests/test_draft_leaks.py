"""Rascunho não pode copiar o pedido do Leo (caso Kennedy/Klesia, /copilot):
comentários [n] e comandos de meta viram resposta/ação, nunca texto do e-mail."""
from __future__ import annotations

import json

import pytest

from app import assistant, draft_guard, llm, store

KENNEDY = (
    "De: Kennedy <kennedy@weqi.com.br>\nData: 2026-10-14\n\n"
    "Oi Leo, tudo bem?\n\n"
    "Seguem os pontos que levantamos:\n\n"
    "1 - Escopo do time:\n"
    "- Atividades mensais do PCI: Revisões de documentação, testes de segmentação, revisão de regras de firewall "
    "e acompanhamento das evidências para o QSA.\n"
    "- Atividades de devops: Evolução do ambiente pensando em Finops e custo dentro da AWS, com revisão mensal "
    "das reservas.\n"
    "- Atividades de Secops: Controle e gestão de acesso ao ambiente CDE. - Governança de chaves e rotação de "
    "segredos.\n\n"
    "2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e na WEQI, como priorizamos "
    "o atendimento?\n\n"
    "Abs,\nKennedy"
)

PEDIDO = (
    '[1] Sobre "- Atividades mensais do PCI: Revisões de documentação, testes de segmentação, r…": '
    "Essas atividades são feitas todos os meses? Ou foi feita durante o processo de PSI?\n"
    '[2] Sobre "- Atividades de devops: Evolução do ambiente pensando em Finops e custo dentro d…": '
    "Isso é perfeito, exatamente o que o Claudeci faz aqui.\n"
    '[3] Sobre "- Atividades de Secops: Controle e gestão de acesso ao ambiente CDE. - Governanç…": '
    "Isso também o Claudeci faz aqui todo mês. E na verdade muita coisa ele já automatizou.\n"
    '[4] Sobre "2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e n…": '
    "Sobre a concorrência concordo com você é um gargalo, mas que devemos priorizar a WEQI.\n\n"
    "Continue a resposta dos outros pontos da forma como você fez no primeiro ponto."
)

TURNO_1 = 'Pergunte sobre o primeiro ponto se as atividades do PCI são mensais'
RASCUNHO_1 = (
    "Oi Kennedy, tudo bem?\n\nObrigado pelos pontos. Sobre as atividades do PCI: elas são feitas todos os "
    "meses ou foram feitas durante o processo de PSI?\n\nAbs,\nLeo"
)

RUIM = (
    "Oi Kennedy, tudo bem?\n\nAs atividades do PCI são feitas todos os meses ou foram durante o PSI?\n\n"
    "Sobre a concorrência concordo com você é um gargalo, mas que devemos priorizar a WEQI.\n\n"
    "Continue a resposta dos outros pontos da forma como você fez no primeiro ponto.\n\nAbs,\nLeo"
)
BOM = (
    "Oi Kennedy, tudo bem?\n\nObrigado pelos pontos. Sobre as atividades do PCI: elas são feitas todos os "
    "meses ou foram feitas durante o processo de PSI?\n\n"
    "Quanto ao devops, perfeito: é exatamente o trabalho que o Claudeci já conduz por aqui.\n\n"
    "Em Secops vale o mesmo: o Claudeci cuida disso mensalmente e boa parte já está automatizada.\n\n"
    "Sobre a concorrência de demandas, concordo que pode virar um gargalo; nesse cenário, a WEQI tem "
    "prioridade.\n\nAbs,\nLeo"
)


@pytest.fixture(autouse=True)
def _isolated(tmp_path, monkeypatch):
    monkeypatch.setattr("app.store.DB_PATH", tmp_path / "t.sqlite")
    store.init()
    store.save_settings(rag_enabled=False)
    monkeypatch.setattr(llm, "has_key", lambda: True)
    store.upsert_thread(
        {
            "id": "k1", "subject": "Proposta de escopo", "from_email": "kennedy@weqi.com.br", "from_name": "Kennedy",
            "snippet": "", "internal_date": 5, "is_unread": 0, "last_from_me": 0, "is_automatic": 0,
            "is_marketing": 0, "needs_action_hint": 0, "awaiting_reply": 0, "conferido": 1,
            "hidden": 0, "hide_as_replied": 0, "last_from_header": "", "labels_json": [],
        }
    )
    chat = [{"role": "user", "text": TURNO_1}, {"role": "ai", "kind": "draft", "text": RASCUNHO_1}]
    store.save_ai("k1", body_text=KENNEDY, chat_json=json.dumps(chat), chat_anchor_date=5, draft=RASCUNHO_1)


def _fake(monkeypatch, replies):
    prompts = []
    it = iter(replies)

    def complete(prompt, **kwargs):
        prompts.append(prompt)
        return json.dumps({"kind": "draft", "text": next(it), "cc_names": []})

    monkeypatch.setattr(llm, "complete", complete)
    return prompts


def test_prompt_separates_request_from_email_with_all_turns_and_full_quotes(monkeypatch):
    prompts = _fake(monkeypatch, [BOM])
    out = assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    p = prompts[0]
    # blocos rotulados, na ordem: conversa -> pedido -> rascunho -> thread
    for tag in ("<<<CONVERSA_COM_A_IA", "<<<PEDIDO_DO_LEO", "<<<RASCUNHO_ANTERIOR", "<<<THREAD"):
        assert tag in p
    assert p.rindex("<<<CONVERSA_COM_A_IA") < p.rindex("<<<PEDIDO_DO_LEO") < p.rindex("<<<RASCUNHO_ANTERIOR") < p.rindex("<<<THREAD")
    # todos os turnos anteriores do chat
    assert TURNO_1 in p and "IA (rascunho 1)" in p
    # trechos citados voltam inteiros (sem o "…" do front) e o comentário vira intenção
    pedido = p[p.rindex("<<<PEDIDO_DO_LEO"):p.rindex("PEDIDO_DO_LEO>>>")]
    assert "acompanhamento das evidências para o QSA." in pedido
    assert "Governança de chaves e rotação de segredos." in pedido
    assert "como priorizamos o atendimento?" in pedido
    assert "Intenção do Leo para esse ponto: Isso é perfeito, exatamente o que o Claudeci faz aqui." in pedido
    assert "Instrução do Leo: Continue a resposta dos outros pontos" in pedido
    # regras fortes
    assert "NUNCA copie essas frases para o e-mail" in p and "são EXECUTADOS, nunca escritos" in p
    assert "Não cole as perguntas/pontos do remetente sem resposta" in p
    assert len(prompts) == 1 and "alerta_copia" not in out


def test_comments_follow_email_order_not_number_order(monkeypatch):
    prompts = _fake(monkeypatch, [BOM])
    pedido = (
        '[1] Sobre "2 - Concorrência de demandas: Caso tenhamos incidências": priorize a WEQI\n'
        '[2] Sobre "- Atividades de devops: Evolução do ambiente": é o que fazemos'
    )
    assistant.draft("k1", pedido)
    p = prompts[0]
    assert p.index("[2] Trecho citado") < p.index("[1] Trecho citado")


def test_copied_comment_and_meta_trigger_one_retry_with_correction(monkeypatch):
    prompts = _fake(monkeypatch, [RUIM, BOM])
    out = assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    assert len(prompts) == 2
    assert "CORREÇÃO OBRIGATÓRIA" in prompts[1]
    assert "Continue a resposta dos outros pontos da forma como você fez no primeiro ponto." in prompts[1]
    assert out["draft"] == BOM and "alerta_copia" not in out
    assert store.get_thread("k1")["draft"] == BOM


def test_second_failure_returns_draft_with_warning_and_passages(monkeypatch):
    prompts = _fake(monkeypatch, [RUIM, RUIM])
    out = assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    assert len(prompts) == 2
    assert out["draft"] == RUIM
    alerta = out["alerta_copia"]
    assert alerta["mensagem"].startswith("A IA pode ter copiado parte do seu pedido")
    assert "Continue a resposta dos outros pontos da forma como você fez no primeiro ponto." in alerta["trechos"]
    assert any("devemos priorizar a WEQI" in t for t in alerta["trechos"])
    assert all(t in RUIM for t in alerta["trechos"])  # texto exato do rascunho: o front acha e destaca


def test_clean_draft_does_not_retry(monkeypatch):
    prompts = _fake(monkeypatch, [BOM])
    out = assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    assert len(prompts) == 1 and "alerta_copia" not in out


def test_reformulated_content_does_not_trigger():
    segs = draft_guard.request_segments(PEDIDO, [TURNO_1])
    assert draft_guard.find_leaks(BOM, segs, allowed=KENNEDY) == []


def test_dictated_content_and_quoted_text_are_not_leaks():
    segs = draft_guard.request_segments(
        'diga que vamos enviar o relatório completo até sexta-feira à tarde sem falta. '
        'Use a frase "seguimos à disposição para qualquer dúvida sobre o contrato assinado"'
    )
    draft = ("Oi Ana,\n\nVamos enviar o relatório completo até sexta-feira à tarde sem falta.\n\n"
             "Seguimos à disposição para qualquer dúvida sobre o contrato assinado.\n\nAbs")
    assert draft_guard.find_leaks(draft, segs) == []


def test_text_already_in_the_thread_is_not_a_leak():
    segs = draft_guard.request_segments(
        '[1] Sobre "x": Caso tenhamos incidências simultâneas no Pulse e na WEQI como priorizamos o atendimento'
    )
    draft = "Caso tenhamos incidências simultâneas no Pulse e na WEQI, como priorizamos o atendimento? A WEQI."
    assert draft_guard.find_leaks(draft, segs, allowed=KENNEDY) == []


def test_citation_markers_always_flagged():
    leaks = draft_guard.find_leaks('Oi Kennedy.\n\n[4] Sobre "Concorrência": priorizar a WEQI.', [])
    assert leaks and leaks[0].startswith("[4] Sobre")


def test_parse_instruction_splits_citations_and_free_text():
    parsed = draft_guard.parse_instruction(PEDIDO)
    assert [c["n"] for c in parsed["citacoes"]] == [1, 2, 3, 4]
    assert parsed["citacoes"][3]["comentario"].startswith("Sobre a concorrência concordo")
    assert parsed["livre"].startswith("Continue a resposta")
    assert draft_guard.parse_instruction("mais curto") == {"citacoes": [], "livre": "mais curto"}


def test_expand_quote_restores_truncated_passage():
    full = draft_guard.expand_quote("2 - Concorrência de demandas: Caso tenhamos incidências simultâneas no Pulse e n…", [KENNEDY])
    assert full.endswith("como priorizamos o atendimento?")
    assert draft_guard.expand_quote("trecho que não existe…", [KENNEDY]) == "trecho que não existe…"


def test_endpoint_returns_copy_warning(monkeypatch):
    from fastapi.testclient import TestClient

    from app import main

    _fake(monkeypatch, [RUIM, RUIM])
    r = TestClient(main.app).post("/api/threads/k1/draft", json={"instruction": PEDIDO, "current_draft": RASCUNHO_1})
    assert r.status_code == 200
    data = r.json()
    assert data["draft"] == RUIM and data["alerta_copia"]["trechos"]


# saída real (gemini) antes do reforço: [2] e [3] voltaram como o texto da Kennedy, sem resposta
COLADO = (
    "Oi Kennedy, tudo bem?\n\nObrigado pelos pontos. Sobre as atividades do PCI: elas são feitas todos os "
    "meses ou foram feitas durante o processo de PSI?\n\n"
    "- Atividades de devops: evolução do ambiente pensando em Finops e custo dentro da AWS, com revisão mensal "
    "das reservas.\n"
    "- Atividades de Secops: controle e gestão de acesso ao ambiente CDE - governança de chaves e rotação de "
    "segredos.\n\n"
    "Sobre a concorrência de demandas: caso tenhamos incidências simultâneas no Pulse e na WEQI, priorizamos o "
    "atendimento da WEQI.\n\nAbs,\nLeo"
)


def test_pasted_sender_points_without_answer_are_detected():
    quotes = [draft_guard.expand_quote(c["trecho"], [KENNEDY]) for c in draft_guard.parse_instruction(PEDIDO)["citacoes"]]
    pasted = draft_guard.find_pasted_quotes(COLADO, quotes)
    assert len(pasted) == 2 and pasted[0].startswith("- Atividades de devops") and "Secops" in pasted[1]
    # responder o ponto reusando parte dele como contexto não conta
    assert draft_guard.find_pasted_quotes(BOM, quotes) == []


def test_pasted_points_trigger_retry_and_then_warning(monkeypatch):
    prompts = _fake(monkeypatch, [COLADO, COLADO])
    out = assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    assert len(prompts) == 2 and "Repetiu pontos do remetente sem responder" in prompts[1]
    assert out["alerta_copia"]["mensagem"].startswith("A IA pode ter colado pontos do e-mail original")
    assert len(out["alerta_copia"]["trechos"]) == 2


def test_prompt_demands_an_answer_for_every_point(monkeypatch):
    prompts = _fake(monkeypatch, [BOM])
    assistant.draft("k1", PEDIDO, current_draft=RASCUNHO_1)
    assert "O e-mail precisa responder CADA um destes pontos: [1], [2], [3], [4]." in prompts[0]


def test_light_rewording_of_content_comment_is_not_flagged():
    # saída real (gemini) depois do reforço: comentário que já falava com a Kennedy, só ajustado
    draft = ("Oi Kennedy,\n\nIsso é perfeito, exatamente o que o Claudeci já faz por aqui.\n\n"
             "Sobre a concorrência, concordo que é um gargalo, mas devemos priorizar a WEQI.\n\nAbs,\nLeo")
    assert draft_guard.find_leaks(draft, draft_guard.request_segments(PEDIDO), allowed=KENNEDY) == []
