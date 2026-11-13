import os
import asyncio
import threading
from contextlib import asynccontextmanager

from dotenv import load_dotenv
load_dotenv()  # debe ir ANTES de importar core / modules

from fastapi import FastAPI, Request
from fastapi.middleware.cors import CORSMiddleware

from core.bootstrap import iniciar_auth
from core.config import DEV, LAN_REGEX, ORIGENES
from core.db import abrir_db
from core.difusion import por_cambio
from core.recordatorios import bucle as bucle_recordatorios
from core.vencimientos import bucle as bucle_vencimientos
from core.tiempo_real import gestor
from modules.auth.router import router as auth_router
from modules.auth.doblefactor import router as doblefactor_router
from modules.coti_menor.archivos import router as archivos_router
from modules.coti_menor.asignaciones import router as asignaciones_router
from modules.coti_menor.router import router as coti_menor_router
from modules.coti_menor.scraper import bucle

from modules.coti_mayor.router import router as coti_mayor_router
from modules.coti_mayor.scraper import bucle as bucle_mayor, bucle_sync as bucle_sync_mayor
from modules.coti_mayor.refresco import bucle_refresco as bucle_refresco_mayor

from core.semillas import sembrar_catalogo
from modules.agenda.admin import router as agenda_admin_router
from modules.agenda.asesor import router as asesor_router
from modules.publico.legal import router_admin as legal_admin_router
from modules.superadmin.avisos import router as avisos_router
from modules.superadmin.ventas import router as ventas_admin_router
from modules.publico.ventas import router as ventas_publico_router
from modules.crm.router import router as crm_router
from modules.crm.whatsapp import router as crm_wa_router
from modules.crm.whatsapp import router_admin as crm_wa_admin_router
from modules.crm.whatsapp import router_webhook as wa_webhook_router
from modules.crm.whatsapp import router_admin_meta as crm_meta_admin_router
from modules.crm.ejecutivos import router as router_ejecutivos
from modules.publico.legal import router_publico as legal_publico_router
from modules.agenda.cliente import router as agenda_cliente_router
from modules.agenda.integraciones import router as integraciones_router
from modules.agenda.integraciones import router_callback as integraciones_callback_router
from modules.anuncios.router import router as anuncios_router
from modules.anuncios.router import router_admin as anuncios_admin_router
from modules.anuncios.router import router_publico as anuncios_publico_router
from modules.aprende.admin import router as aprende_admin_router
from modules.aprende.alumno import router as aprende_router
from modules.cuenta.router import router as cuenta_router
from modules.publico.cursos import router as cursos_publicos_router
from modules.publico.checkout import router as checkout_router
from modules.superadmin.pedidos import router as pedidos_router
from modules.publico.router import router as publico_router
from modules.superadmin.catalogo import router as catalogo_router
from modules.superadmin.router import router as plataforma_router
from modules.tiempo_real.router import router as ws_router
from modules.usuarios.router import router as usuarios_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    gestor.iniciar()
    abrir_db().close()
    iniciar_auth()
    sembrar_catalogo()
    threading.Thread(target=bucle_vencimientos, daemon=True).start()  # se activa o apaga desde el panel Avisos
    if os.getenv("RECORDATORIOS", "1") == "1":
        threading.Thread(target=bucle_recordatorios, daemon=True).start()
    if os.getenv("SCRAPER", "1") == "1":
        threading.Thread(target=bucle, daemon=True).start()
    if os.getenv("SCRAPER_MAYOR", "1") == "1":
        threading.Thread(target=bucle_mayor, daemon=True, name="scraper-mayor").start()
    if os.getenv("SYNC_MAYOR", "1") == "1":
        threading.Thread(target=bucle_sync_mayor, daemon=True, name="sync-mayor").start()
    if os.getenv("REFRESCO_MAYOR", "1") == "1":
        threading.Thread(target=bucle_refresco_mayor, daemon=True, name="refresco-mayor").start()
    yield


app = FastAPI(
    title="COTI", lifespan=lifespan,
    docs_url="/docs" if DEV else None,
    redoc_url=None,
    openapi_url="/openapi.json" if DEV else None,
)


@app.middleware("http")
async def cabeceras_seguridad(request: Request, call_next):
    resp = await call_next(request)
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    resp.headers["Cache-Control"] = "no-store"
    if not request.url.path.startswith(("/api/archivo", "/api/aprende/media")):  # los PDF se muestran en iframe del frontend
        resp.headers["X-Frame-Options"] = "DENY"
    if not DEV:
        resp.headers["Strict-Transport-Security"] = "max-age=31536000; includeSubDomains"
    return resp


# Cada cambio hecho desde un panel de configuración se difunde por WebSocket a quien corresponda
EVENTOS_POR_RUTA = (
    ("/api/catalogo", "catalogo"),
    ("/api/plataforma/planes", "catalogo"),
    ("/api/aprende/admin", "cursos"),
    ("/api/plataforma/empresas", "acceso"),
    ("/api/plataforma/suscripciones", "acceso"),
    ("/api/usuarios", "acceso_empresa"),
    ("/api/agenda/admin/modulos", "catalogo"),
    ("/api/agenda/admin/asesores", "horarios"),
    ("/api/agenda/admin/bloqueos", "horarios"),
    ("/api/agenda/admin/servicios", "horarios"),
    ("/api/agenda/admin/reglas", "horarios"),
    ("/api/agenda/admin/pedidos", "horarios"),
    ("/api/agenda/admin/sesiones", "horarios"),
    ("/api/asesor/horarios", "horarios"),
    ("/api/asesor/bloqueos", "horarios"),
    ("/api/asesor/sesiones", "horarios"),
    ("/api/asesor/perfil", "horarios"),
    ("/api/mis-servicios", "horarios"),
    ("/api/legal/admin", "catalogo"),
    ("/api/ventas/admin/ajustes", "catalogo"),
    ("/api/ventas/admin/ordenes", "acceso"),
    ("/api/anuncios/admin", "anuncios"),
)
_tareas: set[asyncio.Task] = set()


@app.middleware("http")
async def difundir_cambios(request: Request, call_next):
    resp = await call_next(request)
    if request.method in ("POST", "PUT", "PATCH", "DELETE") and resp.status_code < 400:
        ruta = request.url.path
        if not ruta.endswith("/archivos"):  # subir un archivo sin usarlo todavía no cambia nada visible
            for prefijo, tipo in EVENTOS_POR_RUTA:
                if ruta.startswith(prefijo):
                    t = asyncio.create_task(por_cambio(tipo, request.headers.get("authorization")))
                    _tareas.add(t)
                    t.add_done_callback(_tareas.discard)
                    break
    return resp


app.add_middleware(
    CORSMiddleware,
    allow_origins=ORIGENES,
    allow_origin_regex=LAN_REGEX if DEV else None,
    allow_methods=["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allow_headers=["Authorization", "Content-Type"],
)

@app.get("/api/salud")
def salud():
    """Lo usa Docker para saber si el backend está vivo y conectado a la base de datos."""
    from fastapi.responses import JSONResponse
    try:
        abrir_db().close()
    except Exception:
        return JSONResponse({"ok": False}, status_code=503)
    return {"ok": True}


app.include_router(auth_router)
app.include_router(doblefactor_router)
app.include_router(usuarios_router)
app.include_router(coti_menor_router)

app.include_router(coti_mayor_router)

app.include_router(asignaciones_router)
app.include_router(archivos_router)
app.include_router(plataforma_router)
app.include_router(catalogo_router)
app.include_router(publico_router)
app.include_router(checkout_router)
app.include_router(cuenta_router)
app.include_router(agenda_admin_router)
app.include_router(asesor_router)
app.include_router(legal_admin_router)
app.include_router(avisos_router)
app.include_router(ventas_admin_router)
app.include_router(ventas_publico_router)
app.include_router(crm_router)
app.include_router(crm_wa_router)
app.include_router(crm_wa_admin_router)
app.include_router(wa_webhook_router)
app.include_router(crm_meta_admin_router)
app.include_router(router_ejecutivos)
app.include_router(legal_publico_router)
app.include_router(agenda_cliente_router)
app.include_router(integraciones_router)
app.include_router(integraciones_callback_router)
app.include_router(anuncios_admin_router)
app.include_router(anuncios_router)
app.include_router(anuncios_publico_router)
app.include_router(aprende_admin_router)
app.include_router(aprende_router)
app.include_router(cursos_publicos_router)
app.include_router(pedidos_router)
app.include_router(ws_router)