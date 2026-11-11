"""
Sync API OCDS (contratacionesabiertas.oece.gob.pe) -> Postgres.
Port a Postgres de seace_sync.py. Escribe en procesos_mayor, mayor_adjudicaciones y mayor_items.
Corre en un hilo (ver scraper.py).
"""
import json
import logging
import re
import os
import time
from datetime import date, datetime, timedelta, timezone

import httpx
from curl_cffi import requests as cffi_requests

from core.db import abrir_db
from modules.coti_mayor.scraper_live import PERU, normalizar

logger = logging.getLogger("coti_mayor")

BASE_URL = "https://contratacionesabiertas.oece.gob.pe/api/v1"
SOURCE = "seace_v3"
MODALIDADES_OK = ("licitacion publica", "concurso publico", "subasta inversa")
DESDE_DEFECTO = os.getenv("SYNC_MAYOR_DESDE") or f"{datetime.now(PERU).year}-01-01"


def _leer_estado(con):
    r = con.execute("SELECT ultima_fecha, cursor_url FROM mayor_sync_estado WHERE fuente=?", (SOURCE,)).fetchone()
    return (r[0], r[1]) if r else (None, None)


def _guardar_estado(con, ultima_fecha, cursor_url):
    con.execute(
        """INSERT INTO mayor_sync_estado (fuente, ultima_fecha, cursor_url) VALUES (?,?,?)
           ON CONFLICT (fuente) DO UPDATE SET
             ultima_fecha = COALESCE(EXCLUDED.ultima_fecha, mayor_sync_estado.ultima_fecha),
             cursor_url = EXCLUDED.cursor_url""",
        (SOURCE, ultima_fecha, cursor_url),
    )
    con.commit()


_RUC_RE = re.compile(r"(?<!\d)(?:10|15|16|17|20)\d{9}(?!\d)")
_RUC_DEBUG = {"n": 0}


def _ruc_directo(parte):
    if not parte:
        return None
    cands = [parte.get("identifier") or {}] + list(parte.get("additionalIdentifiers") or [])
    for i in cands:
        if i.get("scheme") == "PE-RUC" and i.get("id"):
            return str(i["id"]).strip()
    # el RUC a veces viene dentro del id, ej. "PE-RUC-20123456789"
    for texto in [i.get("id") for i in cands] + [parte.get("id")]:
        m = _RUC_RE.search(str(texto or ""))
        if m:
            return m.group(0)
    return None


def _ruc(parte, rel=None):
    """RUC de una parte. Si el proveedor no lo trae, se busca la misma parte en rel['parties'] (por id o nombre)."""
    r = _ruc_directo(parte)
    if r or not rel or not parte:
        return r
    pid, nombre = parte.get("id"), normalizar(parte.get("name") or "")
    for q in rel.get("parties") or []:
        if (pid is not None and q.get("id") == pid) or (nombre and normalizar(q.get("name") or "") == nombre):
            r = _ruc_directo(q)
            if r:
                return r
    if _RUC_DEBUG["n"] < 3:   # solo las 3 primeras veces, para diagnosticar
        _RUC_DEBUG["n"] += 1
        logger.info("Sin RUC para proveedor: %s | parties=%s",
                    json.dumps(parte, ensure_ascii=False)[:300],
                    json.dumps((rel.get("parties") or [])[:4], ensure_ascii=False)[:600])
    return None


def clasificar(release: dict) -> str:
    if release.get("awards") or release.get("contracts"):
        return "con_resultado"
    tender = release.get("tender") or {}
    limite = ((tender.get("enquiryPeriod") or {}).get("endDate")
              or (tender.get("tenderPeriod") or {}).get("endDate"))
    if limite:
        try:
            fin = datetime.fromisoformat(limite.replace("Z", "+00:00"))
            if fin.tzinfo is None:
                fin = fin.replace(tzinfo=PERU)
            if fin >= datetime.now(timezone.utc):
                return "vigente"
        except ValueError:
            pass
    return "vencido_sin_resultado"


def es_mayor(tender: dict) -> bool:
    m = normalizar(tender.get("procurementMethodDetails") or "")
    return any(k in m for k in MODALIDADES_OK)


def _clasif_item(item: dict):
    cubso = unspsc = None
    p = item.get("classification") or {}
    if p.get("scheme") == "CUBSO":
        cubso = p.get("id")
    elif p.get("scheme") == "UNSPSC":
        unspsc = p.get("id")
    for e in item.get("additionalClassifications", []) or []:
        if e.get("scheme") == "UNSPSC" and not unspsc:
            unspsc = e.get("id")
        elif e.get("scheme") == "CUBSO" and not cubso:
            cubso = e.get("id")
    return cubso, unspsc


def _guardar_items(con, ocid, items, origen, proveedor=None, ruc=None, fecha_adj=None):
    for it in items or []:
        cant = it.get("quantity")
        total = (it.get("totalValue") or {}).get("amount")
        unit = None
        if cant and total is not None:
            try:
                unit = float(total) / float(cant)
            except (ZeroDivisionError, TypeError, ValueError):
                unit = None
        cubso, unspsc = _clasif_item(it)
        con.execute(
            """INSERT INTO mayor_items
               (ocid, item_id, origen_item, descripcion, cantidad, monto_total, precio_unitario,
                unidad, cubso, unspsc, proveedor, proveedor_ruc, fecha_adjudicacion)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?::timestamptz)""",
            (ocid, str(it.get("id")) if it.get("id") is not None else None, origen,
             it.get("description"), cant, total, unit, (it.get("unit") or {}).get("name"),
             cubso, unspsc, proveedor, ruc, fecha_adj),
        )


def upsert_proceso(con, rel: dict):
    ocid = rel["ocid"]
    tender = rel.get("tender") or {}
    buyer = rel.get("buyer") or {}
    partes = rel.get("parties") or []
    p0 = partes[0] if partes else {}
    addr = p0.get("address") or {}
    desc = tender.get("description")
    nomen = tender.get("title")
    pub = tender.get("datePublished")
    anio = int(pub[:4]) if pub and pub[:4].isdigit() else datetime.now(PERU).year
    desierto = int(any("desierto" in (d.get("title") or "").lower() for d in tender.get("documents") or []))

    con.execute(
        """INSERT INTO procesos_mayor
           (ocid, tender_id, nomenclatura, anio, titulo, descripcion, entidad, entidad_ruc,
            region, departamento, distrito, modalidad, categoria, fecha_convocatoria,
            fecha_fin_consultas, monto, moneda, estado, tiene_indicio_desierto, published_date,
            origen, primera_vez)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::timestamp,?::timestamp,?,?,?,?,?::timestamptz,
                   'api', COALESCE(?::timestamptz, now()))
           ON CONFLICT (ocid) DO UPDATE SET
             tender_id=EXCLUDED.tender_id, nomenclatura=EXCLUDED.nomenclatura,
             titulo=EXCLUDED.titulo, descripcion=EXCLUDED.descripcion,
             region=EXCLUDED.region, departamento=EXCLUDED.departamento, distrito=EXCLUDED.distrito,
             fecha_fin_consultas=EXCLUDED.fecha_fin_consultas, estado=EXCLUDED.estado,
             tiene_indicio_desierto=EXCLUDED.tiene_indicio_desierto,
             published_date=EXCLUDED.published_date, origen='api', actualizado_en=now()
           WHERE procesos_mayor.published_date IS NULL
              OR EXCLUDED.published_date >= procesos_mayor.published_date""",
        (ocid, tender.get("id"), nomen, anio, ((desc or nomen or "")[:250] or None), desc,
         buyer.get("name"), _ruc(p0), addr.get("region"), addr.get("department"), addr.get("locality"),
         tender.get("procurementMethodDetails"), tender.get("mainProcurementCategory"), pub,
         (tender.get("enquiryPeriod") or {}).get("endDate"),
         (tender.get("value") or {}).get("amount_PEN"), "PEN" if (tender.get("value") or {}).get("amount_PEN") is not None else None,
         clasificar(rel), desierto, rel.get("publishedDate"), pub),
    )

    # Si el scraper ya había guardado este proceso con su ocid propio, se le pasa la ficha al oficial
    if nomen:
        con.execute(
            """UPDATE procesos_mayor a SET
                 detalle = COALESCE(a.detalle, s.detalle),
                 documentos = COALESCE(a.documentos, s.documentos),
                 cronograma = COALESCE(a.cronograma, s.cronograma),
                 ficha_en = COALESCE(a.ficha_en, s.ficha_en)
               FROM procesos_mayor s
               WHERE a.ocid = ? AND s.nomenclatura = ? AND s.origen = 'scraper' AND s.ocid <> a.ocid""",
            (ocid, nomen),
        )
        con.execute(
            "DELETE FROM procesos_mayor WHERE nomenclatura=? AND origen='scraper' AND ocid<>?",
            (nomen, ocid),
        )

    awards = rel.get("awards") or []
    if awards:
        con.execute("DELETE FROM mayor_adjudicaciones WHERE ocid=?", (ocid,))
        for aw in awards:
            sup = (aw.get("suppliers") or [{}])[0] or {}
            val = aw.get("value") or {}
            ruc_p = _ruc(sup, rel)
            raw = None
            if not ruc_p:   # sin RUC: se guarda el JSON crudo para ver cómo viene realmente
                raw = json.dumps({"supplier": sup, "award_id": aw.get("id"),
                                  "parties": (rel.get("parties") or [])[:6]}, ensure_ascii=False)[:6000]
            con.execute(
                """INSERT INTO mayor_adjudicaciones
                   (ocid, award_id, proveedor, proveedor_ruc, monto, moneda, fecha_adjudicacion, estado_award, raw)
                   VALUES (?,?,?,?,?,?,?::timestamptz,?,?::jsonb)""",
                (ocid, aw.get("id"), sup.get("name"), ruc_p, val.get("amount"),
                 val.get("currency"), aw.get("date"), aw.get("status"), raw),
            )

    items_t = tender.get("items") or []
    if items_t or awards:
        con.execute("DELETE FROM mayor_items WHERE ocid=?", (ocid,))
        _guardar_items(con, ocid, items_t, "tender")
        for aw in awards:
            sup = (aw.get("suppliers") or [{}])[0] or {}
            _guardar_items(con, ocid, aw.get("items"), "award", sup.get("name"), _ruc(sup, rel), aw.get("date"))


def _get(client, url, params):
    for n in range(4):
        try:
            r = client.get(url, params=params, timeout=60,
                           headers={"accept": "application/json"})
            r.raise_for_status()
            return r.json()
        except Exception as e:
            espera = 15 * (2 ** n)
            logger.warning("API OCDS falló (%s). Reintento en %ss", e, espera)
            time.sleep(espera)
    raise RuntimeError("La API OCDS no respondió tras 4 intentos")

def sincronizar():
    con = abrir_db()
    omitidas: dict[str, int] = {}
    try:
        ultima, cursor = _leer_estado(con)
        if cursor:
            url, params = cursor, None
            logger.info("Sync OCDS: retomando desde el cursor guardado")
        else:
            start = ultima.isoformat() if ultima else DESDE_DEFECTO
            end = (date.today() + timedelta(days=1)).isoformat()
            logger.info("Sync OCDS: %s a %s", start, end)
            url = f"{BASE_URL}/releasesAfter"
            params = {"sourceId": SOURCE, "startDate": start, "endDate": end, "size": 100}

        total = guardados = 0
        with cffi_requests.Session(impersonate="chrome") as client:
            while url:
                data = _get(client, url, params)
                for rel in data.get("releases", []):
                    total += 1
                    tender = rel.get("tender") or {}
                    if not es_mayor(tender):
                        m = tender.get("procurementMethodDetails") or "(sin modalidad)"
                        omitidas[m] = omitidas.get(m, 0) + 1
                        continue
                    try:
                        upsert_proceso(con, rel)
                        con.commit()
                        guardados += 1
                    except Exception as e:
                        try:
                            con.rollback()
                        except Exception:
                            pass
                        logger.warning("No se pudo guardar %s: %s", rel.get("ocid"), e)
                    if total % 500 == 0:
                        logger.info("Sync OCDS: %s leídos, %s guardados", total, guardados)

                url = (data.get("links") or {}).get("next")
                params = None
                _guardar_estado(con, None, url)  # cursor: si se corta, retoma aquí

        _guardar_estado(con, date.today() - timedelta(days=3), None)
        logger.info("Sync OCDS terminado: %s leídos, %s guardados", total, guardados)
        if omitidas:
            logger.info("Sync OCDS: modalidades omitidas %s", omitidas)
    finally:
        con.close()