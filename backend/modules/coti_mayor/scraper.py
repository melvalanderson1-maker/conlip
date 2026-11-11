import logging
import random
import time
from datetime import datetime

from modules.coti_mayor.scraper_live import PERU, ejecutar_ciclo
from modules.coti_mayor.sync_api import sincronizar

logger = logging.getLogger("coti_mayor")


def bucle() -> None:
    time.sleep(60)  # deja que el backend termine de arrancar
    while True:
        try:
            anio = str(datetime.now(PERU).year)
            logger.info("Ciclo Coti Mayor: año %s", anio)
            ejecutar_ciclo(anio)
        except Exception as e:
            logger.error(f"Ciclo Coti Mayor falló: {e}")
        time.sleep(random.uniform(20 * 60, 30 * 60))


def bucle_sync() -> None:
    time.sleep(15)
    while True:
        try:
            sincronizar()
        except Exception as e:
            logger.error(f"Sync OCDS Coti Mayor falló: {e}")
        time.sleep(random.uniform(55 * 60, 65 * 60))