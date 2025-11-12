import { DateTime } from 'luxon';
import fs from 'node:fs';
import path from 'node:path';
import { getCortes } from './sources/cortes.js';
import { getControles } from './sources/controles.js';

const TZ = 'Europe/Madrid';

function yyyymm(dt) { return dt.setZone(TZ).toFormat('yyyy-LL'); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, data) { fs.writeFileSync(p, JSON.stringify(data, null, 2)); console.log('Escrito', p, data.length); }
const overlap = (a1,a2,b1,b2) => a1 < b2 && b1 < a2;

// Mañana 06–14, Tarde 14–22, Noche 22–06
function computeFranja(item, ref = DateTime.now().setZone(TZ)) {
  if (item.franja) return String(item.franja).toLowerCase();
  const d1 = item.desde ? DateTime.fromISO(item.desde).setZone(TZ) : ref.startOf('day');
  const d2 = item.hasta ? DateTime.fromISO(item.hasta).setZone(TZ) : ref.endOf('day');

  const man1 = ref.set({hour:6,minute:0,second:0});
  const man2 = ref.set({hour:14,minute:0,second:0});
  const tar1 = ref.set({hour:14,minute:0,second:0});
  const tar2 = ref.set({hour:22,minute:0,second:0});
  const noc1 = ref.set({hour:22,minute:0,second:0});
  const noc2 = ref.endOf('day');
  const noc3 = ref.plus({days:1}).startOf('day');
  const noc4 = ref.plus({days:1}).set({hour:6,minute:0,second:0});

  if (overlap(d1,d2,man1,man2)) return 'manana';
  if (overlap(d1,d2,tar1,tar2)) return 'tarde';
  if (overlap(d1,d2,noc1,noc2) || overlap(d1,d2,noc3,noc4)) return 'noche';
  return 'manana';
}

function normalize(x, forceTipo) {
  return {
    id: String(x.id ?? Math.random().toString(36).slice(2,10)),
    tipo: String(forceTipo ?? x.tipo ?? 'corte').toLowerCase(),
    descripcion: String(x.descripcion ?? x.motivo ?? ''),
    lat: Number(x.lat ?? x.latitude),
    lon: Number(x.lon ?? x.longitude),
    desde: x.desde ?? x.start ?? null,
    hasta: x.hasta ?? x.end ?? null,
    franja: computeFranja(x),
    oficial: Boolean(x.oficial ?? false),
    organismo: x.organismo ?? null,
    fuente_url: x.fuente_url ?? x.fuenteUrl ?? x.url ?? null
  };
}

async function main() {
  const now = DateTime.now().setZone(TZ);
  const ym = yyyymm(now);
  const outMonth = path.join('radars', ym);
  const outLatest = path.join('radars', 'latest');
  ensureDir(outMonth); ensureDir(outLatest);

  // Usa tus lectores existentes
  const cortesSrc = await getCortes(now);
  const controlesSrc = await getControles(now);

  const cortes = cortesSrc.map(r => normalize(r, 'corte'));
  const controles = controlesSrc.map(r => normalize(r, 'control'));

  writeJson(path.join(outMonth, 'cortes.json'), cortes);
  writeJson(path.join(outMonth, 'controles.json'), controles);

  writeJson(path.join(outLatest, 'cortes.json'), cortes);
  writeJson(path.join(outLatest, 'controles.json'), controles);
}

main().catch(e => { console.error(e); process.exit(1); });
