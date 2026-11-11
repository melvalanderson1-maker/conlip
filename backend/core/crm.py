"""CRM: leads, embudo por etapas y actividad.

Los leads se captan SIEMPRE (aunque el CRM esté apagado) para que, al activarlo, ya haya historial.
La interfaz se enciende en Ventas → Ajustes. Nada de aquí puede romper una venta: lo que se llama desde
un flujo de compra usa captar_lead_seguro / marcar_ganado_por_orden, que nunca lanzan errores.
"""
import logging
import re

from fastapi import HTTPException

from core.db import abrir_db
from core.difusion import a_superadmins
from core.tiempo_real import gestor
from core.ventas import normalizar_telefono

logger = logging.getLogger("crm")
CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")
NOMBRES_ORIGEN = {
    "manual": "carga manual", "importado": "una importación", "pedido_whatsapp": "un pedido por WhatsApp",
    "cotizacion": "una solicitud de cotización", "whatsapp": "WhatsApp", "facebook": "Facebook", "instagram": "Instagram",
    "web": "la web",
}


def contacto_valido(correo: str, telefono: str) -> tuple[str, str]:
    """Normaliza y valida correo y teléfono. Devuelve (correo, teléfono_solo_dígitos)."""
    correo = (correo or "").strip().lower()
    if correo and not CORREO.match(correo):
        raise HTTPException(400, "El correo no es válido")
    tel = ""
    if (telefono or "").strip():
        tel = normalizar_telefono(telefono)
        if not tel:
            raise HTTPException(400, "El teléfono no es válido. Usa 9 dígitos o escríbelo con código de país.")
    return correo, tel


def registrar(con, lead_id: int, tipo: str, contenido: str, usuario: str = "sistema", programada_en=None) -> int:
    return con.execute(
        "INSERT INTO crm_actividades (lead_id, tipo, contenido, usuario, programada_en) VALUES (?,?,?,?,?) RETURNING id",
        (lead_id, tipo, contenido, usuario, programada_en)).fetchone()[0]


def recalcular_siguiente(con, lead_id: int) -> None:
    """La próxima acción del lead es la tarea pendiente más cercana."""
    con.execute(
        "UPDATE crm_leads SET siguiente_accion_en = (SELECT MIN(programada_en) FROM crm_actividades "
        "WHERE lead_id=? AND completada_en IS NULL AND programada_en IS NOT NULL) WHERE id=?", (lead_id, lead_id))


def buscar_duplicado(con, correo: str, tel: str, excluir: int | None = None) -> int | None:
    cond, args = [], []
    if tel:
        cond.append("telefono=?"); args.append(tel)
    if correo:
        cond.append("lower(correo)=?"); args.append(correo)
    if not cond:
        return None
    sql = "SELECT id FROM crm_leads WHERE estado='abierto' AND (" + " OR ".join(cond) + ")"
    if excluir is not None:
        sql += " AND id<>?"; args.append(excluir)
    f = con.execute(sql + " ORDER BY id DESC LIMIT 1", args).fetchone()
    return f["id"] if f else None


def siguiente_asesor(con) -> int | None:
    """Reparto rotativo entre los asesores activos con acceso a la plataforma (solo si está activado en la configuración)."""
    cfg = con.execute("SELECT valor FROM configuracion WHERE clave='crm_reparto'").fetchone()
    if not cfg or cfg["valor"] != "rotativo":
        return None
    ids = [r["id"] for r in con.execute(
        "SELECT id FROM asesores WHERE activo=1 AND usuario_id IS NOT NULL ORDER BY id").fetchall()]
    if not ids:
        return None
    ult = con.execute("SELECT valor FROM configuracion WHERE clave='crm_ultimo_asesor'").fetchone()
    ultimo = int(ult["valor"]) if ult and (ult["valor"] or "").isdigit() else 0
    elegido = next((i for i in ids if i > ultimo), ids[0])
    con.execute(
        "INSERT INTO configuracion (clave, valor) VALUES ('crm_ultimo_asesor', ?) "
        "ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", (str(elegido),))
    return elegido


def captar_lead(con, *, nombre: str, correo: str = "", telefono: str = "", empresa: str = "", doc_tipo: str = "",
                doc_numero: str = "", origen: str = "manual", interes: str = "", valor: float = 0.0,
                orden_id: str | None = None, creado_por: str = "sistema", asesor_id: int | None = None) -> tuple[int, bool]:
    """Crea un lead o, si ya hay uno abierto con el mismo teléfono o correo, le suma una actividad. Devuelve (id, creado)."""
    correo = (correo or "").strip().lower()
    tel = normalizar_telefono(telefono)
    existente = buscar_duplicado(con, correo, tel)
    if existente:
        registrar(con, existente, "sistema", f"Volvió a contactar por {NOMBRES_ORIGEN.get(origen, origen)}. {interes}".strip())
        con.execute(
            "UPDATE crm_leads SET actualizado_en=now(), ultimo_contacto_en=now(), orden_id=COALESCE(orden_id, ?) WHERE id=?",
            (orden_id, existente))
        return existente, False
    etapa = con.execute("SELECT id FROM crm_etapas WHERE tipo='abierta' AND activa=1 ORDER BY orden, id LIMIT 1").fetchone()
    if not etapa:
        raise RuntimeError("El CRM no tiene etapas abiertas activas")
    if asesor_id is None:
        asesor_id = siguiente_asesor(con)
    lid = con.execute(
        "INSERT INTO crm_leads (nombre, empresa_nombre, correo, telefono, doc_tipo, doc_numero, origen, interes, "
        "valor_estimado, etapa_id, asesor_id, orden_id, creado_por, ultimo_contacto_en) "
        "VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?, now()) RETURNING id",
        (nombre.strip()[:120], empresa.strip()[:160], correo, tel, doc_tipo[:10], doc_numero.strip()[:20], origen,
         interes.strip()[:300], valor, etapa["id"], asesor_id, orden_id, creado_por)).fetchone()[0]
    registrar(con, lid, "sistema", f"Lead creado desde {NOMBRES_ORIGEN.get(origen, origen)}", creado_por)
    return lid, True


def avisar_lead(lead_id: int, usuarios_extra: list[int] | None = None) -> None:
    """Tiempo real: avisa a los superadmins y al asesor dueño del lead (y a quien se indique, por ejemplo el asesor anterior)."""
    con = abrir_db()
    try:
        r = con.execute(
            "SELECT a.usuario_id FROM crm_leads l LEFT JOIN asesores a ON a.id = l.asesor_id WHERE l.id=?", (lead_id,)).fetchone()
    finally:
        con.close()
    a_superadmins({"tipo": "crm"})
    ids = [x for x in [r["usuario_id"] if r else None, *(usuarios_extra or [])] if x]
    if ids:
        gestor.notificar(list(set(ids)), {"tipo": "crm"})


def captar_lead_seguro(**datos) -> int | None:
    """Para llamar desde los flujos de venta: jamás lanza errores ni retrasa la compra del cliente."""
    try:
        con = abrir_db()
        try:
            lid, _ = captar_lead(con, **datos)
        finally:
            con.close()
        avisar_lead(lid)
        return lid
    except Exception:
        logger.exception("No se pudo captar el lead (%s)", datos.get("origen"))
        return None


def marcar_ganado_por_orden(oid: str) -> None:
    """Cuando se confirma el pago de un pedido, su lead pasa a Ganado. Nunca lanza errores."""
    try:
        con = abrir_db()
        try:
            lead = con.execute("SELECT id FROM crm_leads WHERE orden_id=? AND estado='abierto' LIMIT 1", (oid,)).fetchone()
            if not lead:
                return
            et = con.execute("SELECT id, nombre FROM crm_etapas WHERE tipo='ganada' AND activa=1 ORDER BY orden LIMIT 1").fetchone()
            if not et:
                return
            con.execute(
                "UPDATE crm_leads SET estado='ganado', etapa_id=?, actualizado_en=now(), ultimo_contacto_en=now() WHERE id=?",
                (et["id"], lead["id"]))
            registrar(con, lead["id"], "sistema", f"Pago confirmado del pedido {oid[:8].upper()}: pasó a {et['nombre']}")
            lid = lead["id"]
        finally:
            con.close()
        avisar_lead(lid)
    except Exception:
        logger.exception("No se pudo marcar como ganado el lead del pedido %s", oid)