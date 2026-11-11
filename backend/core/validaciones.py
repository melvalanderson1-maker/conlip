import re

from fastapi import HTTPException


def ruc_valido(r: str) -> bool:
    """RUC peruano: 11 dígitos, prefijo válido y dígito verificador (módulo 11)."""
    if not (r.isdigit() and len(r) == 11 and r[:2] in ("10", "15", "16", "17", "20")):
        return False
    pesos = (5, 4, 3, 2, 7, 6, 5, 4, 3, 2)
    suma = sum(int(d) * p for d, p in zip(r[:10], pesos))
    return (11 - suma % 11) % 10 == int(r[10])


def validar_documento(tipo: str, numero: str) -> str:
    """Valida y devuelve el documento normalizado."""
    n = numero.strip().upper()
    reglas = {
        "RUC": ruc_valido(n),
        "DNI": n.isdigit() and len(n) == 8,
        "CE": bool(re.fullmatch(r"[A-Z0-9]{8,12}", n)),
        "PASAPORTE": bool(re.fullmatch(r"[A-Z0-9]{6,12}", n)),
    }
    if not reglas.get(tipo, False):
        raise HTTPException(400, f"{tipo} inválido")
    return n