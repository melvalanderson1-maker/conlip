import json
import re
import urllib.error
import urllib.request
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from core.db import abrir_db
from core.ordenes import confirmar_manual, reintentar_activacion
from core.secretos import clave_ok, guardar
from core.seguridad import auditar, ip_cliente, solo_superadmin
from core.ventas import (
    entorno_llave, enlace_whatsapp, invalidar, llaves_culqi, normalizar_telefono, numero_whatsapp, origen_llaves, sitio,
)
from core.ventas import _cfg  # lectura de ajustes (misma caché que usa todo el sistema)

router = APIRouter(prefix="/api/ventas/admin", tags=["ventas-admin"], dependencies=[Depends(solo_superadmin)])

ESTADOS = ("pendiente", "pagada", "error_aprovision", "cancelada")
RE_PK = re.compile(r"^pk_(test|live)_[A-Za-z0-9]+$")
RE_SK = re.compile(r"^sk_(test|live)_[A-Za-z0-9]+$")


# ======================= PEDIDOS =======================
class ConfirmarIn(BaseModel):
    metodo: Literal["yape", "plin", "transferencia", "deposito", "efectivo", "otro"]
    referencia: str = Field(default="", max_length=80)
    nota: str = Field(default="", max_length=300)


@router.get("/ordenes")
def ordenes(estado: str = ""):
    if estado and estado not in ESTADOS:
        raise HTTPException(400, "Estado inválido")
    w = "WHERE o.estado=?" if estado else ""
    con = abrir_db()
    try:
        filas = con.execute(
            "SELECT o.id, o.estado, o.total, o.moneda, o.tipo_cuenta, o.periodo, o.comprador, o.proveedor, o.metodo_pago, "
            "o.ref_externa, o.nota_pago, o.confirmado_por, o.contactado_en, o.creado_en, o.pagado_en, o.empresa_id, "
            "COALESCE((SELECT json_agg(json_build_object('descripcion', i.descripcion, 'cantidad', i.cantidad, "
            "'monto_unit', i.monto_unit) ORDER BY i.id) FROM orden_items i WHERE i.orden_id = o.id), '[]'::json) AS items "
            f"FROM ordenes o {w} ORDER BY o.creado_en DESC LIMIT 300", [estado] if estado else []).fetchall()
    finally:
        con.close()
    nombre_sitio = sitio()
    out = []
    for f in filas:
        d = dict(f)
        d["total"] = float(d["total"])
        d["codigo"] = d["id"][:8].upper()
        comp = d["comprador"] or {}
        tel = normalizar_telefono(comp.get("telefono", ""))
        texto = f"Hola {comp.get('nombre', '')}, te escribimos de {nombre_sitio} por tu pedido {d['codigo']}. ¿Te ayudamos a completar el pago?"
        d["whatsapp_cliente"] = enlace_whatsapp(texto, tel) if tel else ""
        out.append(d)
    return out


@router.post("/ordenes/{oid}/confirmar")
def confirmar(oid: str, d: ConfirmarIn, request: Request, yo: dict = Depends(solo_superadmin)):
    return confirmar_manual(oid, d.metodo, d.referencia.strip(), d.nota.strip(), yo["usuario"])


@router.post("/ordenes/{oid}/reintentar")
def reintentar(oid: str, request: Request, yo: dict = Depends(solo_superadmin)):
    return reintentar_activacion(oid, yo["usuario"])


@router.post("/ordenes/{oid}/cancelar")
def cancelar(oid: str, request: Request, yo: dict = Depends(solo_superadmin)):
    con = abrir_db()
    try:
        r = con.execute(
            "UPDATE ordenes SET estado='cancelada' WHERE id=? AND estado='pendiente' RETURNING id", (oid,)).fetchone()
    finally:
        con.close()
    if not r:
        raise HTTPException(409, "Solo se pueden cancelar pedidos pendientes de pago")
    auditar("orden_cancelada", yo["usuario"], ip_cliente(request), oid)
    return {"ok": True}


# ======================= AJUSTES =======================
class WhatsappIn(BaseModel):
    numero: str = Field(default="", max_length=30)
    mensaje: str = Field(default="", max_length=300)
    flotante: bool = True


class CulqiIn(BaseModel):
    publica: str = Field(default="", max_length=120)
    secreta: str = Field(default="", max_length=120)


class FuncionesIn(BaseModel):
    crm: bool = False


class AjustesIn(BaseModel):
    modo: Literal["whatsapp", "pasarela"]
    pasarela: Literal["culqi", "demo"] = "culqi"
    whatsapp: WhatsappIn
    culqi: CulqiIn = Field(default_factory=CulqiIn)
    funciones: FuncionesIn = Field(default_factory=FuncionesIn)


def _demo_permitido() -> bool:
    import os
    return os.getenv("ENTORNO", "prod").lower() == "dev" or os.getenv("PAGO_DEMO_PERMITIDO") == "1"


def _mask(v: str) -> str:
    return "" if not v else (v if len(v) <= 10 else f"{v[:8]}•••{v[-4:]}")


@router.get("/ajustes")
def ver_ajustes():
    invalidar()
    cfg = _cfg()
    pub, sec = llaves_culqi()
    from core.ventas import modo_venta, pasarela_elegida
    return {
        "clave_ok": clave_ok(),
        "modo": modo_venta(),
        "pasarela": pasarela_elegida(),
        "demo_permitido": _demo_permitido(),
        "whatsapp": {
            "numero": cfg.get("contacto_whatsapp", ""),
            "mensaje": cfg.get("ventas_wa_mensaje", ""),
            "flotante": cfg.get("ventas_wa_flotante", "1") == "1",
            "enlace_prueba": enlace_whatsapp("Prueba de enlace de WhatsApp"),
        },
        "culqi": {
            "publica": _mask(pub), "secreta_guardada": bool(sec), "origen": origen_llaves(),
            "entorno": entorno_llave(sec) or entorno_llave(pub),
        },
        "funciones": {"crm": cfg.get("func_crm") == "1", "facturacion": False},
    }


def _guardar_cfg(con, clave: str, valor: str) -> None:
    con.execute(
        "INSERT INTO configuracion (clave, valor) VALUES (?,?) ON CONFLICT (clave) DO UPDATE SET valor = EXCLUDED.valor",
        (clave, valor))


@router.put("/ajustes")
def guardar_ajustes(d: AjustesIn, request: Request, yo: dict = Depends(solo_superadmin)):
    # ---- WhatsApp ----
    numero_txt = d.whatsapp.numero.strip()
    if numero_txt and not normalizar_telefono(numero_txt):
        raise HTTPException(400, "El número de WhatsApp no es válido. Escríbelo con código de país, por ejemplo +51 999 888 777.")
    if d.modo == "whatsapp" and not (numero_txt or numero_whatsapp()):
        raise HTTPException(400, "Para vender por WhatsApp necesitas escribir el número de WhatsApp de ventas.")

    # ---- Llaves de Culqi (vacío = se conserva la actual) ----
    nueva_pub, nueva_sec = d.culqi.publica.strip(), d.culqi.secreta.strip()
    if nueva_pub and not RE_PK.match(nueva_pub):
        raise HTTPException(400, "La llave pública de Culqi debe empezar con pk_test_ o pk_live_")
    if nueva_sec and not RE_SK.match(nueva_sec):
        raise HTTPException(400, "La llave secreta de Culqi debe empezar con sk_test_ o sk_live_")
    if (nueva_pub or nueva_sec) and not clave_ok():
        raise HTTPException(400, "Falta SECRETS_KEY en el servidor: no se pueden guardar llaves de forma segura.")
    actual_pub, actual_sec = llaves_culqi()
    pub, sec = (nueva_pub or actual_pub), (nueva_sec or actual_sec)

    # ---- Reglas para encender la pasarela ----
    if d.modo == "pasarela":
        if d.pasarela == "demo":
            if not _demo_permitido():
                raise HTTPException(400, "El pago de prueba no está permitido en este entorno. Usa Culqi o vende por WhatsApp.")
        else:
            if not pub or not sec:
                raise HTTPException(400, "Para activar la pasarela primero guarda las llaves de Culqi (pública y secreta).")
            if entorno_llave(pub) != entorno_llave(sec):
                raise HTTPException(400, "La llave pública y la secreta son de entornos distintos (una de prueba y otra de producción).")

    con = abrir_db()
    try:
        if nueva_pub:
            guardar("culqi_public_key", nueva_pub)
        if nueva_sec:
            guardar("culqi_secret_key", nueva_sec)
        _guardar_cfg(con, "ventas_modo", d.modo)
        _guardar_cfg(con, "ventas_pasarela", d.pasarela)
        if numero_txt:
            _guardar_cfg(con, "contacto_whatsapp", numero_txt)  # es el mismo dato de Catálogo → textos del sitio
        _guardar_cfg(con, "ventas_wa_mensaje", d.whatsapp.mensaje.strip())
        _guardar_cfg(con, "ventas_wa_flotante", "1" if d.whatsapp.flotante else "0")
        _guardar_cfg(con, "func_crm", "1" if d.funciones.crm else "0")
    finally:
        con.close()
    invalidar()
    auditar("ventas_ajustes", yo["usuario"], ip_cliente(request),
            f"modo={d.modo} pasarela={d.pasarela} crm={d.funciones.crm} llaves_nuevas={bool(nueva_pub or nueva_sec)}")
    return {"ok": True}


@router.post("/pasarela/probar")
def probar_pasarela():
    """Comprueba la llave secreta de Culqi con una consulta que no cobra nada."""
    pub, sec = llaves_culqi()
    if not sec:
        raise HTTPException(400, "Primero guarda la llave secreta de Culqi.")
    req = urllib.request.Request("https://api.culqi.com/v2/charges?limit=1", headers={"Authorization": f"Bearer {sec}"})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        if e.code in (401, 403):
            raise HTTPException(400, "Culqi rechazó la llave secreta. Revisa que esté completa y sea de tu comercio.")
        raise HTTPException(400, f"Culqi respondió con el código {e.code}.")
    except Exception:
        raise HTTPException(400, "No se pudo contactar a Culqi. Revisa tu conexión.")
    entorno = {"prueba": "de PRUEBA", "produccion": "de PRODUCCIÓN"}.get(entorno_llave(sec), "")
    aviso = ""
    if pub and entorno_llave(pub) != entorno_llave(sec):
        aviso = " ¡Cuidado!: la llave pública es de otro entorno."
    return {"ok": True, "detalle": f"La llave secreta es válida {entorno}.{aviso}".strip()}