# Canonical events

> **This document is entirely optional and has nothing to do with chain
> integrity.** The hash chain is verifiable, tamper-evident, and complete
> without any of the conventions below. You can create a chain with an empty
> root event (`rootOmitDefaultData`, no extra data) and record fully arbitrary
> JSON objects forever; the chain links, the hashing, and every verifier still
> work exactly the same. See [`FORMAT.md`](FORMAT.md) for what is actually
> guaranteed and frozen — *that* is the contract.
>
> What this document adds is purely a layer of **shared meaning** on top of the
> bytes: a small, growing vocabulary of well-known event shapes so that
> independent producers and consumers can agree on what an event *is* without
> prior arrangement. If you adopt it, you (or your readers) know what each event
> means. If you don't, that's a perfectly legitimate choice — it simply means
> you either carry that meaning out-of-band, or it isn't relevant to you (e.g.
> the chain is used as an immutable "syslog" where the payloads are opaque).
>
> Nothing here is enforced by the library. These are conventions, not schema.

## Conventions

Canonical events are plain JSON objects (the same objects you record with
`recordEvent`). Two properties are conventional across all of them:

- **`type`** — a string discriminator naming the event's kind. Every canonical
  event has one. Unknown types should be ignored by a consumer, not rejected.
- **`ts`** — an ISO 8601 timestamp in **UTC** (e.g. `2026-06-14T12:34:56.789Z`),
  present on any event that has a meaningful point in time.

A canonical event may carry **additional, arbitrary properties** beyond the
mandatory ones for its type. Consumers should tolerate unknown properties.

> **Reminder on the trust boundary.** What is hashed and verified is the
> canonical `jsonb::text` of the payload, not your in-memory object (see
> [`FORMAT.md`](FORMAT.md) §4). The conventions here describe the *object you
> record*; they do not change anything about how it is stored or hashed.

### Type namespacing

To keep application-defined event types from colliding, the `type` property is
canonically **scoped to a namespace** by prefixing it, using `:` (colon) as the
separator. The **last** component is the event type proper; everything before it
is the namespace.

Namespaces are **hierarchical**, written from the broadest scope on the left to
the narrowest on the right — for example organization, then unit or project,
then product, and so on:

```
myapp:start
myapp:stop
myapp:log

mycompany:myapp1:log
mycompany:myapp2:log

myself@somewhere.com:event
```

So `mycompany:myapp1:log` is a `log` event scoped to `myapp1` within
`mycompany`. There is no fixed depth: a single namespace component is fine, and
deeper hierarchies are allowed, but **overly deep hierarchies are discouraged**
— how to partition the scope is entirely up to you. Anything that uniquely
identifies the owner works as the top-level component (a company name, a domain,
even a personal email address for strictly personal use).

The **well-known types** defined in this document (such as `chain-root` and
`ts`) are deliberately **unnamespaced**: they are reserved, shared names meant
to be used as-is. Think of them like IANA well-known TCP port numbers or the
standard JWT claims — nothing technically forces anyone to honor them, but
everything interoperates better when they are used as defined. Conversely,
nothing prevents you from defining a namespaced variant of a well-known type
(e.g. `mycompany:ts`), or from repurposing a well-known one, if you genuinely
need to extend or change its meaning.

For your own application-specific types, **namespacing is encouraged** — it is
what keeps them from colliding with the well-known names or with each other.

---

## `chain-root`

The first event after genesis (`id 1`), identifying the chain. Recorded
automatically by the library when an empty chain is first initialized; the
defaults can be shaped or suppressed via the `rootExtraData` /
`rootOmitDefaultData` constructor options.

### Type

```json
"type": "chain-root"
```

### Mandatory properties

| property | type | meaning |
|---|---|---|
| `chain` | string | an identifier for this chain (the library defaults to a random UUID) |
| `ts` | string | chain creation time, ISO 8601 UTC |

### Optional properties

| property | type | meaning |
|---|---|---|
| `sealKey` | object | a **public** JWK used to verify [`seal`](#seal) events on this chain (see below) |

`sealKey` enables [seals](#seal). It is a JSON Web Key (RFC 7517) holding the
**public** verification key only — never private key material, since the root
event is world-readable and anyone able to read it could otherwise forge seals.
The corresponding private key is held off-chain by whoever mints seals.

- The key MUST be usable for JWT signature verification with one of the
  permitted algorithms (see [`seal`](#seal)).
- The `alg` member SHOULD be present in the key.
- The `kid` member SHOULD be present in the key.

A single `sealKey` is fixed for the chain's lifetime (the root event is
immutable). Key rotation is intentionally **not** specified here; a future
extension may introduce a new key via an event that embeds the new public key
signed by the previous one.

### Example

```json
{ "type": "chain-root", "chain": "kukkuu", "ts": "2026-06-14T12:00:00.000Z" }
```

With a seal key:

```json
{
  "type": "chain-root",
  "chain": "kukkuu",
  "ts": "2026-06-14T12:00:00.000Z",
  "sealKey": {
    "kty": "EC",
    "crv": "P-256",
    "x": "f83OJ3D2xF1Bg8vub9tLe1gHMzV76e8Tus9uPHvRVEU",
    "y": "x_FEzRu9m36HLN_tue659LNpXW6pCyStikYjKIWI5a0",
    "alg": "ES256",
    "kid": "seal-2026"
  }
}
```

---

## `ts`

A bare timestamp / checkpoint event. Recorded by the `timestamp()` convenience
method. Useful as a periodic heartbeat or as a notarized point in time.

### Type

```json
"type": "ts"
```

### Mandatory properties

| property | type | meaning |
|---|---|---|
| `ts` | string | the recorded point in time, ISO 8601 UTC |

### Example

```json
{ "type": "ts", "ts": "2026-06-14T12:34:56.789Z" }
```

---

## `seal`

A seal binds a recent chain position to an **externally-held private key** by
embedding a signed JWT that names the sealed `event_id`. The chain on its own is
tamper-evident, but an adversary with write access could in principle re-hash the
entire chain wholesale; a seal — signed with a key that adversary does not hold,
over a chain position they cannot re-sign — is the non-repudiable anchor that
defeats that. Seals are entirely optional and have no bearing on chain integrity;
a chain with no [`sealKey`](#chain-root) simply has no verifiable seals.

A seal also addresses a second, more fundamental point: **appending to the chain
is not restricted.** Anyone who can export the chain can, to whatever end,
"fork" it and simply keep adding their own events to their own copy — this is an
inherent property of the format, not a flaw. A seal marks the point up to which
the events (specifically, up to and including the `sealed-head` event) are
cryptographically affirmed to have been added by the **original chain holder**
— the party holding the private half of the seal key. Events that appear after a
seal, or on a fork that the seal key holder never sealed, carry no such
attestation. Sealing periodically therefore lets consumers distinguish the
authentic prefix of a chain from anything appended later or elsewhere; this is
valuable for some use cases and irrelevant for others.

The sealed event need not be the immediate predecessor of the seal event: when
the chain is idle the sealed head is typically the head itself, but it is fine
for unrelated events to appear between the sealed event and the seal event. By
construction the sealed event is always an ancestor of the seal event.

### Type

```json
"type": "seal"
```

### Mandatory properties

| property | type | meaning |
|---|---|---|
| `ts` | string | when the seal was created, ISO 8601 UTC (same instant as the JWT's `iat`) |
| `sealed-head` | string | the sealed `event_id`, lowercase hex (equal to the JWT's `sealed-head` claim) |
| `seal` | string | a compact JWS / JWT signed with the chain's seal key (below) |

### How a seal is produced

1. Retrieve the chain **head** `event_id`. Per the head convention the library
   appends an empty event first unless the head already is one, so the sealed
   position is a stable checkpoint.
2. Build and sign a JWT with the chain's private seal key:

   **Protected header**

   | member | value |
   |---|---|
   | `alg` | the signature algorithm (see below) |
   | `kid` | the key id, if available (per JWT/JWS) |
   | `chain-op` | `"seal"` (custom extension marking this JWT's purpose) |

   **Claims**

   | claim | value |
   |---|---|
   | `iat` | issued-at, Unix timestamp (integer seconds) |
   | `sub` | the chain identifier — the `chain` value from the [`chain-root`](#chain-root) event, verbatim |
   | `sealed-head` | the sealed `event_id` (lowercase hex), identical to the event's `sealed-head` property |

3. Record the seal event into the chain:

   ```json
   {
     "type": "seal",
     "ts": "2026-06-14T13:00:00.000Z",
     "sealed-head": "4fcb…bd44",
     "seal": "eyJhbGciOiJFUzI1Ni…"
   }
   ```

### Permitted signature algorithms

`ES256`, `ES384`, `ES512`, `RS256`, `RS384`, `RS512`, `PS256`, `PS384`, `PS512`.
The algorithm in the JWT header MUST be one of these and MUST be consistent with
the [`sealKey`](#chain-root). A verifier MUST reject any other `alg` (in
particular `none`) outright.

### How a seal is verified

1. Read the [`chain-root`](#chain-root) event and obtain its public `sealKey`
   and `chain` identifier. If there is no `sealKey`, seals on this chain cannot
   be verified — flag them rather than treating them as valid.
2. For each `seal` event, verify the JWT in `seal` against `sealKey`:
   - the signature is valid and the header `alg` is permitted (never `none`);
   - the header `chain-op` is `"seal"` (and `kid`, if present, matches the key);
   - the `sub` claim equals the chain's `chain` identifier;
   - the `sealed-head` claim equals the event's `sealed-head` property.
3. Confirm `sealed-head` is a real `event_id` present in the chain at an `id`
   **less than or equal to** the seal event's own `id` (i.e. an ancestor). This
   is what ties the external signature to an actual position in the chain.

A seal that fails any of these checks is invalid; a valid seal proves that the
holder of the seal key attested to the chain containing the sealed `event_id` at
or before the seal's `iat`.

---

## Future work

This vocabulary is expected to grow. A companion class for emitting periodic
events of various kinds (heartbeats and similar) into a logger is planned but
out of scope for this document.
