from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.seguridad import auditar, hash_clave, ip_cliente, solo_superadmin, validar_clave_fuerte
from core.suscripciones import activar_suscripcion, ajustar_rol_persona
from core.validaciones import validar_documento

router = APIRouter(prefix="/api/plataforma", tags=["plataforma"], dependencies=[Depends(solo_superadmin)])

CORREO = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class SuscripcionIn(BaseModel):
    plan: str = Field(max_length=30)  # código del plan: perucompras | menor | mayor
    modo: Literal["ver", "cotizar"]
    periodo: Literal["mensual", "anual"]


class ClienteIn(BaseModel):
    tipo: Literal["empresa", "persona"]
    nombre: str = Field(min_length=2, max_length=160)
    doc_tipo: Literal["RUC", "DNI", "CE", "PASAPORTE"]
    doc_numero: str = Field(min_length=6, max_length=20)
    correo: str = Field(max_length=160, pattern=CORREO)
    usuario: str = Field(min_length=3, max_length=60, pattern=r"^[A-Za-z0-9._-]+$")
    clave: str = Field(min_length=10, max_length=72)
    cupo_usuarios: int | None = Field(default=None, ge=1, le=500)
    suscripciones: list[SuscripcionIn] = Field(min_length=1, max_length=10)


class EmpresaPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=160)
    correo: str | None = Field(default=None, max_length=160, pattern=CORREO)
    cupo_usuarios: int | None = Field(default=None, ge=1, le=500)
    activo: bool | None = None


class SuscripcionPatch(BaseModel):
    estado: Literal["activa", "cancelada"] | None = None
    vence_en: datetime | None = None


class PlanPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=80)
    descripcion: str | None = Field(default=None, max_length=400)
    en_venta: bool | None = None
    orden: int | None = Field(default=None, ge=0, le=99)


class PrecioIn(BaseModel):
    tipo_cuenta: Literal["empresa", "persona"]
    concepto: Literal["ver", "cotizar", "usuario_extra"]
    periodo: Literal["mensual", "anual"]
    monto: float = Field(ge=0, le=100000)


# ---------------- Resumen y clientes ----------------
@router.get("/resumen")
def resumen():
    con = abrir_db()
    try:
        r = con.execute(
            "SELECT "
            "(SELECT COUNT(*) FROM empresas WHERE tipo='empresa') AS empresas, "
            "(SELECT COUNT(*) FROM empresas WHERE tipo='persona') AS personas, "
            "(SELECT COUNT(*) FROM suscripciones WHERE estado='activa' AND vence_en > now()) AS suscripciones_activas, "
            "(SELECT COUNT(*) FROM suscripciones WHERE estado='activa' AND vence_en > now() "
            " AND vence_en < now() + interval '30 days') AS por_vencer").fetchone()
        return dict(r)
    finally:
        con.close()


@router.get("/empresas")
def empresas(tipo: str = ""):
    if tipo and tipo not in ("empresa", "persona"):
        raise HTTPException(400, "Tipo inválido")
    con = abrir_db()
    try:
        w, a = ("WHERE e.tipo=?", [tipo]) if tipo else ("", [])
        emps = con.execute(
            "SELECT e.id, e.tipo, e.nombre, e.doc_tipo, e.doc_numero, e.correo, e.cupo_usuarios, "
            "e.activo, e.creado_en, "
            "(SELECT COUNT(*) FROM usuarios u WHERE u.empresa_id=e.id AND u.activo=1) AS usuarios "
            f"FROM empresas e {w} ORDER BY e.id DESC", a).fetchall()
        subs = con.execute(
            "SELECT s.id, s.empresa_id, p.codigo, p.nombre, s.modo, s.periodo, s.inicio, s.vence_en, "
            "s.estado, (s.vence_en > now()) AS vigente "
            "FROM suscripciones s JOIN planes p ON p.id = s.plan_id ORDER BY p.orden").fetchall()
    finally:
        con.close()
    por: dict[int, list[dict]] = {}
    for s in subs:
        por.setdefault(s["empresa_id"], []).append(dict(s))
    return [{**dict(e), "suscripciones": por.get(e["id"], [])} for e in emps]


@router.get("/empresas/{eid}/usuarios")
def usuarios_de(eid: int):
    con = abrir_db()
    try:
        return [dict(r) for r in con.execute(
            "SELECT id, usuario, nombre, rol, activo FROM usuarios WHERE empresa_id=? ORDER BY id", (eid,)).fetchall()]
    finally:
        con.close()


@router.post("/empresas")
def crear_cliente(d: ClienteIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if d.tipo == "empresa" and d.doc_tipo != "RUC":
        raise HTTPException(400, "Una empresa se registra con RUC")
    if d.tipo == "persona" and d.doc_tipo == "RUC":
        raise HTTPException(400, "Una persona natural se registra con DNI, CE o pasaporte")
    doc = validar_documento(d.doc_tipo, d.doc_numero)
    validar_clave_fuerte(d.clave)
    cupo = (d.cupo_usuarios or 3) if d.tipo == "empresa" else 1
    usuario = d.usuario.strip().lower()

    con = abrir_db()
    eid = None
    try:
        if con.execute("SELECT 1 FROM usuarios WHERE usuario=?", (usuario,)).fetchone():
            raise HTTPException(409, "Ese usuario ya existe")
        planes = {r["codigo"]: r["id"] for r in con.execute("SELECT id, codigo FROM planes").fetchall()}
        for s in d.suscripciones:
            if s.plan not in planes:
                raise HTTPException(400, f"Plan inexistente: {s.plan}")
        fila = con.execute(
            "INSERT INTO empresas (tipo, nombre, doc_tipo, doc_numero, correo, cupo_usuarios) "
            "VALUES (?,?,?,?,?,?) ON CONFLICT (doc_tipo, doc_numero) DO NOTHING RETURNING id",
            (d.tipo, d.nombre.strip(), d.doc_tipo, doc, d.correo.strip().lower(), cupo)).fetchone()
        if not fila:
            raise HTTPException(409, "Ya existe un cliente con ese documento")
        eid = fila[0]
        rol = "admin" if d.tipo == "empresa" else (
            "cotizador" if any(s.modo == "cotizar" for s in d.suscripciones) else "visualizador")
        con.execute(
            "INSERT INTO usuarios (usuario, nombre, clave_hash, rol, empresa_id) VALUES (?,?,?,?,?)",
            (usuario, d.nombre.strip(), hash_clave(d.clave), rol, eid))
        for s in d.suscripciones:
            activar_suscripcion(con, eid, planes[s.plan], s.modo, s.periodo)
    except Exception:
        if eid:  # deshace lo creado si algo falló a medias
            con.execute("DELETE FROM suscripciones WHERE empresa_id=?", (eid,))
            con.execute("DELETE FROM usuarios WHERE empresa_id=?", (eid,))
            con.execute("DELETE FROM empresas WHERE id=?", (eid,))
        raise
    finally:
        con.close()
    auditar("cliente_creado", yo["usuario"], ip_cliente(request), f"{d.nombre} ({d.tipo}) {d.doc_tipo} {doc}")
    return {"id": eid}


@router.patch("/empresas/{eid}")
def editar_empresa(eid: int, d: EmpresaPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    sets, args = [], []
    if d.nombre is not None:
        sets.append("nombre=?"); args.append(d.nombre.strip())
    if d.correo is not None:
        sets.append("correo=?"); args.append(d.correo.strip().lower())
    if d.cupo_usuarios is not None:
        sets.append("cupo_usuarios=?"); args.append(d.cupo_usuarios)
    if d.activo is not None:
        sets.append("activo=?"); args.append(1 if d.activo else 0)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(f"UPDATE empresas SET {', '.join(sets)} WHERE id=? RETURNING id", args + [eid]).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Cliente no encontrado")
    auditar("cliente_editado", yo["usuario"], ip_cliente(request), f"empresa {eid}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}


# ---------------- Suscripciones ----------------
@router.post("/empresas/{eid}/suscripciones")
def suscribir(eid: int, s: SuscripcionIn, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM empresas WHERE id=?", (eid,)).fetchone():
            raise HTTPException(404, "Cliente no encontrado")
        plan = con.execute("SELECT id FROM planes WHERE codigo=?", (s.plan,)).fetchone()
        if not plan:
            raise HTTPException(400, "Plan inexistente")
        r = activar_suscripcion(con, eid, plan["id"], s.modo, s.periodo)
        ajustar_rol_persona(con, eid)
    finally:
        con.close()
    auditar("suscripcion_activada", yo["usuario"], ip_cliente(request), f"empresa {eid}: {s.plan} {s.modo} {s.periodo}")
    return {"id": r["id"], "vence_en": r["vence_en"]}


@router.patch("/suscripciones/{sid}")
def editar_suscripcion(sid: int, d: SuscripcionPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    sets, args = [], []
    if d.estado is not None:
        sets.append("estado=?"); args.append(d.estado)
    if d.vence_en is not None:
        sets.append("vence_en=?"); args.append(d.vence_en)
    if not sets:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        r = con.execute(
            f"UPDATE suscripciones SET {', '.join(sets)} WHERE id=? RETURNING empresa_id", args + [sid]).fetchone()
        if not r:
            raise HTTPException(404, "Suscripción no encontrada")
        ajustar_rol_persona(con, r["empresa_id"])
    finally:
        con.close()
    auditar("suscripcion_editada", yo["usuario"], ip_cliente(request), f"suscripcion {sid}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}


# ---------------- Paquetes y precios ----------------
@router.get("/planes")
def planes():
    con = abrir_db()
    try:
        ps = con.execute("SELECT id, codigo, nombre, descripcion, en_venta, orden FROM planes ORDER BY orden, id").fetchall()
        pr = con.execute("SELECT plan_id, tipo_cuenta, concepto, periodo, monto FROM precios").fetchall()
    finally:
        con.close()
    return [{
        **dict(p), "en_venta": bool(p["en_venta"]),
        "precios": [{"tipo_cuenta": x["tipo_cuenta"], "concepto": x["concepto"], "periodo": x["periodo"],
                     "monto": float(x["monto"])} for x in pr if x["plan_id"] == p["id"]],
    } for p in ps]


@router.patch("/planes/{pid}")
def editar_plan(pid: int, d: PlanPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    sets, args = [], []
    if d.nombre is not None:
        sets.append("nombre=?"); args.append(d.nombre.strip())
    if d.descripcion is not None:
        sets.append("descripcion=?"); args.append(d.descripcion.strip())
    if d.en_venta is not None:
        sets.append("en_venta=?"); args.append(1 if d.en_venta else 0)
    if d.orden is not None:
        sets.append("orden=?"); args.append(d.orden)
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


@router.put("/planes/{pid}/precios")
def fijar_precios(pid: int, precios: list[PrecioIn], request: Request, yo: dict = Depends(solo_superadmin)):
    """Reemplaza TODOS los precios del plan: lo que no envíes deja de venderse."""
    for p in precios:
        if p.concepto == "usuario_extra" and p.tipo_cuenta != "empresa":
            raise HTTPException(400, "El usuario extra solo aplica a empresas")
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM planes WHERE id=?", (pid,)).fetchone():
            raise HTTPException(404, "Plan no encontrado")
        con.execute("DELETE FROM precios WHERE plan_id=?", (pid,))
        for p in precios:
            con.execute(
                "INSERT INTO precios (plan_id, tipo_cuenta, concepto, periodo, monto) VALUES (?,?,?,?,?) "
                "ON CONFLICT (plan_id, tipo_cuenta, concepto, periodo) DO UPDATE SET monto=EXCLUDED.monto",
                (pid, p.tipo_cuenta, p.concepto, p.periodo, p.monto))
    finally:
        con.close()
    auditar("precios_actualizados", yo["usuario"], ip_cliente(request), f"plan {pid}: {len(precios)} precios")
    return {"ok": True, "precios": len(precios)}