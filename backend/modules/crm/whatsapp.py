import hmac
import logging
import json
import os
import re
import secrets
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request, Response
from fastapi.responses import PlainTextResponse
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from core import meta_social as ms
from core import whatsapp as wa
from core.crm import avisar_lead
from core.db import abrir_db
from core.secretos import clave_ok, guardar, leer
from core.seguridad import auditar, ip_cliente, solo_superadmin
from modules.crm.router import _lead, contexto

logger = logging.getLogger("crm_meta")

router_webhook = APIRouter(prefix="/api/webhooks", tags=["webhooks"])
router = APIRouter(prefix="/api/crm", tags=["crm-whatsapp"])
router_admin = APIRouter(prefix="/api/integraciones/whatsapp", tags=["whatsapp-admin"], dependencies=[Depends(solo_superadmin)])
router_admin_meta = APIRouter(prefix="/api/integraciones/meta", tags=["meta-admin"], dependencies=[Depends(solo_superadmin)])

MEDIA_INLINE = ("image/jpeg", "image/png", "image/webp", "image/gif", "audio/ogg", "audio/mpeg", "audio/mp4", "audio/aac", "audio/amr", "video/mp4", "application/pdf")


def _base() -> str:
    return os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")


# ======================= WEBHOOK DE WHATSAPP (lo llama Meta) =======================
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


# ======================= WEBHOOK DE FACEBOOK E INSTAGRAM (lo llama Meta) =======================
@router_webhook.get("/meta")
def verificar_meta(request: Request):
    """Misma verificación que WhatsApp: usa el mismo 'verify token' de la misma app de Meta."""
    return verificar(request)


@router_webhook.post("/meta")
async def recibir_meta(request: Request):
    cuerpo = await request.body()
    if len(cuerpo) > 2_000_000:
        raise HTTPException(413, "Demasiado grande")
    if not wa.firma_valida(cuerpo, request.headers.get("x-hub-signature-256")):
        logger.warning("Aviso de Meta rechazado: firma inválida (falta el App Secret o es de otra app)")
        raise HTTPException(403, "Firma inválida")
    try:
        payload = json.loads(cuerpo)
    except ValueError:
        raise HTTPException(400, "JSON inválido")
    cuenta = await run_in_threadpool(ms.procesar, payload)
    logger.info("Aviso de Meta recibido: object=%s resultado=%s", payload.get("object"), cuenta)  # temporal, se quita al terminar las pruebas
    if cuenta["fallos"]:
        # Meta reintenta; los mensajes ya guardados no se duplican (índice único) ni los leads de anuncios (tabla de vistos)
        raise HTTPException(500, "No se pudo procesar todo el aviso")
    return {"ok": True}


# ======================= ENTRADA GENÉRICA (Zapier, Make, otro servidor tuyo) =======================
@router_webhook.post("/crm-entrada")
async def entrada_generica(request: Request):
    """Crea un lead desde un JSON. La clave va en la cabecera X-Webhook-Key. Llámala solo desde un servidor, nunca desde el navegador."""
    if not ms.clave_generica_valida(request.headers.get("x-webhook-key")):
        raise HTTPException(403, "Clave inválida")
    cuerpo = await request.body()
    if len(cuerpo) > 100_000:
        raise HTTPException(413, "Demasiado grande")
    try:
        datos = json.loads(cuerpo)
    except ValueError:
        raise HTTPException(400, "JSON inválido")
    if not isinstance(datos, dict):
        raise HTTPException(400, "Se esperaba un objeto JSON")
    try:
        lid = await run_in_threadpool(ms.captar_generico, datos)
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "id": lid}


# ======================= CONVERSACIÓN EN EL CRM =======================
class TextoIn(BaseModel):
    texto: str = Field(min_length=1, max_length=4000)
    canal: Literal["whatsapp", "facebook", "instagram"] = "whatsapp"


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


def _canales(l) -> list[dict]:
    """Qué canales tiene este lead y, en cada uno, hasta cuándo se le puede responder con texto libre."""
    def info(canal: str, disponible: bool, configurado: bool, ultimo) -> dict:
        return {
            "canal": canal, "disponible": disponible, "configurado": configurado,
            "ventana_hasta": (ultimo + wa.VENTANA).isoformat() if ultimo else None,
            "puede_texto_libre": wa.dentro_de_ventana(ultimo),
        }
    return [
        info("whatsapp", bool(l["telefono"]), wa.configurado(), l["wa_ultimo_entrante"]),
        info("facebook", bool(l["fb_psid"]), ms.configurado("facebook"), l["fb_ultimo_entrante"]),
        info("instagram", bool(l["ig_id"]), ms.configurado("instagram"), l["ig_ultimo_entrante"]),
    ]


@router.get("/leads/{lid}/mensajes")
def mensajes(lid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        filas = con.execute(
            "SELECT id, direccion, tipo, texto, (media_id IS NOT NULL) AS tiene_media, media_mime, media_nombre, estado, error, "
            "enviado_por, creado_en, canal FROM crm_mensajes WHERE lead_id=? ORDER BY creado_en DESC LIMIT 300", (lid,)).fetchall()
    finally:
        con.close()
    ultimo = l["wa_ultimo_entrante"]
    return {
        "configurado": wa.configurado(), "telefono": l["telefono"], "no_leidos": l["wa_no_leidos"],
        "ventana_hasta": (ultimo + wa.VENTANA).isoformat() if ultimo else None,
        "puede_texto_libre": wa.dentro_de_ventana(ultimo),
        "canales": _canales(l),
        "mensajes": [dict(f) for f in reversed(filas)],
    }


@router.post("/leads/{lid}/mensajes")
def enviar(lid: int, d: TextoIn, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        if d.canal == "whatsapp":
            if not l["telefono"]:
                raise HTTPException(400, "Este lead no tiene teléfono")
            if not wa.dentro_de_ventana(l["wa_ultimo_entrante"]):
                raise HTTPException(409, "Pasaron más de 24 horas desde el último mensaje del cliente. Envía una plantilla aprobada.")
            try:
                wamid = wa.enviar_texto(l["telefono"], d.texto.strip())
            except wa.ErrorWa as e:
                raise HTTPException(400, str(e))
            _guardar_salida(con, lid, wamid, "text", d.texto.strip(), ctx["u"]["usuario"])
        else:
            try:
                ms.enviar_a_lead(con, lid, d.canal, d.texto.strip(), ctx["u"]["usuario"])
            except wa.ErrorWa as e:
                raise HTTPException(400, str(e))
            con.execute("UPDATE crm_leads SET wa_no_leidos=0 WHERE id=?", (lid,))
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
        m = con.execute(
            "SELECT lead_id, media_id, media_mime, media_nombre, tipo, canal FROM crm_mensajes WHERE id=? AND media_id IS NOT NULL", (mid,)).fetchone()
        if not m:
            raise HTTPException(404, "Archivo no encontrado")
        _lead(con, m["lead_id"], ctx)  # el asesor solo ve archivos de sus propios leads
    finally:
        con.close()
    try:
        if m["canal"] in ("facebook", "instagram"):
            contenido, mime = ms.descargar_url(m["media_id"])  # en estos canales media_id guarda la URL temporal del archivo
        else:
            contenido, mime = wa.descargar_media(m["media_id"])
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    mime = (m["media_mime"] or mime).split(";")[0].strip().lower()
    nombre = re.sub(r"[^\w.\- ]", "_", m["media_nombre"] or f"{m['tipo']}-{mid}")[:80]
    if mime in MEDIA_INLINE:
        return Response(content=contenido, media_type=mime, headers={"Content-Disposition": f'inline; filename="{nombre}"'})
    # Cualquier otro tipo (HTML, SVG…) se entrega solo como descarga: nunca se ejecuta en el navegador
    return Response(content=contenido, media_type="application/octet-stream", headers={"Content-Disposition": f'attachment; filename="{nombre}"'})


# ======================= CONFIGURACIÓN DE WHATSAPP (solo superadmin) =======================
class ConfigIn(BaseModel):
    phone_id: str = Field(default="", max_length=30)
    waba_id: str = Field(default="", max_length=30)
    token: str = Field(default="", max_length=600)
    app_secret: str = Field(default="", max_length=100)
    version: str = Field(default="", max_length=10)


def _url_webhook() -> str:
    return _base() + "/api/webhooks/whatsapp"


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


# ======================= CONFIGURACIÓN DE FACEBOOK / INSTAGRAM (solo superadmin) =======================
class ConfigMetaIn(BaseModel):
    page_id: str = Field(default="", max_length=30)
    ig_id: str = Field(default="", max_length=30)
    token: str = Field(default="", max_length=800)
    ig_token: str = Field(default="", max_length=800)


@router_admin_meta.get("")
def meta_estado():
    c = ms.cfg()
    con = abrir_db()
    try:
        r = con.execute("SELECT valor FROM configuracion WHERE clave='meta_ultimo_evento'").fetchone()
    finally:
        con.close()
    return {
        "clave_ok": clave_ok(), "configurado": ms.configurado(), "page_id": c["page_id"], "ig_id": c["ig_id"],
        "token_guardado": bool(c["page_token"]), "ig_token_guardado": bool(c["ig_token"]),
        "secreto_guardado": bool(leer("wa_app_secret")),  # la firma de Meta se valida con el App Secret de la misma app
        "verify_token": leer("wa_verify_token"), "webhook_url": _base() + "/api/webhooks/meta",
        "entrada_url": _base() + "/api/webhooks/crm-entrada", "clave_entrada_guardada": bool(leer("crm_webhook_clave")),
        "ultimo_evento": r["valor"] if r else None,
    }


@router_admin_meta.put("")
def meta_guardar(d: ConfigMetaIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    page, ig, token, ig_token = d.page_id.strip(), d.ig_id.strip(), d.token.strip(), d.ig_token.strip()
    if page and not re.fullmatch(r"\d{5,30}", page):
        raise HTTPException(400, "El ID de la página de Facebook son solo números")
    if ig and not re.fullmatch(r"\d{5,30}", ig):
        raise HTTPException(400, "El ID de la cuenta de Instagram son solo números")
    if token and (len(token) < 40 or re.search(r"\s", token)):
        raise HTTPException(400, "El token de la página no parece completo. Cópialo de nuevo sin espacios.")
    if ig_token and (len(ig_token) < 40 or re.search(r"\s", ig_token)):
        raise HTTPException(400, "El token de Instagram no parece completo. Cópialo de nuevo sin espacios.")
    for clave, valor in (("meta_page_id", page), ("meta_ig_id", ig), ("meta_page_token", token), ("meta_ig_token", ig_token)):
        if valor:
            guardar(clave, valor)
    if not leer("wa_verify_token"):
        guardar("wa_verify_token", secrets.token_urlsafe(24))
    auditar("meta_config", yo["usuario"], ip_cliente(request), "credenciales de Facebook/Instagram actualizadas")
    return {"ok": True}


@router_admin_meta.post("/probar")
def meta_probar():
    try:
        i = ms.info_conexion()
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    partes = []
    if "pagina" in i:
        partes.append(f"Messenger: página {i['pagina'] or 'sin nombre'}")
    if "instagram" in i:
        partes.append(f"Instagram: @{i['instagram'] or 'sin usuario'}")
    if not partes:
        raise HTTPException(400, " · ".join(i["errores"]))
    detalle = "Conectado. " + " · ".join(partes) + "."
    if i["errores"]:
        detalle += " Con problemas: " + " · ".join(i["errores"])
    return {"ok": True, "detalle": detalle}


@router_admin_meta.post("/suscribir")
def meta_suscribir(request: Request, yo: dict = Depends(solo_superadmin)):
    try:
        ok = ms.suscribir_pagina()
    except wa.ErrorWa as e:
        raise HTTPException(400, str(e))
    auditar("meta_suscribir", yo["usuario"], ip_cliente(request), "página suscrita a mensajes y leads")
    return {"ok": ok, "detalle": "Tu página quedó suscrita a los mensajes de Messenger." if ok else "Meta no confirmó la suscripción."}


@router_admin_meta.post("/clave-entrada")
def meta_nueva_clave(request: Request, yo: dict = Depends(solo_superadmin)):
    """Genera la clave de la entrada genérica. Se muestra UNA vez; si se pierde, se genera otra (la anterior deja de servir)."""
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    clave = secrets.token_urlsafe(32)
    guardar("crm_webhook_clave", clave)
    auditar("crm_webhook_clave", yo["usuario"], ip_cliente(request), "clave de entrada regenerada")
    return {"clave": clave}