import { describe, expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { extname, join, resolve } from 'node:path';
import { z } from 'zod';
import { registeredQualificationSuiteRoleV1 } from '../../../release/qualification/evidence/source-owned-verifier-v1';
import {
  assertQualificationSourceReferenceV1,
  assertSourceOwnedL0ContractBindingProvenanceV1,
  assertSourceOwnedL1PublicProjectionBindingProvenanceV1,
  assertSourceOwnedL1SkillMcpBindingProvenanceV1,
  assertSourceOwnedL1ToolVerificationBindingProvenanceV1,
  assertSourceOwnedL2NativeConformanceBindingProvenanceV1,
  assertSourceOwnedNoCredentialPublicEntrypointsV1,
  collectSourceOwnedPublicCredentialEntrypointCandidatesV1,
  collectSourceOwnedQualificationSurfacesV1,
  configSchemaPointers,
  createSourceOwnedQualificationCatalogV1,
  discoverSourceOwnedDefaultOffFeatureFlagBindingsV1,
  discoverSourceOwnedEntryRejectionBindingsV1,
  discoverSourceOwnedL0ContractBindingsV1,
  discoverSourceOwnedL1PublicProjectionBindingsV1,
  discoverSourceOwnedL1SkillMcpBindingsV1,
  discoverSourceOwnedL1ToolVerificationBindingsV1,
  discoverSourceOwnedL2NativeConformanceBindingsV1,
  discoverSourceOwnedPublicDocumentationPathsV1,
  discoverSourceOwnedPublicOperationsV1,
  generateSourceOwnedFeatureMatrixV1,
  parseSourceOwnedDefaultOffGuardAnnotationsV1,
  parseSourceOwnedEntryRejectionAnnotationsV1,
  parseSourceOwnedOperationAnnotationsV1,
  publicDocumentationSurfaceIdV1,
} from '../../../release/qualification/source-owned-surface-v1';
import {
  type AgentFeatureQualificationSpecV1,
  agentFeatureQualificationSpecV1Schema,
  buildQualificationConditionV1,
  buildQualificationSourceSurfaceV1,
  buildQualificationSuiteV1,
  computeQualificationSourceFactDigestV1,
  computeQualificationSourceSurfaceDigestV1,
  evaluateQualificationStructuralAssertionsV1,
  generateAgentFeatureQualificationMatrixV1,
  qualificationStructuralConditionAssertionIdV1,
} from '../../../scripts/evals/contracts/qualification/feature-matrix';
import { L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1 } from '../../../scripts/evals/contracts/qualification/l0-contract-adapter-v1';
import {
  L0_CONTRACT_ADAPTERS_V1,
  L0_CONTRACT_SUITE_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l0-contract-schema-v1';
import {
  L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_PUBLIC_PROJECTION_ADAPTERS_V1,
  L1_PUBLIC_PROJECTION_SUITE_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-public-projection-schema-v1';
import {
  L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1,
  L1_SKILL_MCP_ADAPTERS_V1,
  L1_SKILL_MCP_SUITE_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1';
import {
  L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1,
  L1_TOOL_VERIFICATION_ADAPTERS_V1,
  L1_TOOL_VERIFICATION_SUITE_ID_V1,
} from '../../../scripts/evals/contracts/qualification/l1-tool-verification-schema-v1';
import {
  L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
  L2_NATIVE_CONFORMANCE_CASES_V1,
  L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
  L2_NATIVE_CONFORMANCE_TARGETS_V1,
} from '../../../scripts/evals/contracts/qualification/l2-native-conformance-schema-v1';
import { parseArgs } from '../../../src/app/cli';
import {
  CLI_COMMAND_SPECS_V1,
  CLI_FIRST_TOKEN_ALIASES_V1,
  CLI_OPTION_SPECS_V1,
  formatCliHelpV1,
} from '../../../src/app/cli/public-surface';
import { parseSlashCommand, SLASH_COMMAND_DEFS } from '../../../src/app/tui/public-surface';
import { RELEASE_CAPABILITY_IDS_V1 } from '../../../src/core/config/capability-ids';
import { configSchema } from '../../../src/core/config/config-schema';
import { FEATURE_FLAG_DEFINITIONS_V1 } from '../../../src/core/config/features';
import {
  EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1,
  PRODUCTION_DISTRIBUTION_TARGETS_V1,
} from '../../../src/core/config/release-surface-registry';
import { builtinToolSpecs } from '../../../src/core/tools/registry/builtins';
import { CAPABILITY_KINDS_V1 } from '../../../src/protocol/capabilities';

// qualificationCommentOnlySymbol

const always = buildQualificationConditionV1({
  conditionId: 'always-v1',
  kind: 'always',
  parameters: {},
});
const manualDisabled = buildQualificationConditionV1({
  conditionId: 'manual-usability-disabled-v1',
  kind: 'manual_usability_disabled',
  parameters: { enabled: false, governanceRef: 'ADR-0070' },
});

function feature(overrides: Partial<AgentFeatureQualificationSpecV1> = {}) {
  const value = {
    schema: 'AgentFeatureQualificationSpecV1' as const,
    version: 1 as const,
    id: 'TOOL-READ_FILE-001',
    sourceSurfaceId: 'builtin-tool:read_file',
    domain: 'tool' as const,
    observableContract: 'builtin_tool_registry' as const,
    risk: 'p1' as const,
    riskRationale: 'read_only_deterministic_tool' as const,
    sourceRefs: [
      { kind: 'registry' as const, ref: 'src/core/tools/registry/builtins.ts#builtinToolSpecs' },
    ],
    owner: 'core-tools',
    applicability: {
      releaseProfiles: ['internal-dogfood'],
      platforms: ['any' as const],
      entrypoints: ['runtime' as const],
    },
    supportState: 'supported' as const,
    declaredExposure: 'default_on' as const,
    requiredEvidence: [
      {
        layer: 'contract' as const,
        suiteIds: ['source-owned-surface-contract-v1'],
        assertionIds: ['assertion:builtin-tool/read_file'],
        requiredWhen: { conditionId: always.conditionId, conditionDigest: always.conditionDigest },
      },
    ],
    evidenceExclusions: [
      {
        layer: 'manual_usability' as const,
        condition: {
          conditionId: manualDisabled.conditionId,
          conditionDigest: manualDisabled.conditionDigest,
        },
        rationale: 'manual_usability_not_adr_enabled' as const,
      },
    ],
    ...overrides,
  };
  return agentFeatureQualificationSpecV1Schema.parse(value);
}

function fixture(overrides: Partial<AgentFeatureQualificationSpecV1> = {}) {
  const spec = feature(overrides);
  return {
    sourceSurfaces: [
      buildQualificationSourceSurfaceV1({
        sourceSurfaceId: spec.sourceSurfaceId,
        sourceFact: { name: 'read_file', version: 1 },
        feature: spec,
      }),
    ],
    conditions: [always, manualDisabled],
    suites: [
      buildQualificationSuiteV1({
        suiteId: 'source-owned-surface-contract-v1',
        sourceRefs: [
          { kind: 'evaluator', ref: 'scripts/evals/contracts/qualification/feature-matrix.ts' },
        ],
        assertionIds: ['assertion:builtin-tool/read_file'],
        sourceFact: { suite: 'source-owned-surface-contract-v1', revision: 1 },
        evaluatorFact: { evaluator: 'matrix' },
        oracleFact: { oracle: 'strict' },
        corpusFact: { corpus: 'fixture' },
      }),
    ],
  };
}

function publicDocumentationPathsFromRepository(root: string): string[] {
  const paths = ['README.md'];
  const visit = (relativeDirectory: string): void => {
    for (const entry of readdirSync(resolve(root, relativeDirectory), { withFileTypes: true })) {
      const relativePath = join(relativeDirectory, entry.name).replaceAll('\\', '/');
      if (entry.isDirectory()) visit(relativePath);
      else if (entry.isFile() && extname(entry.name).toLowerCase() === '.md')
        paths.push(relativePath);
    }
  };
  visit('docs/active');
  visit('docs/book');
  return paths.sort();
}

describe('source-owned Agent Feature Matrix', () => {
  test('generates a stable digest from source facts, conditions, suite identity, and features', () => {
    const input = fixture();
    const first = generateAgentFeatureQualificationMatrixV1(input);
    const second = generateAgentFeatureQualificationMatrixV1(input);
    expect(first.matrixDigest).toBe(second.matrixDigest);
    expect(first.features).toHaveLength(1);
    expect(first.features[0]?.id).toBe('TOOL-READ_FILE-001');

    const changedSource = fixture();
    changedSource.sourceSurfaces[0] = buildQualificationSourceSurfaceV1({
      sourceSurfaceId: 'builtin-tool:read_file',
      sourceFact: { name: 'read_file', version: 2 },
      feature: changedSource.sourceSurfaces[0]!.feature,
    });
    expect(generateAgentFeatureQualificationMatrixV1(changedSource).matrixDigest).not.toBe(
      first.matrixDigest,
    );

    const changedSuite = fixture();
    changedSuite.suites[0] = buildQualificationSuiteV1({
      suiteId: 'source-owned-surface-contract-v1',
      sourceRefs: [
        { kind: 'evaluator', ref: 'scripts/evals/contracts/qualification/feature-matrix.ts' },
      ],
      assertionIds: ['assertion:builtin-tool/read_file'],
      sourceFact: { suite: 'source-owned-surface-contract-v1', revision: 2 },
      evaluatorFact: { evaluator: 'matrix-v2' },
      oracleFact: { oracle: 'strict' },
      corpusFact: { corpus: 'fixture' },
    });
    expect(generateAgentFeatureQualificationMatrixV1(changedSuite).matrixDigest).not.toBe(
      first.matrixDigest,
    );
  });

  test('rejects missing structured fields, unapproved manual evidence, and unsupported misuse', () => {
    for (const mutation of [
      { owner: '' },
      { riskRationale: '' },
      { sourceRefs: [] },
      { applicability: { releaseProfiles: [], platforms: ['any'], entrypoints: ['runtime'] } },
      { declaredExposure: 'default_on', requiredEvidence: [] },
      { requiredEvidence: [{ ...feature().requiredEvidence[0]!, layer: 'manual_usability' }] },
      {
        supportState: 'unsupported',
        declaredExposure: 'unsupported',
        notApplicableRationale: undefined,
      },
      {
        supportState: 'supported',
        declaredExposure: 'unsupported',
        notApplicableRationale: 'No support.',
      },
    ]) {
      expect(() => feature(mutation as Partial<AgentFeatureQualificationSpecV1>)).toThrow();
    }
  });

  test('requires sorted, source-bound scoped entrypoint absence only for supported features', () => {
    const base = feature();
    const record = {
      entrypoint: 'cli' as const,
      rationale: 'entrypoint_not_exposed' as const,
      sourceFactDigest: `sha256:${'a'.repeat(64)}`,
    };
    expect(
      agentFeatureQualificationSpecV1Schema.parse({
        ...base,
        applicability: {
          ...base.applicability,
          entrypointNotApplicable: [record],
        },
      }).applicability.entrypointNotApplicable,
    ).toEqual([record]);
    for (const invalid of [
      {
        ...base,
        applicability: {
          ...base.applicability,
          entrypointNotApplicable: [{ ...record, entrypoint: 'runtime' }],
        },
      },
      {
        ...base,
        applicability: {
          ...base.applicability,
          entrypointNotApplicable: [
            { ...record, entrypoint: 'tui' },
            { ...record, entrypoint: 'cli' },
          ],
        },
      },
      {
        ...base,
        supportState: 'unsupported',
        declaredExposure: 'unsupported',
        notApplicableRationale: 'source_not_supported',
        applicability: {
          ...base.applicability,
          entrypointNotApplicable: [record],
        },
      },
    ]) {
      expect(() => agentFeatureQualificationSpecV1Schema.parse(invalid)).toThrow();
    }
  });

  test('rejects test-only refs, unknown structured conditions, unknown assertions, and unmapped source surfaces', () => {
    expect(() =>
      feature({ sourceRefs: [{ kind: 'contract', ref: 'tests/evals/fake.test.ts' }] }),
    ).toThrow('test-only');
    for (const ref of [
      'src/https://example.invalid/path.ts',
      'src/core/../secret.ts',
      '/tmp/qualification.ts',
      'src/core/config.ts?endpoint=https://example.invalid',
      'src/core/config.ts#not/a/symbol',
      `src/core/${String.fromCharCode(0)}config.ts`,
    ]) {
      expect(() => feature({ sourceRefs: [{ kind: 'contract', ref }] })).toThrow();
    }
    expect(() =>
      buildQualificationSuiteV1({
        suiteId: 'source-owned-surface-contract-v1',
        sourceRefs: [{ kind: 'test', ref: 'tests/evals/unrelated.test.ts' }],
        assertionIds: ['assertion:builtin-tool/read_file'],
        sourceFact: { suite: 'source-owned-surface-contract-v1' },
        evaluatorFact: { evaluator: 'matrix' },
        oracleFact: { oracle: 'strict' },
        corpusFact: { corpus: 'fixture' },
      }),
    ).toThrow('safe qualification');

    const unknownCondition = fixture();
    unknownCondition.sourceSurfaces[0] = buildQualificationSourceSurfaceV1({
      sourceSurfaceId: 'builtin-tool:read_file',
      sourceFact: { name: 'read_file' },
      feature: feature({
        requiredEvidence: [
          {
            layer: 'contract',
            suiteIds: ['source-owned-surface-contract-v1'],
            assertionIds: ['assertion:builtin-tool/read_file'],
            requiredWhen: {
              conditionId: 'free-prose-green',
              conditionDigest: always.conditionDigest,
            },
          },
        ],
      }),
    });
    expect(() => generateAgentFeatureQualificationMatrixV1(unknownCondition)).toThrow(
      'unknown_or_drifted_condition',
    );

    const unknownAssertion = fixture();
    unknownAssertion.sourceSurfaces[0] = buildQualificationSourceSurfaceV1({
      sourceSurfaceId: 'builtin-tool:read_file',
      sourceFact: { name: 'read_file' },
      feature: feature({
        requiredEvidence: [
          {
            layer: 'contract',
            suiteIds: ['source-owned-surface-contract-v1'],
            assertionIds: ['assertion:missing'],
            requiredWhen: {
              conditionId: always.conditionId,
              conditionDigest: always.conditionDigest,
            },
          },
        ],
      }),
    });
    expect(() => generateAgentFeatureQualificationMatrixV1(unknownAssertion)).toThrow(
      'unknown_assertion',
    );

    const unknownSuite = fixture();
    unknownSuite.sourceSurfaces[0] = buildQualificationSourceSurfaceV1({
      sourceSurfaceId: 'builtin-tool:read_file',
      sourceFact: { name: 'read_file' },
      feature: feature({
        requiredEvidence: [
          {
            layer: 'native',
            suiteIds: ['qualification-missing-suite-v1'],
            assertionIds: ['assertion:builtin-tool/read_file'],
            requiredWhen: {
              conditionId: always.conditionId,
              conditionDigest: always.conditionDigest,
            },
          },
        ],
      }),
    });
    expect(() => generateAgentFeatureQualificationMatrixV1(unknownSuite)).toThrow(
      'unknown_suite:TOOL-READ_FILE-001:qualification-missing-suite-v1',
    );

    expect(() =>
      buildQualificationSourceSurfaceV1({
        sourceSurfaceId: 'builtin-tool:read_file',
        sourceFact: { name: 'read_file' },
        feature: feature({ sourceSurfaceId: 'builtin-tool:unmapped' }),
      }),
    ).toThrow('exact source surface');
  });

  test('makes default-on features explicitly exclude unapproved manual usability evidence', () => {
    const noManualExclusion = fixture();
    noManualExclusion.sourceSurfaces[0] = buildQualificationSourceSurfaceV1({
      sourceSurfaceId: 'builtin-tool:read_file',
      sourceFact: { name: 'read_file' },
      feature: feature({ evidenceExclusions: [] }),
    });
    expect(() => generateAgentFeatureQualificationMatrixV1(noManualExclusion)).toThrow(
      'manual_usability_exclusion_missing',
    );
  });

  test('requires structured enablement plus a verified safe-disable condition for experimental flags and rejection for disabled surfaces', () => {
    const flagEnabled = buildQualificationConditionV1({
      conditionId: 'feature-flag-example-on-v1',
      kind: 'feature_flag_enabled',
      parameters: { flagId: 'example', expected: true },
    });
    const entryRejected = buildQualificationConditionV1({
      conditionId: 'entry-rejection-cli-example-v1',
      kind: 'entry_rejection',
      parameters: {
        entrypointId: 'cli',
        denialFamily: 'example_rejected',
        sourceFactDigest: `sha256:${'a'.repeat(64)}`,
      },
    });
    const safelyDisabled = buildQualificationConditionV1({
      conditionId: 'default-off-safe-disable-cli-example-v1',
      kind: 'default_off_safe_disable',
      parameters: {
        flagId: 'example',
        entrypointId: 'cli',
        sourceFactDigest: `sha256:${'b'.repeat(64)}`,
      },
    });
    const experimental = fixture({
      declaredExposure: 'experimental_default_off',
      applicability: {
        ...feature().applicability,
        entrypoints: ['cli'],
        featureFlags: ['example'],
      },
      requiredEvidence: [
        {
          ...feature().requiredEvidence[0]!,
          requiredWhen: {
            conditionId: flagEnabled.conditionId,
            conditionDigest: flagEnabled.conditionDigest,
          },
        },
        {
          ...feature().requiredEvidence[0]!,
          requiredWhen: {
            conditionId: safelyDisabled.conditionId,
            conditionDigest: safelyDisabled.conditionDigest,
          },
        },
      ],
    });
    experimental.conditions = [always, safelyDisabled, flagEnabled, manualDisabled];
    expect(() => generateAgentFeatureQualificationMatrixV1(experimental)).not.toThrow();

    const experimentalWithoutEnablement = fixture({ declaredExposure: 'experimental_default_off' });
    expect(() => generateAgentFeatureQualificationMatrixV1(experimentalWithoutEnablement)).toThrow(
      'feature_flag_enablement_requirement_missing',
    );

    const experimentalWithoutSafeDisable = fixture({
      declaredExposure: 'experimental_default_off',
      applicability: {
        ...feature().applicability,
        entrypoints: ['cli'],
        featureFlags: ['example'],
      },
      requiredEvidence: [
        {
          ...feature().requiredEvidence[0]!,
          requiredWhen: {
            conditionId: flagEnabled.conditionId,
            conditionDigest: flagEnabled.conditionDigest,
          },
        },
      ],
    });
    experimentalWithoutSafeDisable.conditions = [always, flagEnabled, manualDisabled];
    expect(() => generateAgentFeatureQualificationMatrixV1(experimentalWithoutSafeDisable)).toThrow(
      'default_off_safe_disable_requirement_missing',
    );

    const disabled = fixture({
      declaredExposure: 'disabled',
      applicability: { ...feature().applicability, entrypoints: ['cli'] },
      requiredEvidence: [
        {
          ...feature().requiredEvidence[0]!,
          requiredWhen: {
            conditionId: entryRejected.conditionId,
            conditionDigest: entryRejected.conditionDigest,
          },
        },
      ],
    });
    disabled.conditions = [always, entryRejected, manualDisabled];
    expect(() => generateAgentFeatureQualificationMatrixV1(disabled)).not.toThrow();

    const disabledWithoutRejection = fixture({ declaredExposure: 'disabled' });
    expect(() => generateAgentFeatureQualificationMatrixV1(disabledWithoutRejection)).toThrow(
      'entry_rejection_requirement_missing',
    );
  });

  test('covers source-owned registries, recursive config, CLI, TUI, profiles, and public operation contracts', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const matrix = generateSourceOwnedFeatureMatrixV1();
    const publicOperations = discoverSourceOwnedPublicOperationsV1();
    const l0Bindings = discoverSourceOwnedL0ContractBindingsV1();
    const l1Bindings = discoverSourceOwnedL1ToolVerificationBindingsV1();
    const l1ProjectionBindings = discoverSourceOwnedL1PublicProjectionBindingsV1();
    const l1SkillMcpBindings = discoverSourceOwnedL1SkillMcpBindingsV1();
    const sourceIds = new Set(catalog.sourceSurfaces.map((surface) => surface.sourceSurfaceId));
    expect(catalog.sourceSurfaces.length).toBeGreaterThan(70);

    for (const spec of builtinToolSpecs)
      expect(sourceIds.has(`builtin-tool:${spec.name}`)).toBe(true);
    for (const flag of Object.keys(FEATURE_FLAG_DEFINITIONS_V1)) {
      expect(sourceIds.has(`feature-flag:${flag}`)).toBe(true);
      expect(sourceIds.has(`config-schema:/features/${flag}`)).toBe(true);
    }
    const expectedConfigIds = new Set(
      configSchemaPointers(z.toJSONSchema(configSchema)).map(
        ({ pointer }) => `config-schema:${pointer.replaceAll('*', 'wildcard')}`,
      ),
    );
    const actualConfigIds = new Set(
      [...sourceIds].filter((sourceId) => sourceId.startsWith('config-schema:')),
    );
    expect(actualConfigIds).toEqual(expectedConfigIds);
    for (const branch of [0, 1, 2, 3]) {
      expect(sourceIds.has(`config-schema:/mcpServers/wildcard/auth/oneOf-${branch}`)).toBe(true);
    }
    for (const command of CLI_COMMAND_SPECS_V1) {
      expect(sourceIds.has(`cli-command:${command.command}`)).toBe(true);
      expect(parseArgs([command.command]).command).toBe(command.command);
    }
    expect(parseArgs(['--help']).command).toBe('help');
    expect(parseArgs(['run', '--help']).command).toBe('run');
    expect(CLI_FIRST_TOKEN_ALIASES_V1).toContainEqual({ token: '--help', command: 'help' });
    expect(parseArgs(['run', '--full-access']).approvalGrant).toBe('full_access');
    expect(() => parseArgs(['run', '--feature', 'executionBoundaryV1=true'])).toThrow(
      'release-controlled',
    );
    for (const option of CLI_OPTION_SPECS_V1) {
      expect(sourceIds.has(`cli-option:${option.id}`)).toBe(true);
      if (option.id !== 'version') expect(formatCliHelpV1()).toContain(option.flag);
    }
    for (const command of SLASH_COMMAND_DEFS) {
      expect(sourceIds.has(`tui-command:${command.name}`)).toBe(true);
      expect(parseSlashCommand(`/${command.name}`)?.type).not.toBe('unknown');
      for (const alias of command.aliases)
        expect(parseSlashCommand(`/${alias}`)?.type).not.toBe('unknown');
    }
    for (const capability of RELEASE_CAPABILITY_IDS_V1) {
      expect(sourceIds.has(`release-capability:${capability}`)).toBe(true);
    }
    expect(sourceIds.has('capability-catalog:protocol')).toBe(true);
    const publicDocumentationPaths = discoverSourceOwnedPublicDocumentationPathsV1();
    expect(publicDocumentationPaths).toEqual(publicDocumentationPathsFromRepository(process.cwd()));
    for (const relativePath of publicDocumentationPaths) {
      expect(sourceIds.has(publicDocumentationSurfaceIdV1(relativePath))).toBe(true);
      expect(readFileSync(resolve(process.cwd(), relativePath), 'utf8')).not.toContain(
        '<!-- @qualification-surface-v1',
      );
    }
    expect(CAPABILITY_KINDS_V1).toEqual([
      'builtin_tool',
      'mcp_tool',
      'mcp_resource',
      'mcp_prompt',
      'skill',
      'subagent',
    ]);
    for (const profile of EMBEDDED_RELEASE_PROFILE_DECLARATIONS_V1) {
      expect(sourceIds.has(`release-profile:${profile.profileId}`)).toBe(true);
    }
    for (const target of Object.values(PRODUCTION_DISTRIBUTION_TARGETS_V1)) {
      expect(sourceIds.has(`distribution-target:${target.identity}`)).toBe(true);
    }
    const l2Suite = catalog.suites.find(
      (candidate) => candidate.suiteId === L2_NATIVE_CONFORMANCE_SUITE_ID_V1,
    );
    expect(l2Suite?.assertionIds).toEqual([...L2_NATIVE_CONFORMANCE_CASE_IDS_V1]);
    expect(registeredQualificationSuiteRoleV1(L2_NATIVE_CONFORMANCE_SUITE_ID_V1)).toBe(
      'behavioral',
    );

    const nativeAssertionIds = (feature: {
      requiredEvidence: readonly {
        layer: string;
        suiteIds: readonly string[];
        assertionIds: readonly string[];
      }[];
    }) =>
      feature.requiredEvidence
        .filter(
          (requirement) =>
            requirement.layer === 'native' &&
            requirement.suiteIds.includes(L2_NATIVE_CONFORMANCE_SUITE_ID_V1),
        )
        .flatMap((requirement) => requirement.assertionIds)
        .sort();

    const catalogNativeAssertionIds = catalog.sourceSurfaces
      .flatMap((surface) => nativeAssertionIds(surface.feature))
      .sort();
    expect(catalogNativeAssertionIds).toEqual([...L2_NATIVE_CONFORMANCE_CASE_IDS_V1]);

    for (const target of L2_NATIVE_CONFORMANCE_TARGETS_V1) {
      const sourceSurfaceId = `distribution-target:${target.distributionTargetId}`;
      const expectedCaseIds = L2_NATIVE_CONFORMANCE_CASES_V1.filter(
        (entry) =>
          entry.target.distributionTargetId === target.distributionTargetId &&
          entry.capabilityId !== 'standalone_keyring_unavailable',
      )
        .map((entry) => entry.caseId)
        .sort();
      expect(expectedCaseIds).toHaveLength(4);

      const sourceSurface = catalog.sourceSurfaces.find(
        (candidate) => candidate.sourceSurfaceId === sourceSurfaceId,
      );
      const matrixFeature = matrix.features.find(
        (candidate) => candidate.sourceSurfaceId === sourceSurfaceId,
      );
      expect(nativeAssertionIds(sourceSurface!.feature)).toEqual(expectedCaseIds);
      expect(nativeAssertionIds(matrixFeature!)).toEqual(expectedCaseIds);
    }

    const standaloneKeyringCaseIds = L2_NATIVE_CONFORMANCE_CASES_V1.filter(
      (entry) => entry.capabilityId === 'standalone_keyring_unavailable',
    )
      .map((entry) => entry.caseId)
      .sort();
    expect(standaloneKeyringCaseIds).toHaveLength(3);
    const standaloneKeyringSurface = catalog.sourceSurfaces.find(
      (candidate) => candidate.sourceSurfaceId === 'standalone-keyring:unavailable',
    );
    const standaloneKeyringFeature = matrix.features.find(
      (candidate) => candidate.sourceSurfaceId === 'standalone-keyring:unavailable',
    );
    expect(nativeAssertionIds(standaloneKeyringSurface!.feature)).toEqual(standaloneKeyringCaseIds);
    expect(nativeAssertionIds(standaloneKeyringFeature!)).toEqual(standaloneKeyringCaseIds);
    const standaloneKeyringDisclosureRefs = [
      'release/oss-first-release/KNOWN_LIMITATIONS.md',
      'release/oss-first-release/RELEASE_NOTES.md',
    ] as const;
    const keyringEntrypointAbsenceRefs = [
      'src/app/cli/public-surface.ts#CLI_COMMAND_SPECS_V1',
      'src/app/cli/public-surface.ts#CLI_OPTION_SPECS_V1',
      'src/app/tui/public-surface.ts#SLASH_COMMAND_DEFS',
    ] as const;
    expect(standaloneKeyringSurface!.feature).toMatchObject({
      supportState: 'supported',
      declaredExposure: 'default_on',
      applicability: { entrypoints: ['runtime'] },
    });
    expect(standaloneKeyringSurface!.feature.sourceRefs).toEqual(
      expect.arrayContaining([
        ...standaloneKeyringDisclosureRefs.map((ref) => ({ kind: 'public_surface', ref })),
        ...keyringEntrypointAbsenceRefs.map((ref) => ({ kind: 'public_surface', ref })),
      ]),
    );
    const keyringEntrypointNotApplicable =
      standaloneKeyringSurface!.feature.applicability.entrypointNotApplicable;
    expect(keyringEntrypointNotApplicable).toHaveLength(2);
    expect(
      keyringEntrypointNotApplicable?.map(({ entrypoint, rationale }) => ({
        entrypoint,
        rationale,
      })),
    ).toEqual([
      { entrypoint: 'cli', rationale: 'entrypoint_not_exposed' },
      { entrypoint: 'tui', rationale: 'entrypoint_not_exposed' },
    ]);
    for (const record of keyringEntrypointNotApplicable ?? []) {
      expect(record.sourceFactDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    }

    const credentialPublicEntrypointCandidates =
      collectSourceOwnedPublicCredentialEntrypointCandidatesV1();
    expect(() =>
      assertSourceOwnedNoCredentialPublicEntrypointsV1(credentialPublicEntrypointCandidates),
    ).not.toThrow();
    expect(() =>
      assertSourceOwnedNoCredentialPublicEntrypointsV1([
        ...credentialPublicEntrypointCandidates,
        {
          entrypoint: 'cli',
          kind: 'cli_option',
          identifier: 'credential-store',
          publicText: '--credential-store',
        },
      ]),
    ).toThrow('qualification_standalone_keyring_public_credential_entrypoint_exposed');
    const keyringEntrypointAbsenceSourceFiles = keyringEntrypointAbsenceRefs.map((ref) => {
      const relativePath = ref.split('#', 1)[0]!;
      return {
        ref,
        sourceContentDigest: computeQualificationSourceFactDigestV1({
          relativePath,
          content: readFileSync(resolve(process.cwd(), relativePath), 'utf8'),
        }),
      };
    });
    for (const record of keyringEntrypointNotApplicable ?? []) {
      expect(record.sourceFactDigest).toBe(
        computeQualificationSourceFactDigestV1({
          schema: 'SourceOwnedCredentialEntrypointAbsenceV1',
          version: 1,
          entrypoint: record.entrypoint,
          selector: 'credential_specific_public_entrypoint_v1',
          sourceFiles: keyringEntrypointAbsenceSourceFiles,
          publicEntrypoints: credentialPublicEntrypointCandidates.filter(
            (candidate) => candidate.entrypoint === record.entrypoint,
          ),
        }),
      );
    }
    const cliEntrypointAbsence = keyringEntrypointNotApplicable?.find(
      (record) => record.entrypoint === 'cli',
    );
    const driftedCliSourceFiles = keyringEntrypointAbsenceSourceFiles.map((sourceFile) =>
      sourceFile.ref === 'src/app/cli/public-surface.ts#CLI_COMMAND_SPECS_V1'
        ? {
            ...sourceFile,
            sourceContentDigest: computeQualificationSourceFactDigestV1({
              relativePath: 'src/app/cli/public-surface.ts',
              content: `${readFileSync(resolve(process.cwd(), 'src/app/cli/public-surface.ts'), 'utf8')}\nqualification-public-surface-drift`,
            }),
          }
        : sourceFile,
    );
    expect(cliEntrypointAbsence).toBeDefined();
    expect(
      computeQualificationSourceFactDigestV1({
        schema: 'SourceOwnedCredentialEntrypointAbsenceV1',
        version: 1,
        entrypoint: 'cli',
        selector: 'credential_specific_public_entrypoint_v1',
        sourceFiles: driftedCliSourceFiles,
        publicEntrypoints: credentialPublicEntrypointCandidates.filter(
          (candidate) => candidate.entrypoint === 'cli',
        ),
      }),
    ).not.toBe(cliEntrypointAbsence!.sourceFactDigest);

    const keyringSourceFiles = standaloneKeyringSurface!.feature.sourceRefs.map((sourceRef) => {
      const relativePath = sourceRef.ref.split('#', 1)[0]!;
      return {
        ref: sourceRef.ref,
        sourceContentDigest: computeQualificationSourceFactDigestV1({
          relativePath,
          content: readFileSync(resolve(process.cwd(), relativePath), 'utf8'),
        }),
      };
    });
    const keyringDeclaration = {
      source: 'standalone-keyring-unavailable-v1',
      candidateResolver: 'createStandaloneReleaseStubsV1',
      disclosureDocuments: [...standaloneKeyringDisclosureRefs],
      entrypointNotApplicable: keyringEntrypointNotApplicable,
    };
    expect(standaloneKeyringSurface!.sourceFactDigest).toBe(
      computeQualificationSourceFactDigestV1({
        declaration: keyringDeclaration,
        sourceFiles: keyringSourceFiles,
      }),
    );
    for (const disclosureRef of standaloneKeyringDisclosureRefs) {
      const originalContent = readFileSync(resolve(process.cwd(), disclosureRef), 'utf8');
      const driftedSourceFiles = keyringSourceFiles.map((sourceFile) =>
        sourceFile.ref === disclosureRef
          ? {
              ...sourceFile,
              sourceContentDigest: computeQualificationSourceFactDigestV1({
                relativePath: disclosureRef,
                content: `${originalContent}\nqualification-disclosure-drift`,
              }),
            }
          : sourceFile,
      );
      const driftedSourceFactDigest = computeQualificationSourceFactDigestV1({
        declaration: keyringDeclaration,
        sourceFiles: driftedSourceFiles,
      });
      expect(driftedSourceFactDigest).not.toBe(standaloneKeyringSurface!.sourceFactDigest);
      expect(
        computeQualificationSourceSurfaceDigestV1({
          sourceSurfaceId: standaloneKeyringSurface!.sourceSurfaceId,
          sourceFactDigest: driftedSourceFactDigest,
          feature: standaloneKeyringSurface!.feature,
        }),
      ).not.toBe(standaloneKeyringSurface!.sourceDigest);
    }
    const l2Bindings = discoverSourceOwnedL2NativeConformanceBindingsV1(
      process.cwd(),
      catalog.sourceSurfaces,
    );
    expect(l2Bindings.map((binding) => binding.assertionId)).toEqual([
      ...L2_NATIVE_CONFORMANCE_CASE_IDS_V1,
    ]);
    for (const binding of l2Bindings) {
      const surface = catalog.sourceSurfaces.find(
        (candidate) => candidate.sourceSurfaceId === binding.sourceSurfaceId,
      );
      expect(surface).toBeDefined();
      expect(surface!.sourceDigest).toBe(binding.sourceDigest);
      expect(binding.case.caseId).toBe(binding.assertionId);
      expect(nativeAssertionIds(surface!.feature)).toContain(binding.case.caseId);
    }
    const l2FeatureSplice = l2Bindings.map((binding) => ({ ...binding }));
    l2FeatureSplice[0] = {
      ...l2FeatureSplice[0]!,
      featureId: 'RELEASE-FOREIGN-001',
    };
    expect(() => assertSourceOwnedL2NativeConformanceBindingProvenanceV1(l2FeatureSplice)).toThrow(
      'qualification_l2_native_source_binding_mismatch',
    );

    for (const declaration of publicOperations) {
      const surface = catalog.sourceSurfaces.find(
        (candidate) => candidate.sourceSurfaceId === declaration.sourceSurfaceId,
      );
      expect(surface?.feature.id).toBe(declaration.featureId);
      expect(surface?.feature.sourceRefs).toEqual(declaration.sourceRefs);
    }
    expect(
      l0Bindings.map((binding) => ({
        adapterId: binding.binding.adapterId,
        assertionId: binding.binding.assertionId,
      })),
    ).toEqual([...L0_CONTRACT_ADAPTERS_V1]);
    const l0Suite = catalog.suites.find(
      (candidate) => candidate.suiteId === L0_CONTRACT_SUITE_ID_V1,
    );
    expect(l0Suite?.assertionIds).toEqual(
      [...L0_CONTRACT_ADAPTERS_V1].map((entry) => entry.assertionId).sort(),
    );
    for (const binding of l0Bindings) {
      const feature = matrix.features.find((candidate) => candidate.id === binding.featureId);
      expect(feature?.requiredEvidence).toContainEqual(
        expect.objectContaining({
          layer: 'contract',
          suiteIds: [L0_CONTRACT_SUITE_ID_V1],
          assertionIds: [binding.binding.assertionId],
        }),
      );
    }
    expect(
      l0Bindings.map((binding) => ({
        adapterId: binding.binding.adapterId,
        assertionId: binding.binding.assertionId,
        sourceRef: binding.sourceRef.ref,
      })),
    ).toEqual([...L0_CONTRACT_ADAPTER_IMPLEMENTATIONS_V1]);
    const relocated = l0Bindings.map((binding) => ({ ...binding }));
    relocated[0] = {
      ...relocated[0]!,
      sourceRef: { ...relocated[1]!.sourceRef },
    };
    expect(() => assertSourceOwnedL0ContractBindingProvenanceV1(relocated)).toThrow(
      'qualification_l0_adapter_source_provenance_mismatch',
    );
    expect(
      l1Bindings
        .map((binding) => `${binding.binding.adapterId}:${binding.binding.assertionId}`)
        .sort(),
    ).toEqual(
      L1_TOOL_VERIFICATION_ADAPTERS_V1.map(
        (binding) => `${binding.adapterId}:${binding.assertionId}`,
      ).sort(),
    );
    const l1Suite = catalog.suites.find(
      (candidate) => candidate.suiteId === L1_TOOL_VERIFICATION_SUITE_ID_V1,
    );
    expect(l1Suite?.assertionIds).toEqual(
      L1_TOOL_VERIFICATION_ADAPTERS_V1.map((entry) => entry.assertionId).sort(),
    );
    for (const binding of l1Bindings) {
      const feature = matrix.features.find((candidate) => candidate.id === binding.featureId);
      expect(feature?.requiredEvidence).toContainEqual(
        expect.objectContaining({
          layer: 'scripted_runtime',
          suiteIds: [L1_TOOL_VERIFICATION_SUITE_ID_V1],
          assertionIds: [binding.binding.assertionId],
        }),
      );
    }
    expect(
      l1Bindings
        .map((binding) => ({
          adapterId: binding.binding.adapterId,
          assertionId: binding.binding.assertionId,
          sourceRef: binding.sourceRef.ref,
        }))
        .sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
    ).toEqual(
      [...L1_TOOL_VERIFICATION_ADAPTER_IMPLEMENTATIONS_V1].sort((left, right) =>
        left.adapterId.localeCompare(right.adapterId),
      ),
    );
    const relocatedL1 = l1Bindings.map((binding) => ({ ...binding }));
    relocatedL1[0] = {
      ...relocatedL1[0]!,
      sourceRef: { ...relocatedL1[1]!.sourceRef },
    };
    expect(() => assertSourceOwnedL1ToolVerificationBindingProvenanceV1(relocatedL1)).toThrow(
      'qualification_l1_adapter_source_provenance_mismatch',
    );
    expect(
      l1ProjectionBindings
        .map((binding) => `${binding.binding.adapterId}:${binding.binding.assertionId}`)
        .sort(),
    ).toEqual(
      L1_PUBLIC_PROJECTION_ADAPTERS_V1.map(
        (binding) => `${binding.adapterId}:${binding.assertionId}`,
      ).sort(),
    );
    const l1ProjectionSuite = catalog.suites.find(
      (candidate) => candidate.suiteId === L1_PUBLIC_PROJECTION_SUITE_ID_V1,
    );
    expect(l1ProjectionSuite?.assertionIds).toEqual(
      L1_PUBLIC_PROJECTION_ADAPTERS_V1.map((entry) => entry.assertionId).sort(),
    );
    for (const binding of l1ProjectionBindings) {
      const feature = matrix.features.find((candidate) => candidate.id === binding.featureId);
      expect(feature?.requiredEvidence).toContainEqual(
        expect.objectContaining({
          layer: 'scripted_runtime',
          suiteIds: [L1_PUBLIC_PROJECTION_SUITE_ID_V1],
          assertionIds: [binding.binding.assertionId],
        }),
      );
    }
    expect(
      l1ProjectionBindings
        .map((binding) => ({
          adapterId: binding.binding.adapterId,
          assertionId: binding.binding.assertionId,
          sourceRef: binding.sourceRef.ref,
        }))
        .sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
    ).toEqual(
      [...L1_PUBLIC_PROJECTION_ADAPTER_IMPLEMENTATIONS_V1].sort((left, right) =>
        left.adapterId.localeCompare(right.adapterId),
      ),
    );
    const relocatedL1Projection = l1ProjectionBindings.map((binding) => ({ ...binding }));
    relocatedL1Projection[0] = {
      ...relocatedL1Projection[0]!,
      sourceRef: { ...relocatedL1Projection[2]!.sourceRef },
    };
    expect(() =>
      assertSourceOwnedL1PublicProjectionBindingProvenanceV1(relocatedL1Projection),
    ).toThrow('qualification_l1_projection_adapter_source_provenance_mismatch');
    expect(
      l1SkillMcpBindings
        .map((binding) => `${binding.binding.adapterId}:${binding.binding.assertionId}`)
        .sort(),
    ).toEqual(
      L1_SKILL_MCP_ADAPTERS_V1.map(
        (binding) => `${binding.adapterId}:${binding.assertionId}`,
      ).sort(),
    );
    const l1SkillMcpSuite = catalog.suites.find(
      (candidate) => candidate.suiteId === L1_SKILL_MCP_SUITE_ID_V1,
    );
    expect(l1SkillMcpSuite?.assertionIds).toEqual(
      L1_SKILL_MCP_ADAPTERS_V1.map((entry) => entry.assertionId).sort(),
    );
    for (const binding of l1SkillMcpBindings) {
      const feature = matrix.features.find((candidate) => candidate.id === binding.featureId);
      expect(feature?.requiredEvidence).toContainEqual(
        expect.objectContaining({
          layer: 'scripted_runtime',
          suiteIds: [L1_SKILL_MCP_SUITE_ID_V1],
          assertionIds: [binding.binding.assertionId],
        }),
      );
    }
    expect(
      l1SkillMcpBindings
        .map((binding) => ({
          adapterId: binding.binding.adapterId,
          assertionId: binding.binding.assertionId,
          sourceRef: binding.sourceRef.ref,
        }))
        .sort((left, right) => left.adapterId.localeCompare(right.adapterId)),
    ).toEqual(
      [...L1_SKILL_MCP_ADAPTER_IMPLEMENTATIONS_V1].sort((left, right) =>
        left.adapterId.localeCompare(right.adapterId),
      ),
    );
    const relocatedL1SkillMcp = l1SkillMcpBindings.map((binding) => ({ ...binding }));
    relocatedL1SkillMcp[0] = {
      ...relocatedL1SkillMcp[0]!,
      sourceRef: { ...relocatedL1SkillMcp[1]!.sourceRef },
    };
    expect(() => assertSourceOwnedL1SkillMcpBindingProvenanceV1(relocatedL1SkillMcp)).toThrow(
      'qualification_l1_skill_mcp_adapter_source_provenance_mismatch',
    );
    for (const surface of catalog.sourceSurfaces) {
      for (const sourceRef of surface.feature.sourceRefs) {
        expect(() => assertQualificationSourceReferenceV1(sourceRef)).not.toThrow();
      }
    }

    expect(matrix.features.map((entry) => entry.id)).toContain('TOOL-READ_FILE-001');
    expect(matrix.features.map((entry) => entry.id)).toContain('FLAG-CONTEXTCOMPACTIONAUTOV1-001');
    expect(matrix.features.map((entry) => entry.id)).toContain('TUI-SLASH_COMPACT-001');
    expect(matrix.features.map((entry) => entry.id)).toContain('RUNTIME-SESSION_RESUME-001');
    expect(matrix.features.map((entry) => entry.id)).toContain('CAPABILITY-CATALOG_PROTOCOL-001');
    const resume = matrix.features.find((entry) => entry.sourceSurfaceId === 'cli-command:resume');
    expect(resume).toMatchObject({
      supportState: 'unsupported',
      declaredExposure: 'unsupported',
      notApplicableRationale: 'legacy_resume_rejected',
    });
    const entryRejection = catalog.conditions.find(
      (condition) => condition.conditionId === 'entry-rejection-cli-legacy_resume_rejected-v1',
    );
    expect(entryRejection).toMatchObject({ kind: 'entry_rejection' });
    expect(
      (entryRejection as { parameters?: { sourceFactDigest?: string } }).parameters
        ?.sourceFactDigest,
    ).toMatch(/^sha256:[a-f0-9]{64}$/);
    const rendered = JSON.stringify(matrix);
    expect(rendered).not.toContain('api.deepseek.com');
    expect(rendered).not.toContain('Implementation context.');
    expect(rendered).not.toContain('Legacy checkpoint sessions');
    expect(rendered).not.toContain('https://');
  }, 20_000);

  test('fails closed when a caller supplies a non-repository source root or unsupported schema reference', () => {
    expect(() => collectSourceOwnedQualificationSurfacesV1('/private/tmp')).toThrow(
      'qualification_source_root_mismatch',
    );
    expect(() => configSchemaPointers({ $ref: '#/$defs/missing', $defs: {} })).toThrow(
      'qualification_config_schema_missing_ref',
    );
    expect(() => configSchemaPointers({ $ref: 'https://example.invalid/schema' })).toThrow(
      'qualification_config_schema_unsupported_ref',
    );
  });

  test('resolves source fragments as AST declarations rather than textual tokens', () => {
    expect(() =>
      assertQualificationSourceReferenceV1({
        kind: 'test',
        ref: 'tests/evals/qualification/feature-matrix.test.ts#qualificationCommentOnlySymbol',
      }),
    ).toThrow('qualification_source_ref_symbol_missing');
    expect(() =>
      assertQualificationSourceReferenceV1({
        kind: 'test',
        ref: 'tests/evals/qualification/feature-matrix.test.ts#fixture',
      }),
    ).not.toThrow();
  });

  test('discovers only exact annotations adjacent to their declared symbols', () => {
    const annotation = JSON.stringify({
      sourceSurfaceId: 'runtime:fixture',
      featureId: 'RUNTIME-FIXTURE-001',
      domain: 'runtime',
      observableContract: 'runtime_snapshot_recovery',
      risk: 'p1',
      riskRationale: 'recovery_authorization_boundary',
      owner: 'core-runtime',
      entrypoints: ['runtime'],
      sourceKind: 'contract',
      symbol: 'fixtureOperation',
    });
    expect(
      parseSourceOwnedOperationAnnotationsV1(
        'src/core/fixture.ts',
        `const forged = "@qualification-surface-v1 ${annotation}";`,
      ),
    ).toEqual([]);
    expect(
      parseSourceOwnedOperationAnnotationsV1(
        'src/core/fixture.ts',
        `/** @qualification-surface-v1 ${annotation} */\nexport const fixtureOperation = () => undefined;`,
      ),
    ).toHaveLength(1);
    expect(() =>
      parseSourceOwnedOperationAnnotationsV1(
        'src/core/fixture.ts',
        `/** @qualification-surface-v1 ${annotation} */\nexport const anotherOperation = () => undefined;`,
      ),
    ).toThrow('qualification_source_declaration_symbol_mismatch');
  });

  test('derives entry-rejection provenance from product-owned declarations', () => {
    const bindings = discoverSourceOwnedEntryRejectionBindingsV1();
    expect(
      bindings
        .filter(
          (binding) =>
            binding.entrypointId === 'cli' && binding.denialFamily === 'legacy_resume_rejected',
        )
        .map((binding) => binding.sourceRef.ref),
    ).toEqual(['src/app/cli/index.ts#main', 'src/app/cli/public-surface.ts#CLI_COMMAND_SPECS_V1']);
    expect(
      bindings
        .filter(
          (binding) =>
            binding.entrypointId === 'runtime' && binding.denialFamily === 'capability_ceiling_off',
        )
        .map((binding) => binding.sourceRef.ref),
    ).toEqual([
      'src/core/config/release-profile.ts#allCapabilitiesOff',
      'src/core/config/release-profile.ts#failClosedEmbeddedProfile',
    ]);
    const annotation = JSON.stringify({
      entrypointId: 'runtime',
      denialFamily: 'fixture_rejected',
      sourceKind: 'contract',
      symbol: 'fixtureRejection',
    });
    expect(
      parseSourceOwnedEntryRejectionAnnotationsV1(
        'src/core/fixture.ts',
        `const forged = "@qualification-entry-rejection-v1 ${annotation}";`,
      ),
    ).toEqual([]);
    expect(
      parseSourceOwnedEntryRejectionAnnotationsV1(
        'src/core/fixture.ts',
        `/** @qualification-entry-rejection-v1 ${annotation} */\nexport const fixtureRejection = () => undefined;`,
      ),
    ).toHaveLength(1);
  });

  test('binds every implemented default-off flag to product guards and only exposes verified safe disables', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    for (const [flagId, definition] of Object.entries(FEATURE_FLAG_DEFINITIONS_V1)) {
      if (definition.defaultEnabled) continue;
      const surface = catalog.sourceSurfaces.find(
        (candidate) => candidate.sourceSurfaceId === `feature-flag:${flagId}`,
      );
      expect(surface).toBeDefined();
      if (definition.implementationState === 'declared_only') {
        expect(surface?.feature).toMatchObject({
          supportState: 'unsupported',
          declaredExposure: 'unsupported',
          notApplicableRationale: 'source_not_supported',
        });
        expect(() => discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(flagId)).toThrow(
          'not_default_off_implemented',
        );
        continue;
      }
      const bindings = discoverSourceOwnedDefaultOffFeatureFlagBindingsV1(flagId);
      expect(bindings.length).toBeGreaterThan(0);
      expect(surface?.feature.applicability.entrypoints).toEqual(
        [...new Set(bindings.map((binding) => binding.entrypointId))].sort(),
      );
      for (const binding of bindings) {
        expect(binding.flagId).toBe(flagId);
        expect(() => assertQualificationSourceReferenceV1(binding.sourceRef)).not.toThrow();
      }
      const safeDisableConditions = catalog.conditions.filter(
        (condition) =>
          condition.kind === 'default_off_safe_disable' && condition.parameters.flagId === flagId,
      );
      const everyGuardSafelyDisables = bindings.every(
        (binding) => binding.outcome === 'safe_disable',
      );
      if (everyGuardSafelyDisables) {
        expect(surface?.feature).toMatchObject({
          supportState: 'supported',
          declaredExposure: 'experimental_default_off',
        });
        expect(safeDisableConditions.length).toBeGreaterThan(0);
        const sourceFactDigests = safeDisableConditions.map((condition) =>
          condition.kind === 'default_off_safe_disable'
            ? condition.parameters.sourceFactDigest
            : '',
        );
        expect(new Set(sourceFactDigests).size).toBe(safeDisableConditions.length);
      } else {
        expect(surface?.feature).toMatchObject({
          supportState: 'unsupported',
          declaredExposure: 'unsupported',
          notApplicableRationale: 'default_off_legacy_fallback',
        });
        expect(safeDisableConditions).toEqual([]);
      }
    }
  });

  test('derives suite assertions forward from structural source/condition evaluation', () => {
    const catalog = createSourceOwnedQualificationCatalogV1();
    const suite = catalog.suites.find(
      (candidate) => candidate.suiteId === 'source-owned-surface-contract-v1',
    );
    const structuralAssertionIds = evaluateQualificationStructuralAssertionsV1(
      catalog.sourceSurfaces,
      catalog.conditions,
    ).map((assertion) => assertion.assertionId);
    expect(suite?.assertionIds).toEqual(structuralAssertionIds);

    const sourceSurfaceId = 'feature-flag:mcpExecutionRecordV1';
    const safeDisableAssertionId = qualificationStructuralConditionAssertionIdV1(
      sourceSurfaceId,
      'default_off_safe_disable',
    );
    expect(suite?.assertionIds).toContain(safeDisableAssertionId);
    expect(suite?.assertionIds).not.toContain('assertion:forged');

    const conditionsWithoutMcpSafeDisable = catalog.conditions.filter(
      (condition) =>
        !(
          condition.kind === 'default_off_safe_disable' &&
          condition.parameters.flagId === 'mcpExecutionRecordV1'
        ),
    );
    expect(
      evaluateQualificationStructuralAssertionsV1(
        catalog.sourceSurfaces,
        conditionsWithoutMcpSafeDisable,
      ).map((assertion) => assertion.assertionId),
    ).not.toContain(safeDisableAssertionId);
  });

  test('rejects malformed safe-disable guards, identity fallbacks, and partial false guards', () => {
    const annotation = JSON.stringify({
      entrypointId: 'runtime',
      flagId: 'mcpExecutionRecordV1',
      outcome: 'safe_disable',
      disabledResult: 'empty',
      sourceKind: 'contract',
      symbol: 'fixtureGuard',
    });
    const guarded = `/** @qualification-default-off-guard-v1 ${annotation} */\nexport function fixtureGuard(flags: { mcpExecutionRecordV1: boolean }) {\n  if (!flags.mcpExecutionRecordV1) return undefined;\n  return { recorded: true };\n}`;
    expect(
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/core/fixture.ts', guarded),
    ).toHaveLength(1);
    const fallback = guarded.replace('return undefined;', 'return { recorded: false };');
    expect(() =>
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/core/fixture.ts', fallback),
    ).toThrow('qualification_default_off_guard_not_closed');

    const partialGuard = guarded
      .replace(
        'fixtureGuard(flags: { mcpExecutionRecordV1: boolean })',
        'fixtureGuard(flags: { mcpExecutionRecordV1: boolean }, extra: boolean)',
      )
      .replace(
        'if (!flags.mcpExecutionRecordV1) return undefined;',
        'if (!flags.mcpExecutionRecordV1 && extra) return undefined;',
      );
    expect(() =>
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/core/fixture.ts', partialGuard),
    ).toThrow('qualification_default_off_guard_not_closed');

    const identityAnnotation = JSON.stringify({
      entrypointId: 'cli',
      flagId: 'terminalOutcomeV1',
      outcome: 'safe_disable',
      disabledResult: 'identity',
      closedValueParameter: 'event',
      sourceKind: 'public_surface',
      symbol: 'identityGuard',
    });
    const identityGuard = `/** @qualification-default-off-guard-v1 ${identityAnnotation} */\nexport function identityGuard(flags: { terminalOutcomeV1: boolean }, event: { trusted: true }) {\n  if (!flags.terminalOutcomeV1) return event;\n  return { trusted: false };\n}`;
    expect(
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/app/fixture.ts', identityGuard),
    ).toHaveLength(1);
    const unsafeIdentity = identityGuard.replace('return event;', 'return untrusted;');
    expect(() =>
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/app/fixture.ts', unsafeIdentity),
    ).toThrow('qualification_default_off_guard_not_closed');
  });

  test('requires a guard binding for every direct or destructured default-off consumer symbol', () => {
    const annotation = JSON.stringify({
      entrypointId: 'runtime',
      flagId: 'mcpExecutionRecordV1',
      outcome: 'safe_disable',
      disabledResult: 'empty',
      sourceKind: 'contract',
      symbol: 'fixtureGuard',
    });
    const guardedDestructure = `/** @qualification-default-off-guard-v1 ${annotation} */\nexport function fixtureGuard(config: unknown) {\n  const resolved = getFeatureFlags(config);\n  const { mcpExecutionRecordV1: enabled } = resolved;\n  if (!enabled) return undefined;\n  return { recorded: true };\n}`;
    expect(
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/core/fixture.ts', guardedDestructure),
    ).toHaveLength(1);
    const unboundConsumer = `${guardedDestructure}\nexport function unsafeConsumer(flags: { mcpExecutionRecordV1: boolean }) {\n  return flags.mcpExecutionRecordV1;\n}`;
    expect(() =>
      parseSourceOwnedDefaultOffGuardAnnotationsV1('src/core/fixture.ts', unboundConsumer),
    ).toThrow('qualification_default_off_guard_consumer_binding_missing:mcpExecutionRecordV1');
  });

  test('keeps the qualification implementation independent of release evidence and Gate vocabulary', () => {
    const root = process.cwd();
    const implementation = [
      'scripts/evals/contracts/qualification/feature-matrix.ts',
      'release/qualification/source-owned-surface-v1.ts',
      'scripts/evals/contracts/qualification/l1-tool-verification-schema-v1.ts',
      'scripts/evals/contracts/qualification/l1-tool-verification-evidence-v1.ts',
      'scripts/evals/contracts/qualification/l1-public-projection-schema-v1.ts',
      'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts',
      'scripts/evals/contracts/qualification/l1-skill-mcp-schema-v1.ts',
      'scripts/evals/contracts/qualification/l1-skill-mcp-evaluator-v1.ts',
      'scripts/evals/contracts/qualification/l1-skill-mcp-evidence-v1.ts',
      'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-candidate-identity-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-conformance-evidence-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts',
      'scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1.ts',
      'scripts/evals/qualification/run-l2-native-conformance.ts',
      'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts',
      'release/qualification/sentinel-journey-map-v2.ts',
      'release/qualification/source-owned-sentinel-journey-map-v2.ts',
    ]
      .map((path) => readFileSync(resolve(root, path), 'utf8'))
      .join('\n');
    expect(implementation).not.toContain('ReleaseEvidenceV1');
    expect(implementation).not.toContain('RELEASE_GATES');
    expect(implementation).not.toContain('release bundle');
    expect(implementation).not.toContain('PUBLIC_OPERATION_BINDINGS_V1');
    expect(implementation).not.toContain('ENTRY_REJECTION_CONDITION_BINDINGS_V1');
    expect(implementation).not.toContain("from '../../src/core/config/release-capabilities'");
    expect(implementation).not.toContain('CAPABILITY_PROFILE_GATES_V1');
    for (const gateVocabulary of ['G0', 'G1', 'G2', 'G3', 'G4', 'G5']) {
      expect(implementation).not.toContain(gateVocabulary);
    }
  });

  test('keeps the qualification collector dependency graph outside release evaluation and config barrels', async () => {
    const root = process.cwd();
    const build = await Bun.build({
      entrypoints: [resolve(root, 'release/qualification/source-owned-surface-v1.ts')],
      format: 'esm',
      metafile: true,
      target: 'bun',
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {}).map((input) =>
      input.replaceAll('\\', '/'),
    );
    for (const forbiddenInput of [
      'src/core/config/index.ts',
      'src/core/config/release-capabilities.ts',
      'src/core/config/release-profile.ts',
      'scripts/release/evidence-schema.ts',
      'scripts/release/evidence-bundle.ts',
      'scripts/release/gate-evaluator.ts',
      'scripts/release/gate-replay.ts',
    ]) {
      expect(inputs.some((input) => input.endsWith(forbiddenInput))).toBe(false);
    }
  });

  test('keeps L1 and L2 implementations outside release evidence and gate evaluator paths', async () => {
    const root = process.cwd();
    const build = await Bun.build({
      entrypoints: [
        resolve(root, 'scripts/evals/contracts/qualification/l1-tool-verification-adapter-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l1-public-projection-adapter-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l1-skill-mcp-adapter-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l1-skill-mcp-evidence-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l2-native-candidate-identity-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l2-native-conformance-adapter-v1.ts'),
        resolve(
          root,
          'scripts/evals/contracts/qualification/l2-native-conformance-evaluator-v1.ts',
        ),
        resolve(root, 'scripts/evals/contracts/qualification/l2-native-conformance-evidence-v1.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts'),
        resolve(
          root,
          'scripts/evals/contracts/qualification/l2-native-conformance-worker-record-v1.ts',
        ),
        resolve(root, 'scripts/evals/qualification/run-l2-native-conformance.ts'),
        resolve(root, 'scripts/evals/contracts/qualification/evidence/evidence-verifier-v1.ts'),
        resolve(root, 'release/qualification/sentinel-journey-map-v2.ts'),
        resolve(root, 'release/qualification/source-owned-sentinel-journey-map-v2.ts'),
      ],
      format: 'esm',
      metafile: true,
      target: 'bun',
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {}).map((input) =>
      input.replaceAll('\\', '/'),
    );
    for (const forbiddenInput of [
      'scripts/release/evidence-schema.ts',
      'scripts/release/evidence-bundle.ts',
      'scripts/release/gate-evaluator.ts',
      'scripts/release/gate-replay.ts',
      'scripts/release/platform-capability-probe.ts',
    ]) {
      expect(inputs.some((input) => input.endsWith(forbiddenInput))).toBe(false);
    }
    expect(
      inputs.some((input) => input.endsWith('scripts/release/platform-capability-identity.ts')),
    ).toBe(true);
  });

  test('keeps the L2 source registry projection outside the runtime execution qualification loader', async () => {
    const root = process.cwd();
    const build = await Bun.build({
      entrypoints: [
        resolve(root, 'scripts/evals/contracts/qualification/l2-native-conformance-schema-v1.ts'),
      ],
      format: 'esm',
      metafile: true,
      target: 'bun',
    });
    expect(build.success).toBe(true);
    const inputs = Object.keys(build.metafile?.inputs ?? {}).map((input) =>
      input.replaceAll('\\', '/'),
    );
    for (const forbiddenInput of [
      'src/core/config/execution-boundary.ts',
      'src/core/config/execution-qualification.ts',
      'src/core/sandbox/environment-identity.ts',
      'src/core/sandbox/platform.ts',
    ]) {
      expect(inputs.some((input) => input.endsWith(forbiddenInput))).toBe(false);
    }
  });
});
