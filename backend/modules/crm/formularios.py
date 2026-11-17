"""Formularios web configurables: el superadmin define los campos y cada envío crea (o actualiza) un lead en el CRM."""
import json
import logging
import os
import re
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.crm import avisar_lead, captar_lead, contacto_valido, registrar
from core.db import abrir_db
from core.limites import limitar
from core.ordenes import avisar_ventas
from core.seguridad import auditar, ip_cliente, solo_superadmin

logger = logging.getLogger("formularios")

router_admin = APIRouter(prefix="/api/crm/formularios", tags=["crm-formularios"], dependencies=[Depends(solo_superadmin)])
router_publico = APIRouter(prefix="/api/publico/formularios", tags=["formularios-publicos"])

# Qué tipos de campo admite cada dato del lead
TIPOS_POR_DESTINO = {
    "nombre": ("texto",), "telefono": ("telefono",), "correo": ("correo",), "valor": ("numero",),
    "empresa": ("texto", "lista"), "interes": ("texto", "lista"),
}


class CampoIn(BaseModel):
    id: str = Field(pattern=r"^[a-z][a-z0-9_]{1,29}$")
    tipo: Literal["texto", "telefono", "correo", "numero", "area", "lista", "casilla"]
    etiqueta: str = Field(min_length=1, max_length=80)
    requerido: bool = False
    destino: Literal["nombre", "telefono", "correo", "empresa", "interes", "valor", "nota"] = "nota"
    opciones: list[str] = Field(default_factory=list, max_length=20)
    ayuda: str = Field(default="", max_length=120)


class FormularioIn(BaseModel):
    slug: str = Field(pattern=r"^[a-z0-9][a-z0-9-]{2,39}$")
    nombre: str = Field(min_length=2, max_length=80)
    titulo: str = Field(default="", max_length=120)
    descripcion: str = Field(default="", max_length=300)
    boton: str = Field(default="Enviar", min_length=1, max_length=30)
    exito_titulo: str = Field(default="¡Gracias, te contactaremos pronto!", max_length=120)
    exito_mensaje: str = Field(default="Recibimos tus datos. Un ejecutivo de ventas se comunicará contigo.", max_length=300)
    origen: str = Field(default="web", pattern=r"^[a-z]{3,20}$")
    ejecutivo_id: int | None = None
    activo: bool = True
    campos: list[CampoIn] = Field(min_length=2, max_length=20)


class EnvioIn(BaseModel):
    valores: dict[str, str | bool | None] = Field(default_factory=dict, max_length=30)
    acepto_privacidad: bool
    origen: str = Field(default="", max_length=20)
    sitio: str = Field(default="", max_length=200)  # trampa para bots: una persona nunca lo llena


def _campo(c: dict) -> dict:
    """Completa lo que falte (los formularios sembrados traen menos claves)."""
    return {"requerido": False, "opciones": [], "ayuda": "", "destino": "nota", **c}


def _fila(f) -> dict:
    d = dict(f)
    d["activo"] = bool(d["activo"])
    d["campos"] = [_campo(c) for c in d["campos"]]
    d["url"] = f"{os.getenv('FRONTEND_URL', '').rstrip('/')}/f/{d['slug']}"
    return d


def _preparar(d: FormularioIn) -> list[dict]:
    """Valida el diseño del formulario y devuelve los campos listos para guardar."""
    ids = [c.id for c in d.campos]
    if len(set(ids)) != len(ids):
        raise HTTPException(400, "Hay dos campos con el mismo identificador")
    usados = [c.destino for c in d.campos if c.destino != "nota"]
    if len(set(usados)) != len(usados):
        raise HTTPException(
            400, "Cada dato del lead (nombre, teléfono, correo, empresa, interés, valor) solo puede usarse en un campo")
    if "nombre" not in usados:
        raise HTTPException(400, "Falta un campo que se guarde como «Nombre del lead»")
    if "telefono" not in usados and "correo" not in usados:
        raise HTTPException(400, "Agrega un campo de teléfono o de correo para poder contactar al lead")
    for c in d.campos:
        c.etiqueta = c.etiqueta.strip()
        c.ayuda = c.ayuda.strip()
        c.opciones = [o.strip()[:80] for o in c.opciones if o.strip()]
        if not c.etiqueta:
            raise HTTPException(400, "Todos los campos necesitan un título")
        permitidos = TIPOS_POR_DESTINO.get(c.destino)
        if permitidos and c.tipo not in permitidos:
            raise HTTPException(400, f"El campo «{c.etiqueta}» no puede guardarse como «{c.destino}» con ese tipo")
        if c.tipo == "lista" and len(c.opciones) < 2:
            raise HTTPException(400, f"El campo «{c.etiqueta}» necesita al menos 2 opciones")
        if c.destino == "nombre":
            c.requerido = True
    return [c.model_dump() for c in d.campos]


def _validar_ejecutivo(con, eid: int | None) -> None:
    if eid is not None and not con.execute("SELECT 1 FROM ejecutivos WHERE id=? AND activo=1", (eid,)).fetchone():
        raise HTTPException(400, "El ejecutivo elegido no está disponible")


# ======================= ADMINISTRACIÓN (solo superadmin) =======================
@router_admin.get("")
def listar():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT id, slug, nombre, titulo, descripcion, boton, exito_titulo, exito_mensaje, origen, ejecutivo_id, "
            "activo, campos FROM crm_formularios ORDER BY id").fetchall()
    finally:
        con.close()
    return [_fila(f) for f in filas]


@router_admin.post("")
def crear(d: FormularioIn, request: Request, yo: dict = Depends(solo_superadmin)):
    campos = _preparar(d)
    con = abrir_db()
    try:
        if con.execute("SELECT 1 FROM crm_formularios WHERE slug=?", (d.slug,)).fetchone():
            raise HTTPException(409, "Ya existe un formulario con esa dirección. Cambia el nombre corto.")
        _validar_ejecutivo(con, d.ejecutivo_id)
        fid = con.execute(
            "INSERT INTO crm_formularios (slug, nombre, titulo, descripcion, boton, exito_titulo, exito_mensaje, origen, "
            "ejecutivo_id, activo, campos) VALUES (?,?,?,?,?,?,?,?,?,?,?::jsonb) RETURNING id",
            (d.slug, d.nombre.strip(), d.titulo.strip(), d.descripcion.strip(), d.boton.strip(), d.exito_titulo.strip(),
             d.exito_mensaje.strip(), d.origen, d.ejecutivo_id, 1 if d.activo else 0, json.dumps(campos))).fetchone()[0]
    finally:
        con.close()
    auditar("formulario_creado", yo["usuario"], ip_cliente(request), d.slug)
    return {"id": fid}


@router_admin.put("/{fid}")
def guardar(fid: int, d: FormularioIn, request: Request, yo: dict = Depends(solo_superadmin)):
    """Actualiza todo menos la dirección (slug): cambiarla rompería los enlaces que ya compartiste."""
    campos = _preparar(d)
    con = abrir_db()
    try:
        _validar_ejecutivo(con, d.ejecutivo_id)
        r = con.execute(
            "UPDATE crm_formularios SET nombre=?, titulo=?, descripcion=?, boton=?, exito_titulo=?, exito_mensaje=?, "
            "origen=?, ejecutivo_id=?, activo=?, campos=?::jsonb, actualizado_en=now() WHERE id=? RETURNING slug",
            (d.nombre.strip(), d.titulo.strip(), d.descripcion.strip(), d.boton.strip(), d.exito_titulo.strip(),
             d.exito_mensaje.strip(), d.origen, d.ejecutivo_id, 1 if d.activo else 0, json.dumps(campos), fid)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Formulario no encontrado")
    auditar("formulario_editado", yo["usuario"], ip_cliente(request), r["slug"])
    return {"ok": True}


@router_admin.delete("/{fid}")
def borrar(fid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM crm_formularios WHERE id=? RETURNING slug", (fid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Formulario no encontrado")
    auditar("formulario_borrado", yo["usuario"], ip_cliente(request), r["slug"])
    return {"ok": True}


# ======================= PÚBLICO (lo ve el cliente) =======================
@router_publico.get("/{slug}")
def ver(slug: str):
    con = abrir_db()
    try:
        f = con.execute(
            "SELECT slug, nombre, titulo, descripcion, boton, exito_titulo, exito_mensaje, campos "
            "FROM crm_formularios WHERE slug=? AND activo=1", (slug,)).fetchone()
    finally:
        con.close()
    if not f:
        raise HTTPException(404, "Este formulario no está disponible")
    return {
        "slug": f["slug"], "nombre": f["nombre"], "titulo": f["titulo"] or f["nombre"], "descripcion": f["descripcion"],
        "boton": f["boton"], "exito_titulo": f["exito_titulo"], "exito_mensaje": f["exito_mensaje"],
        "campos": [{k: v for k, v in _campo(c).items() if k != "destino"} for c in f["campos"]],  # el cliente no ve a dónde va cada dato
    }


def _leer_valores(campos: list[dict], valores: dict) -> tuple[dict[str, str], list[tuple[str, str]]]:
    """Valida lo que envió el cliente contra el diseño del formulario. Devuelve (datos del lead, notas)."""
    datos: dict[str, str] = {}
    notas: list[tuple[str, str]] = []
    for c in map(_campo, campos):
        crudo = valores.get(c["id"])
        etiqueta = c["etiqueta"]
        if c["tipo"] == "casilla":
            marcado = crudo is True or str(crudo).strip().lower() in ("true", "si", "sí", "1")
            if c["requerido"] and not marcado:
                raise HTTPException(400, f"Debes marcar «{etiqueta}»")
            if marcado:
                notas.append((etiqueta, "Sí"))
            continue
        v = ("" if crudo is None else str(crudo)).strip()
        if len(v) > (1000 if c["tipo"] == "area" else 200):
            raise HTTPException(400, f"«{etiqueta}» es demasiado largo")
        if not v:
            if c["requerido"]:
                raise HTTPException(400, f"Completa «{etiqueta}»")
            continue
        if c["tipo"] == "lista" and v not in [o.strip() for o in c["opciones"]]:
            raise HTTPException(400, f"Elige una opción válida en «{etiqueta}»")
        if c["tipo"] == "numero":
            v = v.replace(",", ".")
            try:
                float(v)
            except ValueError:
                raise HTTPException(400, f"«{etiqueta}» debe ser un número")
        if c["destino"] == "nota":
            notas.append((etiqueta, v))
        else:
            datos[c["destino"]] = v
    return datos, notas


@router_publico.post("/{slug}")
def enviar(slug: str, d: EnvioIn, request: Request):
    ip = ip_cliente(request)
    limitar(f"formweb|{ip}", 6, 600)  # máximo 6 envíos por IP cada 10 minutos
    if d.sitio.strip():
        return {"ok": True}  # es un bot: se responde "bien" sin guardar nada
    if not d.acepto_privacidad:
        raise HTTPException(400, "Debes aceptar la política de privacidad")
    con = abrir_db()
    try:
        f = con.execute(
            "SELECT nombre, origen, ejecutivo_id, campos FROM crm_formularios WHERE slug=? AND activo=1", (slug,)).fetchone()
        if not f:
            raise HTTPException(404, "Este formulario no está disponible")
        datos, notas = _leer_valores(f["campos"], d.valores)
        nombre = datos.get("nombre", "")
        if len(nombre) < 2:
            raise HTTPException(400, "Escribe tu nombre")
        correo, tel = contacto_valido(datos.get("correo", ""), datos.get("telefono", ""))
        if not correo and not tel:
            raise HTTPException(400, "Escribe un teléfono o un correo para poder contactarte")
        origen = d.origen if re.fullmatch(r"[a-z]{3,20}", d.origen or "") else f["origen"]
        ejecutivo = f["ejecutivo_id"]
        if ejecutivo is not None and not con.execute(
                "SELECT 1 FROM ejecutivos WHERE id=? AND activo=1", (ejecutivo,)).fetchone():
            ejecutivo = None  # si el ejecutivo fijo ya no está activo, se usa el reparto normal
        try:
            valor = min(max(float(datos.get("valor") or 0), 0.0), 10_000_000.0)
        except ValueError:
            valor = 0.0
        form_nombre = f["nombre"]
        lid, creado = captar_lead(
            con, nombre=nombre, correo=correo, telefono=tel, empresa=datos.get("empresa", ""), origen=origen,
            interes=datos.get("interes") or f"Formulario: {form_nombre}", valor=valor,
            creado_por="formulario web", asesor_id=ejecutivo)  # asesor_id = id del ejecutivo
        if notas:
            registrar(con, lid, "nota", f"Respuestas del formulario «{form_nombre}»:\n"
                      + "\n".join(f"- {e}: {v}" for e, v in notas), "formulario web")
    finally:
        con.close()
    avisar_lead(lid)
    try:
        resumen = "\n".join(f"{e}: {v}" for e, v in notas)
        avisar_ventas(
            f"{'Nuevo lead' if creado else 'Lead que volvió a escribir'}: {nombre} ({form_nombre})",
            f"{nombre} · {tel or '-'} · {correo or '-'}\nOrigen: {origen}\n\n{resumen}")
    except Exception:
        logger.exception("No se pudo avisar a ventas del lead %s", lid)
    return {"ok": True}