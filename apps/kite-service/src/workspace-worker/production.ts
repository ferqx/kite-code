import { join } from 'node:path';
import { createWorkspaceWorkerApplication } from './application';
import type { WorkspaceWorkerMainDependencies } from './process-main';
import { createWorkspaceWorkerRuntimeComposition } from './runtime-composition';

/**
 * Production Worker child factory. Every filesystem root comes from the manager-owned explicit
 * environment; it never reads cwd, HOME, PATH, dotenv, a legacy Store, or a second Runtime owner.
 */
export const createProductionWorkspaceWorkerRuntime: NonNullable<
  WorkspaceWorkerMainDependencies['createRuntime']
> = async ({ environment, ownerLock }) => {
  // Builtin artifact owners still consume the process-local KITE_CODE_HOME binding. Pin it from
  // the already-validated manager environment before composing them; never inherit a caller or
  // Workspace dotenv value. One Worker process owns exactly one Kite home.
  process.env.KITE_CODE_HOME = environment.home.root;
  // Keep the established Kite home configuration identity. The Worker receives this root from
  // the validated manager environment; it must not invent a parallel config tree or consult HOME.
  const configRoot = environment.home.root;
  return createWorkspaceWorkerRuntimeComposition({
    home: environment.home,
    coordinationHome: environment.coordinationHome,
    workspace: environment.workspace,
    workerScopeId: environment.workerScopeId,
    workerInstanceId: environment.workerInstanceId,
    buildId: environment.buildId,
    layoutGeneration: environment.layoutGeneration,
    controlCredential: environment.controlCredential,
    ownerLock,
    createApplication: (input) =>
      createWorkspaceWorkerApplication(input, {
        appControlOptions: {
          userConfigPath: join(configRoot, 'kite-code.jsonc'),
          workspaceTrustStorePath: join(configRoot, 'workspace-trust.jsonc'),
          userMcpConfigPath: join(configRoot, 'mcp.json'),
          mcpApprovalPath: join(configRoot, 'mcp-project-approvals.jsonc'),
          userKiteCodeSkillsDir: join(configRoot, 'skills'),
          userAgentsSkillsDir: join(configRoot, 'agents-skills'),
        },
      }),
  });
};
