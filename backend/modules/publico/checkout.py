import hashlib
from typing import Literal

from fastapi import APIRouter, HTTPException, Request
from pydantic import BaseModel, Field

from core.correo import enviar_correo
from core.difusion import a_superadmins
from core.db import abrir_db
from core.limites import limitar
from core.ordenes import armar_orden, avisar_ventas, guardar_orden, nuevo_enlace_clave, pagar_orden
from core.pagos import info_publica, pago_disponible
from core.seguridad import auditar, hash_clave, ip_cliente, validar_clave_fuerte
from core.validaciones import validar_documento

router = APIRouter(prefix="/api/publico", tags=["checkout"])
CORREO = r"^[^@\s]+@[^@\s]+\.[^@\s]+$"


class PlanItem(BaseModel):
    plan_id: int
    modo: Literal["ver", "cotizar"]


class CompradorIn(BaseModel):
    nombre: str = Field(min_length=2, max_length=160)
    doc_tipo: Literal["RUC", "DNI", "CE", "PASAPORTE"]
    doc_numero: str = Field(min_length=6, max_length=20)
    correo: str = Field(max_length=160, pattern=CORREO)
    telefono: str = Field(default="", max_length=20)


class OrdenIn(BaseModel):
    tipo_cuenta: Literal["empresa", "persona"]
    periodo: Literal["mensual", "anual"]
    planes: list[PlanItem] = Field(default_factory=list, max_length=10)
    servicios: list[int] = Field(default_factory=list, max_length=20)
    usuarios_extra: int = Field(default=0, ge=0, le=200)
    comprador: CompradorIn
    acepto_terminos: bool


class PagoIn(BaseModel):
    token: str | None = Field(default=None, max_length=200)
    simular: str | None = Field(default=None, max_length=20)
    device_id: str | None = Field(default=None, max_length=64)
    auth3ds: dict[str, str] | None = Field(default=None, max_length=8)


class SolicitudIn(BaseModel):
    servicio_id: int
    nombre: str = Field(min_length=2, max_length=160)
    correo: str = Field(max_length=160, pattern=CORREO)
    telefono: str = Field(default="", max_length=20)
    mensaje: str = Field(default="", max_length=500)


class ClaveIn(BaseModel):
    token: str = Field(min_length=20, max_length=100)
    clave: str = Field(min_length=10, max_length=72)


class EnlaceIn(BaseModel):
    correo: str = Field(max_length=160, pattern=CORREO)


@router.post("/ordenes")
def nueva_orden(d: OrdenIn, request: Request):
    ip = ip_cliente(request)
    limitar(f"orden|{ip}", 15)
    if not d.acepto_terminos:
        raise HTTPException(400, "Debes aceptar los términos y la política de privacidad")
    if not d.planes and not d.servicios and d.usuarios_extra == 0:
        raise HTTPException(400, "Tu carrito está vacío")
    ok, msg = pago_disponible()
    if not ok:
        raise HTTPException(503, msg)

    c = d.comprador
    if d.tipo_cuenta == "empresa" and c.doc_tipo != "RUC":
        raise HTTPException(400, "Una empresa se registra con RUC")
    if d.tipo_cuenta == "persona" and c.doc_tipo == "RUC":
        raise HTTPException(400, "Una persona natural se registra con DNI, carné de extranjería o pasaporte")
    doc = validar_documento(c.doc_tipo, c.doc_numero)
    correo = c.correo.strip().lower()

    con = abrir_db()
    try:
        if d.planes or d.usuarios_extra > 0:  # solo estas compras crean cuenta
            if len(correo) > 60:
                raise HTTPException(400, "El correo es demasiado largo para usarlo como usuario (máx. 60 caracteres)")
            if (con.execute("SELECT 1 FROM empresas WHERE doc_tipo=? AND doc_numero=?", (c.doc_tipo, doc)).fetchone()
                    or con.execute("SELECT 1 FROM usuarios WHERE lower(correo)=? OR usuario=?", (correo, correo)).fetchone()):
                raise HTTPException(
                    409, "Ya existe una cuenta con ese documento o correo. Inicia sesión y compra desde 'Mi cuenta'.")
        calculo = armar_orden(con, d.tipo_cuenta, d.periodo, [p.model_dump() for p in d.planes],
                              d.servicios, d.usuarios_extra, None)
        comprador = {"nombre": c.nombre.strip(), "doc_tipo": c.doc_tipo, "doc_numero": doc,
                     "correo": correo, "telefono": c.telefono.strip()}
        oid = guardar_orden(con, d.tipo_cuenta, d.periodo, comprador, None, calculo, d.usuarios_extra, ip)
    finally:
        con.close()
    return {
        "orden_id": oid, "total": float(calculo["total"]), "moneda": "PEN",
        "items": [{"descripcion": i["descripcion"], "cantidad": i["cantidad"], "monto_unit": float(i["monto_unit"])}
                  for i in calculo["items"]],
        "pago": info_publica({
            "id": oid, "total": float(calculo["total"]),
            "items": [{"descripcion": i["descripcion"], "cantidad": i["cantidad"]} for i in calculo["items"]],
        }),
    }


@router.post("/ordenes/{oid}/pagar")
def pagar(oid: str, d: PagoIn, request: Request):
    limitar(f"pago|{ip_cliente(request)}", 20)
    return pagar_orden(oid, d.model_dump(), None)


@router.post("/solicitudes")
def solicitar(d: SolicitudIn, request: Request):
    limitar(f"sol|{ip_cliente(request)}", 6)
    con = abrir_db()
    try:
        s = con.execute("SELECT categoria, nombre FROM servicios WHERE id=? AND activo=1", (d.servicio_id,)).fetchone()
        if not s:
            raise HTTPException(404, "Servicio no encontrado")
        nombre_srv = f"{s['categoria']} · {s['nombre']}"
        con.execute(
            "INSERT INTO pedidos_servicio (servicio_id, servicio_nombre, origen, nombre, correo, telefono, mensaje) "
            "VALUES (?,?, 'cotizacion', ?,?,?,?)",
            (d.servicio_id, nombre_srv, d.nombre.strip(), d.correo.strip().lower(), d.telefono.strip(), d.mensaje.strip()))
    finally:
        con.close()
    from core.crm import captar_lead_seguro
    captar_lead_seguro(nombre=d.nombre.strip(), correo=d.correo, telefono=d.telefono, origen="cotizacion",
                       interes=nombre_srv)
    avisar_ventas(f"Solicitud de cotización: {nombre_srv}",
                  f"{d.nombre} · {d.correo} · {d.telefono}\n\nServicio: {nombre_srv}\n\n{d.mensaje}")
    a_superadmins({"tipo": "pedido"})
    enviar_correo(d.correo.strip().lower(), "Recibimos tu solicitud",
                  f"Hola {d.nombre}, recibimos tu solicitud de cotización para: {nombre_srv}.\nTe responderemos pronto.")
    return {"ok": True}


@router.post("/crear-clave")
def crear_clave(d: ClaveIn, request: Request):
    ip = ip_cliente(request)
    limitar(f"clave|{ip}", 10)
    validar_clave_fuerte(d.clave)
    h = hashlib.sha256(d.token.encode()).hexdigest()
    con = abrir_db()
    try:
        # El enlace se "consume" primero: dos personas no pueden usar el mismo enlace
        t = con.execute(
            "UPDATE tokens_clave SET usado_en=now() WHERE token_hash=? AND usado_en IS NULL AND vence_en > now() "
            "RETURNING usuario_id", (h,)).fetchone()
        if not t:
            raise HTTPException(400, "El enlace no es válido o ya venció. Pide uno nuevo.")
        u = con.execute(
            "UPDATE usuarios SET clave_hash=?, token_ver=token_ver+1 WHERE id=? RETURNING usuario",
            (hash_clave(d.clave), t["usuario_id"])).fetchone()
    finally:
        con.close()
    auditar("clave_creada", u["usuario"], ip)
    return {"ok": True}


@router.post("/solicitar-enlace")
def solicitar_enlace(d: EnlaceIn, request: Request):
    limitar(f"enlace|{ip_cliente(request)}", 5)
    correo = d.correo.strip().lower()
    limitar(f"enlace|{correo}", 3)
    con = abrir_db()
    try:
        u = con.execute("SELECT id FROM usuarios WHERE lower(correo)=? AND activo=1", (correo,)).fetchone()
        enlace = nuevo_enlace_clave(con, u["id"]) if u else None
    finally:
        con.close()
    if enlace:
        enviar_correo(correo, "Crea tu clave de acceso",
                      f"Usa este enlace para crear tu clave. Sirve una sola vez y vence en 24 horas:\n{enlace}\n\n"
                      "Si no lo pediste tú, ignora este mensaje.")
    return {"ok": True}  # misma respuesta exista o no el correo (no revela quién tiene cuenta)