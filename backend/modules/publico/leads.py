"""Formulario público de contacto: crea un lead en el CRM desde la web (sin clave, protegido contra spam)."""
import logging

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.crm import avisar_lead, captar_lead, contacto_valido, registrar
from core.db import abrir_db
from core.limites import limitar
from core.ordenes import avisar_ventas
from core.seguridad import ip_cliente

logger = logging.getLogger("leads_publicos")
router = APIRouter(prefix="/api/publico", tags=["leads-publicos"])


class LeadWebIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=120)
    telefono: str = Field(default="", max_length=30)
    correo: str = Field(default="", max_length=160)
    empresa: str = Field(default="", max_length=160)
    interes: str = Field(default="", max_length=300)
    mensaje: str = Field(default="", max_length=1000)
    origen: str = Field(default="web", pattern=r"^[a-z]{3,20}$")
    acepto_privacidad: bool
    sitio: str = Field(default="", max_length=200)  # trampa para bots: una persona nunca lo llena


@router.post("/leads")
def nuevo_lead(d: LeadWebIn, request: Request):
    ip = ip_cliente(request)
    limitar(f"leadweb|{ip}", 5, 600)  # máximo 5 envíos por IP cada 10 minutos
    if d.sitio.strip():
        return {"ok": True}  # es un bot: se responde "bien" sin guardar nada
    if not d.acepto_privacidad:
        raise HTTPException(400, "Debes aceptar la política de privacidad")
    correo, tel = contacto_valido(d.correo, d.telefono)
    if not correo and not tel:
        raise HTTPException(400, "Escribe un teléfono o un correo para poder contactarte")
    mensaje = d.mensaje.strip()
    con = abrir_db()
    try:
        lid, creado = captar_lead(
            con, nombre=d.nombre, correo=correo, telefono=tel, empresa=d.empresa, origen=d.origen,
            interes=d.interes.strip() or mensaje[:80], creado_por="formulario web")
        if mensaje:
            registrar(con, lid, "nota", f"Mensaje del formulario: {mensaje}", "formulario web")
    finally:
        con.close()
    avisar_lead(lid)
    try:
        avisar_ventas(
            f"{'Nuevo lead' if creado else 'Lead que volvió a escribir'} desde la web: {d.nombre.strip()}",
            f"{d.nombre.strip()} · {tel or '-'} · {correo or '-'} · {d.empresa.strip() or '-'}\n"
            f"Origen: {d.origen}\nInterés: {d.interes.strip() or '-'}\n\n{mensaje}")
    except Exception:
        logger.exception("No se pudo avisar a ventas del lead %s", lid)
    return {"ok": True}