/**
 * Mortgage source documents: fetch each recorded document from the county portal and
 * stream it straight to S3 (no local copies), with a small index.json beside it.
 *
 * Layout: s3://<bucket>/documents/<ST>/<county>/<instrument>/document.pdf
 *         s3://<bucket>/documents/<ST>/<county>/<instrument>/index.json
 * A document whose index.json already exists with the same sha256 is skipped, so runs
 * resume. Credentials come from the AWS credential chain (AWS_PROFILE).
 *
 * @module src/mortgage/documents
 */

import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

import { createAcclaimSession } from "./acclaim.mjs";

export const HILLSBOROUGH_DOCUMENT_URL =
  "https://publicaccess.hillsclerk.com/Public/ORIUtilities/OverlayWatermark/api/Watermark/";

/**
 * @param {{ state: string, county: string, instrumentNumber: string }} record - Index record.
 * @returns {string} S3 key prefix for the record.
 */
export function documentPrefix(record) {
  const safe = String(record.instrumentNumber).replace(/[^A-Za-z0-9._-]/g, "_");
  return `documents/${record.state}/${record.county}/${safe}`;
}

/**
 * Read index records from a harvest run's windows directory.
 *
 * @param {string} windowsDir - <output>/<county>/<jobId>/windows.
 * @param {{ from?: string, to?: string }} [range] - Optional ISO date bounds on recordDate.
 * @returns {Promise<Record<string, any>[]>} Records, newest first.
 */
export async function readIndexRecords(windowsDir, range = {}) {
  const files = (await readdir(windowsDir)).filter((name) => name.endsWith(".jsonl"));
  const records = [];
  for (const file of files) {
    const text = await readFile(path.join(windowsDir, file), "utf8");
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      const record = JSON.parse(line);
      if (range.from && (record.recordDate ?? "") < range.from) continue;
      if (range.to && (record.recordDate ?? "") > range.to) continue;
      records.push(record);
    }
  }
  return records.sort((a, b) => String(b.recordDate).localeCompare(String(a.recordDate)));
}

/**
 * Document fetchers per vendor. Each returns { bytes, contentType, sourceUrl }.
 *
 * @param {string} vendor - Profile vendor.
 * @param {{ baseUrl: string, bookType?: string }} profile - County profile.
 * @param {{ fetchImpl?: typeof fetch }} [options]
 * @returns {(record: Record<string, any>) => Promise<{ bytes: Uint8Array, contentType: string, sourceUrl: string }>}
 *   Fetcher.
 */
export function documentFetcher(vendor, profile, options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  if (vendor === "acclaim") {
    const session = createAcclaimSession({ baseUrl: profile.baseUrl, bookType: profile.bookType, fetchImpl });
    return async (record) => {
      const details = await session.fetchDetails(String(record.instrumentNumber));
      const pdf = await session.fetchDocumentPdf(details.facts.transactionItemId);
      return { bytes: pdf.bytes, contentType: "application/pdf", sourceUrl: details.url };
    };
  }
  if (vendor === "hillsclerk-ori") {
    return async (record) => {
      const key = record.source?.documentKey;
      if (!key) throw new Error(`No document key for ${record.requestIdentifier}`);
      const url = `${HILLSBOROUGH_DOCUMENT_URL}${encodeURIComponent(key)}`;
      const response = await fetchImpl(url, { signal: AbortSignal.timeout(180_000) });
      if (!response.ok) throw new Error(`Hillsborough document returned HTTP ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (new TextDecoder().decode(bytes.subarray(0, 5)) !== "%PDF-") throw new Error("Hillsborough did not return a PDF");
      return { bytes, contentType: "application/pdf", sourceUrl: url };
    };
  }
  throw new Error(`No document fetcher for vendor ${vendor} yet`);
}

/**
 * Fetch documents for index records and store them in S3.
 *
 * @param {{
 *   records: Record<string, any>[],
 *   fetchDocument: (record: Record<string, any>) => Promise<{ bytes: Uint8Array, contentType: string, sourceUrl: string }>,
 *   s3: { send: (command: any) => Promise<any> },
 *   commands: { PutObjectCommand: any, GetObjectCommand: any },
 *   bucket: string,
 *   limit: number,
 *   delayMs?: number,
 *   now?: () => Date,
 *   onProgress?: (event: Record<string, unknown>) => void,
 * }} input - Run inputs.
 * @returns {Promise<{ stored: number, skipped: number, failed: number, bytes: number }>} Summary.
 */
export async function storeDocuments(input) {
  const now = input.now ?? (() => new Date());
  const delayMs = input.delayMs ?? 2_000;
  const counts = { stored: 0, skipped: 0, failed: 0, bytes: 0 };
  let requested = 0;
  for (const record of input.records.slice(0, input.limit)) {
    const prefix = documentPrefix(record);
    try {
      const existing = await input.s3
        .send(new input.commands.GetObjectCommand({ Bucket: input.bucket, Key: `${prefix}/index.json` }))
        .then(async (out) => JSON.parse(await out.Body.transformToString()))
        .catch(() => null);
      if (existing?.sha256) {
        counts.skipped += 1;
        continue;
      }
      if (requested > 0 && delayMs > 0) await new Promise((r) => setTimeout(r, delayMs));
      requested += 1;
      const started = Date.now();
      const document = await input.fetchDocument(record);
      const sha256 = createHash("sha256").update(document.bytes).digest("hex");
      const extension = document.contentType === "application/pdf" ? "pdf" : "bin";
      await input.s3.send(
        new input.commands.PutObjectCommand({
          Bucket: input.bucket,
          Key: `${prefix}/document.${extension}`,
          Body: document.bytes,
          ContentType: document.contentType,
          ChecksumSHA256: Buffer.from(sha256, "hex").toString("base64"),
        }),
      );
      const index = {
        requestIdentifier: record.requestIdentifier,
        county: record.county,
        state: record.state,
        instrumentNumber: record.instrumentNumber,
        recordDate: record.recordDate,
        docType: record.docType ?? null,
        sourceUrl: document.sourceUrl,
        objectKey: `${prefix}/document.${extension}`,
        contentType: document.contentType,
        bytes: document.bytes.byteLength,
        sha256,
        fetchSeconds: Math.round((Date.now() - started) / 100) / 10,
        storedAt: now().toISOString(),
      };
      await input.s3.send(
        new input.commands.PutObjectCommand({
          Bucket: input.bucket,
          Key: `${prefix}/index.json`,
          Body: JSON.stringify(index, null, 2),
          ContentType: "application/json",
        }),
      );
      counts.stored += 1;
      counts.bytes += document.bytes.byteLength;
      input.onProgress?.({ event: "document_stored", instrument: record.instrumentNumber, bytes: index.bytes, seconds: index.fetchSeconds });
    } catch (error) {
      counts.failed += 1;
      input.onProgress?.({ event: "document_failed", instrument: record.instrumentNumber, error: String(error?.message ?? error) });
    }
  }
  return counts;
}
