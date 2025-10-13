// scripts/fetch_radars.js
import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";
const BBOX_LEON = "42.56,-5.62,42.65,-5.50";
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

function hoyES() {
  const f = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ,
    year: "numeric",
    month: "numeric",
    day: "numeric",
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return {
    day: Number(parts.day),
    month: Number(parts.month),
    year: Number(parts.year),
  };
}

// --- 1) CRAWLER: busca PDFs de "Radares" en noticias recientes ---
const NEWS_PAGES = [
  "https://www.aytoleon.es/es/actualidad/noticias",
  // Páginas de listados típicos
  "https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx",
];
const HREF_RE = /href\s*=\s*"(.*?)"/gi;

async function listCandidateNewsPages() {
  // Intenta paginaciones simple: ?page=2..6 y /Paginas/default.aspx?Paged=TRUE
  const urls = new Set(NEWS_PAGES);
  for (let i = 2; i <= 8; i++) {
    urls.add(`https://www.aytoleon.es/es/actualidad/noticias?page=${i}`);
  }
  // Algunas noticias modernas usan ruta /es/actualidad/noticias/articulos/<slug>
  return [...urls];
}

function abs(base, href) {
  try {
    return new URL(href, base).toString();
  } catch { return null; }
}

async function fetchText(u) {
  const r = await fetch(u, { headers: { "User-Agent": "leon-radares/1.0" }});
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  return await r.text();
}

function extractLinks(html, base) {
  const out = [];
  let m;
  while ((m = HREF_RE.exec(html)) !== null) {
    const u = abs(base, m[1]);
    if (u) out.push(u);
  }
  return out;
}

function scoreByMonth(u, monthIdx, year) {
  // Prioriza PDFs que mencionen el mes/año actual
  const mes = MESES[monthIdx-1];
  const s = decodeURIComponent(u).toLowerCase();
  let score = 0;
  if (s.includes("radares")) score += 5;
  if (s.endsWith(".pdf")) score += 5;
  if (s.includes(mes)) score += 3;
  if (s.includes(String(year))) score += 2;
  return score;
}

async function discoverRadarPDF() {
  const { month, year } = hoyES();
  const pages = await listCandidateNewsPages();

  const pdfs = new Set();
  for (const p of pages) {
    try {
      const html = await fetchText(p);
      const links = extractLinks(html, p);
      // Mantén solo enlaces a artículos o PDFs
      for (const l of links) {
        if (l.toLowerCase().endsWith(".pdf") && /radares/i.test(l)) {
          pdfs.add(l);
        }
        // También entra a artículos y busca PDFs dentro
        if (/\/articulos\//i.test(l)) pdfs.add(l);
      }
    } catch {}
  }

  // Abre artículos y saca PDFs internos
  const more = [];
  for (const l of [...pdfs]) {
    if (!l.toLowerCase().endsWith(".pdf")) more.push(l);
  }
  for (const art of more.slice(0, 30)) { // limita 30 artículos
    try {
      const html = await fetchText(art);
      const links = extractLinks(html, art);
      for (const u of links) {
        if (u.toLowerCase().endsWith(".pdf") && /radares/i.test(u)) {
          pdfs.add(u);
        }
      }
    } catch {}
  }

  const ranked = [...pdfs]
    .filter(u => u.toLowerCase().endsWith(".pdf"))
    .map(u => ({ u, s: scoreByMonth(u, month, year) }))
    .sort((a,b) => b.s - a.s);

  if (ranked.length === 0) throw new Error("No se localizaron PDFs de radares en noticias.");
  const best = ranked[0].u;
  return best;
}

// --- 2) PDF → texto ---
async function pdfToTextFromUrl(url) {
  const r = await fetch(url, { headers: { "User-Agent": "leon-radares/1.0" }});
  if (!r.ok) throw new Error(`HTTP ${r.status} PDF`);
  const bytes = new Uint8Array(await r.arrayBuffer());
  const doc = await pdfjs.getDocument({ data: bytes }).promise;
  let text = "";
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const tc = await page.getTextContent();
    text += tc.items.map(it => it.str).join("\n") + "\n";
  }
  return text;
}

// --- 3) Parseo del día ---
function norm(s) {
  return s
    .replace(/\b(avda?\.?|av\.)\b/gi, "Avenida")
    .replace(/\b(c\/|c\.\s?|calle)\b/gi, "Calle")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseStreetsForDay(txt, day) {
  // Busca una tabla por día; tolera columnas
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

// --- 4) Overpass para cada vía ---
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

// --- 5) Main ---
async function main() {
  const { day } = hoyES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  const pdfUrl = await discoverRadarPDF();
  console.log("PDF usado:", pdfUrl);

  const text = await pdfToTextFromUrl(pdfUrl);
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
    await new Promise(r => setTimeout(r, 600));
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
