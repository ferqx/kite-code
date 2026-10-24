-- Explicit imports retain their identity after release; they are not generic Blob access grants.
CREATE TABLE input_file_import (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES session(id),
  subject_id TEXT NOT NULL,
  origin_store_id TEXT NOT NULL,
  name TEXT NOT NULL,
  reference_id TEXT NOT NULL,
  reference_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('prepared','bound','released')),
  bound_command_id TEXT REFERENCES command(id),
  created_at INTEGER NOT NULL,
  CHECK((state='bound')=(bound_command_id IS NOT NULL)),
  UNIQUE(reference_id)
);
CREATE INDEX input_file_import_session ON input_file_import(session_id,id);
