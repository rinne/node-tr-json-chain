import { afterAll, describe, expect, it } from 'vitest';
import {
  ChainNotInitializedError,
  ChainVerificationError,
  EventChainLogger,
} from '../src';
import { makePool } from './helpers';

const pool = makePool();
afterAll(() => pool.end());

const HEX64 = /^[0-9a-f]{64}$/;
const ZERO_HEX = '0'.repeat(64);

async function seed(ns: string, n: number): Promise<EventChainLogger> {
  const log = new EventChainLogger(pool, { namespace: ns });
  await log.init();
  for (let i = 0; i < n; i++) await log.recordEvent({ n: i });
  return log;
}

describe('all-hex returns', () => {
  it('recordEvent / timestamp / getChainHead return 64-hex strings', async () => {
    const log = new EventChainLogger(pool, { namespace: 'hex_returns' });
    const a = await log.recordEvent({ a: 1 });
    const t = await log.timestamp();
    const h = await log.getChainHead();
    for (const v of [a, t, h]) {
      expect(typeof v).toBe('string');
      expect(v).toMatch(HEX64);
    }
  });
});

describe('recordEvent returnFullEventData', () => {
  it('returns the full normalized event object', async () => {
    const log = new EventChainLogger(pool, { namespace: 'full_basic' });
    await log.init();
    const ev = await log.recordEvent({ bb: 1, a: 2 }, { returnFullEventData: true });
    expect(ev.id).toBe(2); // genesis 0, root 1, this 2
    expect(ev.event_id).toMatch(HEX64);
    expect(ev.parent_id).toMatch(HEX64);
    expect(ev.data_hash).toMatch(HEX64);
    expect(ev.hashed_data).toBe('{"a": 2, "bb": 1}'); // canonical (normalized) text
    expect(ev.data).toEqual({ bb: 1, a: 2 });
    // hashed_data hashes to data_hash (portability), and links correctly:
    const { createHash } = await import('node:crypto');
    const dh = createHash('sha256').update(Buffer.from(ev.hashed_data!, 'utf8')).digest('hex');
    expect(dh).toBe(ev.data_hash);
  });

  it('returns hashed_data even when the payload is NOT stored', async () => {
    const log = new EventChainLogger(pool, { namespace: 'full_nostore' });
    await log.init();
    const ev = await log.recordEvent(
      { secret: true },
      { storePayload: false, returnFullEventData: true },
    );
    expect(ev.hashed_data).toBe('{"secret": true}'); // the only time this text exists
    expect(ev.data).toEqual({ secret: true });
    // …and a later getEvent cannot recover it (no payload row was kept):
    const later = await log.getEvent(ev.id, { includeHashedData: true, includeDataHash: true });
    expect(later).not.toBeNull();
    expect(later!.hashed_data).toBeUndefined();
    expect(later!.data).toBeUndefined();
    expect(later!.data_hash).toBe(ev.data_hash); // hash is still on the chain
  });

  it('recordEvent(x).data matches getEvent(id).data (both normalized)', async () => {
    const log = new EventChainLogger(pool, { namespace: 'full_match' });
    await log.init();
    const ev = await log.recordEvent({ z: 1, a: 2 }, { returnFullEventData: true });
    const got = await log.getEvent(ev.id, { includeHashedData: true });
    expect(got!.data).toEqual(ev.data);
    expect(got!.hashed_data).toBe(ev.hashed_data);
  });

  it('timestamp supports returnFullEventData', async () => {
    const log = new EventChainLogger(pool, { namespace: 'full_ts' });
    await log.init();
    const ev = await log.timestamp({ returnFullEventData: true });
    expect(ev.event_id).toMatch(HEX64);
    expect((ev.data as { type: string }).type).toBe('ts');
    expect(ev.hashed_data).toContain('"type": "ts"');
  });
});

describe('getEvent', () => {
  it('fetches by id, with slice-style negative indexing', async () => {
    const log = await seed('ge_basic', 3); // ids 0..4
    const genesis = await log.getEvent(0);
    expect(genesis!.id).toBe(0);
    expect(genesis!.event_id).toBe(ZERO_HEX);
    expect(genesis).not.toHaveProperty('data');

    const root = await log.getEvent(1);
    expect(root!.id).toBe(1);
    expect(typeof (root!.data as { chain: string }).chain).toBe('string');

    const last = await log.getEvent(-1); // non-mutating head peek
    expect(last!.id).toBe(4);
    const secondLast = await log.getEvent(-2);
    expect(secondLast!.id).toBe(3);
  });

  it('returns null for out-of-range ids', async () => {
    const log = await seed('ge_oob', 2); // ids 0..3
    expect(await log.getEvent(9999)).toBeNull();
    expect(await log.getEvent(-9999)).toBeNull();
  });

  it('passes options through', async () => {
    const log = await seed('ge_opts', 2);
    const root = await log.getEvent(1, { includeParentId: true, includeDataHash: true });
    expect(root!.parent_id).toBe(ZERO_HEX);
    expect(root!.data_hash).toMatch(HEX64);
  });

  it('throws TypeError on a non-integer id', async () => {
    const log = await seed('ge_bad', 1);
    await expect(log.getEvent(1.5)).rejects.toThrow(TypeError);
  });
});

describe('getRootEvent (delegates to getEvent(1))', () => {
  it('returns the root as a unified event detail', async () => {
    const log = await seed('gr_ok', 1);
    const root = await log.getRootEvent({ includeParentId: true });
    expect(root.id).toBe(1);
    expect(root.event_id).toMatch(HEX64);
    expect(root.parent_id).toBe(ZERO_HEX);
    expect(typeof (root.data as { chain: string }).chain).toBe('string');
  });

  it('throws ChainNotInitializedError when there is no chain', async () => {
    const log = new EventChainLogger(pool, { namespace: 'gr_uninit' });
    await expect(log.getRootEvent()).rejects.toThrow(ChainNotInitializedError);
  });
});

describe('ChainNotInitializedError', () => {
  it('is thrown by getEvents / getEvent on an uninitialized chain', async () => {
    const log = new EventChainLogger(pool, { namespace: 'cnie' });
    await expect(log.getEvents()).rejects.toThrow(ChainNotInitializedError);
    await expect(log.getEvent(0)).rejects.toThrow(ChainNotInitializedError);
  });
});

describe('verify', () => {
  it('verifies the root canary on a healthy chain', async () => {
    const log = await seed('vf_root', 2);
    const r = await log.verify();
    expect(r).toEqual({ ok: true, mode: 'root', eventsChecked: 1 });
  });

  it('verifies the whole chain with { full: true }', async () => {
    const log = await seed('vf_full', 3); // genesis + root + 3 = 5 rows
    await log.recordEvent({ secret: true }, { storePayload: false });
    await log.getChainHead(); // checkpoint
    const r = await log.verify({ full: true });
    expect(r.ok).toBe(true);
    expect(r.mode).toBe('full');
    expect(r.eventsChecked).toBe(7); // genesis + root + 3 + nopayload + checkpoint
  });

  it('throws ChainVerificationError on a tampered chain (default)', async () => {
    const log = await seed('vf_tamper', 2);
    await pool.query(`UPDATE vf_tamper_event_payload SET d = '{"n": 999}' WHERE event_id =
      (SELECT event_id FROM vf_tamper_event_chain ORDER BY id DESC LIMIT 1)`);
    await expect(log.verify({ full: true })).rejects.toThrow(ChainVerificationError);
  });

  it('returns { ok: false, … } with throwOnMismatch: false', async () => {
    const log = await seed('vf_noerr', 2); // ids 0..3; last is id 3
    await pool.query(`UPDATE vf_noerr_event_payload SET d = '{"n": 999}' WHERE event_id =
      (SELECT event_id FROM vf_noerr_event_chain WHERE id = 3)`);
    const r = await log.verify({ full: true, throwOnMismatch: false });
    expect(r.ok).toBe(false);
    expect(r.mode).toBe('full');
    expect(r.firstBadId).toBe(3);
    expect(r.offending?.[0]).toEqual({ id: 3, reasons: ['data_hash'] });
  });

  it('throws ChainNotInitializedError when the chain does not exist', async () => {
    const log = new EventChainLogger(pool, { namespace: 'vf_uninit' });
    await expect(log.verify()).rejects.toThrow(ChainNotInitializedError);
    await expect(log.verify({ full: true })).rejects.toThrow(ChainNotInitializedError);
  });
});
