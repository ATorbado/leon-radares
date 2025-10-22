// Busca en SharePoint: últimos N días, palabra radar/radares; devuelve el PDF más reciente.
async function discoverRadarPDFViaSharePointSearch(daysBack = 60) {
  const now = new Date();
  const from = new Date(now.getTime() - daysBack*24*60*60*1000);
  const fromIso = from.toISOString().replace(/\.\d{3}Z$/, "Z");

  // Filtro de fecha (LastModifiedTime) y búsqueda por "radar"
  const filter = {
    k: "radar",
    r: [{ n: "LastModifiedTime", t: [`range(${fromIso}, max, to="le")`], o: "and", k: false, m: null }],
    l: 3082
  };
  const base = "https://www.aytoleon.es/_layouts/15/osssearchresults.aspx";
  const url = `${base}?k=radar#Default=${encodeURIComponent(JSON.stringify(filter))}`;

  // Descarga HTML y extrae links (href="...", '...', data-href/src)
  const html = await (await fetch(url)).text();
  const LINK_RE = /(href|data-href|data-src)\s*=\s*(['"])(.*?)\2/gi;
  const abs = (h) => { try { return new URL(h, base).toString(); } catch { return null; } };

  const cand = new Set();
  let m;
  while ((m = LINK_RE.exec(html)) !== null) {
    const u = abs(m[3]);
    if (!u) continue;
    if (u.toLowerCase().endsWith(".pdf") && /radares?/i.test(u)) cand.add(u);
  }
  if (cand.size === 0) throw new Error("SP search: sin PDFs.");

  // Elige el más reciente por Last-Modified (si disponible); si no, por URL con mes/año
  const entries = [];
  for (const u of cand) {
    let score = 0, lm = 0;
    try {
      const head = await fetch(u, { method: "HEAD" });
      const lmStr = head.headers.get("last-modified");
      if (lmStr) lm = Date.parse(lmStr) || 0;
    } catch {}
    // Puntos por contener el mes/año actual
    const MES = ["enero","febrero","marzo","abril","mayo","junio","julio","agosto","septiembre","octubre","noviembre","diciembre"];
    const { month, year } = hoyES();
    const s = decodeURIComponent(u).toLowerCase();
    if (s.includes(MES[month-1])) score += 5;
    if (s.includes(String(year))) score += 2;
    entries.push({ u, lm, score });
  }

  entries.sort((a,b) => (b.lm - a.lm) || (b.score - a.score));
  return entries[0].u;
}
