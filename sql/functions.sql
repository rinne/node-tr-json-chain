-- tr-json-chain: stored functions.
--
-- Replaceable layer: these are (re)installed with CREATE OR REPLACE on every
-- init and may evolve freely between module versions. They must NEVER change
-- how event_id / data_hash are computed:
--
--   data_hash = sha256(payload jsonb rendered as text, UTF-8)
--   event_id  = sha256(parent_event_id || data_hash)
--
-- {{ns}} is the namespace prefix (e.g. "myapp_"), empty by default.

-- Records an event into the chain and returns its event id.
CREATE OR REPLACE FUNCTION {{ns}}event_record(event_data jsonb, store_payload bool DEFAULT TRUE)
RETURNS BYTEA AS $$
DECLARE
  d bytea; -- Payload data as binary (UTF-8 rendering of the jsonb value).
  j jsonb; -- Payload converted back from binary; exactly what was hashed.
  h bytea; -- Hash of the payload.
  r bytea; -- Event id to be returned.
BEGIN
  IF event_data IS NULL THEN
    RAISE EXCEPTION 'event_data must not be null';
  END IF;

  -- Elaborate assignments with castings to ensure the stored payload is the
  -- exact jsonb value whose rendering was hashed.
  d := convert_to(event_data::text, 'UTF8');
  j := convert_from(d, 'UTF8')::jsonb;
  h := sha256(d);

  -- Chain handling needs the lock: finding the chain head and inserting the
  -- new head must be atomic. The new id is the head's id + 1 (dense, gap-free).
  LOCK TABLE {{ns}}event_chain IN EXCLUSIVE MODE;
  INSERT INTO {{ns}}event_chain (id, parent_id, data_hash, event_id)
    SELECT id + 1, event_id, h, sha256(event_id || h)
    FROM {{ns}}event_chain
    ORDER BY id DESC
    LIMIT 1
  RETURNING event_id INTO r;

  IF r IS NULL THEN
    RAISE EXCEPTION 'event chain is empty (missing genesis row)';
  END IF;

  -- Payload is recorded unless explicitly omitted; the chain entry exists
  -- regardless.
  IF store_payload = TRUE THEN
    INSERT INTO {{ns}}event_payload (event_id, d) VALUES (r, j);
  END IF;

  RETURN r;
END
$$ LANGUAGE plpgsql;

-- Returns the chain head's event id. If the head is not already an empty
-- event (zero data_hash), appends one first, so that repeated calls don't
-- pile up empty events.
CREATE OR REPLACE FUNCTION {{ns}}event_head()
RETURNS BYTEA AS $$
DECLARE
  z CONSTANT bytea :=
    '\x0000000000000000000000000000000000000000000000000000000000000000'::bytea;
  i bigint; -- id of the current head.
  h bytea; -- data_hash of the current head.
  r bytea; -- Event id to be returned.
BEGIN
  -- Chain handling needs the lock: inspecting the head and appending the
  -- empty checkpoint event must be atomic.
  LOCK TABLE {{ns}}event_chain IN EXCLUSIVE MODE;
  SELECT id, event_id, data_hash INTO i, r, h
    FROM {{ns}}event_chain ORDER BY id DESC LIMIT 1;

  IF r IS NULL THEN
    RAISE EXCEPTION 'event chain is empty (missing genesis row)';
  END IF;

  IF h <> z THEN
    INSERT INTO {{ns}}event_chain (id, parent_id, data_hash, event_id)
      VALUES (i + 1, r, z, sha256(r || z))
    RETURNING event_id INTO r;
  END IF;

  RETURN r;
END
$$ LANGUAGE plpgsql;
