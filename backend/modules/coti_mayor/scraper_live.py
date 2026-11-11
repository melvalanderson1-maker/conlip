"""
Scraper en vivo de contratos MAYORES (SEACE buscadorPublico) -> Postgres (procesos_mayor).
Corre dentro del backend COTI en un hilo (ver scraper.py).
"""
import json
import logging
import os
import random
import re
import time
import unicodedata
from urllib.parse import parse_qs, unquote, urlparse
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone

from playwright.sync_api import TimeoutError as PWTimeout
from playwright.sync_api import sync_playwright

from core.db import abrir_db

logger = logging.getLogger("coti_mayor")

URL_BUSCADOR = "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml"

MODALIDADES_MAYORES = [
    "Licitación Pública",
    "Licitación Pública Abreviada",
    "Concurso Público de Servicios",
    "Concurso Público para Consultoría",
    "Subasta Inversa Electrónica",
]

TIMEOUT_MS = 20_000
PAUSA_MS = 800
REVISAR_FICHA_DIAS = 3      # una ficha ya leída se vuelve a leer cada N días...
REVISAR_HASTA_DIAS = 30     # ...pero solo si el proceso se publicó hace menos de N días
REINTENTOS = 2
PERU = timezone(timedelta(hours=-5))

PROXY_SERVER = os.getenv("SEACE_PROXY_SERVER")
PROXY_USER = os.getenv("SEACE_PROXY_USER")
PROXY_PASS_TEMPLATE = os.getenv("SEACE_PROXY_PASS_TEMPLATE")

# Modo desarrollo: SEACE_HEADLESS=false muestra los navegadores en pantalla
HEADLESS = os.getenv("SEACE_HEADLESS", "true").strip().lower() != "false"
VENTANA_W = int(os.getenv("SEACE_VENTANA_W", "640"))
VENTANA_H = int(os.getenv("SEACE_VENTANA_H", "520"))
COLUMNAS = int(os.getenv("SEACE_COLUMNAS", "3"))  # 3 columnas x 2 filas en 1920x1080

MAPA_CATEGORIA = {
    "bien": "goods", "bienes": "goods",
    "servicio": "services", "servicios": "services",
    "obra": "works", "obras": "works",
    "consultoria de obra": "consultoriadeobra", "consultoria en obras": "consultoriadeobra",
}


def config_proxy():
    if not PROXY_SERVER:
        return None
    if PROXY_PASS_TEMPLATE and "{session}" in PROXY_PASS_TEMPLATE:
        password = PROXY_PASS_TEMPLATE.format(session=random.randint(10_000_000, 99_999_999))
    else:
        password = PROXY_PASS_TEMPLATE
    return {"server": PROXY_SERVER, "username": PROXY_USER, "password": password}


def args_navegador(indice: int):
    """Argumentos de Chromium; en modo visible reparte las ventanas en mosaico."""
    args = ["--no-sandbox"]
    if not HEADLESS:
        x = (indice % COLUMNAS) * VENTANA_W
        y = (indice // COLUMNAS) * VENTANA_H
        args += [f"--window-position={x},{y}", f"--window-size={VENTANA_W},{VENTANA_H}"]
    return args

# ---------- utilidades ----------
def normalizar(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto or "")
    t = "".join(c for c in t if not unicodedata.combining(c))
    return " ".join(t.strip().lower().split())


def recortar(texto, longitud: int):
    if texto is None:
        return None
    texto = str(texto).strip()
    return (texto[:longitud] if len(texto) > longitud else texto) or None


def normalizar_moneda(texto: str):
    t = normalizar(texto)
    if not t:
        return None
    if "sol" in t or t in ("s/", "s/."):
        return "PEN"
    if "dolar" in t or "usd" in t:
        return "USD"
    return recortar(texto, 10)


def limpiar_monto(texto: str):
    if not texto or texto.strip() in ("", "---"):
        return None
    try:
        return float(texto.replace(",", "").strip())
    except ValueError:
        return None


def parsear_fecha(texto: str):
    if not texto or texto.strip() in ("", "---"):
        return None
    for formato in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto.strip(), formato)
        except ValueError:
            continue
    return None


def _primera_linea(td) -> str:
    lineas = [l.strip() for l in td.inner_text().splitlines() if l.strip()]
    return lineas[0] if lineas else ""


def parsear_resumen_paginador(resumen: str):
    m_pag = re.search(r"Página:\s*(\d+)\s*/\s*(\d+)", resumen or "")
    m_total = re.search(r"del total\s*(\d+)", resumen or "")
    return (int(m_pag.group(2)) if m_pag else None, int(m_total.group(1)) if m_total else None)


# ---------- combos PrimeFaces ----------
def obtener_opciones(select_locator):
    return select_locator.evaluate(
        "(el) => Array.from(el.options).map(o => ({value: o.value, text: o.textContent}))"
    )


def elegir_opcion(select_locator, texto_deseado: str, nombre_campo: str):
    page = select_locator.page
    objetivo = normalizar(texto_deseado)
    opciones = obtener_opciones(select_locator)
    idx = next((i for i, o in enumerate(opciones) if normalizar(o["text"]) == objetivo), None)
    if idx is None:
        raise RuntimeError(f"Opción '{texto_deseado}' no encontrada en combo '{nombre_campo}'")

    opcion = opciones[idx]
    select_id = select_locator.get_attribute("id") or ""
    base = select_id[:-len("_input")] if select_id.endswith("_input") else select_id
    sel_item = f'li.ui-selectonemenu-item[data-label="{opcion["text"]}"]'

    def estado_actual():
        valor = select_locator.evaluate("(el) => el.value")
        try:
            etiqueta = page.locator(f'[id="{base}_label"]').first.inner_text(timeout=2000).strip()
        except Exception:
            etiqueta = None
        return valor, etiqueta

    def esta_ok():
        valor, etiqueta = estado_actual()
        return valor == opcion["value"] and (etiqueta is None or normalizar(etiqueta) == objetivo)

    for intento in range(1, 5):
        if esta_ok():
            return
        try:
            if intento <= 2:
                widget = page.locator(f'[id="{base}"]').first
                widget.scroll_into_view_if_needed(timeout=5000)
                widget.click(timeout=5000)
                panel = page.locator(f'[id="{base}_panel"]').first
                panel.wait_for(state="visible", timeout=5000)
                item = panel.locator(sel_item)
                if item.count() == 0:
                    item = panel.locator("li.ui-selectonemenu-item").nth(idx)
                item.first.click(timeout=5000)
            else:
                select_locator.select_option(value=opcion["value"], force=True)
                select_locator.dispatch_event("change")
        except Exception as e:
            logger.warning("combo '%s' intento %s/4: %s", nombre_campo, intento, e)
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
        page.wait_for_timeout(800)
        try:
            page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
        except Exception:
            pass

    if not esta_ok():
        raise RuntimeError(f"No se pudo fijar '{texto_deseado}' en el combo '{nombre_campo}'")


def activar_pestana_buscador(page):
    tab = page.locator("a[href='#tbBuscador:tab1']")
    tab.first.wait_for(state="visible", timeout=TIMEOUT_MS)
    tab.first.click()
    page.wait_for_timeout(500)


def seleccionar_por_id_estable(page, id_termina_en: str, texto_opcion: str):
    select = page.locator(f"select[id$='{id_termina_en}_input']")
    select.wait_for(state="attached", timeout=TIMEOUT_MS)
    elegir_opcion(select, texto_opcion, id_termina_en)
    page.wait_for_timeout(300)


def seleccionar_por_etiqueta(page, texto_etiqueta: str, texto_opcion: str):
    select = page.locator(
        f"xpath=//span[contains(normalize-space(.), '{texto_etiqueta}')]"
        f"/ancestor::tr[1]//select[contains(@id, 'idFormBuscarProceso')]"
    ).first
    select.wait_for(state="attached", timeout=TIMEOUT_MS)
    elegir_opcion(select, texto_opcion, texto_etiqueta)
    page.wait_for_timeout(300)


# ---------- tabla de resultados ----------
def obtener_contenedor_tabla(page):
    contenedor = page.locator("div[id$=':dtProcesos']")
    contenedor.first.wait_for(state="attached", timeout=TIMEOUT_MS)
    return contenedor.first


def extraer_filas_tabla(contenedor, modalidad: str, anio: str):
    filas = contenedor.locator("tbody[id$=':dtProcesos_data'] > tr")
    for i in range(filas.count()):
        tds = filas.nth(i).locator("td")
        if tds.count() < 13:
            continue
        entidad = tds.nth(1).inner_text().strip()
        fecha_txt = tds.nth(2).inner_text().strip()
        nomenclatura = tds.nth(3).inner_text().strip()
        objeto = tds.nth(5).inner_text().strip()
        descripcion = tds.nth(6).inner_text().strip()
        valor_txt = tds.nth(9).inner_text().strip()
        moneda = tds.nth(10).inner_text().strip()

        base_id = f"{nomenclatura}-{entidad}" if nomenclatura else f"{entidad}-{fecha_txt}"
        ocid = f"seace-live-{anio}-{re.sub(r'[^A-Za-z0-9-]+', '-', base_id)}"[:120]
        yield {
            "ocid": ocid,
            "nomenclatura": recortar(nomenclatura, 180),
            "anio": int(anio),
            "titulo": (descripcion or objeto)[:250] if (descripcion or objeto) else None,
            "descripcion": descripcion or None,
            "entidad": recortar(entidad, 255),
            "modalidad": recortar(modalidad, 150),
            "categoria": MAPA_CATEGORIA.get(normalizar(objeto)),
            "fecha_convocatoria": parsear_fecha(fecha_txt),
            "monto": limpiar_monto(valor_txt),
            "moneda": normalizar_moneda(moneda),
        }


# ---------- Ficha de Selección ----------
def leer_campo_ficha(page, etiqueta: str):
    span = page.locator(f"xpath=//span[contains(normalize-space(text()), '{etiqueta}')]").first
    if span.count() == 0:
        return None
    td_valor = span.locator("xpath=ancestor::td[1]/following-sibling::td[1]").first
    if td_valor.count() == 0:
        return None
    try:
        return td_valor.inner_text().strip() or None
    except Exception:
        return None


def leer_descripcion_completa(page):
    dialogo = page.locator("[id$=':dialogDescObj'] .ui-dialog-content").first
    if dialogo.count() == 0:
        return None
    try:
        return dialogo.inner_text().strip() or None
    except Exception:
        return None


_EXT_DOC = r"\.(pdf|docx?|xlsx?|zip|rar|7z|png|jpe?g)$"
_GANADOR = {"k": 2}  # índice del elemento de la fila que dispara la descarga (se aprende solo)


def _nombre_desde_url(url: str):
    try:
        u = urlparse(url)
        for clave in ("fileName", "filename", "file", "nombreArchivo", "name"):
            vals = parse_qs(u.query).get(clave)
            if vals:
                cand = unquote(vals[0]).split("/")[-1]
                if re.search(_EXT_DOC, cand, re.I):
                    return cand
        cand = unquote(u.path.rsplit("/", 1)[-1])
        if re.search(_EXT_DOC, cand, re.I):
            return cand
    except Exception:
        pass
    return None


def obtener_url_documento_fila(page, fila):
    """Devuelve (url, nombre, via) del documento de una fila, sin guardar nada en disco.
    via = 'href' (enlace directo) o 'click' (URL capturada al disparar la descarga, que se cancela)."""
    candidatos = fila.locator("a, button, input[type='image'], img")
    total = min(candidatos.count(), 3)

    # 1) enlace directo
    for i in range(total):
        el = candidatos.nth(i)
        try:
            href = el.get_attribute("href")
            if not href or href.strip().lower().startswith(("javascript:", "#", "blob:")):
                continue
            url = page.evaluate("(u) => new URL(u, location.href).href", href)
            nombre = None
            for attr in ("download", "title", "aria-label", "data-filename", "data-original-title"):
                v = (el.get_attribute(attr) or "").strip()
                if v and re.search(_EXT_DOC, v, re.I):
                    nombre = v
                    break
            return url, (nombre or _nombre_desde_url(url)), "href"
        except Exception:
            continue

    # 2) capturar la URL al hacer clic (la descarga se cancela, no se guarda)
    orden = list(range(total))
    g = _GANADOR["k"]
    if g in orden:
        orden.remove(g)
        orden.insert(0, g)
    for k in orden:
        try:
            with page.expect_download(timeout=5000) as info:
                candidatos.nth(k).click()
            d = info.value
            url, nombre = d.url, d.suggested_filename
            try:
                d.cancel()
            except Exception:
                pass
            if url and not url.lower().startswith("blob:"):
                _GANADOR["k"] = k
                return url, nombre, "click"
        except Exception:
            continue
    return None, None, None


def extraer_documentos_ficha(page):
    docs = []
    filas = page.locator("tbody[id$=':dtDocumentos_data'] > tr")
    for i in range(filas.count()):
        fila = filas.nth(i)
        tds = fila.locator("td")
        if tds.count() < 5:
            continue
        try:
            doc = {
                "nro": tds.nth(0).inner_text().strip(),
                "etapa": tds.nth(1).inner_text().strip(),
                "documento": tds.nth(2).inner_text().strip(),
                "archivo": tds.nth(3).inner_text().strip(),
                "fecha_publicacion": tds.nth(4).inner_text().strip(),
                "url_documento": None, "nombre_archivo": None, "formato": None, "via": None,
            }
        except Exception:
            continue
        try:
            url, nombre, via = obtener_url_documento_fila(page, fila)
            doc["url_documento"] = url
            doc["nombre_archivo"] = nombre
            doc["formato"] = os.path.splitext(nombre or "")[1].lower().lstrip(".") or None
            doc["via"] = via
            logger.info("    documento %s: url=%s via=%s", doc["nro"], "sí" if url else "NO", via)
        except Exception as e:
            logger.warning("    documento %s: no se pudo obtener URL -> %s", doc["nro"], e)
        docs.append(doc)
    return docs


def extraer_cronograma_ficha(page):
    filas = page.locator("tbody[id$=':dtCronograma_data'] > tr")
    crono = []
    for i in range(filas.count()):
        tr = filas.nth(i)
        tds = tr.locator("td")
        if tds.count() < 3:
            continue
        try:
            actual = 1 if "active" in (tr.get_attribute("class") or "").split() else 0
            ini = parsear_fecha(_primera_linea(tds.nth(1)))
            fin = parsear_fecha(_primera_linea(tds.nth(2)))
            crono.append({
                "etapa": recortar(_primera_linea(tds.nth(0)), 150),
                "fecha_inicio": ini.strftime("%Y-%m-%d %H:%M:%S") if ini else None,
                "fecha_fin": fin.strftime("%Y-%m-%d %H:%M:%S") if fin else None,
                "es_etapa_actual": actual,
            })
        except Exception as e:
            logger.warning("fila de cronograma ilegible: %s", e)
    return crono


def visitar_ficha_de_fila(page, contenedor, indice_fila: int):
    fila = contenedor.locator("tbody[id$=':dtProcesos_data'] > tr").nth(indice_fila)
    boton = fila.locator("img[id*='grafichaSel']").first
    if boton.count() == 0:
        raise RuntimeError("no encontré el ícono de Ficha de Selección en esta fila")
    boton.scroll_into_view_if_needed()
    try:
        with page.expect_navigation(timeout=8000):
            boton.click()
    except PWTimeout:
        pass
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.locator("[id$=':pnlContenedorGral']").first.wait_for(state="visible", timeout=TIMEOUT_MS)

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
    docs = extraer_documentos_ficha(page)
    crono = extraer_cronograma_ficha(page)

    page.get_by_text("Regresar", exact=True).first.click()
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)
    return detalle, docs, crono


def calc_proxima_revision(crono):
    """Cuándo volver a leer la ficha.
    - Hasta 2 h después de un hito (inicio o fin de etapa): cada 20 min, que es cuando la entidad
      suele publicar el documento de esa etapa.
    - Con un hito por venir: justo después de él, y como máximo en 2 h (cubre reprogramaciones y
      documentos publicados antes de tiempo).
    - Cronograma terminado: cada 24 h los primeros 10 días y cada 5 días hasta los 45; después None."""
    VENTANA_POST_HITO = timedelta(hours=2)
    CADA_POST_HITO = timedelta(minutes=20)
    TECHO_ENTRE_HITOS = timedelta(hours=2)
    PISO = timedelta(minutes=15)

    ahora = datetime.now(PERU).replace(tzinfo=None)
    fechas = []
    for c in crono or []:
        for k in ("fecha_inicio", "fecha_fin"):
            v = c.get(k)
            if v:
                try:
                    fechas.append(datetime.strptime(v, "%Y-%m-%d %H:%M:%S"))
                except ValueError:
                    pass
    if not fechas:
        prox = ahora + TECHO_ENTRE_HITOS
    else:
        recientes = [f for f in fechas if ahora - VENTANA_POST_HITO <= f <= ahora]
        futuras = [f for f in fechas if f > ahora]
        if recientes:
            prox = ahora + CADA_POST_HITO
        elif futuras:
            prox = min(min(futuras) + timedelta(minutes=5), ahora + TECHO_ENTRE_HITOS)
            prox = max(prox, ahora + PISO)
        else:
            dias = (ahora - max(fechas)).days
            if dias <= 10:
                prox = ahora + timedelta(hours=24)
            elif dias <= 45:
                prox = ahora + timedelta(days=5)
            else:
                return None
    return prox.replace(tzinfo=PERU)


def ocid_de_api(con, nomenclatura, fecha=None):
    """Devuelve (ocid, vetado).
    - ocid: el de la API si hay exactamente un proceso de la API con esa nomenclatura.
    - vetado: True si ese proceso de la API es de otra convocatoria (publicada con más de 30 días
      de diferencia: p. ej. un reinicio), y entonces NO se le asigna esta fila."""
    if not nomenclatura:
        return None, False
    rs = con.execute(
        "SELECT ocid, (published_date AT TIME ZONE 'America/Lima') FROM procesos_mayor "
        "WHERE nomenclatura=? AND origen='api' LIMIT 2",
        (nomenclatura,),
    ).fetchall()
    if len(rs) != 1:
        return None, False
    ocid, publicado = rs[0][0], rs[0][1]
    # El release de la API siempre es igual o posterior a la convocatoria. Si la fila de SEACE es MÁS
    # NUEVA que el último release (más de 7 días), es otra convocatoria (reinicio), no la de la API.
    if fecha is not None and publicado is not None and (fecha - publicado).days > 7:
        return None, True
    return ocid, False

# ---------- base de datos ----------
def necesita_ficha(con, ocid: str) -> bool:
    r = con.execute(
        "SELECT ficha_en, proxima_revision, documentos FROM procesos_mayor WHERE ocid=?", (ocid,)
    ).fetchone()
    if r is None or r[0] is None:
        return True
    docs = r[2]
    if isinstance(docs, str):
        try:
            docs = json.loads(docs)
        except ValueError:
            docs = None
    if docs and any("url_documento" not in d for d in docs):
        return True
    prox = r[1]
    if prox is None:          # cronograma cerrado hace mucho: ya no se revisa
        return False
    if prox.tzinfo is None:
        prox = prox.replace(tzinfo=PERU)
    return prox <= datetime.now(timezone.utc)

def _cargar_json(valor):
    if isinstance(valor, str):
        try:
            return json.loads(valor)
        except ValueError:
            return []
    return valor or []


def calcular_cambios(docs_prev, crono_prev, docs_new, crono_new):
    """Compara lo guardado con lo recién leído. No compara URLs (pueden variar en cada lectura)."""
    cambios = []

    def clave_doc(d):
        return (d.get("etapa"), d.get("documento"), d.get("archivo"), d.get("fecha_publicacion"))

    vistos = {clave_doc(d) for d in docs_prev}
    for d in docs_new:
        if clave_doc(d) not in vistos:
            cambios.append(("documento_nuevo", {
                "etapa": d.get("etapa"), "documento": d.get("documento"),
                "nombre_archivo": d.get("nombre_archivo"),
                "fecha_publicacion": d.get("fecha_publicacion")}))

    prev = {c.get("etapa"): c for c in crono_prev}
    for c in crono_new:
        p = prev.get(c.get("etapa"))
        if p is None:
            cambios.append(("etapa_nueva", {"etapa": c.get("etapa"),
                                            "inicio": c.get("fecha_inicio"), "fin": c.get("fecha_fin")}))
            continue
        if (p.get("fecha_inicio"), p.get("fecha_fin")) != (c.get("fecha_inicio"), c.get("fecha_fin")):
            cambios.append(("cronograma_fecha", {
                "etapa": c.get("etapa"),
                "antes": {"inicio": p.get("fecha_inicio"), "fin": p.get("fecha_fin")},
                "ahora": {"inicio": c.get("fecha_inicio"), "fin": c.get("fecha_fin")}}))
        if p.get("es_etapa_actual") != c.get("es_etapa_actual") and c.get("es_etapa_actual") == 1:
            cambios.append(("etapa_actual", {"etapa": c.get("etapa")}))
    return cambios


def guardar(con, f: dict, detalle=None, documentos=None, cronograma=None):
    con.execute(
        """INSERT INTO procesos_mayor
           (ocid, nomenclatura, anio, titulo, descripcion, entidad, modalidad, categoria,
            fecha_convocatoria, monto, moneda)
           VALUES (?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT (ocid) DO UPDATE SET
             titulo=EXCLUDED.titulo, descripcion=EXCLUDED.descripcion, entidad=EXCLUDED.entidad,
             modalidad=EXCLUDED.modalidad, categoria=EXCLUDED.categoria,
             fecha_convocatoria=EXCLUDED.fecha_convocatoria, monto=EXCLUDED.monto,
             moneda=EXCLUDED.moneda, actualizado_en=now()""",
        (f["ocid"], f["nomenclatura"], f["anio"], f["titulo"], f["descripcion"], f["entidad"],
         f["modalidad"], f["categoria"], f["fecha_convocatoria"], f["monto"], f["moneda"]),
    )
    if detalle is not None:
        con.execute(
            """UPDATE procesos_mayor
               SET detalle=?::jsonb, documentos=?::jsonb, cronograma=?::jsonb, ficha_en=now(),
                   proxima_revision=?, fallos_ficha=0
               WHERE ocid=?""",
            (json.dumps(detalle, ensure_ascii=False), json.dumps(documentos or [], ensure_ascii=False),
             json.dumps(cronograma or [], ensure_ascii=False), calc_proxima_revision(cronograma), f["ocid"]),
        )
    con.commit()


# ---------- búsqueda + paginación ----------
def buscar_modalidad(con, page, anio: str, modalidad: str, reintento: bool) -> int:
    logger.info("== Buscando: %s — año %s ==", modalidad, anio)
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)  # re-verifica por el AJAX
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))

    boton = page.locator("button[id$=':btnBuscarSelToken']")
    boton.wait_for(state="visible", timeout=TIMEOUT_MS)
    boton.click()
    page.wait_for_timeout(1500)
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)

    filas_reales = 0
    for _ in range(15):
        filas_reales = page.evaluate("""() => {
            const tb = document.querySelector("tbody[id$=':dtProcesos_data']");
            if (!tb) return 0;
            return Array.from(tb.querySelectorAll(':scope > tr'))
                .filter(tr => tr.querySelectorAll(':scope > td').length >= 13).length;
        }""")
        if filas_reales > 0:
            break
        page.wait_for_timeout(1000)
    if filas_reales == 0 and not reintento:
        raise RuntimeError("0 filas en el primer intento; se reintenta con navegador nuevo")

    pagina, total = 1, 0
    while True:
        contenedor = obtener_contenedor_tabla(page)
        filas = list(extraer_filas_tabla(contenedor, modalidad, anio))
        try:
            resumen = contenedor.locator("span.ui-paginator-current").first.inner_text(timeout=2000).strip()
        except Exception:
            resumen = ""
        logger.info("  %s | página %s: %s filas | %s", modalidad, pagina, len(filas), resumen)

        conocidas = 0
        for idx, f in enumerate(filas):
            detalle = documentos = cronograma = None
            oficial, vetado = ocid_de_api(con, f.get("nomenclatura"), f.get("fecha_convocatoria"))
            if oficial:
                f["ocid"] = oficial  # el proceso ya vino de la API: el scraper solo le agrega la ficha
            elif vetado and f.get("fecha_convocatoria"):
                # otra convocatoria con la misma nomenclatura (reinicio): ocid propio, con la fecha
                f["ocid"] = (f["ocid"] + "-" + f["fecha_convocatoria"].strftime("%Y%m%d%H%M"))[:120]
            if necesita_ficha(con, f["ocid"]):
                try:
                    contenedor = obtener_contenedor_tabla(page)
                    detalle, documentos, cronograma = visitar_ficha_de_fila(page, contenedor, idx)
                except Exception as e:
                    logger.warning("    ficha no leída (%s): %s", f.get("nomenclatura"), e)
            else:
                conocidas += 1
            try:
                guardar(con, f, detalle, documentos, cronograma)
            except Exception as e:
                try:
                    con.rollback()
                except Exception:
                    pass
                logger.error("    no se pudo guardar %s: %s", f.get("nomenclatura"), e)
        total += len(filas)

        # Ciclo normal: si toda la página ya era conocida, no hay nada nuevo más atrás.
        if not reintento and filas and conocidas == len(filas):
            logger.info("  [fin anticipado] página %s ya conocida", pagina)
            break

        contenedor = obtener_contenedor_tabla(page)
        nxt = contenedor.locator("span.ui-paginator-next, a.ui-paginator-next")
        if nxt.count() == 0 or "ui-state-disabled" in (nxt.first.get_attribute("class") or ""):
            break
        nxt.first.click()
        page.wait_for_timeout(PAUSA_MS)
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
        pagina += 1
    return total

MAX_PARALELO = int(os.getenv("MAYOR_PARALELO", "5"))
PAUSA_ARRANQUE = 4  # segundos entre el arranque de cada navegador (evita una ráfaga contra el SEACE)


def _worker_modalidad(anio: str, modalidad: str, indice: int) -> int:
    """Un navegador + una conexión a la base propios para UNA modalidad."""
    threading.current_thread().name = f"mayor-{indice + 1}"
    time.sleep(indice * PAUSA_ARRANQUE)
    con = abrir_db()
    try:
        for intento in range(1, REINTENTOS + 2):
            try:
                with sync_playwright() as p:
                    browser = p.chromium.launch(
                        headless=HEADLESS, proxy=config_proxy(), args=args_navegador(indice)
                    )
                    try:
                        # no_viewport: la página ocupa el tamaño real de la ventana (solo en modo visible)
                        opciones_pagina = {} if HEADLESS else {"no_viewport": True}
                        page = browser.new_page(accept_downloads=True, **opciones_pagina)
                        page.goto(URL_BUSCADOR, timeout=60_000)
                        page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
                        activar_pestana_buscador(page)
                        n = buscar_modalidad(con, page, anio, modalidad, intento > 1)
                    finally:
                        browser.close()
                logger.info("== TERMINADA '%s': %s filas ==", modalidad, n)
                return n
            except Exception as e:
                logger.warning("'%s' intento %s/%s falló: %s", modalidad, intento, REINTENTOS + 1, e)
                try:
                    con.rollback()
                except Exception:
                    pass
                time.sleep(5 * intento)
        return 0
    finally:
        con.close()


# ---------- refresco puntual por nomenclatura (buscador avanzado) ----------
REFRESCO_MAX = int(os.getenv("MAYOR_REFRESCO_MAX", "60"))  # máx. procesos a refrescar por ciclo


def _contar(valor):
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except ValueError:
            return 0
    return len(valor or [])


def procesos_por_revisar(con, anio: str, limite: int):
    """Procesos con ficha ya leída cuya proxima_revision ya venció (cualquier página de SEACE)."""
    filas = con.execute(
        """SELECT ocid, nomenclatura, entidad, modalidad FROM procesos_mayor
           WHERE anio=? AND ficha_en IS NOT NULL AND proxima_revision IS NOT NULL
             AND proxima_revision <= now() AND nomenclatura IS NOT NULL AND entidad IS NOT NULL
           ORDER BY proxima_revision LIMIT ?""",
        (int(anio), limite),
    ).fetchall()
    return [(r[0], r[1], r[2], r[3]) for r in filas]


def posponer(con, ocid: str):
    """Si no se pudo refrescar, reintenta en 6 h en vez de bloquear cada ciclo."""
    try:
        con.execute(
            "UPDATE procesos_mayor SET proxima_revision = now() + interval '6 hours', "
            "fallos_ficha = COALESCE(fallos_ficha, 0) + 1 WHERE ocid=?", (ocid,))
        con.commit()
    except Exception:
        try:
            con.rollback()
        except Exception:
            pass


def buscar_por_nomenclatura(page, anio: str, modalidad: str, nomenclatura: str):
    try:
        activar_pestana_buscador(page)
    except Exception:
        pass
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)  # re-verifica por el AJAX
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))

    # El campo está en la búsqueda avanzada (puede estar plegada): se asigna por JS, después de los combos
    campo = page.locator("input[id$=':siglasEntidad']").first
    campo.wait_for(state="attached", timeout=TIMEOUT_MS)
    campo.evaluate(
        "(el, v) => { el.value = v; el.dispatchEvent(new Event('input', {bubbles: true})); "
        "el.dispatchEvent(new Event('change', {bubbles: true})); }",
        nomenclatura,
    )
    boton = page.locator("button[id$=':btnBuscarSelToken']")
    boton.wait_for(state="visible", timeout=TIMEOUT_MS)
    boton.click()
    page.wait_for_timeout(1500)
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)


def _localizar_fila(page, modalidad: str, anio: str, nomenclatura: str, entidad: str):
    obj_n, obj_e = normalizar(nomenclatura), normalizar(entidad)
    for _ in range(4):
        contenedor = obtener_contenedor_tabla(page)
        for i, f in enumerate(extraer_filas_tabla(contenedor, modalidad, anio)):
            if normalizar(f["nomenclatura"]) == obj_n and normalizar(f["entidad"]) == obj_e:
                return contenedor, i, f
        nxt = contenedor.locator("span.ui-paginator-next, a.ui-paginator-next")
        if nxt.count() == 0 or "ui-state-disabled" in (nxt.first.get_attribute("class") or ""):
            break
        nxt.first.click()
        page.wait_for_timeout(PAUSA_MS)
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    return None, None, None


def refrescar_proceso(con, page, anio: str, modalidad: str, ocid: str, nomenclatura: str, entidad: str) -> bool:
    buscar_por_nomenclatura(page, anio, modalidad, nomenclatura)
    contenedor, idx, fila = _localizar_fila(page, modalidad, anio, nomenclatura, entidad)
    if idx is None:
        logger.warning("  [refresco] no encontré %s | %s en el buscador", nomenclatura, entidad)
        return False
    previo = con.execute("SELECT documentos, cronograma FROM procesos_mayor WHERE ocid=?", (ocid,)).fetchone()
    detalle, documentos, cronograma = visitar_ficha_de_fila(page, contenedor, idx)
    fila["ocid"] = ocid  # se conserva el ocid que ya tiene en la base
    guardar(con, fila, detalle, documentos, cronograma)
    if previo:
        logger.info("  [refresco] %s | %s: docs %s->%s, etapas %s->%s", nomenclatura, entidad,
                    _contar(previo[0]), len(documentos or []), _contar(previo[1]), len(cronograma or []))
    return True


def _worker_refresco(anio: str, modalidad: str, procesos, indice: int) -> int:
    threading.current_thread().name = f"refresco-{indice + 1}"
    time.sleep(indice * PAUSA_ARRANQUE)
    con = abrir_db()
    hechos = 0
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(
                headless=HEADLESS, proxy=config_proxy(), args=args_navegador(indice)
            )
            try:
                opciones_pagina = {} if HEADLESS else {"no_viewport": True}
                page = browser.new_page(accept_downloads=True, **opciones_pagina)
                page.goto(URL_BUSCADOR, timeout=60_000)
                page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
                activar_pestana_buscador(page)
                for ocid, nomenclatura, entidad in procesos:
                    try:
                        if refrescar_proceso(con, page, anio, modalidad, ocid, nomenclatura, entidad):
                            hechos += 1
                        else:
                            posponer(con, ocid)
                    except Exception as e:
                        logger.warning("  [refresco] falló %s: %s", nomenclatura, e)
                        try:
                            con.rollback()
                        except Exception:
                            pass
                        posponer(con, ocid)
                        try:  # recomponer la página para seguir con el siguiente
                            page.goto(URL_BUSCADOR, timeout=60_000)
                            page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
                            activar_pestana_buscador(page)
                        except Exception:
                            break
            finally:
                browser.close()
    finally:
        con.close()
    logger.info("== REFRESCO '%s': %s/%s procesos ==", modalidad, hechos, len(procesos))
    return hechos


def ejecutar_refresco(anio: str):
    """Vuelve a leer, por nomenclatura, los procesos cuya revisión venció, sin importar en qué página estén."""
    con = abrir_db()
    try:
        pendientes = procesos_por_revisar(con, anio, REFRESCO_MAX)
    finally:
        con.close()
    grupos = {}
    for ocid, nomenclatura, entidad, modalidad in pendientes:
        if modalidad in MODALIDADES_MAYORES:
            grupos.setdefault(modalidad, []).append((ocid, nomenclatura, entidad))
    if not grupos:
        logger.info("Refresco Coti Mayor: no hay procesos con revisión vencida")
        return
    logger.info("Refresco Coti Mayor: %s procesos en %s modalidades",
                sum(len(v) for v in grupos.values()), len(grupos))
    n = max(1, min(MAX_PARALELO, len(grupos)))
    with ThreadPoolExecutor(max_workers=n, thread_name_prefix="refresco") as ex:
        futs = [ex.submit(_worker_refresco, anio, m, procs, i)
                for i, (m, procs) in enumerate(grupos.items())]
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                logger.error("Un worker de refresco falló: %s", e)


def ejecutar_ciclo(anio: str):
    """Una modalidad por navegador, todas a la vez (máx. MAYOR_PARALELO)."""
    n = max(1, min(MAX_PARALELO, len(MODALIDADES_MAYORES)))
    logger.info("Live Coti Mayor: %s modalidades con %s navegadores en paralelo", len(MODALIDADES_MAYORES), n)
    with ThreadPoolExecutor(max_workers=n, thread_name_prefix="mayor") as ex:
        futs = [ex.submit(_worker_modalidad, anio, m, i) for i, m in enumerate(MODALIDADES_MAYORES)]
        for f in as_completed(futs):
            try:
                f.result()
            except Exception as e:
                logger.error("Un worker del live falló: %s", e)

