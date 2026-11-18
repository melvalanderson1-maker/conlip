"""Archivos del CRM: biblioteca, adjuntos de conversaciones y envío por WhatsApp, Messenger e Instagram."""
import hashlib
import hmac
import logging
import mimetypes
import os
import re
import secrets
import time
from pathlib import Path

from core import canales as cn
from core import meta_social as ms
from core import whatsapp as wa
from core.db import abrir_db
from core.seguridad import secreto

logger = logging.getLogger("archivos")
DIR = Path(os.getenv("CRM_MEDIA_DIR", "/app/storage/crm"))
MAX_BYTES = 16 * 1024 * 1024
MAX_IMAGEN = 5 * 1024 * 1024  # el límite de WhatsApp para imágenes
FORMATOS = "JPG o PNG, MP4, MP3, OGG, AAC, M4A, AMR, PDF, Word, Excel, PowerPoint o TXT"
TIPOS = {
    "image/jpeg": ("imagen", ".jpg"), "image/png": ("imagen", ".png"),
    "video/mp4": ("video", ".mp4"), "video/3gpp": ("video", ".3gp"),
    "audio/aac": ("audio", ".aac"), "audio/mp4": ("audio", ".m4a"), "audio/mpeg": ("audio", ".mp3"),
    "audio/amr": ("audio", ".amr"), "audio/ogg": ("audio", ".ogg"),
    "application/pdf": ("documento", ".pdf"), "application/msword": ("documento", ".doc"),
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ("documento", ".docx"),
    "application/vnd.ms-excel": ("documento", ".xls"),
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": ("documento", ".xlsx"),
    "application/vnd.ms-powerpoint": ("documento", ".ppt"),
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ("documento", ".pptx"),
    "text/plain": ("documento", ".txt"),
}
ALIAS = {"image/jpg": "image/jpeg", "audio/mp3": "audio/mpeg", "audio/x-m4a": "audio/mp4", "audio/m4a": "audio/mp4",
         "audio/mp4a-latm": "audio/mp4", "audio/x-aac": "audio/aac"}
TIPO_MENSAJE = {"imagen": "image", "audio": "audio", "video": "video", "documento": "document"}


def clasificar(nombre: str, mime: str) -> tuple[str, str, str]:
    """Devuelve (mime, categoría, extensión). Solo se aceptan formatos que WhatsApp y Meta entienden."""
    mime = ALIAS.get(mime, mime)
    if mime not in TIPOS:
        adivinado = mimetypes.guess_type(nombre)[0] or ""
        mime = ALIAS.get(adivinado, adivinado)
    if mime not in TIPOS:
        raise wa.ErrorWa(f"Formato no admitido. Usa {FORMATOS}.")
    return (mime, *TIPOS[mime])


def _firma_ok(mime: str, c: bytes) -> bool:
    if mime == "image/jpeg":
        return c[:3] == b"\xff\xd8\xff"
    if mime == "image/png":
        return c[:4] == b"\x89PNG"
    if mime == "application/pdf":
        return c[:5] == b"%PDF-"
    if mime == "video/mp4":
        return b"ftyp" in c[:16]
    if mime == "audio/ogg":
        return c[:4] == b"OggS"
    return True


def guardar_archivo(con, nombre: str, mime: str, contenido: bytes, origen: str, usuario: str) -> int:
    mime, categoria, ext = clasificar(nombre, mime)
    if len(contenido) > MAX_BYTES:
        raise wa.ErrorWa("El archivo es demasiado grande (máximo 16 MB).")
    if categoria == "imagen" and len(contenido) > MAX_IMAGEN:
        raise wa.ErrorWa("Las imágenes pueden pesar hasta 5 MB.")
    if not _firma_ok(mime, contenido):
        raise wa.ErrorWa("El contenido del archivo no coincide con su tipo. Revisa que no esté dañado.")
    ruta = f"{secrets.token_hex(16)}{ext}"
    try:
        DIR.mkdir(parents=True, exist_ok=True)
        (DIR / ruta).write_bytes(contenido)
    except OSError:
        logger.exception("No se pudo escribir en %s", DIR)
        raise wa.ErrorWa("No se pudo guardar el archivo en el servidor. Revisa el volumen de almacenamiento.")
    limpio = re.sub(r"[^\w.\- ]", "_", nombre)[:100] or f"archivo{ext}"
    return con.execute(
        "INSERT INTO crm_archivos (nombre, mime, categoria, tamano, ruta, origen, subido_por) VALUES (?,?,?,?,?,?,?) RETURNING id",
        (limpio, mime, categoria, len(contenido), ruta, origen, usuario)).fetchone()[0]


def _contenido(fila) -> bytes:
    p = (DIR / fila["ruta"]).resolve()
    if DIR.resolve() not in p.parents or not p.is_file():
        raise wa.ErrorWa("El archivo ya no está disponible en el servidor.")
    return p.read_bytes()


def leer_por_id(archivo_id: int) -> tuple[bytes, str]:
    con = abrir_db()
    try:
        f = con.execute("SELECT ruta, mime FROM crm_archivos WHERE id=?", (archivo_id,)).fetchone()
    finally:
        con.close()
    if not f:
        raise wa.ErrorWa("El archivo no existe.")
    return _contenido(f), f["mime"]


def borrar(con, archivo_id: int) -> None:
    f = con.execute("DELETE FROM crm_archivos WHERE id=? RETURNING ruta", (archivo_id,)).fetchone()
    if f:
        try:
            (DIR / f["ruta"]).unlink(missing_ok=True)
        except OSError:
            logger.warning("No se pudo borrar el archivo %s del disco", f["ruta"])


# ---------------- Enlace público firmado (Messenger e Instagram descargan el archivo desde aquí) ----------------
def _firma(aid: int, exp: int) -> str:
    return hmac.new(secreto().encode(), f"crm-archivo|{aid}|{exp}".encode(), hashlib.sha256).hexdigest()[:32]


def url_publica(aid: int, minutos: int = 60) -> str:
    exp = int(time.time()) + minutos * 60
    base = os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")
    return f"{base}/api/publico/archivos/{aid}.{exp}.{_firma(aid, exp)}"


def id_de_token(token: str) -> int | None:
    try:
        aid, exp, firma = token.split(".")
        if int(exp) < time.time() or not hmac.compare_digest(firma, _firma(int(aid), int(exp))):
            return None
        return int(aid)
    except (ValueError, TypeError):
        return None


# ---------------- Envío ----------------
def _lead_wa(con, lead_id: int):
    l = con.execute("SELECT telefono, wa_ultimo_entrante FROM crm_leads WHERE id=?", (lead_id,)).fetchone()
    if not l or not l["telefono"]:
        raise wa.ErrorWa("El lead no tiene teléfono.")
    if not wa.dentro_de_ventana(l["wa_ultimo_entrante"]):
        raise wa.ErrorWa("Pasaron más de 24 horas desde el último mensaje del cliente: en WhatsApp solo se puede enviar una plantilla.")
    return l


def _registrar(con, lead_id: int, wa_id: str, tipo: str, texto: str, archivo, canal: str, canal_id: int | None, usuario: str) -> int:
    r = con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, media_mime, media_nombre, archivo_id, estado, enviado_por, canal, canal_id) "
        "VALUES (?, 'out', ?, ?, ?, ?, ?, ?, 'enviado', ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id",
        (lead_id, wa_id, tipo, texto, archivo["mime"] if archivo else None, archivo["nombre"] if archivo else None,
         archivo["id"] if archivo else None, usuario, canal, canal_id)).fetchone()
    con.execute("UPDATE crm_leads SET ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?", (lead_id,))
    return r[0] if r else 0


def enviar_a_lead(con, lead_id: int, canal: str, archivo, caption: str, usuario: str) -> int:
    """Envía un archivo ya guardado por el canal indicado. Lanza ErrorWa con un mensaje legible."""
    caption = (caption or "").strip()
    contenido = _contenido(archivo)
    tipo = TIPO_MENSAJE[archivo["categoria"]]
    if canal == "whatsapp":
        l = _lead_wa(con, lead_id)
        cid = cn.para_responder(con, lead_id, "whatsapp")
        with cn.usando(cid):
            media_id = wa.subir_media(contenido, archivo["mime"], archivo["nombre"])
            wamid = wa.enviar_media(l["telefono"], archivo["categoria"], media_id, caption, archivo["nombre"])
        return _registrar(con, lead_id, wamid, tipo, "" if tipo == "audio" else caption, archivo, "whatsapp", cid, usuario)
    if canal not in ms.COLUMNAS:
        raise wa.ErrorWa("Canal no válido.")
    col_id, col_ult = ms.COLUMNAS[canal]
    l = con.execute(f"SELECT {col_id} AS cid, {col_ult} AS ult FROM crm_leads WHERE id=?", (lead_id,)).fetchone()
    if not l or not l["cid"]:
        raise wa.ErrorWa(f"Este lead no tiene conversación por {ms.NOMBRE_CANAL[canal]}.")
    if not wa.dentro_de_ventana(l["ult"]):
        raise wa.ErrorWa(ms.MSG_VENTANA)
    cid = cn.para_responder(con, lead_id, canal)
    with cn.usando(cid):
        mid = ms.enviar_adjunto(canal, l["cid"], archivo["categoria"], url_publica(archivo["id"]))
        if caption:
            ms.enviar(canal, l["cid"], caption)  # en estos canales el texto va como mensaje aparte
    return _registrar(con, lead_id, mid, tipo, caption, archivo, canal, cid, usuario)


def enviar_botones_a_lead(con, lead_id: int, texto: str, botones: list[str], archivo, usuario: str) -> int:
    """Mensaje de WhatsApp con botones (solo dentro de las 24 h). El archivo, si es imagen o video, va arriba."""
    if not 1 <= len(botones) <= 3:
        raise wa.ErrorWa("Los botones deben ser de 1 a 3.")
    l = _lead_wa(con, lead_id)
    cid = cn.para_responder(con, lead_id, "whatsapp")
    with cn.usando(cid):
        cabecera = None
        if archivo and archivo["categoria"] in ("imagen", "video"):
            cabecera = (archivo["categoria"], wa.subir_media(_contenido(archivo), archivo["mime"], archivo["nombre"]))
        wamid = wa.enviar_botones(l["telefono"], texto, botones, cabecera)
    return _registrar(con, lead_id, wamid, "interactive", f"{texto}\n[Botones: {' | '.join(botones)}]", None, "whatsapp", cid, usuario)