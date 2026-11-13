"""CRM: equipo de ventas (ejecutivos). Un ejecutivo puede ser también asesor de la agenda (vínculo opcional)."""
import html
import re
import secrets

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.correo import enviar_correo
from core.crm import registrar
from core.db import abrir_db
from core.difusion import a_superadmins
from core.ordenes import nuevo_enlace_clave
from core.seguridad import auditar, hash_clave, ip_cliente, solo_superadmin
from core.tiempo_real import gestor

router = APIRouter(prefix="/api/crm/ejecutivos", tags=["crm-ejecutivos"], dependencies=[Depends(solo_superadmin)])

CORREO = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")


class EjecutivoIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=120)
    correo: str = Field(default="", max_length=160)
    telefono: str = Field(default="", max_length=30)
    color: str = Field(default="#0ea5e9", pattern=r"^#[0-9a-fA-F]{6}$")
    activo: bool = True
    recibe_leads: bool = True
    asesor_id: int | None = None  # si esta persona también es asesor de la agenda


class EjecutivoPatch(BaseModel):
    nombre: str | None = Field(default=None, min_length=2, max_length=120)
    correo: str | None = Field(default=None, max_length=160)
    telefono: str | None = Field(default=None, max_length=30)
    color: str | None = Field(default=None, pattern=r"^#[0-9a-fA-F]{6}$")
    activo: bool | None = None
    recibe_leads: bool | None = None
    asesor_id: int | None = None  # null = desvincular


class TraspasoIn(BaseModel):
    a_ejecutivo_id: int | None = None  # null = dejar sin asignar


def _validar(con, correo: str, asesor_id: int | None, excluir: int | None = None) -> None:
    if correo and not CORREO.match(correo):
        raise HTTPException(400, "El correo no es válido")
    if asesor_id is not None:
        if not con.execute("SELECT 1 FROM asesores WHERE id=?", (asesor_id,)).fetchone():
            raise HTTPException(400, "El asesor indicado no existe")
        otro = con.execute(
            "SELECT 1 FROM ejecutivos WHERE asesor_id=? AND id <> COALESCE(?, 0)", (asesor_id, excluir)).fetchone()
        if otro:
            raise HTTPException(409, "Ese asesor ya está vinculado a otro ejecutivo")


@router.get("")
def listar():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT e.id, e.nombre, e.correo, e.telefono, e.color, e.activo, e.recibe_leads, e.usuario_id, e.asesor_id, "
            "a.nombre AS asesor_nombre, "
            "(SELECT COUNT(*) FROM crm_leads l WHERE l.ejecutivo_id = e.id AND l.estado='abierto') AS leads_abiertos, "
            "(SELECT COUNT(*) FROM crm_leads l WHERE l.ejecutivo_id = e.id AND l.estado='ganado' "
            " AND l.actualizado_en >= date_trunc('month', now())) AS ganados_mes "
            "FROM ejecutivos e LEFT JOIN asesores a ON a.id = e.asesor_id ORDER BY e.nombre, e.id").fetchall()
    finally:
        con.close()
    return [{**dict(f), "activo": bool(f["activo"]), "recibe_leads": bool(f["recibe_leads"]),
             "tiene_acceso": f["usuario_id"] is not None} for f in filas]


@router.get("/asesores-libres")
def asesores_libres():
    """Asesores de la agenda que todavía no están vinculados a un ejecutivo (para elegir al crear uno)."""
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT a.id, a.nombre FROM asesores a WHERE a.activo=1 "
            "AND NOT EXISTS (SELECT 1 FROM ejecutivos e WHERE e.asesor_id = a.id) ORDER BY a.nombre").fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


@router.post("")
def crear(d: EjecutivoIn, request: Request, yo: dict = Depends(solo_superadmin)):
    correo = d.correo.strip().lower()
    con = abrir_db()
    try:
        _validar(con, correo, d.asesor_id)
        eid = con.execute(
            "INSERT INTO ejecutivos (nombre, correo, telefono, color, activo, recibe_leads, asesor_id) "
            "VALUES (?,?,?,?,?,?,?) RETURNING id",
            (d.nombre.strip(), correo, d.telefono.strip(), d.color, 1 if d.activo else 0,
             1 if d.recibe_leads else 0, d.asesor_id)).fetchone()[0]
    finally:
        con.close()
    auditar("ejecutivo_creado", yo["usuario"], ip_cliente(request), d.nombre)
    a_superadmins({"tipo": "crm"})
    return {"id": eid}


@router.patch("/{eid}")
def editar(eid: int, d: EjecutivoPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    campos = {k: v for k, v in d.model_dump(exclude_unset=True).items() if v is not None or k == "asesor_id"}
    if not campos:
        raise HTTPException(400, "Nada que cambiar")
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM ejecutivos WHERE id=?", (eid,)).fetchone():
            raise HTTPException(404, "Ejecutivo no encontrado")
        if "correo" in campos:
            campos["correo"] = campos["correo"].strip().lower()
        _validar(con, campos.get("correo", ""), campos.get("asesor_id"), excluir=eid)
        for k in ("nombre", "telefono"):
            if k in campos:
                campos[k] = campos[k].strip()
        for k in ("activo", "recibe_leads"):
            if k in campos:
                campos[k] = 1 if campos[k] else 0
        sets = ", ".join(f"{k}=?" for k in campos)
        con.execute(f"UPDATE ejecutivos SET {sets} WHERE id=?", [*campos.values(), eid])
    finally:
        con.close()
    auditar("ejecutivo_editado", yo["usuario"], ip_cliente(request), f"ejecutivo {eid}: {list(campos)}")
    a_superadmins({"tipo": "crm"})
    return {"ok": True}


def _cerrar_acceso(con, eid: int) -> None:
    e = con.execute("SELECT usuario_id FROM ejecutivos WHERE id=?", (eid,)).fetchone()
    if e and e["usuario_id"]:
        con.execute("UPDATE ejecutivos SET usuario_id=NULL WHERE id=?", (eid,))
        # Solo se desactiva el usuario si era únicamente ejecutivo; si también es asesor, conserva su agenda
        con.execute("UPDATE usuarios SET activo=0, token_ver=token_ver+1 WHERE id=? AND rol='ejecutivo'", (e["usuario_id"],))


@router.delete("/{eid}")
def borrar(eid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        e = con.execute("SELECT nombre FROM ejecutivos WHERE id=?", (eid,)).fetchone()
        if not e:
            raise HTTPException(404, "Ejecutivo no encontrado")
        if con.execute("SELECT 1 FROM crm_leads WHERE ejecutivo_id=? LIMIT 1", (eid,)).fetchone():
            raise HTTPException(409, "Tiene leads asignados. Traspásalos a otro ejecutivo o desactívalo en lugar de eliminarlo.")
        _cerrar_acceso(con, eid)
        con.execute("DELETE FROM ejecutivos WHERE id=?", (eid,))
    finally:
        con.close()
    auditar("ejecutivo_eliminado", yo["usuario"], ip_cliente(request), e["nombre"])
    a_superadmins({"tipo": "crm"})
    return {"ok": True}


@router.post("/{eid}/traspasar")
def traspasar(eid: int, d: TraspasoIn, request: Request, yo: dict = Depends(solo_superadmin)):
    """Pasa todos los leads ABIERTOS de este ejecutivo a otro (o los deja sin asignar)."""
    con = abrir_db()
    try:
        origen = con.execute("SELECT nombre, usuario_id FROM ejecutivos WHERE id=?", (eid,)).fetchone()
        if not origen:
            raise HTTPException(404, "Ejecutivo no encontrado")
        destino = None
        nombre_destino = "sin asignar"
        if d.a_ejecutivo_id is not None:
            if d.a_ejecutivo_id == eid:
                raise HTTPException(400, "Elige un ejecutivo distinto")
            destino = con.execute(
                "SELECT nombre, usuario_id FROM ejecutivos WHERE id=? AND activo=1", (d.a_ejecutivo_id,)).fetchone()
            if not destino:
                raise HTTPException(400, "El ejecutivo de destino no está disponible")
            nombre_destino = destino["nombre"]
        movidos = con.execute(
            "UPDATE crm_leads SET ejecutivo_id=?, actualizado_en=now() WHERE ejecutivo_id=? AND estado='abierto' RETURNING id",
            (d.a_ejecutivo_id, eid)).fetchall()
        for f in movidos:
            registrar(con, f["id"], "sistema", f"Traspasado de {origen['nombre']} a {nombre_destino}", yo["usuario"])
        avisar = [x["usuario_id"] for x in (origen, destino) if x and x["usuario_id"]]
    finally:
        con.close()
    auditar("ejecutivo_traspaso", yo["usuario"], ip_cliente(request), f"{len(movidos)} leads: {origen['nombre']} → {nombre_destino}")
    a_superadmins({"tipo": "crm"})
    if avisar:
        gestor.notificar(list(set(avisar)), {"tipo": "crm"})
    return {"ok": True, "traspasados": len(movidos)}


@router.post("/{eid}/acceso")
def dar_acceso(eid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    """Da acceso al CRM. Si el ejecutivo también es asesor con usuario, reutiliza ese mismo usuario."""
    con = abrir_db()
    try:
        e = con.execute("SELECT id, nombre, correo, usuario_id, asesor_id FROM ejecutivos WHERE id=?", (eid,)).fetchone()
        if not e:
            raise HTTPException(404, "Ejecutivo no encontrado")
        correo = (e["correo"] or "").strip().lower()
        if not CORREO.match(correo):
            raise HTTPException(400, "Primero guarda un correo válido para este ejecutivo: ahí llegará su invitación.")
        uid = e["usuario_id"]
        if not uid and e["asesor_id"]:
            a = con.execute("SELECT usuario_id FROM asesores WHERE id=?", (e["asesor_id"],)).fetchone()
            uid = a["usuario_id"] if a else None
        if uid:
            if con.execute("SELECT 1 FROM ejecutivos WHERE usuario_id=? AND id <> ?", (uid, eid)).fetchone():
                raise HTTPException(409, "Ese usuario ya está vinculado a otro ejecutivo")
            con.execute("UPDATE usuarios SET activo=1 WHERE id=?", (uid,))
        else:
            ex = con.execute("SELECT id, rol FROM usuarios WHERE usuario=?", (correo,)).fetchone()
            if ex and ex["rol"] != "ejecutivo":
                raise HTTPException(409, "Ese correo ya pertenece a otro usuario de la plataforma. Usa otro correo.")
            if ex:
                uid = ex["id"]
                con.execute("UPDATE usuarios SET activo=1, nombre=? WHERE id=?", (e["nombre"], uid))
            else:
                uid = con.execute(
                    "INSERT INTO usuarios (usuario, nombre, clave_hash, rol, correo) VALUES (?,?,?, 'ejecutivo', ?) RETURNING id",
                    (correo, e["nombre"], hash_clave(secrets.token_urlsafe(24)), correo)).fetchone()[0]
        con.execute("UPDATE ejecutivos SET usuario_id=? WHERE id=?", (uid, eid))
        usuario = con.execute("SELECT usuario FROM usuarios WHERE id=?", (uid,)).fetchone()["usuario"]
        enlace = nuevo_enlace_clave(con, uid)
        nombre = e["nombre"]
    finally:
        con.close()
    texto = (f"Hola {nombre},\n\nTe dimos acceso al CRM de ventas. Crea tu clave desde este enlace "
             f"(sirve una sola vez y vence en 24 horas):\n{enlace}\n\nTu usuario es: {usuario}")
    cuerpo = (f"<p>Hola <b>{html.escape(nombre)}</b>,</p><p>Te dimos acceso al CRM de ventas. "
              f"Crea tu clave desde este enlace (sirve una sola vez y vence en 24 horas):</p>"
              f'<p><a href="{html.escape(enlace)}">Crear mi clave</a></p><p>Tu usuario es: <b>{html.escape(usuario)}</b></p>')
    enviar_correo(correo, "Tu acceso al CRM de ventas", texto, cuerpo)
    auditar("ejecutivo_acceso", yo["usuario"], ip_cliente(request), f"ejecutivo {eid} {correo}")
    a_superadmins({"tipo": "crm"})
    return {"ok": True}


@router.delete("/{eid}/acceso")
def quitar_acceso(eid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM ejecutivos WHERE id=?", (eid,)).fetchone():
            raise HTTPException(404, "Ejecutivo no encontrado")
        _cerrar_acceso(con, eid)
    finally:
        con.close()
    auditar("ejecutivo_sin_acceso", yo["usuario"], ip_cliente(request), f"ejecutivo {eid}")
    a_superadmins({"tipo": "crm"})
    return {"ok": True}