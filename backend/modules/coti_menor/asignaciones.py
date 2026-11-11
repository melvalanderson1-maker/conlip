from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.seguridad import (
    auditar, calcular_permisos, ip_cliente, requiere_permiso, suscripciones_activas,
)
from core.tiempo_real import gestor

router = APIRouter(prefix="/api/menor/asignaciones", tags=["asignaciones"])
COTIZAR = requiere_permiso("menor:cotizar")
ESTADOS = ("pendiente", "en_curso", "cotizada", "descartada")

SQL_BASE = """
SELECT a.id, a.id_contrato, a.estado, a.nota, a.creado_en, a.visto_en,
       a.asignado_por AS por_id, COALESCE(NULLIF(up.nombre,''), up.usuario) AS por_nombre,
       a.asignado_a AS para_id, COALESCE(NULLIF(ua.nombre,''), ua.usuario) AS para_nombre,
       ua.empresa_id AS empresa_id,
       c.codigo, c.anio, c.descripcion, c.entidad, c.objeto, c.fec_publica, c.fec_ini_cot,
       c.fec_fin_cot, c.id_estado, c.estado AS estado_contrato
FROM asignaciones a
JOIN contratos c ON c.id_contrato = a.id_contrato
JOIN usuarios up ON up.id = a.asignado_por
JOIN usuarios ua ON ua.id = a.asignado_a
"""


def _miembros(con, yo: dict) -> list[dict]:
    """Usuarios de MI empresa que hoy pueden cotizar en Coti Menor."""
    subs = suscripciones_activas(con, yo["empresa_id"])
    filas = con.execute(
        "SELECT id, usuario, COALESCE(NULLIF(nombre,''), usuario) AS nombre, rol, permisos "
        "FROM usuarios WHERE empresa_id=? AND activo=1 ORDER BY 3", (yo["empresa_id"],)).fetchall()
    out = []
    for f in filas:
        perm = calcular_permisos(f["rol"], yo["empresa_tipo"], list(f["permisos"] or []), subs)
        if "menor:cotizar" in perm:
            out.append({"id": f["id"], "usuario": f["usuario"], "nombre": f["nombre"]})
    return out


def _fila(con, id_asig: int, eid: int):
    return con.execute(SQL_BASE + " WHERE a.id=? AND ua.empresa_id=?", (id_asig, eid)).fetchone()


def _evento(tipo: str, r) -> dict:
    return {"tipo": tipo, "id": r["id"], "id_contrato": r["id_contrato"], "codigo": r["codigo"],
            "por_id": r["por_id"], "por": r["por_nombre"], "para_id": r["para_id"],
            "para": r["para_nombre"], "estado": r["estado"]}


class AsignarIn(BaseModel):
    id_contrato: int
    asignado_a: int
    nota: str | None = Field(default=None, max_length=300)


class EstadoIn(BaseModel):
    estado: str


@router.get("/equipo")
def equipo(yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        return _miembros(con, yo)
    finally:
        con.close()


@router.get("/resumen")
def resumen(yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        n = con.execute(
            "SELECT COUNT(*) FROM asignaciones WHERE asignado_a=? AND visto_en IS NULL",
            (yo["id"],)).fetchone()[0]
    finally:
        con.close()
    return {"sin_ver": n}


@router.post("/vistas")
def marcar_vistas(yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        cur = con.execute(
            "UPDATE asignaciones SET visto_en=now() WHERE asignado_a=? AND visto_en IS NULL",
            (yo["id"],))
        n = cur.rowcount
    finally:
        con.close()
    if n:
        gestor.notificar([yo["id"]], {"tipo": "vistas"})
    return {"marcadas": n}


@router.get("")
def listar(ambito: str = "mias", estado: str = "", yo: dict = Depends(COTIZAR)):
    if ambito not in ("mias", "enviadas", "todas"):
        raise HTTPException(400, "Ámbito inválido")
    if ambito == "todas" and yo["rol"] != "admin":
        raise HTTPException(403, "Solo el administrador puede ver todas las asignaciones")
    where, args = ["ua.empresa_id=?"], [yo["empresa_id"]]
    if ambito == "mias":
        where.append("a.asignado_a=?"); args.append(yo["id"])
    elif ambito == "enviadas":
        where.append("a.asignado_por=? AND a.asignado_a<>a.asignado_por"); args.append(yo["id"])
    if estado:
        if estado not in ESTADOS:
            raise HTTPException(400, "Estado inválido")
        where.append("a.estado=?"); args.append(estado)
    con = abrir_db()
    try:
        filas = con.execute(
            f"{SQL_BASE} WHERE {' AND '.join(where)} "
            f"ORDER BY (a.visto_en IS NULL) DESC, a.creado_en DESC LIMIT 300", args
        ).fetchall()
        return [dict(r) for r in filas]
    finally:
        con.close()


@router.get("/contrato/{id_contrato}")
def de_contrato(id_contrato: int, yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        filas = con.execute(
            f"{SQL_BASE} WHERE a.id_contrato=? AND ua.empresa_id=? ORDER BY a.creado_en",
            (id_contrato, yo["empresa_id"])).fetchall()
        return [{k: r[k] for k in ("id", "para_id", "para_nombre", "por_id", "por_nombre",
                                   "estado", "creado_en")} for r in filas]
    finally:
        con.close()


@router.post("")
def crear(d: AsignarIn, request: Request, yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM contratos WHERE id_contrato=?", (d.id_contrato,)).fetchone():
            raise HTTPException(404, "Contrato no encontrado")
        if d.asignado_a not in {m["id"] for m in _miembros(con, yo)}:
            raise HTTPException(400, "Esa persona no puede recibir asignaciones")
        propia = d.asignado_a == yo["id"]
        nuevo = con.execute(
            "INSERT INTO asignaciones (id_contrato, asignado_a, asignado_por, nota, visto_en) "
            "VALUES (?,?,?,?, CASE WHEN ? THEN now() ELSE NULL END) "
            "ON CONFLICT (id_contrato, asignado_a) DO NOTHING RETURNING id",
            (d.id_contrato, d.asignado_a, yo["id"], (d.nota or "").strip() or None, propia),
        ).fetchone()
        if not nuevo:
            raise HTTPException(409, "Este contrato ya está asignado a esa persona")
        r = _fila(con, nuevo[0], yo["empresa_id"])
    finally:
        con.close()
    gestor.notificar({r["para_id"], r["por_id"]}, _evento("asignacion_nueva", r))
    auditar("asignacion_creada", yo["usuario"], ip_cliente(request), f"{r['codigo']} -> {r['para_nombre']}")
    return {"id": r["id"]}


@router.patch("/{id_asig}")
def cambiar_estado(id_asig: int, d: EstadoIn, request: Request, yo: dict = Depends(COTIZAR)):
    if d.estado not in ESTADOS:
        raise HTTPException(400, "Estado inválido")
    con = abrir_db()
    try:
        r = _fila(con, id_asig, yo["empresa_id"])
        if not r:
            raise HTTPException(404, "Asignación no encontrada")
        if yo["rol"] != "admin" and r["para_id"] != yo["id"]:
            raise HTTPException(403, "Solo quien recibió la asignación puede cambiar su estado")
        con.execute("UPDATE asignaciones SET estado=?, actualizado_en=now() WHERE id=?", (d.estado, id_asig))
        r = _fila(con, id_asig, yo["empresa_id"])
    finally:
        con.close()
    gestor.notificar({r["para_id"], r["por_id"]}, _evento("asignacion_actualizada", r))
    auditar("asignacion_estado", yo["usuario"], ip_cliente(request), f"{r['codigo']} -> {d.estado}")
    return {"ok": True}


@router.delete("/{id_asig}")
def quitar(id_asig: int, request: Request, yo: dict = Depends(COTIZAR)):
    con = abrir_db()
    try:
        r = _fila(con, id_asig, yo["empresa_id"])
        if not r:
            raise HTTPException(404, "Asignación no encontrada")
        if yo["rol"] != "admin" and yo["id"] not in (r["por_id"], r["para_id"]):
            raise HTTPException(403, "No puedes quitar esta asignación")
        con.execute("DELETE FROM asignaciones WHERE id=?", (id_asig,))
    finally:
        con.close()
    gestor.notificar({r["para_id"], r["por_id"]}, _evento("asignacion_quitada", r))
    auditar("asignacion_quitada", yo["usuario"], ip_cliente(request), f"{r['codigo']} de {r['para_nombre']}")
    return {"ok": True}