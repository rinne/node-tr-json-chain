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

/** Verifies the genesis row: exactly one root, with all-zero hashes. */
async function verifyGenesis(client: PoolClient, prefix: string): Promise<void> {
  const res = await client.query(
    `SELECT data_hash, event_id FROM ${prefix}event_chain WHERE parent_id IS NULL`,
  );
  if (res.rowCount !== 1) {
    throw new SchemaMismatchError(
      `table "${prefix}event_chain" has ${res.rowCount} genesis rows, expected exactly 1`,
    );
  }
  const row = res.rows[0] as { data_hash: Buffer; event_id: Buffer };
  if (!ZERO_HASH.equals(row.data_hash) || !ZERO_HASH.equals(row.event_id)) {
    throw new SchemaMismatchError(
      `genesis row of "${prefix}event_chain" does not have all-zero hashes`,
    );
  }
}

/**
 * Records the chain's root event if (and only if) the chain is empty, i.e.
 * holds nothing beyond the genesis row:
 *
 *   { "chain": "<random-uuid>", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
 *
 * The UUID gives the chain a unique identity; "ts" (ISO 8601 UTC) is also
 * the conventional timestamp property for subsequent events. Idempotent
 * under concurrency: the caller holds the per-namespace advisory lock, and
 * the NOT EXISTS guard makes the statement a no-op on any non-empty chain.
 */
async function ensureRootEvent(client: PoolClient, prefix: string): Promise<void> {
  const root = { chain: randomUUID(), ts: new Date().toISOString() };
  await client.query(
    `SELECT ${prefix}event_record($1::jsonb)
      WHERE NOT EXISTS
        (SELECT 1 FROM ${prefix}event_chain WHERE parent_id IS NOT NULL)`,
    [JSON.stringify(root)],
  );
}

/**
 * Canary check, run on every init after the root event exists: re-hashes the
 * root event server-side with the very expressions event_record() uses.
 *
 * Chain *links* are immune to server upgrades (they hash stored bytes), but
 * re-verifying a *payload* depends on jsonb::text rendering being stable
 * across PostgreSQL versions. That rendering has been byte-stable since 9.4
 * and is de facto frozen, but is not formally guaranteed — so this proves,
 * cheaply and on every connect, that the current server still renders and
 * hashes JSONB exactly as the server that recorded the root event did. It
 * also detects tampering with the root event itself.
 */
async function verifyRootEvent(client: PoolClient, prefix: string): Promise<void> {
  const res = await client.query(
    `SELECT (c.data_hash = sha256(convert_to(p.d::text, 'UTF8'))) AS payload_ok,
            (c.event_id = sha256(c.parent_id || c.data_hash)) AS link_ok
       FROM ${prefix}event_chain c JOIN ${prefix}event_payload p USING (event_id)
      WHERE c.parent_id = $1`,
    [ZERO_HASH],
  );
  if (res.rowCount === 0) return; // pre-root-event chain, or payload not stored
  const { payload_ok, link_ok } = res.rows[0];
  if (!payload_ok || !link_ok) {
    throw new ChainVerificationError(
      `root event of "${prefix}event_chain" fails hash re-verification ` +
        `(payload hash ${payload_ok ? 'ok' : 'MISMATCH'}, ` +
        `chain link ${link_ok ? 'ok' : 'MISMATCH'}): either the chain data ` +
        'was tampered with, or this PostgreSQL server hashes JSONB ' +
        'incompatibly with the one that recorded the chain',
    );
  }
}

/**
 * Idempotently ensures the chain schema for the given namespace prefix:
 * sha256() support, tables (create-if-absent + shape verification of
 * pre-existing ones), genesis row, stored functions (CREATE OR REPLACE),
 * and the chain's root event (recorded only into an empty chain).
 *
 * Runs in a single transaction serialized by a per-namespace advisory lock,
 * so concurrent initializers across processes are safe.
 */
export async function ensureSchema(pool: Pool, prefix: string): Promise<void> {
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
    await ensureRootEvent(client, prefix);
    await verifyRootEvent(client, prefix);
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
