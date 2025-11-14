// scripts/build_feeds.js
import { DateTime } from "luxon";
import fs from "node:fs";
import path from "node:path";

import { getCortes } from "./sources/cortes.js";
import { getControles } from "./sources/controles.js";

async function main() {
  const now = DateTime.now();

  const cortesSrc = await getCortes(now);
  const controlesSrc = await getControles(now);

  const ym = now.toFormat("yyyy-MM");

  const outDir = path.join("radars", ym);
  fs.mkdirSync(outDir, { recursive: true });
  fs.mkdirSync("radars/latest", { recursive: true });

  fs.writeFileSync(
    path.join(outDir, "cortes.json"),
    JSON.stringify(cortesSrc, null, 2)
  );
  fs.writeFileSync(
    path.join(outDir, "controles.json"),
    JSON.stringify(controlesSrc, null, 2)
  );

  fs.writeFileSync(
    "radars/latest/cortes.json",
    JSON.stringify(cortesSrc, null, 2)
  );
  fs.writeFileSync(
    "radars/latest/controles.json",
    JSON.stringify(controlesSrc, null, 2)
  );
}

main();
