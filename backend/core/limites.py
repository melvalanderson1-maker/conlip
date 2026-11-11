import time

from fastapi import HTTPException

_golpes: dict[str, list[float]] = {}


def limitar(clave: str, maximo: int, ventana: int = 600) -> None:
    """Máximo `maximo` intentos por `ventana` segundos para esa clave (IP, correo...)."""
    ahora = time.time()
    lista = [t for t in _golpes.get(clave, []) if ahora - t < ventana]
    if len(lista) >= maximo:
        _golpes[clave] = lista
        raise HTTPException(429, "Demasiados intentos. Espera unos minutos e inténtalo de nuevo.")
    lista.append(ahora)
    _golpes[clave] = lista
    if len(_golpes) > 5000:  # limpieza simple para que no crezca sin límite
        for k in [k for k, v in _golpes.items() if not v or ahora - v[-1] > ventana]:
            _golpes.pop(k, None)