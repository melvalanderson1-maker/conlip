import re
from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.agenda import (
    avisar_pedido, calcular, choca, correo_sesion, guardar_reglas, recalcular, reglas, resumen_pedido,
    sincronizar_entregables, slots, zona, MODULOS_SERVICIOS, NOMBRES_MODULO, servicios_habilitados,
)
import html
import secrets

from core import videollamadas as vc
from core.correo import enviar_correo
from core.ordenes import nuevo_enlace_clave
from core.db import abrir_db
from core.seguridad import auditar, hash_clave, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/agenda/admin", tags=["agenda-admin"], dependencies=[Depends(solo_superadmin)])

HORA = r"^([01]\d|2[0-3]):[0-5]\d$"
HTTPS = re.compile(r"^https://[^\s<>\"']+$")
CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
ESTADOS_PEDIDO = ("nuevo", "en_curso", "entregado", "cancelado")


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=zona())


def _min(h: str) -> int:
    return int(h[:2]) * 60 + int(h[3:])


def _validar_contacto(correo: str, enlace: str) -> None:
    if correo and not CORREO.match(correo):
        raise HTTPException(400, "El correo del asesor no es válido")
    if enlace and not HTTPS.match(enlace):
        raise HTTPException(400, "El enlace de la sala debe empezar con https://")


# ======================= MODELOS =======================
class AsesorIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=120)
    correo: str = Field(default="", max_length=160)
    plataforma: Literal["meet", "zoom", "otra"] = "meet"
    enlace: str = Field(default="", max_length=500)
    color: str = Field(default="#1d4ed8", pattern=r"^#[0-9a-fA-F]{6}$")
    activo: bool = True
    modo_enlace: Literal["fijo", "api"] = "fijo"
    zoom_usuario: str = Field(default="", max_length=160)


class AsesorPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=120)
    correo: str | None = Field(default=None, max_length=160)
    plataforma: Literal["meet", "zoom", "otra"] | None = None
    enlace: str | None = Field(default=None, max_length=500)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    activo: bool | None = None
    modo_enlace: Literal["fijo", "api"] | None = None
    zoom_usuario: str | None = Field(default=None, max_length=160)


class HorarioIn(BaseModel):
    dia: int = Field(ge=0, le=6)  # 0 = lunes
    inicio: str = Field(pattern=HORA)
    fin: str = Field(pattern=HORA)


class HorariosIn(BaseModel):
    horarios: list[HorarioIn] = Field(default_factory=list, max_length=70)


class BloqueoIn(BaseModel):
    desde: datetime
    hasta: datetime
    motivo: str = Field(default="", max_length=200)


class ServicioAgendaIn(BaseModel):
    sesiones: int = Field(ge=0, le=20)
    duracion_min: int = Field(ge=15, le=240)
    asesor_ids: list[int] = Field(default_factory=list, max_length=100)


class ReglasIn(BaseModel):
    antelacion_horas: int = Field(ge=0, le=720)
    cancelacion_horas: int = Field(ge=0, le=720)
    dias_adelante: int = Field(ge=1, le=180)


class EntregablePatch(BaseModel):
    titulo: str | None = Field(default=None, min_length=2, max_length=200)
    estado: Literal["pendiente", "en_curso", "hecho"] | None = None
    nota: str | None = Field(default=None, max_length=500)


class EntregableNuevo(BaseModel):
    titulo: str = Field(min_length=2, max_length=200)


class SesionNueva(BaseModel):
    asesor_id: int
    inicio: datetime


class SesionPatch(BaseModel):
    estado: Literal["programada", "realizada", "no_asistio", "cancelada"] | None = None
    inicio: datetime | None = None
    asesor_id: int | None = None
    nota: str | None = Field(default=None, max_length=500)


# ======================= ASESORES =======================
@router.get("/asesores")
def listar_asesores():
    con = abrir_db()
    try:
        ases = con.execute(
            "SELECT id, nombre, correo, plataforma, enlace, color, activo, modo_enlace, zoom_usuario, usuario_id FROM asesores ORDER BY nombre, id").fetchall()
        hs = con.execute(
            "SELECT asesor_id, dia, to_char(inicio, 'HH24:MI') AS inicio, to_char(fin, 'HH24:MI') AS fin "
            "FROM asesor_horarios ORDER BY dia, inicio").fetchall()
        bl = con.execute(
            "SELECT id, asesor_id, desde, hasta, motivo FROM asesor_bloqueos WHERE hasta > now() ORDER BY desde").fetchall()
        pr = con.execute(
            "SELECT asesor_id, COUNT(*) AS n FROM sesiones_servicio WHERE estado='programada' AND inicio > now() "
            "GROUP BY asesor_id").fetchall()
    finally:
        con.close()
    proximas = {p["asesor_id"]: p["n"] for p in pr}
    return [{
        **dict(a), "activo": bool(a["activo"]), "proximas": proximas.get(a["id"], 0),
        "horarios": [{"dia": h["dia"], "inicio": h["inicio"], "fin": h["fin"]} for h in hs if h["asesor_id"] == a["id"]],
        "bloqueos": [{"id": b["id"], "desde": b["desde"], "hasta": b["hasta"], "motivo": b["motivo"]}
                     for b in bl if b["asesor_id"] == a["id"]],
    } for a in ases]


@router.post("/asesores")
def crear_asesor(d: AsesorIn, request: Request, yo: dict = Depends(solo_superadmin)):
    _validar_contacto(d.correo.strip(), d.enlace.strip())
    con = abrir_db()
    try:
        aid = con.execute(
            "INSERT INTO asesores (nombre, correo, plataforma, enlace, color, activo, modo_enlace, zoom_usuario) "
            "VALUES (?,?,?,?,?,?,?,?) RETURNING id",
            (d.nombre.strip(), d.correo.strip(), d.plataforma, d.enlace.strip(), d.color, 1 if d.activo else 0,
             d.modo_enlace, d.zoom_usuario.strip())).fetchone()[0]
    finally:
        con.close()
    auditar("asesor_creado", yo["usuario"], ip_cliente(request), d.nombre)
    return {"id": aid}


@router.patch("/asesores/{aid}")
def editar_asesor(aid: int, d: AsesorPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    if d.correo is not None or d.enlace is not None:
        _validar_contacto((d.correo or "").strip(), (d.enlace or "").strip())
    sets, args = [], []
    for campo in ("nombre", "correo", "enlace", "zoom_usuario"):
        v = getattr(d, campo)
        if v is not None:
            sets.append(f"{campo}=?"); args.append(v.strip())
    if d.plataforma is not None:
        sets.append("plataforma=?"); args.append(d.plataforma)
    if d.modo_enlace is not None:
        sets.append("modo_enlace=?"); args.append(d.modo_enlace)
    if d.color is not None:
        sets.append("color=?"); args.append(d.color)
    if d.activo is not None:
        sets.append("activo=?"); args.append(1 if d.activo else 0)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(f"UPDATE asesores SET {', '.join(sets)} WHERE id=? RETURNING id", args + [aid]).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Asesor no encontrado")
    auditar("asesor_editado", yo["usuario"], ip_cliente(request), f"asesor {aid}")
    return {"ok": True}


@router.delete("/asesores/{aid}")
def borrar_asesor(aid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if con.execute("SELECT 1 FROM sesiones_servicio WHERE asesor_id=? LIMIT 1", (aid,)).fetchone():
            raise HTTPException(409, "Este asesor tiene sesiones registradas. Desactívalo en lugar de eliminarlo.")
        r = con.execute("DELETE FROM asesores WHERE id=? RETURNING nombre", (aid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Asesor no encontrado")
    auditar("asesor_eliminado", yo["usuario"], ip_cliente(request), r["nombre"])
    return {"ok": True}


@router.put("/asesores/{aid}/horarios")
def fijar_horarios(aid: int, d: HorariosIn):
    por_dia: dict[int, list[tuple[int, int]]] = {}
    for h in d.horarios:
        ini, fin = _min(h.inicio), _min(h.fin)
        if fin <= ini:
            raise HTTPException(400, "En cada rango, la hora de fin debe ser posterior a la de inicio")
        por_dia.setdefault(h.dia, []).append((ini, fin))
    for rangos in por_dia.values():
        rangos.sort()
        for (_, f1), (i2, _) in zip(rangos, rangos[1:]):
            if i2 < f1:
                raise HTTPException(400, "Hay rangos que se cruzan en un mismo día")
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM asesores WHERE id=?", (aid,)).fetchone():
            raise HTTPException(404, "Asesor no encontrado")
        con.execute("DELETE FROM asesor_horarios WHERE asesor_id=?", (aid,))
        for h in d.horarios:
            con.execute(
                "INSERT INTO asesor_horarios (asesor_id, dia, inicio, fin) VALUES (?,?,?::time,?::time)",
                (aid, h.dia, h.inicio, h.fin))
    finally:
        con.close()
    return {"ok": True}


@router.post("/asesores/{aid}/bloqueos")
def crear_bloqueo(aid: int, d: BloqueoIn):
    desde, hasta = _aware(d.desde), _aware(d.hasta)
    if hasta <= desde:
        raise HTTPException(400, "El fin del bloqueo debe ser posterior al inicio")
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM asesores WHERE id=?", (aid,)).fetchone():
            raise HTTPException(404, "Asesor no encontrado")
        bid = con.execute(
            "INSERT INTO asesor_bloqueos (asesor_id, desde, hasta, motivo) VALUES (?,?,?,?) RETURNING id",
            (aid, desde, hasta, d.motivo.strip())).fetchone()[0]
    finally:
        con.close()
    return {"id": bid}


@router.delete("/bloqueos/{bid}")
def borrar_bloqueo(bid: int):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM asesor_bloqueos WHERE id=? RETURNING id", (bid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Bloqueo no encontrado")
    return {"ok": True}


# ======================= SERVICIOS Y REGLAS =======================
@router.get("/servicios")
def servicios_agenda():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT id, categoria, nombre, sesiones, duracion_sesion_min FROM servicios ORDER BY orden, id").fetchall()
        asig = con.execute("SELECT servicio_id, asesor_id FROM servicio_asesores").fetchall()
    finally:
        con.close()
    return [{**dict(f), "asesor_ids": [a["asesor_id"] for a in asig if a["servicio_id"] == f["id"]]} for f in filas]


@router.put("/servicios/{sid}")
def fijar_servicio(sid: int, d: ServicioAgendaIn, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        r = con.execute(
            "UPDATE servicios SET sesiones=?, duracion_sesion_min=? WHERE id=? RETURNING nombre",
            (d.sesiones, d.duracion_min, sid)).fetchone()
        if not r:
            raise HTTPException(404, "Servicio no encontrado")
        validos = [x["id"] for x in con.execute(
            "SELECT id FROM asesores WHERE id = ANY(?)", (d.asesor_ids,)).fetchall()] if d.asesor_ids else []
        con.execute("DELETE FROM servicio_asesores WHERE servicio_id=?", (sid,))
        for aid in validos:
            con.execute("INSERT INTO servicio_asesores (servicio_id, asesor_id) VALUES (?,?)", (sid, aid))
    finally:
        con.close()
    auditar("servicio_agenda", yo["usuario"], ip_cliente(request), f"{r['nombre']}: {d.sesiones} sesiones")
    return {"ok": True}


@router.get("/reglas")
def get_reglas():
    con = abrir_db()
    try:
        r = reglas(con)
    finally:
        con.close()
    return {"antelacion_horas": r["agenda_antelacion_horas"], "cancelacion_horas": r["agenda_cancelacion_horas"],
            "dias_adelante": r["agenda_dias_adelante"]}


@router.put("/reglas")
def put_reglas(d: ReglasIn):
    con = abrir_db()
    try:
        guardar_reglas(con, d.antelacion_horas, d.cancelacion_horas, d.dias_adelante)
    finally:
        con.close()
    return {"ok": True}


# ======================= SEGUIMIENTO POR CLIENTE =======================
SQL_PEDIDOS = """
SELECT p.id, p.servicio_nombre, p.estado, p.origen, p.nombre, p.correo, p.telefono, p.creado_en, e.nombre AS empresa,
  COALESCE(s.sesiones, 0) AS sesiones_incluidas,
  (SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id) AS total_e,
  (SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id AND x.estado = 'hecho') AS hechos,
  (SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id AND x.estado = 'en_curso') AS en_curso,
  (SELECT COUNT(*) FROM sesiones_servicio q WHERE q.pedido_id = p.id AND q.estado = 'realizada') AS realizadas,
  (SELECT COUNT(*) FROM sesiones_servicio q WHERE q.pedido_id = p.id AND q.estado = 'programada') AS programadas,
  (SELECT MIN(q.inicio) FROM sesiones_servicio q WHERE q.pedido_id = p.id AND q.estado = 'programada' AND q.inicio > now()) AS proxima
FROM pedidos_servicio p LEFT JOIN servicios s ON s.id = p.servicio_id LEFT JOIN empresas e ON e.id = p.empresa_id
"""


@router.get("/pedidos")
def pedidos(estado: str = ""):
    if estado and estado not in ESTADOS_PEDIDO:
        raise HTTPException(400, "Estado inválido")
    w = "WHERE p.estado=?" if estado else ""
    con = abrir_db()
    try:
        sincronizar_entregables(con)
        filas = con.execute(
            f"{SQL_PEDIDOS} {w} ORDER BY p.creado_en DESC LIMIT 200", [estado] if estado else []).fetchall()
    finally:
        con.close()
    out = []
    for f in filas:
        d = dict(f)
        _, d["progreso"] = calcular({**d, "inc": d["sesiones_incluidas"]})
        out.append(d)
    return out


def _detalle(con, pid: int) -> dict:
    sincronizar_entregables(con)
    p = con.execute(
        "SELECT p.id, p.servicio_id, p.servicio_nombre, p.estado, p.origen, p.nombre, p.correo, p.telefono, p.mensaje, "
        "p.creado_en, e.nombre AS empresa, COALESCE(s.sesiones, 0) AS sesiones_incluidas, "
        "COALESCE(s.duracion_sesion_min, 60) AS duracion_min "
        "FROM pedidos_servicio p LEFT JOIN servicios s ON s.id = p.servicio_id LEFT JOIN empresas e ON e.id = p.empresa_id "
        "WHERE p.id=?", (pid,)).fetchone()
    if not p:
        raise HTTPException(404, "Pedido no encontrado")
    ents = con.execute(
        "SELECT id, orden, titulo, estado, nota FROM pedido_entregables WHERE pedido_id=? ORDER BY orden, id", (pid,)).fetchall()
    ses = con.execute(
        "SELECT q.id, q.asesor_id, a.nombre AS asesor, a.color, q.inicio, q.fin, q.estado, q.enlace, q.plataforma, q.nota "
        "FROM sesiones_servicio q JOIN asesores a ON a.id = q.asesor_id WHERE q.pedido_id=? ORDER BY q.inicio", (pid,)).fetchall()
    _, pct = calcular(resumen_pedido(con, pid))
    activas = sum(1 for s in ses if s["estado"] in ("programada", "realizada"))
    return {**dict(p), "entregables": [dict(e) for e in ents], "sesiones": [dict(s) for s in ses], "progreso": pct,
            "pendientes_agendar": max(0, p["sesiones_incluidas"] - activas)}


@router.get("/pedidos/{pid}")
def pedido(pid: int):
    con = abrir_db()
    try:
        return _detalle(con, pid)
    finally:
        con.close()


@router.post("/pedidos/{pid}/entregables")
def agregar_entregable(pid: int, d: EntregableNuevo):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM pedidos_servicio WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Pedido no encontrado")
        con.execute(
            "INSERT INTO pedido_entregables (pedido_id, orden, titulo) VALUES "
            "(?, COALESCE((SELECT MAX(orden) + 1 FROM pedido_entregables WHERE pedido_id=?), 1), ?)",
            (pid, pid, d.titulo.strip()))
        recalcular(con, pid)
    finally:
        con.close()
    avisar_pedido(pid)
    return {"ok": True}


@router.patch("/entregables/{eid}")
def editar_entregable(eid: int, d: EntregablePatch):
    sets, args = [], []
    if d.titulo is not None:
        sets.append("titulo=?"); args.append(d.titulo.strip())
    if d.estado is not None:
        sets.append("estado=?"); args.append(d.estado)
    if d.nota is not None:
        sets.append("nota=?"); args.append(d.nota.strip())
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    sets.append("actualizado_en=now()")
    con = abrir_db()
    try:
        r = con.execute(
            f"UPDATE pedido_entregables SET {', '.join(sets)} WHERE id=? RETURNING pedido_id", args + [eid]).fetchone()
        if not r:
            raise HTTPException(404, "Entregable no encontrado")
        pid = r["pedido_id"]
        recalcular(con, pid)
    finally:
        con.close()
    avisar_pedido(pid)
    return {"ok": True}


@router.delete("/entregables/{eid}")
def quitar_entregable(eid: int):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM pedido_entregables WHERE id=? RETURNING pedido_id", (eid,)).fetchone()
        if not r:
            raise HTTPException(404, "Entregable no encontrado")
        pid = r["pedido_id"]
        recalcular(con, pid)
    finally:
        con.close()
    avisar_pedido(pid)
    return {"ok": True}


@router.get("/pedidos/{pid}/horarios")
def horarios_pedido(pid: int, desde: date, dias: int = 1):
    con = abrir_db()
    try:
        p = con.execute("SELECT servicio_id FROM pedidos_servicio WHERE id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Pedido no encontrado")
        if p["servicio_id"] is None:
            raise HTTPException(400, "Este pedido no está asociado a un servicio")
        lista = slots(con, p["servicio_id"], desde, min(max(dias, 1), 31))
    finally:
        con.close()
    return [{"inicio": s["inicio"], "fin": s["fin"], "asesor_id": s["asesor_id"], "asesor": s["asesor"]} for s in lista]


@router.post("/pedidos/{pid}/sesiones")
def agendar(pid: int, d: SesionNueva, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        p = con.execute(
            "SELECT p.servicio_nombre, p.nombre, p.correo, p.estado, COALESCE(s.duracion_sesion_min, 60) AS dur "
            "FROM pedidos_servicio p LEFT JOIN servicios s ON s.id = p.servicio_id WHERE p.id=?", (pid,)).fetchone()
        if not p:
            raise HTTPException(404, "Pedido no encontrado")
        if p["estado"] == "cancelado":
            raise HTTPException(400, "El pedido está cancelado")
        a = con.execute(
            "SELECT id, nombre, correo, plataforma, enlace, modo_enlace, zoom_usuario FROM asesores "
            "WHERE id=? AND activo=1", (d.asesor_id,)).fetchone()
        if not a:
            raise HTTPException(400, "Asesor no disponible")
        inicio = _aware(d.inicio)
        fin = inicio + timedelta(minutes=p["dur"])
        if inicio < datetime.now(inicio.tzinfo):
            raise HTTPException(400, "No puedes agendar en el pasado")
        motivo = choca(con, a["id"], inicio, fin)
        if motivo:
            raise HTTPException(409, motivo)
        sala = vc.crear(dict(a), dict(p), inicio, fin)
        try:
            con.execute(
                "INSERT INTO sesiones_servicio (pedido_id, asesor_id, inicio, fin, enlace, plataforma, proveedor, ext_id, creado_por) "
                "VALUES (?,?,?,?,?,?,?,?, 'admin')",
                (pid, a["id"], inicio, fin, sala["enlace"], a["plataforma"], sala["proveedor"], sala["ext_id"]))
        except Exception:
            vc.cancelar({"proveedor": sala["proveedor"], "ext_id": sala["ext_id"]})
            raise HTTPException(409, "Ese horario acaba de ocuparse. Elige otro.")
        recalcular(con, pid)
        pedido_d, asesor_d = dict(p), {**dict(a), "enlace": sala["enlace"]}
    finally:
        con.close()
    correo_sesion(pedido_d, asesor_d, inicio, fin, "Sesión agendada")
    auditar("sesion_agendada", yo["usuario"], ip_cliente(request), f"pedido {pid} {inicio.isoformat()}")
    avisar_pedido(pid)
    return {"ok": True, "aviso": sala["aviso"]}

# ======================= SESIONES =======================
@router.get("/sesiones")
def sesiones(desde: datetime, hasta: datetime, asesor_id: int | None = None):
    w = "AND q.asesor_id=?" if asesor_id else ""
    args: list = [_aware(hasta), _aware(desde)] + ([asesor_id] if asesor_id else [])
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT q.id, q.pedido_id, q.asesor_id, a.nombre AS asesor, a.color, q.inicio, q.fin, q.estado, q.enlace, "
            "p.nombre AS cliente, p.servicio_nombre FROM sesiones_servicio q JOIN asesores a ON a.id = q.asesor_id "
            f"JOIN pedidos_servicio p ON p.id = q.pedido_id WHERE q.inicio < ? AND q.fin > ? AND q.estado <> 'cancelada' {w} "
            "ORDER BY q.inicio", args).fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


@router.patch("/sesiones/{sid}")
def editar_sesion(sid: int, d: SesionPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    aviso: tuple | None = None
    sala: dict | None = None
    con = abrir_db()
    try:
        s = con.execute(
            "SELECT pedido_id, asesor_id, inicio, fin, estado, proveedor, ext_id, enlace FROM sesiones_servicio WHERE id=?",
            (sid,)).fetchone()
        if not s:
            raise HTTPException(404, "Sesión no encontrada")
        ped = con.execute(
            "SELECT servicio_nombre, nombre, correo FROM pedidos_servicio WHERE id=?", (s["pedido_id"],)).fetchone()
        sets, args = [], []
        estado_final = d.estado or s["estado"]
        mover = d.inicio is not None or d.asesor_id is not None
        reactivar = d.estado == "programada" and s["estado"] != "programada"
        if mover and estado_final != "programada":
            raise HTTPException(400, "Solo se pueden mover sesiones programadas")
        if mover or reactivar:
            asesor_id = d.asesor_id or s["asesor_id"]
            a = con.execute(
                "SELECT id, nombre, correo, plataforma, enlace, modo_enlace, zoom_usuario FROM asesores "
                "WHERE id=? AND activo=1", (asesor_id,)).fetchone()
            if not a:
                raise HTTPException(400, "Asesor no disponible")
            inicio = _aware(d.inicio) if d.inicio else s["inicio"]
            fin = inicio + (s["fin"] - s["inicio"])
            if inicio < datetime.now(inicio.tzinfo):
                raise HTTPException(400, "No puedes dejar una sesión en el pasado")
            motivo = choca(con, a["id"], inicio, fin, excluir=sid)
            if motivo:
                raise HTTPException(409, motivo)
            if s["estado"] == "programada":
                sala = vc.mover(dict(s), dict(a), dict(ped), inicio, fin, a["id"] == s["asesor_id"])
            else:
                vc.cancelar(dict(s))
                sala = vc.crear(dict(a), dict(ped), inicio, fin)
            sets += ["asesor_id=?", "inicio=?", "fin=?", "enlace=?", "plataforma=?", "proveedor=?", "ext_id=?",
                     "recordatorio_24h=0", "recordatorio_1h=0"]
            args += [a["id"], inicio, fin, sala["enlace"], a["plataforma"], sala["proveedor"], sala["ext_id"]]
            aviso = ({**dict(a), "enlace": sala["enlace"]}, inicio, fin)
        elif d.estado == "cancelada" and s["estado"] == "programada":
            vc.cancelar(dict(s))
        if d.estado is not None:
            sets.append("estado=?"); args.append(d.estado)
        if d.nota is not None:
            sets.append("nota=?"); args.append(d.nota.strip())
        if not sets:
            raise HTTPException(400, "Nada que cambiar")
        sets.append("actualizado_en=now()")
        try:
            con.execute(f"UPDATE sesiones_servicio SET {', '.join(sets)} WHERE id=?", args + [sid])
        except Exception:
            raise HTTPException(409, "Ese horario acaba de ocuparse. Elige otro.")
        recalcular(con, s["pedido_id"])
        pid, ped_d = s["pedido_id"], dict(ped)
    finally:
        con.close()
    if aviso:
        correo_sesion(ped_d, aviso[0], aviso[1], aviso[2], "Sesión reprogramada" if mover else "Sesión reactivada")
    auditar("sesion_editada", yo["usuario"], ip_cliente(request), f"sesion {sid}: {[x.split('=')[0] for x in sets]}")
    avisar_pedido(pid)
    return {"ok": True, "aviso": sala["aviso"] if sala else ""}




# ======================= MENÚ "SERVICIOS" POR MÓDULO =======================
class ModulosServiciosIn(BaseModel):
    perucompras: bool
    menor: bool
    mayor: bool


@router.get("/modulos")
def modulos_servicios():
    con = abrir_db()
    try:
        hab = servicios_habilitados(con)
        cuentas = {r["modulo"]: r["n"] for r in con.execute(
            "SELECT modulo, COUNT(*) AS n FROM servicios WHERE activo=1 AND modulo IS NOT NULL GROUP BY modulo").fetchall()}
    finally:
        con.close()
    return [{"id": m, "nombre": NOMBRES_MODULO[m], "habilitado": hab[m], "servicios": cuentas.get(m, 0)}
            for m in MODULOS_SERVICIOS]


@router.put("/modulos")
def fijar_modulos_servicios(d: ModulosServiciosIn, request: Request, yo: dict = Depends(solo_superadmin)):
    valores = {"perucompras": d.perucompras, "menor": d.menor, "mayor": d.mayor}
    con = abrir_db()
    try:
        for m, on in valores.items():
            con.execute(
                "INSERT INTO configuracion (clave, valor) VALUES (?,?) "
                "ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", (f"servicios_menu_{m}", "1" if on else "0"))
    finally:
        con.close()
    auditar("servicios_menu", yo["usuario"], ip_cliente(request), ",".join(m for m, on in valores.items() if on) or "ninguno")
    return {"ok": True}


# ======================= ACCESO DEL ASESOR A LA PLATAFORMA =======================
@router.post("/asesores/{aid}/acceso")
def dar_acceso(aid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    """Crea (o reactiva) el usuario del asesor y le envía el enlace para crear su clave."""
    con = abrir_db()
    try:
        a = con.execute("SELECT id, nombre, correo, usuario_id FROM asesores WHERE id=?", (aid,)).fetchone()
        if not a:
            raise HTTPException(404, "Asesor no encontrado")
        correo = (a["correo"] or "").strip().lower()
        if not CORREO.match(correo):
            raise HTTPException(400, "Primero guarda un correo válido para este asesor: ahí llegará su invitación.")
        uid = a["usuario_id"]
        if uid:
            con.execute("UPDATE usuarios SET activo=1 WHERE id=?", (uid,))
        else:
            ex = con.execute("SELECT id, rol FROM usuarios WHERE usuario=?", (correo,)).fetchone()
            if ex and ex["rol"] != "asesor":
                raise HTTPException(409, "Ese correo ya pertenece a otro usuario de la plataforma. Usa otro correo para el asesor.")
            if ex:
                uid = ex["id"]
                con.execute("UPDATE usuarios SET activo=1, nombre=? WHERE id=?", (a["nombre"], uid))
            else:
                uid = con.execute(
                    "INSERT INTO usuarios (usuario, nombre, clave_hash, rol, correo) VALUES (?,?,?, 'asesor', ?) RETURNING id",
                    (correo, a["nombre"], hash_clave(secrets.token_urlsafe(24)), correo)).fetchone()[0]
            con.execute("UPDATE asesores SET usuario_id=? WHERE id=?", (uid, aid))
        enlace = nuevo_enlace_clave(con, uid)
        nombre = a["nombre"]
    finally:
        con.close()
    texto = (f"Hola {nombre},\n\nTe dimos acceso a la plataforma como asesor. Crea tu clave desde este enlace "
             f"(sirve una sola vez y vence en 24 horas):\n{enlace}\n\nTu usuario es: {correo}")
    cuerpo = (f"<p>Hola <b>{html.escape(nombre)}</b>,</p><p>Te dimos acceso a la plataforma como asesor. "
              f"Crea tu clave desde este enlace (sirve una sola vez y vence en 24 horas):</p>"
              f'<p><a href="{html.escape(enlace)}">Crear mi clave</a></p><p>Tu usuario es: <b>{html.escape(correo)}</b></p>')
    enviar_correo(correo, "Tu acceso como asesor", texto, cuerpo)
    auditar("asesor_acceso", yo["usuario"], ip_cliente(request), f"asesor {aid} {correo}")
    return {"ok": True}


@router.delete("/asesores/{aid}/acceso")
def quitar_acceso(aid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        a = con.execute("SELECT usuario_id FROM asesores WHERE id=?", (aid,)).fetchone()
        if not a:
            raise HTTPException(404, "Asesor no encontrado")
        if a["usuario_id"]:
            # token_ver + 1 invalida de inmediato cualquier sesión abierta del asesor
            con.execute("UPDATE usuarios SET activo=0, token_ver=token_ver+1 WHERE id=?", (a["usuario_id"],))
            con.execute("UPDATE asesores SET usuario_id=NULL WHERE id=?", (aid,))
    finally:
        con.close()
    auditar("asesor_sin_acceso", yo["usuario"], ip_cliente(request), f"asesor {aid}")
    return {"ok": True}