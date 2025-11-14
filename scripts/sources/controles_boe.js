// scripts/sources/controles_boe.js

import https from "node:https";
import { DateTime } from "luxon";

const BOE_HOST = "boe.es";

function fetchJson(path) {
  return new Promise((resolve, reject) => {
    const opts = {
      host: BOE_HOST,
      path,
      method: "GET",
      headers: { Accept: "application/json" }
    };

    const req = https.request(opts, res => {
      let data = "";
      res.on("data", c => (data += c));
      res.on("end", () => {
        try {
          resolve(JSON.parse(data));
        } catch (e) {
          reject(e);
        }
      });
    });

    req.on("error", reject);
    req.end();
  });
}

function* walkItems(node) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const x of node) yield* walkItems(x);
  } else if (typeof node === "object") {
    if (node.item) {
      if (Array.isArray(node.item)) {
        for (const it of node.item) yield it;
      } else {
        yield node.item;
      }
    }
    for (const v of Object.values(node)) {
      if (v && typeof v === "object") yield* walkItems(v);
    }
  }
}

function matchesTrafficLeon(titulo = "") {
  const t = titulo.toLowerCase();
  const hasLeon = t.includes("león") || t.includes("leon");
  const hasTraffic =
    t.includes("tráfico") ||
    t.includes("trafico") ||
    t.includes("seguridad vial") ||
    t.includes("guardia civil") ||
    t.includes("dirección general de tráfico");

  return hasLeon && hasTraffic;
}

export async function getControlesBOE(now = DateTime.now()) {
  const out = [];
  const daysBack = 3;

  for (let i = 0; i < daysBack; i++) {
    const date = now.minus({ days: i }).toFormat("yyyyLLdd");
    const path = `/datosabiertos/api/boe/sumario/${date}`;

    let json;
    try {
      json = await fetchJson(path);
    } catch {
      continue;
    }

    const sumario = json?.data?.sumario;
    if (!sumario) continue;

    for (const item of walkItems(sumario)) {
      const titulo = item.titulo || "";
      if (!matchesTrafficLeon(titulo)) continue;

      const id = item.identificador || `BOE-${date}-${Math.random().toString(36).slice(2, 8)}`;
      const urlHtml = item.url_html || null;

      out.push({
        id,
        descripcion: titulo,
        organismo: "BOE",
        fuente_url: urlHtml,
        desde: null,
        hasta: null,
        lat: null,
        lon: null,
        oficial: true,
        tipo: "control"
      });
    }
  }

  return out;
}
