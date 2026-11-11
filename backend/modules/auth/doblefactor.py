from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.doblefactor import (
    generar_respaldo, nuevo_secreto, paso_valido, qr_png, respaldo_restantes, roles_exigidos, uri_totp, verificar_codigo,
)
from core.limites import limitar
from core.secretos import cifrar, clave_ok, descifrar
from core.seguridad import (
    auditar, cargar_usuario, crear_token, ip_cliente, leer_ticket_2fa, usuario_actual, usuario_publico, verificar_clave,
)

router = APIRouter(prefix="/api/auth/2fa", tags=["2fa"])


class ClaveIn(BaseModel):
    clave: str = Field(min_length=1, max_length=72)


class CodigoIn(BaseModel):
    codigo: str = Field(min_length=6, max_length=20)


class ClaveCodigoIn(BaseModel):
    clave: str = Field(min_length=1, max_length=72)
    codigo: str = Field(min_length=6, max_length=20)


class VerificarIn(BaseModel):
    ticket: str = Field(min_length=10, max_length=800)
    codigo: str = Field(min_length=6, max_length=20)


def _comprobar_clave(con, u: dict, clave: str, request: Request) -> None:
    """Para cambios sensibles se vuelve a pedir la clave (si alguien se queda con una sesión abierta no puede cambiar el 2FA)."""
    limitar(f"2fa-clave|{u['id']}", 8, 300)
    h = con.execute("SELECT clave_hash FROM usuarios WHERE id=?", (u["id"],)).fetchone()
    if not h or not verificar_clave(clave, h["clave_hash"]):
        auditar("2fa_clave_incorrecta", u["usuario"], ip_cliente(request))
        raise HTTPException(400, "La clave no es correcta")  # 400, no 401: un error aquí no debe cerrar la sesión


def _emisor(con) -> str:
    r = con.execute("SELECT valor FROM configuracion WHERE clave = 'sitio_nombre'").fetchone()
    return (r["valor"] or "").strip() or "COTI" if r else "COTI"


@router.get("/estado")
def estado(u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        restantes = respaldo_restantes(con, u["id"]) if u["totp_activo"] else 0
    finally:
        con.close()
    return {"activo": bool(u["totp_activo"]), "respaldo_restantes": restantes, "exigido": u["rol"] in roles_exigidos()}


@router.post("/preparar")
def preparar(d: ClaveIn, request: Request, u: dict = Depends(usuario_actual)):
    """Genera el secreto y el QR. Todavía no queda activa: falta confirmar con un código."""
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se puede guardar el secreto de forma segura.")
    if u["totp_activo"]:
        raise HTTPException(400, "Ya está activada. Si cambiaste de teléfono, desactívala y vuelve a activarla.")
    con = abrir_db()
    try:
        _comprobar_clave(con, u, d.clave, request)
        secreto = nuevo_secreto()
        con.execute("UPDATE usuarios SET totp_secreto=?, totp_paso=0 WHERE id=?", (cifrar(secreto), u["id"]))
        uri = uri_totp(secreto, u["usuario"], _emisor(con))
    finally:
        con.close()
    return {"secreto": secreto, "qr": qr_png(uri)}


@router.post("/activar")
def activar(d: CodigoIn, request: Request, u: dict = Depends(usuario_actual)):
    limitar(f"2fa|{u['id']}", 8, 300)
    con = abrir_db()
    try:
        fila = con.execute(
            "SELECT totp_secreto, totp_paso, totp_activo FROM usuarios WHERE id=?", (u["id"],)).fetchone()
        if fila["totp_activo"]:
            raise HTTPException(400, "Ya está activada")
        secreto = descifrar(fila["totp_secreto"]) if fila["totp_secreto"] else ""
        if not secreto:
            raise HTTPException(400, "Primero genera el código QR")
        paso = paso_valido(secreto, d.codigo, fila["totp_paso"])
        if paso is None:
            auditar("2fa_activar_fallido", u["usuario"], ip_cliente(request))
            raise HTTPException(400, "El código no es correcto. Revisa la hora de tu teléfono e inténtalo con el código nuevo.")
        con.execute("UPDATE usuarios SET totp_activo=1, totp_paso=? WHERE id=?", (paso, u["id"]))
        codigos = generar_respaldo(con, u["id"])
    finally:
        con.close()
    auditar("2fa_activada", u["usuario"], ip_cliente(request))
    return {"ok": True, "codigos": codigos}


@router.post("/desactivar")
def desactivar(d: ClaveCodigoIn, request: Request, u: dict = Depends(usuario_actual)):
    if u["rol"] in roles_exigidos():
        raise HTTPException(403, "La verificación en dos pasos es obligatoria para tu rol y no se puede desactivar.")
    if not u["totp_activo"]:
        raise HTTPException(400, "No está activada")
    limitar(f"2fa|{u['id']}", 8, 300)
    con = abrir_db()
    try:
        _comprobar_clave(con, u, d.clave, request)
        if not verificar_codigo(con, u["id"], d.codigo):
            auditar("2fa_desactivar_fallido", u["usuario"], ip_cliente(request))
            raise HTTPException(400, "El código no es correcto")
        # token_ver + 1 cierra todas las sesiones abiertas de este usuario
        con.execute("UPDATE usuarios SET totp_activo=0, totp_secreto='', totp_paso=0, token_ver=token_ver+1 WHERE id=?", (u["id"],))
        con.execute("DELETE FROM codigos_respaldo WHERE usuario_id=?", (u["id"],))
    finally:
        con.close()
    auditar("2fa_desactivada", u["usuario"], ip_cliente(request))
    return {"ok": True, "cerrar_sesion": True}


@router.post("/respaldo")
def nuevos_respaldo(d: ClaveCodigoIn, request: Request, u: dict = Depends(usuario_actual)):
    """Genera 10 códigos de respaldo nuevos (los anteriores dejan de servir)."""
    if not u["totp_activo"]:
        raise HTTPException(400, "Primero activa la verificación en dos pasos")
    limitar(f"2fa|{u['id']}", 8, 300)
    con = abrir_db()
    try:
        _comprobar_clave(con, u, d.clave, request)
        if not verificar_codigo(con, u["id"], d.codigo):
            auditar("2fa_respaldo_fallido", u["usuario"], ip_cliente(request))
            raise HTTPException(400, "El código no es correcto")
        codigos = generar_respaldo(con, u["id"])
    finally:
        con.close()
    auditar("2fa_respaldo_nuevo", u["usuario"], ip_cliente(request))
    return {"ok": True, "codigos": codigos}


@router.post("/verificar")
def verificar(d: VerificarIn, request: Request):
    """Segundo paso del inicio de sesión: canjea el comprobante + el código por la sesión."""
    ip = ip_cliente(request)
    limitar(f"2fa-ip|{ip}", 30, 300)
    uid = leer_ticket_2fa(d.ticket)
    limitar(f"2fa|{uid}", 8, 300)  # un código de 6 dígitos no se puede adivinar a base de intentos
    con = abrir_db()
    try:
        ok = verificar_codigo(con, uid, d.codigo)
    finally:
        con.close()
    u = cargar_usuario(uid)
    if not ok:
        auditar("2fa_fallido", u["usuario"], ip)
        raise HTTPException(400, "Código incorrecto o vencido")
    auditar("login_ok", u["usuario"], ip, "con verificación en dos pasos")
    return {"token": crear_token(u), "usuario": usuario_publico(u)}