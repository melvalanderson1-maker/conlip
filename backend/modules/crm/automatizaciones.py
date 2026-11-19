"""CRM: automatizaciones (flujos de nodos). Solo el superadmin las crea, prueba y publica."""
import json
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field, field_validator

from core import ia
from core.automatizaciones import PLANTILLAS, problemas, simular
from core.db import abrir_db
from core.secretos import clave_ok, guardar
from core.seguridad import auditar, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/crm/automatizaciones", tags=["crm-automatizaciones"], dependencies=[Depends(solo_superadmin)])
BASE_VACIA = {"nodos": [{"id": "n1", "tipo": "disparador", "x": 40, "y": 120, "config": {"evento": "mensaje_entrante", "repetir_horas": 24}}], "conexiones": []}


class NodoIn(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{0,19}$")
    tipo: Literal["disparador", "mensaje", "plantilla", "ia", "esperar", "esperar_respuesta", "condicion", "asignar", "etapa", "nota", "tarea", "fin", "archivo", "botones"]
    x: float = Field(ge=-5000, le=30000)
    y: float = Field(ge=-5000, le=30000)
    config: dict = Field(default_factory=dict)

    @field_validator("config")
    @classmethod
    def _tamano(cls, v: dict) -> dict:
        if len(json.dumps(v)) > 6000:
            raise ValueError("La configuración de un paso es demasiado grande")
        return v


class ConexionIn(BaseModel):
    de: str = Field(max_length=20)
    salida: str = Field(max_length=20)
    a: str = Field(max_length=20)


class DefinicionIn(BaseModel):
    nodos: list[NodoIn] = Field(default_factory=list, max_length=60)
    conexiones: list[ConexionIn] = Field(default_factory=list, max_length=150)


class FlujoIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=80)
    canal: Literal["whatsapp", "facebook", "instagram"]
    canal_id: int | None = None
    definicion: DefinicionIn | None = None
    plantilla: str | None = Field(default=None, max_length=30)


class PruebaIn(BaseModel):
    mensaje: str = Field(default="Hola", max_length=500)
    respuesta: str = Field(default="", max_length=500)
    sin_respuesta: bool = False


class IaIn(BaseModel):
    proveedor: Literal["gemini", "groq", "openrouter", "anthropic"]
    modelo: str = Field(min_length=3, max_length=80, pattern=r"^[A-Za-z0-9._:/-]+$")
    clave: str = Field(default="", max_length=300)
    instrucciones: str = Field(default="", max_length=3000)
    max_dia: int = Field(ge=10, le=5000)


def _flujo(con, fid: int):
    f = con.execute("SELECT id, nombre, canal, canal_id, estado, definicion, publicada, version FROM crm_flujos WHERE id=?", (fid,)).fetchone()
    if not f:
        raise HTTPException(404, "Flujo no encontrado")
    return f


def _validar_canal_id(con, canal: str, canal_id: int | None) -> None:
    if canal_id is not None and not con.execute(
            "SELECT 1 FROM crm_canales WHERE id=? AND tipo=? AND estado <> 'desconectado'", (canal_id, canal)).fetchone():
        raise HTTPException(400, "Ese número o cuenta no está conectado.")


# ---- Catálogo y listado ----
@router.get("/plantillas")
def plantillas():
    return [{"id": p["id"], "nombre": p["nombre"], "descripcion": p["descripcion"]} for p in PLANTILLAS]


@router.get("")
def listar():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT f.id, f.nombre, f.canal, f.canal_id, f.estado, f.version, f.publicado_en, f.actualizado_en, f.definicion, f.publicada, "
            "(SELECT COUNT(*) FROM crm_flujo_ejecuciones e WHERE e.flujo_id=f.id AND e.estado IN ('activa','procesando','esperando','esperando_respuesta')) AS en_curso, "
            "(SELECT COUNT(*) FROM crm_flujo_ejecuciones e WHERE e.flujo_id=f.id AND e.creado_en > now() - interval '7 days') AS ultimos7 "
            "FROM crm_flujos f ORDER BY f.id DESC").fetchall()
    finally:
        con.close()
    out = []
    for f in filas:
        disp = next((n for n in f["definicion"].get("nodos", []) if n["tipo"] == "disparador"), None)
        out.append({"id": f["id"], "nombre": f["nombre"], "canal": f["canal"], "canal_id": f["canal_id"], "estado": f["estado"],
                    "version": f["version"], "publicado_en": f["publicado_en"], "actualizado_en": f["actualizado_en"],
                    "evento": ((disp or {}).get("config") or {}).get("evento", ""), "en_curso": f["en_curso"], "ultimos7": f["ultimos7"],
                    "cambios_sin_publicar": f["estado"] == "publicado" and f["definicion"] != f["publicada"]})
    return out


# ---- Asistente de IA ----
@router.get("/ia/config")
def ia_config():
    c = ia.config()
    return {"proveedor": c["proveedor"], "modelo": c["modelo"], "clave_guardada": bool(c["clave"]), "instrucciones": c["instrucciones"],
            "max_dia": c["max_dia"], "proveedores": [{"id": k, **{x: v[x] for x in ("nombre", "modelo", "gratis", "url_clave")}} for k, v in ia.PROVEEDORES.items()]}


@router.put("/ia/config")
def ia_guardar(d: IaIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar credenciales de forma segura.")
    if d.clave.strip() and re.search(r"\s", d.clave.strip()):
        raise HTTPException(400, "La clave no debe tener espacios. Cópiala de nuevo.")
    guardar("ia_proveedor", d.proveedor)
    guardar("ia_modelo", d.modelo)
    guardar("ia_instrucciones", d.instrucciones.strip() or "-")
    guardar("ia_max_dia", str(d.max_dia))
    if d.clave.strip():
        guardar("ia_clave", d.clave.strip())
    auditar("ia_config", yo["usuario"], ip_cliente(request), f"proveedor {d.proveedor}")
    return {"ok": True}


@router.post("/ia/probar")
def ia_probar():
    try:
        texto, _ = ia.responder("", [("user", "Responde únicamente con la palabra OK.")], "")
    except ia.ErrorIA as e:
        raise HTTPException(400, str(e))
    return {"ok": True, "detalle": f"La IA respondió: «{texto[:80]}»"}


class IaModelosIn(BaseModel):
    proveedor: Literal["gemini", "groq", "openrouter", "anthropic"]
    clave: str = Field(default="", max_length=300)


@router.post("/ia/modelos")
def ia_modelos(d: IaModelosIn):
    """Lista los modelos que puede usar la clave (la que escribiste o, si la dejas vacía, la guardada)."""
    try:
        return {"modelos": ia.listar_modelos(d.proveedor, d.clave.strip())}
    except ia.ErrorIA as e:
        raise HTTPException(400, str(e))


@router.get("/ejecuciones/{eid}/registros")
def registros(eid: int):
    con = abrir_db()
    try:
        filas = con.execute("SELECT nodo_id, tipo, salida, detalle, creado_en FROM crm_flujo_registros WHERE ejecucion_id=? ORDER BY id", (eid,)).fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


# ---- Flujos ----
@router.post("")
def crear(d: FlujoIn, request: Request, yo: dict = Depends(solo_superadmin)):
    if d.plantilla:
        p = next((x for x in PLANTILLAS if x["id"] == d.plantilla), None)
        if not p:
            raise HTTPException(400, "Esa plantilla no existe")
        defn = json.loads(json.dumps(p["definicion"]))
    else:
        defn = d.definicion.model_dump() if d.definicion else BASE_VACIA
    errores = problemas(defn, d.canal, False)
    if errores:
        raise HTTPException(400, " ".join(errores))
    con = abrir_db()
    try:
        _validar_canal_id(con, d.canal, d.canal_id)
        fid = con.execute("INSERT INTO crm_flujos (nombre, canal, canal_id, definicion, creado_por) VALUES (?,?,?,?::jsonb,?) RETURNING id",
                          (d.nombre.strip(), d.canal, d.canal_id, json.dumps(defn), yo["usuario"])).fetchone()[0]
    finally:
        con.close()
    auditar("flujo_creado", yo["usuario"], ip_cliente(request), f"{d.nombre} ({d.canal})")
    return {"id": fid}


@router.get("/{fid}")
def detalle(fid: int):
    con = abrir_db()
    try:
        f = _flujo(con, fid)
    finally:
        con.close()
    return {"id": f["id"], "nombre": f["nombre"], "canal": f["canal"], "canal_id": f["canal_id"], "estado": f["estado"], "definicion": f["definicion"]}


@router.put("/{fid}")
def guardar_borrador(fid: int, d: FlujoIn, request: Request, yo: dict = Depends(solo_superadmin)):
    """Guarda el borrador. Lo que está publicado no cambia hasta que se publique de nuevo."""
    if d.definicion is None:
        raise HTTPException(400, "Falta la definición del flujo")
    defn = d.definicion.model_dump()
    errores = problemas(defn, d.canal, False)
    if errores:
        raise HTTPException(400, " ".join(errores))
    con = abrir_db()
    try:
        f = _flujo(con, fid)
        if f["estado"] == "publicado" and f["canal"] != d.canal:
            raise HTTPException(400, "No se puede cambiar el canal de un flujo publicado. Páusalo primero.")
        _validar_canal_id(con, d.canal, d.canal_id)
        con.execute("UPDATE crm_flujos SET nombre=?, canal=?, canal_id=?, definicion=?::jsonb, actualizado_en=now() WHERE id=?",
                    (d.nombre.strip(), d.canal, d.canal_id, json.dumps(defn), fid))
    finally:
        con.close()
    auditar("flujo_editado", yo["usuario"], ip_cliente(request), f"flujo {fid}")
    return {"ok": True}


@router.post("/{fid}/publicar")
def publicar(fid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        f = _flujo(con, fid)
        errores = problemas(f["definicion"], f["canal"], True)
        if errores:
            raise HTTPException(400, " ".join(errores))
        con.execute("UPDATE crm_flujos SET publicada=definicion, estado='publicado', version=version+1, publicado_en=now() WHERE id=?", (fid,))
    finally:
        con.close()
    auditar("flujo_publicado", yo["usuario"], ip_cliente(request), f"flujo {fid}")
    return {"ok": True}


@router.post("/{fid}/pausar")
def pausar(fid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    """Deja de activarse y cancela lo que estaba en curso o esperando."""
    con = abrir_db()
    try:
        _flujo(con, fid)
        con.execute("UPDATE crm_flujos SET estado='borrador' WHERE id=?", (fid,))
        con.execute("UPDATE crm_flujo_ejecuciones SET estado='cancelada', error='El flujo se pausó', siguiente_en=NULL, actualizado_en=now() "
                    "WHERE flujo_id=? AND estado IN ('activa','esperando','esperando_respuesta')", (fid,))
    finally:
        con.close()
    auditar("flujo_pausado", yo["usuario"], ip_cliente(request), f"flujo {fid}")
    return {"ok": True}


@router.delete("/{fid}")
def borrar(fid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        f = _flujo(con, fid)
        con.execute("DELETE FROM crm_flujos WHERE id=?", (fid,))
    finally:
        con.close()
    auditar("flujo_borrado", yo["usuario"], ip_cliente(request), f["nombre"])
    return {"ok": True}


@router.post("/{fid}/probar")
def probar(fid: int, d: PruebaIn):
    """Recorre el borrador sin enviar nada: así se prueba antes de publicar."""
    con = abrir_db()
    try:
        f = _flujo(con, fid)
    finally:
        con.close()
    return simular(f["definicion"], f["canal"], d.mensaje, d.respuesta, d.sin_respuesta)


@router.get("/{fid}/ejecuciones")
def ejecuciones(fid: int):
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT e.id, e.estado, e.error, e.creado_en, e.actualizado_en, e.nodo_actual, l.id AS lead_id, l.nombre "
            "FROM crm_flujo_ejecuciones e JOIN crm_leads l ON l.id = e.lead_id WHERE e.flujo_id=? ORDER BY e.id DESC LIMIT 50", (fid,)).fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]