import base64
import json
import logging
import os
import threading
import time

from playwright.sync_api import sync_playwright

logger = logging.getLogger("seace_auth")
LOGIN_URL = "https://prod6.seace.gob.pe/auth-proveedor/"
BUSCADOR_URL = "https://prod6.seace.gob.pe/buscador-publico/contrataciones"
RENOVAR_ANTES_DE = 90   # segundos: renueva cuando al token le quedan menos de esto


def _restante(auth: dict) -> float:
    try:
        token = auth["authorization"].split(" ", 1)[1]
        p = token.split(".")[1]
        p += "=" * (-len(p) % 4)
        return json.loads(base64.urlsafe_b64decode(p))["exp"] - time.time()
    except Exception:
        return 0


class SesionNavegador:
    """
    Sesión de proveedor en SEACE.
    - NO se inicia sola: solo cuando alguien pulsa "Iniciar sesión" en la plataforma.
    - Mantiene UN navegador (invisible por defecto) abierto y renueva el token de 5 min.
    - Si algo falla o el navegador se cierra, la sesión TERMINA y no reintenta sola
      (así no se repiten logins que podrían bloquear la cuenta).
    """

    def __init__(self):
        self._lock = threading.Lock()   # protege _auth
        self._ctl = threading.Lock()    # un solo "iniciar" a la vez
        self._auth: dict = {}
        self._version = 0
        self._hilo = None
        self._forzar = threading.Event()
        self._listo = threading.Event()
        self._ultimo_error = ""
        self._ultimo_ok = 0.0
        self._browser = None
        self._ctx = None
        self._page = None

    # ------------------------------------------------------------------
    # API para el resto del backend
    # ------------------------------------------------------------------
    def obtener(self) -> dict:
        with self._lock:
            return dict(self._auth)

    def estado(self) -> dict:
        seg = _restante(self.obtener())
        viva = bool(self._hilo and self._hilo.is_alive())
        return {
            "activa": viva and seg > 0,
            "expira_en": int(max(seg, 0)) if viva else 0,
            "error": self._ultimo_error,
        }

    def iniciar(self, timeout: float = 120):
        """Inicia (o renueva) la sesión y espera el resultado. Devuelve (ok, error)."""
        with self._ctl:
            if self.estado()["activa"] and time.time() - self._ultimo_ok < 20:
                return True, ""   # doble clic: ya se acaba de iniciar
            self._listo.clear()
            self._ultimo_error = ""
            if not self._hilo or not self._hilo.is_alive():
                self._hilo = threading.Thread(target=self._run, daemon=True)
                self._hilo.start()
            else:
                self._forzar.set()
            if not self._listo.wait(timeout):
                return False, "Tiempo agotado esperando el login de SEACE"
        return self.estado()["activa"], self._ultimo_error

    # ------------------------------------------------------------------
    # Internos (corren en el hilo del navegador)
    # ------------------------------------------------------------------
    def _on_request(self, req):
        if "s8uit-services" not in req.url:
            return
        auth = req.headers.get("authorization")
        if not auth:
            return
        with self._lock:
            if auth != self._auth.get("authorization"):
                self._auth = {"authorization": auth}
                self._version += 1

    def _esperar_token(self, page, version_antes: int, segundos: int) -> bool:
        for _ in range(segundos * 2):
            if self._version != version_antes:
                return True
            page.wait_for_timeout(500)
        return False

    def _contexto_limpio(self):
        """Contexto nuevo (sin cookies ni localStorage): cada login empieza de cero."""
        if self._ctx is not None:
            try:
                self._ctx.close()
            except Exception:
                pass
        self._ctx = self._browser.new_context(locale="es-PE")
        self._page = self._ctx.new_page()
        self._page.on("request", self._on_request)

    def _diagnostico(self, page):
        try:
            logger.error(f"Diagnóstico: URL actual = {page.url}")
            page.screenshot(path="login_error.png", full_page=True)
            logger.error("Captura guardada en login_error.png (carpeta backend)")
        except Exception as e:
            logger.error(f"No se pudo guardar el diagnóstico: {e}")

    def _login(self):
        ruc = os.getenv("SEACE_RUC", "")
        clave = os.getenv("SEACE_CLAVE", "")
        if not ruc or not clave:
            raise RuntimeError("Faltan las variables SEACE_RUC / SEACE_CLAVE")

        self._contexto_limpio()
        page = self._page
        antes = self._version
        try:
            page.goto(LOGIN_URL, wait_until="networkidle", timeout=60000)
            page.get_by_placeholder("Ingrese su RUC").fill(ruc)
            page.locator('input[type="password"]').fill(clave)
            page.get_by_role("button", name="Acceder", exact=True).click()

            try:
                acepto = page.get_by_role("button", name="Acepto", exact=True)
                acepto.wait_for(timeout=15000)
                for _ in range(10):
                    ver = page.get_by_role("button", name="Ver más")
                    if ver.count() == 0:
                        break
                    ver.first.click()
                    page.wait_for_timeout(300)
                page.locator("mat-checkbox label").click()
                acepto.click()
            except Exception:
                logger.info("No apareció la pantalla de términos (o ya estaba aceptada)")

            if not self._esperar_token(page, antes, 15):
                page.goto(BUSCADOR_URL, wait_until="networkidle", timeout=60000)
                if not self._esperar_token(page, antes, 10):
                    raise RuntimeError("Login sin token")
        except Exception:
            self._diagnostico(page)
            raise
        self._ultimo_ok = time.time()
        logger.info("Sesión SEACE iniciada (navegador abierto)")

    def _login_y_avisar(self):
        self._login()
        self._listo.set()

    def _refrescar(self):
        page = self._page
        antes = self._version
        ok = False
        try:
            page.goto(BUSCADOR_URL, wait_until="networkidle", timeout=60000)
            ok = self._esperar_token(page, antes, 10)
        except Exception as e:
            logger.warning(f"Renovación por recarga falló: {e}")
        if not ok or "auth-proveedor" in page.url:
            logger.info("La recarga no dio token nuevo: inicio sesión otra vez")
            self._login()
        else:
            logger.info("Token renovado")

    def _run(self):
        visible = os.getenv("SEACE_VER") == "1"
        self._forzar.clear()
        try:
            with sync_playwright() as p:
                self._browser = p.chromium.launch(headless=not visible)
                try:
                    self._login_y_avisar()
                    while True:
                        if self._forzar.wait(15):
                            self._forzar.clear()
                            self._login_y_avisar()
                            continue
                        if not self._browser.is_connected() or (self._page and self._page.is_closed()):
                            raise RuntimeError("Se cerró el navegador de sesión")
                        if _restante(self.obtener()) < RENOVAR_ANTES_DE:
                            self._refrescar()
                finally:
                    try:
                        self._browser.close()
                    except Exception:
                        pass
                    self._ctx = self._page = None
        except Exception as e:
            self._ultimo_error = str(e).splitlines()[0] if str(e) else "Error desconocido"
            logger.error(f"Sesión SEACE terminada: {self._ultimo_error}. "
                         f"Pulsa 'Iniciar sesión' en la plataforma para abrirla de nuevo.")
        finally:
            with self._lock:
                self._auth = {}
            self._listo.set()


sesion = SesionNavegador()