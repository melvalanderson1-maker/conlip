import hashlib
import hmac
import os
import time
import urllib.parse

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import RedirectResponse
from pydantic import BaseModel, Field

from core import videollamadas as vc
from core.secretos import borrar, clave_base, clave_ok, guardar, leer
from core.seguridad import auditar, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/integraciones", tags=["integraciones"], dependencies=[Depends(solo_superadmin)])
router_callback = APIRouter(prefix="/api/integraciones", tags=["integraciones"])  # la usa Google al volver

GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth"
GOOGLE_SCOPES = "https://www.googleapis.com/auth/calendar.events openid email"


def _mask(v: str) -> str:
    if not v:
        return ""
    return v if len(v) <= 6 else f"{v[:3]}•••{v[-3:]}"


def _exigir_clave() -> None:
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en backend/.env. Agrégala y reinicia el servidor.")


def _redirect_uri() -> str:
    return os.getenv("BACKEND_URL", "http://localhost:8000").rstrip("/") + "/api/integraciones/google/callback"


def _firma(base: str) -> str:
    return hmac.new(clave_base().encode(), f"gstate|{base}".encode(), hashlib.sha256).hexdigest()[:32]


def _estado_firmado(uid: int) -> str:
    base = f"{uid}.{int(time.time()) + 600}"
    return f"{base}.{_firma(base)}"


def _verificar_estado(estado: str) -> None:
    try:
        uid, exp, firma = estado.split(".")
    except ValueError:
        raise vc.ErrorApi("La solicitud de conexión no es válida. Intenta de nuevo.")
    if not hmac.compare_digest(firma, _firma(f"{uid}.{exp}")) or int(exp) < time.time():
        raise vc.ErrorApi("La solicitud de conexión venció. Intenta de nuevo.")


class ZoomIn(BaseModel):
    account_id: str = Field(default="", max_length=100)
    client_id: str = Field(default="", max_length=100)
    client_secret: str = Field(default="", max_length=200)
    host: str = Field(default="", max_length=160)


class GoogleIn(BaseModel):
    client_id: str = Field(default="", max_length=200)
    client_secret: str = Field(default="", max_length=200)


@router.get("")
def estado():
    return {
        "clave_ok": clave_ok(),
        "zoom": {
            "configurado": bool(leer("zoom_account_id") and leer("zoom_client_id") and leer("zoom_client_secret")),
            "account_id": _mask(leer("zoom_account_id")), "client_id": _mask(leer("zoom_client_id")),
            "host": leer("zoom_host"),
        },
        "google": {
            "configurado": bool(leer("google_client_id") and leer("google_client_secret")),
            "conectado": bool(leer("google_refresh_token")), "client_id": _mask(leer("google_client_id")),
            "email": leer("google_email"), "redirect_uri": _redirect_uri(),
        },
    }


# ---------------- Zoom ----------------
@router.put("/zoom")
def guardar_zoom(d: ZoomIn, request: Request, yo: dict = Depends(solo_superadmin)):
    _exigir_clave()
    for clave, valor in (("zoom_account_id", d.account_id), ("zoom_client_id", d.client_id), ("zoom_client_secret", d.client_secret)):
        if valor.strip():
            guardar(clave, valor.strip())
    guardar("zoom_host", d.host.strip())
    vc.limpiar_cache()
    if not (leer("zoom_account_id") and leer("zoom_client_id") and leer("zoom_client_secret")):
        raise HTTPException(400, "Faltan datos: completa Account ID, Client ID y Client Secret.")
    auditar("integracion_zoom", yo["usuario"], ip_cliente(request), "credenciales actualizadas")
    return {"ok": True}


@router.post("/zoom/probar")
def probar_zoom():
    try:
        return {"ok": True, "detalle": vc.probar_zoom()}
    except vc.ErrorApi as e:
        raise HTTPException(400, f"No se pudo conectar con Zoom: {e}")


# ---------------- Google ----------------
@router.put("/google")
def guardar_google(d: GoogleIn, request: Request, yo: dict = Depends(solo_superadmin)):
    _exigir_clave()
    for clave, valor in (("google_client_id", d.client_id), ("google_client_secret", d.client_secret)):
        if valor.strip():
            guardar(clave, valor.strip())
    vc.limpiar_cache()
    if not (leer("google_client_id") and leer("google_client_secret")):
        raise HTTPException(400, "Faltan datos: completa Client ID y Client Secret.")
    auditar("integracion_google", yo["usuario"], ip_cliente(request), "credenciales actualizadas")
    return {"ok": True}


@router.get("/google/autorizar")
def autorizar_google(yo: dict = Depends(solo_superadmin)):
    _exigir_clave()
    cid = leer("google_client_id")
    if not (cid and leer("google_client_secret")):
        raise HTTPException(400, "Primero guarda el Client ID y el Client Secret de Google.")
    params = {
        "client_id": cid, "redirect_uri": _redirect_uri(), "response_type": "code", "scope": GOOGLE_SCOPES,
        "access_type": "offline", "prompt": "consent", "state": _estado_firmado(yo["id"]),
    }
    return {"url": f"{GOOGLE_AUTH}?{urllib.parse.urlencode(params)}"}


@router_callback.get("/google/callback")
def google_callback(code: str = "", state: str = "", error: str = ""):
    destino = os.getenv("FRONTEND_URL", "http://localhost:4200").rstrip("/") + "/agenda-admin"
    try:
        if error:
            raise vc.ErrorApi(f"Google respondió: {error}")
        _verificar_estado(state)
        r = vc.http_json("POST", vc.GOOGLE_TOKEN, form={
            "code": code, "client_id": leer("google_client_id"), "client_secret": leer("google_client_secret"),
            "redirect_uri": _redirect_uri(), "grant_type": "authorization_code"})
        refresco = r.get("refresh_token")
        if not refresco:
            raise vc.ErrorApi("Google no entregó el permiso permanente. Vuelve a conectar y acepta todos los permisos.")
        guardar("google_refresh_token", refresco)
        try:
            u = vc.http_json("GET", "https://www.googleapis.com/oauth2/v2/userinfo",
                             {"Authorization": f"Bearer {r['access_token']}"})
            guardar("google_email", u.get("email", ""))
        except vc.ErrorApi:
            pass
        vc.limpiar_cache()
        return RedirectResponse(f"{destino}?google=ok")
    except Exception as e:
        return RedirectResponse(f"{destino}?google=error&msg={urllib.parse.quote(str(e)[:200])}")


@router.post("/google/probar")
def probar_google():
    try:
        return {"ok": True, "detalle": vc.probar_google()}
    except vc.ErrorApi as e:
        raise HTTPException(400, f"No se pudo conectar con Google: {e}")


@router.delete("/google")
def desconectar_google(request: Request, yo: dict = Depends(solo_superadmin)):
    borrar("google_refresh_token", "google_email")
    vc.limpiar_cache()
    auditar("integracion_google", yo["usuario"], ip_cliente(request), "cuenta desconectada")
    return {"ok": True}