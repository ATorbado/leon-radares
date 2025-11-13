// scripts/fetch_radars.js
// Genera radars/today.geojson con las calles de León que tienen radar móvil HOY.

import fs from "node:fs/promises";
import path from "node:path";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";

const OUT = path.join(process.cwd(), "radars", "today.geojson");
const LAST_PDF = path.join(process.cwd(), "radars", "latest_pdf.txt");
const TZ = "Europe/Madrid";
const BBOX_LEON = "42.56,-5.62,42.65,-5.50"; // S,W,N,E aprox León capital
const MESES = [
  "enero","febrero","marzo","abril","mayo","junio",
  "julio","agosto","septiembre","octubre","noviembre","diciembre"
];
const USER_AGENT = "leon-radares/1.2 (+github actions)";

// Usa el fetch global de Node 20
const realFetch = globalThis.fetch;

// -------------------- HTTP con reintentos --------------------
async function fetch(url, opts = {}, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await realFetch(url, {
        headers: { "User-Agent": USER_AGENT, ...(opts.headers || {}) },
        ...opts,
      });
      if (r.ok) return r;
    } catch {}
    await new Promise(r => setTimeout(r, 600 + i * 400));
  }
  throw new Error(`HTTP fail: ${url}`);
}

// -------------------- Overpass helper --------------------
const OVERPASS_ENDPOINTS = [
  "https://overpass-api.de/api/interpreter",
  "https://z.overpass-api.de/api/interpreter",
  "https://overpass.kumi.systems/api/interpreter",
];

async function overpassRequest(q, triesPerHost = 2) {
  const body = "data=" + encodeURIComponent(q);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
  };
  for (const ep of OVERPASS_ENDPOINTS) {
    for (let i = 0; i < triesPerHost; i++) {
      try {
        const r = await fetch(ep, { method: "POST", headers, body });
        if (r.ok) {
          const txt = await r.text();
          try { return JSON.parse(txt); } catch {}
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

// -------------------- 0) Adivinar URL directa del mes actual --------------------
const BASES = [
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/",
  "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias/",
];

const VARIANTES = (mes, año) => [
  `Radares ${mes}.pdf`,               // Radares noviembre.pdf (caso actual)
  `Radares ${mes} ${año}.pdf`,
  `Radares mes de ${mes}.pdf`,
  `Radares mes de ${mes} de ${año}.pdf`,
  `Radares móviles ${mes} ${año}.pdf`,
  `Radares movilidad ${mes} ${año}.pdf`,
  `Radares_${mes}_${año}.pdf`,
  `Radares ${mes}-${año}.pdf`,
];

async function tryHeadOrRange(u) {
  try {
    let r = await fetch(u, { method: "HEAD" });
    if (r.ok) return true;
    r = await fetch(u, {
      method: "GET",
      headers: { Range: "bytes=0-64" },
    });
    return r.ok;
  } catch {
    return false;
  }
}

// intenta directamente URLs tipo Radares noviembre.pdf en las carpetas conocidas
async function discoverRadarPDFDirectGuessCurrentMonth() {
  const { month, year } = hoyES();
  const mes = MESES[month - 1];

  const candidatos = [];
  for (const base of BASES) {
    for (const fn of VARIANTES(mes, year)) {
      candidatos.push(base + encodeURIComponent(fn));
    }
  }

  for (const url of candidatos) {
    if (await tryHeadOrRange(url)) {
      console.log("Fuente PDF: adivinado directo mes actual");
      return url;
    }
  }
  throw new Error("Direct guess: sin PDF para el mes actual.");
}

// -------------------- 1) Búsqueda SharePoint --------------------
async function discoverRadarPDFViaSharePointSearchStrict() {
  const { month, year } = hoyES();
  const mesNombre = MESES[month - 1];       // ej: "noviembre"

  // Igual que haces tú: "radares noviembre"
  const query = encodeURIComponent(`radares ${mesNombre}`);
  const searchUrl =
    `https://www.aytoleon.es/_layouts/15/osssearchresults.aspx?k=${query}`;
  const base =
    "https://www.aytoleon.es/_layouts/15/osssearchresults.aspx";

  const html = await (await fetch(searchUrl)).text();
  const LINK_RE =
    /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
  const abs = (h) => {
    try { return new URL(h, base).toString(); } catch { return null; }
  };

  const links = new Set();
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(m[3]);
    if (u) links.add(u);
  }
  if (!links.size) {
    throw new Error("SP strict: sin enlaces en resultados.");
  }

  const norm = s =>
    s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const mesNorm = norm(mesNombre);
  const yearStr = String(year);

  const pdfs = [...links].filter(u =>
    u.toLowerCase().endsWith(".pdf") && /radares?/i.test(u)
  );
  if (!pdfs.length) {
    throw new Error("SP strict: no hay PDFs de radares en resultados.");
  }

  const candidatos = pdfs.map(u => {
    const s = norm(decodeURIComponent(u));
    let score = 0;
    if (s.includes(mesNorm)) score += 5;
    if (s.includes(yearStr)) score += 2;
    return { u, score };
  });

  candidatos.sort((a, b) => b.score - a.score);
  const topScore = candidatos[0].score;
  const top = candidatos.filter(c => c.score === topScore);

  const scored = [];
  for (const c of top) {
    let lm = 0;
    try {
      const head = await fetch(c.u, { method: "HEAD" });
      const lmStr = head.headers.get("last-modified");
      if (lmStr) lm = Date.parse(lmStr) || 0;
    } catch {}
    scored.push({ u: c.u, lm });
  }
  scored.sort((a, b) => b.lm - a.lm);

  console.log("Fuente PDF: SharePoint search");
  return scored[0].u;
}

// -------------------- 2) Crawler de noticias --------------------
const NEWS_PAGES = [
  "https://www.aytoleon.es/es/actualidad/noticias",
  "https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx",
];
const LINK_RE =
  /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
function abs(base2, href) {
  try { return new URL(href, base2).toString(); } catch { return null; }
}

async function listCandidatePages() {
  const urls = new Set(NEWS_PAGES);
  for (let i = 2; i <= 12; i++) {
    urls.add(
      `https://www.aytoleon.es/es/actualidad/noticias?page=${i}`
    );
  }
  for (let i = 2; i <= 12; i++) {
    urls.add(
      `https://www.aytoleon.es/es/actualidad/noticias/Paginas/default.aspx?Page=${i}`
    );
  }
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
  const mes = MESES[monthIdx - 1];
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
        if (l.toLowerCase().endsWith(".pdf") && /radares/i.test(l)) {
          pdfs.add(l);
        }
        if (/\/articulos\//i.test(l)) pdfs.add(l);
      }
      if (pdfs.size > 80) break;
    } catch {}
  }

  const arts = [...pdfs]
    .filter(u => !u.toLowerCase().endsWith(".pdf"))
    .slice(0, 60);

  for (const a of arts) {
    try {
      const links = await extractLinksFrom(a);
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
    .sort((a, b) => b.s - a.s);

  if (!ranked.length) throw new Error("Crawler: sin PDFs.");
  console.log("Fuente PDF: crawler noticias");
  return ranked[0].u;
}

// -------------------- 3) Fallback SOLO mes actual --------------------
async function discoverRadarPDFFallbackCurrentMonth() {
  const { month, year } = hoyES();
  const mes = MESES[month - 1];

  const candidatos = [];
  for (const base of BASES) {
    for (const fn of VARIANTES(mes, year)) {
      candidatos.push(base + encodeURIComponent(fn));
    }
  }

  for (const url of candidatos) {
    if (await tryHeadOrRange(url)) {
      console.log("Fuente PDF: fallback patrones mes actual");
      return url;
    }
  }
  throw new Error("Patrones: sin PDF para el mes actual.");
}

// -------------------- Caché último PDF --------------------
async function readCachedPDF() {
  try {
    return (await fs.readFile(LAST_PDF, "utf8")).trim();
  } catch {
    return null;
  }
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
  const dayStart = String.raw`(^|\n)\s*${day}\s+`;
  const nextDay = String.raw`(?=(^|\n)\s*(?:[1-9]|[12]\d|3[01])\s+(mañana|tarde)|$)`;

  const reManana = new RegExp(
    `${dayStart}mañana[\\s\\S]*?(?=(^|\\n)\\s*tarde\\b|${nextDay})`,
    "i"
  );
  const reTarde = new RegExp(
    `${dayStart}(?:mañana[\\s\\S]*?\\n\\s*)?tarde[\\s\\S]*?${nextDay}`,
    "i"
  );

  const bloques = [];
  const m1 = txt.match(reManana);
  if (m1) bloques.push(m1[0]);
  const m2 = txt.match(reTarde);
  if (m2) bloques.push(m2[0]);

  const normalizar = (s) =>
    s
      .replace(/\bGABINETE DE COMUNICACIÓN\b/gi, " ")
      .replace(/\b(mañana|tarde)\b/gi, " ")
      .replace(/km\/h|velocidad.*?(\n|$)/gim, " ")
      .replace(/(\s|^)(20|30|40|50|60|70|80|90|100)(\s|$)/g, " ")
      .replace(/[0-9]{1,3}\s*$/gm, " ")
      .replace(/[ \t]{2,}/g, " ")
      .replace(/\n{2,}/g, "\n")
      .trim();

  const normVia = (s) =>
    s
      .replace(/\./g, " ")
      .replace(/\b(avda?\.?|av\.)\b/gi, "Avenida")
      .replace(/\b(c\/|c\.\s?|calle)\b/gi, "Calle")
      .replace(/\b(de la|de los|de las|de|del)\b/gi, (m) => m.toLowerCase())
      .replace(/^\W+|\W+$/g, "")
      .replace(/\s{2,}/g, " ")
      .trim();

  const vias = new Set();
  for (const b of bloques) {
    const cleaned = normalizar(b);
    const lines = cleaned
      .split(/\n+/)
      .map((s) => s.trim())
      .filter(Boolean);
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
  const base = name
    .replace(/\./g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();

  const cores = new Set([
    base,
    base.replace(/\bAvenida\b/i, "").trim(),
    base.replace(/\bCalle\b/i, "").trim(),
  ]);

  const heads = ["", "Calle ", "Avenida ", "Paseo ", "Plaza ", "Glorieta "];
  const articles = ["", "de ", "del ", "de la ", "de los ", "de las "];

  const variants = new Set();
  for (const c of cores) {
    for (const h of heads) {
      for (const a of articles) {
        variants.add(
          (h + a + c).replace(/\s{2,}/g, " ").trim()
        );
      }
    }
  }

  // Alias habituales
  variants.add("Avenida de los Peregrinos");
  variants.add("Calle La Corredera");

  const esc = (s) =>
    s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  const accent = (c) =>
    ({ a: "[aáà]", e: "[eéè]", i: "[iíì]", o: "[oóò]", u: "[uúùü]" }[
      c.toLowerCase()
    ] || esc(c));
  const toRegex = (s) =>
    s
      .split(/\s+/)
      .map((t) => t.split("").map(accent).join(""))
      .join(".*");

  const tryQuery = async (filter) => {
    const q = `
[out:json][timeout:25];
way["name"${filter}](${BBOX_LEON});
out geom;`;
    const j = await overpassRequest(q);
    return (j.elements || [])
      .filter((e) => e.type === "way" && Array.isArray(e.geometry))
      .map((e) => e.geometry.map((p) => [p.lon, p.lat]));
  };

  for (const v of variants) {
    const lines = await tryQuery(`="${v}"`);
    if (lines.length) return lines;
  }
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
    pdfUrl = await discoverRadarPDFDirectGuessCurrentMonth();
  } catch (e0) {
    console.warn(e0.message);
    try {
      pdfUrl = await discoverRadarPDFViaSharePointSearchStrict();
    } catch (e1) {
      console.warn(e1.message);
      try {
        pdfUrl = await discoverRadarPDFViaCrawler();
      } catch (e2) {
        console.warn(e2.message);
        try {
          pdfUrl = await discoverRadarPDFFallbackCurrentMonth();
        } catch (e3) {
          console.warn(e3.message);
          const cached = await readCachedPDF();
          if (cached) {
            console.warn(
              "Fallo SP + crawler + fallback. Usando caché:",
              cached
            );
            pdfUrl = cached;
          } else {
            throw e3;
          }
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
      geometry:
        mls.length === 1
          ? { type: "LineString", coordinates: mls[0] }
          : { type: "MultiLineString", coordinates: mls },
    });
    await new Promise((r) => setTimeout(r, 1000));
  }

  const fc = { type: "FeatureCollection", features };
  await fs.writeFile(OUT, JSON.stringify(fc, null, 2), "utf8");
  console.log(`Generado ${OUT} con ${features.length} calles`);
}

main().catch(async (e) => {
  console.error("ERROR:", e.message);
  const fc = { type: "FeatureCollection", features: [] };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(fc), "utf8");
});
