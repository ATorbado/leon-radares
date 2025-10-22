// scripts/fetch_radars.js
// Genera radars/today.geojson (calles de León con radar móvil HOY)

import fs from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const LAST_PDF = path.join(process.cwd(), "radars", "latest_pdf.txt");
const TZ = "Europe/Madrid";
const BBOX_LEON = "42.56,-5.62,42.65,-5.50"; // S,W,N,E aprox

const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const USER_AGENT = "leon-radares/1.1 (+github actions)";

// ---------- util HTTP con reintentos ----------
async function fetch(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await undiciFetch(url, {
        headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
        ...opts,
      });
      if (r.ok) return r;
    } catch {}
    await new Promise(r => setTimeout(r, 600 + i * 400));
  }
  throw new Error(`HTTP fail: ${url}`);
}

// ---------- fecha local ES ----------
function hoyES() {
  const f = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { day: Number(parts.day), month: Number(parts.month), year: Number(parts.year) };
}

// ---------- crawler noticias Ayto ----------
const NEWS_PAGES = [
  "https://www.aytoleon.es/es/actualidad/noticias",
  "https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx",
];
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return null; } }

// acepta href="...", href='...', data-href, data-src
const LINK_RE = /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;

async function listCandidatePages() {
  const urls = new Set(NEWS_PAGES);
  // más paginación
  for (let i = 2; i <= 12; i++) urls.add(`https://www.aytoleon.es/es/actualidad/noticias?page=${i}`);
  // variantes SharePoint
  for (let i = 2; i <= 12; i++) urls.add(`https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx?Page=${i}`);
  return [...urls];
}

async function extractLinksFrom(url) {
  const html = await (await fetch(url)).text();
  const out = [];
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(url, m[3]);
    if (u) out.push(u);
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

async function discoverRadarPDFViaCrawler() {
  const { month, year } = hoyES();
  const pages = await listCandidatePages();

  const seen = new Set();
  const pdfs = new Set();

  // 1) rastrea listados
  for (const p of pages) {
    try {
      const links = await extractLinksFrom(p);
      for (const l of links) {
        if (seen.has(l)) continue;
        seen.add(l);
        if (l.toLowerCase().endsWith(".pdf") && /radares/i.test(l)) pdfs.add(l);
        if (/\/articulos\//i.test(l)) pdfs.add(l); // visitar artículos
      }
      if (pdfs.size > 80) break;
    } catch {}
  }

  // 2) abre artículos y saca PDFs internos
  const articles = [...pdfs].filter(u => !u.toLowerCase().endsWith(".pdf")).slice(0, 60);
  for (const art of articles) {
    try {
      const links = await extractLinksFrom(art);
      for (const u of links) {
        if (u.toLowerCase().endsWith(".pdf") && /radares/i.test(u)) pdfs.add(u);
      }
    } catch {}
  }

  const ranked = [...pdfs]
    .filter(u => u.toLowerCase().endsWith(".pdf"))
    .map(u => ({ u, s: scoreByMonth(u, month, year) }))
    .sort((a,b) => b.s - a.s);

  if (!ranked.length) throw new Error("No PDFs en crawler.");
  return ranked[0].u;
}

// ---------- fallback por patrones últimos 12 meses ----------
const BASES = [
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/",
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias/",
];
const VARIANTES = (mes, año) => [
  `Radares ${mes} ${año}.pdf`,
  `Radares mes de ${mes} de ${año}.pdf`,
  `Radares móviles ${mes} ${año}.pdf`,
  `Radares movilidad ${mes} ${año}.pdf`,
  `Radares_${mes}_${año}.pdf`,
  `Radares ${mes}-${año}.pdf`,
];

function mesesAtras(n) {
  const { month, year } = hoyES();
  const arr = [];
  let m = month, y = year;
  for (let i = 0; i < n; i++) {
    const mes = MESES[m-1];
    arr.push({ mes, año: y });
    m--; if (m === 0) { m = 12; y--; }
  }
  return arr;
}

async function tryHeadOrRange(u) {
  try {
    let r = await fetch(u, { method: "HEAD" });
    if (r.ok) return true;
    r = await fetch(u, { method: "GET", headers: { Range: "bytes=0-64" } });
    return r.ok;
  } catch { return false; }
}

async function discoverRadarPDFFallback() {
  const candidatos = [];
  for (const { mes, año } of mesesAtras(12)) {
    for (const base of BASES) {
      for (const fn of VARIANTES(mes, año)) {
        candidatos.push(base + encodeURIComponent(fn));
      }
    }
  }
  for (const url of candidatos) {
    if (await tryHeadOrRange(url)) return url;
  }
  throw new Error("Sin PDF por patrones.");
}

// ---------- caché del último PDF válido ----------
async function readCachedPDF() {
  try {
    const s = await fs.readFile(LAST_PDF, "utf8");
    return s.trim();
  } catch { return null; }
}
async function writeCachedPDF(url) {
  await fs.mkdir(path.dirname(LAST_PDF), { recursive: true });
  await fs.writeFile(LAST_PDF, url, "utf8");
}

// ---------- PDF → texto ----------
async function pdfToTextFromUrl(url) {
  const r = await fetch(url);
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

// ---------- parseo del día ----------
function parseStreetsForDay(txt, day) {
  const reBlock = new RegExp(
    String.raw`(^|\n)\s*${day}\s+(mañana|tarde)[\s\S]*?(?=(^|\n)\s*(?:[1-9]|[12]\d|3[01])\s+(mañana|tarde)|$)`,
    "i"
  );
  const m = txt.match(reBlock);
  if (!m) return [];
  const cleaned = m[0]
    .replace(/\bGABINETE DE COMUNICACIÓN\b/gi, " ")
    .replace(/\b(mañana|tarde)\b/gi, " ")
    .replace(/km\/h|velocidad.*?(\n|$)/gim, " ")
    .replace(/(\s|^)(20|30|40|50|60|70|80|90|100)(\s|$)/g, " ")
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

// ---------- Overpass ----------
async function overpassWaysForName(name) {
  const BBOX = BBOX_LEON;

  const base = name.replace(/\./g, " ").replace(/\s{2,}/g, " ").trim();
  const cores = new Set([
    base,
    base.replace(/\bAvenida\b/i, "").trim(),
    base.replace(/\bCalle\b/i, "").trim(),
  ]);
  const heads = ["", "Calle ", "Avenida ", "Paseo ", "Plaza ", "Glorieta "];
  const articles = ["", "de ", "del ", "de la ", "de los ", "de las "];

  const variants = new Set();
  for (const c of cores) {
    for (const h of heads) for (const a of articles)
      variants.add((h + a + c).replace(/\s{2,}/g, " ").trim());
  }
  // alias frecuentes
  variants.add("Avenida de los Peregrinos");
  variants.add("Calle La Corredera");

  const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const accent = c => ({a:"[aáà]",e:"[eéè]",i:"[iíì]",o:"[oóò]",u:"[uúùü]"}[c.toLowerCase()] || esc(c));
  const toRegex = s => s.split(/\s+/).map(t => t.split("").map(accent).join("")).join(".*");

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
    return (j.elements || [])
      .filter(e => e.type === "way" && Array.isArray(e.geometry))
      .map(e => e.geometry.map(p => [p.lon, p.lat]));
  };

  // exactas primero
  for (const v of variants) {
    const lines = await tryQuery(`="${v}"`);
    if (lines.length) return lines;
  }
  // regex tolerante (flag i al final)
  for (const v of variants) {
    const rx = toRegex(v);
    const lines = await tryQuery(`~"${rx}",i`);
    if (lines.length) return lines;
  }
  return [];
}

// ---------- MAIN ----------
async function main() {
  const { day } = hoyES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  let pdfUrl = null;
  try {
    pdfUrl = await discoverRadarPDFViaCrawler();
  } catch {
    try {
      pdfUrl = await discoverRadarPDFFallback();
    } catch {
      const cached = await readCachedPDF();
      if (cached) {
        console.warn("Crawler y fallback fallaron. Usando PDF en caché:", cached);
        pdfUrl = cached;
      } else {
        throw new Error("No se localizaron PDFs de radares en noticias.");
      }
    }
  }
  console.log("PDF usado:", pdfUrl);
  await writeCachedPDF(pdfUrl);

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
