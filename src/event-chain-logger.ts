import type { Pool } from 'pg';
import {
  ensureSchema,
  namespacePrefix,
  runChainCheck,
  chainVerificationMessage,
  ChainNotInitializedError,
  ChainVerificationError,
  type RootEventOptions,
  type VerifyResult,
} from './schema';

// getEvents() never returns more than this many events in one call.
const MAX_EVENTS = 1000;

/** Which optional per-event fields {@link EventChainLogger.getEvents} includes. */
export interface GetEventsOptions {
  /**
   * Include `hashed_data`: the JSONB rendered as text (`jsonb::text`) — exactly
   * the string whose UTF-8 bytes were SHA-256'd into `data_hash`. Omitted for
   * events with no stored payload. Default false.
   */
  includeHashedData?: boolean;
  /** Include `data_hash` (hex). Always available, even for empty events. Default false. */
  includeDataHash?: boolean;
  /** Include `parent_id` (hex). Omitted for the genesis row (null parent). Default false. */
  includeParentId?: boolean;
  /**
   * Maximum events to return in this call. Must be a positive integer; values
   * greater than {@link MAX_EVENTS} (1000) are ignored (the 1000 cap applies).
   * Default: 1000.
   */
  maxEvents?: number;
}

/** One event as returned by {@link EventChainLogger.getEvents} (ids are hex). */
export interface ChainEventDetail {
  /**
   * The event's chain position — `event_chain.id` (genesis 0, root 1, …).
   * Always present; equals the event's index in the chain.
   */
  id: number;
  event_id: string;
  /** Stored JSONB payload; omitted if no payload was kept. */
  data?: unknown;
  /** Present only when requested via {@link GetEventsOptions.includeHashedData}. */
  hashed_data?: string;
  /** Present only when requested via {@link GetEventsOptions.includeDataHash}. */
  data_hash?: string;
  /** Present only when requested via {@link GetEventsOptions.includeParentId}. */
  parent_id?: string;
}

/** Result of {@link EventChainLogger.getEvents}: a page of events plus range info. */
export interface GetEventsResult {
  events: ChainEventDetail[];
  /** Index (= chain id) of the first returned event; `start - 1` if empty. */
  start: number;
  /** Index (= chain id) of the last returned event; `start - 1` if empty. */
  end: number;
  /** True if the requested range has more events than were returned; refetch from `end + 1`. */
  have_more: boolean;
}

export interface EventChainLoggerOptions {
  /**
   * Optional chain namespace, allowing multiple independent chains in the
   * same database. All tables and functions get the prefix `<namespace>_`
   * (e.g. `myapp_event_chain`). Must match /^[a-z][a-z0-9_]*$/ and be at
   * most 39 characters. Default: no prefix (bare names).
   */
  namespace?: string;

  /**
   * Plain object superimposed (Object.assign) on top of the default root
   * event data when the chain is empty and is being initialized. Keys
   * override the defaults. undefined/null have no effect. Has no effect on an
   * already-initialized (non-empty) chain. Must be undefined, null, or a plain
   * object (not an array).
   *
   * Example: { chain: "kukkuu", foo: 1, bar: [1, 2, 3] } yields the root event
   * { "type": "chain-root", "chain": "kukkuu", "ts": "<ISO 8601 UTC>",
   *   "foo": 1, "bar": [1, 2, 3] }.
   */
  rootExtraData?: Record<string, unknown> | null;

  /**
   * When true, omit the default "type", "chain" and "ts" properties from the
   * root event; combined with no rootExtraData the root event becomes simply
   * {}. Has no effect on an already-initialized chain. Default: false.
   */
  rootOmitDefaultData?: boolean;

  /**
   * When true, every `init()` re-verifies the *entire* chain server-side
   * (re-hashing and re-linking all events) instead of only the root event.
   * Throws `ChainVerificationError` on any mismatch. Stronger but heavier —
   * cost scales with chain length, so enable it where that trade-off is worth
   * it (e.g. on trusted-startup integrity checks). Default: false.
   */
  verifyChain?: boolean;
}

export interface RecordEventOptions {
  /**
   * When false, only the chain entry (hashes) is stored and the payload
   * itself is discarded. Default: true.
   */
  storePayload?: boolean;
  /**
   * When true, the call resolves to the full {@link ChainEventDetail} for the
   * new event (all fields populated) instead of just its `event_id` hex string.
   *
   * This is the only way to obtain the canonical `hashed_data` (the exact text
   * that was hashed) for an event recorded with `storePayload: false` — record
   * time is the only moment that text exists, since no `event_payload` row is
   * kept for later retrieval. Default: false.
   */
  returnFullEventData?: boolean;
}

/** Options for {@link EventChainLogger.verify}. */
export interface VerifyOptions {
  /**
   * When true, verify the entire chain (re-hash + re-link every event) instead
   * of only the root-event canary. Heavier (scales with chain length). Default: false.
   */
  full?: boolean;
  /**
   * When true (the default), an integrity mismatch throws `ChainVerificationError`.
   * When false, `verify` instead resolves to a `{ ok: false, … }` result so
   * audit/monitoring callers can branch on it. Operational failures (not
   * initialized, no `sha256()`, connection errors) always throw regardless.
   */
  throwOnMismatch?: boolean;
}

/**
 * Immutable SHA-256 hash-chained JSON event log on PostgreSQL.
 *
 * The constructor takes a pg Pool; the schema (tables, genesis row, stored
 * functions) is maintained automatically and idempotently on first use or
 * via an explicit {@link init} call. Existing chain tables are never
 * altered — only verified.
 */
export class EventChainLogger {
  readonly #pool: Pool;
  readonly #prefix: string;
  readonly #rootEventOptions: RootEventOptions;
  readonly #verifyChain: boolean;
  #initPromise: Promise<void> | undefined;

  constructor(pool: Pool, options: EventChainLoggerOptions = {}) {
    this.#pool = pool;
    this.#prefix = namespacePrefix(options.namespace); // throws on invalid namespace
    const { rootExtraData = null, rootOmitDefaultData = false } = options;
    if (
      rootExtraData !== null &&
      (typeof rootExtraData !== 'object' || Array.isArray(rootExtraData))
    ) {
      throw new TypeError(
        'rootExtraData must be undefined, null, or a plain object ' +
          `(got ${Array.isArray(rootExtraData) ? 'array' : typeof rootExtraData})`,
      );
    }
    this.#rootEventOptions = { rootExtraData, rootOmitDefaultData };
    this.#verifyChain = options.verifyChain === true;
  }

  /**
   * Ensures the schema: sha256() support (throws UnsupportedPostgresError on
   * PostgreSQL older than 11), chain tables (created if absent, verified —
   * never altered — if present; throws SchemaMismatchError on mismatch),
   * genesis row, stored functions, and — if the chain is empty — the chain's
   * root event (by default
   * { "type": "chain-root", "chain": "<random-uuid>", "ts": "<ISO 8601 UTC>" },
   * shaped by the rootExtraData / rootOmitDefaultData constructor options).
   * Finally a server-side canary re-verifies hashes (throws
   * ChainVerificationError), proving on every connect that this server hashes
   * the stored JSONB compatibly with the one that recorded it — the root event
   * only by default, or the entire chain when the `verifyChain` option is set.
   *
   * Idempotent and safe under concurrent startup of multiple processes
   * (serialized by a per-namespace advisory lock). Called lazily by
   * {@link recordEvent} and {@link getChainHead} if not called explicitly.
   */
  init(): Promise<void> {
    if (!this.#initPromise) {
      this.#initPromise = ensureSchema(
        this.#pool,
        this.#prefix,
        this.#rootEventOptions,
        this.#verifyChain,
      ).catch((err) => {
        this.#initPromise = undefined; // allow retry after a failed init
        throw err;
      });
    }
    return this.#initPromise;
  }

  /**
   * Appends an event to the chain.
   *
   * By default resolves to the new event's `event_id` as a lowercase hex
   * string. With `returnFullEventData: true` it resolves to the full
   * {@link ChainEventDetail} instead (all fields populated, including the
   * canonical `hashed_data` even when the payload is not stored).
   *
   * The payload is any JSON-serializable value. Note that PostgreSQL normalizes
   * JSONB (key order, whitespace, duplicate keys) before hashing; see the
   * README's verification notes. The returned `data` is that normalized value.
   */
  recordEvent(
    data: unknown,
    options?: RecordEventOptions & { returnFullEventData?: false },
  ): Promise<string>;
  recordEvent(
    data: unknown,
    options: RecordEventOptions & { returnFullEventData: true },
  ): Promise<ChainEventDetail>;
  async recordEvent(
    data: unknown,
    options: RecordEventOptions = {},
  ): Promise<string | ChainEventDetail> {
    const json = JSON.stringify(data);
    if (json === undefined) {
      throw new TypeError('event data must be JSON-serializable (got undefined)');
    }
    await this.init();
    const storePayload = options.storePayload !== false;

    if (options.returnFullEventData !== true) {
      const res = await this.#pool.query(
        `SELECT encode(${this.#prefix}event_record($1::jsonb, $2), 'hex') AS event_id`,
        [json, storePayload],
      );
      return res.rows[0].event_id as string;
    }

    // Record, then read back id/parent_id/data_hash for the (immutable) new row
    // by its event_id, deriving the canonical text + normalized value from the
    // input — so it works even when the payload is not stored. `($1::jsonb)::text`
    // is byte-identical to what event_record() hashed. (A single statement can't
    // do both: the function's INSERT isn't visible to that statement's snapshot.)
    const rec = await this.#pool.query(
      `SELECT encode(${this.#prefix}event_record($1::jsonb, $2), 'hex') AS event_id`,
      [json, storePayload],
    );
    const eventId = rec.rows[0].event_id as string;
    const res = await this.#pool.query(
      `SELECT c.id,
              encode(c.parent_id, 'hex') AS parent_id,
              encode(c.data_hash, 'hex') AS data_hash,
              ($1::jsonb)::text AS hashed_data,
              $1::jsonb AS data
         FROM ${this.#prefix}event_chain c WHERE c.event_id = $2`,
      [json, Buffer.from(eventId, 'hex')],
    );
    const row = res.rows[0];
    return {
      id: Number(row.id),
      event_id: eventId,
      parent_id: row.parent_id,
      data_hash: row.data_hash,
      hashed_data: row.hashed_data,
      data: row.data,
    };
  }

  /**
   * Records a timestamp event { "type": "ts", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
   * (current time, ISO 8601 UTC). Returns the event's `event_id` hex string, or
   * the full {@link ChainEventDetail} with `returnFullEventData: true`.
   */
  timestamp(options?: RecordEventOptions & { returnFullEventData?: false }): Promise<string>;
  timestamp(options: RecordEventOptions & { returnFullEventData: true }): Promise<ChainEventDetail>;
  async timestamp(options: RecordEventOptions = {}): Promise<string | ChainEventDetail> {
    return this.recordEvent(
      { type: 'ts', ts: new Date().toISOString() },
      options as RecordEventOptions & { returnFullEventData: true },
    );
  }

  /**
   * Returns the chain's root event (the first event after genesis, carrying the
   * chain's identity) as a {@link ChainEventDetail} — equivalent to
   * `getEvent(1, options)`.
   *
   * Unlike `getEvent`, this stays a "give me the root or fail" accessor: it
   * throws {@link ChainNotInitializedError} when no root event exists (tables
   * absent, or only the genesis row). It does NOT initialize the chain.
   */
  async getRootEvent(options?: GetEventsOptions): Promise<ChainEventDetail> {
    const root = await this.getEvent(1, options);
    if (root === null) {
      throw new ChainNotInitializedError('chain is not initialized (no root event)');
    }
    return root;
  }

  /**
   * Returns a page of events addressed by `Array.prototype.slice` semantics
   * over the chain, where the index equals the event's `id` (genesis is 0, the
   * root event 1, …). `getEvents()` / `getEvents(0)` mean "all events".
   *
   * Forms (the last argument may always be an `options` object):
   *   getEvents(), getEvents(start), getEvents(start, end),
   *   getEvents(options), getEvents(start, options), getEvents(start, end, options)
   *
   * `start`/`end` follow `slice`: negative counts from the end, `end` is
   * exclusive, an omitted/`null` `end` means "to the end". Non-integer numbers
   * throw `TypeError`.
   *
   * At most 1000 events are returned per call (or `options.maxEvents`, if
   * smaller); if the requested range holds more, that many are returned with
   * `have_more: true` and the caller continues from `result.end + 1`:
   *
   *   for (let x = await ec.getEvents(0); ; x = await ec.getEvents(x.end + 1)) {
   *     for (const ev of x.events) { ... }
   *     if (!x.have_more) break;
   *   }
   *
   * Like {@link getRootEvent} this does NOT initialize the chain; it throws if
   * the chain is uninitialized.
   */
  async getEvents(
    start?: number | GetEventsOptions,
    end?: number | null | GetEventsOptions,
    options?: GetEventsOptions,
  ): Promise<GetEventsResult> {
    // The last object-typed argument is `options`; the rest are indices.
    const isOpts = (v: unknown): v is GetEventsOptions =>
      v !== null && typeof v === 'object';
    let startIdx: number | undefined;
    let endIdx: number | null | undefined;
    let opts: GetEventsOptions;
    if (isOpts(options)) {
      opts = options;
      startIdx = start as number | undefined;
      endIdx = end as number | null | undefined;
    } else if (isOpts(end)) {
      opts = end;
      startIdx = start as number | undefined;
      endIdx = undefined;
    } else if (isOpts(start)) {
      opts = start;
      startIdx = undefined;
      endIdx = undefined;
    } else {
      opts = {};
      startIdx = start;
      endIdx = end;
    }

    const checkIndex = (v: unknown, name: string): number | undefined => {
      if (v === undefined || v === null) return undefined; // null end => "to the end"
      if (typeof v !== 'number' || !Number.isInteger(v)) {
        throw new TypeError(`${name} must be an integer or omitted (got ${String(v)})`);
      }
      return v;
    };
    const s0 = checkIndex(startIdx, 'start');
    const e0 = checkIndex(endIdx, 'end');

    // Per-call cap: opts.maxEvents (a positive integer) clamped to MAX_EVENTS.
    if (
      opts.maxEvents !== undefined &&
      (typeof opts.maxEvents !== 'number' || !Number.isInteger(opts.maxEvents) || opts.maxEvents < 1)
    ) {
      throw new TypeError(
        `maxEvents must be a positive integer (got ${String(opts.maxEvents)})`,
      );
    }
    const cap =
      opts.maxEvents === undefined ? MAX_EVENTS : Math.min(opts.maxEvents, MAX_EVENTS);

    // Chain length (= max id + 1). Throws if uninitialized, like getRootEvent.
    let maxRes;
    try {
      maxRes = await this.#pool.query(
        `SELECT max(id) AS max FROM ${this.#prefix}event_chain`,
      );
    } catch (err) {
      if ((err as { code?: string }).code === '42P01') {
        throw new ChainNotInitializedError('chain is not initialized (tables do not exist)');
      }
      throw err;
    }
    if (maxRes.rows[0].max === null) {
      throw new ChainNotInitializedError('chain is not initialized (no genesis row)');
    }
    const len = Number(maxRes.rows[0].max) + 1;

    // Resolve slice() indices against [0, len).
    const clamp = (v: number): number =>
      v < 0 ? Math.max(len + v, 0) : Math.min(v, len);
    const s = s0 === undefined ? 0 : clamp(s0);
    let e = e0 === undefined ? len : clamp(e0);
    if (e < s) e = s;

    if (s >= e) {
      return { events: [], start: s, end: s - 1, have_more: false };
    }

    const limit = Math.min(e - s, cap);
    const res = await this.#pool.query(
      `SELECT c.id,
              encode(c.event_id, 'hex') AS event_id,
              encode(c.parent_id, 'hex') AS parent_id,
              encode(c.data_hash, 'hex') AS data_hash,
              p.d AS data,
              p.d::text AS hashed_data
         FROM ${this.#prefix}event_chain c
         LEFT JOIN ${this.#prefix}event_payload p ON p.event_id = c.event_id
        WHERE c.id >= $1 AND c.id < $2
        ORDER BY c.id
        LIMIT $3`,
      [s, e, limit],
    );

    const inclHashed = opts.includeHashedData === true;
    const inclHash = opts.includeDataHash === true;
    const inclParent = opts.includeParentId === true;
    const events: ChainEventDetail[] = res.rows.map((row) => {
      const ev: ChainEventDetail = { id: Number(row.id), event_id: row.event_id };
      if (row.data !== null) ev.data = row.data;
      if (inclParent && row.parent_id !== null) ev.parent_id = row.parent_id;
      if (inclHash) ev.data_hash = row.data_hash;
      if (inclHashed && row.hashed_data !== null) ev.hashed_data = row.hashed_data;
      return ev;
    });

    const startOut = Number(res.rows[0].id);
    const endOut = Number(res.rows[res.rows.length - 1].id);
    return { events, start: startOut, end: endOut, have_more: endOut + 1 < e };
  }

  /**
   * Returns a single event by its `id` (chain position), as a
   * {@link ChainEventDetail}, or `null` if no such event exists.
   *
   * A thin wrapper over {@link getEvents} with `slice`-style indexing, so it
   * inherits negative indexing: `getEvent(-1)` is the last event (a
   * non-mutating head peek, unlike {@link getChainHead}), `getEvent(0)` the
   * genesis row, `getEvent(1)` the root. Out-of-range ids resolve to `null`.
   * Does NOT initialize the chain (throws {@link ChainNotInitializedError} when
   * uninitialized, via `getEvents`).
   */
  async getEvent(id: number, options?: GetEventsOptions): Promise<ChainEventDetail | null> {
    if (!Number.isInteger(id)) {
      throw new TypeError(`id must be an integer (got ${String(id)})`);
    }
    // `id + 1` as the exclusive end picks exactly index `id`; but for `id === -1`
    // that end would be 0 (an empty slice), so use "to the end" there.
    const end = id === -1 ? undefined : id + 1;
    const page = await this.getEvents(id, end, options);
    return page.events[0] ?? null;
  }

  /**
   * Returns the chain head's event id as a lowercase hex string. If the head is
   * not already an empty checkpoint event, one is appended first — so repeated
   * calls return the same id instead of piling up empty events. On a virgin
   * chain this is the genesis id (64 zero hex chars). Mutating: for a read-only
   * peek at the current tip, use {@link getEvent}(-1) instead.
   */
  async getChainHead(): Promise<string> {
    await this.init();
    const res = await this.#pool.query(
      `SELECT encode(${this.#prefix}event_head(), 'hex') AS event_id`,
    );
    return res.rows[0].event_id as string;
  }

  /**
   * Verifies chain integrity server-side, on demand (the same check `init()`
   * runs): the root-event canary by default, or the entire chain with
   * `{ full: true }`. Resolves to a {@link VerifyResult}.
   *
   * On an integrity mismatch it throws {@link ChainVerificationError} by default;
   * pass `{ throwOnMismatch: false }` to instead resolve to `{ ok: false, … }`.
   * Operational failures always throw: {@link ChainNotInitializedError} if the
   * chain doesn't exist, plus connection / `sha256()`-support errors. Does NOT
   * initialize the chain.
   */
  async verify(options: VerifyOptions = {}): Promise<VerifyResult> {
    const result = await runChainCheck(this.#pool, this.#prefix, options.full === true);
    if (!result.ok && options.throwOnMismatch !== false) {
      throw new ChainVerificationError(chainVerificationMessage(this.#prefix, result));
    }
    return result;
  }
}
