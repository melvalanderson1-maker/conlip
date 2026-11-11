import logging
import os
import sqlite3
import threading

from psycopg_pool import ConnectionPool

logger = logging.getLogger("db")

DATABASE_URL = os.getenv("DATABASE_URL", "postgresql://postgres:postgres@localhost:5432/coti")

COLS = ["id_contrato", "codigo", "anio", "objeto", "descripcion", "entidad", "fec_publica",
        "fec_ini_cot", "fec_fin_cot", "id_estado", "estado", "primera_vez", "ultima_verificacion",
        "estado_cambio_en", "relevante", "enriquecido", "detalle_json", "archivos_json", "raw_json"]

SCHEMA = """
CREATE TABLE IF NOT EXISTS contratos (
    id_contrato BIGINT PRIMARY KEY,
    codigo TEXT, anio INTEGER, objeto TEXT, descripcion TEXT, entidad TEXT,
    fec_publica TEXT, fec_ini_cot TEXT, fec_fin_cot TEXT,
    id_estado INTEGER, estado TEXT,
    primera_vez TEXT, ultima_verificacion TEXT, estado_cambio_en TEXT,
    relevante INTEGER DEFAULT 0,
    enriquecido INTEGER DEFAULT 0,
    detalle_json TEXT, archivos_json TEXT, raw_json TEXT
);
CREATE INDEX IF NOT EXISTS ix_estado ON contratos(id_estado);
CREATE INDEX IF NOT EXISTS ix_publica ON contratos(fec_publica DESC);
"""


class Fila(dict):
    """Se lee por nombre (r["codigo"]) o por posición (r[0])."""
    def __getitem__(self, k):
        if isinstance(k, int):
            return list(self.values())[k]
        return super().__getitem__(k)


def _fila_factory(cursor):
    # Sentencias sin resultado (CREATE TABLE, INSERT, UPDATE...) no tienen columnas
    if cursor.description is None:
        return lambda valores: valores
    cols = [c.name for c in cursor.description]
    return lambda valores: Fila(zip(cols, valores))


_pool = ConnectionPool(
    DATABASE_URL, min_size=2, max_size=20, open=True,
    kwargs={"autocommit": True, "row_factory": _fila_factory},
)


class Con:
    def __init__(self):
        self._c = _pool.getconn()

    def execute(self, sql, params=()):
        return self._c.execute(sql.replace("?", "%s"), params)

    def commit(self):
        pass  # autocommit

    def close(self):
        if self._c is not None:
            _pool.putconn(self._c)
            self._c = None


def _migrar_desde_sqlite():
    ruta = os.getenv("SEACE_DB", "seace.db")
    if not os.path.exists(ruta):
        return
    try:
        src = sqlite3.connect(ruta)
        try:
            filas = src.execute(f"SELECT {','.join(COLS)} FROM contratos").fetchall()
        finally:
            src.close()
        if not filas:
            return
        sql = (f"INSERT INTO contratos ({','.join(COLS)}) VALUES ({','.join(['%s'] * len(COLS))}) "
               "ON CONFLICT (id_contrato) DO NOTHING")
        with _pool.connection() as c:
            with c.cursor() as cur:
                for i in range(0, len(filas), 500):
                    cur.executemany(sql, filas[i:i + 500])
        logger.info(f"Migrados {len(filas)} contratos de SQLite a PostgreSQL")
    except Exception as e:
        logger.error(f"Migración desde SQLite falló: {e}")


_lock = threading.Lock()
_listo = False


def abrir_db() -> Con:
    global _listo
    with _lock:
        if not _listo:
            with _pool.connection() as c:
                c.execute(SCHEMA)
                n = c.execute("SELECT COUNT(*) AS n FROM contratos").fetchone()["n"]
            if n == 0:
                _migrar_desde_sqlite()
            _listo = True
    return Con()