// scripts/fetch_radars.js
// Genera radars/today.geojson (calles de León con radar móvil HOY)
// 1) Rastrea la web del Ayto para hallar el PDF de "Radares"
// 2) Extrae el bloque del día (mañana/tarde) y las vías
// 3) Busca cada vía en OSM (Overpass) y crea GeoJSON

import fs from "node:fs/promises";
import path from "node:path";
import { fetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const TZ = "Europe/Madrid";
const BBOX_LEON = "42.56,-5.62,42.65,-5.50"; // S,W,N,E aprox León capital

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];

// ---------- fecha local ES (sin reparsear strings) ----------
function hoyES() {
  const f = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { day: Number(parts.day), month: Number(parts.month), year: Number(parts.year) };
}

// ---------- utilidades HTML ----------
const NEWS_PAGES = [
  "https://www.aytoleon.es/es/actualidad/noticias",
  "https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx",
];
const HREF_RE = /href\s*=\s*"(.*?)"/gi;

async function fetchText(u) {
  const r = await fetch(u, { headers: { "User-Agent": "leon-radares/1.0" }});
  if (!r.ok) throw new Error(`HTTP ${r.status} ${u}`);
  return await r.text();
}
function abs(base, href) {
  try { return new URL(href, base).toString(); } catch { return null; }
}
function extractLinks(html, base) {
  const out = []; let m;
  while ((m = HREF_RE.exec(html)) !== null) {
    const u = abs(base, m[1]); if (u) out.push(u);
  }
  return out;
}
function scoreByMonth(u, monthIdx, year) {
  const mes = MESES[monthIdx-1];
  const s = decodeURIComponent(u).toLowerCase();
  let score = 0;
  if (s.includes("radares")) score += 5;
  if (s.endsWith(".pdf")) score += 5;
  if (s.includes(mes)) score += 3;
  if (s.includes(String(year))) score += 2;
  return score;
}

// ---------- 1) Descubrir PDF de "Radares" ----------
async function discoverRadarPDF() {
  const { month, year } = hoyES();
  const pages = new Set(NEWS_PAGES);
  for (let i = 2; i <= 8; i++) pages.add(`https://www.aytoleon.es/es/actualidad/noticias?page=${i}`);

  const pdfs = new Set();
  for (const p of pages) {
    try {
      const html = await fetchText(p);
      for (const l of extractLinks(html, p)) {
        if (l.toLowerCase().endsWith(".pdf") && /radares/i.test(l)) pdfs.add(l);
        if (/\/articulos\//i.test(l)) pdfs.add(l); // abrir artículos luego
      }
    } catch {}
  }

  const artLinks = [...pdfs].filter(l => !l.toLowerCase().endsWith(".pdf")).slice(0, 30);
  for (const art of artLinks) {
    try {
      const html = await fetchText(art);
      for (const u of extractLinks(html, art)) {
        if (u.toLowerCase().endsWith(".pdf") && /radares/i.test(u)) pdfs.add(u);
      }
    } catch {}
  }

  const ranked = [...pdfs]
    .filter(u => u.toLowerCase().endsWith(".pdf"))
    .map(u => ({ u, s: scoreByMonth(u, month, year) }))
    .sort((a,b) => b.s - a.s);

  if (!ranked.length) throw new Error("No se localizaron PDFs de radares en noticias.");
  return ranked[0].u;
}

// ---------- 2) PDF → texto ----------
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

// ---------- 3) Parseo del bloque del día ----------
function parseStreetsForDay(txt, day) {
  // Empieza en: ^día (mañana|tarde). Termina en: ^otro día (mañana|tarde) o fin.
  const reBlock = new RegExp(
    String.raw`(^|\n)\s*${day}\s+(mañana|tarde)[\s\S]*?(?=(^|\n)\s*(?:[1-9]|[12]\d|3[01])\s+(mañana|tarde)|$)`,
    "i"
  );
  const m = txt.match(reBlock);
  if (!m) return [];

  const block = m[0];
  const cleaned = block
    .replace(/\bGABINETE DE COMUNICACIÓN\b/gi, "")
    .replace(/\b(mañana|tarde)\b/gi, "")
    .replace(/km\/h|velocidad.*?(\n|$)/gim, " ")
    .replace(/(\s|^)(20|30|40|50|60|70|80|90|100)(\s|$)/g, " ") // velocidades sueltas
    .replace(/[0-9]{1,3}\s*$/gm, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);

  const norm = s => s
    .replace(/\./g, " ")
    .replace(/\b(avda?\.?|av\.)\b/gi, "Avenida")
    .replace(/\b(c\/|c\.\s?|calle)\b/gi, "Calle")
    .replace(/\b(de la|de los|de las|de|del)\b/gi, m => m.toLowerCase())
    .replace(/^\W+|\W+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const vias = [];
  for (const raw of lines) {
    if (/^(?:día|turno|\W*)$/i.test(raw)) continue;
    const v = norm(raw);
    if (v && !vias.includes(v)) vias.push(v);
  }
  return vias;
}

// ---------- 4) Overpass: buscar la vía (con variantes) ----------
async function overpassWaysForName(name) {
  // 1) Normaliza: quita puntos, duplica espacios, expande Avda.
  const base = name
    .replace(/\./g, " ")
    .replace(/\b(avda?\.?|av)\b/gi, "Avenida")
    .replace(/\s{2,}/g, " ")
    .trim();

  // 2) Construye variantes con prefijos frecuentes
  const variants = new Set([
    base,
    /^calle\s/i.test(base) ? base : "Calle " + base,
    /^avenida\s/i.test(base) ? base : "Avenida " + base,
    /^paseo\s/i.test(base) ? base : "Paseo " + base,
    /^plaza\s/i.test(base) ? base : "Plaza " + base,
    /^glorieta\s/i.test(base) ? base : "Glorieta " + base,
  ]);

  // 3) Utilidad: crear regex tolerante (case-insensitive, espacios flexibles, acentos opcionales)
  const accentClass = (c) => {
    const map = { a: "[aáà]", e: "[eéè]", i: "[iíì]", o: "[oóò]", u: "[uúùü]" };
    const lower = c.toLowerCase();
    return map[lower] ? map[lower] : c.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  };
  const toRegex = (s) => {
    // Palabras → .* entre ellas (permite abreviaturas tipo "José M Suárez")
    const tokens = s.split(/\s+/).filter(Boolean);
    const pattern = tokens.map(t => t.split("").map(accentClass).join("")).join(".*");
    return `(?i)^.*${pattern}.*$`;
  };

  // 4) Prueba primero coincidencia exacta; luego regex amplio
  const BBOX = "42.56,-5.62,42.65,-5.50";
  const tryQuery = async (filter) => {
    const q = `
[out:json][timeout:25];
way["name"${filter}](${BBOX});
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
      if (e.type === "way" && Array.isArray(e.geometry)) {
        lines.push(e.geometry.map(p => [p.lon, p.lat]));
      }
    }
    return lines;
  };

  // 4a) exactas
  for (const v of variants) {
    const lines = await tryQuery(`="${v}"`);
    if (lines.length) return lines;
  }
  // 4b) regex tolerante
  for (const v of variants) {
    const rx = toRegex(v);
    const lines = await tryQuery(`~"${rx}"`);
    if (lines.length) return lines;
  }
  return [];
}


// ---------- 5) Main ----------
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
    // cortesía Overpass (evitar rate limit)
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
