CLAVES_CONFIG = (
    "sitio_nombre", "sitio_titular", "sitio_subtitulo", "contacto_whatsapp", "contacto_correo",
    "paq_menor_nombre", "paq_menor_desc", "paq_mayor_nombre", "paq_mayor_desc",
    "paq_perucompras_nombre", "paq_perucompras_desc",
)


def leer_config(con) -> dict[str, str]:
    base = {k: "" for k in CLAVES_CONFIG}
    for r in con.execute("SELECT clave, valor FROM configuracion").fetchall():
        if r["clave"] in base:
            base[r["clave"]] = r["valor"]
    return base


def armar_planes(con, solo_en_venta: bool) -> list[dict]:
    """Planes con sus módulos, precios y valores de beneficios."""
    w = "WHERE en_venta=1" if solo_en_venta else ""
    ps = con.execute(
        "SELECT id, codigo, nombre, subtitulo, descripcion, en_venta, destacado, usuarios_incluidos, orden "
        f"FROM planes {w} ORDER BY orden, id").fetchall()
    ids = [p["id"] for p in ps]
    mods: dict[int, list[str]] = {}
    precios: dict[int, list[dict]] = {}
    valores: dict[int, dict[str, str]] = {}
    if ids:
        for r in con.execute(
                "SELECT plan_id, modulo FROM plan_modulos WHERE plan_id = ANY(?) ORDER BY modulo", (ids,)).fetchall():
            mods.setdefault(r["plan_id"], []).append(r["modulo"])
        for r in con.execute(
                "SELECT plan_id, tipo_cuenta, concepto, periodo, monto FROM precios WHERE plan_id = ANY(?)",
                (ids,)).fetchall():
            precios.setdefault(r["plan_id"], []).append(
                {"tipo_cuenta": r["tipo_cuenta"], "concepto": r["concepto"], "periodo": r["periodo"],
                 "monto": float(r["monto"])})
        for r in con.execute(
                "SELECT plan_id, beneficio_id, valor FROM plan_beneficios WHERE plan_id = ANY(?)", (ids,)).fetchall():
            valores.setdefault(r["plan_id"], {})[str(r["beneficio_id"])] = r["valor"]
    return [{
        **dict(p), "en_venta": bool(p["en_venta"]), "destacado": bool(p["destacado"]),
        "modulos": mods.get(p["id"], []), "precios": precios.get(p["id"], []),
        "beneficios": valores.get(p["id"], {}),
    } for p in ps]