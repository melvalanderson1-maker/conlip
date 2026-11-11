MODULOS = {"menor": "Coti Menor", "mayor": "Coti Mayor", "perucompras": "Perú Compras"}
ACCIONES = {
    "ver": "Ver contratos y detalle",
    "archivos": "Abrir / descargar archivos",
    "cotizar": "Cotizar",
}
ROLES = ("superadmin", "admin", "cotizador", "visualizador")
ROLES_ASIGNABLES = ("cotizador", "visualizador")  # los que un admin de empresa puede crear

CATALOGO = [f"{m}:{a}" for m in MODULOS for a in ACCIONES]


def _todos(acciones: tuple[str, ...]) -> list[str]:
    return [f"{m}:{a}" for m in MODULOS for a in acciones]


# Permisos que se marcan por defecto al elegir un rol (el admin luego los ajusta).
POR_DEFECTO = {
    "superadmin": [],
    "admin": [],
    "cotizador": _todos(("ver", "archivos", "cotizar")),
    "visualizador": _todos(("ver", "archivos")),
}


def normalizar(permisos: list[str]) -> list[str]:
    """Descarta permisos inventados y garantiza que 'archivos'/'cotizar' incluyan 'ver'."""
    validos = {p for p in permisos if p in CATALOGO}
    for p in list(validos):
        validos.add(p.split(":")[0] + ":ver")
    return sorted(validos)