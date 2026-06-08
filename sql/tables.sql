-- tr-json-chain: immutable bootstrap DDL.
--
-- FROZEN: this file must never change in a way that alters the shape of
-- existing tables. Everything here is idempotent (create-if-absent); the
-- module verifies the shape of pre-existing tables and refuses to touch
-- them on any mismatch. No ALTER, no DROP — ever.
--
-- {{ns}} is the namespace prefix (e.g. "myapp_"), empty by default. It is
-- expanded by the module after strict identifier validation.

-- `id` is a caller-assigned, dense, 0-based position in the chain (genesis is
-- 0, the next event 1, and so on). The stored functions derive each new id as
-- parent.id + 1 under the table's exclusive lock, so there are no gaps even
-- across rolled-back transactions (unlike a sequence). `id` is never hashed,
-- so this addressing has no bearing on chain integrity.
CREATE TABLE IF NOT EXISTS {{ns}}event_chain (
  id BIGINT NOT NULL,
  parent_id BYTEA UNIQUE REFERENCES {{ns}}event_chain(event_id),
  data_hash BYTEA NOT NULL,
  event_id BYTEA UNIQUE NOT NULL,
  PRIMARY KEY (id)
);

-- Structural single-linked-list guarantee: parent_id UNIQUE forbids forks,
-- the parent FK forbids orphans, and this partial unique index forbids a
-- second root (only one row may have parent_id IS NULL).
CREATE UNIQUE INDEX IF NOT EXISTS {{ns}}event_chain_one_genesis
  ON {{ns}}event_chain ((true)) WHERE parent_id IS NULL;

CREATE TABLE IF NOT EXISTS {{ns}}event_payload (
  event_id BYTEA NOT NULL REFERENCES {{ns}}event_chain(event_id),
  ts TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
  d JSONB NOT NULL,
  PRIMARY KEY (event_id)
);

-- Genesis row: id 0, 256 zero bits for both data_hash and event_id, no parent.
-- Inserted only into a virgin chain; the partial unique index above also
-- guards this against races.
INSERT INTO {{ns}}event_chain (id, parent_id, data_hash, event_id)
SELECT
  0,
  NULL,
  '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea,
  '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea
WHERE NOT EXISTS (SELECT 1 FROM {{ns}}event_chain);
