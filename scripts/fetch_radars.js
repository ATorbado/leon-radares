// scripts/fetch_radars.js
// Genera radars/today.geojson con las calles de León que tienen radar móvil HOY.
// Flujo: búsqueda SharePoint → crawler de noticias → patrones último año → caché.
// PDF → texto con pdfjs-dist. Overpass tolerante para mapear nombres de vías.

import fs from "node:fs/promises";
import path from "node:path";
import { fetch as undiciFetch } from "undici";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const LAST_PDF = path.join(process.cwd(), "radars", "latest_pdf.txt");
const TZ = "Europe/Madrid";
const BBOX_LEON = "42.56,-5.62,42.65,-5.50"; // S,W,N,E aprox León capital
const MESES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
const USER_AGENT = "leon-radares/1.2 (+github actions)";

// -------------------- HTTP con reintentos --------------------
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

// -------------------- Mirrors y helper para Overpass --------------------
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpassRequest(q, triesPerHost = 2) {
  const body = "data=" + encodeURIComponent(q);
  const headers = { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" };
  for (const ep of OVERPASS_ENDPOINTS) {
    for (let i = 0; i < triesPerHost; i++) {
      try {
        const r = await fetch(ep, { method: "POST", headers, body });
        if (r.ok) {
          // Algunos mirrors devuelven HTML de error; intenta parsear JSON
          const txt = await r.text();
          try { return JSON.parse(txt); } catch { /* cae a retry */ }
        }
      } catch {}
      await new Promise(r => setTimeout(r, 800 + i * 600));
    }
  }
  throw new Error("Overpass no disponible en los mirrors.");
}

// -------------------- Fecha local ES --------------------
function hoyES() {
  const f = new Intl.DateTimeFormat("es-ES", {
    timeZone: TZ, year: "numeric", month: "numeric", day: "numeric",
  });
  const parts = Object.fromEntries(
    f.formatToParts(new Date()).map(p => [p.type, p.value])
  );
  return { day: Number(parts.day), month: Number(parts.month), year: Number(parts.year) };
}

// -------------------- Búsqueda SharePoint --------------------
async function discoverRadarPDFViaSharePointSearchStrict() {
  // URL EXACTA con filtro de ~últimos 30 días y palabra 'radar'
  const searchUrl = "https://www.aytoleon.es/_layouts/15/osssearchresults.aspx?k=radar#Default=%7B%22k%22%3A%22radar%22%2C%22r%22%3A%5B%7B%22n%22%3A%22LastModifiedTime%22%2C%22t%22%3A%5B%22range(2025-09-21T22%3A00%3A00Z%2C%20max%2C%20to%3D%5C%22le%5C%22)%22%5D%2C%22o%22%3A%22and%22%2C%22k%22%3Afalse%2C%22m%22%3Anull%7D%5D%2C%22l%22%3A3082%7D";
  const base = "https://www.aytoleon.es/_layouts/15/osssearchresults.aspx";

  const { month, year } = hoyES();
  const mesNombre = MESES[month - 1];

  const html = await (await fetch(searchUrl)).text();
  const LINK_RE = /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
  const abs = (h) => { try { return new URL(h, base).toString(); } catch { return null; } };

  const pdfs = new Set();
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(m[3]);
    if (u && u.toLowerCase().endsWith(".pdf") && /radares?/i.test(u)) pdfs.add(u);
  }
  if (!pdfs.size) throw new Error("SP strict: no hay PDFs en el rango dado.");

  const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const mesNorm = norm(mesNombre);
  const yearStr = String(year);

  const exactos = [...pdfs].filter(u => {
    const s = norm(decodeURIComponent(u));
    return s.includes(mesNorm) && s.includes(yearStr);
  });

  if (exactos.length > 0) {
    const scored = [];
    for (const u of exactos) {
      let lm = 0;
      try {
        const head = await fetch(u, { method: "HEAD" });
        const lmStr = head.headers.get("last-modified");
        if (lmStr) lm = Date.parse(lmStr) || 0;
      } catch {}
      scored.push({ u, lm });
    }
    scored.sort((a,b) => b.lm - a.lm);
    return scored[0].u;
  }

  // Si no hay coincidencia exacta, coge el más reciente del año actual.
  const soloAnioActual = [...pdfs].filter(u => norm(decodeURIComponent(u)).includes(yearStr));
  if (soloAnioActual.length > 0) {
    const scored = [];
    for (const u of soloAnioActual) {
      let lm = 0;
      try {
        const head = await fetch(u, { method: "HEAD" });
        const lmStr = head.headers.get("last-modified");
        if (lmStr) lm = Date.parse(lmStr) || 0;
      } catch {}
      scored.push({ u, lm });
    }
    scored.sort((a,b) => b.lm - a.lm);
    return scored[0].u;
  }

  throw new Error("SP strict: no hay PDF del mes/año actual en resultados.");
}

// -------------------- Crawler de noticias --------------------
const NEWS_PAGES = [
  "https://www.aytoleon.es/es/actualidad/noticias",
  "https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx",
];
const LINK_RE = /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
function abs(base, href) { try { return new URL(href, base).toString(); } catch { return null; } }

async function listCandidatePages() {
  const urls = new Set(NEWS_PAGES);
  for (let i = 2; i <= 12; i++) urls.add(`https://www.aytoleon.es/es/actualidad/noticias?page=${i}`);
  for (let i = 2; i <= 12; i++) urls.add(`https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx?Page=${i}`);
  return [...urls];
}
async function extractLinksFrom(url) {
  const html = await (await fetch(url)).text();
  const out = []; let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(url, m[3]); if (u) out.push(u);
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
  const pdfs = new Set();

  for (const p of pages) {
    try {
      const links = await extractLinksFrom(p);
      for (const l of links) {
        if (l.toLowerCase().endsWith(".pdf") && /radares/i.test(l)) pdfs.add(l);
        if (/\/articulos\//i.test(l)) pdfs.add(l);
      }
      if (pdfs.size > 80) break;
    } catch {}
  }
  const arts = [...pdfs].filter(u => !u.toLowerCase().endsWith(".pdf")).slice(0, 60);
  for (const a of arts) {
    try {
      const links = await extractLinksFrom(a);
      for (const u of links) {
        if (u.toLowerCase().endsWith(".pdf") && /radares/i.test(u)) pdfs.add(u);
      }
    } catch {}
  }
  const ranked = [...pdfs]
    .filter(u => u.toLowerCase().endsWith(".pdf"))
    .map(u => ({ u, s: scoreByMonth(u, month, year) }))
    .sort((a,b) => b.s - a.s);

  if (!ranked.length) throw new Error("Crawler: sin PDFs.");
  return ranked[0].u;
}

// -------------------- Patrones último año --------------------
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
  const arr = []; let m = month, y = year;
  for (let i = 0; i < n; i++) {
    const mes = MESES[m-1]; arr.push({ mes, año: y });
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
    for (const base of BASES) for (const fn of VARIANTES(mes, año))
      candidatos.push(base + encodeURIComponent(fn));
  }
  for (const url of candidatos) {
    if (await tryHeadOrRange(url)) return url;
  }
  throw new Error("Patrones: sin PDF.");
}

// -------------------- Caché último PDF --------------------
async function readCachedPDF() {
  try { return (await fs.readFile(LAST_PDF, "utf8")).trim(); }
  catch { return null; }
}
async function writeCachedPDF(url) {
  await fs.mkdir(path.dirname(LAST_PDF), { recursive: true });
  await fs.writeFile(LAST_PDF, url, "utf8");
}

// -------------------- PDF → texto --------------------
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

// -------------------- Parser del día --------------------
function parseStreetsForDay(txt, day) {
  // Patrones de inicio/fin
  const dayStart = String.raw`(^|\n)\s*${day}\s+`;
  const nextDay  = String.raw`(?=(^|\n)\s*(?:[1-9]|[12]\d|3[01])\s+(mañana|tarde)|$)`;

  // Captura explícita de mañana -> hasta "tarde" o siguiente día
  const reManana = new RegExp(`${dayStart}mañana[\\s\\S]*?(?=(^|\\n)\\s*tarde\\b|${nextDay})`, "i");
  // Captura explícita de tarde -> desde "tarde" hasta siguiente día
  const reTarde  = new RegExp(`${dayStart}(?:mañana[\\s\\S]*?\\n\\s*)?tarde[\\s\\S]*?${nextDay}`, "i");

  const bloques = [];
  const m1 = txt.match(reManana); if (m1) bloques.push(m1[0]);
  const m2 = txt.match(reTarde);  if (m2) bloques.push(m2[0]);

  const normalizar = (s) => s
    .replace(/\bGABINETE DE COMUNICACIÓN\b/gi, " ")
    .replace(/\b(mañana|tarde)\b/gi, " ")
    .replace(/km\/h|velocidad.*?(\n|$)/gim, " ")
    .replace(/(\s|^)(20|30|40|50|60|70|80|90|100)(\s|$)/g, " ")
    .replace(/[0-9]{1,3}\s*$/gm, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{2,}/g, "\n")
    .trim();

  const normVia = (s) => s
    .replace(/\./g, " ")
    .replace(/\b(avda?\.?|av\.)\b/gi, "Avenida")
    .replace(/\b(c\/|c\.\s?|calle)\b/gi, "Calle")
    .replace(/\b(de la|de los|de las|de|del)\b/gi, (m)=>m.toLowerCase())
    .replace(/^\W+|\W+$/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();

  const vias = new Set();
  for (const b of bloques) {
    const cleaned = normalizar(b);
    const lines = cleaned.split(/\n+/).map(s => s.trim()).filter(Boolean);
    for (const raw of lines) {
      if (/^(?:día|turno|\W*)$/i.test(raw)) continue;
      const v = normVia(raw);
      if (v) vias.add(v);
    }
  }
  return [...vias];
}

// -------------------- Overpass tolerante --------------------
async function overpassWaysForName(name) {
  const base = name.replace(/\./g, " ").replace(/\s{2,}/g, " ").trim();
  const cores = new Set([
    base,
    base.replace(/\bAvenida\b/i, "").trim(),
    base.replace(/\bCalle\b/i, "").trim(),
  ]);
  const heads = ["", "Calle ", "Avenida ", "Paseo ", "Plaza ", "Glorieta "];
  const articles = ["", "de ", "del ", "de la ", "de los ", "de las "];

  const variants = new Set();
  for (const c of cores) for (const h of heads) for (const a of articles)
    variants.add((h + a + c).replace(/\s{2,}/g, " ").trim());

  // Alias habituales
  variants.add("Avenida de los Peregrinos");
  variants.add("Calle La Corredera");

  const esc = s => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const accent = c => ({a:"[aáà]",e:"[eéè]",i:"[iíì]",o:"[oóò]",u:"[uúùü]"}[c.toLowerCase()] || esc(c));
  const toRegex = s => s.split(/\s+/).map(t => t.split("").map(accent).join("")).join(".*");

  const tryQuery = async (filter) => {
    const q = `
[out:json][timeout:25];
way["name"${filter}](${BBOX_LEON});
out geom;`;
    const j = await overpassRequest(q); // ← usa mirrors + reintentos
    return (j.elements || [])
      .filter(e => e.type === "way" && Array.isArray(e.geometry))
      .map(e => e.geometry.map(p => [p.lon, p.lat]));
  };

  // Exactas
  for (const v of variants) {
    const lines = await tryQuery(`="${v}"`);
    if (lines.length) return lines;
  }
  // Regex con flag i
  for (const v of variants) {
    const rx = toRegex(v);
    const lines = await tryQuery(`~"${rx}",i`);
    if (lines.length) return lines;
  }
  return [];
}

// -------------------- Main --------------------
async function main() {
  const { day } = hoyES();
  await fs.mkdir(path.dirname(OUT), { recursive: true });

  let pdfUrl = null;
  try {
    pdfUrl = await discoverRadarPDFViaSharePointSearchStrict(); // filtro estricto
  } catch (e1) {
    try {
      pdfUrl = await discoverRadarPDFViaCrawler();
    } catch {
      try {
        pdfUrl = await discoverRadarPDFFallback();
      } catch {
        const cached = await readCachedPDF();
        if (cached) {
          console.warn("Fallo SP strict + fallbacks. Usando caché:", cached);
          pdfUrl = cached;
        } else {
          throw e1;
        }
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
    await new Promise(r => setTimeout(r, 1000)); // cortesía Overpass
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
