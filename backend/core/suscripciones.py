SQL_ACTIVAR = """
INSERT INTO suscripciones (empresa_id, plan_id, modo, periodo, vence_en)
VALUES (?,?,?,?, now() + CASE WHEN ?::text = 'anual' THEN interval '1 year' ELSE interval '1 month' END)
ON CONFLICT (empresa_id, plan_id) DO UPDATE SET
    modo = EXCLUDED.modo,
    periodo = EXCLUDED.periodo,
    estado = 'activa',
    vence_en = GREATEST(suscripciones.vence_en, now())
             + CASE WHEN EXCLUDED.periodo = 'anual' THEN interval '1 year' ELSE interval '1 month' END
RETURNING id, vence_en
"""


def activar_suscripcion(con, empresa_id: int, plan_id: int, modo: str, periodo: str):
    """Crea la suscripción o la renueva (suma un periodo a partir del vencimiento si aún está vigente)."""
    return con.execute(SQL_ACTIVAR, (empresa_id, plan_id, modo, periodo, periodo)).fetchone()


def ajustar_rol_persona(con, empresa_id: int) -> None:
    """Persona natural: su rol refleja si tiene algún paquete en modo cotizar."""
    e = con.execute("SELECT tipo FROM empresas WHERE id=?", (empresa_id,)).fetchone()
    if not e or e["tipo"] != "persona":
        return
    hay = con.execute(
        "SELECT 1 FROM suscripciones WHERE empresa_id=? AND estado='activa' AND vence_en > now() "
        "AND modo='cotizar' LIMIT 1", (empresa_id,)).fetchone()
    con.execute("UPDATE usuarios SET rol=? WHERE empresa_id=? AND rol IN ('cotizador','visualizador')",
                ("cotizador" if hay else "visualizador", empresa_id))