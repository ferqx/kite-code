import type { AgentRuntime, RuntimeOptions } from '@kite-ai/agent';
import type { Json } from '@kite-ai/agent/extensions';
import type { ProfileSelection } from '@kite-ai/agent/profile';
import { z } from 'zod';
import type { ConfigurationManagementPort } from './configuration-management';
import type { HostStatusSource } from './host-status';
import { schemas } from './http/schema';
import type { PermissionManagementPort } from './permission-management';
import { parseRuntimeProtection } from './runtime-protection';
import type { SkillCatalogueSource } from './skill-catalogue';

export const startupLimitBytes = 64 * 1024;
export const bootstrapLimitBytes = 16 * 1024;
const runtimeProtectionSchema = z.unknown().transform((value, context) => {
  try {
    return parseRuntimeProtection(value);
  } catch {
    context.addIssue({ code: 'custom', message: 'Invalid runtime protection.' });
    return z.NEVER;
  }
});
export const privateStartupSchema = z.strictObject({
  profile: z.strictObject({
    dataRoot: z.string().min(1).max(4096),
    profile: z.string().min(1).max(64),
    profileAccessKey: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  instanceId: schemas.Workspace.shape.id,
  buildId: z.string().min(1).max(256),
  token: z.string().min(32).max(256),
  capabilities: z.array(z.string().min(1).max(128)).max(64).optional(),
  hostConfiguration: z.json().optional(),
  /** Host-only selected candidate proof; absent from HTTP, JSONC and Model configuration. */
  runtimeProtection: runtimeProtectionSchema.optional(),
});
export type PrivateStartup = z.infer<typeof privateStartupSchema>;
export type PrivateBootstrap = z.infer<typeof schemas.ServerInfo> & {
  endpoint: string;
  token: string;
};
export type SelectedProfile = Pick<ProfileSelection, 'dataRoot' | 'profile' | 'profileAccessKey'>;
export interface ProcessHostConfiguration {
  diagnosticSource?: HostStatusSource;
  skillCatalogue?: SkillCatalogueSource;
  configurationManagement?: (runtime?: AgentRuntime) => ConfigurationManagementPort;
  permissionManagement?: (runtime?: AgentRuntime) => PermissionManagementPort;
  model?: RuntimeOptions['model'];
  modelId?: string;
  permissions?: RuntimeOptions['permissions'];
  authorizationReview?: RuntimeOptions['authorizationReview'];
  conditions?: RuntimeOptions['conditions'];
  initializeRunRequirements?: RuntimeOptions['initializeRunRequirements'];
  extensions?: RuntimeOptions['extensions'];
  sources?: RuntimeOptions['sources'];
  workspaceSerialLocks?: RuntimeOptions['workspaceSerialLocks'];
  /** Share the actual host coordinator with private network/credential operations. No new owner. */
  bindWorkspaceSerialLocks?(locks: NonNullable<RuntimeOptions['workspaceSerialLocks']>): void;
  supportsSelectedSkills?: RuntimeOptions['supportsSelectedSkills'];
  supportsExtensionInputs?: RuntimeOptions['supportsExtensionInputs'];
  resolveRunConfiguration?: RuntimeOptions['resolveRunConfiguration'];
  resolveRecoveryRunConfiguration?: RuntimeOptions['resolveRecoveryRunConfiguration'];
  resolveRecoveryJobConfiguration?: RuntimeOptions['resolveRecoveryJobConfiguration'];
  authorizeJobReconcile?: RuntimeOptions['authorizeJobReconcile'];
  childConfigurations?: RuntimeOptions['childConfigurations'];
  resolveChildRunConfiguration?: RuntimeOptions['resolveChildRunConfiguration'];
}
export interface ProcessHostContext {
  readonly subjectId: string;
}
export type ConfigureProcessHost = (
  startup: PrivateStartup & { hostConfiguration?: Json },
  context: Readonly<ProcessHostContext>,
) => Promise<ProcessHostConfiguration> | ProcessHostConfiguration;
