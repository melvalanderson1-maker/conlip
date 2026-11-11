import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.seguridad import (
    auditar, cargar_usuario, crear_token, crear_ticket_2fa,
    hash_clave, ip_cliente, usuario_actual, usuario_publico,
    verificar_clave,
)

router = APIRouter(prefix="/api/auth", tags=["auth"])

# Fuerza bruta: 5 fallos por IP+usuario o 20 por IP en 5 min => bloqueo de 5 min
VENTANA = 300
_fallos: dict[str, list[float]] = {}
_HASH_FALSO = hash_clave("clave-falsa-para-igualar-tiempos-1")


def _bloqueado(k: str, maximo: int) -> bool:
    ahora = time.time()
    _fallos[k] = [t for t in _fallos.get(k, []) if ahora - t < VENTANA]
    return len(_fallos[k]) >= maximo


class LoginIn(BaseModel):
    usuario: str = Field(min_length=1, max_length=60)
    clave: str = Field(min_length=1, max_length=72)


@router.post("/login")
def login(datos: LoginIn, request: Request):
    ip = ip_cliente(request)
    nombre = datos.usuario.strip().lower()
    k_user, k_ip = f"{ip}|{nombre}", f"ip|{ip}"
    if _bloqueado(k_user, 5) or _bloqueado(k_ip, 20):
        auditar("login_bloqueado", nombre, ip)
        raise HTTPException(429, "Demasiados intentos. Espera 5 minutos.")

    con = abrir_db()
    try:
        u = con.execute("SELECT * FROM usuarios WHERE usuario=?", (nombre,)).fetchone()
    finally:
        con.close()

    # Siempre se ejecuta bcrypt (exista o no el usuario) para no revelar usuarios por tiempo de respuesta
    clave_ok = verificar_clave(datos.clave, u["clave_hash"] if u else _HASH_FALSO)
    if not (u and u["activo"] == 1 and clave_ok):
        _fallos.setdefault(k_user, []).append(time.time())
        _fallos.setdefault(k_ip, []).append(time.time())
        auditar("login_fallido", nombre, ip)
        raise HTTPException(401, "Usuario o clave incorrectos")

    _fallos.pop(k_user, None)

    d = cargar_usuario(u["id"])

    if d.get("totp_activo"):
        auditar("login_clave_ok_pide_2fa", nombre, ip)
        return {
            "requiere_2fa": True,
            "ticket": crear_ticket_2fa(d)
        }

    auditar("login_ok", nombre, ip)
    return {
        "token": crear_token(d),
        "usuario": usuario_publico(d)
    }


@router.get("/yo")
def yo(u: dict = Depends(usuario_actual)):
    return usuario_publico(u)