import asyncio
import logging

from core.db import abrir_db
from core.seguridad import usuario_desde_token
from core.tiempo_real import gestor

logger = logging.getLogger("difusion")


def _ids(sql: str, args: tuple = ()) -> list[int]:
    con = abrir_db()
    try:
        return [r["id"] for r in con.execute(sql, args).fetchall()]
    finally:
        con.close()


def a_superadmins(evento: dict) -> None:
    gestor.notificar(_ids("SELECT id FROM usuarios WHERE rol='superadmin' AND activo=1"), evento)


def a_empresa(empresa_id: int, evento: dict) -> None:
    gestor.notificar(_ids("SELECT id FROM usuarios WHERE empresa_id=? AND activo=1", (empresa_id,)), evento)


def compra_confirmada(oid: str) -> None:
    """Una compra se pagó: el superadmin ve el pedido y los usuarios de esa empresa reciben sus nuevos accesos."""
    con = abrir_db()
    try:
        r = con.execute("SELECT empresa_id FROM ordenes WHERE id=?", (oid,)).fetchone()
    finally:
        con.close()
    a_superadmins({"tipo": "pedido"})
    if r and r["empresa_id"]:
        a_empresa(r["empresa_id"], {"tipo": "acceso"})


def _empresa_del_token(auth: str | None) -> int | None:
    if not auth or not auth.lower().startswith("bearer "):
        return None
    try:
        return usuario_desde_token(auth[7:].strip()).get("empresa_id")
    except Exception:
        return None


async def por_cambio(tipo: str, auth: str | None) -> None:
    """Se ejecuta después de cada cambio hecho desde un panel de configuración."""
    try:
        if tipo == "horarios":                                         # agenda: horarios, bloqueos, sesiones, asesores
            await gestor.difundir({"tipo": "horarios"}, publico=False)
        elif tipo in ("catalogo", "cursos", "anuncios"):
            await gestor.difundir({"tipo": tipo})                      # portada + todos los paneles
        elif tipo == "acceso":
            await gestor.difundir({"tipo": "acceso"}, publico=False)   # cambios de empresas y suscripciones
        elif tipo == "acceso_empresa":                                 # un admin cambió los permisos de su equipo
            eid = await asyncio.to_thread(_empresa_del_token, auth)
            if eid:
                uids = await asyncio.to_thread(
                    _ids, "SELECT id FROM usuarios WHERE empresa_id=? AND activo=1", (eid,))
                await gestor.enviar_a(uids, {"tipo": "acceso"})
    except Exception as e:
        logger.warning("No se pudo difundir '%s': %s", tipo, e)