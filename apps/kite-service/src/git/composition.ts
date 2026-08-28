import { existsSync } from 'node:fs';
import {
  createGitBroker,
  type GitBroker,
  qualifyBrokeredGitNativeDeny,
} from '@kite-ai/builtin-runtime/git';
import { createProtectedPathEvaluator } from '@kite-ai/builtin-runtime/sandbox';
import { BROKERED_GIT_FEATURE_REVISION_, type GitShellDenyEvidence } from '@kite-ai/runtime-spi';
import { getFeatureFlags } from '#kite-service/config/features';
import type { AgentConfig } from '#kite-service/config/index';
import { createAppGitProcessAdapter } from './process-adapter';

/** Release-owned executable selection. There is no PATH/model fallback. */
export function resolveAppGitExecutable(): string | undefined {
  if (process.platform === 'darwin' || process.platform === 'linux') {
    return existsSync('/usr/bin/git') ? '/usr/bin/git' : undefined;
  }
  return undefined;
}

/**
 * App-owned atomic composition seam.  A broker is constructed only when the
 * feature flag, admitted capability surface and native deny evidence all name
 * the exact same revision.  The executable is release/App-owned, never model
 * input or PATH lookup.
 */
export function composeAppGitBroker(input: {
  workspace: string;
  executable: string;
  config: AgentConfig;
  shellDenyEvidence: GitShellDenyEvidence;
}): GitBroker | undefined {
  const surface = input.config.executionCapabilitySurface;
  const qualification = qualifyBrokeredGitNativeDeny(input.shellDenyEvidence);
  if (
    !getFeatureFlags(input.config).brokeredGit ||
    !input.config.executionBoundary ||
    surface?.brokeredGitFeatureRevision !== BROKERED_GIT_FEATURE_REVISION_ ||
    !surface.gitInspect ||
    qualification.outcome !== 'qualified'
  ) {
    return undefined;
  }
  return createGitBroker({
    workspace: input.workspace,
    authorizedRepositoryRoot: input.config.executionBoundary.workspaceRoot,
    executable: input.executable,
    featureRevision: BROKERED_GIT_FEATURE_REVISION_,
    shellDenyEvidence: qualification.evidence,
    protectedPathEvaluator: createProtectedPathEvaluator({
      workspaceRoot: input.config.executionBoundary.workspaceRoot,
      mode: input.config.executionBoundary.protectedPathPolicy,
    }),
    processAdapter: createAppGitProcessAdapter(),
  });
}
