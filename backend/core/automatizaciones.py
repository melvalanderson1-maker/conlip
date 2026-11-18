"""Motor de automatizaciones del CRM: flujos de nodos por canal (WhatsApp, Messenger e Instagram).

Un flujo es un grafo {"nodos": [{id, tipo, x, y, config}], "conexiones": [{de, salida, a}]}. Las ejecuciones viven en la base de
datos y un proceso en segundo plano las hace avanzar cada pocos segundos: ningún webhook ni pantalla espera por ellas.
"""
import json
import logging
import re
import time
import unicodedata
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo

from core import archivos as ar
from core import canales as cn
from core import ia
from core import meta_social as ms
from core import whatsapp as wa
from core.crm import avisar_lead, recalcular_siguiente, registrar, siguiente_asesor
from core.db import abrir_db

logger = logging.getLogger("automatizaciones")
ZONA = ZoneInfo("America/Lima")
AUTOR = "automatización"
MAX_PASOS = 40
UNIDADES = {"minutos": 60, "horas": 3600, "dias": 86400}
EVENTOS = ("mensaje_entrante", "palabra_clave", "lead_nuevo", "sin_respuesta")
OPERADORES = ("contiene", "no_contiene", "igual", "distinto", "empieza", "vacio", "no_vacio")
CAMPOS = ("mensaje", "origen", "canal", "interes", "empresa", "etapa", "ejecutivo", "horario")
SALIDAS = {
    "disparador": ("siguiente",), "mensaje": ("siguiente", "error"), "plantilla": ("siguiente", "error"),
    "ia": ("siguiente", "humano", "error"), "esperar": ("siguiente",), "esperar_respuesta": ("respondio", "tiempo"),
    "condicion": ("si", "no"), "asignar": ("siguiente",), "etapa": ("siguiente",), "nota": ("siguiente",),
    "archivo": ("siguiente", "error"), "botones": ("b1", "b2", "b3", "otro", "tiempo", "error"),
    "tarea": ("siguiente",), "fin": (),
}
HORA = re.compile(r"^([01]\d|2[0-3]):[0-5]\d$")


def _int(v, defecto: int = 0) -> int:
    try:
        return int(v)
    except (TypeError, ValueError):
        return defecto


def _norm(t: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFD", t or "") if unicodedata.category(c) != "Mn").lower().strip()


def _render(texto: str, v: dict) -> str:
    return re.sub(r"\{\{\s*(\w+)\s*\}\}", lambda m: str(v.get(m.group(1), "")), texto)


def _segundos(c: dict) -> int:
    return _int(c.get("cantidad")) * UNIDADES.get(str(c.get("unidad")), 0)


# ======================= VALIDACIÓN =======================
def _config_ok(n: dict, canal: str) -> str | None:
    t, c = n["tipo"], n.get("config") or {}
    nombre = f"«{c.get('rotulo') or t}»"
    if t == "disparador":
        ev = c.get("evento")
        if ev not in EVENTOS:
            return "El inicio del flujo necesita un evento."
        if ev == "palabra_clave" and not [p for p in c.get("palabras", []) if str(p).strip()]:
            return "Escribe al menos una palabra clave en el inicio del flujo."
        if ev == "sin_respuesta" and not 5 <= _int(c.get("minutos")) <= 10080:
            return "En «cliente sin responder», los minutos van de 5 a 10080."
    elif t == "mensaje" and not str(c.get("texto", "")).strip():
        return f"El mensaje {nombre} no tiene texto."
    elif t == "plantilla":
        if canal != "whatsapp":
            return "Las plantillas solo existen en WhatsApp."
        if not c.get("plantilla") or not c.get("idioma"):
            return f"El paso {nombre} necesita plantilla e idioma."
    elif t in ("esperar", "esperar_respuesta"):
        maximo = 30 * 86400 if t == "esperar" else 7 * 86400
        if not 60 <= _segundos(c) <= maximo:
            return f"El tiempo de espera {nombre} debe ir de 1 minuto a {'30' if t == 'esperar' else '7'} días."
    elif t == "condicion":
        if c.get("campo") not in CAMPOS:
            return f"La condición {nombre} necesita un campo."
        if c.get("campo") == "horario":
            if c.get("operador") not in ("dentro", "fuera") or not HORA.match(str(c.get("desde", ""))) or not HORA.match(str(c.get("hasta", ""))):
                return f"La condición {nombre} necesita horas con formato HH:MM."
        elif c.get("operador") not in OPERADORES or (c["operador"] not in ("vacio", "no_vacio") and not str(c.get("valor", "")).strip()):
            return f"La condición {nombre} necesita operador y valor."
    elif t == "archivo":
        if not _int(c.get("archivo_id")):
            return f"El paso {nombre} necesita un archivo de la biblioteca."
    elif t == "botones":
        bs = [str(b).strip() for b in c.get("botones", [])]
        if canal != "whatsapp":
            return "Los botones solo existen en WhatsApp."
        if not str(c.get("texto", "")).strip() or len(str(c.get("texto", ""))) > 1024:
            return f"El mensaje de botones {nombre} necesita texto (máximo 1024 caracteres)."
        if not 1 <= len(bs) <= 3 or any(not b or len(b) > 20 for b in bs) or len({_norm(b) for b in bs}) != len(bs):
            return f"El paso {nombre} necesita de 1 a 3 botones distintos, con texto de hasta 20 caracteres."
        if not 60 <= _segundos(c) <= 7 * 86400:
            return f"El tiempo de espera {nombre} debe ir de 1 minuto a 7 días."
    elif t == "asignar" and c.get("ejecutivo_id") != "reparto" and not _int(c.get("ejecutivo_id")):
        return f"El paso {nombre} necesita un ejecutivo (o «reparto»)."
    elif t == "etapa" and not _int(c.get("etapa_id")):
        return f"El paso {nombre} necesita una etapa."
    elif t == "nota" and not str(c.get("texto", "")).strip():
        return f"La nota {nombre} no tiene texto."
    elif t == "tarea" and (not str(c.get("texto", "")).strip() or not 0 <= _int(c.get("horas"), -1) <= 720):
        return f"La tarea {nombre} necesita texto y horas entre 0 y 720."
    elif t == "ia" and len(str(c.get("instrucciones", ""))) > 1500:
        return f"Las instrucciones de la IA {nombre} son demasiado largas (máximo 1500 caracteres)."
    return None


def _hay_ciclo(adj: dict[str, list[str]]) -> bool:
    estado: dict[str, int] = {}

    def visita(u: str) -> bool:
        estado[u] = 1
        for v in adj.get(u, []):
            if estado.get(v) == 1 or (estado.get(v) is None and visita(v)):
                return True
        estado[u] = 2
        return False
    return any(estado.get(u) is None and visita(u) for u in list(adj))


def problemas(defn: dict, canal: str, estricta: bool) -> list[str]:
    """Borrador (estricta=False): solo que la estructura sea coherente. Publicar (estricta=True): que el flujo pueda correr."""
    nodos, cons = defn.get("nodos", []), defn.get("conexiones", [])
    out: list[str] = []
    ids = [n["id"] for n in nodos]
    if len(set(ids)) != len(ids):
        out.append("Hay dos pasos con el mismo identificador.")
    por_id = {n["id"]: n for n in nodos}
    disp = [n for n in nodos if n["tipo"] == "disparador"]
    if len(disp) > 1:
        out.append("Solo puede haber un inicio de flujo.")
    usadas: set[tuple[str, str]] = set()
    adj: dict[str, list[str]] = {}
    for c in cons:
        if c["de"] not in por_id or c["a"] not in por_id:
            out.append("Hay una conexión que apunta a un paso que no existe.")
            continue
        if c["salida"] not in SALIDAS[por_id[c["de"]]["tipo"]]:
            out.append(f"El paso «{por_id[c['de']].get('config', {}).get('rotulo') or por_id[c['de']]['tipo']}» no tiene la salida «{c['salida']}».")
        if (c["de"], c["salida"]) in usadas:
            out.append("Una salida solo puede conectarse a un paso.")
        usadas.add((c["de"], c["salida"]))
        adj.setdefault(c["de"], []).append(c["a"])
    if not estricta:
        return out
    if len(disp) != 1:
        return out + ["El flujo necesita exactamente un inicio."]
    vistos, pila = {disp[0]["id"]}, [disp[0]["id"]]
    while pila:
        for v in adj.get(pila.pop(), []):
            if v not in vistos:
                vistos.add(v); pila.append(v)
    if len(vistos) == 1:
        out.append("Conecta el inicio con al menos un paso.")
    for n in nodos:
        if n["id"] not in vistos:
            out.append(f"El paso «{(n.get('config') or {}).get('rotulo') or n['tipo']}» no está conectado al inicio.")
    if _hay_ciclo(adj):
        out.append("El flujo tiene un ciclo (vuelve a un paso anterior). Por ahora los flujos deben avanzar sin repetirse.")
    for n in nodos:
        m = _config_ok(n, canal)
        if m:
            out.append(m)
    return out


# ======================= CONDICIONES Y SIMULACIÓN =======================
def _coincide_mensaje(c: dict, texto: str) -> bool:
    if c.get("evento") == "mensaje_entrante":
        return True
    if c.get("evento") != "palabra_clave":
        return False
    t = _norm(texto)
    palabras = [_norm(str(p)) for p in c.get("palabras", []) if str(p).strip()]
    return t in palabras if c.get("modo") == "igual" else any(p in t for p in palabras)


def evaluar(c: dict, v: dict, ahora: datetime | None = None) -> bool:
    campo, op = c.get("campo"), c.get("operador")
    if campo == "horario":
        a = (ahora or datetime.now(ZONA)).astimezone(ZONA)
        dentro = a.weekday() in (c.get("dias") or range(7)) and str(c.get("desde", "00:00")) <= a.strftime("%H:%M") < str(c.get("hasta", "23:59"))
        return dentro if op == "dentro" else not dentro
    dato, valor = _norm(str(v.get(campo, "") or "")), _norm(str(c.get("valor", "")))
    return {"contiene": valor in dato, "no_contiene": valor not in dato, "igual": dato == valor, "distinto": dato != valor,
            "empieza": dato.startswith(valor), "vacio": not dato, "no_vacio": bool(dato)}.get(op, False)


def _siguiente(defn: dict, nodo_id: str, salida: str) -> str | None:
    for tentativa in (salida, "siguiente" if salida == "humano" else None):
        for c in defn["conexiones"]:
            if tentativa and c["de"] == nodo_id and c["salida"] == tentativa:
                return c["a"]
    return None


def _disparador(defn: dict | None) -> dict | None:
    return next((n for n in (defn or {}).get("nodos", []) if n["tipo"] == "disparador"), None)


def simular(defn: dict, canal: str, mensaje: str, respuesta: str = "", sin_respuesta: bool = False) -> dict:
    """Recorre el flujo SIN enviar nada ni llamar a la IA: sirve para probar antes de publicar."""
    nodos = {n["id"]: n for n in defn["nodos"]}
    disp = _disparador(defn)
    if not disp:
        return {"coincide": False, "motivo": "Falta el inicio del flujo.", "pasos": []}
    cd = disp.get("config") or {}
    if cd.get("evento") in ("mensaje_entrante", "palabra_clave") and not _coincide_mensaje(cd, mensaje):
        return {"coincide": False, "motivo": "Con ese mensaje el flujo no se activaría. Revisa las palabras clave.", "pasos": []}
    v = {"nombre": "Cliente de prueba", "primer_nombre": "Cliente", "telefono": "999888777", "correo": "", "empresa": "", "interes": "",
         "ejecutivo": "", "etapa": "Nuevo", "origen": canal, "canal": canal, "mensaje": mensaje}
    pasos, actual = [], disp["id"]
    while actual and len(pasos) < MAX_PASOS:
        nodo = nodos[actual]
        t, c = nodo["tipo"], nodo.get("config") or {}
        salida, detalle = "siguiente", ""
        if t == "mensaje":
            detalle = "Enviaría: " + _render(str(c.get("texto", "")), v)
        elif t == "plantilla":
            detalle = f"Enviaría la plantilla «{c.get('plantilla')}»."
        elif t == "ia":
            detalle = "La IA respondería según sus instrucciones (en la prueba no se llama a la IA)."
        elif t == "esperar":
            detalle = f"Esperaría {c.get('cantidad')} {c.get('unidad')}."
        elif t == "esperar_respuesta":
            if sin_respuesta:
                salida, detalle = "tiempo", "El cliente no responde a tiempo."
            else:
                salida, v["mensaje"] = "respondio", respuesta or v["mensaje"]
                detalle = f"El cliente responde: «{v['mensaje']}»"
        elif t == "condicion":
            ok = evaluar(c, v)
            salida, detalle = ("si", "Se cumple.") if ok else ("no", "No se cumple.")
        elif t == "asignar":
            detalle = "Asignaría al ejecutivo elegido." if c.get("ejecutivo_id") != "reparto" else "Asignaría según el reparto rotativo."
        elif t == "archivo":
            detalle = "Enviaría el archivo elegido de la biblioteca."
        elif t == "botones":
            if sin_respuesta:
                salida, detalle = "tiempo", "El cliente no toca ningún botón a tiempo."
            else:
                v["mensaje"] = respuesta or mensaje
                salida = _salida_botones(nodo, v["mensaje"])
                detalle = f"Enviaría «{_render(str(c.get('texto', '')), v)}» con los botones {' | '.join(str(b) for b in c.get('botones', []))}. El cliente toca: «{v['mensaje']}»"
        elif t == "etapa":
            detalle = "Cambiaría la etapa del lead."
        elif t in ("nota", "tarea"):
            detalle = ("Agregaría la nota: " if t == "nota" else "Crearía la tarea: ") + _render(str(c.get("texto", "")), v)
        elif t == "fin":
            detalle = "Termina el flujo."
        pasos.append({"nodo": nodo["id"], "tipo": t, "rotulo": c.get("rotulo") or "", "salida": salida, "detalle": detalle})
        actual = _siguiente(defn, nodo["id"], salida)
    return {"coincide": True, "motivo": "", "pasos": pasos}


# ======================= ENVÍOS =======================
def _variables(con, lead_id: int, ctx: dict) -> dict:
    l = con.execute(
        "SELECT l.nombre, l.telefono, l.correo, l.empresa_nombre, l.interes, l.origen, e.nombre AS ejecutivo, et.nombre AS etapa "
        "FROM crm_leads l LEFT JOIN ejecutivos e ON e.id = l.ejecutivo_id LEFT JOIN crm_etapas et ON et.id = l.etapa_id WHERE l.id=?",
        (lead_id,)).fetchone()
    nombre = (l["nombre"] or "").strip()
    return {"nombre": nombre, "primer_nombre": nombre.split(" ")[0] if nombre else "", "telefono": l["telefono"], "correo": l["correo"],
            "empresa": l["empresa_nombre"], "interes": l["interes"], "origen": l["origen"], "ejecutivo": l["ejecutivo"] or "",
            "etapa": l["etapa"] or "", "mensaje": ctx.get("mensaje", ""), "canal": ctx.get("canal", "")}


def _guardar_mensaje(con, lead_id: int, wamid: str, tipo: str, texto: str, canal_id: int | None) -> None:
    con.execute(
        "INSERT INTO crm_mensajes (lead_id, direccion, wa_id, tipo, texto, estado, enviado_por, canal, canal_id) "
        "VALUES (?, 'out', ?, ?, ?, 'enviado', ?, 'whatsapp', ?)", (lead_id, wamid, tipo, texto, AUTOR, canal_id))
    con.execute("UPDATE crm_leads SET ultimo_contacto_en=now(), actualizado_en=now() WHERE id=?", (lead_id,))


def _enviar_texto(con, lead_id: int, canal: str, texto: str) -> None:
    """Envía por el canal del flujo. Lanza ErrorWa con un mensaje legible si no se puede."""
    if canal != "whatsapp":
        ms.enviar_a_lead(con, lead_id, canal, texto, AUTOR)
        return
    l = con.execute("SELECT telefono, wa_ultimo_entrante FROM crm_leads WHERE id=?", (lead_id,)).fetchone()
    if not l or not l["telefono"]:
        raise wa.ErrorWa("El lead no tiene teléfono.")
    if not wa.dentro_de_ventana(l["wa_ultimo_entrante"]):
        raise wa.ErrorWa("Pasaron más de 24 horas desde el último mensaje del cliente: en WhatsApp solo se puede enviar una plantilla.")
    cid = cn.para_responder(con, lead_id, "whatsapp")
    with cn.usando(cid):
        wamid = wa.enviar_texto(l["telefono"], texto)
    _guardar_mensaje(con, lead_id, wamid, "text", texto, cid)


def _enviar_plantilla(con, lead_id: int, c: dict, v: dict) -> str:
    l = con.execute("SELECT telefono FROM crm_leads WHERE id=?", (lead_id,)).fetchone()
    if not l or not l["telefono"]:
        raise wa.ErrorWa("El lead no tiene teléfono.")
    variables = [_render(str(x), v) for x in c.get("variables", [])]
    cid = cn.para_responder(con, lead_id, "whatsapp")
    with cn.usando(cid):
        pl = next((p for p in wa.plantillas() if p["nombre"] == c.get("plantilla") and p["idioma"] == c.get("idioma")), None)
        if not pl:
            raise wa.ErrorWa("La plantilla no está aprobada o no existe en ese idioma.")
        if len(variables) != pl["variables"] or any(not x.strip() for x in variables):
            raise wa.ErrorWa(f"La plantilla necesita {pl['variables']} variable(s) con texto.")
        wamid = wa.enviar_plantilla(l["telefono"], pl["nombre"], pl["idioma"], variables)
    texto = re.sub(r"\{\{(\d+)\}\}", lambda m: variables[int(m.group(1)) - 1] if int(m.group(1)) <= len(variables) else "", pl["cuerpo"])
    _guardar_mensaje(con, lead_id, wamid, "template", f"[Plantilla {pl['nombre']}] {texto}", cid)
    return texto


def _historial(con, lead_id: int, canal: str) -> list[tuple[str, str]]:
    filas = con.execute(
        "SELECT direccion, texto FROM crm_mensajes WHERE lead_id=? AND canal=? AND texto <> '' ORDER BY creado_en DESC, id DESC LIMIT 12",
        (lead_id, canal)).fetchall()
    return [("user" if f["direccion"] == "in" else "assistant", f["texto"]) for f in reversed(filas)]


# ======================= EJECUCIÓN =======================
def _ejecutar_nodo(con, ej, f, nodo: dict, ctx: dict, avisar: set) -> tuple:
    """Devuelve ('seguir', salida, detalle) | ('espera', cuando, estado, salida_al_vencer) | ('reintentar', segundos)."""
    t, c, lid = nodo["tipo"], nodo.get("config") or {}, ej["lead_id"]
    v = _variables(con, lid, ctx)
    if t in ("archivo", "botones"):
        return _ejecutar_extra(con, f, nodo, ctx, lid, v)
    if t == "disparador":
        return ("seguir", "siguiente", "")
    if t in ("mensaje", "plantilla"):
        try:
            if t == "mensaje":
                texto = _render(str(c.get("texto", "")), v)
                _enviar_texto(con, lid, f["canal"], texto)
            else:
                texto = _enviar_plantilla(con, lid, c, v)
            return ("seguir", "siguiente", texto[:300])
        except wa.ErrorWa as e:
            ctx["ultimo_error"] = str(e)
            return ("seguir", "error", str(e))
    if t == "ia":
        espera = ia.espera_necesaria()
        if espera > 0:
            return ("reintentar", int(espera) + 1)
        try:
            texto, humano = ia.responder(_render(str(c.get("instrucciones", "")), v), _historial(con, lid, f["canal"]), v["nombre"])
            _enviar_texto(con, lid, f["canal"], texto)
        except ia.ErrorIA as e:
            if e.reintentable and _int(ctx.get("intentos_ia")) < 3:
                ctx["intentos_ia"] = _int(ctx.get("intentos_ia")) + 1
                return ("reintentar", 45)
            ctx["ultimo_error"] = str(e)
            return ("seguir", "error", str(e))
        except wa.ErrorWa as e:
            ctx["ultimo_error"] = str(e)
            return ("seguir", "error", str(e))
        if humano:  # una persona toma la conversación: la IA y los flujos por mensaje callan un tiempo
            con.execute("UPDATE crm_leads SET bot_pausado_hasta = now() + (? * interval '1 hour') WHERE id=?",
                        (_int(c.get("pausa_horas"), 24) or 24, lid))
            registrar(con, lid, "sistema", "La IA pasó la conversación a una persona", AUTOR)
        return ("seguir", "humano" if humano else "siguiente", texto[:300])
    if t in ("esperar", "esperar_respuesta"):
        resp = t == "esperar_respuesta"
        cuando = datetime.now(ZONA) + timedelta(seconds=max(60, _segundos(c)))
        return ("espera", cuando, "esperando_respuesta" if resp else "esperando", "tiempo" if resp else "siguiente")
    if t == "condicion":
        ok = evaluar(c, v)
        return ("seguir", "si" if ok else "no", "Se cumple" if ok else "No se cumple")
    if t == "asignar":
        l = con.execute("SELECT ejecutivo_id FROM crm_leads WHERE id=?", (lid,)).fetchone()
        if l["ejecutivo_id"] is not None and c.get("solo_sin_asignar", True):
            return ("seguir", "siguiente", "Ya tenía ejecutivo: no se cambió")
        eid = siguiente_asesor(con) if c.get("ejecutivo_id") == "reparto" else _int(c.get("ejecutivo_id"))
        e = con.execute("SELECT id, nombre FROM ejecutivos WHERE id=? AND activo=1", (eid,)).fetchone() if eid else None
        if not e:
            return ("seguir", "siguiente", "No había ejecutivo disponible (reparto rotativo apagado o ejecutivo inactivo)")
        con.execute("UPDATE crm_leads SET ejecutivo_id=?, actualizado_en=now() WHERE id=?", (e["id"], lid))
        registrar(con, lid, "sistema", f"Asignado a: {e['nombre']} (automatización)", AUTOR)
        avisar.add(lid)
        return ("seguir", "siguiente", f"Asignado a {e['nombre']}")
    if t == "etapa":
        n = con.execute("SELECT id, nombre, tipo FROM crm_etapas WHERE id=? AND activa=1", (_int(c.get("etapa_id")),)).fetchone()
        if not n:
            return ("seguir", "siguiente", "La etapa ya no existe o está desactivada")
        estado = {"abierta": "abierto", "ganada": "ganado", "perdida": "perdido"}[n["tipo"]]
        con.execute("UPDATE crm_leads SET etapa_id=?, estado=?, motivo_perdida=?, actualizado_en=now() WHERE id=?",
                    (n["id"], estado, str(c.get("motivo") or "Automatización")[:200] if estado == "perdido" else "", lid))
        registrar(con, lid, "sistema", f"Etapa → {n['nombre']} (automatización)", AUTOR)
        avisar.add(lid)
        return ("seguir", "siguiente", f"Etapa: {n['nombre']}")
    if t == "nota":
        registrar(con, lid, "nota", _render(str(c.get("texto", "")), v), AUTOR)
        return ("seguir", "siguiente", "Nota agregada")
    if t == "tarea":
        registrar(con, lid, "tarea", _render(str(c.get("texto", "")), v), AUTOR, datetime.now(ZONA) + timedelta(hours=_int(c.get("horas"))))
        recalcular_siguiente(con, lid)
        avisar.add(lid)
        return ("seguir", "siguiente", "Tarea creada")
    return ("seguir", "siguiente", "")  # «fin» y desconocidos: se cierra al no haber conexión


def _salida_botones(nodo: dict, texto: str) -> str:
    """Qué botón tocó el cliente (por su título); «otro» si escribió otra cosa."""
    t = _norm(texto)
    for i, b in enumerate((nodo.get("config") or {}).get("botones", [])[:3]):
        if t and _norm(str(b)) == t:
            return f"b{i + 1}"
    return "otro"


def _ejecutar_extra(con, f, nodo: dict, ctx: dict, lid: int, v: dict) -> tuple:
    """Nodos «Enviar archivo» y «Botones de WhatsApp»."""
    t, c = nodo["tipo"], nodo.get("config") or {}
    try:
        a = con.execute("SELECT * FROM crm_archivos WHERE id=?", (_int(c.get("archivo_id")),)).fetchone() if _int(c.get("archivo_id")) else None
        if t == "archivo":
            if not a:
                raise wa.ErrorWa("El archivo ya no existe en la biblioteca.")
            ar.enviar_a_lead(con, lid, f["canal"], a, _render(str(c.get("texto", "")), v), AUTOR)
            return ("seguir", "siguiente", f"Archivo enviado: {a['nombre']}")
        ar.enviar_botones_a_lead(con, lid, _render(str(c.get("texto", "")), v), [str(b).strip() for b in c.get("botones", [])], a, AUTOR)
        cuando = datetime.now(ZONA) + timedelta(seconds=max(60, _segundos(c)))
        return ("espera", cuando, "esperando_respuesta", "tiempo")  # al responder, _correr elige la salida según el botón
    except wa.ErrorWa as e:
        ctx["ultimo_error"] = str(e)
        return ("seguir", "error", str(e))


def _log(con, ej_id: int, nodo: dict, r: tuple) -> None:
    if r[0] == "seguir":
        salida, detalle = r[1], r[2]
    elif r[0] == "espera":
        salida, detalle = "", f"Espera hasta {r[1].astimezone(ZONA):%d/%m %H:%M}"
    else:
        salida, detalle = "", f"Vuelve a intentar en {r[1]} s"
    con.execute("INSERT INTO crm_flujo_registros (ejecucion_id, nodo_id, tipo, salida, detalle) VALUES (?,?,?,?,?)",
                (ej_id, nodo["id"], nodo["tipo"], salida, detalle[:300]))


def _guardar(con, ej_id: int, nodo_id: str, estado: str, cuando, ctx: dict) -> None:
    con.execute("UPDATE crm_flujo_ejecuciones SET estado=?, nodo_actual=?, siguiente_en=?, contexto=?::jsonb, actualizado_en=now() WHERE id=?",
                (estado, nodo_id, cuando, json.dumps(ctx), ej_id))


def _cerrar(con, ej_id: int, estado: str, error: str = "", ctx: dict | None = None) -> None:
    con.execute("UPDATE crm_flujo_ejecuciones SET estado=?, error=?, siguiente_en=NULL, contexto=COALESCE(?::jsonb, contexto), actualizado_en=now() WHERE id=?",
                (estado, error[:300], json.dumps(ctx) if ctx is not None else None, ej_id))


def _correr(ej_id: int) -> None:
    con = abrir_db()
    avisar: set[int] = set()
    try:
        ej = con.execute("SELECT * FROM crm_flujo_ejecuciones WHERE id=?", (ej_id,)).fetchone()
        if not ej or ej["estado"] != "procesando":
            return
        f = con.execute("SELECT id, canal, canal_id, publicada FROM crm_flujos WHERE id=?", (ej["flujo_id"],)).fetchone()
        defn = f["publicada"] if f else None
        if not defn:
            return _cerrar(con, ej_id, "cancelada", "El flujo ya no está publicado")
        ctx = dict(ej["contexto"] or {})
        ctx.setdefault("canal", f["canal"])
        pend, venc = ctx.pop("_salida", None), ctx.pop("_salida_al_vencer", None)
        pend = pend or venc  # si el cliente respondió a tiempo gana la respuesta; si no, la salida por vencimiento
        nodos = {n["id"]: n for n in defn["nodos"]}
        actual, pasos = ej["nodo_actual"], 0
        while True:
            nodo = nodos.get(actual)
            if nodo is None:
                return _cerrar(con, ej_id, "error", "El flujo cambió y este paso ya no existe", ctx)
            if pend is not None:
                if nodo["tipo"] == "botones" and pend == "respondio":
                    pend = _salida_botones(nodo, ctx.get("mensaje", ""))
                r, pend = ("seguir", pend, ""), None
            else:
                r = _ejecutar_nodo(con, ej, f, nodo, ctx, avisar)
                _log(con, ej_id, nodo, r)
            if r[0] == "espera":
                return _guardar(con, ej_id, nodo["id"], r[2], r[1], {**ctx, "_salida_al_vencer": r[3]})
            if r[0] == "reintentar":
                return _guardar(con, ej_id, nodo["id"], "activa", datetime.now(ZONA) + timedelta(seconds=r[1]), ctx)
            destino = _siguiente(defn, nodo["id"], r[1])
            if destino is None:
                fallo = r[1] == "error"
                return _cerrar(con, ej_id, "error" if fallo else "completada", ctx.get("ultimo_error", "") if fallo else "", ctx)
            actual, pasos = destino, pasos + 1
            if pasos >= MAX_PASOS:
                return _cerrar(con, ej_id, "error", "El flujo hizo demasiados pasos seguidos", ctx)
    except Exception as e:
        logger.exception("Falló la automatización %s", ej_id)
        try:
            _cerrar(con, ej_id, "error", str(e))
        except Exception:
            pass
    finally:
        con.close()
        for lid in avisar:
            avisar_lead(lid)


# ======================= DISPARADORES =======================
def _publicados(con, canal: str | None = None, canal_id: int | None = None) -> list:
    if canal is None:
        return con.execute("SELECT id, canal, canal_id, publicada FROM crm_flujos WHERE estado='publicado'").fetchall()
    return con.execute(
        "SELECT id, canal, canal_id, publicada FROM crm_flujos WHERE estado='publicado' AND canal=? AND (canal_id IS NULL OR canal_id = ?::int)",
        (canal, canal_id)).fetchall()


def _ya_corre(con, flujo_id: int, lead_id: int, horas: int) -> bool:
    return con.execute(
        "SELECT 1 FROM crm_flujo_ejecuciones WHERE flujo_id=? AND lead_id=? AND (estado IN ('activa','procesando','esperando','esperando_respuesta') "
        "OR creado_en > now() - make_interval(hours => ?)) LIMIT 1", (flujo_id, lead_id, max(0, horas))).fetchone() is not None


def _crear(con, f, lead_id: int, nodo_id: str, ctx: dict, retraso_seg: int) -> None:
    con.execute("INSERT INTO crm_flujo_ejecuciones (flujo_id, lead_id, estado, nodo_actual, siguiente_en, contexto) "
                "VALUES (?,?,'activa',?, now() + (? * interval '1 second'), ?::jsonb)",
                (f["id"], lead_id, nodo_id, retraso_seg, json.dumps(ctx)))


def _al_recibir(con, lid: int) -> None:
    m = con.execute("SELECT id, canal, canal_id, texto FROM crm_mensajes WHERE lead_id=? AND direccion='in' ORDER BY creado_en DESC, id DESC LIMIT 1", (lid,)).fetchone()
    if not m:
        return
    texto = m["texto"] or ""
    # 1) ¿Hay un flujo esperando justo esta respuesta?
    esperando = con.execute(
        "UPDATE crm_flujo_ejecuciones e SET estado='activa', siguiente_en=now(), actualizado_en=now(), "
        "contexto = (e.contexto - '_salida_al_vencer') || ?::jsonb FROM crm_flujos f "
        "WHERE e.lead_id=? AND e.estado='esperando_respuesta' AND f.id = e.flujo_id AND f.canal=? RETURNING e.id",
        (json.dumps({"_salida": "respondio", "mensaje": texto, "msg_id": m["id"]}), lid, m["canal"])).fetchall()
    if esperando:
        return
    # 2) ¿Corresponde iniciar un flujo nuevo? (no si una persona tomó la conversación)
    l = con.execute("SELECT estado, COALESCE(bot_pausado_hasta > now(), false) AS pausado FROM crm_leads WHERE id=?", (lid,)).fetchone()
    if not l or l["estado"] != "abierto" or l["pausado"]:
        return
    total = con.execute("SELECT COUNT(*) FROM crm_mensajes WHERE lead_id=? AND direccion='in' AND canal=?", (lid, m["canal"])).fetchone()[0]
    candidatos = []
    for f in _publicados(con, m["canal"], m["canal_id"]):
        t = _disparador(f["publicada"])
        c = (t or {}).get("config") or {}
        if not t or c.get("evento") not in ("mensaje_entrante", "palabra_clave"):
            continue
        if (c.get("solo_primero") and total > 1) or not _coincide_mensaje(c, texto):
            continue
        candidatos.append((c["evento"] != "palabra_clave", f["id"], f, t))
    candidatos.sort(key=lambda x: (x[0], x[1]))  # primero las palabras clave (más específicas)
    for _, _, f, t in candidatos:
        if _ya_corre(con, f["id"], lid, _int(t["config"].get("repetir_horas"), 24)):
            continue
        _crear(con, f, lid, t["id"], {"mensaje": texto, "msg_id": m["id"]}, 0)
        break  # un solo flujo por mensaje


def despues_de_recibir(lead_ids) -> None:
    """Lo llaman los webhooks. Nunca lanza errores ni espera: solo deja programado lo que corresponda."""
    if not lead_ids:
        return
    try:
        con = abrir_db()
        try:
            for lid in lead_ids:
                _al_recibir(con, lid)
        finally:
            con.close()
    except Exception:
        logger.exception("No se pudieron programar las automatizaciones de un mensaje nuevo")


def al_crear_lead(con, lead_id: int, origen: str) -> None:
    for f in _publicados(con):
        t = _disparador(f["publicada"])
        c = (t or {}).get("config") or {}
        if not t or c.get("evento") != "lead_nuevo":
            continue
        if origen not in (c.get("origenes") or ["whatsapp", "facebook", "instagram"]):  # por defecto, un import masivo no dispara nada
            continue
        if not _ya_corre(con, f["id"], lead_id, _int(c.get("repetir_horas"), 24)):
            _crear(con, f, lead_id, t["id"], {"origen": origen}, 5)  # 5 s: da tiempo a que el lead termine de guardarse


def pausar_por_humano(con, lead_id: int) -> None:
    """Si una persona escribe al cliente: se detienen los flujos que esperaban y los de mensaje callan 24 h."""
    try:
        con.execute("UPDATE crm_flujo_ejecuciones SET estado='cancelada', error='Una persona tomó la conversación', siguiente_en=NULL, "
                    "actualizado_en=now() WHERE lead_id=? AND estado IN ('esperando','esperando_respuesta')", (lead_id,))
        con.execute("UPDATE crm_leads SET bot_pausado_hasta = now() + interval '24 hours' WHERE id=?", (lead_id,))
    except Exception:
        logger.exception("No se pudo pausar la automatización del lead %s", lead_id)


def _revisar_sin_respuesta() -> None:
    con = abrir_db()
    try:
        for f in _publicados(con):
            t = _disparador(f["publicada"])
            c = (t or {}).get("config") or {}
            if not t or c.get("evento") != "sin_respuesta":
                continue
            filas = con.execute(
                "SELECT l.id AS lead_id, m.id AS msg_id FROM crm_leads l "
                "JOIN LATERAL (SELECT id, direccion, creado_en, canal_id FROM crm_mensajes WHERE lead_id = l.id AND canal = ? "
                "ORDER BY creado_en DESC, id DESC LIMIT 1) m ON TRUE "
                "WHERE l.estado='abierto' AND m.direccion='out' AND m.creado_en < now() - (? * interval '1 minute') "
                "AND m.creado_en > now() - interval '7 days' AND (?::int IS NULL OR m.canal_id = ?::int) "
                "AND NOT EXISTS (SELECT 1 FROM crm_flujo_ejecuciones e WHERE e.flujo_id = ? AND e.lead_id = l.id AND "
                "(e.estado IN ('activa','procesando','esperando','esperando_respuesta') OR e.creado_en > now() - (? * interval '1 hour'))) LIMIT 50",
                (f["canal"], max(5, _int(c.get("minutos"), 60)), f["canal_id"], f["canal_id"], f["id"], max(1, _int(c.get("repetir_horas"), 72)))).fetchall()
            for r in filas:
                _crear(con, f, r["lead_id"], t["id"], {"msg_id": r["msg_id"]}, 0)
    finally:
        con.close()


def _reclamar() -> list[int]:
    con = abrir_db()
    try:
        con.execute("UPDATE crm_flujo_ejecuciones SET estado='activa' WHERE estado='procesando' AND actualizado_en < now() - interval '5 minutes'")
        filas = con.execute(
            "UPDATE crm_flujo_ejecuciones SET estado='procesando', actualizado_en=now() WHERE id IN ("
            "SELECT id FROM crm_flujo_ejecuciones WHERE estado IN ('activa','esperando','esperando_respuesta') AND siguiente_en <= now() "
            "ORDER BY siguiente_en LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING id").fetchall()
        return [r["id"] for r in filas]
    finally:
        con.close()


def bucle() -> None:
    """Cada 3 segundos hace avanzar lo que ya toca (esperas vencidas, respuestas del cliente, mensajes nuevos)."""
    ultima = 0.0
    while True:
        try:
            for ej_id in _reclamar():
                _correr(ej_id)
            if time.time() - ultima > 60:
                ultima = time.time()
                _revisar_sin_respuesta()
        except Exception:
            logger.exception("Falló el ciclo de automatizaciones")
        time.sleep(3)


# ======================= PLANTILLAS PREDISEÑADAS =======================
def _n(i: str, t: str, x: int, y: int, **c) -> dict:
    return {"id": i, "tipo": t, "x": x, "y": y, "config": c}


def _c(de: str, a: str, salida: str = "siguiente") -> dict:
    return {"de": de, "salida": salida, "a": a}


PLANTILLAS = [
    {"id": "bienvenida", "nombre": "Bienvenida automática",
     "descripcion": "Saluda la primera vez que alguien escribe y le asigna un ejecutivo.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 120, rotulo="Primer mensaje", evento="mensaje_entrante", solo_primero=True, repetir_horas=24),
         _n("n2", "mensaje", 320, 120, rotulo="Saludo", texto="¡Hola! Gracias por escribirnos. En un momento un ejecutivo de ventas te atenderá. ¿En qué podemos ayudarte?"),
         _n("n3", "asignar", 600, 120, rotulo="Asignar ejecutivo", ejecutivo_id="reparto"),
         _n("n4", "fin", 880, 120, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3"), _c("n3", "n4")]}},
    {"id": "fuera_horario", "nombre": "Respuesta fuera de horario",
     "descripcion": "Avisa que están fuera de horario (lunes a viernes, 9:00 a 18:00) y deja una tarea para el día siguiente.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 140, rotulo="Mensaje entrante", evento="mensaje_entrante", repetir_horas=12),
         _n("n2", "condicion", 320, 140, rotulo="¿Fuera de horario?", campo="horario", operador="fuera", desde="09:00", hasta="18:00", dias=[0, 1, 2, 3, 4]),
         _n("n3", "mensaje", 600, 60, rotulo="Aviso", texto="¡Hola! Ahora estamos fuera de horario (lunes a viernes de 9:00 a 18:00). Te responderemos apenas volvamos."),
         _n("n4", "tarea", 880, 60, rotulo="Tarea", texto="Responder a {{nombre}}: escribió fuera de horario", horas=12),
         _n("n5", "fin", 1160, 60, rotulo="Fin"), _n("n6", "fin", 600, 240, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3", "si"), _c("n2", "n6", "no"), _c("n3", "n4"), _c("n4", "n5")]}},
    {"id": "precios", "nombre": "Palabra clave: precios",
     "descripcion": "Si el cliente pregunta por precios o cotización, responde, asigna un ejecutivo y crea una tarea de llamada.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 120, rotulo="Pregunta por precios", evento="palabra_clave", palabras=["precio", "precios", "costo", "cuanto cuesta", "cotizacion"], modo="contiene", repetir_horas=24),
         _n("n2", "mensaje", 320, 120, rotulo="Respuesta", texto="¡Gracias por tu interés! Un ejecutivo te enviará la información y los precios en breve."),
         _n("n3", "asignar", 600, 120, rotulo="Asignar ejecutivo", ejecutivo_id="reparto"),
         _n("n4", "tarea", 880, 120, rotulo="Tarea de llamada", texto="Llamar a {{nombre}}: pidió precios", horas=1),
         _n("n5", "fin", 1160, 120, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3"), _c("n3", "n4"), _c("n4", "n5")]}},
    {"id": "seguimiento", "nombre": "Seguimiento si no responde",
     "descripcion": "Si el cliente no contesta en 2 horas, le escribe y espera 12 horas; si sigue sin responder, crea una tarea para llamarlo.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 140, rotulo="Sin respuesta", evento="sin_respuesta", minutos=120, repetir_horas=72),
         _n("n2", "mensaje", 320, 140, rotulo="Seguimiento", texto="Hola, te escribimos para saber si pudiste revisar la información que te enviamos. ¿Tienes alguna duda? Estamos para ayudarte."),
         _n("n3", "esperar_respuesta", 600, 80, rotulo="Esperar respuesta", cantidad=12, unidad="horas"),
         _n("n4", "nota", 880, 40, rotulo="Nota", texto="El cliente respondió al seguimiento."),
         _n("n5", "fin", 1160, 40, rotulo="Fin"),
         _n("n6", "tarea", 880, 240, rotulo="Tarea de llamada", texto="Llamar a {{nombre}}: no respondió al seguimiento", horas=2),
         _n("n7", "fin", 1160, 240, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3"), _c("n2", "n6", "error"), _c("n3", "n4", "respondio"), _c("n3", "n6", "tiempo"), _c("n4", "n5"), _c("n6", "n7")]}},
    {"id": "menu_botones", "nombre": "Menú con botones de WhatsApp",
     "descripcion": "Saluda con 3 botones. Según el que toque, responde y asigna un ejecutivo; si no elige nada, deja una nota.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 240, rotulo="Primer mensaje", evento="mensaje_entrante", solo_primero=True, repetir_horas=24),
         _n("n2", "botones", 320, 180, rotulo="Menú", texto="¡Hola! ¿Qué te interesa?", botones=["Información", "Precios", "Hablar con alguien"], cantidad=12, unidad="horas", archivo_id=0),
         _n("n3", "mensaje", 640, 0, rotulo="Información", texto="Con gusto te contamos más. Un ejecutivo te enviará la información en breve."),
         _n("n4", "mensaje", 640, 140, rotulo="Precios", texto="Un ejecutivo te enviará los precios en breve."),
         _n("n6", "asignar", 960, 200, rotulo="Pasar a un ejecutivo", ejecutivo_id="reparto"),
         _n("n7", "nota", 640, 420, rotulo="Sin elegir", texto="El cliente no eligió ninguna opción del menú."),
         _n("n8", "fin", 960, 420, rotulo="Fin"), _n("n9", "fin", 1240, 200, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3", "b1"), _c("n2", "n4", "b2"), _c("n2", "n6", "b3"), _c("n2", "n6", "otro"),
                        _c("n2", "n7", "tiempo"), _c("n3", "n6"), _c("n4", "n6"), _c("n6", "n9"), _c("n7", "n8")]}},
    {"id": "asistente_ia", "nombre": "Asistente con IA y traspaso a humano",
     "descripcion": "La IA responde cada mensaje con la información de tu empresa. Si el cliente pide una persona o se molesta, asigna un ejecutivo y la IA calla 24 horas.",
     "definicion": {"nodos": [
         _n("n1", "disparador", 40, 160, rotulo="Mensaje entrante", evento="mensaje_entrante", repetir_horas=0),
         _n("n2", "ia", 320, 160, rotulo="Asistente", instrucciones="Atiende a personas interesadas en nuestros servicios. Pregunta su nombre y qué necesitan. No des precios.", pausa_horas=24),
         _n("n3", "fin", 600, 60, rotulo="Fin"),
         _n("n4", "asignar", 600, 240, rotulo="Pasar a un ejecutivo", ejecutivo_id="reparto"),
         _n("n5", "nota", 880, 240, rotulo="Nota", texto="La conversación pasó de la IA a una persona."),
         _n("n6", "fin", 1160, 240, rotulo="Fin")],
         "conexiones": [_c("n1", "n2"), _c("n2", "n3"), _c("n2", "n4", "humano"), _c("n2", "n4", "error"), _c("n4", "n5"), _c("n5", "n6")]}},
]