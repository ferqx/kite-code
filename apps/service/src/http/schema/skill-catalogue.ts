import { z } from 'zod';

const id = z.string().min(1).max(128);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const positive = z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER);
export const SkillCatalogueQuerySchema = z.strictObject({
  storeId: id,
  workflow: z.literal('manual').optional(),
  afterId: id.optional(),
  revision: digest.optional(),
  limit: positive.optional(),
  byteLimit: positive.max(1048576).optional(),
});
export const skillUnavailableReasons = [
  'invalid_skill_configuration',
  'skill_path_denied',
  'unsupported_skill_options',
  'skill_unavailable',
  'skill_version_changed',
  'duplicate_skill_location',
  'skill_capability_missing',
  'skill_metadata_limit',
  'skill_text_limit',
  'skill_text_invalid',
  'skill_path_changed',
] as const;
export const workflowUnavailableReasons = [
  'workflow_disabled',
  'workflow_configuration_unavailable',
  'workflow_contract_unavailable',
  'workflow_dependency_unavailable',
  'workflow_manual_not_allowed',
  'workflow_input_required',
  'workflow_fork_unavailable',
  'workflow_verifier_unavailable',
  'workflow_source_changed',
  'skill_unavailable',
] as const;
/** A read-only manual activation projection; execution still revalidates the original source. */
export const SkillWorkflowCatalogueSchema = z.strictObject({
  extensionId: z.literal('builtin.skill-workflow'),
  definitionVersion: z.literal('1'),
  skillId: id.nullable(),
  name: z.string().max(256).nullable(),
  revision: digest.nullable(),
  state: z.enum(['available', 'disabled', 'unavailable']),
  reason: z.enum(workflowUnavailableReasons).nullable(),
  manualAllowed: z.boolean(),
  emptyInputValid: z.boolean(),
  contextMode: z.enum(['inline', 'fork']).nullable(),
});
export const SkillCatalogueEntrySchema = z.strictObject({
  id,
  source: z
    .strictObject({
      scope: z.enum(['project', 'user']),
      origin: z.enum(['.agents', '.kite-code', 'profile', 'configured']),
    })
    .nullable()
    .optional(),
  name: z.string().max(256).nullable(),
  description: z.string().max(4096).nullable(),
  version: digest.nullable(),
  enabled: z.boolean(),
  state: z.enum(['available', 'disabled', 'unavailable']),
  reason: z.enum(skillUnavailableReasons).nullable(),
  requiredCapabilities: z.array(z.string().min(1).max(256)),
  missingCapabilities: z.array(z.string().min(1).max(256)),
  workflow: SkillWorkflowCatalogueSchema.optional(),
});
export const SkillCataloguePageSchema = z.strictObject({
  version: z.literal(1),
  storeId: id,
  workspaceId: id,
  revision: digest,
  availability: z.enum(['available', 'unavailable']),
  reason: z
    .enum([
      'configuration_unavailable',
      'workspace_configuration_unavailable',
      'skill_catalogue_source_unavailable',
    ])
    .nullable(),
  entries: z.array(SkillCatalogueEntrySchema),
  nextAfterId: id.nullable(),
  complete: z.boolean(),
});
