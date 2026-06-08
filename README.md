# tr-json-chain

Immutable, append-only, SHA-256 hash-chained JSON event log on PostgreSQL.

`tr-json-chain` maintains a tamper-evident chain of JSON events inside your
existing PostgreSQL database. Give it a [`pg`](https://www.npmjs.com/package/pg)
pool; it maintains its own schema and stored functions automatically — and
**never migrates the chain tables**, so chain integrity is verifiable
indefinitely.

## Install

```sh
npm install tr-json-chain pg
```

Requires Node.js ≥ 18 and PostgreSQL ≥ 11 (for the built-in `sha256()`
function). No extensions needed.

## Quick start

```js
const { Pool } = require('pg');
const { EventChainLogger } = require('tr-json-chain');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const log = new EventChainLogger(pool);

// Schema is ensured automatically on first use (or call log.init() eagerly).
const eventId = await log.recordEvent({ action: 'user.login', user: 42 });
console.log('event id:', eventId.toString('hex'));

const head = await log.getChainHead();
console.log('chain head:', head.toString('hex'));
```

TypeScript types are included:

```ts
import { EventChainLogger } from 'tr-json-chain';
```

## How the chain works

Every event payload (a JSONB value) is hashed, and every event is linked to
its predecessor:

```
data_hash = SHA256(payload rendered as JSONB text, UTF-8)
event_id  = SHA256(parent_event_id ‖ data_hash)
```

The chain starts from a fixed **genesis row** whose `event_id` and `data_hash`
are 256 zero bits, immediately followed by a **root event** carrying the
chain's random UUID identity and creation time (see
[`init()`](#init-promisevoid)). Altering, removing, or reordering any historical event
changes every subsequent `event_id`, so the head id commits to the entire
history. Publish or cross-log a head id periodically and you have an
externally verifiable, tamper-evident audit log.

Two tables hold the data:

| table | contents |
|---|---|
| `event_chain` | the chain itself: `id BIGSERIAL`, `parent_id`, `data_hash`, `event_id` (BYTEA) |
| `event_payload` | optional payload per event: `event_id` (FK), `ts TIMESTAMPTZ`, `d JSONB` |

The chain's shape is enforced *structurally* by the table itself:

- `parent_id UNIQUE` — no forks (two events can't share a parent);
- `parent_id REFERENCES event_chain(event_id)` — no orphans;
- a partial unique index allows only **one** row with `parent_id IS NULL` —
  exactly one genesis.

So even raw SQL access cannot turn the chain into anything but a single
linked list.

## API

### `new EventChainLogger(pool, options?)`

- `pool` — a `pg.Pool`. The logger never closes it; lifecycle stays yours.
- `options.namespace` — optional chain namespace (see
  [Namespaces](#namespaces-multiple-chains-per-database)).
- `options.rootExtraData` — optional plain object superimposed
  (`Object.assign`) on top of the default root-event data when the chain is
  first initialized; keys override the defaults. `undefined`/`null` have no
  effect, and arrays/primitives throw `TypeError`. Has **no effect** on an
  already-initialized chain. For example
  `{ chain: 'kukkuu', foo: 1, bar: [1, 2, 3] }` yields the root event
  `{ "chain": "kukkuu", "ts": "<ISO 8601 UTC>", "foo": 1, "bar": [1, 2, 3] }`.
- `options.rootOmitDefaultData` — when `true`, omit the default `chain`
  and `ts` properties from the root event; with no `rootExtraData` the root
  event becomes simply `{}`. Default `false`. Also ignored on an
  already-initialized chain.

The constructor throws `TypeError` synchronously on an invalid namespace or a
non-object `rootExtraData`.

### `init(): Promise<void>`

Idempotently ensures everything the logger needs:

1. probes for `sha256()` support — throws `UnsupportedPostgresError` on
   PostgreSQL older than 11;
2. **verifies** any pre-existing chain tables against the expected shape —
   throws `SchemaMismatchError` on any difference (existing tables are never
   altered or dropped);
3. creates missing tables, indexes, and the genesis row;
4. installs/refreshes the stored functions (`CREATE OR REPLACE`);
5. if the chain is empty (genesis only), records the chain's **root event**
   (default form):

   ```json
   { "chain": "<random-uuid>", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
   ```

   The UUID gives the chain a unique identity for the rest of its life; `ts`
   is the chain's creation time (ISO 8601 UTC) — `ts` is also the recommended
   conventional timestamp property for your own subsequent events. The default
   content can be extended/overridden with `rootExtraData` or reduced with
   `rootOmitDefaultData` (see the constructor options). The root event is
   recorded at most once, even under concurrent initialization;

6. re-verifies the root event server-side (the **canary check**, see below) —
   throws `ChainVerificationError` on mismatch.

It runs in one transaction serialized by a per-namespace advisory lock, so
any number of processes can start concurrently. You don't have to call it —
`recordEvent` and `getChainHead` call it lazily on first use — but calling it
at startup surfaces configuration problems early. A failed `init()` may be
retried (e.g. after fixing the database).

### `recordEvent(data, options?): Promise<Buffer>`

Appends an event and resolves to its 32-byte `event_id`.

- `data` — any JSON-serializable value (object, array, string, number,
  boolean, or `null`). `undefined` and functions throw `TypeError`.
- `options.storePayload` — when `false`, only the chain entry (hashes) is
  stored; the payload itself is discarded. The hash still commits to the
  payload, so you can later prove that a payload you retained out-of-band was
  recorded, without keeping it in the database. Default `true`.

### `timestamp(): Promise<Buffer>`

Convenience shortcut that records the current time as an event and resolves to
its 32-byte `event_id`:

```json
{ "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
```

Equivalent to `recordEvent({ ts: new Date().toISOString() })`.

### `getChainHead(): Promise<Buffer>`

Resolves to the 32-byte `event_id` of the chain head. If the current head is
not already an *empty checkpoint event* (one with a zero `data_hash`), one is
appended first. Repeated calls therefore return the same id instead of piling
up empty events.

This makes a head fetch itself an auditable act: the returned id commits to
everything recorded before it.

### `getRootEvent(): Promise<{ event_id, event_data? }>`

Resolves to the chain's **root event** — the first event after genesis, which
carries the chain's identity:

```js
{ event_id: <Buffer>, event_data: { chain: '…', ts: '…' /* … */ } }
```

`event_data` (the stored JSONB payload) is **omitted** when no payload was kept
for the root event. Unlike the other accessors this does **not** initialize the
chain: it reads existing state and throws an `Error` if the chain is
uninitialized (tables absent, or no root event recorded yet).

### Errors

| class | thrown when |
|---|---|
| `SchemaMismatchError` | a pre-existing table doesn't match the frozen shape (nothing is touched) |
| `ChainVerificationError` | the root event fails hash re-verification at init (tampering, or an incompatible server) |
| `UnsupportedPostgresError` | the server lacks built-in `sha256()` (PostgreSQL < 11) |
| `TypeError` | invalid namespace or non-JSON-serializable event data |

## Namespaces: multiple chains per database

```js
const billing = new EventChainLogger(pool, { namespace: 'billing' });
const access  = new EventChainLogger(pool, { namespace: 'access' });
```

Each namespace is a fully independent chain with its own genesis: the tables
and functions are name-prefixed (`billing_event_chain`,
`billing_event_record()`, …). Without a namespace the bare names
(`event_chain`, …) are used.

Namespaces must match `/^[a-z][a-z0-9_]*$/` and be at most 39 characters
(so prefixed identifiers stay within PostgreSQL's 63-character limit).
Validation is strict because the namespace becomes part of SQL identifiers.

## The never-migrate guarantee

The chain tables' DDL is **frozen**. New versions of this module may replace
the stored functions, but will never `ALTER`, `DROP`, or otherwise migrate
`event_chain` / `event_payload`, and will never change how `event_id` or
`data_hash` are computed. On every `init()` the module *verifies* existing
tables and refuses to proceed on any mismatch — it has no code path that
modifies an existing table.

This is what makes the chain trustworthy long-term: a chain recorded today
remains verifiable, byte for byte, against any future version of this module.

## Verifying a chain independently

Anyone with read access can re-verify the chain without this module:

```js
const { createHash } = require('node:crypto');
const sha256 = (...bufs) => {
  const h = createHash('sha256');
  for (const b of bufs) h.update(b);
  return h.digest();
};

const { rows } = await pool.query(
  'SELECT parent_id, data_hash, event_id FROM event_chain ORDER BY id'
);
for (let i = 1; i < rows.length; i++) {
  if (!rows[i].parent_id.equals(rows[i - 1].event_id)) throw new Error('broken link');
  if (!sha256(rows[i].parent_id, rows[i].data_hash).equals(rows[i].event_id))
    throw new Error('bad event_id');
}

// Payloads: hash PostgreSQL's normalized JSONB rendering.
const payloads = await pool.query(
  `SELECT p.d::text AS d_text, c.data_hash
     FROM event_payload p JOIN event_chain c USING (event_id)`
);
for (const r of payloads.rows) {
  if (!sha256(Buffer.from(r.d_text, 'utf8')).equals(r.data_hash))
    throw new Error('bad data_hash');
}
```

### What about PostgreSQL upgrades?

Chain *links* are immune to server changes: `event_id = SHA256(parent_id ‖
data_hash)` is computed over stored bytes and is never re-rendered, so the
linked structure verifies forever. Re-verifying *payloads*, however, depends
on `jsonb::text` rendering being identical to when the payload was hashed.
That rendering has been byte-stable since PostgreSQL 9.4 and is de facto
frozen (changing it would break dumps and replication ecosystem-wide), but it
is not formally guaranteed. As insurance, every `init()` runs a **canary
check**: it re-hashes the chain's root event server-side using the exact
expressions `event_record()` uses. If a server ever rendered or hashed JSONB
incompatibly — or the root event was tampered with — connecting fails loudly
with `ChainVerificationError` instead of the chain silently becoming
unverifiable.

### ⚠ JSONB normalization

PostgreSQL normalizes JSONB before it is hashed: object keys are reordered
(by length, then bytewise), whitespace is canonicalized, duplicate keys are
collapsed. `data_hash` therefore commits to the **normalized** rendering
(`d::text`), *not* to the byte sequence you originally serialized in
JavaScript. When verifying, always hash the value as PostgreSQL renders it —
as in the snippet above — or round-trip your copy through `::jsonb::text`.

## Operational notes

- **Permissions:** the module needs `CREATE` on the schema for first-time
  setup; after that, `INSERT`/`SELECT` on the two tables and `EXECUTE` on the
  two functions suffice.
- **Concurrency:** appends take a short `EXCLUSIVE` lock on the chain table
  (head lookup + insert must be atomic), so writes serialize per chain.
  Reads are unaffected. For write-heavy multi-tenant use, give tenants their
  own namespaces.
- **The SQL sources** ship in the package under `sql/` for review; the same
  text is embedded in the compiled module and is what `init()` executes.

## Roadmap

Possible future additions — all strictly additive (the chain tables are
frozen and will never change):

- `getEvent(eventId)` — fetch a single event's payload and timestamp;
- an async-iterator chain walker;
- `verifyChain()` — full chain re-verification in JS with Node `crypto`
  (until then, see the snippet above).

## Development

```sh
npm install
npm run build     # embeds sql/*.sql and compiles TypeScript
npm test          # integration tests against a real PostgreSQL
```

`npm test` bootstraps a throwaway PostgreSQL cluster with `initdb`/`pg_ctl`
(server binaries must be on `PATH`). Alternatively point it at any server:

```sh
docker compose -f test/docker-compose.yml up -d
TR_JSON_CHAIN_TEST_URL=postgres://postgres:postgres@localhost:5433/postgres npm test
```

## License

MIT
