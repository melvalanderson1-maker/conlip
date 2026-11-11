"""
seace_cliente.py  (v2)
- Guarda los contratos en SQLite (seace.db)
- Detecta vigentes nuevos
- Detecta cambios de estado SOLO cuando corresponde (por fecha de fin de cotización)
- Guarda la metadata de los archivos (NO descarga los PDF)
"""

import json
import os
import re
import time
import random

import logging
import threading
import unicodedata
import base64
from datetime import datetime, timedelta, timezone

from curl_cffi import requests as cffi_requests
from modules.coti_menor.seace_auth import sesion

logger = logging.getLogger("seace_cliente")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")

# ------------------------------------------------------------------
# CONFIG
# ------------------------------------------------------------------
BASE_SERVICIOS = "https://prod6.seace.gob.pe/v1/s8uit-services"
REFERER = "https://prod6.seace.gob.pe/buscador-publico/contrataciones"

RUTA_BUSCADOR = "buscadorpublico/contrataciones/buscador"
# Rutas con sesión iniciada. Tipo 1 = Anexo de la contratación, 2 = Oferta económica/formatos
RUTA_ARCHIVOS = "archivo/archivos/listar-archivos-contrato/{id_contrato}/{tipo}"
TIPOS_ARCHIVO = (1, 2)
RUTA_DETALLE = "contratacion/contrataciones/listar-completo?id_contrato={id}"

ESTADO_VIGENTE = 2
ESTADO_EVALUACION = 3
ESTADO_CULMINADO = 4

PAGE_SIZE = 20                       # no subir sin probar (si da 400, bájalo)


# Cada cuántos minutos se vuelve a consultar el estado de un contrato (según su estado actual)
RECHEQUEO_MIN = {ESTADO_VIGENTE: 30, ESTADO_EVALUACION: 12 * 60}
GRACIA_MIN = 5                       # minutos extra después de fecFinCotizacion antes de consultar

# Topes por ciclo (protegen la IP). Cada request ya espera 3-7 s.
MAX_VERIFICACIONES_POR_CICLO = 15
MAX_ENRIQUECER_POR_CICLO = 20

# Solo a los "relevantes" se les pide la lista de archivos. [] = todos.
# EDÍTALA con tus categorías. NO afecta qué contratos se guardan, solo a cuáles se piden archivos.
PALABRAS_INTERES = [
    "ALCOHOL", "DETERGENTE", "DESINFECTANTE", "ESCOBA", "ESCOBILLA", "PAPEL HIGIENICO",
    "PAPEL TOALLA", "JABON", "LAVAVAJILLA", "SUAVIZANTE", "LIMPIADOR", "LEJIA", "HIPOCLORITO",
    "TACHO", "MOPA", "TRAPEADOR", "BALDE", "TUBO", "PINTURA", "CEMENTO", "ARROZ", "AZUCAR",
    "ACEITE", "MATERIAL DE LIMPIEZA", "UTILES DE ASEO",
]

RECONCILIAR_CADA_HORAS = 2

FMT = "%Y-%m-%d %H:%M:%S"
PERU = timezone(timedelta(hours=-5))


def ahora_peru() -> datetime:
    # Hora de Perú aunque el servidor (Coolify) esté en UTC
    return datetime.now(PERU).replace(tzinfo=None)


def parse_fecha(s) -> str | None:
    # "20/10/2026 15:00:00" -> "2026-10-20 15:00:00"
    try:
        return datetime.strptime(s, "%d/%m/%Y %H:%M:%S").strftime(FMT)
    except Exception:
        return None


def normalizar(s: str) -> str:
    s = unicodedata.normalize("NFD", s or "")
    s = "".join(c for c in s if unicodedata.category(c) != "Mn")
    return re.sub(r"\s+", " ", s.upper()).strip()

def token_expira_en(auth: dict) -> float:
    """Segundos que le quedan al token Bearer (0 si no hay token)."""
    try:
        token = auth["authorization"].split(" ", 1)[1]
        payload = token.split(".")[1]
        payload += "=" * (-len(payload) % 4)
        return json.loads(base64.urlsafe_b64decode(payload))["exp"] - time.time()
    except Exception:
        return 0


def es_relevante(item: dict) -> int:
    if not PALABRAS_INTERES:
        return 1
    texto = normalizar(item.get("desObjetoContrato", ""))
    return int(any(p in texto for p in PALABRAS_INTERES))


class SesionRequerida(RuntimeError):
    """SEACE respondió 401: hay que iniciar sesión desde la plataforma."""

# ------------------------------------------------------------------
# Cliente HTTP (imita Chrome, pausas al azar, backoff)
# ------------------------------------------------------------------
class SeaceClient:
    def __init__(self, pausa_min: float = 3.0, pausa_max: float = 7.0):
        self.pausa_min = pausa_min
        self.pausa_max = pausa_max
        self._ultimo_request = 0.0
        self._lock = threading.Lock()
        self._auth = {}
        self._cookies = []
        self._ultimo_login = 0.0
        self._nueva_sesion()

    def _nueva_sesion(self):
        self.s = cffi_requests.Session(impersonate="chrome")
        self.s.headers.update({
            "accept": "application/json",
            "accept-language": "es-ES,es;q=0.9,en;q=0.8",
            "cache-control": "no-cache",
            "pragma": "no-cache",
            "referer": REFERER,
            "origin": "https://prod6.seace.gob.pe",
        })
        self._aplicar_auth()
        self._calentado = False

    def _aplicar_auth(self):
        if self._auth:
            self.s.headers.update(self._auth)
        for c in self._cookies:
            self.s.cookies.set(c["name"], c["value"], domain=c.get("domain", ""), path=c.get("path", "/"))

    def _sincronizar(self):
        """Toma el token del navegador de sesión; si no hay sesión válida, lo quita."""
        auth = sesion.obtener()
        if auth and token_expira_en(auth) > 0:
            if auth != self._auth:
                self._auth = auth
                self.s.headers.update(auth)
        elif self._auth:
            self._auth = {}
            try:
                del self.s.headers["authorization"]
            except Exception:
                pass

    def sesion_activa(self) -> bool:
        return sesion.estado()["activa"]

    def login(self, forzar: bool = False):
        """Solo se llama desde el botón de la plataforma. Devuelve (ok, error)."""
        ok, error = sesion.iniciar()
        self._sincronizar()
        return ok, error

    def _esperar(self, pmin=None, pmax=None):
        pausa = random.uniform(pmin or self.pausa_min, pmax or self.pausa_max)
        transcurrido = time.time() - self._ultimo_request
        if transcurrido < pausa:
            time.sleep(pausa - transcurrido)
        self._ultimo_request = time.time()

    def _calentar(self):
        try:
            self.s.get(REFERER, timeout=25)
            time.sleep(random.uniform(1.0, 2.5))
        except Exception as e:
            logger.warning(f"Calentamiento falló (se sigue igual): {e}")
        self._calentado = True

    def _pedir(self, ruta, params=None, intentos=5, pausa=None, headers=None):
        """Devuelve la respuesta cruda (200) o None si es 404."""
        with self._lock:
            if not self._calentado:
                self._calentar()
            url = f"{BASE_SERVICIOS}/{ruta}"

            for n in range(intentos):
                self._sincronizar()
                self._esperar(*(pausa or (None, None)))
                try:
                    resp = self.s.get(url, params=params, headers=headers, timeout=40)
                except Exception as e:
                    espera = 20 * (2 ** n) + random.uniform(0, 10)
                    logger.warning(f"Error de red ({e}). Reintento en {espera:.0f}s")
                    time.sleep(espera)
                    continue

                if resp.status_code == 200:
                    return resp
                if resp.status_code == 404:
                    return None
                if resp.status_code == 400:
                    raise ValueError(f"SEACE 400 ruta={ruta} params={params} body={resp.text[:300]}")

                if resp.status_code == 401:
                    raise SesionRequerida("SEACE respondió 401: inicia sesión desde la plataforma")

                if resp.status_code in (403, 429) or resp.status_code >= 500:
                    ra = resp.headers.get("Retry-After")
                    espera = (int(ra) + random.uniform(1, 5)) if ra and ra.isdigit() \
                        else 60 * (2 ** n) + random.uniform(0, 20)
                    logger.warning(f"SEACE {resp.status_code}. Espero {espera:.0f}s ({n + 1}/{intentos})")
                    if resp.status_code == 403:
                        self._nueva_sesion()
                        self._calentar()
                    time.sleep(espera)
                    continue
                resp.raise_for_status()
            raise RuntimeError(f"SEACE: agotados {intentos} intentos en {ruta}")

    def get_json(self, ruta, params=None):
        resp = self._pedir(ruta, params)
        return resp.json() if resp is not None else None

    def get_bytes(self, ruta):
        """Para el visor: pausa corta porque hay una persona esperando. Devuelve (bytes, content_type) o None."""
        resp = self._pedir(ruta, pausa=(0.5, 1.5), intentos=3, headers={"accept": "*/*"})
        if resp is None:
            return None
        return resp.content, resp.headers.get("content-type", "application/octet-stream")

    def buscar(self, anio, estado, page, page_size=PAGE_SIZE, palabra_clave=""):
        params = {"anio": anio, "palabra_clave": palabra_clave, "orden": 2,
                  "page": page, "page_size": page_size}
        if estado is not None:
            params["lista_estado_contrato"] = estado
        return self.get_json(RUTA_BUSCADOR, params)


def extraer_lista(data) -> list[dict]:
    if isinstance(data, list):
        return data
    if isinstance(data, dict):
        for k in ("data", "content", "items", "results", "lista", "contrataciones"):
            v = data.get(k)
            if isinstance(v, list):
                return v
            if isinstance(v, dict):
                interno = extraer_lista(v)
                if interno:
                    return interno
    return []


def listar_archivos(client, id_contrato) -> list[dict]:
    todos = []
    for tipo in TIPOS_ARCHIVO:
        todos += extraer_lista(client.get_json(RUTA_ARCHIVOS.format(id_contrato=id_contrato, tipo=tipo)))
    return todos


from core.db import abrir_db  # noqa: E402

def insertar_si_nuevo(con, it: dict) -> dict | None:
    """Si es nuevo: lo inserta y devuelve la fila.
    Si ya existe: actualiza fechas/descripcion/relevante si cambiaron y devuelve None."""
    fec_pub = it.get("fecPublica") or ""
    anio = int(fec_pub[6:10]) if len(fec_pub) >= 10 and fec_pub[6:10].isdigit() else ahora_peru().year
    fec_ini = parse_fecha(it.get("fecIniCotizacion"))
    fec_fin = parse_fecha(it.get("fecFinCotizacion"))
    relevante = es_relevante(it)

    cur = con.execute(
        """INSERT INTO contratos
           (id_contrato, codigo, anio, objeto, descripcion, entidad, fec_publica, fec_ini_cot,
            fec_fin_cot, id_estado, estado, primera_vez, relevante, raw_json)
             VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON CONFLICT (id_contrato) DO NOTHING""",
        (
            it["idContrato"], it.get("desContratacion"), anio, it.get("nomObjetoContrato"),
            it.get("desObjetoContrato"), it.get("nomEntidad"), parse_fecha(fec_pub),
            fec_ini, fec_fin,
            it.get("idEstadoContrato"), it.get("nomEstadoContrato"), ahora_peru().strftime(FMT),
            relevante, json.dumps(it, ensure_ascii=False),
        ),
    )
    if cur.rowcount == 0:
        # Ya existía: refrescar solo lo que puede cambiar (no toca id_estado)
        desc = it.get("desObjetoContrato")
        con.execute(
            """UPDATE contratos
               SET descripcion=?, fec_ini_cot=?, fec_fin_cot=?, relevante=?, raw_json=?
               WHERE id_contrato=?
                 AND (fec_ini_cot IS DISTINCT FROM ? OR fec_fin_cot IS DISTINCT FROM ?
                      OR descripcion IS DISTINCT FROM ? OR relevante IS DISTINCT FROM ?)""",
            (desc, fec_ini, fec_fin, relevante, json.dumps(it, ensure_ascii=False),
             it["idContrato"],
             fec_ini, fec_fin, desc, relevante),
        )
        return None
    return dict(con.execute("SELECT * FROM contratos WHERE id_contrato=?", (it["idContrato"],)).fetchone())

# ------------------------------------------------------------------
# Hooks: AQUÍ conectas con tu sistema
# ------------------------------------------------------------------
def procesar_nuevos(nuevos: list[dict]):
    for f in nuevos:
        logger.info(f"NUEVO VIGENTE {f['codigo']} | {f['entidad']} | {f['descripcion'][:90]} | cierra {f['fec_fin_cot']}")


def al_cambiar_estado(fila: dict, estado_anterior: str, estado_nuevo: str):
    logger.info(f"CAMBIO DE ESTADO {fila['codigo']}: {estado_anterior} -> {estado_nuevo}")


# ------------------------------------------------------------------
# 1) Vigentes
# ------------------------------------------------------------------
def descargar_vigentes(client, con, max_paginas=200):
    """Baja todos los vigentes del año. Devuelve (ids_vistos, filas_nuevas)."""
    anio = ahora_peru().year
    vistos, nuevos = set(), []
    for pagina in range(1, max_paginas + 1):
        registros = extraer_lista(client.buscar(anio, ESTADO_VIGENTE, pagina))
        if not registros:
            break
        for it in registros:
            vistos.add(it["idContrato"])
            fila = insertar_si_nuevo(con, it)
            if fila:
                nuevos.append(fila)
        con.commit()
        logger.info(f"Descarga vigentes: página {pagina}, vistos {len(vistos)}, nuevos {len(nuevos)}")
    return vistos, nuevos


def vigentes_nuevos(client, con, max_paginas=5) -> list[dict]:
    """Ciclo normal: pide página 1, 2... y se detiene al llegar a una página sin nada nuevo."""
    anio = ahora_peru().year
    nuevos = []
    for pagina in range(1, max_paginas + 1):
        registros = extraer_lista(client.buscar(anio, ESTADO_VIGENTE, pagina))
        if not registros:
            break
        nuevos_pag = 0
        for it in registros:
            fila = insertar_si_nuevo(con, it)
            if fila:
                nuevos.append(fila)
                nuevos_pag += 1
        con.commit()
        if nuevos_pag == 0:
            break
    return nuevos


# ------------------------------------------------------------------
# 2) Cambios de estado
# ------------------------------------------------------------------
def consultar_estado(client, f) -> tuple[int, str] | None:
    if RUTA_DETALLE:
        d = client.get_json(RUTA_DETALLE.format(id=f["id_contrato"]))
        p = (d or {}).get("uitContratoCompletoProjection") or {}
        if p.get("idEstadoContrato") is not None:
            return p["idEstadoContrato"], p.get("nomEstadoContrato")
        return None
    data = client.buscar(f["anio"], None, 1, palabra_clave=f["codigo"])
    for it in extraer_lista(data):
        if it.get("idContrato") == f["id_contrato"]:
            return it["idEstadoContrato"], it["nomEstadoContrato"]
    return None


def pendientes_de_verificar(con, max_n: int) -> list[dict]:
    ahora = ahora_peru()
    limite_vencido = (ahora - timedelta(minutes=GRACIA_MIN)).strftime(FMT)
    filas = con.execute(
        "SELECT * FROM contratos WHERE id_estado IN (?,?) "
        "ORDER BY COALESCE(ultima_verificacion,'') ASC, fec_fin_cot ASC",
        (ESTADO_VIGENTE, ESTADO_EVALUACION),
    ).fetchall()
    salida = []
    for f in filas:
        if f["id_estado"] == ESTADO_VIGENTE:
            if not f["fec_fin_cot"] or f["fec_fin_cot"] > limite_vencido:
                continue  # aún no vence: 0 requests
        corte = (ahora - timedelta(minutes=RECHEQUEO_MIN[f["id_estado"]])).strftime(FMT)
        if f["ultima_verificacion"] and f["ultima_verificacion"] > corte:
            continue
        salida.append(dict(f))
        if len(salida) >= max_n:
            break
    return salida


def verificar_filas(client, con, filas: list[dict]):
    for f in filas:
        try:
            res = consultar_estado(client, f)
        except RuntimeError as e:
            logger.error(f"Bloqueo/errores repetidos, corto el ciclo de verificación: {e}")
            break
        except Exception as e:
            logger.warning(f"No se pudo verificar {f['codigo']}: {e}")
            continue

        ahora = ahora_peru().strftime(FMT)
        if res is None:
            logger.warning(f"{f['codigo']}: no apareció en la consulta; se reintenta más tarde")
            con.execute("UPDATE contratos SET ultima_verificacion=? WHERE id_contrato=?", (ahora, f["id_contrato"]))
        else:
            id_est, nom = res
            if id_est != f["id_estado"]:
                con.execute(
                    "UPDATE contratos SET id_estado=?, estado=?, estado_cambio_en=?, ultima_verificacion=? "
                    "WHERE id_contrato=?",
                    (id_est, nom, ahora, ahora, f["id_contrato"]),
                )
                al_cambiar_estado(f, f["estado"], nom)
            else:
                con.execute("UPDATE contratos SET ultima_verificacion=? WHERE id_contrato=?", (ahora, f["id_contrato"]))
        con.commit()


def verificar_pendientes(client, con, max_n=MAX_VERIFICACIONES_POR_CICLO):
    verificar_filas(client, con, pendientes_de_verificar(con, max_n))


# ------------------------------------------------------------------
# 3) Archivos (solo metadata) y detalle
# ------------------------------------------------------------------
def enriquecer_pendientes(client, con, max_n=MAX_ENRIQUECER_POR_CICLO):
    filas = con.execute(
        "SELECT * FROM contratos WHERE relevante=1 AND enriquecido=0 AND id_estado=? "
        "ORDER BY fec_fin_cot ASC LIMIT ?",
        (ESTADO_VIGENTE, max_n),
    ).fetchall()
    for f in filas:
        try:
            archivos = listar_archivos(client, f["id_contrato"])
            detalle = None
            if RUTA_DETALLE:
                detalle = client.get_json(RUTA_DETALLE.format(id=f["id_contrato"]))
        except RuntimeError as e:
            logger.error(f"Bloqueo/errores repetidos, corto el enriquecimiento: {e}")
            break
        except Exception as e:
            logger.warning(f"No se pudo enriquecer {f['codigo']}: {e}")
            continue
        con.execute(
            "UPDATE contratos SET archivos_json=?, detalle_json=?, enriquecido=1 WHERE id_contrato=?",
            (json.dumps(archivos, ensure_ascii=False),
             json.dumps(detalle, ensure_ascii=False) if detalle else None,
             f["id_contrato"]),
        )
        con.commit()
        logger.info(f"Enriquecido {f['codigo']}: {len(archivos)} archivo(s)")


# ------------------------------------------------------------------
# 4) Reconciliación diaria
# ------------------------------------------------------------------
def reconciliar(client, con):
    logger.info("Reconciliación diaria: bajando todos los vigentes...")
    vistos, nuevos = descargar_vigentes(client, con)
    if nuevos:
        procesar_nuevos(nuevos)
    filas = con.execute("SELECT * FROM contratos WHERE id_estado=?", (ESTADO_VIGENTE,)).fetchall()
    desaparecidos = [dict(f) for f in filas if f["id_contrato"] not in vistos]
    logger.info(f"Reconciliación: {len(desaparecidos)} vigentes de la base ya no aparecen; se verifican")
    verificar_filas(client, con, desaparecidos[:60])


# ------------------------------------------------------------------
# MAIN
# ------------------------------------------------------------------
def ciclo(client, con):
    nuevos = vigentes_nuevos(client, con)
    if nuevos:
        procesar_nuevos(nuevos)
    else:
        logger.info("Sin vigentes nuevos")
    if client.sesion_activa():
        verificar_pendientes(client, con)
        enriquecer_pendientes(client, con)
    else:
        logger.info("Sin sesión SEACE: se omiten verificación y enriquecimiento hasta que alguien inicie sesión")


if __name__ == "__main__":
    cliente = SeaceClient()
    db = abrir_db()

    if db.execute("SELECT COUNT(*) FROM contratos").fetchone()[0] == 0:
        logger.info("Base vacía: carga inicial de vigentes (tarda ~10 min)...")
        _, inicial = descargar_vigentes(cliente, db)
        logger.info(f"Carga inicial lista: {len(inicial)} registros")

    ultima_reconciliacion = time.time()

    while True:
        try:
            ciclo(cliente, db)
            if time.time() - ultima_reconciliacion > RECONCILIAR_CADA_HORAS * 3600:
                reconciliar(cliente, db)
                ultima_reconciliacion = time.time()
        except Exception as e:
            logger.error(f"Ciclo falló: {e}")

        time.sleep(random.uniform(10 * 60, 15 * 60))