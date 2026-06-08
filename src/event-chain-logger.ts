import type { Pool } from 'pg';
import { ensureSchema, namespacePrefix, type RootEventOptions } from './schema';

// The genesis row's event_id (32 zero bytes); the root event is the unique
// row whose parent_id points at it.
const ZERO_HASH = Buffer.alloc(32);

/** A chain event id together with its payload, if the payload was stored. */
export interface ChainEvent {
  event_id: Buffer;
  /** The stored JSONB payload; omitted entirely if no payload was kept. */
  event_data?: unknown;
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
   * { "chain": "kukkuu", "ts": "<ISO 8601 UTC>", "foo": 1, "bar": [1, 2, 3] }.
   */
  rootExtraData?: Record<string, unknown> | null;

  /**
   * When true, omit the default "chain" and "ts" properties from the root
   * event; combined with no rootExtraData the root event becomes simply {}.
   * Has no effect on an already-initialized chain. Default: false.
   */
  rootOmitDefaultData?: boolean;
}

export interface RecordEventOptions {
  /**
   * When false, only the chain entry (hashes) is stored and the payload
   * itself is discarded. Default: true.
   */
  storePayload?: boolean;
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
  }

  /**
   * Ensures the schema: sha256() support (throws UnsupportedPostgresError on
   * PostgreSQL older than 11), chain tables (created if absent, verified —
   * never altered — if present; throws SchemaMismatchError on mismatch),
   * genesis row, stored functions, and — if the chain is empty — the chain's
   * root event (by default { "chain": "<random-uuid>", "ts": "<ISO 8601 UTC>" },
   * shaped by the rootExtraData / rootOmitDefaultData constructor options).
   * Finally the root event is re-verified server-side (canary; throws
   * ChainVerificationError), proving on every connect that this server
   * hashes the stored JSONB compatibly with the one that recorded it.
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
      ).catch((err) => {
        this.#initPromise = undefined; // allow retry after a failed init
        throw err;
      });
    }
    return this.#initPromise;
  }

  /**
   * Appends an event to the chain and returns its 32-byte event id.
   *
   * The payload is any JSON-serializable value. Note that PostgreSQL
   * normalizes JSONB (key order, whitespace, duplicate keys) before hashing;
   * see the README's verification notes.
   */
  async recordEvent(data: unknown, options: RecordEventOptions = {}): Promise<Buffer> {
    const json = JSON.stringify(data);
    if (json === undefined) {
      throw new TypeError('event data must be JSON-serializable (got undefined)');
    }
    await this.init();
    const res = await this.#pool.query(
      `SELECT ${this.#prefix}event_record($1::jsonb, $2) AS event_id`,
      [json, options.storePayload !== false],
    );
    return res.rows[0].event_id;
  }

  /**
   * Records a timestamp event { "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" } (current
   * time, ISO 8601 UTC) to the chain and returns its 32-byte event id.
   */
  async timestamp(): Promise<Buffer> {
    return this.recordEvent({ ts: new Date().toISOString() });
  }

  /**
   * Returns the chain's root event — the first event after genesis, carrying
   * the chain's identity. Resolves to `{ event_id }`, plus `event_data` (the
   * stored JSONB payload) when the payload was kept.
   *
   * Unlike the other accessors this does NOT initialize the chain: it reads
   * the existing state and throws an Error if the chain is uninitialized
   * (tables absent, or no root event recorded yet).
   */
  async getRootEvent(): Promise<ChainEvent> {
    let res;
    try {
      res = await this.#pool.query(
        `SELECT c.event_id, p.d AS event_data
           FROM ${this.#prefix}event_chain c
           LEFT JOIN ${this.#prefix}event_payload p ON p.event_id = c.event_id
          WHERE c.parent_id = $1`,
        [ZERO_HASH],
      );
    } catch (err) {
      // undefined_table — the chain tables don't exist yet.
      if ((err as { code?: string }).code === '42P01') {
        throw new Error('chain is not initialized (tables do not exist)');
      }
      throw err;
    }
    if (res.rowCount === 0) {
      throw new Error('chain is not initialized (no root event)');
    }
    const row = res.rows[0] as { event_id: Buffer; event_data: unknown };
    const event: ChainEvent = { event_id: row.event_id };
    if (row.event_data !== null) event.event_data = row.event_data;
    return event;
  }

  /**
   * Returns the chain head's 32-byte event id. If the head is not already an
   * empty checkpoint event, one is appended first — so repeated calls return
   * the same id instead of piling up empty events. On a virgin chain this is
   * the genesis id (32 zero bytes).
   */
  async getChainHead(): Promise<Buffer> {
    await this.init();
    const res = await this.#pool.query(
      `SELECT ${this.#prefix}event_head() AS event_id`,
    );
    return res.rows[0].event_id;
  }
}
