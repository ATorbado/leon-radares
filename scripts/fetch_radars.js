// scripts/fetch_radars.js
// Genera radars/today.geojson con las calles de León que tienen radar móvil hoy
// Fuente: PDF mensual del Ayuntamiento de León. Busca automáticamente el PDF
// del mes actual o de los últimos 12 meses con varias variantes de nombre.

import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";

// León capital aproximado: S, W, N, E
const BBOX_LEON = "42.56,-5.62,42.65,-5.50";

const MESES = [
  "enero","febrero","marzo","abril","mayo","junio",
  "julio","agosto","septiembre","octubre","noviembre","diciembre"
];

// Directorios donde suelen colgar los PDFs
const BASES = [
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/",
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias/"
];

// Variantes comunes del nombre del fichero
const VARIANTES = (mes, año) => [
  `Radares ${mes} ${año}.pdf`,
  `radares ${mes} ${año}.pdf`,
  `Radares móviles ${mes} ${año}.pdf`,
  `Radares movilidad ${mes} ${año}.pdf`,
  `Radares_${mes}_${año}.pdf`,
  `Radares ${mes}-${año}.pdf`
];

function hoyES() {
  const d = new Date(new Date().toLocaleString("en-GB", { timeZone: TZ }));
  return { d, day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
}

function mesesAtras(n) {
  const { d } = hoyES();
  const arr = [];
  for (let i = 0; i < n; i++) {
    const dt = new Date(Date.UTC(d.getFullYear(), d.getMonth() - i, 1));
    const mes = MESES[dt.getUTCMonth()];
    const año = dt.getUTCFullYear();
    arr.push({ mes, año });
  }
  return arr;
}

async function tryUrl(u) {
  try {
    // HEAD a veces bloqueado; prueba GET con Range para no descargar entero
    let r = await fetch(u, { method: "HEAD" });
    if (r.ok) return u;
    r = await fetch(u, { method: "GET", headers: { Range: "bytes=0-64" } });
    if (r.ok) return u;
  } catch {}
  return null;
}

async function downloadPDF() {
  const candidatos = [];
  for (const { mes, año } of mesesAtras(12)) {
    for (const base of BASES) {
      for (const fn of VARIANTES(mes, año)) {
        candidatos.push(base + encodeURIComponent(fn));
      }
    }
  }
  for (const url of candidatos) {
    const okUrl = await tryUrl(url);
    if (okUrl) {
      const r = await fetch(okUrl);
      if (r.ok) {
        console.log("PDF usado:", okUrl);
        return { bytes: new Uint8Array(await r.arrayBuffer()), url: okUrl };
      }
    }
  }
  throw new Error("No se pudo localizar ningún PDF de radares en los últimos 12 meses.");
}

async function pdfToText(uint8) {
  const doc = await pdfjs.getDocument({ data: uint8 }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str).join("\n") + "\n";
  }
  return text;
}

function norm(s) {
  return s
    .replace(/\b(avda?\.?|av\.)\b/gi, "Avenida")
    .replace(/\b(c\/|c\.\s?|calle)\b/gi, "Calle")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Extrae las vías del bloque del día indicado
function parseStreetsForDay(txt, day) {
  const reBlock = new RegExp(`\\n\\s*${day}\\s+[\\s\\S]*?(?=\\n\\s*${day + 1}\\s+|\\n\\s*\\d+\\s+|$)`, "i");
  const m = txt.match(reBlock);
  if (!m) return [];
  const block = m[0]
    .replace(/\b(mañana|tarde)\b/gi, "")
    .replace(/km\/h|velocidad.*?\n/gi, "")
    .replace(/[0-9]{1,3}\s*$/gm, "")
    .replace(/[0-9]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length && /^\d+\b/.test(lines[0])) lines.shift();

  const vias = [];
  for (const s of lines) {
    const v = norm(s).replace(/^\W+|\W+$/g, "");
    if (v && !vias.includes(v)) vias.push(v);
  }
  return vias;
}

async function overpassWaysForName(name) {
  const query = `
[out:json][timeout:25];
(
  way["name"="${name}"](${BBOX_LEON});
);
out geom;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(query)
  });
  if (!r.ok) return [];
  const j = await r.json();
  const lines = [];
  for (const e of j.elements || []) {
    if (e.type === "way" && Array.isArray(e.geometry)) {
      lines.push(e.geometry.map(p => [p.lon, p.lat]));
    }
  }
  return lines;
}

async function main() {
  const { day } = hoyES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  const { bytes } = await downloadPDF();
  const text = await pdfToText(bytes);
  const streets = parseStreetsForDay(text, day);

  console.log(`Calles detectadas para el día ${day}:`, streets);

  const features = [];
  for (const name of streets) {
    const mls = await overpassWaysForName(name);
    if (mls.length === 0) {
      console.log(`No mapeada en OSM: ${name}`);
      continue;
    }
    features.push({
      type: "Feature",
      properties: { nombre: name, fuente: "Ayto León" },
      geometry: mls.length === 1
        ? { type: "LineString", coordinates: mls[0] }
        : { type: "MultiLineString", coordinates: mls }
    });
    await new Promise(r => setTimeout(r, 600)); // cortesía Overpass
  }

  const fc = { type: "FeatureCollection", features };
  await fs.writeFile(OUT, JSON.stringify(fc, null, 2), "utf8");
  console.log(`Generado ${OUT} con ${features.length} calles`);
}

main().catch(async e => {
  console.error("ERROR:", e.message);
  const fc = { type: "FeatureCollection", features: [] };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fc, null, 2), "utf8");
});
