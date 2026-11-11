"""
seace_scrape_prueba.py

Extrae "contratos mayores" DIRECTO del buscador público de SEACE
(buscadorPublico.xhtml), en vivo, para tener datos del mismo día.

VERSIÓN DE PRUEBA — sin conexión a MySQL; documentos se visualizan en navegador mediante visor local en memoria, sin guardarlos en disco:
  - Ya NO escribe a sqlite. Escribe directo a tus tablas:
        seace_procesos        (upsert, misma tabla que usa seace_router.py)
        seace_detalle_ficha   (1 fila por ocid, datos de la Ficha de Selección)
        seace_documentos      (N filas por ocid, documentos publicados)
  - Reporta su avance en vivo en la tabla seace_scraper_jobs, para que
    el endpoint /api/seace/scraper/estado/{job_id} del backend pueda
    devolverle al frontend "en qué va" (modalidad, página, filas) y
    el frontend pinte un loader tipo "Navegando licitaciones del SEACE...".
  - Se puede llamar:
      a) Desde el backend (routers/seace_scraper_router.py) importando
         `ejecutar_scraping_live(anio, job_id, headless, con_detalle)`
         y corriéndola en un thread aparte.
      b) Desde la terminal, para pruebas manuales:
           python seace_scrape_live.py --anio 2026
           python seace_scrape_live.py --anio 2026 --detalle false   (rápido, sin fichas)

IMPORTANTE — nombre del pool de conexiones:
  Tu seace_sync.py ya crea un pool llamado "seace_sync_pool". Si este
  archivo vive en el mismo proceso del backend (lo normal, porque el
  router lo importa), NO puede volver a crear un pool con el mismo
  nombre — mysql-connector lanzaría un error de pool duplicado. Por
  eso este archivo usa su propio nombre: "seace_live_pool".

Puntos clave de scraping (heredados de la versión anterior, sin cambios):
  1. El formulario vive en una pestaña ("Buscador de Procedimientos de
     Selección") que hay que activar con clic antes de tocar campos.
  2. "Tipo de Selección" y "Año de la Convocatoria" son widgets
     PrimeFaces (SelectOneMenu). Se seleccionan leyendo el <select>
     oculto, normalizando texto (sin tildes/mayúsculas).
  3. Hay dos botones "Buscar": usamos el visible
     (id que termina en ':btnBuscarSelToken').
  4. Paginación y extracción de filas acotadas al contenedor exacto
     de la tabla de resultados (div[id$=':dtProcesos']).
  5. Ficha de Selección por fila: cada fila tiene un ícono
     (<img id="...:grafichaSel">) que abre fichaSeleccion.xhtml con
     dirección/teléfono de la entidad, descripción completa del
     objeto, monto del derecho de participación y documentos
     publicados. El botón "Regresar" vuelve a la misma página de
     resultados (ptoRetorno=LOCAL). Se puede desactivar con
     --detalle false para la versión rápida.

Instalación:
    pip install playwright python-dotenv
    playwright install chromium
"""

import argparse
import glob
import random
import logging
import os
import re
import sys
import time
import threading
import unicodedata
import uuid
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta
import hashlib

from dotenv import load_dotenv
from playwright.sync_api import sync_playwright, TimeoutError as PWTimeout

load_dotenv()

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(levelname)s] [%(threadName)s] %(message)s")
logger = logging.getLogger("seace_scrape_live")

URL_BUSCADOR = "https://prod2.seace.gob.pe/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml"

MODALIDADES_MAYORES = [
    "Licitación Pública",
    "Licitación Pública Abreviada",
    "Concurso Público de Servicios",
    "Concurso Público para Consultoría",
    "Subasta Inversa Electrónica",
]

PAUSA_ENTRE_ACCIONES = 0.8
TIMEOUT_MS = 20_000

PROXY_SERVER = os.getenv("SEACE_PROXY_SERVER")
PROXY_USER = os.getenv("SEACE_PROXY_USER")
PROXY_PASS_TEMPLATE = os.getenv("SEACE_PROXY_PASS_TEMPLATE")  # ej: dcPCczaZYNlOpAF_country-PE_session-{session}_ttl-10


def config_proxy():
    if not PROXY_SERVER:
        return None
    if PROXY_PASS_TEMPLATE and "{session}" in PROXY_PASS_TEMPLATE:
        session_id = random.randint(10_000_000, 99_999_999)
        password = PROXY_PASS_TEMPLATE.format(session=session_id)
    else:
        password = PROXY_PASS_TEMPLATE
    return {"server": PROXY_SERVER, "username": PROXY_USER, "password": password}

# ---- descarga de documentos de la Ficha ----
DESCARGAR_DOCUMENTOS = False    # No descargar archivos; apertura por navegador
SOLO_BASES = False              # No aplica en modo apertura por navegador
SALTAR_YA_SCRAPEADOS = True     # True = no vuelve a entrar a la ficha de procesos ya completos en la BD
SALTAR_SI_YA_EN_API = True      # True = omite procesos que seace_sync.py ya trajo (origen = 'api')
PARAR_SI_PAGINA_CONOCIDA = True # False = siempre recorre TODAS las páginas de la modalidad

REVISION_INICIAL_DIAS = 3       # si el proceso cambió (o es nuevo), vuelve a mirarlo en N días
REVISION_MAXIMA_DIAS = 60       # aunque nunca cambie, no dejes de vigilarlo más de N días entre revisiones
FACTOR_BACKOFF = 2               # cada vez que NO cambia nada, duplica el intervalo (hasta el máximo)

MARGEN_DIAS_TRAS_CIERRE = 3     # sigue revisando el proceso unos días después de su fecha de cierre,
                                 # por si la entidad sube documentos o corrige el cronograma tarde
_ESTADO_DESCARGA = {"ganador": 2}  # índice del elemento que sí dispara la descarga (se aprende solo)
DESCARGA_TIMEOUT_MS = 15_000    # tiempo máximo esperando que empiece cada descarga
DOCS_DIR = os.path.abspath(os.getenv("SEACE_DOCS_DIR", "seace_docs"))

# Mapea el texto de "Objeto de Contratación" de la tabla del SEACE al
# valor que usa tu columna seace_procesos.categoria (la misma que ya
# usa el pipeline OCDS/API, para que el filtro por categoría del
# frontend funcione igual sin importar el origen del dato).
MAPA_CATEGORIA = {
    "bien": "goods",
    "bienes": "goods",
    "servicio": "services",
    "servicios": "services",
    "obra": "works",
    "obras": "works",
    "consultoria de obra": "consultoriadeobra",
    "consultoria en obras": "consultoriadeobra",
}


# ---------- modo de prueba SIN base de datos ----------
# Este archivo no crea pools ni abre conexiones MySQL.
def obtener_conexion():
    raise RuntimeError("Modo de prueba: la conexión a MySQL está deshabilitada.")


# ---------- utilidades de texto ----------

def normalizar(texto: str) -> str:
    t = unicodedata.normalize("NFKD", texto or "")
    t = "".join(c for c in t if not unicodedata.combining(c))
    return " ".join(t.strip().lower().split())


def recortar(texto, longitud: int):
    """Corta defensivamente un texto antes de mandarlo a una columna
    VARCHAR, para que un desfase de columnas en una fila puntual nunca
    tumbe TODO el guardado (proceso + ficha + documentos) de esa fila."""
    if texto is None:
        return None
    texto = str(texto).strip()
    if len(texto) > longitud:
        logger.warning("valor recortado de %s a %s caracteres: %r", len(texto), longitud, texto[:80])
        return texto[:longitud]
    return texto or None


def normalizar_moneda(texto: str):
    """seace_procesos.moneda es VARCHAR(10) — muy chico para 'Nuevo Sol'
    o para una fila donde el SEACE desfasó columnas. Mapea a código
    corto conocido; si no reconoce nada, recorta en vez de tronar."""
    t = normalizar(texto)
    if not t:
        return None
    if "sol" in t or t in ("s/", "s/."):
        return "PEN"
    if "dolar" in t or "dólar" in t or "usd" in t:
        return "USD"
    return recortar(texto, 10)


def mapear_categoria(objeto_texto: str):
    if not objeto_texto:
        return None
    return MAPA_CATEGORIA.get(normalizar(objeto_texto))


def limpiar_monto(texto: str):
    if not texto or texto.strip() in ("", "---"):
        return None
    try:
        return float(texto.replace(",", "").strip())
    except ValueError:
        return None


def parsear_fecha(texto: str):
    """La tabla del SEACE trae fechas tipo '17/09/2026 14:30:00' o
    '17/09/2026'. Devuelve un datetime o None si no calza con nada
    conocido (nunca truena la corrida por un formato inesperado)."""
    if not texto:
        return None
    texto = texto.strip()
    if not texto or texto == "---":
        return None
    for formato in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y %H:%M", "%d/%m/%Y"):
        try:
            return datetime.strptime(texto, formato)
        except ValueError:
            continue
    return None



def parsear_resumen_paginador(resumen: str):
    """'Mostrando de 1 a 15 del total 499 - Página: 1/34' -> (pagina_actual, paginas_totales, filas_totales)"""
    m_pag = re.search(r"Página:\s*(\d+)\s*/\s*(\d+)", resumen or "")
    m_total = re.search(r"del total\s*(\d+)", resumen or "")
    pagina = int(m_pag.group(1)) if m_pag else None
    paginas_totales = int(m_pag.group(2)) if m_pag else None
    filas_totales = int(m_total.group(1)) if m_total else None
    return pagina, paginas_totales, filas_totales

# ---------- progreso del job (para el botón/loader del frontend) ----------

def crear_job(anio: str, modalidad_total: int) -> str:
    job_id = uuid.uuid4().hex
    con = obtener_conexion()
    try:
        cur = con.cursor()
        cur.execute(
            """INSERT INTO seace_scraper_jobs
               (job_id, estado, anio, modalidad_total, mensaje)
               VALUES (%s, 'en_cola', %s, %s, 'En cola, iniciando navegador...')""",
            (job_id, anio, modalidad_total),
        )
        con.commit()
        cur.close()
    finally:
        con.close()
    return job_id


def actualizar_job(job_id: str, **campos):
    """Actualiza solo los campos que se pasen. Nunca deja tumbar el
    scraping si hay un problema de conexión al reportar progreso."""
    if not job_id or not campos:
        return
    sets = ", ".join(f"{k} = %s" for k in campos)
    valores = list(campos.values()) + [job_id]
    try:
        con = obtener_conexion()
        try:
            cur = con.cursor()
            cur.execute(f"UPDATE seace_scraper_jobs SET {sets} WHERE job_id = %s", valores)
            con.commit()
            cur.close()
        finally:
            con.close()
    except Exception as e:
        logger.warning("no se pudo actualizar el progreso del job %s: %s", job_id, e)


def reportar_progreso_modalidad(job_id, modalidad, pagina_actual=None, paginas_totales=None,
                                 filas_procesadas=None, filas_totales=None, estado=None):
    if not job_id:
        return
    campos = {
        "job_id": job_id, "modalidad": recortar(modalidad, 150),
        "pagina_actual": pagina_actual, "paginas_totales": paginas_totales,
        "filas_procesadas": filas_procesadas, "filas_totales": filas_totales,
        "estado": estado or "en_curso",
    }
    try:
        con = obtener_conexion()
        try:
            cur = con.cursor()
            cur.execute(
                """INSERT INTO seace_scraper_progreso
                       (job_id, modalidad, pagina_actual, paginas_totales, filas_procesadas, filas_totales, estado)
                   VALUES (%(job_id)s, %(modalidad)s, %(pagina_actual)s, %(paginas_totales)s, %(filas_procesadas)s, %(filas_totales)s, %(estado)s)
                   ON DUPLICATE KEY UPDATE
                       pagina_actual = COALESCE(VALUES(pagina_actual), pagina_actual),
                       paginas_totales = COALESCE(VALUES(paginas_totales), paginas_totales),
                       filas_procesadas = COALESCE(VALUES(filas_procesadas), filas_procesadas),
                       filas_totales = COALESCE(VALUES(filas_totales), filas_totales),
                       estado = VALUES(estado)""",
                campos,
            )
            con.commit()
            cur.close()
        finally:
            con.close()
    except Exception as e:
        logger.warning("no se pudo reportar progreso de modalidad %s: %s", modalidad, e)


def finalizar_job(job_id: str, estado: str, mensaje: str, error: str = None):
    actualizar_job(
        job_id,
        estado=estado,
        mensaje=mensaje,
        error=error,
        finalizado_en=datetime.now(),
    )


# ---------- upsert en tus tablas reales ----------

def guardar_fila(con, fila: dict):
    """Upsert de una convocatoria en seace_procesos + su detalle/documentos
    si vinieron (--detalle true). Usa ON DUPLICATE KEY UPDATE porque
    seace_procesos.ocid es PRIMARY KEY."""
    documentos = fila.pop("_documentos", None)
    detalle = fila.pop("_detalle", None)
    cronograma = fila.pop("_cronograma", None)

    es_api = fila.pop("_ocid_api", None)
    cur = con.cursor()
    if es_api:
        fila["tender_id"] = es_api[1]  # el cronograma se guarda con el tender_id oficial
    else:
      cur.execute(
        """
        INSERT INTO seace_procesos
            (ocid, tender_id, titulo, descripcion, entidad, modalidad, categoria,
             fecha_convocatoria, monto, moneda, estado, origen, published_date,
             nomenclatura, raw_json)
        VALUES
            (%(ocid)s, %(tender_id)s, %(titulo)s, %(descripcion)s, %(entidad)s,
             %(modalidad)s, %(categoria)s, %(fecha_convocatoria)s, %(monto)s,
             %(moneda)s, %(estado)s, 'scraper', %(published_date)s,
             %(nomenclatura)s, %(raw_json)s)
        ON DUPLICATE KEY UPDATE
            titulo = VALUES(titulo),
            descripcion = VALUES(descripcion),
            entidad = VALUES(entidad),
            modalidad = VALUES(modalidad),
            categoria = VALUES(categoria),
            fecha_convocatoria = VALUES(fecha_convocatoria),
            monto = VALUES(monto),
            moneda = VALUES(moneda),
            published_date = VALUES(published_date),
            raw_json = VALUES(raw_json)
        """,
        fila,
    )

    if detalle:
        detalle["ocid"] = fila["ocid"]
        cur.execute(
            """
            INSERT INTO seace_detalle_ficha
                (ocid, tipo_compra_seleccion, normativa_aplicable, entidad_convocante,
                 direccion_legal, pagina_web, telefono_entidad, monto_derecho_participacion,
                 fecha_hora_publicacion_detalle, descripcion_objeto_completa)
            VALUES
                (%(ocid)s, %(tipo_compra_seleccion)s, %(normativa_aplicable)s, %(entidad_convocante)s,
                 %(direccion_legal)s, %(pagina_web)s, %(telefono_entidad)s, %(monto_derecho_participacion)s,
                 %(fecha_hora_publicacion_detalle)s, %(descripcion_objeto_completa)s)
            ON DUPLICATE KEY UPDATE
                tipo_compra_seleccion = VALUES(tipo_compra_seleccion),
                normativa_aplicable = VALUES(normativa_aplicable),
                entidad_convocante = VALUES(entidad_convocante),
                direccion_legal = VALUES(direccion_legal),
                pagina_web = VALUES(pagina_web),
                telefono_entidad = VALUES(telefono_entidad),
                monto_derecho_participacion = VALUES(monto_derecho_participacion),
                fecha_hora_publicacion_detalle = VALUES(fecha_hora_publicacion_detalle),
                descripcion_objeto_completa = VALUES(descripcion_objeto_completa)
            """,
            detalle,
        )

    if documentos is not None:
        cur.execute("DELETE FROM seace_documentos WHERE ocid = %s", (fila["ocid"],))
        if documentos:
            cur.executemany(
                """INSERT INTO seace_documentos
                   (ocid, nro, etapa, documento, archivo, fecha_publicacion, ruta_local)
                   VALUES (%(ocid)s, %(nro)s, %(etapa)s, %(documento)s, %(archivo)s, %(fecha_publicacion)s, %(ruta_local)s)""",
                [{**d, "ocid": fila["ocid"]} for d in documentos],
            )

    # seace_cronograma_fases se indexa por tender_id (no por ocid), y no
    # tiene un unique key sobre (tender_id, etapa) — por eso borramos
    # todas las fases de este tender_id antes de reinsertar, así cada
    # scraneo deja el cronograma actualizado sin duplicar filas viejas.
    tender_id = fila.get("tender_id")
    if cronograma is not None and tender_id:
        cur.execute("DELETE FROM seace_cronograma_fases WHERE tender_id = %s", (tender_id,))
        if cronograma:
            cur.executemany(
                """INSERT INTO seace_cronograma_fases
                   (tender_id, nomenclatura, etapa, fecha_inicio, fecha_fin, es_etapa_actual)
                   VALUES (%(tender_id)s, %(nomenclatura)s, %(etapa)s, %(fecha_inicio)s, %(fecha_fin)s, %(es_etapa_actual)s)""",
                [{**c, "tender_id": tender_id, "nomenclatura": fila.get("nomenclatura")} for c in cronograma],
            )

    con.commit()
    cur.close()



def guardar_fila_con_reintento(con, fila: dict, intentos: int = 4):
    """MySQL puede lanzar un deadlock (errno 1213) o lock wait timeout
    (errno 1205) cuando varios navegadores en paralelo escriben filas
    relacionadas casi al mismo tiempo. Es normal en concurrencia y se
    resuelve reintentando la transacción completa desde cero, con una
    pequeña espera aleatoria para que los procesos no choquen otra vez
    en el mismo instante."""
    
    for intento in range(1, intentos + 1):
        try:
            guardar_fila(con, dict(fila))
            return
        except Exception as e:
            con.rollback()
            if e.errno in (1213, 1205) and intento < intentos:
                espera = round(random.uniform(0.5, 1.5) * intento, 2)
                logger.warning("    deadlock/lock-timeout guardando %s (intento %s/%s), reintentando en %ss",
                               fila.get("nomenclatura"), intento, intentos, espera)
                time.sleep(espera)
                continue
            raise

# ---------- utilidades de matching de texto (combo Tipo de Selección) ----------

def obtener_opciones(select_locator):
    return select_locator.evaluate(
        "(el) => Array.from(el.options).map(o => ({value: o.value, text: o.textContent}))"
    )


def elegir_opcion(select_locator, texto_deseado: str, nombre_campo: str):
    """Selecciona una opción de un combo PrimeFaces con clic REAL sobre el
    widget (abrir panel -> clic en el <li>) y verifica que tanto el <select>
    oculto como la etiqueta visible quedaron en lo pedido. Reintenta hasta 4
    veces. Match EXACTO (sin difuso): si la opción no existe, falla."""
    page = select_locator.page
    objetivo = normalizar(texto_deseado)
    opciones = obtener_opciones(select_locator)

    idx = next((i for i, o in enumerate(opciones) if normalizar(o["text"]) == objetivo), None)
    if idx is None:
        logger.error("No encontré la opción exacta '%s' en el combo '%s'. Opciones disponibles:",
                     texto_deseado, nombre_campo)
        for o in opciones:
            logger.error("  value=%r texto=%r", o["value"], o["text"])
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
            logger.warning("  [combo '%s'] intento %s/4 con problemas: %s", nombre_campo, intento, e)
            try:
                page.keyboard.press("Escape")
            except Exception:
                pass
        page.wait_for_timeout(800)
        try:
            page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
        except Exception:
            pass

    if esta_ok():
        return
    valor, etiqueta = estado_actual()
    raise RuntimeError(
        f"No se pudo fijar '{texto_deseado}' en el combo '{nombre_campo}' tras 4 intentos "
        f"(quedó value={valor!r}, etiqueta={etiqueta!r})"
    )

# ---------- interacción con la página: pestaña y combos ----------

def activar_pestana_buscador(page):
    tab = page.locator("a[href='#tbBuscador:tab1']")
    tab.first.wait_for(state="visible", timeout=TIMEOUT_MS)
    tab.first.click()
    page.wait_for_timeout(500)


def seleccionar_por_id_estable(page, id_widget_termina_en: str, texto_opcion: str):
    select = page.locator(f"select[id$='{id_widget_termina_en}_input']")
    select.wait_for(state="attached", timeout=TIMEOUT_MS)
    elegir_opcion(select, texto_opcion, id_widget_termina_en)
    page.wait_for_timeout(300)


def seleccionar_por_etiqueta(page, texto_etiqueta: str, texto_opcion: str):
    # OJO: el SEACE tiene varios formularios superpuestos en la misma
    # página (ej. 'idFormBuscarProceso' -que es el que usamos, con el
    # catálogo completo de modalidades- e 'idFormbuscarACF' -oculto,
    # con solo 8 modalidades reducidas-). Ambos tienen un <span> que
    # dice "Tipo de Selección", así que filtramos el <select> por id
    # para quedarnos SOLO con el del formulario correcto.
    select = page.locator(
        f"xpath=//span[contains(normalize-space(.), '{texto_etiqueta}')]"
        f"/ancestor::tr[1]//select[contains(@id, 'idFormBuscarProceso')]"
    ).first
    select.wait_for(state="attached", timeout=TIMEOUT_MS)
    elegir_opcion(select, texto_opcion, texto_etiqueta)
    page.wait_for_timeout(300)
    # Verificación: confirma qué quedó realmente seleccionado en el <select>
    # oculto, para poder comparar contra lo que pediste si algo sale raro.
    seleccionado = select.evaluate("(el) => el.options[el.selectedIndex]?.textContent")
    logger.info("    [verificación] '%s' -> combo quedó en: %r", texto_etiqueta, seleccionado)


def esperar_challenge_visual(page):
    try:
        challenge = page.locator("iframe[title*='recaptcha challenge']")
        if challenge.count() > 0 and challenge.first.is_visible():
            logger.info("Apareció un challenge visual de reCAPTCHA. Resuélvelo en la ventana del navegador.")
            input("Presiona Enter aquí para continuar...")
    except Exception:
        pass


# ---------- tabla de resultados (acotada a su contenedor) ----------

def obtener_contenedor_tabla(page):
    contenedor = page.locator("div[id$=':dtProcesos']")
    contenedor.first.wait_for(state="attached", timeout=TIMEOUT_MS)
    return contenedor.first


def extraer_filas_tabla(contenedor, modalidad: str, anio: str):
    """Columnas reales de la tabla (0-index):
    0 N° | 1 Entidad | 2 Fecha y Hora Publicación | 3 Nomenclatura |
    4 Reiniciado Desde | 5 Objeto de Contratación | 6 Descripción de
    Objeto | 7 Código SNIP | 8 Código Único de Inversión |
    9 VR/VE/Cuantía | 10 Moneda | 11 Versión SEACE | 12 Acciones."""
    filas = contenedor.locator("tbody[id$=':dtProcesos_data'] > tr")
    n = filas.count()
    for i in range(n):
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

        # nomenclatura no es única entre modalidades/años en algunos casos raros,
        # así que el ocid incluye año + modalidad para no chocar entre corridas.
        base_id = nomenclatura or f"{entidad}-{fecha_txt}"
        ocid = f"seace-live-{anio}-{re.sub(r'[^A-Za-z0-9-]+', '-', base_id)}"[:120]

        fecha_dt = parsear_fecha(fecha_txt)
        fecha_mysql = fecha_dt.strftime("%Y-%m-%d %H:%M:%S") if fecha_dt else None

        yield {
            "ocid": ocid,
            "tender_id": recortar(nomenclatura, 50),
            "titulo": (descripcion or objeto)[:250] if (descripcion or objeto) else None,
            "descripcion": descripcion or None,
            "entidad": recortar(entidad, 255),
            "modalidad": recortar(modalidad, 150),
            "categoria": mapear_categoria(objeto),
            "fecha_convocatoria": fecha_mysql,
            "monto": limpiar_monto(valor_txt),
            "moneda": normalizar_moneda(moneda),
            "estado": "vigente",
            "published_date": fecha_mysql,
            "nomenclatura": recortar(nomenclatura, 180),
            "raw_json": None,  # se completa en buscar_modalidad() con json.dumps
            "_objeto_texto": objeto,
        }


# ---------- Ficha de Selección: entrar, leer, volver ----------

def leer_campo_ficha(page, etiqueta: str):
    span = page.locator(f"xpath=//span[contains(normalize-space(text()), '{etiqueta}')]").first
    if span.count() == 0:
        return None
    td_valor = span.locator("xpath=ancestor::td[1]/following-sibling::td[1]").first
    if td_valor.count() == 0:
        return None
    try:
        texto = td_valor.inner_text().strip()
        return texto or None
    except Exception:
        return None


def leer_descripcion_completa(page):
    dialogo = page.locator("[id$=':dialogDescObj'] .ui-dialog-content").first
    if dialogo.count() == 0:
        return None
    try:
        texto = dialogo.inner_text().strip()
        return texto or None
    except Exception:
        return None


def _nombre_seguro(texto: str, maximo: int = 120) -> str:
    limpio = re.sub(r"[^A-Za-z0-9._-]+", "_", texto or "").strip("._")
    return limpio[:maximo] or "archivo"


def obtener_url_documento_fila(page, fila, ocid: str, nro: str):
    """Captura una URL de documento para abrirla en el navegador, sin guardarla localmente."""
    candidatos = fila.locator("a, button, input[type='image'], img")
    total = min(candidatos.count(), 3)
    for i in range(total):
        elemento = candidatos.nth(i)
        try:
            href = elemento.get_attribute("href")
            if href and not href.strip().lower().startswith(("javascript:", "#", "blob:")):
                url_abs = page.evaluate("(u) => new URL(u, location.href).href", href)
                atributos = []
                for attr in ("download", "title", "aria-label", "data-filename", "data-original-title"):
                    try:
                        valor = elemento.get_attribute(attr)
                        if valor:
                            atributos.append(valor.strip())
                    except Exception:
                        pass
                nombre = next((v for v in atributos if re.search(r"\\.(pdf|docx?|xlsx?|zip|rar|7z)$", v, re.I)), None)
                if not nombre:
                    try:
                        from urllib.parse import urlparse, parse_qs, unquote
                        u = urlparse(url_abs)
                        for clave in ("fileName", "filename", "file", "nombreArchivo", "name"):
                            vals = parse_qs(u.query).get(clave)
                            if vals:
                                cand = unquote(vals[0]).split("/")[-1]
                                if re.search(r"\\.(pdf|docx?|xlsx?|zip|rar|7z)$", cand, re.I):
                                    nombre = cand
                                    break
                        if not nombre:
                            cand = unquote(u.path.rsplit("/", 1)[-1])
                            if re.search(r"\\.(pdf|docx?|xlsx?|zip|rar|7z)$", cand, re.I):
                                nombre = cand
                    except Exception:
                        pass
                _ESTADO_DESCARGA["nombre_archivo"] = nombre or (atributos[0] if atributos else "")
                _ESTADO_DESCARGA["formato"] = os.path.splitext(nombre or "")[1].lower().lstrip(".")
                return url_abs
        except Exception:
            pass

    ganador = _ESTADO_DESCARGA.get("ganador")
    orden = list(range(total))
    if ganador is not None and ganador in orden:
        orden.remove(ganador)
        orden.insert(0, ganador)
    for k in orden:
        try:
            with page.expect_download(timeout=5000) as info:
                candidatos.nth(k).click()
            descarga = info.value
            url = getattr(descarga, "url", None)
            nombre_archivo = getattr(descarga, "suggested_filename", None)
            if url and not url.lower().startswith("blob:"):
                _ESTADO_DESCARGA["ganador"] = k
                _ESTADO_DESCARGA["nombre_archivo"] = nombre_archivo or ""
                _ESTADO_DESCARGA["formato"] = os.path.splitext(nombre_archivo or "")[1].lower().lstrip(".")
                logger.info("    documento %s: enlace capturado (%s); cancelando descarga temporal", nro, nombre_archivo or "nombre desconocido")
                try:
                    descarga.cancel()
                except Exception:
                    pass
                return url
        except Exception:
            continue
    try:
        logger.info("    documento %s: no se encontró URL directa; revisar atributos de la fila", nro)
        logger.debug("    HTML fila: %s", fila.evaluate("(el) => el.outerHTML")[:1500])
    except Exception:
        pass
    return None


def extraer_documentos_ficha(page, ocid: str):
    docs = []
    filas = page.locator("tbody[id$=':dtDocumentos_data'] > tr")
    n = filas.count()
    for i in range(n):
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
                "tamano": tds.nth(3).inner_text().strip(),
                "nombre_archivo": None,
                "formato": None,
                "fecha_publicacion": tds.nth(4).inner_text().strip(),
                "ruta_local": None,
                "url_documento": None,
            }
        except Exception:
            continue

        # Capturar URL para abrir el documento en el navegador, sin guardar el archivo.
        try:
            _ESTADO_DESCARGA["nombre_archivo"] = ""
            _ESTADO_DESCARGA["formato"] = ""
            doc["url_documento"] = obtener_url_documento_fila(page, fila, ocid, doc["nro"])
            doc["nombre_archivo"] = _ESTADO_DESCARGA.get("nombre_archivo") or None
            doc["formato"] = _ESTADO_DESCARGA.get("formato") or None
        except Exception as e:
            logger.warning("    documento %s: no se pudo obtener URL -> %s", doc["nro"], e)

        docs.append(doc)
    return docs


def extraer_cronograma_ficha(page):
    """Lee la tabla de Cronograma de la Ficha de Selección
    (div[id$=':dtCronograma']). El SEACE marca con clase CSS 'active'
    en el <tr> la(s) etapa(s) vigente(s) ahora mismo — puede haber más
    de una etapa activa a la vez (ej. 'Registro de participantes' y
    'Formulación de consultas' corriendo en paralelo), por eso se
    guarda es_etapa_actual fila por fila y no como un flag único."""
    filas = page.locator("tbody[id$=':dtCronograma_data'] > tr")
    n = filas.count()
    cronograma = []
    for i in range(n):
        tr = filas.nth(i)
        tds = tr.locator("td")
        if tds.count() < 3:
            continue
        try:
            clase = tr.get_attribute("class") or ""
            es_actual = 1 if "active" in clase.split() else 0

            # La celda de etapa trae un <br> + un <span> casi siempre
            # vacío (a veces con "SEACE" adentro) — nos quedamos solo
            # con la primera línea de texto, que es el nombre real.
            lineas_etapa = [l.strip() for l in tds.nth(0).inner_text().splitlines() if l.strip()]
            etapa = lineas_etapa[0] if lineas_etapa else ""

            lineas_inicio = [l.strip() for l in tds.nth(1).inner_text().splitlines() if l.strip()]
            fecha_inicio_txt = lineas_inicio[0] if lineas_inicio else ""

            # La celda de fecha fin trae un <div style="float:right">
            # vacío pegado al lado — mismo truco: solo la primera línea.
            lineas_fin = [l.strip() for l in tds.nth(2).inner_text().splitlines() if l.strip()]
            fecha_fin_txt = lineas_fin[0] if lineas_fin else ""

            fecha_inicio_dt = parsear_fecha(fecha_inicio_txt)
            fecha_fin_dt = parsear_fecha(fecha_fin_txt)

            cronograma.append({
                "etapa": recortar(etapa, 150),
                "fecha_inicio": fecha_inicio_dt.strftime("%Y-%m-%d %H:%M:%S") if fecha_inicio_dt else None,
                "fecha_fin": fecha_fin_dt.strftime("%Y-%m-%d %H:%M:%S") if fecha_fin_dt else None,
                "es_etapa_actual": es_actual,
            })
        except Exception as e:
            logger.warning("    no se pudo leer una fila del cronograma: %s", e)
            continue
    return cronograma


def extraer_detalle_ficha(page, ocid: str):
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
    return detalle, extraer_documentos_ficha(page, ocid), extraer_cronograma_ficha(page)


def visitar_ficha_de_fila(page, contenedor, indice_fila: int, ocid: str):
    fila = contenedor.locator("tbody[id$=':dtProcesos_data'] > tr").nth(indice_fila)
    boton_ficha = fila.locator("img[id*='grafichaSel']").first
    if boton_ficha.count() == 0:
        raise RuntimeError("no encontré el ícono de 'Ver Ficha de Selección' en esta fila")

    t_inicio = time.monotonic()
    boton_ficha.scroll_into_view_if_needed()
    try:
        with page.expect_navigation(timeout=8000):
            boton_ficha.click()
    except PWTimeout:
        pass

    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    ficha = page.locator("[id$=':pnlContenedorGral']")
    ficha.first.wait_for(state="visible", timeout=TIMEOUT_MS)

    t_abierta = time.monotonic()
    detalle, documentos, cronograma = extraer_detalle_ficha(page, ocid)
    logger.info("    tiempos: abrir ficha %.1fs | leer documentos %.1fs",
                t_abierta - t_inicio, time.monotonic() - t_abierta)

    boton_regresar = page.get_by_text("Regresar", exact=True).first
    boton_regresar.click()
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)

    return detalle, documentos, cronograma


def existe_en_api(con, nomenclatura: str) -> bool:
    """True si seace_sync.py ya trajo este proceso desde la API OCDS."""
    if not nomenclatura:
        return False
    cur = con.cursor(buffered=True)
    try:
        cur.execute(
            "SELECT 1 FROM seace_procesos WHERE nomenclatura = %s AND origen = 'api' LIMIT 1",
            (nomenclatura,),
        )
        return cur.fetchone() is not None
    finally:
        cur.close()


def ocid_de_api(con, nomenclatura: str):
    """(ocid, tender_id) del proceso oficial de la API con esa nomenclatura, o None."""
    if not nomenclatura:
        return None
    cur = con.cursor(buffered=True)
    try:
        cur.execute(
            "SELECT ocid, tender_id FROM seace_procesos WHERE nomenclatura = %s AND origen = 'api' LIMIT 1",
            (nomenclatura,),
        )
        return cur.fetchone()
    finally:
        cur.close()


def ya_tiene_ficha_completa(con, ocid: str) -> bool:
    """True si el proceso ya tiene su ficha guardada y (si estamos
    descargando archivos) ningún documento le falta por bajar."""
    cur = con.cursor(buffered=True)
    try:
        cur.execute("SELECT 1 FROM seace_detalle_ficha WHERE ocid = %s LIMIT 1", (ocid,))
        if cur.fetchone() is None:
            return False
        if DESCARGAR_DOCUMENTOS:
            sql_docs = "SELECT 1 FROM seace_documentos WHERE ocid = %s AND ruta_local IS NULL"
            params_docs = [ocid]
            if SOLO_BASES:
                # solo importan las Bases: los demás documentos nunca se descargan
                sql_docs += " AND LOWER(documento) LIKE %s"
                params_docs.append("%bases%")
            cur.execute(sql_docs + " LIMIT 1", params_docs)
            if cur.fetchone() is not None:
                return False
        return True
    finally:
        cur.close()


def proceso_finalizado(con, tender_id: str) -> bool:
    """True SOLO si ya sabemos con certeza que el cronograma de este
    proceso terminó (su última fecha_fin ya pasó, con margen de
    MARGEN_DIAS_TRAS_CIERRE días). Si no hay cronograma guardado
    todavía, o si la última etapa sigue vigente o es futura, devuelve
    False: hay que seguir revisando ese proceso porque sus etapas o
    documentos todavía pueden cambiar."""
    if not tender_id:
        return False
    cur = con.cursor(buffered=True)
    try:
        cur.execute(
            "SELECT MAX(fecha_fin) FROM seace_cronograma_fases WHERE tender_id = %s",
            (tender_id,),
        )
        fila = cur.fetchone()
        fecha_fin_max = fila[0] if fila else None
        if fecha_fin_max is None:
            return False  # sin cronograma conocido: no está confirmado que terminó
        return fecha_fin_max < (datetime.now() - timedelta(days=MARGEN_DIAS_TRAS_CIERRE))
    finally:
        cur.close()



def calcular_hash_ficha(detalle: dict, documentos: list, cronograma: list) -> str:
    """Huella de todo lo que se sabe de un proceso. Si cambia una etapa,
    se sube un documento nuevo, o se corrige una fecha, el hash cambia."""
    partes = [
        str(sorted((detalle or {}).items())),
        str(sorted((d.get("documento"), d.get("archivo"), d.get("fecha_publicacion")) for d in (documentos or []))),
        str(sorted((c.get("etapa"), c.get("fecha_inicio"), c.get("fecha_fin")) for c in (cronograma or []))),
    ]
    return hashlib.sha256("|".join(partes).encode("utf-8")).hexdigest()


def debe_revisar_ficha(con, ocid: str) -> bool:
    """True si nunca se revisó, o si ya pasó su fecha de próxima_revision."""
    cur = con.cursor(buffered=True)
    try:
        cur.execute("SELECT proxima_revision FROM seace_procesos WHERE ocid = %s", (ocid,))
        fila = cur.fetchone()
        if fila is None or fila[0] is None:
            return True  # nunca evaluado -> revisar
        return datetime.now() >= fila[0]
    finally:
        cur.close()


def actualizar_backoff(con, ocid: str, hash_nuevo: str):
    """Compara el hash nuevo contra el guardado. Si cambió (o es la
    primera vez), reinicia el backoff corto porque el proceso sigue
    'vivo'. Si NO cambió, duplica el intervalo hasta el máximo."""
    cur = con.cursor(buffered=True)
    try:
        cur.execute("SELECT hash_ficha, proxima_revision FROM seace_procesos WHERE ocid = %s", (ocid,))
        fila = cur.fetchone()
        hash_anterior = fila[0] if fila else None

        if hash_anterior == hash_nuevo and hash_anterior is not None:
            # nada cambió: calcula cuánto duró el último intervalo y lo duplica
            cur.execute("SELECT proxima_revision FROM seace_procesos WHERE ocid = %s", (ocid,))
            prox_anterior = cur.fetchone()[0]
            dias_previos = REVISION_INICIAL_DIAS
            if prox_anterior:
                dias_previos = max(1, (prox_anterior - datetime.now()).days + REVISION_INICIAL_DIAS)
            nuevos_dias = min(REVISION_MAXIMA_DIAS, dias_previos * FACTOR_BACKOFF)
        else:
            nuevos_dias = REVISION_INICIAL_DIAS  # cambió algo -> vigilarlo de cerca otra vez

        proxima = datetime.now() + timedelta(days=nuevos_dias)
        cur.execute(
            "UPDATE seace_procesos SET hash_ficha = %s, proxima_revision = %s WHERE ocid = %s",
            (hash_nuevo, proxima, ocid),
        )
        con.commit()
    finally:
        cur.close()

# ---------- búsqueda + paginación + (opcional) fichas ----------
def buscar_modalidad(page, anio: str, modalidad: str, con_detalle: bool = True):
    """Extrae resultados, fichas, documentos y cronogramas solo en memoria.
    No consulta ni escribe en ninguna base de datos."""
    import json

    logger.info("== Buscando: %s — año %s ==", modalidad, anio)
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))
    seleccionar_por_etiqueta(page, "Tipo de Selección", modalidad)
    seleccionar_por_id_estable(page, ":anioConvocatoria", str(anio))

    boton_buscar = page.locator("button[id$=':btnBuscarSelToken']")
    boton_buscar.wait_for(state="visible", timeout=TIMEOUT_MS)
    boton_buscar.click()
    page.wait_for_timeout(1500)
    esperar_challenge_visual(page)
    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
    page.wait_for_selector("tbody[id$=':dtProcesos_data']", timeout=TIMEOUT_MS)

    estado = {"filas": 0, "texto": ""}
    for _ in range(15):
        estado = page.evaluate("""() => {
            const tb = document.querySelector("tbody[id$=':dtProcesos_data']");
            if (!tb) return {filas: 0, texto: '(no hay tbody)'};
            const trs = Array.from(tb.querySelectorAll(':scope > tr'));
            const reales = trs.filter(tr => tr.querySelectorAll(':scope > td').length >= 13).length;
            return {filas: reales, texto: (tb.innerText || '').trim().slice(0, 300)};
        }""")
        if estado["filas"] > 0:
            break
        page.wait_for_timeout(1000)

    if estado["filas"] == 0:
        logger.warning("No aparecieron filas para '%s'. Texto mostrado por SEACE: %r", modalidad, estado["texto"])
        return 0

    pagina = 1
    total_filas = 0
    while True:
        contenedor = obtener_contenedor_tabla(page)
        filas_pagina = list(extraer_filas_tabla(contenedor, modalidad, anio))
        try:
            resumen = contenedor.locator("span.ui-paginator-current").first.inner_text(timeout=2000).strip()
        except Exception:
            resumen = ""
        logger.info("Página %s: %s filas | %s", pagina, len(filas_pagina), resumen)

        for idx, fila in enumerate(filas_pagina):
            objeto_texto = fila.pop("_objeto_texto", None)
            fila["objeto"] = objeto_texto
            # El identificador solo organiza el resultado en memoria; no se guarda en SQL.
            detalle, documentos, cronograma = {}, [], []
            if con_detalle:
                try:
                    contenedor = obtener_contenedor_tabla(page)
                    detalle, documentos, cronograma = visitar_ficha_de_fila(
                        page, contenedor, idx, fila.get("ocid", "")
                    )
                    logger.info("  Ficha %s: %s documentos listados, %s etapas del cronograma",
                                fila.get("nomenclatura") or '(sin nomenclatura)', len(documentos), len(cronograma))
                except Exception as e:
                    logger.warning("  No se pudo leer la ficha de %s: %s", fila.get("nomenclatura"), e)

            resultado = {
                **fila,
                "detalle_ficha": detalle,
                "documentos": documentos,
                "cronograma": cronograma,
            }
            # Una línea JSON por proceso: la ventana de escritorio la interpreta y presenta.
            print("RESULTADO_JSON:" + json.dumps(resultado, ensure_ascii=False, default=str), flush=True)
            total_filas += 1

        contenedor = obtener_contenedor_tabla(page)
        boton_next = contenedor.locator("span.ui-paginator-next, a.ui-paginator-next")
        if boton_next.count() == 0:
            break
        clase = boton_next.first.get_attribute("class") or ""
        if "ui-state-disabled" in clase:
            break
        boton_next.first.click()
        page.wait_for_timeout(int(PAUSA_ENTRE_ACCIONES * 1000))
        page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
        pagina += 1

    logger.info("Modalidad '%s' finalizada: %s procesos extraídos", modalidad, total_filas)
    return total_filas


# ---------- ejecución secuencial para prueba de escritorio, sin BD ----------
def ejecutar_prueba(anio: str, headless: bool = True, con_detalle: bool = True):
    total = 0
    logger.info("Modo de prueba SIN MySQL. Año %s. Fichas: %s", anio, "sí" if con_detalle else "no")
    logger.info("Documentos: apertura por navegador; no se guardan archivos locales")
    with sync_playwright() as p:
        for indice, modalidad in enumerate(MODALIDADES_MAYORES, start=1):
            logger.info("Modalidad %s/%s: %s", indice, len(MODALIDADES_MAYORES), modalidad)
            browser = None
            ultimo_error = None
            for intento in range(1, 3):
                try:
                    browser = p.chromium.launch(headless=headless, proxy=config_proxy())
                    page = browser.new_page(accept_downloads=False)
                    page.goto(URL_BUSCADOR, timeout=TIMEOUT_MS)
                    page.wait_for_load_state("networkidle", timeout=TIMEOUT_MS)
                    activar_pestana_buscador(page)
                    total += buscar_modalidad(page, anio, modalidad, con_detalle)
                    ultimo_error = None
                    break
                except Exception as e:
                    ultimo_error = e
                    logger.error("Intento %s/2 falló en '%s': %s", intento, modalidad, e)
                    if intento < 2:
                        time.sleep(3)
                finally:
                    if browser is not None:
                        try:
                            browser.close()
                        except Exception:
                            pass
                        browser = None
            if ultimo_error:
                logger.error("Se omite la modalidad '%s' tras los reintentos: %s", modalidad, ultimo_error)
    logger.info("PRUEBA FINALIZADA. Total de procesos extraídos: %s", total)
    return total


def main():
    ap = argparse.ArgumentParser(description="Extractor de SEACE para pruebas, sin conexión a base de datos")
    ap.add_argument("--anio", default="2026")
    ap.add_argument("--headless", default="true", choices=["true", "false"])
    ap.add_argument("--detalle", default="true", choices=["true", "false"])
    args = ap.parse_args()
    ejecutar_prueba(args.anio, headless=(args.headless == "true"), con_detalle=(args.detalle == "true"))
    return 0


if __name__ == "__main__":
    sys.exit(main() or 0)
