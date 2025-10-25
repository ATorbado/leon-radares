# scripts/scrape_ayto.py
import re, json, datetime, urllib.request
from pathlib import Path
from html.parser import HTMLParser

AYTO_AVISOS = "https://www.aytoleon.es/es/actualidad/avisos/Paginas/default.aspx"

# Este parser extrae titulares con “Corte”, “Restricciones”, fechas y calles.
# Para geocodificar, guarda solo el texto y deja la geometría como null; luego
# un paso manual/semiautomático puede convertir a LineString/Polygon.
class SimpleText(HTMLParser):
    def __init__(self): super().__init__(); self.text=[]
    def handle_data(self, d): self.text.append(d)
    def get(self): return " ".join(self.text)

def fetch_text(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8","ignore")

def parse_avisos(txt):
    items=[]
    for m in re.finditer(r"(Corte|Restricci[óo]n)[^\.]+", txt, flags=re.I):
        items.append(m.group(0))
    return items

def to_geojson(items):
    feats=[]
    now=datetime.datetime.utcnow().isoformat()+"Z"
    for i,raw in enumerate(items):
        props={"id":f"ayto-{i}","autoridad":"Ayto León","descripcion":raw,"motivo":"corte/restriccion","last_update":now}
        feats.append({"type":"Feature","geometry":None,"properties":props})
    return {"type":"FeatureCollection","features":feats}

def main():
    html=fetch_text(AYTO_AVISOS)
    txt=SimpleText(); txt.feed(html)
    avisos=parse_avisos(txt.get())
    gj=to_geojson(avisos)
    Path("closures").mkdir(exist_ok=True)
    Path("closures/calles_cortadas.geojson").write_text(json.dumps(gj,ensure_ascii=False))

if __name__=="__main__":
    main()
