import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createSocrataAdapter,
  linkableSocrataParcel,
} from "../src/permits/adapters/socrata.mjs";

const fixtureRoot = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/permits/los-angeles",
);
const fixture = (name) =>
  JSON.parse(readFileSync(path.join(fixtureRoot, name), "utf8"));

const DATASETS = [
  { id: "e67z-kt2n", label: "issued before 2010" },
  { id: "dyxf-7hc4", label: "issued 2010-2019" },
  { id: "pi9x-tg5x", label: "issued 2020-present" },
];
const jurisdiction = {
  key: "city-of-los-angeles",
  adapterKey: "socrata",
  adapterConfig: {
    sourceSystem: "LADBS Socrata open data",
    baseUrl: "https://data.lacity.org",
    datasets: DATASETS,
    minimumDelayMs: 250,
  },
};
const parcelRows = Object.fromEntries(
  DATASETS.map(({ id }) => [id, fixture(`ladbs-2139009018-${id}.json`)]),
);

// Fake SODA endpoint over in-memory datasets: count(*), $where apn = '...', $order/:id paging.
function fakeClient(datasets, { versions = () => 1 } = {}) {
  const calls = [];
  return {
    calls,
    async json(url) {
      calls.push(url);
      const u = new URL(url);
      const view = /\/api\/views\/([a-z0-9-]+)\.json$/.exec(u.pathname);
      if (view) return { body: { rowsUpdatedAt: versions(view[1]) } };
      const id = /\/resource\/([a-z0-9-]+)\.json$/.exec(u.pathname)[1];
      let rows = datasets[id] ?? [];
      const where = u.searchParams.get("$where");
      if (where) {
        const apn = /apn = '([^']*)'/.exec(where)[1];
        rows = rows.filter((row) => row.apn === apn);
      }
      if (u.searchParams.get("$select")?.startsWith("count(*)")) {
        return { body: [{ n: String(rows.length) }] };
      }
      const offset = Number(u.searchParams.get("$offset") ?? 0);
      const limit = Number(u.searchParams.get("$limit") ?? 1000);
      return { body: rows.slice(offset, offset + limit) };
    },
  };
}

describe("Socrata (LADBS) permit adapter", () => {
  it("links only full, non-placeholder parcel ids", () => {
    const config = { parcelPattern: "^\\d{10}$", placeholderParcelPattern: "^(?:9+|0+)$" };
    expect(linkableSocrataParcel("2139009018", config)).toBe("2139009018");
    expect(linkableSocrataParcel("2139-009-018", config)).toBe("2139009018");
    expect(linkableSocrataParcel("9999999999", config)).toBeNull();
    expect(linkableSocrataParcel("2269025***", config)).toBeNull();
    expect(linkableSocrataParcel("", config)).toBeNull();
  });

  it("finds a parcel's permits across every dataset and normalizes them", async () => {
    const adapter = createSocrataAdapter(jurisdiction, {
      client: fakeClient(parcelRows),
    });
    const refs = await adapter.searchParcel("2139009018");
    expect(refs.reconciliation.map((r) => r.reported)).toEqual([0, 4, 1]);
    const records = await Promise.all(refs.map((r) => adapter.fetchPermitDetail(r)));
    expect(records).toHaveLength(5);
    for (const record of records) {
      expect(record.parcel_identifier).toBe("2139009018");
      expect(record.contractors).toEqual([]);
      expect(record.sourceUrl).toMatch(/^https:\/\/data\.lacity\.org\/resource\//);
      expect(record.property_improvement_id).toMatch(/\S/);
      if (record.final_inspection_date) {
        expect(record.improvement_status).toMatch(/^permit finaled$/i);
        expect(record.final_inspection_date).toBe(record.sourcePayload.statusDate);
      } else {
        expect(record.sourcePayload.statusDateUsedAsFinal).toBe(false);
      }
    }
    expect(records.filter((r) => r.isRoofPermit)).toHaveLength(1);
  });

  it("leaves a negative valuation out of estimated_job_value but keeps it raw", async () => {
    const adapter = createSocrataAdapter(jurisdiction, {
      client: fakeClient(parcelRows),
    });
    const [ref] = await adapter.searchParcel("2139009018");
    const record = await adapter.fetchPermitDetail({
      ...ref,
      row: { ...ref.row, valuation: "-1250" },
    });
    expect(record.estimated_job_value).toBeNull();
    expect(record.sourcePayload.row.valuation).toBe("-1250");
  });

  it("returns no permits cleanly for a parcel with none", async () => {
    const adapter = createSocrataAdapter(jurisdiction, {
      client: fakeClient(parcelRows),
    });
    const refs = await adapter.searchParcel("6060011004");
    expect(refs).toHaveLength(0);
  });

  it("refuses to search a placeholder parcel", async () => {
    const adapter = createSocrataAdapter(jurisdiction, {
      client: fakeClient(parcelRows),
    });
    await expect(adapter.searchParcel("9999999999")).rejects.toMatchObject({
      code: "socrata_unlinkable_parcel",
    });
  });

  it("rejects a row whose parcel differs from the requested parcel", async () => {
    const adapter = createSocrataAdapter(jurisdiction, {
      client: fakeClient(parcelRows),
    });
    const [ref] = await adapter.searchParcel("2139009018");
    await expect(
      adapter.fetchPermitDetail({ ...ref, requestedParcelIdentifier: "2139009019" }),
    ).rejects.toMatchObject({ code: "socrata_parcel_mismatch" });
  });

  it("downloads every row, keeps placeholder-parcel rows unlinked, and resumes pages", async () => {
    const placeholder = fixture("ladbs-placeholder-apn-e67z-kt2n.json");
    const datasets = { ...parcelRows, "e67z-kt2n": placeholder };
    const config = { ...jurisdiction.adapterConfig, bulkPageSize: 2 };
    const pages = new Map();
    const adapter = createSocrataAdapter(
      { ...jurisdiction, adapterConfig: config },
      { client: fakeClient(datasets) },
    );
    const result = await adapter.enumerateAll({
      onPage: async (page) => pages.set(page.pageKey, page),
    });
    expect(result.status).toBe("complete");
    expect(result.sourceCount).toBe(placeholder.length + 5);
    expect(result.receivedCount).toBe(result.sourceCount);
    const all = [...pages.values()];
    expect(all.flatMap((p) => p.unlinked)).toHaveLength(placeholder.length);
    expect(all.flatMap((p) => p.records)).toHaveLength(5);

    const resumed = await createSocrataAdapter(
      { ...jurisdiction, adapterConfig: config },
      { client: fakeClient(datasets) },
    ).enumerateAll({
      loadPageCheckpoint: async ({ pageKey }) => pages.get(pageKey) ?? null,
    });
    expect(resumed.resumedPageCount).toBe(result.pageCount);
  });

  it("refuses completion when a dataset changes mid-download", async () => {
    let stamp = 1;
    const adapter = createSocrataAdapter(
      { ...jurisdiction, adapterConfig: { ...jurisdiction.adapterConfig, bulkPageSize: 2 } },
      { client: fakeClient(parcelRows, { versions: () => stamp }) },
    );
    await expect(
      adapter.enumerateAll({ onPage: async () => { stamp = 2; } }),
    ).rejects.toMatchObject({ code: "socrata_source_drift" });
  });
});
