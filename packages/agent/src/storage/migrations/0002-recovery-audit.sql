-- Transactional recovery certificates. The original ledger remains authoritative.
CREATE TABLE recovery_audit_writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), writing INTEGER NOT NULL CHECK(writing IN(0,1)));
INSERT INTO recovery_audit_writer VALUES(1,0);
CREATE TABLE recovery_audit (run_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1), store_id TEXT NOT NULL, schema_cookie INTEGER NOT NULL, covered_seq INTEGER NOT NULL CHECK(covered_seq>=0));
CREATE INDEX recovery_audit_sequence ON recovery_audit(covered_seq DESC);
CREATE TABLE recovery_audit_record (run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('execution','interaction')), record_id TEXT NOT NULL, row_digest TEXT NOT NULL, issue TEXT, PRIMARY KEY(run_id,kind,record_id));
CREATE INDEX recovery_audit_issue ON recovery_audit_record(run_id,issue) WHERE issue IS NOT NULL;
CREATE TABLE recovery_audit_change (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('execution','interaction','run')), record_id TEXT NOT NULL);
CREATE INDEX recovery_audit_pending ON recovery_audit_change(run_id,seq);
CREATE TRIGGER recovery_audit_sequence_guard AFTER INSERT ON recovery_audit_change
WHEN NEW.seq <= COALESCE((SELECT covered_seq FROM recovery_audit ORDER BY covered_seq DESC LIMIT 1),0)
  OR NEW.seq < (SELECT MAX(seq) FROM recovery_audit_change)
BEGIN SELECT RAISE(ABORT,'recovery_audit_sequence_conflict'); END;
CREATE INDEX execution_recovery_frontier ON execution(run_id) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_root ON execution(root_session_id,state) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_model ON execution(run_id) WHERE kind='model';
CREATE INDEX execution_model_step ON execution(session_id,step_id) WHERE kind='model';
CREATE INDEX execution_effect_step ON execution(session_id,step_id) WHERE kind IN('tool','job');
CREATE INDEX execution_effect_model ON execution(session_id,json_extract(CASE WHEN json_valid(decision_source_json) THEN decision_source_json ELSE '{}' END,'$.modelExecutionId')) WHERE kind IN('tool','job');
CREATE INDEX interaction_recovery_frontier ON interaction(run_id) WHERE state IN('pending','answered');
CREATE INDEX execution_child_work ON execution(root_session_id,root_work_command_id,root_work_seq) WHERE child_session_id IS NOT NULL AND state IN('planned','dispatching','running','outcome_unknown');
CREATE TRIGGER recovery_audit_insert_guard BEFORE INSERT ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_update_guard BEFORE UPDATE ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_delete_guard BEFORE DELETE ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_insert_guard BEFORE INSERT ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_update_guard BEFORE UPDATE ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_delete_guard BEFORE DELETE ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_change_update_guard BEFORE UPDATE ON recovery_audit_change WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_change_delete_guard BEFORE DELETE ON recovery_audit_change WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER execution_recovery_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'execution',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_dependencies_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=NEW.session_id AND step_id=NEW.step_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=NEW.parent_execution_id AND run_id IS NOT NULL AND NEW.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(NEW.decision_source_json) THEN NEW.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND NEW.kind IN('tool','job');
END;
CREATE TRIGGER execution_recovery_update AFTER UPDATE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'execution',OLD.id WHERE OLD.run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'execution',NEW.id WHERE NEW.run_id IS NOT NULL;
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
CREATE TRIGGER execution_recovery_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'execution',OLD.id WHERE OLD.run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_dependencies_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND session_id=OLD.session_id AND step_id=OLD.step_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=OLD.parent_execution_id AND run_id IS NOT NULL AND OLD.kind IN('tool','job')
UNION SELECT run_id,'execution',id FROM execution WHERE kind='model' AND state='failed' AND id=json_extract(CASE WHEN json_valid(OLD.decision_source_json) THEN OLD.decision_source_json ELSE '{}' END,'$.modelExecutionId') AND run_id IS NOT NULL AND OLD.kind IN('tool','job');
END;
CREATE TRIGGER interaction_recovery_insert AFTER INSERT ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'interaction',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER interaction_recovery_update AFTER UPDATE ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'interaction',OLD.id WHERE OLD.run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'interaction',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER interaction_recovery_delete AFTER DELETE ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'interaction',OLD.id WHERE OLD.run_id IS NOT NULL;
END;
CREATE TRIGGER run_recovery_insert AFTER INSERT ON run BEGIN INSERT INTO recovery_audit_change(run_id,kind,record_id) VALUES(NEW.id,'run',NEW.id); END;
CREATE TRIGGER run_recovery_delete AFTER DELETE ON run BEGIN
DELETE FROM recovery_audit_record WHERE run_id=OLD.id;
DELETE FROM recovery_audit_change WHERE run_id=OLD.id;
DELETE FROM recovery_audit WHERE run_id=OLD.id;
END;
-- Existing rows are certified once through the ordinary validator.
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT id,'run',id FROM run;

-- Qualification dependencies outside the changed row itself.
CREATE TRIGGER execution_recovery_interactions AFTER UPDATE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id IN(OLD.id,NEW.id) AND run_id IS NOT NULL;
END;
CREATE INDEX execution_failed_origin ON execution(origin_command_id) WHERE kind='model' AND state='failed';
CREATE TRIGGER command_recovery_identity AFTER UPDATE OF id,subject_id,kind,request_json,agent_carrier_execution_id ON command BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE origin_command_id IN(OLD.id,NEW.id) AND kind='model' AND state='failed' AND run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT i.run_id,'interaction',i.id FROM run r JOIN interaction i ON i.run_id=r.id WHERE r.origin_command_id IN(OLD.id,NEW.id) AND i.state IN('pending','answered');
END;
CREATE TRIGGER run_recovery_identity AFTER UPDATE OF session_id,origin_command_id ON run BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE run_id=NEW.id AND kind='model' AND state='failed';
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE run_id=NEW.id AND state IN('pending','answered');
END;
CREATE TRIGGER execution_recovery_child_identity AFTER UPDATE OF id,child_session_id ON execution WHEN OLD.id IS NOT NEW.id OR OLD.child_session_id IS NOT NEW.child_session_id BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE parent_execution_id IN(OLD.id,NEW.id) AND kind='model' AND state='failed' AND run_id IS NOT NULL;
END;
CREATE TRIGGER session_recovery_identity AFTER UPDATE OF parent_id,root_id ON session BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE session_id=NEW.id AND kind='model' AND state='failed' AND run_id IS NOT NULL;
END;

CREATE INDEX command_session_kind ON command(session_id,kind);
CREATE INDEX execution_recovery_state ON execution(state,session_id) WHERE state IN('planned','dispatching','running','outcome_unknown');

CREATE INDEX recovery_audit_pending_record ON recovery_audit_change(run_id,kind,record_id);

-- REPLACE can delete a conflicting row without DELETE triggers when recursive_triggers=OFF.
-- Capture both primary-key and execution-identity conflicts before the replacement.
CREATE TRIGGER execution_recovery_replace BEFORE INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE id=NEW.id AND run_id IS NOT NULL
UNION SELECT run_id,'execution',id FROM execution WHERE run_id=NEW.run_id AND step_id=NEW.step_id AND call_id=NEW.call_id AND attempt=NEW.attempt;
END;
CREATE TRIGGER interaction_recovery_replace BEFORE INSERT ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE id=NEW.id AND run_id IS NOT NULL;
END;

CREATE TRIGGER execution_recovery_interactions_insert AFTER INSERT ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id=NEW.id AND run_id IS NOT NULL;
END;
CREATE TRIGGER execution_recovery_interactions_delete AFTER DELETE ON execution BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE execution_id=OLD.id AND run_id IS NOT NULL;
END;
