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
const realFetch = globalThis.fetch;

// -------------------- Utilidades básicas --------------------
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

async function tryHeadOrRange(u) {
  try {
    let r = await fetch(u, { method: "HEAD" });
    if (r.ok) return true;
    r = await fetch(u, { method: "GET", headers: { Range: "bytes=0-64" } });
    return r.ok;
  } catch {
    return false;
  }
}

// -------------------- Elección del PDF --------------------
// SOLO mes actual. No baja a meses anteriores.
async function discoverRadarPDFCurrentMonth() {
  const { month, year } = hoyES();
  const mes = MESES[month - 1];

  const bases = [
    "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias2/",
    "https://www.aytoleon.es/es/actualidad/noticias/articulos/SiteAssets/Lists/EntradasDeBlog/Noticias/",
  ];

  const candidatos = [];

  // Estilo nuevo: Radares noviembre.pdf
  for (const base of bases) {
    candidatos.push(base + encodeURIComponent(`Radares ${mes}.pdf`));
  }
  // Estilo antiguo: Radares septiembre 2025.pdf
  for (const base of bases) {
    candidatos.push(base + encodeURIComponent(`Radares ${mes} ${year}.pdf`));
  }

  for (const url of candidatos) {
    if (await tryHeadOrRange(url)) {
      console.log("Fuente PDF: directo mes actual");
      return url;
    }
  }

  throw new Error("No se ha encontrado PDF de radares para el mes actual.");
}

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

// -------------------- Overpass --------------------
async function overpassRequest(q, triesPerHost = 2) {
  const body = "data=" + encodeURIComponent(q);
  const headers = {
    "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"
  };
  for (const ep of [
    "https://overpass-api.de/api/interpreter",
    "https://z.overpass-api.de/api/interpreter",
    "https://overpass.kumi.systems/api/interpreter",
  ]) {
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

  variants.add("Avenida de los Peregrinos");
  variants.add("Calle La Corredera");

  const esc = (s) => s.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
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
    pdfUrl = await discoverRadarPDFCurrentMonth();
  } catch (e) {
    console.warn(e.message);
    const cached = await readCachedPDF();
    if (cached) {
      console.warn("Usando PDF en caché:", cached);
      pdfUrl = cached;
    } else {
      throw e;
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
    await new Promise(r => setTimeout(r, 1000));
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
