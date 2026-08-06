import { readdirSync, readFileSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { z } from 'zod';
import {
  type AgentFeatureQualificationSpecV1,
  buildQualificationConditionV1,
  buildQualificationSourceSurfaceV1,
  buildQualificationSuiteV1,
  compareCodePoint,
  computeQualificationSourceFactDigestV1,
  evaluateQualificationStructuralAssertionsV1,
  generateAgentFeatureQualificationMatrixV1,
  QUALIFICATION_CONTRACT_CODES_V1,
  QUALIFICATION_OWNER_IDS_V1,
  QUALIFICATION_RISK_RATIONALE_CODES_V1,
  type QualificationConditionV1,
  type QualificationEntrypointNotApplicableV1,
  type QualificationSourceRefV1,
  type QualificationSourceSurfaceV1,
  type QualificationSuiteSourceRefV1,
  qualificationSourceRefV1Schema,
  qualificationStructuralAssertionIdV1,
  qualificationSuiteSourceRefV1Schema,
} from '../../scripts/evals/contracts/qualification/feature-matrix';
import { L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1 } from '../../scripts/evals/contracts/qualification/l0-contract-adapter-v1';
import {
  buildL0EvaluatorIdentityV1,
  buildL0SourceOwnedBindingV1,
  L0_CONTRACT_ADAPTERS_V1,
  L0_CONTRACT_SUITE_ID_V1,
  L0_GOOD_BAD_CORPUS_V1,
  L0_MUTATION_CORPUS_V1,
  type L0SourceOwnedBindingV1,
  type L0SourceOwnedContractDeclarationV1,
  l0SourceOwnedContractDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l0-contract-schema-v1';
import {
  buildL1AutoCompactionFailureEvaluatorIdentityV1,
  buildL1AutoCompactionFailureSourceOwnedBindingV1,
  L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1,
  L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1,
  L1_AUTO_COMPACTION_FAILURE_CORPUS_V1,
  L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
  type L1AutoCompactionFailureSourceOwnedBindingV1,
  type L1AutoCompactionFailureSourceOwnedDeclarationV1,
  l1AutoCompactionFailureSourceOwnedDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-auto-compaction-failure-schema-v1';
import {
  buildL1PublicProjectionEvaluatorIdentityV1,
  buildL1PublicProjectionSourceOwnedBindingV1,
  L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_PUBLIC_PROJECTION_ADAPTERS_V1,
  L1_PUBLIC_PROJECTION_CORPUS_V1,
  L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
  L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
  L1_PUBLIC_PROJECTION_SUITE_ID_V1,
  type L1PublicProjectionSourceOwnedBindingV1,
  type L1PublicProjectionSourceOwnedDeclarationV1,
  l1PublicProjectionSourceOwnedDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-public-projection-schema-v1';
import {
  buildL1SkillMcpEvaluatorIdentityV1,
  buildL1SkillMcpSourceOwnedBindingV1,
  L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1,
  L1_SKILL_MCP_ADAPTERS_V1,
  L1_SKILL_MCP_CORPUS_V1,
  L1_SKILL_MCP_FIXTURE_ID_V1,
  L1_SKILL_MCP_RUNNER_ID_V1,
  L1_SKILL_MCP_SUITE_ID_V1,
  type L1SkillMcpSourceOwnedBindingV1,
  type L1SkillMcpSourceOwnedDeclarationV1,
  l1SkillMcpSourceOwnedDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1';
import {
  buildL1SubagentRecoveryEvaluatorIdentityV1,
  buildL1SubagentRecoverySourceOwnedBindingV1,
  L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1,
  L1_SUBAGENT_RECOVERY_ADAPTERS_V1,
  L1_SUBAGENT_RECOVERY_CORPUS_V1,
  L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
  L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
  L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
  type L1SubagentRecoverySourceOwnedBindingV1,
  type L1SubagentRecoverySourceOwnedDeclarationV1,
  l1SubagentRecoverySourceOwnedDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1';
import {
  buildL1SourceOwnedBindingV1,
  buildL1ToolVerificationEvaluatorIdentityV1,
  L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TOOL_VERIFICATION_ADAPTERS_V1,
  L1_TOOL_VERIFICATION_CORPUS_V1,
  L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
  L1_TOOL_VERIFICATION_RUNNER_ID_V1,
  L1_TOOL_VERIFICATION_SUITE_ID_V1,
  type L1SourceOwnedBindingV1,
  type L1SourceOwnedContractDeclarationV1,
  l1SourceOwnedContractDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-tool-verification-schema-v1';
import {
  buildL1TuiRewindForkProjectionEvaluatorIdentityV1,
  buildL1TuiRewindForkProjectionSourceOwnedBindingV1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1,
  L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
  L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
  type L1TuiRewindForkProjectionSourceOwnedBindingV1,
  type L1TuiRewindForkProjectionSourceOwnedDeclarationV1,
  l1TuiRewindForkProjectionSourceOwnedDeclarationV1Schema,
} from '../../scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1';
import { buildL2NativeConformanceEvaluatorV1 } from '../../scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1';
import {
  buildL2NativeConformanceSourceRegistryV1,
  buildL2NativeConformanceSuiteV1,
  L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
  type L2NativeConformanceCaseV1,
} from '../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import {
  CLI_COMMAND_SPECS_V1,
  CLI_FIRST_TOKEN_ALIASES_V1,
  CLI_OPTION_SPECS_V1,
  cliCommandSpecV1,
  cliOptionSpecV1,
} from '../../src/app/cli/public-surface';
import { SLASH_COMMAND_DEFS } from '../../src/app/tui/public-surface';
import {
  RELEASE_CAPABILITY_IDS_V1,
  type ReleaseCapabilityIdV1,
} from '../../src/core/config/capability-ids';
import { configSchema } from '../../src/core/config/config-schema';
import { FEATURE_FLAG_DEFINITIONS_V1, type FeatureFlagName } from '../../src/core/config/features';
import {
  EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
  SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1,
} from '../../src/core/config/release-surface-registry';
import { builtinToolRegistry, builtinToolSpecs } from '../../src/core/tools/registry/builtins';

const MATRIX_SUITE_ID = 'source-owned-surface-contract-v1';
const QUALIFICATION_REPOSITORY_ROOT = realpathSync(resolve(import.meta.dir, '../..'));
const STANDALONE_KEYRING_DISCLOSURE_SOURCE_REFS_V1 = [
  {
    kind: 'public_surface',
    ref: 'release/oss-first-release/KNOWN_LIMITATIONS.md',
  },
  {
    kind: 'public_surface',
    ref: 'release/oss-first-release/RELEASE_NOTES.md',
  },
] as const satisfies readonly QualificationSourceRefV1[];
const STANDALONE_KEYRING_ENTRYPOINT_ABSENCE_SOURCE_REFS_V1 = [
  {
    kind: 'public_surface',
    ref: 'src/app/cli/public-surface.ts#CLI_COMMAND_SPECS_V1',
  },
  {
    kind: 'public_surface',
    ref: 'src/app/cli/public-surface.ts#CLI_OPTION_SPECS_V1',
  },
  {
    kind: 'public_surface',
    ref: 'src/app/tui/public-surface.ts#SLASH_COMMAND_DEFS',
  },
] as const satisfies readonly QualificationSourceRefV1[];
const CREDENTIAL_SPECIFIC_PUBLIC_ENTRYPOINT_TOKEN_V1 =
  /(?:^|[^a-z0-9])(?:credential|credentials|keyring)(?:$|[^a-z0-9])/iu;

export interface SourceOwnedPublicCredentialEntrypointCandidateV1 {
  entrypoint: 'cli' | 'tui';
  kind: 'cli_command' | 'cli_option' | 'tui_slash_command';
  identifier: string;
  publicText: string;
}

/**
 * This derives from the data-only public CLI/TUI registries. A generic `/mcp`
 * manager is not itself a credential-specific public entrypoint; an explicit
 * credential/keyring token in a public identifier or help surface is.
 */
export function collectSourceOwnedPublicCredentialEntrypointCandidatesV1(): readonly SourceOwnedPublicCredentialEntrypointCandidateV1[] {
  return [
    ...CLI_COMMAND_SPECS_V1.map((command) => ({
      entrypoint: 'cli' as const,
      kind: 'cli_command' as const,
      identifier: command.command,
      publicText: [command.command, command.usage].join('\n'),
    })),
    ...CLI_OPTION_SPECS_V1.map((option) => ({
      entrypoint: 'cli' as const,
      kind: 'cli_option' as const,
      identifier: option.id,
      publicText: [option.id, option.flag, 'value' in option ? option.value : '', option.help].join(
        '\n',
      ),
    })),
    ...SLASH_COMMAND_DEFS.map((command) => ({
      entrypoint: 'tui' as const,
      kind: 'tui_slash_command' as const,
      identifier: command.name,
      publicText: [command.name, ...command.aliases, command.description, command.args ?? ''].join(
        '\n',
      ),
    })),
  ].sort((left, right) =>
    compareCodePoint(
      `${left.entrypoint}:${left.kind}:${left.identifier}`,
      `${right.entrypoint}:${right.kind}:${right.identifier}`,
    ),
  );
}

export function assertSourceOwnedNoCredentialPublicEntrypointsV1(
  candidates: readonly SourceOwnedPublicCredentialEntrypointCandidateV1[] = collectSourceOwnedPublicCredentialEntrypointCandidatesV1(),
): void {
  const exposed = candidates.find((candidate) =>
    CREDENTIAL_SPECIFIC_PUBLIC_ENTRYPOINT_TOKEN_V1.test(candidate.publicText),
  );
  if (exposed) {
    throw new Error(
      `qualification_standalone_keyring_public_credential_entrypoint_exposed:${exposed.entrypoint}:${exposed.kind}:${exposed.identifier}`,
    );
  }
}

function standaloneKeyringEntrypointNotApplicableV1(): QualificationEntrypointNotApplicableV1[] {
  const candidates = collectSourceOwnedPublicCredentialEntrypointCandidatesV1();
  assertSourceOwnedNoCredentialPublicEntrypointsV1(candidates);
  const sourceFiles = sourceFileFacts(
    QUALIFICATION_REPOSITORY_ROOT,
    STANDALONE_KEYRING_ENTRYPOINT_ABSENCE_SOURCE_REFS_V1,
  );
  return (['cli', 'tui'] as const).map((entrypoint) => ({
    entrypoint,
    rationale: 'entrypoint_not_exposed' as const,
    sourceFactDigest: computeQualificationSourceFactDigestV1({
      schema: 'SourceOwnedCredentialEntrypointAbsenceV1',
      version: 1,
      entrypoint,
      selector: 'credential_specific_public_entrypoint_v1',
      sourceFiles,
      publicEntrypoints: candidates.filter((candidate) => candidate.entrypoint === entrypoint),
    }),
  }));
}

/**
 * These are evaluator self-contract dependencies, not product Feature
 * bindings. They keep L0's deterministic corpus coupled to existing local
 * contracts without inventing a source-surface-to-Feature map or importing
 * legacy release evidence vocabulary.
 */
const L0_EVALUATOR_REUSED_CONTRACT_SOURCE_REFS_V1 = [
  {
    kind: 'evaluator_dependency',
    ref: 'scripts/evals/contracts/agent-task-case-schema.ts#parseAgentTaskCase',
  },
  {
    kind: 'evaluator_dependency',
    ref: 'scripts/evals/contracts/compaction-continuation.ts#compareSyntheticContinuation',
  },
  {
    kind: 'evaluator_dependency',
    ref: 'scripts/runtime/fault-soak-report.ts#RUNTIME_FAULT_SOAK_CASE_IDS',
  },
] as const;

/**
 * The collector only projects facts owned by product source. Its adapters carry
 * no defaults, route values, or hand-maintained product catalog entries: each
 * feature fact comes from a registry, schema, public declaration, or a digest
 * of the exact public operation source named by its sourceRefs.
 */
export function collectSourceOwnedQualificationSurfacesV1(
  root = process.cwd(),
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): QualificationSourceSurfaceV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const profiles = embeddedProfileIds();
  const surfaces: QualificationSourceSurfaceV1[] = [];
  const standaloneKeyringEntrypointNotApplicable = standaloneKeyringEntrypointNotApplicableV1();

  for (const spec of builtinToolSpecs) {
    const descriptor = builtinToolRegistry.descriptorOf(spec);
    const effects = Object.values(spec.declaredEffects).map(String);
    const risk = effects.some((value) => ['write', 'destructive', 'unknown'].includes(value))
      ? 'p0'
      : effects.some((value) => value !== 'none' && value !== 'read')
        ? 'p1'
        : 'p2';
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `builtin-tool:${spec.name}`,
        featureId: mechanicalFeatureId('TOOL', spec.name),
        domain: 'tool',
        observableContract: 'builtin_tool_registry',
        risk,
        riskRationale:
          risk === 'p0'
            ? 'destructive_or_unknown_tool_effect'
            : risk === 'p1'
              ? 'governed_runtime_boundary'
              : 'read_only_deterministic_tool',
        sourceRefs: [
          {
            kind: 'registry',
            ref: 'src/core/tools/registry/builtins.ts#builtinToolSpecs',
          },
          { kind: 'registry', ref: 'src/core/tools/registry/registry.ts#descriptorOf' },
        ],
        owner: 'core-tools',
        entrypoints: ['runtime'],
        releaseProfiles: profiles,
        sourceFact: {
          name: spec.name,
          kind: spec.kind,
          declaredEffects: spec.declaredEffects,
          minimumApproval: spec.minimumApproval,
          governanceRevision: spec.governanceRevision ?? null,
          inputSchema: jsonSnapshot(z.toJSONSchema(spec.inputSchema)),
          descriptor: jsonSnapshot(descriptor),
        },
      }),
    );
  }

  for (const [name, definition] of Object.entries(FEATURE_FLAG_DEFINITIONS_V1)) {
    const enabled = definition.defaultEnabled;
    const declaredOnly = definition.implementationState === 'declared_only';
    if (declaredOnly) assertDeclaredOnlyFeatureFlagHasNoProductConsumerV1(sourceRoot, name);
    const defaultOffBindings =
      !enabled && !declaredOnly ? discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(name) : [];
    const defaultOffSafeDisable =
      defaultOffBindings.length > 0 &&
      defaultOffBindings.every((binding) => binding.outcome === 'safe_disable');
    const entrypoints =
      defaultOffBindings.length > 0
        ? [...new Set(defaultOffBindings.map((binding) => binding.entrypointId))].sort(
            compareCodePoint,
          )
        : [...definition.configurationEntrypoints].sort(compareCodePoint);
    const sourceRefs: QualificationSourceRefV1[] = [
      { kind: 'config' as const, ref: 'src/core/config/features.ts#FEATURE_FLAG_DEFINITIONS_V1' },
      { kind: 'config' as const, ref: 'src/core/config/config-schema.ts#configSchema' },
      ...defaultOffBindings.map((binding) => binding.sourceRef),
    ].sort(sourceRefCompare);
    const defaultOffSafeDisableRequirements = defaultOffSafeDisable
      ? featureFlagDefaultOffSafeDisableConditions(name)
      : [];
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `feature-flag:${name}`,
        featureId: mechanicalFeatureId('FLAG', name),
        domain: 'config',
        observableContract: 'feature_flag_registry',
        risk: name.includes('Boundary') || name.includes('Policy') ? 'p0' : 'p1',
        riskRationale: 'feature_exposure_boundary',
        sourceRefs,
        owner: 'core-config',
        entrypoints,
        releaseProfiles: profiles,
        supportState:
          declaredOnly || (!enabled && !defaultOffSafeDisable) ? 'unsupported' : 'supported',
        declaredExposure:
          declaredOnly || (!enabled && !defaultOffSafeDisable)
            ? 'unsupported'
            : enabled
              ? 'default_on'
              : 'experimental_default_off',
        notApplicableRationale: declaredOnly
          ? 'source_not_supported'
          : !enabled && !defaultOffSafeDisable
            ? 'default_off_legacy_fallback'
            : undefined,
        featureFlags: [name],
        requiredWhen:
          enabled || declaredOnly || !defaultOffSafeDisable
            ? alwaysCondition()
            : featureFlagCondition(name, true),
        defaultOffSafeDisableRequirements,
        sourceFact: {
          name,
          defaultEnabled: definition.defaultEnabled,
          cliOverridePolicy: definition.cliOverridePolicy,
          configurationEntrypoints: definition.configurationEntrypoints,
          implementationState: definition.implementationState,
          defaultOffGuardOutcomes: defaultOffBindings.map((binding) => ({
            entrypointId: binding.entrypointId,
            outcome: binding.outcome,
            disabledResult: binding.disabledResult ?? null,
            sourceRef: binding.sourceRef,
          })),
        },
      }),
    );
  }

  const configSchemaJson = jsonSnapshot(z.toJSONSchema(configSchema));
  for (const entry of configSchemaPointers(configSchemaJson)) {
    const sourceSurfaceId = `config-schema:${entry.pointer.replaceAll('*', 'wildcard')}`;
    surfaces.push(
      sourceSurface({
        sourceSurfaceId,
        featureId: mechanicalFeatureId('CONFIG', sourceSurfaceId),
        domain: 'config',
        observableContract: 'config_schema',
        risk: configPointerRisk(entry.pointer),
        riskRationale: 'configuration_boundary',
        sourceRefs: [{ kind: 'config', ref: 'src/core/config/config-schema.ts#configSchema' }],
        owner: 'core-config',
        entrypoints: ['cli', 'tui', 'runtime'],
        releaseProfiles: profiles,
        sourceFact: { pointer: entry.pointer, schema: entry.schema },
      }),
    );
  }

  for (const command of CLI_COMMAND_SPECS_V1) {
    const commandSpec = cliCommandSpecV1(command.command);
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `cli-command:${command.command}`,
        featureId: mechanicalFeatureId('CLI', `command-${command.command}`),
        domain: 'cli',
        observableContract: 'cli_public_declaration',
        risk: command.command === 'run' ? 'p0' : 'p1',
        riskRationale: 'cli_entrypoint',
        sourceRefs: [
          { kind: 'public_surface', ref: 'src/app/cli/public-surface.ts#CLI_COMMAND_SPECS_V1' },
          { kind: 'public_surface', ref: 'src/app/cli/index.ts#parseArgs' },
        ],
        owner: 'app-cli',
        entrypoints: ['cli'],
        releaseProfiles: profiles,
        routeClasses: [`cli-command:${command.command}`],
        supportState: commandSpec.supportState,
        declaredExposure: commandSpec.declaredExposure,
        notApplicableRationale: commandSpec.notApplicableRationale,
        requiredWhen:
          commandSpec.supportState === 'unsupported'
            ? entryRejectionCondition('cli', 'legacy_resume_rejected')
            : alwaysCondition(),
        sourceFact: {
          command,
          firstTokenAliases: command.command === 'help' ? CLI_FIRST_TOKEN_ALIASES_V1 : [],
        },
      }),
    );
  }
  for (const option of CLI_OPTION_SPECS_V1) {
    const optionSpec = cliOptionSpecV1(option.id);
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `cli-option:${option.id}`,
        featureId: mechanicalFeatureId('CLI', `option-${option.id}`),
        domain: 'cli',
        observableContract: 'cli_public_declaration',
        risk: ['workspace', 'noSandbox', 'fullAccess', 'trustWorkspace'].includes(option.id)
          ? 'p0'
          : 'p1',
        riskRationale: 'cli_entrypoint',
        sourceRefs: [
          { kind: 'public_surface', ref: 'src/app/cli/public-surface.ts#CLI_OPTION_SPECS_V1' },
          { kind: 'public_surface', ref: 'src/app/cli/index.ts#parseArgs' },
        ],
        owner: 'app-cli',
        entrypoints: ['cli'],
        releaseProfiles: profiles,
        routeClasses:
          'bootstrapOnly' in option && option.bootstrapOnly
            ? ['cli-bootstrap']
            : option.commands.map((command) => `cli-command:${command}`),
        supportState: optionSpec.supportState,
        declaredExposure: optionSpec.declaredExposure,
        notApplicableRationale: optionSpec.notApplicableRationale,
        requiredWhen:
          optionSpec.supportState === 'unsupported'
            ? entryRejectionCondition('cli', 'legacy_resume_rejected')
            : alwaysCondition(),
        sourceFact: option,
      }),
    );
  }

  for (const command of [...SLASH_COMMAND_DEFS].sort((left, right) =>
    compareCodePoint(left.name, right.name),
  )) {
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `tui-command:${command.name}`,
        featureId: mechanicalFeatureId('TUI', `slash-${command.name}`),
        domain: 'tui',
        observableContract: 'tui_slash_command',
        risk: ['permissions', 'rewind', 'mcp', 'compact'].includes(command.name) ? 'p0' : 'p1',
        riskRationale: 'tui_control_surface',
        sourceRefs: [
          {
            kind: 'public_surface',
            ref: 'src/app/tui/public-surface.ts#SLASH_COMMAND_DEFS',
          },
          { kind: 'public_surface', ref: 'src/app/tui/public-surface.ts#parseSlashCommand' },
          { kind: 'public_surface', ref: 'src/app/tui/components/HelpPanel.tsx#HelpPanel' },
        ],
        owner: 'app-tui',
        entrypoints: ['tui'],
        releaseProfiles: profiles,
        sourceFact: {
          name: command.name,
          aliases: [...command.aliases],
          description: command.description,
          args: command.args ?? null,
        },
      }),
    );
  }

  for (const capability of RELEASE_CAPABILITY_IDS_V1) {
    surfaces.push(releaseCapabilitySurface(capability, profiles));
  }
  for (const profile of EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1) {
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `release-profile:${profile.profileId}`,
        featureId: mechanicalFeatureId('RELEASE', `profile-${profile.profileId}`),
        domain: 'release',
        observableContract: 'embedded_release_profile',
        risk: 'p0',
        riskRationale: 'release_profile_ceiling',
        sourceRefs: [
          {
            kind: 'registry',
            ref: 'src/core/config/release-surface-registry.ts#EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1',
          },
          {
            kind: 'contract',
            ref: 'src/core/config/release-profile.ts#EMBEDDED_RELEASE_PROFILES_V1',
          },
        ],
        owner: 'release-platform',
        entrypoints: ['cli', 'tui', 'runtime'],
        releaseProfiles: [profile.profileId],
        declaredExposure: 'disabled',
        requiredWhen: entryRejectionCondition('runtime', 'release_profile_closed'),
        sourceFact: profile,
      }),
    );
  }
  for (const target of Object.values(PRODUCTION_DISTRIBUTION_TARGETS_V1)) {
    const l2NativeCases = L2_NATIVE_CONFORMANCE_CASES_V1.filter(
      (candidate) =>
        candidate.target.distributionTargetId === target.identity &&
        candidate.capabilityId !== 'standalone_keyring_unavailable',
    );
    surfaces.push(
      sourceSurface({
        sourceSurfaceId: `distribution-target:${target.identity}`,
        featureId: mechanicalFeatureId('RELEASE', `distribution-${target.identity}`),
        domain: 'release',
        observableContract: 'distribution_target_registry',
        risk: 'p1',
        riskRationale: 'distribution_scope',
        sourceRefs: [
          {
            kind: 'registry',
            ref: 'src/core/config/release-surface-registry.ts#PRODUCTION_DISTRIBUTION_TARGETS_V1',
          },
        ],
        owner: 'release-platform',
        entrypoints: ['cli', 'installer', 'runtime', 'tui'],
        releaseProfiles: profiles,
        platforms: [target.platform],
        l2NativeCases,
        sourceFact: target,
      }),
    );
  }
  surfaces.push(
    sourceSurface({
      sourceSurfaceId: 'standalone-keyring:unavailable',
      featureId: mechanicalFeatureId('RELEASE', 'standalone-keyring-unavailable'),
      domain: 'release',
      observableContract: 'standalone_keyring_unavailable',
      risk: 'p0',
      riskRationale: 'execution_isolation',
      sourceRefs: [
        {
          kind: 'contract',
          ref: 'src/app/release/standalone-keyring-unavailable.ts#AsyncEntry',
        },
        {
          kind: 'contract',
          ref: 'scripts/release/oss-candidate.ts#createStandaloneReleaseStubsV1',
        },
        ...STANDALONE_KEYRING_DISCLOSURE_SOURCE_REFS_V1,
        ...STANDALONE_KEYRING_ENTRYPOINT_ABSENCE_SOURCE_REFS_V1,
      ],
      owner: 'release-platform',
      entrypoints: ['runtime'],
      entrypointNotApplicable: standaloneKeyringEntrypointNotApplicable,
      releaseProfiles: profiles,
      platforms: ['macos', 'linux', 'windows'],
      l2NativeCases: L2_NATIVE_CONFORMANCE_CASES_V1.filter(
        (candidate) => candidate.capabilityId === 'standalone_keyring_unavailable',
      ),
      sourceFact: {
        source: 'standalone-keyring-unavailable-v1',
        candidateResolver: 'createStandaloneReleaseStubsV1',
        disclosureDocuments: STANDALONE_KEYRING_DISCLOSURE_SOURCE_REFS_V1.map(({ ref }) => ref),
        entrypointNotApplicable: standaloneKeyringEntrypointNotApplicable,
      },
    }),
  );
  surfaces.push(
    sourceSurface({
      sourceSurfaceId: 'execution-support:effectful-targets',
      featureId: 'SANDBOX-EFFECTFUL_EXECUTION-001',
      domain: 'sandbox',
      observableContract: 'effectful_execution_target_registry',
      risk: 'p0',
      riskRationale: 'execution_isolation',
      sourceRefs: [
        {
          kind: 'registry',
          ref: 'src/core/config/release-surface-registry.ts#SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1',
        },
      ],
      owner: 'release-platform',
      entrypoints: ['cli', 'tui', 'runtime'],
      releaseProfiles: profiles,
      declaredExposure:
        SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1.length === 0 ? 'disabled' : 'default_on',
      requiredWhen: entryRejectionCondition('runtime', 'unadmitted_execution_target'),
      sourceFact: { targets: [...SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1] },
    }),
  );

  for (const binding of publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot)) {
    surfaces.push(
      sourceSurface({
        ...binding,
        releaseProfiles: profiles,
        sourceFact: binding.declaration,
      }),
    );
  }
  for (const relativePath of discoverSourceOwnedPublicDocumentationPathsV1(sourceRoot)) {
    surfaces.push(publicDocumentationSurfaceV1(relativePath, profiles));
  }
  return surfaces.sort((left, right) =>
    compareCodePoint(left.sourceSurfaceId, right.sourceSurfaceId),
  );
}

/**
 * An AQ-7 binding is derived from a source-owned Feature requirement. The
 * native runner and specialized verifier consume this projection instead of
 * recreating a target-to-feature map outside the catalog.
 */
export interface SourceOwnedL2NativeConformanceBindingV1 {
  sourceSurfaceId: string;
  sourceDigest: `sha256:${string}`;
  featureId: string;
  assertionId: string;
  case: L2NativeConformanceCaseV1;
}

export function assertSourceOwnedL2NativeConformanceBindingProvenanceV1(
  bindings: readonly SourceOwnedL2NativeConformanceBindingV1[],
): void {
  if (bindings.length !== L2_NATIVE_CONFORMANCE_CASES_V1.length) {
    throw new Error('qualification_l2_native_source_binding_inventory_incomplete');
  }
  for (const [index, binding] of bindings.entries()) {
    const expectedCase = L2_NATIVE_CONFORMANCE_CASES_V1[index];
    if (
      !expectedCase ||
      binding.assertionId !== expectedCase.caseId ||
      JSON.stringify(binding.case) !== JSON.stringify(expectedCase)
    ) {
      throw new Error('qualification_l2_native_source_binding_inventory_incomplete');
    }
    const expectedSourceSurfaceId =
      expectedCase.capabilityId === 'standalone_keyring_unavailable'
        ? 'standalone-keyring:unavailable'
        : `distribution-target:${expectedCase.target.distributionTargetId}`;
    const expectedFeatureId =
      expectedCase.capabilityId === 'standalone_keyring_unavailable'
        ? mechanicalFeatureId('RELEASE', 'standalone-keyring-unavailable')
        : mechanicalFeatureId(
            'RELEASE',
            `distribution-${expectedCase.target.distributionTargetId}`,
          );
    if (
      binding.sourceSurfaceId !== expectedSourceSurfaceId ||
      binding.featureId !== expectedFeatureId
    ) {
      throw new Error(`qualification_l2_native_source_binding_mismatch:${binding.assertionId}`);
    }
  }
}

export function discoverSourceOwnedL2NativeConformanceBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  sourceSurfaces?: readonly QualificationSourceSurfaceV1[],
): SourceOwnedL2NativeConformanceBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (sourceSurfaces ?? collectSourceOwnedQualificationSurfacesV1(sourceRoot))
    .flatMap((surface) =>
      surface.feature.requiredEvidence
        .filter(
          (requirement) =>
            requirement.layer === 'native' &&
            requirement.suiteIds.includes(L2_NATIVE_CONFORMANCE_SUITE_ID_V1),
        )
        .flatMap((requirement) =>
          requirement.assertionIds.map((assertionId) => {
            const nativeCase = L2_NATIVE_CONFORMANCE_CASES_V1.find(
              (candidate) => candidate.caseId === assertionId,
            );
            if (!nativeCase) {
              throw new Error(`qualification_l2_native_source_binding_case_unknown:${assertionId}`);
            }
            return {
              sourceSurfaceId: surface.sourceSurfaceId,
              sourceDigest: surface.sourceDigest as `sha256:${string}`,
              featureId: surface.feature.id,
              assertionId,
              case: nativeCase,
            };
          }),
        ),
    )
    .sort((left, right) => compareCodePoint(left.assertionId, right.assertionId));
  assertSourceOwnedL2NativeConformanceBindingProvenanceV1(bindings);
  return bindings;
}

export function createSourceOwnedQualificationCatalogV1(root = process.cwd()) {
  const sourceRoot = qualificationRepositoryRoot(root);
  const publicOperations = discoverSourceOwnedPublicOperationsV1(sourceRoot);
  const sourceSurfaces = collectSourceOwnedQualificationSurfacesV1(sourceRoot, publicOperations);
  const conditions = qualificationConditions(sourceSurfaces).sort((left, right) =>
    compareCodePoint(left.conditionId, right.conditionId),
  );
  const assertionIds = evaluateQualificationStructuralAssertionsV1(sourceSurfaces, conditions)
    .map(({ assertionId }) => assertionId)
    .sort(compareCodePoint)
    .filter((assertionId, index, values) => index === 0 || values[index - 1] !== assertionId);
  const suiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/feature-matrix.ts#evaluateQualificationStructuralAssertionsV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    { kind: 'corpus', ref: 'tests/evals/qualification/feature-matrix.test.ts#fixture' },
    { kind: 'test', ref: 'tests/evals/qualification/feature-matrix.test.ts' },
  ];
  suiteRefs.sort(suiteSourceRefCompare);
  const sourceFacts = sourceFileFacts(sourceRoot, suiteRefs);
  const l0Bindings = discoverSourceOwnedL0ContractBindingsV1(sourceRoot, publicOperations);
  const l0SuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l0-contract-schema-v1.ts#L0_GOOD_BAD_CORPUS_V1',
    },
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l0-contract-schema-v1.ts#L0_MUTATION_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts#runL0ContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts#L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l0-contract-evaluator-v1.ts#evaluateL0ContractCorpusV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/contract-adapter.test.ts',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/evaluator.test.ts',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL0ContractEvidenceV1',
    },
  ];
  l0SuiteRefs.sort(suiteSourceRefCompare);
  const l0SourceFacts = sourceFileFacts(sourceRoot, [
    ...l0SuiteRefs,
    ...l0Bindings.map((binding) => binding.sourceRef),
    ...L0_EVALUATOR_REUSED_CONTRACT_SOURCE_REFS_V1,
  ]);
  const l0Fact = (ref: string) => {
    const sourceFact = l0SourceFacts.find((candidate) => candidate.ref === ref);
    if (!sourceFact) throw new Error(`qualification_l0_source_fact_missing:${ref}`);
    return sourceFact;
  };
  const l0Evaluator = buildL0EvaluatorIdentityV1({
    oracle: {
      sourceFact: l0Fact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l0Bindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l0Fact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL0ContractEvidenceV1',
      ),
    },
    adapterDependency: {
      adapterSourceFact: l0Fact(
        'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts#runL0ContractCorpusV1',
      ),
      implementationProvenanceSourceFact: l0Fact(
        'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts#L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l0Bindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l0Fact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
      reusedEvaluatorContracts: L0_EVALUATOR_REUSED_CONTRACT_SOURCE_REFS_V1.map((sourceRef) => ({
        ref: sourceRef.ref,
        sourceFact: l0Fact(sourceRef.ref),
      })),
    },
    runnerDependency: {
      fixtureId: 'l0-contract-fixture-v1',
      runner: 'qualification-l0-contract-runner-v1',
      runnerSourceFact: l0Fact(
        'scripts/evals/contracts/qualification/l0-contract-adapter-v1.ts#runL0ContractCorpusV1',
      ),
    },
  });
  const l1Bindings = discoverSourceOwnedL1ToolVerificationBindingsV1(sourceRoot, publicOperations);
  const l1SuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-tool-verification-schema-v1.ts#L1_TOOL_VERIFICATION_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tool-verification-adapter-v1.ts#runL1ToolVerificationContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tool-verification-schema-v1.ts#L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tool-verification-evaluator-v1.ts#evaluateL1ToolVerificationCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tool-verification-evidence-v1.ts#buildL1ToolVerificationReceiptV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/runtime-tool-verification.test.ts',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1ToolVerificationEvidenceV1',
    },
  ];
  l1SuiteRefs.sort(suiteSourceRefCompare);
  const l1ProductDependencyRefs: QualificationSourceRefV1[] = [
    { kind: 'contract', ref: 'src/core/runtime/scheduler.ts#decideNextEffect' },
  ];
  const l1SourceFacts = sourceFileFacts(sourceRoot, [
    ...l1SuiteRefs,
    ...l1Bindings.map((binding) => binding.sourceRef),
    ...l1ProductDependencyRefs,
  ]);
  const l1Fact = (ref: string) => {
    const sourceFact = l1SourceFacts.find((candidate) => candidate.ref === ref);
    if (!sourceFact) throw new Error(`qualification_l1_source_fact_missing:${ref}`);
    return sourceFact;
  };
  const l1Evaluator = buildL1ToolVerificationEvaluatorIdentityV1({
    oracle: {
      sourceFact: l1Fact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l1Bindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l1Fact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1ToolVerificationEvidenceV1',
      ),
    },
    runner: {
      fixtureId: L1_TOOL_VERIFICATION_FIXTURE_ID_V1,
      runner: L1_TOOL_VERIFICATION_RUNNER_ID_V1,
      runnerSourceFact: l1Fact(
        'scripts/evals/contracts/qualification/l1-tool-verification-adapter-v1.ts#runL1ToolVerificationContractCorpusV1',
      ),
      implementationProvenanceSourceFact: l1Fact(
        'scripts/evals/contracts/qualification/l1-tool-verification-schema-v1.ts#L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l1Bindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l1Fact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
    },
    scheduler: {
      sourceFact: l1Fact('src/core/runtime/scheduler.ts#decideNextEffect'),
      clock: 'fixed-fixture-clock-v1',
    },
    faultInjection: {
      sourceFact: l1Fact(
        'scripts/evals/contracts/qualification/l1-tool-verification-adapter-v1.ts#runL1ToolVerificationContractCorpusV1',
      ),
      scenarios: ['approval-rejection-v1', 'late-terminal-v1', 'bounded-cleanup-v1'],
    },
  });
  const l1AutoCompactionFailureBindings = discoverSourceOwnedL1AutoCompactionFailureBindingsV1(
    sourceRoot,
    publicOperations,
  );
  const l1AutoCompactionFailureSuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-auto-compaction-failure-schema-v1.ts#L1_AUTO_COMPACTION_FAILURE_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-auto-compaction-failure-adapter-v1.ts#runL1AutoCompactionFailureContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-auto-compaction-failure-schema-v1.ts#L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-auto-compaction-failure-evaluator-v1.ts#evaluateL1AutoCompactionFailureCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-auto-compaction-failure-evidence-v1.ts#buildL1AutoCompactionFailureReceiptV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    { kind: 'test', ref: 'tests/evals/qualification/auto-compaction-failure-contract.test.ts' },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1AutoCompactionFailureEvidenceV1',
    },
  ];
  l1AutoCompactionFailureSuiteRefs.sort(suiteSourceRefCompare);
  const l1AutoCompactionFailureProductDependencyRefs: QualificationSourceRefV1[] = [
    {
      kind: 'contract',
      ref: 'src/core/controllers/compaction-controller.ts#executeContextCompaction',
    },
    { kind: 'contract', ref: 'src/core/controllers/model-controller.ts#invokeRuntimeModel' },
    {
      kind: 'contract',
      ref: 'src/core/model/context-compaction-decision.ts#decideAutomaticContextCompaction',
    },
    {
      kind: 'contract',
      ref: 'src/core/model/compaction-summary.ts#createNarrativeContextCompactor',
    },
    { kind: 'contract', ref: 'src/core/runtime/executor.ts#createRuntimeEffectExecutor' },
    { kind: 'contract', ref: 'src/core/runtime/reducer.ts#reduceRuntimeState' },
    { kind: 'contract', ref: 'src/core/runtime/runner.ts#runRuntimeLoop' },
    { kind: 'contract', ref: 'src/core/runtime/scheduler.ts#decideNextEffect' },
  ];
  l1AutoCompactionFailureProductDependencyRefs.sort(sourceRefCompare);
  const l1AutoCompactionFailureSourceFacts = sourceFileFacts(sourceRoot, [
    ...l1AutoCompactionFailureSuiteRefs,
    ...l1AutoCompactionFailureBindings.map((binding) => binding.sourceRef),
    ...l1AutoCompactionFailureProductDependencyRefs,
  ]);
  const l1AutoCompactionFailureEvaluator = buildL1AutoCompactionFailureEvaluatorIdentityV1();
  const l1ProjectionBindings = discoverSourceOwnedL1PublicProjectionBindingsV1(
    sourceRoot,
    publicOperations,
  );
  const l1ProjectionSuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-public-projection-schema-v1.ts#L1_PUBLIC_PROJECTION_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts#runL1PublicProjectionContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-public-projection-schema-v1.ts#L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts#buildL1PublicProjectionReceiptV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-public-projection-evaluator-v1.ts#evaluateL1PublicProjectionCorpusV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/public-projection-adapter.test.ts',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1PublicProjectionEvidenceV1',
    },
  ];
  l1ProjectionSuiteRefs.sort(suiteSourceRefCompare);
  const l1ProjectionProductDependencyRefs: QualificationSourceRefV1[] = [
    { kind: 'contract', ref: 'src/app/tui/initialState.ts#createInitialState' },
    { kind: 'contract', ref: 'src/core/runtime/terminal-outcome.ts#completedTerminalOutcomeV1' },
  ];
  const l1ProjectionSourceFacts = sourceFileFacts(sourceRoot, [
    ...l1ProjectionSuiteRefs,
    ...l1ProjectionBindings.map((binding) => binding.sourceRef),
    ...l1ProjectionProductDependencyRefs,
  ]);
  const l1ProjectionFact = (ref: string) => {
    const sourceFact = l1ProjectionSourceFacts.find((candidate) => candidate.ref === ref);
    if (!sourceFact) throw new Error('qualification_l1_projection_source_fact_missing:' + ref);
    return sourceFact;
  };
  const l1ProjectionEvaluator = buildL1PublicProjectionEvaluatorIdentityV1({
    oracle: {
      sourceFact: l1ProjectionFact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l1ProjectionBindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l1ProjectionFact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1PublicProjectionEvidenceV1',
      ),
    },
    runner: {
      fixtureId: L1_PUBLIC_PROJECTION_FIXTURE_ID_V1,
      runner: L1_PUBLIC_PROJECTION_RUNNER_ID_V1,
      runnerSourceFact: l1ProjectionFact(
        'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts#runL1PublicProjectionContractCorpusV1',
      ),
      implementationProvenanceSourceFact: l1ProjectionFact(
        'scripts/evals/contracts/qualification/l1-public-projection-schema-v1.ts#L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l1ProjectionBindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l1ProjectionFact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
    },
    scheduler: {
      cliProjectionSourceFact: l1ProjectionFact(
        'src/app/cli/runtime-event-projection.ts#projectCliRuntimeEventV1',
      ),
      tuiProjectionSourceFact: l1ProjectionFact(
        'src/app/tui/reducers/handleEvent.ts#handleRuntimeEventAction',
      ),
      initialStateSourceFact: l1ProjectionFact('src/app/tui/initialState.ts#createInitialState'),
      terminalOutcomeSourceFact: l1ProjectionFact(
        'src/core/runtime/terminal-outcome.ts#completedTerminalOutcomeV1',
      ),
    },
  });
  const l1SkillMcpBindings = discoverSourceOwnedL1SkillMcpBindingsV1(sourceRoot, publicOperations);
  const l1SkillMcpSuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1.ts#L1_SKILL_MCP_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts#runL1SkillMcpContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts#runL1SkillMcpAdaptersV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1.ts#L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-evaluator-v1.ts#evaluateL1SkillMcpCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-skill-mcp-evidence-v1.ts#buildL1SkillMcpReceiptV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/runtime-skill-mcp.test.ts',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1SkillMcpEvidenceV1',
    },
  ];
  l1SkillMcpSuiteRefs.sort(suiteSourceRefCompare);
  const l1SkillMcpSourceFacts = sourceFileFacts(sourceRoot, [
    ...l1SkillMcpSuiteRefs,
    ...l1SkillMcpBindings.map((binding) => binding.sourceRef),
  ]);
  const l1SkillMcpFact = (ref: string) => {
    const sourceFact = l1SkillMcpSourceFacts.find((candidate) => candidate.ref === ref);
    if (!sourceFact) throw new Error(`qualification_l1_skill_mcp_source_fact_missing:${ref}`);
    return sourceFact;
  };
  const l1SkillMcpEvaluator = buildL1SkillMcpEvaluatorIdentityV1({
    oracle: {
      sourceFact: l1SkillMcpFact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l1SkillMcpBindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l1SkillMcpFact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1SkillMcpEvidenceV1',
      ),
    },
    runner: {
      fixtureId: L1_SKILL_MCP_FIXTURE_ID_V1,
      runner: L1_SKILL_MCP_RUNNER_ID_V1,
      runnerSourceFact: l1SkillMcpFact(
        'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts#runL1SkillMcpContractCorpusV1',
      ),
      adaptersSourceFact: l1SkillMcpFact(
        'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts#runL1SkillMcpAdaptersV1',
      ),
      implementationProvenanceSourceFact: l1SkillMcpFact(
        'scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1.ts#L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l1SkillMcpBindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l1SkillMcpFact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
    },
    scheduler: { clock: 'fixed-fixture-clock-v1' },
    faultInjection: {
      sourceFact: l1SkillMcpFact(
        'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts#runL1SkillMcpAdaptersV1',
      ),
      scenarios: [
        'invalid-provider-auth-v1',
        'catalog-revision-churn-v1',
        'unknown-write-reconciliation-v1',
        'skill-mcp-dependency-revision-drift-v1',
      ],
    },
  });
  const l1SubagentRecoveryBindings = discoverSourceOwnedL1SubagentRecoveryBindingsV1(
    sourceRoot,
    publicOperations,
  );
  const l1SubagentRecoverySuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1.ts#L1_SUBAGENT_RECOVERY_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1.ts#runL1SubagentRecoveryContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1.ts#runL1SubagentRecoveryAdaptersV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1.ts#L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-evaluator-v1.ts#evaluateL1SubagentRecoveryCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-subagent-recovery-evidence-v1.ts#buildL1SubagentRecoveryReceiptV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    { kind: 'test', ref: 'tests/evals/qualification/runtime-subagent-recovery.test.ts' },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1SubagentRecoveryEvidenceV1',
    },
  ];
  l1SubagentRecoverySuiteRefs.sort(suiteSourceRefCompare);
  const l1SubagentRecoveryProductDependencyRefs: QualificationSourceRefV1[] = [
    {
      kind: 'contract',
      ref: 'src/core/runtime/resource-budget-admission.ts#createDescendantResourceAdmissionV1',
    },
    { kind: 'contract', ref: 'src/core/runtime/reducer.ts#reduceRuntimeState' },
    { kind: 'public_surface', ref: 'src/app/tui/hooks/useRewindHandler.ts#useRunRewind' },
  ];
  const l1SubagentRecoverySourceFacts = sourceFileFacts(sourceRoot, [
    ...l1SubagentRecoverySuiteRefs,
    ...l1SubagentRecoveryBindings.map((binding) => binding.sourceRef),
    ...l1SubagentRecoveryProductDependencyRefs,
  ]);
  const l1SubagentRecoveryFact = (ref: string) => {
    const sourceFact = l1SubagentRecoverySourceFacts.find((candidate) => candidate.ref === ref);
    if (!sourceFact)
      throw new Error(`qualification_l1_subagent_recovery_source_fact_missing:${ref}`);
    return sourceFact;
  };
  const l1SubagentRecoveryEvaluator = buildL1SubagentRecoveryEvaluatorIdentityV1({
    oracle: {
      sourceFact: l1SubagentRecoveryFact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l1SubagentRecoveryBindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l1SubagentRecoveryFact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1SubagentRecoveryEvidenceV1',
      ),
    },
    runner: {
      fixtureId: L1_SUBAGENT_RECOVERY_FIXTURE_ID_V1,
      runner: L1_SUBAGENT_RECOVERY_RUNNER_ID_V1,
      runnerSourceFact: l1SubagentRecoveryFact(
        'scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1.ts#runL1SubagentRecoveryContractCorpusV1',
      ),
      adaptersSourceFact: l1SubagentRecoveryFact(
        'scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1.ts#runL1SubagentRecoveryAdaptersV1',
      ),
      implementationProvenanceSourceFact: l1SubagentRecoveryFact(
        'scripts/evals/contracts/qualification/l1-subagent-recovery-schema-v1.ts#L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l1SubagentRecoveryBindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l1SubagentRecoveryFact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
    },
    scheduler: {
      descendantAdmissionSourceFact: l1SubagentRecoveryFact(
        'src/core/runtime/resource-budget-admission.ts#createDescendantResourceAdmissionV1',
      ),
      reducerSourceFact: l1SubagentRecoveryFact('src/core/runtime/reducer.ts#reduceRuntimeState'),
      rewindProjectionSourceFact: l1SubagentRecoveryFact(
        'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
      ),
      clock: 'fixed-fixture-clock-v1',
    },
    faultInjection: {
      sourceFact: l1SubagentRecoveryFact(
        'scripts/evals/contracts/qualification/l1-subagent-recovery-adapter-v1.ts#runL1SubagentRecoveryAdaptersV1',
      ),
      scenarios: [
        'parent-reservation-before-dispatch-v1',
        'approved-continuation-claim-v1',
        'child-dispatch-unknown-recovery-v1',
        'late-terminal-noop-v1',
        'parallel-cancel-convergence-v1',
        'rewind-fork-tightening-v1',
      ],
    },
  });
  const l1TuiRewindForkProjectionBindings = discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1(
    sourceRoot,
    publicOperations,
  );
  const l1TuiRewindForkProjectionSuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1.ts#L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionContractCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionAdaptersV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1.ts#L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-evaluator-v1.ts#evaluateL1TuiRewindForkProjectionCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l1-tui-rewind-projection-evidence-v1.ts#buildL1TuiRewindForkProjectionReceiptV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    { kind: 'test', ref: 'tests/evals/qualification/tui-rewind-projection.test.ts' },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1TuiRewindForkProjectionEvidenceV1',
    },
  ];
  l1TuiRewindForkProjectionSuiteRefs.sort(suiteSourceRefCompare);
  const l1TuiRewindForkProjectionProductDependencyRefs: QualificationSourceRefV1[] = [
    {
      kind: 'public_surface',
      ref: 'src/app/tui/hooks/useRewindHandler.ts#dispatchTuiRewindRequest',
    },
    { kind: 'public_surface', ref: 'src/app/tui/hooks/useRewindHandler.ts#useRunRewind' },
    { kind: 'public_surface', ref: 'src/app/tui/hooks/useSlashCommand.ts#useSlashCommand' },
    { kind: 'public_surface', ref: 'src/app/tui/public-surface.ts#parseSlashCommand' },
    { kind: 'contract', ref: 'src/core/runtime/store.ts#forkSession' },
  ];
  l1TuiRewindForkProjectionProductDependencyRefs.sort(sourceRefCompare);
  const l1TuiRewindForkProjectionSourceFacts = sourceFileFacts(sourceRoot, [
    ...l1TuiRewindForkProjectionSuiteRefs,
    ...l1TuiRewindForkProjectionBindings.map((binding) => binding.sourceRef),
    ...l1TuiRewindForkProjectionProductDependencyRefs,
  ]);
  const l1TuiRewindForkProjectionFact = (ref: string) => {
    const sourceFact = l1TuiRewindForkProjectionSourceFacts.find(
      (candidate) => candidate.ref === ref,
    );
    if (!sourceFact) {
      throw new Error(`qualification_l1_tui_rewind_fork_projection_source_fact_missing:${ref}`);
    }
    return sourceFact;
  };
  const l1TuiRewindForkProjectionEvaluator = buildL1TuiRewindForkProjectionEvaluatorIdentityV1({
    oracle: {
      sourceFact: l1TuiRewindForkProjectionFact(
        'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
      ),
      sourceSurfaceIds: l1TuiRewindForkProjectionBindings.map((binding) => binding.sourceSurfaceId),
    },
    verifier: {
      sourceFact: l1TuiRewindForkProjectionFact(
        'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL1TuiRewindForkProjectionEvidenceV1',
      ),
    },
    runner: {
      fixtureId: L1_TUI_REWIND_FORK_PROJECTION_FIXTURE_ID_V1,
      runner: L1_TUI_REWIND_FORK_PROJECTION_RUNNER_ID_V1,
      runnerSourceFact: l1TuiRewindForkProjectionFact(
        'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionContractCorpusV1',
      ),
      adaptersSourceFact: l1TuiRewindForkProjectionFact(
        'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionAdaptersV1',
      ),
      implementationProvenanceSourceFact: l1TuiRewindForkProjectionFact(
        'scripts/evals/contracts/qualification/l1-tui-rewind-projection-schema-v1.ts#L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1',
      ),
      bindings: l1TuiRewindForkProjectionBindings.map((binding) => ({
        sourceSurfaceId: binding.sourceSurfaceId,
        featureId: binding.featureId,
        sourceRef: binding.sourceRef.ref,
        sourceFact: l1TuiRewindForkProjectionFact(binding.sourceRef.ref),
        binding: binding.binding,
      })),
    },
    scheduler: {
      parseSlashCommandSourceFact: l1TuiRewindForkProjectionFact(
        'src/app/tui/public-surface.ts#parseSlashCommand',
      ),
      slashCommandSourceFact: l1TuiRewindForkProjectionFact(
        'src/app/tui/hooks/useSlashCommand.ts#useSlashCommand',
      ),
      dispatchTuiRewindRequestSourceFact: l1TuiRewindForkProjectionFact(
        'src/app/tui/hooks/useRewindHandler.ts#dispatchTuiRewindRequest',
      ),
      useRunRewindSourceFact: l1TuiRewindForkProjectionFact(
        'src/app/tui/hooks/useRewindHandler.ts#useRunRewind',
      ),
      forkSessionSourceFact: l1TuiRewindForkProjectionFact('src/core/runtime/store.ts#forkSession'),
    },
    isolation: {
      sourceFact: l1TuiRewindForkProjectionFact(
        'scripts/evals/contracts/qualification/l1-tui-rewind-projection-adapter-v1.ts#runL1TuiRewindForkProjectionAdaptersV1',
      ),
      fixtureRoot: 'fresh-private-temporary-root-v1',
      network: 'not-used-v1',
      process: 'not-used-v1',
      provider: 'not-used-v1',
    },
  });
  /**
   * AQ-7 projects the native corpus from the same product-owned target and
   * support registries as the candidate builder. The collector only records
   * their digests and exact source-surface bindings; it never supplies a
   * second target list or any native execution result.
   */
  const l2NativeConformanceSuiteRefs: QualificationSuiteSourceRefV1[] = [
    {
      kind: 'corpus',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts#L2_NATIVE_CONFORMANCE_CASES_V1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1.ts#buildL2NativeConformanceAdapterObservationV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1.ts#buildL2NativeConformanceEvaluatorV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1.ts#evaluateL2NativeConformanceCorpusV1',
    },
    {
      kind: 'evaluator',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1.ts#assembleL2NativeConformanceWorkerRecordsV1',
    },
    {
      kind: 'oracle',
      ref: 'release/qualification/source-owned-surface-v1.ts#createSourceOwnedQualificationCatalogV1',
    },
    {
      kind: 'test',
      ref: 'tests/evals/qualification/native-conformance-workflow.test.ts',
    },
    { kind: 'test', ref: 'tests/evals/qualification/native-conformance.test.ts' },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-evidence-v1.ts#l2NativeConformanceReceiptV1Schema',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts#verifyL2NativeConformanceReceiptV1',
    },
    {
      kind: 'verifier',
      ref: 'scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1.ts#l2NativeConformanceWorkerRecordV1Schema',
    },
  ];
  l2NativeConformanceSuiteRefs.sort(suiteSourceRefCompare);
  const l2NativeConformanceProductDependencyRefs: QualificationSourceRefV1[] = [
    {
      kind: 'contract',
      ref: 'scripts/release/oss-candidate.ts#resolveOssReleaseTarget',
    },
    {
      kind: 'contract',
      ref: 'src/app/release/standalone-keyring-unavailable.ts#AsyncEntry',
    },
    {
      kind: 'registry',
      ref: 'scripts/release/platform-capability-identity.ts#PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_ID_V1',
    },
    {
      kind: 'registry',
      ref: 'scripts/release/platform-capability-identity.ts#PLATFORM_CAPABILITY_CANONICAL_REPOSITORY_V1',
    },
    {
      kind: 'registry',
      ref: 'release/platform-capabilities/approved-execution-qualifications-v1.json',
    },
    {
      kind: 'registry',
      ref: 'release/platform-capabilities/support-matrix-v1.json',
    },
    {
      kind: 'registry',
      ref: 'src/core/config/release-surface-registry.ts#PRODUCTION_DISTRIBUTION_TARGET_IDENTITIES_V1',
    },
    {
      kind: 'registry',
      ref: 'src/core/config/release-surface-registry.ts#PRODUCTION_DISTRIBUTION_TARGETS_V1',
    },
    {
      kind: 'registry',
      ref: 'src/core/config/release-surface-registry.ts#SUPPORTED_PRODUCTION_EXECUTION_TARGETS_V1',
    },
  ];
  l2NativeConformanceProductDependencyRefs.sort(sourceRefCompare);
  const l2NativeConformanceSourceFacts = sourceFileFacts(sourceRoot, [
    ...l2NativeConformanceSuiteRefs,
    ...l2NativeConformanceProductDependencyRefs,
  ]);
  const l2NativeConformanceBindings = discoverSourceOwnedL2NativeConformanceBindingsV1(
    sourceRoot,
    sourceSurfaces,
  );
  const l2NativeConformanceSourceRegistry = buildL2NativeConformanceSourceRegistryV1();
  const l2NativeConformanceSuite = buildL2NativeConformanceSuiteV1();
  const l2NativeConformanceEvaluator = buildL2NativeConformanceEvaluatorV1();
  const suites = [
    buildQualificationSuiteV1({
      suiteId: MATRIX_SUITE_ID,
      sourceRefs: suiteRefs,
      assertionIds,
      sourceFact: { sourceFacts, assertionIds },
      evaluatorFact: { sourceFacts, evaluator: 'source-owned-matrix-integrity-v1' },
      oracleFact: { conditionIds: conditions.map((condition) => condition.conditionId) },
      corpusFact: { sourceSurfaceIds: sourceSurfaces.map((surface) => surface.sourceSurfaceId) },
    }),
    buildQualificationSuiteV1({
      suiteId: L0_CONTRACT_SUITE_ID_V1,
      sourceRefs: l0SuiteRefs,
      assertionIds: l0Bindings.map((binding) => binding.binding.assertionId).sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l0SourceFacts,
        bindings: l0Bindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l0Evaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l0Bindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { goodBad: L0_GOOD_BAD_CORPUS_V1, mutation: L0_MUTATION_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_TOOL_VERIFICATION_SUITE_ID_V1,
      sourceRefs: l1SuiteRefs,
      assertionIds: l1Bindings.map((binding) => binding.binding.assertionId).sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1SourceFacts,
        bindings: l1Bindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1Evaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1Bindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { cases: L1_TOOL_VERIFICATION_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1,
      sourceRefs: l1AutoCompactionFailureSuiteRefs,
      assertionIds: l1AutoCompactionFailureBindings
        .map((binding) => binding.binding.assertionId)
        .sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1AutoCompactionFailureSourceFacts,
        bindings: l1AutoCompactionFailureBindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1AutoCompactionFailureEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1AutoCompactionFailureBindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { cases: L1_AUTO_COMPACTION_FAILURE_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_PUBLIC_PROJECTION_SUITE_ID_V1,
      sourceRefs: l1ProjectionSuiteRefs,
      assertionIds: l1ProjectionBindings
        .map((binding) => binding.binding.assertionId)
        .sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1ProjectionSourceFacts,
        bindings: l1ProjectionBindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1ProjectionEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1ProjectionBindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { cases: L1_PUBLIC_PROJECTION_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_SKILL_MCP_SUITE_ID_V1,
      sourceRefs: l1SkillMcpSuiteRefs,
      assertionIds: l1SkillMcpBindings
        .map((binding) => binding.binding.assertionId)
        .sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1SkillMcpSourceFacts,
        bindings: l1SkillMcpBindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1SkillMcpEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1SkillMcpBindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { cases: L1_SKILL_MCP_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_SUBAGENT_RECOVERY_SUITE_ID_V1,
      sourceRefs: l1SubagentRecoverySuiteRefs,
      assertionIds: l1SubagentRecoveryBindings
        .map((binding) => binding.binding.assertionId)
        .sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1SubagentRecoverySourceFacts,
        bindings: l1SubagentRecoveryBindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1SubagentRecoveryEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1SubagentRecoveryBindings.map((binding) => binding.sourceSurfaceId),
      },
      corpusFact: { cases: L1_SUBAGENT_RECOVERY_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1,
      sourceRefs: l1TuiRewindForkProjectionSuiteRefs,
      assertionIds: l1TuiRewindForkProjectionBindings
        .map((binding) => binding.binding.assertionId)
        .sort(compareCodePoint),
      sourceFact: {
        sourceFacts: l1TuiRewindForkProjectionSourceFacts,
        bindings: l1TuiRewindForkProjectionBindings.map((binding) => ({
          sourceSurfaceId: binding.sourceSurfaceId,
          featureId: binding.featureId,
          sourceRef: binding.sourceRef,
          binding: binding.binding,
        })),
      },
      evaluatorFact: l1TuiRewindForkProjectionEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceSurfaceIds: l1TuiRewindForkProjectionBindings.map(
          (binding) => binding.sourceSurfaceId,
        ),
      },
      corpusFact: { cases: L1_TUI_REWIND_FORK_PROJECTION_CORPUS_V1 },
    }),
    buildQualificationSuiteV1({
      suiteId: L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
      sourceRefs: l2NativeConformanceSuiteRefs,
      assertionIds: L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
      sourceFact: {
        sourceFacts: l2NativeConformanceSourceFacts,
        sourceRegistry: l2NativeConformanceSourceRegistry,
        suite: l2NativeConformanceSuite,
        bindings: l2NativeConformanceBindings,
      },
      evaluatorFact: l2NativeConformanceEvaluator,
      oracleFact: {
        conditionIds: conditions.map((condition) => condition.conditionId),
        sourceRegistryDigest: l2NativeConformanceSourceRegistry.sourceRegistryDigest,
        sourceSurfaceBindings: l2NativeConformanceBindings,
      },
      corpusFact: {
        cases: L2_NATIVE_CONFORMANCE_CASES_V1,
        suiteDigest: l2NativeConformanceSuite.suiteDigest,
      },
    }),
  ].sort((left, right) => compareCodePoint(left.suiteId, right.suiteId));
  return {
    sourceSurfaces,
    conditions,
    suites,
    l0Evaluator,
    l1Evaluator,
    l1AutoCompactionFailureEvaluator,
    l1ProjectionEvaluator,
    l1SkillMcpEvaluator,
    l1SubagentRecoveryEvaluator,
    l1TuiRewindForkProjectionEvaluator,
    l2NativeConformanceEvaluator,
  };
}

export function generateSourceOwnedFeatureMatrixV1(root = process.cwd()) {
  return generateAgentFeatureQualificationMatrixV1(createSourceOwnedQualificationCatalogV1(root));
}

interface SurfaceInput {
  sourceSurfaceId: string;
  featureId: string;
  domain: AgentFeatureQualificationSpecV1['domain'];
  observableContract: AgentFeatureQualificationSpecV1['observableContract'];
  risk: AgentFeatureQualificationSpecV1['risk'];
  riskRationale: AgentFeatureQualificationSpecV1['riskRationale'];
  sourceRefs: QualificationSourceRefV1[];
  owner: AgentFeatureQualificationSpecV1['owner'];
  entrypoints: Array<'tui' | 'cli' | 'installer' | 'runtime'>;
  entrypointNotApplicable?: readonly QualificationEntrypointNotApplicableV1[];
  releaseProfiles: string[];
  platforms?: Array<'macos' | 'linux' | 'windows' | 'any'>;
  routeClasses?: string[];
  declaredExposure?: AgentFeatureQualificationSpecV1['declaredExposure'];
  supportState?: AgentFeatureQualificationSpecV1['supportState'];
  notApplicableRationale?: AgentFeatureQualificationSpecV1['notApplicableRationale'];
  featureFlags?: string[];
  requiredWhen?: QualificationConditionV1;
  entryRejectionRequirements?: QualificationConditionV1[];
  defaultOffSafeDisableRequirements?: QualificationConditionV1[];
  /**
   * A product owner may opt an exact public operation into L0 only beside the
   * same AST declaration that owns the Feature.  The Feature ID is therefore
   * derived from this surface, never repeated in a qualification-side map.
   */
  l0Binding?: L0SourceOwnedContractDeclarationV1;
  /**
   * L1 declarations are adjacent to the exact product operation exercised by
   * the sealed scripted-runtime adapter. Their Feature mapping remains owned
   * by this operation declaration, not by qualification code.
   */
  l1Bindings?: readonly L1SourceOwnedContractDeclarationV1[];
  /** Independent CLI/TUI projection receipts bind a separate public symbol. */
  l1ProjectionBindings?: readonly L1PublicProjectionSourceOwnedDeclarationV1[];
  /** AQ-9A binds automatic compaction failure admission to its model entry point. */
  l1AutoCompactionFailureBindings?: readonly L1AutoCompactionFailureSourceOwnedDeclarationV1[];
  /** AQ-5 binds exact Skill/MCP runtime symbols to its sealed L1 suite. */
  l1SkillMcpBindings?: readonly L1SkillMcpSourceOwnedDeclarationV1[];
  /** AQ-6 binds recovery cut points beside the exact owning runtime symbol. */
  l1SubagentRecoveryBindings?: readonly L1SubagentRecoverySourceOwnedDeclarationV1[];
  /** AQ-6 binds the real TUI rewind path beside its exact public hook. */
  l1TuiRewindForkProjectionBindings?: readonly L1TuiRewindForkProjectionSourceOwnedDeclarationV1[];
  /** AQ-7 derives native requirements from the closed product target registry. */
  l2NativeCases?: readonly L2NativeConformanceCaseV1[];
  sourceFact?: unknown;
}

function sourceSurface(input: SurfaceInput): QualificationSourceSurfaceV1 {
  const declaredExposure = input.declaredExposure ?? 'default_on';
  const requiredWhen = input.requiredWhen ?? alwaysCondition();
  const assertionId = qualificationStructuralAssertionIdV1(input.sourceSurfaceId);
  const manualUsabilityDisabled = manualUsabilityDisabledCondition();
  const feature = {
    schema: 'AgentFeatureQualificationSpecV1' as const,
    version: 1 as const,
    id: input.featureId,
    sourceSurfaceId: input.sourceSurfaceId,
    domain: input.domain,
    observableContract: input.observableContract,
    risk: input.risk,
    riskRationale: input.riskRationale,
    sourceRefs: [...input.sourceRefs].sort(sourceRefCompare),
    owner: input.owner,
    applicability: {
      releaseProfiles: [...input.releaseProfiles].sort(compareCodePoint),
      platforms: [...(input.platforms ?? ['any'])].sort(compareCodePoint),
      entrypoints: [...input.entrypoints].sort(compareCodePoint),
      ...(input.entrypointNotApplicable?.length
        ? {
            entrypointNotApplicable: [...input.entrypointNotApplicable].sort((left, right) =>
              compareCodePoint(left.entrypoint, right.entrypoint),
            ),
          }
        : {}),
      ...(input.routeClasses
        ? { routeClasses: [...input.routeClasses].sort(compareCodePoint) }
        : {}),
      ...(input.featureFlags
        ? { featureFlags: [...input.featureFlags].sort(compareCodePoint) }
        : {}),
    },
    supportState: input.supportState ?? 'supported',
    declaredExposure,
    ...(input.notApplicableRationale
      ? { notApplicableRationale: input.notApplicableRationale }
      : {}),
    requiredEvidence: [
      {
        layer: 'contract' as const,
        suiteIds: [MATRIX_SUITE_ID],
        assertionIds: [assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      },
      ...(input.entryRejectionRequirements ?? []).map((requirement) => ({
        layer: 'contract' as const,
        suiteIds: [MATRIX_SUITE_ID],
        assertionIds: [`${assertionId}:entry-rejection`],
        requiredWhen: {
          conditionId: requirement.conditionId,
          conditionDigest: requirement.conditionDigest,
        },
      })),
      ...(input.defaultOffSafeDisableRequirements ?? []).map((requirement) => ({
        layer: 'contract' as const,
        suiteIds: [MATRIX_SUITE_ID],
        assertionIds: [`${assertionId}:default-off-safe-disable`],
        requiredWhen: {
          conditionId: requirement.conditionId,
          conditionDigest: requirement.conditionDigest,
        },
      })),
      ...(input.l0Binding
        ? [
            {
              layer: 'contract' as const,
              suiteIds: [L0_CONTRACT_SUITE_ID_V1],
              assertionIds: [input.l0Binding.assertionId],
              requiredWhen: {
                conditionId: requiredWhen.conditionId,
                conditionDigest: requiredWhen.conditionDigest,
              },
            },
          ]
        : []),
      ...(input.l1Bindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_TOOL_VERIFICATION_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l1ProjectionBindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_PUBLIC_PROJECTION_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l1AutoCompactionFailureBindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_AUTO_COMPACTION_FAILURE_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l1SkillMcpBindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_SKILL_MCP_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l1SubagentRecoveryBindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_SUBAGENT_RECOVERY_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l1TuiRewindForkProjectionBindings ?? []).map((binding) => ({
        layer: 'scripted_runtime' as const,
        suiteIds: [L1_TUI_REWIND_FORK_PROJECTION_SUITE_ID_V1],
        assertionIds: [binding.assertionId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
      ...(input.l2NativeCases ?? []).map((nativeCase) => ({
        layer: 'native' as const,
        suiteIds: [L2_NATIVE_CONFORMANCE_SUITE_ID_V1],
        assertionIds: [nativeCase.caseId],
        requiredWhen: {
          conditionId: requiredWhen.conditionId,
          conditionDigest: requiredWhen.conditionDigest,
        },
      })),
    ],
    evidenceExclusions:
      declaredExposure === 'default_on'
        ? [
            {
              layer: 'manual_usability' as const,
              condition: {
                conditionId: manualUsabilityDisabled.conditionId,
                conditionDigest: manualUsabilityDisabled.conditionDigest,
              },
              rationale: 'manual_usability_not_adr_enabled',
            },
          ]
        : [],
  } satisfies AgentFeatureQualificationSpecV1;
  return buildQualificationSourceSurfaceV1({
    sourceSurfaceId: input.sourceSurfaceId,
    sourceFact: {
      declaration: input.sourceFact ?? {
        sourceSurfaceId: input.sourceSurfaceId,
        owner: input.owner,
        entrypoints: input.entrypoints,
      },
      sourceFiles: sourceFileFacts(
        QUALIFICATION_REPOSITORY_ROOT,
        input.sourceRefs.map((sourceRef) => qualificationSourceRefV1Schema.parse(sourceRef)),
      ),
    },
    feature,
  });
}

function releaseCapabilitySurface(
  capability: ReleaseCapabilityIdV1,
  profiles: string[],
): QualificationSourceSurfaceV1 {
  return sourceSurface({
    sourceSurfaceId: `release-capability:${capability}`,
    featureId: mechanicalFeatureId('RELEASE', `capability-${capability}`),
    domain: 'release',
    observableContract: 'release_capability_catalog',
    risk: ['mcp_write', 'skills_effectful', 'auto_compaction'].includes(capability) ? 'p0' : 'p1',
    riskRationale: 'release_capability_admission',
    sourceRefs: [
      { kind: 'registry', ref: 'src/core/config/capability-ids.ts#RELEASE_CAPABILITY_IDS_V1' },
    ],
    owner: 'release-capability',
    entrypoints: ['cli', 'tui', 'runtime'],
    releaseProfiles: profiles,
    declaredExposure: 'disabled',
    requiredWhen: entryRejectionCondition('runtime', 'capability_ceiling_off'),
    sourceFact: { capability, catalog: [...RELEASE_CAPABILITY_IDS_V1] },
  });
}

const SOURCE_OWNED_OPERATION_ANNOTATION_V1 = '@qualification-surface-v1';
const SOURCE_OWNED_PUBLIC_DECLARATION_ROOTS_V1 = ['src'] as const;
const SOURCE_OWNED_PUBLIC_DOCUMENTATION_ROOTS_V1 = [
  'README.md',
  'docs/active',
  'docs/book',
] as const;

/**
 * Product owners place this compact, closed-vocabulary annotation next to the
 * public operation they own. The collector discovers it; it never contains a
 * qualification-side operation list or a hand-maintained sourceRef map.
 */
const sourceOwnedPublicOperationDeclarationV1Schema = z
  .object({
    sourceSurfaceId: z.string().regex(/^[A-Za-z][A-Za-z0-9_.:/-]*$/),
    featureId: z.string().regex(/^[A-Z][A-Z0-9_]*-[A-Z0-9_]+-[0-9]{3}$/),
    domain: z.enum([
      'tool',
      'skill',
      'mcp',
      'subagent',
      'runtime',
      'authorization',
      'sandbox',
      'verification',
      'model_context',
      'tui',
      'cli',
      'release',
      'config',
    ]),
    observableContract: z.enum(QUALIFICATION_CONTRACT_CODES_V1),
    risk: z.enum(['p0', 'p1', 'p2']),
    riskRationale: z.enum(QUALIFICATION_RISK_RATIONALE_CODES_V1),
    owner: z.enum(QUALIFICATION_OWNER_IDS_V1),
    entrypoints: z.array(z.enum(['tui', 'cli', 'installer', 'runtime'])).min(1),
    sourceKind: z.enum(['registry', 'config', 'contract', 'public_surface']),
    symbol: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      .optional(),
    l0Binding: l0SourceOwnedContractDeclarationV1Schema.optional(),
    l1Bindings: z
      .array(l1SourceOwnedContractDeclarationV1Schema)
      .min(1)
      .max(L1_TOOL_VERIFICATION_ADAPTERS_V1.length)
      .optional(),
    l1ProjectionBindings: z
      .array(l1PublicProjectionSourceOwnedDeclarationV1Schema)
      .min(1)
      .max(L1_PUBLIC_PROJECTION_ADAPTERS_V1.length)
      .optional(),
    l1AutoCompactionFailureBindings: z
      .array(l1AutoCompactionFailureSourceOwnedDeclarationV1Schema)
      .min(1)
      .max(L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.length)
      .optional(),
    l1SkillMcpBindings: z
      .array(l1SkillMcpSourceOwnedDeclarationV1Schema)
      .min(1)
      .max(L1_SKILL_MCP_ADAPTERS_V1.length)
      .optional(),
    l1SubagentRecoveryBindings: z
      .array(l1SubagentRecoverySourceOwnedDeclarationV1Schema)
      .min(1)
      .max(L1_SUBAGENT_RECOVERY_ADAPTERS_V1.length)
      .optional(),
    l1TuiRewindForkProjectionBindings: z
      .array(l1TuiRewindForkProjectionSourceOwnedDeclarationV1Schema)
      .min(1)
      .max(L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.length)
      .optional(),
  })
  .strict();

type SourceOwnedPublicOperationDeclarationV1 = z.infer<
  typeof sourceOwnedPublicOperationDeclarationV1Schema
>;

type DiscoveredPublicOperationV1 = Omit<SurfaceInput, 'releaseProfiles' | 'sourceFact'> & {
  declaration: SourceOwnedPublicOperationDeclarationV1;
};

export function discoverSourceOwnedPublicOperationsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
): DiscoveredPublicOperationV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const discovered: DiscoveredPublicOperationV1[] = [];
  for (const relativePath of sourceOwnedDeclarationFiles(sourceRoot)) {
    const content = readFileSync(resolve(sourceRoot, relativePath), 'utf8');
    for (const { declaration, sourceRef } of parseSourceOwnedOperationAnnotationsV1(
      relativePath,
      content,
    )) {
      discovered.push({
        sourceSurfaceId: declaration.sourceSurfaceId,
        featureId: declaration.featureId,
        domain: declaration.domain,
        observableContract: declaration.observableContract,
        risk: declaration.risk,
        riskRationale: declaration.riskRationale,
        sourceRefs: [sourceRef],
        owner: declaration.owner,
        entrypoints: declaration.entrypoints,
        l0Binding: declaration.l0Binding,
        l1Bindings: declaration.l1Bindings,
        l1ProjectionBindings: declaration.l1ProjectionBindings,
        l1AutoCompactionFailureBindings: declaration.l1AutoCompactionFailureBindings,
        l1SkillMcpBindings: declaration.l1SkillMcpBindings,
        l1SubagentRecoveryBindings: declaration.l1SubagentRecoveryBindings,
        l1TuiRewindForkProjectionBindings: declaration.l1TuiRewindForkProjectionBindings,
        declaration,
      });
    }
  }
  if (discovered.length === 0) {
    throw new Error('qualification_source_declaration_missing');
  }
  assertUniqueDiscoveredPublicOperations(discovered);
  return discovered.sort((left, right) =>
    compareCodePoint(left.sourceSurfaceId, right.sourceSurfaceId),
  );
}

/**
 * The only L0 product bindings are the compact declarations placed beside
 * their existing public operation annotations.  This derives Feature IDs and
 * source references from those owners rather than maintaining a second map in
 * qualification code.
 */
export interface SourceOwnedL0ContractBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L0SourceOwnedBindingV1;
}

/**
 * Verify that an L0 source annotation names the exact product symbol executed
 * by its closed adapter. This deliberately has no Feature-ID table: Feature
 * ownership remains the adjacent product annotation, while the adapter owns
 * only its implementation provenance.
 */
export function assertSourceOwnedL0ContractBindingProvenanceV1(
  bindings: readonly SourceOwnedL0ContractBindingV1[],
): void {
  if (bindings.length !== L0_CONTRACT_ADAPTERS_V1.length) {
    throw new Error('qualification_l0_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) throw new Error(`qualification_l0_source_binding_duplicate:${key}`);
    pairKeys.add(key);
    const implementation = L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(`qualification_l0_adapter_implementation_missing:${key}`);
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(`qualification_l0_adapter_source_provenance_mismatch:${key}`);
    }
  }
  for (const adapter of L0_CONTRACT_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) throw new Error(`qualification_l0_source_binding_missing:${key}`);
  }
  if (L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1.length !== L0_CONTRACT_ADAPTERS_V1.length) {
    throw new Error('qualification_l0_adapter_implementation_inventory_incomplete');
  }
}

export function discoverSourceOwnedL0ContractBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL0ContractBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      if (!operation.declaration.l0Binding) return [];
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef) {
        throw new Error(`qualification_l0_source_ref_missing:${operation.sourceSurfaceId}`);
      }
      return [
        {
          sourceSurfaceId: operation.sourceSurfaceId,
          featureId: operation.featureId,
          sourceRef,
          binding: buildL0SourceOwnedBindingV1({
            sourceSurfaceId: operation.sourceSurfaceId,
            declaration: operation.declaration.l0Binding,
          }),
        },
      ];
    })
    .sort((left, right) => compareCodePoint(left.sourceSurfaceId, right.sourceSurfaceId));

  assertSourceOwnedL0ContractBindingProvenanceV1(bindings);
  return bindings;
}

/**
 * AQ-4's L1 bindings are source annotations rather than a qualification-side
 * feature table. Every closed adapter pair must resolve back to the exact
 * product symbol it executes, or catalog construction stops fail-closed.
 */
export interface SourceOwnedL1ToolVerificationBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1SourceOwnedBindingV1;
}

export function assertSourceOwnedL1ToolVerificationBindingProvenanceV1(
  bindings: readonly SourceOwnedL1ToolVerificationBindingV1[],
): void {
  if (bindings.length !== L1_TOOL_VERIFICATION_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) throw new Error(`qualification_l1_source_binding_duplicate:${key}`);
    pairKeys.add(key);
    const implementation = L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(`qualification_l1_adapter_implementation_missing:${key}`);
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(`qualification_l1_adapter_source_provenance_mismatch:${key}`);
    }
  }
  for (const adapter of L1_TOOL_VERIFICATION_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) throw new Error(`qualification_l1_source_binding_missing:${key}`);
  }
  if (
    L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1.length !==
    L1_TOOL_VERIFICATION_ADAPTERS_V1.length
  ) {
    throw new Error('qualification_l1_adapter_implementation_inventory_incomplete');
  }
}

export function discoverSourceOwnedL1ToolVerificationBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1ToolVerificationBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1Bindings?.length) {
        throw new Error(`qualification_l1_source_ref_missing:${operation.sourceSurfaceId}`);
      }
      return (operation.declaration.l1Bindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1SourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        `${left.sourceSurfaceId}:${left.binding.adapterId}`,
        `${right.sourceSurfaceId}:${right.binding.adapterId}`,
      ),
    );
  assertSourceOwnedL1ToolVerificationBindingProvenanceV1(bindings);
  return bindings;
}

/** AQ-9A keeps all automatic compaction failure receipts adjacent to the admission symbol. */
export interface SourceOwnedL1AutoCompactionFailureBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1AutoCompactionFailureSourceOwnedBindingV1;
}

export function assertSourceOwnedL1AutoCompactionFailureBindingProvenanceV1(
  bindings: readonly SourceOwnedL1AutoCompactionFailureBindingV1[],
): void {
  if (bindings.length !== L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_auto_compaction_failure_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) {
      throw new Error(`qualification_l1_auto_compaction_failure_source_binding_duplicate:${key}`);
    }
    pairKeys.add(key);
    const implementation = L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(
        `qualification_l1_auto_compaction_failure_adapter_implementation_missing:${key}`,
      );
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(
        `qualification_l1_auto_compaction_failure_adapter_source_provenance_mismatch:${key}`,
      );
    }
  }
  for (const adapter of L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) {
      throw new Error(`qualification_l1_auto_compaction_failure_source_binding_missing:${key}`);
    }
  }
  if (
    L1_AUTO_COMPACTION_FAILURE_ADAPTER_IMPLEMENTATIONS_V1.length !==
    L1_AUTO_COMPACTION_FAILURE_ADAPTERS_V1.length
  ) {
    throw new Error(
      'qualification_l1_auto_compaction_failure_adapter_implementation_inventory_incomplete',
    );
  }
}

export function discoverSourceOwnedL1AutoCompactionFailureBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1AutoCompactionFailureBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1AutoCompactionFailureBindings?.length) {
        throw new Error(
          `qualification_l1_auto_compaction_failure_source_ref_missing:${operation.sourceSurfaceId}`,
        );
      }
      return (operation.declaration.l1AutoCompactionFailureBindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1AutoCompactionFailureSourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        `${left.sourceSurfaceId}:${left.binding.adapterId}`,
        `${right.sourceSurfaceId}:${right.binding.adapterId}`,
      ),
    );
  assertSourceOwnedL1AutoCompactionFailureBindingProvenanceV1(bindings);
  return bindings;
}

/** AQ-5 keeps Skill/MCP runtime bindings sealed to their product owners. */
export interface SourceOwnedL1SkillMcpBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1SkillMcpSourceOwnedBindingV1;
}

export function assertSourceOwnedL1SkillMcpBindingProvenanceV1(
  bindings: readonly SourceOwnedL1SkillMcpBindingV1[],
): void {
  if (bindings.length !== L1_SKILL_MCP_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_skill_mcp_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) {
      throw new Error(`qualification_l1_skill_mcp_source_binding_duplicate:${key}`);
    }
    pairKeys.add(key);
    const implementation = L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(`qualification_l1_skill_mcp_adapter_implementation_missing:${key}`);
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(`qualification_l1_skill_mcp_adapter_source_provenance_mismatch:${key}`);
    }
  }
  for (const adapter of L1_SKILL_MCP_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) {
      throw new Error(`qualification_l1_skill_mcp_source_binding_missing:${key}`);
    }
  }
  if (L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1.length !== L1_SKILL_MCP_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_skill_mcp_adapter_implementation_inventory_incomplete');
  }
}

export function discoverSourceOwnedL1SkillMcpBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1SkillMcpBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1SkillMcpBindings?.length) {
        throw new Error(
          `qualification_l1_skill_mcp_source_ref_missing:${operation.sourceSurfaceId}`,
        );
      }
      return (operation.declaration.l1SkillMcpBindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1SkillMcpSourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        `${left.sourceSurfaceId}:${left.binding.adapterId}`,
        `${right.sourceSurfaceId}:${right.binding.adapterId}`,
      ),
    );
  assertSourceOwnedL1SkillMcpBindingProvenanceV1(bindings);
  return bindings;
}

/** AQ-6 keeps Subagent/Runtime recovery cut points sealed to product owners. */
export interface SourceOwnedL1SubagentRecoveryBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1SubagentRecoverySourceOwnedBindingV1;
}

export function assertSourceOwnedL1SubagentRecoveryBindingProvenanceV1(
  bindings: readonly SourceOwnedL1SubagentRecoveryBindingV1[],
): void {
  if (bindings.length !== L1_SUBAGENT_RECOVERY_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_subagent_recovery_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) {
      throw new Error(`qualification_l1_subagent_recovery_source_binding_duplicate:${key}`);
    }
    pairKeys.add(key);
    const implementation = L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(`qualification_l1_subagent_recovery_adapter_implementation_missing:${key}`);
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(
        `qualification_l1_subagent_recovery_adapter_source_provenance_mismatch:${key}`,
      );
    }
  }
  for (const adapter of L1_SUBAGENT_RECOVERY_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) {
      throw new Error(`qualification_l1_subagent_recovery_source_binding_missing:${key}`);
    }
  }
  if (
    L1_SUBAGENT_RECOVERY_ADAPTER_IMPLEMENTATIONS_V1.length !==
    L1_SUBAGENT_RECOVERY_ADAPTERS_V1.length
  ) {
    throw new Error(
      'qualification_l1_subagent_recovery_adapter_implementation_inventory_incomplete',
    );
  }
}

export function discoverSourceOwnedL1SubagentRecoveryBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1SubagentRecoveryBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1SubagentRecoveryBindings?.length) {
        throw new Error(
          `qualification_l1_subagent_recovery_source_ref_missing:${operation.sourceSurfaceId}`,
        );
      }
      return (operation.declaration.l1SubagentRecoveryBindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1SubagentRecoverySourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        `${left.sourceSurfaceId}:${left.binding.adapterId}`,
        `${right.sourceSurfaceId}:${right.binding.adapterId}`,
      ),
    );
  assertSourceOwnedL1SubagentRecoveryBindingProvenanceV1(bindings);
  return bindings;
}

/** AQ-6 binds the real TUI rewind fork projection to its product owner. */
export interface SourceOwnedL1TuiRewindForkProjectionBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1TuiRewindForkProjectionSourceOwnedBindingV1;
}

export function assertSourceOwnedL1TuiRewindForkProjectionBindingProvenanceV1(
  bindings: readonly SourceOwnedL1TuiRewindForkProjectionBindingV1[],
): void {
  if (bindings.length !== L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.length) {
    throw new Error(
      'qualification_l1_tui_rewind_fork_projection_source_binding_inventory_incomplete',
    );
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.binding.adapterId}:${binding.binding.assertionId}`;
    if (pairKeys.has(key)) {
      throw new Error(
        `qualification_l1_tui_rewind_fork_projection_source_binding_duplicate:${key}`,
      );
    }
    pairKeys.add(key);
    const implementation = L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error(
        `qualification_l1_tui_rewind_fork_projection_adapter_implementation_missing:${key}`,
      );
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error(
        `qualification_l1_tui_rewind_fork_projection_adapter_source_provenance_mismatch:${key}`,
      );
    }
  }
  for (const adapter of L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1) {
    const key = `${adapter.adapterId}:${adapter.assertionId}`;
    if (!pairKeys.has(key)) {
      throw new Error(`qualification_l1_tui_rewind_fork_projection_source_binding_missing:${key}`);
    }
  }
  if (
    L1_TUI_REWIND_FORK_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1.length !==
    L1_TUI_REWIND_FORK_PROJECTION_ADAPTERS_V1.length
  ) {
    throw new Error(
      'qualification_l1_tui_rewind_fork_projection_adapter_implementation_inventory_incomplete',
    );
  }
}

export function discoverSourceOwnedL1TuiRewindForkProjectionBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1TuiRewindForkProjectionBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1TuiRewindForkProjectionBindings?.length) {
        throw new Error(
          `qualification_l1_tui_rewind_fork_projection_source_ref_missing:${operation.sourceSurfaceId}`,
        );
      }
      return (operation.declaration.l1TuiRewindForkProjectionBindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1TuiRewindForkProjectionSourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        `${left.sourceSurfaceId}:${left.binding.adapterId}`,
        `${right.sourceSurfaceId}:${right.binding.adapterId}`,
      ),
    );
  assertSourceOwnedL1TuiRewindForkProjectionBindingProvenanceV1(bindings);
  return bindings;
}

/** Source-owned public projection bindings are independently validated. */
export interface SourceOwnedL1PublicProjectionBindingV1 {
  sourceSurfaceId: string;
  featureId: string;
  sourceRef: QualificationSourceRefV1;
  binding: L1PublicProjectionSourceOwnedBindingV1;
}

export function assertSourceOwnedL1PublicProjectionBindingProvenanceV1(
  bindings: readonly SourceOwnedL1PublicProjectionBindingV1[],
): void {
  if (bindings.length !== L1_PUBLIC_PROJECTION_ADAPTERS_V1.length) {
    throw new Error('qualification_l1_projection_source_binding_inventory_incomplete');
  }
  const pairKeys = new Set<string>();
  for (const binding of bindings) {
    const key = binding.binding.adapterId + ':' + binding.binding.assertionId;
    if (pairKeys.has(key)) {
      throw new Error('qualification_l1_projection_source_binding_duplicate:' + key);
    }
    pairKeys.add(key);
    const implementation = L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1.find(
      (candidate) =>
        candidate.adapterId === binding.binding.adapterId &&
        candidate.assertionId === binding.binding.assertionId,
    );
    if (!implementation) {
      throw new Error('qualification_l1_projection_adapter_implementation_missing:' + key);
    }
    if (binding.sourceRef.ref !== implementation.sourceRef) {
      throw new Error('qualification_l1_projection_adapter_source_provenance_mismatch:' + key);
    }
  }
  for (const adapter of L1_PUBLIC_PROJECTION_ADAPTERS_V1) {
    const key = adapter.adapterId + ':' + adapter.assertionId;
    if (!pairKeys.has(key)) {
      throw new Error('qualification_l1_projection_source_binding_missing:' + key);
    }
  }
  if (
    L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1.length !==
    L1_PUBLIC_PROJECTION_ADAPTERS_V1.length
  ) {
    throw new Error('qualification_l1_projection_adapter_implementation_inventory_incomplete');
  }
}

export function discoverSourceOwnedL1PublicProjectionBindingsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
  publicOperations?: readonly DiscoveredPublicOperationV1[],
): SourceOwnedL1PublicProjectionBindingV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const bindings = (publicOperations ?? discoverSourceOwnedPublicOperationsV1(sourceRoot))
    .flatMap((operation) => {
      const sourceRef = operation.sourceRefs[0];
      if (!sourceRef && operation.declaration.l1ProjectionBindings?.length) {
        throw new Error(
          'qualification_l1_projection_source_ref_missing:' + operation.sourceSurfaceId,
        );
      }
      return (operation.declaration.l1ProjectionBindings ?? []).map((declaration) => ({
        sourceSurfaceId: operation.sourceSurfaceId,
        featureId: operation.featureId,
        sourceRef: sourceRef!,
        binding: buildL1PublicProjectionSourceOwnedBindingV1({
          sourceSurfaceId: operation.sourceSurfaceId,
          declaration,
        }),
      }));
    })
    .sort((left, right) =>
      compareCodePoint(
        left.sourceSurfaceId + ':' + left.binding.adapterId,
        right.sourceSurfaceId + ':' + right.binding.adapterId,
      ),
    );
  assertSourceOwnedL1PublicProjectionBindingProvenanceV1(bindings);
  return bindings;
}

export function parseSourceOwnedOperationAnnotationsV1(
  relativePath: string,
  content: string,
): Array<{
  declaration: SourceOwnedPublicOperationDeclarationV1;
  sourceRef: QualificationSourceRefV1;
}> {
  return parseTypeScriptSourceOwnedOperationAnnotationsV1(relativePath, content);
}

function parseTypeScriptSourceOwnedOperationAnnotationsV1(
  relativePath: string,
  content: string,
): Array<{
  declaration: SourceOwnedPublicOperationDeclarationV1;
  sourceRef: QualificationSourceRefV1;
}> {
  const extension = extname(relativePath).toLowerCase();
  if (!['.ts', '.tsx'].includes(extension)) return [];
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const declarations: Array<{
    declaration: SourceOwnedPublicOperationDeclarationV1;
    sourceRef: QualificationSourceRefV1;
  }> = [];
  const seenComments = new Set<number>();
  const visit = (node: ts.Node): void => {
    const symbol = annotationTargetSymbol(node);
    if (symbol) {
      for (const range of ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []) {
        if (seenComments.has(range.pos)) continue;
        seenComments.add(range.pos);
        const comment = content.slice(range.pos, range.end);
        if (!comment.includes(SOURCE_OWNED_OPERATION_ANNOTATION_V1)) continue;
        const annotation = /^\/\*\*\s*@qualification-surface-v1\s+(\{[^\r\n]*\})\s*\*\/$/.exec(
          comment,
        );
        if (!annotation) {
          throw new Error(`qualification_source_declaration_invalid_comment:${relativePath}`);
        }
        const parsed = declarationFromAnnotationJson(relativePath, annotation[1] ?? '');
        if (parsed.declaration.symbol !== symbol) {
          throw new Error(`qualification_source_declaration_symbol_mismatch:${relativePath}`);
        }
        declarations.push(parsed);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return declarations;
}

function declarationFromAnnotationJson(
  relativePath: string,
  annotationJson: string,
): { declaration: SourceOwnedPublicOperationDeclarationV1; sourceRef: QualificationSourceRefV1 } {
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(annotationJson);
  } catch {
    throw new Error(`qualification_source_declaration_invalid_json:${relativePath}`);
  }
  const result = sourceOwnedPublicOperationDeclarationV1Schema.safeParse(parsedJson);
  if (!result.success) throw new Error(`qualification_source_declaration_invalid:${relativePath}`);
  if (relativePath.startsWith('src/') && !result.data.symbol) {
    throw new Error(`qualification_source_declaration_symbol_missing:${relativePath}`);
  }
  if (!relativePath.startsWith('src/') && result.data.symbol) {
    throw new Error(`qualification_source_declaration_symbol_unexpected:${relativePath}`);
  }
  const ref = `${relativePath}${result.data.symbol ? `#${result.data.symbol}` : ''}`;
  return {
    declaration: result.data,
    sourceRef: qualificationSourceRefV1Schema.parse({ kind: result.data.sourceKind, ref }),
  };
}

function annotationTargetSymbol(node: ts.Node): string | undefined {
  const named = declaredSymbolName(node);
  if (named) return named;
  if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1)
    return undefined;
  const declaration = node.declarationList.declarations[0];
  return declaration?.name && ts.isIdentifier(declaration.name) ? declaration.name.text : undefined;
}

const SOURCE_OWNED_ENTRY_REJECTION_ANNOTATION_V1 = '@qualification-entry-rejection-v1';
const SOURCE_OWNED_DEFAULT_OFF_GUARD_ANNOTATION_V1 = '@qualification-default-off-guard-v1';
const sourceOwnedEntryRejectionDeclarationV1Schema = z
  .object({
    entrypointId: z.enum(['cli', 'runtime', 'tui']),
    denialFamily: z.string().regex(/^[A-Za-z][A-Za-z0-9_-]*$/),
    sourceKind: z.enum(['registry', 'config', 'contract', 'public_surface']),
    symbol: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
  })
  .strict();

type SourceOwnedEntryRejectionBindingV1 = z.infer<
  typeof sourceOwnedEntryRejectionDeclarationV1Schema
> & {
  sourceRef: QualificationSourceRefV1;
};

const sourceOwnedDefaultOffGuardDeclarationV1Schema = z
  .object({
    entrypointId: z.enum(['cli', 'runtime', 'tui']),
    flagId: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/),
    outcome: z.enum(['safe_disable', 'legacy_fallback']),
    disabledResult: z.enum(['deny', 'empty', 'identity', 'inactive', 'off']).optional(),
    closedValueParameter: z
      .string()
      .regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/)
      .optional(),
    sourceKind: z.enum(['registry', 'config', 'contract', 'public_surface']),
    symbol: z.string().regex(/^[A-Za-z_$][A-Za-z0-9_$]*$/),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.outcome === 'safe_disable' && !value.disabledResult) {
      context.addIssue({
        code: 'custom',
        path: ['disabledResult'],
        message: 'safe-disable guard requires a closed disabled result',
      });
    }
    if (
      value.outcome === 'safe_disable' &&
      value.disabledResult === 'identity' &&
      !value.closedValueParameter
    ) {
      context.addIssue({
        code: 'custom',
        path: ['closedValueParameter'],
        message: 'identity safe-disable must name the preserved function parameter',
      });
    }
    if (
      value.outcome === 'safe_disable' &&
      value.disabledResult !== 'identity' &&
      value.closedValueParameter
    ) {
      context.addIssue({
        code: 'custom',
        path: ['closedValueParameter'],
        message: 'only identity safe-disable may name a preserved function parameter',
      });
    }
    if (
      value.outcome === 'legacy_fallback' &&
      (value.disabledResult || value.closedValueParameter)
    ) {
      context.addIssue({
        code: 'custom',
        path: ['disabledResult'],
        message: 'legacy fallback must not be represented as a closed disabled result or identity',
      });
    }
  });

type SourceOwnedDefaultOffGuardBindingV1 = z.infer<
  typeof sourceOwnedDefaultOffGuardDeclarationV1Schema
> & {
  sourceRef: QualificationSourceRefV1;
};

interface SourceOwnedFeatureFlagConsumerV1 {
  relativePath: string;
  symbol: string;
  sourceRef: string;
}

let cachedSourceOwnedEntryRejectionBindingsV1:
  | readonly SourceOwnedEntryRejectionBindingV1[]
  | undefined;
let cachedSourceOwnedDefaultOffGuardBindingsV1:
  | readonly SourceOwnedDefaultOffGuardBindingV1[]
  | undefined;
const cachedProductFeatureFlagConsumersV1 = new Map<
  string,
  readonly SourceOwnedFeatureFlagConsumerV1[]
>();

/**
 * Entry rejection provenance is declared beside the actual product denial
 * paths. Multiple declarations with the same pair intentionally bind all
 * participating public/runtime sources without a qualification-side map.
 */
export function discoverSourceOwnedEntryRejectionBindingsV1(): readonly SourceOwnedEntryRejectionBindingV1[] {
  if (cachedSourceOwnedEntryRejectionBindingsV1) return cachedSourceOwnedEntryRejectionBindingsV1;
  const root = QUALIFICATION_REPOSITORY_ROOT;
  const bindings: SourceOwnedEntryRejectionBindingV1[] = [];
  for (const relativePath of sourceOwnedDeclarationFiles(root)) {
    if (!relativePath.startsWith('src/')) continue;
    const content = readFileSync(resolve(root, relativePath), 'utf8');
    bindings.push(...parseSourceOwnedEntryRejectionAnnotationsV1(relativePath, content));
  }
  if (bindings.length === 0) throw new Error('qualification_entry_rejection_declaration_missing');
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.entrypointId}:${binding.denialFamily}:${binding.sourceRef.kind}:${binding.sourceRef.ref}`;
    if (seen.has(key))
      throw new Error(`qualification_entry_rejection_declaration_duplicate:${key}`);
    seen.add(key);
  }
  cachedSourceOwnedEntryRejectionBindingsV1 = bindings.sort((left, right) =>
    compareCodePoint(
      `${left.entrypointId}:${left.denialFamily}:${left.sourceRef.kind}:${left.sourceRef.ref}`,
      `${right.entrypointId}:${right.denialFamily}:${right.sourceRef.kind}:${right.sourceRef.ref}`,
    ),
  );
  return cachedSourceOwnedEntryRejectionBindingsV1;
}

export function parseSourceOwnedEntryRejectionAnnotationsV1(
  relativePath: string,
  content: string,
): SourceOwnedEntryRejectionBindingV1[] {
  const extension = extname(relativePath).toLowerCase();
  if (!relativePath.startsWith('src/') || !['.ts', '.tsx'].includes(extension)) return [];
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const bindings: SourceOwnedEntryRejectionBindingV1[] = [];
  const seenComments = new Set<number>();
  const visit = (node: ts.Node): void => {
    const symbol = annotationTargetSymbol(node);
    if (symbol) {
      for (const range of ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []) {
        if (seenComments.has(range.pos)) continue;
        seenComments.add(range.pos);
        const comment = content.slice(range.pos, range.end);
        if (!comment.includes(SOURCE_OWNED_ENTRY_REJECTION_ANNOTATION_V1)) continue;
        const annotation =
          /^\/\*\*\s*@qualification-entry-rejection-v1\s+(\{[^\r\n]*\})\s*\*\/$/.exec(comment);
        if (!annotation) {
          throw new Error(
            `qualification_entry_rejection_declaration_invalid_comment:${relativePath}`,
          );
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(annotation[1] ?? '');
        } catch {
          throw new Error(`qualification_entry_rejection_declaration_invalid_json:${relativePath}`);
        }
        const declaration = sourceOwnedEntryRejectionDeclarationV1Schema.safeParse(parsedJson);
        if (!declaration.success) {
          throw new Error(`qualification_entry_rejection_declaration_invalid:${relativePath}`);
        }
        if (declaration.data.symbol !== symbol) {
          throw new Error(
            `qualification_entry_rejection_declaration_symbol_mismatch:${relativePath}`,
          );
        }
        bindings.push({
          ...declaration.data,
          sourceRef: qualificationSourceRefV1Schema.parse({
            kind: declaration.data.sourceKind,
            ref: `${relativePath}#${declaration.data.symbol}`,
          }),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

/**
 * Default-off provenance is deliberately distinct from entry rejection. Only
 * a syntactically verified closed disabled result may keep a flag eligible as
 * `experimental_default_off`; a legacy fallback is surfaced as unsupported.
 */
export function discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(
  flagId: string,
): readonly SourceOwnedDefaultOffGuardBindingV1[] {
  const definition = FEATURE_FLAG_DEFINITIONS_V1[flagId as FeatureFlagName];
  if (!definition) throw new Error(`qualification_feature_flag_unknown:${flagId}`);
  if (definition.defaultEnabled || definition.implementationState !== 'implemented') {
    throw new Error(`qualification_feature_flag_not_default_off_implemented:${flagId}`);
  }
  const bindings = discoverSourceOwnedDefaultOffGuardBindingsV1()
    .filter((binding) => binding.flagId === flagId)
    .sort((left, right) =>
      compareCodePoint(
        `${left.entrypointId}:${left.sourceRef.kind}:${left.sourceRef.ref}`,
        `${right.entrypointId}:${right.sourceRef.kind}:${right.sourceRef.ref}`,
      ),
    );
  const coveredConsumers = new Set(bindings.map((binding) => binding.sourceRef.ref));
  const missingConsumers = productFeatureFlagConsumersV1(flagId)
    .map((consumer) => consumer.sourceRef)
    .filter((sourceRef) => !coveredConsumers.has(sourceRef));
  if (missingConsumers.length > 0) {
    throw new Error(
      `qualification_default_off_guard_consumer_binding_missing:${flagId}:${missingConsumers.join(',')}`,
    );
  }
  if (bindings.length === 0) {
    throw new Error(`qualification_default_off_guard_binding_missing:${flagId}`);
  }
  return bindings;
}

function discoverSourceOwnedDefaultOffGuardBindingsV1(): readonly SourceOwnedDefaultOffGuardBindingV1[] {
  if (cachedSourceOwnedDefaultOffGuardBindingsV1) return cachedSourceOwnedDefaultOffGuardBindingsV1;
  const root = QUALIFICATION_REPOSITORY_ROOT;
  const bindings: SourceOwnedDefaultOffGuardBindingV1[] = [];
  for (const relativePath of sourceOwnedDeclarationFiles(root)) {
    const content = readFileSync(resolve(root, relativePath), 'utf8');
    bindings.push(...parseSourceOwnedDefaultOffGuardAnnotationsV1(relativePath, content));
  }
  const seen = new Set<string>();
  for (const binding of bindings) {
    const key = `${binding.flagId}:${binding.entrypointId}:${binding.sourceRef.kind}:${binding.sourceRef.ref}`;
    if (seen.has(key)) throw new Error(`qualification_default_off_guard_duplicate:${key}`);
    seen.add(key);
  }
  cachedSourceOwnedDefaultOffGuardBindingsV1 = bindings.sort((left, right) =>
    compareCodePoint(
      `${left.flagId}:${left.entrypointId}:${left.sourceRef.kind}:${left.sourceRef.ref}`,
      `${right.flagId}:${right.entrypointId}:${right.sourceRef.kind}:${right.sourceRef.ref}`,
    ),
  );
  return cachedSourceOwnedDefaultOffGuardBindingsV1;
}

export function parseSourceOwnedDefaultOffGuardAnnotationsV1(
  relativePath: string,
  content: string,
): SourceOwnedDefaultOffGuardBindingV1[] {
  const extension = extname(relativePath).toLowerCase();
  if (!relativePath.startsWith('src/') || !['.ts', '.tsx'].includes(extension)) return [];
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    relativePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  const bindings: SourceOwnedDefaultOffGuardBindingV1[] = [];
  const seenComments = new Set<number>();
  const visit = (node: ts.Node): void => {
    const symbol = annotationTargetSymbol(node);
    if (symbol) {
      for (const range of ts.getLeadingCommentRanges(content, node.getFullStart()) ?? []) {
        if (seenComments.has(range.pos)) continue;
        seenComments.add(range.pos);
        const comment = content.slice(range.pos, range.end);
        if (!comment.includes(SOURCE_OWNED_DEFAULT_OFF_GUARD_ANNOTATION_V1)) continue;
        const annotation =
          /^\/\*\*\s*@qualification-default-off-guard-v1\s+(\{[^\r\n]*\})\s*\*\/$/.exec(comment);
        if (!annotation) {
          throw new Error(`qualification_default_off_guard_invalid_comment:${relativePath}`);
        }
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(annotation[1] ?? '');
        } catch {
          throw new Error(`qualification_default_off_guard_invalid_json:${relativePath}`);
        }
        const declaration = sourceOwnedDefaultOffGuardDeclarationV1Schema.safeParse(parsedJson);
        if (!declaration.success) {
          throw new Error(`qualification_default_off_guard_invalid:${relativePath}`);
        }
        if (declaration.data.symbol !== symbol) {
          throw new Error(`qualification_default_off_guard_symbol_mismatch:${relativePath}`);
        }
        const definition = FEATURE_FLAG_DEFINITIONS_V1[declaration.data.flagId as FeatureFlagName];
        if (
          !definition ||
          definition.defaultEnabled ||
          definition.implementationState !== 'implemented'
        ) {
          throw new Error(
            `qualification_default_off_guard_invalid_flag:${relativePath}:${declaration.data.flagId}`,
          );
        }
        if (!nodeContainsFeatureFlagAccess(node, declaration.data.flagId)) {
          throw new Error(
            `qualification_default_off_guard_missing_flag_access:${relativePath}:${symbol}:${declaration.data.flagId}`,
          );
        }
        if (
          declaration.data.outcome === 'safe_disable' &&
          !nodeHasClosedDisabledResult(
            node,
            declaration.data.flagId,
            declaration.data.disabledResult!,
            declaration.data.closedValueParameter,
          )
        ) {
          throw new Error(
            `qualification_default_off_guard_not_closed:${relativePath}:${symbol}:${declaration.data.flagId}`,
          );
        }
        bindings.push({
          ...declaration.data,
          sourceRef: qualificationSourceRefV1Schema.parse({
            kind: declaration.data.sourceKind,
            ref: `${relativePath}#${declaration.data.symbol}`,
          }),
        });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  assertSourceOwnedDefaultOffGuardConsumerCoverageV1(relativePath, sourceFile, bindings);
  return bindings;
}

function assertDeclaredOnlyFeatureFlagHasNoProductConsumerV1(root: string, flagId: string): void {
  const sourceRoot = qualificationRepositoryRoot(root);
  const productConsumers = productFeatureFlagReferencePathsV1(flagId, sourceRoot);
  if (productConsumers.length > 0) {
    throw new Error(
      `qualification_declared_only_feature_flag_has_product_consumer:${flagId}:${productConsumers.join(',')}`,
    );
  }
}

function productFeatureFlagReferencePathsV1(
  flagId: string,
  root = QUALIFICATION_REPOSITORY_ROOT,
): readonly string[] {
  return [
    ...new Set(
      productFeatureFlagConsumersV1(flagId, root).map((consumer) => consumer.relativePath),
    ),
  ].sort(compareCodePoint);
}

function productFeatureFlagConsumersV1(
  flagId: string,
  root = QUALIFICATION_REPOSITORY_ROOT,
): readonly SourceOwnedFeatureFlagConsumerV1[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const cacheKey = `${sourceRoot}\u0000${flagId}`;
  const cached = cachedProductFeatureFlagConsumersV1.get(cacheKey);
  if (cached) return cached;
  const consumers: SourceOwnedFeatureFlagConsumerV1[] = [];
  for (const relativePath of sourceOwnedDeclarationFiles(sourceRoot)) {
    if (relativePath === 'src/core/config/features.ts') continue;
    const content = readFileSync(resolve(sourceRoot, relativePath), 'utf8');
    const sourceFile = createSourceFileForQualificationV1(relativePath, content);
    for (const access of featureFlagAccessNodesV1(sourceFile, flagId)) {
      const declaration = consumerDeclarationForFeatureFlagAccessV1(access);
      const symbol = declaration ? annotationTargetSymbol(declaration) : undefined;
      if (!declaration || !symbol) {
        throw new Error(
          `qualification_feature_flag_consumer_unattributable:${flagId}:${relativePath}:${access.getStart(sourceFile)}`,
        );
      }
      consumers.push({
        relativePath,
        symbol,
        sourceRef: `${relativePath}#${symbol}`,
      });
    }
  }
  const ordered = consumers
    .sort((left, right) => compareCodePoint(left.sourceRef, right.sourceRef))
    .filter(
      (consumer, index, values) =>
        index === 0 || values[index - 1]?.sourceRef !== consumer.sourceRef,
    );
  cachedProductFeatureFlagConsumersV1.set(cacheKey, ordered);
  return ordered;
}

function assertSourceOwnedDefaultOffGuardConsumerCoverageV1(
  relativePath: string,
  sourceFile: ts.SourceFile,
  bindings: readonly SourceOwnedDefaultOffGuardBindingV1[],
): void {
  for (const [flagId, definition] of Object.entries(FEATURE_FLAG_DEFINITIONS_V1)) {
    if (definition.defaultEnabled || definition.implementationState !== 'implemented') continue;
    const consumers = featureFlagAccessNodesV1(sourceFile, flagId)
      .map((access) => {
        const declaration = consumerDeclarationForFeatureFlagAccessV1(access);
        const symbol = declaration ? annotationTargetSymbol(declaration) : undefined;
        if (!declaration || !symbol) {
          throw new Error(
            `qualification_feature_flag_consumer_unattributable:${flagId}:${relativePath}:${access.getStart(sourceFile)}`,
          );
        }
        return `${relativePath}#${symbol}`;
      })
      .filter((sourceRef, index, values) => values.indexOf(sourceRef) === index)
      .sort(compareCodePoint);
    if (consumers.length === 0) continue;
    const covered = new Set(
      bindings
        .filter((binding) => binding.flagId === flagId)
        .map((binding) => binding.sourceRef.ref),
    );
    const missing = consumers.filter((sourceRef) => !covered.has(sourceRef));
    if (missing.length > 0) {
      throw new Error(
        `qualification_default_off_guard_consumer_binding_missing:${flagId}:${missing.join(',')}`,
      );
    }
  }
}

function nodeContainsFeatureFlagAccess(node: ts.Node, flagId: string): boolean {
  const sourceFile = node.getSourceFile();
  const start = node.getStart(sourceFile);
  return featureFlagAccessNodesV1(sourceFile, flagId).some((access) => {
    const accessStart = access.getStart(sourceFile);
    return accessStart >= start && access.end <= node.end;
  });
}

function nodeHasClosedDisabledResult(
  node: ts.Node,
  flagId: string,
  disabledResult: 'deny' | 'empty' | 'identity' | 'inactive' | 'off',
  closedValueParameter: string | undefined,
): boolean {
  const functionLike = functionLikeForAnnotationTargetV1(node);
  if (!functionLike?.body || !ts.isBlock(functionLike.body)) return false;
  if (
    disabledResult === 'identity' &&
    (!closedValueParameter ||
      !functionLike.parameters.some(
        (parameter) =>
          ts.isIdentifier(parameter.name) && parameter.name.text === closedValueParameter,
      ))
  ) {
    return false;
  }
  return functionLike.body.statements.some(
    (statement) =>
      ts.isIfStatement(statement) &&
      expressionContainsDisabledFeatureFlag(statement.expression, flagId) &&
      statementHasClosedDisabledResult(
        statement.thenStatement,
        disabledResult,
        closedValueParameter,
      ),
  );
}

function expressionContainsDisabledFeatureFlag(expression: ts.Expression, flagId: string): boolean {
  if (ts.isParenthesizedExpression(expression)) {
    return expressionContainsDisabledFeatureFlag(expression.expression, flagId);
  }
  if (
    ts.isPrefixUnaryExpression(expression) &&
    expression.operator === ts.SyntaxKind.ExclamationToken
  ) {
    return nodeContainsFeatureFlagAccess(expression.operand, flagId);
  }
  if (
    ts.isBinaryExpression(expression) &&
    expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
  ) {
    return (
      expressionContainsDisabledFeatureFlag(expression.left, flagId) ||
      expressionContainsDisabledFeatureFlag(expression.right, flagId)
    );
  }
  return false;
}

function statementHasClosedDisabledResult(
  statement: ts.Statement,
  disabledResult: 'deny' | 'empty' | 'identity' | 'inactive' | 'off',
  closedValueParameter: string | undefined,
): boolean {
  if (ts.isBlock(statement)) {
    return (
      statement.statements.length === 1 &&
      statementHasClosedDisabledResult(
        statement.statements[0]!,
        disabledResult,
        closedValueParameter,
      )
    );
  }
  if (disabledResult === 'deny' && ts.isThrowStatement(statement)) return true;
  if (!ts.isReturnStatement(statement)) return false;
  const expression = statement.expression;
  if (disabledResult === 'empty') return !expression || isUndefinedExpression(expression);
  if (disabledResult === 'identity') {
    return Boolean(
      expression &&
        ts.isIdentifier(expression) &&
        closedValueParameter &&
        expression.text === closedValueParameter,
    );
  }
  if (disabledResult === 'off')
    return Boolean(expression && ts.isStringLiteral(expression) && expression.text === 'off');
  if (disabledResult === 'deny') return returnExpressionIsRejected(expression);
  return returnExpressionIsInactive(expression);
}

function isUndefinedExpression(expression: ts.Expression): boolean {
  return ts.isIdentifier(expression) && expression.text === 'undefined';
}

function returnExpressionIsRejected(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'ok' &&
      property.initializer.kind === ts.SyntaxKind.FalseKeyword,
  );
}

function returnExpressionIsInactive(expression: ts.Expression | undefined): boolean {
  if (!expression || !ts.isObjectLiteralExpression(expression)) return false;
  return expression.properties.some(
    (property) =>
      ts.isPropertyAssignment(property) &&
      ts.isIdentifier(property.name) &&
      property.name.text === 'active' &&
      property.initializer.kind === ts.SyntaxKind.FalseKeyword,
  );
}

type FunctionLikeWithBodyV1 =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function functionLikeForAnnotationTargetV1(node: ts.Node): FunctionLikeWithBodyV1 | undefined {
  if (
    ts.isFunctionDeclaration(node) ||
    ts.isFunctionExpression(node) ||
    ts.isArrowFunction(node) ||
    ts.isMethodDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node)
  ) {
    return node;
  }
  if (!ts.isVariableStatement(node) || node.declarationList.declarations.length !== 1) {
    return undefined;
  }
  const initializer = node.declarationList.declarations[0]?.initializer;
  return initializer && (ts.isFunctionExpression(initializer) || ts.isArrowFunction(initializer))
    ? initializer
    : undefined;
}

function createSourceFileForQualificationV1(relativePath: string, content: string): ts.SourceFile {
  const extension = extname(relativePath).toLowerCase();
  const scriptKind = extension === '.tsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  return ts.createSourceFile(relativePath, content, ts.ScriptTarget.Latest, true, scriptKind);
}

interface DestructuredFeatureFlagBindingV1 {
  localName: string;
  access: ts.Identifier;
}

function featureFlagAccessNodesV1(
  sourceFile: ts.SourceFile,
  flagId: string,
): readonly ts.Identifier[] {
  const carrierAliases = featureFlagCarrierAliasesV1(sourceFile);
  const destructuredBindings = destructuredFeatureFlagBindingsV1(
    sourceFile,
    flagId,
    carrierAliases,
  );
  const destructuredNames = new Set(destructuredBindings.map((binding) => binding.localName));
  const accesses: ts.Identifier[] = [];
  const seen = new Set<number>();
  const add = (identifier: ts.Identifier): void => {
    const start = identifier.getStart(sourceFile);
    if (seen.has(start)) return;
    seen.add(start);
    accesses.push(identifier);
  };
  for (const binding of destructuredBindings) add(binding.access);
  const visit = (node: ts.Node): void => {
    if (isFeatureFlagAccessIdentifier(node, flagId, carrierAliases)) add(node);
    else if (isDestructuredFeatureFlagAliasReferenceV1(node, destructuredNames)) add(node);
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return accesses.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile));
}

function destructuredFeatureFlagBindingsV1(
  sourceFile: ts.SourceFile,
  flagId: string,
  carrierAliases: ReadonlySet<string>,
): readonly DestructuredFeatureFlagBindingV1[] {
  const bindings: DestructuredFeatureFlagBindingV1[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      ts.isObjectBindingPattern(node.name) &&
      isFeatureFlagCarrierExpression(node.initializer, carrierAliases)
    ) {
      for (const element of node.name.elements) {
        const propertyName = element.propertyName ?? element.name;
        if (
          ts.isIdentifier(propertyName) &&
          propertyName.text === flagId &&
          ts.isIdentifier(element.name)
        ) {
          bindings.push({ localName: element.name.text, access: propertyName });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return bindings;
}

function featureFlagCarrierAliasesV1(sourceFile: ts.SourceFile): ReadonlySet<string> {
  const aliases = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        node.initializer &&
        ts.isIdentifier(node.name) &&
        isFeatureFlagCarrierExpression(node.initializer, aliases) &&
        !aliases.has(node.name.text)
      ) {
        aliases.add(node.name.text);
        changed = true;
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
  }
  return aliases;
}

function isDestructuredFeatureFlagAliasReferenceV1(
  node: ts.Node,
  aliases: ReadonlySet<string>,
): node is ts.Identifier {
  if (!ts.isIdentifier(node) || !aliases.has(node.text)) return false;
  const parent = node.parent;
  if (ts.isBindingElement(parent)) return false;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false;
  if (ts.isShorthandPropertyAssignment(parent) && parent.name === node) return true;
  return true;
}

function consumerDeclarationForFeatureFlagAccessV1(access: ts.Identifier): ts.Node | undefined {
  let candidate: ts.Node | undefined = access.parent;
  let topLevelVariable: ts.VariableStatement | undefined;
  while (candidate && !ts.isSourceFile(candidate)) {
    if (
      ts.isFunctionDeclaration(candidate) ||
      ts.isMethodDeclaration(candidate) ||
      ts.isGetAccessorDeclaration(candidate) ||
      ts.isSetAccessorDeclaration(candidate)
    ) {
      return candidate;
    }
    if (ts.isArrowFunction(candidate) || ts.isFunctionExpression(candidate)) {
      const namedVariable = namedVariableStatementForFunctionLikeV1(candidate);
      if (namedVariable) return namedVariable;
    }
    if (ts.isVariableStatement(candidate) && ts.isSourceFile(candidate.parent)) {
      topLevelVariable ??= candidate;
    }
    candidate = candidate.parent;
  }
  return topLevelVariable;
}

function namedVariableStatementForFunctionLikeV1(
  functionLike: ts.ArrowFunction | ts.FunctionExpression,
): ts.VariableStatement | undefined {
  const declaration = functionLike.parent;
  if (!ts.isVariableDeclaration(declaration) || declaration.initializer !== functionLike)
    return undefined;
  const declarationList = declaration.parent;
  return ts.isVariableDeclarationList(declarationList) &&
    ts.isVariableStatement(declarationList.parent)
    ? declarationList.parent
    : undefined;
}

function isFeatureFlagAccessIdentifier(
  node: ts.Node,
  flagId: string,
  carrierAliases: ReadonlySet<string>,
): node is ts.Identifier {
  if (!ts.isIdentifier(node) || node.text !== flagId) return false;
  const parent = node.parent;
  if (!ts.isPropertyAccessExpression(parent) || parent.name !== node) return false;
  return isFeatureFlagCarrierExpression(parent.expression, carrierAliases);
}

function isFeatureFlagCarrierExpression(
  expression: ts.Expression,
  carrierAliases: ReadonlySet<string>,
): boolean {
  if (
    ts.isCallExpression(expression) &&
    ts.isIdentifier(expression.expression) &&
    expression.expression.text === 'getFeatureFlags'
  ) {
    return true;
  }
  if (ts.isIdentifier(expression)) {
    return (
      carrierAliases.has(expression.text) ||
      /(?:^flags$|Flags$|^featureOverrides$)/.test(expression.text)
    );
  }
  if (ts.isPropertyAccessExpression(expression)) {
    return ['features', 'featureFlags', 'flags'].includes(expression.name.text);
  }
  return false;
}

function sourceOwnedDeclarationFiles(root: string): string[] {
  const files: string[] = [];
  const visitDirectory = (relativeDirectory: string): void => {
    const directoryPath = resolve(root, relativeDirectory);
    for (const entry of readdirSync(directoryPath, { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        throw new Error(`qualification_source_declaration_symlink:${relativePath}`);
      }
      if (entry.isDirectory()) {
        visitDirectory(relativePath);
      } else if (entry.isFile() && ['.ts', '.tsx'].includes(extname(entry.name))) {
        files.push(relativePath);
      }
    }
  };
  for (const declarationRoot of SOURCE_OWNED_PUBLIC_DECLARATION_ROOTS_V1) {
    const canonicalPath = realpathSync(resolve(root, declarationRoot));
    const rootRelativePath = relative(root, canonicalPath);
    if (
      isAbsolute(rootRelativePath) ||
      rootRelativePath === '..' ||
      rootRelativePath.startsWith('../')
    ) {
      throw new Error(`qualification_source_declaration_outside_repository:${declarationRoot}`);
    }
    if (declarationRoot === 'src') {
      visitDirectory(declarationRoot);
    } else {
      files.push(declarationRoot);
    }
  }
  return files.sort(compareCodePoint);
}

/**
 * The repository's public documentation contract is intentionally complete:
 * the root README plus every Markdown document under current-rule and book
 * roots. Qualification never selects individual documents as a side list.
 */
export function discoverSourceOwnedPublicDocumentationPathsV1(
  root = QUALIFICATION_REPOSITORY_ROOT,
): string[] {
  const sourceRoot = qualificationRepositoryRoot(root);
  const files: string[] = [];
  const assertInsideRepository = (relativePath: string): string => {
    const canonicalPath = realpathSync(resolve(sourceRoot, relativePath));
    const rootRelativePath = relative(sourceRoot, canonicalPath);
    if (
      isAbsolute(rootRelativePath) ||
      rootRelativePath === '..' ||
      rootRelativePath.startsWith('../')
    ) {
      throw new Error(`qualification_public_document_outside_repository:${relativePath}`);
    }
    return canonicalPath;
  };
  const visitDirectory = (relativeDirectory: string): void => {
    assertInsideRepository(relativeDirectory);
    for (const entry of readdirSync(resolve(sourceRoot, relativeDirectory), {
      withFileTypes: true,
    })) {
      const relativePath = join(relativeDirectory, entry.name).replaceAll('\\', '/');
      if (entry.isSymbolicLink()) {
        throw new Error(`qualification_public_document_symlink:${relativePath}`);
      }
      if (entry.isDirectory()) {
        visitDirectory(relativePath);
      } else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md') {
        assertInsideRepository(relativePath);
        files.push(relativePath);
      }
    }
  };
  for (const publicRoot of SOURCE_OWNED_PUBLIC_DOCUMENTATION_ROOTS_V1) {
    if (publicRoot.endsWith('.md')) {
      assertInsideRepository(publicRoot);
      files.push(publicRoot);
    } else {
      visitDirectory(publicRoot);
    }
  }
  const sorted = files.sort(compareCodePoint);
  if (sorted.length === 0) throw new Error('qualification_public_document_missing');
  return sorted;
}

export function publicDocumentationSurfaceIdV1(relativePath: string): string {
  const asciiSlug = relativePath
    .normalize('NFKD')
    .replaceAll(/[^A-Za-z0-9]+/g, '-')
    .replaceAll(/^-+|-+$/g, '')
    .toLowerCase();
  const pathDigest = computeQualificationSourceFactDigestV1({ relativePath }).slice(-16);
  return `public-doc:${asciiSlug || 'document'}-${pathDigest}`;
}

function publicDocumentationSurfaceV1(
  relativePath: string,
  profiles: string[],
): QualificationSourceSurfaceV1 {
  const sourceSurfaceId = publicDocumentationSurfaceIdV1(relativePath);
  return sourceSurface({
    sourceSurfaceId,
    featureId: mechanicalFeatureId('DOC', sourceSurfaceId),
    domain: 'release',
    observableContract: 'public_documentation_disclosure',
    risk: 'p1',
    riskRationale: 'public_documentation_claim',
    sourceRefs: [{ kind: 'public_surface', ref: relativePath }],
    owner: 'release-docs',
    entrypoints: ['cli', 'runtime', 'tui'],
    releaseProfiles: profiles,
    sourceFact: {
      relativePath,
      discoveryContract: 'repository-public-documentation-v1',
    },
  });
}

function assertUniqueDiscoveredPublicOperations(
  declarations: readonly DiscoveredPublicOperationV1[],
): void {
  for (const key of ['sourceSurfaceId', 'featureId'] as const) {
    const seen = new Set<string>();
    for (const declaration of declarations) {
      const value = declaration[key];
      if (seen.has(value))
        throw new Error(`qualification_source_declaration_duplicate_${key}:${value}`);
      seen.add(value);
    }
  }
}

function qualificationConditions(
  sourceSurfaces: readonly QualificationSourceSurfaceV1[],
): QualificationConditionV1[] {
  const conditions = [alwaysCondition(), manualUsabilityDisabledCondition()];
  for (const [name, definition] of Object.entries(FEATURE_FLAG_DEFINITIONS_V1) as Array<
    [
      keyof typeof FEATURE_FLAG_DEFINITIONS_V1,
      (typeof FEATURE_FLAG_DEFINITIONS_V1)[keyof typeof FEATURE_FLAG_DEFINITIONS_V1],
    ]
  >) {
    conditions.push(featureFlagCondition(name, false), featureFlagCondition(name, true));
    if (!definition.defaultEnabled && definition.implementationState === 'implemented') {
      const bindings = discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(name);
      if (bindings.every((binding) => binding.outcome === 'safe_disable')) {
        conditions.push(...featureFlagDefaultOffSafeDisableConditions(name));
      }
    }
  }
  for (const surface of sourceSurfaces) {
    for (const requirement of surface.feature.requiredEvidence) {
      const known = conditions.find(
        (condition) =>
          condition.conditionId === requirement.requiredWhen.conditionId &&
          condition.conditionDigest === requirement.requiredWhen.conditionDigest,
      );
      if (!known) {
        const inferred = conditionForId(requirement.requiredWhen.conditionId);
        if (!inferred || inferred.conditionDigest !== requirement.requiredWhen.conditionDigest) {
          throw new Error(`source_surface_uses_unregistered_condition:${surface.sourceSurfaceId}`);
        }
        conditions.push(inferred);
      }
    }
  }
  return conditions;
}

function alwaysCondition(): QualificationConditionV1 {
  return buildQualificationConditionV1({
    conditionId: 'always-v1',
    kind: 'always',
    parameters: {},
  });
}

function featureFlagCondition(flagId: string, expected: boolean): QualificationConditionV1 {
  return buildQualificationConditionV1({
    conditionId: `feature-flag-${flagId}-${expected ? 'on' : 'off'}-v1`,
    kind: 'feature_flag_enabled',
    parameters: { flagId, expected },
  });
}

/** A default-off safe-disable condition cannot be mistaken for a rejection. */
function featureFlagDefaultOffSafeDisableConditions(flagId: string): QualificationConditionV1[] {
  const bindings = discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(flagId);
  if (bindings.length === 0 || bindings.some((binding) => binding.outcome !== 'safe_disable')) {
    throw new Error(`qualification_default_off_safe_disable_missing:${flagId}`);
  }
  const registryRefs: QualificationSourceRefV1[] = [
    { kind: 'config', ref: 'src/core/config/features.ts#FEATURE_FLAG_DEFINITIONS_V1' },
    { kind: 'config', ref: 'src/core/config/config-schema.ts#configSchema' },
  ];
  const byEntrypoint = new Map<string, SourceOwnedDefaultOffGuardBindingV1[]>();
  for (const binding of bindings) {
    const current = byEntrypoint.get(binding.entrypointId) ?? [];
    current.push(binding);
    byEntrypoint.set(binding.entrypointId, current);
  }
  return [...byEntrypoint.entries()]
    .sort(([left], [right]) => compareCodePoint(left, right))
    .map(([entrypointId, entrypointBindings]) => {
      const sourceRefs = [
        ...registryRefs,
        ...entrypointBindings.map((binding) => binding.sourceRef),
      ].sort(sourceRefCompare);
      return buildQualificationConditionV1({
        conditionId: `default-off-safe-disable-${entrypointId}-feature-flag-${flagId}-v1`,
        kind: 'default_off_safe_disable',
        parameters: {
          flagId,
          entrypointId,
          sourceFactDigest: computeQualificationSourceFactDigestV1({
            flagId,
            entrypointId,
            registry: sourceFileFacts(QUALIFICATION_REPOSITORY_ROOT, registryRefs),
            gateway: sourceFileFacts(QUALIFICATION_REPOSITORY_ROOT, sourceRefs),
          }),
        },
      });
    });
}

function entryRejectionCondition(
  entrypointId: string,
  denialFamily: string,
): QualificationConditionV1 {
  const sourceRefs = discoverSourceOwnedEntryRejectionBindingsV1()
    .filter(
      (binding) => binding.entrypointId === entrypointId && binding.denialFamily === denialFamily,
    )
    .map((binding) => binding.sourceRef)
    .sort(sourceRefCompare);
  if (sourceRefs.length === 0) {
    throw new Error(
      `qualification_entry_rejection_binding_missing:${entrypointId}:${denialFamily}`,
    );
  }
  return buildQualificationConditionV1({
    conditionId: `entry-rejection-${entrypointId}-${denialFamily}-v1`,
    kind: 'entry_rejection',
    parameters: {
      entrypointId,
      denialFamily,
      sourceFactDigest: computeQualificationSourceFactDigestV1(
        sourceFileFacts(QUALIFICATION_REPOSITORY_ROOT, sourceRefs),
      ),
    },
  });
}

function manualUsabilityDisabledCondition(): QualificationConditionV1 {
  return buildQualificationConditionV1({
    conditionId: 'manual-usability-disabled-v1',
    kind: 'manual_usability_disabled',
    parameters: { enabled: false, governanceRef: 'ADR-0070' },
  });
}

function conditionForId(conditionId: string): QualificationConditionV1 | undefined {
  const inputs = discoverSourceOwnedEntryRejectionBindingsV1();
  for (const input of inputs) {
    const condition = entryRejectionCondition(input.entrypointId, input.denialFamily);
    if (condition.conditionId === conditionId) return condition;
  }
  return undefined;
}

function embeddedProfileIds(): string[] {
  return EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1.map((profile) => profile.profileId).sort(
    compareCodePoint,
  );
}

export function configSchemaPointers(schema: unknown): Array<{ pointer: string; schema: unknown }> {
  const entries: Array<{ pointer: string; schema: unknown }> = [];
  const definitions = isRecord(schema) && isRecord(schema.$defs) ? schema.$defs : undefined;
  const seenReferences = new Set<string>();
  const visit = (value: unknown, pointer: string) => {
    if (!isRecord(value)) return;
    if ('$ref' in value) {
      const reference = value.$ref;
      if (typeof reference !== 'string' || !reference.startsWith('#/$defs/')) {
        throw new Error(`qualification_config_schema_unsupported_ref:${String(reference)}`);
      }
      const definitionName = reference.slice('#/$defs/'.length);
      if (!definitionName || !definitions || !Object.hasOwn(definitions, definitionName)) {
        throw new Error(`qualification_config_schema_missing_ref:${reference}`);
      }
      const referenceKey = `${pointer}:${reference}`;
      if (seenReferences.has(referenceKey)) {
        throw new Error(`qualification_config_schema_recursive_ref:${reference}`);
      }
      seenReferences.add(referenceKey);
      visit(definitions[definitionName], pointer);
      seenReferences.delete(referenceKey);
      return;
    }
    if (pointer) entries.push({ pointer, schema: value });
    const properties = isRecord(value.properties) ? value.properties : undefined;
    if (properties) {
      for (const [key, child] of Object.entries(properties).sort(([left], [right]) =>
        compareCodePoint(left, right),
      )) {
        visit(child, `${pointer}/${escapeJsonPointer(key)}`);
      }
    }
    if (isRecord(value.additionalProperties)) visit(value.additionalProperties, `${pointer}/*`);
    if (isRecord(value.items)) visit(value.items, `${pointer}/*`);
    for (const unionKey of ['anyOf', 'oneOf', 'allOf'] as const) {
      const variants = value[unionKey];
      if (!Array.isArray(variants)) continue;
      for (const [index, child] of variants.entries()) {
        visit(child, `${pointer}/${unionKey}-${index}`);
      }
    }
  };
  visit(schema, '');
  return entries.sort((left, right) => compareCodePoint(left.pointer, right.pointer));
}

function configPointerRisk(pointer: string): AgentFeatureQualificationSpecV1['risk'] {
  return /(?:provider|sandbox|mcp|telemetry|authorization|workspace|compaction|autoReview)/i.test(
    pointer,
  )
    ? 'p0'
    : 'p1';
}

function qualificationRepositoryRoot(root: string): string {
  const requestedRoot = realpathSync(root);
  if (requestedRoot !== QUALIFICATION_REPOSITORY_ROOT) {
    throw new Error('qualification_source_root_mismatch');
  }
  return QUALIFICATION_REPOSITORY_ROOT;
}

export function assertQualificationSourceReferenceV1(
  sourceRef: QualificationSourceRefV1 | QualificationSuiteSourceRefV1,
): void {
  sourceFileFacts(QUALIFICATION_REPOSITORY_ROOT, [sourceRef]);
}

function sourceFileFacts(
  root: string,
  sourceRefs: readonly Readonly<{ kind: string; ref: string }>[],
) {
  const sourceRoot = qualificationRepositoryRoot(root);
  return [...sourceRefs]
    .sort((left, right) =>
      compareCodePoint(`${left.kind}:${left.ref}`, `${right.kind}:${right.ref}`),
    )
    .map((sourceRef) => {
      const productSource = qualificationSourceRefV1Schema.safeParse(sourceRef);
      const suiteSource = qualificationSuiteSourceRefV1Schema.safeParse(sourceRef);
      const l0EvaluatorDependency = L0_EVALUATOR_REUSED_CONTRACT_SOURCE_REFS_V1.some(
        (candidate) => candidate.kind === sourceRef.kind && candidate.ref === sourceRef.ref,
      );
      if (!productSource.success && !suiteSource.success && !l0EvaluatorDependency) {
        throw new Error(`qualification_source_ref_invalid:${sourceRef.ref}`);
      }
      const relativePath = sourceRef.ref.split('#', 1)[0]!;
      const candidatePath = resolve(sourceRoot, relativePath);
      const canonicalPath = realpathSync(candidatePath);
      const rootRelativePath = relative(sourceRoot, canonicalPath);
      if (
        isAbsolute(rootRelativePath) ||
        rootRelativePath === '..' ||
        rootRelativePath.startsWith('../')
      ) {
        throw new Error(`qualification_source_ref_outside_repository:${relativePath}`);
      }
      const content = readFileSync(canonicalPath, 'utf8');
      const symbol = sourceRef.ref.split('#', 2)[1];
      if (symbol && !hasDeclaredSourceSymbol(content, canonicalPath, symbol)) {
        throw new Error(`qualification_source_ref_symbol_missing:${sourceRef.ref}`);
      }
      return {
        ref: sourceRef.ref,
        sourceContentDigest: computeQualificationSourceFactDigestV1({ relativePath, content }),
      };
    });
}

/**
 * A fragment is a source declaration reference, never a textual token. This
 * deliberately ignores comments, strings, imports, and arbitrary identifiers
 * so qualification provenance cannot be satisfied by a look-alike marker.
 */
function hasDeclaredSourceSymbol(content: string, filePath: string, symbol: string): boolean {
  const extension = extname(filePath).toLowerCase();
  if (!['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'].includes(extension)) {
    return false;
  }
  const scriptKind =
    extension === '.tsx' || extension === '.jsx' ? ts.ScriptKind.TSX : ts.ScriptKind.TS;
  const sourceFile = ts.createSourceFile(
    filePath,
    content,
    ts.ScriptTarget.Latest,
    true,
    scriptKind,
  );
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (declaredSymbolName(node) === symbol) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found;
}

function declaredSymbolName(node: ts.Node): string | undefined {
  const named = node as ts.NamedDeclaration;
  if (
    !(
      ts.isClassDeclaration(node) ||
      ts.isClassExpression(node) ||
      ts.isEnumDeclaration(node) ||
      ts.isEnumMember(node) ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isInterfaceDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isMethodSignature(node) ||
      ts.isModuleDeclaration(node) ||
      ts.isPropertyDeclaration(node) ||
      ts.isPropertySignature(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node) ||
      ts.isTypeAliasDeclaration(node) ||
      ts.isVariableDeclaration(node)
    )
  ) {
    return undefined;
  }
  return named.name && ts.isIdentifier(named.name) ? named.name.text : undefined;
}

function mechanicalFeatureId(domain: string, sourceId: string): string {
  const normalized = sourceId
    .replaceAll(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  if (!normalized) throw new Error(`source surface cannot form a feature ID: ${sourceId}`);
  return `${domain.toUpperCase()}-${normalized}-001`;
}

function sourceRefCompare(left: QualificationSourceRefV1, right: QualificationSourceRefV1): number {
  return compareCodePoint(`${left.kind}:${left.ref}`, `${right.kind}:${right.ref}`);
}

function suiteSourceRefCompare(
  left: QualificationSuiteSourceRefV1,
  right: QualificationSuiteSourceRefV1,
): number {
  return compareCodePoint(`${left.kind}:${left.ref}`, `${right.kind}:${right.ref}`);
}

function escapeJsonPointer(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function jsonSnapshot(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value));
}
