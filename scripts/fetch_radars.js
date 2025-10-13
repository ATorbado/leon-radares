import fs from "node:fs/promises";
import path from "node:path";
import pdfParse from "pdf-parse";
import { fetch } from "undici";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";

function todayES() {
  const d = new Date(new Date().toLocaleString("en-GB", { timeZone: TZ }));
  const day = d.getDate();
  const month = d.getMonth() + 1;
  const year = d.getFullYear();
  return { day, month, year };
}

// URLs de ejemplo; amplía cada mes o añade crawler más adelante
const PDF_CANDIDATES = [
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/Radares%20octubre%202025.pdf",
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/Radares%20septiembre%202025.pdf"
];

async function downloadFirstWorking(urls) {
  for (const u of urls) {
    const r = await fetch(u);
    if (r.ok) return new Uint8Array(await r.arrayBuffer());
  }
  throw new Error("No se pudo descargar el PDF mensual.");
}

function parseStreetsForDay(txt, day) {
  const reBlock = new RegExp(`\\n${day}\\s+[\\s\\S]*?(?=\\n${day + 1}\\s+|\\n\\d+\\s+|$)`, "g");
  const m = txt.match(reBlock);
  if (!m) return [];
  const block = m[0];
  const cleaned = block
    .replace(/\b(mañana|tarde)\b/gi, "")
    .replace(/\b(Km\/h|km\/h|Velocidad.*?\n)/gi, "")
    .replace(/[0-9]{1,3}\s*$/gm, "")
    .replace(/[0-9]+/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
  if (lines.length && /^\d+\b/.test(lines[0])) lines.shift();
  const asWords = lines.join("\n").split(/\n/).map(s => s.trim()).filter(Boolean);

  const vias = [];
  for (const s of asWords) {
    const v = s.replace(/\s{2,}/g, " ").replace(/^\W+|\W+$/g, "");
    if (!v) continue;
    if (!vias.includes(v)) vias.push(v);
  }
  return vias;
}

async function overpassWaysForName(name) {
  const bbox = "42.56,-5.62,42.65,-5.50"; // León aprox (S,W,N,E)
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
  const { text } = await pdfParse(pdfBytes);
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
    await new Promise(r => setTimeout(r, 600)); // cortesía Overpass
  }

  const fc = { type: "FeatureCollection", features };
  await fs.writeFile(OUT, JSON.stringify(fc, null, 2), "utf8");
  console.log(`Generado ${OUT} con ${features.length} calles`);
}

main().catch(async (e) => {
  console.error(e);
  const fc = { type: "FeatureCollection", features: [] };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fc), "utf8");
  process.exit(0); // no falla el workflow
});
