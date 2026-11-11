from typing import Literal

from fastapi import APIRouter, Depends, File, HTTPException, Request, UploadFile
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.media import borrar_de_disco, embed_de, guardar_subida
from core.seguridad import auditar, ip_cliente, solo_superadmin

router = APIRouter(prefix="/api/aprende/admin", tags=["aprende-admin"], dependencies=[Depends(solo_superadmin)])

Modulo = Literal["perucompras", "menor", "mayor"]
Nivel = Literal["todos", "basico", "intermedio", "avanzado"]
Tipo = Literal["video", "audio", "documento", "imagen", "texto"]

SQL_RESUMEN = """
SELECT c.id, c.modulo, c.titulo, c.subtitulo, c.nivel, c.instructor, c.portada_id,
       c.publicado, c.publico, c.destacado, c.orden,
  (SELECT COUNT(*) FROM curso_secciones s WHERE s.curso_id = c.id) AS n_secciones,
  (SELECT COUNT(*) FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id WHERE s.curso_id = c.id) AS n_lecciones,
  (SELECT COALESCE(SUM(l.duracion_seg), 0) FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id WHERE s.curso_id = c.id) AS duracion_seg
FROM cursos c
"""


def _flags(f) -> dict:
    return {**dict(f), "publicado": bool(f["publicado"]), "publico": bool(f["publico"]), "destacado": bool(f["destacado"])}


def _siguiente(con, tabla: str, donde: str = "", args: tuple = ()) -> int:
    return con.execute(f"SELECT COALESCE(MAX(orden), 0) + 1 FROM {tabla} {donde}", args).fetchone()[0]


def _ordenar(con, tabla: str, ids: list[int]) -> None:
    for i, _id in enumerate(ids, start=1):  # 'tabla' siempre es una constante interna
        con.execute(f"UPDATE {tabla} SET orden=? WHERE id=?", (i, _id))


def _limpiar_archivos(con, ids) -> None:
    """Borra de la base y del disco los archivos que ya no usa ninguna lección ni portada."""
    for aid in {i for i in ids if i}:
        if con.execute(
                "SELECT 1 FROM lecciones WHERE archivo_id=? UNION ALL SELECT 1 FROM cursos WHERE portada_id=? LIMIT 1",
                (aid, aid)).fetchone():
            continue
        r = con.execute("DELETE FROM archivos_aprende WHERE id=? RETURNING ruta", (aid,)).fetchone()
        if r:
            borrar_de_disco(r["ruta"])


def _barrer(con) -> None:
    """Quita archivos subidos hace más de un día que nunca se usaron."""
    ids = [r["id"] for r in con.execute(
        "SELECT id FROM archivos_aprende a WHERE creado_en < now() - interval '1 day' "
        "AND NOT EXISTS (SELECT 1 FROM lecciones WHERE archivo_id = a.id) "
        "AND NOT EXISTS (SELECT 1 FROM cursos WHERE portada_id = a.id)").fetchall()]
    _limpiar_archivos(con, ids)


class OrdenIn(BaseModel):
    ids: list[int] = Field(min_length=1, max_length=500)


class TituloIn(BaseModel):
    titulo: str = Field(min_length=2, max_length=160)


class CursoNuevo(BaseModel):
    titulo: str = Field(min_length=3, max_length=160)
    modulo: Modulo | None = None


class CursoPatch(BaseModel):
    titulo: str | None = Field(default=None, min_length=3, max_length=160)
    subtitulo: str | None = Field(default=None, max_length=200)
    descripcion: str | None = Field(default=None, max_length=4000)
    instructor: str | None = Field(default=None, max_length=120)
    nivel: Nivel | None = None
    modulo: Modulo | None = None
    sin_modulo: bool = False
    publicado: bool | None = None
    publico: bool | None = None
    destacado: bool | None = None
    portada_id: int | None = None
    sin_portada: bool = False


class PlanesIn(BaseModel):
    plan_ids: list[int] = Field(default_factory=list, max_length=50)


class LeccionIn(BaseModel):
    titulo: str = Field(min_length=2, max_length=160)
    tipo: Tipo
    archivo_id: int | None = None
    url_externa: str | None = Field(default=None, max_length=500)
    contenido: str = Field(default="", max_length=20000)
    duracion_seg: int = Field(default=0, ge=0, le=86400)
    vista_previa: bool = False


def _validar_leccion(con, d: LeccionIn) -> tuple[int | None, str | None, str]:
    if d.tipo == "texto":
        if not d.contenido.strip():
            raise HTTPException(400, "Escribe el contenido de la lección")
        return None, None, d.contenido.strip()
    url = (d.url_externa or "").strip() or None
    if d.tipo == "video" and url and d.archivo_id is None:
        if not embed_de(url):
            raise HTTPException(400, "El enlace debe ser de YouTube, Vimeo o un archivo .mp4/.webm con https")
        return None, url, ""
    if d.archivo_id is None:
        raise HTTPException(400, "Sube un archivo para esta lección")
    r = con.execute("SELECT categoria FROM archivos_aprende WHERE id=?", (d.archivo_id,)).fetchone()
    if not r or r["categoria"] != d.tipo:
        raise HTTPException(400, "El archivo no corresponde al tipo de lección")
    return d.archivo_id, None, ""


# ======================= CURSOS =======================
@router.get("/cursos")
def cursos():
    con = abrir_db()
    try:
        return [_flags(f) for f in con.execute(SQL_RESUMEN + " ORDER BY c.orden, c.id").fetchall()]
    finally:
        con.close()


@router.post("/cursos/orden")
def ordenar_cursos(d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "cursos", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.get("/cursos/{cid}")
def curso(cid: int):
    con = abrir_db()
    try:
        c = con.execute(
            "SELECT id, modulo, titulo, subtitulo, descripcion, nivel, instructor, portada_id, publicado, publico, "
            "destacado, orden FROM cursos WHERE id=?", (cid,)).fetchone()
        if not c:
            raise HTTPException(404, "Curso no encontrado")
        plan_ids = [r["plan_id"] for r in con.execute(
            "SELECT plan_id FROM curso_planes WHERE curso_id=? ORDER BY plan_id", (cid,)).fetchall()]
        secs = con.execute(
            "SELECT id, titulo, orden FROM curso_secciones WHERE curso_id=? ORDER BY orden, id", (cid,)).fetchall()
        lecs = con.execute(
            "SELECT l.id, l.seccion_id, l.titulo, l.tipo, l.archivo_id, a.nombre AS archivo_nombre, l.url_externa, "
            "l.contenido, l.duracion_seg, l.vista_previa, l.orden FROM lecciones l "
            "JOIN curso_secciones s ON s.id = l.seccion_id LEFT JOIN archivos_aprende a ON a.id = l.archivo_id "
            "WHERE s.curso_id=? ORDER BY l.orden, l.id", (cid,)).fetchall()
    finally:
        con.close()
    por: dict[int, list[dict]] = {}
    for l in lecs:
        por.setdefault(l["seccion_id"], []).append({**dict(l), "vista_previa": bool(l["vista_previa"])})
    return {**_flags(c), "plan_ids": plan_ids,
            "secciones": [{**dict(s), "lecciones": por.get(s["id"], [])} for s in secs]}


@router.post("/cursos")
def crear_curso(d: CursoNuevo, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        cid = con.execute(
            "INSERT INTO cursos (modulo, titulo, orden) VALUES (?,?,?) RETURNING id",
            (d.modulo, d.titulo.strip(), _siguiente(con, "cursos"))).fetchone()[0]
    finally:
        con.close()
    auditar("curso_creado", yo["usuario"], ip_cliente(request), d.titulo)
    return {"id": cid}


@router.patch("/cursos/{cid}")
def editar_curso(cid: int, d: CursoPatch, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        actual = con.execute("SELECT portada_id FROM cursos WHERE id=?", (cid,)).fetchone()
        if not actual:
            raise HTTPException(404, "Curso no encontrado")
        sets, args = [], []
        for campo in ("titulo", "subtitulo", "descripcion", "instructor"):
            v = getattr(d, campo)
            if v is not None:
                sets.append(f"{campo}=?"); args.append(v.strip())
        if d.nivel is not None:
            sets.append("nivel=?"); args.append(d.nivel)
        if d.sin_modulo:
            sets.append("modulo=NULL")
        elif d.modulo is not None:
            sets.append("modulo=?"); args.append(d.modulo)
        if d.publicado:
            n = con.execute(
                "SELECT COUNT(*) FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id WHERE s.curso_id=?",
                (cid,)).fetchone()[0]
            if n == 0:
                raise HTTPException(400, "Agrega al menos una lección antes de publicar el curso")
        for campo in ("publicado", "publico", "destacado"):
            v = getattr(d, campo)
            if v is not None:
                sets.append(f"{campo}=?"); args.append(1 if v else 0)
        if d.sin_portada:
            sets.append("portada_id=NULL")
        elif d.portada_id is not None:
            r = con.execute("SELECT categoria FROM archivos_aprende WHERE id=?", (d.portada_id,)).fetchone()
            if not r or r["categoria"] != "imagen":
                raise HTTPException(400, "La portada debe ser una imagen")
            sets.append("portada_id=?"); args.append(d.portada_id)
        if not sets:
            raise HTTPException(400, "Nada que cambiar")
        con.execute(f"UPDATE cursos SET {', '.join(sets)} WHERE id=?", args + [cid])
        _limpiar_archivos(con, [actual["portada_id"]])
    finally:
        con.close()
    auditar("curso_editado", yo["usuario"], ip_cliente(request), f"curso {cid}: {[s.split('=')[0] for s in sets]}")
    return {"ok": True}


@router.delete("/cursos/{cid}")
def borrar_curso(cid: int, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        ids = [r["archivo_id"] for r in con.execute(
            "SELECT l.archivo_id FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id "
            "WHERE s.curso_id=? AND l.archivo_id IS NOT NULL", (cid,)).fetchall()]
        p = con.execute("SELECT portada_id FROM cursos WHERE id=?", (cid,)).fetchone()
        r = con.execute("DELETE FROM cursos WHERE id=? RETURNING titulo", (cid,)).fetchone()
        if not r:
            raise HTTPException(404, "Curso no encontrado")
        _limpiar_archivos(con, ids + [p["portada_id"]])
    finally:
        con.close()
    auditar("curso_eliminado", yo["usuario"], ip_cliente(request), r["titulo"])
    return {"ok": True}


@router.put("/cursos/{cid}/planes")
def fijar_planes(cid: int, d: PlanesIn):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM cursos WHERE id=?", (cid,)).fetchone():
            raise HTTPException(404, "Curso no encontrado")
        validos = [r["id"] for r in con.execute(
            "SELECT id FROM planes WHERE id = ANY(?)", (d.plan_ids,)).fetchall()] if d.plan_ids else []
        con.execute("DELETE FROM curso_planes WHERE curso_id=?", (cid,))
        for pid in validos:
            con.execute("INSERT INTO curso_planes (curso_id, plan_id) VALUES (?,?)", (cid, pid))
    finally:
        con.close()
    return {"ok": True}


# ======================= SECCIONES =======================
@router.post("/cursos/{cid}/secciones/orden")
def ordenar_secciones(cid: int, d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "curso_secciones", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.post("/cursos/{cid}/secciones")
def crear_seccion(cid: int, d: TituloIn):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM cursos WHERE id=?", (cid,)).fetchone():
            raise HTTPException(404, "Curso no encontrado")
        sid = con.execute(
            "INSERT INTO curso_secciones (curso_id, titulo, orden) VALUES (?,?,?) RETURNING id",
            (cid, d.titulo.strip(), _siguiente(con, "curso_secciones", "WHERE curso_id=?", (cid,)))).fetchone()[0]
    finally:
        con.close()
    return {"id": sid}


@router.patch("/secciones/{sid}")
def renombrar_seccion(sid: int, d: TituloIn):
    con = abrir_db()
    try:
        r = con.execute("UPDATE curso_secciones SET titulo=? WHERE id=? RETURNING id", (d.titulo.strip(), sid)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Sección no encontrada")
    return {"ok": True}


@router.delete("/secciones/{sid}")
def borrar_seccion(sid: int):
    con = abrir_db()
    try:
        ids = [r["archivo_id"] for r in con.execute(
            "SELECT archivo_id FROM lecciones WHERE seccion_id=? AND archivo_id IS NOT NULL", (sid,)).fetchall()]
        r = con.execute("DELETE FROM curso_secciones WHERE id=? RETURNING id", (sid,)).fetchone()
        if not r:
            raise HTTPException(404, "Sección no encontrada")
        _limpiar_archivos(con, ids)
    finally:
        con.close()
    return {"ok": True}


# ======================= LECCIONES =======================
@router.post("/secciones/{sid}/lecciones/orden")
def ordenar_lecciones(sid: int, d: OrdenIn):
    con = abrir_db()
    try:
        _ordenar(con, "lecciones", d.ids)
    finally:
        con.close()
    return {"ok": True}


@router.post("/secciones/{sid}/lecciones")
def crear_leccion(sid: int, d: LeccionIn):
    con = abrir_db()
    try:
        if not con.execute("SELECT 1 FROM curso_secciones WHERE id=?", (sid,)).fetchone():
            raise HTTPException(404, "Sección no encontrada")
        archivo_id, url, contenido = _validar_leccion(con, d)
        lid = con.execute(
            "INSERT INTO lecciones (seccion_id, titulo, tipo, archivo_id, url_externa, contenido, duracion_seg, vista_previa, orden) "
            "VALUES (?,?,?,?,?,?,?,?,?) RETURNING id",
            (sid, d.titulo.strip(), d.tipo, archivo_id, url, contenido, d.duracion_seg, 1 if d.vista_previa else 0,
             _siguiente(con, "lecciones", "WHERE seccion_id=?", (sid,)))).fetchone()[0]
    finally:
        con.close()
    return {"id": lid}


@router.put("/lecciones/{lid}")
def editar_leccion(lid: int, d: LeccionIn):
    con = abrir_db()
    try:
        actual = con.execute("SELECT archivo_id FROM lecciones WHERE id=?", (lid,)).fetchone()
        if not actual:
            raise HTTPException(404, "Lección no encontrada")
        archivo_id, url, contenido = _validar_leccion(con, d)
        con.execute(
            "UPDATE lecciones SET titulo=?, tipo=?, archivo_id=?, url_externa=?, contenido=?, duracion_seg=?, vista_previa=? WHERE id=?",
            (d.titulo.strip(), d.tipo, archivo_id, url, contenido, d.duracion_seg, 1 if d.vista_previa else 0, lid))
        _limpiar_archivos(con, [actual["archivo_id"]])
    finally:
        con.close()
    return {"ok": True}


@router.delete("/lecciones/{lid}")
def borrar_leccion(lid: int):
    con = abrir_db()
    try:
        r = con.execute("DELETE FROM lecciones WHERE id=? RETURNING archivo_id", (lid,)).fetchone()
        if not r:
            raise HTTPException(404, "Lección no encontrada")
        _limpiar_archivos(con, [r["archivo_id"]])
    finally:
        con.close()
    return {"ok": True}


# ======================= ARCHIVOS =======================
@router.post("/archivos")
async def subir(request: Request, archivo: UploadFile = File(...), yo: dict = Depends(solo_superadmin)):
    info = await guardar_subida(archivo)
    con = abrir_db()
    try:
        _barrer(con)
        aid = con.execute(
            "INSERT INTO archivos_aprende (nombre, ruta, mime, categoria, tamano) VALUES (?,?,?,?,?) RETURNING id",
            (info["nombre"], info["ruta"], info["mime"], info["categoria"], info["tamano"])).fetchone()[0]
    except Exception:
        borrar_de_disco(info["ruta"])
        raise
    finally:
        con.close()
    auditar("archivo_subido", yo["usuario"], ip_cliente(request), f"{info['nombre']} ({info['tamano']} bytes)")
    return {"id": aid, "nombre": info["nombre"], "categoria": info["categoria"], "tamano": info["tamano"]}