from fastapi import APIRouter, HTTPException, Request

from core.db import abrir_db
from core.limites import limitar
from core.media import embed_de, firmar, servir_archivo
from core.seguridad import ip_cliente

router = APIRouter(prefix="/api/publico", tags=["cursos-publicos"])


@router.get("/cursos")
def cursos_publicos():
    con = abrir_db()
    try:
        cs = con.execute(
            "SELECT c.id, c.modulo, c.titulo, c.subtitulo, c.descripcion, c.nivel, c.instructor, "
            "(c.portada_id IS NOT NULL) AS portada, c.destacado FROM cursos c "
            "WHERE c.publicado=1 AND c.publico=1 ORDER BY c.orden, c.id").fetchall()
        ids = [c["id"] for c in cs]
        esquema: dict[int, list[dict]] = {}
        planes: dict[int, list[str]] = {}
        if ids:
            filas = con.execute(
                "SELECT s.curso_id, s.id AS sid, s.titulo AS seccion, l.id, l.titulo, l.tipo, l.duracion_seg, l.vista_previa "
                "FROM curso_secciones s LEFT JOIN lecciones l ON l.seccion_id = s.id "
                "WHERE s.curso_id = ANY(?) ORDER BY s.orden, s.id, l.orden, l.id", (ids,)).fetchall()
            vistos: dict[int, dict] = {}
            for f in filas:
                if f["sid"] not in vistos:
                    vistos[f["sid"]] = {"titulo": f["seccion"], "lecciones": []}
                    esquema.setdefault(f["curso_id"], []).append(vistos[f["sid"]])
                if f["id"] is not None:
                    vistos[f["sid"]]["lecciones"].append({
                        "id": f["id"], "titulo": f["titulo"], "tipo": f["tipo"],
                        "duracion_seg": f["duracion_seg"], "vista_previa": bool(f["vista_previa"])})
            for r in con.execute(
                    "SELECT cp.curso_id, p.nombre FROM curso_planes cp JOIN planes p ON p.id = cp.plan_id "
                    "WHERE cp.curso_id = ANY(?) AND p.en_venta=1 ORDER BY p.orden", (ids,)).fetchall():
                planes.setdefault(r["curso_id"], []).append(r["nombre"])
    finally:
        con.close()
    out = []
    for c in cs:
        secciones = esquema.get(c["id"], [])
        lecciones = [l for s in secciones for l in s["lecciones"]]
        out.append({
            "id": c["id"], "modulo": c["modulo"], "titulo": c["titulo"], "subtitulo": c["subtitulo"],
            "descripcion": c["descripcion"], "nivel": c["nivel"], "instructor": c["instructor"],
            "portada": bool(c["portada"]), "destacado": bool(c["destacado"]),
            "n_lecciones": len(lecciones), "duracion_seg": sum(l["duracion_seg"] for l in lecciones),
            "secciones": secciones, "planes": planes.get(c["id"], []),
        })
    return out


@router.get("/lecciones/{lid}/vista-previa")
def vista_previa(lid: int, request: Request):
    """Solo se puede ver sin cuenta una lección marcada como vista previa de un curso publicado y público."""
    limitar(f"vp|{ip_cliente(request)}", 60)
    con = abrir_db()
    try:
        l = con.execute(
            "SELECT l.id, l.titulo, l.tipo, l.contenido, l.url_externa, l.archivo_id, l.duracion_seg, s.curso_id "
            "FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id JOIN cursos c ON c.id = s.curso_id "
            "WHERE l.id=? AND l.vista_previa=1 AND c.publicado=1 AND c.publico=1", (lid,)).fetchone()
    finally:
        con.close()
    if not l:
        raise HTTPException(404, "Esta lección no tiene vista previa")
    out = {"id": l["id"], "curso_id": l["curso_id"], "titulo": l["titulo"], "tipo": l["tipo"],
           "duracion_seg": l["duracion_seg"], "fuente": None, "url": None, "ruta_media": None, "contenido": ""}
    if l["tipo"] == "texto":
        out["fuente"], out["contenido"] = "texto", l["contenido"]
    elif l["url_externa"]:
        emb = embed_de(l["url_externa"])
        if not emb:
            raise HTTPException(404, "El enlace del video ya no es válido")
        out["fuente"], out["url"] = emb["fuente"], emb["url"]
    elif l["archivo_id"]:
        out["fuente"] = "archivo"
        out["ruta_media"] = f"/aprende/media/{firmar(l['archivo_id'], 0)}"
    else:
        raise HTTPException(404, "Esta lección todavía no tiene contenido")
    return out


@router.get("/portadas/{cid}")
def portada(cid: int):
    con = abrir_db()
    try:
        r = con.execute(
            "SELECT a.ruta, a.mime, a.nombre FROM cursos c JOIN archivos_aprende a ON a.id = c.portada_id "
            "WHERE c.id=? AND c.publicado=1", (cid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(404, "Sin portada")
    return servir_archivo(r["ruta"], r["mime"], r["nombre"], None)