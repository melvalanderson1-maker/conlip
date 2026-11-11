import asyncio
import logging

from fastapi import APIRouter, HTTPException, WebSocket, WebSocketDisconnect

from core.config import origen_permitido
from core.seguridad import usuario_desde_token
from core.tiempo_real import gestor

logger = logging.getLogger("ws")
router = APIRouter()


@router.websocket("/api/ws")
async def conexion(ws: WebSocket) -> None:
    # 1) Solo orígenes autorizados
    if not origen_permitido(ws.headers.get("origin")):
        await ws.close(code=1008)
        return
    await ws.accept()

    # 2) El token NO va en la URL: se envía como primer mensaje (máx. 5 s)
    try:
        msg = await asyncio.wait_for(ws.receive_json(), timeout=5)
        token = str(msg.get("token", ""))
        u = await asyncio.to_thread(usuario_desde_token, token)
    except Exception:
        await ws.close(code=1008)
        return

    uid = u["id"]
    if not gestor.puede_conectar(uid):
        await ws.close(code=1008)
        return

    gestor.registrar(uid, ws)
    try:
        await ws.send_json({"tipo": "listo"})
        while True:
            texto = await ws.receive_text()
            if texto != "ping":
                continue
            # Cada ping revalida: si el token venció o desactivaron al usuario, se corta
            try:
                await asyncio.to_thread(usuario_desde_token, token)
            except HTTPException:
                await ws.close(code=1008)
                return
            await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket de usuario {uid} cerrado por error: {e}")
    finally:
        gestor.quitar(uid, ws)




@router.websocket("/api/ws/publico")
async def conexion_publica(ws: WebSocket) -> None:
    """Canal de solo lectura para la portada: avisa cuando cambian planes, precios, cursos o textos."""
    if not origen_permitido(ws.headers.get("origin")) or not gestor.puede_conectar_publico():
        await ws.close(code=1008)
        return
    await ws.accept()
    gestor.registrar_publico(ws)
    try:
        await ws.send_json({"tipo": "listo"})
        while True:
            texto = await ws.receive_text()
            if texto == "ping":
                await ws.send_text("pong")
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.warning(f"WebSocket público cerrado por error: {e}")
    finally:
        gestor.quitar_publico(ws)