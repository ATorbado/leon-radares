import fs from 'node:fs';
import path from 'node:path';

const MANUAL = path.join('radars', 'manual', 'controles_oficiales.json');

function ensureFile() {
  const dir = path.dirname(MANUAL);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(MANUAL)) fs.writeFileSync(MANUAL, '[]', 'utf8');
}

export async function getControles() {
  ensureFile();
  const arr = JSON.parse(fs.readFileSync(MANUAL, 'utf8'));
  return Array.isArray(arr) ? arr : [];
}

// Estructura sugerida para radars/manual/controles_oficiales.json:
// [
//   {
//     "id": "c-001",
//     "descripcion": "Control nocturno AV. Ordoño II",
//     "lat": 42.5986,
//     "lon": -5.5671,
//     "desde": "2025-11-13T22:30:00+01:00",
//     "hasta": "2025-11-14T01:30:00+01:00",
//     "franja": "noche",
//     "oficial": true,
//     "organismo": "Policía Local León",
//     "fuente_url": "https://...nota-prensa..."
//   }
// ]
