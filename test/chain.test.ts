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

describe('timestamp', () => {
  it('records a { ts } event and returns its id', async () => {
    const log = new EventChainLogger(pool, { namespace: 'ts_basic' });
    const before = Date.now();
    const id = await log.timestamp();
    const after = Date.now();
    expect(id).toBeInstanceOf(Buffer);
    expect(id.length).toBe(32);
    const { rows } = await pool.query(
      'SELECT d FROM ts_basic_event_payload WHERE event_id = $1',
      [id],
    );
    expect(Object.keys(rows[0].d)).toEqual(['ts']);
    const ts = Date.parse(rows[0].d.ts);
    expect(ts).toBeGreaterThanOrEqual(before);
    expect(ts).toBeLessThanOrEqual(after);
    expect(await verifyChainInJs(pool, 'ts_basic')).toBe(3); // genesis + root + ts
  });
});

describe('root event options', () => {
  it('superimposes rootExtraData on the default root event', async () => {
    const log = new EventChainLogger(pool, {
      namespace: 'root_extra',
      rootExtraData: { chain: 'kukkuu', foo: 1, bar: [1, 2, 3] },
    });
    await log.init();
    const root = await getRoot(pool, 'root_extra');
    expect(root.d.chain).toBe('kukkuu'); // overridden default
    expect(root.d).toMatchObject({ foo: 1, bar: [1, 2, 3] });
    expect(typeof root.d.ts).toBe('string'); // default ts kept
    expect(await verifyChainInJs(pool, 'root_extra')).toBe(2); // genesis + root
  });

  it('omits default chain/ts with rootOmitDefaultData (empty object)', async () => {
    const log = new EventChainLogger(pool, {
      namespace: 'root_omit',
      rootOmitDefaultData: true,
    });
    await log.init();
    const root = await getRoot(pool, 'root_omit');
    expect(root.d).toEqual({});
    expect(await verifyChainInJs(pool, 'root_omit')).toBe(2);
  });

  it('combines rootOmitDefaultData with rootExtraData', async () => {
    const log = new EventChainLogger(pool, {
      namespace: 'root_omit_extra',
      rootOmitDefaultData: true,
      rootExtraData: { only: 'this' },
    });
    await log.init();
    const root = await getRoot(pool, 'root_omit_extra');
    expect(root.d).toEqual({ only: 'this' });
  });

  it('has no effect on an already-initialized chain', async () => {
    const first = new EventChainLogger(pool, { namespace: 'root_existing' });
    await first.init();
    const rootBefore = await getRoot(pool, 'root_existing');

    const second = new EventChainLogger(pool, {
      namespace: 'root_existing',
      rootExtraData: { ignored: true },
    });
    await second.init();
    const rootAfter = await getRoot(pool, 'root_existing');
    expect(rootAfter.d).toEqual(rootBefore.d);
    expect(rootAfter.d.ignored).toBeUndefined();
  });

  it('null/undefined rootExtraData behaves like the default', async () => {
    const log = new EventChainLogger(pool, {
      namespace: 'root_null',
      rootExtraData: null,
    });
    await log.init();
    const root = await getRoot(pool, 'root_null');
    expect(typeof root.d.chain).toBe('string');
    expect(typeof root.d.ts).toBe('string');
  });

  it('rejects non-object rootExtraData before any SQL runs', () => {
    for (const bad of [[1, 2, 3], 'str', 42, true]) {
      expect(
        () =>
          new EventChainLogger(pool, {
            rootExtraData: bad as unknown as Record<string, unknown>,
          }),
      ).toThrow(TypeError);
    }
  });
});

describe('getRootEvent', () => {
  it('returns the root event id and payload', async () => {
    const log = new EventChainLogger(pool, { namespace: 'root_get' });
    await log.init();
    const root = await getRoot(pool, 'root_get');
    const got = await log.getRootEvent();
    expect(got.event_id).toBeInstanceOf(Buffer);
    expect(got.event_id.equals(root.event_id)).toBe(true);
    expect(got.data).toEqual(root.d);
    expect(typeof (got.data as { chain: string }).chain).toBe('string');
  });

  it('reflects rootExtraData / rootOmitDefaultData', async () => {
    const log = new EventChainLogger(pool, {
      namespace: 'root_get_omit',
      rootOmitDefaultData: true,
      rootExtraData: { only: 'this' },
    });
    await log.init();
    expect((await log.getRootEvent()).data).toEqual({ only: 'this' });
  });

  it('throws when the chain is uninitialized', async () => {
    const log = new EventChainLogger(pool, { namespace: 'root_get_uninit' });
    await expect(log.getRootEvent()).rejects.toThrow(/not initialized/);
  });
});

describe('getEvents', () => {
  const ZERO_HEX = '00'.repeat(32);

  // Builds a chain with `n` recorded events on top of genesis(0) + root(1),
  // so ids run 0..(n+1), len = n + 2.
  async function seed(ns: string, n: number) {
    const log = new EventChainLogger(pool, { namespace: ns });
    await log.init();
    for (let i = 0; i < n; i++) await log.recordEvent({ n: i });
    return log;
  }

  it('returns all events (genesis at index 0) by default', async () => {
    const log = await seed('ev_all', 3); // ids 0..4, len 5
    const r = await log.getEvents();
    expect(r.events.length).toBe(5);
    expect(r.start).toBe(0);
    expect(r.end).toBe(4);
    expect(r.have_more).toBe(false);
    // index 0 = genesis: all-zero id, no payload
    expect(r.events[0].event_id).toBe(ZERO_HEX);
    expect(r.events[0].data).toBeUndefined();
    expect(r.events[0]).not.toHaveProperty('data');
    // index 1 = root event: has chain UUID + ts
    expect(typeof (r.events[1].data as { chain: string }).chain).toBe('string');
    // event_id is 64-char hex
    expect(r.events[2].event_id).toMatch(/^[0-9a-f]{64}$/);
  });

  it('honors a positive start (slice from index)', async () => {
    const log = await seed('ev_start', 3); // len 5
    const r = await log.getEvents(2);
    expect(r.events.length).toBe(3); // ids 2,3,4
    expect([r.start, r.end]).toEqual([2, 4]);
    expect(r.have_more).toBe(false);
  });

  it('honors start and (exclusive) end', async () => {
    const log = await seed('ev_range', 5); // ids 0..6, len 7
    const r = await log.getEvents(2, 4); // ids 2,3
    expect([r.start, r.end]).toEqual([2, 3]);
    expect(r.events.length).toBe(2);
  });

  it('supports negative start (last N)', async () => {
    const log = await seed('ev_neg', 5); // ids 0..6, len 7
    const r = await log.getEvents(-2); // ids 5,6
    expect([r.start, r.end]).toEqual([5, 6]);
    expect(r.events.length).toBe(2);
  });

  it('supports a negative end (omit the last)', async () => {
    const log = await seed('ev_negend', 5); // ids 0..6, len 7
    const r = await log.getEvents(2, -1); // ids 2..5
    expect([r.start, r.end]).toEqual([2, 5]);
  });

  it('returns an empty page for a collapsed range', async () => {
    const log = await seed('ev_empty', 3); // len 5
    const r = await log.getEvents(2, 2);
    expect(r.events).toEqual([]);
    expect(r.have_more).toBe(false);
    expect([r.start, r.end]).toEqual([2, 1]); // end = start - 1
  });

  it('includes optional fields on request', async () => {
    const log = await seed('ev_opts', 2); // ids 0..3
    const r = await log.getEvents(1, 2, {
      includeHashedData: true,
      includeDataHash: true,
      includeParentId: true,
    });
    const root = r.events[0];
    expect(root.parent_id).toBe(ZERO_HEX); // root's parent is genesis
    expect(root.data_hash).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof root.hashed_data).toBe('string');
    expect(JSON.parse(root.hashed_data as string)).toEqual(root.data);
  });

  it('omits parent_id/data/hashed_data appropriately for genesis', async () => {
    const log = await seed('ev_genesis', 1);
    const r = await log.getEvents(0, 1, {
      includeParentId: true,
      includeDataHash: true,
      includeHashedData: true,
    });
    const genesis = r.events[0];
    expect(genesis).not.toHaveProperty('parent_id'); // null parent
    expect(genesis).not.toHaveProperty('data'); // no payload
    expect(genesis).not.toHaveProperty('hashed_data'); // no payload
    expect(genesis.data_hash).toBe(ZERO_HEX); // present, all-zero
  });

  it('accepts options as the sole / second argument', async () => {
    const log = await seed('ev_optarg', 2);
    const all = await log.getEvents({ includeDataHash: true });
    expect(all.start).toBe(0);
    expect(all.events.every((e) => typeof e.data_hash === 'string')).toBe(true);
    const fromOne = await log.getEvents(1, { includeDataHash: true });
    expect(fromOne.start).toBe(1);
  });

  it('caps at 1000 events and paginates with have_more', async () => {
    const ns = 'ev_big';
    const log = new EventChainLogger(pool, { namespace: ns });
    await log.init();
    // Populate 1001 events server-side: genesis(0) + root(1) + 1001 => ids 0..1002
    await pool.query(
      `DO $$ BEGIN
         FOR i IN 1..1001 LOOP
           PERFORM ${ns}_event_record(jsonb_build_object('n', i));
         END LOOP;
       END $$;`,
    );
    const page1 = await log.getEvents(); // len 1003
    expect(page1.events.length).toBe(1000);
    expect([page1.start, page1.end]).toEqual([0, 999]);
    expect(page1.have_more).toBe(true);
    const page2 = await log.getEvents(page1.end + 1);
    expect([page2.start, page2.end]).toEqual([1000, 1002]);
    expect(page2.events.length).toBe(3);
    expect(page2.have_more).toBe(false);
  });

  it('honors options.maxEvents and continues via end + 1', async () => {
    const log = await seed('ev_max', 6); // ids 0..7, len 8
    const p1 = await log.getEvents(0, { maxEvents: 3 });
    expect(p1.events.length).toBe(3);
    expect([p1.start, p1.end]).toEqual([0, 2]);
    expect(p1.have_more).toBe(true);
    const p2 = await log.getEvents(p1.end + 1, { maxEvents: 3 });
    expect([p2.start, p2.end]).toEqual([3, 5]);
    expect(p2.have_more).toBe(true);
  });

  it('traverses the whole chain with the documented loop', async () => {
    const log = await seed('ev_loop', 10); // ids 0..11, len 12
    const seen: string[] = [];
    for (let x = await log.getEvents(0, { maxEvents: 4 }); ; x = await log.getEvents(x.end + 1, { maxEvents: 4 })) {
      for (const ev of x.events) seen.push(ev.event_id);
      if (!x.have_more) break;
    }
    expect(seen.length).toBe(12); // every row exactly once, no gaps/dupes
    expect(new Set(seen).size).toBe(12);
  });

  it('ignores maxEvents above the 1000 cap', async () => {
    const log = await seed('ev_maxbig', 2); // len 4
    const r = await log.getEvents(0, { maxEvents: 5000 });
    expect(r.events.length).toBe(4); // all, cap not exceeded
    expect(r.have_more).toBe(false);
  });

  it('throws TypeError on an invalid maxEvents', async () => {
    const log = await seed('ev_maxbad', 1);
    await expect(log.getEvents(0, { maxEvents: 0 })).rejects.toThrow(TypeError);
    await expect(log.getEvents(0, { maxEvents: -3 })).rejects.toThrow(TypeError);
    await expect(log.getEvents(0, { maxEvents: 2.5 })).rejects.toThrow(TypeError);
  });

  it('throws TypeError on a non-integer index', async () => {
    const log = await seed('ev_bad', 1);
    await expect(log.getEvents(1.5)).rejects.toThrow(TypeError);
    await expect(log.getEvents(0, 'x' as unknown as number)).rejects.toThrow(TypeError);
  });

  it('throws when the chain is uninitialized', async () => {
    const log = new EventChainLogger(pool, { namespace: 'ev_uninit' });
    await expect(log.getEvents()).rejects.toThrow(/not initialized/);
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
