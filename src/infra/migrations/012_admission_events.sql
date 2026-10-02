-- Policy/epoch only. P5 owns the durable admission_results ledger.
CREATE TABLE admission_events (
  event_id UUID PRIMARY KEY REFERENCES events(id) ON DELETE CASCADE,
  protected BOOLEAN NOT NULL DEFAULT false,
  generation BIGINT NOT NULL DEFAULT 0 CHECK (generation >= 0),
  epoch UUID NOT NULL DEFAULT uuid_generate_v4(),
  phase TEXT NOT NULL DEFAULT 'recovering' CHECK (phase IN ('recovering', 'open')),
  epoch_started_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  redis_namespace TEXT NOT NULL
);
CREATE UNIQUE INDEX admission_events_one_protected ON admission_events(protected) WHERE protected;
INSERT INTO admission_events(event_id, redis_namespace)
SELECT id, 'peakpass:admission:' || id::text || ':' FROM events;
