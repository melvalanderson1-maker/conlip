"""CRM-3: Messenger, Instagram Direct, leads de anuncios de Facebook (Lead Ads) y entrada genérica por webhook.

Usa la MISMA app de Meta que WhatsApp: misma firma (App Secret) y mismo token de verificación del webhook.
Nada de aquí puede romper el CRM: los errores de Meta se convierten en ErrorWa con un mensaje legible.
"""
import hmac
import json
import logging
import re
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from fastapi import HTTPException

from core.crm import avisar_lead, captar_lead, contacto_valido, registrar
from core.db import abrir_db
from core.secretos import leer
from core.whatsapp import GRAPH, VERSION_BASE, ErrorWa, dentro_de_ventana, firma_valida  # firma_valida se reutiliza tal cual

logger = logging.getLogger("meta_social")

# canal -> (columna con el id del cliente en ese canal, columna con su último mensaje entrante)
COLUMNAS = {"facebook": ("fb_psid", "fb_ultimo_entrante"), "instagram": ("ig_id", "ig_ultimo_entrante")}
NOMBRE_CANAL = {"facebook": "Messenger", "instagram": "Instagram"}
MAX_MEDIA = 16 * 1024 * 1024
HOSTS_MEDIA = (".fbcdn.net", ".cdninstagram.com", ".fbsbx.com")

ERRORES = {
    190: "El token de acceso de la página venció o no es válido. Genera uno nuevo en Meta y guárdalo en CRM → Conexiones.",
    200: "Meta negó el permiso. Revisa que la app tenga los permisos de mensajería y que la página esté conectada.",
    551: "Esa persona no está disponible para recibir mensajes ahora.",
    368: "Meta bloqueó el mensaje por posible spam.",
    100: "Meta rechazó la solicitud por un dato inválido.",
    613: "Se alcanzó el límite de envío. Espera unos minutos.",
}
MSG_VENTANA = "Pasaron más de 24 horas desde el último mensaje del cliente: Meta ya no permite responderle por este canal."


def traducir_error(codigo: int, subcodigo: int = 0, mensaje: str = "") -> str:
    if int(codigo or 0) == 10 or int(subcodigo or 0) == 2018278:
        return MSG_VENTANA
    base = ERRORES.get(int(codigo or 0))
    return base if base else (f"Meta respondió: {mensaje}" if mensaje else "Meta rechazó la solicitud.")


# ---------------- Configuración (cifrada, se edita en el panel) ----------------
def cfg() -> dict[str, str]:
    return {
        "page_id": leer("meta_page_id"), "page_token": leer("meta_page_token"), "ig_id": leer("meta_ig_id"),
        "version": leer("wa_version") or VERSION_BASE,
    }


def configurado(canal: str | None = None) -> bool:
    c = cfg()
    if not (c["page_id"] and c["page_token"]):
        return False
    return bool(c["ig_id"]) if canal == "instagram" else True


def _obligatoria() -> dict[str, str]:
    c = cfg()
    if not (c["page_id"] and c["page_token"]):
        raise ErrorWa("Facebook/Instagram no está configurado. Pídele al superadmin que lo conecte en CRM → Conexiones.")
    return c


# ---------------- Llamadas a la API de Meta ----------------
def _graph(metodo: str, ruta: str, cuerpo: dict | None = None, consulta: dict | None = None):
    c = _obligatoria()
    url = f"{GRAPH}/{c['version']}{ruta}"
    if consulta:
        url += "?" + urllib.parse.urlencode(consulta)
    datos = json.dumps(cuerpo).encode() if cuerpo is not None else (b"" if metodo == "POST" else None)
    cab = {"Authorization": f"Bearer {c['page_token']}"}
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
        logger.warning("Meta rechazó %s %s: %s", metodo, ruta,
                       {k: err.get(k) for k in ("code", "error_subcode", "message")})
        raise ErrorWa(traducir_error(err.get("code", 0), err.get("error_subcode", 0), err.get("message", "")))
    except Exception as e:
        logger.error("No se pudo contactar a Meta: %s", e)
        raise ErrorWa("No se pudo contactar a Meta. Revisa tu conexión e inténtalo de nuevo.")


def info_conexion() -> dict:
    """Para el botón «Probar conexión» del panel."""
    c = _obligatoria()
    salida: dict = {"pagina": _graph("GET", f"/{c['page_id']}", consulta={"fields": "name"}).get("name", "")}
    if c["ig_id"]:
        salida["instagram"] = _graph("GET", f"/{c['ig_id']}", consulta={"fields": "username"}).get("username", "")
    return salida



def suscribir_pagina() -> bool:
    """Suscribe la página a los avisos de Messenger."""
    c = _obligatoria()

    r = _graph(
        "POST",
        f"/{c['page_id']}/subscribed_apps",
        consulta={"subscribed_fields": "messages"}
    )

    if not r.get("success"):
        raise ErrorWa("Meta no confirmó la suscripción de Messenger.")

    return True



def nombre_perfil(canal: str, id_cliente: str) -> str:
    """Nombre público del cliente. Meta a veces no lo entrega; en ese caso devuelve vacío."""
    try:
        campos = "name,username" if canal == "instagram" else "name"
        d = _graph("GET", f"/{id_cliente}", consulta={"fields": campos})
        return (d.get("name") or d.get("username") or "").strip()
    except Exception:
        return ""


def enviar(canal: str, destinatario: str, texto: str) -> str:
    """Envía un texto por Messenger o Instagram. Devuelve el id del mensaje."""
    c = _obligatoria()
    if canal == "instagram" and not c["ig_id"]:
        raise ErrorWa("Falta el ID de la cuenta de Instagram en CRM → Conexiones.")
    r = _graph("POST", f"/{c['page_id']}/messages", {
        "recipient": {"id": destinatario}, "messaging_type": "RESPONSE", "message": {"text": texto}})
    return r["message_id"]


def enviar_a_lead(con, lead_id: int, canal: str, texto: str, usuario: str) -> int:
    """Responde a un lead por su canal, respetando la ventana de 24 h. Guarda el mensaje y devuelve su id."""
    if canal not in COLUMNAS:
        raise ErrorWa("Canal no válido.")
    col_id, col_ult = COLUMNAS[canal]
    lead = con.execute(f"SELECT id, {col_id} AS cid, {col_ult} AS ult FROM crm_leads WHERE id=?", (lead_id,)).fetchone()
    if not lead or not lead["cid"]:
        raise ErrorWa(f"Este lead no tiene conversación por {NOMBRE_CANAL[canal]}.")
    if not dentro_de_ventana(lead["ult"]):
        raise ErrorWa(MSG_VENTANA)
    mid = enviar(canal, lead["cid"], texto)
    mensaje_id = con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, estado, enviado_por, canal) "
        "VALUES (?, 'out', ?, 'text', ?, 'enviado', ?, ?) ON CONFLICT DO NOTHING RETURNING id",
        (lead_id, mid, texto, usuario, canal)).fetchone()
    con.execute("UPDATE crm_leads SET ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?", (lead_id,))
    return mensaje_id[0] if mensaje_id else 0


# ---------------- Archivos recibidos (Meta entrega una URL temporal) ----------------
class _SinRedirecciones(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *a, **k):
        return None


def descargar_url(url: str) -> tuple[bytes, str]:
    """Baja un adjunto recibido. Solo acepta direcciones https de las CDN de Meta."""
    host = (urllib.parse.urlparse(url).hostname or "").lower()
    if not url.startswith("https://") or not host.endswith(HOSTS_MEDIA):
        raise ErrorWa("Dirección de archivo no permitida.")
    try:
        with urllib.request.build_opener(_SinRedirecciones).open(urllib.request.Request(url), timeout=30) as r:
            tipo = r.headers.get_content_type() or "application/octet-stream"
            contenido = r.read(MAX_MEDIA + 1)
    except Exception:
        raise ErrorWa("No se pudo descargar el archivo. Puede que ya no esté disponible.")
    if len(contenido) > MAX_MEDIA:
        raise ErrorWa("El archivo es demasiado grande para verlo aquí (máximo 16 MB).")
    return contenido, tipo


# ---------------- Recepción (webhook) ----------------
def _contenido(m: dict) -> tuple[str, str, str | None] | None:
    """(tipo, texto, url_adjunto). None = ignorar."""
    texto = (m.get("text") or "").strip()
    adjuntos = m.get("attachments") or []
    if not adjuntos:
        return ("text", texto, None) if texto else None
    a = adjuntos[0]
    t = a.get("type", "")
    p = a.get("payload") or {}
    if t == "location":
        co = p.get("coordinates") or {}
        return "location", f"Ubicación: {co.get('lat')}, {co.get('long')}", None
    tipo = {"image": "image", "audio": "audio", "video": "video", "file": "document"}.get(t)
    url = p.get("url")
    if not tipo or not url:
        return "otro", texto or f"[Adjunto de tipo «{t}» que aún no se puede mostrar]", None
    return tipo, texto, url


def _recibir(con, canal: str, ev: dict, propio: str) -> int | None:
    m = ev.get("message") or {}
    mid = m.get("mid")
    de = str((ev.get("sender") or {}).get("id") or "")
    if not mid or not de or de == propio or m.get("is_echo"):
        return None
    cont = _contenido(m)
    if cont is None:
        return None
    tipo, texto, url = cont
    try:
        ts = datetime.fromtimestamp(int(ev.get("timestamp")) / 1000, tz=timezone.utc)
    except (TypeError, ValueError):
        ts = datetime.now(timezone.utc)
    col_id, col_ult = COLUMNAS[canal]
    lead = con.execute(
        f"SELECT id FROM crm_leads WHERE {col_id}=? AND estado='abierto' ORDER BY id DESC LIMIT 1", (de,)).fetchone()
    if lead:
        lid = lead["id"]
    else:
        nombre = nombre_perfil(canal, de) or f"{NOMBRE_CANAL[canal]} {de[-4:]}"
        lid, _ = captar_lead(con, nombre=nombre, origen=canal, interes=(texto or "")[:80])
        con.execute(f"UPDATE crm_leads SET {col_id}=? WHERE id=?", (de, lid))
    # Si Meta reintenta el aviso, el índice único del id del mensaje lo detecta y no se cuenta dos veces
    nuevo = con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, media_id, estado, creado_en, canal) "
        "VALUES (?, 'in', ?, ?, ?, ?, 'recibido', ?, ?) ON CONFLICT DO NOTHING RETURNING id",
        (lid, mid, tipo, texto, url, ts, canal)).fetchone()
    if not nuevo:
        return None
    con.execute(
        f"UPDATE crm_leads SET {col_ult}=?, wa_no_leidos=wa_no_leidos+1, ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?",
        (ts, lid))
    return lid


_CAMPOS_BASICOS = {"full_name", "first_name", "last_name", "email", "phone_number", "company_name"}


def _leadgen(con, v: dict) -> int | None:
    """Lead de un formulario instantáneo de Facebook: Meta avisa con un id y hay que pedir los datos."""
    lg = str(v.get("leadgen_id") or "")
    if not lg:
        return None
    nuevo = con.execute(
        "INSERT INTO crm_leadgen_vistos (leadgen_id) VALUES (?) ON CONFLICT DO NOTHING RETURNING leadgen_id", (lg,)).fetchone()
    if not nuevo:
        return None  # aviso repetido
    try:
        d = _graph("GET", f"/{lg}", consulta={"fields": "field_data,ad_name,form_id,created_time"})
    except ErrorWa:
        con.execute("DELETE FROM crm_leadgen_vistos WHERE leadgen_id=?", (lg,))  # que el reintento de Meta lo vuelva a procesar
        raise
    campos: dict[str, str] = {}
    for f in d.get("field_data", []):
        vals = f.get("values") or []
        campos[str(f.get("name", ""))] = str(vals[0]).strip() if vals else ""
    nombre = campos.get("full_name") or " ".join(x for x in (campos.get("first_name"), campos.get("last_name")) if x) or "Lead de Facebook"
    correo, tel, descartados = "", "", []
    try:
        correo, _ = contacto_valido(campos.get("email", ""), "")
    except HTTPException:
        descartados.append(f"correo: {campos.get('email', '')}")
    try:
        _, tel = contacto_valido("", campos.get("phone_number", ""))
    except HTTPException:
        descartados.append(f"teléfono: {campos.get('phone_number', '')}")
    interes = (d.get("ad_name") or "Formulario de Facebook").strip()
    lid, _ = captar_lead(con, nombre=nombre, correo=correo, telefono=tel, empresa=campos.get("company_name", ""),
                         origen="facebook", interes=interes)
    extras = [f"- {k}: {val}" for k, val in campos.items() if k not in _CAMPOS_BASICOS and val]
    extras += [f"- (dato no válido) {x}" for x in descartados]
    if extras:
        registrar(con, lid, "nota", "Respuestas del formulario de Facebook:\n" + "\n".join(extras), "facebook")
    return lid


def procesar(payload: dict) -> dict:
    """Procesa un aviso de Meta ya verificado (Messenger, Instagram o Lead Ads).
    'fallos' > 0 significa que algo debe reintentarse: el router responde 500 para que Meta reenvíe."""
    cuenta = {"mensajes": 0, "leads": 0, "fallos": 0}
    canal = {"page": "facebook", "instagram": "instagram"}.get(payload.get("object", ""))
    if not canal:
        return cuenta
    c = cfg()
    propio = c["ig_id"] if canal == "instagram" else c["page_id"]
    if not propio:
        return cuenta
    avisar: set[int] = set()
    con = abrir_db()
    try:
        for entrada in payload.get("entry", []):
            if str(entrada.get("id")) != propio:
                continue
            for ev in entrada.get("messaging", []):
                try:
                    lid = _recibir(con, canal, ev, propio)
                    if lid:
                        avisar.add(lid); cuenta["mensajes"] += 1
                except Exception:
                    logger.exception("No se pudo guardar un mensaje de %s", canal)
                    cuenta["fallos"] += 1
            if canal == "facebook":
                for cambio in entrada.get("changes", []):
                    if cambio.get("field") != "leadgen":
                        continue
                    try:
                        lid = _leadgen(con, cambio.get("value") or {})
                        if lid:
                            avisar.add(lid); cuenta["leads"] += 1
                    except Exception:
                        logger.exception("No se pudo traer el lead del anuncio")
                        cuenta["fallos"] += 1
        con.execute(
            "INSERT INTO configuracion (clave, valor) VALUES ('meta_ultimo_evento', ?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
            (datetime.now(timezone.utc).isoformat(),))
    finally:
        con.close()
    for lid in avisar:
        avisar_lead(lid)  # tiempo real
    return cuenta


# ---------------- Entrada genérica (Zapier, Make, tu landing) ----------------
def clave_generica_valida(cabecera: str | None) -> bool:
    """La clave viaja en la cabecera X-Webhook-Key (nunca en la URL, para que no quede en los logs)."""
    clave = leer("crm_webhook_clave")
    return bool(clave and cabecera) and hmac.compare_digest(clave.encode(), cabecera.encode())


def captar_generico(datos: dict) -> int:
    """Crea (o actualiza, si ya existe) un lead desde un JSON externo. Lanza ErrorWa con un mensaje claro."""
    nombre = str(datos.get("nombre") or "").strip()
    if not nombre:
        raise ErrorWa("Falta el campo «nombre».")
    try:
        correo, tel = contacto_valido(str(datos.get("correo") or ""), str(datos.get("telefono") or ""))
    except HTTPException as e:
        raise ErrorWa(str(e.detail))
    if not (correo or tel):
        raise ErrorWa("Envía al menos «telefono» o «correo».")
    origen = str(datos.get("origen") or "web").strip().lower()
    if not re.fullmatch(r"[a-z_]{1,20}", origen):
        origen = "web"
    try:
        valor = max(0.0, float(datos.get("valor") or 0))
    except (TypeError, ValueError):
        valor = 0.0
    con = abrir_db()
    try:
        lid, _ = captar_lead(con, nombre=nombre, correo=correo, telefono=tel, empresa=str(datos.get("empresa") or ""),
                             origen=origen, interes=str(datos.get("interes") or ""), valor=valor, creado_por="webhook")
    finally:
        con.close()
    avisar_lead(lid)
    return lid