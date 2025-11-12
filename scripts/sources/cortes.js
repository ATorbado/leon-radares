// scripts/sources/cortes.js
import fs from 'node:fs';
import path from 'node:path';
import { DateTime } from 'luxon';
// import fetch from 'node-fetch';

const TZ = 'Europe/Madrid';

// EJEMPLO A) leer de un JSON local generado por tus otros scripts
const LOCAL_FILE = path.join('closures', 'cortes_source.json');

// EJEMPLO B) consumir una URL (descomenta si tienes endpoint)
// const CORTES_URL = 'https://.../cortes_source.json';

function pickMonthList(items, now = DateTime.now().setZone(TZ)) {
  // Si tu fuente tiene campo mes 'YYYY-MM', filtramos el actual
  const ym = now.toFormat('yyyy-LL');
  return items.filter(x => (x.mes ?? '').startsWith(ym));
}

export async function getCortes(now) {
  // A) local
  if (fs.existsSync(LOCAL_FILE)) {
    const raw = JSON.parse(fs.readFileSync(LOCAL_FILE, 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.items ?? raw.cortes ?? []);
    return pickMonthList(list, now).map(mapItem);
  }

  // B) remoto
  // const r = await fetch(CORTES_URL);
  // const data = await r.json();
  // const list = Array.isArray(data) ? data : (data.items ?? data.cortes ?? []);
  // return pickMonthList(list, now).map(mapItem);

  return []; // si no hay fuente
}

function mapItem(x) {
  // adapta nombres de campos de tu fuente a los esperados por normalize()
  return {
    id: x.id ?? x.code,
    tipo: x.tipo ?? 'corte',
    descripcion: x.descripcion ?? x.motivo ?? '',
    lat: x.lat ?? x.latitude,
    lon: x.lon ?? x.longitude,
    desde: x.desde ?? x.start ?? null,
    hasta: x.hasta ?? x.end ?? null,
    // si tu fuente trae franja explícita, pásala aquí y se respetará
    franja: x.franja ?? null,
    oficial: true,
    organismo: x.organismo ?? 'DGT',
    fuente_url: x.fuente_url ?? x.url ?? null
  };
}
