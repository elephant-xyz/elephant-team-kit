import { z } from "zod";

import {
  createStablePermitId,
  normalizedPermitRecordSchema,
} from "../contracts.mjs";
import { sha256Json } from "../backfill-inputs.mjs";
import { normalizeSourcePayload } from "../normalization.mjs";
import { PermitHttpClient } from "../http.mjs";
import { PermitSourceError } from "../errors.mjs";

// Socrata (SODA 2.x) open-data permit datasets, e.g. City of Los Angeles LADBS
// (data.lacity.org). One jurisdiction may publish its history split across several
// datasets (by issue-date era); all of them are searched and enumerated.

const DEFAULT_FIELD_MAP = Object.freeze({
  permitNumber: "permit_nbr",
  parcelIdentifier: "apn",
  permitGroup: "permit_group",
  permitType: "permit_type",
  permitSubType: "permit_sub_type",
  status: "status_desc",
  statusDate: "status_date",
  description: "work_desc",
  address: "primary_address",
  zipCode: "zip_code",
  issuedAt: "issue_date",
  appliedAt: "submitted_date",
  estimatedValue: "valuation",
});

const datasetSchema = z
  .object({
    id: z.string().regex(/^[a-z0-9]{4}-[a-z0-9]{4}$/),
    label: z.string().min(1),
  })
  .strict();

const configSchema = z.object({
  sourceSystem: z.string().min(1),
  baseUrl: z.string().url(),
  datasets: z.array(datasetSchema).min(1),
  fieldMap: z.record(z.string(), z.string()).default({}),
  // Status text that means the permit was finaled; only then is status_date used as
  // the final/close date. Any other status keeps status_date in the payload only.
  finaledStatusPattern: z.string().min(1).default("^permit finaled$"),
  // A source parcel is linked only when it is a full parcel id; partial (e.g.
  // "2269025***"), blank and placeholder values stay unlinked.
  parcelPattern: z.string().min(1).default("^\\d{10}$"),
  placeholderParcelPattern: z.string().min(1).default("^(?:9+|0+)$"),
  bulkPageSize: z.number().int().min(1).max(50000).default(10000),
  searchPageSize: z.number().int().min(1).max(5000).default(1000),
  minimumDelayMs: z.number().int().min(250).default(500),
  detailFingerprintVersion: z.string().min(1).default("socrata-v1"),
});

function field(config, key) {
  return config.fieldMap[key] ?? DEFAULT_FIELD_MAP[key];
}

function stringValue(value) {
  const normalized = String(value ?? "").trim();
  return normalized || null;
}

function dateOnly(value) {
  const text = stringValue(value);
  if (!text) return null;
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
  return match ? match[1] : null;
}

function moneyValue(value) {
  if (value == null || value === "") return null;
  const amount = Number(String(value).replace(/[$,\s]/g, ""));
  return Number.isFinite(amount) ? amount : null;
}

function soqlLiteral(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

export function normalizeSocrataParcel(value) {
  return stringValue(value)?.replace(/[-\s]/g, "") ?? null;
}

export function linkableSocrataParcel(value, config) {
  const parcel = normalizeSocrataParcel(value);
  if (!parcel) return null;
  if (!new RegExp(config.parcelPattern).test(parcel)) return null;
  if (new RegExp(config.placeholderParcelPattern).test(parcel)) return null;
  return parcel;
}

function resourceUrl(baseUrl, datasetId, parameters) {
  const url = new URL(
    `${baseUrl.replace(/\/+$/, "")}/resource/${datasetId}.json`,
  );
  for (const [key, value] of Object.entries(parameters)) {
    if (value != null) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function viewUrl(baseUrl, datasetId) {
  return `${baseUrl.replace(/\/+$/, "")}/api/views/${datasetId}.json`;
}

function publicSourceRow(row) {
  return Object.fromEntries(
    Object.entries(row).filter(
      ([key]) =>
        !key.startsWith(":") &&
        !/(?:owner|applicant|phone|email)/i.test(key),
    ),
  );
}

export function normalizeSocrataPermitRow(
  row,
  {
    countyKey,
    countyName,
    jurisdiction,
    config,
    dataset,
    requestedParcelIdentifier,
    requestedPropertyId = null,
  },
) {
  const permitNumber = stringValue(row?.[field(config, "permitNumber")]);
  if (!permitNumber) {
    throw new PermitSourceError("Socrata permit row has no permit number", {
      classification: "permanent",
      code: "socrata_missing_permit_key",
    });
  }
  const sourceParcelIdentifier = normalizeSocrataParcel(
    row[field(config, "parcelIdentifier")],
  );
  if (
    requestedParcelIdentifier !== "unlinked" &&
    sourceParcelIdentifier !== requestedParcelIdentifier
  ) {
    throw new PermitSourceError(
      `Socrata permit ${permitNumber} parcel ${sourceParcelIdentifier} differs from requested parcel`,
      {
        classification: "permanent",
        code: "socrata_parcel_mismatch",
      },
    );
  }

  const permitGroup = stringValue(row[field(config, "permitGroup")]);
  const permitType = stringValue(row[field(config, "permitType")]);
  const permitSubType = stringValue(row[field(config, "permitSubType")]);
  const status = stringValue(row[field(config, "status")]);
  const statusDate = dateOnly(row[field(config, "statusDate")]);
  const description = stringValue(row[field(config, "description")]);
  const issuedDate = dateOnly(row[field(config, "issuedAt")]);
  const appliedDate = dateOnly(row[field(config, "appliedAt")]);
  const finaled =
    status !== null &&
    new RegExp(config.finaledStatusPattern, "i").test(status);
  const finalDate = finaled ? statusDate : null;
  const address = stringValue(row[field(config, "address")]);
  const zipCode = stringValue(row[field(config, "zipCode")]);

  return normalizedPermitRecordSchema.parse({
    schemaVersion: "elephant.normalized-permit-record.v1",
    property_improvement_id: createStablePermitId({
      countyKey,
      jurisdictionKey: jurisdiction.key,
      sourceRecordId: permitNumber,
    }),
    property_id: requestedPropertyId,
    parcel_identifier: requestedParcelIdentifier,
    permit_number: permitNumber,
    improvement_type: permitType,
    improvement_status: status,
    improvement_action: null,
    permit_issue_date: issuedDate,
    application_received_date: appliedDate,
    final_inspection_date: finalDate,
    permit_close_date: finalDate,
    completion_date: finalDate,
    expiration_date: null,
    opened_date: appliedDate,
    source_system: config.sourceSystem,
    county_name: countyName,
    project_description: description,
    description,
    // Negative valuations (revisions/refunds) have no lexicon home; the raw value
    // stays in sourcePayload.row.
    estimated_job_value: (() => {
      const value = moneyValue(row[field(config, "estimatedValue")]);
      return value !== null && value >= 0 ? value : null;
    })(),
    fee: null,
    countyKey,
    jurisdictionKey: jurisdiction.key,
    sourceRecordId: permitNumber,
    sourceUrl: resourceUrl(config.baseUrl, dataset.id, {
      [field(config, "permitNumber")]: permitNumber,
    }),
    requestedParcelIdentifier,
    requestedPropertyId,
    workAddress: address && zipCode ? `${address} ${zipCode}` : address,
    isRoofPermit: /roof/i.test(
      `${permitType ?? ""} ${permitSubType ?? ""} ${description ?? ""}`,
    ),
    // LADBS open data publishes no contractor or contact fields.
    contractors: [],
    inspections: [],
    relatedRecords: [],
    sourcePayload: normalizeSourcePayload({
      dataset: { id: dataset.id, label: dataset.label },
      row: publicSourceRow(row),
      permitGroup,
      permitSubType,
      statusDate,
      statusDateUsedAsFinal: finaled,
      sourceParcelIdentifier,
      detailFingerprintVersion: config.detailFingerprintVersion,
    }),
  });
}

export function createSocrataAdapter(jurisdiction, options = {}) {
  const countyKey = options.countyKey ?? "los-angeles";
  const countyName = options.countyName ?? "Los Angeles";
  const config = configSchema.parse(jurisdiction.adapterConfig);
  const httpClient =
    options.client ??
    new PermitHttpClient({
      minimumDelayMs: config.minimumDelayMs,
      maxAttempts: options.maxAttempts ?? 4,
      timeoutMs: options.timeoutMs ?? 120_000,
    });

  async function rows(dataset, parameters) {
    const { body } = await httpClient.json(
      resourceUrl(config.baseUrl, dataset.id, parameters),
    );
    if (!Array.isArray(body)) {
      throw new PermitSourceError(
        `Socrata dataset ${dataset.id} returned a non-array response`,
        { classification: "transient", code: "socrata_bad_response" },
      );
    }
    return body;
  }

  async function count(dataset, where) {
    const body = await rows(dataset, {
      $select: "count(*) AS n",
      $where: where ?? null,
    });
    const n = Number(body[0]?.n ?? body[0]?.count);
    if (!Number.isInteger(n) || n < 0) {
      throw new PermitSourceError(
        `Socrata dataset ${dataset.id} did not return a valid count`,
        { classification: "permanent", code: "socrata_count_unavailable" },
      );
    }
    return n;
  }

  async function datasetVersion(dataset) {
    const { body } = await httpClient.json(viewUrl(config.baseUrl, dataset.id));
    return {
      id: dataset.id,
      rowsUpdatedAt: body?.rowsUpdatedAt ?? null,
      count: await count(dataset),
    };
  }

  async function snapshot() {
    const versions = [];
    for (const dataset of config.datasets) versions.push(await datasetVersion(dataset));
    return { versions, sha256: sha256Json(versions) };
  }

  function normalize(row, dataset, requestedParcelIdentifier, requestedPropertyId) {
    return normalizeSocrataPermitRow(row, {
      countyKey,
      countyName,
      jurisdiction,
      config,
      dataset,
      requestedParcelIdentifier,
      requestedPropertyId,
    });
  }

  async function searchParcel(parcelIdentifier, request = {}) {
    const parcel = linkableSocrataParcel(parcelIdentifier, config);
    if (!parcel) {
      throw new PermitSourceError(
        `Parcel identifier ${parcelIdentifier} is empty, partial or a placeholder`,
        { classification: "permanent", code: "socrata_unlinkable_parcel" },
      );
    }
    const where = `${field(config, "parcelIdentifier")} = ${soqlLiteral(parcel)}`;
    const references = [];
    const reconciliation = [];
    for (const dataset of config.datasets) {
      const reported = await count(dataset, where);
      const found = [];
      for (let offset = 0; ; offset += config.searchPageSize) {
        const page = await rows(dataset, {
          $where: where,
          $order: ":id",
          $limit: config.searchPageSize,
          $offset: offset,
        });
        found.push(...page);
        if (page.length < config.searchPageSize) break;
      }
      if (found.length !== reported) {
        throw new PermitSourceError(
          `Socrata ${dataset.id} parcel ${parcel}: count ${reported}, received ${found.length}`,
          { classification: "transient", code: "socrata_search_reconciliation_failed" },
        );
      }
      reconciliation.push({ dataset: dataset.id, reported, returned: found.length });
      for (const row of found) {
        references.push({
          row,
          dataset,
          requestedParcelIdentifier: parcel,
          requestedPropertyId: request.requestedPropertyId ?? null,
        });
      }
    }
    const numbers = references.map((ref) =>
      stringValue(ref.row[field(config, "permitNumber")]),
    );
    if (new Set(numbers).size !== numbers.length) {
      throw new PermitSourceError(
        `Socrata parcel ${parcel} returned a permit number more than once across datasets`,
        { classification: "permanent", code: "socrata_duplicate_permit" },
      );
    }
    return Object.assign(references, { reconciliation });
  }

  // Full download of every dataset, page by page in :id order, with resume
  // checkpoints. Completion is refused if any dataset's count or update stamp moved.
  async function enumerateAll({
    loadPageCheckpoint = async () => null,
    onPage = async () => {},
  } = {}) {
    const starting = await snapshot();
    let received = 0;
    let resumedPages = 0;
    let pageCount = 0;
    for (const [datasetIndex, dataset] of config.datasets.entries()) {
      const expected = starting.versions[datasetIndex].count;
      let datasetReceived = 0;
      for (let offset = 0; offset < expected; offset += config.bulkPageSize) {
        pageCount += 1;
        const pageKey = `${dataset.id}-page-${String(offset / config.bulkPageSize + 1).padStart(6, "0")}`;
        const pageIdentity = {
          pageKey,
          datasetId: dataset.id,
          offset,
          limit: config.bulkPageSize,
          snapshotSha256: starting.sha256,
        };
        const checkpoint = await loadPageCheckpoint(pageIdentity);
        const want = Math.min(config.bulkPageSize, expected - offset);
        if (
          checkpoint?.status === "complete" &&
          checkpoint.snapshotSha256 === starting.sha256 &&
          checkpoint.receivedCount === want
        ) {
          datasetReceived += want;
          resumedPages += 1;
          continue;
        }
        const page = await rows(dataset, {
          $order: ":id",
          $limit: config.bulkPageSize,
          $offset: offset,
        });
        if (page.length !== want) {
          throw new PermitSourceError(
            `Socrata ${pageKey}: expected ${want} rows, received ${page.length}`,
            { classification: "transient", code: "socrata_page_reconciliation_failed" },
          );
        }
        const records = [];
        const unlinked = [];
        for (const row of page) {
          const parcel = linkableSocrataParcel(
            row[field(config, "parcelIdentifier")],
            config,
          );
          if (parcel) records.push(normalize(row, dataset, parcel, null));
          else unlinked.push(normalize(row, dataset, "unlinked", null));
        }
        await onPage({
          ...pageIdentity,
          status: "complete",
          receivedCount: page.length,
          records,
          unlinked,
        });
        datasetReceived += page.length;
      }
      received += datasetReceived;
    }
    const ending = await snapshot();
    const expectedTotal = starting.versions.reduce((t, v) => t + v.count, 0);
    if (ending.sha256 !== starting.sha256 || received !== expectedTotal) {
      throw new PermitSourceError(
        "Socrata source changed during enumeration; completion is refused",
        { classification: "transient", code: "socrata_source_drift" },
      );
    }
    return {
      status: "complete",
      sourceCount: expectedTotal,
      receivedCount: received,
      pageCount,
      resumedPageCount: resumedPages,
      snapshotSha256: starting.sha256,
      datasets: starting.versions,
    };
  }

  return {
    key: "socrata",
    async probe() {
      const { versions } = await snapshot();
      return {
        status: "ready",
        ok: true,
        count: versions.reduce((t, v) => t + v.count, 0),
        datasets: versions,
        parcelSearch: true,
      };
    },
    searchParcel,
    async fetchPermitDetail(reference) {
      return normalize(
        reference.row,
        reference.dataset,
        reference.requestedParcelIdentifier,
        reference.requestedPropertyId,
      );
    },
    enumerateAll,
  };
}
