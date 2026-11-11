import random
import time

from core.db import abrir_db
from modules.coti_menor import seace_cliente as sc
from modules.coti_menor.instancia import cliente


def bucle() -> None:
    db = abrir_db()
    if db.execute("SELECT COUNT(*) FROM contratos").fetchone()[0] == 0:
        sc.logger.info("Base vacía: carga inicial...")
        sc.descargar_vigentes(cliente, db)
    ultima = time.time()
    while True:
        try:
            sc.ciclo(cliente, db)
            if time.time() - ultima > sc.RECONCILIAR_CADA_HORAS * 3600:
                sc.reconciliar(cliente, db)
                ultima = time.time()
        except Exception as e:
            sc.logger.error(f"Ciclo falló: {e}")
        time.sleep(random.uniform(10 * 60, 15 * 60))