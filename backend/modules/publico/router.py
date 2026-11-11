from fastapi import APIRouter

from core.catalogo import armar_planes, leer_config
from core.db import abrir_db

router = APIRouter(prefix="/api/publico", tags=["publico"])


@router.get("/catalogo")
def catalogo():
    con = abrir_db()
    try:
        planes = armar_planes(con, True)
        beneficios = [dict(r) for r in con.execute(
            "SELECT id, nombre, tipo FROM beneficios WHERE visible=1 ORDER BY orden, id").fetchall()]
        servicios = [{
            "id": r["id"], "modulo": r["modulo"], "categoria": r["categoria"], "nombre": r["nombre"],
            "descripcion": r["descripcion"], "entregables": list(r["entregables"] or []),
            "precio": float(r["precio"]) if r["precio"] is not None else None,
        } for r in con.execute(
            "SELECT id, modulo, categoria, nombre, descripcion, entregables, precio FROM servicios "
            "WHERE activo=1 ORDER BY orden, id").fetchall()]
        config = leer_config(con)
    finally:
        con.close()
    return {"config": config, "planes": planes, "beneficios": beneficios, "servicios": servicios}