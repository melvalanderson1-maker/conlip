"""Canales conectados del CRM: varios números de WhatsApp, varias páginas de Facebook y varias cuentas de Instagram.

Cada canal es una fila de crm_canales con su propio token (cifrado). Las funciones de whatsapp.py y meta_social.py
usan las credenciales del canal que se indique con `with usando(canal_id):`; sin canal usan las de Conexiones, como siempre.
"""
import logging
from contextlib import contextmanager
from contextvars import ContextVar

from core.db import abrir_db
from core.secretos import cifrar, descifrar, leer

logger = logging.getLogger("canales")
_actual: ContextVar[int | None] = ContextVar("canal_actual", default=None)

COLUMNAS = "id, tipo, nombre, ext_id, waba_id, page_id, detalle, token, legado, estado, error"


@contextmanager
def usando(canal_id: int | None):
    """Dentro de este bloque, whatsapp.py y meta_social.py usan las credenciales de ese canal."""
    t = _actual.set(canal_id)
    try:
        yield
    finally:
        _actual.reset(t)


def actual() -> int | None:
    return _actual.get()


def asegurar_legado(con) -> None:
    """Lo que ya tenías en Conexiones pasa a ser un canal «principal» (una sola vez por cada uno)."""
    pendientes = (
        ("whatsapp", "WhatsApp principal", leer("wa_phone_id"), leer("wa_waba_id"), ""),
        ("facebook", "Messenger principal", leer("meta_page_id"), "", leer("meta_page_id")),
        ("instagram", "Instagram principal", leer("meta_ig_id"), "", leer("meta_page_id")),
    )
    for tipo, nombre, ext_id, waba, page in pendientes:
        if ext_id:
            con.execute(
                "INSERT INTO crm_canales (tipo, nombre, ext_id, waba_id, page_id, legado) VALUES (?,?,?,?,?,1) "
                "ON CONFLICT (tipo, ext_id) DO NOTHING", (tipo, nombre, ext_id, waba, page))


def token_de(c) -> str:
    """Los canales que vienen de Conexiones leen su token en vivo (si lo cambias allí, aquí también cambia)."""
    if c["legado"]:
        if c["tipo"] == "whatsapp":
            return leer("wa_token")
        if c["tipo"] == "facebook":
            return leer("meta_page_token")
        return leer("meta_ig_token") or leer("meta_page_token")
    return descifrar(c["token"]) if c["token"] else ""


def obtener(con, canal_id: int):
    return con.execute(f"SELECT {COLUMNAS} FROM crm_canales WHERE id=?", (canal_id,)).fetchone()


def buscar(con, tipo: str, ext_id: str):
    """Canal por el id que Meta manda en el webhook (phone_number_id, id de página o de cuenta de Instagram)."""
    if not ext_id:
        return None
    asegurar_legado(con)
    return con.execute(
        f"SELECT {COLUMNAS} FROM crm_canales WHERE tipo=? AND ext_id=? AND estado <> 'desconectado'", (tipo, ext_id)).fetchone()


def predeterminado(con, tipo: str) -> int | None:
    asegurar_legado(con)
    f = con.execute(
        "SELECT id FROM crm_canales WHERE tipo=? AND estado <> 'desconectado' "
        "ORDER BY (estado='activo') DESC, legado DESC, id LIMIT 1", (tipo,)).fetchone()
    return f["id"] if f else None


def para_responder(con, lead_id: int, tipo: str) -> int | None:
    """Canal por el que se responde: el del último mensaje del cliente; si no hay, el principal."""
    asegurar_legado(con)
    f = con.execute(
        "SELECT m.canal_id FROM crm_mensajes m JOIN crm_canales c ON c.id = m.canal_id "
        "WHERE m.lead_id=? AND m.canal=? AND m.direccion='in' AND c.estado <> 'desconectado' "
        "ORDER BY m.creado_en DESC LIMIT 1", (lead_id, tipo)).fetchone()
    return f["canal_id"] if f else predeterminado(con, tipo)


def hay_activos(tipo: str) -> bool:
    con = abrir_db()
    try:
        asegurar_legado(con)
        return con.execute(
            "SELECT 1 FROM crm_canales WHERE tipo=? AND estado <> 'desconectado' LIMIT 1", (tipo,)).fetchone() is not None
    finally:
        con.close()


def marcar(canal_id: int | None, estado: str, error: str = "") -> None:
    """Nunca lanza errores: solo deja constancia del estado del canal."""
    if canal_id is None:
        return
    try:
        con = abrir_db()
        try:
            con.execute("UPDATE crm_canales SET estado=?, error=? WHERE id=?", (estado, error[:300], canal_id))
        finally:
            con.close()
    except Exception:
        logger.exception("No se pudo marcar el canal %s", canal_id)


def guardar(con, tipo: str, nombre: str, ext_id: str, waba_id: str, page_id: str, detalle: str, token: str, usuario: str) -> int:
    """Crea el canal o, si ya existía (mismo tipo e id), le actualiza el token y lo reactiva."""
    return con.execute(
        "INSERT INTO crm_canales (tipo, nombre, ext_id, waba_id, page_id, detalle, token, legado, estado, error, creado_por) "
        "VALUES (?,?,?,?,?,?,?,0,'activo','',?) ON CONFLICT (tipo, ext_id) DO UPDATE SET "
        "waba_id=EXCLUDED.waba_id, page_id=EXCLUDED.page_id, detalle=EXCLUDED.detalle, token=EXCLUDED.token, "
        "legado=0, estado='activo', error='' RETURNING id",
        (tipo, nombre[:60], ext_id, waba_id, page_id, detalle, cifrar(token), usuario)).fetchone()[0]