import logging
import os
import smtplib
import ssl
import threading
from email.message import EmailMessage

logger = logging.getLogger("correo")


def _enviar(para: str, asunto: str, texto: str, html: str | None) -> None:
    host = os.getenv("SMTP_HOST", "")
    if not host:
        logger.warning("SMTP sin configurar. Correo para %s\nAsunto: %s\n%s", para, asunto, texto)
        return
    port = int(os.getenv("SMTP_PORT", "587"))
    seguridad = os.getenv("SMTP_SEGURIDAD", "starttls").lower()  # starttls | ssl | none
    usuario, clave = os.getenv("SMTP_USER", ""), os.getenv("SMTP_CLAVE", "")
    desde = os.getenv("SMTP_DESDE") or usuario

    msg = EmailMessage()
    msg["Subject"], msg["From"], msg["To"] = asunto, desde, para
    msg.set_content(texto)
    if html:
        msg.add_alternative(html, subtype="html")

    ctx = ssl.create_default_context()
    if seguridad == "ssl":
        server = smtplib.SMTP_SSL(host, port, context=ctx, timeout=20)
    else:
        server = smtplib.SMTP(host, port, timeout=20)
        if seguridad == "starttls":
            server.starttls(context=ctx)
    with server:
        if usuario:
            server.login(usuario, clave)
        server.send_message(msg)


def _seguro(para: str, asunto: str, texto: str, html: str | None) -> None:
    try:
        _enviar(para, asunto, texto, html)
    except Exception as e:
        logger.error("No se pudo enviar el correo a %s: %s", para, e)


def enviar_correo(para: str, asunto: str, texto: str, html: str | None = None) -> None:
    """Envía en segundo plano para no hacer esperar a quien compra."""
    threading.Thread(target=_seguro, args=(para, asunto, texto, html), daemon=True).start()