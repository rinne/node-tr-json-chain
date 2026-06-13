// Shared build/export logic for the golden chain fixture, used by BOTH the
// generator (scripts/gen-golden-chain.mjs, against ../dist) and the test
// (test/golden-chain.test.ts, against ../src). The library classes are injected
// so there is exactly one copy of the build steps — the generator and the test
// cannot drift. Inputs come from golden-chain-input.json (the single source).

const DROP = (ns) => [
  `DROP TABLE IF EXISTS ${ns}_event_payload CASCADE`,
  `DROP TABLE IF EXISTS ${ns}_event_chain CASCADE`,
  `DROP FUNCTION IF EXISTS ${ns}_event_record(jsonb, boolean)`,
  `DROP FUNCTION IF EXISTS ${ns}_event_head()`,
];

/** Drops the golden namespace so the chain is rebuilt deterministically from scratch. */
export async function dropGoldenNamespace(pool, ns) {
  for (const q of DROP(ns)) await pool.query(q);
}

/**
 * Builds the deterministic golden chain described by `recipe` and returns the
 * initialized EventChainLogger. Drops the namespace first so the result is a
 * pure function of the recipe (no leftover state).
 */
export async function buildGoldenChain(pool, recipe, { EventChainLogger }) {
  await dropGoldenNamespace(pool, recipe.namespace);
  const log = new EventChainLogger(pool, {
    namespace: recipe.namespace,
    rootOmitDefaultData: recipe.rootOmitDefaultData === true,
    rootExtraData: recipe.rootExtraData ?? null,
  });
  await log.init();
  for (const ev of recipe.events) {
    if (ev.checkpoint) {
      await log.getChainHead(); // appends an empty checkpoint event
    } else {
      await log.recordEvent(ev.data, { storePayload: ev.store !== false });
    }
  }
  return log;
}

/**
 * Exports the whole chain (genesis excluded) via EventChainCsvExport, returning
 * the CSV string plus, for invariants, every row's { id, event_id, data_hash }
 * INCLUDING genesis, and the total chain length (max id + 1).
 */
export async function exportGoldenCsv(log, { EventChainCsvExport }) {
  const enc = new EventChainCsvExport();
  const opts = { includeHashedData: true, includeDataHash: true, includeParentId: true };

  // Full chain (incl. genesis) for the invariant rows.
  const allRows = [];
  for (let from = 0; ; ) {
    const page = await log.getEvents(from, opts);
    for (const e of page.events) {
      allRows.push({ id: e.id, event_id: e.event_id, data_hash: e.data_hash });
    }
    if (!page.have_more) break;
    from = page.end + 1;
  }
  const length = allRows.length; // dense ids 0..length-1

  // CSV export (genesis excluded), via the library encoder.
  let csv = enc.header() + '\n';
  for (let from = 1; ; ) {
    const page = await log.getEvents(from, opts);
    for (const e of page.events) csv += enc.event(e) + '\n';
    if (!page.have_more) break;
    from = page.end + 1;
  }

  return { csv, rows: allRows, length };
}
