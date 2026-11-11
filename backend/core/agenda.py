import html
import logging
import os
from datetime import date, datetime, time, timedelta, timezone
from zoneinfo import ZoneInfo

from core.correo import enviar_correo
from core.db import abrir_db
from core.difusion import a_empresa, a_superadmins
from core.tiempo_real import gestor

logger = logging.getLogger("agenda")

REGLAS_BASE = {"agenda_antelacion_horas": 12, "agenda_cancelacion_horas": 24, "agenda_dias_adelante": 30}
PLATAFORMAS = {"meet": "Google Meet", "zoom": "Zoom", "otra": "Videollamada"}


def zona():
    try:
        return ZoneInfo(os.getenv("AGENDA_ZONA", "America/Lima"))
    except Exception:
        return timezone(timedelta(hours=-5))  # Perú no usa horario de verano


# ---------------- Reglas ----------------
def reglas(con) -> dict[str, int]:
    out = dict(REGLAS_BASE)
    for r in con.execute("SELECT clave, valor FROM configuracion WHERE clave = ANY(?)", (list(REGLAS_BASE),)).fetchall():
        try:
            out[r["clave"]] = int(r["valor"])
        except ValueError:
            pass
    return out


def guardar_reglas(con, antelacion: int, cancelacion: int, dias: int) -> None:
    for clave, valor in (("agenda_antelacion_horas", antelacion), ("agenda_cancelacion_horas", cancelacion),
                         ("agenda_dias_adelante", dias)):
        con.execute(
            "INSERT INTO configuracion (clave, valor) VALUES (?,?) "
            "ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor", (clave, str(valor)))


# ---------------- Entregables y estado del servicio ----------------
def sincronizar_entregables(con) -> None:
    """Copia 'Qué incluye' del servicio como checklist propia de cada pedido (una sola vez por pedido)."""
    con.execute(
        "INSERT INTO pedido_entregables (pedido_id, orden, titulo) "
        "SELECT p.id, e.n, e.t FROM pedidos_servicio p JOIN servicios s ON s.id = p.servicio_id "
        "CROSS JOIN LATERAL unnest(s.entregables) WITH ORDINALITY AS e(t, n) WHERE p.entregables_ok = 0")
    con.execute("UPDATE pedidos_servicio SET entregables_ok = 1 WHERE entregables_ok = 0 AND servicio_id IS NOT NULL")


def resumen_pedido(con, pid: int) -> dict:
    r = con.execute(
        "SELECT p.estado, COALESCE(s.sesiones, 0) AS inc, "
        "(SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id) AS total_e, "
        "(SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id AND x.estado = 'hecho') AS hechos, "
        "(SELECT COUNT(*) FROM pedido_entregables x WHERE x.pedido_id = p.id AND x.estado = 'en_curso') AS en_curso, "
        "(SELECT COUNT(*) FROM sesiones_servicio q WHERE q.pedido_id = p.id AND q.estado = 'realizada') AS realizadas, "
        "(SELECT COUNT(*) FROM sesiones_servicio q WHERE q.pedido_id = p.id AND q.estado = 'programada') AS programadas "
        "FROM pedidos_servicio p LEFT JOIN servicios s ON s.id = p.servicio_id WHERE p.id=?", (pid,)).fetchone()
    return dict(r) if r else {}


def calcular(res: dict) -> tuple[str, int]:
    """(estado, porcentaje) a partir de entregables hechos y sesiones realizadas."""
    total = res["total_e"] + res["inc"]
    hecho = res["hechos"] + min(res["realizadas"], res["inc"])
    pct = round(hecho / total * 100) if total else (100 if res["estado"] == "entregado" else 0)
    completo = total > 0 and res["hechos"] == res["total_e"] and res["realizadas"] >= res["inc"]
    avance = res["hechos"] > 0 or res["en_curso"] > 0 or res["realizadas"] > 0 or res["programadas"] > 0
    return ("entregado" if completo else ("en_curso" if avance else "nuevo")), pct


def recalcular(con, pid: int) -> None:
    res = resumen_pedido(con, pid)
    if not res or res["estado"] == "cancelado":
        return
    estado, _ = calcular(res)
    if estado != res["estado"]:
        con.execute("UPDATE pedidos_servicio SET estado=? WHERE id=?", (estado, pid))


def avisar_pedido(pid: int) -> None:
    """Avisa por WebSocket a los superadmins, a los asesores de sus sesiones y a la empresa del cliente."""
    con = abrir_db()
    try:
        r = con.execute("SELECT empresa_id FROM pedidos_servicio WHERE id=?", (pid,)).fetchone()
        asesores = [x["usuario_id"] for x in con.execute(
            "SELECT DISTINCT a.usuario_id FROM sesiones_servicio q JOIN asesores a ON a.id = q.asesor_id "
            "WHERE q.pedido_id=? AND a.usuario_id IS NOT NULL", (pid,)).fetchall()]
    finally:
        con.close()
    a_superadmins({"tipo": "agenda"})
    if asesores:
        gestor.notificar(asesores, {"tipo": "agenda"})
    if r and r["empresa_id"]:
        a_empresa(r["empresa_id"], {"tipo": "servicio"})
# ---------------- Horarios ----------------
def choca(con, asesor_id: int, inicio: datetime, fin: datetime, excluir: int | None = None) -> str | None:
    """Devuelve el motivo si el asesor no puede atender en ese horario; None si está libre."""
    if con.execute(
            "SELECT 1 FROM sesiones_servicio WHERE asesor_id=? AND estado='programada' AND inicio < ? AND fin > ? "
            "AND (?::int IS NULL OR id <> ?::int)", (asesor_id, fin, inicio, excluir, excluir)).fetchone():
        return "El asesor ya tiene una sesión en ese horario"
    if con.execute(
            "SELECT 1 FROM asesor_bloqueos WHERE asesor_id=? AND desde < ? AND hasta > ?", (asesor_id, fin, inicio)).fetchone():
        return "El asesor tiene un bloqueo (permiso o vacaciones) en ese horario"
    return None


def slots(con, servicio_id: int, desde: date, dias: int) -> list[dict]:
    """Horarios libres para un servicio: horario semanal de los asesores menos sus sesiones y bloqueos."""
    r = reglas(con)
    srv = con.execute("SELECT duracion_sesion_min FROM servicios WHERE id=?", (servicio_id,)).fetchone()
    dur = timedelta(minutes=srv["duracion_sesion_min"] if srv else 60)
    ases = con.execute(
        "SELECT a.id, a.nombre FROM asesores a WHERE a.activo=1 AND ("
        "EXISTS (SELECT 1 FROM servicio_asesores sa WHERE sa.servicio_id=? AND sa.asesor_id = a.id) "
        "OR NOT EXISTS (SELECT 1 FROM servicio_asesores sb WHERE sb.servicio_id=?)) ORDER BY a.id",
        (servicio_id, servicio_id)).fetchall()
    if not ases:
        return []
    tz = zona()
    ahora = datetime.now(tz)
    minimo = ahora + timedelta(hours=r["agenda_antelacion_horas"])
    limite = ahora + timedelta(days=r["agenda_dias_adelante"])
    ini_v = datetime.combine(desde, time(0, 0), tzinfo=tz)
    fin_v = ini_v + timedelta(days=dias)
    ids = [a["id"] for a in ases]
    horarios = con.execute(
        "SELECT asesor_id, dia, inicio, fin FROM asesor_horarios WHERE asesor_id = ANY(?)", (ids,)).fetchall()
    ocupados = [(o["asesor_id"], o["inicio"], o["fin"]) for o in con.execute(
        "SELECT asesor_id, inicio, fin FROM sesiones_servicio WHERE asesor_id = ANY(?) AND estado='programada' "
        "AND fin > ? AND inicio < ?", (ids, ini_v, fin_v)).fetchall()]
    ocupados += [(b["asesor_id"], b["desde"], b["hasta"]) for b in con.execute(
        "SELECT asesor_id, desde, hasta FROM asesor_bloqueos WHERE asesor_id = ANY(?) AND hasta > ? AND desde < ?",
        (ids, ini_v, fin_v)).fetchall()]

    out: dict[datetime, dict] = {}
    for i in range(dias):
        dia = desde + timedelta(days=i)
        for a in ases:
            for h in horarios:
                if h["asesor_id"] != a["id"] or h["dia"] != dia.weekday():
                    continue
                t = datetime.combine(dia, h["inicio"], tzinfo=tz)
                tope = datetime.combine(dia, h["fin"], tzinfo=tz)
                while t + dur <= tope:
                    fin = t + dur
                    libre = not any(o[0] == a["id"] and o[1] < fin and o[2] > t for o in ocupados)
                    if libre and minimo <= t <= limite:
                        out.setdefault(t, {"inicio": t, "fin": fin, "asesor_id": a["id"], "asesor": a["nombre"]})
                    t += dur
    return [out[k] for k in sorted(out)]


# ---------------- Correos ----------------
def correo_sesion(pedido: dict, asesor: dict, inicio: datetime, fin: datetime, motivo: str) -> None:
    tz = zona()
    fecha = inicio.astimezone(tz).strftime("%d/%m/%Y")
    horas = f"{inicio.astimezone(tz).strftime('%H:%M')} a {fin.astimezone(tz).strftime('%H:%M')} (hora de Lima)"
    plat = PLATAFORMAS.get(asesor.get("plataforma", ""), "Videollamada")
    enlace = (asesor.get("enlace") or "").strip()
    servicio = pedido.get("servicio_nombre", "")
    nombre = pedido.get("nombre", "")
    texto = "\n".join([
        f"Hola {nombre},", "", f"{motivo}: {servicio}", f"Fecha: {fecha}", f"Hora: {horas}",
        f"Con: {asesor['nombre']}", f"{plat}: {enlace or 'te enviaremos el enlace antes de la sesión'}",
    ])
    boton = f'<p><a href="{html.escape(enlace)}">Unirme a la sesión ({plat})</a></p>' if enlace else ""
    cuerpo = (f"<p>Hola <b>{html.escape(nombre)}</b>,</p><p><b>{html.escape(motivo)}</b>: {html.escape(servicio)}</p>"
              f"<ul><li>Fecha: {fecha}</li><li>Hora: {html.escape(horas)}</li><li>Con: {html.escape(asesor['nombre'])}</li></ul>{boton}")
    if pedido.get("correo"):
        enviar_correo(pedido["correo"], f"{motivo}: {servicio}", texto, cuerpo)
    if asesor.get("correo"):
        enviar_correo(asesor["correo"], f"{motivo} (asesor): {servicio}",
                      f"Cliente: {nombre}\n{fecha} · {horas}\n{plat}: {enlace}", None)




# ---------------- Menú "Servicios" por módulo ----------------
MODULOS_SERVICIOS = ("perucompras", "menor", "mayor")
NOMBRES_MODULO = {"perucompras": "Perú Compras", "menor": "Contratos Menores", "mayor": "Contratos Mayores"}


def servicios_habilitados(con) -> dict[str, bool]:
    """Módulos que muestran la opción Servicios en su menú. Perú Compras viene activo por defecto."""
    claves = [f"servicios_menu_{m}" for m in MODULOS_SERVICIOS]
    cfg = {r["clave"]: r["valor"] for r in con.execute(
        "SELECT clave, valor FROM configuracion WHERE clave = ANY(?)", (claves,)).fetchall()}
    return {m: cfg.get(f"servicios_menu_{m}", "1" if m == "perucompras" else "0") == "1" for m in MODULOS_SERVICIOS}