from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel

from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/plataforma", tags=["pedidos"], dependencies=[Depends(solo_superadmin)])

ESTADOS_ORDEN = ("pendiente", "pagada", "error_aprovision", "cancelada")
ESTADOS_PEDIDO = ("nuevo", "en_curso", "entregado", "cancelado")


class PedidoPatch(BaseModel):
    estado: Literal["nuevo", "en_curso", "entregado", "cancelado"]


@router.get("/pendientes")
def pendientes():
    con = abrir_db()
    try:
        r = con.execute(
            "SELECT (SELECT COUNT(*) FROM pedidos_servicio WHERE estado='nuevo') AS pedidos_nuevos, "
            "(SELECT COUNT(*) FROM ordenes WHERE estado='error_aprovision') AS ordenes_error").fetchone()
        return dict(r)
    finally:
        con.close()


@router.get("/ordenes")
def ordenes(estado: str = ""):
    if estado and estado not in ESTADOS_ORDEN:
        raise HTTPException(400, "Estado inválido")
    w = "WHERE o.estado=?" if estado else "WHERE o.estado IN ('pagada','error_aprovision')"
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT o.id, o.tipo_cuenta, o.periodo, o.total, o.estado, o.proveedor, o.ref_externa, "
            "o.creado_en, o.pagado_en, o.comprador, e.nombre AS empresa "
            f"FROM ordenes o LEFT JOIN empresas e ON e.id = o.empresa_id {w} "
            "ORDER BY o.creado_en DESC LIMIT 200", [estado] if estado else []).fetchall()
        ids = [f["id"] for f in filas]
        items = con.execute(
            "SELECT orden_id, descripcion, cantidad, monto_unit FROM orden_items WHERE orden_id = ANY(?) ORDER BY id",
            (ids,)).fetchall() if ids else []
    finally:
        con.close()
    por: dict[str, list[dict]] = {}
    for i in items:
        por.setdefault(i["orden_id"], []).append(
            {"descripcion": i["descripcion"], "cantidad": i["cantidad"], "monto_unit": float(i["monto_unit"])})
    return [{**dict(f), "total": float(f["total"]), "items": por.get(f["id"], [])} for f in filas]


@router.get("/pedidos")
def pedidos(estado: str = ""):
    if estado and estado not in ESTADOS_PEDIDO:
        raise HTTPException(400, "Estado inválido")
    w = "WHERE p.estado=?" if estado else ""
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT p.id, p.servicio_nombre, p.orden_id, p.origen, p.estado, p.nombre, p.correo, p.telefono, "
            "p.mensaje, p.creado_en, e.nombre AS empresa "
            f"FROM pedidos_servicio p LEFT JOIN empresas e ON e.id = p.empresa_id {w} "
            "ORDER BY p.creado_en DESC LIMIT 200", [estado] if estado else []).fetchall()
        return [dict(f) for f in filas]
    finally:
        con.close()


@router.patch("/pedidos/{pid}")
def cambiar_pedido(pid: int, d: PedidoPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        r = con.execute("UPDATE pedidos_servicio SET estado=? WHERE id=? RETURNING id", (d.estado, pid)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Pedido no encontrado")
    auditar("pedido_estado", yo["usuario"], ip_cliente(request), f"pedido {pid} -> {d.estado}")
    return {"ok": True}