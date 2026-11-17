"""Conexión de canales con Meta: varios números de WhatsApp, páginas de Facebook y cuentas de Instagram."""
import json
import logging
import os
import secrets
import time
import urllib.error
import urllib.parse
import urllib.request

import jwt
from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from core import canales as cn
from core import meta_social as ms
from core import whatsapp as wa
from core.db import abrir_db
from core.secretos import cifrar, clave_ok, descifrar, guardar, leer
from core.seguridad import auditar, ip_cliente, secreto as jwt_secreto, solo_superadmin

logger = logging.getLogger("canales_crm")

router = APIRouter(prefix="/api/integraciones/canales", tags=["canales"], dependencies=[Depends(solo_superadmin)])
router_callback = APIRouter(prefix="/api/integraciones/oauth", tags=["canales-oauth"])

SCOPES = (
    "pages_show_list,pages_messaging,pages_manage_metadata,pages_read_engagement,instagram_basic,"
    "instagram_manage_messages,leads_retrieval,whatsapp_business_management,whatsapp_business_messaging,business_management"
)
MINUTOS_SESION = 30


class AppIn(BaseModel):
    app_id: str = Field(default="", max_length=30)
    config_id: str = Field(default="", max_length=30)


class TokenWaIn(BaseModel):
    waba_id: str = Field(pattern=r"^\d{5,30}$")
    token: str = Field(min_length=40, max_length=800)


class NumeroSel(BaseModel):
    id: str = Field(pattern=r"^\d{5,30}$")
    waba_id: str = Field(pattern=r"^\d{5,30}$")


class ConectarIn(BaseModel):
    paginas: list[str] = Field(default_factory=list, max_length=50)
    instagram: list[str] = Field(default_factory=list, max_length=50)  # ids de cuentas de Instagram (de páginas elegidas)
    numeros: list[NumeroSel] = Field(default_factory=list, max_length=50)


class RenombrarIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=60)


# ---------------- Utilidades ----------------
def _base() -> str:
    return os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/")


def _front() -> str:
    return os.getenv("FRONTEND_URL", "http://localhost:4200").rstrip("/")


def _version() -> str:
    return leer("wa_version") or wa.VERSION_BASE


def _redirect_uri() -> str:
    return _base() + "/api/integraciones/oauth/callback"


def _graph(token: str | None, ruta: str, consulta: dict | None = None, metodo: str = "GET") -> dict:
    url = f"{wa.GRAPH}/{_version()}{ruta}"
    if consulta:
        url += "?" + urllib.parse.urlencode(consulta)
    cab = {"Authorization": f"Bearer {token}"} if token else {}
    req = urllib.request.Request(url, data=b"" if metodo == "POST" else None, method=metodo, headers=cab)
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
        raise HTTPException(400, wa.traducir_error(err.get("code", 0), err.get("message", "")))
    except Exception as e:
        logger.error("No se pudo contactar a Meta: %s", e)
        raise HTTPException(400, "No se pudo contactar a Meta. Inténtalo de nuevo.")


def _firmar_estado(usuario: str) -> str:
    return jwt.encode({"u": usuario, "t": "oauth-canales", "exp": int(time.time()) + 600}, jwt_secreto(), algorithm="HS256")


def _leer_estado(estado: str) -> str:
    d = jwt.decode(estado, jwt_secreto(), algorithms=["HS256"])
    if d.get("t") != "oauth-canales":
        raise ValueError("estado inválido")
    return str(d["u"])


def _canjear(code: str) -> str:
    app_id, app_secret = leer("meta_app_id"), leer("wa_app_secret")
    if not (app_id and app_secret):
        raise HTTPException(400, "Falta el App ID o el App Secret de tu app de Meta.")
    r = _graph(None, "/oauth/access_token", {
        "client_id": app_id, "client_secret": app_secret, "redirect_uri": _redirect_uri(), "code": code})
    token = r.get("access_token")
    if not token:
        raise HTTPException(400, "Meta no entregó el permiso. Inténtalo de nuevo.")
    try:  # token de larga duración (las páginas que salgan de él no vencen)
        largo = _graph(None, "/oauth/access_token", {
            "grant_type": "fb_exchange_token", "client_id": app_id, "client_secret": app_secret, "fb_exchange_token": token})
        token = largo.get("access_token") or token
    except HTTPException:
        pass
    return token


def _nueva_sesion(usuario: str, token: str, tipo: str, waba_id: str) -> str:
    sid = secrets.token_urlsafe(24)
    con = abrir_db()
    try:
        con.execute(f"DELETE FROM crm_oauth_sesiones WHERE creado_en < now() - interval '{MINUTOS_SESION} minutes'")
        con.execute("INSERT INTO crm_oauth_sesiones (id, usuario, tipo, waba_id, token) VALUES (?,?,?,?,?)",
                    (sid, usuario, tipo, waba_id, cifrar(token)))
    finally:
        con.close()
    return sid


def _sesion(con, sid: str, yo: dict):
    s = con.execute(
        f"SELECT usuario, tipo, waba_id, token FROM crm_oauth_sesiones WHERE id=? AND creado_en > now() - interval '{MINUTOS_SESION} minutes'",
        (sid,)).fetchone()
    if not s:
        raise HTTPException(404, "La sesión de conexión venció. Vuelve a empezar.")
    if s["usuario"] != yo["usuario"]:
        raise HTTPException(403, "Esta conexión la inició otro usuario.")
    return s


def _descubrir(token: str, waba_ids: list[str] | None, con_paginas: bool) -> dict:
    """Lista lo que este permiso deja conectar: páginas (con su Instagram) y números de WhatsApp."""
    app_id, app_secret = leer("meta_app_id"), leer("wa_app_secret")
    paginas: list[dict] = []
    numeros: list[dict] = []
    avisos: list[str] = []
    if con_paginas:
        try:
            for p in _graph(token, "/me/accounts", {"fields": "id,name,instagram_business_account{id,username}", "limit": 100}).get("data", []):
                ig = p.get("instagram_business_account") or None
                paginas.append({"id": p["id"], "nombre": p.get("name", ""),
                                "ig": {"id": ig["id"], "usuario": ig.get("username", "")} if ig else None})
        except HTTPException as e:
            avisos.append(f"Páginas de Facebook: {e.detail}")
    wabas = waba_ids
    if wabas is None:
        wabas = []
        if app_id and app_secret:
            try:
                d = _graph(f"{app_id}|{app_secret}", "/debug_token", {"input_token": token}).get("data", {})
                for g in d.get("granular_scopes", []):
                    if g.get("scope") in ("whatsapp_business_management", "whatsapp_business_messaging"):
                        wabas += [str(x) for x in g.get("target_ids", [])]
            except HTTPException as e:
                avisos.append(f"Cuentas de WhatsApp: {e.detail}")
        wabas = list(dict.fromkeys(wabas))
    for w in wabas:
        try:
            nombre_waba = _graph(token, f"/{w}", {"fields": "name"}).get("name", "")
            for n in _graph(token, f"/{w}/phone_numbers", {"fields": "id,display_phone_number,verified_name,quality_rating", "limit": 50}).get("data", []):
                numeros.append({"id": n["id"], "waba_id": w, "waba": nombre_waba, "numero": n.get("display_phone_number", ""),
                                "nombre": n.get("verified_name", ""), "calidad": n.get("quality_rating", "")})
        except HTTPException as e:
            avisos.append(f"Cuenta de WhatsApp {w}: {e.detail}")
    return {"paginas": paginas, "numeros": numeros, "avisos": avisos}


# ---------------- Estado y configuración de la app ----------------
@router.get("")
def listar():
    con = abrir_db()
    try:
        cn.asegurar_legado(con)
        filas = con.execute(
            "SELECT id, tipo, nombre, ext_id, waba_id, page_id, detalle, estado, error, legado, creado_en "
            "FROM crm_canales WHERE estado <> 'desconectado' ORDER BY tipo, legado DESC, id").fetchall()
    finally:
        con.close()
    return {
        "app_id": leer("meta_app_id"), "config_id": leer("meta_login_config_id"),
        "app_secret_guardado": bool(leer("wa_app_secret")), "clave_ok": clave_ok(), "redirect_uri": _redirect_uri(),
        "canales": [{**dict(f), "legado": bool(f["legado"])} for f in filas],
    }


@router.put("/app")
def guardar_app(d: AppIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    app_id, config_id = d.app_id.strip(), d.config_id.strip()
    if app_id and not app_id.isdigit():
        raise HTTPException(400, "El App ID son solo números (lo ves en Meta → Configuración → Básica).")
    if config_id and not config_id.isdigit():
        raise HTTPException(400, "El Configuration ID son solo números.")
    if app_id:
        guardar("meta_app_id", app_id)
    if config_id:
        guardar("meta_login_config_id", config_id)
    auditar("canales_app", yo["usuario"], ip_cliente(request), "datos de la app de Meta actualizados")
    return {"ok": True}


# ---------------- Conexión con Meta (OAuth) ----------------
@router.post("/oauth/iniciar")
def iniciar(request: Request, yo: dict = Depends(solo_superadmin)):
    app_id = leer("meta_app_id")
    if not app_id:
        raise HTTPException(400, "Primero guarda el App ID de tu app de Meta.")
    if not leer("wa_app_secret"):
        raise HTTPException(400, "Falta el App Secret: guárdalo en CRM → Conexiones → tarjeta de WhatsApp.")
    p = {"client_id": app_id, "redirect_uri": _redirect_uri(), "state": _firmar_estado(yo["usuario"]), "response_type": "code"}
    config_id = leer("meta_login_config_id")
    if config_id:  # Facebook Login for Business: los permisos vienen de la configuración
        p["config_id"] = config_id
        p["override_default_response_type"] = "true"
    else:
        p["scope"] = SCOPES
    auditar("canales_oauth", yo["usuario"], ip_cliente(request), "inicio de conexión con Meta")
    return {"url": f"https://www.facebook.com/{_version()}/dialog/oauth?" + urllib.parse.urlencode(p)}


@router_callback.get("/callback")
def callback(code: str = "", state: str = "", error: str = "", error_description: str = ""):
    """Meta devuelve aquí al usuario. No hay sesión: el «state» firmado dice quién inició la conexión."""
    destino = _front() + "/crm-admin"

    def volver(ok: bool, extra: str) -> RedirectResponse:
        return RedirectResponse(f"{destino}?canales={'ok' if ok else 'error'}&{extra}")

    if error or not code:
        return volver(False, "msg=" + urllib.parse.quote(error_description or "Se canceló la conexión con Meta"))
    try:
        usuario = _leer_estado(state)
    except Exception:
        return volver(False, "msg=" + urllib.parse.quote("El enlace de conexión venció. Inténtalo de nuevo."))
    try:
        sid = _nueva_sesion(usuario, _canjear(code), "meta", "")
    except HTTPException as e:
        return volver(False, "msg=" + urllib.parse.quote(str(e.detail)))
    return volver(True, "sid=" + sid)


# ---------------- WhatsApp con token permanente (usuario del sistema) ----------------
@router.post("/token-whatsapp")
def token_whatsapp(d: TokenWaIn, request: Request, yo: dict = Depends(solo_superadmin)):
    """Pegas el token permanente de tu usuario del sistema y el ID de la cuenta: se listan todos sus números."""
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    token = d.token.strip()
    _graph(token, f"/{d.waba_id}", {"fields": "name"})  # comprueba que el token ve esa cuenta
    sid = _nueva_sesion(yo["usuario"], token, "whatsapp", d.waba_id)
    auditar("canales_token_wa", yo["usuario"], ip_cliente(request), f"cuenta {d.waba_id}")
    return {"sid": sid}


# ---------------- Elegir y conectar ----------------
@router.get("/sesiones/{sid}")
def activos(sid: str, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        s = _sesion(con, sid, yo)
        token = descifrar(s["token"])
        tipo, waba = s["tipo"], s["waba_id"]
        conectados = {(r["tipo"], r["ext_id"]) for r in con.execute(
            "SELECT tipo, ext_id FROM crm_canales WHERE estado <> 'desconectado'").fetchall()}
    finally:
        con.close()
    d = _descubrir(token, [waba] if tipo == "whatsapp" else None, con_paginas=(tipo != "whatsapp"))
    for p in d["paginas"]:
        p["conectada"] = ("facebook", p["id"]) in conectados
        p["ig_conectada"] = bool(p["ig"]) and ("instagram", p["ig"]["id"]) in conectados
    for n in d["numeros"]:
        n["conectada"] = ("whatsapp", n["id"]) in conectados
    return d


@router.post("/sesiones/{sid}/conectar")
def conectar(sid: str, d: ConectarIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    if not (d.paginas or d.numeros):
        raise HTTPException(400, "Elige al menos una página o un número.")
    con = abrir_db()
    try:
        s = _sesion(con, sid, yo)
        token = descifrar(s["token"])
    finally:
        con.close()
    conectados: list[str] = []
    avisos: list[str] = []

    if d.paginas:
        cuentas = {p["id"]: p for p in _graph(token, "/me/accounts", {
            "fields": "id,name,access_token,instagram_business_account{id,username}", "limit": 100}).get("data", [])}
        for pid in d.paginas:
            p = cuentas.get(pid)
            if not p or not p.get("access_token"):
                avisos.append(f"No se pudo leer la página {pid}: revisa que diste el permiso sobre ella.")
                continue
            ptoken, nombre = p["access_token"], p.get("name") or f"Página {pid}"
            try:  # sin esta suscripción Meta no avisa de los mensajes ni de los formularios de anuncios
                _graph(ptoken, f"/{pid}/subscribed_apps", {"subscribed_fields": "messages,leadgen"}, "POST")
            except HTTPException as e:
                avisos.append(f"{nombre}: no se pudo suscribir a los avisos ({e.detail})")
            ig = p.get("instagram_business_account") or {}
            con = abrir_db()
            try:
                cn.guardar(con, "facebook", nombre, pid, "", "", "Messenger", ptoken, yo["usuario"])
                conectados.append(f"Messenger: {nombre}")
                if ig.get("id") and ig["id"] in d.instagram:
                    usuario_ig = ig.get("username", "")
                    cn.guardar(con, "instagram", f"Instagram {usuario_ig or ig['id']}", ig["id"], "", pid, usuario_ig, ptoken, yo["usuario"])
                    conectados.append(f"Instagram: {usuario_ig or ig['id']}")
            finally:
                con.close()

    for n in d.numeros:
        try:
            info = _graph(token, f"/{n.id}", {"fields": "display_phone_number,verified_name"})
            try:
                _graph(token, f"/{n.waba_id}/subscribed_apps", None, "POST")
            except HTTPException as e:
                avisos.append(f"Número {n.id}: no se pudo suscribir a los avisos ({e.detail})")
            nombre = info.get("verified_name") or f"WhatsApp {n.id}"
            con = abrir_db()
            try:
                cn.guardar(con, "whatsapp", nombre, n.id, n.waba_id, "", info.get("display_phone_number", ""), token, yo["usuario"])
            finally:
                con.close()
            conectados.append(f"WhatsApp: {nombre} ({info.get('display_phone_number', '')})")
        except HTTPException as e:
            avisos.append(f"Número {n.id}: {e.detail}")

    if conectados:
        con = abrir_db()
        try:
            con.execute("DELETE FROM crm_oauth_sesiones WHERE id=?", (sid,))
        finally:
            con.close()
    auditar("canales_conectados", yo["usuario"], ip_cliente(request), "; ".join(conectados)[:400] or "ninguno")
    return {"conectados": conectados, "avisos": avisos}


# ---------------- Gestión de cada canal ----------------
@router.post("/{cid}/probar")
def probar(cid: int):
    con = abrir_db()
    try:
        c = cn.obtener(con, cid)
    finally:
        con.close()
    if not c or c["estado"] == "desconectado":
        raise HTTPException(404, "Canal no encontrado")
    try:
        with cn.usando(cid):
            if c["tipo"] == "whatsapp":
                i = wa.info_numero()
                detalle = f"Conectado: {i.get('verified_name', '')} ({i.get('display_phone_number', '')}). Calidad: {i.get('quality_rating', 'sin dato')}."
            else:
                i = ms.info_conexion()
                if "pagina" not in i and "instagram" not in i:
                    raise wa.ErrorWa(" · ".join(i["errores"]) or "No se pudo comprobar este canal.")
                partes = []
                if "pagina" in i:
                    partes.append(f"página {i['pagina'] or 'sin nombre'}")
                if "instagram" in i:
                    partes.append(f"Instagram {i['instagram'] or 'sin usuario'}")
                detalle = "Conectado: " + " · ".join(partes) + "."
    except wa.ErrorWa as e:
        cn.marcar(cid, "error", str(e))
        raise HTTPException(400, str(e))
    cn.marcar(cid, "activo", "")
    return {"ok": True, "detalle": detalle}


@router.patch("/{cid}")
def renombrar(cid: int, d: RenombrarIn):
    con = abrir_db()
    try:
        r = con.execute("UPDATE crm_canales SET nombre=? WHERE id=? RETURNING id", (d.nombre.strip(), cid)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Canal no encontrado")
    return {"ok": True}


@router.delete("/{cid}")
def desconectar(cid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    """El canal deja de recibir y de enviar. Su historial de mensajes se conserva."""
    con = abrir_db()
    try:
        c = cn.obtener(con, cid)
        if not c or c["estado"] == "desconectado":
            raise HTTPException(404, "Canal no encontrado")
        if c["legado"]:
            raise HTTPException(400, "Este canal viene de CRM → Conexiones. Para cambiarlo, actualiza sus credenciales allí.")
        con.execute("UPDATE crm_canales SET estado='desconectado', token='' WHERE id=?", (cid,))
    finally:
        con.close()
    auditar("canal_desconectado", yo["usuario"], ip_cliente(request), f"{c['tipo']} {c['nombre']}")
    return {"ok": True}