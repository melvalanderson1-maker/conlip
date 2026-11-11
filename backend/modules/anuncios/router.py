from datetime import datetime
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.seguridad import auditar, ip_cliente, solo_superadmin, usuario_actual

router_admin = APIRouter(prefix="/api/anuncios/admin", tags=["anuncios-admin"], dependencies=[Depends(solo_superadmin)])
router = APIRouter(prefix="/api/anuncios", tags=["anuncios"])
router_publico = APIRouter(prefix="/api/publico", tags=["anuncios-publicos"])

Tipo = Literal["curso", "novedad", "promocion"]
VIGENTE = "a.activo=1 AND (a.vence_en IS NULL OR a.vence_en > now())"


class AnuncioIn(BaseModel):
    tipo: Tipo = "novedad"
    titulo: str = Field(min_length=3, max_length=120)
    mensaje: str = Field(default="", max_length=400)
    curso_id: int | None = None
    para_clientes: bool = True
    para_publico: bool = True
    vence_en: datetime | None = None
    publicar: bool = False


class AnuncioPatch(BaseModel):
    tipo: Tipo | None = None
    titulo: str | None = Field(default=None, min_length=3, max_length=120)
    mensaje: str | None = Field(default=None, max_length=400)
    curso_id: int | None = None
    sin_curso: bool = False
    para_clientes: bool | None = None
    para_publico: bool | None = None
    vence_en: datetime | None = None
    sin_vencimiento: bool = False
    activo: bool | None = None


# ======================= SUPERADMIN =======================
@router_admin.get("")
def listar():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT a.id, a.tipo, a.titulo, a.mensaje, a.curso_id, c.titulo AS curso_titulo, a.para_clientes, "
            "a.para_publico, a.activo, a.publicado_en, a.vence_en, "
            "(a.vence_en IS NOT NULL AND a.vence_en < now()) AS vencido, "
            "(SELECT COUNT(*) FROM anuncios_leidos l WHERE l.anuncio_id = a.id) AS lecturas "
            "FROM anuncios a LEFT JOIN cursos c ON c.id = a.curso_id ORDER BY a.creado_en DESC").fetchall()
    finally:
        con.close()
    return [{**dict(f), "para_clientes": bool(f["para_clientes"]), "para_publico": bool(f["para_publico"]),
             "activo": bool(f["activo"])} for f in filas]


@router_admin.post("")
def crear(d: AnuncioIn, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        if d.curso_id is not None and not con.execute("SELECT 1 FROM cursos WHERE id=?", (d.curso_id,)).fetchone():
            raise HTTPException(404, "Curso no encontrado")
        aid = con.execute(
            "INSERT INTO anuncios (tipo, titulo, mensaje, curso_id, para_clientes, para_publico, vence_en, activo, publicado_en) "
            "VALUES (?,?,?,?,?,?,?,?, CASE WHEN ? THEN now() ELSE NULL END) RETURNING id",
            (d.tipo, d.titulo.strip(), d.mensaje.strip(), d.curso_id, 1 if d.para_clientes else 0,
             1 if d.para_publico else 0, d.vence_en, 1 if d.publicar else 0, d.publicar)).fetchone()[0]
    finally:
        con.close()
    auditar("anuncio_creado", yo["usuario"], ip_cliente(request), d.titulo)
    return {"id": aid}


@router_admin.patch("/{aid}")
def editar(aid: int, d: AnuncioPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        actual = con.execute("SELECT activo FROM anuncios WHERE id=?", (aid,)).fetchone()
        if not actual:
            raise HTTPException(404, "Anuncio no encontrado")
        sets, args = [], []
        for campo in ("titulo", "mensaje"):
            v = getattr(d, campo)
            if v is not None:
                sets.append(f"{campo}=?"); args.append(v.strip())
        if d.tipo is not None:
            sets.append("tipo=?"); args.append(d.tipo)
        if d.sin_curso:
            sets.append("curso_id=NULL")
        elif d.curso_id is not None:
            if not con.execute("SELECT 1 FROM cursos WHERE id=?", (d.curso_id,)).fetchone():
                raise HTTPException(404, "Curso no encontrado")
            sets.append("curso_id=?"); args.append(d.curso_id)
        for campo in ("para_clientes", "para_publico"):
            v = getattr(d, campo)
            if v is not None:
                sets.append(f"{campo}=?"); args.append(1 if v else 0)
        if d.sin_vencimiento:
            sets.append("vence_en=NULL")
        elif d.vence_en is not None:
            sets.append("vence_en=?"); args.append(d.vence_en)
        if d.activo is not None:
            sets.append("activo=?"); args.append(1 if d.activo else 0)
            if d.activo and not actual["activo"]:  # al publicar de nuevo, vuelve a avisar a todos
                sets.append("publicado_en=now()")
        if not sets:
            raise HTTPException(400, "Nada que cambiar")
        con.execute(f"UPDATE anuncios SET {', '.join(sets)} WHERE id=?", args + [aid])
    finally:
        con.close()
    auditar("anuncio_editado", yo["usuario"], ip_cliente(request), f"anuncio {aid}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}


@router_admin.delete("/{aid}")
def borrar(aid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM anuncios WHERE id=? RETURNING titulo", (aid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Anuncio no encontrado")
    auditar("anuncio_eliminado", yo["usuario"], ip_cliente(request), r["titulo"])
    return {"ok": True}


# ======================= USUARIOS CON SESIÓN =======================
@router.get("")
def mis_anuncios(u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT a.id, a.tipo, a.titulo, a.mensaje, a.curso_id, c.modulo AS curso_modulo, a.publicado_en, "
            "(l.usuario_id IS NOT NULL) AS leido FROM anuncios a LEFT JOIN cursos c ON c.id = a.curso_id "
            "LEFT JOIN anuncios_leidos l ON l.anuncio_id = a.id AND l.usuario_id=? "
            f"WHERE {VIGENTE} AND a.para_clientes=1 AND (a.curso_id IS NULL OR c.publicado=1) "
            "ORDER BY a.publicado_en DESC NULLS LAST LIMIT 30", (u["id"],)).fetchall()
    finally:
        con.close()
    items = [{**dict(f), "leido": bool(f["leido"])} for f in filas]
    return {"items": items, "sin_leer": sum(1 for i in items if not i["leido"])}


@router.post("/leer-todos")
def leer_todos(u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        con.execute(
            "INSERT INTO anuncios_leidos (usuario_id, anuncio_id) SELECT ?::int, a.id FROM anuncios a "
            f"WHERE {VIGENTE} AND a.para_clientes=1 ON CONFLICT DO NOTHING", (u["id"],))
    finally:
        con.close()
    return {"ok": True}


@router.post("/{aid}/leer")
def leer(aid: int, u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        con.execute(
            "INSERT INTO anuncios_leidos (usuario_id, anuncio_id) SELECT ?::int, a.id FROM anuncios a "
            "WHERE a.id=? ON CONFLICT DO NOTHING", (u["id"], aid))
    finally:
        con.close()
    return {"ok": True}


# ======================= PORTADA PÚBLICA =======================
@router_publico.get("/anuncios")
def anuncios_publicos():
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT a.id, a.tipo, a.titulo, a.mensaje, a.curso_id, c.modulo AS curso_modulo FROM anuncios a "
            "LEFT JOIN cursos c ON c.id = a.curso_id "
            f"WHERE {VIGENTE} AND a.para_publico=1 AND (a.curso_id IS NULL OR c.publicado=1) "
            "ORDER BY a.publicado_en DESC NULLS LAST LIMIT 3").fetchall()
        return [dict(f) for f in filas]
    finally:
        con.close()