#!/usr/bin/env node
// Download every City of Los Angeles (LADBS) permit from data.lacity.org through the
// socrata permit adapter. Rerun to resume: finished pages are skipped by checkpoint.
//   node bin/ladbs-permit-download.mjs <jobId>
// Writes data/artifacts/permits/los-angeles/<jobId>/{pages,checkpoints}/ and summary.json.
import { mkdirSync, readFileSync, writeFileSync, renameSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import path from "node:path";

import { createSocrataAdapter } from "../src/permits/adapters/socrata.mjs";

const jobId = process.argv[2];
if (!jobId) throw new Error("usage: ladbs-permit-download.mjs <jobId>");
const root = path.resolve("data/artifacts/permits/los-angeles", jobId);
for (const dir of ["pages", "checkpoints"]) mkdirSync(path.join(root, dir), { recursive: true });

export const ladbsJurisdiction = {
  key: "city-of-los-angeles",
  adapterKey: "socrata",
  adapterConfig: {
    sourceSystem: "LADBS Socrata open data",
    baseUrl: "https://data.lacity.org",
    datasets: [
      { id: "e67z-kt2n", label: "issued before 2010" },
      { id: "dyxf-7hc4", label: "issued 2010-2019" },
      { id: "pi9x-tg5x", label: "issued 2020-present" },
    ],
    bulkPageSize: 50000,
    minimumDelayMs: 500,
  },
};

const writeAtomic = (file, data) => {
  writeFileSync(`${file}.tmp`, data);
  renameSync(`${file}.tmp`, file);
};
const checkpointFile = (pageKey) => path.join(root, "checkpoints", `${pageKey}.json`);

const adapter = createSocrataAdapter(ladbsJurisdiction, { timeoutMs: 300_000 });
const started = new Date().toISOString();
let linked = 0;
let unlinked = 0;
const result = await adapter.enumerateAll({
  loadPageCheckpoint: async ({ pageKey }) =>
    existsSync(checkpointFile(pageKey))
      ? JSON.parse(readFileSync(checkpointFile(pageKey), "utf8"))
      : null,
  onPage: async (page) => {
    const lines = [
      ...page.records.map((r) => JSON.stringify(r)),
      ...page.unlinked.map((r) => JSON.stringify(r)),
    ].join("\n");
    writeAtomic(path.join(root, "pages", `${page.pageKey}.jsonl.gz`), gzipSync(`${lines}\n`));
    const { records, unlinked: u, ...meta } = page;
    writeAtomic(
      checkpointFile(page.pageKey),
      JSON.stringify({ ...meta, linkedCount: records.length, unlinkedCount: u.length }),
    );
    linked += records.length;
    unlinked += u.length;
    console.log(`${new Date().toISOString()} ${page.pageKey} rows=${page.receivedCount} linked=${records.length} unlinked=${u.length}`);
  },
});
const summary = { jobId, started, finished: new Date().toISOString(), ...result, linkedThisRun: linked, unlinkedThisRun: unlinked };
writeAtomic(path.join(root, "summary.json"), JSON.stringify(summary, null, 2));
console.log(JSON.stringify(summary));
