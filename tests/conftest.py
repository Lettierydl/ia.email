import sys
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

# Os testes NUNCA podem abrir o banco real (data/radar.sqlite): importar
# app.main roda store.init() na hora, e o container Docker usa esse mesmo
# arquivo ao mesmo tempo -- foi assim que o banco corrompeu. Isso tem que
# acontecer antes de qualquer import de app.store.
from app import config  # noqa: E402

_tmp = Path(tempfile.mkdtemp(prefix="ia_email_tests_"))
config.DB_PATH = _tmp / "test.sqlite"
config.RAG_DB_PATH = _tmp / "rag-test.sqlite"
# Espelho dos aprendizados: nunca na Learning Base real.
config.LEARNED_NOTES_MD = _tmp / "aprendizados.md"
# Sem sync automático com o Gmail nos testes (o loop nunca pode rodar aqui).
config.SYNC_MINUTES = 0

# Token de acesso (app/auth.py): valor fixo de teste, setado DEPOIS de
# importar app.config (que carrega o .env real com override=True). O
# TestClient padrão já manda o header, pra os testes antigos de API não
# precisarem saber de auth; tests/test_auth.py usa o cliente cru.
import os  # noqa: E402

import fastapi.testclient  # noqa: E402
import starlette.testclient  # noqa: E402

TEST_TOKEN = "token-de-teste-nao-real"
os.environ["IA_EMAIL_API_TOKEN"] = TEST_TOKEN
RawTestClient = starlette.testclient.TestClient


class _AuthedTestClient(RawTestClient):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.headers["Authorization"] = f"Bearer {TEST_TOKEN}"


fastapi.testclient.TestClient = _AuthedTestClient
