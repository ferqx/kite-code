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
  'git_inspect',
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
  'web_fetch',
] as const;

export type KnownToolName = (typeof KNOWN_TOOL_NAMES)[number];

/** Canonical 19/19 builtin contract facts. No Runner or prompt layer owns a second guidance table. */
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
      'Use in building, or during planning only for a proven read-only command. Prefer typed read/search tools when they cover the task.',
    returns: {
      format: 'text',
      description:
        'Bounded stdout on success or bounded stderr on failure; a legacy planning deferral reports deferred: true and until_phase: building. Command status, exit code and result metadata remain Runtime-owned.',
    },
    constraints:
      'The model supplies command plus optional description/timeout_ms only; policy derives effects and approval. Never submit intent, grant_request, prefix_rule or privilege escalation.',
    recovery:
      'A planning write is deferred until building: do not retry and do not ask for shell approval. Policy/approval denial, timeout, cancellation or unknown effects are never replayed; correct only explicit pre-dispatch argument errors.',
  },
  git_inspect: {
    summary: 'Inspect local Git state through the hardened typed broker.',
    useWhen:
      'Use status, diff, log or branch_list instead of shell Git. The broker binds the repository and trusted executable before dispatch.',
    returns: {
      format: 'json',
      description: 'Bounded output plus Runtime-owned operation receipt and stable failure code.',
      fields: ['ok', 'output', 'failure_code', 'next_capability', 'receipt'],
    },
    constraints:
      'Only fixed operations and bounded paths/revision/record/output/timeout fields are accepted. Arbitrary argv, config, formats, repo roots, remotes and protected paths are forbidden.',
    recovery:
      'Hostile repository, protected content, untrusted binary or missing qualification fails closed. Use the returned stable code; never fall back to raw shell Git.',
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
      'Use explore for evidence, plan for read-only architecture or design planning, review for bounded read-only review, and code only when the user task calls for implementation. Issue multiple independent sibling task calls in one response so Runtime can execute them concurrently within its shared budget; serialize dependent work and give concurrent code tasks disjoint write scopes. Do not delegate trivial or tightly coupled work, and obey an explicit user instruction not to delegate. Parent and child share Runtime authorization, phase, budget and recovery ceilings.',
    returns: {
      format: 'json',
      description:
        'Only ok, summary, error, terminalStatus, toolCallCount, durationMs and governed nextActions; private continuation/journal/lineage never reaches the model.',
      fields: [
        'ok',
        'summary',
        'error',
        'terminalStatus',
        'toolCallCount',
        'durationMs',
        'nextActions',
      ],
    },
    constraints:
      'name, subagent_type and task are required. name is a short public label that states what the child is doing; task is the concrete self-contained instruction. Clarify material ambiguity before dispatch: child agents cannot call ask_user and must return missing prerequisites to the parent. Planning permits only explore/plan; other disclosed roles return a phase-constraint error and never gain writes by implication.',
    recovery:
      'Approval/policy denial and exhausted/unknown child effects are not replayed. Resume only a Runtime-owned continuation; use a new bounded task only after real replan/user/provider progress.',
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
export const GIT_INSPECT_CONTRACT = currentToolContract('git_inspect');
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
