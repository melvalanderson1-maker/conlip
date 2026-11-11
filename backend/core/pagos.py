import json
import logging
import os
import re
import secrets
import urllib.error
import urllib.request
from decimal import ROUND_HALF_UP, Decimal

logger = logging.getLogger("pagos")

# Señal interna: el banco pide verificar la compra (3D Secure) antes de aprobar el cargo
AUTENTICAR_3DS = "__autenticar_3ds__"
PARAMETROS_3DS = ("eci", "xid", "cavv", "protocolVersion", "directoryServerTransactionId")


from core.ventas import llaves_culqi


def proveedor_activo() -> str:
    """'whatsapp' (el equipo confirma el pago a mano), 'culqi' o 'demo'. Se elige en el superadmin: Ventas → Ajustes."""
    from core.ventas import modo_venta, pasarela_elegida
    return "whatsapp" if modo_venta() == "whatsapp" else pasarela_elegida()


def pago_disponible() -> tuple[bool, str]:
    p = proveedor_activo()
    if p == "whatsapp":
        return True, ""
    if p == "demo":
        if os.getenv("ENTORNO", "prod").lower() == "dev" or os.getenv("PAGO_DEMO_PERMITIDO") == "1":
            return True, ""
        return False, "El pago de prueba está desactivado en este entorno"
    pub, sec = llaves_culqi()
    if not pub or not sec:
        return False, "Los pagos aún no están configurados"
    return True, ""


def info_publica(orden: dict | None = None) -> dict:
    """Lo único que el navegador necesita saber del proveedor (nunca la llave secreta)."""
    p = proveedor_activo()
    if p == "whatsapp":
        from core.ventas import enlace_whatsapp, mensaje_orden
        info = {"proveedor": "whatsapp"}
        if orden:
            info["codigo"] = orden["id"][:8].upper()
            info["whatsapp_url"] = enlace_whatsapp(mensaje_orden(orden))
        return info
    if p == "culqi":
        return {"proveedor": "culqi", "llave_publica": llaves_culqi()[0]}
    return {"proveedor": "demo"}


def cobrar(orden: dict, correo: str, datos: dict) -> tuple[bool, str, str]:
    """Devuelve (aprobado, referencia, mensaje_de_error). El monto sale SIEMPRE de la orden guardada."""
    p = proveedor_activo()
    if p == "whatsapp":  # en este modo nunca se cobra en línea: el equipo confirma el pago a mano
        return False, "", "Esta compra se confirma por WhatsApp con un asesor"
    if p == "demo":
        if datos.get("simular") == "rechazado":
            return False, "", "Pago rechazado (simulación)"
        return True, "demo-" + secrets.token_hex(6), ""
    return _culqi(orden, correo, datos)

def _culqi(orden: dict, correo: str, datos: dict) -> tuple[bool, str, str]:
    secreto = llaves_culqi()[1]
    token = str(datos.get("token") or "")
    if not secreto or not token.startswith("tkn_"):
        return False, "", "No se pudo validar la tarjeta"

    # Datos para el antifraude de Culqi (el monto sale SIEMPRE de la orden guardada, nunca del navegador)
    comprador = orden.get("comprador") or {}
    partes = str(comprador.get("nombre", "")).split()
    nombre = (partes[0] if partes else "Cliente")[:50]
    antifraude = {"first_name": nombre, "last_name": (" ".join(partes[1:]) or nombre)[:50], "country_code": "PE"}
    tel = re.sub(r"\D", "", str(comprador.get("telefono", "")))
    if tel:
        antifraude["phone_number"] = tel[:15]
    device = str(datos.get("device_id") or "")
    if re.fullmatch(r"[0-9a-fA-F-]{16,64}", device):
        antifraude["device_finger_print_id"] = device

    cuerpo = {
        "amount": int((Decimal(str(orden["total"])) * 100).quantize(Decimal("1"), rounding=ROUND_HALF_UP)),  # céntimos
        "currency_code": orden["moneda"],
        "email": correo,
        "source_id": token,
        "description": f"Orden {orden['id'][:8]}",
        "metadata": {"orden": orden["id"]},
        "antifraud_details": antifraude,
    }
    # Solo se aceptan los campos que Culqi define para 3D Secure: nada más llega a su API
    a3 = {k: str(v)[:200] for k, v in (datos.get("auth3ds") or {}).items() if k in PARAMETROS_3DS and v}
    if a3:
        cuerpo["authentication_3DS"] = a3

    req = urllib.request.Request(
        "https://api.culqi.com/v2/charges", data=json.dumps(cuerpo).encode(), method="POST",
        headers={"Authorization": f"Bearer {secreto}", "Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as r:
            estado = r.status
            resp = json.loads(r.read() or b"{}")
    except urllib.error.HTTPError as e:
        try:
            err = json.loads(e.read())
            msg = err.get("user_message") or err.get("merchant_message") or "Pago rechazado"
        except Exception:
            msg = "Pago rechazado"
        logger.warning("Culqi rechazó el cargo de la orden %s (HTTP %s): %s", orden["id"], e.code, msg)
        return False, "", msg
    except Exception as e:
        logger.error("No se pudo contactar a Culqi: %s", e)
        return False, "", "No pudimos contactar al proveedor de pagos. Inténtalo de nuevo."

    pide_3ds = resp.get("action_code") == "REVIEW"
    if resp.get("object") == "charge" and str(resp.get("id", "")).startswith("chr_") and not pide_3ds:
        return True, resp["id"], ""
    # Respuesta sin cargo y sin error: el antifraude pidió autenticar (3D Secure). La documentación de Culqi se
    # contradice con los códigos 200/201, por eso se decide por el contenido de la respuesta y no por el código.
    if (pide_3ds or estado in (200, 201)) and not a3:
        logger.info("Culqi pidió 3D Secure para la orden %s (respuesta: %s)", orden["id"],
                    {k: resp.get(k) for k in ("object", "action_code", "user_message")})
        return False, "", AUTENTICAR_3DS
    return False, "", resp.get("user_message") or "El pago no fue aprobado"