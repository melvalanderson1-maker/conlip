from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.permisos import ACCIONES, MODULOS, POR_DEFECTO, ROLES_ASIGNABLES, normalizar
from core.seguridad import (
    auditar, hash_clave, ip_cliente, permisos_permitidos, solo_admin,
    suscripciones_activas, validar_clave_fuerte,
)

router = APIRouter(prefix="/api/usuarios", tags=["usuarios"])

# Cupo vigente = cupo base + usuarios extra mientras no hayan vencido
CUPO_EFECTIVO = "(cupo_usuarios + CASE WHEN extras_vence_en IS NOT NULL AND extras_vence_en > now() THEN usuarios_extra ELSE 0 END)"


def _limite(con, yo: dict, rol: str) -> set[str]:
    """Lo máximo que las suscripciones de la empresa permiten a ese rol."""
    return permisos_permitidos(rol, yo["empresa_tipo"], suscripciones_activas(con, yo["empresa_id"]))


def _usados(con, eid: int) -> int:
    return con.execute("SELECT COUNT(*) FROM usuarios WHERE empresa_id=? AND activo=1", (eid,)).fetchone()[0]


def _cupo(con, eid: int) -> int:
    return con.execute(f"SELECT {CUPO_EFECTIVO} FROM empresas WHERE id=?", (eid,)).fetchone()[0]


class UsuarioIn(BaseModel):
    usuario: str = Field(min_length=3, max_length=60, pattern=r"^[A-Za-z0-9._-]+$")
    nombre: str = Field(default="", max_length=120)
    clave: str = Field(min_length=10, max_length=72)
    rol: str = "visualizador"
    permisos: list[str] | None = None


class UsuarioPatch(BaseModel):
    nombre: str | None = Field(default=None, max_length=120)
    rol: str | None = None
    activo: bool | None = None
    clave: str | None = Field(default=None, min_length=10, max_length=72)
    permisos: list[str] | None = None


@router.get("/catalogo")
def catalogo(yo: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        lim_c = _limite(con, yo, "cotizador")
        lim_v = _limite(con, yo, "visualizador")
        eid = yo["empresa_id"]
        return {
            # solo los módulos que la empresa tiene contratados
            "modulos": [{"id": k, "nombre": v} for k, v in MODULOS.items() if f"{k}:ver" in lim_c],
            "acciones": [{"id": k, "nombre": v} for k, v in ACCIONES.items()],
            "roles": {
                "cotizador": [p for p in POR_DEFECTO["cotizador"] if p in lim_c],
                "visualizador": [p for p in POR_DEFECTO["visualizador"] if p in lim_v],
            },
            "cupo": _cupo(con, eid),
            "usados": _usados(con, eid),
        }
    finally:
        con.close()


@router.get("")
def listar(yo: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT id, usuario, nombre, rol, activo, permisos FROM usuarios WHERE empresa_id=? ORDER BY id",
            (yo["empresa_id"],)).fetchall()
        return [{**dict(r), "permisos": list(r["permisos"] or [])} for r in filas]
    finally:
        con.close()


@router.post("")
def crear(d: UsuarioIn, request: Request, yo: dict = Depends(solo_admin)):
    if d.rol not in ROLES_ASIGNABLES:
        raise HTTPException(400, f"Rol inválido. Usa: {', '.join(ROLES_ASIGNABLES)}")
    validar_clave_fuerte(d.clave)
    nombre = d.usuario.strip().lower()
    eid = yo["empresa_id"]
    con = abrir_db()
    try:
        if con.execute("SELECT 1 FROM usuarios WHERE usuario=?", (nombre,)).fetchone():
            raise HTTPException(409, "Ese usuario ya existe")
        limite = _limite(con, yo, d.rol)
        base = d.permisos if d.permisos is not None else POR_DEFECTO[d.rol]
        permisos = [p for p in normalizar(base) if p in limite]
        # El cupo se valida dentro del mismo INSERT (atómico)
        nuevo = con.execute(
            "INSERT INTO usuarios (usuario, nombre, clave_hash, rol, permisos, empresa_id) "
            "SELECT ?::text, ?::text, ?::text, ?::text, ?::text[], ?::int "
            "WHERE (SELECT COUNT(*) FROM usuarios WHERE empresa_id=? AND activo=1) "
            f"< (SELECT {CUPO_EFECTIVO} FROM empresas WHERE id=?) RETURNING id",
            (nombre, d.nombre.strip(), hash_clave(d.clave), d.rol, permisos, eid, eid, eid),
        ).fetchone()
        if not nuevo:
            raise HTTPException(403, "Llegaste al límite de usuarios de tu plan. Amplía tu cupo para agregar más.")
    finally:
        con.close()
    auditar("usuario_creado", yo["usuario"], ip_cliente(request), f"{nombre} rol={d.rol} permisos={permisos}")
    return {"id": nuevo[0], "usuario": nombre, "rol": d.rol}


@router.patch("/{id_usuario}")
def editar(id_usuario: int, d: UsuarioPatch, request: Request, yo: dict = Depends(solo_admin)):
    if id_usuario == yo["id"] and (d.activo is False or (d.rol is not None and d.rol != "admin")):
        raise HTTPException(400, "No puedes quitarte tu propio acceso de administrador")

    con = abrir_db()
    try:
        actual = con.execute(
            "SELECT usuario, rol, activo FROM usuarios WHERE id=? AND empresa_id=?",
            (id_usuario, yo["empresa_id"])).fetchone()
        if not actual:
            raise HTTPException(404, "Usuario no encontrado")
        if d.rol is not None and d.rol != actual["rol"] and d.rol not in ROLES_ASIGNABLES:
            raise HTTPException(400, f"Rol inválido. Usa: {', '.join(ROLES_ASIGNABLES)}")
        if d.activo and not actual["activo"] and _usados(con, yo["empresa_id"]) >= _cupo(con, yo["empresa_id"]):
            raise HTTPException(403, "Llegaste al límite de usuarios de tu plan.")

        rol_final = d.rol or actual["rol"]
        sets, args = [], []
        if d.nombre is not None:
            sets.append("nombre=?"); args.append(d.nombre.strip())
        if d.rol is not None:
            sets.append("rol=?"); args.append(d.rol)
        if d.rol is not None or d.permisos is not None:
            if rol_final == "admin":
                perm: list[str] = []
            else:
                limite = _limite(con, yo, rol_final)
                base = d.permisos if d.permisos is not None else POR_DEFECTO[rol_final]
                perm = [p for p in normalizar(base) if p in limite]
            sets.append("permisos=?"); args.append(perm)
        if d.activo is not None:
            sets.append("activo=?"); args.append(1 if d.activo else 0)
        if d.clave is not None:
            validar_clave_fuerte(d.clave)
            sets.append("clave_hash=?"); args.append(hash_clave(d.clave))
        if not sets:
            raise HTTPException(400, "Nada que cambiar")

        # Invalida los tokens ya emitidos si cambia la clave, el rol o se desactiva
        if d.clave is not None or d.activo is False or (d.rol is not None and d.rol != actual["rol"]):
            sets.append("token_ver=token_ver+1")

        con.execute(f"UPDATE usuarios SET {', '.join(sets)} WHERE id=? AND empresa_id=?",
                    args + [id_usuario, yo["empresa_id"]])
    finally:
        con.close()
    auditar("usuario_editado", yo["usuario"], ip_cliente(request),
            f"{actual['usuario']}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}