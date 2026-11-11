"""
seace_http.py  -  Cosechador HTTP para el buscador público de SEACE (Procedimientos de selección).

Idea: Playwright SOLO hace lo que requiere un navegador real (filtros + clic en Buscar, que genera el
token reCAPTCHA). Todo lo demás (paginación y fichas) va por HTTP con la misma sesión, rápido y liviano.

Instalar:  pip install curl_cffi lxml playwright
"""
import gzip
import json
import random
import re
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode

from curl_cffi import requests as cr
from lxml import html as lh

BASE = "https://prod2.seace.gob.pe"
URL = f"{BASE}/seacebus-uiwd-pub/buscadorPublico/buscadorPublico.xhtml"
FORM = "tbBuscador:idFormBuscarProceso"
TABLE = f"{FORM}:dtProcesos"
BTN = f"{FORM}:btnBuscarSel"
ROWS = 15            # prueba 50 o 100 más adelante (ver nota en la respuesta)
PAUSA = (1.5, 3.5)   # segundos entre requests (aleatorio)

# claves del POST capturado que NO deben pasar a la plantilla
_DROP = {
    "javax.faces.partial.ajax", "javax.faces.source", "javax.faces.partial.execute",
    "javax.faces.partial.render", "javax.faces.behavior.event", "javax.faces.partial.event",
    "submit", BTN, "javax.faces.ViewState",
}


def pausa():
    time.sleep(random.uniform(*PAUSA))


# ----------------------------------------------------------------------------- parsing
def _cdata(xml: str) -> str:
    blocks = re.findall(r"<!\[CDATA\[(.*?)\]\]>", xml, re.S)
    return "\n".join(blocks) if blocks else xml


def new_viewstate(xml: str):
    m = re.search(r'<update id="[^"]*ViewState[^"]*"><!\[CDATA\[(.*?)\]\]>', xml, re.S)
    return m.group(1) if m else None


def total_registros(xml: str):
    m = re.search(r"del total (\d+)", xml)
    return int(m.group(1)) if m else None


def parse_rows(xml: str):
    blob = _cdata(xml)
    if "<table" not in blob:
        blob = f"<table>{blob}</table>"
    root = lh.fromstring(f"<div>{blob}</div>")
    out = []
    for tr in root.xpath("//tr[@data-ri]"):
        tds = tr.xpath("./td")
        if len(tds) < 13:
            continue
        t = lambda i: " ".join(tds[i].text_content().split())
        row = {
            "entidad": t(1), "fecha_publicacion": t(2), "nomenclatura": t(3),
            "reiniciado_desde": t(4), "objeto": t(5), "descripcion": t(6),
            "valor_referencial": t(9), "moneda": t(10), "version_seace": t(11),
        }
        for a in tds[12].xpath(".//a[@onclick]"):
            m = re.search(r"addSubmitParam\('([^']+)',\{(.*?)\}\)", a.get("onclick"))
            if not m:
                continue
            params = dict(re.findall(r"'([^']*)':'([^']*)'", m.group(2)))
            if "ntipo" in params:                       # el enlace de la Ficha de selección
                row["ficha_params"] = params
                row["nid_proceso"] = params.get("nidProceso")
                row["nid_convocatoria"] = params.get("nidConvocatoria")
        if row.get("nid_proceso"):
            out.append(row)
    return out


def extract_links(doc_html: str, base_url: str):
    root = lh.fromstring(doc_html)
    root.make_links_absolute(base_url)
    links = []
    for a in root.xpath("//a"):
        href = a.get("href") or ""
        if href in ("", "#") or href.startswith("javascript"):
            href = None
        oc = a.get("onclick") or ""
        if not href and not oc:
            continue
        links.append({
            "id": a.get("id"), "text": " ".join(a.text_content().split()),
            "href": href, "onclick": oc[:400] or None,
        })
    return links


# ----------------------------------------------------------------------------- cliente HTTP
class Harvester:
    def __init__(self, cookies, template_pairs, viewstate):
        # impersonate="chrome" imita el handshake TLS de Chrome real (evita huella de 'python-requests')
        self.s = cr.Session(impersonate="chrome", timeout=45)
        for c in cookies:
            self.s.cookies.set(c["name"], c["value"], domain=c["domain"], path=c.get("path", "/"))
        self.template = [(k, v) for k, v in template_pairs if k not in _DROP]
        if not any(k == FORM for k, _ in self.template):
            self.template.append((FORM, FORM))
        self.vs = viewstate

    @classmethod
    def from_capture(cls, cookies, post_data: str, response_xml: str):
        pairs = parse_qsl(post_data, keep_blank_values=True)
        return cls(cookies, pairs, new_viewstate(response_xml))

    def _post(self, pairs, ajax, intentos=4):
        h = {"origin": BASE, "referer": URL, "accept-language": "es-ES,es;q=0.9"}
        if ajax:
            h.update({"accept": "application/xml, text/xml, */*; q=0.01",
                      "faces-request": "partial/ajax", "x-requested-with": "XMLHttpRequest",
                      "content-type": "application/x-www-form-urlencoded; charset=UTF-8"})
        else:
            h.update({"accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
                      "content-type": "application/x-www-form-urlencoded",
                      "upgrade-insecure-requests": "1"})
        body = urlencode(pairs)
        for n in range(intentos):
            r = self.s.post(URL, data=body, headers=h, allow_redirects=True)
            if r.status_code == 200 and "ViewExpired" not in r.text[:3000]:
                return r
            if r.status_code in (403, 429) or r.status_code >= 500:
                espera = (2 ** n) * 20 + random.uniform(0, 10)   # backoff largo: no insistas si te frenan
                print(f"[aviso] HTTP {r.status_code}, espero {espera:.0f}s")
                time.sleep(espera)
                continue
            raise RuntimeError(f"Respuesta inesperada HTTP {r.status_code} (¿ViewState vencido?)")
        raise RuntimeError("Demasiados reintentos; SEACE está frenando. Para y reintenta más tarde.")

    def page(self, first: int):
        pairs = self.template + [
            ("javax.faces.partial.ajax", "true"), ("javax.faces.source", TABLE),
            ("javax.faces.partial.execute", TABLE), ("javax.faces.partial.render", TABLE),
            ("javax.faces.behavior.event", "page"), ("javax.faces.partial.event", "page"),
            (f"{TABLE}_pagination", "true"), (f"{TABLE}_first", str(first)),
            (f"{TABLE}_rows", str(ROWS)), (f"{TABLE}_encodeFeature", "true"),
            ("javax.faces.ViewState", self.vs),
        ]
        r = self._post(pairs, ajax=True)
        self.vs = new_viewstate(r.text) or self.vs
        return parse_rows(r.text)

    def ficha(self, row):
        pairs = self.template + list(row["ficha_params"].items()) + [("javax.faces.ViewState", self.vs)]
        r = self._post(pairs, ajax=False)
        return r.text, str(r.url)


# ----------------------------------------------------------------------------- persistencia
def persist(item: dict):
    """<<< AQUÍ conectas tu MySQL (pladibot_db): INSERT ... ON DUPLICATE KEY UPDATE por nid_proceso >>>"""
    with open("seace_items.jsonl", "a", encoding="utf-8") as f:
        f.write(json.dumps(item, ensure_ascii=False) + "\n")


def guardar_ficha_cruda(nid: str, doc_html: str):
    d = Path("fichas_html")
    d.mkdir(exist_ok=True)
    (d / f"{nid}.html.gz").write_bytes(gzip.compress(doc_html.encode("utf-8")))


def ya_guardada(nid: str) -> bool:
    return (Path("fichas_html") / f"{nid}.html.gz").exists()


# ----------------------------------------------------------------------------- orquestación
def cosechar(context, search_response, traer_fichas=True):
    """
    context: BrowserContext de Playwright (para sacar las cookies)
    search_response: la Response capturada del POST de Buscar (ver snippet de integración)
    """
    xml = search_response.text()
    h = Harvester.from_capture(context.cookies(), search_response.request.post_data, xml)

    rows = parse_rows(xml)
    total = total_registros(xml) or len(rows)
    print(f"[búsqueda] total={total}, primera página={len(rows)}")

    vistos = {r["nid_proceso"] for r in rows}
    first = ROWS
    while len(vistos) < total:
        pausa()
        nuevos = [r for r in h.page(first) if r["nid_proceso"] not in vistos]
        if not nuevos:
            print("[aviso] página vacía, corto la paginación")
            break
        for r in nuevos:
            vistos.add(r["nid_proceso"])
        rows += nuevos
        first += ROWS
        print(f"[paginación] {len(vistos)}/{total}")

    for i, row in enumerate(rows, 1):
        nid = row["nid_proceso"]
        item = {k: v for k, v in row.items() if k != "ficha_params"}
        if traer_fichas and not ya_guardada(nid):
            pausa()
            try:
                doc, url_final = h.ficha(row)
                guardar_ficha_cruda(nid, doc)
                item["ficha_url_final"] = url_final
                item["links"] = extract_links(doc, url_final)
            except Exception as e:
                item["error_ficha"] = str(e)
                print(f"[error] ficha {nid}: {e}")
        persist(item)
        if i % 25 == 0:
            print(f"[fichas] {i}/{len(rows)}")
    return rows