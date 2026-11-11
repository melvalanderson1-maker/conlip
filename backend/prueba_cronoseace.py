import json
from collections import Counter
from curl_cffi import requests as r

BASE = "https://contratacionesabiertas.oece.gob.pe/api/v1"
H = {"accept": "application/json"}


def docs_map(rel):
    out = {}
    for d in (rel.get("tender", {}).get("documents") or []):
        key = str(d.get("id") or d.get("url") or d.get("title"))
        out[key] = d
    return out


def senales(rel):
    t = rel.get("tender", {})
    return {
        "fecha": (rel.get("date") or "")[:16],
        "tag": ",".join(rel.get("tag") or []),
        "docs": len(t.get("documents") or []),
        "nTenderers": t.get("numberOfTenderers"),
        "tenderers": len(t.get("tenderers") or []),
        "awards": len(rel.get("awards") or []),
        "finConsultas": ((t.get("enquiryPeriod") or {}).get("endDate") or "")[:16],
    }


def resumen_doc(d):
    return (f"tipo={d.get('documentType')} | titulo={str(d.get('title'))[:70]} | "
            f"pub={str(d.get('datePublished'))[:16]} | fmt={d.get('format')}")


with r.Session(impersonate="chrome") as s:
    p = {"sourceId": "seace_v3", "startDate": "2026-08-01", "endDate": "2026-09-15", "size": 100}
    rels = s.get(f"{BASE}/releasesAfter", params=p, timeout=60, headers=H).json()["releases"]

    procesos = {}
    for x in rels:
        pmd = (x["tender"].get("procurementMethodDetails") or "").lower()
        if "licitaci" in pmd:
            procesos.setdefault(x["ocid"], x["tender"]["id"])
    print("Procesos únicos (licitaciones):", len(procesos))

    tipos_agregados = Counter()
    titulos_agregados = Counter()
    muestra_doc = None
    muestra_award = None
    impresos = 0

    for ocid, tid in list(procesos.items())[:40]:
        pk = s.get(f"{BASE}/release/seace_v3/{tid}", timeout=60, headers=H).json()
        rl = sorted(pk.get("releases", []), key=lambda z: z.get("date", ""))
        if len(rl) < 2:
            continue

        if muestra_doc is None:
            for e in rl:
                if (e.get("tender", {}).get("documents")):
                    muestra_doc = e["tender"]["documents"][0]
                    break
        if muestra_award is None:
            for e in rl:
                if e.get("awards"):
                    muestra_award = e["awards"][0]
                    break

        lineas = []
        hubo_algo = False
        for i in range(len(rl) - 1):
            a, b = docs_map(rl[i]), docs_map(rl[i + 1])
            agregados = [b[k] for k in b if k not in a]
            quitados = [a[k] for k in a if k not in b]
            sa, sb = senales(rl[i]), senales(rl[i + 1])
            cambio_senal = {k: (sa[k], sb[k]) for k in sa if k != "fecha" and sa[k] != sb[k]}
            if agregados or quitados or cambio_senal:
                hubo_algo = True
                lineas.append(f"  {sa['fecha']} -> {sb['fecha']} | señales que cambian: {cambio_senal}")
                for d in agregados:
                    lineas.append(f"      + DOC NUEVO: {resumen_doc(d)}")
                    tipos_agregados[str(d.get("documentType"))] += 1
                    titulos_agregados[str(d.get("title"))[:50]] += 1
                for d in quitados:
                    lineas.append(f"      - DOC QUITADO: {resumen_doc(d)}")
        if hubo_algo and impresos < 8:
            impresos += 1
            print(f"\n=== proceso {tid} ({len(rl)} releases) ===")
            print("\n".join(lineas))

    print("\n=== ESTRUCTURA DE UN DOCUMENTO (claves y valores) ===")
    print(json.dumps(muestra_doc, ensure_ascii=False, indent=1)[:1200])
    print("\n=== ESTRUCTURA DE UN AWARD ===")
    if muestra_award:
        print("claves:", list(muestra_award.keys()))
        print(json.dumps({k: v for k, v in muestra_award.items() if k != "items"}, ensure_ascii=False, indent=1)[:1500])
    else:
        print("no se encontró ninguno")

    print("\n=== TIPOS de documento que aparecieron después ===")
    for k, n in tipos_agregados.most_common():
        print(f"  {k}: {n}")
    print("\n=== TÍTULOS de documento que aparecieron después (top 15) ===")
    for k, n in titulos_agregados.most_common(15):
        print(f"  {k}: {n}")