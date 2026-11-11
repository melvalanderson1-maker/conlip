"""
Postores y ofertas de un proceso (SEACE > Ficha > Ver Ofertas Presentadas).
Se ejecuta bajo demanda, con UN solo navegador a la vez y sin guardar archivos en disco.
"""
import json
import logging
import re
import threading
import time
from datetime import datetime

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

from core.db import abrir_db
from modules.coti_mayor.scraper_live import (
    PERU, TIMEOUT_MS, URL_BUSCADOR, activar_pestana_buscador, calc_proxima_revision, config_proxy,
    calcular_cambios, _cargar_json,
    extraer_cronograma_ficha, extraer_documentos_ficha, extraer_filas_tabla, leer_campo_ficha,
    leer_descripcion_completa, normalizar, obtener_contenedor_tabla,
    seleccionar_por_id_estable,
)

logger = logging.getLogger("coti_mayor")

_NAVEGADOR = threading.Lock()   # un solo navegador de postores a la vez
_GUARDA = threading.Lock()
_EN_PROCESO: set[str] = set()

CODIGOS_TIPO_BASE = {
    "LP": "licitacion publica", "CP": "concurso publico", "AS": "adjudicacion simplificada",
    "SIE": "subasta inversa electronica", "CD": "contratacion directa", "CM": "comparacion de precios",
    "SD": "seleccion de consultores individuales",
}
CODIGOS_TIPO_MOD = {"ABR": "abreviada"}


# ---------------------------------------------------------------- estado en base
def _marcar(ocid, estado, paso=None, error=None, total=None, actual=None):
    con = abrir_db()
    try:
        con.execute(
            """INSERT INTO mayor_postores_estado
                 (ocid, estado, paso, error_msg, total_postores, postor_actual, actualizado_en)
               VALUES (?,?,?,?,?,?, now())
               ON CONFLICT (ocid) DO UPDATE SET
                 estado = EXCLUDED.estado, paso = EXCLUDED.paso, error_msg = EXCLUDED.error_msg,
                 total_postores = COALESCE(EXCLUDED.total_postores, mayor_postores_estado.total_postores),
                 postor_actual = COALESCE(EXCLUDED.postor_actual, mayor_postores_estado.postor_actual),
                 actualizado_en = now()""",
            (ocid, estado, paso, error, total, actual),
        )
        con.commit()
    finally:
        con.close()


def _leer_estado(ocid):
    con = abrir_db()
    try:
        r = con.execute(
            """SELECT estado, EXTRACT(EPOCH FROM (now() - actualizado_en)) / 60.0 AS edad
               FROM mayor_postores_estado WHERE ocid = ?""", (ocid,)).fetchone()
    finally:
        con.close()
    return (r["estado"], float(r["edad"] or 0)) if r else None


def _lista(valor):
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except ValueError:
            return []
    return valor or []


def obtener(ocid: str) -> dict:
    con = abrir_db()
    try:
        e = con.execute(
            """SELECT estado, paso, error_msg, total_postores, postor_actual, actualizado_en
               FROM mayor_postores_estado WHERE ocid = ?""", (ocid,)).fetchone()
        filas = con.execute(
            """SELECT id, orden, ruc, razon_social, consorcio, tipo_proveedor, estado_propuesta,
                      estado_registro, mype, monto_total, items, documentos
               FROM mayor_postores WHERE ocid = ?
               ORDER BY monto_total ASC NULLS LAST, orden""", (ocid,)).fetchall()
    finally:
        con.close()
    postores = []
    for f in filas:
        d = dict(f)
        d["items"] = _lista(d.get("items"))
        d["documentos"] = [
            {**{k: v for k, v in x.items() if k not in ("url_documento", "via")},
             "visible": bool(x.get("url_documento"))}
            for x in _lista(d.get("documentos"))
        ]
        postores.append(d)
    if not e:
        return {"ocid": ocid, "estado": "pendiente", "paso": None, "error": None,
                "total_postores": None, "postor_actual": None, "actualizado_en": None, "postores": postores}
    return {"ocid": ocid, "estado": e["estado"], "paso": e["paso"], "error": e["error_msg"],
            "total_postores": e["total_postores"], "postor_actual": e["postor_actual"],
            "actualizado_en": str(e["actualizado_en"]) if e["actualizado_en"] else None,
            "postores": postores}


def disparar(ocid: str, nomenclatura: str, forzar: bool = False, ficha_ok: bool = True, 
             entidad: str | None = None, fecha=None) -> dict:
    with _GUARDA:
        if ocid in _EN_PROCESO:
            return obtener(ocid)
        e = _leer_estado(ocid)
        if e and not forzar:
            estado, edad = e
            if estado == "listo" and ficha_ok:
                return obtener(ocid)
            if estado == "ficha" and ficha_ok and edad < 60:
                return obtener(ocid)
            if estado == "sin_ofertas" and ficha_ok and edad < 360:
                return obtener(ocid)
            if estado in ("listo", "ficha", "error", "sin_ofertas") and edad < 15:
                return obtener(ocid)   # evita reintentos en bucle
        _EN_PROCESO.add(ocid)
    _marcar(ocid, "en_cola", paso="En cola…")
    threading.Thread(target=_trabajo, args=(ocid, nomenclatura), daemon=True, name="postores-mayor").start()
    return obtener(ocid)


def _trabajo(ocid, nomenclatura, entidad=None, fecha=None):
    try:
        with _NAVEGADOR:
            _procesar(ocid, nomenclatura, entidad, fecha)
    except Exception as e:
        logger.error("Postores %s falló: %s", ocid, e)
        _marcar(ocid, "error", error=str(e)[:300])
    finally:
        with _GUARDA:
            _EN_PROCESO.discard(ocid)


# ---------------------------------------------------------------- buscador avanzado (por nomenclatura)
def _idle(page):
    try:
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    except Exception:
        pass


def _anio_de(nomenclatura, fecha):
    m = re.search(r"(?<!\d)(20\d{2})(?!\d)", nomenclatura or "")
    if m:
        return m.group(1)
    if fecha:
        return str(fecha.year)
    raise ValueError(f"No pude deducir el año de '{nomenclatura}'")


def _filtrar_por_nomenclatura(page, nomenclatura, anio):
    """Año de la convocatoria + Sigla Nomenclatura (Búsqueda Avanzada) y clic en Buscar."""
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))
    _idle(page)
    campo = page.locator("input[id$=':siglasEntidad']").first
    campo.wait_for(state="attached", timeout=TIMEOUT_MS)
    if not campo.is_visible():  # Búsqueda Avanzada plegada: se despliega
        page.locator("legend.ui-fieldset-legend", has_text="Búsqueda Avanzada").first.click()
        page.wait_for_timeout(600)
    campo.click()
    campo.fill(nomenclatura)
    try:
        campo.press("Tab")
    except Exception:
        pass
    if campo.input_value().strip() != nomenclatura.strip():
        raise RuntimeError("El campo Sigla Nomenclatura no tomó el valor")
    btn = page.locator("button[id$=':btnBuscarSelToken']")
    btn.wait_for(state="visible", timeout=TIMEOUT_MS)
    btn.click()
    page.wait_for_timeout(2500)
    _idle(page)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)


def _minuto(dt):
    return dt.replace(second=0, microsecond=0) if dt else None


def _elegir_fila(page, nomenclatura, entidad, fecha, anio, max_paginas=10):
    """Devuelve el índice de la fila (en la página actual) que coincide en nomenclatura + entidad + fecha.
    Si hay varias candidatas y ninguna coincide en fecha, NO adivina: devuelve None."""
    obj_n, obj_e, obj_f = normalizar(nomenclatura), normalizar(entidad or ""), _minuto(fecha)
    candidatas = []   # (pagina, idx, fila)
    pagina = 1
    while True:
        cont = obtener_contenedor_tabla(page)
        for idx, f in enumerate(extraer_filas_tabla(cont, "", str(anio))):
            if normalizar(f["nomenclatura"]) != obj_n:
                continue
            if obj_e and normalizar(f["entidad"]) != obj_e:
                continue
            if obj_f and _minuto(f["fecha_convocatoria"]) == obj_f:
                return idx                       # coincidencia exacta: está en la página actual
            candidatas.append((pagina, idx, f))
        cont = obtener_contenedor_tabla(page)
        nxt = cont.locator("span.ui-paginator-next, a.ui-paginator-next")
        if (pagina >= max_paginas or nxt.count() == 0
                or "ui-state-disabled" in (nxt.first.get_attribute("class") or "")):
            break
        nxt.first.click()
        page.wait_for_timeout(900)
        _idle(page)
        pagina += 1
    if len(candidatas) == 1 and candidatas[0][0] == pagina:
        logger.warning("Postores: solo hay 1 fila para %s pero su fecha no coincide con la guardada", nomenclatura)
        return candidatas[0][1]
    if candidatas:
        logger.warning("Postores: %s filas para %s | %s y ninguna coincide con la fecha %s",
                       len(candidatas), nomenclatura, entidad, fecha)
    return None


def _buscar_con_reintentos(page, ocid, nomenclatura, entidad, fecha, max_intentos=3):
    anio = _anio_de(nomenclatura, fecha)
    ultimo = None
    for intento in range(1, max_intentos + 1):
        if intento > 1 and ocid:
            _marcar(ocid, "en_progreso", paso=f"Reintentando la búsqueda ({intento}/{max_intentos})…")
        try:
            page.goto(URL_BUSCADOR, timeout=60_000, wait_until="domcontentloaded")
            _idle(page)
            if intento > 1:
                page.wait_for_timeout(1500)
            activar_pestana_buscador(page)
            _filtrar_por_nomenclatura(page, nomenclatura, anio)
            idx = _elegir_fila(page, nomenclatura, entidad, fecha, anio)
            if idx is not None:
                return idx
        except Exception as e:
            ultimo = e
            logger.warning("Postores %s: intento %s falló: %s", ocid, intento, e)
    if ultimo:
        raise ultimo
    return None


# ---------------------------------------------------------------- ficha y ofertas
def _entrar_ficha(page, idx):
    cont = obtener_contenedor_tabla(page)
    fila = cont.locator("tbody[id$=':dtProcesos_data'] > tr").nth(idx)
    boton = fila.locator("img[id*='grafichaSel']").first
    if boton.count() == 0:
        raise RuntimeError("No encontré el ícono de la ficha de selección")
    boton.scroll_into_view_if_needed()
    try:
        with page.expect_navigation(timeout=8000):
            boton.click()
    except PWTimeout:
        pass
    _idle(page)
    page.locator("[id$=':pnlContenedorGral']").first.wait_for(state="visible", timeout=TIMEOUT_MS)

def _enlace_ofertas(page):
    return page.locator("xpath=//a[contains(normalize-space(.), 'Ofertas Presentadas')]")


def _hay_ofertas(page, espera_ms: int = 12_000) -> bool:
    """El enlace se pinta por AJAX: se espera a que aparezca en el DOM (aunque esté en un panel plegado)."""
    limite = time.monotonic() + espera_ms / 1000
    while True:
        try:
            if _enlace_ofertas(page).count() > 0:
                return True
        except Exception:
            pass
        if time.monotonic() >= limite:
            break
        page.wait_for_timeout(500)
    try:
        textos = page.evaluate(
            "() => Array.from(document.querySelectorAll('a')).map(a => (a.innerText || '').trim())"
            ".filter(t => t).slice(0, 40)")
        logger.warning("Postores: no apareció 'Ver Ofertas Presentadas'. Enlaces de la ficha: %s | url=%s",
                       textos, page.url)
    except Exception:
        pass
    return False


def _entrar_ofertas(page):
    e = _enlace_ofertas(page).first
    try:
        e.scroll_into_view_if_needed(timeout=3000)
    except Exception:
        pass
    try:
        with page.expect_navigation(timeout=10_000):
            if e.is_visible():
                e.click()
            else:
                e.evaluate("el => el.click()")   # enlace en panel plegado: se dispara por JS
    except PWTimeout:
        pass
    _idle(page)

def _contar_postores(page) -> int:
    tabla = page.locator("div[id$=':dtListaPostores']").first
    tabla.wait_for(state="visible", timeout=TIMEOUT_MS)
    return tabla.locator("tbody[id$=':dtListaPostores_data'] > tr").count()


def _entrar_detalle(page, i):
    tabla = page.locator("div[id$=':dtListaPostores']").first
    tabla.wait_for(state="visible", timeout=TIMEOUT_MS)
    fila = tabla.locator("tbody[id$=':dtListaPostores_data'] > tr").nth(i)
    enlace = fila.locator("a.ui-commandlink").first
    enlace.wait_for(state="visible", timeout=TIMEOUT_MS)
    enlace.scroll_into_view_if_needed()
    try:
        with page.expect_navigation(timeout=TIMEOUT_MS, wait_until="load"):
            enlace.click()
    except PWTimeout:
        pass
    _idle(page)
    try:
        page.locator(
            "xpath=//td[normalize-space(text())='RUC/Código' or normalize-space(text())='Nombre o Razón Social']"
        ).first.wait_for(state="visible", timeout=TIMEOUT_MS)
    except PWTimeout:
        logger.warning("Postor %s: no aparecieron los datos tras esperar", i + 1)


def _volver(page):
    try:
        page.go_back(wait_until="domcontentloaded", timeout=TIMEOUT_MS)
    except Exception:
        page.wait_for_timeout(1000)
        try:
            page.go_back(wait_until="domcontentloaded", timeout=TIMEOUT_MS)
        except Exception:
            _entrar_ofertas(page)
            return
    try:
        page.locator("div[id$=':dtListaPostores']").first.wait_for(state="visible", timeout=TIMEOUT_MS)
    except PWTimeout:
        pass


def _campo_td(page, etiqueta):
    td = page.locator(f"xpath=//td[normalize-space(text())='{etiqueta}']").first
    if td.count() == 0:
        return None
    try:
        return td.locator("xpath=following-sibling::td[1]").first.inner_text().strip() or None
    except Exception:
        return None


def _datos_postor(page):
    return {
        "tipo_proveedor": _campo_td(page, "Tipo de Proveedor"),
        "ruc": _campo_td(page, "RUC/Código"),
        "consorcio": _campo_td(page, "Consorcio"),
        "razon_social": _campo_td(page, "Nombre o Razón Social"),
        "estado_registro": _campo_td(page, "Estado de registro"),
        "estado_propuesta": _campo_td(page, "Estado de la propuesta"),
        "mype": _campo_td(page, "MYPE"),
    }


def _items_postor(page):
    tabla = page.locator("div[id$=':dtListadoItems']").first
    if tabla.count() == 0:
        return []
    filas = tabla.locator("tbody[id$=':dtListadoItems_data'] > tr")
    items = []
    for i in range(filas.count()):
        tds = filas.nth(i).locator("td")
        if tds.count() < 6:
            continue
        try:
            items.append({
                "nro": tds.nth(0).inner_text().strip(),
                "descripcion": tds.nth(1).inner_text().strip(),
                "cantidad_solicitada": tds.nth(2).inner_text().strip(),
                "vr_ve_cuantia": tds.nth(3).inner_text().strip(),
                "cantidad_ofertada": tds.nth(4).inner_text().strip(),
                "monto_ofertado": tds.nth(5).inner_text().strip(),
            })
        except Exception:
            continue
    return items


def _url_enlace(page, enlace):
    """(url, via) del archivo, SIN guardarlo: enlace directo o URL capturada al disparar la descarga (se cancela)."""
    try:
        href = enlace.get_attribute("href")
        if href and not href.strip().lower().startswith(("javascript:", "#", "blob:")):
            return page.evaluate("(u) => new URL(u, location.href).href", href), "href"
    except Exception:
        pass
    try:
        with page.expect_download(timeout=6000) as info:
            enlace.click()
        d = info.value
        url = d.url
        try:
            d.cancel()
        except Exception:
            pass
        if url and not url.lower().startswith("blob:"):
            return url, "click"
    except Exception:
        pass
    return None, None


def _docs_postor(page):
    tabla = page.locator("div[id$=':dtListaArchivosOfertas']").first
    if tabla.count() == 0:
        return []
    filas = tabla.locator("tbody[id$=':dtListaArchivosOfertas_data'] > tr")
    docs = []
    for i in range(filas.count()):
        fila = filas.nth(i)
        tds = fila.locator("td")
        if tds.count() < 2:
            continue
        try:
            nombre = tds.nth(1).inner_text().strip()
            enlace = tds.last.locator("a.ui-commandlink").last
            url, via = _url_enlace(page, enlace)
            m = re.search(r"\.([A-Za-z0-9]{2,5})$", nombre)
            docs.append({"nombre": nombre, "nombre_archivo": nombre,
                         "formato": m.group(1).lower() if m else None,
                         "url_documento": url, "via": via})
        except Exception as e:
            logger.warning("Documento de postor ilegible: %s", e)
    return docs


def _num(t) -> float:
    try:
        return float(str(t or "0").replace(",", "").strip() or 0)
    except ValueError:
        return 0.0

def _leer_ficha(page):
    """Lee la ficha ya abierta: datos, documentos (con enlace) y cronograma."""
    detalle = {
        "tipo_compra_seleccion": leer_campo_ficha(page, "Tipo Compra o Selección"),
        "normativa_aplicable": leer_campo_ficha(page, "Normativa Aplicable"),
        "entidad_convocante": leer_campo_ficha(page, "Entidad Convocante"),
        "direccion_legal": leer_campo_ficha(page, "Direccion Legal"),
        "pagina_web": leer_campo_ficha(page, "Pagina Web"),
        "telefono_entidad": leer_campo_ficha(page, "Télefono de la Entidad"),
        "monto_derecho_participacion": leer_campo_ficha(page, "Monto del Derecho de Participacion"),
        "fecha_hora_publicacion_detalle": leer_campo_ficha(page, "Fecha y Hora Publicación"),
        "descripcion_objeto_completa": leer_descripcion_completa(page),
    }
    return detalle, extraer_documentos_ficha(page), extraer_cronograma_ficha(page)


def _guardar_ficha(ocid, detalle, docs, crono):
    prox = calc_proxima_revision(crono)
    con = abrir_db()
    try:
        previo = con.execute(
            "SELECT ficha_en, documentos, cronograma FROM procesos_mayor WHERE ocid = ?", (ocid,)
        ).fetchone()
        con.execute(
            """UPDATE procesos_mayor
               SET detalle = ?::jsonb, documentos = ?::jsonb, cronograma = ?::jsonb,
                   ficha_en = now(), actualizado_en = now(), proxima_revision = ?, fallos_ficha = 0
               WHERE ocid = ?""",
            (json.dumps(detalle, ensure_ascii=False), json.dumps(docs or [], ensure_ascii=False),
             json.dumps(crono or [], ensure_ascii=False), prox, ocid),
        )
        # La primera lectura no cuenta como cambio: solo se compara si ya había una ficha leída
        if previo is not None and previo["ficha_en"] is not None:
            cambios = calcular_cambios(_cargar_json(previo["documentos"]), _cargar_json(previo["cronograma"]),
                                       docs or [], crono or [])
            for tipo, det in cambios:
                con.execute(
                    "INSERT INTO procesos_mayor_historial (ocid, tipo, detalle) VALUES (?,?,?::jsonb)",
                    (ocid, tipo, json.dumps(det, ensure_ascii=False)),
                )
            if cambios:
                logger.info("Cambios en %s: %s", ocid, ", ".join(t for t, _ in cambios))
        con.commit()
    finally:
        con.close()


def _quiere_postores(ocid, crono) -> bool:
    """True si el proceso ya terminó (cronograma vencido) o tiene resultado/adjudicación/indicio de desierto."""
    fines = []
    for c in crono or []:
        try:
            if c.get("fecha_fin"):
                fines.append(datetime.strptime(c["fecha_fin"], "%Y-%m-%d %H:%M:%S"))
        except ValueError:
            pass
    if fines and max(fines) < datetime.now(PERU).replace(tzinfo=None):
        return True
    con = abrir_db()
    try:
        r = con.execute(
            """SELECT (estado = 'con_resultado' OR tiene_indicio_desierto = 1
                       OR EXISTS (SELECT 1 FROM mayor_adjudicaciones a WHERE a.ocid = procesos_mayor.ocid)) AS f
               FROM procesos_mayor WHERE ocid = ?""", (ocid,)).fetchone()
    finally:
        con.close()
    return bool(r and r["f"])
# ---------------------------------------------------------------- trabajo completo
def _procesar(ocid, nomenclatura, entidad=None, fecha=None):
    _marcar(ocid, "en_progreso", paso="Abriendo el buscador de SEACE…")
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True, proxy=config_proxy(), args=["--no-sandbox"])
        try:
            page = browser.new_page(accept_downloads=False)
            idx = _buscar_con_reintentos(page, ocid, nomenclatura, entidad, fecha)
            if idx is None:
                _marcar(ocid, "error", error="No se encontró el proceso en el buscador de SEACE")
                return
            _marcar(ocid, "en_progreso", paso="Proceso encontrado, abriendo la ficha…")
            _entrar_ficha(page, idx)
            _marcar(ocid, "en_progreso", paso="Leyendo cronograma, documentos y datos de la ficha…")
            detalle, docs_f, crono = _leer_ficha(page)
            _guardar_ficha(ocid, detalle, docs_f, crono)
            if not _quiere_postores(ocid, crono):
                _marcar(ocid, "ficha", paso="Ficha actualizada")
                return
            if not _hay_ofertas(page):
                _marcar(ocid, "sin_ofertas", paso="SEACE no muestra ofertas presentadas para este proceso")
                return
            _marcar(ocid, "en_progreso", paso="Revisando las ofertas presentadas…")
            _entrar_ofertas(page)
            total = _contar_postores(page)
            if total == 0:
                _marcar(ocid, "sin_ofertas", paso="No hay postores registrados")
                return
            _marcar(ocid, "en_progreso", paso=f"{total} postor(es) encontrados", total=total, actual=0)

            con = abrir_db()
            guardados = 0
            try:
                con.execute("DELETE FROM mayor_postores WHERE ocid = ?", (ocid,))
                con.commit()
                for i in range(total):
                    try:
                        _marcar(ocid, "en_progreso", paso=f"Revisando postor {i + 1} de {total}…",
                                total=total, actual=i + 1)
                        _entrar_detalle(page, i)
                        datos, items = _datos_postor(page), _items_postor(page)
                        if not datos.get("ruc") and not datos.get("razon_social"):
                            page.wait_for_timeout(1500)
                            datos, items = _datos_postor(page), _items_postor(page)
                        if not datos.get("ruc") and not datos.get("razon_social"):
                            logger.warning("Postor %s/%s sin datos, se omite", i + 1, total)
                            _volver(page)
                            continue
                        docs = _docs_postor(page)
                        monto = round(sum(_num(it.get("monto_ofertado")) for it in items), 2) if items else None
                        con.execute(
                            """INSERT INTO mayor_postores
                               (ocid, orden, ruc, razon_social, consorcio, tipo_proveedor, estado_propuesta,
                                estado_registro, mype, monto_total, items, documentos)
                               VALUES (?,?,?,?,?,?,?,?,?,?,?::jsonb,?::jsonb)""",
                            (ocid, i + 1, datos.get("ruc"), datos.get("razon_social"), datos.get("consorcio"),
                             datos.get("tipo_proveedor"), datos.get("estado_propuesta"),
                             datos.get("estado_registro"), datos.get("mype"), monto,
                             json.dumps(items, ensure_ascii=False), json.dumps(docs, ensure_ascii=False)),
                        )
                        con.commit()
                        guardados += 1
                        _volver(page)
                    except Exception as e:
                        logger.warning("Postor %s/%s falló: %s", i + 1, total, e)
                        try:
                            con.rollback()
                        except Exception:
                            pass
                        try:
                            _volver(page)
                        except Exception:
                            pass
            finally:
                con.close()
            _marcar(ocid, "listo" if guardados else "error",
                    paso=f"{guardados} postor(es) leídos", total=total, actual=total,
                    error=None if guardados else "No se pudo leer ningún postor")
        finally:
            browser.close()