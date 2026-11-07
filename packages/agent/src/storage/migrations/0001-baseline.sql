-- Store format 1: reviewed independent schema; no old-format conversion.
CREATE TABLE blob (hash TEXT PRIMARY KEY, size INTEGER NOT NULL CHECK(size >= 0), published_at TEXT NOT NULL);
CREATE TABLE blob_ref (id TEXT PRIMARY KEY, blob_hash TEXT NOT NULL REFERENCES blob(hash), session_id TEXT NOT NULL REFERENCES session(id), owner_kind TEXT NOT NULL, owner_id TEXT NOT NULL, subject_id TEXT NOT NULL, origin_store_id TEXT NOT NULL, media_type TEXT NOT NULL);
CREATE TABLE change_event (cursor INTEGER PRIMARY KEY, scope_session_id TEXT REFERENCES session(id), object_id TEXT NOT NULL, revision INTEGER NOT NULL, type TEXT NOT NULL, payload_json TEXT NOT NULL);
CREATE TABLE command (run_resume_lease_json TEXT, job_recovery_lease_json TEXT, id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), seq INTEGER NOT NULL, kind TEXT NOT NULL, subject_id TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('accepted','applied','rejected','needs_review')), receipt_json TEXT, origin_store_id TEXT NOT NULL, root_work_command_id TEXT NOT NULL, root_work_seq INTEGER NOT NULL, cancelled INTEGER NOT NULL DEFAULT 0, cancel_requested_at INTEGER, extension_id TEXT, scope_kind TEXT, scope_id TEXT, operation_key TEXT, target_command_id TEXT, agent_source_execution_id TEXT REFERENCES execution(id), agent_carrier_execution_id TEXT REFERENCES execution(id), input_target_run_id TEXT REFERENCES run(id), input_context_selection_id TEXT, after_run_id TEXT REFERENCES run(id), mail_target_session_id TEXT REFERENCES session(id), mail_target_run_id TEXT REFERENCES run(id), mail_selection_id TEXT, mail_received_message_id TEXT REFERENCES message(id), mail_received_run_id TEXT REFERENCES run(id), mail_received_selection_id TEXT, mail_adoption_upper_seq INTEGER, mail_adoption_cursor INTEGER, mail_confirmed INTEGER NOT NULL DEFAULT 0 CHECK(mail_confirmed IN (0,1)), pending_order INTEGER, UNIQUE(session_id,seq), UNIQUE(id,session_id), UNIQUE(origin_store_id,extension_id,scope_kind,scope_id,operation_key));
CREATE TABLE context_snapshot (kind TEXT NOT NULL DEFAULT 'model_snapshot' CHECK(kind IN ('selection','result_ref','model_snapshot','compression_pending','compression','compression_reset')), seq INTEGER, execution_id TEXT REFERENCES execution(id), result_revision INTEGER, inclusion TEXT CHECK(inclusion IN ('automatic','explicit')), origin_store_id TEXT, subject_id TEXT, id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT, step_id TEXT, selection_id TEXT NOT NULL, sources_json TEXT NOT NULL, request_json TEXT NOT NULL, FOREIGN KEY(run_id,session_id) REFERENCES run(id,session_id));
CREATE TABLE "execution" (recovery_manifest_json TEXT, id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT, kind TEXT NOT NULL CHECK(kind IN ('model','tool','job')), origin_command_id TEXT NOT NULL, origin_store_id TEXT NOT NULL, root_work_command_id TEXT NOT NULL, root_work_seq INTEGER NOT NULL, parent_execution_id TEXT REFERENCES execution(id), cancel_with_parent INTEGER NOT NULL DEFAULT 1, root_session_id TEXT NOT NULL REFERENCES session(id), step_id TEXT NOT NULL, call_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt > 0), adapter_id TEXT NOT NULL, definition_version TEXT NOT NULL, child_session_id TEXT REFERENCES session(id), child_configuration_json TEXT, after_turn_json TEXT, state TEXT NOT NULL CHECK(state IN ('planned','dispatching','running','succeeded','failed','cancelled','outcome_unknown')), intent_json TEXT NOT NULL, decision_source_json TEXT NOT NULL, model_snapshot_json TEXT, dispatch_authorization_json TEXT, result_json TEXT, reference_json TEXT, output_seq INTEGER NOT NULL DEFAULT 0, output_bytes INTEGER NOT NULL DEFAULT 0, output_truncated INTEGER NOT NULL DEFAULT 0, output_budget_exhausted INTEGER NOT NULL DEFAULT 0 CHECK(output_budget_exhausted IN (0,1)), interaction_binding_json TEXT, finalization_digest TEXT, predecessor_execution_id TEXT REFERENCES execution(id), dispatched INTEGER NOT NULL DEFAULT 0 CHECK(dispatched IN (0,1)), result_revision INTEGER NOT NULL DEFAULT 0, completed_cursor INTEGER CHECK(completed_cursor > 0), cancel_requested_at INTEGER, owner_generation INTEGER NOT NULL, cancel_requested INTEGER NOT NULL DEFAULT 0, requirements_json TEXT NOT NULL DEFAULT '[]', delivery TEXT, delivery_reason TEXT, delivery_target_session_id TEXT REFERENCES session(id), context_selection_id TEXT, CHECK(run_id IS NOT NULL OR (kind IN ('job','tool','model') AND origin_command_id IS NOT NULL)), UNIQUE(id,session_id), UNIQUE(run_id,step_id,call_id,attempt), FOREIGN KEY(run_id,session_id) REFERENCES run(id,session_id), FOREIGN KEY(origin_command_id,session_id) REFERENCES command(id,session_id));
CREATE TABLE execution_output (execution_id TEXT NOT NULL REFERENCES execution(id), stream TEXT NOT NULL, seq INTEGER NOT NULL, blob_hash TEXT REFERENCES blob(hash), summary TEXT, content TEXT NOT NULL DEFAULT '', through_seq INTEGER NOT NULL, dropped_bytes INTEGER NOT NULL DEFAULT 0, is_gap INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(execution_id,stream,seq));
CREATE TABLE extension_record (fork_provenance_json TEXT, extension_id TEXT NOT NULL, scope_kind TEXT NOT NULL, scope_id TEXT NOT NULL, key TEXT NOT NULL, revision INTEGER NOT NULL, content_type TEXT NOT NULL, content_version INTEGER NOT NULL, origin_store_id TEXT, json TEXT NOT NULL, PRIMARY KEY(extension_id,scope_kind,scope_id,key));
CREATE TABLE host_mutation (id TEXT PRIMARY KEY, origin_store_id TEXT NOT NULL, subject_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('config.user.write','config.workspace.write','config.repair','credential.put','credential.revoke','permission.mode','workspace.trust','permission.grants.clear')), scope TEXT NOT NULL, request_digest TEXT NOT NULL, safe_request_json TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('pending','applied','failed','outcome_unknown')), receipt_json TEXT NOT NULL DEFAULT 'null');
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
CREATE TABLE interaction (information_permission_json TEXT, id TEXT PRIMARY KEY, origin_store_id TEXT NOT NULL, subject_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT, execution_id TEXT NOT NULL, attempt INTEGER NOT NULL CHECK(attempt>0), presentation_session_id TEXT NOT NULL REFERENCES session(id), ancestry_json TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('approval','question','plan_review')), definition_id TEXT NOT NULL, definition_version TEXT NOT NULL, input_digest TEXT NOT NULL, policy_revision TEXT NOT NULL, required_refs_json TEXT NOT NULL, source_json TEXT NOT NULL, request_digest TEXT NOT NULL, request_json TEXT NOT NULL, answer_json TEXT, revision INTEGER NOT NULL DEFAULT 1, accepted_decision_revision INTEGER, state TEXT NOT NULL CHECK(state IN ('pending','answered','cancelled')), FOREIGN KEY(run_id,session_id) REFERENCES run(id,session_id), FOREIGN KEY(execution_id,session_id) REFERENCES execution(id,session_id));
CREATE TABLE message (fork_source_message_id TEXT REFERENCES message(id), id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), run_id TEXT, seq INTEGER NOT NULL, role TEXT NOT NULL, status TEXT NOT NULL, source_json TEXT NOT NULL, UNIQUE(session_id,seq), FOREIGN KEY(run_id,session_id) REFERENCES run(id,session_id));
CREATE TABLE message_part (message_id TEXT NOT NULL REFERENCES message(id), ordinal INTEGER NOT NULL, kind TEXT NOT NULL, content_version INTEGER NOT NULL, revision INTEGER NOT NULL, json TEXT NOT NULL, PRIMARY KEY(message_id,ordinal));
CREATE TABLE pending_input_queue_revision (
  session_id TEXT PRIMARY KEY REFERENCES session(id) ON DELETE CASCADE,
  revision INTEGER NOT NULL CHECK(typeof(revision)='integer' AND revision>=0)
);
CREATE TABLE permission_grant (id TEXT PRIMARY KEY REFERENCES interaction(id), origin_store_id TEXT NOT NULL, subject_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session(id), workspace_id TEXT NOT NULL, kind TEXT NOT NULL, definition_id TEXT NOT NULL, definition_version TEXT NOT NULL, input_digest TEXT NOT NULL, scope_digest TEXT NOT NULL, payload_json TEXT NOT NULL, execution_id TEXT NOT NULL REFERENCES execution(id), decision_revision TEXT NOT NULL, seq INTEGER NOT NULL REFERENCES permission_grant_change(seq), revoked_seq INTEGER REFERENCES permission_grant_change(seq));
CREATE TABLE permission_grant_change (seq INTEGER PRIMARY KEY AUTOINCREMENT, origin_store_id TEXT NOT NULL, subject_id TEXT NOT NULL, session_id TEXT NOT NULL REFERENCES session(id), kind TEXT NOT NULL);
CREATE TABLE recovery_audit (run_id TEXT PRIMARY KEY, version INTEGER NOT NULL CHECK(version=1), store_id TEXT NOT NULL, schema_cookie INTEGER NOT NULL, covered_seq INTEGER NOT NULL CHECK(covered_seq>=0));
CREATE TABLE recovery_audit_change (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('execution','interaction','run')), record_id TEXT NOT NULL);
CREATE TABLE recovery_audit_record (run_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN('execution','interaction')), record_id TEXT NOT NULL, row_digest TEXT NOT NULL, issue TEXT, PRIMARY KEY(run_id,kind,record_id));
CREATE TABLE recovery_audit_writer (singleton INTEGER PRIMARY KEY CHECK(singleton=1), writing INTEGER NOT NULL CHECK(writing IN(0,1)));
CREATE TABLE run (context_selection_id TEXT NOT NULL, initialization_state TEXT NOT NULL DEFAULT 'unstarted' CHECK(initialization_state IN ('unstarted','started','completed')), id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES session(id), origin_command_id TEXT NOT NULL, origin_store_id TEXT NOT NULL, root_work_command_id TEXT NOT NULL, root_work_seq INTEGER NOT NULL, status TEXT NOT NULL, is_active INTEGER NOT NULL CHECK(is_active IN (0,1)), config_json TEXT NOT NULL, requirements_json TEXT NOT NULL DEFAULT '[]', waiting_results_json TEXT NOT NULL DEFAULT '[]', started_at TEXT NOT NULL, deadline_at INTEGER CHECK(deadline_at IS NULL OR (typeof(deadline_at)='integer' AND deadline_at<=CAST(started_at AS INTEGER)+1800000)), finished_at TEXT, reason TEXT, cancel_requested_at INTEGER, cancel_requested INTEGER NOT NULL DEFAULT 0, UNIQUE(id,session_id), UNIQUE(origin_command_id), FOREIGN KEY(origin_command_id,session_id) REFERENCES command(id,session_id));
CREATE TABLE schema_migration (id TEXT PRIMARY KEY, checksum TEXT NOT NULL, completed_at TEXT NOT NULL);
CREATE TABLE session (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL REFERENCES workspace(id), parent_id TEXT REFERENCES session(id), root_id TEXT NOT NULL REFERENCES session(id), title TEXT NOT NULL, control_revision INTEGER NOT NULL DEFAULT 0, next_seq INTEGER NOT NULL DEFAULT 0, context_selection_id TEXT NOT NULL, owner_instance TEXT, owner_generation INTEGER NOT NULL DEFAULT 0, delete_requested INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER, stop_boundary INTEGER NOT NULL DEFAULT 0, UNIQUE(id,workspace_id));
CREATE TABLE session_reconciliation (
  root_session_id TEXT PRIMARY KEY REFERENCES session(id),
  command_id TEXT NOT NULL REFERENCES command(id),
  store_id TEXT NOT NULL,
  generation INTEGER NOT NULL,
  checkpoint_json TEXT NOT NULL
);
CREATE TABLE storage_meta (singleton INTEGER PRIMARY KEY CHECK(singleton=1), store_id TEXT NOT NULL, format_major INTEGER NOT NULL, replay_floor INTEGER NOT NULL DEFAULT 0, last_change_cursor INTEGER NOT NULL DEFAULT 0 CHECK(last_change_cursor >= replay_floor));
CREATE TABLE workspace (id TEXT PRIMARY KEY, root_uri TEXT NOT NULL, name TEXT NOT NULL, metadata_json TEXT NOT NULL DEFAULT '{}');
CREATE INDEX command_input_target ON command(input_target_run_id,status,seq) WHERE kind IN ('input.steer','result.include');
CREATE INDEX command_mail_target ON command(mail_target_session_id,mail_target_run_id,mail_confirmed) WHERE kind='agent.message';
CREATE INDEX command_mail_recipient ON command(mail_target_session_id,subject_id) WHERE mail_target_session_id IS NOT NULL;
CREATE INDEX command_pending ON command(session_id,status,seq);
CREATE INDEX command_pending_order ON command(session_id,status,pending_order,seq);
CREATE INDEX command_session_kind ON command(session_id,kind);
CREATE INDEX command_work_authority ON command(origin_store_id,root_work_command_id,session_id,seq);
CREATE INDEX authorization_invalidation_check ON command(json_extract(receipt_json,'$.checkExecutionId'),origin_store_id,json_extract(receipt_json,'$.targetExecutionId'),json_extract(receipt_json,'$.policyRevision')) WHERE kind='authorization.invalidate' AND status='applied' AND cancelled=0;
CREATE INDEX context_compression ON context_snapshot(session_id,selection_id,seq DESC) WHERE kind IN ('compression','compression_reset');
CREATE INDEX context_result_ref ON context_snapshot(session_id,execution_id,result_revision,seq) WHERE kind='result_ref';
CREATE INDEX context_result_execution ON context_snapshot(execution_id,result_revision,seq) WHERE kind='result_ref';
CREATE INDEX execution_activity ON execution(session_id,state);
CREATE INDEX execution_child ON execution(child_session_id) WHERE child_session_id IS NOT NULL;
CREATE INDEX execution_child_work ON execution(root_session_id,root_work_command_id,root_work_seq) WHERE child_session_id IS NOT NULL AND state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_effect_model ON execution(session_id,json_extract(CASE WHEN json_valid(decision_source_json) THEN decision_source_json ELSE '{}' END,'$.modelExecutionId')) WHERE kind IN('tool','job');
CREATE INDEX execution_effect_step ON execution(session_id,step_id) WHERE kind IN('tool','job');
CREATE INDEX execution_work_effect ON execution(origin_store_id,root_work_command_id) WHERE kind IN('tool','job') AND dispatched=1;
CREATE INDEX execution_failed_origin ON execution(origin_command_id) WHERE kind='model' AND state='failed';
CREATE INDEX execution_model_step ON execution(session_id,step_id) WHERE kind='model';
CREATE INDEX execution_origin_command ON execution(origin_command_id);
CREATE INDEX execution_parent ON execution(parent_execution_id,cancel_with_parent);
CREATE INDEX execution_pending_delivery ON execution(delivery_target_session_id,completed_cursor) WHERE delivery='pending';
CREATE INDEX execution_recovery_frontier ON execution(run_id) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_model ON execution(run_id) WHERE kind='model';
CREATE INDEX execution_recovery_root ON execution(root_session_id,state) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX execution_recovery_state ON execution(state,session_id) WHERE state IN('planned','dispatching','running','outcome_unknown');
CREATE INDEX host_mutation_control_scope ON host_mutation(origin_store_id,subject_id,kind,scope,state);
CREATE INDEX host_mutation_default_mode ON host_mutation(origin_store_id,subject_id) WHERE kind='permission.mode' AND state='applied' AND json_extract(safe_request_json,'$.makeDefault')=1;
CREATE INDEX input_file_import_session ON input_file_import(session_id,id);
CREATE INDEX interaction_execution ON interaction(execution_id,attempt,kind);
CREATE INDEX interaction_projection ON interaction(presentation_session_id,state,id);
CREATE INDEX interaction_recovery_frontier ON interaction(run_id) WHERE state IN('pending','answered');
CREATE INDEX job_reconcile_verified ON command(origin_store_id,session_id,json_extract(request_json,'$.executionId'),json_extract(request_json,'$.expectedResultRevision')) WHERE kind='job.reconcile' AND status='applied' AND json_extract(receipt_json,'$.outcome')='verified' AND json_extract(receipt_json,'$.supervision')='ended';
CREATE INDEX message_tool_pair ON message(session_id,json_extract(source_json,'$.toolCallId'),seq) WHERE role='tool';
CREATE UNIQUE INDEX output_gap ON execution_output(execution_id,stream) WHERE is_gap=1;
CREATE INDEX permission_grant_exact ON permission_grant(origin_store_id,subject_id,session_id,workspace_id,scope_digest);
CREATE INDEX permission_grant_scope ON permission_grant_change(origin_store_id,subject_id,session_id,seq);
CREATE INDEX recovery_audit_issue ON recovery_audit_record(run_id,issue) WHERE issue IS NOT NULL;
CREATE INDEX recovery_audit_pending ON recovery_audit_change(run_id,seq);
CREATE INDEX recovery_audit_pending_record ON recovery_audit_change(run_id,kind,record_id);
CREATE INDEX recovery_audit_sequence ON recovery_audit(covered_seq DESC);
CREATE UNIQUE INDEX run_active ON run(session_id) WHERE is_active=1;
CREATE INDEX session_group ON session(root_id,parent_id);
CREATE TRIGGER authorization_check_model_insert BEFORE INSERT ON execution
WHEN NEW.kind='model' AND NEW.run_id IS NULL
BEGIN
 SELECT CASE WHEN NEW.child_session_id IS NOT NULL OR NEW.parent_execution_id IS NULL OR NOT EXISTS(SELECT 1 FROM command c JOIN execution target ON target.id=NEW.parent_execution_id WHERE c.id=NEW.origin_command_id AND (c.kind='authorization.check' OR (c.kind='session.title' AND target.adapter_id='builtin.session-title/generate' AND target.definition_version='1' AND target.dispatched=1)) AND c.session_id=NEW.session_id AND target.session_id=NEW.session_id AND c.origin_store_id=NEW.origin_store_id AND target.origin_store_id=NEW.origin_store_id) THEN RAISE(ABORT,'invalid_runless_model') END;
END;
CREATE TRIGGER command_recovery_identity AFTER UPDATE OF id,subject_id,kind,request_json,agent_carrier_execution_id ON command BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE origin_command_id IN(OLD.id,NEW.id) AND kind='model' AND state='failed' AND run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT i.run_id,'interaction',i.id FROM run r JOIN interaction i ON i.run_id=r.id WHERE r.origin_command_id IN(OLD.id,NEW.id) AND i.state IN('pending','answered');
END;
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
CREATE TRIGGER interaction_recovery_delete AFTER DELETE ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'interaction',OLD.id WHERE OLD.run_id IS NOT NULL;
END;
CREATE TRIGGER interaction_recovery_insert AFTER INSERT ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'interaction',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER interaction_recovery_replace BEFORE INSERT ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE id=NEW.id AND run_id IS NOT NULL;
END;
CREATE TRIGGER interaction_recovery_update AFTER UPDATE ON interaction BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT OLD.run_id,'interaction',OLD.id WHERE OLD.run_id IS NOT NULL;
INSERT INTO recovery_audit_change(run_id,kind,record_id) SELECT NEW.run_id,'interaction',NEW.id WHERE NEW.run_id IS NOT NULL;
END;
CREATE TRIGGER pending_input_queue_delete AFTER DELETE ON command
WHEN EXISTS(SELECT 1 FROM session WHERE id=OLD.session_id) AND OLD.kind IN ('input.steer','input.follow_up','result.include') AND OLD.status='accepted' AND OLD.cancelled=0 AND COALESCE(json_extract(OLD.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(OLD.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER pending_input_queue_insert AFTER INSERT ON command
WHEN NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(NEW.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER pending_input_queue_update AFTER UPDATE OF status,cancelled,receipt_json,pending_order ON command
WHEN ((OLD.kind IN ('input.steer','input.follow_up','result.include') AND OLD.status='accepted' AND OLD.cancelled=0 AND COALESCE(json_extract(OLD.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')) != (NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')))
  OR ((NEW.kind IN ('input.steer','input.follow_up','result.include') AND NEW.status='accepted' AND NEW.cancelled=0 AND COALESCE(json_extract(NEW.receipt_json,'$.outcome'),'') NOT IN('human_input_pending','human_input_queued','human_input_unresolved')) AND NEW.pending_order IS NOT OLD.pending_order)
BEGIN
  INSERT INTO pending_input_queue_revision VALUES(NEW.session_id,1)
  ON CONFLICT(session_id) DO UPDATE SET revision=revision+1;
END;
CREATE TRIGGER recovery_audit_change_delete_guard BEFORE DELETE ON recovery_audit_change WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_change_update_guard BEFORE UPDATE ON recovery_audit_change WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_delete_guard BEFORE DELETE ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_insert_guard BEFORE INSERT ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_delete_guard BEFORE DELETE ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 AND EXISTS(SELECT 1 FROM run WHERE id=OLD.run_id) BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_insert_guard BEFORE INSERT ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_record_update_guard BEFORE UPDATE ON recovery_audit_record WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER recovery_audit_sequence_guard AFTER INSERT ON recovery_audit_change
WHEN NEW.seq <= COALESCE((SELECT covered_seq FROM recovery_audit ORDER BY covered_seq DESC LIMIT 1),0)
  OR NEW.seq < (SELECT MAX(seq) FROM recovery_audit_change)
BEGIN SELECT RAISE(ABORT,'recovery_audit_sequence_conflict'); END;
CREATE TRIGGER recovery_audit_update_guard BEFORE UPDATE ON recovery_audit WHEN COALESCE((SELECT writing FROM recovery_audit_writer WHERE singleton=1),0)!=1 BEGIN SELECT RAISE(ABORT,'recovery_audit_write_denied'); END;
CREATE TRIGGER run_recovery_delete AFTER DELETE ON run BEGIN
DELETE FROM recovery_audit_record WHERE run_id=OLD.id;
DELETE FROM recovery_audit_change WHERE run_id=OLD.id;
DELETE FROM recovery_audit WHERE run_id=OLD.id;
END;
CREATE TRIGGER run_recovery_identity AFTER UPDATE OF session_id,origin_command_id ON run BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE run_id=NEW.id AND kind='model' AND state='failed';
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'interaction',id FROM interaction WHERE run_id=NEW.id AND state IN('pending','answered');
END;
CREATE TRIGGER run_recovery_insert AFTER INSERT ON run BEGIN INSERT INTO recovery_audit_change(run_id,kind,record_id) VALUES(NEW.id,'run',NEW.id); END;
CREATE TRIGGER session_recovery_identity AFTER UPDATE OF parent_id,root_id ON session BEGIN
INSERT INTO recovery_audit_change(run_id,kind,record_id)
SELECT run_id,'execution',id FROM execution WHERE session_id=NEW.id AND kind='model' AND state='failed' AND run_id IS NOT NULL;
END;
INSERT INTO recovery_audit_writer VALUES(1,0);
