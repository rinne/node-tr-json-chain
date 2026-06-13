# tr-json-chain — frozen on-disk format & hash specification

This document is the **authoritative, frozen specification** of the
`tr-json-chain` on-disk format and hashing. It is the single source of truth a
re-implementer (or a future maintainer) treats as law.

> **Frozen as of 1.0.0.** The table shapes, the genesis convention, head
> selection, the `id` scheme, and the hash algorithm described here are
> **permanent**. No future version will `ALTER`/rewrite `event_chain` /
> `event_payload` or change how `event_id` / `data_hash` are computed. Schema
> evolution may only *add new objects alongside* and *replace stored functions*
> (`CREATE OR REPLACE` — functions are not part of integrity). A chain recorded
> against any 1.x/2.x release remains verifiable, byte for byte, forever.
>
> (Historical note: during the `0.x` series the shape was still being finalized
> — `0.4.0` changed `event_chain.id` from a serial to the dense 0-based scheme
> below, and chains from `0.1.0`–`0.3.0` are intentionally rejected. From 1.0.0
> onward there are no such breaks.)

The format requires **PostgreSQL ≥ 11** and **no extensions**: `sha256()` is a
core function since v11 (pgcrypto is *not* needed — it only provides `digest()`).
The canonical payload bytes are PostgreSQL's `jsonb` text rendering, which is
verified to be byte-identical across PostgreSQL 11–18.

Throughout, `{ns}` is the optional namespace prefix (e.g. `myapp_`), empty by
default; it lets one database hold several independent chains. It is strictly
validated (`^[a-z][a-z0-9_]*$`, ≤ 39 chars) before interpolation into DDL.

---

## 1. Tables

### 1.1 `{ns}event_chain` — the chain

The hash chain itself: one row per event, including the genesis row.

| column | type | null | notes |
|---|---|---|---|
| `id` | `BIGINT` | NOT NULL | **Primary key.** Caller-assigned dense 0-based position (genesis 0, root 1, …). Never hashed. |
| `parent_id` | `BYTEA` | NULL | The parent event's `event_id` (32 bytes). `NULL` **only** for the genesis row. `UNIQUE`. Foreign key → `{ns}event_chain(event_id)`. |
| `data_hash` | `BYTEA` | NOT NULL | 32 bytes. SHA-256 of the canonical payload bytes (see §3), or 32 zero bytes for genesis / empty events. |
| `event_id` | `BYTEA` | NOT NULL | 32 bytes. The event's identity (see §3). `UNIQUE`. |

Constraints / indexes (all part of the frozen shape):

- `PRIMARY KEY (id)`.
- `parent_id` is `UNIQUE` — **forbids forks** (no two events may share a parent).
- `parent_id` is a foreign key to this table's own `event_id` — **forbids
  orphans** (every non-genesis parent must exist).
- `event_id` is `UNIQUE`.
- A **partial unique index** `{ns}event_chain_one_genesis ON ((true)) WHERE
  parent_id IS NULL` — **forbids a second genesis** (at most one row may have a
  `NULL` parent).

Together these make the table a structurally-enforced singly-linked list with
exactly one root and no forks.

### 1.2 `{ns}event_payload` — payload storage

Optional per-event payload, keyed by `event_id`. A chain entry in
`event_chain` exists whether or not a payload row is stored here.

| column | type | null | notes |
|---|---|---|---|
| `event_id` | `BYTEA` | NOT NULL | **Primary key.** Foreign key → `{ns}event_chain(event_id)`. |
| `ts` | `TIMESTAMPTZ` | NOT NULL | Insertion time; `DEFAULT CURRENT_TIMESTAMP`. **Not hashed** — informational only. |
| `d` | `JSONB` | NOT NULL | The stored payload value. Its `::text` rendering is the canonical payload text (§3). |

`ts` and the payload-vs-no-payload choice have **no bearing on integrity**: the
chain's hashes are fully determined by `event_chain` plus, where present, the
`d` value in `event_payload`.

### 1.3 Exact DDL (frozen bootstrap)

Everything is create-if-absent and idempotent; the module never `ALTER`s or
`DROP`s an existing object. Verbatim from `sql/tables.sql`:

```sql
CREATE TABLE IF NOT EXISTS {ns}event_chain (
  id BIGINT NOT NULL,
  parent_id BYTEA UNIQUE REFERENCES {ns}event_chain(event_id),
  data_hash BYTEA NOT NULL,
  event_id BYTEA UNIQUE NOT NULL,
  PRIMARY KEY (id)
);

CREATE UNIQUE INDEX IF NOT EXISTS {ns}event_chain_one_genesis
  ON {ns}event_chain ((true)) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS {ns}event_payload (
  event_id BYTEA NOT NULL REFERENCES {ns}event_chain(event_id),
  ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  d JSONB NOT NULL,
  PRIMARY KEY (event_id)
);
```

---

## 2. The genesis row

A virgin chain is bootstrapped with exactly one **genesis row**, inserted only
when the table is empty (guarded by the partial unique index against races):

- `id` = `0`
- `parent_id` = `NULL`
- `data_hash` = **32 zero bytes** (a constant — *not* the hash of anything)
- `event_id` = **32 zero bytes** (a constant)

The genesis row carries no payload. The **root event** (the chain's identity) is
the first event recorded after genesis, at `id = 1`; it is an ordinary event
(§3), not part of this bootstrap.

---

## 3. Hashing & chaining

Two equations define the entire chain. All hashes are **SHA-256**; every
`event_id`, `parent_id`, and `data_hash` is a 32-byte value.

```
data_hash = SHA256( canonical_payload_bytes )
event_id  = SHA256( parent_id ‖ data_hash )       // SHA-256 over the 64-byte concatenation
```

with these fixed rules:

1. **Canonical payload bytes** = the UTF-8 encoding of PostgreSQL's `jsonb` text
   rendering of the payload — i.e. `convert_to(d::text, 'UTF8')`. **Not** the
   caller's original JSON string. See §4.

2. **Genesis** (`id 0`): `data_hash` and `event_id` are both 32 zero bytes, and
   `parent_id` is `NULL`. Constants, not hashes.

3. **Empty / checkpoint events** (recorded with payload storage off, or appended
   by the head function): `data_hash` is **32 zero bytes** (it is *not*
   `SHA256("")`). `event_id` is still `SHA256(parent_id ‖ data_hash)` and the
   event still links normally. No `event_payload` row exists, so a verifier
   cannot recompute such an event's `data_hash` and trusts the stored value when
   checking `event_id`.

4. **`parent_id`** of every non-genesis event equals the **previous event's
   `event_id`** (the row with `id` one less). This is what `‖` chains together.

The recorder computes these exactly as (verbatim intent of `sql/functions.sql`):

```
d         := convert_to(event_data::text, 'UTF8')   -- canonical payload bytes
data_hash := sha256(d)
event_id  := sha256(parent_event_id || data_hash)   -- parent_event_id is the head's event_id
```

### 3.1 `id` assignment (dense, gap-free)

A new event's `id` is the current head's `id + 1`, computed under a
`LOCK TABLE {ns}event_chain IN EXCLUSIVE MODE` so that "find the head" and
"insert the new head" are atomic. Because no sequence is used, ids are **dense
and gap-free even across rolled-back transactions** (genesis 0, root 1, 2, 3, …).
`id` is never hashed and has no bearing on integrity; it exists purely to make
positional/range access trivial (index === id).

### 3.2 Head selection

The chain **head** is simply the row with the highest `id`
(`ORDER BY id DESC LIMIT 1`, under the exclusive lock). A "get head" operation
that finds the head is *not* already an empty checkpoint (i.e. its `data_hash`
is non-zero) appends one empty checkpoint event (rule 3) and returns that;
otherwise it returns the existing head. Repeated calls therefore do not pile up
empty events.

---

## 4. The one compatibility-critical detail: canonical payload bytes

`canonical_payload_bytes` are the UTF-8 bytes of PostgreSQL's `jsonb` text
rendering. That rendering **normalizes** the input:

- object keys are sorted (by length, then bytewise);
- exactly one space follows each `:` and `,`;
- duplicate keys are collapsed (last value wins);
- numbers are canonicalized (e.g. `1e3` → `1000`, `1E3` → `1000`, `-0` → `0`,
  `1e-7` → `0.0000001`; trailing zeros in a written decimal are preserved, e.g.
  `1.0` stays `1.0`, `100.00` stays `100.00`; integers keep full precision);
- string escapes are canonicalized (e.g. `a` → `a`, `\/` → `/`), while
  control characters remain `\uXXXX`;
- Unicode is **not** normalized (a combining sequence and its precomposed form
  stay distinct — they hash differently).

**A verifier should never reproduce this rendering itself.** Instead, an export
carries the canonical text **verbatim** (the `hashed_data` field, i.e.
`d::text`), and the verifier hashes those exact bytes — so it needs zero
knowledge of `jsonb` normalization. Only event *creation* (or re-deriving a
hash from a parsed object) depends on matching PostgreSQL's rendering.

### 4.1 The trust boundary (what is and isn't guaranteed)

The thing of record is the **canonical text** (`hashed_data`), not any object.
There are two transformations between a producer's in-memory value and the hash;
only the second is inside the guarantee:

1. **producer value → JSON text → stored `jsonb`** — *outside* the boundary, and
   not provable in general. How an object becomes JSON is producer- and
   language-dependent (`JSON.stringify` choices, whitespace, number formatting,
   UTF-8 encoding, duplicate keys, key order; non-JSON-native languages such as
   Python, Swift, Perl, or C differ again). The chain neither guarantees nor
   needs to constrain this step. *Example:* in JavaScript `JSON.stringify({ x:
   1e500 })` is `{"x":null}` — `1e500` overflows to `Infinity`, which JSON cannot
   represent, so it becomes `null` *before PostgreSQL is even involved*. The
   chain then faithfully records exactly that (`hashed_data` = `{"x": null}`); the
   loss was the producer's, and the chain's job is only to certify what it was
   handed.
2. **stored `jsonb` → `jsonb::text` → `data_hash`** — *inside* the boundary, and
   the integrity-critical route. `data_hash = SHA256(utf8(hashed_data))`, where
   `hashed_data` is exactly that `jsonb::text`. The guarantee is that this
   rendering is immutable across PostgreSQL versions (§4.3), continuously guarded
   by the smoke tests, so the bytes that were hashed are recoverable verbatim and
   re-verifiable forever.

A direct consequence — **and not a problem:** taking `hashed_data` and parsing it
back into a language's object model (e.g. `JSON.parse` in JS) may *not* yield a
value deep-equal to the producer's original object. The sharpest case is a large
integer: a non-JS producer emits JSON text `9007199254740993`, PostgreSQL stores
and renders it exactly, and the hash commits to that exact text — yet JS
`JSON.parse` returns `9007199254740992` (lossy). The chain is unharmed: it
certifies the canonical bytes that were committed and recovers them verbatim;
re-parsing into an object is a downstream convenience, not part of the integrity
contract. **Consumers that need exactness must use `hashed_data` (the text), not
a re-parsed object.** (This is why `getEvents` exposes both `data` — a possibly
lossy driver-parsed object — and `hashed_data` — the exact bytes — and why
`recordEvent(..., { returnFullEventData: true })` returns `hashed_data`.)

### 4.2 Numbers caveat (for producers)

The normalization above is PostgreSQL's and is self-consistent and stable. But a
value can be **skewed before it reaches PostgreSQL** — e.g. a JavaScript `number`
larger than 2⁵³ or a binary-floating-point decimal loses precision in JSON
serialization on the *client* side, independent of this format. If you need an
exact large integer or exact decimal preserved, encode it as a JSON **string**.
The chain only guarantees that whatever JSON PostgreSQL ingests renders back to
the same canonical text (and thus the same hash) on every supported version.

### 4.3 Cross-version stability (verified)

Chain *links* are immune to server changes — `event_id = SHA256(parent_id ‖
data_hash)` is computed over stored bytes and never re-rendered. Re-verifying a
*payload* depends on `jsonb::text` rendering being identical to record time.
That rendering has been byte-stable since PostgreSQL 9.4; this project verifies
it empirically: a committed adversarial corpus (`test/jsonb-vectors.json`)
renders **byte-identically on PostgreSQL 11, 12, 13, 14, 15, 16, 17, and 18**.
As insurance, the library re-hashes the chain (root by default, or all of it on
request) on connect and raises an error rather than letting a hypothetical
future divergence pass silently.

---

## 5. Verification algorithm (language-agnostic)

Given an export in ascending `id` order, where each record carries `event_id`,
`parent_id`, `data_hash`, and (when a payload is present) the verbatim canonical
text `hashed_data`:

```
prev := none
i    := 0
for each event e, in ascending id order starting at 0:
    if i == 0:                                     # genesis
        require e.event_id  == 32 zero bytes
        require e.data_hash == 32 zero bytes
        require e has no parent_id
    else:
        require e.parent_id == prev                # chain link
        if e has hashed_data:                       # payload present
            require SHA256(utf8(e.hashed_data)) == e.data_hash
        require SHA256(e.parent_id ‖ e.data_hash) == e.event_id
    prev := e.event_id
    i    := i + 1
```

That is the entire checker — SHA-256 over byte strings, no JSON library and no
PostgreSQL required. The standalone `tr-json-chain-check` (in
`tr-json-chain-tools`) is a reference implementation of exactly this.

---

## 6. What is frozen vs. free to change

**Frozen (this document):** the two table shapes and all their constraints/
indexes; the genesis convention; the empty-event convention; head selection; the
dense `id` rule; the two hash equations and the canonical-bytes definition.

**Free to evolve** (never affecting an existing chain's verifiability):

- Stored functions (`event_record`, `event_head`, …) — replaced with
  `CREATE OR REPLACE`; they are not part of integrity. They may change *how* they
  are written but never *what* `event_id` / `data_hash` come out to.
- *New* objects added alongside (new tables/indexes/functions), never altering
  `event_chain` / `event_payload`.
- The library/tooling API surface (additively).

---

## 7. Enforcement note (what the library checks on connect)

On `init()` the library:

- probes `sha256()` and refuses servers older than PostgreSQL 11;
- **verifies the column shape** of any pre-existing `event_chain` /
  `event_payload` (name, type, nullability, in order) against §1 and refuses to
  proceed — never altering — on a mismatch (`SchemaMismatchError`);
- verifies the genesis row (exactly one `parent_id IS NULL` row, at `id 0`, with
  all-zero hashes);
- re-hashes the chain server-side as a canary (the root event by default, or the
  entire chain on request), raising `ChainVerificationError` on any mismatch.

> Scope note: the automatic shape check compares **columns** (name / type /
> nullability). The constraints and indexes in §1 (PK, the two `UNIQUE`s, both
> FKs, the partial single-genesis index) are created by the frozen bootstrap DDL
> and are what *enforce* structure at write time; they are part of the frozen
> format, but the reconnect-time verifier does not separately re-introspect them.
> A full structural audit of a foreign database should check them against §1
> directly.
