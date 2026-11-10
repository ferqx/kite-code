-- Immutable trajectory facts share the original business event transaction.
ALTER TABLE change_event ADD COLUMN trajectory_fact_json TEXT;
ALTER TABLE storage_meta ADD COLUMN trajectory_enabled_after_cursor INTEGER NOT NULL DEFAULT 0
  CHECK(typeof(trajectory_enabled_after_cursor)='integer' AND trajectory_enabled_after_cursor>=0);
UPDATE storage_meta SET trajectory_enabled_after_cursor=last_change_cursor WHERE singleton=1;
