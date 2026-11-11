import logging
import time

from core.agenda import correo_sesion
from core.db import abrir_db

logger = logging.getLogger("recordatorios")

# (columna que marca "ya enviado", desde cuándo, hasta cuándo, asunto)
AVISOS = (
    ("recordatorio_24h", "23 hours", "24 hours", "Recordatorio: tu sesión es mañana"),
    ("recordatorio_1h", "30 minutes", "1 hour", "Recordatorio: tu sesión empieza en 1 hora"),
)


def _ciclo() -> None:
    con = abrir_db()
    try:
        for columna, desde, hasta, motivo in AVISOS:
            filas = con.execute(
                "SELECT q.id, q.inicio, q.fin, p.servicio_nombre, p.nombre, p.correo, a.nombre AS a_nombre, "
                "a.correo AS a_correo, a.plataforma, q.enlace FROM sesiones_servicio q "
                "JOIN pedidos_servicio p ON p.id = q.pedido_id JOIN asesores a ON a.id = q.asesor_id "
                f"WHERE q.estado='programada' AND q.{columna}=0 "
                f"AND q.inicio > now() + interval '{desde}' AND q.inicio <= now() + interval '{hasta}'").fetchall()
            for f in filas:
                # Se marca primero: aunque falle el envío, no se repite en cada ciclo
                con.execute(f"UPDATE sesiones_servicio SET {columna}=1 WHERE id=?", (f["id"],))
                correo_sesion(
                    {"servicio_nombre": f["servicio_nombre"], "nombre": f["nombre"], "correo": f["correo"]},
                    {"nombre": f["a_nombre"], "correo": f["a_correo"], "plataforma": f["plataforma"], "enlace": f["enlace"]},
                    f["inicio"], f["fin"], motivo)
                logger.info("Recordatorio '%s' enviado para la sesión %s", motivo, f["id"])
    finally:
        con.close()


def bucle() -> None:
    """Revisa cada 5 minutos si hay sesiones por recordar."""
    while True:
        try:
            _ciclo()
        except Exception as e:
            logger.error("Falló el ciclo de recordatorios: %s", e)
        time.sleep(300)