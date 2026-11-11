import re
import unicodedata
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.catalogo import CLAVES_CONFIG, armar_planes, leer_config
from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/catalogo", tags=["catalogo"], dependencies=[Depends(solo_superadmin)])

Modulo = Literal["perucompras", "menor", "mayor"]
CORREO_RE = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


def _slug(txt: str) -> str:
    t = unicodedata.normalize("NFKD", txt).encode("ascii", "ignore").decode().lower()
    return re.sub(r"[^a-z0-9]+", "-", t).strip("-")[:40] or "plan"


def _ordenar(con, tabla: str, ids: list[int]) -> None:
    for i, _id in enumerate(ids, start=1):  # 'tabla' es siempre una constante interna
        con.execute(f"UPDATE {tabla} SET orden=? WHERE id=?", (i, _id))


def _limpiar_lista(items: list[str]) -> list[str]:
    return [i.strip()[:200] for i in items if i.strip()][:40]


class OrdenIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=200)


# ======================= PLANES =======================
class PlanNuevo(BaseModel):
    nombre: str = Field(min_length=2, max_length=80)
    subtitulo: str = Field(default="", max_length=120)
    descripcion: str = Field(default="", max_length=400)
    modulos: list[Modulo] = Field(min_length=1)
    usuarios_incluidos: int = Field(default=3, ge=1, le=500)


class PlanPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=80)
    subtitulo: str | None = Field(default=None, max_length=120)
    descripcion: str | None = Field(default=None, max_length=400)
    en_venta: bool | None = None
    destacado: bool | None = None
    usuarios_incluidos: int | None = Field(default=None, ge=1, le=500)


class ModulosIn(BaseModel):
    modulos: list[Modulo] = Field(min_length=1)


class ValoresIn(BaseModel):
    valores: dict[str, str]  # id_beneficio -> valor ("" = no incluido)


@router.get("/planes")
def planes():
    con = abrir_db()
    try:
        return armar_planes(con, False)
    finally:
        con.close()


@router.post("/planes/orden")
def ordenar_planes(d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "planes", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.post("/planes")
def crear_plan(d: PlanNuevo, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        base = _slug(d.nombre)
        codigo, n = base, 2
        while con.execute("SELECT 1 FROM planes WHERE codigo=?", (codigo,)).fetchone():
            codigo, n = f"{base}-{n}", n + 1
        orden = con.execute("SELECT COALESCE(MAX(orden),0)+1 FROM planes").fetchone()[0]
        pid = con.execute(
            "INSERT INTO planes (codigo, nombre, subtitulo, descripcion, usuarios_incluidos, orden) "
            "VALUES (?,?,?,?,?,?) RETURNING id",
            (codigo, d.nombre.strip(), d.subtitulo.strip(), d.descripcion.strip(), d.usuarios_incluidos, orden),
        ).fetchone()[0]
        for m in set(d.modulos):
            con.execute("INSERT INTO plan_modulos (plan_id, modulo) VALUES (?,?)", (pid, m))
    finally:
        con.close()
    auditar("plan_creado", yo["usuario"], ip_cliente(request), f"{d.nombre} ({codigo})")
    return {"id": pid}


@router.patch("/planes/{pid}")
def editar_plan(pid: int, d: PlanPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    sets, args = [], []
    for campo in ("nombre", "subtitulo", "descripcion"):
        v = getattr(d, campo)
        if v is not None:
            sets.append(f"{campo}=?"); args.append(v.strip())
    if d.en_venta is not None:
        sets.append("en_venta=?"); args.append(1 if d.en_venta else 0)
    if d.destacado is not None:
        sets.append("destacado=?"); args.append(1 if d.destacado else 0)
    if d.usuarios_incluidos is not None:
        sets.append("usuarios_incluidos=?"); args.append(d.usuarios_incluidos)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(f"UPDATE planes SET {', '.join(sets)} WHERE id=? RETURNING id", args + [pid]).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Plan no encontrado")
    auditar("plan_editado", yo["usuario"], ip_cliente(request), f"plan {pid}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}


@router.delete("/planes/{pid}")
def borrar_plan(pid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if con.execute("SELECT 1 FROM suscripciones WHERE plan_id=? LIMIT 1", (pid,)).fetchone():
            raise HTTPException(409, "Este plan tiene clientes suscritos. Quítale 'En venta' para ocultarlo.")
        r = con.execute("DELETE FROM planes WHERE id=? RETURNING nombre", (pid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Plan no encontrado")
    auditar("plan_eliminado", yo["usuario"], ip_cliente(request), r["nombre"])
    return {"ok": True}


@router.put("/planes/{pid}/modulos")
def fijar_modulos(pid: int, d: ModulosIn, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM planes WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Plan no encontrado")
        con.execute("DELETE FROM plan_modulos WHERE plan_id=?", (pid,))
        for m in set(d.modulos):
            con.execute("INSERT INTO plan_modulos (plan_id, modulo) VALUES (?,?)", (pid, m))
    finally:
        con.close()
    auditar("plan_modulos", yo["usuario"], ip_cliente(request), f"plan {pid}: {sorted(set(d.modulos))}")
    return {"ok": True}


@router.put("/planes/{pid}/beneficios")
def fijar_beneficios(pid: int, d: ValoresIn):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM planes WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Plan no encontrado")
        validos = {str(r["id"]) for r in con.execute("SELECT id FROM beneficios").fetchall()}
        con.execute("DELETE FROM plan_beneficios WHERE plan_id=?", (pid,))
        for bid, v in d.valores.items():
            v = v.strip()[:60]
            if bid in validos and v:
                con.execute(
                    "INSERT INTO plan_beneficios (plan_id, beneficio_id, valor) VALUES (?,?,?)", (pid, int(bid), v))
    finally:
        con.close()
    return {"ok": True}


# ======================= BENEFICIOS =======================
class BeneficioIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=160)
    tipo: Literal["check", "numero", "texto"] = "check"


class BeneficioPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=160)
    tipo: Literal["check", "numero", "texto"] | None = None
    visible: bool | None = None


@router.get("/beneficios")
def beneficios():
    con = abrir_db()
    try:
        return [{**dict(r), "visible": bool(r["visible"])} for r in con.execute(
            "SELECT id, nombre, tipo, visible, orden FROM beneficios ORDER BY orden, id").fetchall()]
    finally:
        con.close()


@router.post("/beneficios/orden")
def ordenar_beneficios(d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "beneficios", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.post("/beneficios")
def crear_beneficio(d: BeneficioIn):
    con = abrir_db()
    try:
        orden = con.execute("SELECT COALESCE(MAX(orden),0)+1 FROM beneficios").fetchone()[0]
        bid = con.execute(
            "INSERT INTO beneficios (nombre, tipo, orden) VALUES (?,?,?) RETURNING id",
            (d.nombre.strip(), d.tipo, orden)).fetchone()[0]
    finally:
        con.close()
    return {"id": bid}


@router.patch("/beneficios/{bid}")
def editar_beneficio(bid: int, d: BeneficioPatch):
    sets, args = [], []
    if d.nombre is not None:
        sets.append("nombre=?"); args.append(d.nombre.strip())
    if d.tipo is not None:
        sets.append("tipo=?"); args.append(d.tipo)
    if d.visible is not None:
        sets.append("visible=?"); args.append(1 if d.visible else 0)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(f"UPDATE beneficios SET {', '.join(sets)} WHERE id=? RETURNING id", args + [bid]).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Beneficio no encontrado")
    return {"ok": True}


@router.delete("/beneficios/{bid}")
def borrar_beneficio(bid: int):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM beneficios WHERE id=? RETURNING id", (bid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Beneficio no encontrado")
    return {"ok": True}


# ======================= SERVICIOS PERSONALIZADOS =======================
class ServicioIn(BaseModel):
    modulo: Modulo | None = None  # paquete al que pertenece; None = general
    categoria: str = Field(min_length=2, max_length=120)
    nombre: str = Field(min_length=2, max_length=160)
    descripcion: str = Field(default="", max_length=400)
    entregables: list[str] = Field(default_factory=list, max_length=60)
    precio: float | None = Field(default=None, ge=0, le=1000000)


class ServicioPatch(BaseModel):
    modulo: Modulo | None = None
    sin_modulo: bool = False  # true = servicio general (sin paquete)
    categoria: str | None = Field(default=None, min_length=2, max_length=120)
    nombre: str | None = Field(default=None, min_length=2, max_length=160)
    descripcion: str | None = Field(default=None, max_length=400)
    entregables: list[str] | None = Field(default=None, max_length=60)
    precio: float | None = Field(default=None, ge=0, le=1000000)
    sin_precio: bool = False  # true = "A cotizar"
    activo: bool | None = None


def _servicio(r) -> dict:
    return {**dict(r), "entregables": list(r["entregables"] or []), "activo": bool(r["activo"]),
            "precio": float(r["precio"]) if r["precio"] is not None else None}


@router.get("/servicios")
def servicios():
    con = abrir_db()
    try:
        return [_servicio(r) for r in con.execute(
            "SELECT id, modulo, categoria, nombre, descripcion, entregables, precio, activo, orden "
            "FROM servicios ORDER BY orden, id").fetchall()]
    finally:
        con.close()


@router.post("/servicios/orden")
def ordenar_servicios(d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "servicios", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.post("/servicios")
def crear_servicio(d: ServicioIn):
    con = abrir_db()
    try:
        orden = con.execute("SELECT COALESCE(MAX(orden),0)+1 FROM servicios").fetchone()[0]
        sid = con.execute(
            "INSERT INTO servicios (modulo, categoria, nombre, descripcion, entregables, precio, orden) "
            "VALUES (?,?,?,?,?,?,?) RETURNING id",
            (d.modulo, d.categoria.strip(), d.nombre.strip(), d.descripcion.strip(),
             _limpiar_lista(d.entregables), d.precio, orden)).fetchone()[0]
    finally:
        con.close()
    return {"id": sid}


@router.patch("/servicios/{sid}")
def editar_servicio(sid: int, d: ServicioPatch):
    sets, args = [], []
    for campo in ("categoria", "nombre", "descripcion"):
        v = getattr(d, campo)
        if v is not None:
            sets.append(f"{campo}=?"); args.append(v.strip())
    if d.entregables is not None:
        sets.append("entregables=?"); args.append(_limpiar_lista(d.entregables))
    if d.sin_modulo:
        sets.append("modulo=NULL")
    elif d.modulo is not None:
        sets.append("modulo=?"); args.append(d.modulo)
    if d.sin_precio:
        sets.append("precio=NULL")
    elif d.precio is not None:
        sets.append("precio=?"); args.append(d.precio)
    if d.activo is not None:
        sets.append("activo=?"); args.append(1 if d.activo else 0)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(f"UPDATE servicios SET {', '.join(sets)} WHERE id=? RETURNING id", args + [sid]).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Servicio no encontrado")
    return {"ok": True}


@router.delete("/servicios/{sid}")
def borrar_servicio(sid: int):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM servicios WHERE id=? RETURNING id", (sid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Servicio no encontrado")
    return {"ok": True}


# ======================= TEXTOS Y CONTACTO DEL SITIO =======================
class ConfigIn(BaseModel):
    valores: dict[str, str]


@router.get("/config")
def get_config():
    con = abrir_db()
    try:
        return leer_config(con)
    finally:
        con.close()


@router.put("/config")
def put_config(d: ConfigIn, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        for k, v in d.valores.items():
            if k not in CLAVES_CONFIG:
                continue
            v = v.strip()[:400]
            if k == "contacto_whatsapp":
                v = re.sub(r"\D", "", v)[:15]
            if k == "contacto_correo" and v and not re.fullmatch(CORREO_RE, v):
                raise HTTPException(400, "El correo de contacto no es válido")
            con.execute(
                "INSERT INTO configuracion (clave, valor) VALUES (?,?) "
                "ON CONFLICT (clave) DO UPDATE SET valor=EXCLUDED.valor", (k, v))
    finally:
        con.close()
    auditar("sitio_editado", yo["usuario"], ip_cliente(request), ",".join(d.valores))
    return {"ok": True}