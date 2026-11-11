import logging

from core.db import abrir_db

logger = logging.getLogger("semillas")

ORIGINALES = [
    ("perucompras", "Perú Compras", "Compras y acuerdos marco en Perú Compras", 1),
    ("menor", "Contratos Menores", "Contrataciones menores", 2),
    ("mayor", "Contratos Mayores", "Contrataciones mayores", 3),
]

BENEFICIOS = [
    ("Sistema de inteligencia comercial de Perú Compras", "check"),
    ("Sistema de búsqueda y cotización de SEACE", "check"),
    ("Sistema de búsqueda y cotización de contratos menores", "check"),
    ("Formatos y modelos de documentos", "check"),
    ("Acceso a capacitación 360°", "texto"),
    ("Atención de consultas", "numero"),
]

# codigo, nombre, subtítulo, módulos, valores por beneficio (misma posición que BENEFICIOS; "" = no incluido)
PLANES = [
    ("inicia-perucompras", "Plan Inicia Perú Compras", "Para empezar en Perú Compras",
     ["perucompras"], ["x", "", "", "x", "2", "1"]),
    ("inicia-seace-menores", "Plan Inicia SEACE - Contratos Menores", "Para cotizar en SEACE y contratos menores",
     ["mayor", "menor"], ["", "x", "x", "x", "2", "1"]),
    ("emprendedor", "Plan Emprendedor", "Perú Compras, SEACE y contratos menores",
     ["perucompras", "mayor", "menor"], ["x", "x", "x", "x", "4", "2"]),
    ("corporativo", "Plan Corporativo", "Todo incluido para equipos que venden al Estado",
     ["perucompras", "mayor", "menor"], ["x", "x", "x", "x", "Todos", "4"]),
]

SERVICIOS = [
    ("Ingresa a Perú Compras", "Como proveedor", [
        "Diagnóstico inicial del proveedor",
        "Inscripción y habilitación en Perú Compras",
        "Selección estratégica de Fichas-producto",
        "Análisis estratégico de márgenes y precios",
        "Registro de oferta de hasta 20 Fichas-producto",
        "Actualización de stock, plazo de entrega y stock",
        "Capacitación del uso de la plataforma",
    ]),
    ("Ingresa a Perú Compras", "Como fabricante o dueño de marca", [
        "Diagnóstico inicial de la empresa",
        "Acreditación como representante de marca",
        "Identificación de productos potencialmente incorporables",
        "Análisis de estructura de Ficha-producto",
        "Elaboración de hasta 10 Fichas-producto",
        "Registro y carga de hasta 10 Fichas-producto",
    ]),
    ("Ingresa a Perú Compras", "Como proveedor y fabricante o dueño de marca", [
        "Diagnóstico inicial de la empresa",
        "Acreditación como representante de marca",
        "Identificación de productos potencialmente incorporables",
        "Análisis de estructura de Ficha-producto",
        "Elaboración de hasta 10 Fichas-producto",
        "Registro y carga de hasta 10 Fichas-producto",
        "Análisis estratégico de márgenes y precios",
        "Registro de oferta de hasta 10 Fichas-producto",
        "Actualización de stock, plazo de entrega y stock",
        "Capacitación del uso de la plataforma",
    ]),
    ("Capacitación 360°", "Capacitación 360°", [
        "Cómo inscribirte como proveedor en PERÚ COMPRAS",
        "Cómo inscribirte como dueño o representante de marca en PERÚ COMPRAS",
        "Elaboración de fichas producto para dueños o representantes de marca",
        "Cómo vender al Estado a través de Catálogos Electrónicos de Perú Compras",
        "Cómo participar en las ventas corporativas",
    ]),
]

CONFIG = {
    "sitio_nombre": "COTI",
    "sitio_titular": "Encuentra contrataciones del Estado y cotiza en equipo",
    "sitio_subtitulo": ("Contratos menores, contratos mayores y Perú Compras en una sola plataforma, "
                        "con asignaciones y avisos en tiempo real."),
    "contacto_whatsapp": "",
    "contacto_correo": "",
    "paq_menor_nombre": "Contratos Menores",
    "paq_menor_desc": "Búsqueda y cotización de contrataciones menores",
    "paq_mayor_nombre": "Contratos Mayores",
    "paq_mayor_desc": "Búsqueda y cotización de contrataciones en SEACE",
    "paq_perucompras_nombre": "Perú Compras",
    "paq_perucompras_desc": "Inteligencia comercial, catálogos electrónicos y capacitación",
}


def sembrar_catalogo() -> None:
    """Se ejecuta una sola vez: después, lo que agregues o borres desde el panel se respeta."""
    con = abrir_db()
    try:
        if con.execute("SELECT 1 FROM configuracion WHERE clave='catalogo_sembrado'").fetchone():
            return

        for codigo, nombre, desc, orden in ORIGINALES:
            fila = con.execute(
                "INSERT INTO planes (codigo, nombre, descripcion, orden) VALUES (?,?,?,?) "
                "ON CONFLICT (codigo) DO NOTHING RETURNING id", (codigo, nombre, desc, orden)).fetchone()
            pid = fila[0] if fila else con.execute("SELECT id FROM planes WHERE codigo=?", (codigo,)).fetchone()[0]
            con.execute("INSERT INTO plan_modulos (plan_id, modulo) VALUES (?,?) ON CONFLICT DO NOTHING", (pid, codigo))

        ids_b = []
        for i, (nombre, tipo) in enumerate(BENEFICIOS, start=1):
            ids_b.append(con.execute(
                "INSERT INTO beneficios (nombre, tipo, orden) VALUES (?,?,?) RETURNING id", (nombre, tipo, i)).fetchone()[0])

        for orden, (codigo, nombre, sub, mods, vals) in enumerate(PLANES, start=10):
            fila = con.execute(
                "INSERT INTO planes (codigo, nombre, subtitulo, orden) VALUES (?,?,?,?) "
                "ON CONFLICT (codigo) DO NOTHING RETURNING id", (codigo, nombre, sub, orden)).fetchone()
            if not fila:
                continue
            pid = fila[0]
            for m in mods:
                con.execute("INSERT INTO plan_modulos (plan_id, modulo) VALUES (?,?)", (pid, m))
            for bid, v in zip(ids_b, vals):
                if v:
                    con.execute("INSERT INTO plan_beneficios (plan_id, beneficio_id, valor) VALUES (?,?,?)", (pid, bid, v))

        for orden, (cat, nombre, entregables) in enumerate(SERVICIOS, start=1):
            con.execute(
                "INSERT INTO servicios (modulo, categoria, nombre, entregables, orden) VALUES (?,?,?,?,?)",
                ("perucompras", cat, nombre, entregables, orden))

        for k, v in CONFIG.items():
            con.execute("INSERT INTO configuracion (clave, valor) VALUES (?,?) ON CONFLICT (clave) DO NOTHING", (k, v))

        con.execute("INSERT INTO configuracion (clave, valor) VALUES ('catalogo_sembrado','1') ON CONFLICT (clave) DO NOTHING")
        logger.info("Catálogo inicial cargado")
    finally:
        con.close()