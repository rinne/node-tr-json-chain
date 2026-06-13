import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { TABLES_SQL, FUNCTIONS_SQL } from './generated/sql';

/**
 * Thrown when a pre-existing table does not match the shape this module
 * expects. The module never alters or drops existing tables; resolving a
 * mismatch is up to the operator.
 */
export class SchemaMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaMismatchError';
  }
}

/**
 * Thrown when the PostgreSQL server lacks the built-in sha256() function
 * (i.e. is older than PostgreSQL 11).
 */
export class UnsupportedPostgresError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnsupportedPostgresError';
  }
}

/**
 * Thrown when the chain's root event fails hash re-verification at init.
 * Either the root event's data was tampered with, or this PostgreSQL server
 * renders/hashes JSONB incompatibly with the server that recorded it (e.g.
 * a hypothetical jsonb::text rendering change across a major upgrade).
 */
export class ChainVerificationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainVerificationError';
  }
}

/**
 * Thrown by the read accessors (`getEvents`, `getEvent`, `getRootEvent`,
 * `verify`) when the chain has not been initialized — the tables do not exist,
 * or (for `getRootEvent`) no root event has been recorded yet. These accessors
 * deliberately do not create the schema; call `init()` (or any write) first.
 */
export class ChainNotInitializedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ChainNotInitializedError';
  }
}

/** Result of an integrity check (see {@link runChainCheck} / `EventChainLogger.verify`). */
export interface VerifyResult {
  /** True when no integrity problem was found. */
  ok: boolean;
  /** Which check ran: the root-event canary, or the whole chain. */
  mode: 'root' | 'full';
  /** How many events the check examined (root: 0 or 1; full: the chain length). */
  eventsChecked: number;
  /** The `id` of the first offending event, when `ok` is false. */
  firstBadId?: number;
  /** The offending events (capped), with the failed checks, when `ok` is false. */
  offending?: { id: number; reasons: string[] }[];
}

const NAMESPACE_RE = /^[a-z][a-z0-9_]*$/;

// Longest generated identifier suffix is "event_chain_one_genesis" (23 chars);
// with the joining "_" the namespace may use at most 63 - 23 - 1 = 39 chars
// before PostgreSQL would silently truncate identifiers.
const NAMESPACE_MAX_LENGTH = 63 - 'event_chain_one_genesis'.length - 1;

/**
 * Validates a namespace and returns the identifier prefix ("" or "<ns>_").
 *
 * The namespace is interpolated into DDL, so this validation is the
 * injection guard: reject, never quote or escape around it.
 */
export function namespacePrefix(namespace?: string): string {
  if (namespace === undefined || namespace === '') return '';
  if (typeof namespace !== 'string' || !NAMESPACE_RE.test(namespace)) {
    throw new TypeError(
      `invalid namespace ${JSON.stringify(namespace)}: must match ${NAMESPACE_RE}`,
    );
  }
  if (namespace.length > NAMESPACE_MAX_LENGTH) {
    throw new TypeError(
      `invalid namespace: at most ${NAMESPACE_MAX_LENGTH} characters allowed ` +
        `(got ${namespace.length})`,
    );
  }
  return `${namespace}_`;
}

function expand(sql: string, prefix: string): string {
  return sql.replace(/\{\{ns\}\}/g, prefix);
}

// Per-namespace advisory lock key so concurrent init of different chains
// doesn't serialize. Derived deterministically from the prefix.
function advisoryLockKey(prefix: string): bigint {
  return createHash('sha256')
    .update(`tr-json-chain:${prefix}`)
    .digest()
    .readBigInt64BE(0);
}

interface ExpectedColumn {
  name: string;
  dataType: string;
  nullable: boolean;
}

// The frozen shape of the chain tables (see sql/tables.sql). Pre-existing
// tables are verified against this; any mismatch is a hard error.
const EXPECTED_TABLES: ReadonlyArray<[string, ReadonlyArray<ExpectedColumn>]> = [
  [
    'event_chain',
    [
      { name: 'id', dataType: 'bigint', nullable: false },
      { name: 'parent_id', dataType: 'bytea', nullable: true },
      { name: 'data_hash', dataType: 'bytea', nullable: false },
      { name: 'event_id', dataType: 'bytea', nullable: false },
    ],
  ],
  [
    'event_payload',
    [
      { name: 'event_id', dataType: 'bytea', nullable: false },
      { name: 'ts', dataType: 'timestamp with time zone', nullable: false },
      { name: 'd', dataType: 'jsonb', nullable: false },
    ],
  ],
];

const ZERO_HASH = Buffer.alloc(32);

// sha256(bytea) is a core function since PostgreSQL 11 (pgcrypto is NOT
// needed — it only provides digest()). Probe it so that an unsupported
// server fails init with a clear error instead of a cryptic one later.
async function ensureSha256(client: PoolClient): Promise<void> {
  try {
    await client.query(`SELECT sha256(''::bytea)`);
  } catch (cause) {
    throw new UnsupportedPostgresError(
      'this PostgreSQL server lacks the built-in sha256() function; ' +
        'PostgreSQL 11 or newer is required',
      { cause },
    );
  }
}

/**
 * Verifies that any pre-existing chain tables match the frozen shape.
 * Runs BEFORE the bootstrap DDL so that a wrong table fails with a clear
 * error instead of a confusing one from the genesis insert.
 */
async function verifyTableShapes(client: PoolClient, prefix: string): Promise<void> {
  const names = EXPECTED_TABLES.map(([t]) => `${prefix}${t}`);
  const res = await client.query(
    `SELECT table_name, column_name, data_type, is_nullable
       FROM information_schema.columns
      WHERE table_schema = current_schema() AND table_name = ANY($1)
      ORDER BY table_name, ordinal_position`,
    [names],
  );
  const actual = new Map<string, { column_name: string; data_type: string; is_nullable: string }[]>();
  for (const row of res.rows) {
    const cols = actual.get(row.table_name) ?? [];
    cols.push(row);
    actual.set(row.table_name, cols);
  }

  for (const [table, expected] of EXPECTED_TABLES) {
    const name = `${prefix}${table}`;
    const cols = actual.get(name);
    if (!cols) continue; // Absent: bootstrap DDL will create it.
    const got = cols.map(
      (c) => `${c.column_name} ${c.data_type}${c.is_nullable === 'YES' ? '' : ' not null'}`,
    );
    const want = expected.map(
      (c) => `${c.name} ${c.dataType}${c.nullable ? '' : ' not null'}`,
    );
    if (got.join(', ') !== want.join(', ')) {
      throw new SchemaMismatchError(
        `existing table "${name}" does not match the expected shape and will ` +
          `not be touched.\n  expected: ${want.join(', ')}\n  found:    ${got.join(', ')}`,
      );
    }
  }
}

/**
 * Verifies the genesis row: exactly one root, at id 0, with all-zero hashes.
 *
 * The id 0 requirement is part of the chain's addressing contract since 0.4.0
 * (dense, 0-based ids). Chains created by pre-0.4.0 versions used a serial id
 * starting at 1 and are intentionally rejected here — they are not compatible.
 */
async function verifyGenesis(client: PoolClient, prefix: string): Promise<void> {
  const res = await client.query(
    `SELECT id, data_hash, event_id FROM ${prefix}event_chain WHERE parent_id IS NULL`,
  );
  if (res.rowCount !== 1) {
    throw new SchemaMismatchError(
      `table "${prefix}event_chain" has ${res.rowCount} genesis rows, expected exactly 1`,
    );
  }
  const row = res.rows[0] as { id: string; data_hash: Buffer; event_id: Buffer };
  if (!ZERO_HASH.equals(row.data_hash) || !ZERO_HASH.equals(row.event_id)) {
    throw new SchemaMismatchError(
      `genesis row of "${prefix}event_chain" does not have all-zero hashes`,
    );
  }
  // pg returns bigint as a string.
  if (String(row.id) !== '0') {
    throw new SchemaMismatchError(
      `genesis row of "${prefix}event_chain" has id ${row.id}, expected 0 ` +
        '(chains created before 0.4.0 are not compatible)',
    );
  }
}

/**
 * Options controlling the content of the chain's root event.
 * Both only take effect when the chain is empty and a root event is being
 * recorded; on a non-empty chain they are ignored.
 */
export interface RootEventOptions {
  /**
   * A plain object superimposed (Object.assign) on top of the default root
   * event data. undefined/null have no effect. Keys override the defaults.
   */
  rootExtraData?: Record<string, unknown> | null;
  /**
   * When true, omit the default "chain" and "ts" properties; with no
   * rootExtraData the root event becomes simply {}. Default: false.
   */
  rootOmitDefaultData?: boolean;
}

/**
 * Records the chain's root event if (and only if) the chain is empty, i.e.
 * holds nothing beyond the genesis row. By default:
 *
 *   { "type": "chain-root", "chain": "<random-uuid>", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
 *
 * The UUID gives the chain a unique identity; "ts" (ISO 8601 UTC) is also
 * the conventional timestamp property for subsequent events. The defaults
 * may be omitted (`rootOmitDefaultData`) and/or extended/overridden
 * (`rootExtraData`). Idempotent under concurrency: the caller holds the
 * per-namespace advisory lock, and the NOT EXISTS guard makes the statement
 * a no-op on any non-empty chain.
 */
async function ensureRootEvent(
  client: PoolClient,
  prefix: string,
  options: RootEventOptions,
): Promise<void> {
  const base: Record<string, unknown> = options.rootOmitDefaultData
    ? {}
    : { type: 'chain-root', chain: randomUUID(), ts: new Date().toISOString() };
  const root =
    options.rootExtraData != null
      ? Object.assign(base, options.rootExtraData)
      : base;
  await client.query(
    `SELECT ${prefix}event_record($1::jsonb)
      WHERE NOT EXISTS
        (SELECT 1 FROM ${prefix}event_chain WHERE parent_id IS NOT NULL)`,
    [JSON.stringify(root)],
  );
}

// Minimal queryable shared by a Pool and a PoolClient — so the checks below run
// both inside init's transaction (client) and standalone for verify() (pool).
type Queryable = Pick<Pool, 'query'>;

const FULL_CHAIN_OFFENDING_LIMIT = 5;

/** Maps a pg "undefined_table" (42P01) into ChainNotInitializedError. */
function asNotInitialized(err: unknown): never {
  if ((err as { code?: string }).code === '42P01') {
    throw new ChainNotInitializedError('chain is not initialized (tables do not exist)');
  }
  throw err;
}

/**
 * Root-event canary: re-hashes the root event server-side with the very
 * expressions event_record() uses, returning a structured {@link VerifyResult}.
 *
 * Chain *links* are immune to server upgrades (they hash stored bytes), but
 * re-verifying a *payload* depends on jsonb::text rendering being stable across
 * PostgreSQL versions — byte-stable since 9.4 and de facto frozen, but not
 * formally guaranteed. This proves, cheaply, that the current server still
 * renders and hashes JSONB exactly as the recorder did, and detects tampering.
 */
async function runRootCheck(q: Queryable, prefix: string): Promise<VerifyResult> {
  let res;
  try {
    res = await q.query(
      `SELECT c.id,
              (c.data_hash = sha256(convert_to(p.d::text, 'UTF8'))) AS payload_ok,
              (c.event_id = sha256(c.parent_id || c.data_hash)) AS link_ok
         FROM ${prefix}event_chain c JOIN ${prefix}event_payload p USING (event_id)
        WHERE c.parent_id = $1`,
      [ZERO_HASH],
    );
  } catch (err) {
    asNotInitialized(err);
  }
  if (res.rowCount === 0) {
    return { ok: true, mode: 'root', eventsChecked: 0 }; // no root payload to check
  }
  const row = res.rows[0];
  if (row.payload_ok && row.link_ok) {
    return { ok: true, mode: 'root', eventsChecked: 1 };
  }
  const reasons: string[] = [];
  if (!row.payload_ok) reasons.push('data_hash');
  if (!row.link_ok) reasons.push('event_id');
  const id = Number(row.id);
  return { ok: false, mode: 'root', eventsChecked: 1, firstBadId: id, offending: [{ id, reasons }] };
}

/**
 * Full-chain check: re-hashes and re-links *every* event server-side in one
 * statement (instead of only the root). For each row, exactly as the recorder
 * computes them:
 *   - data_hash = sha256(convert_to(d::text, 'UTF8'))  — only where a payload is
 *     stored (payload-less events keep a data_hash we can't recompute, so they
 *     are skipped here but still bound by the event_id check);
 *   - event_id  = sha256(parent_id || data_hash), since parent_id already *is*
 *     the parent's event_id (FK-enforced) — no self-join needed;
 *   - the genesis row (parent_id IS NULL) has all-zero event_id and data_hash.
 *
 * Heavier than the root-only check (scales with chain length).
 */
async function runFullCheck(q: Queryable, prefix: string): Promise<VerifyResult> {
  let lenRes;
  try {
    lenRes = await q.query(`SELECT count(*)::int AS n FROM ${prefix}event_chain`);
  } catch (err) {
    asNotInitialized(err);
  }
  const eventsChecked = Number(lenRes.rows[0]?.n ?? 0);
  const res = await q.query(
    `SELECT v.id, v.bad_data_hash, v.bad_event_id
       FROM (
         SELECT e.id,
                (p.d IS NOT NULL
                   AND e.data_hash <> sha256(convert_to(p.d::text, 'UTF8'))) AS bad_data_hash,
                (CASE
                   WHEN e.parent_id IS NULL
                     THEN (e.event_id <> $1 OR e.data_hash <> $1)
                   ELSE e.event_id <> sha256(e.parent_id || e.data_hash)
                 END) AS bad_event_id
           FROM ${prefix}event_chain e
           LEFT JOIN ${prefix}event_payload p ON p.event_id = e.event_id
       ) v
      WHERE v.bad_data_hash OR v.bad_event_id
      ORDER BY v.id
      LIMIT ${FULL_CHAIN_OFFENDING_LIMIT}`,
    [ZERO_HASH],
  );
  if (res.rows.length === 0) return { ok: true, mode: 'full', eventsChecked };
  const offending = res.rows.map((r) => {
    const reasons: string[] = [];
    if (r.bad_data_hash) reasons.push('data_hash');
    if (r.bad_event_id) reasons.push('event_id');
    return { id: Number(r.id), reasons };
  });
  return { ok: false, mode: 'full', eventsChecked, firstBadId: offending[0]?.id, offending };
}

/**
 * Runs the integrity check for `prefix`: the root-event canary, or the whole
 * chain when `full`. Returns a structured {@link VerifyResult} (does not throw
 * on a mismatch — the caller decides). Throws {@link ChainNotInitializedError}
 * if the chain tables do not exist.
 */
export function runChainCheck(q: Queryable, prefix: string, full: boolean): Promise<VerifyResult> {
  return full ? runFullCheck(q, prefix) : runRootCheck(q, prefix);
}

/** Builds the human-readable message for a failed {@link VerifyResult}. */
export function chainVerificationMessage(prefix: string, result: VerifyResult): string {
  const detail = (result.offending ?? [])
    .map((o) => `id ${o.id} (${o.reasons.join('+')})`)
    .join(', ');
  const more =
    result.mode === 'full' && (result.offending?.length ?? 0) === FULL_CHAIN_OFFENDING_LIMIT
      ? ' (and possibly more)'
      : '';
  return (
    `chain verification failed for "${prefix}event_chain" at ${detail}${more}: ` +
    'either the chain was tampered with, or this PostgreSQL server hashes ' +
    'JSONB incompatibly with the one that recorded the chain'
  );
}

/**
 * Idempotently ensures the chain schema for the given namespace prefix:
 * sha256() support, tables (create-if-absent + shape verification of
 * pre-existing ones), genesis row, stored functions (CREATE OR REPLACE),
 * and the chain's root event (recorded only into an empty chain; its
 * content is shaped by rootEventOptions).
 *
 * The final canary re-verifies hashes server-side: the root event only by
 * default, or — when `verifyChain` is true — the entire chain.
 *
 * Runs in a single transaction serialized by a per-namespace advisory lock,
 * so concurrent initializers across processes are safe.
 */
export async function ensureSchema(
  pool: Pool,
  prefix: string,
  rootEventOptions: RootEventOptions = {},
  verifyChain = false,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [
      advisoryLockKey(prefix).toString(),
    ]);
    await ensureSha256(client);
    await verifyTableShapes(client, prefix);
    await client.query(expand(TABLES_SQL, prefix));
    await verifyGenesis(client, prefix);
    await client.query(expand(FUNCTIONS_SQL, prefix));
    await ensureRootEvent(client, prefix, rootEventOptions);
    const result = await runChainCheck(client, prefix, verifyChain);
    if (!result.ok) {
      throw new ChainVerificationError(chainVerificationMessage(prefix, result));
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
