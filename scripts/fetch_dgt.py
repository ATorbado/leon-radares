import csv, json, io, urllib.request, datetime
from pathlib import Path
from openpyxl import load_workbook  # XLSX oficial DGT

PROVINCIA = "LEÓN"
DGT_XLSX_URL = "https://www.dgt.es/export/sites/web-DGT/.galleries/downloads/conoce-el-estado-del-trafico/informacion-e-incidencias-de-trafico/JO_INFORME_CINEMOMETROS_WEB_DGT.XLSX"

def leer_xlsx(url):
    data = urllib.request.urlopen(url, timeout=60).read()
    wb = load_workbook(io.BytesIO(data), data_only=True)
    sh = wb.active
    headers = [str(c.value).strip() if c.value is not None else "" for c in next(sh.iter_rows(min_row=1, max_row=1))]
    rows = []
    for r in sh.iter_rows(min_row=2):
        row = {headers[i]: ("" if r[i].value is None else str(r[i].value)) for i in range(len(headers))}
        rows.append(row)
    return rows

def filtrar_y_geojson(rows):
    feats=[]
    for r in rows:
        if r.get("Provincia","").strip().upper()!=PROVINCIA: 
            continue
        tipo = r.get("Tipo","").strip().upper()
        if "FIJO" not in tipo: 
            continue
        try:
            lat = float(str(r.get("Latitud","")).replace(",","."))
            lon = float(str(r.get("Longitud","")).replace(",","."))
        except:
            continue
        props = {
            "id": r.get("ID",""),
            "source":"DGT",
            "via": r.get("Vía",""),
            "pk_km": r.get("PK",""),
            "sentido": r.get("Sentido",""),
            "velocidad": r.get("Velocidad",""),
            "last_update": datetime.datetime.utcnow().isoformat()+"Z"
        }
        feats.append({"type":"Feature","geometry":{"type":"Point","coordinates":[lon,lat]},"properties":props})
    return {"type":"FeatureCollection","features":feats}

def main():
    rows = leer_xlsx(DGT_XLSX_URL)
    gj = filtrar_y_geojson(rows)
    Path("radars").mkdir(exist_ok=True)
    Path("radars/radares_fijos.geojson").write_text(json.dumps(gj, ensure_ascii=False))

if __name__=="__main__":
    main()
