// One-off generator for lib/zip3-centroids.json: the mean internal point of every ZCTA that
// shares a 3-digit ZIP prefix, as [longitude, latitude] rounded to 3 decimals.
//
// Source: US Census Bureau 2020 ZCTA Gazetteer (public domain)
//   https://www2.census.gov/geo/docs/maps-data/data/gazetteer/2020_Gazetteer/2020_Gaz_zcta_national.zip
//
// Usage, with the zip downloaded and extracted outside the repo:
//   node scripts/build-zip3.ts /path/to/2020_Gaz_zcta_national.txt

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const source = process.argv[2];
if (!source) {
  console.error("Usage: node scripts/build-zip3.ts <2020_Gaz_zcta_national.txt>");
  process.exit(1);
}

const [header = "", ...rows] = readFileSync(source, "utf8").split(/\r?\n/);
const columns = header.split("\t").map((name) => name.trim());
const geoid = columns.indexOf("GEOID");
const lat = columns.indexOf("INTPTLAT");
const lon = columns.indexOf("INTPTLONG");
if (geoid < 0 || lat < 0 || lon < 0) throw new Error("Unexpected Gazetteer header");

const sums = new Map<string, { lon: number; lat: number; n: number }>();
for (const row of rows) {
  const fields = row.split("\t").map((field) => field.trim());
  const zip = fields[geoid];
  const latitude = Number(fields[lat]);
  const longitude = Number(fields[lon]);
  if (!zip || !/^\d{5}$/.test(zip) || !Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
  const prefix = zip.slice(0, 3);
  const sum = sums.get(prefix) ?? { lon: 0, lat: 0, n: 0 };
  sum.lon += longitude;
  sum.lat += latitude;
  sum.n += 1;
  sums.set(prefix, sum);
}

const round = (value: number) => Math.round(value * 1000) / 1000;
const centroids = Object.fromEntries(
  [...sums.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([prefix, s]) => [prefix, [round(s.lon / s.n), round(s.lat / s.n)]]),
);

const target = fileURLToPath(new URL("../lib/zip3-centroids.json", import.meta.url));
writeFileSync(target, `${JSON.stringify(centroids)}\n`);
console.log(`Wrote ${Object.keys(centroids).length} ZIP3 centroids to ${target}`);
