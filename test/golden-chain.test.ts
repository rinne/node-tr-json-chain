import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { EventChainLogger, EventChainCsvExport, EventChainCsvParse } from '../src';
// @ts-expect-error — plain-JS shared build helper (DI'd with the src classes here)
import { buildGoldenChain, exportGoldenCsv, dropGoldenNamespace } from './golden-chain-build.mjs';
import { makePool } from './helpers';

// The golden chain fixture: a deterministic, committed, known-good chain that
// must verify FOREVER. Its expected hashes are LITERALS in the repo
// (golden-chain.csv / golden-chain.json), generated once on PostgreSQL 16. A
// change to the on-disk format, the hashing, or jsonb::text rendering anywhere
// would change these and fail loudly. Three independent verifiers must agree on
// the committed bytes; a fourth check rebuilds the chain in the DB and asserts
// it still reproduces them exactly. (The standalone `tr-json-chain-check` is the
// third, spec-independent verifier — run on this same CSV in tr-json-chain-tools.)

const here = join(import.meta.dirname, '.');
const CSV = readFileSync(join(here, 'golden-chain.csv'), 'utf8');
const INVARIANTS = JSON.parse(readFileSync(join(here, 'golden-chain.json'), 'utf8')) as {
  length: number;
  genesisEventId: string;
  headEventId: string;
  rows: { id: number; event_id: string; data_hash: string }[];
};
const RECIPE = JSON.parse(readFileSync(join(here, 'golden-chain-input.json'), 'utf8'));

const ZERO_HEX = '0'.repeat(64);
function sha256hex(...bufs: Buffer[]): string {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest('hex');
}
function csvLines(csv: string): string[] {
  return csv.split('\n').filter((l) => l !== '');
}

const pool = makePool();
afterAll(async () => {
  await dropGoldenNamespace(pool, RECIPE.namespace);
  await pool.end();
});

describe('golden chain fixture', () => {
  // Verifier 1 — the CSV parser, with every integrity layer on, over the
  // committed bytes (no database).
  it('passes EventChainCsvParse with full verification (no DB)', () => {
    const lines = csvLines(CSV);
    const parser = new EventChainCsvParse(lines[0], {
      verifyHashes: true,
      verifyLinks: true,
      verifyRoot: true,
    });
    for (const line of lines.slice(1)) parser.row(line);
    const summary = parser.end();
    expect(summary.partial).toBe(false);
    expect(summary.count).toBe(INVARIANTS.length - 1); // CSV excludes genesis
  });

  // Verifier 2 — an independent, dependency-free re-derivation straight from the
  // spec (this is exactly what `tr-json-chain-check` does), over the committed
  // bytes. Re-hashes each row's verbatim canonical text and re-links the chain.
  it('re-derives every hash from the spec, independently (no DB)', () => {
    const rows = csvLines(CSV)
      .slice(1)
      .map((line) => {
        const [num, event_id, parent_id, data_hash, ...rest] = line.split(';');
        // `data` is the last field, RFC-4180 quoted; rebuild & unquote it.
        const dataField = rest.join(';');
        const data =
          dataField === '' ? '' : dataField.replace(/^"|"$/g, '').replace(/""/g, '"');
        return { id: Number(num), event_id, parent_id, data_hash, data };
      });

    let prev = INVARIANTS.genesisEventId; // genesis event_id (all-zero)
    for (const r of rows) {
      // parent_id links to the previous event_id
      expect(r.parent_id).toBe(prev);
      // data_hash == SHA256(utf8(canonical text)), where a payload is present
      if (r.data !== '') {
        expect(sha256hex(Buffer.from(r.data, 'utf8'))).toBe(r.data_hash);
      }
      // event_id == SHA256(parent_id || data_hash)
      expect(sha256hex(Buffer.from(r.parent_id, 'hex'), Buffer.from(r.data_hash, 'hex'))).toBe(
        r.event_id,
      );
      prev = r.event_id;
    }
    expect(prev).toBe(INVARIANTS.headEventId); // ended at the committed head
  });

  // The committed invariants and CSV must agree with each other (catches an
  // accidental partial regeneration of one file but not the other).
  it('committed CSV and invariants are mutually consistent', () => {
    const lines = csvLines(CSV).slice(1);
    expect(lines.length).toBe(INVARIANTS.length - 1);
    expect(INVARIANTS.rows[0].event_id).toBe(ZERO_HEX); // genesis
    lines.forEach((line, k) => {
      const [num, event_id, , data_hash] = line.split(';');
      const inv = INVARIANTS.rows[k + 1]; // +1: invariants include genesis
      expect(Number(num)).toBe(inv.id);
      expect(event_id).toBe(inv.event_id);
      expect(data_hash).toBe(inv.data_hash);
    });
  });

  // Verifier 3 — the live library against a freshly rebuilt chain: the DB must
  // still reproduce the committed fixture byte-for-byte, and the server-side
  // full-chain verification must pass.
  it('the DB reproduces the committed fixture byte-for-byte and verifies', async () => {
    const log = await buildGoldenChain(pool, RECIPE, { EventChainLogger });
    const { csv, length } = await exportGoldenCsv(log, { EventChainCsvExport });
    expect(csv).toBe(CSV); // byte-identical to the committed golden CSV
    expect(length).toBe(INVARIANTS.length);

    const result = await log.verify({ full: true });
    expect(result.ok).toBe(true);
    expect(result.eventsChecked).toBe(INVARIANTS.length);

    // Spot-check the head via the live accessor too.
    const head = await log.getEvent(-1);
    expect(head?.event_id).toBe(INVARIANTS.headEventId);
  });
});
