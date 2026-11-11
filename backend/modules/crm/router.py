from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.crm import (
    avisar_lead, buscar_duplicado, captar_lead, contacto_valido, recalcular_siguiente, registrar, siguiente_asesor,
)
from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, usuario_actual
from core.ventas import funcion_activa

router = APIRouter(prefix="/api/crm", tags=["crm"])

ESTADO_POR_TIPO = {"abierta": "abierto", "ganada": "ganado", "perdida": "perdido"}


# ======================= ACCESO Y ALCANCE =======================
@router.get("/estado")
def estado(u: dict = Depends(usuario_actual)):
    """¿Debe verse el CRM para este usuario? (superadmin o asesor, y con la función encendida)."""
    return {"activo": bool(u["rol"] in ("superadmin", "asesor") and funcion_activa("crm"))}


def contexto(u: dict = Depends(usuario_actual)) -> dict:
    if u["rol"] not in ("superadmin", "asesor"):
        raise HTTPException(403, "No tienes acceso al CRM")
    if not funcion_activa("crm"):
        raise HTTPException(404, "El CRM no está activado")
    asesor_id = None
    if u["rol"] == "asesor":
        con = abrir_db()
        try:
            a = con.execute("SELECT id FROM asesores WHERE usuario_id=? AND activo=1", (u["id"],)).fetchone()
        finally:
            con.close()
        if not a:
            raise HTTPException(403, "Tu usuario no está vinculado a un asesor activo")
        asesor_id = a["id"]
    return {"u": u, "asesor_id": asesor_id, "admin": u["rol"] == "superadmin"}


def solo_admin(ctx: dict = Depends(contexto)) -> dict:
    if not ctx["admin"]:
        raise HTTPException(403, "Solo el superadmin puede hacer esto")
    return ctx


def _lead(con, lid: int, ctx: dict):
    l = con.execute("SELECT * FROM crm_leads WHERE id=?", (lid,)).fetchone()
    if not l or (ctx["asesor_id"] is not None and l["asesor_id"] != ctx["asesor_id"]):
        raise HTTPException(404, "Lead no encontrado")
    return l


def _usuarios_de(con, asesor_ids: list[int | None]) -> list[int]:
    ids = [a for a in asesor_ids if a]
    if not ids:
        return []
    return [r["usuario_id"] for r in con.execute(
        "SELECT usuario_id FROM asesores WHERE id = ANY(?) AND usuario_id IS NOT NULL", (ids,)).fetchall()]


# ======================= MODELOS =======================
class LeadIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=120)
    empresa_nombre: str = Field(default="", max_length=160)
    correo: str = Field(default="", max_length=160)
    telefono: str = Field(default="", max_length=30)
    doc_tipo: Literal["", "DNI", "RUC", "CE", "PASAPORTE"] = ""
    doc_numero: str = Field(default="", max_length=20)
    interes: str = Field(default="", max_length=300)
    valor_estimado: float = Field(default=0, ge=0, le=10_000_000)
    asesor_id: int | None = None


class LeadPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=120)
    empresa_nombre: str | None = Field(default=None, max_length=160)
    correo: str | None = Field(default=None, max_length=160)
    telefono: str | None = Field(default=None, max_length=30)
    doc_tipo: Literal["", "DNI", "RUC", "CE", "PASAPORTE"] | None = None
    doc_numero: str | None = Field(default=None, max_length=20)
    interes: str | None = Field(default=None, max_length=300)
    valor_estimado: float | None = Field(default=None, ge=0, le=10_000_000)


class EtapaIn(BaseModel):
    etapa_id: int
    motivo: str = Field(default="", max_length=200)


class ActividadIn(BaseModel):
    tipo: Literal["nota", "llamada", "whatsapp", "correo", "reunion", "tarea"]
    contenido: str = Field(min_length=1, max_length=1000)
    programada_en: datetime | None = None


class AsignarIn(BaseModel):
    asesor_id: int | None = None


class ImportarIn(BaseModel):
    filas: list[dict[str, str]] = Field(max_length=500)


class EtapaCfg(BaseModel):
    id: int | None = None
    nombre: str = Field(min_length=2, max_length=40)
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")
    tipo: Literal["abierta", "ganada", "perdida"]
    activa: bool = True


class ConfigIn(BaseModel):
    reparto: Literal["manual", "rotativo"]
    etapas: list[EtapaCfg] = Field(min_length=3, max_length=20)


# ======================= CONSULTAS =======================
@router.get("/etapas")
def etapas(ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        filas = con.execute("SELECT id, nombre, orden, tipo, color, activa FROM crm_etapas ORDER BY orden, id").fetchall()
    finally:
        con.close()
    return [{**dict(f), "activa": bool(f["activa"])} for f in filas]


@router.get("/asesores")
def asesores(ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT a.id, a.nombre, a.color, (SELECT COUNT(*) FROM crm_leads l WHERE l.asesor_id = a.id AND l.estado='abierto') AS leads "
            "FROM asesores a WHERE a.activo=1 ORDER BY a.nombre").fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


@router.get("/resumen")
def resumen(ctx: dict = Depends(contexto)):
    w, args = ("WHERE asesor_id=?", [ctx["asesor_id"]]) if ctx["asesor_id"] is not None else ("", [])
    con = abrir_db()
    try:
        k = con.execute(
            "SELECT COUNT(*) FILTER (WHERE estado='abierto') AS abiertos, "
            "COALESCE(SUM(valor_estimado) FILTER (WHERE estado='abierto'), 0) AS valor_abierto, "
            "COUNT(*) FILTER (WHERE estado='abierto' AND siguiente_accion_en < now()) AS vencidos, "
            "COUNT(*) FILTER (WHERE estado='abierto' AND asesor_id IS NULL) AS sin_asignar, "
            "COUNT(*) FILTER (WHERE estado='ganado' AND actualizado_en >= date_trunc('month', now())) AS ganados_mes, "
            "COALESCE(SUM(valor_estimado) FILTER (WHERE estado='ganado' AND actualizado_en >= date_trunc('month', now())), 0) AS valor_ganado_mes "
            f"FROM crm_leads {w}", args).fetchone()
        por = con.execute(
            f"SELECT etapa_id, COUNT(*) AS n, COALESCE(SUM(valor_estimado), 0) AS valor FROM crm_leads {w} GROUP BY etapa_id", args).fetchall()
    finally:
        con.close()
    return {
        "abiertos": k["abiertos"], "valor_abierto": float(k["valor_abierto"]), "vencidos": k["vencidos"],
        "sin_asignar": k["sin_asignar"], "ganados_mes": k["ganados_mes"], "valor_ganado_mes": float(k["valor_ganado_mes"]),
        "por_etapa": {p["etapa_id"]: {"n": p["n"], "valor": float(p["valor"])} for p in por},
    }


COLUMNAS_LEAD = (
    "l.id, l.nombre, l.empresa_nombre, l.correo, l.telefono, l.origen, l.interes, l.valor_estimado, l.etapa_id, l.estado, "
    "l.asesor_id, a.nombre AS asesor, a.color AS asesor_color, l.siguiente_accion_en, l.ultimo_contacto_en, l.creado_en, "
    "l.wa_no_leidos, l.wa_ultimo_entrante, "
    "l.actualizado_en, (l.estado = 'abierto' AND l.siguiente_accion_en IS NOT NULL AND l.siguiente_accion_en < now()) AS vencido"
)


def _lead_json(f) -> dict:
    d = dict(f)
    d["valor_estimado"] = float(d["valor_estimado"])
    return d


@router.get("/leads")
def listar(estado: str = "abierto", etapa_id: int | None = None, asesor_id: int | None = None, q: str = "",
           vencidos: bool = False, limite: int = 200, desde: int = 0, ctx: dict = Depends(contexto)):
    if estado not in ("abierto", "ganado", "perdido", "todos"):
        raise HTTPException(400, "Estado inválido")
    w, args = [], []
    if ctx["asesor_id"] is not None:
        w.append("l.asesor_id=?"); args.append(ctx["asesor_id"])
    elif asesor_id is not None:
        if asesor_id == 0:
            w.append("l.asesor_id IS NULL")
        else:
            w.append("l.asesor_id=?"); args.append(asesor_id)
    if estado != "todos":
        w.append("l.estado=?"); args.append(estado)
    if etapa_id:
        w.append("l.etapa_id=?"); args.append(etapa_id)
    if q.strip():
        like = f"%{q.strip()}%"
        w.append("(l.nombre ILIKE ? OR l.empresa_nombre ILIKE ? OR l.correo ILIKE ? OR l.telefono LIKE ?)")
        args += [like, like, like, like]
    if vencidos:
        w.append("l.estado='abierto' AND l.siguiente_accion_en < now()")
    donde = ("WHERE " + " AND ".join(w)) if w else ""
    limite = min(max(limite, 1), 500)
    con = abrir_db()
    try:
        filas = con.execute(
            f"SELECT {COLUMNAS_LEAD} FROM crm_leads l LEFT JOIN asesores a ON a.id = l.asesor_id {donde} "
            "ORDER BY l.actualizado_en DESC LIMIT ? OFFSET ?", args + [limite, max(desde, 0)]).fetchall()
    finally:
        con.close()
    return [_lead_json(f) for f in filas]


@router.get("/leads/{lid}")
def detalle(lid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        _lead(con, lid, ctx)
        l = con.execute(
            f"SELECT {COLUMNAS_LEAD}, l.doc_tipo, l.doc_numero, l.motivo_perdida, l.orden_id, l.creado_por "
            "FROM crm_leads l LEFT JOIN asesores a ON a.id = l.asesor_id WHERE l.id=?", (lid,)).fetchone()
        acts = con.execute(
            "SELECT id, tipo, contenido, usuario, programada_en, completada_en, creado_en FROM crm_actividades "
            "WHERE lead_id=? ORDER BY creado_en DESC LIMIT 300", (lid,)).fetchall()
    finally:
        con.close()
    return {**_lead_json(l), "actividades": [dict(a) for a in acts]}


# ======================= ESCRITURA =======================
@router.post("/leads")
def crear(d: LeadIn, request: Request, ctx: dict = Depends(contexto)):
    correo, tel = contacto_valido(d.correo, d.telefono)
    if not correo and not tel:
        raise HTTPException(400, "Escribe al menos un teléfono o un correo para poder contactar al lead")
    con = abrir_db()
    try:
        dup = buscar_duplicado(con, correo, tel)
        if dup:
            raise HTTPException(409, "Ya existe un lead abierto con ese teléfono o correo" + (f" (n.º {dup})" if ctx["admin"] else ""))
        asesor_id = ctx["asesor_id"] if ctx["asesor_id"] is not None else d.asesor_id
        lid, _ = captar_lead(
            con, nombre=d.nombre, correo=correo, telefono=tel, empresa=d.empresa_nombre, doc_tipo=d.doc_tipo,
            doc_numero=d.doc_numero, origen="manual", interes=d.interes, valor=d.valor_estimado,
            creado_por=ctx["u"]["usuario"], asesor_id=asesor_id)
    finally:
        con.close()
    avisar_lead(lid)
    return {"id": lid}


@router.patch("/leads/{lid}")
def editar(lid: int, d: LeadPatch, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        campos = d.model_dump(exclude_unset=True)
        if "correo" in campos or "telefono" in campos:
            correo, tel = contacto_valido(campos.get("correo", l["correo"]), campos.get("telefono", l["telefono"]))
            if not correo and not tel:
                raise HTTPException(400, "El lead necesita un teléfono o un correo")
            dup = buscar_duplicado(con, correo, tel, excluir=lid)
            if dup:
                raise HTTPException(409, "Otro lead abierto ya usa ese teléfono o correo")
            campos["correo"], campos["telefono"] = correo, tel
        if not campos:
            raise HTTPException(400, "Nada que cambiar")
        sets = ", ".join(f"{k}=?" for k in campos)
        con.execute(f"UPDATE crm_leads SET {sets}, actualizado_en=now() WHERE id=?", [*campos.values(), lid])
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


@router.post("/leads/{lid}/etapa")
def mover(lid: int, d: EtapaIn, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        nueva = con.execute("SELECT id, nombre, tipo FROM crm_etapas WHERE id=? AND activa=1", (d.etapa_id,)).fetchone()
        if not nueva:
            raise HTTPException(400, "Etapa no válida")
        if nueva["tipo"] == "perdida" and not d.motivo.strip():
            raise HTTPException(400, "Indica el motivo por el que se perdió")
        vieja = con.execute("SELECT nombre FROM crm_etapas WHERE id=?", (l["etapa_id"],)).fetchone()
        if l["etapa_id"] == nueva["id"]:
            return {"ok": True}
        motivo = d.motivo.strip() if nueva["tipo"] == "perdida" else ""
        con.execute(
            "UPDATE crm_leads SET etapa_id=?, estado=?, motivo_perdida=?, actualizado_en=now(), ultimo_contacto_en=now() WHERE id=?",
            (nueva["id"], ESTADO_POR_TIPO[nueva["tipo"]], motivo, lid))
        registrar(con, lid, "sistema", f"Etapa: {vieja['nombre'] if vieja else '?'} → {nueva['nombre']}" + (f". Motivo: {motivo}" if motivo else ""),
                  ctx["u"]["usuario"])
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


@router.post("/leads/{lid}/actividades")
def nueva_actividad(lid: int, d: ActividadIn, ctx: dict = Depends(contexto)):
    if d.tipo != "tarea" and d.programada_en is not None:
        raise HTTPException(400, "Solo las tareas pueden tener fecha programada")
    if d.tipo == "tarea" and d.programada_en is None:
        raise HTTPException(400, "Indica cuándo debes hacer esta tarea")
    con = abrir_db()
    try:
        _lead(con, lid, ctx)
        aid = registrar(con, lid, d.tipo, d.contenido.strip(), ctx["u"]["usuario"], d.programada_en)
        if d.tipo == "tarea":
            recalcular_siguiente(con, lid)
            con.execute("UPDATE crm_leads SET actualizado_en=now() WHERE id=?", (lid,))
        else:  # nota, llamada, WhatsApp, correo o reunión: cuenta como contacto
            con.execute("UPDATE crm_leads SET actualizado_en=now(), ultimo_contacto_en=now() WHERE id=?", (lid,))
    finally:
        con.close()
    avisar_lead(lid)
    return {"id": aid}


@router.post("/actividades/{aid}/completar")
def completar(aid: int, ctx: dict = Depends(contexto)):
    con = abrir_db()
    try:
        a = con.execute("SELECT lead_id FROM crm_actividades WHERE id=?", (aid,)).fetchone()
        if not a:
            raise HTTPException(404, "Actividad no encontrada")
        _lead(con, a["lead_id"], ctx)
        con.execute("UPDATE crm_actividades SET completada_en=now() WHERE id=? AND completada_en IS NULL", (aid,))
        recalcular_siguiente(con, a["lead_id"])
        con.execute("UPDATE crm_leads SET actualizado_en=now(), ultimo_contacto_en=now() WHERE id=?", (a["lead_id"],))
        lid = a["lead_id"]
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


@router.post("/leads/{lid}/asignar")
def asignar(lid: int, d: AsignarIn, ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        nombre = "sin asignar"
        if d.asesor_id is not None:
            a = con.execute("SELECT nombre FROM asesores WHERE id=? AND activo=1", (d.asesor_id,)).fetchone()
            if not a:
                raise HTTPException(400, "Asesor no disponible")
            nombre = a["nombre"]
        con.execute("UPDATE crm_leads SET asesor_id=?, actualizado_en=now() WHERE id=?", (d.asesor_id, lid))
        registrar(con, lid, "sistema", f"Asignado a: {nombre}", ctx["u"]["usuario"])
        extra = _usuarios_de(con, [l["asesor_id"]])  # el asesor anterior también debe enterarse
    finally:
        con.close()
    avisar_lead(lid, extra)
    return {"ok": True}


@router.delete("/leads/{lid}")
def borrar(lid: int, request: Request, ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        l = _lead(con, lid, ctx)
        extra = _usuarios_de(con, [l["asesor_id"]])
        con.execute("DELETE FROM crm_leads WHERE id=?", (lid,))
    finally:
        con.close()
    auditar("crm_lead_borrado", ctx["u"]["usuario"], ip_cliente(request), f"lead {lid} {l['nombre']}")
    from core.difusion import a_superadmins
    from core.tiempo_real import gestor
    a_superadmins({"tipo": "crm"})
    if extra:
        gestor.notificar(extra, {"tipo": "crm"})
    return {"ok": True}


@router.post("/importar")
def importar(d: ImportarIn, request: Request, ctx: dict = Depends(contexto)):
    """Importa filas de un CSV (ya leído en el navegador). Salta duplicados y filas inválidas, y dice por qué."""
    creados = duplicados = invalidos = 0
    errores: list[str] = []
    vistos: set[str] = set()
    con = abrir_db()
    try:
        for n, f in enumerate(d.filas, start=2):  # la fila 1 del archivo son los títulos
            try:
                nombre = (f.get("nombre") or "").strip()
                if len(nombre) < 2:
                    raise HTTPException(400, "falta el nombre")
                correo, tel = contacto_valido(f.get("correo", ""), f.get("telefono", ""))
                if not correo and not tel:
                    raise HTTPException(400, "falta teléfono o correo")
                clave = tel or correo
                if clave in vistos:
                    duplicados += 1
                    continue
                vistos.add(clave)
                if buscar_duplicado(con, correo, tel):
                    duplicados += 1
                    continue
                try:
                    valor = float((f.get("valor") or "0").replace(",", ".") or 0)
                except ValueError:
                    valor = 0.0
                captar_lead(con, nombre=nombre, correo=correo, telefono=tel, empresa=f.get("empresa", ""),
                            origen="importado", interes=f.get("interes", ""), valor=max(0.0, min(valor, 10_000_000)),
                            creado_por=ctx["u"]["usuario"], asesor_id=ctx["asesor_id"])
                creados += 1
            except HTTPException as e:
                invalidos += 1
                if len(errores) < 15:
                    errores.append(f"Fila {n}: {e.detail}")
    finally:
        con.close()
    auditar("crm_importacion", ctx["u"]["usuario"], ip_cliente(request), f"creados={creados} dup={duplicados} inv={invalidos}")
    if creados:
        from core.difusion import a_superadmins
        a_superadmins({"tipo": "crm"})
    return {"creados": creados, "duplicados": duplicados, "invalidos": invalidos, "errores": errores}


# ======================= CONFIGURACIÓN (solo superadmin) =======================
@router.get("/admin/config")
def ver_config(ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        r = con.execute("SELECT valor FROM configuracion WHERE clave='crm_reparto'").fetchone()
        et = con.execute(
            "SELECT e.id, e.nombre, e.orden, e.tipo, e.color, e.activa, (SELECT COUNT(*) FROM crm_leads l WHERE l.etapa_id = e.id) AS leads "
            "FROM crm_etapas e ORDER BY e.orden, e.id").fetchall()
    finally:
        con.close()
    return {"reparto": "rotativo" if r and r["valor"] == "rotativo" else "manual",
            "etapas": [{**dict(e), "activa": bool(e["activa"])} for e in et]}


@router.put("/admin/config")
def guardar_config(d: ConfigIn, request: Request, ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        actuales = {e["id"]: e for e in con.execute("SELECT id, tipo FROM crm_etapas").fetchall()}
        activas = {"abierta": 0, "ganada": 0, "perdida": 0}
        for e in d.etapas:
            tipo = actuales[e.id]["tipo"] if e.id in actuales else e.tipo
            if e.id is not None and e.id not in actuales:
                raise HTTPException(400, "Una etapa no existe")
            if e.activa:
                activas[tipo] += 1
            elif e.id is not None:
                n = con.execute("SELECT COUNT(*) FROM crm_leads WHERE etapa_id=?", (e.id,)).fetchone()[0]
                if n:
                    raise HTTPException(409, f"La etapa «{e.nombre}» tiene {n} leads: muévelos a otra etapa antes de desactivarla")
        if not all(activas.values()):
            raise HTTPException(400, "Debe haber al menos una etapa abierta, una de ganado y una de perdido activas")
        for orden, e in enumerate(d.etapas, start=1):
            if e.id is None:
                con.execute("INSERT INTO crm_etapas (nombre, orden, tipo, color, activa) VALUES (?,?,?,?,?)",
                            (e.nombre.strip(), orden, e.tipo, e.color, 1 if e.activa else 0))
            else:  # el tipo de una etapa existente no cambia (los leads ya están clasificados con él)
                con.execute("UPDATE crm_etapas SET nombre=?, orden=?, color=?, activa=? WHERE id=?",
                            (e.nombre.strip(), orden, e.color, 1 if e.activa else 0, e.id))
        con.execute(
            "INSERT INTO configuracion (clave, valor) VALUES ('crm_reparto', ?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
            (d.reparto,))
    finally:
        con.close()
    auditar("crm_config", ctx["u"]["usuario"], ip_cliente(request), f"reparto={d.reparto} etapas={len(d.etapas)}")
    from core.difusion import a_superadmins
    a_superadmins({"tipo": "crm"})
    return {"ok": True}