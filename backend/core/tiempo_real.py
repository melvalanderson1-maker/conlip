import asyncio
import logging
from collections import defaultdict

from fastapi import WebSocket

logger = logging.getLogger("tiempo_real")
MAX_POR_USUARIO = 8
MAX_PUBLICOS = 500


class Gestor:
    """Conexiones abiertas: por usuario (con sesión) y públicas (visitantes de la portada)."""

    def __init__(self) -> None:
        self._conexiones: dict[int, set[WebSocket]] = defaultdict(set)
        self._publicos: set[WebSocket] = set()
        self.loop: asyncio.AbstractEventLoop | None = None

    def iniciar(self) -> None:
        self.loop = asyncio.get_running_loop()

    # ---- usuarios con sesión ----
    def puede_conectar(self, uid: int) -> bool:
        return len(self._conexiones.get(uid, ())) < MAX_POR_USUARIO

    def registrar(self, uid: int, ws: WebSocket) -> None:
        self._conexiones[uid].add(ws)

    def quitar(self, uid: int, ws: WebSocket) -> None:
        self._conexiones[uid].discard(ws)
        if not self._conexiones[uid]:
            self._conexiones.pop(uid, None)

    # ---- visitantes ----
    def puede_conectar_publico(self) -> bool:
        return len(self._publicos) < MAX_PUBLICOS

    def registrar_publico(self, ws: WebSocket) -> None:
        self._publicos.add(ws)

    def quitar_publico(self, ws: WebSocket) -> None:
        self._publicos.discard(ws)

    # ---- envío ----
    async def _enviar(self, uid: int, evento: dict) -> None:
        for ws in list(self._conexiones.get(uid, ())):
            try:
                await ws.send_json(evento)
            except Exception:
                self.quitar(uid, ws)

    async def _enviar_publicos(self, evento: dict) -> None:
        for ws in list(self._publicos):
            try:
                await ws.send_json(evento)
            except Exception:
                self._publicos.discard(ws)

    async def enviar_a(self, uids, evento: dict) -> None:
        for uid in set(uids):
            await self._enviar(uid, evento)

    async def difundir(self, evento: dict, publico: bool = True, autenticados: bool = True) -> None:
        """Envía el evento a todos los visitantes y/o a todos los usuarios con sesión."""
        if publico:
            await self._enviar_publicos(evento)
        if autenticados:
            for uid in list(self._conexiones):
                await self._enviar(uid, evento)

    def notificar(self, uids, evento: dict) -> None:
        """Se puede llamar desde endpoints normales (def), que corren en otro hilo."""
        if self.loop is None:
            return
        for uid in set(uids):
            asyncio.run_coroutine_threadsafe(self._enviar(uid, evento), self.loop)


gestor = Gestor()