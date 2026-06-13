import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { makePool } from './helpers';
import vectorsDoc from './jsonb-vectors.json';

// Golden JSONB canonicalization vectors (generated once on PostgreSQL 16 via
// scripts/gen-jsonb-vectors.mjs). Each vector's source is a raw JSON string.
//
// What these prove for the 1.0.0 freeze: PostgreSQL's canonical rendering
// `jsonb::text` is DETERMINISTIC and STABLE — the same JSON input always renders
// to the same text and therefore the same
//   data_hash = sha256(convert_to(input::jsonb::text, 'UTF8'))
// regardless of which supported PostgreSQL version is doing it. We do not care
// *what* form PostgreSQL chooses (e.g. `1e21` → `1000000000000000000000`); we
// only require that it never changes. Run the suite with TR_JSON_CHAIN_TEST_URL
// pointed at 16 / 17 / 18 / … and these must all reproduce the committed values.

const pool = makePool();
const { vectors } = vectorsDoc as {
  vectors: { name: string; input: string; canonical: string; data_hash: string }[];
};

function sha256hex(buf: Buffer): string {
  return createHash('sha256').update(buf).digest('hex');
}

describe('jsonb canonical vectors', () => {
  it('has a sane, de-duplicated corpus', () => {
    expect(vectors.length).toBeGreaterThan(40);
    expect(new Set(vectors.map((v) => v.name)).size).toBe(vectors.length);
    for (const v of vectors) {
      expect(v.data_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(typeof v.input).toBe('string');
      expect(typeof v.canonical).toBe('string');
    }
  });

  // The cross-version heart: the configured server must render every input to
  // exactly the committed canonical text and hash it to the committed data_hash.
  // Identical reproduction across versions is the whole freeze guarantee.
  it('reproduces the committed canonical text and data_hash on this server', async () => {
    const inputs = vectors.map((v) => v.input);
    const { rows } = await pool.query(
      `SELECT t.i AS idx,
              (t.v::jsonb)::text AS canonical,
              encode(sha256(convert_to((t.v::jsonb)::text, 'UTF8')), 'hex') AS data_hash
         FROM unnest($1::text[]) WITH ORDINALITY AS t(v, i)
        ORDER BY t.i`,
      [inputs],
    );
    expect(rows.length).toBe(vectors.length);
    const mismatches: string[] = [];
    rows.forEach((row, k) => {
      const v = vectors[k];
      if (row.canonical !== v.canonical) {
        mismatches.push(`${v.name}: canonical ${JSON.stringify(row.canonical)} != ${JSON.stringify(v.canonical)}`);
      }
      if (row.data_hash !== v.data_hash) {
        mismatches.push(`${v.name}: data_hash ${row.data_hash} != ${v.data_hash}`);
      }
    });
    expect(mismatches).toEqual([]);
  });

  // Portability contract: an independent SHA-256 over the committed canonical
  // bytes reproduces data_hash — no PostgreSQL needed, any language could do it.
  it('independently re-hashes the canonical bytes to data_hash (no DB)', () => {
    for (const v of vectors) {
      expect(sha256hex(Buffer.from(v.canonical, 'utf8'))).toBe(v.data_hash);
    }
  });
});
