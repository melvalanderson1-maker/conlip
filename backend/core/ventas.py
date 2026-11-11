"""Ajustes de venta y funciones activables desde el superadmin (Ventas → Ajustes).

- Modo de venta 'whatsapp': el cliente deja su pedido y cierra la compra por WhatsApp; el equipo confirma el pago a mano.
- Modo de venta 'pasarela': pago con tarjeta en línea (Culqi) o 'demo' para pruebas.
- Funciones activables: 'crm' (y 'facturacion', todavía sin implementar).

Todo vive en la tabla configuracion (y las llaves de la pasarela, cifradas, en secretos): cambiar de modo no requiere tocar
código ni reiniciar el servidor.
"""
import os
import re
import time
import urllib.parse

from core.db import abrir_db
from core.secretos import leer

CLAVES = (
    "ventas_modo", "ventas_pasarela", "ventas_wa_mensaje", "ventas_wa_flotante",
    "func_crm", "func_facturacion", "contacto_whatsapp", "sitio_nombre",
)
_cache: dict = {"t": 0.0, "v": None}
_TTL = 5.0  # segundos: las páginas consultan esto seguido y no hace falta ir a la base de datos cada vez


def _cfg() -> dict[str, str]:
    if _cache["v"] is not None and time.time() - _cache["t"] < _TTL:
        return _cache["v"]
    con = abrir_db()
    try:
        filas = con.execute("SELECT clave, valor FROM configuracion WHERE clave = ANY(?)", (list(CLAVES),)).fetchall()
    finally:
        con.close()
    _cache["v"] = {f["clave"]: f["valor"] for f in filas}
    _cache["t"] = time.time()
    return _cache["v"]


def invalidar() -> None:
    """Se llama al guardar ajustes para que el cambio se vea de inmediato."""
    _cache["v"] = None


def sitio() -> str:
    return (_cfg().get("sitio_nombre") or "").strip() or "COTI"


# ---------------- Modo de venta y funciones ----------------
def modo_venta() -> str:
    return "pasarela" if _cfg().get("ventas_modo") == "pasarela" else "whatsapp"


def pasarela_elegida() -> str:
    p = ((_cfg().get("ventas_pasarela") or "") or os.getenv("PAGO_PROVEEDOR", "demo")).lower()
    return p if p in ("demo", "culqi") else "demo"


def funcion_activa(nombre: str) -> bool:
    return _cfg().get(f"func_{nombre}") == "1"


# ---------------- Llaves de Culqi ----------------
def llaves_culqi() -> tuple[str, str]:
    """(pública, secreta). Primero lo guardado en el panel (cifrado); si no hay, las variables de entorno."""
    pub = leer("culqi_public_key") or os.getenv("CULQI_PUBLIC_KEY", "")
    sec = leer("culqi_secret_key") or os.getenv("CULQI_SECRET_KEY", "")
    return pub.strip(), sec.strip()


def origen_llaves() -> str:
    if leer("culqi_secret_key"):
        return "panel"
    return "entorno" if os.getenv("CULQI_SECRET_KEY") else ""


def entorno_llave(llave: str) -> str:
    if llave.startswith(("pk_test_", "sk_test_")):
        return "prueba"
    if llave.startswith(("pk_live_", "sk_live_")):
        return "produccion"
    return ""


# ---------------- WhatsApp ----------------
def normalizar_telefono(valor: str) -> str:
    """Solo dígitos con código de país. '999 888 777' y '+51 999 888 777' dan '51999888777'. Vacío si no es válido."""
    d = re.sub(r"\D", "", valor or "")
    if len(d) == 9 and d.startswith("9"):
        d = "51" + d
    return d if 10 <= len(d) <= 15 else ""


def numero_whatsapp() -> str:
    return normalizar_telefono(_cfg().get("contacto_whatsapp", ""))


def enlace_whatsapp(texto: str, numero: str | None = None) -> str:
    n = numero if numero is not None else numero_whatsapp()
    if not n:
        return ""
    return f"https://wa.me/{n}?text={urllib.parse.quote(texto)}"


def mensaje_orden(orden: dict) -> str:
    """Texto que el cliente envía por WhatsApp con el código de su pedido."""
    lineas = [f"Hola, quiero contratar en {sitio()}.", "", f"Pedido: {orden['id'][:8].upper()}"]
    for it in orden.get("items", []):
        cant = f" x{it['cantidad']}" if it.get("cantidad", 1) > 1 else ""
        lineas.append(f"- {it['descripcion']}{cant}")
    lineas += ["", f"Total: S/ {float(orden['total']):.2f}", "", "¿Me ayudan a completar el pago?"]
    return "\n".join(lineas)


def ajustes_publicos() -> dict:
    """Lo único que el público necesita saber (nunca llaves ni datos internos)."""
    cfg = _cfg()
    numero = numero_whatsapp()
    texto = (cfg.get("ventas_wa_mensaje") or "").strip() or f"Hola, quiero información sobre los planes de {sitio()}."
    return {
        "modo": modo_venta(),
        "whatsapp": {
            "numero": numero,
            "enlace": enlace_whatsapp(texto, numero),
            "flotante": cfg.get("ventas_wa_flotante", "1") == "1" and bool(numero),
        },
    }