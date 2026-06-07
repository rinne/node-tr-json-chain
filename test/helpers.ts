import { createHash } from 'node:crypto';
import { inject } from 'vitest';
import { Pool } from 'pg';

export const ZERO = Buffer.alloc(32);

export function makePool(max = 8): Pool {
  return new Pool({ connectionString: inject('dbUrl'), max });
}

export function sha256(...parts: Buffer[]): Buffer {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest();
}

/** Returns the chain's root event (the one whose parent is genesis). */
export async function getRoot(
  pool: Pool,
  ns?: string,
): Promise<{ event_id: Buffer; d: { chain: string; created_at: string } }> {
  const p = ns ? `${ns}_` : '';
  const { rows } = await pool.query(
    `SELECT c.event_id, p.d
       FROM ${p}event_chain c LEFT JOIN ${p}event_payload p USING (event_id)
      WHERE c.parent_id = $1`,
    [ZERO],
  );
  if (rows.length !== 1) throw new Error(`expected exactly one root event, got ${rows.length}`);
  return rows[0];
}

/**
 * Independently re-verifies a whole chain in JS with Node crypto:
 * - the genesis row has no parent and all-zero hashes, and is unique;
 * - every link's parent_id equals the previous row's event_id;
 * - every event_id === sha256(parent_id || data_hash);
 * - every stored payload's normalized JSONB text hashes to its data_hash.
 * Returns the number of chain rows (including genesis).
 */
export async function verifyChainInJs(pool: Pool, ns?: string): Promise<number> {
  const p = ns ? `${ns}_` : '';
  const { rows } = await pool.query(
    `SELECT parent_id, data_hash, event_id FROM ${p}event_chain ORDER BY id`,
  );
  if (rows.length === 0) throw new Error('empty chain');
  const genesis = rows[0];
  if (genesis.parent_id !== null) throw new Error('genesis has a parent');
  if (!ZERO.equals(genesis.data_hash) || !ZERO.equals(genesis.event_id)) {
    throw new Error('genesis hashes are not zero');
  }
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    if (row.parent_id === null) throw new Error(`row ${i}: second genesis`);
    if (!rows[i - 1].event_id.equals(row.parent_id)) {
      throw new Error(`row ${i}: parent_id does not match previous event_id`);
    }
    if (!sha256(row.parent_id, row.data_hash).equals(row.event_id)) {
      throw new Error(`row ${i}: event_id != sha256(parent_id || data_hash)`);
    }
  }

  const payloads = await pool.query(
    `SELECT p.d::text AS d_text, c.data_hash
       FROM ${p}event_payload p JOIN ${p}event_chain c USING (event_id)`,
  );
  for (const row of payloads.rows) {
    if (!sha256(Buffer.from(row.d_text, 'utf8')).equals(row.data_hash)) {
      throw new Error('payload text does not hash to data_hash');
    }
  }
  return rows.length;
}
