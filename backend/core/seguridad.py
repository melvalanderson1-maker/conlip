import logging
import os
import time

import bcrypt
import jwt
from fastapi import HTTPException, Request

from core.db import abrir_db
from core.permisos import CATALOGO

logger = logging.getLogger("seguridad")

HORAS_TOKEN = 8
EMISOR = "coti-menor"
AUDIENCIA = "coti-menor-app"
EXTRA_SUPERADMIN = ["usuarios:gestionar", "plataforma:gestionar"]


def secreto() -> str:
    s = os.getenv("JWT_SECRET", "")
    if len(s) < 32:
        raise RuntimeError("Falta JWT_SECRET (mínimo 32 caracteres) en el .env")
    return s


# ---------------- Claves ----------------
def hash_clave(clave: str) -> str:
    b = clave.encode()
    if len(b) > 72:
        raise HTTPException(400, "La clave es demasiado larga (máximo 72 bytes)")
    return bcrypt.hashpw(b, bcrypt.gensalt(rounds=12)).decode()


def verificar_clave(clave: str, hash_: str) -> bool:
    try:
        return bcrypt.checkpw(clave.encode(), hash_.encode())
    except ValueError:
        return False


def validar_clave_fuerte(clave: str) -> None:
    if len(clave) < 10 or not any(c.isalpha() for c in clave) or not any(c.isdigit() for c in clave):
        raise HTTPException(400, "La clave debe tener mínimo 10 caracteres, con letras y números")


# ---------------- Utilidades ----------------
def ip_cliente(request: Request) -> str:
    # Detrás de Coolify/Traefik la IP real viene en X-Forwarded-For (activa TRUST_PROXY=1 en producción)
    if os.getenv("TRUST_PROXY") == "1":
        xff = request.headers.get("x-forwarded-for")
        if xff:
            return xff.split(",")[0].strip()
    return request.client.host if request.client else "?"


def auditar(accion: str, usuario: str | None = None, ip: str | None = None, detalle: str | None = None) -> None:
    try:
        con = abrir_db()
        try:
            con.execute(
                "INSERT INTO auditoria (usuario, accion, detalle, ip) VALUES (?,?,?,?)",
                (usuario, accion, (detalle or "")[:500], ip),
            )
        finally:
            con.close()
    except Exception as e:  # la auditoría nunca debe tumbar la petición
        logger.error(f"No se pudo auditar {accion}: {e}")


# ---------------- Token ----------------
def crear_token(u: dict) -> str:
    ahora = int(time.time())
    return jwt.encode(
        {"sub": str(u["id"]), "ver": u["token_ver"], "iss": EMISOR, "aud": AUDIENCIA,
         "iat": ahora, "exp": ahora + HORAS_TOKEN * 3600},
        secreto(), algorithm="HS256",
    )


# ---------------- Comprobante del segundo paso (2FA) ----------------
def crear_ticket_2fa(u: dict) -> str:
    """Comprobante de 5 minutos: se entrega al acertar la clave y se canjea por la sesión con el código de la app."""
    ahora = int(time.time())
    return jwt.encode(
        {"sub": str(u["id"]), "ver": u["token_ver"], "t": "2fa", "iss": EMISOR, "aud": AUDIENCIA,
         "iat": ahora, "exp": ahora + 300},
        secreto(), algorithm="HS256",
    )


def leer_ticket_2fa(ticket: str) -> int:
    """Valida el comprobante y devuelve el id del usuario."""
    try:
        datos = jwt.decode(
            ticket, secreto(), algorithms=["HS256"], audience=AUDIENCIA, issuer=EMISOR,
            options={"require": ["exp", "iat", "sub"]},
        )
        if datos.get("t") != "2fa":
            raise ValueError("no es un comprobante de 2FA")
        uid = int(datos["sub"])
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(401, "La verificación venció. Inicia sesión de nuevo.")
    if cargar_usuario(uid)["token_ver"] != datos.get("ver"):
        raise HTTPException(401, "La verificación venció. Inicia sesión de nuevo.")
    return uid


# ---------------- Permisos según la suscripción de la empresa ----------------
def suscripciones_activas(con, empresa_id: int | None) -> list[tuple[str, str]]:
    """[(codigo_modulo, modo)] de las suscripciones vigentes de la empresa."""
    if empresa_id is None:
        return []
    filas = con.execute(
        "SELECT pm.modulo AS codigo, s.modo FROM suscripciones s JOIN plan_modulos pm ON pm.plan_id = s.plan_id "
        "WHERE s.empresa_id=? AND s.estado='activa' AND s.vence_en > now()", (empresa_id,)).fetchall()
    return [(f["codigo"], f["modo"]) for f in filas]


def permisos_permitidos(rol: str, tipo_empresa: str, subs) -> set[str]:
    """Lo máximo que las suscripciones permiten a este rol."""
    out: set[str] = set()
    for codigo, modo in subs:
        out |= {f"{codigo}:ver", f"{codigo}:archivos"}
        if modo == "cotizar" and (rol in ("admin", "cotizador") or tipo_empresa == "persona"):
            out.add(f"{codigo}:cotizar")
    return out


def calcular_permisos(rol: str, tipo_empresa: str | None, guardados: list[str], subs) -> list[str]:
    """Permisos efectivos = suscripción vigente ∩ lo que el admin marcó (según el rol)."""
    if rol == "superadmin":  # ve todo, pero no cotiza (no pertenece a ninguna empresa)
        return [p for p in CATALOGO if not p.endswith(":cotizar")] + EXTRA_SUPERADMIN
    if rol == "asesor":  # no pertenece a una empresa: solo entra a su propia agenda
        return ["agenda:asesor"]
    permitidos = permisos_permitidos(rol, tipo_empresa or "", subs)
    if rol == "admin":
        return sorted(permitidos) + ["usuarios:gestionar"]
    if tipo_empresa == "persona":
        return sorted(permitidos)
    return sorted(permitidos & set(guardados))


def cargar_usuario(uid: int) -> dict:
    con = abrir_db()
    try:
        u = con.execute(
            "SELECT u.id, u.usuario, u.nombre, u.rol, u.activo, u.permisos, u.token_ver, u.totp_activo, u.empresa_id, "
            "e.nombre AS empresa_nombre, e.tipo AS empresa_tipo, e.activo AS empresa_activa "
            "FROM usuarios u LEFT JOIN empresas e ON e.id = u.empresa_id WHERE u.id=?", (uid,)).fetchone()
        if not u or not u["activo"]:
            raise HTTPException(401, "Sesión inválida o vencida")
        d = dict(u)
        subs: list[tuple[str, str]] = []
        if d["rol"] not in ("superadmin", "asesor"):
            if d["empresa_id"] is None or not d["empresa_activa"]:
                raise HTTPException(401, "Cuenta suspendida. Contacta a soporte.")
            subs = suscripciones_activas(con, d["empresa_id"])
    finally:
        con.close()
    guardados = list(d["permisos"] or [])
    d["permisos_guardados"] = guardados
    d["permisos"] = calcular_permisos(d["rol"], d["empresa_tipo"], guardados, subs)
    return d


def usuario_desde_token(token: str) -> dict:
    """Valida un JWT y devuelve el usuario vigente (se usa en HTTP y en WebSocket)."""
    try:
        datos = jwt.decode(
            token, secreto(), algorithms=["HS256"], audience=AUDIENCIA, issuer=EMISOR,
            options={"require": ["exp", "iat", "sub"]},
        )
        uid = int(datos["sub"])
    except (jwt.PyJWTError, ValueError):
        raise HTTPException(401, "Sesión inválida o vencida")
    d = cargar_usuario(uid)
    if datos.get("t") or d["token_ver"] != datos.get("ver"):  # un comprobante de 2FA jamás vale como sesión
        raise HTTPException(401, "Sesión inválida o vencida")
    return d


def _usuario(request: Request, permitir_query: bool) -> dict:
    auth = request.headers.get("authorization", "")
    token = None
    if auth.lower().startswith("bearer "):
        token = auth[7:].strip()
    elif permitir_query:  # solo para abrir archivos en iframe/pestaña
        token = request.query_params.get("token")
    if not token:
        raise HTTPException(401, "No autenticado")
    from core.doblefactor import roles_exigidos
    u = usuario_desde_token(token)
    # Si el rol exige 2FA y aún no la activó, solo puede usar /api/auth (para activarla). Todo lo demás se rechaza.
    if u["rol"] in roles_exigidos() and not u["totp_activo"] and not request.url.path.startswith("/api/auth"):
        raise HTTPException(403, "Debes activar la verificación en dos pasos para continuar")
    return u


# ---------------- Dependencias de FastAPI ----------------
def usuario_actual(request: Request) -> dict:
    return _usuario(request, False)


def solo_admin(request: Request) -> dict:
    """Administrador de una empresa."""
    u = _usuario(request, False)
    if u["rol"] != "admin":
        auditar("acceso_denegado", u["usuario"], ip_cliente(request), f"{request.method} {request.url.path}")
        raise HTTPException(403, "Solo el administrador puede hacer esto")
    return u


def solo_superadmin(request: Request) -> dict:
    u = _usuario(request, False)
    if u["rol"] != "superadmin":
        auditar("acceso_denegado", u["usuario"], ip_cliente(request), f"{request.method} {request.url.path}")
        raise HTTPException(403, "Solo el superadmin puede hacer esto")
    return u


def solo_asesor(request: Request) -> dict:
    """Asesor con acceso a la plataforma: ve solo su agenda y sus clientes."""
    u = _usuario(request, False)
    if u["rol"] != "asesor":
        auditar("acceso_denegado", u["usuario"], ip_cliente(request), f"{request.method} {request.url.path}")
        raise HTTPException(403, "Solo un asesor puede hacer esto")
    return u


def solo_titular(request: Request) -> dict:
    """Titular de la cuenta: admin de una empresa o persona natural dueña de su cuenta."""
    u = _usuario(request, False)
    es_titular = (
        u["rol"] != "superadmin" and u.get("empresa_id") is not None
        and (u["rol"] == "admin" or u.get("empresa_tipo") == "persona")
    )
    if not es_titular:
        auditar("acceso_denegado", u["usuario"], ip_cliente(request), f"{request.method} {request.url.path}")
        raise HTTPException(403, "Solo el titular de la cuenta puede hacer esto")
    return u


def _fabrica(permitir_query: bool):
    def requiere(*requeridos: str):
        def dependencia(request: Request) -> dict:
            u = _usuario(request, permitir_query)
            if not set(requeridos) <= set(u["permisos"]):
                auditar("acceso_denegado", u["usuario"], ip_cliente(request),
                        f"{request.method} {request.url.path} requiere {','.join(requeridos)}")
                raise HTTPException(403, "No tienes permiso para esto")
            return u
        return dependencia
    return requiere


requiere_permiso = _fabrica(False)          # solo header Authorization
requiere_permiso_archivo = _fabrica(True)   # también ?token= (solo endpoint de archivos)


# ---------------- Lo que ve el frontend ----------------
def usuario_publico(u: dict) -> dict:
    empresa = None
    if u.get("empresa_id") is not None:
        empresa = {"id": u["empresa_id"], "nombre": u["empresa_nombre"], "tipo": u["empresa_tipo"]}
    from core.doblefactor import roles_exigidos
    dos_pasos = bool(u.get("totp_activo"))
    return {"id": u["id"], "usuario": u["usuario"], "nombre": u["nombre"], "rol": u["rol"],
            "permisos": u["permisos"], "empresa": empresa, "dos_pasos": dos_pasos,
            "debe_activar_2fa": u["rol"] in roles_exigidos() and not dos_pasos}