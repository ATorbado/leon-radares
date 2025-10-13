import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";

const PDF_CANDIDATES = [
  // Oficial septiembre 2025 (verificado)
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/Radares%20septiembre%202025.pdf"
  // Añade aquí octubre cuando el Ayuntamiento publique el PDF del mes.
];

function todayES() {
  const d = new Date(new Date().toLocaleString("en-GB", { timeZone: TZ }));
  return { day: d.getDate(), month: d.getMonth() + 1, year: d.getFullYear() };
}

async function downloadFirstWorking(urls) {
  for (const u of urls) {
    const r = await fetch(u);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("No se pudo descargar el PDF mensual.");
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

// Heurística sencilla: extrae bloque del día actual y lista de vías únicas.
function parseStreetsForDay(txt, day) {
  const reBlock = new RegExp(`\\n${day}\\s+[\\s\\S]*?(?=\\n${day + 1}\\s+|\\n\\d+\\s+|$)`, "i");
  const m = txt.match(reBlock);
  if (!m) return [];
  const block = m[0]
    .replace(/\b(mañana|tarde)\b/gi, "")
    .replace(/\b(km\/h|velocidad.*?\n)\b/gi, "")
    .replace(/[0-9]{1,3}\s*$/gm, "")
    .replace(/[0-9]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const lines = block.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length && /^\d+\b/.test(lines[0])) lines.shift();

  const vias = [];
  for (const s of lines) {
    const v = s.replace(/^\W+|\W+$/g, "");
    if (v && !vias.includes(v)) vias.push(v);
  }
  return vias;
}

async function overpassWaysForName(name) {
  const bbox = "42.56,-5.62,42.65,-5.50"; // S,W,N,E León capital aprox
  const query = `
[out:json][timeout:25];
(
  way["name"="${name}"](${bbox});
);
out geom;
`;
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
  const { day } = todayES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  const pdfBytes = await downloadFirstWorking(PDF_CANDIDATES);
  const text = await pdfToText(pdfBytes);
  const streets = parseStreetsForDay(text, day);

  const features = [];
  for (const name of streets) {
    const mls = await overpassWaysForName(name);
    if (mls.length === 0) continue;
    features.push({
      type: "Feature",
      properties: { nombre: name, fuente: "Ayto León PDF mensual" },
      geometry: mls.length === 1
        ? { type: "LineString", coordinates: mls[0] }
        : { type: "MultiLineString", coordinates: mls }
    });
    await new Promise(r => setTimeout(r, 600));
  }

  const fc = { type: "FeatureCollection", features };
  await fs.writeFile(OUT, JSON.stringify(fc, null, 2), "utf8");
  console.log(`Generado ${OUT} con ${features.length} calles`);
}

main().catch(async e => {
  console.error(e);
  const fc = { type: "FeatureCollection", features: [] };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fc), "utf8");
});
