import json
import os

from fastapi import APIRouter, Depends, HTTPException

from core.db import abrir_db
from core.seguridad import requiere_permiso, solo_superadmin
from modules.coti_menor import seace_cliente as sc
from modules.coti_menor.instancia import cliente
from modules.coti_menor.seace_auth import sesion

router = APIRouter(prefix="/api", tags=["coti-menor"])
VER = Depends(requiere_permiso("menor:ver"))

COLS = ("id_contrato,codigo,anio,objeto,descripcion,entidad,fec_publica,fec_ini_cot,"
        "fec_fin_cot,id_estado,estado,relevante,enriquecido,archivos_json")


@router.get("/sesion", dependencies=[VER])
def sesion_estado():
    return sesion.estado()


@router.post("/sesion/iniciar", dependencies=[Depends(solo_superadmin)])
def sesion_iniciar():
    if not os.getenv("SEACE_RUC") or not os.getenv("SEACE_CLAVE"):
        raise HTTPException(400, "Faltan SEACE_RUC / SEACE_CLAVE en el .env del backend")
    ok, error = cliente.login(forzar=True)
    if not ok:
        sc.logger.error(f"Login SEACE falló: {error}")
        raise HTTPException(502, "No se pudo iniciar sesión en SEACE. Revisa los logs del backend.")
    return sesion.estado()


@router.get("/stats", dependencies=[VER])
def stats():
    con = abrir_db()
    try:
        total = con.execute("SELECT COUNT(*) FROM contratos").fetchone()[0]
        rel = con.execute("SELECT COUNT(*) FROM contratos WHERE relevante=1").fetchone()[0]
        por = {str(r[0]): r[1] for r in con.execute(
            "SELECT id_estado, COUNT(*) FROM contratos GROUP BY id_estado")}
        return {"total": total, "relevantes": rel, "por_estado": por}
    finally:
        con.close()


@router.get("/contratos", dependencies=[VER])
def listar(q: str = "", estado: int | None = None, objeto: str = "", relevante: bool = False,
           page: int = 1, page_size: int = 25):
    page_size = min(max(page_size, 1), 100)
    q, objeto = q.strip()[:100], objeto.strip()[:60]
    where, args = [], []
    if estado is not None:
        where.append("id_estado=?")
        args.append(estado)
    if relevante:
        where.append("relevante=1")
    if objeto:
        where.append("objeto ILIKE ?")
        args.append(f"{objeto}%")
    if q:
        where.append("(codigo ILIKE ? OR descripcion ILIKE ? OR entidad ILIKE ? OR objeto ILIKE ?)")
        args += [f"%{q}%"] * 4
    w = ("WHERE " + " AND ".join(where)) if where else ""
    con = abrir_db()
    try:
        total = con.execute(f"SELECT COUNT(*) FROM contratos {w}", args).fetchone()[0]
        rows = con.execute(
            f"SELECT {COLS} FROM contratos {w} ORDER BY fec_publica DESC NULLS LAST LIMIT ? OFFSET ?",
            args + [page_size, (max(page, 1) - 1) * page_size],
        ).fetchall()
        return {"total": total, "page": page, "page_size": page_size,
                "items": [{**{k: v for k, v in dict(r).items() if k != "archivos_json"},
                           "n_archivos": (len(json.loads(r["archivos_json"])) if r["archivos_json"] else None)}
                          for r in rows]}
    finally:
        con.close()


@router.get("/contratos/{id_contrato}", dependencies=[VER])
def detalle(id_contrato: int):
    con = abrir_db()
    try:
        r = con.execute("SELECT * FROM contratos WHERE id_contrato=?", (id_contrato,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Contrato no encontrado")
    d = dict(r)
    archivos = json.loads(d["archivos_json"]) if d.get("archivos_json") else None
    if archivos is None:
        try:
            archivos = sc.listar_archivos(cliente, id_contrato)
        except Exception as e:
            sc.logger.warning(f"No se pudieron traer archivos de {id_contrato}: {e}")
            archivos = []
    d["archivos"] = archivos
    for k in ("raw_json", "detalle_json", "archivos_json"):
        d.pop(k, None)
    return d



@router.get("/mayor/historial")
def historial_global(desde_id: int | None = None, limite: int = 50):
    """Sin desde_id: devuelve solo el último id (referencia). Con desde_id: los cambios posteriores."""
    con = abrir_db()
    try:
        if desde_id is None:
            r = con.execute("SELECT COALESCE(MAX(id), 0) FROM procesos_mayor_historial").fetchone()
            return {"ultimo_id": r[0], "items": []}
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


@router.get("/mayor/procesos/{ocid}/historial")
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