import base64
import json
import logging
import secrets as _secrets
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

from core.secretos import leer

logger = logging.getLogger("videollamadas")

ZOOM_TOKEN = "https://zoom.us/oauth/token"
ZOOM_API = "https://api.zoom.us/v2"
GOOGLE_TOKEN = "https://oauth2.googleapis.com/token"
GOOGLE_CAL = "https://www.googleapis.com/calendar/v3"
ZONA = "America/Lima"
_cache: dict[str, tuple[str, float]] = {}


class ErrorApi(Exception):
    """Error al hablar con Zoom o Google; el mensaje se puede mostrar al superadmin."""


def limpiar_cache() -> None:
    _cache.clear()


def http_json(metodo: str, url: str, cabeceras: dict | None = None, cuerpo: dict | None = None,
              form: dict | None = None) -> dict:
    datos = None
    cab = dict(cabeceras or {})
    if form is not None:
        datos = urllib.parse.urlencode(form).encode()
        cab["Content-Type"] = "application/x-www-form-urlencoded"
    elif cuerpo is not None:
        datos = json.dumps(cuerpo).encode()
        cab["Content-Type"] = "application/json"
    elif metodo in ("POST", "PUT", "PATCH"):
        datos = b""
    req = urllib.request.Request(url, data=datos, method=metodo, headers=cab)
    try:
        with urllib.request.urlopen(req, timeout=20) as r:
            crudo = r.read()
            return json.loads(crudo) if crudo else {}
    except urllib.error.HTTPError as e:
        msg = ""
        try:
            det = json.loads(e.read())
            err = det.get("error")
            msg = det.get("message") or det.get("error_description") or (err.get("message") if isinstance(err, dict) else err) or ""
        except Exception:
            pass
        raise ErrorApi(f"{e.code} {msg}".strip())
    except Exception as e:
        raise ErrorApi(str(e))


def _utc(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _minutos(inicio: datetime, fin: datetime) -> int:
    return max(1, int((fin - inicio).total_seconds() // 60))


# ======================= ZOOM =======================
def _zoom_token() -> str:
    t = _cache.get("zoom")
    if t and t[1] > time.time() + 60:
        return t[0]
    cuenta, cid, sec = leer("zoom_account_id"), leer("zoom_client_id"), leer("zoom_client_secret")
    if not (cuenta and cid and sec):
        raise ErrorApi("Zoom no está configurado")
    basico = base64.b64encode(f"{cid}:{sec}".encode()).decode()
    url = f"{ZOOM_TOKEN}?{urllib.parse.urlencode({'grant_type': 'account_credentials', 'account_id': cuenta})}"
    r = http_json("POST", url, cabeceras={"Authorization": f"Basic {basico}"})
    tok = r.get("access_token")
    if not tok:
        raise ErrorApi("Zoom no entregó el token de acceso")
    _cache["zoom"] = (tok, time.time() + int(r.get("expires_in", 3600)))
    return tok


def _zoom_cab() -> dict:
    return {"Authorization": f"Bearer {_zoom_token()}"}


def _zoom_crear(asesor: dict, titulo: str, inicio: datetime, fin: datetime) -> tuple[str, str]:
    host = (asesor.get("zoom_usuario") or "").strip() or leer("zoom_host") or "me"
    cuerpo = {
        "topic": titulo[:200], "type": 2, "start_time": _utc(inicio), "duration": _minutos(inicio, fin),
        "timezone": ZONA, "settings": {"join_before_host": True, "waiting_room": False, "mute_upon_entry": True},
    }
    r = http_json("POST", f"{ZOOM_API}/users/{urllib.parse.quote(host)}/meetings", _zoom_cab(), cuerpo)
    return str(r["id"]), r.get("join_url", "")


def _zoom_mover(ext: str, inicio: datetime, fin: datetime) -> None:
    http_json("PATCH", f"{ZOOM_API}/meetings/{ext}", _zoom_cab(),
              {"start_time": _utc(inicio), "duration": _minutos(inicio, fin), "timezone": ZONA})


def _zoom_borrar(ext: str) -> None:
    http_json("DELETE", f"{ZOOM_API}/meetings/{ext}", _zoom_cab())


def probar_zoom() -> str:
    _zoom_token()
    host = leer("zoom_host") or "me"
    try:
        u = http_json("GET", f"{ZOOM_API}/users/{urllib.parse.quote(host)}", _zoom_cab())
        return f"Conectado. Cuenta anfitriona: {u.get('email', host)}"
    except ErrorApi as e:
        return (f"Las credenciales son válidas, pero no se pudo leer la cuenta «{host}» ({e}). "
                "Revisa el correo de la cuenta anfitriona y los permisos de la app.")


# ======================= GOOGLE =======================
def _google_token() -> str:
    t = _cache.get("google")
    if t and t[1] > time.time() + 60:
        return t[0]
    cid, sec, rt = leer("google_client_id"), leer("google_client_secret"), leer("google_refresh_token")
    if not (cid and sec and rt):
        raise ErrorApi("Google no está conectado")
    r = http_json("POST", GOOGLE_TOKEN, form={
        "client_id": cid, "client_secret": sec, "refresh_token": rt, "grant_type": "refresh_token"})
    tok = r.get("access_token")
    if not tok:
        raise ErrorApi("Google no entregó el token de acceso")
    _cache["google"] = (tok, time.time() + int(r.get("expires_in", 3600)))
    return tok


def _google_cab() -> dict:
    return {"Authorization": f"Bearer {_google_token()}"}


def _horas(inicio: datetime, fin: datetime) -> dict:
    return {"start": {"dateTime": inicio.isoformat(), "timeZone": ZONA}, "end": {"dateTime": fin.isoformat(), "timeZone": ZONA}}


def _google_crear(titulo: str, detalle: str, inicio: datetime, fin: datetime, correos: list[str]) -> tuple[str, str]:
    cuerpo = {
        "summary": titulo, "description": detalle, **_horas(inicio, fin),
        "attendees": [{"email": c} for c in correos if c],
        "conferenceData": {"createRequest": {
            "requestId": _secrets.token_hex(8), "conferenceSolutionKey": {"type": "hangoutsMeet"}}},
    }
    url = f"{GOOGLE_CAL}/calendars/primary/events?conferenceDataVersion=1&sendUpdates=all"
    r = http_json("POST", url, _google_cab(), cuerpo)
    link = r.get("hangoutLink", "")
    if not link:  # Google a veces tarda un instante en generar la sala
        time.sleep(1.5)
        link = http_json("GET", f"{GOOGLE_CAL}/calendars/primary/events/{r['id']}", _google_cab()).get("hangoutLink", "")
    return r["id"], link


def _google_mover(ext: str, inicio: datetime, fin: datetime) -> None:
    http_json("PATCH", f"{GOOGLE_CAL}/calendars/primary/events/{ext}?sendUpdates=all", _google_cab(), _horas(inicio, fin))


def _google_borrar(ext: str) -> None:
    http_json("DELETE", f"{GOOGLE_CAL}/calendars/primary/events/{ext}?sendUpdates=all", _google_cab())


def probar_google() -> str:
    http_json("GET", f"{GOOGLE_CAL}/calendars/primary/events?maxResults=1", _google_cab())
    return f"Conectado al Google Calendar de {leer('google_email') or 'la cuenta conectada'}"


# ======================= API PÚBLICA DEL MÓDULO =======================
def modo(asesor: dict) -> str:
    """'zoom' o 'meet' si el asesor usa sala automática; 'fijo' en cualquier otro caso."""
    if asesor.get("modo_enlace") == "api" and asesor.get("plataforma") in ("zoom", "meet"):
        return asesor["plataforma"]
    return "fijo"


def _fijo(asesor: dict, aviso: str = "") -> dict:
    return {"proveedor": "fijo", "ext_id": "", "enlace": asesor.get("enlace") or "", "aviso": aviso}


def crear(asesor: dict, pedido: dict, inicio: datetime, fin: datetime) -> dict:
    """Siempre devuelve {proveedor, ext_id, enlace, aviso}. Si la API falla usa el enlace fijo del asesor."""
    m = modo(asesor)
    if m == "fijo":
        return _fijo(asesor)
    servicio, cliente = pedido.get("servicio_nombre", "Sesión"), pedido.get("nombre", "")
    titulo = f"{servicio} · {cliente}".strip(" ·")
    try:
        if m == "zoom":
            ext, link = _zoom_crear(asesor, titulo, inicio, fin)
        else:
            ext, link = _google_crear(titulo, f"Sesión de {servicio} con {cliente}.", inicio, fin,
                                      [asesor.get("correo", ""), pedido.get("correo", "")])
        if not link:
            raise ErrorApi("la plataforma no devolvió el enlace de la sala")
        return {"proveedor": m, "ext_id": ext, "enlace": link, "aviso": ""}
    except Exception as e:
        logger.error("No se pudo crear la sala %s: %s", m, e)
        return _fijo(asesor, f"No se pudo crear la sala automática ({e}). Se usó el enlace fijo del asesor.")


def cancelar(sesion: dict) -> None:
    prov, ext = sesion.get("proveedor", "fijo"), sesion.get("ext_id", "")
    if prov not in ("zoom", "meet") or not ext:
        return
    try:
        if prov == "zoom":
            _zoom_borrar(ext)
        else:
            _google_borrar(ext)
    except Exception as e:
        logger.error("No se pudo eliminar la sala %s %s: %s", prov, ext, e)


def mover(sesion: dict, asesor: dict, pedido: dict, inicio: datetime, fin: datetime, mismo_asesor: bool) -> dict:
    """Actualiza la sala existente; si cambió el asesor o la plataforma, elimina la anterior y crea otra."""
    prov, ext = sesion.get("proveedor", "fijo"), sesion.get("ext_id", "")
    if mismo_asesor and prov in ("zoom", "meet") and ext and prov == modo(asesor):
        try:
            if prov == "zoom":
                _zoom_mover(ext, inicio, fin)
            else:
                _google_mover(ext, inicio, fin)
            return {"proveedor": prov, "ext_id": ext, "enlace": sesion.get("enlace", ""), "aviso": ""}
        except Exception as e:
            logger.error("No se pudo mover la sala %s %s: %s", prov, ext, e)
    cancelar(sesion)
    return crear(asesor, pedido, inicio, fin)