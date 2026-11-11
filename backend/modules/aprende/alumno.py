from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.media import embed_de, firmar, servir_archivo, verificar
from core.seguridad import usuario_actual

router = APIRouter(prefix="/api/aprende", tags=["aprende"])
MODULOS = ("perucompras", "menor", "mayor")


def _activos(con, u: dict) -> set[int]:
    if u["rol"] == "superadmin" or u.get("empresa_id") is None:
        return set()
    return {r["plan_id"] for r in con.execute(
        "SELECT plan_id FROM suscripciones WHERE empresa_id=? AND estado='activa' AND vence_en > now()",
        (u["empresa_id"],)).fetchall()}


def _acceso(u: dict, activos: set[int], modulo: str | None, plan_ids: list[int]) -> bool:
    if u["rol"] == "superadmin":
        return True
    if modulo is not None and f"{modulo}:ver" not in u["permisos"]:
        return False
    if plan_ids:
        return bool(activos & set(plan_ids))
    return True


def _planes_de(con, cid: int) -> list[int]:
    return [r["plan_id"] for r in con.execute("SELECT plan_id FROM curso_planes WHERE curso_id=?", (cid,)).fetchall()]


def _leccion_con_acceso(con, u: dict, lid: int):
    l = con.execute(
        "SELECT l.id, l.titulo, l.tipo, l.contenido, l.url_externa, l.archivo_id, l.duracion_seg, s.curso_id, "
        "c.modulo, c.publicado FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id "
        "JOIN cursos c ON c.id = s.curso_id WHERE l.id=?", (lid,)).fetchone()
    if not l or (not l["publicado"] and u["rol"] != "superadmin"):
        raise HTTPException(404, "Lección no encontrada")
    if not _acceso(u, _activos(con, u), l["modulo"], _planes_de(con, l["curso_id"])):
        raise HTTPException(403, "Tu plan no incluye este curso")
    return l


def _resumen(con, uid: int, cid: int):
    return con.execute(
        "SELECT COUNT(l.id) AS total, COUNT(p.completada_en) AS hechas FROM curso_secciones s "
        "JOIN lecciones l ON l.seccion_id = s.id "
        "LEFT JOIN progreso_lecciones p ON p.leccion_id = l.id AND p.usuario_id=? WHERE s.curso_id=?",
        (uid, cid)).fetchone()


@router.get("/cursos")
def cursos(modulo: str = "", u: dict = Depends(usuario_actual)):
    if modulo and modulo not in MODULOS:
        raise HTTPException(400, "Módulo inválido")
    w = "WHERE c.publicado=1" + (" AND (c.modulo=? OR c.modulo IS NULL)" if modulo else "")
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT c.id, c.modulo, c.titulo, c.subtitulo, c.nivel, c.instructor, (c.portada_id IS NOT NULL) AS portada, "
            f"c.destacado FROM cursos c {w} ORDER BY c.orden, c.id", [modulo] if modulo else []).fetchall()
        ids = [f["id"] for f in filas]
        prog: dict[int, dict] = {}
        planes: dict[int, list[int]] = {}
        if ids:
            for r in con.execute(
                    "SELECT s.curso_id, COUNT(l.id) AS total, COUNT(p.completada_en) AS hechas, "
                    "COALESCE(SUM(l.duracion_seg), 0) AS duracion, "
                    "COALESCE(SUM(CASE WHEN p.completada_en IS NOT NULL THEN l.duracion_seg "
                    "ELSE LEAST(COALESCE(p.posicion_seg, 0), l.duracion_seg) END), 0) AS visto, "
                    "MAX(p.visto_en) AS ultimo "
                    "FROM curso_secciones s JOIN lecciones l ON l.seccion_id = s.id "
                    "LEFT JOIN progreso_lecciones p ON p.leccion_id = l.id AND p.usuario_id=? "
                    "WHERE s.curso_id = ANY(?) GROUP BY s.curso_id", (u["id"], ids)).fetchall():
                prog[r["curso_id"]] = dict(r)
            for r in con.execute("SELECT curso_id, plan_id FROM curso_planes WHERE curso_id = ANY(?)", (ids,)).fetchall():
                planes.setdefault(r["curso_id"], []).append(r["plan_id"])
        activos = _activos(con, u)
    finally:
        con.close()
    out = []
    for f in filas:
        p = prog.get(f["id"], {})
        out.append({
            "id": f["id"], "modulo": f["modulo"], "titulo": f["titulo"], "subtitulo": f["subtitulo"],
            "nivel": f["nivel"], "instructor": f["instructor"], "portada": bool(f["portada"]),
            "destacado": bool(f["destacado"]),
            "acceso": _acceso(u, activos, f["modulo"], planes.get(f["id"], [])),
            "total": p.get("total", 0), "hechas": p.get("hechas", 0),
            "duracion_seg": int(p.get("duracion", 0)), "visto_seg": int(p.get("visto", 0)),
            "ultimo": p.get("ultimo"),
        })
    return out


@router.get("/cursos/{cid}")
def curso(cid: int, u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        c = con.execute(
            "SELECT id, modulo, titulo, subtitulo, descripcion, nivel, instructor, (portada_id IS NOT NULL) AS portada, "
            "publicado FROM cursos WHERE id=?", (cid,)).fetchone()
        if not c or (not c["publicado"] and u["rol"] != "superadmin"):
            raise HTTPException(404, "Curso no encontrado")
        acceso = _acceso(u, _activos(con, u), c["modulo"], _planes_de(con, cid))
        filas = con.execute(
            "SELECT s.id AS sid, s.titulo AS seccion, l.id, l.titulo, l.tipo, l.duracion_seg, p.completada_en, "
            "p.visto_en, p.posicion_seg "
            "FROM curso_secciones s LEFT JOIN lecciones l ON l.seccion_id = s.id "
            "LEFT JOIN progreso_lecciones p ON p.leccion_id = l.id AND p.usuario_id=? "
            "WHERE s.curso_id=? ORDER BY s.orden, s.id, l.orden, l.id", (u["id"], cid)).fetchall()
    finally:
        con.close()
    secciones: list[dict] = []
    mapa: dict[int, dict] = {}
    total = hechas = duracion = visto = 0
    siguiente = ultima = ult_visto = None
    for f in filas:
        if f["sid"] not in mapa:
            mapa[f["sid"]] = {"id": f["sid"], "titulo": f["seccion"], "lecciones": []}
            secciones.append(mapa[f["sid"]])
        if f["id"] is None:
            continue
        hecha = f["completada_en"] is not None
        pos = f["posicion_seg"] or 0
        mapa[f["sid"]]["lecciones"].append({
            "id": f["id"], "titulo": f["titulo"], "tipo": f["tipo"], "duracion_seg": f["duracion_seg"],
            "completada": hecha, "posicion_seg": pos})
        total += 1
        hechas += 1 if hecha else 0
        duracion += f["duracion_seg"]
        visto += f["duracion_seg"] if hecha else min(pos, f["duracion_seg"])
        if siguiente is None and not hecha:
            siguiente = f["id"]
        if f["visto_en"] is not None and (ult_visto is None or f["visto_en"] > ult_visto):
            ultima, ult_visto = f["id"], f["visto_en"]
    return {
        "id": c["id"], "modulo": c["modulo"], "titulo": c["titulo"], "subtitulo": c["subtitulo"],
        "descripcion": c["descripcion"], "nivel": c["nivel"], "instructor": c["instructor"],
        "portada": bool(c["portada"]), "acceso": acceso, "secciones": secciones,
        "total": total, "hechas": hechas, "duracion_seg": duracion, "visto_seg": visto,
        "siguiente": siguiente, "ultima": ultima,
    }


@router.get("/lecciones/{lid}")
def leccion(lid: int, u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        l = _leccion_con_acceso(con, u, lid)
        p = con.execute(
            "INSERT INTO progreso_lecciones (usuario_id, leccion_id) VALUES (?,?) "
            "ON CONFLICT (usuario_id, leccion_id) DO UPDATE SET visto_en = now() "
            "RETURNING posicion_seg, completada_en", (u["id"], lid)).fetchone()
    finally:
        con.close()
    out = {"id": l["id"], "curso_id": l["curso_id"], "titulo": l["titulo"], "tipo": l["tipo"],
           "duracion_seg": l["duracion_seg"], "fuente": None, "url": None, "ruta_media": None, "contenido": "",
           "posicion_seg": p["posicion_seg"], "completada": p["completada_en"] is not None}
    if l["tipo"] == "texto":
        out["contenido"] = l["contenido"]
        out["fuente"] = "texto"
    elif l["url_externa"]:
        emb = embed_de(l["url_externa"])
        if not emb:
            raise HTTPException(404, "El enlace del video ya no es válido")
        out["fuente"], out["url"] = emb["fuente"], emb["url"]
    elif l["archivo_id"]:
        out["fuente"] = "archivo"
        out["ruta_media"] = f"/aprende/media/{firmar(l['archivo_id'], u['id'])}"
    else:
        raise HTTPException(404, "Esta lección todavía no tiene contenido")
    return out


class ProgresoIn(BaseModel):
    segundos: int = Field(ge=0, le=86400)
    total: int = Field(default=0, ge=0, le=86400)


@router.post("/lecciones/{lid}/progreso")
def progreso(lid: int, d: ProgresoIn, u: dict = Depends(usuario_actual)):
    """Guarda hasta dónde llegó. Al pasar el 90% de la lección, queda completada."""
    con = abrir_db()
    try:
        l = _leccion_con_acceso(con, u, lid)
        dur = l["duracion_seg"] or d.total
        fin = dur > 0 and d.segundos >= int(dur * 0.9)
        r = con.execute(
            "INSERT INTO progreso_lecciones (usuario_id, leccion_id, posicion_seg, completada_en) "
            "VALUES (?,?,?, CASE WHEN ? THEN now() ELSE NULL END) "
            "ON CONFLICT (usuario_id, leccion_id) DO UPDATE SET posicion_seg = EXCLUDED.posicion_seg, visto_en = now(), "
            "completada_en = COALESCE(progreso_lecciones.completada_en, EXCLUDED.completada_en) "
            "RETURNING completada_en", (u["id"], lid, d.segundos, fin)).fetchone()
        res = _resumen(con, u["id"], l["curso_id"])
    finally:
        con.close()
    return {"completada": r["completada_en"] is not None, "total": res["total"], "hechas": res["hechas"]}


class CompletarIn(BaseModel):
    completada: bool = True


@router.post("/lecciones/{lid}/completar")
def completar(lid: int, d: CompletarIn, u: dict = Depends(usuario_actual)):
    con = abrir_db()
    try:
        l = _leccion_con_acceso(con, u, lid)
        con.execute(
            "INSERT INTO progreso_lecciones (usuario_id, leccion_id, completada_en) "
            "VALUES (?,?, CASE WHEN ? THEN now() ELSE NULL END) "
            "ON CONFLICT (usuario_id, leccion_id) DO UPDATE SET completada_en = EXCLUDED.completada_en, visto_en = now()",
            (u["id"], lid, d.completada))
        r = _resumen(con, u["id"], l["curso_id"])
    finally:
        con.close()
    return {"total": r["total"], "hechas": r["hechas"]}


@router.get("/media/{ticket}")
def media(ticket: str, request: Request):
    aid = verificar(ticket)
    con = abrir_db()
    try:
        r = con.execute("SELECT ruta, mime, nombre FROM archivos_aprende WHERE id=?", (aid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Archivo no encontrado")
    return servir_archivo(r["ruta"], r["mime"], r["nombre"], request.headers.get("range"))