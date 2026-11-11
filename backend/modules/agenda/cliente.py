from datetime import date, datetime, timedelta
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.agenda import (
    avisar_pedido, calcular, correo_sesion, recalcular, reglas, resumen_pedido, sincronizar_entregables, slots, zona,
    MODULOS_SERVICIOS, servicios_habilitados,
)
from core.correo import enviar_correo
from core import videollamadas as vc
from core.db import abrir_db
from core.limites import limitar
from core.seguridad import auditar, ip_cliente, solo_titular, usuario_actual

router = APIRouter(prefix="/api/mis-servicios", tags=["mis-servicios"])


def _aware(dt: datetime) -> datetime:
    return dt if dt.tzinfo else dt.replace(tzinfo=zona())


def _pedido(con, pid: int, eid: int):
    p = con.execute(
        "SELECT id, servicio_id, servicio_nombre, estado, nombre, correo FROM pedidos_servicio WHERE id=? AND empresa_id=?",
        (pid, eid)).fetchone()
    if not p:
        raise HTTPException(404, "Servicio no encontrado")
    return p


class AgendarIn(BaseModel):
    inicio: datetime


class CambioIn(BaseModel):
    accion: Literal["cancelar", "reprogramar"]
    inicio: datetime | None = None

@router.get("/modulos")
def modulos(yo: dict = Depends(usuario_actual)):
    """Módulos donde este usuario ve la opción Servicios: habilitados por el superadmin y solo para el titular."""
    titular = (yo["rol"] != "superadmin" and yo.get("empresa_id") is not None
               and (yo["rol"] == "admin" or yo.get("empresa_tipo") == "persona"))
    con = abrir_db()
    try:
        hab = servicios_habilitados(con)
    finally:
        con.close()
    return {m: bool(titular and hab[m]) for m in MODULOS_SERVICIOS}


@router.get("")
def mis_servicios(modulo: str = "", yo: dict = Depends(solo_titular)):
    if modulo and modulo not in (*MODULOS_SERVICIOS, "general"):
        raise HTTPException(400, "Módulo inválido")
    filtro = "AND COALESCE(s.modulo, 'general') = ?" if modulo else ""
    eid = yo["empresa_id"]
    con = abrir_db()
    try:
        sincronizar_entregables(con)
        r = reglas(con)
        peds = con.execute(
            "SELECT p.id, p.servicio_nombre, p.estado, p.creado_en, COALESCE(s.sesiones, 0) AS inc, "
            "COALESCE(s.duracion_sesion_min, 60) AS dur FROM pedidos_servicio p "
            "LEFT JOIN servicios s ON s.id = p.servicio_id "
            f"WHERE p.empresa_id=? AND p.estado <> 'cancelado' {filtro} ORDER BY p.creado_en DESC",
            [eid] + ([modulo] if modulo else [])).fetchall()
        ids = [p["id"] for p in peds]
        ents = con.execute(
            "SELECT pedido_id, id, titulo, estado, nota FROM pedido_entregables WHERE pedido_id = ANY(?) ORDER BY orden, id",
            (ids,)).fetchall() if ids else []
        ses = con.execute(
            "SELECT q.id, q.pedido_id, q.inicio, q.fin, q.estado, q.enlace, q.plataforma, a.nombre AS asesor "
            "FROM sesiones_servicio q JOIN asesores a ON a.id = q.asesor_id WHERE q.pedido_id = ANY(?) ORDER BY q.inicio",
            (ids,)).fetchall() if ids else []
        res = {pid: resumen_pedido(con, pid) for pid in ids}
    finally:
        con.close()

    ahora = datetime.now(zona())
    limite = timedelta(hours=r["agenda_cancelacion_horas"])
    out = []
    for p in peds:
        rs = res[p["id"]]
        _, pct = calcular(rs)
        out.append({
            "id": p["id"], "servicio_nombre": p["servicio_nombre"], "estado": p["estado"], "creado_en": p["creado_en"],
            "progreso": pct, "sesiones_incluidas": p["inc"], "duracion_min": p["dur"],
            "pendientes_agendar": max(0, p["inc"] - rs["programadas"] - rs["realizadas"]),
            "entregables": [{"id": e["id"], "titulo": e["titulo"], "estado": e["estado"], "nota": e["nota"]}
                            for e in ents if e["pedido_id"] == p["id"]],
            "sesiones": [{
                "id": s["id"], "inicio": s["inicio"], "fin": s["fin"], "estado": s["estado"], "asesor": s["asesor"],
                "plataforma": s["plataforma"], "enlace": s["enlace"] if s["estado"] == "programada" else "",
                "puede_cambiar": s["estado"] == "programada" and s["inicio"] - ahora >= limite,
            } for s in ses if s["pedido_id"] == p["id"]],
        })
    return {"reglas": {"cancelacion_horas": r["agenda_cancelacion_horas"], "antelacion_horas": r["agenda_antelacion_horas"]},
            "servicios": out}


@router.get("/{pid}/horarios")
def horarios(pid: int, desde: date, dias: int = 14, yo: dict = Depends(solo_titular)):
    con = abrir_db()
    try:
        p = _pedido(con, pid, yo["empresa_id"])
        if p["servicio_id"] is None:
            raise HTTPException(400, "Este servicio no tiene agenda")
        lista = slots(con, p["servicio_id"], desde, min(max(dias, 1), 30))
    finally:
        con.close()
    return [{"inicio": s["inicio"], "fin": s["fin"]} for s in lista]


@router.post("/{pid}/sesiones")
def agendar(pid: int, d: AgendarIn, request: Request, yo: dict = Depends(solo_titular)):
    limitar(f"agendar|{yo['id']}", 20)
    con = abrir_db()
    try:
        p = _pedido(con, pid, yo["empresa_id"])
        if p["servicio_id"] is None:
            raise HTTPException(400, "Este servicio no tiene agenda")
        rs = resumen_pedido(con, pid)
        if rs["inc"] - rs["programadas"] - rs["realizadas"] <= 0:
            raise HTTPException(400, "Ya agendaste todas las sesiones incluidas en este servicio")
        inicio = _aware(d.inicio)
        dia = inicio.astimezone(zona()).date()
        elegido = next((s for s in slots(con, p["servicio_id"], dia, 1) if s["inicio"] == inicio), None)
        if not elegido:
            raise HTTPException(409, "Ese horario ya no está disponible. Elige otro.")
        a = con.execute(
            "SELECT id, nombre, correo, plataforma, enlace, modo_enlace, zoom_usuario FROM asesores WHERE id=?",
            (elegido["asesor_id"],)).fetchone()
        sala = vc.crear(dict(a), dict(p), elegido["inicio"], elegido["fin"])
        try:
            con.execute(
                "INSERT INTO sesiones_servicio (pedido_id, asesor_id, inicio, fin, enlace, plataforma, proveedor, ext_id, creado_por) "
                "VALUES (?,?,?,?,?,?,?,?, 'cliente')",
                (pid, a["id"], elegido["inicio"], elegido["fin"], sala["enlace"], a["plataforma"],
                 sala["proveedor"], sala["ext_id"]))
        except Exception:
            vc.cancelar({"proveedor": sala["proveedor"], "ext_id": sala["ext_id"]})
            raise HTTPException(409, "Ese horario acaba de ocuparse. Elige otro.")
        recalcular(con, pid)
        ped, ase, ini, fin = dict(p), {**dict(a), "enlace": sala["enlace"]}, elegido["inicio"], elegido["fin"]
    finally:
        con.close()
    correo_sesion(ped, ase, ini, fin, "Sesión agendada")
    auditar("sesion_agendada_cliente", yo["usuario"], ip_cliente(request), f"pedido {pid} {ini.isoformat()}")
    avisar_pedido(pid)
    return {"ok": True}

@router.patch("/sesiones/{sid}")
def cambiar(sid: int, d: CambioIn, request: Request, yo: dict = Depends(solo_titular)):
    limitar(f"cambiar|{yo['id']}", 30)
    nuevo = None
    con = abrir_db()
    try:
        s = con.execute(
            "SELECT q.id, q.pedido_id, q.asesor_id, q.inicio, q.estado, q.proveedor, q.ext_id, q.enlace, p.empresa_id, "
            "p.servicio_id, p.servicio_nombre, p.nombre, p.correo, a.nombre AS a_nombre, a.correo AS a_correo "
            "FROM sesiones_servicio q JOIN pedidos_servicio p ON p.id = q.pedido_id "
            "JOIN asesores a ON a.id = q.asesor_id WHERE q.id=?", (sid,)).fetchone()
        if not s or s["empresa_id"] != yo["empresa_id"]:
            raise HTTPException(404, "Sesión no encontrada")
        if s["estado"] != "programada":
            raise HTTPException(400, "Solo se pueden cambiar sesiones programadas")
        horas = reglas(con)["agenda_cancelacion_horas"]
        if s["inicio"] - datetime.now(zona()) < timedelta(hours=horas):
            raise HTTPException(400, f"Solo puedes cambiar la sesión hasta {horas} horas antes. Escríbenos y te ayudamos.")
        pid = s["pedido_id"]
        ped = {"servicio_nombre": s["servicio_nombre"], "nombre": s["nombre"], "correo": s["correo"]}
        if d.accion == "cancelar":
            vc.cancelar(dict(s))
            con.execute("UPDATE sesiones_servicio SET estado='cancelada', actualizado_en=now() WHERE id=?", (sid,))
        else:
            if d.inicio is None or s["servicio_id"] is None:
                raise HTTPException(400, "Elige el nuevo horario")
            inicio = _aware(d.inicio)
            dia = inicio.astimezone(zona()).date()
            elegido = next((x for x in slots(con, s["servicio_id"], dia, 1) if x["inicio"] == inicio), None)
            if not elegido:
                raise HTTPException(409, "Ese horario ya no está disponible. Elige otro.")
            a = con.execute(
                "SELECT id, nombre, correo, plataforma, enlace, modo_enlace, zoom_usuario FROM asesores WHERE id=?",
                (elegido["asesor_id"],)).fetchone()
            sala = vc.mover(dict(s), dict(a), ped, elegido["inicio"], elegido["fin"], a["id"] == s["asesor_id"])
            try:
                con.execute(
                    "UPDATE sesiones_servicio SET asesor_id=?, inicio=?, fin=?, enlace=?, plataforma=?, proveedor=?, ext_id=?, "
                    "recordatorio_24h=0, recordatorio_1h=0, actualizado_en=now() WHERE id=?",
                    (a["id"], elegido["inicio"], elegido["fin"], sala["enlace"], a["plataforma"],
                     sala["proveedor"], sala["ext_id"], sid))
            except Exception:
                raise HTTPException(409, "Ese horario acaba de ocuparse. Elige otro.")
            nuevo = ({**dict(a), "enlace": sala["enlace"]}, elegido["inicio"], elegido["fin"])
        recalcular(con, pid)
        asesor_correo, fecha_ant = s["a_correo"], s["inicio"]
    finally:
        con.close()

    if nuevo:
        correo_sesion(ped, nuevo[0], nuevo[1], nuevo[2], "Sesión reprogramada")
    else:
        cuando = fecha_ant.astimezone(zona()).strftime("%d/%m/%Y %H:%M")
        texto = f"La sesión de {ped['servicio_nombre']} del {cuando} (hora de Lima) fue cancelada."
        if ped["correo"]:
            enviar_correo(ped["correo"], f"Sesión cancelada: {ped['servicio_nombre']}", f"Hola {ped['nombre']},\n\n{texto}")
        if asesor_correo:
            enviar_correo(asesor_correo, f"Sesión cancelada: {ped['servicio_nombre']}", f"{ped['nombre']} canceló. {texto}")
    auditar(f"sesion_{d.accion}_cliente", yo["usuario"], ip_cliente(request), f"sesion {sid}")
    avisar_pedido(pid)
    return {"ok": True}