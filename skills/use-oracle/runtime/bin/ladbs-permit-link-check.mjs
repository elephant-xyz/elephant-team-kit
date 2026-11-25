#!/usr/bin/env node
// Reconcile a finished LADBS permit download against the LA parcel seed.
//   node bin/ladbs-permit-link-check.mjs <jobId>
// Reports: total rows, duplicate permit numbers, linked to a seeded parcel (and whether
// that parcel's tax-rate city is Los Angeles), linked to an excluded parcel, linked to
// an APN not in the seed at all, and unlinked rows. Writes link-check.json.
import { createReadStream, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { createGunzip } from "node:zlib";
import { createInterface } from "node:readline";
import path from "node:path";

const jobId = process.argv[2];
const root = path.resolve("data/artifacts/permits/los-angeles", jobId);
const summary = JSON.parse(readFileSync(path.join(root, "summary.json"), "utf8"));

async function* lines(file) {
  const rl = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  for await (const line of rl) if (line) yield line;
}
async function* csvRows(file) {
  const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  let header = null;
  for await (const line of rl) {
    const cells = [];
    let cell = "", quoted = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (quoted) {
        if (ch === '"' && line[i + 1] === '"') { cell += '"'; i++; }
        else if (ch === '"') quoted = false;
        else cell += ch;
      } else if (ch === '"') quoted = true;
      else if (ch === ",") { cells.push(cell); cell = ""; }
      else cell += ch;
    }
    cells.push(cell);
    if (!header) { header = cells; continue; }
    yield Object.fromEntries(header.map((h, i) => [h, cells[i]]));
  }
}

const seedCity = new Map();
for await (const row of csvRows("data/seeds/los-angeles.csv")) seedCity.set(row.parcel_id, row.tax_rate_city);
const excluded = new Map();
for await (const row of csvRows("data/seeds/los-angeles.excluded.csv")) if (row.parcel_id) excluded.set(row.parcel_id, row.reason);

const counts = {
  rows: 0, unlinked: 0, linkedSeeded: 0, linkedSeededCityOfLA: 0, linkedSeededOtherCity: 0,
  linkedExcluded: 0, linkedNotInSeed: 0, roof: 0, finaled: 0,
};
const excludedReasons = {};
const otherCities = {};
const permitNumbers = new Set();
let duplicates = 0;
const parcelsWithPermits = new Set();
for (const file of readdirSync(path.join(root, "pages")).sort()) {
  for await (const line of lines(path.join(root, "pages", file))) {
    const r = JSON.parse(line);
    counts.rows += 1;
    if (permitNumbers.has(r.permit_number)) duplicates += 1;
    permitNumbers.add(r.permit_number);
    if (r.isRoofPermit) counts.roof += 1;
    if (r.final_inspection_date) counts.finaled += 1;
    const apn = r.parcel_identifier;
    if (apn === "unlinked") { counts.unlinked += 1; continue; }
    if (seedCity.has(apn)) {
      counts.linkedSeeded += 1;
      parcelsWithPermits.add(apn);
      const city = seedCity.get(apn);
      if (city === "LOS ANGELES") counts.linkedSeededCityOfLA += 1;
      else { counts.linkedSeededOtherCity += 1; otherCities[city] = (otherCities[city] ?? 0) + 1; }
    } else if (excluded.has(apn)) {
      counts.linkedExcluded += 1;
      const reason = excluded.get(apn);
      excludedReasons[reason] = (excludedReasons[reason] ?? 0) + 1;
    } else counts.linkedNotInSeed += 1;
  }
}
const report = {
  jobId,
  sourceCount: summary.sourceCount,
  ...counts,
  duplicatePermitNumbers: duplicates,
  seededParcelsWithPermits: parcelsWithPermits.size,
  excludedReasons,
  topOtherCities: Object.entries(otherCities).sort((a, b) => b[1] - a[1]).slice(0, 10),
  rowsMatchSource: counts.rows === summary.sourceCount,
};
writeFileSync(path.join(root, "link-check.json"), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
