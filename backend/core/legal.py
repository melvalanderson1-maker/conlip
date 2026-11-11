"""Textos legales base y armado de las páginas públicas (Términos y Privacidad).

Formato de los textos: '# Título' = encabezado, '- texto' = viñeta, y cada línea suelta es un párrafo.
Marcas que se reemplazan: {{sitio}} {{razon_social}} {{ruc}} {{domicilio}} {{correo}} {{ciudad}}
"""

CLAVES = {
    "razon_social": "legal_razon_social", "ruc": "legal_ruc", "domicilio": "legal_domicilio",
    "correo": "legal_correo", "ciudad": "legal_ciudad",
}
CLAVE_TERMINOS = "legal_terminos"
CLAVE_PRIVACIDAD = "legal_privacidad"
CLAVE_FECHA = "legal_actualizado"
FALTANTE = "(dato pendiente)"
MARCAS = ["{{sitio}}", "{{razon_social}}", "{{ruc}}", "{{domicilio}}", "{{correo}}", "{{ciudad}}"]

BASE_TERMINOS = """# 1. Quiénes somos y aceptación
{{sitio}} es una plataforma operada por {{razon_social}}, con RUC {{ruc}} y domicilio en {{domicilio}} (en adelante, "nosotros"). Estos Términos y Condiciones regulan el uso de la plataforma y la contratación de sus planes y servicios. Al crear una cuenta, realizar una compra o usar la plataforma, declaras que los leíste y los aceptas.

# 2. Qué ofrecemos
- Búsqueda, seguimiento y cotización de contrataciones del Estado: contratos menores, contratos mayores (SEACE) y Perú Compras.
- Planes por suscripción con acceso a módulos, capacitación en video y material de apoyo.
- Servicios personalizados con entregables definidos y sesiones de asesoría en vivo.
La información de contrataciones proviene de fuentes públicas y puede tener retrasos o errores de origen. {{sitio}} no es una entidad del Estado ni está afiliada a ellas, y no garantiza que una cotización sea aceptada ni que se obtenga una adjudicación.

# 3. Cuenta y usuarios
La cuenta pertenece a su titular: la persona natural o la empresa que contrata. El titular es responsable de la información que registra, de los usuarios que agrega dentro del cupo de su plan y de la confidencialidad de las claves. Cada usuario debe usar su propio acceso; no se permite compartir credenciales. Debes avisarnos de inmediato si sospechas un uso no autorizado.

# 4. Planes, precios y pagos
Los precios se muestran en soles (S/) y pueden cambiar; el precio que se te informa al comprar es el que se aplica al periodo contratado. El pago se procesa a través de una pasarela de pagos de terceros: {{sitio}} no almacena los datos de tu tarjeta. La compra se confirma cuando el pago es aprobado.

# 5. Vigencia y renovación
Cada plan tiene un periodo de vigencia (mensual o anual) y un modo de acceso: solo visualizar, o visualizar y cotizar. Al vencer, el acceso se suspende hasta que renueves. La plataforma no realiza cobros automáticos: renuevas o amplías tu plan desde "Mi cuenta" cuando lo decidas.

# 6. Servicios personalizados y sesiones
Los servicios incluyen los entregables y el número de sesiones indicados en su descripción. Las sesiones se agendan en la plataforma según la disponibilidad de los asesores y pueden reprogramarse o cancelarse con la anticipación indicada en tu panel. Una sesión a la que no asistas no se cuenta como realizada. El avance de los entregables se registra en tu panel a medida que se cumplen.

# 7. Capacitación y contenidos
Los cursos, videos, documentos y demás materiales son para el uso personal de los usuarios de tu cuenta. Está prohibido descargarlos para redistribuirlos, venderlos, compartirlos con terceros o publicarlos.

# 8. Uso aceptable
No puedes usar la plataforma para actividades ilícitas, intentar acceder sin autorización a cuentas o sistemas, extraer información de forma masiva y automatizada, interferir con su funcionamiento o vulnerar derechos de terceros. Podemos suspender las cuentas que incumplan estas reglas.

# 9. Propiedad intelectual
La plataforma, su diseño, textos, cursos y demás contenidos pertenecen a {{razon_social}} o a sus licenciantes. Estos términos no te transfieren ningún derecho distinto al de usarla conforme a lo aquí indicado.

# 10. Disponibilidad y responsabilidad
Hacemos lo razonable para mantener la plataforma disponible, pero pueden ocurrir interrupciones por mantenimiento o por causas ajenas a nosotros. En la medida permitida por la ley, no respondemos por decisiones comerciales tomadas con base en la información de la plataforma ni por pérdidas indirectas.

# 11. Cambios en estos términos
Podemos actualizar estos términos. La versión vigente es la publicada en esta página, con su fecha de actualización. Si el cambio es importante, te avisaremos por correo o dentro de la plataforma.

# 12. Reclamos y atención al cliente
Puedes presentar consultas, quejas o reclamos escribiendo a {{correo}}. Los atenderemos en los plazos que establece la normativa de protección al consumidor.

# 13. Ley aplicable y jurisdicción
Estos términos se rigen por las leyes de la República del Perú. Cualquier controversia se someterá a los jueces y tribunales de {{ciudad}}, sin perjuicio de los derechos que la ley reconoce a los consumidores.

# 14. Contacto
{{razon_social}} · RUC {{ruc}} · {{domicilio}} · {{correo}}
"""

BASE_PRIVACIDAD = """# 1. Responsable del tratamiento
{{razon_social}}, con RUC {{ruc}} y domicilio en {{domicilio}}, es la responsable del tratamiento de tus datos personales en {{sitio}}, conforme a la Ley N.º 29733, Ley de Protección de Datos Personales, y su Reglamento.

# 2. Qué datos recopilamos
- Identificación y contacto: nombre o razón social, tipo y número de documento (DNI, RUC, CE o pasaporte), correo electrónico y teléfono.
- Datos de la cuenta: usuario, rol, permisos, planes contratados y su vigencia.
- Datos de uso: contrataciones asignadas, cotizaciones, avance en cursos, sesiones agendadas y registros de acceso, como la dirección IP y la fecha de ingreso.
- Datos de pago: tu tarjeta la procesa la pasarela de pagos; nosotros solo recibimos el resultado y una referencia de la operación, no el número de la tarjeta.

# 3. Para qué los usamos
- Crear y administrar tu cuenta y darte acceso a los módulos contratados.
- Procesar compras y renovaciones.
- Prestar los servicios personalizados y coordinar tus sesiones de asesoría.
- Enviarte avisos del servicio: enlaces de acceso, recordatorios de sesiones, vencimientos y novedades de la plataforma.
- Mantener la seguridad, prevenir fraudes y cumplir obligaciones legales.

# 4. Base del tratamiento
Tratamos tus datos para ejecutar el contrato que celebras con nosotros, para cumplir obligaciones legales y, cuando corresponde, con tu consentimiento, que puedes retirar en cualquier momento.

# 5. Con quién los compartimos
No vendemos tus datos. Los compartimos solo con proveedores que nos ayudan a operar la plataforma y que los tratan por encargo nuestro: la pasarela de pagos, el envío de correos, el alojamiento de servidores y las herramientas de videollamada (como Zoom o Google Meet) cuando se agenda una sesión. También podemos entregar datos a las autoridades cuando la ley lo exija.

# 6. Cuánto tiempo los conservamos
Conservamos tus datos mientras tu cuenta esté activa y, después, por el tiempo necesario para cumplir obligaciones legales o contables y atender reclamos. Luego los eliminamos o anonimizamos.

# 7. Tus derechos
Puedes ejercer tus derechos de acceso, rectificación, cancelación y oposición, y revocar tu consentimiento, escribiendo a {{correo}} e indicando tu nombre y número de documento. Responderemos en los plazos que fija la ley. Si consideras que no atendimos tu solicitud, puedes acudir a la Autoridad Nacional de Protección de Datos Personales.

# 8. Seguridad
Aplicamos medidas técnicas y organizativas razonables: claves protegidas, conexiones cifradas, control de acceso por roles y registro de actividad. Ningún sistema es infalible; si ocurre un incidente que afecte tus datos, actuaremos conforme a la normativa.

# 9. Almacenamiento del navegador
Usamos el almacenamiento del navegador para mantener tu sesión iniciada mientras la pestaña esté abierta. No usamos publicidad de terceros.

# 10. Menores de edad
La plataforma está dirigida a personas mayores de edad y a empresas. No recopilamos a sabiendas datos de menores de edad.

# 11. Cambios en esta política
Podemos actualizar esta política. La versión vigente es la publicada en esta página, con su fecha de actualización.

# 12. Contacto
Para consultas sobre privacidad: {{correo}}. {{razon_social}} · RUC {{ruc}} · {{domicilio}}.
"""


def leer_crudo(con) -> dict[str, str]:
    claves = [*CLAVES.values(), CLAVE_TERMINOS, CLAVE_PRIVACIDAD, CLAVE_FECHA, "sitio_nombre", "contacto_correo"]
    return {r["clave"]: r["valor"] for r in con.execute(
        "SELECT clave, valor FROM configuracion WHERE clave = ANY(?)", (claves,)).fetchall()}


def armar(con) -> dict:
    """Lo que ve el público: textos con los datos del titular ya puestos."""
    cfg = leer_crudo(con)
    datos = {k: (cfg.get(c) or "").strip() for k, c in CLAVES.items()}
    if not datos["correo"]:
        datos["correo"] = (cfg.get("contacto_correo") or "").strip()
    sitio = (cfg.get("sitio_nombre") or "").strip() or "COTI"
    valores = {**{k: (v or FALTANTE) for k, v in datos.items()}, "sitio": sitio}

    def llenar(texto: str) -> str:
        for k, v in valores.items():
            texto = texto.replace("{{" + k + "}}", v)
        return texto

    return {
        "sitio": sitio,
        "actualizado": cfg.get(CLAVE_FECHA, ""),
        "terminos": llenar(cfg.get(CLAVE_TERMINOS) or BASE_TERMINOS),
        "privacidad": llenar(cfg.get(CLAVE_PRIVACIDAD) or BASE_PRIVACIDAD),
    }