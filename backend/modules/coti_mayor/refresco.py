"""
Actualizador en segundo plano de Coti Mayor.
Vuelve a leer la ficha (cronograma, documentos, datos) de las licitaciones cuya revisión ya venció
y completa las que el live todavía no leyó. Usa su propio navegador (independiente del live y de los postores).
"""
import logging
import os
import random
import time
from concurrent.futures import ThreadPoolExecutor

from playwright.sync_api import sync_playwright

from core.db import abrir_db
from modules.coti_mayor import postores as pst
from modules.coti_mayor.scraper_live import HEADLESS, args_navegador, config_proxy

logger = logging.getLogger("coti_mayor")

LOTE = int(os.getenv("MAYOR_REFRESCO_LOTE", "12"))          # licitaciones por navegador y por pasada
PARALELO = int(os.getenv("MAYOR_REFRESCO_PARALELO", "2"))   # navegadores del actualizador


def _pendientes(n: int):
    con = abrir_db()
    try:
        filas = con.execute(
               """SELECT ocid, nomenclatura, entidad, fecha_convocatoria FROM procesos_mayor
               WHERE nomenclatura IS NOT NULL
                 AND ( proxima_revision <= now()
                       OR (ficha_en IS NULL AND proxima_revision IS NULL
                           AND primera_vez < now() - interval '3 hours'
                           AND fecha_convocatoria > (now() AT TIME ZONE 'America/Lima') - interval '45 days') )
                 AND NOT EXISTS (SELECT 1 FROM procesos_mayor o
                                 WHERE o.nomenclatura = procesos_mayor.nomenclatura
                                   AND o.entidad = procesos_mayor.entidad
                                   AND o.fecha_convocatoria = procesos_mayor.fecha_convocatoria
                                   AND o.ocid <> procesos_mayor.ocid)
               ORDER BY (ficha_en IS NULL) DESC, proxima_revision ASC NULLS LAST, fecha_convocatoria DESC NULLS LAST
               LIMIT ?""", (n,)).fetchall()
        return [(r["ocid"], r["nomenclatura"], r["entidad"], r["fecha_convocatoria"]) for r in filas]
    finally:
        con.close()


def _fallo(ocid: str):
    """Reintento espaciado: 30 min, 1 h, 2 h, 4 h, 8 h... hasta 12 h."""
    con = abrir_db()
    try:
        con.execute(
            """UPDATE procesos_mayor
               SET fallos_ficha = fallos_ficha + 1,
                   proxima_revision = now() + (LEAST(0.5 * power(2, fallos_ficha), 12) * interval '1 hour')
               WHERE ocid = ?""", (ocid,))
        con.commit()
    finally:
        con.close()


def _refrescar_uno(page, ocid: str, nomenclatura: str, entidad, fecha):
    idx = pst._buscar_con_reintentos(page, None, nomenclatura, entidad, fecha)
    if idx is None:
        raise RuntimeError("no apareció en el buscador del SEACE")
    pst._entrar_ficha(page, idx)
    detalle, docs, crono = pst._leer_ficha(page)
    pst._guardar_ficha(ocid, detalle, docs, crono)


def _lote(items, indice: int):
    if not items:
        return
    time.sleep(indice * 3)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=HEADLESS, proxy=config_proxy(), args=args_navegador(indice))
            try:
                page = browser.new_page(accept_downloads=True, **({} if HEADLESS else {"no_viewport": True}))
                for ocid, nomen, entidad, fecha in items:
                    try:
                        _refrescar_uno(page, ocid, nomen, entidad, fecha)
                        logger.info("Refresco OK: %s", nomen)
                    except Exception as e:
                        logger.warning("Refresco falló (%s): %s", nomen, e)
                        try:
                            _fallo(ocid)
                        except Exception:
                            pass
                    time.sleep(random.uniform(1, 3))
            finally:
                browser.close()
    except Exception as e:
        logger.error("Lote de refresco falló: %s", e)


def bucle_refresco() -> None:
    time.sleep(120)
    while True:
        try:
            pend = _pendientes(LOTE * PARALELO)
            if not pend:
                time.sleep(300)
                continue
            logger.info("Refresco Coti Mayor: %s licitaciones por actualizar", len(pend))
            with ThreadPoolExecutor(max_workers=PARALELO, thread_name_prefix="refresco") as ex:
                futs = [ex.submit(_lote, pend[i::PARALELO], i) for i in range(PARALELO)]
                for f in futs:
                    f.result()
        except Exception as e:
            logger.error("Refresco Coti Mayor falló: %s", e)
        time.sleep(30)