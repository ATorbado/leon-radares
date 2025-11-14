import json
import urllib.request
import math
from pathlib import Path

# Centro de León (Plaza Santo Domingo aprox)
LEON_LAT = 42.598726
LEON_LON = -5.567095

# Radio a cubrir (en km)
RADIUS_KM = 12   # cubre León + Trobajo + San Andrés + Navatejera + Villaquilambre

URL = "https://infocar.dgt.es/etraffic/data/radars.json"

def haversine(lat1, lon1, lat2, lon2):
    R = 6371
    dLat = math.radians(lat2-lat1)
    dLon = math.radians(lon2-lon1)
    a = math.sin(dLat/2)**2 + math.cos(math.radians(lat1)) * math.cos(math.radians(lat2)) * math.sin(dLon/2)**2
    return 2*R*math.asin(math.sqrt(a))

def main():
    print("Descargando lista completa de radares DGT…")
    data = urllib.request.urlopen(URL, timeout=30).read().decode("utf-8")
    radars = json.loads(data)["features"]

    out = []

    for r in radars:
        props = r.get("properties", {})
        geom = r.get("geometry", {})

        tipo = props.get("tipo", "").upper()
        if "FIJO" not in tipo:
            continue

        coords = geom.get("coordinates")
        if not coords or len(coords) < 2:
            continue

        lon, lat = coords[0], coords[1]
        dist = haversine(LEON_LAT, LEON_LON, lat, lon)

        if dist <= RADIUS_KM:
            descripcion = props.get("descripcion", "").strip()

            out.append({
                "calle": descripcion,
                "lat": lat,
                "lon": lon,
                "tipo": "Fijo",
                "dist_km_leon": round(dist, 2)
            })

    Path("radars").mkdir(exist_ok=True)
    Path("radars/radares_fijos_urbanos_leon.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2)
    )

    print(f"Generado radars/radares_fijos_urbanos_leon.json con {len(out)} radares")


if __name__ == "__main__":
    main()
