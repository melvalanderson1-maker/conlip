import logging
import mimetypes
from urllib.parse import quote

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import Response

from core.seguridad import requiere_permiso_archivo
from modules.coti_menor.instancia import cliente

logger = logging.getLogger("archivos")
router = APIRouter(
    prefix="/api", tags=["archivos"],
    dependencies=[Depends(requiere_permiso_archivo("menor:archivos"))],
)

RUTA_DESCARGA = "archivo/archivos/descargar-archivo-contrato/{id_archivo}"
INLINE_OK = {"application/pdf", "image/png", "image/jpeg", "image/gif", "image/webp"}


@router.get("/archivo/{id_archivo}")
def ver_archivo(id_archivo: int, nombre: str = Query("requerimiento.pdf", max_length=200)):
    try:
        res = cliente.get_bytes(RUTA_DESCARGA.format(id_archivo=id_archivo))
    except Exception as e:
        logger.error(f"SEACE no respondió para archivo {id_archivo}: {e}")
        raise HTTPException(status_code=502, detail="SEACE no respondió")

    if res is None:
        raise HTTPException(status_code=404, detail="Archivo no encontrado en SEACE")

    contenido, mime = res
    mime = (mime or "").split(";")[0].strip().lower()

    if "json" in mime:
        logger.error(f"SEACE devolvió JSON en vez del archivo {id_archivo}: {contenido[:300]!r}")
        raise HTTPException(status_code=502, detail="SEACE no devolvió el archivo")

    if mime in ("", "application/octet-stream"):
        mime = mimetypes.guess_type(nombre)[0] or "application/pdf"

    disp = "inline" if mime in INLINE_OK else "attachment"
    return Response(
        content=contenido,
        media_type=mime,
        headers={"Content-Disposition": f"{disp}; filename*=UTF-8''{quote(nombre)}"},
    )