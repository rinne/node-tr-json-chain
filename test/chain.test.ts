import { afterAll, describe, expect, it } from 'vitest';
import { EventChainLogger } from '../src';
import { ZERO, getRoot, makePool, sha256, verifyChainInJs } from './helpers';

const pool = makePool();
afterAll(() => pool.end());

describe('recordEvent', () => {
  it('appends events and returns 32-byte ids', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_basic' });
    const a = await log.recordEvent({ kind: 'first', n: 1 });
    const b = await log.recordEvent({ kind: 'second', n: 2 });
    expect(a).toBeInstanceOf(Buffer);
    expect(a.length).toBe(32);
    expect(b.length).toBe(32);
    expect(a.equals(b)).toBe(false);
    expect(await verifyChainInJs(pool, 'rec_basic')).toBe(4); // genesis + root + 2
  });

  it('produces a chain that re-verifies in JS for tricky payloads', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_tricky' });
    await log.recordEvent({ s: 'ä€漢 "quotes" \\backslash', emoji: '🎉' });
    await log.recordEvent({ nested: { deep: [1, 2.5, null, true, { x: [] }] } });
    await log.recordEvent([1, 'two', { three: 3 }]);
    await log.recordEvent('bare string');
    await log.recordEvent(42);
    await log.recordEvent(null); // JSON null is a valid payload
    expect(await verifyChainInJs(pool, 'rec_tricky')).toBe(8); // genesis + root + 6
  });

  it('round-trips the stored payload', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_roundtrip' });
    const payload = { a: [1, 2, 3], b: { c: 'ä' }, d: null };
    const id = await log.recordEvent(payload);
    const { rows } = await pool.query(
      'SELECT d, ts FROM rec_roundtrip_event_payload WHERE event_id = $1',
      [id],
    );
    expect(rows[0].d).toEqual(payload);
    expect(rows[0].ts).toBeInstanceOf(Date);
  });

  it('honors storePayload: false', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_nopayload' });
    const id = await log.recordEvent({ secret: true }, { storePayload: false });
    const { rowCount } = await pool.query(
      'SELECT 1 FROM rec_nopayload_event_payload WHERE event_id = $1',
      [id],
    );
    expect(rowCount).toBe(0);
    expect(await verifyChainInJs(pool, 'rec_nopayload')).toBe(3);
  });

  it('rejects non-JSON-serializable data', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_bad' });
    await expect(log.recordEvent(undefined)).rejects.toThrow(TypeError);
    await expect(log.recordEvent(() => {})).rejects.toThrow(TypeError);
  });

  it('hashes the JSONB-normalized rendering, not the caller JSON', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_norm' });
    // jsonb orders keys by length, then bytewise: {"bb":1,"a":2} → {"a": 2, "bb": 1}
    const id = await log.recordEvent({ bb: 1, a: 2 });
    const { rows } = await pool.query(
      `SELECT p.d::text AS d_text, c.data_hash
         FROM rec_norm_event_payload p JOIN rec_norm_event_chain c USING (event_id)
        WHERE event_id = $1`,
      [id],
    );
    expect(rows[0].d_text).toBe('{"a": 2, "bb": 1}');
    expect(sha256(Buffer.from(rows[0].d_text, 'utf8')).equals(rows[0].data_hash)).toBe(true);
    // The caller's own serialization differs from what was hashed:
    expect(
      sha256(Buffer.from(JSON.stringify({ bb: 1, a: 2 }), 'utf8')).equals(rows[0].data_hash),
    ).toBe(false);
  });

  it('keeps an unforked chain under concurrent writers', async () => {
    const log = new EventChainLogger(pool, { namespace: 'rec_concurrent' });
    await log.init();
    const ids = await Promise.all(
      Array.from({ length: 25 }, (_, i) => log.recordEvent({ i })),
    );
    expect(new Set(ids.map((b) => b.toString('hex'))).size).toBe(25);
    expect(await verifyChainInJs(pool, 'rec_concurrent')).toBe(27); // genesis + root + 25
  });
});

describe('getChainHead', () => {
  it('checkpoints over the root event on a freshly initialized chain', async () => {
    const log = new EventChainLogger(pool, { namespace: 'head_virgin' });
    const head = await log.getChainHead();
    const root = await getRoot(pool, 'head_virgin');
    expect(head.equals(sha256(root.event_id, ZERO))).toBe(true);
    expect((await log.getChainHead()).equals(head)).toBe(true); // stable
    expect(await verifyChainInJs(pool, 'head_virgin')).toBe(3); // genesis + root + checkpoint
  });

  it('appends one empty checkpoint and is then stable', async () => {
    const log = new EventChainLogger(pool, { namespace: 'head_stable' });
    const ev = await log.recordEvent({ x: 1 });
    const h1 = await log.getChainHead();
    const h2 = await log.getChainHead();
    expect(h1.equals(ev)).toBe(false);
    expect(h1.equals(sha256(ev, ZERO))).toBe(true); // empty event linked to ev
    expect(h2.equals(h1)).toBe(true); // no pile-up
    expect(await verifyChainInJs(pool, 'head_stable')).toBe(4); // genesis + root + event + checkpoint

    const ev2 = await log.recordEvent({ x: 2 });
    const h3 = await log.getChainHead();
    expect(h3.equals(h1)).toBe(false);
    expect(h3.equals(sha256(ev2, ZERO))).toBe(true);
  });
});

describe('namespaces', () => {
  it('runs independent chains in one database', async () => {
    const a = new EventChainLogger(pool, { namespace: 'multi_a' });
    const b = new EventChainLogger(pool, { namespace: 'multi_b' });
    await a.recordEvent({ chain: 'a' });
    await a.recordEvent({ chain: 'a' });
    await b.recordEvent({ chain: 'b' });
    expect(await verifyChainInJs(pool, 'multi_a')).toBe(4);
    expect(await verifyChainInJs(pool, 'multi_b')).toBe(3);
    // Each chain has its own identity:
    const rootA = await getRoot(pool, 'multi_a');
    const rootB = await getRoot(pool, 'multi_b');
    expect(rootA.d.chain).not.toBe(rootB.d.chain);
  });

  it('supports the default (bare) namespace', async () => {
    const log = new EventChainLogger(pool);
    await log.recordEvent({ bare: true });
    expect(await verifyChainInJs(pool)).toBeGreaterThanOrEqual(3);
    const { rowCount } = await pool.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema = current_schema() AND table_name = 'event_chain'`,
    );
    expect(rowCount).toBe(1);
  });

  it('rejects invalid namespaces before any SQL runs', () => {
    for (const ns of [
      'Bad',
      '1leading_digit',
      'has-dash',
      'has space',
      'x"; DROP TABLE event_chain; --',
      'ä',
      'a'.repeat(40), // one over the 39-char limit
    ]) {
      expect(() => new EventChainLogger(pool, { namespace: ns })).toThrow(TypeError);
    }
    // At the limit is fine:
    expect(() => new EventChainLogger(pool, { namespace: 'a'.repeat(39) })).not.toThrow();
  });
});
