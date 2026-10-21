CREATE TABLE session_reconciliation (
  root_session_id TEXT PRIMARY KEY REFERENCES session(id),
  command_id TEXT NOT NULL REFERENCES command(id),
  store_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL
);
