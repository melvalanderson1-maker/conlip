import html
import logging
import math
import os
import time
from datetime import datetime

from core.agenda import zona
from core.correo import enviar_correo
from core.db import abrir_db

logger = logging.getLogger("vencimientos")

PERMITIDOS = (14, 7, 3, 1)
POR_DEFECTO = [7, 3, 1]
# umbral -> (desde, hasta) en horas respecto a ahora. El 0 es "ya venció" (hasta 3 días después).
VENTANAS = {14: (168, 336), 7: (72, 168), 3: (24, 72), 1: (0, 24), 0: (-72, 0)}
MODOS = {"ver": "Solo visualizar", "cotizar": "Visualizar y cotizar"}

# Solo empresas activas, con correo real (la empresa Demo usa un correo inválido a propósito) y suscripciones activas
SQL_BASE = (
    "SELECT s.id, s.modo, s.vence_en, p.nombre AS plan, e.id AS empresa_id, e.nombre AS empresa, e.correo "
    "FROM suscripciones s JOIN planes p ON p.id = s.plan_id JOIN empresas e ON e.id = s.empresa_id "
    "WHERE s.estado = 'activa' AND e.activo = 1 AND POSITION('@invalido.local' IN e.correo) = 0 "
)


# ---------------- Configuración (se cambia desde el panel) ----------------
def config(con) -> tuple[bool, list[int]]:
    cfg = {r["clave"]: r["valor"] for r in con.execute(
        "SELECT clave, valor FROM configuracion WHERE clave = ANY(?)",
        (["avisos_vencimiento_activo", "avisos_vencimiento_dias"],)).fetchall()}
    activo = cfg.get("avisos_vencimiento_activo", "1") == "1"
    try:
        dias = sorted({int(x) for x in cfg["avisos_vencimiento_dias"].split(",") if x.strip()} & set(PERMITIDOS), reverse=True)
    except (KeyError, ValueError):
        dias = list(POR_DEFECTO)
    return activo, dias


def guardar_config(con, activo: bool, dias: list[int]) -> None:
    for clave, valor in (("avisos_vencimiento_activo", "1" if activo else "0"),
                         ("avisos_vencimiento_dias", ",".join(str(d) for d in sorted(set(dias) & set(PERMITIDOS), reverse=True)))):
        con.execute(
            "INSERT INTO configuracion (clave, valor) VALUES (?,?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
            (clave, valor))


def _sitio(con) -> tuple[str, str]:
    cfg = {r["clave"]: r["valor"] for r in con.execute(
        "SELECT clave, valor FROM configuracion WHERE clave = ANY(?)", (["sitio_nombre", "contacto_correo"],)).fetchall()}
    return (cfg.get("sitio_nombre") or "").strip() or "COTI", (cfg.get("contacto_correo") or "").strip()


# ---------------- Correo ----------------
def armar_correo(sitio: str, empresa: str, contacto: str, subs: list[dict]) -> tuple[str, str, str]:
    tz = zona()
    ahora = datetime.now(tz)
    filas: list[tuple[str, str, str]] = []
    pronto: list[int] = []
    hay_vencida = False
    for s in sorted(subs, key=lambda x: x["vence_en"]):
        delta = (s["vence_en"] - ahora).total_seconds() / 86400
        dias = math.ceil(delta)
        fecha = s["vence_en"].astimezone(tz).strftime("%d/%m/%Y")
        if delta <= 0:
            hay_vencida = True
            estado = f"venció el {fecha}"
        elif dias <= 1:
            pronto.append(1)
            estado = f"vence en menos de 24 horas ({fecha})"
        else:
            pronto.append(dias)
            estado = f"vence en {dias} días ({fecha})"
        filas.append((s["plan"], MODOS.get(s["modo"], s["modo"]), estado))

    uno = len(filas) == 1
    sujeto = f"Tu acceso a {sitio}" if uno else f"Tus accesos a {sitio}"
    if hay_vencida and not pronto:
        asunto = f"{sujeto} {'venció' if uno else 'vencieron'}"
    elif hay_vencida:
        asunto = f"Tus accesos a {sitio} vencieron o están por vencer"
    elif min(pronto) <= 1:
        asunto = f"{sujeto} {'vence' if uno else 'vencen'} en menos de 24 horas"
    else:
        asunto = f"{sujeto} {'vence' if uno else 'vencen'} en {min(pronto)} días"

    url = os.getenv("FRONTEND_URL", "http://localhost:4200").rstrip("/") + "/cuenta"
    ayuda = f"Si necesitas ayuda, escríbenos a {contacto}." if contacto else ""
    lista = "\n".join(f"- {p} ({a}): {e}" for p, a, e in filas)
    texto = (f"Hola {empresa},\n\nTe escribimos de {sitio} para recordarte la vigencia de tu acceso:\n\n{lista}\n\n"
             f'Para no perder el acceso, renueva desde "Mi cuenta":\n{url}\n\n{ayuda}').strip()

    tabla = "".join(
        f'<tr><td style="padding:8px 12px;border-bottom:1px solid #e6e8f0"><b>{html.escape(p)}</b><br>'
        f'<span style="color:#64748b;font-size:13px">{html.escape(a)}</span></td>'
        f'<td style="padding:8px 12px;border-bottom:1px solid #e6e8f0">{html.escape(e)}</td></tr>' for p, a, e in filas)
    cuerpo = (
        f"<p>Hola <b>{html.escape(empresa)}</b>,</p>"
        f"<p>Te escribimos de {html.escape(sitio)} para recordarte la vigencia de tu acceso:</p>"
        f'<table style="border-collapse:collapse;width:100%;max-width:520px">{tabla}</table>'
        f'<p style="margin-top:20px"><a href="{html.escape(url)}" style="display:inline-block;padding:12px 22px;'
        f'border-radius:10px;background:#1d4ed8;color:#fff;text-decoration:none;font-weight:600">Renovar ahora</a></p>'
        f'<p style="color:#64748b;font-size:13px">{html.escape(ayuda)}</p>')
    return asunto, texto, cuerpo


# ---------------- Ciclo automático ----------------
def ciclo() -> int:
    """Revisa los vencimientos y envía los avisos que correspondan. Devuelve cuántas empresas recibieron correo."""
    con = abrir_db()
    por_empresa: dict[int, dict] = {}
    try:
        activo, dias = config(con)
        if not activo:
            return 0
        sitio, contacto = _sitio(con)
        for umbral in [*dias, 0]:
            desde, hasta = VENTANAS[umbral]
            filas = con.execute(
                SQL_BASE + "AND s.vence_en > now() + (? * interval '1 hour') AND s.vence_en <= now() + (? * interval '1 hour') "
                "AND NOT EXISTS (SELECT 1 FROM avisos_vencimiento a WHERE a.suscripcion_id = s.id "
                "AND a.vence_en = s.vence_en AND a.umbral = ?)", (desde, hasta, umbral)).fetchall()
            for f in filas:
                # "Reclamar" el aviso: si otro proceso ya lo reclamó, no devuelve fila y no se envía dos veces
                reclamado = con.execute(
                    "INSERT INTO avisos_vencimiento (suscripcion_id, vence_en, umbral) VALUES (?,?,?) "
                    "ON CONFLICT DO NOTHING RETURNING umbral", (f["id"], f["vence_en"], umbral)).fetchone()
                if reclamado:
                    g = por_empresa.setdefault(f["empresa_id"], {"empresa": f["empresa"], "correo": f["correo"], "subs": {}})
                    g["subs"][f["id"]] = dict(f)
    finally:
        con.close()
    for g in por_empresa.values():
        asunto, texto, cuerpo = armar_correo(sitio, g["empresa"], contacto, list(g["subs"].values()))
        enviar_correo(g["correo"], asunto, texto, cuerpo)
    return len(por_empresa)


def bucle() -> None:
    """Corre en segundo plano: espera 1 minuto al arrancar y luego revisa cada 30 minutos."""
    time.sleep(60)
    while True:
        try:
            n = ciclo()
            if n:
                logger.info("Avisos de vencimiento enviados a %s empresa(s)", n)
        except Exception as e:
            logger.error("Falló el ciclo de avisos de vencimiento: %s", e)
        time.sleep(1800)


# ---------------- Envío manual (botón del superadmin) ----------------
def enviar_ahora(con, sid: int) -> str | None:
    """Envía el aviso de una suscripción ahora mismo. Devuelve el correo, o None si no existe."""
    f = con.execute(
        "SELECT s.id, s.modo, s.vence_en, p.nombre AS plan, e.nombre AS empresa, e.correo FROM suscripciones s "
        "JOIN planes p ON p.id = s.plan_id JOIN empresas e ON e.id = s.empresa_id WHERE s.id=?", (sid,)).fetchone()
    if not f:
        return None
    correo = (f["correo"] or "").strip()
    if "@" not in correo or correo.endswith("@invalido.local"):
        raise ValueError("Esta empresa no tiene un correo válido para recibir avisos.")
    sitio, contacto = _sitio(con)
    asunto, texto, cuerpo = armar_correo(sitio, f["empresa"], contacto, [dict(f)])
    enviar_correo(correo, asunto, texto, cuerpo)
    return correo