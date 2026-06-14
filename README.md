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
function), on a **UTF-8 database** (`ENCODING 'UTF8'`, the default). No
extensions needed. The canonical-payload bytes are byte-verified identical
across PostgreSQL 11–18.

## Quick start

```js
const { Pool } = require('pg');
const { EventChainLogger } = require('tr-json-chain');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const log = new EventChainLogger(pool);

// Schema is ensured automatically on first use (or call log.init() eagerly).
const eventId = await log.recordEvent({ type: 'user.login', user: 42 });
console.log('event id:', eventId); // a 64-char hex string

const head = await log.getChainHead();
console.log('chain head:', head); // hex
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

The chain starts from a fixed **genesis row** (`id 0`) whose `event_id` and
`data_hash` are 256 zero bits, immediately followed by a **root event** (`id 1`)
carrying the chain's random UUID identity and creation time (and a
`"type": "chain-root"` marker — see
[event `type` convention](#event-type-convention) and [`init()`](#init-promisevoid)). Altering, removing, or reordering any historical event
changes every subsequent `event_id`, so the head id commits to the entire
history. Publish or cross-log a head id periodically and you have an
externally verifiable, tamper-evident audit log.

Two tables hold the data:

| table | contents |
|---|---|
| `event_chain` | the chain itself: `id BIGINT`, `parent_id`, `data_hash`, `event_id` (BYTEA) |
| `event_payload` | optional payload per event: `event_id` (FK), `ts TIMESTAMPTZ`, `d JSONB` |

`id` is a **dense, 0-based position** in the chain (genesis is `0`, the next
event `1`, and so on, with no gaps). It is assigned by the chain's stored
functions — each new id is the previous head's `id + 1`, computed under the
table's exclusive write lock — rather than by a sequence, so a rolled-back
transaction never leaves a hole. `id` is never hashed, so this addressing has
no bearing on chain integrity.

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
  `{ "type": "chain-root", "chain": "kukkuu", "ts": "<ISO 8601 UTC>", "foo": 1, "bar": [1, 2, 3] }`.
- `options.rootOmitDefaultData` — when `true`, omit the default `type`, `chain`
  and `ts` properties from the root event; with no `rootExtraData` the root
  event becomes simply `{}`. Default `false`. Also ignored on an
  already-initialized chain.
- `options.verifyChain` — when `true`, every `init()` re-verifies the **entire
  chain** server-side (re-hashing and re-linking every event in one SQL
  statement) instead of only the root event, throwing `ChainVerificationError`
  on any mismatch. Stronger but heavier — the cost scales with chain length.
  Default `false`. See [the canary check](#what-about-postgresql-upgrades).

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
   { "type": "chain-root", "chain": "<random-uuid>", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
   ```

   The UUID gives the chain a unique identity for the rest of its life; `ts`
   is the chain's creation time (ISO 8601 UTC) — `ts` is also the recommended
   conventional timestamp property for your own subsequent events, and `type`
   the recommended discriminator (see [event `type` convention](#event-type-convention)).
   The default
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

> **All identifiers and hashes returned by this API are lowercase hex strings**
> (`event_id`, `parent_id`, `data_hash` — 64 hex chars), never `Buffer`s. Every
> accessor that returns an *event* returns the same shape, the
> [`ChainEventDetail`](#getevents) below.

### `recordEvent(data, options?): Promise<string | ChainEventDetail>`

Appends an event. By default resolves to the new event's `event_id` as a hex
string; with `returnFullEventData: true` it resolves to the full
[`ChainEventDetail`](#getevents) instead.

- `data` — any JSON-serializable value (object, array, string, number,
  boolean, or `null`). `undefined` and functions throw `TypeError`.
- `options.storePayload` — when `false`, only the chain entry (hashes) is
  stored; the payload itself is discarded. The hash still commits to the
  payload, so you can later prove that a payload you retained out-of-band was
  recorded, without keeping it in the database. Default `true`.
- `options.returnFullEventData` — when `true`, resolve to the full event object
  (all fields populated, including the canonical `hashed_data`). This is the
  **only** way to obtain `hashed_data` for an event recorded with
  `storePayload: false`: record time is the only moment that canonical text
  exists (no payload row is kept), and it cannot be reproduced off-server — so
  retain it then if you want to prove the content later. Default `false`.

### `timestamp(options?): Promise<string | ChainEventDetail>`

Convenience shortcut that records the current time as an event:

```json
{ "type": "ts", "ts": "YYYY-MM-DDThh:mm:ss.mmmZ" }
```

Equivalent to `recordEvent({ type: 'ts', ts: new Date().toISOString() }, options)`
— same return contract (hex string, or the full object with `returnFullEventData`).

### `getChainHead(): Promise<string>`

Resolves to the `event_id` (hex) of the chain head. If the current head is not
already an *empty checkpoint event* (one with a zero `data_hash`), one is
appended first. Repeated calls therefore return the same id instead of piling
up empty events — so a head fetch is itself an auditable act: the returned id
commits to everything recorded before it. For a **read-only** peek at the
current tip (no checkpoint appended), use [`getEvent(-1)`](#geteventid-options).

### `getEvent(id, options?): Promise<ChainEventDetail | null>`

Returns a single event by its `id` (chain position) as a
[`ChainEventDetail`](#getevents), or `null` if no such event exists. A thin
wrapper over `getEvents` with `slice`-style indexing, so negatives count from
the end: `getEvent(-1)` is the last event (a non-mutating head peek),
`getEvent(0)` the genesis row, `getEvent(1)` the root. `options` are the same
`include*` flags as `getEvents`. Does **not** initialize the chain (throws
`ChainNotInitializedError` if uninitialized).

### `getRootEvent(options?): Promise<ChainEventDetail>`

Returns the chain's **root event** (the first event after genesis, carrying the
chain's identity) as a [`ChainEventDetail`](#getevents) — equivalent to
`getEvent(1, options)`, but it stays a "give me the root or fail" accessor:
it throws `ChainNotInitializedError` when no root exists (tables absent, or only
the genesis row). Does **not** initialize the chain.

### `verify(options?): Promise<VerifyResult>`

Verifies chain integrity server-side, on demand — the same check `init()` runs:
the root-event canary by default, or the **entire chain** with `{ full: true }`.
Resolves to `{ ok, mode: 'root'|'full', eventsChecked, firstBadId?, offending? }`.

- On an integrity mismatch it **throws** `ChainVerificationError` by default;
  pass `{ throwOnMismatch: false }` to instead resolve to `{ ok: false, … }` so
  audit/monitoring callers can branch on the result.
- Operational failures always throw regardless: `ChainNotInitializedError` if the
  chain doesn't exist, plus `sha256()`-support / connection errors.

### `getEvents(start?, end?, options?): Promise<{ events, start, end, have_more }>`

Returns a page of events addressed by `Array.prototype.slice` semantics, where
**the index equals the event's `id`** (genesis is `0`, the root event `1`, …).
`getEvents()` / `getEvents(0)` mean "all events".

```js
const { events, start, end, have_more } = await log.getEvents(0, 100);
// events: [ { id, event_id: '<hex>', data?: {…} }, … ]   (the ChainEventDetail shape)
// start/end: index (= id) of the first/last returned event
// have_more: true if the requested range holds more than was returned
```

- `start` / `end` follow `slice`: negatives count from the end (`getEvents(-5)`
  = last five), `end` is exclusive (`getEvents(5, 10)` = indices 5–9), an
  omitted or `null` `end` means "to the end" (`getEvents(5, -1)` drops only the
  last). Non-integer indices throw `TypeError`.
- **At most 1000 events per call** (or `options.maxEvents`, if smaller — it must
  be a positive integer, and values above 1000 are ignored). If the requested
  range is larger, that many are returned with `have_more: true`; continue from
  `result.end + 1`. An empty range yields `events: []`, `have_more: false`, and
  `end = start - 1`.

  ```js
  for (let x = await ec.getEvents(0); ; x = await ec.getEvents(x.end + 1)) {
    for (const ev of x.events) { /* … */ }
    if (!x.have_more) break;
  }
  ```
- Each event is `{ id, event_id: '<hex>' }` plus `data` (the JSONB payload) when
  one was stored — so the genesis row and empty checkpoint events have no `data`.
  `id` is the event's chain position (`event_chain.id`: genesis 0, root 1, …),
  always present, equal to the event's index in the chain.
- `options` (always the last argument; also valid as the sole or second
  argument) adds per-event fields, all hex/string and all default `false`:
  - `includeParentId` → `parent_id` (omitted for genesis, which has none);
  - `includeDataHash` → `data_hash` (always available);
  - `includeHashedData` → `hashed_data`, the `jsonb::text` whose UTF-8 bytes
    were hashed into `data_hash` (omitted when no payload was stored);
  - `maxEvents` → a smaller per-call cap (positive integer; `> 1000` ignored).
- Like `getRootEvent`, this does **not** initialize the chain; it throws
  `ChainNotInitializedError` if the chain is uninitialized.

This `{ id, event_id, data?, hashed_data?, data_hash?, parent_id? }` object is
the **`ChainEventDetail`** shape returned by every event accessor (`getEvents`,
`getEvent`, `getRootEvent`, and `recordEvent`/`timestamp` with
`returnFullEventData`). `id`/`event_id` are always present; the rest appear when
available/requested. `data` is the **normalized** payload (what `jsonb` parsed
back to), so the same event has the same `data` from any accessor.

### Errors

| class | thrown when |
|---|---|
| `SchemaMismatchError` | a pre-existing table doesn't match the frozen shape (nothing is touched) |
| `ChainVerificationError` | hash re-verification fails at `init()` or `verify()` (tampering, or an incompatible server) |
| `ChainNotInitializedError` | a read accessor (`getEvents` / `getEvent` / `getRootEvent` / `verify`) is used before the chain exists |
| `UnsupportedPostgresError` | the server lacks built-in `sha256()` (PostgreSQL < 11) |
| `TypeError` | invalid namespace or non-JSON-serializable event data |
| `SealPrecheckError` | (`EventChainScheduler`) a seal's signing key doesn't match the chain-root `sealKey` |
| `SchedulerEndedError` | (`EventChainScheduler`) any method called after `end()` |

## Event `type` convention

The chain stores arbitrary JSON, so it does not impose a schema — but mixing
event kinds in one append-only log is much easier to consume if every event
carries a discriminator. The recommended convention is a top-level **`type`**
string:

```js
await log.recordEvent({ type: 'user.login', user: 42, ip: '…' });
await log.recordEvent({ type: 'order.placed', order: 1001, total: 9.95 });
```

The two events the library generates itself follow it:

- the **root event** is `{ "type": "chain-root", "chain": "<uuid>", "ts": "…" }`;
- **`timestamp()`** records `{ "type": "ts", "ts": "…" }`.

This is only a convention — nothing in the chain enforces or depends on it, and
you can drop it from the root event with `rootOmitDefaultData`. (`ts`, an ISO
8601 UTC timestamp, is the companion convention for an event's own time.)

The optional, growing vocabulary of well-known event shapes (`chain-root`, `ts`,
`seal`) and the `type`-namespacing convention are documented in
[`CANONICAL-EVENTS.md`](CANONICAL-EVENTS.md). None of it affects chain integrity —
a chain can be created and verified while ignoring it entirely.

## Periodic events: `EventChainScheduler`

`EventChainScheduler` is an **optional, separately-importable** helper (like the
CSV classes) that drives an `EventChainLogger` to record periodic events on
independent timers. It is fully independent of the main class — it only calls the
logger's existing public write API and changes nothing about the chain format. Its
sole dependency is `node:crypto`.

It records two canonical event kinds:

- **`timestamp`** — a `{ "type": "ts", "ts": … }` heartbeat (via `logger.timestamp()`).
- **`seal`** — a `{ "type": "seal", "ts": …, "sealed-head": …, "seal": <JWT> }`
  event: an externally-signed (JWT/JWS) attestation that a recent chain position
  was reached by the holder of the seal's **private** key. The matching **public**
  key is published in the chain-root `sealKey`. Seals let a consumer distinguish a
  chain's authentic prefix from anything appended later or on a fork. See
  [`CANONICAL-EVENTS.md`](CANONICAL-EVENTS.md#seal) for the full seal specification.

```js
const { EventChainLogger, EventChainScheduler } = require('tr-json-chain');

// One-time, offline: mint a seal key pair.
const { publicKey, secretKey } =
  EventChainScheduler.generateSealKeyPair('ES256', { kid: 'seal-2026' });

// Publish the PUBLIC key in the chain-root at creation time:
const log = new EventChainLogger(pool, { rootExtraData: { sealKey: publicKey } });

// In a long-running process: heartbeat every minute, seal every hour.
const sched = new EventChainScheduler(log, {
  onError: (err, handle) => console.error('scheduler error', err),
});
sched.on('seal',      ({ sealedHead }) => console.log('sealed', sealedHead));
sched.on('timestamp', ({ eventId })   => console.log('ts', eventId));

const tsHandle   = sched.scheduleTimestamp(60);
const sealHandle = sched.scheduleSeal(secretKey, 3600); // keep `secretKey` secret

process.on('SIGTERM', () => sched.end());
```

### `new EventChainScheduler(logger, options?)`

Wraps a live `EventChainLogger`. The constructor performs no database access; the
chain is touched lazily on the first tick. Extends Node's `EventEmitter`.

`options`:

| option | meaning |
|---|---|
| `onError(err, handle?)` | convenience `'error'` listener (same as `scheduler.on('error', …)`) |
| `clock()` | epoch-ms clock; defaults to `Date.now` (for deterministic tests) |
| `setTimer(fn, ms)` / `clearTimer(token)` | timer hooks; default to `setTimeout`/`clearTimeout` (the defaults `unref()` their timers, so a scheduler never keeps a process alive on its own) |

Emitted events:

| event | payload | when |
|---|---|---|
| `'seal'` | `{ handle, eventId, sealedHead }` | a `seal` event was recorded |
| `'timestamp'` | `{ handle, eventId }` | a `ts` event was recorded |
| `'error'` | `(error, handle?)` | a tick failed (standard `EventEmitter` semantics — attach a listener or `onError`) |

### `scheduleSeal(secretKey, intervalSeconds): handle`

Records a `seal` every `intervalSeconds`. `secretKey` is a **private JWK** (e.g.
the `secretKey` from `generateSealKeyPair`); its `alg` selects the algorithm and
its `kid`, if present, goes into the JWT header. Returns an opaque handle.

On the **first** tick the scheduler verifies the chain-root's public `sealKey`
against the signing key — the **public key itself must match** (its `kid`/`alg`
are checked only if present in the root key). On mismatch (or if the root has no
usable `sealKey`/`chain`) it emits a `SealPrecheckError` via `'error'` and
**auto-unschedules that seal**, so it never mints unverifiable seals.

### `scheduleTimestamp(intervalSeconds): handle`

Records a `ts` event every `intervalSeconds` (via `logger.timestamp()`). Returns
an opaque handle.

> **Cadence.** The first tick of a schedule fires after a short randomized delay
> (1–2 s). Thereafter the next tick is armed only once the current one completes,
> at `start + intervalSeconds`, but never sooner than 1 s after completion — so
> ticks of one schedule never overlap.

### `unschedule(handle?)` / `end()`

- `unschedule(handle)` cancels one schedule; `unschedule()` cancels all. Cancelling
  an unknown/already-cancelled handle is a no-op.
- `end()` cancels everything, detaches the logger, and renders the instance inert:
  every subsequent instance method (including a second `end()`) throws
  `SchedulerEndedError`.

### `static EventChainScheduler.generateSealKeyPair(alg, options?)`

Generates a seal key pair, returning `{ publicKey, secretKey }` (both JWKs, each
carrying `alg`, `kid`, and `use: "sig"`). Publish `publicKey` in the chain-root
`sealKey`; keep `secretKey` private and pass it to `scheduleSeal`.

- `alg` — one of `ES256`, `ES384`, `ES512`, `RS256`, `RS384`, `RS512`, `PS256`,
  `PS384`, `PS512`.
- `options.kid` — written into both JWKs; defaults to a random UUID.
- `options.modulusLength` — RSA algorithms only (a `TypeError` for EC). Defaults
  to 2048 / 3072 / 4096 for the 256 / 384 / 512 families; below the family minimum
  or above 8192 throws `RangeError`.

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

The chain tables' DDL is **frozen** as of `1.0.0`. New versions of this module
may replace the stored functions, but will never `ALTER`, `DROP`, or otherwise
migrate `event_chain` / `event_payload`, and will never change how `event_id` or
`data_hash` are computed. On every `init()` the module *verifies* existing tables
and refuses to proceed on any mismatch — it has no code path that modifies an
existing table.

This is what makes the chain trustworthy long-term: a chain recorded today
remains verifiable, byte for byte, against any future version of this module.

> The complete, frozen on-disk format and hash specification lives in
> [`FORMAT.md`](FORMAT.md) — the authoritative reference for re-implementers.

## Versioning and compatibility

This project follows semantic versioning. Its compatibility promise is about
the **on-disk chain** — whether a chain written by one version can be opened
and extended by another.

- **Chain integrity is preserved across every version.** The hashing rules
  (`event_id` / `data_hash`) and the linked-list structure never change, so a
  chain is always internally verifiable regardless of which version wrote it.
- **The on-disk shape is frozen as of `1.0.0`.** The
  [never-migrate guarantee](#the-never-migrate-guarantee) is in force: every
  release from `1.0.0` onward opens any chain back to `1.0.0`, byte for byte.
  When a future major version changes something *additive*, the README will say
  exactly how far back compatibility reaches — e.g. at `2.0.0`, *"chains are
  fully backward compatible down to 1.0.0."*
- **History (the `0.x` series finalized the shape).** Before `1.0.0` the layout
  was still being settled, so some `0.x` releases reject chains from an older
  one. In particular: **`0.4.0` is not compatible with chains created by
  `0.1.0`–`0.3.0`** — `event_chain.id` changed from a serial (starting at 1) to
  the caller-assigned, dense, 0-based position (genesis `id 0`) used ever since;
  `init()` rejects a pre-`0.4.0` chain with a `SchemaMismatchError`. The old
  chain's integrity is unaffected, but you must start a new chain (or namespace)
  to use `0.4.0+`. There are no such breaks from `1.0.0` onward.

## Hash specification (for independent verifiers)

The chain is designed so that, given an export, **anyone can write an integrity
checker in any language in well under an hour** — no PostgreSQL, no JSON
library, no knowledge of this module required. It uses only **SHA-256**; every
`event_id`, `parent_id`, and `data_hash` is a 32-byte value (64 lowercase hex
characters in an export). Two rules define the entire chain:

```
data_hash = SHA256( canonical_payload_bytes )
event_id  = SHA256( parent_id ‖ data_hash )      // SHA-256 of the 64-byte concatenation
```

with three fixed conventions:

1. **Genesis** (the first event, `id 0`): `data_hash` and `event_id` are both
   **32 zero bytes**, and it has no parent. These are constants — *not* the hash
   of anything.
2. **Empty / payload-less events** (the checkpoint events `event_head()` may
   append, or any event recorded with payload storage off): an empty checkpoint
   event's `data_hash` is **32 zero bytes** (it is *not* `SHA256("")`). With no
   payload, a verifier cannot recompute such an event's `data_hash`; it trusts
   the stored value when checking `event_id`.
3. **`parent_id`** of every non-genesis event equals the previous event's
   `event_id`.

### The one compatibility-critical detail: canonical payload bytes

`canonical_payload_bytes` are the **UTF-8 bytes of PostgreSQL's `jsonb` text
rendering** of the payload — *not* your original JSON string. That rendering
sorts object keys (by length, then bytewise), puts exactly one space after each
`:` and `,`, drops duplicate keys (last wins), and normalizes numbers and
string escapes.

**You should not reproduce that rendering yourself.** Instead, an export carries
the canonical text **verbatim** (the `hashed_data` field, i.e. `jsonb::text`),
and a verifier **hashes those exact bytes** — it never parses or re-serializes
JSON, so it needs zero knowledge of `jsonb` normalization. This is the whole
trick that keeps independent verification trivial and stable.

> ⚠ Only event *creation* (or re-deriving a payload's hash from a parsed object)
> depends on matching PostgreSQL's normalization. *Verification from an export
> that includes `hashed_data`* does not — never hash your own re-serialization.

**The thing of record is the canonical text, not any object.** The hash commits
to the `hashed_data` bytes; how a producer's in-memory value became JSON (and how
a consumer re-parses those bytes back into an object) is outside the guarantee
and can be lossy in either language — e.g. a JSON integer beyond 2⁵³ re-parses to
a different `number` in JavaScript. Consumers that need exactness use
`hashed_data` (the text), never a re-parsed object. If you need an exact large
integer or decimal preserved, encode it as a JSON **string**. See
[`FORMAT.md` §4](FORMAT.md) for the full trust boundary and number caveats.

### Reference export (one self-describing record per event)

`getEvents(0, { includeParentId: true, includeDataHash: true, includeHashedData: true })`
(paged via `have_more`) yields exactly what a portable verifier needs — e.g. as
NDJSON, in ascending `id` order:

```json
{"event_id":"0000…0000","data_hash":"0000…0000"}
{"event_id":"4fcb…bd44","parent_id":"0000…0000","data_hash":"f9d8…1310","hashed_data":"{\"ts\": \"2026-06-08T…Z\", \"type\": \"chain-root\", \"chain\": \"8a2af…d769f\"}"}
{"event_id":"2e9f…d243","parent_id":"4fcb…bd44","data_hash":"6929…cc1b","hashed_data":"{\"a\": 1}"}
```

(`parent_id` is absent for genesis; `hashed_data` is absent for payload-less
events.)

### Verification algorithm (language-agnostic)

```
prev := none
i    := 0
for each event e, in ascending id order starting at 0:
    if i == 0:                                    # genesis
        require e.event_id  == 32 zero bytes
        require e.data_hash == 32 zero bytes
        require e has no parent_id
    else:
        require e.parent_id == prev               # chain link
        if e has hashed_data:                      # payload present
            require SHA256(utf8(e.hashed_data)) == e.data_hash
        require SHA256(e.parent_id ++ e.data_hash) == e.event_id
    prev := e.event_id
    i    := i + 1
```

That is the entire checker: SHA-256 over byte strings you are handed — no JSON
library, no PostgreSQL, any language.

## Verifying a chain independently (with live DB access)

If you have a connection rather than an export, the same checks run directly
against the tables — here PostgreSQL renders the canonical payload text for you
via `d::text`:

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
is not formally guaranteed.

**Cross-version compatibility is verified, not assumed.** A committed corpus of
adversarial JSON payloads (key ordering, duplicate keys, number formats, Unicode
escapes and normalization, emoji, RTL scripts, …) is hashed and checked to render
**byte-identically across every supported PostgreSQL major version, 11 through
18** — so a chain recorded on one of these and re-verified on another reproduces
the exact same `data_hash` and `event_id`. As further insurance, every `init()`
runs a **canary check**: it re-hashes the chain's root event server-side using
the exact
expressions `event_record()` uses. If a server ever rendered or hashed JSONB
incompatibly — or the root event was tampered with — connecting fails loudly
with `ChainVerificationError` instead of the chain silently becoming
unverifiable.

For a stronger guarantee, the `verifyChain: true` constructor option escalates
this canary from the root event to the **whole chain**: a single SQL statement
re-derives `data_hash` (where a payload is stored) and `event_id` for every row
and re-checks every link, raising `ChainVerificationError` on the first
mismatch. It scales with chain length, so it's opt-in rather than the default.

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

## Author

Timo J. Rinne <tri@iki.fi>

## License

MIT
