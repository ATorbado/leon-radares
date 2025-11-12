import fs from 'node:fs';
import path from 'node:path';

const FILE = path.join('closures', 'calles_cortadas.geojson');

export async function getCortes() {
  if (!fs.existsSync(FILE)) return [];
  const gj = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const feats = Array.isArray(gj.features) ? gj.features : [];
  return feats.map(f => {
    const geom = f.geometry || {};
    // Soporta Point o LineString (toma primer vértice)
    let lat = null, lon = null;
    if (geom.type === 'Point') {
      [lon, lat] = geom.coordinates || [null, null];
    } else if (geom.type === 'LineString' && Array.isArray(geom.coordinates) && geom.coordinates.length) {
      [lon, lat] = geom.coordinates[0];
    }
    const p = f.properties || {};
    return {
      id: p.id ?? p.identificador ?? undefined,
      descripcion: p.descripcion ?? p.motivo ?? p.name ?? '',
      lat, lon,
      desde: p.desde ?? p.start ?? null,
      hasta: p.hasta ?? p.end ?? null,
      franja: p.franja ? String(p.franja).toLowerCase() : null, // si ya la traes del lector
      oficial: true,
      organismo: p.organismo ?? 'Conservación',
      fuente_url: p.fuente_url ?? null
    };
  }).filter(x => x.lat != null && x.lon != null);
}
