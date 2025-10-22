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
async function discoverRadarPDFViaSharePointSearch(daysBack = 60) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack*24*60*60*1000);
  const fromIso = from.toISOString().replace(/\.\d{3}Z$/, "Z");
  const filter = {
    k: "radar",
    r: [{ n: "LastModifiedTime", t: [`range(${fromIso}, max, to="le")`], o: "and", k: false, m: null }],
    l: 3082
  };
  const base = "https://www.aytoleon.es/_layouts/15/osssearchresults.aspx";
  const url = `${base}?k=radar#Default=${encodeURIComponent(JSON.stringify(filter))}`;

  const html = await (await fetch(url)).text();
  const LINK_RE = /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
  const abs = (h) => { try { return new URL(h, base).toString(); } catch { return null; } };

  const cand = new Set();
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(m[3]);
    if (!u) continue;
    if (u.toLowerCase().endsWith(".pdf") && /radares?/i.test(u)) cand.add(u);
    if (/\/articulos\//i.test(u)) cand.add(u);
  }

  // Abrir artículos y extraer PDFs internos
  const arts = [...cand].filter(u => !u.toLowerCase().endsWith(".pdf")).slice(0, 40);
  for (const a of arts) {
    try {
      const th = await (await fetch(a)).text();
      let mm; LINK_RE.lastIndex = 0;
      while ((mm = LINK_RE.exec(th)) !== null) {
        const u = abs(mm[3]);
        if (u && u.toLowerCase().endsWith(".pdf") && /radares?/i.test(u)) cand.add(u);
      }
    } catch {}
  }

  if (!cand.size) throw new Error("SP search: sin PDFs.");
  const entries = [];
  for (const u of cand) {
    let lm = 0, score = 0;
    try {
      const head = await fetch(u, { method: "HEAD" });
      const lmStr = head.headers.get("last-modified");
      if (lmStr) lm = Date.parse(lmStr) || 0;
    } catch {}
    const { month, year } = hoyES();
    const mes = MESES[month-1];
    const s = decodeURIComponent(u).toLowerCase();
    if (s.includes(mes)) score += 5;
    if (s.includes(String(year))) score += 2;
    if (s.includes("radares")) score += 2;
    entries.push({ u, lm, score });
  }
  entries.sort((a,b) => (b.lm - a.lm) || (b.score - a.score));
  return entries[0].u;
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
async function readCachedPDF() { try { return (await fs.readFile(LAST_PDF, "utf8")).trim(); } catch { return null; } }
async function writeCachedPDF(url) {
  await fs.mkdir(path.dirname(LAST_PDF), { recursive: true });
  await fs.writeFile(LAST_PDF, url, "utf8");
}

// -------------------- PDF → texto --------------------
async function pdfToTextFromUrl(url
