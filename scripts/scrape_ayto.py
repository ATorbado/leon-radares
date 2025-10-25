import re, json, datetime, urllib.request
from html.parser import HTMLParser
from pathlib import Path

AYTO_AVISOS = "https://www.aytoleon.es/es/actualidad/avisos/Paginas/default.aspx"

class SimpleText(HTMLParser):
    def __init__(self): super().__init__(); self.text=[]
    def handle_data(self, d): self.text.append(d)
    def get(self): return " ".join(self.text)

def fetch_text(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        return r.read().decode("utf-8","ignore")

def parse_avisos(txt):
    pats = r"(Corte|Restricci[óo]n|Obra|Cort(es)? de tr[aá]fico)[^\.]+"
    return [m.group(0).strip() for m in re.finditer(pats, txt, flags=re.I)]

def to_geojson(items):
    now = datetime.datetime.utcnow().isoformat()+"Z"
    feats=[]
    for i, raw in enumerate(items):
        props={"id":f"ayto-{i}","autoridad":"Ayto León","descripcion":raw,"motivo":"corte","last_update":now}
        feats.append({"type":"Feature","geometry":None,"properties":props})
    return {"type":"FeatureCollection","features":feats}

def main():
    html = fetch_text(AYTO_AVISOS)
    txt = SimpleText(); txt.feed(html)
    avisos = parse_avisos(txt.get())
    gj = to_geojson(avisos)
    Path("closures").mkdir(exist_ok=True)
    Path("closures/calles_cortadas.geojson").write_text(json.dumps(gj, ensure_ascii=False))

if __name__=="__main__":
    main()
