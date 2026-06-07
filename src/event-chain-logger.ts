import type { Pool } from 'pg';
import { ensureSchema, namespacePrefix } from './schema';

export interface EventChainLoggerOptions {
  /**
   * Optional chain namespace, allowing multiple independent chains in the
   * same database. All tables and functions get the prefix `<namespace>_`
   * (e.g. `myapp_event_chain`). Must match /^[a-z][a-z0-9_]*$/ and be at
   * most 39 characters. Default: no prefix (bare names).
   */
  namespace?: string;
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
  #initPromise: Promise<void> | undefined;

  constructor(pool: Pool, options: EventChainLoggerOptions = {}) {
    this.#pool = pool;
    this.#prefix = namespacePrefix(options.namespace); // throws on invalid namespace
  }

  /**
   * Ensures the schema: sha256() support (throws UnsupportedPostgresError on
   * PostgreSQL older than 11), chain tables (created if absent, verified —
   * never altered — if present; throws SchemaMismatchError on mismatch),
   * genesis row, stored functions, and — if the chain is empty — the chain's
   * root event: { "chain": "<random-uuid>", "ts": "<ISO 8601 UTC>" }.
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
      this.#initPromise = ensureSchema(this.#pool, this.#prefix).catch((err) => {
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
