// scripts/build_feeds.js
import { DateTime } from 'luxon';
import fs from 'node:fs';
import path from 'node:path';
import { getCortes } from './sources/cortes.js';
import { getControles } from './sources/controles.js';

const TZ = 'Europe/Madrid';

function yyyymm(dt) {
  return dt.setZone(TZ).toFormat('yyyy-LL');
}

// Asigna franja a partir de desde/hasta (si ya viene franja en la fuente se respeta)
function computeFranja(item, refDate = DateTime.now().setZone(TZ)) {
  if (item.franja) return item.franja; // ya establecida
  const dIni = item.desde ? DateTime.fromISO(item.desde).setZone(TZ) : refDate.startOf('day');
  const dFin = item.hasta ? DateTime.fromISO(item.hasta).setZone(TZ) : refDate.endOf('day');

  // Rangos del día ref
  const manIni = refDate.set({ hour: 6, minute: 0, second: 0 });
  const manFin = refDate.set({ hour: 14, minute: 0, second: 0 });
  const tarIni = refDate.set({ hour: 14, minute: 0, second: 0 });
  const tarFin = refDate.set({ hour: 22, minute: 0, second: 0 });
  // noche es [22:00,24:00) U [00:00,06:00) del día sig.
  const nocIni1 = refDate.set({ hour: 22, minute: 0, second: 0 });
  const nocFin1 = refDate.endOf('day');
  const nocIni2 = refDate.plus({ days: 1 }).startOf('day');
  const nocFin2 = refDate.plus({ days: 1 }).set({ hour: 6, minute: 0, second: 0 });

  const solapa = (a1, a2, b1, b2) => a1 < b2 && b1 < a2;

  if (solapa(dIni, dFin, manIni, manFin)) return 'manana';
  if (solapa(dIni, dFin, tarIni, tarFin)) return 'tarde';
  if (solapa(dIni, dFin, nocIni1, nocFin1) || solapa(dIni, dFin, nocIni2, nocFin2)) return 'noche';
  // si no solapa con nada, por defecto 'manana' para evitar vacío
  return 'manana';
}

// Normaliza al esquema común de la app
function normalize(item) {
  return {
    id: String(item.id ?? cryptoRandomId()),
    tipo: String(item.tipo ?? 'corte').toLowerCase(), // corte|obra|accidente|control
    descripcion: String(item.descripcion ?? ''),
    lat: Number(item.lat),
    lon: Number(item.lon),
    desde: item.desde ?? null,
    hasta: item.hasta ?? null,
    franja: computeFranja(item),
    oficial: Boolean(item.oficial ?? false),
    organismo: item.organismo ?? null,
    fuente_url: item.fuente_url ?? item.fuenteUrl ?? null
  };
}

function cryptoRandomId() {
  return 'id_' + Math.random().toString(36).slice(2, 10);
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(p, data) {
  fs.writeFileSync(p, JSON.stringify(data, null, 2), 'utf8');
  console.log('Escrito', p, data.length, 'items');
}

async function main() {
  const now = DateTime.now().setZone(TZ);
  const ym = yyyymm(now);           // mes actual en Madrid
  const outMonthDir = path.join('radars', ym);
  const outLatestDir = path.join('radars', 'latest');
  ensureDir(outMonthDir);
  ensureDir(outLatestDir);

  // 1) Fuentes
  const cortesRaw = await getCortes(now);
  const controlesRaw = await getControles(now);

  // 2) Normaliza y añade franja
  const cortes = cortesRaw.map(normalize);
  const controles = controlesRaw.map(r => normalize({ ...r, tipo: 'control' }));

  // 3) Escribe mes
  writeJson(path.join(outMonthDir, 'cortes.json'), cortes);
  writeJson(path.join(outMonthDir, 'controles.json'), controles);

  // 4) Refresca latest (copia)
  writeJson(path.join(outLatestDir, 'cortes.json'), cortes);
  writeJson(path.join(outLatestDir, 'controles.json'), controles);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
