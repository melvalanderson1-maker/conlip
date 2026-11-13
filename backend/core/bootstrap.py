import logging
import os

from core.db import abrir_db
from core.seguridad import hash_clave, secreto

logger = logging.getLogger("bootstrap")

PASOS = [
    """CREATE TABLE IF NOT EXISTS usuarios (
        id SERIAL PRIMARY KEY,
        usuario TEXT UNIQUE NOT NULL,
        nombre TEXT,
        clave_hash TEXT NOT NULL,
        rol TEXT NOT NULL DEFAULT 'visualizador',
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TIMESTAMP DEFAULT now()
    )""",
    "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS permisos TEXT[] NOT NULL DEFAULT '{}'",
    "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS token_ver INTEGER NOT NULL DEFAULT 0",
    # Usuarios del esquema viejo (rol 'usuario') pasan a visualizador de Coti Menor
    "UPDATE usuarios SET rol='visualizador', permisos=ARRAY['menor:ver','menor:archivos'] WHERE rol='usuario'",
    """CREATE TABLE IF NOT EXISTS auditoria (
        id BIGSERIAL PRIMARY KEY,
        fecha TIMESTAMP NOT NULL DEFAULT now(),
        usuario TEXT,
        accion TEXT NOT NULL,
        detalle TEXT,
        ip TEXT
    )""",
    "CREATE INDEX IF NOT EXISTS ix_auditoria_fecha ON auditoria(fecha DESC)",
    """CREATE TABLE IF NOT EXISTS asignaciones (
        id BIGSERIAL PRIMARY KEY,
        id_contrato BIGINT NOT NULL,
        asignado_a INTEGER NOT NULL REFERENCES usuarios(id),
        asignado_por INTEGER NOT NULL REFERENCES usuarios(id),
        estado TEXT NOT NULL DEFAULT 'pendiente'
            CHECK (estado IN ('pendiente','en_curso','cotizada','descartada')),
        nota TEXT,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
        actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
        visto_en TIMESTAMPTZ,
        UNIQUE (id_contrato, asignado_a)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_asig_para ON asignaciones(asignado_a, visto_en)",
    "CREATE INDEX IF NOT EXISTS ix_asig_contrato ON asignaciones(id_contrato)",
    # ---------- Multi-empresa, planes y suscripciones ----------
    """CREATE TABLE IF NOT EXISTS empresas (
        id SERIAL PRIMARY KEY,
        tipo TEXT NOT NULL CHECK (tipo IN ('empresa','persona')),
        nombre TEXT NOT NULL,
        doc_tipo TEXT NOT NULL CHECK (doc_tipo IN ('RUC','DNI','CE','PASAPORTE')),
        doc_numero TEXT NOT NULL,
        correo TEXT NOT NULL,
        cupo_usuarios INTEGER NOT NULL DEFAULT 1,
        activo INTEGER NOT NULL DEFAULT 1,
        creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
        UNIQUE (doc_tipo, doc_numero)
    )""",
    "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS empresa_id INTEGER REFERENCES empresas(id)",
    "CREATE INDEX IF NOT EXISTS ix_usuarios_empresa ON usuarios(empresa_id)",
    """CREATE TABLE IF NOT EXISTS planes (
        id SERIAL PRIMARY KEY,
        codigo TEXT UNIQUE NOT NULL,
        nombre TEXT NOT NULL,
        descripcion TEXT NOT NULL DEFAULT '',
        en_venta INTEGER NOT NULL DEFAULT 0,
        orden INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS precios (
        id SERIAL PRIMARY KEY,
        plan_id INTEGER NOT NULL REFERENCES planes(id) ON DELETE CASCADE,
        tipo_cuenta TEXT NOT NULL CHECK (tipo_cuenta IN ('empresa','persona')),
        concepto TEXT NOT NULL CHECK (concepto IN ('ver','cotizar','usuario_extra')),
        periodo TEXT NOT NULL CHECK (periodo IN ('mensual','anual')),
        monto NUMERIC(10,2) NOT NULL CHECK (monto >= 0),
        UNIQUE (plan_id, tipo_cuenta, concepto, periodo)
    )""",
    """CREATE TABLE IF NOT EXISTS suscripciones (
        id BIGSERIAL PRIMARY KEY,
        empresa_id INTEGER NOT NULL REFERENCES empresas(id),
        plan_id INTEGER NOT NULL REFERENCES planes(id),
        modo TEXT NOT NULL CHECK (modo IN ('ver','cotizar')),
        periodo TEXT NOT NULL CHECK (periodo IN ('mensual','anual')),
        inicio TIMESTAMPTZ NOT NULL DEFAULT now(),
        vence_en TIMESTAMPTZ NOT NULL,
        estado TEXT NOT NULL DEFAULT 'activa' CHECK (estado IN ('activa','cancelada')),
        UNIQUE (empresa_id, plan_id)
    )""",
    "CREATE INDEX IF NOT EXISTS ix_susc_empresa ON suscripciones(empresa_id)",

    # Migración: tu primer admin pasa a superadmin; los demás usuarios existentes quedan en la empresa 'Demo'
    """UPDATE usuarios SET rol='superadmin', empresa_id=NULL
       WHERE id=(SELECT MIN(id) FROM usuarios WHERE rol='admin')
         AND NOT EXISTS (SELECT 1 FROM usuarios WHERE rol='superadmin')""",
    """INSERT INTO empresas (tipo, nombre, doc_tipo, doc_numero, correo, cupo_usuarios)
       SELECT 'empresa','Demo','RUC','00000000000','demo@invalido.local',10
        WHERE EXISTS (SELECT 1 FROM usuarios WHERE empresa_id IS NULL AND rol NOT IN ('superadmin','asesor','ejecutivo'))
       ON CONFLICT (doc_tipo, doc_numero) DO NOTHING""",
    """UPDATE usuarios SET empresa_id=(SELECT id FROM empresas WHERE doc_tipo='RUC' AND doc_numero='00000000000')
    WHERE empresa_id IS NULL AND rol NOT IN ('superadmin','asesor','ejecutivo')""",
    # ---------- Catálogo configurable (Fase 2A) ----------
    "ALTER TABLE planes ADD COLUMN IF NOT EXISTS subtitulo TEXT NOT NULL DEFAULT ''",
    "ALTER TABLE planes ADD COLUMN IF NOT EXISTS destacado INTEGER NOT NULL DEFAULT 0",
    "ALTER TABLE planes ADD COLUMN IF NOT EXISTS usuarios_incluidos INTEGER NOT NULL DEFAULT 3",
    """CREATE TABLE IF NOT EXISTS plan_modulos (
        plan_id INTEGER NOT NULL REFERENCES planes(id) ON DELETE CASCADE,
        modulo TEXT NOT NULL CHECK (modulo IN ('perucompras','menor','mayor')),
        PRIMARY KEY (plan_id, modulo)
    )""",
    """CREATE TABLE IF NOT EXISTS beneficios (
        id SERIAL PRIMARY KEY,
        nombre TEXT NOT NULL,
        tipo TEXT NOT NULL DEFAULT 'check' CHECK (tipo IN ('check','numero','texto')),
        visible INTEGER NOT NULL DEFAULT 1,
        orden INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS plan_beneficios (
        plan_id INTEGER NOT NULL REFERENCES planes(id) ON DELETE CASCADE,
        beneficio_id INTEGER NOT NULL REFERENCES beneficios(id) ON DELETE CASCADE,
        valor TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (plan_id, beneficio_id)
    )""",
    """CREATE TABLE IF NOT EXISTS servicios (
        id SERIAL PRIMARY KEY,
        categoria TEXT NOT NULL,
        nombre TEXT NOT NULL,
        descripcion TEXT NOT NULL DEFAULT '',
        entregables TEXT[] NOT NULL DEFAULT '{}',
        precio NUMERIC(10,2) CHECK (precio IS NULL OR precio >= 0),
        activo INTEGER NOT NULL DEFAULT 1,
        orden INTEGER NOT NULL DEFAULT 0
    )""",
    """CREATE TABLE IF NOT EXISTS configuracion (
        clave TEXT PRIMARY KEY,
        valor TEXT NOT NULL DEFAULT ''
    )""",
    # Los paquetes originales (Fase 1) conservan su módulo (solo hasta el primer sembrado)
    """INSERT INTO plan_modulos (plan_id, modulo)
       SELECT id, codigo FROM planes WHERE codigo IN ('perucompras','menor','mayor')
         AND NOT EXISTS (SELECT 1 FROM configuracion WHERE clave='catalogo_sembrado')
        ON CONFLICT DO NOTHING""",
            # ---------- Servicios por paquete ----------
            "ALTER TABLE servicios ADD COLUMN IF NOT EXISTS modulo TEXT "
            "CHECK (modulo IS NULL OR modulo IN ('perucompras','menor','mayor'))",
            # Una sola vez: los servicios ya cargados de Perú Compras y Capacitación 360° pasan a ese paquete
            """UPDATE servicios SET modulo='perucompras'
            WHERE modulo IS NULL AND categoria IN ('Ingresa a Perú Compras','Capacitación 360°')
                AND NOT EXISTS (SELECT 1 FROM configuracion WHERE clave='servicios_modulo_migrado')""",
            "INSERT INTO configuracion (clave, valor) VALUES ('servicios_modulo_migrado','1') ON CONFLICT (clave) DO NOTHING",
            # ---------- Checkout, órdenes y accesos (Fase 2B) ----------
            # ---------- Capacitación (Fase 3) ----------
            """CREATE TABLE IF NOT EXISTS archivos_aprende (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                ruta TEXT NOT NULL UNIQUE,
                mime TEXT NOT NULL,
                categoria TEXT NOT NULL CHECK (categoria IN ('video','audio','documento','imagen')),
                tamano BIGINT NOT NULL,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS cursos (
                id SERIAL PRIMARY KEY,
                modulo TEXT CHECK (modulo IS NULL OR modulo IN ('perucompras','menor','mayor')),
                titulo TEXT NOT NULL,
                subtitulo TEXT NOT NULL DEFAULT '',
                descripcion TEXT NOT NULL DEFAULT '',
                nivel TEXT NOT NULL DEFAULT 'todos' CHECK (nivel IN ('todos','basico','intermedio','avanzado')),
                instructor TEXT NOT NULL DEFAULT '',
                portada_id INTEGER REFERENCES archivos_aprende(id) ON DELETE SET NULL,
                publicado INTEGER NOT NULL DEFAULT 0,
                publico INTEGER NOT NULL DEFAULT 1,
                destacado INTEGER NOT NULL DEFAULT 0,
                orden INTEGER NOT NULL DEFAULT 0,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS curso_secciones (
                id SERIAL PRIMARY KEY,
                curso_id INTEGER NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
                titulo TEXT NOT NULL,
                orden INTEGER NOT NULL DEFAULT 0
            )""",
            """CREATE TABLE IF NOT EXISTS lecciones (
                id SERIAL PRIMARY KEY,
                seccion_id INTEGER NOT NULL REFERENCES curso_secciones(id) ON DELETE CASCADE,
                titulo TEXT NOT NULL,
                tipo TEXT NOT NULL CHECK (tipo IN ('video','audio','documento','imagen','texto')),
                archivo_id INTEGER REFERENCES archivos_aprende(id) ON DELETE SET NULL,
                url_externa TEXT,
                contenido TEXT NOT NULL DEFAULT '',
                duracion_seg INTEGER NOT NULL DEFAULT 0,
                orden INTEGER NOT NULL DEFAULT 0
            )""",
            """CREATE TABLE IF NOT EXISTS curso_planes (
                curso_id INTEGER NOT NULL REFERENCES cursos(id) ON DELETE CASCADE,
                plan_id INTEGER NOT NULL REFERENCES planes(id) ON DELETE CASCADE,
                PRIMARY KEY (curso_id, plan_id)
            )""",
            """CREATE TABLE IF NOT EXISTS progreso_lecciones (
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                leccion_id INTEGER NOT NULL REFERENCES lecciones(id) ON DELETE CASCADE,
                visto_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                completada_en TIMESTAMPTZ,
                PRIMARY KEY (usuario_id, leccion_id)
            )""",
            "CREATE INDEX IF NOT EXISTS ix_secciones_curso ON curso_secciones(curso_id, orden)",
            "CREATE INDEX IF NOT EXISTS ix_lecciones_seccion ON lecciones(seccion_id, orden)",
            "ALTER TABLE lecciones ADD COLUMN IF NOT EXISTS vista_previa INTEGER NOT NULL DEFAULT 0",
            # Una sola vez: la primera lección de cada curso ya cargado queda como vista previa gratuita
            """UPDATE lecciones SET vista_previa=1 WHERE id IN (
                SELECT DISTINCT ON (s.curso_id) l.id FROM lecciones l JOIN curso_secciones s ON s.id = l.seccion_id
                ORDER BY s.curso_id, s.orden, s.id, l.orden, l.id)
            AND NOT EXISTS (SELECT 1 FROM configuracion WHERE clave='vista_previa_migrada')""",
            "INSERT INTO configuracion (clave, valor) VALUES ('vista_previa_migrada','1') ON CONFLICT (clave) DO NOTHING",
            "ALTER TABLE progreso_lecciones ADD COLUMN IF NOT EXISTS posicion_seg INTEGER NOT NULL DEFAULT 0",
            # ---------- Anuncios ----------
            """CREATE TABLE IF NOT EXISTS anuncios (
                id SERIAL PRIMARY KEY,
                tipo TEXT NOT NULL DEFAULT 'novedad' CHECK (tipo IN ('curso','novedad','promocion')),
                titulo TEXT NOT NULL,
                mensaje TEXT NOT NULL DEFAULT '',
                curso_id INTEGER REFERENCES cursos(id) ON DELETE SET NULL,
                para_clientes INTEGER NOT NULL DEFAULT 1,
                para_publico INTEGER NOT NULL DEFAULT 1,
                activo INTEGER NOT NULL DEFAULT 0,
                publicado_en TIMESTAMPTZ,
                vence_en TIMESTAMPTZ,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS anuncios_leidos (
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                anuncio_id INTEGER NOT NULL REFERENCES anuncios(id) ON DELETE CASCADE,
                leido_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (usuario_id, anuncio_id)
            )""",
            "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS correo TEXT",
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_usuarios_correo ON usuarios (lower(correo)) WHERE correo IS NOT NULL",
            "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS usuarios_extra INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE empresas ADD COLUMN IF NOT EXISTS extras_vence_en TIMESTAMPTZ",
            """CREATE TABLE IF NOT EXISTS ordenes (
                id TEXT PRIMARY KEY,
                empresa_id INTEGER REFERENCES empresas(id),
                tipo_cuenta TEXT NOT NULL CHECK (tipo_cuenta IN ('empresa','persona')),
                periodo TEXT NOT NULL CHECK (periodo IN ('mensual','anual')),
                comprador JSONB NOT NULL DEFAULT '{}'::jsonb,
                usuarios_extra INTEGER NOT NULL DEFAULT 0,
                total NUMERIC(10,2) NOT NULL CHECK (total > 0),
                moneda TEXT NOT NULL DEFAULT 'PEN',
                estado TEXT NOT NULL DEFAULT 'pendiente'
                    CHECK (estado IN ('pendiente','pagada','error_aprovision','cancelada')),
                proveedor TEXT,
                ref_externa TEXT,
                intentos INTEGER NOT NULL DEFAULT 0,
                ip TEXT,
                terminos_en TIMESTAMPTZ,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                pagado_en TIMESTAMPTZ
            )""",
            """CREATE TABLE IF NOT EXISTS orden_items (
                id SERIAL PRIMARY KEY,
                orden_id TEXT NOT NULL REFERENCES ordenes(id) ON DELETE CASCADE,
                tipo TEXT NOT NULL CHECK (tipo IN ('plan','servicio','usuarios_extra')),
                plan_id INTEGER,
                servicio_id INTEGER,
                modo TEXT,
                cantidad INTEGER NOT NULL DEFAULT 1,
                monto_unit NUMERIC(10,2) NOT NULL,
                descripcion TEXT NOT NULL DEFAULT ''
            )""",
            """CREATE TABLE IF NOT EXISTS pedidos_servicio (
                id SERIAL PRIMARY KEY,
                servicio_id INTEGER,
                servicio_nombre TEXT NOT NULL DEFAULT '',
                empresa_id INTEGER,
                orden_id TEXT,
                origen TEXT NOT NULL CHECK (origen IN ('compra','cotizacion')),
                estado TEXT NOT NULL DEFAULT 'nuevo' CHECK (estado IN ('nuevo','en_curso','entregado','cancelado')),
                nombre TEXT NOT NULL DEFAULT '',
                correo TEXT NOT NULL DEFAULT '',
                telefono TEXT NOT NULL DEFAULT '',
                mensaje TEXT NOT NULL DEFAULT '',
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            # ---------- Agenda y seguimiento de servicios ----------
            "ALTER TABLE servicios ADD COLUMN IF NOT EXISTS sesiones INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE servicios ADD COLUMN IF NOT EXISTS duracion_sesion_min INTEGER NOT NULL DEFAULT 60",
            "ALTER TABLE pedidos_servicio ADD COLUMN IF NOT EXISTS entregables_ok INTEGER NOT NULL DEFAULT 0",
            """CREATE TABLE IF NOT EXISTS asesores (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                correo TEXT NOT NULL DEFAULT '',
                plataforma TEXT NOT NULL DEFAULT 'meet' CHECK (plataforma IN ('meet','zoom','otra')),
                enlace TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT '#1d4ed8',
                activo INTEGER NOT NULL DEFAULT 1,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS asesor_horarios (
                id SERIAL PRIMARY KEY,
                asesor_id INTEGER NOT NULL REFERENCES asesores(id) ON DELETE CASCADE,
                dia SMALLINT NOT NULL CHECK (dia BETWEEN 0 AND 6),
                inicio TIME NOT NULL,
                fin TIME NOT NULL,
                CHECK (fin > inicio)
            )""",
            """CREATE TABLE IF NOT EXISTS asesor_bloqueos (
                id SERIAL PRIMARY KEY,
                asesor_id INTEGER NOT NULL REFERENCES asesores(id) ON DELETE CASCADE,
                desde TIMESTAMPTZ NOT NULL,
                hasta TIMESTAMPTZ NOT NULL,
                motivo TEXT NOT NULL DEFAULT '',
                CHECK (hasta > desde)
            )""",
            """CREATE TABLE IF NOT EXISTS servicio_asesores (
                servicio_id INTEGER NOT NULL REFERENCES servicios(id) ON DELETE CASCADE,
                asesor_id INTEGER NOT NULL REFERENCES asesores(id) ON DELETE CASCADE,
                PRIMARY KEY (servicio_id, asesor_id)
            )""",
            """CREATE TABLE IF NOT EXISTS pedido_entregables (
                id SERIAL PRIMARY KEY,
                pedido_id INTEGER NOT NULL REFERENCES pedidos_servicio(id) ON DELETE CASCADE,
                orden INTEGER NOT NULL DEFAULT 0,
                titulo TEXT NOT NULL,
                estado TEXT NOT NULL DEFAULT 'pendiente' CHECK (estado IN ('pendiente','en_curso','hecho')),
                nota TEXT NOT NULL DEFAULT '',
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS sesiones_servicio (
                id SERIAL PRIMARY KEY,
                pedido_id INTEGER NOT NULL REFERENCES pedidos_servicio(id) ON DELETE CASCADE,
                asesor_id INTEGER NOT NULL REFERENCES asesores(id),
                inicio TIMESTAMPTZ NOT NULL,
                fin TIMESTAMPTZ NOT NULL,
                estado TEXT NOT NULL DEFAULT 'programada' CHECK (estado IN ('programada','realizada','no_asistio','cancelada')),
                enlace TEXT NOT NULL DEFAULT '',
                plataforma TEXT NOT NULL DEFAULT '',
                nota TEXT NOT NULL DEFAULT '',
                creado_por TEXT NOT NULL DEFAULT 'admin',
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                CHECK (fin > inicio)
            )""",
            # Un asesor no puede tener dos sesiones programadas que empiecen a la misma hora
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_sesion_asesor_inicio ON sesiones_servicio (asesor_id, inicio) WHERE estado = 'programada'",
            "CREATE INDEX IF NOT EXISTS ix_sesiones_inicio ON sesiones_servicio (inicio)",
            "CREATE INDEX IF NOT EXISTS ix_sesiones_pedido ON sesiones_servicio (pedido_id)",
            "ALTER TABLE sesiones_servicio ADD COLUMN IF NOT EXISTS recordatorio_24h INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE sesiones_servicio ADD COLUMN IF NOT EXISTS recordatorio_1h INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE asesores ADD COLUMN IF NOT EXISTS modo_enlace TEXT NOT NULL DEFAULT 'fijo' CHECK (modo_enlace IN ('fijo','api'))",
            "ALTER TABLE asesores ADD COLUMN IF NOT EXISTS zoom_usuario TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE sesiones_servicio ADD COLUMN IF NOT EXISTS proveedor TEXT NOT NULL DEFAULT 'fijo'",
            "ALTER TABLE sesiones_servicio ADD COLUMN IF NOT EXISTS ext_id TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE asesores ADD COLUMN IF NOT EXISTS usuario_id INTEGER UNIQUE REFERENCES usuarios(id) ON DELETE SET NULL",
            # ---------- Verificación en dos pasos ----------
            "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_secreto TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_activo INTEGER NOT NULL DEFAULT 0",
            # Último periodo de 30 s aceptado: impide reutilizar un mismo código
            "ALTER TABLE usuarios ADD COLUMN IF NOT EXISTS totp_paso BIGINT NOT NULL DEFAULT 0",
            """CREATE TABLE IF NOT EXISTS codigos_respaldo (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                codigo_hash TEXT NOT NULL,
                usado_en TIMESTAMPTZ
            )""",
            "CREATE INDEX IF NOT EXISTS ix_codigos_respaldo_usuario ON codigos_respaldo (usuario_id)",
            # ---------- Ventas por WhatsApp: confirmación manual del pago ----------
            "ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS metodo_pago TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS nota_pago TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS confirmado_por TEXT NOT NULL DEFAULT ''",
            "ALTER TABLE ordenes ADD COLUMN IF NOT EXISTS contactado_en TIMESTAMPTZ",
            # ---------- CRM ----------
            """CREATE TABLE IF NOT EXISTS crm_etapas (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                orden INTEGER NOT NULL DEFAULT 0,
                tipo TEXT NOT NULL DEFAULT 'abierta' CHECK (tipo IN ('abierta','ganada','perdida')),
                color TEXT NOT NULL DEFAULT '#64748b',
                activa INTEGER NOT NULL DEFAULT 1
            )""",
            """INSERT INTO crm_etapas (nombre, orden, tipo, color)
            SELECT v.n, v.o, v.t, v.c FROM (VALUES
                ('Nuevo', 1, 'abierta', '#64748b'), ('Contactado', 2, 'abierta', '#0ea5e9'),
                ('Interesado', 3, 'abierta', '#6366f1'), ('Propuesta', 4, 'abierta', '#f59e0b'),
                ('Negociación', 5, 'abierta', '#ec4899'), ('Ganado', 6, 'ganada', '#10b981'), ('Perdido', 7, 'perdida', '#ef4444')
            ) AS v(n, o, t, c) WHERE NOT EXISTS (SELECT 1 FROM crm_etapas)""",
            """CREATE TABLE IF NOT EXISTS crm_leads (
                id BIGSERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                empresa_nombre TEXT NOT NULL DEFAULT '',
                correo TEXT NOT NULL DEFAULT '',
                telefono TEXT NOT NULL DEFAULT '',
                doc_tipo TEXT NOT NULL DEFAULT '',
                doc_numero TEXT NOT NULL DEFAULT '',
                origen TEXT NOT NULL DEFAULT 'manual',
                interes TEXT NOT NULL DEFAULT '',
                valor_estimado NUMERIC(12,2) NOT NULL DEFAULT 0,
                etapa_id INTEGER NOT NULL REFERENCES crm_etapas(id),
                estado TEXT NOT NULL DEFAULT 'abierto' CHECK (estado IN ('abierto','ganado','perdido')),
                motivo_perdida TEXT NOT NULL DEFAULT '',
                asesor_id INTEGER REFERENCES asesores(id) ON DELETE SET NULL,
                orden_id TEXT,
                siguiente_accion_en TIMESTAMPTZ,
                ultimo_contacto_en TIMESTAMPTZ,
                creado_por TEXT NOT NULL DEFAULT 'sistema',
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_asesor ON crm_leads (asesor_id, estado)",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_etapa ON crm_leads (etapa_id)",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_tel ON crm_leads (telefono) WHERE telefono <> ''",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_correo ON crm_leads (lower(correo)) WHERE correo <> ''",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_orden ON crm_leads (orden_id) WHERE orden_id IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_sig ON crm_leads (siguiente_accion_en) WHERE estado = 'abierto'",
            """CREATE TABLE IF NOT EXISTS crm_actividades (
                id BIGSERIAL PRIMARY KEY,
                lead_id BIGINT NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
                tipo TEXT NOT NULL CHECK (tipo IN ('nota','llamada','whatsapp','correo','reunion','tarea','sistema')),
                contenido TEXT NOT NULL DEFAULT '',
                usuario TEXT NOT NULL DEFAULT 'sistema',
                programada_en TIMESTAMPTZ,
                completada_en TIMESTAMPTZ,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "CREATE INDEX IF NOT EXISTS ix_crm_act_lead ON crm_actividades (lead_id, creado_en DESC)",
                # ---------- CRM: WhatsApp Business ----------
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS wa_ultimo_entrante TIMESTAMPTZ",
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS wa_no_leidos INTEGER NOT NULL DEFAULT 0",
            """CREATE TABLE IF NOT EXISTS crm_mensajes (
                id BIGSERIAL PRIMARY KEY,
                lead_id BIGINT NOT NULL REFERENCES crm_leads(id) ON DELETE CASCADE,
                direccion TEXT NOT NULL CHECK (direccion IN ('in','out')),
                wa_id TEXT,
                tipo TEXT NOT NULL DEFAULT 'text',
                texto TEXT NOT NULL DEFAULT '',
                media_id TEXT,
                media_mime TEXT,
                media_nombre TEXT,
                estado TEXT NOT NULL DEFAULT 'recibido',
                error TEXT NOT NULL DEFAULT '',
                enviado_por TEXT NOT NULL DEFAULT '',
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            # Un mensaje de WhatsApp (wamid) solo se guarda una vez, aunque Meta reintente el aviso
            "CREATE UNIQUE INDEX IF NOT EXISTS ux_crm_msg_wa ON crm_mensajes (wa_id) WHERE wa_id IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS ix_crm_msg_lead ON crm_mensajes (lead_id, creado_en DESC)",
            # Un aviso por suscripción, por fecha de vencimiento y por umbral: al renovar cambia la fecha y el ciclo empieza de nuevo
            """CREATE TABLE IF NOT EXISTS avisos_vencimiento (
                suscripcion_id BIGINT NOT NULL REFERENCES suscripciones(id) ON DELETE CASCADE,
                vence_en TIMESTAMPTZ NOT NULL,
                umbral INTEGER NOT NULL,
                enviado_en TIMESTAMPTZ NOT NULL DEFAULT now(),
                PRIMARY KEY (suscripcion_id, vence_en, umbral)
            )""",
            """CREATE TABLE IF NOT EXISTS secretos (
                clave TEXT PRIMARY KEY,
                valor TEXT NOT NULL,
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS tokens_clave (
                id SERIAL PRIMARY KEY,
                usuario_id INTEGER NOT NULL REFERENCES usuarios(id) ON DELETE CASCADE,
                token_hash TEXT UNIQUE NOT NULL,
                vence_en TIMESTAMPTZ NOT NULL,
                usado_en TIMESTAMPTZ,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            # ---------- Coti Mayor (licitaciones / contratos mayores) ----------
            """CREATE TABLE IF NOT EXISTS procesos_mayor (
                ocid TEXT PRIMARY KEY,
                nomenclatura TEXT,
                anio INTEGER,
                titulo TEXT,
                descripcion TEXT,
                entidad TEXT,
                modalidad TEXT,
                categoria TEXT,
                fecha_convocatoria TIMESTAMP,
                monto NUMERIC(15,2),
                moneda TEXT,
                detalle JSONB,
                documentos JSONB,
                cronograma JSONB,
                ficha_en TIMESTAMPTZ,
                primera_vez TIMESTAMPTZ NOT NULL DEFAULT now(),
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "CREATE INDEX IF NOT EXISTS ix_mayor_fecha ON procesos_mayor(fecha_convocatoria DESC)",
            "CREATE INDEX IF NOT EXISTS ix_mayor_modalidad ON procesos_mayor(modalidad)",
            # ---------- Coti Mayor: datos de la API OCDS ----------
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS origen TEXT NOT NULL DEFAULT 'scraper'",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS tender_id TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS entidad_ruc TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS region TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS departamento TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS distrito TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS fecha_fin_consultas TIMESTAMP",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS estado TEXT",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS tiene_indicio_desierto INTEGER NOT NULL DEFAULT 0",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS published_date TIMESTAMPTZ",
            "CREATE INDEX IF NOT EXISTS ix_mayor_nomen ON procesos_mayor(nomenclatura)",
            """CREATE TABLE IF NOT EXISTS mayor_sync_estado (
                fuente TEXT PRIMARY KEY,
                ultima_fecha DATE,
                cursor_url TEXT
            )""",
            """CREATE TABLE IF NOT EXISTS mayor_adjudicaciones (
                id BIGSERIAL PRIMARY KEY,
                ocid TEXT NOT NULL REFERENCES procesos_mayor(ocid) ON DELETE CASCADE,
                award_id TEXT,
                proveedor TEXT,
                proveedor_ruc TEXT,
                monto NUMERIC(15,2),
                moneda TEXT,
                fecha_adjudicacion TIMESTAMPTZ,
                estado_award TEXT
            )""",
            "CREATE INDEX IF NOT EXISTS ix_mayor_adj_ocid ON mayor_adjudicaciones(ocid)",
            """CREATE TABLE IF NOT EXISTS mayor_items (
                id BIGSERIAL PRIMARY KEY,
                ocid TEXT NOT NULL REFERENCES procesos_mayor(ocid) ON DELETE CASCADE,
                item_id TEXT,
                origen_item TEXT,
                descripcion TEXT,
                cantidad NUMERIC(18,4),
                monto_total NUMERIC(18,2),
                precio_unitario NUMERIC(18,4),
                unidad TEXT,
                cubso TEXT,
                unspsc TEXT,
                proveedor TEXT,
                proveedor_ruc TEXT,
                fecha_adjudicacion TIMESTAMPTZ
            )""",
            "CREATE INDEX IF NOT EXISTS ix_mayor_items_ocid ON mayor_items(ocid)",
            # ---------- Coti Mayor: postores y ofertas ----------
            """CREATE TABLE IF NOT EXISTS mayor_postores_estado (
                ocid TEXT PRIMARY KEY REFERENCES procesos_mayor(ocid) ON DELETE CASCADE,
                estado TEXT NOT NULL DEFAULT 'pendiente',
                paso TEXT,
                error_msg TEXT,
                total_postores INTEGER,
                postor_actual INTEGER,
                actualizado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            """CREATE TABLE IF NOT EXISTS mayor_postores (
                id BIGSERIAL PRIMARY KEY,
                ocid TEXT NOT NULL REFERENCES procesos_mayor(ocid) ON DELETE CASCADE,
                orden INTEGER NOT NULL DEFAULT 0,
                ruc TEXT,
                razon_social TEXT,
                consorcio TEXT,
                tipo_proveedor TEXT,
                estado_propuesta TEXT,
                estado_registro TEXT,
                mype TEXT,
                monto_total NUMERIC(18,2),
                items JSONB,
                documentos JSONB,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "CREATE INDEX IF NOT EXISTS ix_mayor_postores_ocid ON mayor_postores(ocid)",
            "ALTER TABLE mayor_adjudicaciones ADD COLUMN IF NOT EXISTS raw JSONB",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS proxima_revision TIMESTAMPTZ",
            "ALTER TABLE procesos_mayor ADD COLUMN IF NOT EXISTS fallos_ficha INTEGER NOT NULL DEFAULT 0",
            "CREATE INDEX IF NOT EXISTS ix_mayor_revision ON procesos_mayor(proxima_revision)",

                        # ---------- Coti Mayor: historial de cambios de fichas ----------
            """CREATE TABLE IF NOT EXISTS procesos_mayor_historial (
                id BIGSERIAL PRIMARY KEY,
                ocid TEXT NOT NULL REFERENCES procesos_mayor(ocid) ON DELETE CASCADE,
                tipo TEXT NOT NULL,
                detalle JSONB,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "CREATE INDEX IF NOT EXISTS ix_historial_ocid ON procesos_mayor_historial (ocid, creado_en DESC)",
            "CREATE INDEX IF NOT EXISTS ix_historial_fecha ON procesos_mayor_historial (creado_en DESC)",
            # ---------- CRM-3: Facebook, Instagram y leads de anuncios ----------
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS fb_psid TEXT",
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ig_id TEXT",
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS fb_ultimo_entrante TIMESTAMPTZ",
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ig_ultimo_entrante TIMESTAMPTZ",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_fb ON crm_leads (fb_psid) WHERE fb_psid IS NOT NULL",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_ig ON crm_leads (ig_id) WHERE ig_id IS NOT NULL",
            "ALTER TABLE crm_mensajes ADD COLUMN IF NOT EXISTS canal TEXT NOT NULL DEFAULT 'whatsapp'",
            # ---------- CRM: equipo de ventas (ejecutivos) ----------
            """CREATE TABLE IF NOT EXISTS ejecutivos (
                id SERIAL PRIMARY KEY,
                nombre TEXT NOT NULL,
                correo TEXT NOT NULL DEFAULT '',
                telefono TEXT NOT NULL DEFAULT '',
                color TEXT NOT NULL DEFAULT '#0ea5e9',
                activo INTEGER NOT NULL DEFAULT 1,
                recibe_leads INTEGER NOT NULL DEFAULT 1,
                usuario_id INTEGER UNIQUE REFERENCES usuarios(id) ON DELETE SET NULL,
                asesor_id INTEGER UNIQUE REFERENCES asesores(id) ON DELETE SET NULL,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
            "ALTER TABLE crm_leads ADD COLUMN IF NOT EXISTS ejecutivo_id INTEGER REFERENCES ejecutivos(id) ON DELETE SET NULL",
            "CREATE INDEX IF NOT EXISTS ix_crm_leads_ejecutivo ON crm_leads (ejecutivo_id, estado)",
            # Una sola vez: los asesores que ya tenían acceso o leads pasan a ser ejecutivos (siguen siendo asesores también)
            """INSERT INTO ejecutivos (nombre, correo, color, activo, usuario_id, asesor_id)
               SELECT a.nombre, a.correo, a.color, a.activo, a.usuario_id, a.id FROM asesores a
                WHERE (a.usuario_id IS NOT NULL OR EXISTS (SELECT 1 FROM crm_leads l WHERE l.asesor_id = a.id))
                  AND NOT EXISTS (SELECT 1 FROM configuracion WHERE clave='ejecutivos_migrado')
               ON CONFLICT DO NOTHING""",
            """UPDATE crm_leads l SET ejecutivo_id = e.id FROM ejecutivos e
                WHERE e.asesor_id = l.asesor_id AND l.ejecutivo_id IS NULL
                  AND NOT EXISTS (SELECT 1 FROM configuracion WHERE clave='ejecutivos_migrado')""",
            "INSERT INTO configuracion (clave, valor) VALUES ('ejecutivos_migrado','1') ON CONFLICT (clave) DO NOTHING",
            # Un aviso de lead de anuncio se procesa una sola vez, aunque Meta lo reintente
            """CREATE TABLE IF NOT EXISTS crm_leadgen_vistos (
                leadgen_id TEXT PRIMARY KEY,
                creado_en TIMESTAMPTZ NOT NULL DEFAULT now()
            )""",
        ]


def iniciar_auth() -> None:
    """Crea/actualiza tablas y, si no hay usuarios, el administrador inicial del .env."""
    secreto()
    con = abrir_db()
    try:
        for sql in PASOS:
            con.execute(sql)
        n = con.execute("SELECT COUNT(*) FROM usuarios").fetchone()[0]
        if n == 0:
            u, c = os.getenv("ADMIN_USUARIO", ""), os.getenv("ADMIN_CLAVE", "")
            if not u or not c:
                raise RuntimeError("No hay usuarios: define ADMIN_USUARIO y ADMIN_CLAVE en el .env")
            con.execute(
                "INSERT INTO usuarios (usuario, nombre, clave_hash, rol) VALUES (?,?,?,?)",
                (u.strip().lower(), "Superadmin", hash_clave(c), "superadmin"),
            )
            logger.info(f"Administrador inicial creado: {u}")
    finally:
        con.close()