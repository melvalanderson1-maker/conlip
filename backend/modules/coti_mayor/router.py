import json
import logging
from urllib.parse import quote, urlparse

from curl_cffi import requests as cffi_requests
from fastapi import APIRouter, Depends, HTTPException, Query, Response

from core.db import abrir_db
from core.seguridad import requiere_permiso
from datetime import datetime, timedelta

from modules.coti_mayor.scraper_live import PERU, URL_BUSCADOR, config_proxy
from modules.coti_mayor import postores as postores_mod

logger = logging.getLogger("coti_mayor")

VER = Depends(requiere_permiso("mayor:ver"))

router = APIRouter(prefix="/api/mayor", tags=["coti-mayor"], dependencies=[VER])

MAX_DOC_BYTES = 80 * 1024 * 1024
MIME_POR_FORMATO = {"pdf": "application/pdf", "png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg"}

FUENTE_SQL = """CASE WHEN p.origen = 'api' AND p.ficha_en IS NOT NULL THEN 'ambos'
                      WHEN p.origen = 'api' THEN 'sync'
                      ELSE 'live' END"""



ESTADO_SQL = """CASE
  WHEN p.estado = 'con_resultado'
       OR EXISTS (SELECT 1 FROM mayor_adjudicaciones a WHERE a.ocid = p.ocid) THEN 'adjudicado'
  WHEN p.tiene_indicio_desierto = 1 THEN 'desierto'
  WHEN jsonb_array_length(COALESCE(p.cronograma, '[]'::jsonb)) > 0 THEN
    CASE
      WHEN (SELECT MAX((e->>'fecha_fin')::timestamp) FROM jsonb_array_elements(p.cronograma) e)
           < (now() AT TIME ZONE 'America/Lima') THEN 'concluido'
      WHEN (SELECT MIN((e->>'fecha_inicio')::timestamp) FROM jsonb_array_elements(p.cronograma) e)
           > (now() AT TIME ZONE 'America/Lima') THEN 'por_iniciar'
      ELSE 'vigente'
    END
  WHEN p.estado = 'vigente' THEN 'vigente'
  WHEN p.estado = 'vencido_sin_resultado' THEN 'concluido'
  ELSE 'sin_estado'
END"""

def _proxies_cffi():
    c = config_proxy()
    if not c:
        return None
    srv = c["server"] if "://" in c["server"] else "http://" + c["server"]
    u = urlparse(srv)
    url = f"{u.scheme}://{quote(c['username'] or '', safe='')}:{quote(c['password'] or '', safe='')}@{u.netloc}"
    return {"http": url, "https": url}


def _lista_docs(valor):
    if isinstance(valor, str):
        try:
            valor = json.loads(valor)
        except ValueError:
            return []
    return valor or []

ORDENES = {
    "recientes": "fecha_convocatoria DESC NULLS LAST, primera_vez DESC",
    "antiguas": "fecha_convocatoria ASC NULLS LAST, primera_vez ASC",
    "vence_pronto": "proximo_hito ASC NULLS LAST, fecha_convocatoria DESC NULLS LAST",
    "vence_tarde": "proximo_hito DESC NULLS LAST, fecha_convocatoria DESC NULLS LAST",
    "monto_mayor": "monto DESC NULLS LAST, fecha_convocatoria DESC NULLS LAST",
    "monto_menor": "monto ASC NULLS LAST, fecha_convocatoria DESC NULLS LAST",
    "nuevas": "primera_vez DESC",
}
AHORA_LIMA = "(now() AT TIME ZONE 'America/Lima')"
_CRONO = "jsonb_array_elements(COALESCE(p.cronograma, '[]'::jsonb)) e"


@router.get("/procesos")
def listar(q: str = "", modalidad: str = "", categoria: str = "", estado: str = "",
           orden: str = "recientes", publicado_dias: int = Query(0, ge=0, le=3650),
           monto_min: float | None = None, monto_max: float | None = None,
           page: int = Query(1, ge=1), page_size: int = Query(24, ge=1, le=100)):
    donde, p = [], []
    if q.strip():
        like = f"%{q.strip()}%"
        donde.append("(nomenclatura ILIKE ? OR entidad ILIKE ? OR descripcion ILIKE ?)")
        p += [like, like, like]
    if modalidad:
        donde.append("modalidad = ?")
        p.append(modalidad)
    if categoria:
        donde.append("categoria = ?")
        p.append(categoria)
    if estado:
        donde.append("estado_calc = ?")
        p.append(estado)
    if publicado_dias:
        donde.append("fecha_convocatoria >= ?")
        p.append(datetime.now(PERU).replace(tzinfo=None) - timedelta(days=publicado_dias))
    if monto_min is not None:
        donde.append("monto >= ?")
        p.append(monto_min)
    if monto_max is not None:
        donde.append("monto <= ?")
        p.append(monto_max)
    w = ("WHERE " + " AND ".join(donde)) if donde else ""
    orden_sql = ORDENES.get(orden, ORDENES["recientes"])
    base = f"""SELECT p.ocid, p.nomenclatura, p.titulo, p.descripcion, p.entidad, p.modalidad, p.categoria,
                      p.fecha_convocatoria, p.monto, p.moneda, p.primera_vez, p.ficha_en,
                      COALESCE(jsonb_array_length(p.documentos), 0) AS n_docs,
                      (SELECT e->>'etapa' FROM {_CRONO}
                        WHERE (e->>'fecha_inicio')::timestamp <= {AHORA_LIMA}
                          AND (e->>'fecha_fin')::timestamp >= {AHORA_LIMA}
                        ORDER BY (e->>'fecha_inicio')::timestamp DESC LIMIT 1) AS etapa_actual,
                      (SELECT MIN((e->>'fecha_fin')::timestamp) FROM {_CRONO}
                        WHERE (e->>'fecha_fin')::timestamp > {AHORA_LIMA}) AS proximo_hito,
                      (SELECT e->>'etapa' FROM {_CRONO}
                        WHERE (e->>'fecha_fin')::timestamp > {AHORA_LIMA}
                        ORDER BY (e->>'fecha_fin')::timestamp ASC LIMIT 1) AS proximo_hito_etapa,
                      (SELECT a.proveedor FROM mayor_adjudicaciones a
                        WHERE a.ocid = p.ocid ORDER BY a.id LIMIT 1) AS ganador,
                      {FUENTE_SQL} AS fuente,
                      {ESTADO_SQL} AS estado_calc
               FROM procesos_mayor p"""
    con = abrir_db()
    try:
        total = con.execute(f"SELECT COUNT(*) AS n FROM ({base}) t {w}", tuple(p)).fetchone()["n"]
        filas = con.execute(
            f"""SELECT * FROM ({base}) t {w}
                ORDER BY {orden_sql}
                LIMIT ? OFFSET ?""",
            tuple(p) + (page_size, (page - 1) * page_size),
        ).fetchall()
        return {"total": total, "items": [dict(f) for f in filas]}
    finally:
        con.close()

@router.get("/stats")
def stats():
    con = abrir_db()
    try:
        total = con.execute("SELECT COUNT(*) AS n FROM procesos_mayor").fetchone()["n"]
        hoy = con.execute(
            "SELECT COUNT(*) AS n FROM procesos_mayor WHERE primera_vez >= now() - interval '24 hours'"
        ).fetchone()["n"]
        pm = con.execute(
            "SELECT modalidad AS k, COUNT(*) AS n FROM procesos_mayor GROUP BY modalidad"
        ).fetchall()
        pe = con.execute(
            f"SELECT estado_calc AS k, COUNT(*) AS n FROM (SELECT {ESTADO_SQL} AS estado_calc FROM procesos_mayor p) t GROUP BY estado_calc"
        ).fetchall()
        return {"total": total, "hoy": hoy,
                "por_modalidad": {r["k"]: r["n"] for r in pm},
                "por_estado": {r["k"]: r["n"] for r in pe}}
    finally:
        con.close()


@router.get("/cambios")
def cambios():
    """Consulta liviana: el frontend la usa para saber si hay algo nuevo sin recargar la lista."""
    con = abrir_db()
    try:
        r = con.execute(
            """SELECT COUNT(*) AS total,
                      MAX(primera_vez) AS m_primera,
                      MAX(ficha_en) AS m_ficha,
                      MAX(published_date) AS m_pub,
                      MAX(actualizado_en) AS m_act
               FROM procesos_mayor"""
        ).fetchone()
        return {"total": r["total"],
                "version": f"{r['total']}|{r['m_primera']}|{r['m_ficha']}|{r['m_pub']}|{r['m_act']}"}
    finally:
        con.close()

@router.get("/procesos/{ocid}")
def detalle(ocid: str):
    con = abrir_db()
    try:
        r = con.execute(
            f"""SELECT p.*, {ESTADO_SQL} AS estado_calc, {FUENTE_SQL} AS fuente
                FROM procesos_mayor p WHERE p.ocid = ?""", (ocid,)
        ).fetchone()
        if r is None:
            raise HTTPException(status_code=404, detail="Proceso no encontrado")
        d = dict(r)
        if d.get("documentos") is not None:
            d["documentos"] = [
                {**{k: v for k, v in x.items() if k not in ("url_documento", "via")},
                 "visible": bool(x.get("url_documento"))}
                for x in _lista_docs(d["documentos"])
            ]
        adj = con.execute(
            """SELECT a.proveedor,
                      COALESCE(NULLIF(a.proveedor_ruc, ''),
                               (SELECT p.ruc FROM mayor_postores p
                                 WHERE p.ocid = a.ocid AND p.ruc IS NOT NULL
                                   AND lower(btrim(p.razon_social)) = lower(btrim(a.proveedor)) LIMIT 1)
                      ) AS proveedor_ruc,
                      a.monto, a.moneda, a.fecha_adjudicacion, a.estado_award
               FROM mayor_adjudicaciones a WHERE a.ocid = ? ORDER BY a.id""", (ocid,)
        ).fetchall()
        d["adjudicaciones"] = [dict(a) for a in adj]
        its = con.execute(
            """SELECT item_id, origen_item, descripcion, cantidad, unidad, monto_total,
                      precio_unitario, proveedor, proveedor_ruc
               FROM mayor_items WHERE ocid = ? ORDER BY origen_item, id LIMIT 500""", (ocid,)
        ).fetchall()
        d["items"] = [dict(i) for i in its]
        return d
    finally:
        con.close()


@router.get("/procesos/{ocid}/documentos/{idx}")
def ver_documento(ocid: str, idx: int):
    """Pide el archivo a SEACE y lo devuelve desde memoria (inline). No toca el disco."""
    con = abrir_db()
    try:
        r = con.execute("SELECT documentos FROM procesos_mayor WHERE ocid = ?", (ocid,)).fetchone()
    finally:
        con.close()
    docs = _lista_docs(r[0]) if r else []
    if idx < 0 or idx >= len(docs):
        raise HTTPException(404, "Documento no encontrado")
    d = docs[idx]
    url = d.get("url_documento")
    host = (urlparse(url or "").hostname or "").lower()
    if not url or not host.endswith("seace.gob.pe"):
        raise HTTPException(404, "Este documento aún no tiene enlace; se completa en el próximo ciclo del scraper")
    try:
        resp = cffi_requests.get(url, impersonate="chrome", timeout=60, proxies=_proxies_cffi(),
                                 headers={"referer": URL_BUSCADOR})
    except Exception as e:
        logger.warning("Documento %s[%s]: error de red: %s", ocid, idx, e)
        raise HTTPException(502, "No se pudo contactar a SEACE")
    ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    if resp.status_code != 200 or ctype == "text/html":
        logger.warning("Documento %s[%s]: SEACE respondió %s (%s) via=%s url=%s",
                       ocid, idx, resp.status_code, ctype, d.get("via"), url)
        raise HTTPException(502, "SEACE no entregó el archivo (el enlace pudo caducar)")
    if len(resp.content) > MAX_DOC_BYTES:
        raise HTTPException(413, "El archivo es demasiado grande para la vista previa")
    media = MIME_POR_FORMATO.get((d.get("formato") or "").lower()) or ctype or "application/octet-stream"
    nombre = d.get("nombre_archivo") or f"documento_{idx + 1}"
    return Response(content=resp.content, media_type=media,
                    headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(nombre)}"})


@router.get("/procesos/{ocid}/postores")
def postores_de(ocid: str):
    return postores_mod.obtener(ocid)


@router.post("/procesos/{ocid}/postores/actualizar")
def postores_actualizar(ocid: str, forzar: bool = False):
    """Lanza (si hace falta) la lectura de postores en SEACE. Un solo navegador a la vez."""
    con = abrir_db()
    try:
        r = con.execute("SELECT nomenclatura, ficha_en, entidad, fecha_convocatoria FROM procesos_mayor WHERE ocid = ?", (ocid,)).fetchone()
    finally:
        con.close()
    if not r or not r["nomenclatura"]:
        raise HTTPException(404, "Proceso no encontrado")
    return postores_mod.disparar(ocid, r["nomenclatura"], forzar, r["ficha_en"] is not None,
                                 r["entidad"], r["fecha_convocatoria"])


@router.get("/procesos/{ocid}/postores/{pid}/documentos/{idx}")
def ver_documento_postor(ocid: str, pid: int, idx: int):
    """Entrega desde memoria un documento de la oferta de un postor. No toca el disco."""
    con = abrir_db()
    try:
        r = con.execute("SELECT documentos FROM mayor_postores WHERE id = ? AND ocid = ?", (pid, ocid)).fetchone()
    finally:
        con.close()
    docs = _lista_docs(r[0]) if r else []
    if idx < 0 or idx >= len(docs):
        raise HTTPException(404, "Documento no encontrado")
    d = docs[idx]
    url = d.get("url_documento")
    host = (urlparse(url or "").hostname or "").lower()
    if not url or not host.endswith("seace.gob.pe"):
        raise HTTPException(404, "Este documento no tiene enlace disponible")
    try:
        resp = cffi_requests.get(url, impersonate="chrome", timeout=60, proxies=_proxies_cffi(),
                                 headers={"referer": URL_BUSCADOR})
    except Exception as e:
        logger.warning("Doc postor %s/%s[%s]: error de red: %s", ocid, pid, idx, e)
        raise HTTPException(502, "No se pudo contactar a SEACE")
    ctype = (resp.headers.get("content-type") or "").split(";")[0].strip().lower()
    if resp.status_code != 200 or ctype == "text/html":
        logger.warning("Doc postor %s/%s[%s]: SEACE respondió %s (%s) via=%s url=%s",
                       ocid, pid, idx, resp.status_code, ctype, d.get("via"), url)
        raise HTTPException(502, "SEACE no entregó el archivo (el enlace pudo caducar)")
    if len(resp.content) > MAX_DOC_BYTES:
        raise HTTPException(413, "El archivo es demasiado grande para la vista previa")
    media = MIME_POR_FORMATO.get((d.get("formato") or "").lower()) or ctype or "application/octet-stream"
    nombre = d.get("nombre_archivo") or f"oferta_{idx + 1}"
    return Response(content=resp.content, media_type=media,
                    headers={"Content-Disposition": f"inline; filename*=UTF-8''{quote(nombre)}"})

@router.get("/historial")
def historial_global(desde_id: int | None = None, limite: int = 50):
    """Sin desde_id: devuelve solo el último id (referencia). Con desde_id: los cambios posteriores."""
    con = abrir_db()
    try:
        if desde_id is None:
            r = con.execute("SELECT COALESCE(MAX(id), 0) AS n FROM procesos_mayor_historial").fetchone()
            return {"ultimo_id": r["n"], "items": []}
        rows = con.execute(
            """SELECT h.id, h.ocid, p.nomenclatura, p.entidad, h.tipo, h.detalle, h.creado_en
               FROM procesos_mayor_historial h JOIN procesos_mayor p USING (ocid)
               WHERE h.id > ? ORDER BY h.id LIMIT ?""",
            (desde_id, min(max(limite, 1), 200)),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("detalle"), str):
                d["detalle"] = json.loads(d["detalle"])
            items.append(d)
        return {"ultimo_id": items[-1]["id"] if items else desde_id, "items": items}
    finally:
        con.close()


@router.get("/procesos/{ocid}/historial")
def historial_proceso(ocid: str, limite: int = 30):
    con = abrir_db()
    try:
        rows = con.execute(
            """SELECT id, ocid, tipo, detalle, creado_en FROM procesos_mayor_historial
               WHERE ocid = ? ORDER BY id DESC LIMIT ?""",
            (ocid, min(max(limite, 1), 100)),
        ).fetchall()
        items = []
        for r in rows:
            d = dict(r)
            if isinstance(d.get("detalle"), str):
                d["detalle"] = json.loads(d["detalle"])
            items.append(d)
        return {"items": items}
    finally:
        con.close()