/** Store 14 tracks event content independently of sequence and display metadata. */
export const KITE_HISTORY_GENERATION_TRIGGERS = Object.freeze([
  `CREATE TRIGGER runtime_events_history_insert AFTER INSERT ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1 WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER runtime_events_history_delete AFTER DELETE ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1 WHERE session_id = OLD.session_id;
  END`,
  `CREATE TRIGGER runtime_events_history_update AFTER UPDATE ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1 WHERE session_id = OLD.session_id;
    UPDATE runtime_sessions SET history_generation = history_generation + 1
      WHERE session_id = NEW.session_id AND NEW.session_id <> OLD.session_id;
  END`,
] as const);

export const KITE_HISTORY_GENERATION_TRIGGER_NAMES = Object.freeze([
  'runtime_events_history_insert',
  'runtime_events_history_delete',
  'runtime_events_history_update',
] as const);

/** Store 16 distinguishes a pure tail append from any possible prefix rewrite. */
export const KITE_HISTORY_REVISION_TRIGGERS = Object.freeze([
  `CREATE TRIGGER runtime_sessions_history_identity AFTER INSERT ON runtime_sessions BEGIN
    UPDATE runtime_sessions SET history_instance_id = lower(hex(randomblob(16))) WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER runtime_events_history_insert AFTER INSERT ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1,
      history_rewrite_generation = history_rewrite_generation + CASE WHEN NEW.sequence <= history_append_sequence THEN 1 ELSE 0 END,
      history_append_sequence = MAX(history_append_sequence, NEW.sequence)
      WHERE session_id = NEW.session_id;
  END`,
  `CREATE TRIGGER runtime_events_history_delete AFTER DELETE ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1,
      history_rewrite_generation = history_rewrite_generation + 1 WHERE session_id = OLD.session_id;
  END`,
  `CREATE TRIGGER runtime_events_history_update AFTER UPDATE ON runtime_events BEGIN
    UPDATE runtime_sessions SET history_generation = history_generation + 1,
      history_rewrite_generation = history_rewrite_generation + 1,
      history_append_sequence = MAX(history_append_sequence, CASE WHEN NEW.session_id = OLD.session_id THEN NEW.sequence ELSE 0 END)
      WHERE session_id = OLD.session_id;
    UPDATE runtime_sessions SET history_generation = history_generation + 1,
      history_rewrite_generation = history_rewrite_generation + 1,
      history_append_sequence = MAX(history_append_sequence, NEW.sequence)
      WHERE session_id = NEW.session_id AND NEW.session_id <> OLD.session_id;
  END`,
] as const);

export const KITE_HISTORY_REVISION_TRIGGER_NAMES = Object.freeze([
  'runtime_sessions_history_identity',
  ...KITE_HISTORY_GENERATION_TRIGGER_NAMES,
] as const);
