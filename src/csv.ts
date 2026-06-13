// Canonical CSV export/parse for a tr-json-chain.
//
// The chain's CSV export format is a shared boundary between this library and
// its tooling (the CLI's `/export`, the standalone integrity checker). These
// two classes make the library the owner of that format: `EventChainCsvExport`
// renders `getEvents()` results to CSV rows, `EventChainCsvParse` reads them
// back (optionally re-verifying every hash and link from the spec).
//
// Pure module: the only dependency is `node:crypto` (used solely when a parser
// verification flag is enabled). No `pg`, no I/O — callers own files/streams.
//
// Format (semicolon-delimited, RFC-4180 quoting):
//   #;event_id;parent_id;data_hash;data
// `#` is the event's `event_chain.id` (genesis 0 excluded; contiguous, +1 per
// row). `event_id`/`parent_id`/`data_hash` are 64 lowercase hex chars. `data`
// is the canonical payload text (`jsonb::text`, the exact bytes hashed), quoted;
// an empty cell means no payload was stored, and the whole `data` column may be
// absent (4-column header) when no event in the file carries a payload.
//
// Invariant that makes line-based parsing safe: `jsonb::text` never contains a
// raw newline (JSON escapes them), so one event is always exactly one line.

import { createHash } from 'node:crypto';
import type { ChainEventDetail } from './event-chain-logger';

const DELIM = ';';
const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_HEX = '0'.repeat(64);
const REQUIRED_HEADER = ['#', 'event_id', 'parent_id', 'data_hash'];
const DATA_HEADER = 'data';

/** SHA-256 over the concatenated buffers, lowercase hex (matches PostgreSQL's `encode(sha256(...),'hex')`). */
function sha256hex(...bufs: Buffer[]): string {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest('hex');
}

/** RFC-4180 field: wrap in double quotes, doubling any internal quote. */
function csvQuoteField(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

/**
 * Tokenizes a single physical CSV line into its fields (`;` delimiter, `"`-quoted
 * fields with `""` escaping). A trailing `\r`/`\n` ends the line. Throws on an
 * unterminated quoted field.
 */
function csvParseLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else {
        field += c;
      }
      continue;
    }
    if (c === '"') inQuotes = true;
    else if (c === DELIM) { fields.push(field); field = ''; }
    else if (c === '\n' || c === '\r') break; // end of the physical line
    else field += c;
  }
  if (inQuotes) throw new Error('malformed CSV line: unterminated quoted field');
  fields.push(field);
  return fields;
}

function requireHex64(name: string, val: unknown, optionHint?: string): asserts val is string {
  if (val === undefined) {
    const hint = optionHint ? ` — fetch events with getEvents({ ${optionHint}: true })` : '';
    throw new TypeError(`event.${name} is required${hint}`);
  }
  if (typeof val !== 'string' || !HEX64.test(val)) {
    throw new TypeError(`event.${name} must be 64 lowercase hex chars (got ${JSON.stringify(val)})`);
  }
}

/**
 * Renders chain events (as returned by {@link EventChainLogger.getEvents}) to
 * CSV rows. Stateless — `header()` and `event()` may be called in any order.
 *
 * Events must be fetched with `includeParentId`, `includeDataHash` and
 * `includeHashedData` so every column is available; the genesis row (id 0) is
 * not exportable and is rejected.
 */
export class EventChainCsvExport {
  /** The CSV header row (no trailing newline). */
  header(): string {
    return [...REQUIRED_HEADER, DATA_HEADER].join(DELIM);
  }

  /**
   * Renders one event to a CSV row (no trailing newline). Requires `id` (>= 1),
   * `event_id`, `parent_id` and `data_hash`; `hashed_data` becomes the (quoted)
   * `data` cell, or an empty cell when the event has no stored payload. Throws
   * `TypeError` on the genesis row or a missing/invalid field.
   */
  event(ev: ChainEventDetail): string {
    if (ev === null || typeof ev !== 'object') {
      throw new TypeError('event must be an object');
    }
    const { id, event_id, parent_id, data_hash, hashed_data } = ev;
    if (!Number.isInteger(id)) {
      throw new TypeError(`event.id must be an integer (got ${String(id)})`);
    }
    if (id === 0) throw new TypeError('genesis row (id 0) is not exportable');
    if (id < 0) throw new TypeError(`event.id must be >= 1 (got ${id})`);
    requireHex64('event_id', event_id);
    requireHex64('parent_id', parent_id, 'includeParentId');
    requireHex64('data_hash', data_hash, 'includeDataHash');

    let dataCell = '';
    if (hashed_data !== undefined) {
      if (typeof hashed_data !== 'string') {
        throw new TypeError('event.hashed_data must be a string when present');
      }
      dataCell = csvQuoteField(hashed_data);
    }
    return [id, event_id, parent_id, data_hash, dataCell].join(DELIM);
  }
}

/** Options for {@link EventChainCsvParse}; every verification layer is opt-in. */
export interface EventChainCsvParseOptions {
  /**
   * Re-derive and check hashes per row: `data_hash == SHA256(utf8(data))` (when a
   * payload is present) and `event_id == SHA256(parent_id ‖ data_hash)`. A
   * mismatch throws. Costs one or two SHA-256 hashes per row. Default false.
   */
  verifyHashes?: boolean;
  /**
   * Check chain linkage: `#` is contiguous (+1), each `parent_id` equals the
   * previous row's `event_id`, the root row (`#1`) has an all-zero parent and a
   * partial-chain start (`# > 1`) has a non-zero parent. A violation throws.
   * Default false.
   */
  verifyLinks?: boolean;
  /**
   * Require the file to be a complete chain: the first parsed row must be the
   * root event (`#1`). Rejects partial slices. Only meaningful alongside
   * `verifyLinks` (which checks the root's all-zero parent); enabling it without
   * `verifyLinks` throws from the constructor. Default false.
   */
  verifyRoot?: boolean;
  /**
   * Also `JSON.parse` the canonical payload text into the returned row's `data`
   * field (in addition to the verbatim `hashed_data`). Default false.
   */
  parseData?: boolean;
}

/** One row as returned by {@link EventChainCsvParse.row} (mirrors the encoder's input). */
export interface ParsedRow {
  id: number;
  event_id: string;
  parent_id: string;
  data_hash: string;
  /** The verbatim canonical payload text; omitted when the event has no stored payload. */
  hashed_data?: string;
  /** `JSON.parse(hashed_data)`; present only when `parseData` is set and a payload exists. */
  data?: unknown;
}

/** Summary returned by {@link EventChainCsvParse.end}. */
export interface CsvParseSummary {
  /** Rows parsed. */
  count: number;
  /** Rows that carried a payload (non-empty `data` cell). */
  payloadPresent: number;
  /** Rows with a real (non-zero) `data_hash` — the denominator for payload coverage. */
  realEvents: number;
  /** True when the file is a partial chain (its first row's `#` was not 1). */
  partial: boolean;
  /** The `#` of the last row parsed, or null if no rows were parsed. */
  lastEventId: number | null;
}

/**
 * Parses a tr-json-chain CSV export one row at a time. Construct with the header
 * row, feed each subsequent (non-blank) physical line to {@link row}, then call
 * {@link end} for a summary. By default `row()` only parses and validates field
 * formats; pass `verifyHashes` / `verifyLinks` (and optionally `verifyRoot`) to
 * make it a verifier.
 */
export class EventChainCsvParse {
  readonly #hasDataColumn: boolean;
  readonly #verifyHashes: boolean;
  readonly #verifyLinks: boolean;
  readonly #verifyRoot: boolean;
  readonly #parseData: boolean;
  #ended = false;
  #started = false;
  #partial = false;
  #count = 0;
  #payloadPresent = 0;
  #realEvents = 0;
  #prevId: number | null = null;
  #prevEventId: string | null = null;

  constructor(headerRow: string, options: EventChainCsvParseOptions = {}) {
    const f = csvParseLine(headerRow);
    const matchesRequired = REQUIRED_HEADER.every((c, i) => f[i] === c);
    const ok4 = f.length === 4 && matchesRequired;
    const ok5 = f.length === 5 && matchesRequired && f[4] === DATA_HEADER;
    if (!ok4 && !ok5) {
      throw new Error(
        `bad CSV header: expected "${REQUIRED_HEADER.join(DELIM)}[${DELIM}${DATA_HEADER}]", ` +
          `got ${JSON.stringify(headerRow)}`,
      );
    }
    this.#hasDataColumn = ok5;
    this.#verifyHashes = options.verifyHashes === true;
    this.#verifyLinks = options.verifyLinks === true;
    this.#verifyRoot = options.verifyRoot === true;
    this.#parseData = options.parseData === true;
    if (this.#verifyRoot && !this.#verifyLinks) {
      throw new Error('verifyRoot requires verifyLinks to also be enabled');
    }
  }

  /** True when the file is a partial chain (first row's `#` was not 1). Set after the first {@link row}. */
  get partial(): boolean {
    return this.#partial;
  }

  /**
   * Parses one CSV row (one physical line, blank lines must be filtered by the
   * caller). Returns a {@link ParsedRow}. Throws on a malformed row, or — when
   * the corresponding option is set — on a hash or chain-link violation. Throws
   * if called after {@link end}.
   */
  row(line: string): ParsedRow {
    if (this.#ended) throw new Error('parser has ended; no more rows accepted');
    const f = csvParseLine(line);
    if (f.length < 4) throw new Error(`CSV row has too few columns (${f.length}; expected >= 4)`);
    const numStr = f[0] ?? '';
    const event_id = f[1] ?? '';
    const parent_id = f[2] ?? '';
    const data_hash = f[3] ?? '';
    const data = this.#hasDataColumn ? (f[4] ?? '') : '';

    if (!/^\d+$/.test(numStr)) {
      throw new Error(`# is not a non-negative integer: ${JSON.stringify(numStr)}`);
    }
    const id = Number(numStr);
    if (!HEX64.test(event_id)) throw new Error(`row #${id}: event_id is not 64 lowercase hex chars`);
    if (!HEX64.test(parent_id)) throw new Error(`row #${id}: parent_id is not 64 lowercase hex chars`);
    if (!HEX64.test(data_hash)) throw new Error(`row #${id}: data_hash is not 64 lowercase hex chars`);

    const first = !this.#started;
    if (first && id !== 1) this.#partial = true;

    if (this.#verifyRoot && first && id !== 1) {
      throw new Error(`row #${id}: verifyRoot requires the first row to be the root event (#1)`);
    }

    if (this.#verifyLinks) {
      if (first) {
        if (id === 1) {
          if (parent_id !== ZERO_HEX) throw new Error(`row #${id}: root event must have an all-zero parent_id`);
        } else if (parent_id === ZERO_HEX) {
          throw new Error(`row #${id}: a non-root start must not have an all-zero parent_id`);
        }
      } else {
        if (id !== (this.#prevId as number) + 1) {
          throw new Error(`row #${id}: non-contiguous (previous was #${this.#prevId})`);
        }
        if (parent_id !== this.#prevEventId) {
          throw new Error(`row #${id}: parent_id does not match the previous event_id`);
        }
      }
    }

    if (this.#verifyHashes) {
      if (data !== '' && sha256hex(Buffer.from(data, 'utf8')) !== data_hash) {
        throw new Error(`row #${id}: data does not hash to data_hash`);
      }
      if (sha256hex(Buffer.from(parent_id, 'hex'), Buffer.from(data_hash, 'hex')) !== event_id) {
        throw new Error(`row #${id}: event_id != SHA256(parent_id || data_hash)`);
      }
    }

    this.#count++;
    if (data !== '') this.#payloadPresent++;
    if (data_hash !== ZERO_HEX) this.#realEvents++;
    this.#prevId = id;
    this.#prevEventId = event_id;
    this.#started = true;

    const out: ParsedRow = { id, event_id, parent_id, data_hash };
    if (data !== '') {
      out.hashed_data = data;
      if (this.#parseData) out.data = JSON.parse(data);
    }
    return out;
  }

  /**
   * Finalizes parsing and returns a {@link CsvParseSummary}. After `end()` any
   * further {@link row} call throws. The parser holds no external resources, so
   * it may also simply be abandoned without calling `end()`.
   */
  end(): CsvParseSummary {
    this.#ended = true;
    return {
      count: this.#count,
      payloadPresent: this.#payloadPresent,
      realEvents: this.#realEvents,
      partial: this.#partial,
      lastEventId: this.#prevId,
    };
  }
}
