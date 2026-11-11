import base64
import hashlib
import os

from cryptography.fernet import Fernet, InvalidToken

from core.db import abrir_db


def clave_ok() -> bool:
    return len(os.getenv("SECRETS_KEY", "").strip()) >= 24


def clave_base() -> str:
    k = os.getenv("SECRETS_KEY", "").strip()
    if len(k) < 24:
        raise RuntimeError("Falta SECRETS_KEY en backend/.env (mínimo 24 caracteres).")
    return k


def _fernet() -> Fernet:
    llave = hashlib.sha256(("secretos|" + clave_base()).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(llave))


def guardar(clave: str, valor: str) -> None:
    cifrado = _fernet().encrypt(valor.encode()).decode()
    con = abrir_db()
    try:
        con.execute(
            "INSERT INTO secretos (clave, valor) VALUES (?,?) "
            "ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor, actualizado_en = now()", (clave, cifrado))
    finally:
        con.close()


def leer(clave: str) -> str:
    """Devuelve el valor descifrado; cadena vacía si no existe o no se puede descifrar."""
    con = abrir_db()
    try:
        r = con.execute("SELECT valor FROM secretos WHERE clave=?", (clave,)).fetchone()
    finally:
        con.close()
    if not r:
        return ""
    try:
        return _fernet().decrypt(r["valor"].encode()).decode()
    except (InvalidToken, RuntimeError):
        return ""


def borrar(*claves: str) -> None:
    con = abrir_db()
    try:
        con.execute("DELETE FROM secretos WHERE clave = ANY(?)", (list(claves),))
    finally:
        con.close()



def cifrar(valor: str) -> str:
    """Cifra un texto con la SECRETS_KEY (por ejemplo, el secreto de la app de autenticación de un usuario)."""
    return _fernet().encrypt(valor.encode()).decode()


def descifrar(valor: str) -> str:
    """Descifra; devuelve cadena vacía si el valor no se puede descifrar."""
    try:
        return _fernet().decrypt(valor.encode()).decode()
    except (InvalidToken, RuntimeError):
        return ""