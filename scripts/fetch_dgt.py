# scripts/fetch_dgt.py
import csv, json, io, zipfile, urllib.request, datetime
from pathlib import Path

DGT_URL = "https://www.dgt.es/conoce-el-estado-del-trafico/vigilancia-y-control/equipos-y-tramos-de-vigilancia/"  # página índice
PROVINCIA = "LEÓN"  # mayúsculas como en el fichero de DGT

def descargar_csv_dgt():
    # Nota: en la página hay enlace directo al fichero “Puntos y tramos de control de velocidad”.
    # Aquí asumimos un CSV/ZIP; si fuera XLSX, se parsea con openpyxl.
    # Deja este stub; en el Action usaremos el enlace directo actualizado.
    raise NotImplementedError("Rellena con la URL directa al CSV/XLSX del apartado Puntos y tramos de control de velocidad")

def filtrar_y_geojson(rows):
    feats=[]
    for r in rows:
        # adapta a nombres reales de columnas: Provincia, Tipo, Latitud, Longitud, Vía, PK, Sentido, Velocidad
        if r.get("Provincia","").strip().upper()!="LEÓN": 
            continue
        if r.get("Tipo","").strip().upper() not in ("FIJO","TRAMO FIJO"):
            continue
        try:
            lat=float(r["Latitud"].replace(",",".")); lon=float(r["Longitud"].replace(",","."))
        except:
            continue
        props={
            "id": r.get("ID") or f'{r.get("Vía","")}-{r.get("PK","")}-{r.get("Sentido","")}',
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
    # Sustituye por lectura real del CSV/XLSX
    pass

if __name__=="__main__":
    main()
