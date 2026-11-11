import re
from datetime import datetime

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.agenda import zona
from core.db import abrir_db
from core.legal import (
    BASE_PRIVACIDAD, BASE_TERMINOS, CLAVE_FECHA, CLAVE_PRIVACIDAD, CLAVE_TERMINOS, CLAVES, MARCAS, armar, leer_crudo,
)
from core.seguridad import auditar, ip_cliente, solo_superadmin

router_publico = APIRouter(prefix="/api/publico", tags=["legal"])
router_admin = APIRouter(prefix="/api/legal/admin", tags=["legal"], dependencies=[Depends(solo_superadmin)])

CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


@router_publico.get("/legal")
def legal_publico():
    con = abrir_db()
    try:
        return armar(con)
    finally:
        con.close()


class LegalIn(BaseModel):
    razon_social: str = Field(default="", max_length=160)
    ruc: str = Field(default="", max_length=11)
    domicilio: str = Field(default="", max_length=240)
    correo: str = Field(default="", max_length=160)
    ciudad: str = Field(default="", max_length=80)
    terminos: str = Field(default="", max_length=60000)
    privacidad: str = Field(default="", max_length=60000)


def _guardar(con, clave: str, valor: str) -> None:
    con.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?,?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
        (clave, valor))


@router_admin.get("")
def ver():
    con = abrir_db()
    try:
        cfg = leer_crudo(con)
    finally:
        con.close()
    return {
        "datos": {k: cfg.get(c, "") for k, c in CLAVES.items()},
        "terminos": cfg.get(CLAVE_TERMINOS) or BASE_TERMINOS,
        "privacidad": cfg.get(CLAVE_PRIVACIDAD) or BASE_PRIVACIDAD,
        "terminos_base": BASE_TERMINOS,
        "privacidad_base": BASE_PRIVACIDAD,
        "actualizado": cfg.get(CLAVE_FECHA, ""),
        "marcas": MARCAS,
    }


@router_admin.put("")
def guardar(d: LegalIn, request: Request, yo: dict = Depends(solo_superadmin)):
    ruc = d.ruc.strip()
    if ruc and not re.fullmatch(r"\d{11}", ruc):
        raise HTTPException(400, "El RUC debe tener 11 dígitos")
    correo = d.correo.strip()
    if correo and not CORREO.match(correo):
        raise HTTPException(400, "El correo no es válido")
    datos = {"razon_social": d.razon_social, "ruc": ruc, "domicilio": d.domicilio, "correo": correo, "ciudad": d.ciudad}
    con = abrir_db()
    try:
        for k, v in datos.items():
            _guardar(con, CLAVES[k], v.strip())
        # Si el texto es igual a la base se guarda vacío: así sigue la base cuando se actualice el sistema
        for clave, texto, base in ((CLAVE_TERMINOS, d.terminos, BASE_TERMINOS), (CLAVE_PRIVACIDAD, d.privacidad, BASE_PRIVACIDAD)):
            t = texto.strip()
            _guardar(con, clave, "" if t in ("", base.strip()) else t)
        _guardar(con, CLAVE_FECHA, datetime.now(zona()).strftime("%d/%m/%Y"))
    finally:
        con.close()
    auditar("legal_editado", yo["usuario"], ip_cliente(request), "términos y privacidad")
    return {"ok": True}