// Generates JSONB canonicalization test vectors by hashing fabricated payloads
// in PostgreSQL, exactly as the library does:
//   data_hash = sha256(convert_to(payload::jsonb::text, 'UTF8'))
//
// Every vector's source is a RAW JSON STRING — JavaScript's JSON.stringify is
// deliberately not in the picture, since it has nothing to do with what we are
// verifying (PostgreSQL's JSONB canonicalization). JSON strings also let us
// express inputs JS can't hold faithfully: integers past 2^53, duplicate keys,
// deliberately unordered keys, odd whitespace.
//
// For each vector we store the INPUT (the JSON text fed to ::jsonb), the exact
// canonical text PostgreSQL produced (jsonb::text), and the resulting data_hash.
// The committed vectors are generated once on PostgreSQL 16; the companion test
// (test/jsonb-canonical.test.ts) replays them against whatever server is
// configured, proving the rendering is byte-identical across versions.
//
// Run:  node scripts/gen-jsonb-vectors.mjs
//   (uses TR_JSON_CHAIN_TEST_URL, or the dc/ docker default on :5433)
//
// IMPORTANT: regenerating must stay on PostgreSQL 16 (the reference renderer) —
// the whole point is that 17/18/… must match these, not redefine them.

import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, 'test', 'jsonb-vectors.json');
const URL =
  process.env.TR_JSON_CHAIN_TEST_URL ||
  'postgres://postgres:postgres@localhost:5433/postgres';

// A single backslash, built from its char code so there is zero ambiguity about
// escaping when a JSON source string needs a literal backslash escape (\t, \",
// \uXXXX, \\). The JSON text is what PostgreSQL parses — not anything JS-level.
const BS = String.fromCharCode(92);
const v = (name, json) => ({ name, json });

// Fabricated corpus of raw JSON strings, of moderately growing complexity,
// covering every JSON type with variable-length and non-ASCII property names.
const CORPUS = [
  // ── scalars ────────────────────────────────────────────────────────────
  v('scalar-null', 'null'),
  v('scalar-true', 'true'),
  v('scalar-false', 'false'),
  v('scalar-zero', '0'),
  v('scalar-one', '1'),
  v('scalar-neg', '-1'),
  v('scalar-int', '42'),
  v('scalar-float', '2.5'),
  v('scalar-neg-float', '-3.14'),
  v('scalar-empty-string', '""'),
  v('scalar-string', '"hello"'),
  v('scalar-string-space', '"with space"'),

  // ── number rendering ────────────────────────────────────────────────────
  v('num-one-dot-zero', '1.0'),
  v('num-hundred-dot-zerozero', '100.00'),
  v('num-trailing-zero', '0.10'),
  v('num-sci-lower', '1e3'),
  v('num-sci-upper', '1E3'),
  v('num-sci-big', '1e21'),
  v('num-sci-neg-exp', '1e-7'),
  v('num-point-one', '0.1'),
  v('num-neg-zero', '-0'),
  v('num-long-decimal', '3.141592653589793238462643383279'),
  v('num-past-2^53', '9007199254740993'),
  v('num-neg-past-2^53', '-9007199254740993'),
  v('num-huge-int', '123456789012345678901234567890'),

  // ── string content & escapes (BS = one literal backslash) ───────────────
  v('str-tab', `"tab${BS}there"`),
  v('str-newline', `"new${BS}nline"`),
  v('str-quote', `"a ${BS}"quoted${BS}" word"`),
  v('str-backslash', `"back${BS}${BS}slash"`),
  v('str-slash', '"a/b/c"'),
  v('str-control', `"${BS}u0001${BS}u001f end"`),
  v('str-escaped-unicode', `"${BS}u00e4${BS}u20ac"`), // escaped → "ä€"
  v('str-latin1', '"ä ö ü ß é"'),
  v('str-euro-cjk', '"ä€漢"'),
  v('str-emoji', '"🎉 party 🎊"'),
  v('str-cyrillic', '"Москва"'),
  v('str-japanese', '"日本語テスト"'),
  v('str-zwj-family', '"👨‍👩‍👧‍👦"'),

  // ── empty containers ────────────────────────────────────────────────────
  v('empty-object', '{}'),
  v('empty-array', '[]'),

  // ── key ordering & normalization (deliberately unordered / whitespaced) ─
  v('keys-length-then-bytewise', '{"bb":1,"a":2}'),
  v('keys-varlen', '{"x":1,"yy":2,"zzz":3,"a":4}'),
  v('keys-case', '{"b":1,"B":2,"a":3,"A":4}'),
  v('keys-dup-simple', '{"a":1,"a":2}'),
  v('keys-dup-interleaved', '{"a":1,"b":2,"a":3}'),
  v('whitespace-object', '{ "a" : 1 ,   "b":2 }'),
  v('whitespace-array', '[ 1 , 2 ,3]'),

  // ── non-ASCII keys ──────────────────────────────────────────────────────
  v('keys-nonascii', '{"ä":1,"漢":2,"a":3}'),
  v('keys-umlaut', '{"keyWithÜmlaut":true,"a":1}'),

  // ── variable-length property names ──────────────────────────────────────
  v('keys-growing', '{"a":1,"ab":2,"abc":3,"abcd":4,"x":5}'),

  // ── nesting & mixed types ───────────────────────────────────────────────
  v('nested-object', '{"o":{"i":[1,2,{"deep":true}]}}'),
  v('nested-array', '["a",null,true,1.5,{"k":"v"},[1,[2,[3]]]]'),
  v('mixed-types', '{"n":null,"b":false,"t":true,"i":5,"f":1.5,"s":"x","arr":[1,2],"obj":{"y":9}}'),
  v('array-all-types', '[null,true,false,0,-1,3.14,"str","ä",{"k":1},[1,2]]'),

  // ── moderately complex, realistic event ─────────────────────────────────
  v(
    'realistic-event',
    `{
      "type": "order.placed",
      "id": "ORD-00042",
      "ts": "2026-06-13T10:00:00.000Z",
      "customer": { "name": "Renée Müller", "country": "FI", "vip": true, "tags": ["gold", "eu"] },
      "items": [
        { "sku": "A-1", "qty": 2, "price": 9.95, "note": "fragile — 取扱注意" },
        { "sku": "B-2", "qty": 1, "price": 100.0, "gift": null }
      ],
      "total": 119.90,
      "meta": { "source": "web", "flags": [], "nested": { "a": { "b": { "c": 1 } } } }
    }`,
  ),
  v('deeply-nested', '{"l1":{"l2":{"l3":{"l4":{"l5":{"leaf":[1,2,3]}}}}}}'),

  // ── future-proofing: Unicode normalization & more scripts ───────────────
  // Combining sequence (e + U+0301) vs the precomposed é — PG must NOT apply
  // Unicode normalization (NFC/NFD), so these stay distinct forever.
  v('str-combining-diacritic', `"e${BS}u0301"`),
  v('str-precomposed-e-acute', '"é"'),
  v('str-arabic-rtl', '"مرحبا بالعالم"'),
  v('str-hebrew-rtl', '"שלום עולם"'),

  // ── future-proofing: more escape forms ──────────────────────────────────
  v('str-escaped-quote', `"${BS}u0022"`), // → "\""
  v('str-escaped-solidus', `"${BS}/"`), // → "/"
  v('str-escapes-brf', `"${BS}b${BS}f${BS}r"`), // backspace, form-feed, CR

  // ── future-proofing: more number forms ──────────────────────────────────
  v('num-zero-exp', '0e0'),
  v('num-sci-explicit-plus', '1.5e+2'),
  v('num-classic-binary-float', '0.30000000000000004'),
  v('num-huge-negative-exp', '1.23e-30'),

  // ── future-proofing: structural & key-ordering edge cases ───────────────
  v('key-empty-string', '{"":1,"a":2}'),
  v('keys-multidigit-order', '{"k10":1,"k2":2,"k1":3,"k100":4}'),
  v('nested-empties', '{"a":{},"b":[],"c":[{},[]],"d":[[[]]]}'),
  v('array-of-objects', '[{"id":1,"v":"a"},{"id":2,"v":"ä"},{"id":3,"v":null}]'),
];

const { Client } = pg;

async function main() {
  const client = new Client({ connectionString: URL });
  await client.connect();
  try {
    const pgVersion = (await client.query('SHOW server_version')).rows[0].server_version;
    const vectors = [];
    const seen = new Set();
    for (const entry of CORPUS) {
      if (seen.has(entry.name)) throw new Error(`duplicate vector name: ${entry.name}`);
      seen.add(entry.name);
      try {
        JSON.parse(entry.json); // catch authoring typos with a clear message
      } catch (err) {
        throw new Error(`vector ${entry.name}: source is not valid JSON — ${err.message}`);
      }
      const { rows } = await client.query(
        `SELECT c AS canonical, encode(sha256(convert_to(c, 'UTF8')), 'hex') AS data_hash
           FROM (SELECT ($1::jsonb)::text AS c) s`,
        [entry.json],
      );
      vectors.push({
        name: entry.name,
        input: entry.json,
        canonical: rows[0].canonical,
        data_hash: rows[0].data_hash,
      });
    }
    const doc = {
      _comment:
        'JSONB canonicalization golden vectors. Source values are raw JSON strings. ' +
        'Generated on PostgreSQL 16 via scripts/gen-jsonb-vectors.mjs. ' +
        'data_hash = sha256(convert_to(input::jsonb::text, UTF8)). ' +
        'These must reproduce byte-identically on every supported PostgreSQL version.',
      generatedOnServerVersion: pgVersion,
      count: vectors.length,
      vectors,
    };
    writeFileSync(OUT, JSON.stringify(doc, null, 2) + '\n');
    console.log(`Wrote ${vectors.length} vectors to ${OUT} (PostgreSQL ${pgVersion})`);
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
