import hashlib
import json
import logging
import os
import secrets
from decimal import ROUND_HALF_UP, Decimal
from html import escape

from fastapi import HTTPException

from core.correo import enviar_correo
from core.difusion import compra_confirmada
from core.db import abrir_db
from core.pagos import AUTENTICAR_3DS, cobrar, proveedor_activo
from core.seguridad import auditar, hash_clave
from core.suscripciones import activar_suscripcion, ajustar_rol_persona

logger = logging.getLogger("ordenes")
INTERVALO = "CASE WHEN ?::text = 'anual' THEN interval '1 year' ELSE interval '1 month' END"


def _q(x) -> Decimal:
    return Decimal(str(x)).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def _soles(x) -> str:
    return f"S/ {Decimal(x):.2f}"


def _frontend() -> str:
    return os.getenv("FRONTEND_URL", "http://localhost:4200").rstrip("/")


# ---------------------------------------------------------------- cálculo
def armar_orden(con, tipo_cuenta: str, periodo: str, planes: list[dict], servicios: list[int],
                extras: int, empresa_id: int | None) -> dict:
    """Valida el carrito contra la base de datos y calcula los montos. Nada viene del navegador."""
    if tipo_cuenta != "empresa" and extras > 0:
        raise HTTPException(400, "Los usuarios adicionales solo aplican a empresas")
    if empresa_id is None and extras > 0 and not planes:
        raise HTTPException(400, "Los usuarios adicionales se compran junto con un plan")

    activas: dict[int, str] = {}
    if empresa_id is not None:
        for r in con.execute(
                "SELECT plan_id, modo FROM suscripciones WHERE empresa_id=? AND estado='activa' AND vence_en > now()",
                (empresa_id,)).fetchall():
            activas[r["plan_id"]] = r["modo"]

    items: list[dict] = []
    ids_plan: list[int] = []
    for p in planes:
        if p["plan_id"] in ids_plan:
            raise HTTPException(400, "Hay un plan repetido en el carrito")
        plan = con.execute("SELECT id, nombre FROM planes WHERE id=? AND en_venta=1", (p["plan_id"],)).fetchone()
        if not plan:
            raise HTTPException(400, "Uno de los planes ya no está disponible")
        precio = con.execute(
            "SELECT monto FROM precios WHERE plan_id=? AND tipo_cuenta=? AND concepto=? AND periodo=?",
            (plan["id"], tipo_cuenta, p["modo"], periodo)).fetchone()
        if not precio:
            raise HTTPException(400, f'"{plan["nombre"]}" no se vende en esa modalidad')
        if activas.get(plan["id"]) == "cotizar" and p["modo"] == "ver":
            raise HTTPException(400, f'Ya tienes "{plan["nombre"]}" con cotización; no se puede bajar a solo visualizar')
        etiqueta = "Visualizar y cotizar" if p["modo"] == "cotizar" else "Solo visualizar"
        items.append({"tipo": "plan", "plan_id": plan["id"], "servicio_id": None, "modo": p["modo"], "cantidad": 1,
                      "monto_unit": _q(precio["monto"]), "descripcion": f'{plan["nombre"]} · {etiqueta}'})
        ids_plan.append(plan["id"])

    vistos: list[int] = []
    for sid in servicios:
        if sid in vistos:
            raise HTTPException(400, "Hay un servicio repetido en el carrito")
        s = con.execute("SELECT id, categoria, nombre, precio FROM servicios WHERE id=? AND activo=1", (sid,)).fetchone()
        if not s:
            raise HTTPException(400, "Uno de los servicios ya no está disponible")
        if s["precio"] is None:
            raise HTTPException(400, f'"{s["nombre"]}" es a cotizar: solicita una cotización')
        items.append({"tipo": "servicio", "plan_id": None, "servicio_id": s["id"], "modo": None, "cantidad": 1,
                      "monto_unit": _q(s["precio"]), "descripcion": f'{s["categoria"]} · {s["nombre"]}'})
        vistos.append(sid)

    if extras > 0:
        base = list(set(ids_plan) | set(activas))
        fila = con.execute(
            "SELECT MAX(monto) AS m FROM precios WHERE plan_id = ANY(?) AND tipo_cuenta='empresa' "
            "AND concepto='usuario_extra' AND periodo=?", (base, periodo)).fetchone()
        if not fila or fila["m"] is None:
            raise HTTPException(400, "Los planes elegidos no tienen precio de usuarios adicionales")
        items.append({"tipo": "usuarios_extra", "plan_id": None, "servicio_id": None, "modo": None,
                      "cantidad": extras, "monto_unit": _q(fila["m"]),
                      "descripcion": f"Usuarios adicionales ({extras})"})

    if not items:
        raise HTTPException(400, "Tu carrito está vacío")
    total = sum((i["monto_unit"] * i["cantidad"] for i in items), Decimal("0.00"))
    if total <= 0:
        raise HTTPException(400, "El total debe ser mayor a cero")
    return {"items": items, "total": total}


def guardar_orden(con, tipo_cuenta: str, periodo: str, comprador: dict, empresa_id: int | None,
                  calculo: dict, extras: int, ip: str) -> str:
    oid = secrets.token_hex(16)  # 32 caracteres aleatorios: sirve como "llave" de la orden
    con.execute(
        "INSERT INTO ordenes (id, empresa_id, tipo_cuenta, periodo, comprador, usuarios_extra, total, ip, terminos_en) "
        "VALUES (?,?,?,?,?::jsonb,?,?,?, now())",
        (oid, empresa_id, tipo_cuenta, periodo, json.dumps(comprador), extras, calculo["total"], ip))
    for it in calculo["items"]:
        con.execute(
            "INSERT INTO orden_items (orden_id, tipo, plan_id, servicio_id, modo, cantidad, monto_unit, descripcion) "
            "VALUES (?,?,?,?,?,?,?,?)",
            (oid, it["tipo"], it["plan_id"], it["servicio_id"], it["modo"], it["cantidad"],
             it["monto_unit"], it["descripcion"]))
    return oid


# ---------------------------------------------------------------- accesos y avisos
def nuevo_enlace_clave(con, usuario_id: int) -> str:
    """Enlace de un solo uso (24 h) para que la persona cree su propia clave."""
    token = secrets.token_urlsafe(32)
    h = hashlib.sha256(token.encode()).hexdigest()
    con.execute("UPDATE tokens_clave SET usado_en=now() WHERE usuario_id=? AND usado_en IS NULL", (usuario_id,))
    con.execute("INSERT INTO tokens_clave (usuario_id, token_hash, vence_en) VALUES (?,?, now() + interval '24 hours')",
                (usuario_id, h))
    return f"{_frontend()}/crear-clave?token={token}"


def avisar_ventas(asunto: str, texto: str) -> None:
    con = abrir_db()
    try:
        fila = con.execute("SELECT valor FROM configuracion WHERE clave='contacto_correo'").fetchone()
    finally:
        con.close()
    destino = (fila["valor"] if fila else "").strip()
    if destino:
        enviar_correo(destino, asunto, texto)
    else:
        logger.warning("Aviso para ventas (configura el correo de contacto en el Catálogo): %s\n%s", asunto, texto)


# ---------------------------------------------------------------- aprovisionamiento
def aprovisionar(con, oid: str) -> dict:
    o = con.execute("SELECT * FROM ordenes WHERE id=?", (oid,)).fetchone()
    items = con.execute("SELECT * FROM orden_items WHERE orden_id=? ORDER BY id", (oid,)).fetchall()
    c = o["comprador"]
    planes = [i for i in items if i["tipo"] == "plan"]
    servicios = [i for i in items if i["tipo"] == "servicio"]
    extras, periodo, eid = o["usuarios_extra"], o["periodo"], o["empresa_id"]
    enlace, cuenta_nueva = None, False

    if planes or extras:
        incluidos = 1
        if o["tipo_cuenta"] == "empresa" and planes:
            incluidos = max(r["usuarios_incluidos"] for r in con.execute(
                "SELECT usuarios_incluidos FROM planes WHERE id = ANY(?)", ([p["plan_id"] for p in planes],)).fetchall())
        if eid is None:
            cuenta_nueva = True
            eid = con.execute(
                "INSERT INTO empresas (tipo, nombre, doc_tipo, doc_numero, correo, cupo_usuarios) "
                "VALUES (?,?,?,?,?,?) RETURNING id",
                (o["tipo_cuenta"], c["nombre"], c["doc_tipo"], c["doc_numero"], c["correo"], incluidos)).fetchone()[0]
            rol = "admin" if o["tipo_cuenta"] == "empresa" else "visualizador"
            uid = con.execute(
                "INSERT INTO usuarios (usuario, nombre, clave_hash, rol, empresa_id, correo) VALUES (?,?,?,?,?,?) RETURNING id",
                (c["correo"], c["nombre"], hash_clave(secrets.token_urlsafe(24)), rol, eid, c["correo"])).fetchone()[0]
            enlace = nuevo_enlace_clave(con, uid)
        else:
            con.execute("UPDATE empresas SET cupo_usuarios = GREATEST(cupo_usuarios, ?) WHERE id=?", (incluidos, eid))
        for p in planes:
            activar_suscripcion(con, eid, p["plan_id"], p["modo"], periodo)
        if extras > 0:
            con.execute(
                f"UPDATE empresas SET usuarios_extra=?, "
                f"extras_vence_en = GREATEST(COALESCE(extras_vence_en, now()), now()) + {INTERVALO} WHERE id=?",
                (extras, periodo, eid))
        ajustar_rol_persona(con, eid)
        con.execute("UPDATE ordenes SET empresa_id=? WHERE id=?", (eid, oid))

    for s in servicios:
        con.execute(
            "INSERT INTO pedidos_servicio (servicio_id, servicio_nombre, empresa_id, orden_id, origen, nombre, correo, telefono) "
            "VALUES (?,?,?,?, 'compra', ?,?,?)",
            (s["servicio_id"], s["descripcion"], eid, oid, c["nombre"], c["correo"], c.get("telefono", "")))

    detalle = "\n".join(f"- {i['descripcion']} x{i['cantidad']}: {_soles(i['monto_unit'] * i['cantidad'])}" for i in items)
    detalle_html = "".join(
        f"<li>{escape(i['descripcion'])} ×{i['cantidad']} — {_soles(i['monto_unit'] * i['cantidad'])}</li>" for i in items)
    total = _soles(o["total"])

    if cuenta_nueva:
        texto = (f"¡Gracias por tu compra, {c['nombre']}!\n\n{detalle}\n\nTotal pagado: {total}\n\n"
                 f"Tu usuario es tu correo: {c['correo']}\n"
                 f"Crea tu clave aquí (el enlace sirve una sola vez y vence en 24 horas):\n{enlace}\n")
        html = (f"<p>¡Gracias por tu compra, <b>{escape(c['nombre'])}</b>!</p><ul>{detalle_html}</ul>"
                f"<p><b>Total pagado: {total}</b></p>"
                f"<p>Tu usuario es tu correo: <b>{escape(c['correo'])}</b></p>"
                f"<p><a href=\"{enlace}\">Crear mi clave</a> (el enlace sirve una sola vez y vence en 24 horas)</p>")
    else:
        texto = f"¡Gracias por tu compra, {c['nombre']}!\n\n{detalle}\n\nTotal pagado: {total}\n"
        if servicios:
            texto += "\nNuestro equipo se pondrá en contacto contigo para coordinar tus servicios.\n"
        html = (f"<p>¡Gracias por tu compra, <b>{escape(c['nombre'])}</b>!</p><ul>{detalle_html}</ul>"
                f"<p><b>Total pagado: {total}</b></p>")
    enviar_correo(c["correo"], "Confirmación de tu compra", texto, html)
    avisar_ventas(f"Nueva compra: {c['nombre']} ({total})",
                  f"{c['nombre']} · {c['doc_tipo']} {c['doc_numero']} · {c['correo']} · {c.get('telefono', '')}\n\n{detalle}\n\nTotal: {total}")

    mensaje = (f"¡Listo! Te enviamos un correo a {c['correo']} para crear tu clave." if cuenta_nueva
               else "¡Listo! Tu compra quedó registrada y ya está activa.")
    return {"cuenta_creada": cuenta_nueva, "correo": c["correo"], "mensaje": mensaje}


# ---------------------------------------------------------------- pago
def pagar_orden(oid: str, datos: dict, empresa_id: int | None) -> dict:
    con = abrir_db()
    try:
        o = con.execute("SELECT * FROM ordenes WHERE id=?", (oid,)).fetchone()
        if not o or o["empresa_id"] != empresa_id:
            raise HTTPException(404, "Orden no encontrada")
        if o["estado"] != "pendiente":
            raise HTTPException(409, "Esta orden ya fue procesada")
        if o["intentos"] >= 8:
            raise HTTPException(429, "Demasiados intentos de pago. Crea una orden nueva.")
        con.execute("UPDATE ordenes SET intentos=intentos+1 WHERE id=?", (oid,))
        orden = dict(o)
    finally:
        con.close()

    ok, ref, error = cobrar(orden, orden["comprador"].get("correo", ""), datos)  # fuera de la conexión a la BD
    if error == AUTENTICAR_3DS:  # el banco pide verificar la compra: el navegador la completa y vuelve a enviar
        return {"ok": False, "requiere_3ds": True, "estado": "autenticar", "mensaje": "Tu banco necesita verificar esta compra."}
    if not ok:
        raise HTTPException(402, error or "Pago rechazado")

    con = abrir_db()
    try:
        # Solo UNA petición puede pasar de 'pendiente' a 'pagada' (evita activar dos veces)
        r = con.execute(
            "UPDATE ordenes SET estado='pagada', proveedor=?, ref_externa=?, pagado_en=now() "
            "WHERE id=? AND estado='pendiente' RETURNING id", (proveedor_activo(), ref, oid)).fetchone()
        if not r:
            return {"ok": True, "estado": "pagada", "mensaje": "Tu pago ya fue registrado."}
        try:
            res = aprovisionar(con, oid)
        except Exception as e:  # el cobro ya se hizo: nunca perder la orden
            logger.exception("Falló el aprovisionamiento de la orden %s", oid)
            con.execute("UPDATE ordenes SET estado='error_aprovision' WHERE id=?", (oid,))
            auditar("orden_error_aprovision", None, None, f"{oid} ref={ref}: {e}")
            avisar_ventas("URGENTE: pago recibido sin activar", f"Orden {oid}\nReferencia de pago: {ref}\nError: {e}")
            return {"ok": True, "estado": "error",
                    "mensaje": "Recibimos tu pago. Estamos activando tu compra y te escribiremos por correo en breve."}
    finally:
        con.close()
    try:
        compra_confirmada(oid)
    except Exception:
        logger.exception("No se pudo avisar la compra %s", oid)
    auditar("orden_pagada", None, None, f"{oid} {orden['total']} ref={ref}")
    return {"ok": True, "estado": "pagada", **res}




def confirmar_manual(oid: str, metodo: str, referencia: str, nota: str, quien: str) -> dict:
    """El equipo de ventas confirma un pago hecho por fuera (Yape, Plin, transferencia…).
    Activa la compra exactamente igual que cuando la pasarela aprueba el cobro."""
    con = abrir_db()
    try:
        # Solo UNA confirmación puede pasar la orden de 'pendiente' a 'pagada' (evita activar dos veces)
        r = con.execute(
            "UPDATE ordenes SET estado='pagada', proveedor='manual', ref_externa=?, pagado_en=now(), metodo_pago=?, "
            "nota_pago=?, confirmado_por=? WHERE id=? AND estado='pendiente' RETURNING id",
            (referencia or None, metodo, nota, quien, oid)).fetchone()
        if not r:
            raise HTTPException(409, "Esta orden ya fue procesada o no existe")
        try:
            res = aprovisionar(con, oid)
        except Exception as e:  # el pago ya se confirmó: nunca perder la orden
            logger.exception("Falló la activación de la orden %s", oid)
            con.execute("UPDATE ordenes SET estado='error_aprovision' WHERE id=?", (oid,))
            auditar("orden_error_aprovision", quien, None, f"{oid}: {e}")
            raise HTTPException(
                500, "El pago quedó registrado pero no se pudo activar la compra. Revisa el detalle y usa «Reintentar activación».")
    finally:
        con.close()
    try:
        from core.difusion import compra_confirmada
        compra_confirmada(oid)
    except Exception:
        logger.exception("No se pudo avisar la compra %s por WebSocket", oid)
    auditar("orden_pagada_manual", quien, None, f"{oid} {metodo} ref={referencia}")
    from core.crm import marcar_ganado_por_orden
    marcar_ganado_por_orden(oid)
    return {"ok": True, "estado": "pagada", **res}


def reintentar_activacion(oid: str, quien: str) -> dict:
    """Vuelve a activar una compra pagada cuya activación falló."""
    con = abrir_db()
    try:
        r = con.execute(
            "UPDATE ordenes SET estado='pagada' WHERE id=? AND estado='error_aprovision' RETURNING id", (oid,)).fetchone()
        if not r:
            raise HTTPException(409, "Esta orden no está pendiente de activación")
        try:
            res = aprovisionar(con, oid)
        except Exception as e:
            logger.exception("Falló otra vez la activación de la orden %s", oid)
            con.execute("UPDATE ordenes SET estado='error_aprovision' WHERE id=?", (oid,))
            raise HTTPException(500, f"No se pudo activar la compra: {e}")
    finally:
        con.close()
    try:
        from core.difusion import compra_confirmada
        compra_confirmada(oid)
    except Exception:
        logger.exception("No se pudo avisar la compra %s por WebSocket", oid)
    auditar("orden_reactivada", quien, None, oid)
    from core.crm import marcar_ganado_por_orden
    marcar_ganado_por_orden(oid)
    return {"ok": True, "estado": "pagada", **res}