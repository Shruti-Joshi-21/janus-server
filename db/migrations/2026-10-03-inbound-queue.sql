-- Adds the inbox-queue columns to an existing database without wiping data (schema.sql has them for fresh resets).
-- Messages that arrived before the queue existed are marked done, so Janus doesn't answer old test messages.
ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS status text NOT NULL DEFAULT 'pending';
ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS claimed_at timestamptz;
ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS claim_count integer NOT NULL DEFAULT 0;
ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS handled_at timestamptz;
ALTER TABLE inbound_events ADD COLUMN IF NOT EXISTS outcome text;
DO $$ BEGIN
  ALTER TABLE inbound_events ADD CONSTRAINT inbound_events_status_check CHECK (status IN ('pending', 'claimed', 'done'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
CREATE INDEX IF NOT EXISTS inbound_events_queue_idx ON inbound_events (status, received_at);
UPDATE inbound_events SET status = 'done', handled_at = now(), outcome = 'received before the inbox queue existed'
WHERE status = 'pending' AND outcome IS NULL;
