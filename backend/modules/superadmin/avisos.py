import math
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.agenda import zona
from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, solo_superadmin
from core.vencimientos import PERMITIDOS, config, enviar_ahora, guardar_config

router = APIRouter(prefix="/api/avisos/admin", tags=["avisos"], dependencies=[Depends(solo_superadmin)])


class ConfigIn(BaseModel):
    activo: bool
    dias: list[int] = Field(default_factory=list, max_length=4)


@router.get("")
def ver():
    con = abrir_db()
    try:
        activo, dias = config(con)
        filas = con.execute(
            "SELECT s.id, s.modo, s.vence_en, p.nombre AS plan, e.id AS empresa_id, e.nombre AS empresa, e.correo, "
            "COALESCE((SELECT array_agg(a.umbral ORDER BY a.umbral DESC) FROM avisos_vencimiento a "
            "WHERE a.suscripcion_id = s.id AND a.vence_en = s.vence_en), '{}') AS avisos "
            "FROM suscripciones s JOIN planes p ON p.id = s.plan_id JOIN empresas e ON e.id = s.empresa_id "
            "WHERE s.estado = 'activa' AND e.activo = 1 "
            "AND s.vence_en > now() - interval '15 days' AND s.vence_en <= now() + interval '45 days' "
            "ORDER BY s.vence_en").fetchall()
    finally:
        con.close()
    ahora = datetime.now(zona())
    proximos = []
    for f in filas:
        delta = (f["vence_en"] - ahora).total_seconds() / 86400
        proximos.append({**dict(f), "dias": math.ceil(delta) if delta > 0 else 0, "vencida": delta <= 0,
                         "avisos": list(f["avisos"] or [])})
    return {"activo": activo, "dias": dias, "permitidos": list(PERMITIDOS), "proximos": proximos}


@router.put("/config")
def guardar(d: ConfigIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if any(x not in PERMITIDOS for x in d.dias):
        raise HTTPException(400, "Los días permitidos son 14, 7, 3 y 1")
    con = abrir_db()
    try:
        guardar_config(con, d.activo, d.dias)
    finally:
        con.close()
    auditar("avisos_vencimiento", yo["usuario"], ip_cliente(request), f"activo={d.activo} dias={sorted(d.dias, reverse=True)}")
    return {"ok": True}


@router.post("/enviar/{sid}")
def enviar(sid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        try:
            correo = enviar_ahora(con, sid)
        except ValueError as e:
            raise HTTPException(400, str(e))
    finally:
        con.close()
    if correo is None:
        raise HTTPException(404, "Suscripción no encontrada")
    auditar("aviso_vencimiento_manual", yo["usuario"], ip_cliente(request), f"suscripcion {sid} -> {correo}")
    return {"ok": True, "correo": correo}