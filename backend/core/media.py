import asyncio
import hashlib
import hmac
import os
import re
import secrets
import time
from pathlib import Path
from urllib.parse import parse_qs, quote, urlparse

from fastapi import HTTPException, UploadFile
from fastapi.responses import StreamingResponse

from core.seguridad import secreto

MAX_MB = int(os.getenv("APRENDE_MAX_MB", "500"))
DIR = Path(os.getenv("APRENDE_DIR", "storage/aprende")).resolve()

# extensión -> (categoría, tipo MIME)
TIPOS = {
    ".mp4": ("video", "video/mp4"), ".webm": ("video", "video/webm"),
    ".mp3": ("audio", "audio/mpeg"), ".m4a": ("audio", "audio/mp4"),
    ".ogg": ("audio", "audio/ogg"), ".wav": ("audio", "audio/wav"),
    ".pdf": ("documento", "application/pdf"),
    ".png": ("imagen", "image/png"), ".jpg": ("imagen", "image/jpeg"),
    ".jpeg": ("imagen", "image/jpeg"), ".webp": ("imagen", "image/webp"),
}


def _firma_valida(ext: str, c: bytes) -> bool:
    """Comprueba los primeros bytes: el contenido debe corresponder a la extensión."""
    if ext == ".pdf":
        return c.startswith(b"%PDF")
    if ext == ".png":
        return c.startswith(b"\x89PNG")
    if ext in (".jpg", ".jpeg"):
        return c.startswith(b"\xff\xd8\xff")
    if ext == ".webp":
        return c[:4] == b"RIFF" and c[8:12] == b"WEBP"
    if ext in (".mp4", ".m4a"):
        return c[4:8] == b"ftyp"
    if ext == ".webm":
        return c.startswith(b"\x1a\x45\xdf\xa3")
    if ext == ".mp3":
        return c.startswith(b"ID3") or (len(c) > 1 and c[0] == 0xFF and (c[1] & 0xE0) == 0xE0)
    if ext == ".ogg":
        return c.startswith(b"OggS")
    if ext == ".wav":
        return c[:4] == b"RIFF" and c[8:12] == b"WAVE"
    return False


async def guardar_subida(archivo: UploadFile) -> dict:
    """Guarda el archivo en disco por bloques, con tope de tamaño y nombre aleatorio."""
    nombre = archivo.filename or ""
    ext = Path(nombre).suffix.lower()
    if ext not in TIPOS:
        raise HTTPException(400, "Formato no permitido. Usa mp4, webm, mp3, m4a, ogg, wav, pdf, png, jpg o webp")
    categoria, mime = TIPOS[ext]
    DIR.mkdir(parents=True, exist_ok=True)
    ruta = secrets.token_hex(16) + ext
    destino = DIR / ruta
    limite = MAX_MB * 1024 * 1024
    total = 0
    try:
        with open(destino, "wb") as f:
            while True:
                bloque = await archivo.read(1024 * 1024)
                if not bloque:
                    break
                if total == 0 and not _firma_valida(ext, bloque[:16]):
                    raise HTTPException(400, "El contenido del archivo no corresponde a su formato")
                total += len(bloque)
                if total > limite:
                    raise HTTPException(413, f"El archivo supera el máximo de {MAX_MB} MB")
                await asyncio.to_thread(f.write, bloque)
        if total == 0:
            raise HTTPException(400, "El archivo está vacío")
    except Exception:
        destino.unlink(missing_ok=True)
        raise
    return {"nombre": (nombre or ruta)[:200], "ruta": ruta, "mime": mime, "categoria": categoria, "tamano": total}


def borrar_de_disco(ruta: str) -> None:
    p = (DIR / ruta).resolve()
    if DIR in p.parents:
        p.unlink(missing_ok=True)


def servir_archivo(ruta: str, mime: str, nombre: str, range_header: str | None) -> StreamingResponse:
    """Entrega el archivo con soporte de rangos (adelantar y retroceder el video sin bajarlo completo)."""
    p = (DIR / ruta).resolve()
    if DIR not in p.parents or not p.is_file():
        raise HTTPException(404, "Archivo no encontrado")
    tam = p.stat().st_size
    ini, fin, estado = 0, tam - 1, 200
    cab = {
        "Accept-Ranges": "bytes",
        "Content-Disposition": f"inline; filename*=UTF-8''{quote(nombre)}",
        "X-Content-Type-Options": "nosniff",
    }
    if range_header:
        m = re.fullmatch(r"bytes=(\d*)-(\d*)", range_header.strip())
        if not m or (m.group(1) == "" and m.group(2) == ""):
            raise HTTPException(416, "Rango no válido", headers={"Content-Range": f"bytes */{tam}"})
        if m.group(1) == "":  # últimos N bytes
            ini = max(0, tam - int(m.group(2)))
        else:
            ini = int(m.group(1))
            fin = int(m.group(2)) if m.group(2) else tam - 1
        fin = min(fin, tam - 1)
        if ini > fin or ini >= tam:
            raise HTTPException(416, "Rango no válido", headers={"Content-Range": f"bytes */{tam}"})
        estado = 206
        cab["Content-Range"] = f"bytes {ini}-{fin}/{tam}"
    largo = fin - ini + 1
    cab["Content-Length"] = str(largo)

    def trozos():
        with open(p, "rb") as f:
            f.seek(ini)
            restante = largo
            while restante > 0:
                b = f.read(min(256 * 1024, restante))
                if not b:
                    break
                restante -= len(b)
                yield b

    return StreamingResponse(trozos(), status_code=estado, media_type=mime, headers=cab)


# ---------------- Enlaces firmados (vencen solos) ----------------
def _firma(base: str) -> str:
    return hmac.new(secreto().encode(), b"media|" + base.encode(), hashlib.sha256).hexdigest()[:32]


def firmar(archivo_id: int, usuario_id: int, segundos: int = 7200) -> str:
    base = f"{archivo_id}.{usuario_id}.{int(time.time()) + segundos}"
    return f"{base}.{_firma(base)}"


def verificar(ticket: str) -> int:
    partes = ticket.split(".")
    if len(partes) != 4 or not (partes[0].isdigit() and partes[1].isdigit() and partes[2].isdigit()):
        raise HTTPException(403, "Enlace inválido")
    base = ".".join(partes[:3])
    if not hmac.compare_digest(partes[3], _firma(base)):
        raise HTTPException(403, "Enlace inválido")
    if int(partes[2]) < time.time():
        raise HTTPException(403, "El enlace venció. Vuelve a abrir la lección.")
    return int(partes[0])


# ---------------- Videos por enlace ----------------
def embed_de(url: str) -> dict | None:
    """Convierte un enlace de YouTube, Vimeo o .mp4/.webm (https) en algo reproducible. None = no válido."""
    u = urlparse(url.strip())
    if u.scheme != "https" or not u.netloc:
        return None
    host = u.netloc.lower().removeprefix("www.")
    vid: str | None = None
    if host in ("youtube.com", "m.youtube.com", "music.youtube.com"):
        partes = u.path.split("/")
        if u.path == "/watch":
            vid = parse_qs(u.query).get("v", [""])[0]
        elif len(partes) > 2 and partes[1] in ("embed", "shorts", "live"):
            vid = partes[2]
        else:
            vid = ""
    elif host == "youtu.be":
        vid = u.path.lstrip("/").split("/")[0]
    if vid is not None:
        if not re.fullmatch(r"[A-Za-z0-9_-]{6,15}", vid):
            return None
        return {"fuente": "youtube", "url": f"https://www.youtube-nocookie.com/embed/{vid}?rel=0&modestbranding=1"}
    if host in ("vimeo.com", "player.vimeo.com"):
        m = re.search(r"/(\d{6,12})(?:/([0-9a-f]{6,20}))?", u.path)
        if not m:
            return None
        h = f"?h={m.group(2)}" if m.group(2) else ""
        return {"fuente": "vimeo", "url": f"https://player.vimeo.com/video/{m.group(1)}{h}"}
    if re.search(r"\.(mp4|webm)$", u.path, re.I):
        return {"fuente": "directo", "url": url.strip()}
    return None