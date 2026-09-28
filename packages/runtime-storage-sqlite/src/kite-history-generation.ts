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
