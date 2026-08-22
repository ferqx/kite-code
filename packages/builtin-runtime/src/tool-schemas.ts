import type { RuntimeJsonValueV1 } from '@kite/runtime-spi';
import { z } from 'zod';
import { isGitRevisionV1 } from './git/broker';

/**
 * Builtin-owned input schemas. Operation registrations and the model ToolSet
 * consume JSON projections generated from these exact Zod definitions; the
 * parser/canonicalizer uses the same definition. Registration-time parity
 * checks make a second schema authority impossible.
 */

const boundedPath = z.string().min(1).max(512);
const timeout = z.number().int().min(100).max(60_000).optional();
const outputBound = z.number().int().min(1).max(262_144).optional();
const recordBound = z.number().int().min(1).max(200).optional();
const paths = z.array(boundedPath).min(1).max(128);

export const BUILTIN_READ_FILE_SCHEMA_V1 = z.object({
  path: z.string().describe('Workspace-relative, absolute, or home-relative (~) path to the file'),
  offset: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Starting line number (1-indexed, default 1)'),
  limit: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe('Maximum number of lines to read (default 2000)'),
});

export const BUILTIN_SEARCH_CONTENT_SCHEMA_V1 = z.object({
  pattern: z.string().describe('Regex pattern to search for (e.g. "function\\s+\\w+")'),
  path: z
    .string()
    .optional()
    .describe(
      'Workspace-relative, absolute, or home-relative (~) directory/file path (default: workspace root)',
    ),
  glob: z.string().optional().describe('File glob filter (e.g. "*.ts", "*.{ts,tsx}")'),
});

export const BUILTIN_SEARCH_FILES_SCHEMA_V1 = z.object({
  pattern: z.string().describe('File name pattern (e.g. "*.test.ts", "config.*")'),
  path: z
    .string()
    .optional()
    .describe(
      'Workspace-relative, absolute, or home-relative (~) directory (default: workspace root)',
    ),
});

export const BUILTIN_WRITE_FILE_SCHEMA_V1 = z.object({
  path: z
    .string()
    .describe('Workspace-relative path, or an approved absolute/home-relative external path'),
  content: z.string().describe('Complete file content to write'),
});

export const BUILTIN_EDIT_FILE_SCHEMA_V1 = z.object({
  path: z
    .string()
    .describe(
      'Workspace-relative path to edit, or an approved absolute/home-relative external path',
    ),
  old_string: z
    .string()
    .describe(
      'The exact text to replace. Must match the file content exactly, including whitespace.',
    ),
  new_string: z.string().describe('The new text to replace old_string with'),
  replace_all: z
    .boolean()
    .optional()
    .describe('Replace all occurrences (default: false, fails if multiple matches found)'),
});

export const BUILTIN_GIT_INSPECT_SCHEMA_V1 = z.discriminatedUnion('operation', [
  z
    .object({
      operation: z.literal('status'),
      paths: paths.optional(),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('diff'),
      paths,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('log'),
      paths,
      revision: z.string().min(1).max(128).refine(isGitRevisionV1).optional(),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
  z
    .object({
      operation: z.literal('branch_list'),
      max_records: recordBound,
      max_output_bytes: outputBound,
      timeout_ms: timeout,
    })
    .strict(),
]);

export const BUILTIN_WEB_FETCH_SCHEMA_V1 = z.object({
  url: z.string().min(1).max(8192).describe('Public http/https URL to fetch (max 8192 chars)'),
  max_chars: z
    .number()
    .int()
    .min(1000)
    .max(16000)
    .optional()
    .describe('Max characters of extracted content (default 8000)'),
  timeout_ms: z
    .number()
    .int()
    .min(3000)
    .max(30000)
    .optional()
    .describe(
      'Timeout in milliseconds (default 15000). Increase for large pages like Wikipedia or GitHub.',
    ),
});

export const BUILTIN_LIST_MCP_RESOURCES_SCHEMA_V1 = z.object({
  server: z.string().min(1).optional().describe('Optional exact MCP server name'),
});

export const BUILTIN_LIST_MCP_TOOLS_SCHEMA_V1 = z.object({
  provider: z.string().trim().min(1).max(128).optional(),
  limit: z.number().int().min(1).max(100).optional(),
  cursor: z.string().max(2048).optional(),
});

export const BUILTIN_READ_MCP_RESOURCE_SCHEMA_V1 = z.object({
  server: z.string().describe('MCP server name'),
  uri: z.string().describe('Resource URI to read (e.g. file:///docs/api.md)'),
});

export const BUILTIN_ACTIVATE_SKILL_SCHEMA_V1 = z.object({
  skill_id: z.string().min(1),
  input: z.record(z.string(), z.unknown()),
});

export const BUILTIN_READ_SKILL_REFERENCE_SCHEMA_V1 = z.object({
  activation_id: z.string().min(1),
  path: z.string().min(1),
});

export const BUILTIN_COMPLETE_SKILL_SCHEMA_V1 = z.object({
  activation_id: z.string().min(1),
  output: z.record(z.string(), z.unknown()),
});

export const BUILTIN_DYNAMIC_MCP_SCHEMA_V1 = z
  .object({
    capability_id: z.string().min(1),
    capability_revision: z.string().min(1),
    arguments: z.object({}).passthrough(),
  })
  .strict();

const optionSchemaV1 = z
  .object({
    label: z.string().trim().min(1),
    description: z.string().trim().min(1),
    recommended: z.boolean(),
  })
  .strict();
const questionSchemaV1 = z
  .object({
    question: z.string().trim().min(1),
    options: z.array(optionSchemaV1).min(2).max(3),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.options.filter((option) => option.recommended).length !== 1) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['options'],
        message: 'Exactly one option must set recommended to true',
      });
    }
  });

export const BUILTIN_ASK_USER_SCHEMA_V1 = z
  .object({ questions: z.array(questionSchemaV1).min(1).max(3) })
  .strict();

export const BUILTIN_READ_PLAN_SCHEMA_V1 = z
  .object({
    plan_id: z.string().min(1),
    version: z.number().int().positive().optional(),
    structural_digest: z.string().min(1).optional(),
  })
  .strict();

const planStepSchemaV1 = z
  .object({
    id: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/),
    title: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[^\r\n]+$/),
  })
  .strict();

const writePlanDocumentFieldsV1 = {
  title: z
    .string()
    .trim()
    .min(1)
    .max(120)
    .regex(/^[^\r\n]+$/),
  body_markdown: z.string().trim().min(20).max(30_000),
  steps: z
    .array(planStepSchemaV1)
    .min(1)
    .max(12)
    .superRefine((steps, context) => {
      const ids = new Set<string>();
      for (const [index, step] of steps.entries()) {
        if (ids.has(step.id)) {
          context.addIssue({
            code: z.ZodIssueCode.custom,
            path: [index, 'id'],
            message: 'Step IDs must be unique',
          });
        }
        ids.add(step.id);
      }
    }),
};

export const BUILTIN_WRITE_PLAN_SCHEMA_V1 = z
  .object({
    title: writePlanDocumentFieldsV1.title.optional(),
    body_markdown: writePlanDocumentFieldsV1.body_markdown.optional(),
    steps: writePlanDocumentFieldsV1.steps.optional(),
    plan_id: z.string().trim().min(1).optional(),
    version: z.number().int().positive().optional(),
    structural_digest: z.string().trim().min(1).optional(),
    expected_version: z.number().int().positive().optional(),
    replan_reason: z.string().trim().max(500).optional(),
    action: z.enum(['save', 'submit']).optional(),
  })
  .strict()
  .superRefine((value, context) => {
    const action = value.action ?? 'save';
    const hasDocument =
      value.title !== undefined && value.body_markdown !== undefined && value.steps !== undefined;
    const hasArtifact =
      value.plan_id !== undefined &&
      value.version !== undefined &&
      value.structural_digest !== undefined;
    if (action === 'save' && !hasDocument) {
      for (const key of ['title', 'body_markdown', 'steps'] as const) {
        if (value[key] === undefined) {
          context.addIssue({ code: z.ZodIssueCode.custom, path: [key], message: 'Required' });
        }
      }
    }
    if (action === 'submit' && !hasArtifact) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['plan_id'],
        message: 'Submit requires the saved Artifact identity',
      });
    }
  });

export const BUILTIN_UPDATE_PLAN_SCHEMA_V1 = z
  .object({
    plan_id: z.string().min(1).describe('Plan ID from the approved plan'),
    version: z.number().int().positive().describe('Version from the approved plan').optional(),
    structural_digest: z
      .string()
      .trim()
      .min(1)
      .describe('Digest from the approved plan')
      .optional(),
    updates: z
      .array(
        z
          .object({
            step_id: z.string().min(1).describe('Stable step ID from the plan'),
            status: z.enum(['pending', 'in_progress', 'completed', 'skipped']),
            note: z.string().trim().max(500).optional(),
            reason_code: z
              .string()
              .regex(/^[a-z][a-z0-9_]{0,63}$/)
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(12)
      .superRefine((updates, context) => {
        const ids = new Set<string>();
        for (const [index, update] of updates.entries()) {
          if (ids.has(update.step_id)) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'step_id'],
              message: 'Each step may be updated once per call',
            });
          }
          if (update.status === 'skipped' && update.reason_code === undefined) {
            context.addIssue({
              code: z.ZodIssueCode.custom,
              path: [index, 'reason_code'],
              message: 'Skipped steps require a reason_code',
            });
          }
          ids.add(update.step_id);
        }
      }),
    complete_plan: z.boolean().optional(),
  })
  .strict();

export const BUILTIN_TASK_PUBLIC_SCHEMA_V1 = z
  .object({
    subagent_type: z
      .enum(['explore', 'plan', 'code', 'review'])
      .describe('Type of sub-agent to invoke'),
    task: z
      .string()
      .trim()
      .min(8)
      .max(8_000)
      .describe(
        'Self-contained task description with all necessary context. The sub-agent cannot see the main conversation.',
      ),
  })
  .strict();

export const BUILTIN_TASK_PRIVATE_SCHEMA_V1 = z
  .object({
    subagent_type: z.enum(['explore', 'plan', 'code', 'review']),
    taskArtifact: z
      .object({
        artifactId: z.string().regex(/^pa_[0-9a-f]{64}$/u),
        kind: z.literal('subagent_task_request'),
        integrityIdentifier: z.string().regex(/^hmac-sha256:[0-9a-f]{64}$/u),
        byteLength: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();

export const BUILTIN_TASK_RUNTIME_SCHEMA_V1 = z.union([
  BUILTIN_TASK_PUBLIC_SCHEMA_V1,
  BUILTIN_TASK_PRIVATE_SCHEMA_V1,
]);

export const BUILTIN_TASK_LEGACY_PLANNING_SCHEMA_V1 = BUILTIN_TASK_PUBLIC_SCHEMA_V1.extend({
  subagent_type: z
    .enum(['explore', 'plan'])
    .describe(
      'Read-only role: explore for evidence gathering or plan for architecture and design planning',
    ),
});

export const BUILTIN_SHELL_EXECUTE_SCHEMA_V1 = z.object({
  command: z.string().describe('Shell command to execute in the workspace'),
  description: z
    .string()
    .optional()
    .describe('Short human-readable description of what this command does (shown to the user)'),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .optional()
    .describe(
      'Maximum runtime in milliseconds. Commands default to 600000ms when omitted; set a shorter limit for a TUI, dev server, watcher, or other long-running process, or a longer limit for an unusually slow finite command.',
    ),
});

export const BUILTIN_TOOL_SEARCH_SCHEMA_V1 = z.object({
  query: z.string().trim().min(2).max(512).describe('Capability intent to search for'),
  limit: z.number().int().min(1).max(12).optional().describe('Maximum candidates'),
});

const internalSchemaV1 = z.object({}).passthrough();

export const BUILTIN_ZOD_SCHEMAS_V1 = Object.freeze({
  'builtin:read_file': BUILTIN_READ_FILE_SCHEMA_V1,
  'builtin:search_content': BUILTIN_SEARCH_CONTENT_SCHEMA_V1,
  'builtin:search_files': BUILTIN_SEARCH_FILES_SCHEMA_V1,
  'builtin:write_file': BUILTIN_WRITE_FILE_SCHEMA_V1,
  'builtin:edit_file': BUILTIN_EDIT_FILE_SCHEMA_V1,
  'builtin:git_inspect': BUILTIN_GIT_INSPECT_SCHEMA_V1,
  'builtin:web_fetch': BUILTIN_WEB_FETCH_SCHEMA_V1,
  'builtin:list_mcp_resources': BUILTIN_LIST_MCP_RESOURCES_SCHEMA_V1,
  'builtin:list_mcp_tools': BUILTIN_LIST_MCP_TOOLS_SCHEMA_V1,
  'builtin:read_mcp_resource': BUILTIN_READ_MCP_RESOURCE_SCHEMA_V1,
  'builtin:read_skill_reference': BUILTIN_READ_SKILL_REFERENCE_SCHEMA_V1,
  'builtin:complete_skill': BUILTIN_COMPLETE_SKILL_SCHEMA_V1,
  'builtin:activate_skill': BUILTIN_ACTIVATE_SKILL_SCHEMA_V1,
  'mcp:dynamic_tool': BUILTIN_DYNAMIC_MCP_SCHEMA_V1,
  'builtin:ask_user': BUILTIN_ASK_USER_SCHEMA_V1,
  'builtin:read_plan': BUILTIN_READ_PLAN_SCHEMA_V1,
  'builtin:update_plan': BUILTIN_UPDATE_PLAN_SCHEMA_V1,
  'builtin:write_plan': BUILTIN_WRITE_PLAN_SCHEMA_V1,
  'builtin:task': BUILTIN_TASK_RUNTIME_SCHEMA_V1,
  'builtin:shell_execute': BUILTIN_SHELL_EXECUTE_SCHEMA_V1,
  'builtin:tool_search': BUILTIN_TOOL_SEARCH_SCHEMA_V1,
  'subagent:start': internalSchemaV1,
  'subagent:resume': internalSchemaV1,
  'verification:deterministic': internalSchemaV1,
  'model:primary': internalSchemaV1,
  'model:compaction': internalSchemaV1,
  'model:auto_review': internalSchemaV1,
  'model:verification_review': internalSchemaV1,
  'model:subagent': internalSchemaV1,
} as const);

export type BuiltinOperationIdV1 = keyof typeof BUILTIN_ZOD_SCHEMAS_V1;

export interface BuiltinJsonSchemaOptionsV1 {
  /** Project Zod's empty passthrough object to the existing RMV1 JSON shape. */
  readonly passthroughObject?: boolean;
}

/** The only JSON-schema projection used by Builtin registrations and ToolSet. */
export function builtinJsonSchemaV1(
  schema: z.ZodType,
  options: BuiltinJsonSchemaOptionsV1 = {},
): Readonly<Record<string, RuntimeJsonValueV1>> {
  const raw = z.toJSONSchema(schema) as unknown;
  const projected = options.passthroughObject ? normalizePassthroughSchemaV1(raw) : raw;
  return freezeRuntimeJsonRecordV1(projected);
}

export const BUILTIN_JSON_SCHEMAS_V1 = Object.freeze(
  Object.fromEntries(
    Object.entries(BUILTIN_ZOD_SCHEMAS_V1).map(([operationId, schema]) => [
      operationId,
      builtinJsonSchemaV1(schema, {
        passthroughObject: operationId === 'mcp:dynamic_tool' || operationId.startsWith('model:'),
      }),
    ]),
  ),
) as Readonly<Record<BuiltinOperationIdV1, Readonly<Record<string, RuntimeJsonValueV1>>>>;

function normalizePassthroughSchemaV1(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizePassthroughSchemaV1);
  if (!value || typeof value !== 'object') return value;
  const record = value as Record<string, unknown>;
  const normalized = Object.fromEntries(
    Object.entries(record).map(([key, item]) => [
      key,
      key === 'additionalProperties' &&
      item &&
      typeof item === 'object' &&
      !Array.isArray(item) &&
      Object.keys(item).length === 0
        ? true
        : normalizePassthroughSchemaV1(item),
    ]),
  );
  if (
    normalized.properties &&
    typeof normalized.properties === 'object' &&
    !Array.isArray(normalized.properties) &&
    Object.keys(normalized.properties).length === 0 &&
    normalized.additionalProperties === true
  ) {
    delete normalized.properties;
  }
  return normalized;
}

function freezeRuntimeJsonRecordV1(value: unknown): Readonly<Record<string, RuntimeJsonValueV1>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Builtin JSON schema projection must be an object');
  }
  return Object.freeze(
    Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeRuntimeJsonValueV1(item)]),
    ),
  );
}

function freezeRuntimeJsonValueV1(value: unknown): RuntimeJsonValueV1 {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (Array.isArray(value)) return Object.freeze(value.map(freezeRuntimeJsonValueV1));
  if (value && typeof value === 'object') return freezeRuntimeJsonRecordV1(value);
  throw new Error('Builtin JSON schema contains a non-JSON value');
}
