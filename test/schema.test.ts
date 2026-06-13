import { afterAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import { ChainVerificationError, EventChainLogger, SchemaMismatchError } from '../src';
import { ZERO, getRoot, makePool, verifyChainInJs } from './helpers';

const pool = makePool();
afterAll(() => pool.end());

describe('init', () => {
  it('creates tables, genesis row and functions from an empty database', async () => {
    const log = new EventChainLogger(pool, { namespace: 'init_fresh' });
    await log.init();
    const tables = await pool.query(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name LIKE 'init_fresh_%'
        ORDER BY table_name`,
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual([
      'init_fresh_event_chain',
      'init_fresh_event_payload',
    ]);
    const funcs = await pool.query(
      `SELECT proname FROM pg_proc WHERE proname LIKE 'init_fresh_%' ORDER BY proname`,
    );
    expect(funcs.rows.map((r) => r.proname)).toEqual([
      'init_fresh_event_head',
      'init_fresh_event_record',
    ]);
    expect(await verifyChainInJs(pool, 'init_fresh')).toBe(2); // genesis + root event
  });

  it('records a root event with chain UUID and ts into an empty chain', async () => {
    const log = new EventChainLogger(pool, { namespace: 'init_root' });
    await log.init();
    const root = await getRoot(pool, 'init_root');
    expect(root.d.chain).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    expect(root.d.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(root.d.type).toBe('chain-root');
    expect(Object.keys(root.d).sort()).toEqual(['chain', 'ts', 'type']);
  });

  it('is idempotent and preserves existing chain data', async () => {
    const log1 = new EventChainLogger(pool, { namespace: 'init_idem' });
    const id = await log1.recordEvent({ kept: true });
    const rootBefore = await getRoot(pool, 'init_idem');
    // A "newer module version" re-initializing against existing tables:
    const log2 = new EventChainLogger(pool, { namespace: 'init_idem' });
    await log2.init();
    const { rows } = await pool.query(
      'SELECT d FROM init_idem_event_payload WHERE event_id = $1',
      [Buffer.from(id, 'hex')],
    );
    expect(rows[0].d).toEqual({ kept: true });
    expect(await verifyChainInJs(pool, 'init_idem')).toBe(3); // genesis + root + 1
    // Re-init did not add or replace the root event:
    const rootAfter = await getRoot(pool, 'init_idem');
    expect(rootAfter.event_id.equals(rootBefore.event_id)).toBe(true);
    expect(rootAfter.d).toEqual(rootBefore.d);
  });

  it('survives concurrent initialization from multiple pools', async () => {
    const pools = Array.from({ length: 4 }, () => makePool(2));
    try {
      await Promise.all(
        pools.map((p) =>
          new EventChainLogger(p, { namespace: 'init_conc' }).recordEvent({ hi: 1 }),
        ),
      );
      // Exactly ONE root event despite 4 concurrent initializers:
      expect(await verifyChainInJs(pool, 'init_conc')).toBe(6); // genesis + root + 4
      await getRoot(pool, 'init_conc'); // throws unless exactly one root exists
    } finally {
      await Promise.all(pools.map((p) => p.end()));
    }
  });

  it('refuses to touch a pre-existing table with the wrong shape', async () => {
    await pool.query('CREATE TABLE wrong_event_chain (id int, junk text)');
    const log = new EventChainLogger(pool, { namespace: 'wrong' });
    await expect(log.init()).rejects.toThrow(SchemaMismatchError);
    // The wrong table is untouched — no ALTER, no DROP:
    const { rows } = await pool.query(
      `SELECT column_name, data_type FROM information_schema.columns
        WHERE table_schema = current_schema() AND table_name = 'wrong_event_chain'
        ORDER BY ordinal_position`,
    );
    expect(rows).toEqual([
      { column_name: 'id', data_type: 'integer' },
      { column_name: 'junk', data_type: 'text' },
    ]);
    // And nothing else of the namespace was created:
    const { rowCount } = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'wrong_event_payload'`,
    );
    expect(rowCount).toBe(0);
  });

  it('detects a drifted (altered) table on re-init', async () => {
    const log = new EventChainLogger(pool, { namespace: 'drift' });
    await log.init();
    await pool.query('ALTER TABLE drift_event_payload ADD COLUMN extra text');
    const log2 = new EventChainLogger(pool, { namespace: 'drift' });
    await expect(log2.init()).rejects.toThrow(SchemaMismatchError);
  });

  it('re-verifies the root event hashes on every init (canary)', async () => {
    // Connecting to an existing chain re-proves that this server hashes the
    // stored JSONB compatibly — and detects root tampering as a side effect.
    const log = new EventChainLogger(pool, { namespace: 'canary' });
    await log.init();
    await pool.query(
      `UPDATE canary_event_payload SET d = '{"chain": "forged", "ts": "forged"}'
        WHERE event_id = (SELECT event_id FROM canary_event_chain WHERE parent_id = $1)`,
      [ZERO],
    );
    const log2 = new EventChainLogger(pool, { namespace: 'canary' });
    await expect(log2.init()).rejects.toThrow(ChainVerificationError);
  });

  it('detects a tampered root chain row on init (canary)', async () => {
    const log = new EventChainLogger(pool, { namespace: 'canary2' });
    await log.init();
    await pool.query(
      `UPDATE canary2_event_chain SET data_hash = $2 WHERE parent_id = $1`,
      [ZERO, Buffer.from('99'.repeat(32), 'hex')],
    );
    const log2 = new EventChainLogger(pool, { namespace: 'canary2' });
    await expect(log2.init()).rejects.toThrow(ChainVerificationError);
  });

  it('recovers when a failed init is retried after the cause is fixed', async () => {
    await pool.query('CREATE TABLE retry_event_chain (oops int)');
    const log = new EventChainLogger(pool, { namespace: 'retry' });
    await expect(log.init()).rejects.toThrow(SchemaMismatchError);
    await pool.query('DROP TABLE retry_event_chain');
    await log.init(); // the same instance retries successfully
    expect(await verifyChainInJs(pool, 'retry')).toBe(2);
  });
});

describe('verifyChain option (full server-side chain verification)', () => {
  it('accepts a healthy chain, including checkpoint and no-payload events', async () => {
    const log = new EventChainLogger(pool, { namespace: 'vc_ok' });
    await log.recordEvent({ a: 1 });
    await log.recordEvent({ secret: true }, { storePayload: false }); // no payload row
    await log.getChainHead(); // appends an empty checkpoint (zero data_hash)
    // A fresh init with verifyChain re-checks the entire chain — no throw.
    await new EventChainLogger(pool, { namespace: 'vc_ok', verifyChain: true }).init();
  });

  it('detects a tampered non-root payload that the root-only canary misses', async () => {
    const log = new EventChainLogger(pool, { namespace: 'vc_tamper' });
    await log.recordEvent({ a: 1 });
    await log.recordEvent({ b: 2 }); // a non-root event (id 3)
    await pool.query(
      `UPDATE vc_tamper_event_payload SET d = '{"b": 999}'
        WHERE event_id = (SELECT event_id FROM vc_tamper_event_chain ORDER BY id DESC LIMIT 1)`,
    );
    // Default init (root-only canary) does NOT notice a non-root tamper:
    await new EventChainLogger(pool, { namespace: 'vc_tamper' }).init();
    // verifyChain does:
    await expect(
      new EventChainLogger(pool, { namespace: 'vc_tamper', verifyChain: true }).init(),
    ).rejects.toThrow(ChainVerificationError);
  });

  it('detects a tampered data_hash', async () => {
    const log = new EventChainLogger(pool, { namespace: 'vc_dh' });
    await log.recordEvent({ a: 1 }); // id 2
    await pool.query('UPDATE vc_dh_event_chain SET data_hash = $1 WHERE id = 2', [
      Buffer.from('99'.repeat(32), 'hex'),
    ]);
    await expect(
      new EventChainLogger(pool, { namespace: 'vc_dh', verifyChain: true }).init(),
    ).rejects.toThrow(ChainVerificationError);
  });
});

describe('structural chain integrity', () => {
  it('rejects a second genesis row', async () => {
    const log = new EventChainLogger(pool, { namespace: 'guard_genesis' });
    await log.init(); // genesis id 0, root id 1
    await expect(
      pool.query(
        `INSERT INTO guard_genesis_event_chain (id, parent_id, data_hash, event_id)
         VALUES (2, NULL, $1, $2)`,
        [ZERO, Buffer.from('11'.repeat(32), 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23505' }); // unique_violation (one_genesis)
  });

  it('rejects forks (duplicate parent_id)', async () => {
    const log = new EventChainLogger(pool, { namespace: 'guard_fork' });
    const id = await log.recordEvent({ a: 1 }); // genesis 0, root 1, event 2
    const { rows } = await pool.query(
      'SELECT parent_id FROM guard_fork_event_chain WHERE event_id = $1',
      [Buffer.from(id, 'hex')],
    );
    await expect(
      pool.query(
        `INSERT INTO guard_fork_event_chain (id, parent_id, data_hash, event_id)
         VALUES (3, $1, $2, $3)`,
        [rows[0].parent_id, ZERO, Buffer.from('22'.repeat(32), 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23505' });
  });

  it('rejects orphan parents (FK to event_chain.event_id)', async () => {
    const log = new EventChainLogger(pool, { namespace: 'guard_orphan' });
    await log.init(); // genesis 0, root 1
    await expect(
      pool.query(
        `INSERT INTO guard_orphan_event_chain (id, parent_id, data_hash, event_id)
         VALUES (2, $1, $2, $3)`,
        [Buffer.from('33'.repeat(32), 'hex'), ZERO, Buffer.from('44'.repeat(32), 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23503' }); // foreign_key_violation
  });

  it('assigns dense, gap-free ids starting at genesis 0', async () => {
    const log = new EventChainLogger(pool, { namespace: 'dense_ids' });
    await log.init(); // genesis 0, root 1
    await log.recordEvent({ n: 1 }); // 2
    await log.recordEvent({ n: 2 }); // 3
    await log.getChainHead(); // appends an empty checkpoint -> 4
    const { rows } = await pool.query(
      'SELECT id FROM dense_ids_event_chain ORDER BY id',
    );
    expect(rows.map((r) => Number(r.id))).toEqual([0, 1, 2, 3, 4]);
  });

  it('rejects payloads for unknown events (FK)', async () => {
    const log = new EventChainLogger(pool, { namespace: 'guard_payload' });
    await log.init();
    await expect(
      pool.query(
        `INSERT INTO guard_payload_event_payload (event_id, d) VALUES ($1, '{}')`,
        [Buffer.from('55'.repeat(32), 'hex')],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('stores timestamps as timestamptz', async () => {
    const log = new EventChainLogger(pool, { namespace: 'guard_ts' });
    await log.init();
    const { rows } = await pool.query(
      `SELECT data_type FROM information_schema.columns
        WHERE table_schema = current_schema()
          AND table_name = 'guard_ts_event_payload' AND column_name = 'ts'`,
    );
    expect(rows[0].data_type).toBe('timestamp with time zone');
  });
});
