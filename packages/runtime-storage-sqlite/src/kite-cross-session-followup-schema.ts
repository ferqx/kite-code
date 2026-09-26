import { KITE_SESSION_AGENT_DDL } from './kite-session-agent-schema';

const oldOutbox = KITE_SESSION_AGENT_DDL.find((statement) =>
  statement.startsWith('CREATE TABLE agent_mail_outbox ('),
);
if (!oldOutbox) throw new Error('Store 12 mail outbox DDL is unavailable.');

/** Store 13 binds each TriggerTurn row to one immutable source admission. */
export const KITE_CROSS_SESSION_FOLLOWUP_OUTBOX_DDL = oldOutbox
  .replace(
    '    body_id TEXT NOT NULL,',
    `    submission_id TEXT,
    followup_admission_artifact_id TEXT REFERENCES agent_followup_admission_artifacts(artifact_id),
    followup_admission_digest TEXT CHECK (followup_admission_digest IS NULL OR (length(followup_admission_digest) = 71 AND substr(followup_admission_digest, 1, 7) = 'sha256:')),
    accepted_release_source_revision INTEGER CHECK (accepted_release_source_revision IS NULL OR accepted_release_source_revision >= 1),
    accepted_release_reason TEXT CHECK (accepted_release_reason IS NULL OR accepted_release_reason IN ('tool_failed','expired','context_unavailable','authorization_changed','source_cancelled','capacity_timeout')),
    accepted_release_evidence_digest TEXT CHECK (accepted_release_evidence_digest IS NULL OR (length(accepted_release_evidence_digest) = 71 AND substr(accepted_release_evidence_digest, 1, 7) = 'sha256:')),
    accepted_released_at_ms INTEGER CHECK (accepted_released_at_ms IS NULL OR accepted_released_at_ms >= 0),
    current_turn_release_source_revision INTEGER CHECK (current_turn_release_source_revision IS NULL OR current_turn_release_source_revision >= 1),
    current_turn_release_target_revision INTEGER CHECK (current_turn_release_target_revision IS NULL OR current_turn_release_target_revision >= 1),
    current_turn_release_route_digest TEXT CHECK (current_turn_release_route_digest IS NULL OR (length(current_turn_release_route_digest) = 71 AND substr(current_turn_release_route_digest, 1, 7) = 'sha256:')),
    current_turn_released_at_ms INTEGER CHECK (current_turn_released_at_ms IS NULL OR current_turn_released_at_ms >= 0),
    body_id TEXT NOT NULL,`,
  )
  .replace(
    '    UNIQUE (source_session_id,source_sequence),',
    '    UNIQUE (source_session_id,source_sequence),\n    UNIQUE (source_session_id,submission_id),',
  )
  .replace(
    '    CHECK ((source_grant_id IS NULL) = (source_grant_digest IS NULL))',
    `    CHECK ((source_grant_id IS NULL) = (source_grant_digest IS NULL)),
    CHECK ((mode = 'trigger_turn') = (submission_id IS NOT NULL AND followup_admission_artifact_id IS NOT NULL AND followup_admission_digest IS NOT NULL)),
    CHECK ((accepted_release_source_revision IS NULL) = (accepted_release_evidence_digest IS NULL)),
    CHECK ((accepted_release_source_revision IS NULL) = (accepted_release_reason IS NULL)),
    CHECK ((accepted_release_source_revision IS NULL) = (accepted_released_at_ms IS NULL)),
    CHECK ((current_turn_release_source_revision IS NULL) = (current_turn_release_target_revision IS NULL)),
    CHECK ((current_turn_release_source_revision IS NULL) = (current_turn_release_route_digest IS NULL)),
    CHECK ((current_turn_release_source_revision IS NULL) = (current_turn_released_at_ms IS NULL)),
    CHECK (accepted_release_source_revision IS NULL OR current_turn_release_source_revision IS NULL),
    CHECK (accepted_release_source_revision IS NULL OR mode = 'trigger_turn'),
    CHECK (current_turn_release_source_revision IS NULL OR mode = 'trigger_turn')`,
  );

/** Target-owned receipt survives Run completion and has one route per submission. */
export const KITE_CROSS_SESSION_FOLLOWUP_ROUTE_DDL = `CREATE TABLE agent_followup_routes (
    target_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    source_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    message_id TEXT NOT NULL,
    submission_id TEXT NOT NULL,
    route TEXT NOT NULL CHECK (route IN ('current_turn','new_turn')),
    target_run_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    invocation_id TEXT NOT NULL,
    model_admission_id TEXT NOT NULL,
    reservation_id TEXT NOT NULL,
    routed_revision INTEGER NOT NULL CHECK (routed_revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    PRIMARY KEY (target_session_id,submission_id),
    UNIQUE (target_session_id,message_id),
    FOREIGN KEY (target_session_id,message_id) REFERENCES agent_mail_inbox(target_session_id,message_id),
    FOREIGN KEY (source_session_id,message_id) REFERENCES agent_mail_outbox(source_session_id,message_id)
  ) STRICT`;

export const KITE_CROSS_SESSION_FOLLOWUP_GRANT_DDL = `CREATE TABLE agent_followup_grant_artifacts (
    artifact_id TEXT PRIMARY KEY NOT NULL CHECK (length(artifact_id)=67 AND substr(artifact_id,1,3)='pa_'),
    integrity_identifier TEXT NOT NULL UNIQUE CHECK (length(integrity_identifier)=71 AND substr(integrity_identifier,1,7)='sha256:'),
    artifact_format_version INTEGER NOT NULL CHECK (artifact_format_version=1),
    canonical_json TEXT NOT NULL CHECK (json_valid(canonical_json)),
    byte_length INTEGER NOT NULL CHECK (byte_length BETWEEN 1 AND 16777216),
    created_at INTEGER NOT NULL CHECK (created_at>=0)
  ) STRICT`;

export const KITE_CROSS_SESSION_FOLLOWUP_GRANT_COLUMNS = Object.freeze([
  'artifact_id',
  'integrity_identifier',
  'artifact_format_version',
  'canonical_json',
  'byte_length',
  'created_at',
] as const);

/** Source-owned ACK: a bounded replacement is durable before target dispatch. */
export const KITE_CROSS_SESSION_FOLLOWUP_FUNDING_DDL = `CREATE TABLE agent_followup_funding_receipts (
    source_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    submission_id TEXT NOT NULL,
    target_session_id TEXT NOT NULL REFERENCES runtime_sessions(session_id),
    message_id TEXT NOT NULL,
    funding_run_id TEXT NOT NULL,
    backup_reservation_id TEXT NOT NULL,
    turn_reservation_id TEXT NOT NULL,
    model_reservation_id TEXT NOT NULL,
    target_model_reservation_id TEXT NOT NULL,
    target_budget_digest TEXT NOT NULL,
    target_run_id TEXT NOT NULL,
    model_invocation_id TEXT NOT NULL,
    surface_artifact_id TEXT NOT NULL,
    surface_digest TEXT NOT NULL,
    surface_input_tokens INTEGER NOT NULL CHECK (surface_input_tokens >= 0),
    surface_max_output_tokens INTEGER NOT NULL CHECK (surface_max_output_tokens > 0),
    target_revision INTEGER NOT NULL CHECK (target_revision >= 1),
    source_revision INTEGER NOT NULL CHECK (source_revision >= 1),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    activated_source_revision INTEGER CHECK (activated_source_revision IS NULL OR activated_source_revision >= source_revision),
    activated_at_ms INTEGER CHECK (activated_at_ms IS NULL OR activated_at_ms >= created_at_ms),
    terminal_disposition TEXT CHECK (terminal_disposition IS NULL OR terminal_disposition IN ('completed','unknown','pre_dispatch_released')),
    terminal_target_revision INTEGER CHECK (terminal_target_revision IS NULL OR terminal_target_revision >= target_revision),
    terminal_source_revision INTEGER CHECK (terminal_source_revision IS NULL OR terminal_source_revision >= source_revision),
    terminal_evidence_digest TEXT CHECK (terminal_evidence_digest IS NULL OR (length(terminal_evidence_digest)=71 AND substr(terminal_evidence_digest,1,7)='sha256:')),
    terminal_at_ms INTEGER CHECK (terminal_at_ms IS NULL OR terminal_at_ms >= created_at_ms),
    PRIMARY KEY (source_session_id,submission_id),
    UNIQUE (target_session_id,model_invocation_id),
    FOREIGN KEY (source_session_id,message_id) REFERENCES agent_mail_outbox(source_session_id,message_id),
    CHECK ((activated_source_revision IS NULL) = (activated_at_ms IS NULL)),
    CHECK ((terminal_disposition IS NULL) = (terminal_target_revision IS NULL)),
    CHECK ((terminal_disposition IS NULL) = (terminal_source_revision IS NULL)),
    CHECK ((terminal_disposition IS NULL) = (terminal_evidence_digest IS NULL)),
    CHECK ((terminal_disposition IS NULL) = (terminal_at_ms IS NULL))
  ) STRICT`;

export const KITE_CROSS_SESSION_FOLLOWUP_OUTBOX_COLUMNS = Object.freeze([
  'source_session_id',
  'message_id',
  'target_session_id',
  'target_run_id',
  'command_id',
  'request_digest',
  'source_run_id',
  'source_turn_id',
  'source_model_invocation_id',
  'source_tool_call_id',
  'source_effect_attempt_id',
  'source_task_id',
  'source_grant_id',
  'source_grant_digest',
  'mode',
  'submission_id',
  'followup_admission_artifact_id',
  'followup_admission_digest',
  'accepted_release_source_revision',
  'accepted_release_reason',
  'accepted_release_evidence_digest',
  'accepted_released_at_ms',
  'current_turn_release_source_revision',
  'current_turn_release_target_revision',
  'current_turn_release_route_digest',
  'current_turn_released_at_ms',
  'body_id',
  'source_sequence',
  'source_revision',
  'accepted_at_ms',
  'delivered_target_revision',
] as const);

export const KITE_CROSS_SESSION_FOLLOWUP_ROUTE_COLUMNS = Object.freeze([
  'target_session_id',
  'source_session_id',
  'message_id',
  'submission_id',
  'route',
  'target_run_id',
  'task_id',
  'invocation_id',
  'model_admission_id',
  'reservation_id',
  'routed_revision',
  'created_at_ms',
] as const);

export const KITE_CROSS_SESSION_FOLLOWUP_FUNDING_COLUMNS = Object.freeze([
  'source_session_id',
  'submission_id',
  'target_session_id',
  'message_id',
  'funding_run_id',
  'backup_reservation_id',
  'turn_reservation_id',
  'model_reservation_id',
  'target_model_reservation_id',
  'target_budget_digest',
  'target_run_id',
  'model_invocation_id',
  'surface_artifact_id',
  'surface_digest',
  'surface_input_tokens',
  'surface_max_output_tokens',
  'target_revision',
  'source_revision',
  'created_at_ms',
  'activated_source_revision',
  'activated_at_ms',
  'terminal_disposition',
  'terminal_target_revision',
  'terminal_source_revision',
  'terminal_evidence_digest',
  'terminal_at_ms',
] as const);
