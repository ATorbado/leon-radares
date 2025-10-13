import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function hoyES() {
  const d = new Date(new Date().toLocaleString("en-GB", { timeZone: TZ }));
  return { d, day: d.getDate(), month: d.getMonth()+1, year: d.getFullYear() };
}

// Intenta construir URLs con patrón oficial: "Radares <mes> <año>.pdf"
// Prueba: mes actual y mes anterior.
function candidatesFor(month, year) {
  const mes = MESES[month-1];
  const base = "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/";
  const file = `Radares ${mes} ${year}.pdf`;
  return [ base + encodeURIComponent(file) ];
}

async function downloadPDF() {
  const { month, year } = hoyES();
  const cand = [
    ...candidatesFor(month, year),
    ...candidatesFor(((month+10)%12)+1, month===1?year-1:year) // mes anterior
  ];
  for (const url of cand) {
    const r = await fetch(url);
    if (r.ok) return { bytes: new Uint8Array(await r.arrayBuffer()), url };
  }
  throw new Error("No se pudo descargar el PDF del mes actual/anterior.");
}

async function pdfToText(uint8) {
  const doc = await pdfjs.getDocument({ data: uint8 }).promise;
  let text = "";
  for (let i=1;i<=doc.numPages;i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str).join("\n") + "\n";
  }
  return text;
}

function norm(s) {
  return s
    .replace(/\b(avda?\.?|av\.)\b/gi,"Avenida")
    .replace(/\b(c\/|c\.\s?|calle)\b/gi,"Calle")
    .replace(/\s{2,}/g," ")
    .trim();
}

// Extrae el bloque del día y saca una vía por línea.
function parseStreetsForDay(txt, day) {
  // Variantes: "13", "13 ", "13\t"
  const reBlock = new RegExp(`\\n\\s*${day}\\s+[\\s\\S]*?(?=\\n\\s*${day+1}\\s+|\\n\\s*\\d+\\s+|$)`, "i");
  const m = txt.match(reBlock);
  if (!m) return [];
  const block = m[0]
    .replace(/\b(mañana|tarde)\b/gi,"")
    .replace(/km\/h|velocidad.*?\n/gi,"")
    .replace(/[0-9]{1,3}\s*$/gm,"")
    .replace(/[0-9]+/g," ")
    .replace(/\s{2,}/g," ")
    .trim();

  const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length && /^\d+\b/.test(lines[0])) lines.shift();

  const vias = [];
  for (const s of lines) {
    const v = norm(s).replace(/^\W+|\W+$/g,"");
    if (v && !vias.includes(v)) vias.push(v);
  }
  return vias;
}

async function overpassWaysForName(name) {
  const bbox = "42.56,-5.62,42.65,-5.50"; // León capital aprox (S,W,N,E)
  const q = `
[out:json][timeout:25];
(
  way["name"="${name}"](${bbox});
);
out geom;`;
  const r = await fetch("https://overpass-api.de/api/interpreter", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
    body: "data=" + encodeURIComponent(q)
  });
  if (!r.ok) return [];
  const j = await r.json();
  const lines = [];
  for (const e of j.elements || []) {
    if (e.type==="way" && Array.isArray(e.geometry)) {
      lines.push(e.geometry.map(p => [p.lon, p.lat]));
    }
  }
  return lines;
}

async function main() {
  const { day } = hoyES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  const { bytes, url } = await downloadPDF();
  const text = await pdfToText(bytes);
  const streets = parseStreetsForDay(text, day);
  console.log(`PDF usado: ${url}`);
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
      geometry: mls.length===1
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
  await fs.writeFile(OUT, JSON.stringify(fc), "utf8");
});
