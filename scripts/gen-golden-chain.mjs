// Generates the golden chain fixture: a deterministic, known-good chain that
// must verify FOREVER. Builds the chain described by test/golden-chain-input.json
// on PostgreSQL, exports it via the library's EventChainCsvExport, and writes:
//
//   test/golden-chain.csv   — the canonical CSV export (literal hashes)
//   test/golden-chain.json  — invariants: chain length, genesis/head event_id,
//                             and every row's {id, event_id, data_hash} as literals.
//
// These are committed and checked by test/golden-chain.test.ts with three
// independent verifiers. The fixture is deterministic (fixed root, fixed
// payloads, no timestamps), so its hashes are reproducible across every
// supported PostgreSQL version — a rendering change anywhere fails the test loudly.
//
// Run:  node scripts/gen-golden-chain.mjs
//   (uses TR_JSON_CHAIN_TEST_URL, or the dc/ docker default on :5433)
// Generate on PostgreSQL 16 (the reference renderer), like the jsonb vectors.

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { EventChainLogger, EventChainCsvExport } from '../dist/index.js';
import { buildGoldenChain, exportGoldenCsv } from '../test/golden-chain-build.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const INPUT = join(ROOT, 'test', 'golden-chain-input.json');
const OUT_CSV = join(ROOT, 'test', 'golden-chain.csv');
const OUT_JSON = join(ROOT, 'test', 'golden-chain.json');
const URL =
  process.env.TR_JSON_CHAIN_TEST_URL ||
  'postgres://postgres:postgres@localhost:5433/postgres';

const recipe = JSON.parse(readFileSync(INPUT, 'utf8'));
const { Pool } = pg;

async function main() {
  const pool = new Pool({ connectionString: URL });
  try {
    const pgVersion = (await pool.query('SHOW server_version')).rows[0].server_version;
    const log = await buildGoldenChain(pool, recipe, { EventChainLogger });
    const { csv, rows, length } = await exportGoldenCsv(log, { EventChainCsvExport });

    writeFileSync(OUT_CSV, csv);
    const head = rows[rows.length - 1];
    const doc = {
      _comment:
        'Invariants for the golden chain fixture. Generated on PostgreSQL 16 via ' +
        'scripts/gen-golden-chain.mjs from golden-chain-input.json. Every value is ' +
        'a literal expectation checked by golden-chain.test.ts — a change to any ' +
        'hash means the on-disk format / rendering moved and must be investigated.',
      generatedOnServerVersion: pgVersion,
      length, // total chain rows incl. genesis (= max id + 1)
      genesisEventId: rows[0].event_id,
      headEventId: head.event_id,
      rows, // every row [{ id, event_id, data_hash }], genesis first
    };
    writeFileSync(OUT_JSON, JSON.stringify(doc, null, 2) + '\n');
    console.log(
      `Wrote golden fixture (${length} rows incl. genesis) on PostgreSQL ${pgVersion}\n` +
        `  ${OUT_CSV}\n  ${OUT_JSON}`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
