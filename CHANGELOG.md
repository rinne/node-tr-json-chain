# Changelog

All notable changes to `tr-json-chain` are documented here. This project follows
[semantic versioning](https://semver.org/); the compatibility promise is about
the **on-disk chain** (see the README's "Versioning and compatibility").

## 1.0.0

**The on-disk format is now frozen.** This release contains **no change to the
runtime code, schema, hashing, or any on-disk byte** versus `0.9.0` — its entire
purpose is to make the format guarantee **binding** and to ship the artifacts
that prove and document it. A chain recorded against `1.0.0` remains verifiable,
byte for byte, against every future release.

- **Frozen format & hash specification** documented in the new
  [`FORMAT.md`](FORMAT.md) (shipped in the package): the exact table shapes and
  DDL, the genesis convention, head selection, the dense `id` rule, the two hash
  equations, the canonical-payload-bytes definition, and the **trust boundary**
  (the canonical `jsonb::text` is the thing of record — producer/consumer object
  round-trips are outside the guarantee and may be lossy; use `hashed_data` for
  exactness).
- **Cross-version stability, verified.** A committed adversarial JSONB corpus and
  a committed golden-chain fixture reproduce **byte-identically across PostgreSQL
  11, 12, 13, 14, 15, 16, 17, and 18** — same `jsonb::text`, same `data_hash`,
  same `event_id`. The golden fixture is checked by three independent verifiers.
- **The never-migrate guarantee is in force.** `event_chain` / `event_payload`,
  the genesis row, head selection, the `id` scheme, and how `event_id` /
  `data_hash` are computed will never change. Stored functions remain replaceable
  (`CREATE OR REPLACE`); new objects may be added alongside.
- **Requirement clarified:** a **UTF-8 database** is required.
- Documentation combed end-to-end; the README's freeze wording now states the
  guarantee as binding, with the pre-`0.4.0` incompatibility kept as history.

Compatibility: chains created by `0.4.0`–`0.9.0` (the dense, 0-based `id` scheme)
are fully compatible and open unchanged under `1.0.0`. Chains from before `0.4.0`
are not (see the README).

## 0.9.0

API stabilization ahead of the `1.0.0` freeze (the API may still grow additively
in `1.x`; this release settled its shape).

- All identifiers/hashes returned by the public API are **lowercase hex strings**
  (never `Buffer`s). One canonical `ChainEventDetail` shape across every event
  accessor.
- `recordEvent` / `timestamp` gained `returnFullEventData` (returns the full
  event incl. the canonical `hashed_data` — the only way to obtain it for an
  event recorded with `storePayload: false`).
- New `getEvent(id, options?)` (slice-style indexing; `getEvent(-1)` is a
  non-mutating head peek) and `verify(options?)` (on-demand server-side
  verification; throws by default, `{ throwOnMismatch: false }` returns a result).
- New `ChainNotInitializedError`. Removed the `Buffer`-based `ChainEvent` type.

## 0.8.0

- Added `EventChainCsvExport` / `EventChainCsvParse` — canonical CSV produce/parse
  classes, importable independently of the main logger.
- `getEvents()` now returns each event's `id` (chain position) unconditionally.

## 0.7.0 and earlier

Pre-1.0 development of the chain engine, schema, namespaces, root-event options,
the server-side verification canary, and the portable hash specification. The
on-disk shape was finalized over this series — notably `0.4.0` changed
`event_chain.id` to the caller-assigned, dense, 0-based scheme used since; chains
from `0.1.0`–`0.3.0` are not compatible.
