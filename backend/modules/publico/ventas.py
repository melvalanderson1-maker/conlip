from fastapi import APIRouter, HTTPException, Request

from core.db import abrir_db
from core.difusion import a_superadmins
from core.limites import limitar
from core.seguridad import ip_cliente
from core.ventas import ajustes_publicos

router = APIRouter(prefix="/api/publico", tags=["ventas-publico"])


@router.get("/ventas")
def ventas():
    return ajustes_publicos()


@router.post("/ordenes/{oid}/whatsapp")
def contacto_whatsapp(oid: str, request: Request):
    """El cliente pulsó «Enviar pedido por WhatsApp»: se marca y se avisa al equipo (solo la primera vez)."""
    limitar(f"wa|{ip_cliente(request)}", 30)
    con = abrir_db()
    try:
        o = con.execute(
            "SELECT id, estado, total, comprador, contactado_en FROM ordenes WHERE id=?", (oid,)).fetchone()
        if not o:
            raise HTTPException(404, "Pedido no encontrado")
        if o["estado"] != "pendiente":
            return {"ok": True}
        primera = o["contactado_en"] is None
        con.execute("UPDATE ordenes SET contactado_en = COALESCE(contactado_en, now()) WHERE id=?", (oid,))
        comprador = o["comprador"] or {}
        total = float(o["total"])
    finally:
        con.close()
    if primera:
        from core.ordenes import avisar_ventas
        avisar_ventas(
            "Nuevo pedido por WhatsApp",
            f"Pedido {oid[:8].upper()} de {comprador.get('nombre', '')}\n"
            f"Documento: {comprador.get('doc_tipo', '')} {comprador.get('doc_numero', '')}\n"
            f"Correo: {comprador.get('correo', '')} · Tel: {comprador.get('telefono', '')}\n"
            f"Total: S/ {total:.2f}\n\nConfírmalo en el panel: Ventas.")
        a_superadmins({"tipo": "pedido"})
        # CRM: quien pulsa «Enviar por WhatsApp» es un lead real (se guarda aunque el CRM esté apagado)
        from core.crm import captar_lead_seguro
        captar_lead_seguro(
            nombre=comprador.get("nombre", "Cliente"), correo=comprador.get("correo", ""), telefono=comprador.get("telefono", ""),
            doc_tipo=comprador.get("doc_tipo", ""), doc_numero=comprador.get("doc_numero", ""),
            origen="pedido_whatsapp", interes=f"Pedido {oid[:8].upper()}", valor=total, orden_id=oid)
    return {"ok": True}