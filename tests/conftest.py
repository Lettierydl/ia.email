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
