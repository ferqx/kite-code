import { existsSync } from 'node:fs';
import {
  createGitBrokerV1,
  type GitBrokerV1,
  qualifyBrokeredGitNativeDenyV1,
} from '@kite/builtin-runtime/git';
import { createProtectedPathEvaluatorV1 } from '@kite/builtin-runtime/sandbox';
import { BROKERED_GIT_FEATURE_REVISION_V1, type GitShellDenyEvidenceV1 } from '@kite/runtime-spi';
import { getFeatureFlags } from '#app/config/features';
import type { AgentConfig } from '#app/config/index';
import { createAppGitProcessAdapterV1 } from './process-adapter';

/** Release-owned executable selection. There is no PATH/model fallback. */
export function resolveAppGitExecutableV1(): string | undefined {
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
export function composeAppGitBrokerV1(input: {
  workspace: string;
  executable: string;
  config: AgentConfig;
  shellDenyEvidence: GitShellDenyEvidenceV1;
}): GitBrokerV1 | undefined {
  const surface = input.config.executionCapabilitySurface;
  const qualification = qualifyBrokeredGitNativeDenyV1(input.shellDenyEvidence);
  if (
    !getFeatureFlags(input.config).brokeredGitV1 ||
    !input.config.executionBoundary ||
    surface?.brokeredGitFeatureRevision !== BROKERED_GIT_FEATURE_REVISION_V1 ||
    !surface.gitInspect ||
    qualification.outcome !== 'qualified'
  ) {
    return undefined;
  }
  return createGitBrokerV1({
    workspace: input.workspace,
    authorizedRepositoryRoot: input.config.executionBoundary.workspaceRoot,
    executable: input.executable,
    featureRevision: BROKERED_GIT_FEATURE_REVISION_V1,
    shellDenyEvidence: qualification.evidence,
    protectedPathEvaluator: createProtectedPathEvaluatorV1({
      workspaceRoot: input.config.executionBoundary.workspaceRoot,
      mode: input.config.executionBoundary.protectedPathPolicy,
    }),
    processAdapter: createAppGitProcessAdapterV1(),
  });
}
