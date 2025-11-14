import json
import math
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

# Centro aproximado de León (Plaza Santo Domingo)
LEON_LAT = 42.598726
LEON_LON = -5.567095

# Radio en km para considerar "León y alrededores"
RADIUS_KM = 12

# Endpoint oficial DATEX2 de radares fijos DGT
DGT_DATEX_URL = (
    "http://infocar.dgt.es/datex2/dgt/PredefinedLocationsPublication/radares/content.xml"
)


def haversine(lat1, lon1, lat2, lon2):
    R = 6371.0
    dlat = math.radians(lat2 - lat1)
    dlon = math.radians(lon2 - lon1)
    a = (
        math.sin(dlat / 2) ** 2
        + math.cos(math.radians(lat1))
        * math.cos(math.radians(lat2))
        * math.sin(dlon / 2) ** 2
    )
    c = 2 * math.asin(math.sqrt(a))
    return R * c


def main():
    print("Descargando radares fijos DGT (DATEX2)…")

    try:
        with urllib.request.urlopen(DGT_DATEX_URL, timeout=60) as resp:
            data = resp.read()
    except Exception as e:
        print("No se ha podido descargar el XML de radares DGT:", e)
        # No queremos que falle el workflow: dejamos archivo vacío
        Path("radars").mkdir(exist_ok=True)
        Path("radars/radares_fijos_urbanos_leon.json").write_text(
            "[]", encoding="utf-8"
        )
        return

    try:
        root = ET.fromstring(data)
    except Exception as e:
        print("Error parseando XML de radares DGT:", e)
        Path("radars").mkdir(exist_ok=True)
        Path("radars/radares_fijos_urbanos_leon.json").write_text(
            "[]", encoding="utf-8"
        )
        return

    out = []

    # DATEX2 usa namespaces; los ignoramos comparando por sufijo del tag
    def tag_endswith(elem, suffix):
        return elem.tag.endswith("}" + suffix) or elem.tag == suffix

    # Buscar todos los predefinedLocation
    for pl in root.iter():
        if not tag_endswith(pl, "predefinedLocation"):
            continue

        desc = ""
        lat = None
        lon = None

        # Intentar obtener un nombre / descripción
        for child in pl.iter():
            # Nombre de la localización (puede variar según versión de DATEX2)
            if tag_endswith(child, "predefinedLocationName") or tag_endswith(
                child, "name"
            ):
                if child.text:
                    desc = child.text.strip()

            # Coordenadas (normalmente bajo locationForDisplay, coordinates, etc.)
            if tag_endswith(child, "latitude"):
                try:
                    lat = float(child.text.replace(",", "."))
                except Exception:
                    pass
            if tag_endswith(child, "longitude"):
                try:
                    lon = float(child.text.replace(",", "."))
                except Exception:
                    pass

        # Si no hay lat/lon no podemos filtrar por radio
        if lat is None or lon is None:
            continue

        dist = haversine(LEON_LAT, LEON_LON, lat, lon)
        if dist > RADIUS_KM:
            continue

        out.append(
            {
                "calle": desc,
                "lat": lat,
                "lon": lon,
                "tipo": "Fijo",
                "dist_km_leon": round(dist, 2),
            }
        )

    Path("radars").mkdir(exist_ok=True)
    Path("radars/radares_fijos_urbanos_leon.json").write_text(
        json.dumps(out, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    print(
        f"Generado radars/radares_fijos_urbanos_leon.json con {len(out)} radares en radio {RADIUS_KM} km"
    )


if __name__ == "__main__":
    main()
