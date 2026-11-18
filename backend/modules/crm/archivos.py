"""CRM: archivos. Biblioteca para las automatizaciones y adjuntos enviados desde las conversaciones."""
from fastapi import APIRouter, Depends, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import Response

from core import archivos as ar
from core import automatizaciones as au
from core.crm import avisar_lead
from core.db import abrir_db
from core.seguridad import auditar, ip_cliente
from core.whatsapp import ErrorWa
from modules.crm.router import _lead, contexto, solo_admin

router = APIRouter(prefix="/api/crm", tags=["crm-archivos"])
router_publico = APIRouter(prefix="/api/publico/archivos", tags=["archivos-publicos"])


def _leer(archivo: UploadFile) -> tuple[bytes, str, str]:
    contenido = archivo.file.read(ar.MAX_BYTES + 1)
    if not contenido:
        raise HTTPException(400, "El archivo está vacío")
    if len(contenido) > ar.MAX_BYTES:
        raise HTTPException(413, "El archivo es demasiado grande (máximo 16 MB)")
    return contenido, (archivo.content_type or "").split(";")[0].strip().lower(), archivo.filename or "archivo"


# ---------------- Biblioteca (solo superadmin) ----------------
@router.get("/archivos")
def listar(ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        filas = con.execute("SELECT id, nombre, mime, categoria, tamano, creado_en FROM crm_archivos WHERE origen='biblioteca' ORDER BY id DESC").fetchall()
    finally:
        con.close()
    return [dict(f) for f in filas]


@router.post("/archivos")
def subir(request: Request, archivo: UploadFile = File(...), ctx: dict = Depends(solo_admin)):
    contenido, mime, nombre = _leer(archivo)
    con = abrir_db()
    try:
        try:
            aid = ar.guardar_archivo(con, nombre, mime, contenido, "biblioteca", ctx["u"]["usuario"])
        except ErrorWa as e:
            raise HTTPException(400, str(e))
    finally:
        con.close()
    auditar("crm_archivo_subido", ctx["u"]["usuario"], ip_cliente(request), nombre[:100])
    return {"id": aid}


@router.get("/archivos/{aid}/contenido")
def contenido(aid: int, ctx: dict = Depends(solo_admin)):
    try:
        datos, mime = ar.leer_por_id(aid)
    except ErrorWa as e:
        raise HTTPException(404, str(e))
    return Response(content=datos, media_type=mime, headers={"Content-Disposition": "inline"})


@router.delete("/archivos/{aid}")
def borrar(aid: int, request: Request, ctx: dict = Depends(solo_admin)):
    con = abrir_db()
    try:
        f = con.execute("SELECT nombre FROM crm_archivos WHERE id=? AND origen='biblioteca'", (aid,)).fetchone()
        if not f:
            raise HTTPException(404, "Archivo no encontrado")
        if con.execute("SELECT 1 FROM crm_mensajes WHERE archivo_id=? LIMIT 1", (aid,)).fetchone():
            raise HTTPException(409, "Este archivo ya se envió en conversaciones: no se puede eliminar sin perder esos mensajes.")
        if con.execute("SELECT 1 FROM crm_flujos WHERE definicion::text LIKE ? OR definicion::text LIKE ? OR publicada::text LIKE ? OR publicada::text LIKE ? LIMIT 1",
                       (f'%"archivo_id": {aid},%', f'%"archivo_id": {aid}}}%', f'%"archivo_id": {aid},%', f'%"archivo_id": {aid}}}%')).fetchone():
            raise HTTPException(409, "Este archivo lo usa un flujo. Quítalo del flujo antes de eliminarlo.")
        ar.borrar(con, aid)
    finally:
        con.close()
    auditar("crm_archivo_borrado", ctx["u"]["usuario"], ip_cliente(request), f["nombre"])
    return {"ok": True}


# ---------------- Enviar un archivo desde la conversación ----------------
@router.post("/leads/{lid}/archivo")
def enviar(lid: int, archivo: UploadFile = File(...), canal: str = Form("whatsapp"), caption: str = Form(""), ctx: dict = Depends(contexto)):
    if canal not in ("whatsapp", "facebook", "instagram"):
        raise HTTPException(400, "Canal no válido")
    contenido, mime, nombre = _leer(archivo)
    usuario = ctx["u"]["usuario"]
    con = abrir_db()
    try:
        _lead(con, lid, ctx)
        aid = None
        try:
            aid = ar.guardar_archivo(con, nombre, mime, contenido, "conversacion", usuario)
            a = con.execute("SELECT * FROM crm_archivos WHERE id=?", (aid,)).fetchone()
            ar.enviar_a_lead(con, lid, canal, a, caption.strip()[:1000], usuario)
        except ErrorWa as e:
            if aid:
                ar.borrar(con, aid)  # no se envió: no se guarda
            raise HTTPException(400, str(e))
        au.pausar_por_humano(con, lid)  # una persona tomó la conversación
        con.execute("UPDATE crm_leads SET wa_no_leidos=0 WHERE id=?", (lid,))
    finally:
        con.close()
    avisar_lead(lid)
    return {"ok": True}


# ---------------- Enlace público firmado (lo descarga Meta para Messenger e Instagram) ----------------
@router_publico.get("/{token}")
def publico(token: str):
    aid = ar.id_de_token(token)
    if aid is None:
        raise HTTPException(404, "El enlace venció")
    try:
        datos, mime = ar.leer_por_id(aid)
    except ErrorWa:
        raise HTTPException(404, "No encontrado")
    return Response(content=datos, media_type=mime, headers={"Content-Disposition": "inline"})