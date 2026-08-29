// Generated from @kite-ai/agent-api-contract schemas. Do not edit.

export type AgentApiVersion = "v1";

export type AgentApiCancelRunRequest = {
  readonly "schema": "kite.agent-api.cancel-run.v1";
};

export type AgentApiCheckpoint = {
  readonly "checkpoint_id": string;
  readonly "created_at"?: string;
  readonly "label"?: string;
  readonly "revision": number;
  readonly "schema": "kite.agent-api.checkpoint.v1";
  readonly "scope": "conversation_only" | "conversation_and_workspace" | "code_only";
  readonly "session_id": string;
};

export type AgentApiCheckpointPage = {
  readonly "items": readonly ({
    readonly "checkpoint_id": string;
    readonly "created_at"?: string;
    readonly "label"?: string;
    readonly "revision": number;
    readonly "schema": "kite.agent-api.checkpoint.v1";
    readonly "scope": "conversation_only" | "conversation_and_workspace" | "code_only";
    readonly "session_id": string;
  })[];
  readonly "next_cursor"?: string;
  readonly "schema": "kite.agent-api.checkpoint-page.v1";
  readonly "session_id": string;
};

export type AgentApiCheckpointPreview = {
  readonly "checkpoint": {
    readonly "checkpoint_id": string;
    readonly "created_at"?: string;
    readonly "label"?: string;
    readonly "revision": number;
    readonly "schema": "kite.agent-api.checkpoint.v1";
    readonly "scope": "conversation_only" | "conversation_and_workspace" | "code_only";
    readonly "session_id": string;
  };
  readonly "conflict_summaries": readonly (string)[];
  readonly "current_revision": number;
  readonly "files": {
    readonly "additions": number;
    readonly "changed": number;
    readonly "conflicted": number;
    readonly "deletions": number;
  };
  readonly "schema": "kite.agent-api.checkpoint-preview.v1";
};

export type AgentApiCloseSessionRequest = {
  readonly "schema": "kite.agent-api.close-session.v1";
};

export type AgentApiContext = {
  readonly "access_token": string;
  readonly "api_version": "v1";
  readonly "capabilities": readonly ("checkpoints" | "history" | "interactions" | "runs" | "session_stream" | "sessions")[];
  readonly "expires_at": string;
  readonly "role": "observer" | "controller";
  readonly "schema": "kite.agent-api.context.v1";
  readonly "token_type": "Bearer";
};

export type AgentApiCreateRunRequest = {
  readonly "initial_skills"?: readonly ({
    readonly "input": Readonly<Record<string, unknown>>;
    readonly "skill_id": string;
  })[];
  readonly "input": string;
  readonly "phase": "planning" | "building";
  readonly "schema": "kite.agent-api.create-run.v1";
};

export type AgentApiCreateSessionRequest = {
  readonly "display_name"?: string;
  readonly "schema": "kite.agent-api.create-session.v1";
};

export type AgentApiDeletedSession = {
  readonly "deleted_revision": number;
  readonly "schema": "kite.agent-api.deleted-session.v1";
  readonly "session_id": string;
};

export type AgentApiEvent = {
  readonly "channel": "interactions" | "lifecycle" | "messages" | "session" | "tools";
  readonly "durability": "durable" | "ephemeral";
  readonly "event": {
    readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
    readonly "type": "run.status";
  } | {
    readonly "message_id": string;
    readonly "role": "user" | "assistant";
    readonly "text": string;
    readonly "type": "message.appended";
  } | {
    readonly "request_id": string;
    readonly "text": string;
    readonly "type": "reasoning.appended";
  } | {
    readonly "label": string;
    readonly "status": "queued" | "running" | "completed" | "failed" | "cancelled";
    readonly "summary"?: string;
    readonly "tool_call_id": string;
    readonly "type": "tool.updated";
  } | {
    readonly "queue": {
      readonly "active_interaction_id"?: string;
      readonly "interactions": readonly ({
        readonly "command"?: string;
        readonly "generation": number;
        readonly "grants": readonly ("approve_once" | "same_command")[];
        readonly "interaction_id": string;
        readonly "kind": "approval";
        readonly "schema": "kite.agent-api.interaction.v1";
        readonly "session_revision": number;
        readonly "summary"?: string;
        readonly "title"?: string;
      } | {
        readonly "allow_free_text": boolean;
        readonly "interaction_id": string;
        readonly "kind": "input";
        readonly "options"?: readonly ({
          readonly "description"?: string;
          readonly "label": string;
          readonly "option_id": string;
        })[];
        readonly "question": string;
        readonly "schema": "kite.agent-api.interaction.v1";
        readonly "session_revision": number;
        readonly "summary"?: string;
        readonly "title"?: string;
      } | {
        readonly "interaction_id": string;
        readonly "kind": "plan_review";
        readonly "plan": {
          readonly "plan_id": string;
          readonly "structural_digest": string;
          readonly "version": number;
        };
        readonly "schema": "kite.agent-api.interaction.v1";
        readonly "session_revision": number;
        readonly "summary"?: string;
        readonly "title"?: string;
      } | {
        readonly "action": "login" | "approve" | "retry";
        readonly "interaction_id": string;
        readonly "kind": "provider_action";
        readonly "provider": {
          readonly "directory_revision"?: string;
          readonly "provider_id": string;
        };
        readonly "schema": "kite.agent-api.interaction.v1";
        readonly "session_revision": number;
        readonly "summary"?: string;
        readonly "title"?: string;
      } | {
        readonly "interaction_id": string;
        readonly "kind": "verification";
        readonly "schema": "kite.agent-api.interaction.v1";
        readonly "session_revision": number;
        readonly "summary"?: string;
        readonly "title"?: string;
        readonly "verification": {
          readonly "revision": string;
          readonly "verification_id": string;
        };
      })[];
      readonly "revision": number;
      readonly "schema": "kite.agent-api.interaction-queue.v1";
      readonly "session_id": string;
    };
    readonly "type": "interactions.replaced";
  } | {
    readonly "session": {
      readonly "active_interaction"?: {
        readonly "interaction_id": string;
        readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
        readonly "session_revision": number;
      };
      readonly "active_run_id"?: string;
      readonly "created_at"?: string;
      readonly "display_name"?: string;
      readonly "lifecycle": "open" | "closed" | "unavailable";
      readonly "model"?: {
        readonly "name": string;
        readonly "provider": string;
        readonly "reasoning_enabled"?: boolean;
      };
      readonly "revision": number;
      readonly "schema": "kite.agent-api.session.v1";
      readonly "session_id": string;
      readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
      readonly "updated_at"?: string;
    };
    readonly "type": "session.replaced";
  };
  readonly "run_id"?: string;
  readonly "schema": "kite.agent-api.event.v1";
  readonly "session_id": string;
  readonly "session_revision": number;
};

export type AgentApiExchangeRequest = {
  readonly "api_version": "v1";
  readonly "required_capabilities": readonly ("checkpoints" | "history" | "interactions" | "runs" | "session_stream" | "sessions")[];
  readonly "schema": "kite.agent-api.exchange.v1";
};

export type AgentApiForkSessionRequest = {
  readonly "checkpoint_id": string;
  readonly "display_name"?: string;
  readonly "schema": "kite.agent-api.fork-session.v1";
};

export type AgentApiHistoryItem = {
  readonly "content": {
    readonly "message_id": string;
    readonly "text": string;
    readonly "type": "user.message";
  } | {
    readonly "message_id": string;
    readonly "text": string;
    readonly "type": "model.message";
  } | {
    readonly "request_id": string;
    readonly "text": string;
    readonly "type": "model.reasoning";
  } | {
    readonly "label": string;
    readonly "status": "queued" | "running" | "completed" | "failed" | "cancelled";
    readonly "summary"?: string;
    readonly "tool_call_id": string;
    readonly "type": "tool.lifecycle";
  } | {
    readonly "reason_code"?: string;
    readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
    readonly "type": "run.status";
  };
  readonly "occurred_at": string;
  readonly "public_ordinal": number;
  readonly "run_id"?: string;
  readonly "schema": "kite.agent-api.history-item.v1";
  readonly "sequence": number;
  readonly "session_id": string;
};

export type AgentApiHistoryPage = {
  readonly "items": readonly ({
    readonly "content": {
      readonly "message_id": string;
      readonly "text": string;
      readonly "type": "user.message";
    } | {
      readonly "message_id": string;
      readonly "text": string;
      readonly "type": "model.message";
    } | {
      readonly "request_id": string;
      readonly "text": string;
      readonly "type": "model.reasoning";
    } | {
      readonly "label": string;
      readonly "status": "queued" | "running" | "completed" | "failed" | "cancelled";
      readonly "summary"?: string;
      readonly "tool_call_id": string;
      readonly "type": "tool.lifecycle";
    } | {
      readonly "reason_code"?: string;
      readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
      readonly "type": "run.status";
    };
    readonly "occurred_at": string;
    readonly "public_ordinal": number;
    readonly "run_id"?: string;
    readonly "schema": "kite.agent-api.history-item.v1";
    readonly "sequence": number;
    readonly "session_id": string;
  })[];
  readonly "next_cursor"?: string;
  readonly "schema": "kite.agent-api.history-page.v1";
  readonly "session_id": string;
  readonly "through_sequence": number;
};

export type AgentApiInteraction = {
  readonly "command"?: string;
  readonly "generation": number;
  readonly "grants": readonly ("approve_once" | "same_command")[];
  readonly "interaction_id": string;
  readonly "kind": "approval";
  readonly "schema": "kite.agent-api.interaction.v1";
  readonly "session_revision": number;
  readonly "summary"?: string;
  readonly "title"?: string;
} | {
  readonly "allow_free_text": boolean;
  readonly "interaction_id": string;
  readonly "kind": "input";
  readonly "options"?: readonly ({
    readonly "description"?: string;
    readonly "label": string;
    readonly "option_id": string;
  })[];
  readonly "question": string;
  readonly "schema": "kite.agent-api.interaction.v1";
  readonly "session_revision": number;
  readonly "summary"?: string;
  readonly "title"?: string;
} | {
  readonly "interaction_id": string;
  readonly "kind": "plan_review";
  readonly "plan": {
    readonly "plan_id": string;
    readonly "structural_digest": string;
    readonly "version": number;
  };
  readonly "schema": "kite.agent-api.interaction.v1";
  readonly "session_revision": number;
  readonly "summary"?: string;
  readonly "title"?: string;
} | {
  readonly "action": "login" | "approve" | "retry";
  readonly "interaction_id": string;
  readonly "kind": "provider_action";
  readonly "provider": {
    readonly "directory_revision"?: string;
    readonly "provider_id": string;
  };
  readonly "schema": "kite.agent-api.interaction.v1";
  readonly "session_revision": number;
  readonly "summary"?: string;
  readonly "title"?: string;
} | {
  readonly "interaction_id": string;
  readonly "kind": "verification";
  readonly "schema": "kite.agent-api.interaction.v1";
  readonly "session_revision": number;
  readonly "summary"?: string;
  readonly "title"?: string;
  readonly "verification": {
    readonly "revision": string;
    readonly "verification_id": string;
  };
};

export type AgentApiInteractionQueue = {
  readonly "active_interaction_id"?: string;
  readonly "interactions": readonly ({
    readonly "command"?: string;
    readonly "generation": number;
    readonly "grants": readonly ("approve_once" | "same_command")[];
    readonly "interaction_id": string;
    readonly "kind": "approval";
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  } | {
    readonly "allow_free_text": boolean;
    readonly "interaction_id": string;
    readonly "kind": "input";
    readonly "options"?: readonly ({
      readonly "description"?: string;
      readonly "label": string;
      readonly "option_id": string;
    })[];
    readonly "question": string;
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  } | {
    readonly "interaction_id": string;
    readonly "kind": "plan_review";
    readonly "plan": {
      readonly "plan_id": string;
      readonly "structural_digest": string;
      readonly "version": number;
    };
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  } | {
    readonly "action": "login" | "approve" | "retry";
    readonly "interaction_id": string;
    readonly "kind": "provider_action";
    readonly "provider": {
      readonly "directory_revision"?: string;
      readonly "provider_id": string;
    };
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  } | {
    readonly "interaction_id": string;
    readonly "kind": "verification";
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
    readonly "verification": {
      readonly "revision": string;
      readonly "verification_id": string;
    };
  })[];
  readonly "revision": number;
  readonly "schema": "kite.agent-api.interaction-queue.v1";
  readonly "session_id": string;
};

export type AgentApiInteractionResponseRequest = {
  readonly "interaction": {
    readonly "command"?: string;
    readonly "generation": number;
    readonly "grants": readonly ("approve_once" | "same_command")[];
    readonly "interaction_id": string;
    readonly "kind": "approval";
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  };
  readonly "response": {
    readonly "decision": "approve_once" | "same_command" | "reject";
    readonly "kind": "approval";
  };
  readonly "schema": "kite.agent-api.interaction-response.v1";
} | {
  readonly "interaction": {
    readonly "allow_free_text": boolean;
    readonly "interaction_id": string;
    readonly "kind": "input";
    readonly "options"?: readonly ({
      readonly "description"?: string;
      readonly "label": string;
      readonly "option_id": string;
    })[];
    readonly "question": string;
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  };
  readonly "response": {
    readonly "kind": "text";
    readonly "value": string;
  } | {
    readonly "kind": "input_cancel";
  };
  readonly "schema": "kite.agent-api.interaction-response.v1";
} | {
  readonly "interaction": {
    readonly "interaction_id": string;
    readonly "kind": "plan_review";
    readonly "plan": {
      readonly "plan_id": string;
      readonly "structural_digest": string;
      readonly "version": number;
    };
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  };
  readonly "response": {
    readonly "decision": "auto" | "accept_edits" | "feedback" | "cancel";
    readonly "feedback"?: string;
    readonly "kind": "plan_review";
  };
  readonly "schema": "kite.agent-api.interaction-response.v1";
} | {
  readonly "interaction": {
    readonly "action": "login" | "approve" | "retry";
    readonly "interaction_id": string;
    readonly "kind": "provider_action";
    readonly "provider": {
      readonly "directory_revision"?: string;
      readonly "provider_id": string;
    };
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
  };
  readonly "response": {
    readonly "detail"?: string;
    readonly "kind": "provider_action";
    readonly "outcome": "completed" | "deferred" | "cancelled";
  };
  readonly "schema": "kite.agent-api.interaction-response.v1";
} | {
  readonly "interaction": {
    readonly "interaction_id": string;
    readonly "kind": "verification";
    readonly "schema": "kite.agent-api.interaction.v1";
    readonly "session_revision": number;
    readonly "summary"?: string;
    readonly "title"?: string;
    readonly "verification": {
      readonly "revision": string;
      readonly "verification_id": string;
    };
  };
  readonly "response": {
    readonly "decision": "replan" | "waive" | "compensate";
    readonly "detail": string;
    readonly "kind": "verification";
  };
  readonly "schema": "kite.agent-api.interaction-response.v1";
};

export type AgentApiMutationHeaders = {
  readonly "idempotency_key": string;
  readonly "if_match"?: string;
};

export type AgentApiMutationResult = {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "create_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "resume_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "close_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "rewind_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "delete_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "deleted_revision": number;
    readonly "schema": "kite.agent-api.deleted-session.v1";
    readonly "session_id": string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "create_run";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "created_at": string;
    readonly "finished_at"?: string;
    readonly "phase": "planning" | "building";
    readonly "run_id": string;
    readonly "schema": "kite.agent-api.run.v1";
    readonly "session_id": string;
    readonly "started_at"?: string;
    readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
    readonly "terminal"?: {
      readonly "reason_code": string;
      readonly "recovery_entry": "none" | "retry" | "reconcile" | "new_run" | "operator_action";
      readonly "safe_retry": boolean;
    };
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "cancel_run";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "created_at": string;
    readonly "finished_at"?: string;
    readonly "phase": "planning" | "building";
    readonly "run_id": string;
    readonly "schema": "kite.agent-api.run.v1";
    readonly "session_id": string;
    readonly "started_at"?: string;
    readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
    readonly "terminal"?: {
      readonly "reason_code": string;
      readonly "recovery_entry": "none" | "retry" | "reconcile" | "new_run" | "operator_action";
      readonly "safe_retry": boolean;
    };
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "respond_interaction";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction_id"?: string;
    readonly "interactions": readonly ({
      readonly "command"?: string;
      readonly "generation": number;
      readonly "grants": readonly ("approve_once" | "same_command")[];
      readonly "interaction_id": string;
      readonly "kind": "approval";
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "allow_free_text": boolean;
      readonly "interaction_id": string;
      readonly "kind": "input";
      readonly "options"?: readonly ({
        readonly "description"?: string;
        readonly "label": string;
        readonly "option_id": string;
      })[];
      readonly "question": string;
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "interaction_id": string;
      readonly "kind": "plan_review";
      readonly "plan": {
        readonly "plan_id": string;
        readonly "structural_digest": string;
        readonly "version": number;
      };
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "action": "login" | "approve" | "retry";
      readonly "interaction_id": string;
      readonly "kind": "provider_action";
      readonly "provider": {
        readonly "directory_revision"?: string;
        readonly "provider_id": string;
      };
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "interaction_id": string;
      readonly "kind": "verification";
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
      readonly "verification": {
        readonly "revision": string;
        readonly "verification_id": string;
      };
    })[];
    readonly "revision": number;
    readonly "schema": "kite.agent-api.interaction-queue.v1";
    readonly "session_id": string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
} | {
  readonly "applied_revision": number;
  readonly "mutation_id": string;
  readonly "operation": "fork_session";
  readonly "replayed": boolean;
  readonly "resource": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "schema": "kite.agent-api.mutation-result.v1";
  readonly "stream_consistency": "refetch_required";
};

export type AgentApiPageQuery = {
  readonly "cursor"?: string;
  readonly "limit": number;
};

export type AgentApiProblem = {
  readonly "code": "checkpoint_unavailable" | "controller_conflict" | "cursor_invalidated" | "forbidden" | "idempotency_conflict" | "incompatible" | "interaction_mismatch" | "invalid_cursor" | "invalid_request" | "method_not_allowed" | "not_acceptable" | "not_found" | "outcome_unknown" | "overloaded" | "payload_too_large" | "precondition_required" | "revision_conflict" | "run_not_active" | "session_busy" | "temporarily_unavailable" | "unauthorized" | "unsupported_media_type";
  readonly "current_revision"?: number;
  readonly "detail"?: string;
  readonly "field"?: string;
  readonly "limit_bytes"?: number;
  readonly "missing_capabilities"?: readonly ("checkpoints" | "history" | "interactions" | "runs" | "session_stream" | "sessions")[];
  readonly "recovery_entry"?: "none" | "retry" | "reconcile" | "new_run" | "operator_action";
  readonly "request_id": string;
  readonly "required_header"?: "If-Match";
  readonly "retryable": boolean;
  readonly "schema": "kite.agent-api.problem.v1";
  readonly "status": number;
  readonly "supported_api_versions"?: readonly ("v1")[];
  readonly "title": string;
  readonly "type": string;
};

export type AgentApiResumeSessionRequest = {
  readonly "after_revision": number;
  readonly "schema": "kite.agent-api.resume-session.v1";
};

export type AgentApiResync = {
  readonly "history_through_sequence": number;
  readonly "interactions": {
    readonly "active_interaction_id"?: string;
    readonly "interactions": readonly ({
      readonly "command"?: string;
      readonly "generation": number;
      readonly "grants": readonly ("approve_once" | "same_command")[];
      readonly "interaction_id": string;
      readonly "kind": "approval";
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "allow_free_text": boolean;
      readonly "interaction_id": string;
      readonly "kind": "input";
      readonly "options"?: readonly ({
        readonly "description"?: string;
        readonly "label": string;
        readonly "option_id": string;
      })[];
      readonly "question": string;
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "interaction_id": string;
      readonly "kind": "plan_review";
      readonly "plan": {
        readonly "plan_id": string;
        readonly "structural_digest": string;
        readonly "version": number;
      };
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "action": "login" | "approve" | "retry";
      readonly "interaction_id": string;
      readonly "kind": "provider_action";
      readonly "provider": {
        readonly "directory_revision"?: string;
        readonly "provider_id": string;
      };
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
    } | {
      readonly "interaction_id": string;
      readonly "kind": "verification";
      readonly "schema": "kite.agent-api.interaction.v1";
      readonly "session_revision": number;
      readonly "summary"?: string;
      readonly "title"?: string;
      readonly "verification": {
        readonly "revision": string;
        readonly "verification_id": string;
      };
    })[];
    readonly "revision": number;
    readonly "schema": "kite.agent-api.interaction-queue.v1";
    readonly "session_id": string;
  };
  readonly "reason": "initial" | "cursor_invalid" | "cursor_too_old" | "generation_changed" | "filter_changed" | "ephemeral_cursor" | "buffer_gap" | "codec_changed";
  readonly "resume_after_event_id": string;
  readonly "schema": "kite.agent-api.resync.v1";
  readonly "session": {
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  };
  readonly "snapshot_revision": number;
  readonly "stream_generation": string;
};

export type AgentApiRewindSessionRequest = {
  readonly "checkpoint_id": string;
  readonly "schema": "kite.agent-api.rewind-session.v1";
};

export type AgentApiRun = {
  readonly "created_at": string;
  readonly "finished_at"?: string;
  readonly "phase": "planning" | "building";
  readonly "run_id": string;
  readonly "schema": "kite.agent-api.run.v1";
  readonly "session_id": string;
  readonly "started_at"?: string;
  readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
  readonly "terminal"?: {
    readonly "reason_code": string;
    readonly "recovery_entry": "none" | "retry" | "reconcile" | "new_run" | "operator_action";
    readonly "safe_retry": boolean;
  };
};

export type AgentApiRunListQuery = {
  readonly "cursor"?: string;
  readonly "limit": number;
  readonly "phase"?: "planning" | "building";
  readonly "status"?: "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
};

export type AgentApiRunPage = {
  readonly "items": readonly ({
    readonly "created_at": string;
    readonly "finished_at"?: string;
    readonly "phase": "planning" | "building";
    readonly "run_id": string;
    readonly "schema": "kite.agent-api.run.v1";
    readonly "session_id": string;
    readonly "started_at"?: string;
    readonly "status": "queued" | "running" | "waiting" | "completed" | "failed" | "cancelled" | "unknown";
    readonly "terminal"?: {
      readonly "reason_code": string;
      readonly "recovery_entry": "none" | "retry" | "reconcile" | "new_run" | "operator_action";
      readonly "safe_retry": boolean;
    };
  })[];
  readonly "next_cursor"?: string;
  readonly "schema": "kite.agent-api.run-page.v1";
  readonly "session_id": string;
};

export type AgentApiServerInfo = {
  readonly "api_version": "v1";
  readonly "build_id": string;
  readonly "capabilities": readonly ("checkpoints" | "history" | "interactions" | "runs" | "session_stream" | "sessions")[];
  readonly "schema": "kite.agent-api.server-info.v1";
  readonly "server_version": string;
};

export type AgentApiSession = {
  readonly "active_interaction"?: {
    readonly "interaction_id": string;
    readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
    readonly "session_revision": number;
  };
  readonly "active_run_id"?: string;
  readonly "created_at"?: string;
  readonly "display_name"?: string;
  readonly "lifecycle": "open" | "closed" | "unavailable";
  readonly "model"?: {
    readonly "name": string;
    readonly "provider": string;
    readonly "reasoning_enabled"?: boolean;
  };
  readonly "revision": number;
  readonly "schema": "kite.agent-api.session.v1";
  readonly "session_id": string;
  readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
  readonly "updated_at"?: string;
};

export type AgentApiSessionListQuery = {
  readonly "cursor"?: string;
  readonly "lifecycle"?: "open" | "closed" | "unavailable";
  readonly "limit": number;
  readonly "status"?: "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
};

export type AgentApiSessionPage = {
  readonly "items": readonly ({
    readonly "active_interaction"?: {
      readonly "interaction_id": string;
      readonly "kind": "approval" | "input" | "plan_review" | "provider_action" | "verification";
      readonly "session_revision": number;
    };
    readonly "active_run_id"?: string;
    readonly "created_at"?: string;
    readonly "display_name"?: string;
    readonly "lifecycle": "open" | "closed" | "unavailable";
    readonly "model"?: {
      readonly "name": string;
      readonly "provider": string;
      readonly "reasoning_enabled"?: boolean;
    };
    readonly "revision": number;
    readonly "schema": "kite.agent-api.session.v1";
    readonly "session_id": string;
    readonly "status": "idle" | "queued" | "running" | "waiting" | "error" | "unavailable";
    readonly "updated_at"?: string;
  })[];
  readonly "next_cursor"?: string;
  readonly "schema": "kite.agent-api.session-page.v1";
};

export type AgentApiStreamQuery = {
  readonly "channels": readonly ("interactions" | "lifecycle" | "messages" | "session" | "tools")[];
};

export type AgentApiWaitQuery = {
  readonly "timeout_ms": number;
};
