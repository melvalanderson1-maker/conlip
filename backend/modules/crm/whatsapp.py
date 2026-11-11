import hmac
import json
import os
import re
import secrets
from datetime import datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core import whatsapp as wa
from core.crm import avisar_lead
from core.db import abrir_db
from core.secretos import clave_ok, guardar, leer
from core.seguridad import auditar, ip_cliente, solo_superadmin
from modules.crm.router import _lead, contexto

router_webhook = APIRouter(prefix="/api/webhooks", tags=["webhooks"])
router = APIRouter(prefix="/api/crm", tags=["crm-whatsapp"])
router_admin = APIRouter(prefix="/api/integraciones/whatsapp", tags=["whatsapp-admin"], dependencies=[Depends(solo_superadmin)])

MEDIA_INLINE = ("image/jpeg", "image/png", "image/webp", "image/gif", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "video/mp4", "application/pdf")


# ======================= WEBHOOK (lo llama Meta) =======================
@router_webhook.get("/whatsapp")
def verificar(request: Request):
    """Meta confirma que esta dirección es nuestra enviando el 'verify token' que configuramos."""
    q = request.query_params
    esperado = leer("wa_verify_token")
    if q.get("hub.mode") == "subscribe" and esperado and hmac.compare_digest(q.get("hub.verify_token", ""), esperado):
        return PlainTextResponse(q.get("hub.challenge", ""))
    raise HTTPException(403, "Verificación rechazada")


@router_webhook.post("/whatsapp")
async def recibir(request: Request):
    cuerpo = await request.body()
    if len(cuerpo) > 2_000_000:
        raise HTTPException(413, "Demasiado grande")
    if not wa.firma_valida(cuerpo, request.headers.get("x-hub-signature-256")):
        raise HTTPException(403, "Firma inválida")  # sin firma de Meta no se procesa nada
    try:
        payload = json.loads(cuerpo)
    except ValueError:
        raise HTTPException(400, "JSON inválido")
    # Si algo falla aquí devolvemos error: Meta reintenta y el índice único evita duplicados
    await run_in_threadpool(wa.procesar, payload)
    return {"ok": True}


# ======================= CONVERSACIÓN EN EL CRM =======================
class TextoIn(BaseModel):
    texto: str = Field(min_length=1, max_length=4000)


class PlantillaIn(BaseModel):
    nombre: str = Field(min_length=1, max_length=120)
    idioma: str = Field(min_length=2, max_length=12)
    variables: list[str] = Field(default_factory=list, max_length=20)


def _guardar_salida(con, lid: int, wamid: str, tipo: str, texto: str, usuario: str) -> None:
    con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, estado, enviado_por) VALUES (?, 'out', ?, ?, ?, 'enviado', ?)",
        (lid, wamid, tipo, texto, usuario))
    con.execute(
        "UPDATE crm_leads SET wa_no_leidos=0, ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?", (lid,))


@router.get("/leads/{lid}/mensajes")
def mensajes(lid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        filas = con.execute(
            "SELECT id, direccion, tipo, texto, (media_id IS NOT NULL) AS tiene_media, media_mime, media_nombre, estado, error, "
            "enviado_por, creado_en FROM crm_mensajes WHERE lead_id=? ORDER BY creado_en DESC LIMIT 300", (lid,)).fetchall()
    finally:
        con.close()
    ultimo = l["wa_ultimo_entrante"]
    return {
        "configurado": wa.configurado(), "telefono": l["telefono"], "no_leidos": l["wa_no_leidos"],
        "ventana_hasta": (ultimo + wa.VENTANA).isoformat() if ultimo else None,
        "puede_texto_libre": wa.dentro_de_ventana(ultimo),
        "mensajes": [dict(f) for f in reversed(filas)],
    }


@router.post("/leads/{lid}/mensajes")
def enviar(lid: int, d: TextoIn, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        if not l["telefono"]:
            raise HTTPException(400, "Este lead no tiene teléfono")
        if not wa.dentro_de_ventana(l["wa_ultimo_entrante"]):
            raise HTTPException(409, "Pasaron más de 24 horas desde el último mensaje del cliente. Envía una plantilla aprobada.")
        try:
            wamid = wa.enviar_texto(l["telefono"], d.texto.strip())
        except wa.ErrorWa as e:
            raise HTTPException(400, str(e))
        _guardar_salida(con, lid, wamid, "text", d.texto.strip(), ctx["u"]["usuario"])
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


@router.post("/leads/{lid}/plantilla")
def enviar_plantilla(lid: int, d: PlantillaIn, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        if not l["telefono"]:
            raise HTTPException(400, "Este lead no tiene teléfono")
        try:
            pl = next((p for p in wa.plantillas() if p["nombre"] == d.nombre and p["idioma"] == d.idioma), None)
            if not pl:
                raise HTTPException(400, "Esa plantilla no está aprobada o no se puede enviar desde aquí")
            if len(d.variables) != pl["variables"] or any(not v.strip() for v in d.variables):
                raise HTTPException(400, f"Esta plantilla necesita {pl['variables']} variable(s), todas con texto")
            wamid = wa.enviar_plantilla(l["telefono"], d.nombre, d.idioma, d.variables)
        except wa.ErrorWa as e:
            raise HTTPException(400, str(e))
        texto = re.sub(r"\{\{(\d+)\}\}", lambda m: d.variables[int(m.group(1)) - 1] if int(m.group(1)) <= len(d.variables) else "", pl["cuerpo"])
        _guardar_salida(con, lid, wamid, "template", f"[Plantilla {d.nombre}] {texto}", ctx["u"]["usuario"])
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


@router.post("/leads/{lid}/leido")
def marcar_leido(lid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        _lead(con, lid, ctx)
        r = con.execute("UPDATE crm_leads SET wa_no_leidos=0 WHERE id=? AND wa_no_leidos > 0 RETURNING id", (lid,)).fetchone()
    finally:
        con.close()
    if r:  # solo se avisa si algo cambió (si no, la pantalla entraría en un ciclo de actualizaciones)
        avisar_lead(lid)
    return {"ok": True}


@router.get("/whatsapp/plantillas")
def listar_plantillas(ctx: dict = Depends(contexto)):
    try:
        return wa.plantillas()
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))


@router.get("/mensajes/{mid}/media")
def media(mid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        m = con.execute("SELECT lead_id, media_id, media_mime, media_nombre, tipo FROM crm_mensajes WHERE id=? AND media_id IS NOT NULL", (mid,)).fetchone()
        if not m:
            raise HTTPException(404, "Archivo no encontrado")
        _lead(con, m["lead_id"], ctx)  # el asesor solo ve archivos de sus propios leads
    finally:
        con.close()
    try:
        contenido, mime = wa.descargar_media(m["media_id"])
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    mime = (m["media_mime"] or mime).split(";")[0].strip().lower()
    nombre = re.sub(r"[^\w.\- ]", "_", m["media_nombre"] or f"{m['tipo']}-{mid}")[:80]
    if mime in MEDIA_INLINE:
        return Response(content=contenido, media_type=mime, headers={"Content-Disposition": f'inline; filename="{nombre}"'})
    # Cualquier otro tipo (HTML, SVG…) se entrega solo como descarga: nunca se ejecuta en el navegador
    return Response(content=contenido, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{nombre}"'})


# ======================= CONFIGURACIÓN (solo superadmin) =======================
class ConfigIn(BaseModel):
    phone_id: str = Field(default="", max_length=30)
    waba_id: str = Field(default="", max_length=30)
    token: str = Field(default="", max_length=600)
    app_secret: str = Field(default="", max_length=100)
    version: str = Field(default="", max_length=10)


def _url_webhook() -> str:
    return os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/") + "/api/webhooks/whatsapp"


@router_admin.get("")
def estado():
    c = wa.cfg()
    con = abrir_db()
    try:
        r = con.execute("SELECT valor FROM configuracion WHERE clave='wa_ultimo_evento'").fetchone()
    finally:
        con.close()
    return {
        "clave_ok": clave_ok(), "configurado": wa.configurado(), "phone_id": c["phone_id"], "waba_id": c["waba_id"],
        "token_guardado": bool(c["token"]), "secreto_guardado": bool(c["app_secret"]), "version": c["version"],
        "verify_token": c["verify_token"], "webhook_url": _url_webhook(), "ultimo_evento": r["valor"] if r else None,
    }


@router_admin.put("")
def guardar_config(d: ConfigIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    phone, waba, token, secreto, version = d.phone_id.strip(), d.waba_id.strip(), d.token.strip(), d.app_secret.strip(), d.version.strip()
    if phone and not re.fullmatch(r"\d{5,30}", phone):
        raise HTTPException(400, "El Phone number ID son solo números")
    if waba and not re.fullmatch(r"\d{5,30}", waba):
        raise HTTPException(400, "El ID de la cuenta de WhatsApp Business son solo números")
    if token and (len(token) < 40 or re.search(r"\s", token)):
        raise HTTPException(400, "El token de acceso no parece completo. Cópialo de nuevo sin espacios.")
    if secreto and not re.fullmatch(r"[0-9a-fA-F]{32}", secreto):
        raise HTTPException(400, "El App Secret debe tener 32 caracteres (letras de la a a la f y números)")
    if version and not re.fullmatch(r"v\d{2}\.\d", version):
        raise HTTPException(400, "La versión debe verse así: v24.0")
    for clave, valor in (("wa_phone_id", phone), ("wa_waba_id", waba), ("wa_token", token), ("wa_app_secret", secreto), ("wa_version", version)):
        if valor:
            guardar(clave, valor)
    if not leer("wa_verify_token"):
        guardar("wa_verify_token", secrets.token_urlsafe(24))
    auditar("whatsapp_config", yo["usuario"], ip_cliente(request), "credenciales actualizadas")
    return {"ok": True}


@router_admin.post("/probar")
def probar():
    try:
        i = wa.info_numero()
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "detalle": f"Conectado: {i.get('verified_name', '')} ({i.get('display_phone_number', '')}). Calidad del número: {i.get('quality_rating', 'sin dato')}."}


@router_admin.post("/suscribir")
def suscribir(request: Request, yo: dict = Depends(solo_superadmin)):
    try:
        ok = wa.suscribir_app()
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    auditar("whatsapp_suscribir", yo["usuario"], ip_cliente(request), "app suscrita a la cuenta")
    return {"ok": ok, "detalle": "Tu app quedó suscrita a los avisos de tu cuenta de WhatsApp Business." if ok else "Meta no confirmó la suscripción."}