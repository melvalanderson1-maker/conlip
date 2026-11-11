"""Verificación en dos pasos (TOTP): compatible con Google Authenticator, Microsoft Authenticator, Authy y 1Password."""
import hashlib
import hmac
import os
import re
import secrets
import time

import pyotp
import segno

from core.secretos import clave_base, descifrar

ALFABETO = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"  # sin 0/O ni 1/I/L: se leen sin confundirse
CANTIDAD_RESPALDO = 10


def roles_exigidos() -> set[str]:
    """Roles que no pueden operar sin 2FA. Se configura con EXIGIR_2FA=superadmin (varios separados por coma)."""
    return {r.strip() for r in os.getenv("EXIGIR_2FA", "").split(",") if r.strip()}


def nuevo_secreto() -> str:
    return pyotp.random_base32()  # 160 bits


def uri_totp(secreto: str, cuenta: str, emisor: str) -> str:
    return pyotp.TOTP(secreto).provisioning_uri(name=cuenta, issuer_name=emisor)


def qr_png(uri: str) -> str:
    """Código QR como imagen (data URI): no se necesita ninguna librería en el navegador."""
    return segno.make(uri, error="m").png_data_uri(scale=6, border=2)


def paso_valido(secreto: str, codigo: str, ultimo_paso: int) -> int | None:
    """Devuelve el periodo (de 30 s) del código si es válido y no se usó antes; None si no."""
    codigo = re.sub(r"\s", "", codigo or "")
    if not re.fullmatch(r"\d{6}", codigo):
        return None
    totp = pyotp.TOTP(secreto)
    ahora = int(time.time()) // 30
    for paso in (ahora - 1, ahora, ahora + 1):  # tolera 30 s de desfase del reloj del teléfono
        if paso > ultimo_paso and hmac.compare_digest(totp.at(paso * 30), codigo):
            return paso
    return None


# ---------------- Códigos de respaldo ----------------
def _huella(codigo: str) -> str:
    limpio = re.sub(r"[^A-Z0-9]", "", codigo.upper())
    # HMAC con la clave del servidor: aunque alguien copie la base de datos, no puede probar códigos offline
    return hmac.new(clave_base().encode(), f"respaldo|{limpio}".encode(), hashlib.sha256).hexdigest()


def es_respaldo(codigo: str) -> bool:
    return len(re.sub(r"[^A-Za-z0-9]", "", codigo or "")) == 10


def generar_respaldo(con, uid: int) -> list[str]:
    """Crea 10 códigos nuevos (reemplazan a los anteriores). Se muestran UNA sola vez."""
    con.execute("DELETE FROM codigos_respaldo WHERE usuario_id=?", (uid,))
    codigos = []
    for _ in range(CANTIDAD_RESPALDO):
        c = "".join(secrets.choice(ALFABETO) for _ in range(10))
        con.execute("INSERT INTO codigos_respaldo (usuario_id, codigo_hash) VALUES (?,?)", (uid, _huella(c)))
        codigos.append(f"{c[:5]}-{c[5:]}")
    return codigos


def respaldo_restantes(con, uid: int) -> int:
    return con.execute(
        "SELECT COUNT(*) FROM codigos_respaldo WHERE usuario_id=? AND usado_en IS NULL", (uid,)).fetchone()[0]


def verificar_codigo(con, uid: int, codigo: str) -> bool:
    """Acepta el código de la app (6 dígitos) o un código de respaldo (de un solo uso)."""
    u = con.execute("SELECT totp_secreto, totp_paso FROM usuarios WHERE id=? AND totp_activo=1", (uid,)).fetchone()
    if not u:
        return False
    if es_respaldo(codigo):
        return con.execute(
            "UPDATE codigos_respaldo SET usado_en = now() WHERE usuario_id=? AND codigo_hash=? AND usado_en IS NULL "
            "RETURNING id", (uid, _huella(codigo))).fetchone() is not None
    secreto = descifrar(u["totp_secreto"])
    if not secreto:
        return False
    paso = paso_valido(secreto, codigo, u["totp_paso"])
    if paso is None:
        return False
    # Gana quien guarda primero este periodo: dos envíos simultáneos del mismo código no pasan los dos
    return con.execute(
        "UPDATE usuarios SET totp_paso=? WHERE id=? AND totp_paso < ? RETURNING id", (paso, uid, paso)).fetchone() is not None