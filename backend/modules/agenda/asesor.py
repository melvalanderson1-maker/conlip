from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.agenda import avisar_pedido, calcular, recalcular, zona
from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, solo_asesor
from modules.agenda.admin import (
    HTTPS, SQL_PEDIDOS, BloqueoIn, EntregablePatch, HorariosIn, _aware, _detalle, crear_bloqueo, editar_entregable,
    fijar_horarios,
)

router = APIRouter(prefix="/api/asesor", tags=["asesor"])


def _mio(con, yo: dict) -> dict:
    a = con.execute(
        "SELECT id, nombre, correo, plataforma, modo_enlace, enlace, color, activo FROM asesores WHERE usuario_id=?",
        (yo["id"],)).fetchone()
    if not a or not a["activo"]:
        raise HTTPException(403, "Tu usuario no está vinculado a un asesor activo. Pide al administrador que revise tu acceso.")
    return dict(a)


def _es_mi_cliente(con, asesor_id: int, pid: int) -> None:
    if not con.execute("SELECT 1 FROM sesiones_servicio WHERE pedido_id=? AND asesor_id=? LIMIT 1", (pid, asesor_id)).fetchone():
        raise HTTPException(404, "Cliente no encontrado")


def _asesor_id(yo: dict) -> int:
    con = abrir_db()
    try:
        return _mio(con, yo)["id"]
    finally:
        con.close()


class PerfilIn(BaseModel):
    enlace: str = Field(max_length=500)


class MarcaIn(BaseModel):
    estado: Literal["realizada", "no_asistio"] | None = None
    nota: str | None = Field(default=None, max_length=500)


# ---------------- Perfil y disponibilidad ----------------
@router.get("/yo")
def perfil(yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        hs = con.execute(
            "SELECT dia, to_char(inicio, 'HH24:MI') AS inicio, to_char(fin, 'HH24:MI') AS fin FROM asesor_horarios "
            "WHERE asesor_id=? ORDER BY dia, inicio", (a["id"],)).fetchall()
        bl = con.execute(
            "SELECT id, desde, hasta, motivo FROM asesor_bloqueos WHERE asesor_id=? AND hasta > now() ORDER BY desde",
            (a["id"],)).fetchall()
    finally:
        con.close()
    return {**a, "horarios": [dict(h) for h in hs], "bloqueos": [dict(b) for b in bl]}


@router.patch("/perfil")
def guardar_enlace(d: PerfilIn, request: Request, yo: dict = Depends(solo_asesor)):
    enlace = d.enlace.strip()
    if enlace and not HTTPS.match(enlace):
        raise HTTPException(400, "El enlace de tu sala debe empezar con https://")
    con = abrir_db()
    try:
        a = _mio(con, yo)
        con.execute("UPDATE asesores SET enlace=? WHERE id=?", (enlace, a["id"]))
    finally:
        con.close()
    auditar("asesor_enlace", yo["usuario"], ip_cliente(request), f"asesor {a['id']}")
    return {"ok": True}


@router.put("/horarios")
def horarios(d: HorariosIn, yo: dict = Depends(solo_asesor)):
    return fijar_horarios(_asesor_id(yo), d)


@router.post("/bloqueos")
def agregar_bloqueo(d: BloqueoIn, yo: dict = Depends(solo_asesor)):
    return crear_bloqueo(_asesor_id(yo), d)


@router.delete("/bloqueos/{bid}")
def quitar_bloqueo(bid: int, yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        r = con.execute("DELETE FROM asesor_bloqueos WHERE id=? AND asesor_id=? RETURNING id", (bid, a["id"])).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Bloqueo no encontrado")
    return {"ok": True}


# ---------------- Sesiones ----------------
@router.get("/sesiones")
def mis_sesiones(desde: datetime, hasta: datetime, yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        filas = con.execute(
            "SELECT q.id, q.pedido_id, q.inicio, q.fin, q.estado, q.enlace, q.nota, p.nombre AS cliente, p.correo, "
            "p.telefono, p.servicio_nombre FROM sesiones_servicio q JOIN pedidos_servicio p ON p.id = q.pedido_id "
            "WHERE q.asesor_id=? AND q.inicio < ? AND q.fin > ? AND q.estado <> 'cancelada' ORDER BY q.inicio",
            (a["id"], _aware(hasta), _aware(desde))).fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


@router.patch("/sesiones/{sid}")
def marcar_sesion(sid: int, d: MarcaIn, request: Request, yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        s = con.execute("SELECT pedido_id, asesor_id, inicio, estado FROM sesiones_servicio WHERE id=?", (sid,)).fetchone()
        if not s or s["asesor_id"] != a["id"]:
            raise HTTPException(404, "Sesión no encontrada")
        sets, args = [], []
        if d.estado is not None:
            if s["estado"] == "cancelada":
                raise HTTPException(400, "Esta sesión fue cancelada")
            if s["inicio"] > datetime.now(zona()):
                raise HTTPException(400, "La sesión aún no empieza: no se puede marcar todavía")
            sets.append("estado=?"); args.append(d.estado)
        if d.nota is not None:
            sets.append("nota=?"); args.append(d.nota.strip())
        if not sets:
            raise HTTPException(400, "Nada que cambiar")
        sets.append("actualizado_en=now()")
        con.execute(f"UPDATE sesiones_servicio SET {', '.join(sets)} WHERE id=?", args + [sid])
        recalcular(con, s["pedido_id"])
        pid = s["pedido_id"]
    finally:
        con.close()
    auditar("sesion_marcada_asesor", yo["usuario"], ip_cliente(request), f"sesion {sid} {d.estado or 'nota'}")
    avisar_pedido(pid)
    return {"ok": True}


# ---------------- Mis clientes ----------------
@router.get("/pedidos")
def mis_pedidos(yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        filas = con.execute(
            f"{SQL_PEDIDOS} WHERE p.id IN (SELECT pedido_id FROM sesiones_servicio WHERE asesor_id=?) "
            "ORDER BY p.creado_en DESC LIMIT 200", (a["id"],)).fetchall()
    finally:
        con.close()
    out = []
    for f in filas:
        d = dict(f)
        _, d["progreso"] = calcular({**d, "inc": d["sesiones_incluidas"]})
        out.append(d)
    return out


@router.get("/pedidos/{pid}")
def mi_cliente(pid: int, yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        _es_mi_cliente(con, a["id"], pid)
        return _detalle(con, pid)
    finally:
        con.close()


@router.patch("/entregables/{eid}")
def mi_entregable(eid: int, d: EntregablePatch, yo: dict = Depends(solo_asesor)):
    con = abrir_db()
    try:
        a = _mio(con, yo)
        r = con.execute("SELECT pedido_id FROM pedido_entregables WHERE id=?", (eid,)).fetchone()
        if not r:
            raise HTTPException(404, "Entregable no encontrado")
        _es_mi_cliente(con, a["id"], r["pedido_id"])
    finally:
        con.close()
    d.titulo = None  # el asesor marca avance y notas; el nombre del entregable lo define el superadmin
    return editar_entregable(eid, d)