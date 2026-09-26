/** Structured model-facing facts owned by each Builtin capability definition. */
export interface ToolContractSection {
  /** Selection summary shown first; it must not carry the only copy of a recovery rule. */
  summary: string;
  /** Positive and negative selection boundary. */
  useWhen: string;
  /** Actual model-visible result projection. */
  returns: {
    format: 'text' | 'json' | 'interrupt';
    description: string;
    fields?: readonly string[];
  };
  /** Model argument and phase constraints. */
  constraints: string;
  /** Typed recovery boundary; the Runner derives failure guidance from this field. */
  recovery: string;
}

export interface ToolContract {
  name: string;
  description: string;
  sections: ToolContractSection;
}

export type ToolDescriptionStyle = 'standard' | 'catalog';

export function toolContractSection(sections: ToolContractSection): ToolContractSection {
  return sections;
}

export function buildDescription(
  sections: ToolContractSection,
  style: ToolDescriptionStyle = 'standard',
): string {
  const contract = toolContractSection(sections);
  if (style === 'catalog') {
    return [
      contract.summary,
      contract.useWhen !== contract.summary ? `Use when: ${contract.useWhen}` : '',
      `Returns ${contract.returns.format}: ${contract.returns.description}`,
      `Constraint: ${contract.constraints}`,
      `On failure: ${contract.recovery}`,
    ]
      .filter(Boolean)
      .join('\n');
  }
  return [
    contract.summary,
    `\nUse when: ${contract.useWhen}`,
    `\nOutput: ${contract.returns.description}`,
    `\nConstraints: ${contract.constraints}`,
    `\nFailure: ${contract.recovery}`,
  ].join('');
}

export const KNOWN_TOOL_NAMES = [
  'read_file',
  'read_plan',
  'edit_file',
  'write_file',
  'shell_execute',
  'shell_read',
  'shell_stop',
  'search_content',
  'search_files',
  'tool_search',
  'activate_skill',
  'complete_skill',
  'read_skill_reference',
  'list_mcp_resources',
  'list_mcp_tools',
  'read_mcp_resource',
  'write_plan',
  'update_plan',
  'ask_user',
  'task',
  'task_read',
  'task_wait',
  'task_cancel',
  'list_agents',
  'wait_agent',
  'send_message',
  'followup_task',
  'interrupt_agent',
  'web_fetch',
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

/** Canonical builtin contract facts. No Runner or prompt layer owns a second guidance table. */
export const BUILTIN_TOOL_CONTRACTS: Readonly<Record<KnownToolName, ToolContractSection>> = {
  read_file: {
    summary: 'Read a text file with line numbers.',
    useWhen:
      'Inspect known file content or verify a change. Use search_files when the path is unknown and search_content when the content location is unknown.',
    returns: {
      format: 'text',
      description:
        'Line-numbered file content with explicit truncation and continuation markers; the complete model-visible result is capped at 64 KiB.',
    },
    constraints:
      'Workspace-relative, absolute, and home-relative paths are readable without path approval; offset and limit must be positive, omitted limit defaults to 2000 lines, and binary files are not returned as text.',
    recovery:
      'For ENOENT, locate the file with search_files and retry once with the exact path. For an invalid range, correct offset or limit. Permission or binary failures require user action or an alternative capability, not blind replay.',
  },
  read_plan: {
    summary: 'Read the current saved Plan Artifact by identity.',
    useWhen:
      'Revise or verify the exact persisted plan. Use plan_id and version rather than a filesystem path.',
    returns: {
      format: 'json',
      description:
        'Task/plan identity, structural digest, title, body, steps and metadata-only completion evidence.',
      fields: [
        'ok',
        'status',
        'task_id',
        'plan_id',
        'version',
        'plan_schema_version',
        'structural_digest',
        'title',
        'body_markdown',
        'steps',
        'completion_evidence',
        'artifact',
      ],
    },
    constraints: 'The artifact must belong to the active task and its digest must validate.',
    recovery:
      'If identity, version or digest is missing/stale, do not reconstruct the artifact from memory; read the active identity or save a governed new revision.',
  },
  edit_file: {
    summary: 'Replace exact existing text in one file.',
    useWhen:
      'Apply a targeted building-phase edit after reading the current file. Use write_file for creation or full rewrites.',
    returns: { format: 'text', description: 'The applied unified diff or a precise rejection.' },
    constraints:
      'old_string must exactly match fresh verified content. Do not issue multiple same-file edits from one stale read; use replace_all only for intentional duplicate replacement.',
    recovery:
      'If content is missing, duplicated or stale, re-read then submit one corrected invocation. If rejected in planning, record the edit in the plan and wait for approval; do not retry or request edit approval in planning.',
  },
  write_file: {
    summary: 'Create a file or completely replace its content.',
    useWhen:
      'Use only in building for creation or a deliberate full rewrite; use edit_file for a small targeted change.',
    returns: {
      format: 'text',
      description: 'The created/replaced file diff or a bounded failure result.',
    },
    constraints:
      'Trusted-workspace paths are directly writable. Workspace-external paths require an exact mutation approval before dispatch. Read an existing file first because omitted content is lost.',
    recovery:
      'Correct an invalid path after inspecting the workspace. If rejected in planning, keep the change in the plan and apply it only after approval; permission/boundary denial is not auto-retryable.',
  },
  shell_execute: {
    summary: 'Execute a concrete shell command through the governed execution boundary.',
    useWhen:
      'Use for every Git, build, test, package-manager, project-script, and other shell command. During planning only for a proven read-only command.',
    returns: {
      format: 'text',
      description:
        'Bounded stdout on success or bounded stderr on failure; a legacy planning deferral reports deferred: true and until_phase: building. Command status, exit code and result metadata remain Runtime-owned.',
    },
    constraints:
      'The model supplies command plus optional description/timeout_ms only; policy derives effects and exact approval. Commands whose effects cannot be proven require user approval. Never submit intent, grant_request, prefix_rule or privilege escalation.',
    recovery:
      'A planning write is deferred until building: do not retry and do not ask for shell approval. Policy/approval denial, timeout, cancellation or unknown effects are never replayed; correct only explicit pre-dispatch argument errors.',
  },
  shell_read: {
    summary: 'Read bounded output or wait for a managed Shell execution.',
    useWhen:
      'Inspect a shell_execute handle. Pass the cursor returned by the previous shell_read to receive only later output; use wait_until terminal when a finite command has no independent work left.',
    returns: {
      format: 'json',
      description: 'Current status, cursor, bounded output and terminal cleanup facts.',
    },
    constraints:
      'The handle must belong to the active Runtime scope. Preserve the returned cursor between reads; wait_ms and wait_until are mutually exclusive. Do not poll unchanged output with fixed-interval reads.',
    recovery:
      'A cancelled read ends only the wait; use shell_stop to terminate the execution. If still running, continue independent work or use one bounded wait for a needed result.',
  },
  shell_stop: {
    summary: 'Stop one managed Shell execution.',
    useWhen: 'Terminate an exact shell_id previously returned by shell_execute.',
    returns: {
      format: 'json',
      description: 'The terminal process and cleanup facts after stop is accepted.',
    },
    constraints:
      'Only exact Runtime-owned handles are accepted; arbitrary process ids are rejected.',
    recovery:
      'If cleanup is unconfirmed, report that fact and do not claim the process tree stopped.',
  },
  search_content: {
    summary: 'Search file contents by regular expression.',
    useWhen:
      'Locate symbols or text before reading matching files. Prefer this over shell grep/rg and use a path/glob to bound broad searches.',
    returns: {
      format: 'text',
      description: 'Bounded matching file/line text; zero matches is a successful empty result.',
    },
    constraints:
      'Pattern must be a valid regex; ignored files stay excluded and search is discovery, not file reading.',
    recovery:
      'Treat successful empty output as no match and stop or broaden only with a justified new pattern/scope. Correct invalid regex/path once; do not repeat identical no-match searches.',
  },
  search_files: {
    summary: 'Find files by bounded name/glob pattern.',
    useWhen: 'Locate an unknown path before read_file. Prefer this over shell find/ls.',
    returns: {
      format: 'text',
      description: 'Sorted bounded file paths; zero matches is a successful empty result.',
    },
    constraints:
      'Use a meaningful filename fragment or extension rather than a bare workspace-wide wildcard.',
    recovery:
      'For no matches, broaden the pattern or directory once when evidence supports it. Correct a nonexistent scope; a known exact file can be read directly even when search ignore semantics excluded it.',
  },
  tool_search: {
    summary: 'Discover a capability by metadata without executing it.',
    useWhen:
      'Find an MCP, Skill or builtin capability when the exact tool is not already disclosed.',
    returns: {
      format: 'json',
      description:
        'Bounded capability descriptors with stable identity, availability and effect metadata.',
      fields: [
        'ok',
        'search_id',
        'candidate_count',
        'candidates',
        'executable_candidate_count',
        'provider_count',
        'providers',
        'catalog_summary',
        'message',
        'next_step',
      ],
    },
    constraints:
      'Use a focused query; discovery does not authorize or execute the returned capability.',
    recovery:
      'If no capability matches, refine the intent or ask the user. Unavailable/provider-denied results require capability/provider revision or user action, not repeated discovery.',
  },
  activate_skill: {
    summary: 'Activate a disclosed workflow Skill for the active task.',
    useWhen: 'Load a known available Skill contract before following its workflow.',
    returns: {
      format: 'json',
      description: 'Activation identity and Runtime-owned skill frame metadata.',
      fields: ['ok', 'activation_id', 'skill_id', 'context_mode', 'output', 'summary'],
    },
    constraints:
      'Skill identity/revision must be currently disclosed and the task must not already hold a conflicting active frame.',
    recovery:
      'On unavailable/stale Skill metadata, refresh discovery or select another capability; do not invent a Skill or replay an unchanged denial.',
  },
  complete_skill: {
    summary: 'Close an active Skill frame with schema-validated output.',
    useWhen:
      'Finish the active Skill only after its workflow and declared output contract are satisfied.',
    returns: {
      format: 'json',
      description: 'Closed activation metadata and optional Runtime verification request.',
      fields: ['ok', 'activation_id', 'output'],
    },
    constraints: 'Activation ID, Skill revision and output schema must match the active frame.',
    recovery:
      'Correct a schema mismatch once from the active contract. Missing/stale frames require reading current Runtime state, not replaying old output.',
  },
  read_skill_reference: {
    summary: 'Read one declared reference from an active Skill.',
    useWhen: 'Load a reference explicitly listed by the active Skill contract.',
    returns: {
      format: 'json',
      description:
        'ok, activation_id, declared path, encoding and bounded content from the governed Skill root.',
      fields: ['ok', 'activation_id', 'path', 'encoding', 'content'],
    },
    constraints:
      'Reference must be declared, non-symlink, inside the Skill root and at most 128 KiB.',
    recovery:
      'For an unknown reference, inspect the active Skill contract and choose a declared item. Boundary or symlink denial is terminal for that reference.',
  },
  list_mcp_resources: {
    summary: 'List governed MCP resources from connected providers.',
    useWhen:
      'Discover resource URIs before read_mcp_resource; this does not invoke dynamic MCP tools.',
    returns: {
      format: 'json',
      description: 'Bounded provider/resource metadata and stable resource URIs.',
      fields: ['ok', 'resource_count', 'resources', 'truncated', 'next_step'],
    },
    constraints:
      'Only configured and admitted providers are visible; resource discovery carries no tool execution authority.',
    recovery:
      'Provider unavailable or denied requires provider/user action. An empty list is a valid terminal observation and must not be blindly retried.',
  },
  list_mcp_tools: {
    summary: 'List governed MCP tool metadata.',
    useWhen:
      'Inspect connected-provider tool availability when metadata discovery is explicitly needed.',
    returns: {
      format: 'json',
      description: 'Bounded dynamic tool names, descriptions and schema metadata.',
      fields: [
        'ok',
        'configured_provider_count',
        'callable_provider_count',
        'available_tool_count',
        'providers',
        'tools',
        'truncated',
      ],
    },
    constraints: 'Listing does not bind, approve or execute a dynamic capability.',
    recovery:
      'Unavailable providers require user/provider action or an alternate capability; unchanged empty/error results are not retry loops.',
  },
  read_mcp_resource: {
    summary: 'Read a previously discovered MCP resource URI.',
    useWhen: 'Use after list_mcp_resources provides the exact server and URI.',
    returns: {
      format: 'text',
      description:
        'Bounded resource content; oversized content is a JSON partial-result envelope with truncation metadata.',
    },
    constraints: 'Server/URI must match the current resource catalog and network/provider policy.',
    recovery:
      'Refresh the resource list after a catalog revision. Policy, provider or network denial requires user/provider action; unknown effects are never replayed.',
  },
  write_plan: {
    summary: 'Save or submit a canonical PlanDocument V2 artifact.',
    useWhen: 'Create a reviewable plan or save a governed revision before execution.',
    returns: {
      format: 'json',
      description:
        'Metadata-only task/plan identity, version, structural_digest, artifact format and disposition.',
      fields: [
        'ok',
        'status',
        'task_id',
        'plan_id',
        'version',
        'plan_schema_version',
        'structural_digest',
        'artifact',
        'next_action',
      ],
    },
    constraints:
      'Title/steps are bounded and unique. Revisions must return exact plan_id + version + structural_digest; the model cannot provide completion evidence.',
    recovery:
      'On stale/conflicting identity, read the current plan and create one governed revision. Artifact/digest mismatch, legacy V1 or review denial cannot be bypassed or reconstructed from memory.',
  },
  update_plan: {
    summary: 'Update progress for the exact executing PlanDocument V2 identity.',
    useWhen: 'Record step progress, skipped reason or completion after Runtime evidence exists.',
    returns: {
      format: 'json',
      description:
        'Metadata-only plan identity, updated steps, completion disposition and blockers.',
      fields: ['ok', 'plan_id', 'updated_steps', 'plan_completed'],
    },
    constraints:
      'Require exact plan_id/version/structural_digest. Reject terminal rollback, duplicate steps, free-form evidence, command/path/stdout and all-skipped completion.',
    recovery:
      'On identity conflict, read the active plan. verification_required/effect_evidence_required/unresolved blockers require real Runtime evidence or explicit governed resolution, never model-authored success.',
  },
  ask_user: {
    summary: 'Pause for one to three focused user decisions.',
    useWhen:
      'Ask only when a material choice blocks progress; even a single question is an array with one item.',
    returns: {
      format: 'interrupt',
      description:
        'A user_input request whose questions contain 1-3 items and 2-3 {label, description, recommended?} options each.',
    },
    constraints:
      'Use only the canonical questions array. Removed top-level question/options are invalid; put the preferred option first and optionally set exactly one recommended=true. The client always adds free-text input.',
    recovery:
      'Correct the canonical questions array once and never pass stringified JSON. User rejection/cancellation is terminal for that interaction and is not auto-retried.',
  },
  task: {
    summary: 'Delegate bounded self-contained work that benefits from an isolated sub-agent.',
    useWhen:
      'Use explore for evidence, plan for read-only architecture or design planning, review for bounded read-only review, and code only when the user task calls for implementation. Issue independent sibling task calls together with background=true so Runtime can execute them concurrently; serialize dependent work and give concurrent code tasks disjoint write scopes. Do not delegate trivial or tightly coupled work, and obey an explicit user instruction not to delegate. Parent and child share Runtime authorization, phase, budget and recovery ceilings.',
    returns: {
      format: 'json',
      description:
        'Synchronous calls return the bounded terminal result. A background call returns an accepted stable task_id; Runtime reliably delivers its admitted terminal result according to result_disposition.',
      fields: [
        'ok',
        'task_id',
        'summary',
        'error',
        'terminalStatus',
        'toolCallCount',
        'durationMs',
        'nextActions',
      ],
    },
    constraints:
      'name, subagent_type and task are required. background=true returns a stable task identity; result_disposition controls delivery and defaults to required. required remains part of the current Run; after_turn requires separate Runtime authorization and budget. Child agents cannot call ask_user. Planning permits only explore/plan; other roles never gain writes by implication.',
    recovery:
      'After background admission, continue meaningful independent work. If the first child result determines the next step, use one task_wait for the relevant task_ids; otherwise submit the final answer candidate and let Runtime wait for required children. Do not wait with sleep or task_read polling. Approval/policy denial and exhausted/unknown child effects are not replayed; resume only a Runtime-owned continuation.',
  },
  task_read: {
    summary: 'Read the current status or durable terminal report for one background sub-agent.',
    useWhen:
      'Read the exact task_id for a user-requested status check, current model retry progress, failure/cancellation diagnosis, or a full durable report after a truncated terminal result. This is an on-demand snapshot, not a waiting primitive or completion guard.',
    returns: {
      format: 'json',
      description:
        'The stable task identity, lifecycle status, bounded model retry progress, cleanup facts and classified terminal report when available. A failed child is still a successful status read.',
      fields: [
        'ok',
        'task_id',
        'status',
        'retry',
        'cleanup_confirmed',
        'outcome',
        'result',
        'artifact',
      ],
    },
    constraints:
      'The task must belong to the active Session and Runtime owner. This non-consuming on-demand snapshot is not a waiting primitive or completion guard and does not grant cancellation or execution authority. Do not use sleep, loops, or fixed-interval reads to wait.',
    recovery:
      'If status is running and the revision has not changed, do not immediately read again; yield so the Runtime watcher can deliver an actionable result. A missing or foreign task identity is terminal for that invocation.',
  },
  task_wait: {
    summary: 'Wait for an actionable update from one or more background sub-agents.',
    useWhen:
      'Use one bounded wait when a child result or model retry changes the next action, for example which independent result to inspect or which dependent task to start. Pass one to eight exact task_ids. When only required children remain before the final answer, submit the final candidate and let Runtime wait automatically.',
    returns: {
      format: 'json',
      description:
        'The wait reason and current task snapshots after a model retry, terminal, failed, cancelled, missing, interrupted, or timeout outcome. A failed child remains visible in tasks rather than failing the wait Tool.',
      fields: ['ok', 'reason', 'cursor', 'tasks'],
    },
    constraints:
      'task_ids must contain one to eight distinct Runtime-owned task identities. timeout_ms is bounded to 0-60000 and defaults to 30000. Do not repeatedly call task_wait after an unchanged timeout or model retry, and do not replace it with sleep or task_read polling.',
    recovery:
      'On timeout, continue meaningful independent work or yield to automatic required-result delivery. Treat missing or foreign task identities as terminal for that invocation; user input or cancellation interrupts the wait.',
  },
  task_cancel: {
    summary: 'Stop one Runtime-owned background sub-agent and wait for its cleanup result.',
    useWhen:
      'Stop the exact task_id returned by a background task without cancelling the main Run.',
    returns: {
      format: 'json',
      description:
        'Cancellation acceptance plus the target terminal status, report reference and cleanup confirmation.',
      fields: ['ok', 'task_id', 'status', 'cancel_requested', 'cleanup_confirmed', 'result'],
    },
    constraints:
      'The task must belong to the active Session and Runtime owner. Cancellation affects only that child and its governed descendants.',
    recovery:
      'Repeated cancellation returns the existing terminal fact. If cleanup is unconfirmed, report it and do not claim the child stopped.',
  },
  list_agents: {
    summary: 'List visible Agents in the current Session.',
    useWhen: 'Inspect the Agent tree, current status, recent task identity or unread update count.',
    returns: {
      format: 'json',
      description:
        'A bounded same-Session Agent tree snapshot; it does not include private message bodies.',
      fields: ['ok', 'agents'],
    },
    constraints:
      'Read-only. Listing does not consume mailbox messages or start an Agent turn. agent_id is distinct from task_id.',
    recovery:
      'A missing or foreign Agent is not made visible by guessing an ID; use the current Session tree.',
  },
  wait_agent: {
    summary: 'Wait once for an update to the calling Agent mailbox.',
    useWhen: 'Wait for a response or actionable update after sending a message or followup.',
    returns: {
      format: 'json',
      description:
        'Only timed_out and the wake reason; full messages enter a later model input as lower-trust Agent frames.',
      fields: ['timed_out', 'reason'],
    },
    constraints:
      'timeout_ms defaults to 30000 and is bounded to 0–60000. Waiting does not mark messages read, consume the mailbox, or cancel any Agent.',
    recovery:
      'After an unchanged timeout, continue independent work or yield; do not poll with repeated short waits.',
  },
  send_message: {
    summary: 'Queue a message to one visible Agent without starting a turn.',
    useWhen:
      'Send guidance or a reply to an active or idle Agent when it can be read at a later safe model boundary.',
    returns: {
      format: 'text',
      description:
        'Empty success after durable acceptance; it does not mean the target read or acted on the message.',
    },
    constraints:
      'agent_id names a direct parent or child Agent Session, not a task_id. message is at most 4096 UTF-8 bytes; the target can have at most eight pending messages. This is QueueOnly and never starts a new turn. An idle target keeps the message queued until an explicit eligible continuation.',
    recovery:
      'On a rejected or unknown receipt, inspect the durable Agent state; do not blindly resend or assume delivery.',
  },
  followup_task: {
    summary: 'Submit a message that explicitly requests one Agent to continue.',
    useWhen:
      'Resume a visible non-root Agent under an admitted TriggerTurn budget and authorization.',
    returns: {
      format: 'text',
      description:
        'Empty success after durable admission, without a new task ID or a promise that execution started.',
    },
    constraints:
      'agent_id names a non-root Agent, not a task_id. message is at most 4096 UTF-8 bytes. The Host must admit exact caller scope, authorization, deadline and bounded backup budget before success; old grants are not reused.',
    recovery:
      'Use wait_agent or list_agents for progress. Rejection or unknown admission is not safe to replay blindly; inspect the durable receipt first.',
  },
  interrupt_agent: {
    summary: 'Interrupt the current active turn of one visible Agent.',
    useWhen:
      'Stop an exact Agent after checking its current state; preserve its identity and settled history.',
    returns: {
      format: 'json',
      description:
        'Cancellation request and exact active-task cleanup status, or the existing idle state.',
      fields: [
        'ok',
        'agent_id',
        'status',
        'current_task_id',
        'cancel_requested',
        'cleanup_confirmed',
      ],
    },
    constraints:
      'agent_id is not task_id. Only the Host resolves the current task and applies accurate stop/cleanup semantics; sibling Agents are unaffected.',
    recovery:
      'If cleanup is unknown, do not claim the Agent stopped. Re-read the same Agent state rather than targeting an old task ID.',
  },
  web_fetch: {
    summary: 'Fetch and extract one public HTTP or HTTPS document.',
    useWhen:
      'Read a known public article/document URL; use another source for login pages, search forms or inaccessible sites.',
    returns: {
      format: 'text',
      description:
        'Bounded status/content metadata, cleaned text, links, truncation and fetch timing.',
    },
    constraints:
      'Only public http/https URLs; SSRF, robots, network and size limits are enforced. timeout_ms is bounded.',
    recovery:
      'Do not retry the same 403/robots/unextractable URL; choose another source. Correct 404 URLs, respect 429, and increase timeout once only for a known large public page.',
  },
};

function currentToolContract(name: KnownToolName): ToolContract {
  const sections = BUILTIN_TOOL_CONTRACTS[name];
  return { name, sections, description: buildDescription(sections) };
}

export const READ_FILE_CONTRACT = currentToolContract('read_file');
export const READ_PLAN_CONTRACT = currentToolContract('read_plan');
export const EDIT_FILE_CONTRACT = currentToolContract('edit_file');
export const WRITE_FILE_CONTRACT = currentToolContract('write_file');
export const SHELL_EXECUTE_CONTRACT = currentToolContract('shell_execute');
export const SEARCH_CONTENT_CONTRACT = currentToolContract('search_content');
export const SEARCH_FILES_CONTRACT = currentToolContract('search_files');
export const TOOL_SEARCH_CONTRACT = currentToolContract('tool_search');
export const LIST_MCP_RESOURCES_CONTRACT = currentToolContract('list_mcp_resources');
export const LIST_MCP_TOOLS_CONTRACT = currentToolContract('list_mcp_tools');
export const READ_MCP_RESOURCE_CONTRACT = currentToolContract('read_mcp_resource');
export const WRITE_PLAN_CONTRACT = currentToolContract('write_plan');
export const UPDATE_PLAN_CONTRACT = currentToolContract('update_plan');
export const ASK_USER_CONTRACT = currentToolContract('ask_user');
export const TASK_CONTRACT = currentToolContract('task');
export const TASK_READ_CONTRACT = currentToolContract('task_read');
export const TASK_WAIT_CONTRACT = currentToolContract('task_wait');
export const TASK_CANCEL_CONTRACT = currentToolContract('task_cancel');
export const WEB_FETCH_CONTRACT = currentToolContract('web_fetch');

/** Current contract registry view. */
export const TOOL_CONTRACTS: ReadonlyMap<string, ToolContract> = new Map(
  KNOWN_TOOL_NAMES.map((name) => [name, currentToolContract(name)]),
);

export function getToolContract(toolName: string): ToolContract | undefined {
  return TOOL_CONTRACTS.get(toolName);
}

export function builtinToolDescription(toolName: string): string {
  const contract = TOOL_CONTRACTS.get(toolName);
  if (!contract) throw new Error(`Builtin tool contract is missing: ${toolName}`);
  return contract.description;
}
