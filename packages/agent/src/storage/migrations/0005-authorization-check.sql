-- Rebuild the reviewed execution constraint without changing stored identities.
PRAGMA legacy_alter_table=ON;
CREATE TABLE execution_check_migration (recovery_manifest_json TEXT, id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('model','tool','job')), origin_command_id TEXT NOT NULL, origin_store_id TEXT NOT NULL, root_work_command_id TEXT NOT NULL, root_work_seq INTEGER NOT NULL, parent_execution_id TEXT REFERENCES execution(id), cancel_with_parent INTEGER NOT NULL DEFAULT 1, root_session_id TEXT NOT NULL REFERENCES session(id), step_id TEXT NOT NULL, call_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0), adapter_id TEXT NOT NULL, definition_version TEXT NOT NULL, child_session_id TEXT REFERENCES session(id), child_configuration_json TEXT, after_turn_json TEXT, state TEXT NOT NULL CHECK(state IN ('planned','dispatching','running','succeeded','failed','cancelled','outcome_unknown')), intent_json TEXT NOT NULL, decision_source_json TEXT NOT NULL, model_snapshot_json TEXT, dispatch_authorization_json TEXT, result_json TEXT, reference_json TEXT, output_seq INTEGER NOT NULL DEFAULT 0, output_bytes INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0, output_budget_exhausted INTEGER NOT NULL DEFAULT 0 CHECK(output_budget_exhausted IN (0,1)), interaction_binding_json TEXT, finalization_digest TEXT, predecessor_execution_id TEXT REFERENCES execution(id), dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)), result_revision INTEGER NOT NULL DEFAULT 0, completed_cursor INTEGER CHECK(completed_cursor > 0), cancel_requested_at INTEGER, owner_generation INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, requirements_json TEXT NOT NULL DEFAULT '[]', delivery TEXT, delivery_reason TEXT, delivery_target_session_id TEXT REFERENCES session(id), context_selection_id TEXT, CHECK(run_id IS NOT NULL OR (kind IN ('job','tool','model') AND origin_command_id IS NOT NULL)), UNIQUE(id,session_id), UNIQUE(run_id,step_id,call_id,attempt), FOREIGN KEY(run_id,session_id) REFERENCES run(id,session_id), FOREIGN KEY(origin_command_id,session_id) REFERENCES command(id,session_id));
INSERT INTO execution_check_migration SELECT * FROM execution;
DROP TABLE execution;
ALTER TABLE execution_check_migration RENAME TO execution;
CREATE INDEX execution_activity ON execution(session_id,state);
CREATE INDEX execution_child ON execution(child_session_id) WHERE child_session_id IS NOT NULL;
CREATE INDEX execution_child_work ON execution(root_session_id,root_work_command_id,root_work_seq) WHERE child_session_id IS NOT NULL AND state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_effect_model ON execution(session_id,json_extract(CASE WHEN json_valid(decision_source_json) THEN decision_source_json ELSE '{}' END,'$.modelExecutionId')) WHERE kind IN('tool','job');
CREATE INDEX execution_effect_step ON execution(session_id,step_id) WHERE kind IN('tool','job');
CREATE INDEX execution_failed_origin ON execution(origin_command_id) WHERE kind='model' AND state='failed';
CREATE INDEX execution_model_step ON execution(session_id,step_id) WHERE kind='model';
CREATE INDEX execution_parent ON execution(parent_execution_id,cancel_with_parent);
CREATE INDEX execution_pending_delivery ON execution(delivery_target_session_id,completed_cursor) WHERE delivery='pending';
CREATE INDEX execution_recovery_frontier ON execution(run_id) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_model ON execution(run_id) WHERE kind='model';
CREATE INDEX execution_recovery_root ON execution(root_session_id,state) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_state ON execution(state,session_id) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE TRIGGER execution_recovery_child_identity AFTER UPDATE OF id,child_session_id ON execution WHEN OLD.id IS NOT NEW.id OR OLD.child_session_id IS NOT NEW.child_session_id BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE parent_execution_id IN(OLD.id,NEW.id) AND kind='model' AND state='failed' AND run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'execution',OLD.id WHERE OLD.run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_dependencies_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=OLD.session_id AND step_id=OLD.step_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=OLD.parent_execution_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(OLD.decision_source_json) THEN OLD.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND OLD.kind IN('tool','job');
END;
CREATE TRIGGER execution_recovery_dependencies_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=NEW.session_id AND step_id=NEW.step_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=NEW.parent_execution_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(NEW.decision_source_json) THEN NEW.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND NEW.kind IN('tool','job');
END;
CREATE TRIGGER execution_recovery_dependencies_update AFTER UPDATE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=OLD.session_id AND step_id=OLD.step_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=OLD.parent_execution_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(OLD.decision_source_json) THEN OLD.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND OLD.kind IN('tool','job');
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=NEW.session_id AND step_id=NEW.step_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=NEW.parent_execution_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(NEW.decision_source_json) THEN NEW.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND NEW.kind IN('tool','job');
END;
CREATE TRIGGER execution_recovery_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'execution',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_interactions AFTER UPDATE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id IN(OLD.id,NEW.id) AND run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_interactions_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id=OLD.id AND run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_interactions_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id=NEW.id AND run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_replace BEFORE INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE id=NEW.id AND run_id IS NOT NULL
UNION SELECT run_id,'execution',id FROM execution WHERE run_id=NEW.run_id AND step_id=NEW.step_id AND call_id=NEW.call_id AND attempt=NEW.attempt;
END;
CREATE TRIGGER execution_recovery_update AFTER UPDATE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'execution',OLD.id WHERE OLD.run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'execution',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER authorization_check_model_insert BEFORE INSERT ON execution
WHEN NEW.kind='model' AND NEW.run_id IS NULL
BEGIN
 SELECT CASE WHEN NEW.child_session_id IS NOT NULL OR NEW.parent_execution_id IS NULL OR NOT EXISTS(SELECT 1 FROM command c JOIN execution target ON target.id=NEW.parent_execution_id WHERE c.id=NEW.origin_command_id AND (c.kind='authorization.check' OR (c.kind='session.title' AND target.adapter_id='builtin.session-title/generate' AND target.definition_version='1' AND target.dispatched=1)) AND c.session_id=NEW.session_id AND target.session_id=NEW.session_id AND c.origin_store_id=NEW.origin_store_id AND target.origin_store_id=NEW.origin_store_id) THEN RAISE(ABORT,'invalid_runless_model') END;
END;
PRAGMA legacy_alter_table=OFF;
