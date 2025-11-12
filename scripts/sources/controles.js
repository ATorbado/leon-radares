// scripts/sources/controles.js
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';

const TZ = 'Europe/Madrid';

// Fichero manual para controles oficiales verificados (edítalo tú)
const MANUAL_OFICIALES = path.join('radars', 'manual', 'controles_oficiales.json');
// Estructura esperada de cada elemento:
// { id, descripcion, lat, lon, desde, hasta, franja: "manana|tarde|noche", organismo: "Policía Local León", fuente_url }

function ensureManualFile() {
  const dir = path.dirname(MANUAL_OFICIALES);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(MANUAL_OFICIALES)) fs.writeFileSync(MANUAL_OFICIALES, '[]');
}

function pickMonthList(items, now = DateTime.now().setZone(TZ)) {
  // si traen fechas desde/hasta, acepta aquellos que solapen con el mes actual
  const mesIni = now.startOf('month');
  const mesFin = now.endOf('month');
  const within = (d1, d2) => (d1 < mesFin) && (mesIni < d2);
  return items.filter(x => {
    const di = x.desde ? DateTime.fromISO(x.desde).setZone(TZ) : mesIni;
    const df = x.hasta ? DateTime.fromISO(x.hasta).setZone(TZ) : mesFin;
    return within(di, df);
  });
}

export async function getControles(now) {
  ensureManualFile();
  const manual = JSON.parse(fs.readFileSync(MANUAL_OFICIALES, 'utf8'));

  // Aquí podrías añadir otras fuentes (por ejemplo RSS/notas de prensa de un ayto)
  // y mapearlas a la misma estructura antes de concatenar.
  // const municipales = await fetchMunicipales();

  const list = [].concat(manual /*, municipales*/);
  return pickMonthList(list, now).map(mapItemOficial);
}

function mapItemOficial(x) {
  return {
    id: x.id,
    tipo: 'control',
    descripcion: x.descripcion ?? '',
    lat: x.lat,
    lon: x.lon,
    desde: x.desde ?? null,
    hasta: x.hasta ?? null,
    franja: x.franja ?? null, // si lo rellenas aquí, la app lo respeta
    oficial: true,
    organismo: x.organismo ?? 'Policía Local',
    fuente_url: x.fuente_url ?? null
  };
}
