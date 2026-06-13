import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
// Import straight from the source module (not the package index) to prove these
// classes carry no database / pg coupling — they are pure string transforms.
import { EventChainCsvExport, EventChainCsvParse, type ParsedRow } from '../src/csv';

const ZERO = '0'.repeat(64);
const HEADER = '#;event_id;parent_id;data_hash;data';

function sha(...parts: Buffer[]): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}
function quote(s: string): string {
  return `"${s.replace(/"/g, '""')}"`;
}

interface FixtureRow {
  id: number;
  parent_id: string;
  event_id: string;
  data_hash: string;
  /** Canonical payload text, or null for a payload-less (zero-hash) checkpoint event. */
  text: string | null;
}

// Builds a valid chain (genesis excluded, ids from 1) from a list of payload
// texts (null = a payload-less checkpoint with an all-zero data_hash), wiring
// real SHA-256 hashes so verifyHashes/verifyLinks pass.
function fixture(texts: (string | null)[], startId = 1, startParent = ZERO): FixtureRow[] {
  const rows: FixtureRow[] = [];
  let parent = startParent;
  let id = startId;
  for (const text of texts) {
    const data_hash = text === null ? ZERO : sha(Buffer.from(text, 'utf8'));
    const event_id = sha(Buffer.from(parent, 'hex'), Buffer.from(data_hash, 'hex'));
    rows.push({ id, parent_id: parent, event_id, data_hash, text });
    parent = event_id;
    id++;
  }
  return rows;
}
function toLine(r: FixtureRow): string {
  const cell = r.text === null ? '' : quote(r.text);
  return `${r.id};${r.event_id};${r.parent_id};${r.data_hash};${cell}`;
}

describe('EventChainCsvExport', () => {
  const enc = new EventChainCsvExport();

  it('emits the canonical header', () => {
    expect(enc.header()).toBe(HEADER);
  });

  it('renders a normal payload row', () => {
    const [r] = fixture(['{"a": 1}']);
    const row: ParsedRow = { id: r.id, event_id: r.event_id, parent_id: r.parent_id, data_hash: r.data_hash, hashed_data: r.text! };
    expect(enc.event(row)).toBe(`${r.id};${r.event_id};${r.parent_id};${r.data_hash};${quote('{"a": 1}')}`);
  });

  it('RFC-4180-quotes data with quotes, delimiters, and non-ASCII', () => {
    const tricky = '{"s": "a;b \\"q\\" \\n", "u": "ä€漢🎉"}';
    const [r] = fixture([tricky]);
    const out = enc.event({ id: r.id, event_id: r.event_id, parent_id: r.parent_id, data_hash: r.data_hash, hashed_data: tricky });
    // The whole canonical text sits inside one RFC-4180-quoted field…
    expect(out.endsWith(quote(tricky))).toBe(true);
    // …and unquoting it (via the parser) recovers the exact bytes verbatim.
    expect(new EventChainCsvParse(HEADER).row(out).hashed_data).toBe(tricky);
  });

  it('emits an empty data cell for a payload-less event', () => {
    const [r] = fixture([null]);
    const out = enc.event({ id: r.id, event_id: r.event_id, parent_id: r.parent_id, data_hash: r.data_hash });
    expect(out).toBe(`${r.id};${r.event_id};${r.parent_id};${r.data_hash};`);
  });

  it('rejects the genesis row (id 0)', () => {
    expect(() => enc.event({ id: 0, event_id: ZERO, parent_id: ZERO, data_hash: ZERO })).toThrow(/genesis/);
  });

  it('throws with a helpful hint when an include was forgotten', () => {
    const base = { id: 1, event_id: 'a'.repeat(64) };
    expect(() => enc.event({ ...base, data_hash: 'b'.repeat(64) } as never)).toThrow(/parent_id.*includeParentId/s);
    expect(() => enc.event({ ...base, parent_id: ZERO } as never)).toThrow(/data_hash.*includeDataHash/s);
  });

  it('rejects malformed fields', () => {
    expect(() => enc.event({ id: 1.5, event_id: 'a'.repeat(64), parent_id: ZERO, data_hash: 'b'.repeat(64) })).toThrow(TypeError);
    expect(() => enc.event({ id: 1, event_id: 'xyz', parent_id: ZERO, data_hash: 'b'.repeat(64) })).toThrow(/event_id/);
  });
});

describe('EventChainCsvParse — header', () => {
  it('accepts the 5-column header', () => {
    expect(() => new EventChainCsvParse(HEADER)).not.toThrow();
  });
  it('accepts the 4-column (no data) header', () => {
    expect(() => new EventChainCsvParse('#;event_id;parent_id;data_hash')).not.toThrow();
  });
  it('rejects a wrong / reordered / short header', () => {
    expect(() => new EventChainCsvParse('id;event_id;parent_id;data_hash;data')).toThrow(/bad CSV header/);
    expect(() => new EventChainCsvParse('#;parent_id;event_id;data_hash;data')).toThrow(/bad CSV header/);
    expect(() => new EventChainCsvParse('#;event_id;parent_id')).toThrow(/bad CSV header/);
    expect(() => new EventChainCsvParse('#;event_id;parent_id;data_hash;data;extra')).toThrow(/bad CSV header/);
  });
});

describe('EventChainCsvParse — parsing (flags off)', () => {
  it('parses a row and returns the verbatim canonical text, no decoded data', () => {
    const [r] = fixture(['{"a": 1}']);
    const p = new EventChainCsvParse(HEADER);
    const out = p.row(toLine(r));
    expect(out).toEqual({ id: 1, event_id: r.event_id, parent_id: r.parent_id, data_hash: r.data_hash, hashed_data: '{"a": 1}' });
    expect(out).not.toHaveProperty('data');
  });

  it('omits hashed_data for a payload-less row', () => {
    const [r] = fixture([null]);
    const out = new EventChainCsvParse(HEADER).row(toLine(r));
    expect(out).not.toHaveProperty('hashed_data');
    expect(out.data_hash).toBe(ZERO);
  });

  it('treats every event as payload-less under a 4-column header', () => {
    const [r] = fixture(['{"a": 1}']);
    const line = `${r.id};${r.event_id};${r.parent_id};${r.data_hash}`; // no data column
    const out = new EventChainCsvParse('#;event_id;parent_id;data_hash').row(line);
    expect(out).not.toHaveProperty('hashed_data');
  });

  it('validates field formats even with verification off', () => {
    const p = new EventChainCsvParse(HEADER);
    expect(() => p.row(`x;${'a'.repeat(64)};${ZERO};${'b'.repeat(64)};`)).toThrow(/# is not/);
    expect(() => new EventChainCsvParse(HEADER).row(`1;nothex;${ZERO};${'b'.repeat(64)};`)).toThrow(/event_id/);
    expect(() => new EventChainCsvParse(HEADER).row(`1;${'a'.repeat(64)};${ZERO}`)).toThrow(/too few columns/);
  });

  it('does NOT check links or hashes when the flags are off', () => {
    // A broken chain (wrong parent, wrong hash) parses fine with no verification.
    const p = new EventChainCsvParse(HEADER);
    expect(() => p.row(`5;${'a'.repeat(64)};${'f'.repeat(64)};${'b'.repeat(64)};${quote('{"x":1}')}`)).not.toThrow();
  });
});

describe('EventChainCsvParse — verifyLinks', () => {
  it('accepts a contiguous chain', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}', null]);
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    for (const r of rows) p.row(toLine(r));
    expect(p.partial).toBe(false);
  });

  it('rejects a # gap', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}']);
    rows[1].id = 5; // break contiguity
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    p.row(toLine(rows[0]));
    expect(() => p.row(toLine(rows[1]))).toThrow(/non-contiguous/);
  });

  it('rejects a broken parent link', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}']);
    rows[1].parent_id = 'f'.repeat(64); // not the previous event_id
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    p.row(toLine(rows[0]));
    expect(() => p.row(toLine(rows[1]))).toThrow(/parent_id does not match/);
  });

  it('rejects a root (#1) without an all-zero parent', () => {
    const rows = fixture(['{"a": 1}']);
    rows[0].parent_id = 'f'.repeat(64);
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    expect(() => p.row(toLine(rows[0]))).toThrow(/root event must have an all-zero parent/);
  });

  it('accepts a partial chain (non-root start with a non-zero parent)', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}'], 7, 'c'.repeat(64));
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    const first = p.row(toLine(rows[0]));
    expect(first.id).toBe(7);
    p.row(toLine(rows[1]));
    expect(p.partial).toBe(true);
    expect(p.end().partial).toBe(true);
  });

  it('rejects a non-root start with an all-zero parent', () => {
    const rows = fixture(['{"a": 1}'], 7, ZERO);
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true });
    expect(() => p.row(toLine(rows[0]))).toThrow(/must not have an all-zero parent/);
  });
});

describe('EventChainCsvParse — verifyRoot', () => {
  it('throws from the constructor when set without verifyLinks', () => {
    expect(() => new EventChainCsvParse(HEADER, { verifyRoot: true })).toThrow(/verifyRoot requires verifyLinks/);
    expect(() => new EventChainCsvParse(HEADER, { verifyRoot: true, verifyHashes: true })).toThrow(/verifyRoot requires verifyLinks/);
  });

  it('accepts a chain that starts at the root (#1)', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}']);
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true, verifyRoot: true });
    for (const r of rows) p.row(toLine(r));
    expect(p.end().partial).toBe(false);
  });

  it('rejects a partial slice (first row is not the root)', () => {
    const rows = fixture(['{"a": 1}'], 7, 'c'.repeat(64));
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true, verifyRoot: true });
    expect(() => p.row(toLine(rows[0]))).toThrow(/first row to be the root event/);
  });

  it('only constrains the first row, not later ones', () => {
    const rows = fixture(['{"a": 1}', '{"b": 2}', '{"c": 3}']);
    const p = new EventChainCsvParse(HEADER, { verifyLinks: true, verifyRoot: true });
    for (const r of rows) expect(() => p.row(toLine(r))).not.toThrow();
  });
});

describe('EventChainCsvParse — verifyHashes', () => {
  it('accepts a chain with correct hashes', () => {
    const rows = fixture(['{"a": 1}', null, '{"b": 2}']);
    const p = new EventChainCsvParse(HEADER, { verifyHashes: true });
    for (const r of rows) p.row(toLine(r));
  });

  it('rejects a tampered payload (data does not hash to data_hash)', () => {
    const [r] = fixture(['{"a": 1}']);
    const line = `${r.id};${r.event_id};${r.parent_id};${r.data_hash};${quote('{"a": 2}')}`; // data changed
    const p = new EventChainCsvParse(HEADER, { verifyHashes: true });
    expect(() => p.row(line)).toThrow(/data does not hash to data_hash/);
  });

  it('rejects a tampered event_id', () => {
    const [r] = fixture(['{"a": 1}']);
    const line = `${r.id};${'a'.repeat(64)};${r.parent_id};${r.data_hash};${quote(r.text!)}`;
    const p = new EventChainCsvParse(HEADER, { verifyHashes: true });
    expect(() => p.row(line)).toThrow(/event_id != SHA256/);
  });
});

describe('EventChainCsvParse — parseData', () => {
  it('decodes the payload into data only when requested', () => {
    const [r] = fixture(['{"a": 1, "b": [2, 3]}']);
    const on = new EventChainCsvParse(HEADER, { parseData: true }).row(toLine(r));
    expect(on.data).toEqual({ a: 1, b: [2, 3] });
    const off = new EventChainCsvParse(HEADER).row(toLine(r));
    expect(off).not.toHaveProperty('data');
  });
});

describe('EventChainCsvParse — lifecycle', () => {
  it('returns an accurate summary from end()', () => {
    const rows = fixture(['{"a": 1}', null, '{"b": 2}']); // 2 payloads, 2 real (non-zero hash)
    const p = new EventChainCsvParse(HEADER);
    for (const r of rows) p.row(toLine(r));
    expect(p.end()).toEqual({ count: 3, payloadPresent: 2, realEvents: 2, partial: false, lastEventId: 3 });
  });

  it('reports lastEventId null when no rows were parsed', () => {
    expect(new EventChainCsvParse(HEADER).end().lastEventId).toBeNull();
  });

  it('throws on row() after end()', () => {
    const [r] = fixture(['{"a": 1}']);
    const p = new EventChainCsvParse(HEADER);
    p.row(toLine(r));
    p.end();
    expect(() => p.row(toLine(r))).toThrow(/ended/);
  });

  it('can be abandoned without end()', () => {
    const [r] = fixture(['{"a": 1}']);
    const p = new EventChainCsvParse(HEADER);
    expect(p.row(toLine(r)).id).toBe(1);
    // no end() — nothing to clean up; a fresh parser is unaffected.
    expect(new EventChainCsvParse(HEADER).row(toLine(r)).id).toBe(1);
  });
});

describe('round-trip contract (encode ↔ parse)', () => {
  const enc = new EventChainCsvExport();
  // A chain mixing payloads, a payload-less checkpoint, and tricky text.
  const rows = fixture(['{"a": 1}', null, '{"s": "a;b \\"q\\"", "u": "ä🎉"}']);

  it('parse(encode(ev)) reproduces the event fields', () => {
    const p = new EventChainCsvParse(enc.header(), { verifyHashes: true, verifyLinks: true });
    for (const r of rows) {
      const ev = { id: r.id, event_id: r.event_id, parent_id: r.parent_id, data_hash: r.data_hash, ...(r.text !== null ? { hashed_data: r.text } : {}) };
      const reparsed = p.row(enc.event(ev));
      expect(reparsed).toEqual(ev);
    }
    expect(p.end()).toMatchObject({ count: 3, payloadPresent: 2, realEvents: 2, partial: false });
  });

  it('re-encoding a parsed row is idempotent', () => {
    const p = new EventChainCsvParse(enc.header());
    for (const r of rows) {
      const line = toLine(r);
      expect(enc.event(p.row(line))).toBe(line);
    }
  });
});
