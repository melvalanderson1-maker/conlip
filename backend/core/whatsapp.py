"""WhatsApp Business Platform (Cloud API de Meta): credenciales cifradas, envío, plantillas, medios y recepción por webhook."""
import hashlib
import hmac
import json
import logging
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

from core import canales as cn
from core.crm import avisar_lead, captar_lead
from core.db import abrir_db
from core.secretos import leer
from core.ventas import normalizar_telefono

logger = logging.getLogger("whatsapp")

GRAPH = "https://graph.facebook.com"
VERSION_BASE = "v24.0"  # se cambia en el panel (CRM → Conexiones) por la que muestre tu app de Meta
VENTANA = timedelta(hours=24)
RANGO = {"enviado": 1, "entregado": 2, "leido": 3}
MAX_MEDIA = 16 * 1024 * 1024

ERRORES = {
    131047: "Pasaron más de 24 horas desde el último mensaje del cliente: solo puedes enviar una plantilla aprobada.",
    131026: "No se pudo entregar: ese número no tiene WhatsApp o no puede recibir mensajes.",
    131030: "Ese número no está en la lista de prueba de tu app de Meta (mientras la app no esté en modo Live).",
    131056: "Enviaste demasiados mensajes seguidos a este número. Espera un momento.",
    130429: "Se alcanzó el límite de envío de tu cuenta. Espera unos minutos.",
    131048: "Meta bloqueó el mensaje por posible spam.",
    131031: "La cuenta de WhatsApp Business está restringida o bloqueada por Meta.",
    132000: "La plantilla necesita otra cantidad de variables.",
    132001: "La plantilla no existe, no está aprobada o no está en ese idioma.",
    132005: "El texto de la plantilla quedó demasiado largo.",
    132012: "Las variables de la plantilla no tienen el formato correcto.",
    190: "El token de acceso venció o no es válido. Genera uno nuevo en Meta y guárdalo en CRM → Conexiones.",
    100: "Meta rechazó la solicitud por un dato inválido.",
}


class ErrorWa(Exception):
    """Error de Meta o de configuración; el mensaje se puede mostrar al usuario."""


def traducir_error(codigo: int, mensaje: str = "") -> str:
    base = ERRORES.get(int(codigo or 0))
    return base if base else (f"Meta respondió: {mensaje}" if mensaje else "Meta rechazó el mensaje.")


# ---------------- Configuración (cifrada, se edita en el panel) ----------------
def cfg() -> dict[str, str]:
    base = {"app_secret": leer("wa_app_secret"), "verify_token": leer("wa_verify_token"), "version": leer("wa_version") or VERSION_BASE}
    cid = cn.actual()
    if cid is None:  # sin canal elegido: las credenciales de Conexiones (como siempre)
        return {**base, "phone_id": leer("wa_phone_id"), "waba_id": leer("wa_waba_id"), "token": leer("wa_token")}
    con = abrir_db()
    try:
        c = cn.obtener(con, cid)
    finally:
        con.close()
    if not c or c["tipo"] != "whatsapp" or c["estado"] == "desconectado":
        raise ErrorWa("Ese número de WhatsApp ya no está conectado.")
    return {**base, "phone_id": c["ext_id"], "waba_id": c["waba_id"], "token": cn.token_de(c)}


def configurado() -> bool:
    c = cfg()
    if not c["app_secret"]:
        return False
    return bool(c["phone_id"] and c["token"]) or (cn.actual() is None and cn.hay_activos("whatsapp"))


def _obligatoria() -> dict[str, str]:
    c = cfg()
    if not (c["phone_id"] and c["token"]):
        raise ErrorWa("WhatsApp Business no está configurado. Pídele al superadmin que lo conecte en CRM → Conexiones.")
    return c


# ---------------- Llamadas a la API de Meta ----------------
def _graph(metodo: str, ruta: str, cuerpo: dict | None = None, consulta: dict | None = None):
    c = _obligatoria()
    url = f"{GRAPH}/{c['version']}{ruta}"
    if consulta:
        url += "?" + urllib.parse.urlencode(consulta)
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else (b"" if metodo == "POST" else None)
    cab = {"Authorization": f"Bearer {c['token']}"}
    if cuerpo is not None:
        cab["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=datos, method=metodo, headers=cab)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            crudo = r.read()
            return json.loads(crudo) if crudo else {}
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {})
        except Exception:
            err = {}
        logger.warning("Meta rechazó %s %s: %s", metodo, ruta, {k: err.get(k) for k in ("code", "error_subcode", "message")})
        if int(err.get("code", 0) or 0) == 190:
            cn.marcar(cn.actual(), "error", "El token venció o no es válido. Vuelve a conectar este número.")
        raise ErrorWa(traducir_error(err.get("code", 0), err.get("message", "")))
    except Exception as e:
        logger.error("No se pudo contactar a Meta: %s", e)
        raise ErrorWa("No se pudo contactar a Meta. Revisa tu conexión e inténtalo de nuevo.")


def info_numero() -> dict:
    c = _obligatoria()
    return _graph("GET", f"/{c['phone_id']}", consulta={"fields": "display_phone_number,verified_name,quality_rating"})


def diagnostico() -> dict:
    """Estado del número y de la cuenta según Meta (para entender por qué no se entregan los mensajes)."""
    c = _obligatoria()

    def intentar(ruta: str, juegos: list[str]) -> dict:
        for campos in juegos:  # si Meta no conoce algún campo, se prueba con menos
            try:
                return _graph("GET", ruta, consulta={"fields": campos})
            except ErrorWa:
                continue
        return {}
    numero = intentar(f"/{c['phone_id']}", [
        "display_phone_number,verified_name,quality_rating,status,account_mode,name_status,platform_type,health_status",
        "display_phone_number,verified_name,quality_rating,status,account_mode,name_status",
        "display_phone_number,verified_name,quality_rating"])
    cuenta = intentar(f"/{c['waba_id']}", [
        "name,account_review_status,business_verification_status,health_status",
        "name,account_review_status,business_verification_status", "name"]) if c["waba_id"] else {}
    if not numero and not cuenta:
        raise ErrorWa("Meta no devolvió información de este número. Revisa que el token tenga permiso sobre la cuenta de WhatsApp.")
    return {"numero": numero, "cuenta": cuenta}


def suscribir_app() -> bool:
    """Suscribe tu app a los avisos de tu cuenta de WhatsApp Business."""
    c = _obligatoria()
    if not c["waba_id"]:
        raise ErrorWa("Falta el ID de la cuenta de WhatsApp Business (WABA).")
    return bool(_graph("POST", f"/{c['waba_id']}/subscribed_apps").get("success"))


def enviar_texto(para: str, texto: str) -> str:
    c = _obligatoria()
    r = _graph("POST", f"/{c['phone_id']}/messages", {
        "messaging_product": "whatsapp", "recipient_type": "individual", "to": para,
        "type": "text", "text": {"preview_url": False, "body": texto}})
    return r["messages"][0]["id"]


def subir_media(contenido: bytes, mime: str, nombre: str) -> str:
    """Sube un archivo a Meta y devuelve su id (sirve para enviarlo)."""
    c = _obligatoria()
    limite = f"----crm{time.time_ns()}"
    seguro = re.sub(r'[^\w.\- ]', "_", nombre)[:80] or "archivo"
    cuerpo = b"".join([
        f'--{limite}\r\nContent-Disposition: form-data; name="messaging_product"\r\n\r\nwhatsapp\r\n'.encode(),
        f'--{limite}\r\nContent-Disposition: form-data; name="type"\r\n\r\n{mime}\r\n'.encode(),
        f'--{limite}\r\nContent-Disposition: form-data; name="file"; filename="{seguro}"\r\nContent-Type: {mime}\r\n\r\n'.encode(),
        contenido, f"\r\n--{limite}--\r\n".encode()])
    req = urllib.request.Request(
        f"{GRAPH}/{c['version']}/{c['phone_id']}/media", data=cuerpo, method="POST",
        headers={"Authorization": f"Bearer {c['token']}", "Content-Type": f"multipart/form-data; boundary={limite}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read())["id"]
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read()).get("error", {})
        except Exception:
            err = {}
        logger.warning("Meta rechazó la subida del archivo: %s", {k: err.get(k) for k in ("code", "error_subcode", "message")})
        if int(err.get("code", 0) or 0) == 190:
            cn.marcar(cn.actual(), "error", "El token venció o no es válido. Vuelve a conectar este número.")
        raise ErrorWa(traducir_error(err.get("code", 0), err.get("message", "")))
    except Exception as e:
        logger.error("No se pudo subir el archivo a Meta: %s", e)
        raise ErrorWa("No se pudo subir el archivo a Meta. Inténtalo de nuevo.")


def enviar_media(para: str, categoria: str, media_id: str, caption: str = "", nombre: str = "") -> str:
    c = _obligatoria()
    tipo = {"imagen": "image", "audio": "audio", "video": "video", "documento": "document"}[categoria]
    cuerpo: dict = {"id": media_id}
    if caption.strip() and tipo != "audio":  # los audios no admiten texto
        cuerpo["caption"] = caption.strip()[:1000]
    if tipo == "document":
        cuerpo["filename"] = nombre[:100]
    r = _graph("POST", f"/{c['phone_id']}/messages", {
        "messaging_product": "whatsapp", "recipient_type": "individual", "to": para, "type": tipo, tipo: cuerpo})
    return r["messages"][0]["id"]


def enviar_botones(para: str, cuerpo: str, botones: list[str], cabecera: tuple[str, str] | None = None) -> str:
    """Mensaje interactivo con hasta 3 botones. cabecera = (categoría, media_id) de una imagen o video."""
    c = _obligatoria()
    interactivo: dict = {
        "type": "button", "body": {"text": cuerpo[:1024]},
        "action": {"buttons": [{"type": "reply", "reply": {"id": f"b{i + 1}", "title": t.strip()[:20]}} for i, t in enumerate(botones[:3])]}}
    if cabecera:
        tipo = "image" if cabecera[0] == "imagen" else "video"
        interactivo["header"] = {"type": tipo, tipo: {"id": cabecera[1]}}
    r = _graph("POST", f"/{c['phone_id']}/messages", {
        "messaging_product": "whatsapp", "recipient_type": "individual", "to": para, "type": "interactive", "interactive": interactivo})
    return r["messages"][0]["id"]


def _limpiar_variable(v: str) -> str:
    # Meta no acepta saltos de línea, tabulaciones ni más de 4 espacios seguidos dentro de una variable
    return re.sub(r"\s{2,}", " ", re.sub(r"[\r\n\t]+", " ", v)).strip()[:500]


def enviar_plantilla(para: str, nombre: str, idioma: str, variables: list[str]) -> str:
    c = _obligatoria()
    plantilla: dict = {"name": nombre, "language": {"code": idioma}}
    if variables:
        plantilla["components"] = [{"type": "body", "parameters": [{"type": "text", "text": _limpiar_variable(v)} for v in variables]}]
    r = _graph("POST", f"/{c['phone_id']}/messages", {"messaging_product": "whatsapp", "to": para, "type": "template", "template": plantilla})
    return r["messages"][0]["id"]


_cache_pl: dict = {}


def plantillas() -> list[dict]:
    """Plantillas aprobadas que se pueden enviar desde el CRM (texto con variables en el cuerpo)."""
    ent = _cache_pl.get(cn.actual() or 0)
    if ent and time.time() - ent[0] < 60:
        return ent[1]
    c = _obligatoria()
    if not c["waba_id"]:
        raise ErrorWa("Falta el ID de la cuenta de WhatsApp Business (WABA) para listar las plantillas.")
    r = _graph("GET", f"/{c['waba_id']}/message_templates", consulta={
        "fields": "name,language,status,category,components", "status": "APPROVED", "limit": 200})
    salida = []
    for t in r.get("data", []):
        comps = t.get("components", [])
        cuerpo = next((x.get("text", "") for x in comps if x.get("type") == "BODY"), "")
        cabecera = next((x for x in comps if x.get("type") == "HEADER"), None)
        botones = next((x for x in comps if x.get("type") == "BUTTONS"), None)
        if cabecera and (cabecera.get("format") != "TEXT" or "{{" in cabecera.get("text", "")):
            continue  # cabeceras con imagen, video, documento o variables: aún no se soportan
        if botones and any("{{" in (b.get("url") or "") for b in botones.get("buttons", [])):
            continue
        n = len(set(re.findall(r"\{\{(\d+)\}\}", cuerpo)))
        salida.append({"nombre": t["name"], "idioma": t["language"], "categoria": t.get("category", ""), "cuerpo": cuerpo, "variables": n})
    salida.sort(key=lambda x: x["nombre"])
    _cache_pl[cn.actual() or 0] = (time.time(), salida)
    return salida


def descargar_media(media_id: str) -> tuple[bytes, str]:
    """Baja un archivo recibido (Meta lo conserva por tiempo limitado). Devuelve (contenido, tipo)."""
    c = _obligatoria()
    info = _graph("GET", f"/{media_id}")
    if int(info.get("file_size", 0) or 0) > MAX_MEDIA:
        raise ErrorWa("El archivo es demasiado grande para verlo aquí (máximo 16 MB).")
    url = info.get("url")
    if not url or not url.startswith("https://"):
        raise ErrorWa("Meta no entregó el archivo. Puede que ya no esté disponible.")
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {c['token']}"})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            contenido = r.read(MAX_MEDIA + 1)
    except Exception:
        raise ErrorWa("No se pudo descargar el archivo.")
    if len(contenido) > MAX_MEDIA:
        raise ErrorWa("El archivo es demasiado grande para verlo aquí (máximo 16 MB).")
    return contenido, info.get("mime_type", "application/octet-stream")


# ---------------- Recepción (webhook) ----------------
def firma_valida(cuerpo: bytes, cabecera: str | None) -> bool:
    """Meta firma cada aviso con tu App Secret. Sin firma válida no se procesa nada."""
    secreto = leer("wa_app_secret")
    if not secreto or not cabecera or not cabecera.startswith("sha256="):
        return False
    esperado = hmac.new(secreto.encode(), cuerpo, hashlib.sha256).hexdigest()
    return hmac.compare_digest(esperado, cabecera[7:])


def dentro_de_ventana(ultimo_entrante) -> bool:
    return bool(ultimo_entrante) and datetime.now(timezone.utc) - ultimo_entrante < VENTANA


def _contenido(m: dict) -> tuple[str, str, str | None, str | None, str | None] | None:
    """(tipo, texto, media_id, mime, nombre_archivo). None = ignorar (por ejemplo, reacciones)."""
    t = m.get("type", "")
    if t == "text":
        return "text", (m.get("text") or {}).get("body", ""), None, None, None
    if t in ("image", "video", "audio", "document", "sticker"):
        d = m.get(t) or {}
        return t, d.get("caption", "") or "", d.get("id"), d.get("mime_type"), d.get("filename")
    if t == "location":
        loc = m.get("location") or {}
        nombre = f" ({loc['name']})" if loc.get("name") else ""
        return "location", f"Ubicación: {loc.get('latitude')}, {loc.get('longitude')}{nombre}", None, None, None
    if t == "interactive":
        i = m.get("interactive") or {}
        r = i.get("button_reply") or i.get("list_reply") or {}
        return "interactive", r.get("title", ""), None, None, None
    if t == "button":
        return "text", (m.get("button") or {}).get("text", ""), None, None, None
    if t == "reaction":
        return None
    return "otro", f"[Mensaje de tipo «{t}» que aún no se puede mostrar]", None, None, None


def _recibir(con, m: dict, nombres: dict[str, str], canal_id: int | None = None) -> int | None:
    wa_id = m.get("id")
    de = normalizar_telefono(m.get("from", ""))
    cont = _contenido(m)
    if not wa_id or not de or cont is None:
        return None
    tipo, texto, media_id, mime, archivo = cont
    try:
        ts = datetime.fromtimestamp(int(m.get("timestamp", time.time())), tz=timezone.utc)
    except (TypeError, ValueError):
        ts = datetime.now(timezone.utc)
    lead = con.execute(
        "SELECT id FROM crm_leads WHERE telefono=? AND estado='abierto' ORDER BY id DESC LIMIT 1", (de,)).fetchone()
    if lead:
        lid = lead["id"]
    else:
        nombre = (nombres.get(m.get("from", "")) or "").strip() or f"WhatsApp +{de}"
        lid, _ = captar_lead(con, nombre=nombre, telefono=de, origen="whatsapp", interes=(texto or "")[:80])
    # Si Meta reintenta el aviso, el índice único lo detecta y no se cuenta dos veces
    nuevo = con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, media_id, media_mime, media_nombre, estado, creado_en, canal_id) "
        "VALUES (?, 'in', ?, ?, ?, ?, ?, ?, 'recibido', ?, ?) ON CONFLICT DO NOTHING RETURNING id",
        (lid, wa_id, tipo, texto, media_id, mime, archivo, ts, canal_id)).fetchone()
    if not nuevo:
        return None
    con.execute(
        "UPDATE crm_leads SET wa_ultimo_entrante=?, wa_no_leidos=wa_no_leidos+1, ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?",
        (ts, lid))
    return lid


def _estado(con, s: dict) -> int | None:
    wa_id = s.get("id")
    nuevo = {"sent": "enviado", "delivered": "entregado", "read": "leido", "failed": "fallido"}.get(s.get("status", ""))
    if not wa_id or not nuevo:
        return None
    m = con.execute("SELECT id, lead_id, estado, canal_id FROM crm_mensajes WHERE wa_id=? AND direccion='out'", (wa_id,)).fetchone()
    if not m:
        return None
    if nuevo != "fallido" and RANGO.get(nuevo, 0) <= RANGO.get(m["estado"], 0):
        return None  # un estado viejo que llega tarde no pisa a uno más avanzado
    error = ""
    if nuevo == "fallido":
        e = (s.get("errors") or [{}])[0]
        error = traducir_error(e.get("code", 0), e.get("title") or e.get("message") or "")
        if int(e.get("code", 0) or 0) in (131031, 190):  # cuenta bloqueada o token vencido: queda visible en CRM → Canales
            cn.marcar(m["canal_id"], "error", error)
    con.execute("UPDATE crm_mensajes SET estado=?, error=? WHERE id=?", (nuevo, error, m["id"]))
    return m["lead_id"]


def procesar(payload: dict) -> dict:
    """Procesa un aviso de Meta ya verificado: mensajes nuevos y cambios de estado."""
    cuenta = {"mensajes": 0, "estados": 0}
    if payload.get("object") != "whatsapp_business_account":
        return cuenta

    avisar: set[int] = set()
    nuevos: set[int] = set()  # solo mensajes nuevos (no cambios de estado): son los que activan automatizaciones
    con = abrir_db()
    try:
        for entrada in payload.get("entry", []):
            for cambio in entrada.get("changes", []):
                v = cambio.get("value") or {}
                if cambio.get("field") != "messages":
                    continue
                canal = cn.buscar(con, "whatsapp", str((v.get("metadata") or {}).get("phone_number_id") or ""))
                if not canal:
                    continue  # aviso de un número que no está conectado en este CRM
                nombres = {x.get("wa_id", ""): (x.get("profile") or {}).get("name", "") for x in v.get("contacts", [])}
                for m in v.get("messages", []):
                    lid = _recibir(con, m, nombres, canal["id"])
                    if lid:
                        avisar.add(lid); nuevos.add(lid); cuenta["mensajes"] += 1
                for s in v.get("statuses", []):
                    lid = _estado(con, s)
                    if lid:
                        avisar.add(lid); cuenta["estados"] += 1
        con.execute(
            "INSERT INTO configuracion (clave, valor) VALUES ('wa_ultimo_evento', ?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
            (datetime.now(timezone.utc).isoformat(),))
    finally:
        con.close()
    for lid in avisar:
        avisar_lead(lid)  # tiempo real: la ficha y el tablero se actualizan solos
    from core import automatizaciones as au  # importación tardía: evita un ciclo entre módulos
    au.despues_de_recibir(nuevos)
    return cuenta