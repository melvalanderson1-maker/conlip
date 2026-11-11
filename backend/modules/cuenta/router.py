from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.limites import limitar
from core.ordenes import armar_orden, guardar_orden, pagar_orden
from core.pagos import info_publica, pago_disponible
from core.seguridad import ip_cliente, solo_titular
from modules.publico.checkout import PagoIn

router = APIRouter(prefix="/api/cuenta", tags=["cuenta"])


class PlanItem(BaseModel):
    plan_id: int
    modo: Literal["ver", "cotizar"]


class OrdenCuentaIn(BaseModel):
    periodo: Literal["mensual", "anual"]
    planes: list[PlanItem] = Field(default_factory=list, max_length=10)
    servicios: list[int] = Field(default_factory=list, max_length=20)
    usuarios_extra: int = Field(default=0, ge=0, le=200)


@router.get("")
def mi_cuenta(yo: dict = Depends(solo_titular)):
    eid = yo["empresa_id"]
    con = abrir_db()
    try:
        e = con.execute(
            "SELECT id, tipo, nombre, doc_tipo, doc_numero, correo, cupo_usuarios, usuarios_extra, extras_vence_en, "
            "(extras_vence_en IS NOT NULL AND extras_vence_en > now()) AS extras_vigentes "
            "FROM empresas WHERE id=?", (eid,)).fetchone()
        usados = con.execute("SELECT COUNT(*) FROM usuarios WHERE empresa_id=? AND activo=1", (eid,)).fetchone()[0]
        subs = con.execute(
            "SELECT s.id, s.plan_id, p.nombre, p.en_venta, s.modo, s.periodo, s.inicio, s.vence_en, s.estado, "
            "(s.vence_en > now() AND s.estado='activa') AS vigente, "
            "COALESCE((SELECT array_agg(pm.modulo ORDER BY pm.modulo) FROM plan_modulos pm WHERE pm.plan_id=s.plan_id), '{}') AS modulos "
            "FROM suscripciones s JOIN planes p ON p.id = s.plan_id WHERE s.empresa_id=? ORDER BY s.vence_en", (eid,)
        ).fetchall()
        ords = con.execute(
            "SELECT id, total, periodo, estado, pagado_en, creado_en FROM ordenes "
            "WHERE empresa_id=? AND estado IN ('pagada','error_aprovision') ORDER BY creado_en DESC LIMIT 20", (eid,)
        ).fetchall()
        ids = [o["id"] for o in ords]
        items = con.execute(
            "SELECT orden_id, descripcion, cantidad, monto_unit FROM orden_items WHERE orden_id = ANY(?) ORDER BY id",
            (ids,)).fetchall() if ids else []
        peds = con.execute(
            "SELECT id, servicio_nombre, estado, creado_en FROM pedidos_servicio WHERE empresa_id=? "
            "ORDER BY creado_en DESC LIMIT 20", (eid,)).fetchall()
    finally:
        con.close()

    por: dict[str, list[dict]] = {}
    for i in items:
        por.setdefault(i["orden_id"], []).append(
            {"descripcion": i["descripcion"], "cantidad": i["cantidad"], "monto_unit": float(i["monto_unit"])})
    empresa = dict(e)
    empresa["usados"] = usados
    empresa["cupo_efectivo"] = e["cupo_usuarios"] + (e["usuarios_extra"] if e["extras_vigentes"] else 0)
    return {
        "empresa": empresa,
        "suscripciones": [{**dict(s), "en_venta": bool(s["en_venta"]), "modulos": list(s["modulos"] or [])} for s in subs],
        "ordenes": [{**dict(o), "total": float(o["total"]), "items": por.get(o["id"], [])} for o in ords],
        "pedidos": [dict(p) for p in peds],
    }


@router.post("/ordenes")
def nueva_orden(d: OrdenCuentaIn, request: Request, yo: dict = Depends(solo_titular)):
    limitar(f"cuenta|{yo['id']}", 20)
    if not d.planes and not d.servicios and d.usuarios_extra == 0:
        raise HTTPException(400, "Tu pedido está vacío")
    ok, msg = pago_disponible()
    if not ok:
        raise HTTPException(503, msg)

    eid = yo["empresa_id"]
    con = abrir_db()
    try:
        e = con.execute(
            "SELECT tipo, nombre, doc_tipo, doc_numero, correo, cupo_usuarios FROM empresas WHERE id=?", (eid,)).fetchone()
        if d.usuarios_extra > 0:
            usados = con.execute("SELECT COUNT(*) FROM usuarios WHERE empresa_id=? AND activo=1", (eid,)).fetchone()[0]
            if e["cupo_usuarios"] + d.usuarios_extra < usados:
                raise HTTPException(
                    400, f"Tienes {usados} usuarios activos: el total de usuarios adicionales no puede dejar tu cupo por debajo de eso.")
        calculo = armar_orden(con, e["tipo"], d.periodo, [p.model_dump() for p in d.planes],
                              d.servicios, d.usuarios_extra, eid)
        comprador = {"nombre": e["nombre"], "doc_tipo": e["doc_tipo"], "doc_numero": e["doc_numero"],
                     "correo": e["correo"], "telefono": ""}
        oid = guardar_orden(con, e["tipo"], d.periodo, comprador, eid, calculo, d.usuarios_extra, ip_cliente(request))
    finally:
        con.close()
    return {
        "orden_id": oid, "total": float(calculo["total"]), "moneda": "PEN",
        "items": [{"descripcion": i["descripcion"], "cantidad": i["cantidad"], "monto_unit": float(i["monto_unit"])}
                  for i in calculo["items"]],
        "pago": info_publica({
            "id": oid, "total": float(calculo["total"]),
            "items": [{"descripcion": i["descripcion"], "cantidad": i["cantidad"]} for i in calculo["items"]],
        }),
    }


@router.post("/ordenes/{oid}/pagar")
def pagar(oid: str, d: PagoIn, request: Request, yo: dict = Depends(solo_titular)):
    limitar(f"cuenta-pago|{yo['id']}", 20)
    return pagar_orden(oid, d.model_dump(), yo["empresa_id"])