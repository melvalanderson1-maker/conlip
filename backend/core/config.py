import os
import re

DEV = os.getenv("ENTORNO", "prod").lower() == "dev"

ORIGENES = [o.strip() for o in os.getenv(
    "CORS_ORIGINS", "http://localhost:4200,http://127.0.0.1:4200").split(",") if o.strip()]

LAN_REGEX = (r"^http://(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|"
             r"172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3})(:\d+)?$")
_LAN = re.compile(LAN_REGEX)


def origen_permitido(origen: str | None) -> bool:
    """Los navegadores siempre envían Origin en un WebSocket; sin él se rechaza."""
    if not origen:
        return False
    return origen in ORIGENES or (DEV and bool(_LAN.match(origen)))