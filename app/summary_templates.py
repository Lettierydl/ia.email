from __future__ import annotations

# Modelos de apresentação do resumo. O que muda de um pro outro é só o
# FORMATO do campo "resumo"; as regras de classificação (so_copia,
# nota_captura, eh_propaganda) valem pra todos e ficam em _FLAGS_RULES.

DEFAULT_KEY = "padrao"

_BASE = """Você resume e-mails para Leo (TI/Confrapag). Português do Brasil.
Nunca copie o e-mail. Nunca cole URL do Gmail (google.com/url).
Se faltar evidência, escreva "Não identificado". Sem tom alarmista.
"""

_FLAGS_RULES = """
Marque so_copia=true quando Leo está apenas em cópia/FYI e o e-mail não pede
nada dele: atas de reunião distribuídas em massa, avisos de status entre
outras pessoas, threads onde a decisão já foi resolvida por terceiros, etc.
so_copia=true mesmo que o assunto pareça importante, desde que não haja
pedido/decisão direta a Leo. Nesse caso acao_leo deve ser false também.

Preencha nota_captura APENAS quando o e-mail tiver um fato durável que valha
guardar num arquivo de referência pessoal do Leo (uma decisão tomada, uma
regra/política definida, um número ou acordo que vai ser consultado depois).
Não preencha para chamados pontuais, cobranças rotineiras ou "ainda em
aberto". Se preencher, escreva 1-2 linhas objetivas, estilo nota de
referência (fato + data + quem decidiu), sem floreio. Deixe "" se não houver
nada que valha a pena. NUNCA coloque em nota_captura senha, token, chave de
API, credencial de acesso ou dado de login, mesmo que o e-mail os traga:
nesse caso deixe "".

Marque eh_propaganda=true para e-mail comercial/institucional de terceiros
sem relação de trabalho direta com Leo: convite de webinar, newsletter,
divulgação de produto/parceria, prospecção comercial (ex.: fornecedor
oferecendo serviço). NÃO marque para comunicação interna da Confrapag/Pulse/
Stalopay nem para threads de trabalho com clientes, parceiros ou fornecedores
já em relação ativa (mesmo que peça pra "conhecer uma solução").
"""

TEMPLATES: dict[str, dict] = {
    "padrao": {
        "name": "Padrão",
        "description": "Pedido, fatos, o que fazer e ruído. Completo e fácil de varrer.",
        "headers": ["Pedido:", "Fatos:", "Decisão/ação de Leo:", "Ruído:"],
        "format": (
            "Formato obrigatório do campo resumo, em texto puro:\n\n"
            "Pedido: uma linha com o que o remetente quer de Leo.\n"
            "Fatos:\n- 3 a 6 bullets com números, prazos, sistemas e nomes citados\n"
            "Decisão/ação de Leo:\n- o que ele precisa validar, responder ou fazer\n"
            'Ruído: uma linha se houver (cópia, marketing, aceite de agenda) ou "nenhum".'
        ),
        "sample": (
            "Pedido: Paulo pede validação técnica se a Confrapag pode ser EC de operação.\n"
            "Fatos:\n- Comissão de R$ 9.813,07 em 2026\n- Pede 4 checagens: path_percent, papéis, conta interna, esforço\n"
            "Decisão/ação de Leo:\n- Confirmar se a comissão foi combinada\n"
            "Ruído: nenhum."
        ),
    },
    "curto": {
        "name": "Curto",
        "description": "Três linhas: quem pede, o ponto-chave e o que sobra pra você.",
        "headers": ["Quem pede:", "Ponto-chave:", "Pra você:"],
        "format": (
            "Formato obrigatório do campo resumo, em texto puro, NO MÁXIMO 3 linhas:\n"
            "Quem pede: quem escreveu por último e o que quer, numa frase.\n"
            "Ponto-chave: o fato, número ou prazo mais importante.\n"
            'Pra você: o que o Leo precisa fazer, ou "Nada a fazer".'
        ),
        "sample": (
            "Quem pede: Paulo quer validação técnica da Confrapag como EC de operação.\n"
            "Ponto-chave: R$ 9.813,07 de comissão em 2026 e 4 checagens pendentes.\n"
            "Pra você: confirmar se a comissão foi combinada."
        ),
    },
    "pessoa": {
        "name": "Foco em quem fala",
        "description": "Cada pessoa da conversa, o que ela defende e em que tom. Bom para threads longas.",
        "headers": ["Pessoas:", "Pra você:"],
        "format": (
            "Formato obrigatório do campo resumo, em texto puro, organizado por PESSOA:\n"
            "Pessoas:\n"
            "- Nome (papel, se souber): o que pede ou defende, o tom (neutro, cobrando, preocupado, "
            "resolvendo...) e se espera algo do Leo. Uma linha por pessoa, a mais recente primeiro; "
            "no máximo 5 pessoas.\n"
            "Pra você: uma linha com o que sobra pro Leo, ou \"Nada a fazer\"."
        ),
        "sample": (
            "Pessoas:\n- Paulo (TI): quer validação de 4 pontos, tom objetivo; espera resposta sua.\n"
            "- Anderson (Financeiro): preocupado com a comissão de R$ 9.813,07; só informa.\n"
            "Pra você: confirmar se a comissão foi combinada."
        ),
    },
    "acao": {
        "name": "Só o que preciso fazer",
        "description": "Começa pela ação, com prazo e motivo. Ignora o resto.",
        "headers": ["Ação:", "Prazo:", "Por quê:", "Contexto:"],
        "format": (
            "Formato obrigatório do campo resumo, em texto puro:\n"
            'Ação: o que o Leo precisa fazer (ou "Nenhuma ação sua").\n'
            'Prazo: quando, se o e-mail disser; senão "Sem prazo informado".\n'
            "Por quê: o motivo, numa linha.\n"
            "Contexto: no máximo 2 linhas do essencial para decidir."
        ),
        "sample": (
            "Ação: confirmar se a comissão de operação foi combinada.\n"
            "Prazo: sem prazo informado.\n"
            "Por quê: Paulo precisa travar a regra de comissão zero.\n"
            "Contexto: Confrapag está como EC/LA e gerou R$ 9.813,07 em 2026."
        ),
    },
    "cronologia": {
        "name": "Linha do tempo",
        "description": "Quem disse o quê e quando, até a situação de agora.",
        "headers": ["Situação atual:", "Pra você:"],
        "format": (
            "Formato obrigatório do campo resumo, em texto puro:\n"
            "Uma linha por mensagem relevante, em ordem cronológica: 'DD/MM · Nome: o que disse ou decidiu'. "
            "No máximo 7 linhas (junte mensagens triviais).\n"
            "Situação atual: onde a conversa está agora, numa linha.\n"
            'Pra você: o que sobra pro Leo, ou "Nada a fazer".'
        ),
        "sample": (
            "01/09 · Paulo: pede validação técnica de 4 pontos.\n"
            "02/09 · Anderson: informa a comissão de R$ 9.813,07.\n"
            "Situação atual: aguardando a sua confirmação sobre a comissão.\n"
            "Pra você: confirmar se a comissão foi combinada."
        ),
    },
}


def get(key: str | None) -> dict:
    return TEMPLATES.get(key or DEFAULT_KEY) or TEMPLATES[DEFAULT_KEY]


def all_headers() -> list[str]:
    seen: list[str] = []
    for t in TEMPLATES.values():
        for h in t["headers"]:
            if h not in seen:
                seen.append(h)
    return seen


def build_system(settings: dict) -> str:
    template = get(settings.get("summary_template"))
    custom = (settings.get("summary_custom") or "").strip()
    parts = [_BASE, template["format"], _FLAGS_RULES]
    if custom:
        parts.append(
            "Instrução extra do Leo para o resumo (siga sempre, sem quebrar o formato acima nem as "
            f"regras de classificação):\n{custom}"
        )
    return "\n".join(parts)


def json_spec() -> str:
    return (
        '{"resumo":"<texto no formato pedido, com \\n entre as linhas>",'
        '"acao_leo":true,"sugestao":"","so_copia":false,"nota_captura":"","eh_propaganda":false}'
    )


def example(settings: dict) -> str:
    template = get(settings.get("summary_template"))
    return f"Exemplo de resumo bom neste formato:\n{template['sample']}"


def is_default(settings: dict) -> bool:
    return (settings.get("summary_template") or DEFAULT_KEY) == DEFAULT_KEY
