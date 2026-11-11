import json
import os
import queue
import subprocess
import sys
import threading
import webbrowser
import io
import mimetypes
import urllib.parse
import urllib.request
import zipfile
import xml.etree.ElementTree as ET
import tkinter as tk
from tkinter import ttk, messagebox
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


CARPETA = Path(__file__).resolve().parent
SCRIPT = CARPETA / "seace_scrape_navegador.py"
cola = queue.Queue()
proceso = None
registros = {}
contador = 0



# Visor temporal: sirve el contenido desde memoria y nunca escribe el documento en disco.
# Solo permite recuperar URLs pertenecientes a dominios oficiales de SEACE.
_VISOR_SERVIDOR = None
_VISOR_PUERTO = None

def _docx_a_html(datos, titulo):
    """Convierte texto y tablas de un DOCX a HTML sin crear archivos temporales."""
    try:
        with zipfile.ZipFile(io.BytesIO(datos)) as z:
            xml = z.read("word/document.xml")
        root = ET.fromstring(xml)
        ns = {"w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main"}
        cuerpo = root.find(".//w:body", ns)
        partes = []
        if cuerpo is None:
            raise ValueError("No se encontró el contenido del documento DOCX.")
        for nodo in list(cuerpo):
            if nodo.tag.endswith("}p"):
                textos = [t.text or "" for t in nodo.findall(".//w:t", ns)]
                texto = "".join(textos).strip()
                if texto:
                    partes.append("<p>" + __import__("html").escape(texto) + "</p>")
            elif nodo.tag.endswith("}tbl"):
                filas_html = []
                for tr in nodo.findall("./w:tr", ns):
                    celdas = []
                    for tc in tr.findall("./w:tc", ns):
                        texto = " ".join((t.text or "") for t in tc.findall(".//w:t", ns)).strip()
                        celdas.append("<td>" + __import__("html").escape(texto) + "</td>")
                    filas_html.append("<tr>" + "".join(celdas) + "</tr>")
                if filas_html:
                    partes.append("<table><tbody>" + "".join(filas_html) + "</tbody></table>")
        cuerpo_html = "".join(partes) or "<p>El documento no contiene texto extraíble.</p>"
        return """<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">
<title>{}</title><style>body{{font:16px/1.6 Arial,sans-serif;max-width:1000px;margin:32px auto;padding:0 20px;color:#222}}
h1{{font-size:22px;border-bottom:1px solid #ddd;padding-bottom:12px}}p{{white-space:pre-wrap}}
table{{border-collapse:collapse;width:100%;margin:16px 0}}td{{border:1px solid #bbb;padding:7px;vertical-align:top}}
</style></head><body><h1>{}</h1>{}</body></html>""".format(
            __import__("html").escape(titulo), __import__("html").escape(titulo), cuerpo_html)
    except Exception as exc:
        return ("<!doctype html><meta charset='utf-8'><h2>No se pudo mostrar el DOCX</h2><p>"
                + __import__("html").escape(str(exc)) + "</p>")

def _iniciar_visor():
    global _VISOR_SERVIDOR, _VISOR_PUERTO
    if _VISOR_SERVIDOR:
        return _VISOR_PUERTO

    class VisorHandler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def do_GET(self):
            qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            url = (qs.get("url") or [""])[0]
            nombre = (qs.get("nombre") or ["Documento"])[0]
            if not url:
                self.send_error(400, "Falta la URL del documento")
                return
            parsed = urllib.parse.urlparse(url)
            host = (parsed.hostname or "").lower()
            if parsed.scheme != "https" or not (host == "seace.gob.pe" or host.endswith(".seace.gob.pe") or host == "gob.pe" or host.endswith(".gob.pe")):
                self.send_error(403, "Solo se permiten documentos de dominios oficiales")
                return
            try:
                req = urllib.request.Request(url, headers={
                    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/130 Safari/537.36",
                    "Referer": "https://prod2.seace.gob.pe/"
                })
                with urllib.request.urlopen(req, timeout=45) as resp:
                    datos = resp.read()
                    content_type = resp.headers.get("Content-Type", "")
                    nombre_resp = resp.headers.get_filename() if hasattr(resp.headers, "get_filename") else None
                    if nombre_resp:
                        nombre = nombre_resp
                ext = os.path.splitext(nombre)[1].lower()
                if not ext:
                    ext = {"application/pdf": ".pdf",
                           "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
                           "application/msword": ".doc"}.get(content_type.split(";")[0].lower(), "")
                if ext == ".pdf" or content_type.lower().startswith("application/pdf"):
                    salida = datos
                    tipo = "application/pdf"
                elif ext == ".docx" or "wordprocessingml.document" in content_type.lower():
                    salida = _docx_a_html(datos, nombre).encode("utf-8")
                    tipo = "text/html; charset=utf-8"
                elif content_type.lower().startswith("text/html"):
                    salida = datos
                    tipo = "text/html; charset=utf-8"
                else:
                    tipo_detectado = ext or mimetypes.guess_type(nombre)[0] or content_type or "formato desconocido"
                    salida = ("<!doctype html><meta charset='utf-8'><meta name='viewport' content='width=device-width'>"
                              "<h2>Este formato no tiene vista previa compatible en el navegador</h2>"
                              "<p><b>Archivo:</b> " + __import__("html").escape(nombre) + "</p>"
                              "<p><b>Formato detectado:</b> " + __import__("html").escape(tipo_detectado) + "</p>"
                              "<p>Para cumplir el modo sin descargas, el archivo se leyó en memoria pero no se guardó ni se envió como descarga.</p>"
                              "<p>PDF se muestra directamente y DOCX se presenta como vista HTML. Los archivos DOC antiguos, Excel y ZIP/RAR requieren un visor/conversor específico.</p>").encode("utf-8")
                    tipo = "text/html; charset=utf-8"
                self.send_response(200)
                self.send_header("Content-Type", tipo)
                self.send_header("Content-Disposition", "inline; filename*=UTF-8''" + urllib.parse.quote(nombre))
                self.send_header("Content-Length", str(len(salida)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(salida)
            except Exception as exc:
                cuerpo = ("<!doctype html><meta charset='utf-8'><h2>No se pudo abrir el documento</h2><p>"
                          + __import__("html").escape(str(exc)) +
                          "</p><p>SEACE puede requerir una sesión activa o el enlace pudo vencer. No se guardó ningún archivo.</p>").encode("utf-8")
                self.send_response(502)
                self.send_header("Content-Type", "text/html; charset=utf-8")
                self.send_header("Content-Length", str(len(cuerpo)))
                self.end_headers()
                self.wfile.write(cuerpo)

    _VISOR_SERVIDOR = ThreadingHTTPServer(("127.0.0.1", 0), VisorHandler)
    _VISOR_PUERTO = _VISOR_SERVIDOR.server_address[1]
    threading.Thread(target=_VISOR_SERVIDOR.serve_forever, daemon=True).start()
    return _VISOR_PUERTO


def iniciar():
    global proceso, contador
    if proceso is not None and proceso.poll() is None:
        messagebox.showinfo("SEACE", "La extracción ya está ejecutándose.")
        return
    if not SCRIPT.exists():
        messagebox.showerror("Archivo faltante", f"No se encontró el archivo:\n{SCRIPT}\n\nColoca ambos archivos en la misma carpeta.")
        return
    anio = entrada_anio.get().strip()
    if not anio.isdigit() or len(anio) != 4:
        messagebox.showerror("Año inválido", "Ingresa un año de cuatro dígitos.")
        return

    comando = [sys.executable, "-u", str(SCRIPT), "--anio", anio,
               "--headless", "true", "--detalle", "true" if var_detalle.get() else "false"]
    boton_iniciar.config(state="disabled")
    estado.set("Iniciando extracción en SEACE…")
    progreso.set("Preparando navegador oculto…")
    salida.delete("1.0", tk.END)
    for item in tabla.get_children():
        tabla.delete(item)
    registros.clear()
    contador = 0

    def ejecutar():
        global proceso
        try:
            proceso = subprocess.Popen(
                comando, cwd=str(CARPETA), stdout=subprocess.PIPE,
                stderr=subprocess.STDOUT, text=True, encoding="utf-8",
                errors="replace", bufsize=1
            )
            for linea in proceso.stdout:
                cola.put(("linea", linea.rstrip("\r\n")))
            codigo = proceso.wait()
            cola.put(("fin", codigo))
        except Exception as e:
            cola.put(("error", str(e)))

    threading.Thread(target=ejecutar, daemon=True).start()


def detener():
    if proceso is not None and proceso.poll() is None:
        proceso.terminate()
        estado.set("Se solicitó detener la extracción…")


def mostrar_seleccion(_event=None):
    seleccion = tabla.selection()
    if not seleccion:
        return
    clave = seleccion[0]
    dato = registros.get(clave)
    if dato is None:
        return
    detalle.delete("1.0", tk.END)
    detalle.insert(tk.END, json.dumps(dato, ensure_ascii=False, indent=2))


def abrir_documentos_seleccionados():
    seleccion = tabla.selection()
    if not seleccion:
        messagebox.showinfo("Documentos", "Primero selecciona un proceso de la tabla.")
        return
    dato = registros.get(seleccion[0], {})
    documentos = dato.get("documentos") or []
    if not documentos:
        messagebox.showinfo("Documentos", "Este proceso no tiene documentos listados en la ficha.")
        return

    ventana_docs = tk.Toplevel(ventana)
    ventana_docs.title("Documentos del proceso — apertura en navegador")
    ventana_docs.geometry("760x300")
    ventana_docs.transient(ventana)
    ttk.Label(ventana_docs, text="Selecciona un archivo y pulsa Abrir en navegador. PDF se muestra en Edge; DOCX se convierte a vista HTML en memoria.").pack(anchor="w", padx=10, pady=(10, 5))
    cols = ("nombre", "archivo", "formato", "fecha", "estado")
    tabla_docs = ttk.Treeview(ventana_docs, columns=cols, show="headings", height=8)
    for col, titulo, ancho in [("nombre", "Nombre del archivo", 240), ("archivo", "Tamaño", 95),
                               ("formato", "Formato", 85), ("fecha", "Fecha publicación", 145),
                               ("estado", "Disponibilidad", 150)]:
        tabla_docs.heading(col, text=titulo)
        tabla_docs.column(col, width=ancho, anchor="w")
    tabla_docs.pack(fill="both", expand=True, padx=10, pady=5)
    docs_por_id = {}
    for i, doc in enumerate(documentos):
        iid = str(i)
        docs_por_id[iid] = doc
        estado_doc = "Listo para abrir" if doc.get("url_documento") else "Enlace no capturado"
        nombre_archivo = doc.get("nombre_archivo") or doc.get("documento") or "Documento"
        formato = (doc.get("formato") or os.path.splitext(nombre_archivo)[1].lstrip(".") or "No detectado").upper()
        tabla_docs.insert("", tk.END, iid=iid, values=(nombre_archivo,
            doc.get("tamano") or doc.get("archivo") or "—", formato,
            doc.get("fecha_publicacion") or "—", estado_doc))

    def abrir_doc(_event=None):
        elegido = tabla_docs.selection()
        if not elegido:
            messagebox.showinfo("Documentos", "Selecciona un documento.", parent=ventana_docs)
            return
        doc = docs_por_id[elegido[0]]
        url = doc.get("url_documento")
        if not url:
            messagebox.showwarning("Enlace no disponible",
                "SEACE no entregó una URL directa para este documento. No se descargó ni guardó ningún archivo.\n\nPrueba abrir el documento desde la ficha pública de SEACE; si allí funciona, tendremos que ajustar la captura del enlace.",
                parent=ventana_docs)
            return
        try:
            puerto = _iniciar_visor()
            nombre = doc.get("nombre_archivo") or doc.get("documento") or "Documento"
            visor_url = "http://127.0.0.1:{}/?url={}&nombre={}".format(
                puerto, urllib.parse.quote(url, safe=""), urllib.parse.quote(nombre, safe=""))
            webbrowser.open(visor_url, new=2)
        except Exception as e:
            messagebox.showerror("No se pudo abrir el visor", str(e), parent=ventana_docs)

    botones = ttk.Frame(ventana_docs)
    botones.pack(fill="x", padx=10, pady=(0, 10))
    ttk.Button(botones, text="Abrir en navegador", command=abrir_doc).pack(side="left")
    ttk.Button(botones, text="Cerrar", command=ventana_docs.destroy).pack(side="right")
    tabla_docs.bind("<Double-1>", abrir_doc)


def revisar_cola():
    global proceso, contador
    try:
        while True:
            tipo, dato = cola.get_nowait()
            if tipo == "linea":
                if dato.startswith("RESULTADO_JSON:"):
                    try:
                        registro = json.loads(dato[len("RESULTADO_JSON:"):])
                        contador += 1
                        clave = str(contador)
                        registros[clave] = registro
                        tabla.insert("", tk.END, iid=clave, values=(
                            registro.get("entidad") or "—",
                            registro.get("nomenclatura") or "—",
                            registro.get("modalidad") or "—",
                            registro.get("monto") if registro.get("monto") is not None else "—",
                            registro.get("fecha_convocatoria") or "—",
                        ))
                        progreso.set(f"Procesos encontrados: {contador} · Último: {registro.get('nomenclatura') or 'sin nomenclatura'}")
                    except Exception as e:
                        salida.insert(tk.END, f"Error leyendo resultado: {e}\n")
                else:
                    salida.insert(tk.END, dato + "\n")
                    salida.see(tk.END)
                    progreso.set(dato[-150:])
            elif tipo == "fin":
                proceso = None
                boton_iniciar.config(state="normal")
                estado.set("Extracción finalizada correctamente." if dato == 0 else f"La extracción terminó con código {dato}.")
                progreso.set(f"Total de procesos mostrados: {contador}")
            elif tipo == "error":
                proceso = None
                boton_iniciar.config(state="normal")
                estado.set("Error al ejecutar el extractor.")
                salida.insert(tk.END, dato + "\n")
    except queue.Empty:
        pass
    ventana.after(150, revisar_cola)


ventana = tk.Tk()
ventana.title("SEACE | Prueba de extracción en vivo — sin MySQL")
ventana.geometry("1180x760")
ventana.minsize(850, 560)

contenedor = ttk.Frame(ventana, padding=12)
contenedor.pack(fill="both", expand=True)
ttk.Label(contenedor, text="SEACE · EXTRACCIÓN EN VIVO", font=("Segoe UI", 16, "bold")).pack(anchor="w")
ttk.Label(contenedor, text="Modo de prueba: sin MySQL ni descargas locales. Los documentos se intentan abrir en el navegador.").pack(anchor="w", pady=(3, 12))

controles = ttk.Frame(contenedor)
controles.pack(fill="x", pady=(0, 10))
ttk.Label(controles, text="Año de convocatoria:").pack(side="left")
entrada_anio = ttk.Entry(controles, width=8)
entrada_anio.pack(side="left", padx=(6, 16))
entrada_anio.insert(0, "2026")
var_detalle = tk.BooleanVar(value=True)
ttk.Checkbutton(controles, text="Extraer fichas, documentos y cronogramas", variable=var_detalle).pack(side="left", padx=(0, 14))
ttk.Button(controles, text="Abrir documentos del proceso seleccionado", command=abrir_documentos_seleccionados).pack(side="left", padx=(0, 8))
boton_iniciar = ttk.Button(controles, text="Iniciar extracción", command=iniciar)
boton_iniciar.pack(side="left", padx=(0, 6))
ttk.Button(controles, text="Detener", command=detener).pack(side="left")

estado = tk.StringVar(value="Listo para iniciar.")
ttk.Label(contenedor, textvariable=estado, font=("Segoe UI", 10, "bold")).pack(anchor="w", pady=(4, 2))
progreso = tk.StringVar(value="Los resultados aparecerán en la tabla.")
ttk.Label(contenedor, textvariable=progreso).pack(anchor="w", pady=(0, 8))

panel = ttk.Panedwindow(contenedor, orient="vertical")
panel.pack(fill="both", expand=True)
marco_tabla = ttk.LabelFrame(panel, text="Convocatorias extraídas (selecciona una para ver el detalle)", padding=6)
marco_detalle = ttk.LabelFrame(panel, text="Detalle completo en memoria: ficha, documentos y cronograma", padding=6)
panel.add(marco_tabla, weight=3)
panel.add(marco_detalle, weight=2)

columnas = ("entidad", "nomenclatura", "modalidad", "monto", "fecha")
tabla = ttk.Treeview(marco_tabla, columns=columnas, show="headings", height=12)
for col, titulo, ancho in [
    ("entidad", "Entidad", 230), ("nomenclatura", "Nomenclatura", 240),
    ("modalidad", "Modalidad", 210), ("monto", "Monto", 100), ("fecha", "Fecha", 145)
]:
    tabla.heading(col, text=titulo)
    tabla.column(col, width=ancho, minwidth=80, anchor="w")
scroll_tabla = ttk.Scrollbar(marco_tabla, orient="vertical", command=tabla.yview)
scroll_h = ttk.Scrollbar(marco_tabla, orient="horizontal", command=tabla.xview)
tabla.configure(yscrollcommand=scroll_tabla.set, xscrollcommand=scroll_h.set)
tabla.grid(row=0, column=0, sticky="nsew")
scroll_tabla.grid(row=0, column=1, sticky="ns")
scroll_h.grid(row=1, column=0, sticky="ew")
marco_tabla.rowconfigure(0, weight=1)
marco_tabla.columnconfigure(0, weight=1)
tabla.bind("<<TreeviewSelect>>", mostrar_seleccion)

detalle = tk.Text(marco_detalle, wrap="word", font=("Consolas", 9), height=12)
scroll_detalle = ttk.Scrollbar(marco_detalle, orient="vertical", command=detalle.yview)
detalle.configure(yscrollcommand=scroll_detalle.set)
scroll_detalle.pack(side="right", fill="y")
detalle.pack(side="left", fill="both", expand=True)

marco_log = ttk.LabelFrame(contenedor, text="Registro de actividad", padding=6)
marco_log.pack(fill="x", expand=False, pady=(8, 0))
salida = tk.Text(marco_log, wrap="word", font=("Consolas", 8), height=6)
scroll_log = ttk.Scrollbar(marco_log, orient="vertical", command=salida.yview)
salida.configure(yscrollcommand=scroll_log.set)
scroll_log.pack(side="right", fill="y")
salida.pack(side="left", fill="both", expand=True)

ventana.after(150, revisar_cola)
ventana.mainloop()
